'use strict';
// Joining the guild by itself (src/main/membership.js) and the main-process wiring that drives it
// (wireSession in src/main/main.js). Fakes stand in for the server, auth and the game folders; one test
// reads a real fake game tree in a temp folder. Timers are injected, so nothing waits for real.
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const { createMembership, normalizeResult, joinedResult, cleanCharacters } = require('../src/main/membership');
const { wireSession } = require('../src/main/main');
const { ApiError } = require('../src/main/api');
const { createStore } = require('../src/main/store');
const wow = require('../src/main/wow');
const { toLua } = require('../src/shared/lua');

const GUILD = { id: 1, name: 'Just Now WoW', faction: 'Horde' };
const JOINED = { status: 'joined', guild: GUILD, role: 'member', via: 'roster', character: 'Thrallia', reason: "You're in Just Now WoW (matched Thrallia).", detected: null };
const NO_MATCH = { status: 'no-match', guild: GUILD, role: null, via: null, character: null, reason: 'Log in to World of Warcraft once with the Guild Camp addon on a character in Just Now WoW, then Guild Camp will add you.', detected: null };
const DETECTED = {
  characters: [
    { name: 'Thrallia', realm: 'Forever', guild: 'Just Now WoW', faction: 'Horde', level: 31, class: 'SHAMAN', updated: 1794000000, install: 'C:\\WoW\\_forever_', account: 'ALICE' },
    { name: 'Altie', realm: 'Forever', guild: null, faction: 'Horde', level: 5, class: 'MAGE', updated: 1793000000, install: 'C:\\WoW\\_forever_', account: 'ALICE' },
  ],
  guild: { name: 'Just Now WoW', realm: 'Forever', faction: 'Horde' },
};

let tmp;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-member-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

function memLog() {
  const lines = [];
  const add = (level) => (...parts) => lines.push({ level, msg: parts.map(String).join(' ') });
  return { lines, info: add('info'), warn: add('warn'), error: add('error'), text: () => lines.map((l) => l.msg).join('\n') };
}

/** Auth with a state we control; refresh() can "discover" the guild, as GET /api/me would. */
function fakeAuth(initial = { signedIn: true, guild: null, user: { battletag: 'Thrall#1234' } }) {
  const auth = new EventEmitter();
  auth.current = { ...initial };
  auth.refreshes = 0;
  auth.onRefresh = null;
  auth.state = () => ({ ...auth.current });
  auth.set = (patch) => { auth.current = { ...auth.current, ...patch }; auth.emit('change', auth.state()); };
  auth.refresh = async () => {
    auth.refreshes += 1;
    if (auth.onRefresh) auth.onRefresh();
    return auth.state();
  };
  return auth;
}

function fakeApi(answer) {
  const api = { calls: [], answer };
  api.request = async (method, p, body, opts) => {
    api.calls.push({ method, path: p, body: structuredClone(body), opts });
    const a = typeof api.answer === 'function' ? await api.answer(body) : api.answer;
    return structuredClone(a);
  };
  return api;
}

/** A membership driver over fakes, with timers and the clock under the test's control. */
function setup({ answer = NO_MATCH, auth = fakeAuth(), detected = DETECTED, store = null } = {}) {
  const h = { timers: [], clock: 1000000, results: [], log: memLog(), auth, detectCalls: [] };
  h.api = fakeApi(answer);
  h.wow = { detectGuild: (opts) => { h.detectCalls.push(opts); return structuredClone(detected); } };
  h.m = createMembership({
    api: h.api,
    wow: h.wow,
    auth,
    log: h.log,
    store,
    now: () => h.clock,
    setTimeout: (fn, ms) => { const t = { fn, ms }; h.timers.push(t); return t; },
    clearTimeout: (t) => { const i = h.timers.indexOf(t); if (i !== -1) h.timers.splice(i, 1); },
  });
  h.m.on('change', (r) => h.results.push(r));
  h.fire = async () => {
    const t = h.timers.shift();
    assert.ok(t, 'a retry is booked');
    h.clock += t.ms;
    t.fn();
    await flush();
  };
  return h;
}

const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };

// ---------------------------------------------------------------------------------------------
describe('result helpers', () => {
  test('normalizeResult fills in safe defaults and always has a plain reason', () => {
    assert.deepEqual(normalizeResult(JOINED), JOINED);
    const odd = normalizeResult({ status: 'weird', role: 'king', via: 'magic', guild: { name: '' }, detected: { guild: 'Horde Heroes', realm: 'Forever' } });
    assert.equal(odd.status, 'no-match');
    assert.equal(odd.role, null);
    assert.equal(odd.via, null);
    assert.equal(odd.guild, null);
    assert.match(odd.reason, /couldn't match you/);
    assert.deepEqual(odd.detected, { guild: 'Horde Heroes', realm: 'Forever', faction: null });
    assert.equal(normalizeResult(null).status, 'no-match');
    assert.equal(normalizeResult({ status: 'no-guild-on-server' }).reason, 'This server has no guild yet.');
    assert.equal(normalizeResult({ status: 'disabled', guild: GUILD }).reason, 'Just Now WoW only takes new members with an invite link.');
    assert.equal(normalizeResult({ status: 'already', guild: GUILD, role: 'owner' }).reason, "You're already in Just Now WoW.");
  });

  test('joinedResult turns a sync reply\'s joined part into a joined result', () => {
    assert.deepEqual(joinedResult({ guild: GUILD, role: 'officer', via: 'battlenet', character: 'Thrallia' }), {
      status: 'joined', guild: GUILD, role: 'officer', via: 'battlenet', character: 'Thrallia',
      reason: "You're in Just Now WoW (matched Thrallia).", detected: null,
    });
    assert.equal(joinedResult(null).reason, "You're in the guild.");
  });

  test('cleanCharacters sends only what the server needs, at most 50', () => {
    const [first] = cleanCharacters(DETECTED.characters);
    assert.deepEqual(first, { name: 'Thrallia', realm: 'Forever', guild: 'Just Now WoW', faction: 'Horde', level: 31, class: 'SHAMAN', updated: 1794000000 });
    assert.ok(!('install' in first) && !('account' in first), 'folders and account names stay on this computer');
    const many = Array.from({ length: 80 }, (_, i) => ({ name: `Char${i}`, realm: 'x'.repeat(200) }));
    const out = cleanCharacters(many);
    assert.equal(out.length, 50);
    assert.equal(out[0].realm.length, 60);
    assert.deepEqual(cleanCharacters([null, 'x', { name: '  ' }, { level: 3 }]), []);
    assert.deepEqual(cleanCharacters('nope'), []);
  });
});

// ---------------------------------------------------------------------------------------------
describe('autoJoin', () => {
  test('sends the characters the addon saved and keeps the result', async () => {
    const store = createStore(path.join(tmp, 'ud'));
    store.set({ extraWowFolders: [tmp] });
    const h = setup({ store });
    assert.equal(h.m.status(), null);
    const r = await h.m.autoJoin();
    assert.deepEqual(r, NO_MATCH);
    assert.equal(h.api.calls.length, 1);
    const [call] = h.api.calls;
    assert.equal(call.method, 'POST');
    assert.equal(call.path, '/api/guild/auto-join');
    assert.deepEqual(call.body, { characters: cleanCharacters(DETECTED.characters) });
    assert.deepEqual(h.detectCalls, [{ extraRoots: [path.resolve(tmp)], scanDefaults: true }], 'the folders from settings');
    assert.deepEqual(h.m.status(), NO_MATCH);
    assert.deepEqual(h.results, [NO_MATCH], "the 'change' event carries the result");
    assert.equal(h.auth.refreshes, 0, 'no guild, nothing to refresh');
    assert.match(h.log.text(), /Not in the guild yet: Log in to World of Warcraft once/);
  });

  test("on 'joined' (and 'already') the sign-in state is refreshed so the auth event carries the guild", async () => {
    const auth = fakeAuth();
    auth.onRefresh = () => { auth.current.guild = { id: 1, name: 'Just Now WoW' }; };
    const h = setup({ answer: JOINED, auth });
    const order = [];
    h.m.on('change', () => order.push('membership'));
    auth.refresh = ((orig) => async () => { order.push('refresh'); return orig(); })(auth.refresh);
    const r = await h.m.autoJoin();
    assert.equal(r.status, 'joined');
    assert.equal(auth.refreshes, 1);
    assert.deepEqual(order, ['membership', 'refresh'], 'the result is out before the refreshed sign-in');
    assert.match(h.log.text(), /Joined Just Now WoW \(matched Thrallia\)\./);

    const h2 = setup({ answer: { status: 'already', guild: GUILD, role: 'owner' } });
    assert.equal((await h2.m.autoJoin()).reason, "You're already in Just Now WoW.");
    assert.equal(h2.auth.refreshes, 1);
  });

  test('calls at the same time share one request', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const h = setup({ answer: async () => { await gate; return NO_MATCH; } });
    const a = h.m.autoJoin();
    const b = h.m.autoJoin();
    release();
    assert.deepEqual(await a, await b);
    assert.equal(h.api.calls.length, 1);
  });

  test('an older server without automatic joining answers "use an invite link"', async () => {
    const h = setup({ answer: () => { throw new ApiError(404, "The server couldn't find that."); } });
    const r = await h.m.autoJoin();
    assert.equal(r.status, 'disabled');
    assert.match(r.reason, /invite link/);
  });

  test('a server that cannot be reached rejects and keeps the last result', async () => {
    const h = setup();
    await h.m.autoJoin();
    h.api.answer = () => { throw new ApiError(0, "Can't reach the guild server (x: connection refused)."); };
    await assert.rejects(h.m.autoJoin(), /Can't reach the guild server/);
    assert.deepEqual(h.m.status(), NO_MATCH);
  });

  test('signed out: asks to sign in, sends nothing', async () => {
    const h = setup({ auth: fakeAuth({ signedIn: false, guild: null }) });
    await assert.rejects(h.m.autoJoin(), (err) => err.status === 401 && /Sign in with Battle.net/.test(err.message));
    assert.equal(h.api.calls.length, 0);
  });

  test('a server without a guild gets the guild the addon saw as detected, when it named none', async () => {
    const h = setup({ answer: { status: 'no-guild-on-server', reason: 'This server has no guild yet.' } });
    const r = await h.m.autoJoin();
    assert.deepEqual(r.detected, { guild: 'Just Now WoW', realm: 'Forever', faction: 'Horde' });
    const h2 = setup({ answer: { status: 'no-guild-on-server', detected: { guild: 'From Battle.net', realm: 'Forever', faction: 'Alliance' } } });
    assert.equal((await h2.m.autoJoin()).detected.guild, 'From Battle.net', "the server's answer wins");
    const h3 = setup({ answer: { status: 'no-guild-on-server' }, detected: { characters: [], guild: null } });
    assert.equal((await h3.m.autoJoin()).detected, null);
  });

  test('record() keeps results that came from elsewhere', () => {
    const h = setup();
    const r = h.m.record(joinedResult({ guild: GUILD, role: 'member', via: 'roster', character: 'Thrallia' }));
    assert.equal(r.status, 'joined');
    assert.deepEqual(h.m.status(), r);
    assert.equal(h.results.length, 1);
  });

  test('reads a real game folder: characters from every account, newest first', async () => {
    const root = path.join(tmp, 'World of Warcraft');
    const sv = (chars) => `WowGuildDB = ${toLua({ characters: chars })}\n`;
    const put = (flavor, acc, chars) => {
      const f = path.join(root, flavor, 'WTF', 'Account', acc, 'SavedVariables', 'WowGuild.lua');
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.mkdirSync(path.join(root, flavor, 'Interface', 'AddOns'), { recursive: true });
      fs.writeFileSync(f, sv(chars));
    };
    put('_forever_', 'ALICE', { Thrallia: { name: 'Thrallia', realm: 'Forever', guild: 'Just Now WoW', faction: 'Horde', level: 31, class: 'SHAMAN', updated: 1794000000, money: 5 } });
    put('_forever_', 'BOB', { Grom: { name: 'Grom', realm: 'Forever', level: 12, class: 'WARRIOR', updated: 1794100000 } });
    const store = createStore(path.join(tmp, 'ud'));
    store.set({ extraWowFolders: [root] });
    const api = fakeApi(NO_MATCH);
    const m = createMembership({ api, wow, auth: fakeAuth(), store, scanDefaults: false });
    await m.autoJoin();
    assert.deepEqual(api.calls[0].body.characters, [
      { name: 'Grom', realm: 'Forever', guild: null, faction: null, level: 12, class: 'WARRIOR', updated: 1794100000 },
      { name: 'Thrallia', realm: 'Forever', guild: 'Just Now WoW', faction: 'Horde', level: 31, class: 'SHAMAN', updated: 1794000000 },
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
describe('background driver', () => {
  test('tries at once, then every 60 s, and stops once in a guild', async () => {
    const auth = fakeAuth();
    const h = setup({ auth });
    await h.m.start();
    assert.equal(h.api.calls.length, 1, 'tried straight away');
    assert.equal(h.m.isRunning(), true);
    assert.deepEqual(h.timers.map((t) => t.ms), [60000], 'next try booked in a minute');

    await h.fire();
    assert.equal(h.api.calls.length, 2);
    assert.equal(h.timers.length, 1);

    // The third try matches: the refresh brings the guild and the driver stops by itself.
    h.api.answer = JOINED;
    auth.onRefresh = () => { auth.current.guild = { id: 1, name: 'Just Now WoW' }; };
    await h.fire();
    assert.equal(h.api.calls.length, 3);
    assert.equal(auth.refreshes, 1);
    assert.equal(h.m.isRunning(), false);
    assert.equal(h.timers.length, 0, 'nothing more is booked');
    assert.equal(h.m.status().status, 'joined');
    assert.deepEqual(h.results.map((r) => r.status), ['no-match', 'no-match', 'joined']);
  });

  test('does nothing while already in a guild or signed out', async () => {
    const inGuild = setup({ auth: fakeAuth({ signedIn: true, guild: { id: 1 } }) });
    await inGuild.m.start();
    assert.equal(inGuild.api.calls.length, 0);
    assert.equal(inGuild.m.isRunning(), false);
    const out = setup({ auth: fakeAuth({ signedIn: false, guild: null }) });
    await out.m.start();
    assert.equal(out.api.calls.length, 0);
    assert.equal(out.timers.length, 0);
  });

  test('a guild that arrives another way (invite link) stops the next try', async () => {
    const auth = fakeAuth();
    const h = setup({ auth });
    await h.m.start();
    auth.current.guild = { id: 1 }; // joined with an invite link meanwhile
    await h.fire();
    assert.equal(h.api.calls.length, 1, 'no request once in a guild');
    assert.equal(h.m.isRunning(), false);
  });

  test('network problems are logged once and retried on the timer', async () => {
    const h = setup({ answer: () => { throw new ApiError(0, "Can't reach the guild server."); } });
    await h.m.start();
    await h.fire();
    await h.fire();
    assert.equal(h.api.calls.length, 3);
    assert.equal(h.log.lines.filter((l) => l.level === 'warn').length, 1, 'one warning for the whole outage');
    assert.equal(h.timers.length, 1, 'still trying');
    h.api.answer = NO_MATCH;
    await h.fire();
    assert.equal(h.m.status().status, 'no-match');
  });

  test('stop() cancels the next try; stop({ forget }) also drops the last result', async () => {
    const h = setup();
    await h.m.start();
    h.m.stop();
    assert.equal(h.timers.length, 0);
    assert.equal(h.m.isRunning(), false);
    assert.deepEqual(h.m.status(), NO_MATCH);
    h.m.stop({ forget: true });
    assert.equal(h.m.status(), null);
    await h.m.start();
    assert.equal(h.api.calls.length, 2, 'can start again');
    h.m.stop();
  });

  test('kick() tries now when the game saved, but not twice in a row with the same data', async () => {
    const h = setup();
    await h.m.start();
    await h.m.kick();
    assert.equal(h.api.calls.length, 1, 'a try just ran: skipped');
    h.clock += 30000;
    await h.m.kick();
    assert.equal(h.api.calls.length, 2, 'tried again');
    assert.deepEqual(h.timers.map((t) => t.ms), [60000], 'and the next timed try is a minute after this one');
    h.m.stop();
    h.clock += 30000;
    await h.m.kick();
    assert.equal(h.api.calls.length, 3, 'works without the loop too');
    assert.equal(h.timers.length, 0, 'without booking the loop');
    const inGuild = setup({ auth: fakeAuth({ signedIn: true, guild: { id: 1 } }) });
    await inGuild.m.kick();
    assert.equal(inGuild.api.calls.length, 0);
  });
});

// ---------------------------------------------------------------------------------------------
// main.js: what happens around sign-in (wireSession), with every service faked.
describe('session wiring (main.js)', () => {
  function services({ signedIn = false, guild = null, isPackaged = true, startup = { supported: true } } = {}) {
    const calls = [];
    const rec = (name, value) => (...args) => { calls.push([name, ...args]); return value; };
    const auth = fakeAuth({ signedIn, guild, user: signedIn ? { battletag: 'Thrall#1234' } : null });
    const sync = Object.assign(new EventEmitter(), { start: rec('sync.start'), stop: rec('sync.stop'), clearNoGuild: rec('sync.clearNoGuild') });
    const events = { start: rec('events.start'), stop: rec('events.stop') };
    const addon = { check: rec('addon.check', Promise.resolve()) };
    const membership = { start: rec('membership.start'), stop: rec('membership.stop'), record: rec('membership.record'), kick: rec('membership.kick', Promise.resolve()) };
    const store = createStore(path.join(tmp, `ud-${Math.random().toString(36).slice(2)}`));
    const startupFake = { supported: startup.supported, set: rec('startup.set', true), ...startup };
    const log = memLog();
    const applyAuth = wireSession({ auth, sync, events, addon, membership, store, startup: startupFake, log, isPackaged });
    applyAuth(auth.state());
    const signIn = (g = null) => auth.set({ signedIn: true, guild: g, user: { battletag: 'Thrall#1234' } });
    return { calls, names: () => calls.map((c) => c[0]), auth, sync, store, log, signIn, membership };
  }

  test('signing in without a guild starts sync, the feed, the addon check and the guild search', async () => {
    const s = services();
    assert.deepEqual(s.names(), ['sync.stop', 'events.stop', 'membership.stop'], 'signed out at start');
    s.calls.length = 0;
    s.signIn();
    await flush();
    assert.deepEqual(s.names().filter((n) => n !== 'startup.set'), ['sync.start', 'events.start', 'membership.start', 'addon.check']);
  });

  test('once in a guild: the search stops and waiting uploads go at once', () => {
    const s = services();
    s.signIn();
    s.calls.length = 0;
    s.auth.set({ guild: { id: 1, name: 'Just Now WoW' } });
    assert.deepEqual(s.names(), ['membership.stop', 'sync.clearNoGuild']);
    s.calls.length = 0;
    s.auth.set({ role: 'member' }); // other changes while in the guild
    assert.deepEqual(s.names(), ['membership.stop']);
  });

  test('already in a guild at startup: no search, nothing to clear', () => {
    const s = services({ signedIn: true, guild: { id: 1 } });
    assert.deepEqual(s.names(), ['sync.start', 'events.start', 'membership.stop']);
  });

  test("a sync upload that joined refreshes the sign-in; 'no-guild' passes the server's answer on", async () => {
    const s = services();
    s.signIn();
    s.calls.length = 0;
    const refreshes = s.auth.refreshes;
    s.sync.emit('joined', { guild: GUILD, role: 'member', via: 'roster', character: 'Thrallia' }, { account: 'ALICE' });
    await flush();
    const recorded = s.calls.find((c) => c[0] === 'membership.record');
    assert.equal(recorded[1].status, 'joined');
    assert.equal(recorded[1].character, 'Thrallia');
    assert.equal(s.auth.refreshes, refreshes + 1);

    s.calls.length = 0;
    s.sync.emit('no-guild', { reason: NO_MATCH.reason, autoJoin: NO_MATCH });
    assert.deepEqual(s.calls, [['membership.record', NO_MATCH]], 'the answer that came with the upload is used');
    s.calls.length = 0;
    s.sync.emit('no-guild', { reason: 'Join a guild first.', autoJoin: null });
    await flush();
    assert.deepEqual(s.names(), ['membership.kick'], 'otherwise a fresh check (throttled by membership)');
  });

  test('signing out stops everything and forgets the last result', () => {
    const s = services();
    s.signIn();
    s.calls.length = 0;
    s.auth.set({ signedIn: false, guild: null, user: null });
    assert.deepEqual(s.calls, [['sync.stop'], ['events.stop'], ['membership.stop', { forget: true }]]);
  });

  test('the first sign-in of an installed app turns "start with Windows" on, once', () => {
    const s = services();
    assert.equal(s.store.get().startWithWindows, false);
    s.signIn();
    assert.deepEqual(s.calls.filter((c) => c[0] === 'startup.set'), [['startup.set', true]]);
    assert.equal(s.store.get().startWithWindows, true);
    assert.equal(s.store.get().startupDefaulted, true);
    assert.match(s.log.text(), /starts with Windows/);

    // The person turns it off in Settings; signing in again never turns it back on.
    s.store.set({ startWithWindows: false });
    s.auth.set({ signedIn: false, guild: null, user: null });
    s.signIn();
    assert.equal(s.calls.filter((c) => c[0] === 'startup.set').length, 1);
    assert.equal(s.store.get().startWithWindows, false);
  });

  test('"start with Windows" is not defaulted for dev runs, earlier sign-ins, a person\'s choice, or unsupported systems', () => {
    const dev = services({ isPackaged: false });
    dev.signIn();
    assert.equal(dev.store.get().startWithWindows, false);
    assert.equal(dev.store.get().startupDefaulted, false);

    const upgraded = services({ signedIn: true }); // signed in before this version: not a sign-in
    upgraded.auth.set({ role: 'member' });
    assert.equal(upgraded.store.get().startupDefaulted, false);
    assert.ok(!upgraded.names().includes('startup.set'));

    const chosen = services();
    chosen.store.set({ startupDefaulted: true }); // chose in Settings before signing in
    chosen.signIn();
    assert.ok(!chosen.names().includes('startup.set'));

    const waiting = services();
    waiting.auth.set({ signedIn: true, guild: null, user: null }); // profile not loaded yet
    assert.equal(waiting.store.get().startupDefaulted, false, 'waits for a real sign-in');

    const linux = services({ startup: { supported: false } });
    linux.signIn();
    assert.ok(!linux.names().includes('startup.set'));
    assert.equal(linux.store.get().startWithWindows, false);
    assert.equal(linux.store.get().startupDefaulted, true, 'decided once');
  });
});
