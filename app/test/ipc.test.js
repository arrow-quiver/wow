'use strict';
// IPC dispatcher, method table, preload bridge, event forwarding, the event-feed poller and the
// small pure helpers of the Electron-facing modules (app:// paths, join links, sign-in URL parsing).
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
const { createEvents, readFeed } = require('../src/main/events');
const { resolveAppPath, isAppUrl, isExternalUrl } = require('../src/main/window');
const { parseDoneUrl, signInUrl } = require('../src/main/auth');
const { parseArgs, deepLinkRoute, findDeepLink, routeSlug, throttle } = require('../src/main/main');

const CONTRACT_METHODS = [
  'app.info', 'app.openExternal', 'app.openPath', 'app.showItemInFolder', 'app.pickFolder', 'app.quit', 'app.relaunch',
  'log.recent', 'settings.get', 'settings.set',
  'auth.state', 'auth.signIn', 'auth.devSignIn', 'auth.signOut',
  'api.request', 'api.download',
  'wow.installs', 'wow.addFolder', 'wow.removeFolder', 'wow.detectGuild',
  'guild.autoJoin', 'membership.status',
  'sync.status', 'sync.now', 'sync.setEnabled',
  'addon.status', 'addon.check', 'addon.install', 'addon.update', 'addon.updateAll', 'addon.repair', 'addon.uninstall', 'addon.openFolder',
  'updater.status', 'updater.check', 'updater.download', 'updater.install',
  'publisher.status', 'publisher.publishAddon', 'publisher.publishApp', 'publisher.setRepoDir',
  'notify.test',
];

const CONTRACT_CHANNELS = ['auth', 'sync', 'addon', 'updater', 'publisher:log', 'server-event', 'navigate', 'log', 'settings', 'membership'];

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
    for (const m of ['wow.detectGuild', 'guild.autoJoin', 'membership.status']) assert.ok(METHOD_NAMES.includes(m), m);
    assert.ok(EVENT_CHANNELS.includes('membership'));
  });

  test('the sync badge has words for every sync state, including waiting for a guild', async () => {
    const { pathToFileURL } = require('url');
    const status = await import(pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'lib', 'status.js')).href);
    assert.deepEqual(status.describeSync({ state: 'no-guild' }), { kind: 'warn', label: 'Waiting to match your guild' });
    for (const state of ['off', 'idle', 'syncing', 'error', 'signed-out', 'no-game', 'no-guild']) {
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
  store.setSecret('deviceToken', 'gcd_signedin12345');
  let authState = { signedIn: true, server: store.get().serverUrl, user: { battletag: 'Owner#1' }, guild: { name: 'G' }, role: 'owner' };
  const auth = Object.assign(new EventEmitter(), {
    state: () => authState,
    refresh: record('auth.refresh', () => authState),
    signIn: record('auth.signIn', () => authState),
    devSignIn: record('auth.devSignIn', () => authState),
    signOut: record('auth.signOut', () => { authState = { ...authState, signedIn: false, user: null, guild: null, role: null }; return authState; }),
    setRole: (role) => { authState = { ...authState, role }; },
  });
  const deps = {
    store,
    log: { info() {}, warn() {}, error() {}, recent: () => [{ t: 'x', level: 'info', scope: 'app', msg: 'hi' }] },
    auth,
    api: { request: record('api.request', (m, p, b) => ({ m, p, b })), download: record('api.download', Buffer.from('backup-bytes')) },
    wow: {
      findInstalls: record('wow.findInstalls', []),
      detectGuild: record('wow.detectGuild', { characters: [{ name: 'Thrallia', guild: 'Just Now WoW' }], guild: { name: 'Just Now WoW', realm: 'Forever', faction: 'Horde' } }),
    },
    membership: {
      autoJoin: record('membership.autoJoin', { status: 'joined', guild: { id: 1, name: 'Just Now WoW', faction: 'Horde' }, role: 'member', via: 'roster', character: 'Thrallia', reason: "You're in Just Now WoW.", detected: null }),
      status: record('membership.status', null),
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
      showMessageBox: record('dialog.showMessageBox', { response: 0 }), // "Switch"
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
    const out = await m['settings.set']({ theme: 'dark', lastEventId: 999 });
    assert.equal(out.theme, 'dark');
    assert.equal(store.get().lastEventId, 0, 'internal keys from the renderer are ignored');
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
    assert.equal(store.get().startupDefaulted, true, 'a choice made by the person is never overridden by the first sign-in default');
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

  test('wow.detectGuild reads the folders from settings; guild.autoJoin and membership.status reach membership', async () => {
    const { deps, calls, store } = fakeDeps(tmp);
    store.set({ extraWowFolders: [tmp] });
    const m = buildMethods(deps);
    const found = await m['wow.detectGuild']();
    assert.equal(found.guild.name, 'Just Now WoW');
    assert.deepEqual(calls.find((c) => c[0] === 'wow.detectGuild'), ['wow.detectGuild', { extraRoots: [path.resolve(tmp)], scanDefaults: true }]);
    const result = await m['guild.autoJoin']();
    assert.equal(result.status, 'joined');
    assert.equal(await m['membership.status'](), null);
    assert.deepEqual(names(calls), ['wow.detectGuild', 'membership.autoJoin', 'membership.status']);
  });

  test('a failing startup change leaves the setting unchanged', async () => {
    const { deps, store } = fakeDeps(tmp, {});
    deps.startup = { set: () => { throw new Error("Starting with your computer isn't supported on this system yet."); } };
    const m = buildMethods(deps);
    await assert.rejects(m['settings.set']({ startWithWindows: true }), /isn't supported/);
    assert.equal(store.get().startWithWindows, false);
  });

  test('changing the server signs out first, resets the event cursor and re-checks updates', async () => {
    const { deps, calls, store } = fakeDeps(tmp);
    store.set({ lastEventId: 55 });
    const m = buildMethods(deps);
    let serverAtSignOut = null;
    const realSignOut = deps.auth.signOut;
    deps.auth.signOut = (...a) => { serverAtSignOut = store.get().serverUrl; return realSignOut(...a); };
    const out = await m['settings.set']({ serverUrl: 'https://other.example.com/' });
    await new Promise((r) => setImmediate(r));
    assert.equal(out.serverUrl, 'https://other.example.com');
    assert.equal(serverAtSignOut, 'https://wow.cjplumbing.co.za', 'signs out against the old server');
    assert.equal(store.get().lastEventId, 0);
    assert.equal(names(calls)[0], 'dialog.showMessageBox', 'confirmed before anything changes');
    assert.ok(names(calls).includes('auth.refresh'));
    assert.ok(names(calls).includes('updater.check'));
    assert.ok(names(calls).includes('addon.check'));
  });

  test('a server change from the page is confirmed in a native dialog on the main window', async () => {
    const win = { isDestroyed: () => false, id: 'main' };
    const { deps, calls } = fakeDeps(tmp, { getWindow: () => win });
    const m = buildMethods(deps);
    await m['settings.set']({ serverUrl: 'https://other.example.com:8443/guild', theme: 'dark' });
    const [, parentWin, opts] = calls.find((c) => c[0] === 'dialog.showMessageBox');
    assert.equal(parentWin, win);
    assert.equal(opts.message, "Switch Guild Camp to other.example.com:8443? You'll be signed out.");
    assert.deepEqual(opts.buttons, ['Switch', 'Cancel']);
    assert.equal(opts.cancelId, 1);
    assert.match(opts.detail, /https:\/\/other\.example\.com:8443\/guild/);
  });

  test('Cancel leaves everything as it was and rejects with a quiet "cancelled" error', async () => {
    const { deps, calls, store } = fakeDeps(tmp);
    deps.dialog.showMessageBox = async (...a) => { calls.push(['dialog.showMessageBox', ...a]); return { response: 1 }; };
    store.set({ lastEventId: 55 });
    const warnings = [];
    const m = buildMethods(deps);
    const res = await dispatch(m, 'settings.set', [{ serverUrl: 'https://evil.example.com', theme: 'dark' }], { log: { warn: (x) => warnings.push(x), error() {} } });
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'cancelled', 'the welcome and settings pages can ignore it');
    assert.equal(store.get().serverUrl, 'https://wow.cjplumbing.co.za');
    assert.equal(store.get().theme, 'system', 'nothing in that call is applied');
    assert.equal(store.get().lastEventId, 55);
    assert.deepEqual(names(calls), ['dialog.showMessageBox'], 'no sign-out, no checks');
    assert.deepEqual(warnings, [], 'a cancel is not logged as a failure');
  });

  test('without a way to ask, the server is not changed; changes made by the app itself never ask', async () => {
    const { deps, calls, store } = fakeDeps(tmp);
    delete deps.dialog.showMessageBox;
    const m = buildMethods(deps);
    await assert.rejects(m['settings.set']({ serverUrl: 'https://evil.example.com' }), /kept the old one/);
    assert.equal(store.get().serverUrl, 'https://wow.cjplumbing.co.za');
    // Other settings from the page, and settings the app writes itself (folders), need no dialog.
    await m['settings.set']({ theme: 'dark' });
    await m['wow.addFolder'](tmp);
    assert.equal(calls.filter((c) => c[0] === 'dialog.showMessageBox').length, 0);
  });

  test('settings.set with no real change does nothing', async () => {
    const { deps, calls } = fakeDeps(tmp);
    await buildMethods(deps)['settings.set']({ serverUrl: 'https://wow.cjplumbing.co.za/' });
    assert.deepEqual(calls, []);
  });

  test('api.request only allows /api/ paths, never sign-in endpoints, and passes the call on', async () => {
    const { deps, calls } = fakeDeps(tmp);
    const m = buildMethods(deps);
    assert.deepEqual(await m['api.request']('get', '/api/raids'), { m: 'GET', p: '/api/raids', b: undefined });
    await assert.rejects(m['api.request']('GET', '/updates/app/latest.yml'), /\/api\//);
    await assert.rejects(m['api.request']('GET', 'https://evil.example/api/x'), /\/api\//);
    await assert.rejects(m['api.request']('GET', '/api/../auth'), /\/api\//);
    await assert.rejects(m['api.request']('POST', '/api/auth/dev', { battletag: 'X#1' }), /sign-in/);
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
    assert.equal(calls.filter((c) => c[0] === 'api.request').length, 4, 'none of those reached the server');
  });

  test('api.request refuses sign-in endpoints in any spelling, and publishing (that goes through publisher.*)', async () => {
    const { deps, calls } = fakeDeps(tmp);
    const m = buildMethods(deps);
    for (const p of ['/api/auth', '/api/auth/dev', '/api/AUTH/dev', '/api/Auth/dev/', '/api/%61uth/dev', '/api/auth?x=1', '/api/auth.json']) {
      await assert.rejects(m['api.request']('POST', p, {}), /sign-in/, p);
    }
    for (const p of ['/api/publish/addon?force=1', '/api/publish/app/commit', '/api/PUBLISH/app/files/x.exe', '/api/publish']) {
      await assert.rejects(m['api.request']('PUT', p, {}), /Releases page/, p);
    }
    await m['api.request']('GET', '/api/authors'); // only the auth route itself is off limits
    await m['api.request']('GET', '/api/releases');
    assert.equal(calls.filter((c) => c[0] === 'api.request').length, 2);
  });

  test('api.download uses the same path rules (plus /updates/)', async () => {
    const { checkDownloadPath, serverPathname } = ipc;
    assert.equal(checkDownloadPath('/updates/addon/WowGuild-0.11.1.zip'), '/updates/addon/WowGuild-0.11.1.zip');
    assert.equal(checkDownloadPath('/api/admin/backups/latest?name=a..b'), '/api/admin/backups/latest');
    assert.throws(() => checkDownloadPath('/updates/%2e%2e/api/auth/dev'), /\/api\/ or \/updates\//);
    assert.throws(() => checkDownloadPath('/api/auth/dev'), /cannot be downloaded/);
    assert.throws(() => checkDownloadPath('/api/publish/addon'), /cannot be downloaded/);
    assert.throws(() => checkDownloadPath('/data/guild.db'), /\/api\/ or \/updates\//);
    assert.equal(serverPathname('/api/x?y=../..'), '/api/x');
    assert.equal(serverPathname('/api/a/../b'), null);
    assert.equal(serverPathname(42), null);
  });

  test('api.request refreshes the session after guild/member changes', async () => {
    const { deps, calls } = fakeDeps(tmp);
    const m = buildMethods(deps);
    await m['api.request']('POST', '/api/guild/join', { code: 'abc' });
    assert.deepEqual(names(calls), ['api.request', 'auth.refresh']);
    await m['api.request']('POST', '/api/raids', { title: 'MC' });
    assert.deepEqual(names(calls), ['api.request', 'auth.refresh', 'api.request']);
  });

  test('api.download asks where to save, then writes the file', async () => {
    const { deps, calls } = fakeDeps(tmp);
    const m = buildMethods(deps);
    const saved = await m['api.download']('/api/admin/backups/latest', 'guild:backup?.db');
    assert.equal(saved, path.join(tmp, 'saved.zip'));
    assert.equal(fs.readFileSync(saved, 'utf8'), 'backup-bytes');
    const dialogCall = calls.find((c) => c[0] === 'dialog.showSaveDialog');
    assert.equal(dialogCall[2].defaultPath, path.join(tmp, 'guild_backup_.db'));
    await assert.rejects(m['api.download']('/etc/passwd'), /\/api\/ or \/updates\//);
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

  test('publishing is owner only', async () => {
    const { deps, calls, auth } = fakeDeps(tmp);
    const m = buildMethods(deps);
    assert.equal(await m['publisher.publishAddon']({ bump: 'patch', notes: 'x' }), 'ok');
    auth.setRole('officer');
    await assert.rejects(m['publisher.publishApp']({ bump: 'minor' }), (err) => err.status === 403 && /owner/.test(err.message));
    assert.equal(calls.filter((c) => c[0] === 'publisher.publishApp').length, 0);
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
    await m['auth.devSignIn']('Dev#1');
    await m['auth.state']({ refresh: true });
    assert.deepEqual(m['log.recent']()[0].msg, 'hi');
    assert.deepEqual(m['app.rendererReady']({ routes: ['/'] }), { smoke: false });
    assert.deepEqual(names(calls), ['addon.install', 'updater.check', 'notify.test', 'auth.devSignIn', 'auth.refresh', 'rendererReady']);
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
    s.store.emit('change', { lastEventId: 3 }, ['lastEventId']);
    s.store.emit('change', { windowBounds: {} }, ['windowBounds']);
    assert.deepEqual(sent.map((x) => x[0]), ['auth', 'sync', 'addon', 'updater', 'publisher:log', 'log', 'settings']);
    off();
    s.auth.emit('change', {});
    assert.equal(sent.length, 7);
  });

  test('membership results go to the membership channel; app-managed settings are not broadcast', () => {
    const sent = [];
    const membership = new EventEmitter();
    const store = new EventEmitter();
    const off = forwardEvents({ broadcast: (c, p) => sent.push([c, p]), membership, store });
    const result = { status: 'no-match', guild: null, role: null, via: null, character: null, reason: 'Log in once.', detected: null };
    membership.emit('change', result);
    store.emit('change', { startupDefaulted: true }, ['startupDefaulted']);
    store.emit('change', { addonOptOut: [] }, ['addonOptOut']);
    store.emit('change', { startWithWindows: true, startupDefaulted: true }, ['startWithWindows', 'startupDefaulted']);
    assert.deepEqual(sent.map((x) => x[0]), ['membership', 'settings']);
    assert.deepEqual(sent[0][1], result);
    off();
    membership.emit('change', result);
    assert.equal(sent.length, 2);
  });
});

// ---------------------------------------------------------------------------------------------
describe('events poller', () => {
  function setup(responses, { notifications = true, now } = {}) {
    const store = createStore(tmp);
    store.set({ notifications });
    const requests = [];
    const api = {
      request: async (method, p) => {
        requests.push(p);
        const r = responses.shift();
        if (r instanceof Error) throw r;
        return r;
      },
    };
    const shown = [];
    const sent = [];
    const warnings = [];
    const events = createEvents({
      api, store,
      notify: { show: (ev) => shown.push(ev) },
      broadcast: (c, p) => sent.push([c, p]),
      log: { warn: (m) => warnings.push(m), info() {} },
      now,
    });
    return { store, events, requests, shown, sent, warnings };
  }

  test('first poll only records the latest id (no replay of old news)', async () => {
    const t = setup([{ events: [{ id: 3, kind: 'raid', title: 'Old' }], latestId: 7 }]);
    assert.deepEqual(await t.events.poll(), []);
    assert.deepEqual(t.requests, ['/api/events']);
    assert.equal(t.store.get().lastEventId, 7);
    assert.equal(t.shown.length, 0);
    assert.equal(t.sent.length, 0);
  });

  test('later polls pass after=, broadcast server-event, notify and advance', async () => {
    const t = setup([
      { events: [], latestId: 7 },
      { events: [{ id: 9, kind: 'cta', title: 'Call to arms', body: 'Onyxia', route: '/' }, { id: 8, kind: 'raid', title: 'New raid', route: '/raids/4' }], latestId: 9 },
    ]);
    await t.events.poll();
    const fresh = await t.events.poll();
    assert.deepEqual(t.requests, ['/api/events', '/api/events?after=7']);
    assert.deepEqual(fresh.map((e) => e.id), [8, 9], 'delivered in id order');
    assert.deepEqual(t.sent.map((s) => [s[0], s[1].id]), [['server-event', 8], ['server-event', 9]]);
    assert.deepEqual(t.shown.map((e) => e.title), ['New raid', 'Call to arms']);
    assert.equal(t.store.get().lastEventId, 9);
  });

  test('a feed at 0 (not in a guild yet) re-primes, so joining a guild does not replay its history', async () => {
    const t = setup([
      { events: [], latestId: 0 },
      { events: [], latestId: 40 },
      { events: [{ id: 41, kind: 'notice', title: 'Welcome' }], latestId: 41 },
    ]);
    t.store.set({ lastEventId: 12 }); // left over from a previous guild
    await t.events.poll();
    assert.equal(t.store.get().lastEventId, 0);
    await t.events.poll();
    await t.events.poll();
    assert.deepEqual(t.requests, ['/api/events?after=12', '/api/events', '/api/events?after=40']);
    assert.deepEqual(t.shown.map((e) => e.title), ['Welcome']);
  });

  test('adopts latestId even when it moved past events meant for other members', async () => {
    const t = setup([{ events: [{ id: 11, kind: 'raid', title: 'Mine' }], latestId: 15 }, { events: [], latestId: 15 }]);
    t.store.set({ lastEventId: 10 });
    await t.events.poll();
    assert.equal(t.store.get().lastEventId, 15);
    await t.events.poll();
    assert.deepEqual(t.requests, ['/api/events?after=10', '/api/events?after=15']);
  });

  test('a full page of 100 is followed by another call straight away', async () => {
    const page = Array.from({ length: 100 }, (_, i) => ({ id: 101 + i, kind: 'request', title: `R${i}` }));
    const t = setup([{ events: page, latestId: 200 }, { events: [{ id: 205, kind: 'raid', title: 'Last' }], latestId: 205 }]);
    t.store.set({ lastEventId: 100 });
    const fresh = await t.events.poll();
    assert.equal(fresh.length, 101);
    assert.deepEqual(t.requests, ['/api/events?after=100', '/api/events?after=200']);
    assert.equal(t.store.get().lastEventId, 205);
    assert.equal(t.shown.length, 4, 'one burst per poll: 3 popups + 1 summary');
    assert.match(t.shown[3].body, /98 more updates/);
    assert.equal(t.sent.length, 101);
  });

  test('a stored cursor is used straight away on the next start', async () => {
    const t = setup([{ events: [{ id: 12, kind: 'bank', title: 'Bank request' }], latestId: 12 }]);
    t.store.set({ lastEventId: 10 });
    await t.events.poll();
    assert.deepEqual(t.requests, ['/api/events?after=10']);
    assert.equal(t.shown.length, 1);
  });

  test('no popups when notifications are off (events still reach the renderer)', async () => {
    const t = setup([{ events: [{ id: 2, kind: 'raid', title: 'R' }], latestId: 2 }], { notifications: false });
    t.store.set({ lastEventId: 1 });
    await t.events.poll();
    assert.equal(t.shown.length, 0);
    assert.equal(t.sent.length, 1);
  });

  test('a burst shows at most 3 popups plus a summary', async () => {
    const list = Array.from({ length: 6 }, (_, i) => ({ id: 20 + i, kind: 'request', title: `R${i}` }));
    const t = setup([{ events: list, latestId: 25 }]);
    t.store.set({ lastEventId: 19 });
    await t.events.poll();
    assert.deepEqual(t.shown.map((e) => e.title), ['R0', 'R1', 'R2', 'Guild Camp']);
    assert.match(t.shown[3].body, /3 more updates/);
    assert.equal(t.sent.length, 6);
  });

  test('old events (from while the app was closed) arrive without popups', async () => {
    const now = () => Date.parse('2026-11-07T12:00:00Z');
    const t = setup([{ events: [{ id: 5, kind: 'raid', title: 'Old', createdAt: '2026-11-06 01:00:00' }, { id: 6, kind: 'raid', title: 'New', createdAt: '2026-11-07 11:59:00' }], latestId: 6 }], { now });
    t.store.set({ lastEventId: 4 });
    await t.events.poll();
    assert.deepEqual(t.shown.map((e) => e.title), ['New']);
    assert.equal(t.sent.length, 2);
  });

  test('a server whose feed is behind our cursor (reset) moves the cursor back', async () => {
    const t = setup([{ events: [], latestId: 3 }]);
    t.store.set({ lastEventId: 50 });
    await t.events.poll();
    assert.equal(t.store.get().lastEventId, 3);
  });

  test('failures are logged once per outage and never throw', async () => {
    const err = Object.assign(new Error("Can't reach the guild server"), { status: 0 });
    const t = setup([err, err, { events: [], latestId: 1 }]);
    t.store.set({ lastEventId: 1 });
    assert.deepEqual(await t.events.poll(), []);
    assert.deepEqual(await t.events.poll(), []);
    await t.events.poll();
    assert.equal(t.warnings.length, 1);
  });

  test('readFeed accepts a bare array too', () => {
    assert.deepEqual(readFeed([{ id: '2' }, { id: 1 }, null, { nope: 1 }]), { events: [{ id: 1 }, { id: 2 }], maxId: 2, latestId: null });
  });

  test('start/stop manage the timer', () => {
    const t = setup([{ events: [], latestId: 1 }]);
    t.events.start();
    assert.equal(t.events.running(), true);
    t.events.start();
    t.events.stop();
    assert.equal(t.events.running(), false);
  });

  test('a new server address (without a sign-out) does not replay that server\'s last two weeks', async () => {
    const replay = Array.from({ length: 5 }, (_, i) => ({ id: 100 + i, kind: 'raid', title: `Old ${i}` }));
    const t = setup([{ events: [], latestId: 7 }, { events: replay, latestId: 104 }]);
    await t.events.poll(); // primed on the old server
    // ipc.js writes lastEventId 0 in the same change as the new address.
    t.store.set({ serverUrl: 'https://other.example.com', lastEventId: 0 });
    assert.deepEqual(await t.events.poll(), []);
    assert.deepEqual(t.requests, ['/api/events', '/api/events'], 'a first look, not ?after=0');
    assert.equal(t.shown.length, 0);
    assert.equal(t.store.get().lastEventId, 104);
  });

  test('switching servers (sign-out, new address, sign-in) learns the new feed without notifications', async () => {
    const replay = Array.from({ length: 5 }, (_, i) => ({ id: 100 + i, kind: 'raid', title: `Old ${i}` }));
    const t = setup([
      { events: [], latestId: 7 },
      { events: replay, latestId: 104 }, // the new server's whole feed
      { events: [{ id: 105, kind: 'cta', title: 'New' }], latestId: 105 },
    ]);
    t.events.start();
    await new Promise((r) => setImmediate(r));
    t.events.stop(); // signed out
    t.store.set({ serverUrl: 'https://other.example.com', lastEventId: 0 });
    t.events.start(); // signed in on the new server
    await new Promise((r) => setImmediate(r));
    t.events.stop();
    await t.events.poll();
    assert.deepEqual(t.requests, ['/api/events', '/api/events', '/api/events?after=104']);
    assert.deepEqual(t.shown.map((e) => e.title), ['New'], 'no replay of the new server\'s history');
  });

  test('stop() forgets the feed position only when there is no stored cursor', async () => {
    const t = setup([{ events: [], latestId: 0 }, { events: [], latestId: 30 }, { events: [], latestId: 30 }]);
    await t.events.poll(); // not in a guild: not primed
    t.store.set({ lastEventId: 0 });
    await t.events.poll(); // first look → 30
    t.events.stop();
    await t.events.poll(); // a stored cursor resumes straight away
    assert.deepEqual(t.requests, ['/api/events', '/api/events', '/api/events?after=30']);
  });

  test('an answer that arrives after the server changed is dropped', async () => {
    const store = createStore(tmp);
    store.set({ lastEventId: 10 });
    let release;
    const api = { request: () => new Promise((r) => { release = r; }) };
    const shown = [];
    const events = createEvents({ api, store, notify: { show: (ev) => shown.push(ev) }, broadcast() {}, log: { warn() {}, info() {} } });
    const p = events.poll();
    store.set({ serverUrl: 'https://other.example.com', lastEventId: 0 });
    release({ events: [{ id: 11, kind: 'raid', title: 'From the old server' }], latestId: 11 });
    assert.deepEqual(await p, []);
    assert.equal(shown.length, 0);
    assert.equal(store.get().lastEventId, 0, 'the old server\'s cursor is not written for the new one');
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
describe('sign-in URL handling', () => {
  const server = 'https://guild.example.com';

  test('builds the Battle.net start URL with device details', () => {
    const url = new URL(signInUrl(`${server}/`, { device: "Calvin's PC", platform: 'win32', appVersion: '0.11.0' }));
    assert.equal(url.origin + url.pathname, `${server}/auth/bnet`);
    assert.equal(url.searchParams.get('device'), "Calvin's PC");
    assert.equal(url.searchParams.get('platform'), 'win32');
    assert.equal(url.searchParams.get('appVersion'), '0.11.0');
  });

  test('finds the token on the done page', () => {
    assert.deepEqual(parseDoneUrl(`${server}/auth/app/done#token=gcd_abcDEF123_-xyz`, server), { token: 'gcd_abcDEF123_-xyz' });
    assert.deepEqual(parseDoneUrl(`${server}/auth/app/done/#token=gcd_abcDEF123_-xyz&x=1`, server), { token: 'gcd_abcDEF123_-xyz' });
  });

  test('reports errors from the done page', () => {
    assert.deepEqual(parseDoneUrl(`${server}/auth/app/done#error=Battle.net%20said%20no`, server), { error: 'Battle.net said no' });
  });

  test('ignores other pages, other servers and malformed tokens', () => {
    assert.equal(parseDoneUrl('https://oauth.battle.net/authorize?x=1', server), null);
    assert.equal(parseDoneUrl(`${server}/auth/app/done`, server), null);
    assert.equal(parseDoneUrl(`${server}/auth/app/done#token=wowg_oldkey`, server), null);
    assert.equal(parseDoneUrl('https://evil.example/auth/app/done#token=gcd_abcDEF123456', server), null);
    assert.equal(parseDoneUrl('not a url', server), null);
  });
});

// ---------------------------------------------------------------------------------------------
describe('main.js helpers', () => {
  test('parseArgs reads flags in both --x=v and --x v forms', () => {
    const a = parseArgs(['.', '--hidden', '--user-data', 'C:\\tmp\\gc', '--smoke', '--smoke-routes=/,/raids, /bank', '--smoke-login=Dev#1234', '--smoke-out=out']);
    assert.deepEqual(a, { hidden: true, dev: false, smoke: true, smokeScan: false, userData: 'C:\\tmp\\gc', smokeLogin: 'Dev#1234', smokeRoutes: ['/', '/raids', '/bank'], smokeOut: 'out' });
    assert.equal(parseArgs(['--user-data', 'guildcamp://join/x']).userData, null, 'a join link is never taken as a value');
    assert.deepEqual(parseArgs([]).smokeRoutes, null);
  });

  test('join links become the welcome route', () => {
    assert.equal(deepLinkRoute('guildcamp://join/AbC123'), '/welcome?join=AbC123');
    assert.equal(deepLinkRoute('guildcamp://join/AbC123/'), '/welcome?join=AbC123');
    assert.equal(deepLinkRoute('GUILDCAMP://JOIN/xyz'), '/welcome?join=xyz');
    assert.equal(deepLinkRoute('guildcamp://join/bad code!'), null);
    assert.equal(deepLinkRoute('guildcamp://join/'), null);
    assert.equal(deepLinkRoute('guildcamp://other/abc'), null);
    assert.equal(deepLinkRoute('https://join/abc'), null);
    assert.equal(deepLinkRoute(undefined), null);
    // Read-only app pages open directly (server pages such as /raids/:id link here).
    assert.equal(deepLinkRoute('guildcamp://raids/12'), '/raids/12');
    assert.equal(deepLinkRoute('guildcamp://raids/12/loot'), '/raids/12/loot');
    assert.equal(deepLinkRoute('guildcamp://characters/Zul%C3%A9'), '/characters/Zul%C3%A9');
    assert.equal(deepLinkRoute('guildcamp://coach'), '/coach');
    assert.equal(deepLinkRoute('guildcamp://raids/..%2F..'), null);
    assert.equal(deepLinkRoute('guildcamp://raids/1/2/3/4'), null);
    assert.equal(deepLinkRoute('guildcamp://admin'), null);
  });

  test('finds the link among Windows launch arguments', () => {
    assert.equal(findDeepLink(['C:\\GC\\Guild Camp.exe', '--allow-file-access-from-files', 'guildcamp://join/abc']), 'guildcamp://join/abc');
    assert.equal(findDeepLink(['x', '--hidden']), null);
  });

  test('route slugs make safe file names', () => {
    assert.equal(routeSlug('/'), 'home');
    assert.equal(routeSlug('/raids'), 'raids');
    assert.equal(routeSlug('/guild-settings'), 'guild-settings');
    assert.equal(routeSlug('/welcome?join=abc'), 'welcome-join-abc');
  });

  test('throttle: the profile is re-read at most once per gap when the window is shown or focused', () => {
    let t = 0;
    let runs = 0;
    const run = throttle(() => { runs += 1; }, 20000, () => t);
    assert.equal(run(), true);
    t = 5000;
    assert.equal(run(), false, 'focus right after show');
    t = 20000;
    assert.equal(run(), true);
    run.mark(); // the 5-minute timer just refreshed
    t = 30000;
    assert.equal(run(), false);
    t = 40001;
    assert.equal(run(), true);
    assert.equal(runs, 3);
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
