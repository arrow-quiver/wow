'use strict';
// main.js's wiring between services, run in plain Node against a real local core: the session the
// renderer sees as auth.* (Battle.net in the app + who I am in the core), Battle.net details reaching
// the core, the newest versions for the core, and core events becoming notifications.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { createCore } = require('../src/core');
const { identityOf, createSession, createLatestTracker, wireNotifications, SMOKE_API_PATHS } = require('../src/main/main');
const { createDemoAuth } = require('../src/core/demo');

const quiet = { info() {}, warn() {}, error() {} };

// A stand-in for auth.js with the contract's state shape.
function fakeAuth(initial = {}) {
  let state = { available: true, signedIn: false, signingIn: false, battletag: null, region: 'eu', characters: [], profileAt: null, error: null, ...initial };
  const auth = new EventEmitter();
  const set = (patch) => { state = { ...state, ...patch }; auth.emit('change', state); return state; };
  return Object.assign(auth, {
    state: () => state,
    set,
    signIn: async () => set({ signedIn: true, battletag: 'Jaina#1234', characters: [{ name: 'Jaina', realm: 'Forever', level: 60, class: 'MAGE', namespace: 'profile-classic1x-eu' }] }),
    signOut: async () => set({ signedIn: false, battletag: null, characters: [] }),
    refresh: async () => state,
  });
}

const upload = (core, body) => fetch(`${core.url}/api/sync`, {
  method: 'POST', headers: { Authorization: `Bearer ${core.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}).then((r) => r.json());

test('identityOf: the BattleTag and characters when signed in, nothing otherwise', () => {
  assert.deepEqual(identityOf(null), { battletag: null, characters: [] });
  assert.deepEqual(identityOf({ signedIn: false, battletag: 'X#1', characters: [{ name: 'A' }] }), { battletag: null, characters: [] });
  assert.deepEqual(identityOf({ signedIn: true, battletag: 'X#1', characters: [{ name: 'A' }], profileAt: 't' }), { battletag: 'X#1', characters: [{ name: 'A' }], profileAt: 't' });
  assert.deepEqual(identityOf({ signedIn: true, battletag: 5, characters: 'no' }), { battletag: null, characters: [], profileAt: null });
});

test('the session: Battle.net state plus my guild and role from the core, kept in step both ways', async () => {
  const auth = fakeAuth();
  const core = await createCore({ dbFile: ':memory:', timers: false, log: quiet, getIdentity: () => identityOf(auth.state()) });
  try {
    const session = createSession({ auth, core, log: quiet });
    const changes = [];
    session.on('change', (s) => changes.push(s));
    let s = session.state();
    assert.equal(s.available, true);
    assert.equal(s.signedIn, false);
    assert.deepEqual([s.user.battletag, s.guild, s.role], ['You', null, null], 'usable before any sign-in or sync');

    // The first sync sets the guild up: the renderer hears about it without asking.
    await upload(core, { characters: { Jaina: { name: 'Jaina', realm: 'Forever', guild: 'Kirin Tor', updated: 1 } },
      roster: { scannedAt: 1, members: [{ name: 'Jaina', rankIndex: 1, online: true }] } });
    s = changes.at(-1);
    assert.deepEqual([s.user.battletag, s.guild.name, s.role, s.signedIn], ['Jaina', 'Kirin Tor', 'officer', false]);

    // Signing in to Battle.net: the BattleTag reaches the core and comes back in the session.
    s = await session.signIn();
    assert.deepEqual([s.signedIn, s.battletag, s.user.battletag, s.role], [true, 'Jaina#1234', 'Jaina#1234', 'officer']);
    assert.equal(core.session().user.battletag, 'Jaina#1234');
    const count = changes.length;
    s = await session.refresh();
    assert.equal(changes.length, count, 'nothing changed: no event');

    // Battle.net signing out by itself (an expired token): the core forgets the BattleTag too.
    auth.set({ signedIn: false, battletag: null, characters: [] });
    assert.equal(core.session().user.battletag, 'Jaina');
    assert.equal(changes.at(-1).user.battletag, 'Jaina');
    s = await session.signOut();
    assert.equal(s.signedIn, false);
  } finally {
    await core.close();
  }
});

test('the demo auth for smoke runs looks signed in and never changes', async () => {
  const auth = createDemoAuth();
  const s = auth.state();
  assert.deepEqual([s.available, s.signedIn, s.battletag, s.demo], [true, true, 'Calvin#1234', true]);
  assert.equal(s.characters[0].name, 'Grimtusk');
  assert.deepEqual(await auth.signOut(), auth.state());
});

test('the newest versions for the core come from the updater and the addon manager, as they change', () => {
  const updater = Object.assign(new EventEmitter(), { status: () => ({ state: 'dev', current: '0.11.0', available: null }) });
  const addon = Object.assign(new EventEmitter(), { status: () => Promise.resolve({ latest: null }) });
  const latest = createLatestTracker({ updater, addon });
  assert.deepEqual(latest(), { app: '0.11.0', addon: null });
  updater.emit('status', { state: 'available', current: '0.11.0', available: { version: '0.12.0' } });
  addon.emit('status', { latest: { version: '0.11.3', source: 'remote' } });
  assert.deepEqual(latest(), { app: '0.12.0', addon: '0.11.3' });
  addon.emit('status', { checking: true });
  assert.equal(latest().addon, '0.11.3', 'a status without a version keeps the last one');
  assert.deepEqual(createLatestTracker({})(), { app: null, addon: null });
});

test('core events become server-event broadcasts and, when notifications are on, native notifications', async () => {
  const core = await createCore({ dbFile: ':memory:', timers: false, log: quiet });
  try {
    const sent = [];
    const shown = [];
    const settings = { notifications: true };
    const off = wireNotifications({
      core, store: { get: () => settings }, broadcast: (c, p) => sent.push([c, p]), notify: { show: (ev) => shown.push(ev.title) }, log: quiet,
    });
    await upload(core, { characters: { Me: { name: 'Me', realm: 'Forever', guild: 'wow', updated: 1 } } });
    const gid = core.session().guild.id;
    core.ctx.emit(gid, 'raid', { title: 'Raid soon', route: '/raids/1' });
    settings.notifications = false;
    core.ctx.emit(gid, 'notice', { title: 'Quiet notice' });
    assert.deepEqual(sent.map(([c, p]) => [c, p.title]), [['server-event', 'Raid soon'], ['server-event', 'Quiet notice']], 'pages always hear about it');
    assert.deepEqual(shown, ['Raid soon']);
    off();
    core.ctx.emit(gid, 'raid', { title: 'After off' });
    assert.equal(sent.length, 2);
  } finally {
    await core.close();
  }
});

test('the smoke run checks the endpoints the pages use', () => {
  assert.ok(SMOKE_API_PATHS.includes('/api/camp'));
  assert.ok(SMOKE_API_PATHS.every((p) => p.startsWith('/api/')));
});

test('main.js wires the sync engine to the core: a change queued in the app rewrites the inbox without an upload', async (t) => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { createAppSync } = require('../src/main/main');
  const { createApi } = require('../src/main/api');
  const { createStore } = require('../src/main/store');
  const wow = require('../src/main/wow');
  const { parseSavedVariables } = require('../src/shared/lua');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-main-sync-'));
  const root = path.join(tmp, 'World of Warcraft');
  fs.mkdirSync(path.join(root, '_forever_', 'Interface', 'AddOns', 'WowGuild'), { recursive: true });
  const inboxFile = path.join(root, '_forever_', 'Interface', 'AddOns', 'WowGuild_Inbox', 'Inbox.lua');
  const core = await createCore({ dbFile: ':memory:', timers: false, log: quiet });
  const syncs = [];
  t.after(async () => {
    for (const s of syncs) { s.stop(); await s.whenIdle(); }
    await core.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  await upload(core, { characters: { Jaina: { name: 'Jaina', realm: 'Forever', guild: 'wow', updated: 1 } },
    roster: { scannedAt: 1, members: [{ name: 'Jaina', rankIndex: 3, online: true }] } });
  const store = createStore(path.join(tmp, 'userData'));
  store.set({ extraWowFolders: [root] });
  const api = createApi({ getBase: () => core.url, getToken: () => core.token, appVersion: '0.12.0', log: quiet });
  const sync = createAppSync({ api, store, log: quiet, wow, appVersion: '0.12.0', core, scanDefaults: false, outboxDelayMs: 10 });
  syncs.push(sync);

  // A call to arms posted in the app (sharing.queue → the core's 'outbox' event). No sync.start(), no upload.
  const r = await api.request('POST', '/api/ctas', { zone: 'Crossroads', needed: 5, message: 'Help' });
  assert.equal(r.message, 'Call to arms posted.');
  for (let i = 0; i < 100 && !fs.existsSync(inboxFile); i++) await new Promise((res) => setTimeout(res, 20));
  await sync.whenIdle();
  const inbox = parseSavedVariables(fs.readFileSync(inboxFile)).WowGuildInbox;
  const outbox = Object.values(inbox.outbox);
  assert.equal(outbox.length, 1);
  assert.match(outbox[0].id, /^ca:[0-9a-z]{6}$/);
  assert.match(outbox[0].body, /Crossroads/);
  assert.match(inbox.me.pid, /^Jaina\.[0-9a-z]{4}$/);
});

test('a game folder that just got the addon gets its WowGuild_Inbox at once, so a game started right after finds both folders (a /reload never loads a news folder made mid-session)', async (t) => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const main = require('../src/main/main');
  const { createApi } = require('../src/main/api');
  const { createStore } = require('../src/main/store');
  const { createAddonManager } = require('../src/main/addon');
  const wow = { ...require('../src/main/wow'), isWowRunning: async () => false }; // the game is closed
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-main-inbox-'));
  const root = path.join(tmp, 'World of Warcraft');
  const addonsDir = path.join(root, '_forever_', 'Interface', 'AddOns');
  fs.mkdirSync(addonsDir, { recursive: true });
  fs.mkdirSync(path.join(root, '_forever_', 'WTF'), { recursive: true });
  const inboxToc = path.join(addonsDir, 'WowGuild_Inbox', 'WowGuild_Inbox.toc');
  const core = await createCore({ dbFile: ':memory:', timers: false, log: quiet });
  const store = createStore(path.join(tmp, 'userData'));
  store.set({ extraWowFolders: [root], addonAutoInstall: true, addonAutoUpdate: true });
  const api = createApi({ getBase: () => core.url, getToken: () => core.token, appVersion: '0.12.0', log: quiet });
  const sync = main.createAppSync({ api, store, log: quiet, wow, appVersion: '0.12.0', core, scanDefaults: false, outboxDelayMs: 10 });
  const addon = createAddonManager({
    store, log: quiet, wow, resourcesDir: path.join(__dirname, '..', '..'), fetch: async () => { throw new Error('offline'); },
    feedFile: null, cacheDir: path.join(tmp, 'cache'), scanDefaults: false,
  });
  t.after(async () => {
    addon.dispose();
    sync.stop();
    await sync.whenIdle();
    await core.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  // As at app start: sync's first pass runs before the addon check has installed anything, so it writes no news.
  await sync.start();
  assert.equal(fs.existsSync(inboxToc), false);
  main.wireInboxAfterInstall({ addon, sync });
  await addon.check();
  assert.ok(fs.existsSync(path.join(addonsDir, 'WowGuild', 'WowGuild.toc')), 'the addon was installed automatically');
  for (let i = 0; i < 100 && !fs.existsSync(inboxToc); i++) await new Promise((res) => setTimeout(res, 20));
  assert.ok(fs.existsSync(inboxToc), 'the news folder is there before the game starts, not 5 minutes later');
});

test('a smoke run uses its own user data folder even when GUILDCAMP_USER_DATA (or --user-data) points at a dev profile', () => {
  const path = require('path');
  const { pickUserDataDir, parseArgs } = require('../src/main/main');
  const out = path.resolve('dist', 'smoke');
  const env = { GUILDCAMP_USER_DATA: 'dist/dev-profile' };
  assert.equal(pickUserDataDir(parseArgs(['--smoke', '--smoke-seed']), env, out), path.join(out, 'user-data'));
  assert.equal(pickUserDataDir(parseArgs(['--smoke', '--user-data', 'C:\\Users\\me\\AppData\\Roaming\\Guild Camp']), env, out), path.join(out, 'user-data'));
  // --smoke-user-data picks another scratch folder for it (one with fake game folders, say).
  const smokeArgs = parseArgs(['--smoke', '--smoke-user-data', 'scratch/smoke-profile']);
  assert.equal(smokeArgs.smokeUserData, 'scratch/smoke-profile');
  assert.equal(pickUserDataDir(smokeArgs, env, out), path.resolve('scratch/smoke-profile'));
  assert.equal(pickUserDataDir(parseArgs(['--smoke-user-data=x']), {}, out), null, 'only for smoke runs');
  // Dev runs: --user-data, then the environment variable, else Electron's own folder.
  assert.equal(pickUserDataDir(parseArgs(['--user-data', 'a']), env, out), path.resolve('a'));
  assert.equal(pickUserDataDir(parseArgs([]), env, out), path.resolve('dist/dev-profile'));
  assert.equal(pickUserDataDir(parseArgs([]), {}, out), null);
});

// The Electron start-up can't run here, so this reads it: a smoke run pointed at a dev profile (GUILDCAMP_USER_DATA)
// must neither open that profile nor save its "no sync, no updates, no notifications" switches into settings.json.
test('the Electron start-up picks the user data folder with pickUserDataDir and gives a smoke run its switches as store overrides, never store.set', () => {
  const fs = require('fs');
  const path = require('path');
  const { SMOKE_SETTINGS } = require('../src/main/main');
  const text = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
  const start = text.indexOf('function bootstrap()');
  assert.ok(start > 0, 'main.js still has bootstrap()');
  const boot = text.slice(start);
  const setPath = /app\.setPath\(\s*'userData'\s*,\s*(\w+)\s*\)/.exec(boot);
  assert.ok(setPath, 'bootstrap sets the user data folder');
  assert.match(boot, new RegExp(`\\b${setPath[1]}\\s*=\\s*pickUserDataDir\\(\\s*args\\s*,\\s*process\\.env\\s*,\\s*smokeOut\\s*\\)`), 'the folder comes from pickUserDataDir');
  assert.doesNotMatch(boot, /process\.env\.GUILDCAMP_USER_DATA/, 'only pickUserDataDir reads GUILDCAMP_USER_DATA');
  assert.match(boot, /createStore\(\s*userData\s*,\s*\{[^}]*overrides:\s*args\.smoke\s*\?\s*SMOKE_SETTINGS\s*:\s*null/, 'the smoke switches are store overrides');
  const keys = Object.keys(SMOKE_SETTINGS).join('|');
  assert.doesNotMatch(boot, new RegExp(`store\\.set\\(\\s*\\{[^}]*\\b(${keys})\\s*:\\s*false`), 'no smoke switch is saved with store.set');
});

test('smoke runs: addon and app update checks do nothing and only report the status', async () => {
  const { skipChecksForSmoke } = require('../src/main/main');
  let asked = 0;
  const addon = { status: () => ({ latest: null, lastCheckAt: null }), check: async () => { asked++; throw new Error('asked GitHub'); } };
  const updater = { status: () => ({ state: 'dev', current: '0.12.0' }), check: async () => { asked++; throw new Error('asked GitHub'); } };
  skipChecksForSmoke({ addon, updater });
  assert.deepEqual(await addon.check({ force: true }), { latest: null, lastCheckAt: null });
  assert.deepEqual(await updater.check({ force: true }), { state: 'dev', current: '0.12.0' });
  assert.equal(asked, 0);
});
