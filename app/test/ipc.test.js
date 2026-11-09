'use strict';
// IPC dispatcher, method table, preload bridge, event forwarding and the small pure helpers of the
// Electron-facing modules (app:// paths, guildcamp:// links). main.js's session and notification wiring
// is tested in main.test.js.
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');

const ipc = require('../src/main/ipc');
const { dispatch, serialiseError, buildMethods, forwardEvents, createIpc, METHOD_NAMES, EVENT_CHANNELS } = ipc;
const { createStore } = require('../src/main/store');
const { resolveAppPath, isAppUrl, isExternalUrl } = require('../src/main/window');
const { parseArgs, deepLinkRoute, findDeepLink, routeSlug } = require('../src/main/main');

const CONTRACT_METHODS = [
  'app.info', 'app.openExternal', 'app.openPath', 'app.showItemInFolder', 'app.pickFolder', 'app.quit', 'app.relaunch',
  'log.recent', 'settings.get', 'settings.set',
  'auth.state', 'auth.signIn', 'auth.signOut',
  'api.request', 'api.download',
  'calendar.export', 'secrets.set', 'secrets.has',
  'wow.installs', 'wow.addFolder', 'wow.removeFolder', 'wow.detectGuild',
  'sync.status', 'sync.now', 'sync.setEnabled',
  'addon.status', 'addon.check', 'addon.install', 'addon.update', 'addon.updateAll', 'addon.repair', 'addon.uninstall', 'addon.openFolder',
  'updater.status', 'updater.check', 'updater.download', 'updater.install',
  'publisher.status', 'publisher.publishAddon', 'publisher.publishApp', 'publisher.setRepoDir',
  'notify.test',
];

const CONTRACT_CHANNELS = ['auth', 'sync', 'addon', 'updater', 'publisher:log', 'server-event', 'navigate', 'log', 'settings', 'live'];
// Gone with the server: joining by itself, dev sign-in, the membership channel.
const REMOVED_METHODS = ['guild.autoJoin', 'membership.status', 'auth.devSignIn'];

/** `export const NAME = [ ... ];` from a renderer ES module, read as text (no browser or mock needed). */
function rendererList(file, name) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', ...file.split('/')), 'utf8');
  const m = new RegExp(`export const ${name} = (\\[[\\s\\S]*?\\]);`).exec(src);
  assert.ok(m, `${file} exports ${name}`);
  return [...vm.runInNewContext(`(${m[1]})`)]; // a plain array of this realm
}

let tmp;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-ipc-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

// ---------------------------------------------------------------------------------------------
describe('dispatch', () => {
  const methods = {
    'x.ok': async (a, b) => a + b,
    'x.none': () => undefined,
    'x.user': () => { throw Object.assign(new Error('You need to be an officer.'), { status: 403 }); },
    'x.bug': () => { const o = null; return o.field; },
    'x.string': () => { throw 'plain string'; }, // eslint-disable-line no-throw-literal
    'x.cancel': () => { throw Object.assign(new Error('Sign-in was cancelled.'), { code: 'cancelled' }); },
  };

  test('returns { ok, value } and maps undefined to null', async () => {
    assert.deepEqual(await dispatch(methods, 'x.ok', [2, 3]), { ok: true, value: 5 });
    assert.deepEqual(await dispatch(methods, 'x.none', []), { ok: true, value: null });
  });

  test('unknown methods are an error, including prototype names', async () => {
    for (const name of ['nope.nope', 'toString', '__proto__', 'constructor', 42, null]) {
      const res = await dispatch(methods, name, []);
      assert.equal(res.ok, false);
      assert.equal(res.error.status, 404);
      assert.match(res.error.message, /doesn't know how to/);
    }
  });

  test('errors are serialised as { message, status }', async () => {
    assert.deepEqual(await dispatch(methods, 'x.user', []), { ok: false, error: { message: 'You need to be an officer.', status: 403 } });
    assert.deepEqual(await dispatch(methods, 'x.string', []), { ok: false, error: { message: 'plain string' } });
    assert.deepEqual(await dispatch(methods, 'x.cancel', []), { ok: false, error: { message: 'Sign-in was cancelled.', code: 'cancelled' } });
  });

  test('programming errors are logged with the stack and shown as a generic message', async () => {
    const logged = [];
    const log = { error: (...a) => logged.push(['error', ...a]), warn: (...a) => logged.push(['warn', ...a]) };
    const res = await dispatch(methods, 'x.bug', [], { log });
    assert.deepEqual(res, { ok: false, error: { message: 'Something went wrong. Details are in the log.' } });
    assert.equal(logged[0][0], 'error');
    assert.ok(logged[0][2] instanceof TypeError);
  });

  test('non-array args are treated as no args', async () => {
    assert.deepEqual(await dispatch({ 'a.b': (...a) => a.length }, 'a.b', 'junk'), { ok: true, value: 0 });
  });

  test('serialiseError keeps ApiError status 0 (offline)', () => {
    const err = Object.assign(new Error("Can't reach the guild server (x: connection refused)."), { status: 0, name: 'ApiError' });
    assert.deepEqual(serialiseError(err), { message: err.message, status: 0 });
    assert.deepEqual(serialiseError(undefined), { message: 'Something went wrong. Details are in the log.' });
  });

  test("the core's 403 NO_GUILD keeps its code on the way to the renderer, so pages show the no-guild screen from it", async () => {
    const { NO_GUILD } = require('../src/core/http');
    const noGuild = Object.assign(new Error(NO_GUILD), { status: 403, code: 'NO_GUILD', name: 'ApiError' });
    assert.deepEqual(serialiseError(noGuild), { message: NO_GUILD, status: 403, code: 'NO_GUILD' });
    const res = await dispatch({ 'api.request': () => { throw noGuild; } }, 'api.request', []);
    assert.deepEqual(res, { ok: false, error: { message: NO_GUILD, status: 403, code: 'NO_GUILD' } });
    // Letters, digits, underscores and dashes, up to 40 characters; anything else is left out.
    assert.equal(serialiseError({ message: 'x', code: 'in-use' }).code, 'in-use');
    assert.equal(serialiseError({ message: 'x', code: 'RATE_LIMIT_2' }).code, 'RATE_LIMIT_2');
    for (const bad of ['no guild', '_x', '9lives', 'x', `A${'b'.repeat(40)}`, 'NO_GUILD<script>', 42]) {
      assert.equal('code' in serialiseError({ message: 'x', code: bad }), false, String(bad));
    }
  });
});

// ---------------------------------------------------------------------------------------------
describe('method list', () => {
  test('covers every method in ARCHITECTURE.md plus app.rendererReady', () => {
    for (const m of CONTRACT_METHODS) assert.ok(METHOD_NAMES.includes(m), `missing ${m}`);
    assert.ok(METHOD_NAMES.includes('app.rendererReady'));
    assert.equal(new Set(METHOD_NAMES).size, METHOD_NAMES.length);
  });

  test('buildMethods implements exactly METHOD_NAMES', () => {
    const methods = buildMethods(fakeDeps(tmp).deps);
    assert.deepEqual(Object.keys(methods).sort(), [...METHOD_NAMES].sort());
    for (const fn of Object.values(methods)) assert.equal(typeof fn, 'function');
  });

  test('event channels match the contract', () => {
    assert.deepEqual(EVENT_CHANNELS, CONTRACT_CHANNELS);
  });

  test('ipc.js, preload.js and the renderer\'s lib/gc.js list exactly the same methods and channels', () => {
    const { gc } = loadPreload();
    assert.deepEqual([...gc.methods], METHOD_NAMES, 'preload.js METHODS');
    assert.deepEqual([...gc.channels], EVENT_CHANNELS, 'preload.js CHANNELS');
    assert.deepEqual(rendererList('lib/gc.js', 'METHODS'), METHOD_NAMES, 'lib/gc.js METHODS');
    assert.deepEqual(rendererList('lib/gc.js', 'CHANNELS'), EVENT_CHANNELS, 'lib/gc.js CHANNELS');
    for (const m of REMOVED_METHODS) assert.ok(!METHOD_NAMES.includes(m), m);
    assert.ok(!EVENT_CHANNELS.includes('membership'));
  });

  test('the sync badge has words for every sync state', async () => {
    const { pathToFileURL } = require('url');
    const status = await import(pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'lib', 'status.js')).href);
    for (const state of ['off', 'idle', 'syncing', 'error', 'no-game']) {
      const d = status.describeSync({ state });
      assert.ok(d.label && !/undefined/.test(d.label), state);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// preload.js runs sandboxed in Electron; here it runs in a vm with a fake require('electron').
function loadPreload({ invokeResult } = {}) {
  const exposed = {};
  const invocations = [];
  const ipcListeners = {};
  const fakeElectron = {
    contextBridge: { exposeInMainWorld: (key, value) => { exposed[key] = value; } },
    ipcRenderer: {
      invoke: async (channel, ...args) => {
        invocations.push([channel, ...args]);
        return invokeResult ? invokeResult(...args) : { ok: true, value: args };
      },
      on: (channel, fn) => { (ipcListeners[channel] = ipcListeners[channel] || []).push(fn); },
    },
  };
  const code = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload', 'preload.js'), 'utf8');
  const errors = [];
  const sandbox = {
    require: (name) => {
      if (name !== 'electron') throw new Error(`preload may only require electron, tried ${name}`);
      return fakeElectron;
    },
    process: { platform: 'win32' },
    console: { error: (...a) => errors.push(a) },
  };
  vm.runInNewContext(code, sandbox, { filename: 'preload.js' });
  const emit = (channel, payload) => (ipcListeners['gc:event'] || []).forEach((fn) => fn({}, channel, payload));
  return { gc: exposed.gc, invocations, emit, errors };
}

describe('preload bridge', () => {
  test('METHODS and CHANNELS match ipc.js', () => {
    const { gc } = loadPreload();
    assert.deepEqual([...gc.methods], METHOD_NAMES);
    assert.deepEqual([...gc.channels], EVENT_CHANNELS);
  });

  test('exposes invoke, on and a namespaced wrapper per method', async () => {
    const { gc, invocations } = loadPreload();
    assert.equal(typeof gc.invoke, 'function');
    assert.equal(typeof gc.on, 'function');
    assert.equal(gc.platform, 'win32');
    for (const name of METHOD_NAMES) {
      const [ns, fn] = name.split('.');
      assert.equal(typeof gc[ns][fn], 'function', name);
    }
    const value = await gc.sync.setEnabled(false);
    assert.deepEqual(invocations.at(-1), ['gc:invoke', 'sync.setEnabled', false]);
    assert.deepEqual([...value], ['sync.setEnabled', false], 'resolves with the envelope value');
    await gc.invoke('api.request', 'GET', '/api/me');
    assert.deepEqual(invocations.at(-1), ['gc:invoke', 'api.request', 'GET', '/api/me']);
  });

  test('unwraps errors into a plain { message, status } rejection', async () => {
    const { gc } = loadPreload({ invokeResult: () => ({ ok: false, error: { message: 'No access.', status: 403 } }) });
    await assert.rejects(gc.addon.install('C:\\x'), (err) => {
      assert.deepEqual({ ...err }, { message: 'No access.', status: 403 });
      return true;
    });
  });

  test('refuses unknown methods without calling the main process', async () => {
    const { gc, invocations } = loadPreload();
    await assert.rejects(gc.invoke('fs.deleteEverything'), (err) => err.status === 404);
    assert.equal(invocations.length, 0);
  });

  test('on() delivers only its channel and returns an unsubscribe function', () => {
    const { gc, emit } = loadPreload();
    const got = [];
    const off = gc.on('sync', (p) => got.push(['sync', p]));
    gc.on('auth', (p) => got.push(['auth', p]));
    emit('sync', { state: 'idle' });
    emit('auth', { signedIn: true });
    emit('not-a-channel', 1);
    off();
    emit('sync', { state: 'syncing' });
    assert.deepEqual(got, [['sync', { state: 'idle' }], ['auth', { signedIn: true }]]);
  });

  test('on() rejects undocumented channels and a failing listener does not stop others', () => {
    const { gc, emit, errors } = loadPreload();
    assert.throws(() => gc.on('gc:invoke', () => {}), /Unknown event channel/);
    assert.throws(() => gc.on('sync'), /callback/);
    const got = [];
    gc.on('navigate', () => { throw new Error('bad listener'); });
    gc.on('navigate', (route) => got.push(route));
    emit('navigate', '/raids');
    assert.deepEqual(got, ['/raids']);
    assert.equal(errors.length, 1);
  });
});

// ---------------------------------------------------------------------------------------------
describe('createIpc', () => {
  function fakeIpcMain() {
    const handlers = {};
    return { handlers, handle: (ch, fn) => { handlers[ch] = fn; }, removeHandler: (ch) => { delete handlers[ch]; } };
  }
  const appEvent = { senderFrame: { url: 'app://guildcamp/index.html#/raids' } };

  test('registers one gc:invoke handler that dispatches', async () => {
    const ipcMain = fakeIpcMain();
    const bridge = createIpc({ methods: { 'a.b': (x) => x * 2 }, getWindows: () => [], ipcMain });
    assert.deepEqual(Object.keys(ipcMain.handlers), ['gc:invoke']);
    assert.deepEqual(await ipcMain.handlers['gc:invoke'](appEvent, 'a.b', 21), { ok: true, value: 42 });
    assert.deepEqual(await bridge.dispatch('a.b', 2), { ok: true, value: 4 });
    bridge.dispose();
    assert.deepEqual(ipcMain.handlers, {});
  });

  test('blocks calls from pages that are not app://guildcamp', async () => {
    const ipcMain = fakeIpcMain();
    let called = false;
    createIpc({ methods: { 'a.b': () => { called = true; } }, getWindows: () => [], ipcMain });
    const res = await ipcMain.handlers['gc:invoke']({ senderFrame: { url: 'https://evil.example/' } }, 'a.b');
    assert.deepEqual(res, { ok: false, error: { message: 'Not allowed.', status: 403 } });
    assert.equal(called, false);
  });

  test('broadcast sends gc:event to live windows only', () => {
    const sent = [];
    const win = (destroyed) => ({ isDestroyed: () => destroyed, webContents: { isDestroyed: () => false, send: (...a) => sent.push(a) } });
    const bridge = createIpc({ methods: {}, getWindows: () => [win(false), win(true), null], ipcMain: fakeIpcMain() });
    bridge.broadcast('sync', { state: 'idle' });
    assert.deepEqual(sent, [['gc:event', 'sync', { state: 'idle' }]]);
  });

  test('a failing send does not throw', () => {
    const bad = { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: () => { throw new Error('not cloneable'); } } };
    const bridge = createIpc({ methods: {}, getWindows: () => [bad], ipcMain: fakeIpcMain(), log: { warn() {} } });
    assert.doesNotThrow(() => bridge.broadcast('auth', {}));
  });
});

// ---------------------------------------------------------------------------------------------
// Fakes for buildMethods
function fakeDeps(dir, overrides = {}) {
  const calls = [];
  const record = (name, value) => (...args) => { calls.push([name, ...args]); return typeof value === 'function' ? value(...args) : value; };
  const store = createStore(dir);
  // main.js's session: Battle.net in the app plus who I am in the local core.
  let authState = { available: true, signedIn: true, battletag: 'Owner#1', characters: [], user: { battletag: 'Owner#1' }, guild: { name: 'Camp Fire' }, role: 'owner' };
  const auth = Object.assign(new EventEmitter(), {
    state: () => authState,
    refresh: record('auth.refresh', () => authState),
    signIn: record('auth.signIn', () => authState),
    signOut: record('auth.signOut', () => { authState = { ...authState, signedIn: false, battletag: null }; return authState; }),
    setGuild: (guild) => { authState = { ...authState, guild }; },
  });
  const deps = {
    store,
    log: { info() {}, warn() {}, error() {}, recent: () => [{ t: 'x', level: 'info', scope: 'app', msg: 'hi' }] },
    auth,
    api: {
      request: record('api.request', (m, p, b, o) => (p === '/api/calendar.ics' ? 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n' : { m, p, b, ...(o ? { o } : {}) })),
      download: record('api.download', Buffer.from('backup-bytes')),
    },
    wow: {
      findInstalls: record('wow.findInstalls', []),
      detectGuild: record('wow.detectGuild', { characters: [{ name: 'Thrallia', guild: 'Just Now WoW' }], guild: { name: 'Just Now WoW', realm: 'Forever', faction: 'Horde' } }),
    },
    sync: { status: () => ({ state: 'idle' }), syncNow: record('sync.syncNow', { state: 'syncing' }), setEnabled: record('sync.setEnabled') },
    addon: {
      status: () => ({ installs: [{ dir: path.join(dir, 'game', '_forever_'), addonsDir: path.join(dir, 'game', '_forever_', 'Interface', 'AddOns') }] }),
      check: record('addon.check', {}), install: record('addon.install', 'installed'), update: record('addon.update'), updateAll: record('addon.updateAll'),
      repair: record('addon.repair'), uninstall: record('addon.uninstall'),
    },
    updater: { status: () => ({ state: 'dev' }), check: record('updater.check', {}), download: record('updater.download'), install: record('updater.install') },
    publisher: { status: () => ({ canPublish: true }), publishAddon: record('publisher.publishAddon', 'ok'), publishApp: record('publisher.publishApp', 'ok'), setRepoDir: record('publisher.setRepoDir', 'set') },
    notify: { test: record('notify.test', { shown: true }) },
    startup: { set: record('startup.set', (v) => v), get: () => false, supported: true },
    shell: { openExternal: record('shell.openExternal', Promise.resolve()), openPath: record('shell.openPath', ''), showItemInFolder: record('shell.showItemInFolder') },
    dialog: {
      showOpenDialog: record('dialog.showOpenDialog', { canceled: false, filePaths: [dir] }),
      showSaveDialog: record('dialog.showSaveDialog', { canceled: false, filePath: path.join(dir, 'saved.zip') }),
    },
    getWindow: () => null,
    appInfo: () => ({ version: '0.11.0' }),
    quit: record('quit'),
    relaunch: record('relaunch'),
    rendererReady: record('rendererReady', { smoke: false }),
    downloadsDir: dir,
    ...overrides,
  };
  return { deps, calls, store, auth };
}

const names = (calls) => calls.map((c) => c[0]);

describe('buildMethods', () => {
  test('settings.set validates, persists and returns settings', async () => {
    const { deps, store } = fakeDeps(tmp);
    const m = buildMethods(deps);
    const out = await m['settings.set']({ theme: 'dark', windowBounds: { x: 999 } });
    assert.equal(out.theme, 'dark');
    assert.equal(store.get().windowBounds, null, 'internal keys from the renderer are ignored');
    await assert.rejects(m['settings.set']({ theme: 'neon' }), /system, light or dark/);
  });

  test('settings.set applies side effects: startWithWindows and syncEnabled', async () => {
    const { deps, calls, store } = fakeDeps(tmp);
    const m = buildMethods(deps);
    await m['settings.set']({ startWithWindows: true, syncEnabled: false });
    assert.deepEqual(calls.find((c) => c[0] === 'startup.set'), ['startup.set', true]);
    assert.deepEqual(calls.find((c) => c[0] === 'sync.setEnabled'), ['sync.setEnabled', false]);
    assert.equal(store.get().startWithWindows, true);
    assert.equal(store.get().syncEnabled, false);
    assert.equal(store.get().startupDefaulted, true, 'a choice made by the person is never overridden by the first-launch default');
  });

  test('settings.set accepts addonAutoInstall but not the app-managed keys', async () => {
    const { deps, store } = fakeDeps(tmp);
    const m = buildMethods(deps);
    const out = await m['settings.set']({ addonAutoInstall: false, startupDefaulted: true, addonOptOut: ['C:\\x'] });
    assert.equal(out.addonAutoInstall, false);
    assert.equal(store.get().startupDefaulted, false, 'ignored from the renderer');
    assert.deepEqual(store.get().addonOptOut, []);
    await assert.rejects(m['settings.set']({ addonAutoInstall: 'yes' }), /on or off/);
  });

  test('wow.detectGuild reads the folders from settings', async () => {
    const { deps, calls, store } = fakeDeps(tmp);
    store.set({ extraWowFolders: [tmp] });
    const m = buildMethods(deps);
    const found = await m['wow.detectGuild']();
    assert.equal(found.guild.name, 'Just Now WoW');
    assert.deepEqual(calls.find((c) => c[0] === 'wow.detectGuild'), ['wow.detectGuild', { extraRoots: [path.resolve(tmp)], scanDefaults: true, otherFolders: [] }]);
    for (const gone of REMOVED_METHODS) assert.equal(m[gone], undefined, gone);
  });

  test('a failing startup change leaves the setting unchanged', async () => {
    const { deps, store } = fakeDeps(tmp, {});
    deps.startup = { set: () => { throw new Error("Starting with your computer isn't supported on this system yet."); } };
    const m = buildMethods(deps);
    await assert.rejects(m['settings.set']({ startWithWindows: true }), /isn't supported/);
    assert.equal(store.get().startWithWindows, false);
  });

  test('settings.set takes the Discord webhook and the Battle.net region; there is no server address any more', async () => {
    const { deps, calls, store } = fakeDeps(tmp);
    const m = buildMethods(deps);
    const out = await m['settings.set']({ discordWebhook: ' https://discord.com/api/webhooks/9/abc ', bnetRegion: 'us' });
    assert.equal(out.discordWebhook, 'https://discord.com/api/webhooks/9/abc');
    assert.equal(out.bnetRegion, 'us');
    await assert.rejects(m['settings.set']({ discordWebhook: 'https://example.com/hook' }), /isn't a Discord webhook address/);
    await assert.rejects(m['settings.set']({ serverUrl: 'https://other.example.com' }), /not a setting/);
    assert.equal(store.get().discordWebhook, 'https://discord.com/api/webhooks/9/abc', 'a refused value changes nothing');
    assert.equal((await m['settings.set']({ discordWebhook: '' })).discordWebhook, null);
    assert.ok(!names(calls).includes('auth.signOut'), 'nothing signs anyone out');
  });

  test('settings.set with no real change does nothing', async () => {
    const { deps, calls } = fakeDeps(tmp);
    await buildMethods(deps)['settings.set']({ theme: 'system', bnetRegion: 'eu' });
    assert.deepEqual(calls, []);
  });

  test('api.request only allows /api/ paths and passes the call on to the local core', async () => {
    const { deps, calls } = fakeDeps(tmp);
    const m = buildMethods(deps);
    assert.deepEqual(await m['api.request']('get', '/api/raids'), { m: 'GET', p: '/api/raids', b: undefined });
    await assert.rejects(m['api.request']('GET', '/updates/app/latest.yml'), /\/api\//);
    await assert.rejects(m['api.request']('GET', 'https://evil.example/api/x'), /\/api\//);
    await assert.rejects(m['api.request']('GET', '/api/../auth'), /\/api\//);
    await assert.rejects(m['api.request']('TRACE', '/api/raids'), /GET, POST/);
    assert.equal(calls.filter((c) => c[0] === 'api.request').length, 1);
  });

  test('api.request checks only the path: a query may contain "..", encoded traversal is refused', async () => {
    const { deps, calls } = fakeDeps(tmp);
    const m = buildMethods(deps);
    // Searching for text with ".." used to fail with "path must start with /api/".
    assert.deepEqual(await m['api.request']('GET', '/api/prices?q=a..b'), { m: 'GET', p: '/api/prices?q=a..b', b: undefined });
    await m['api.request']('GET', '/api/characters/Zul%C3%A9');
    await m['api.request']('GET', '/api/characters/Zulé'); // the URL parser encodes it on the way out
    await m['api.request']('GET', '/api/crafters?q=..%2F..%2Fauth');
    assert.equal(calls.filter((c) => c[0] === 'api.request').length, 4);
    for (const bad of [
      '/api/../auth/dev', '/api/%2e%2e/auth/dev', '/api/%2E%2E/%2e%2E/x', '/api/raids/%2e', '/api/raids/./1', '/api/x/..',
      '/api//auth/dev', '/api\\..\\auth', '//evil.example/api/x', '/apix/raids', '/API/raids', '/api/raids/a%2F..%2F..%2Fb',
    ]) {
      await assert.rejects(m['api.request']('GET', bad), /\/api\//, bad);
    }
    assert.equal(calls.filter((c) => c[0] === 'api.request').length, 4, 'none of those reached the core');
  });

  test('api.download uses the same path rules', async () => {
    const { checkDownloadPath, serverPathname } = ipc;
    assert.equal(checkDownloadPath('/api/admin/backups/latest?name=a..b'), '/api/admin/backups/latest');
    assert.throws(() => checkDownloadPath('/updates/addon/WowGuild-0.11.1.zip'), /\/api\//, 'nothing is served from /updates/ any more');
    assert.throws(() => checkDownloadPath('/api/%2e%2e/x'), /\/api\//);
    assert.throws(() => checkDownloadPath('/data/guild.db'), /\/api\//);
    assert.equal(serverPathname('/api/x?y=../..'), '/api/x');
    assert.equal(serverPathname('/api/a/../b'), null);
    assert.equal(serverPathname(42), null);
  });

  test('api.request no longer refreshes anything itself: the core announces session changes', async () => {
    const { deps, calls } = fakeDeps(tmp);
    const m = buildMethods(deps);
    await m['api.request']('PUT', '/api/guild/settings', { officer_rank_max: 2 });
    assert.deepEqual(names(calls), ['api.request']);
  });

  test('calendar.export saves the .ics from the core with a save dialog', async () => {
    const { deps, calls } = fakeDeps(tmp);
    deps.dialog.showSaveDialog = async (win, opts) => { calls.push(['dialog.showSaveDialog', win, opts]); return { canceled: false, filePath: path.join(tmp, 'raids.ics') }; };
    const m = buildMethods(deps);
    const saved = await m['calendar.export']();
    assert.equal(saved, path.join(tmp, 'raids.ics'));
    assert.equal(fs.readFileSync(saved, 'utf8'), 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n');
    const req = calls.find((c) => c[0] === 'api.request');
    assert.deepEqual(req.slice(1), ['GET', '/api/calendar.ics', undefined, { raw: true }]);
    const dlg = calls.find((c) => c[0] === 'dialog.showSaveDialog')[2];
    assert.equal(dlg.defaultPath, path.join(tmp, 'Camp Fire raids.ics'), 'named after the guild');
    assert.deepEqual(dlg.filters, [{ name: 'Calendar file', extensions: ['ics'] }]);
    // Cancelled: nothing written.
    deps.dialog.showSaveDialog = async () => ({ canceled: true });
    assert.equal(await buildMethods(deps)['calendar.export'](), null);
    // Not an iCalendar reply: a plain error.
    deps.api.request = async () => '{"error":"x"}';
    await assert.rejects(buildMethods(deps)['calendar.export'](), /couldn't make the calendar file/);
  });

  test('secrets: only the Anthropic key, set or cleared, never read back', async () => {
    const { deps, store } = fakeDeps(tmp);
    const m = buildMethods(deps);
    assert.equal(await m['secrets.has']('anthropicKey'), false);
    const r = await m['secrets.set']('anthropicKey', '  sk-ant-api03-abcdefghijklmnopqrstuvwxyz  ');
    assert.equal(r.name, 'anthropicKey');
    assert.equal(r.set, true);
    assert.equal(typeof r.encrypted, 'boolean');
    assert.ok(!JSON.stringify(r).includes('sk-ant'), 'the value is never sent back');
    assert.equal(store.getSecret('anthropicKey'), 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz');
    assert.equal(await m['secrets.has']('anthropicKey'), true);
    for (const bad of ['short', 'has spaces in the middle of it ok', 'x'.repeat(400), 42]) {
      await assert.rejects(m['secrets.set']('anthropicKey', bad), (err) => err.status === 400, String(bad).slice(0, 20));
    }
    assert.equal(store.getSecret('anthropicKey'), 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz', 'a refused value changes nothing');
    for (const other of ['bnetToken', 'deviceToken', '__proto__', undefined]) {
      await assert.rejects(m['secrets.set'](other, 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz'), /doesn't keep that/);
      await assert.rejects(Promise.resolve().then(() => m['secrets.has'](other)), /doesn't keep that/);
    }
    assert.deepEqual(await m['secrets.set']('anthropicKey', ''), { name: 'anthropicKey', set: false, encrypted: store.secretsEncrypted() });
    assert.equal(store.getSecret('anthropicKey'), null);
    assert.equal(await m['secrets.has']('anthropicKey'), false);
  });

  test('api.download asks where to save, then writes the file', async () => {
    const { deps, calls } = fakeDeps(tmp);
    const m = buildMethods(deps);
    const saved = await m['api.download']('/api/admin/backups/latest', 'guild:backup?.db');
    assert.equal(saved, path.join(tmp, 'saved.zip'));
    assert.equal(fs.readFileSync(saved, 'utf8'), 'backup-bytes');
    const dialogCall = calls.find((c) => c[0] === 'dialog.showSaveDialog');
    assert.equal(dialogCall[2].defaultPath, path.join(tmp, 'guild_backup_.db'));
    await assert.rejects(m['api.download']('/etc/passwd'), /\/api\//);
  });

  test('api.download returns null when the dialog is cancelled', async () => {
    const { deps, calls } = fakeDeps(tmp);
    deps.dialog.showSaveDialog = async () => ({ canceled: true });
    assert.equal(await buildMethods(deps)['api.download']('/api/x', 'x.zip'), null);
    assert.ok(!names(calls).includes('api.download'));
  });

  test('app.openExternal only opens http(s) links', async () => {
    const { deps, calls } = fakeDeps(tmp);
    const m = buildMethods(deps);
    await m['app.openExternal']('https://www.wowhead.com/classic/item=19019');
    await assert.rejects(m['app.openExternal']('file:///C:/Windows/System32/calc.exe'), /web links/);
    await assert.rejects(m['app.openExternal']('javascript:alert(1)'), /web links/);
    assert.equal(calls.filter((c) => c[0] === 'shell.openExternal').length, 1);
  });

  test('app.openPath opens folders and text files, not programs', async () => {
    const { deps } = fakeDeps(tmp);
    const m = buildMethods(deps);
    fs.writeFileSync(path.join(tmp, 'guildcamp.log'), 'x');
    fs.writeFileSync(path.join(tmp, 'evil.exe'), 'x');
    assert.equal(await m['app.openPath'](tmp), true);
    assert.equal(await m['app.openPath'](path.join(tmp, 'guildcamp.log')), true);
    await assert.rejects(m['app.openPath'](path.join(tmp, 'evil.exe')), /only opens folders/);
    await assert.rejects(m['app.openPath']('relative/path'), /full path/);
    await assert.rejects(m['app.openPath'](path.join(tmp, 'missing')), /doesn't exist/);
  });

  test('app.pickFolder returns the folder or null', async () => {
    const { deps } = fakeDeps(tmp);
    assert.equal(await buildMethods(deps)['app.pickFolder']({ title: 'Pick WoW' }), tmp);
    deps.dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
    assert.equal(await buildMethods(deps)['app.pickFolder'](), null);
  });

  test('wow.addFolder / removeFolder update extraWowFolders', async () => {
    const { deps, store } = fakeDeps(tmp);
    const m = buildMethods(deps);
    await m['wow.addFolder'](tmp);
    await m['wow.addFolder'](tmp);
    assert.deepEqual(store.get().extraWowFolders, [path.resolve(tmp)]);
    await assert.rejects(m['wow.addFolder'](path.join(tmp, 'nope')), /doesn't exist/);
    await m['wow.removeFolder'](tmp);
    assert.deepEqual(store.get().extraWowFolders, []);
  });

  test('sync.setEnabled persists and applies', async () => {
    const { deps, calls, store } = fakeDeps(tmp);
    await buildMethods(deps)['sync.setEnabled'](false);
    assert.equal(store.get().syncEnabled, false);
    assert.deepEqual(calls.find((c) => c[0] === 'sync.setEnabled'), ['sync.setEnabled', false]);
  });

  test('publishing goes straight to the publisher, which checks the gh CLI itself (guild rank plays no part)', async () => {
    const { deps, calls, auth } = fakeDeps(tmp);
    const m = buildMethods(deps);
    auth.setGuild(null);
    assert.equal(await m['publisher.publishAddon']({ bump: 'patch', notes: 'x' }), 'ok');
    assert.equal(await m['publisher.publishApp']('not an object'), 'ok');
    assert.deepEqual(calls.filter((c) => c[0].startsWith('publisher.')), [['publisher.publishAddon', { bump: 'patch', notes: 'x' }], ['publisher.publishApp', {}]]);
  });

  test('addon.openFolder only opens folders of known installs', async () => {
    const { deps, calls } = fakeDeps(tmp);
    const m = buildMethods(deps);
    await m['addon.openFolder'](path.join(tmp, 'game', '_forever_'));
    assert.equal(calls.find((c) => c[0] === 'shell.openPath')[1], path.join(tmp, 'game', '_forever_', 'Interface', 'AddOns'));
    await assert.rejects(m['addon.openFolder']('C:\\Windows'), /isn't in the list/);
  });

  test('plain pass-throughs reach their services', async () => {
    const { deps, calls } = fakeDeps(tmp);
    const m = buildMethods(deps);
    await m['addon.install']('D:\\WoW\\_forever_');
    await m['updater.check']();
    await m['notify.test']();
    await m['auth.signIn']();
    await m['auth.state']({ refresh: true });
    assert.equal(m['auth.state']().guild.name, 'Camp Fire');
    assert.deepEqual(m['log.recent']()[0].msg, 'hi');
    assert.deepEqual(m['app.rendererReady']({ routes: ['/'] }), { smoke: false });
    assert.deepEqual(names(calls), ['addon.install', 'updater.check', 'notify.test', 'auth.signIn', 'auth.refresh', 'rendererReady']);
  });
});

// ---------------------------------------------------------------------------------------------
describe('forwardEvents', () => {
  test('forwards service events to the documented channels', () => {
    const sent = [];
    const src = () => new EventEmitter();
    const s = { store: src(), log: src(), auth: src(), sync: src(), addon: src(), updater: src(), publisher: src() };
    const off = forwardEvents({ broadcast: (c, p) => sent.push([c, p]), ...s });
    s.auth.emit('change', { signedIn: true });
    s.sync.emit('status', { state: 'idle' });
    s.addon.emit('status', { installs: [] });
    s.updater.emit('status', { state: 'dev' });
    s.publisher.emit('log', 'building');
    s.log.emit('line', { msg: 'x' });
    s.store.emit('change', { theme: 'dark' }, ['theme']);
    s.store.emit('change', { windowBounds: {} }, ['windowBounds']);
    assert.deepEqual(sent.map((x) => x[0]), ['auth', 'sync', 'addon', 'updater', 'publisher:log', 'log', 'settings']);
    off();
    s.auth.emit('change', {});
    assert.equal(sent.length, 7);
  });

  test('app-managed settings are not broadcast; a membership source is ignored', () => {
    const sent = [];
    const membership = new EventEmitter();
    const store = new EventEmitter();
    const off = forwardEvents({ broadcast: (c, p) => sent.push([c, p]), membership, store });
    membership.emit('change', { status: 'joined' });
    store.emit('change', { startupDefaulted: true }, ['startupDefaulted']);
    store.emit('change', { addonOptOut: [] }, ['addonOptOut']);
    store.emit('change', { startWithWindows: true, startupDefaulted: true }, ['startWithWindows', 'startupDefaulted']);
    assert.deepEqual(sent.map((x) => x[0]), ['settings']);
    off();
  });
});

// ---------------------------------------------------------------------------------------------
describe('app:// protocol paths', () => {
  const root = path.resolve(os.tmpdir(), 'renderer-root');

  test('maps files with the right MIME types', () => {
    assert.deepEqual(resolveAppPath(root, 'app://guildcamp/index.html'), { file: path.join(root, 'index.html'), mime: 'text/html; charset=utf-8' });
    assert.equal(resolveAppPath(root, 'app://guildcamp/lib/router.js').mime, 'text/javascript; charset=utf-8');
    assert.equal(resolveAppPath(root, 'app://guildcamp/styles/app.css').mime, 'text/css; charset=utf-8');
    assert.equal(resolveAppPath(root, 'app://guildcamp/vendor/fonts/alegreya.woff2').mime, 'font/woff2');
    assert.equal(resolveAppPath(root, 'app://guildcamp/assets/logo.svg').mime, 'image/svg+xml');
    assert.equal(resolveAppPath(root, 'app://guildcamp/assets/My%20Icon.png').file, path.join(root, 'assets', 'My Icon.png'));
  });

  test('the root and extension-less paths serve index.html', () => {
    assert.equal(resolveAppPath(root, 'app://guildcamp/').file, path.join(root, 'index.html'));
    assert.equal(resolveAppPath(root, 'app://guildcamp/raids/12').file, path.join(root, 'index.html'));
  });

  test('never escapes the renderer folder', () => {
    const attempts = [
      'app://guildcamp/../../../Windows/win.ini',
      'app://guildcamp/%2e%2e/%2e%2e/secret.txt',
      'app://guildcamp/..%2f..%2fsecret.txt',
      'app://guildcamp/..%5c..%5csecret.txt',
      'app://guildcamp/C:/Windows/win.ini',
      'app://guildcamp//etc/passwd',
    ];
    for (const url of attempts) {
      const hit = resolveAppPath(root, url);
      if (hit.file) assert.ok(hit.file.startsWith(root + path.sep), `${url} → ${hit.file}`);
    }
    assert.equal(resolveAppPath(root, 'app://guildcamp/a%00.js').status, 400);
    assert.equal(resolveAppPath(root, 'app://guildcamp/%E0%A4%A').status, 400);
    assert.equal(resolveAppPath(root, 'app://other/index.html').status, 404);
    assert.equal(resolveAppPath(root, 'https://guildcamp/index.html').status, 404);
  });

  test('url helpers', () => {
    assert.equal(isAppUrl('app://guildcamp/index.html#/raids'), true);
    assert.equal(isAppUrl('app://guildcampx/index.html'), false);
    assert.equal(isAppUrl('https://wow.example.com'), false);
    assert.equal(isExternalUrl('https://www.wowhead.com/item=1'), true);
    assert.equal(isExternalUrl('http://x.y'), true);
    assert.equal(isExternalUrl('file:///C:/x'), false);
    assert.equal(isExternalUrl('javascript:alert(1)'), false);
  });
});

// ---------------------------------------------------------------------------------------------
describe('main.js helpers', () => {
  test('parseArgs reads flags in both --x=v and --x v forms', () => {
    const a = parseArgs(['.', '--hidden', '--user-data', 'C:\\tmp\\gc', '--smoke', '--smoke-seed', '--smoke-routes=/,/raids, /bank', '--smoke-login=Dev#1234', '--smoke-out=out', '--smoke-user-data=scratch']);
    assert.deepEqual(a, { hidden: true, dev: false, smoke: true, smokeScan: false, smokeSeed: true, userData: 'C:\\tmp\\gc', smokeUserData: 'scratch', smokeRoutes: ['/', '/raids', '/bank'], smokeOut: 'out' });
    assert.equal(parseArgs(['--user-data', 'guildcamp://raids/1']).userData, null, 'a link is never taken as a value');
    assert.equal(parseArgs(['--smoke']).smokeSeed, false);
    assert.deepEqual(parseArgs([]).smokeRoutes, null);
  });

  test('links open read-only pages; join links are gone and just focus the app', () => {
    assert.equal(deepLinkRoute('guildcamp://join/AbC123'), null);
    assert.equal(deepLinkRoute('GUILDCAMP://JOIN/xyz'), null);
    assert.equal(deepLinkRoute('guildcamp://other/abc'), null);
    assert.equal(deepLinkRoute('https://join/abc'), null);
    assert.equal(deepLinkRoute(undefined), null);
    // Read-only app pages open directly.
    assert.equal(deepLinkRoute('guildcamp://raids/12'), '/raids/12');
    assert.equal(deepLinkRoute('guildcamp://raids/12/loot'), '/raids/12/loot');
    assert.equal(deepLinkRoute('guildcamp://characters/Zul%C3%A9'), '/characters/Zul%C3%A9');
    assert.equal(deepLinkRoute('guildcamp://coach'), '/coach');
    assert.equal(deepLinkRoute('guildcamp://raids/..%2F..'), null);
    assert.equal(deepLinkRoute('guildcamp://raids/1/2/3/4'), null);
    assert.equal(deepLinkRoute('guildcamp://admin'), null);
  });

  test('finds the link among Windows launch arguments', () => {
    assert.equal(findDeepLink(['C:\\GC\\Guild Camp.exe', '--allow-file-access-from-files', 'guildcamp://raids/12']), 'guildcamp://raids/12');
    assert.equal(findDeepLink(['x', '--hidden']), null);
  });

  test('route slugs make safe file names', () => {
    assert.equal(routeSlug('/'), 'home');
    assert.equal(routeSlug('/raids'), 'raids');
    assert.equal(routeSlug('/guild-settings'), 'guild-settings');
    assert.equal(routeSlug('/welcome?step=game'), 'welcome-step-game');
  });
});

// ---------------------------------------------------------------------------------------------
describe('main window', () => {
  // window.js requires Electron lazily; stand in a fake BrowserWindow for these tests only.
  const electronId = require.resolve('electron');
  let saved;
  let windows;
  beforeEach(() => {
    saved = require.cache[electronId];
    windows = [];
    class FakeWindow extends EventEmitter {
      constructor(opts) {
        super();
        this.opts = opts;
        this.calls = [];
        this.visible = false;
        this.maximized = false;
        this.webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler() {} });
        windows.push(this);
      }
      isDestroyed() { return false; }
      isMinimized() { return false; }
      isVisible() { return this.visible; }
      isMaximized() { return this.maximized; }
      getNormalBounds() { return { x: 10, y: 10, width: 1280, height: 820 }; }
      maximize() { this.calls.push('maximize'); this.maximized = true; this.visible = true; }
      show() { this.calls.push('show'); this.visible = true; }
      hide() { this.calls.push('hide'); this.visible = false; }
      focus() { this.calls.push('focus'); }
      restore() { this.calls.push('restore'); }
      loadURL() { return Promise.resolve(); }
    }
    require.cache[electronId] = { id: electronId, filename: electronId, loaded: true, exports: { BrowserWindow: FakeWindow, shell: { openExternal: async () => {} }, screen: { getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }] } } };
  });
  afterEach(() => {
    if (saved) require.cache[electronId] = saved;
    else delete require.cache[electronId];
  });

  const { createMainWindow, showWindow } = require('../src/main/window');
  function open({ startHidden, maximized }) {
    const store = createStore(tmp);
    store.set({ windowBounds: { x: 10, y: 10, width: 1280, height: 820, maximized } });
    const win = createMainWindow({ store, log: { warn() {}, error() {} }, preload: 'x.js', startHidden, isQuitting: () => false });
    return { win, store };
  }

  test('started hidden (start with Windows) and last closed maximised: stays in the tray until opened', () => {
    const { win } = open({ startHidden: true, maximized: true });
    win.emit('ready-to-show');
    assert.deepEqual(win.calls, [], 'not maximised (which would show it) and not shown');
    assert.equal(win.visible, false);
    showWindow(win); // opened from the tray
    assert.deepEqual(win.calls, ['maximize', 'focus'], 'maximised the first time it is shown');
    win.hide();
    showWindow(win);
    assert.deepEqual(win.calls.slice(-2), ['show', 'focus'], 'later shows keep whatever size it has');
  });

  test('a normal start maximises when shown; a never-shown window keeps the saved maximised choice', () => {
    const shown = open({ startHidden: false, maximized: true }).win;
    shown.emit('ready-to-show');
    assert.deepEqual(shown.calls, ['maximize', 'focus']);

    const { win, store } = open({ startHidden: true, maximized: true });
    win.emit('close', { preventDefault() {} }); // quitting from the tray before ever opening it
    assert.equal(store.get().windowBounds.maximized, true);

    const plain = open({ startHidden: false, maximized: false }).win;
    plain.emit('ready-to-show');
    assert.deepEqual(plain.calls, ['show', 'focus']);
  });
});
