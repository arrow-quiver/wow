'use strict';
// The bridge between the renderer (window.gc) and the main-process services.
//
// One channel carries every call: ipcMain.handle('gc:invoke', (event, method, ...args)).
// Results travel back as an envelope { ok: true, value } | { ok: false, error: { message, status? } }
// because Electron strips custom fields (like status) from errors thrown across IPC; preload.js
// unwraps it and rejects with the plain { message, status } object.
//
// Events go the other way with broadcast(channel, payload) → webContents.send('gc:event', channel, payload).
//
//   const methods = buildMethods({ store, log, auth, api, wow, sync, addon, updater, publisher, notify, startup, ... });
//   const ipc = createIpc({ methods, getWindows, log });
//   forwardEvents({ broadcast: ipc.broadcast, store, log, auth, sync, addon, updater, publisher });
//
// `auth` here is main.js's session (createSession): Battle.net sign-in in the app plus who I am in the local
// core, so auth.state() = { available, signedIn, battletag, region, characters, profileAt, error, ...,
// user, guild, role }.

const fs = require('fs');
const path = require('path');
const { isAppUrl, isExternalUrl } = require('./window');
const { sanitizeSettingsPatch, INTERNAL_KEYS } = require('./store');

const INVOKE_CHANNEL = 'gc:invoke';
const EVENT_CHANNEL = 'gc:event';

// Keep in sync with METHODS in src/preload/preload.js and src/renderer/lib/gc.js (a test checks they match).
const METHOD_NAMES = [
  'app.info', 'app.openExternal', 'app.openPath', 'app.showItemInFolder', 'app.pickFolder',
  'app.quit', 'app.relaunch', 'app.rendererReady',
  'log.recent',
  'settings.get', 'settings.set',
  'auth.state', 'auth.signIn', 'auth.signOut',
  'api.request', 'api.download',
  'calendar.export',
  'secrets.set', 'secrets.has',
  'wow.installs', 'wow.addFolder', 'wow.removeFolder', 'wow.detectGuild',
  'sync.status', 'sync.now', 'sync.setEnabled',
  'addon.status', 'addon.check', 'addon.install', 'addon.update', 'addon.updateAll', 'addon.repair', 'addon.uninstall', 'addon.openFolder',
  'updater.status', 'updater.check', 'updater.download', 'updater.install',
  'publisher.status', 'publisher.publishAddon', 'publisher.publishApp', 'publisher.setRepoDir', 'publisher.cancel',
  'notify.test',
];

// Keep in sync with CHANNELS in src/preload/preload.js and src/renderer/lib/gc.js.
const EVENT_CHANNELS = ['auth', 'sync', 'addon', 'updater', 'publisher:log', 'server-event', 'navigate', 'log', 'settings'];

// Secrets the renderer may set (never read back): the player's own Anthropic API key for the Coach AI.
const RENDERER_SECRETS = ['anthropicKey'];

// JavaScript's own error types mean a bug, not a message written for people.
const BUG_ERRORS = ['TypeError', 'ReferenceError', 'SyntaxError', 'RangeError', 'EvalError', 'URIError'];

// Error codes passed on to the renderer: the app's own ('in-use', 'cancelled') and the core's ('NO_GUILD').
// Node's system codes (ENOENT, EPERM ...) look the same, which is harmless: the renderer only reacts to codes it knows.
const ERROR_CODE = /^[A-Za-z][A-Za-z0-9_-]{1,39}$/;

/** Turns anything thrown into the { message, status?, code? } shape the renderer receives. */
function serialiseError(err) {
  const out = { message: 'Something went wrong. Details are in the log.' };
  if (err && typeof err === 'object') {
    const isBug = err instanceof Error && BUG_ERRORS.includes(err.name) && !Number.isInteger(err.status);
    if (!isBug && typeof err.message === 'string' && err.message.trim()) out.message = err.message.trim().slice(0, 1000);
    if (Number.isInteger(err.status)) out.status = err.status;
    if (typeof err.code === 'string' && ERROR_CODE.test(err.code)) out.code = err.code;
  } else if (typeof err === 'string' && err.trim()) {
    out.message = err.trim().slice(0, 1000);
  }
  return out;
}

/**
 * Runs methods[method](...args) and always resolves with an envelope (never rejects).
 * Pure: no Electron involved, so it is unit tested directly.
 */
async function dispatch(methods, method, args = [], { log } = {}) {
  try {
    if (typeof method !== 'string' || !Object.prototype.hasOwnProperty.call(methods, method) || typeof methods[method] !== 'function') {
      const err = new Error(`Guild Camp doesn't know how to "${String(method).slice(0, 60)}".`);
      err.status = 404;
      throw err;
    }
    const value = await methods[method](...(Array.isArray(args) ? args : []));
    return { ok: true, value: value === undefined ? null : value };
  } catch (err) {
    const error = serialiseError(err);
    if (log) {
      if (err instanceof Error && BUG_ERRORS.includes(err.name)) log.error(`${method} failed:`, err);
      else if (error.code !== 'cancelled') log.warn(`${method} failed: ${error.message}`);
    }
    return { ok: false, error };
  }
}

function defaultTrustedSender(event) {
  const frameUrl = event && event.senderFrame && event.senderFrame.url;
  const url = frameUrl || (event && event.sender && typeof event.sender.getURL === 'function' ? event.sender.getURL() : '');
  return isAppUrl(url);
}

/**
 * @param {object} deps
 * @param {Record<string, Function>} deps.methods
 * @param {() => object[]} deps.getWindows windows that receive broadcasts
 * @param {object} [deps.log]
 * @param {object} [deps.ipcMain]          injected for tests
 * @param {(event) => boolean} [deps.isTrustedSender]
 */
function createIpc({ methods, getWindows, log, ipcMain, isTrustedSender = defaultTrustedSender }) {
  const main = ipcMain || require('electron').ipcMain;

  main.handle(INVOKE_CHANNEL, async (event, method, ...args) => {
    if (!isTrustedSender(event)) {
      if (log) log.warn(`Blocked "${String(method).slice(0, 60)}" from an untrusted page.`);
      return { ok: false, error: { message: 'Not allowed.', status: 403 } };
    }
    return dispatch(methods, method, args, { log });
  });

  function broadcast(channel, payload) {
    for (const win of getWindows()) {
      try {
        if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(EVENT_CHANNEL, channel, payload);
      } catch (err) {
        // Payload not cloneable or window closing. Never let a broadcast break the sender.
        if (log && channel !== 'log') log.warn(`Couldn't send "${channel}" to the window: ${err.message}`);
      }
    }
  }

  return {
    broadcast,
    dispatch: (method, ...args) => dispatch(methods, method, args, { log }),
    dispose: () => main.removeHandler(INVOKE_CHANNEL),
  };
}

/** Forwards service events to the renderer. Returns a function that removes the listeners. */
function forwardEvents({ broadcast, store, log, auth, sync, addon, updater, publisher }) {
  const subs = [];
  const on = (source, event, fn) => {
    if (!source || typeof source.on !== 'function') return;
    source.on(event, fn);
    subs.push(() => (source.off || source.removeListener).call(source, event, fn));
  };
  on(auth, 'change', (state) => broadcast('auth', state));
  on(sync, 'status', (status) => broadcast('sync', status));
  on(addon, 'status', (status) => broadcast('addon', status));
  on(updater, 'status', (status) => broadcast('updater', status));
  on(publisher, 'log', (line) => broadcast('publisher:log', line));
  on(log, 'line', (line) => broadcast('log', line));
  on(store, 'change', (settings, keys) => {
    // Window position and other internal keys change often and mean nothing to the UI.
    if (!Array.isArray(keys) || keys.some((k) => !INTERNAL_KEYS.includes(k))) broadcast('settings', settings);
  });
  return () => subs.splice(0).forEach((off) => off());
}

// ---------------------------------------------------------------------------------------------
// Method table

const userError = (message, status) => Object.assign(new Error(message), status ? { status } : {});

function samePath(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ra = path.resolve(a);
  const rb = path.resolve(b);
  return process.platform === 'win32' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}

function absolutePath(p, what = 'path') {
  if (typeof p !== 'string' || !p.trim() || p.length > 1024 || p.includes('\0') || !path.isAbsolute(p.trim())) {
    throw userError(`That ${what} is not a full path.`, 400);
  }
  return path.resolve(p.trim());
}

function statOrNull(p) {
  try { return fs.statSync(p); } catch { return null; }
}

// Files that are safe to hand to the system "open" action (never programs or scripts).
const OPENABLE_FILES = ['.log', '.txt', '.json', '.md', '.lua', '.toc', '.png', '.jpg', '.csv'];

function cleanFileName(name, fallback = 'download') {
  const base = path.basename(String(name || '')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^\.+/, '').trim().slice(0, 150);
  return base || fallback;
}

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return null; }
}

/**
 * The path part of a core path the renderer asked for, exactly as the core will see it, or null
 * when it would not reach the core as written: "..", "." and their %2e spellings, backslashes and
 * empty segments are refused. Only the path is checked; the query may contain anything ("q=a..b").
 * Percent-encoded characters are fine ("/api/characters/Gr%C3%BCm"); so is a raw "ü", which the URL
 * parser encodes on the way out.
 */
function serverPathname(p) {
  if (typeof p !== 'string' || p.length > 2048 || !p.startsWith('/') || p.startsWith('//') || p.includes('\\')) return null;
  const raw = p.split(/[?#]/)[0];
  let pathname;
  try { pathname = new URL(raw, 'http://x').pathname; } catch { return null; }
  // The URL parser removes dot segments (also %2e ones); any difference besides percent-encoding means
  // the core would answer for another path than the one asked for.
  const a = safeDecode(pathname);
  const b = safeDecode(raw);
  if (a === null || b === null ? pathname !== raw : a !== b) return null;
  if (pathname.includes('//') || /(^|\/)\.{1,2}(\/|$)/.test(b === null ? raw : b)) return null;
  return pathname;
}

// Paths the renderer may call on the local core: anything under /api/.
function checkApiPath(p) {
  const pathname = serverPathname(p);
  if (!pathname || !pathname.startsWith('/api/')) throw userError('Requests must use a path that starts with /api/.', 400);
  return pathname;
}

// Paths api.download may fetch: the same as checkApiPath.
function checkDownloadPath(p) {
  const pathname = serverPathname(p);
  if (!pathname || !pathname.startsWith('/api/')) throw userError('Downloads must come from /api/.', 400);
  return pathname;
}

/**
 * Builds the flat method map for createIpc. Every dependency is injected so this can be tested
 * with fakes.
 *
 * @param {object} d
 * @param {object} d.store  @param {object} d.log  @param {object} d.auth (main.js session)  @param {object} d.api
 * @param {object} d.wow    @param {object} d.sync @param {object} d.addon @param {object} d.updater
 * @param {object} d.publisher @param {object} d.notify @param {object} d.startup
 * @param {object} d.shell  { openExternal, openPath, showItemInFolder }
 * @param {object} d.dialog { showOpenDialog, showSaveDialog }
 * @param {() => object|null} d.getWindow parent for dialogs
 * @param {() => object} d.appInfo
 * @param {() => void} d.quit
 * @param {() => void} d.relaunch
 * @param {(info) => any} d.rendererReady
 * @param {string} d.downloadsDir
 */
function buildMethods(d) {
  const { store, log, auth, api, wow, sync, addon, updater, publisher, notify, startup, shell, dialog } = d;
  const parent = () => {
    const win = d.getWindow ? d.getWindow() : null;
    return win && !win.isDestroyed() ? win : undefined;
  };
  const background = (fn, what) => {
    Promise.resolve().then(fn).catch((err) => log.warn(`${what}: ${err.message}`));
  };

  async function setSettings(raw) {
    const patch = sanitizeSettingsPatch(raw);
    const current = store.get();
    const changed = Object.keys(patch).filter((k) => JSON.stringify(patch[k]) !== JSON.stringify(current[k]));
    if (!changed.length) return current;

    // Side effects that can fail run first, so a failure leaves the setting unchanged.
    if (changed.includes('startWithWindows')) {
      patch.startWithWindows = startup.set(patch.startWithWindows);
      patch.startupDefaulted = true; // the person chose: the first sign-in default never overrides it
    }

    store.set(patch);

    if (changed.includes('syncEnabled')) sync.setEnabled(patch.syncEnabled);
    if (changed.includes('discordWebhook')) log.info(patch.discordWebhook ? 'Discord webhook saved.' : 'Discord webhook removed.');
    if (changed.includes('extraWowFolders')) background(() => addon.check(), 'Addon check failed');
    return store.get();
  }

  function installs() {
    return wow.findInstalls({ extraRoots: store.get().extraWowFolders, scanDefaults: true });
  }

  return {
    // --- app -------------------------------------------------------------------------------
    'app.info': () => d.appInfo(),
    'app.openExternal': async (url) => {
      if (!isExternalUrl(url)) throw userError('Only web links (http or https) can be opened.', 400);
      await shell.openExternal(url);
      return true;
    },
    'app.openPath': async (p) => {
      const target = absolutePath(p);
      const st = statOrNull(target);
      if (!st) throw userError("That file or folder doesn't exist.", 404);
      if (!st.isDirectory() && !OPENABLE_FILES.includes(path.extname(target).toLowerCase())) {
        throw userError('Guild Camp only opens folders and text files. Use "Show in folder" instead.', 400);
      }
      const problem = await shell.openPath(target);
      if (problem) throw userError(problem);
      return true;
    },
    'app.showItemInFolder': async (p) => {
      const target = absolutePath(p);
      if (!statOrNull(target)) throw userError("That file or folder doesn't exist.", 404);
      shell.showItemInFolder(target);
      return true;
    },
    'app.pickFolder': async (opts = {}) => {
      const o = opts && typeof opts === 'object' ? opts : {};
      const defaultPath = typeof o.defaultPath === 'string' && path.isAbsolute(o.defaultPath) ? o.defaultPath : undefined;
      const res = await dialog.showOpenDialog(parent(), {
        title: typeof o.title === 'string' && o.title.trim() ? o.title.slice(0, 120) : 'Choose a folder',
        defaultPath,
        properties: ['openDirectory', 'dontAddToRecent'],
      });
      return res.canceled || !res.filePaths || !res.filePaths.length ? null : res.filePaths[0];
    },
    'app.quit': () => { setImmediate(d.quit); return true; },
    'app.relaunch': () => { setImmediate(d.relaunch); return true; },
    'app.rendererReady': (info) => {
      const r = d.rendererReady ? d.rendererReady(info && typeof info === 'object' ? info : {}) : null;
      return r === undefined ? true : r;
    },

    // --- log / settings -------------------------------------------------------------------
    'log.recent': () => log.recent(),
    'settings.get': () => store.get(),
    'settings.set': (patch) => setSettings(patch),

    // --- auth (Battle.net in the app, plus who I am in the local core) ---------------------
    'auth.state': (opts) => (opts && opts.refresh ? auth.refresh() : auth.state()),
    'auth.signIn': () => auth.signIn(),
    'auth.signOut': () => auth.signOut(),

    // --- the local core's API -------------------------------------------------------------
    'api.request': async (method, p, body) => {
      const verb = typeof method === 'string' ? method.toUpperCase() : '';
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(verb)) throw userError('Request method must be GET, POST, PUT or DELETE.', 400);
      checkApiPath(p);
      return api.request(verb, p, verb === 'GET' ? undefined : body);
    },
    'api.download': async (p, suggestedName) => {
      checkDownloadPath(p);
      const name = cleanFileName(suggestedName || p.split('?')[0]);
      const res = await dialog.showSaveDialog(parent(), {
        title: 'Save file',
        defaultPath: d.downloadsDir ? path.join(d.downloadsDir, name) : name,
      });
      if (res.canceled || !res.filePath) return null;
      const data = await api.download(p);
      await fs.promises.writeFile(res.filePath, data);
      log.info(`Saved ${name} to ${res.filePath}`);
      return res.filePath;
    },

    // --- calendar -------------------------------------------------------------------------
    // Saves the guild's raids and events as an .ics file the player imports into their calendar.
    'calendar.export': async () => {
      const ics = await api.request('GET', '/api/calendar.ics', undefined, { raw: true });
      if (typeof ics !== 'string' || !ics.startsWith('BEGIN:VCALENDAR')) throw userError("Guild Camp couldn't make the calendar file.");
      let guildName = 'Guild';
      try {
        const s = auth.state();
        if (s && s.guild && s.guild.name) guildName = s.guild.name;
      } catch { /* the default name is fine */ }
      const name = cleanFileName(`${guildName} raids.ics`, 'Guild raids.ics');
      const res = await dialog.showSaveDialog(parent(), {
        title: 'Export to calendar',
        defaultPath: d.downloadsDir ? path.join(d.downloadsDir, name) : name,
        filters: [{ name: 'Calendar file', extensions: ['ics'] }],
      });
      if (res.canceled || !res.filePath) return null;
      await fs.promises.writeFile(res.filePath, ics, 'utf8');
      log.info(`Saved the raid calendar to ${res.filePath}`);
      return res.filePath;
    },

    // --- secrets (set only; the page never reads one back) ----------------------------------
    'secrets.set': async (name, value) => {
      if (!RENDERER_SECRETS.includes(name)) throw userError("Guild Camp doesn't keep that.", 400);
      if (value === null || value === undefined || value === '') {
        store.setSecret(name, null);
        log.info('Anthropic API key removed. The Coach\'s AI answers are off.');
        return { name, set: false, encrypted: store.secretsEncrypted() };
      }
      if (typeof value !== 'string') throw userError('Paste the key as text.', 400);
      const key = value.trim();
      if (key.length < 20 || key.length > 300 || /\s/.test(key)) {
        throw userError('That doesn\'t look like an Anthropic API key. Copy it again from console.anthropic.com (it starts with sk-ant-).', 400);
      }
      store.setSecret(name, key);
      log.info('Anthropic API key saved. The Coach can answer with AI now.');
      return { name, set: true, encrypted: store.secretsEncrypted() };
    },
    'secrets.has': (name) => {
      if (!RENDERER_SECRETS.includes(name)) throw userError("Guild Camp doesn't keep that.", 400);
      return Boolean(store.getSecret(name));
    },

    // --- game folders ---------------------------------------------------------------------
    'wow.installs': () => installs(),
    'wow.addFolder': async (dir) => {
      const target = absolutePath(dir, 'folder');
      const st = statOrNull(target);
      if (!st || !st.isDirectory()) throw userError("That folder doesn't exist.", 404);
      const list = store.get().extraWowFolders || [];
      if (!list.some((f) => samePath(f, target))) await setSettings({ extraWowFolders: [...list, target] });
      return installs();
    },
    'wow.removeFolder': async (dir) => {
      if (typeof dir !== 'string') throw userError('Pick a folder to remove.', 400);
      const list = store.get().extraWowFolders || [];
      const next = list.filter((f) => !samePath(f, dir));
      if (next.length !== list.length) await setSettings({ extraWowFolders: next });
      return installs();
    },
    'wow.detectGuild': () => wow.detectGuild({ extraRoots: store.get().extraWowFolders, scanDefaults: true }),

    // --- sync -----------------------------------------------------------------------------
    'sync.status': () => sync.status(),
    'sync.now': () => sync.syncNow(),
    'sync.setEnabled': async (enabled) => {
      await setSettings({ syncEnabled: Boolean(enabled) });
      return sync.status();
    },

    // --- addon ----------------------------------------------------------------------------
    'addon.status': () => addon.status(),
    'addon.check': (opts) => addon.check({ force: !!(opts && opts.force === true) }),
    'addon.install': (dir) => addon.install(dir),
    'addon.update': (dir) => addon.update(dir),
    'addon.updateAll': () => addon.updateAll(),
    'addon.repair': (dir) => addon.repair(dir),
    'addon.uninstall': (dir) => addon.uninstall(dir),
    'addon.openFolder': async (dir) => {
      const status = await addon.status();
      const list = (status && status.installs) || [];
      const install = list.find((i) => samePath(i.dir, dir));
      if (!install) throw userError("That game folder isn't in the list.", 404);
      const own = path.join(install.addonsDir, 'WowGuild');
      const target = statOrNull(own) ? own : install.addonsDir;
      const problem = await shell.openPath(target);
      if (problem) throw userError(problem);
      return true;
    },

    // --- updater --------------------------------------------------------------------------
    'updater.status': () => updater.status(),
    'updater.check': (opts) => updater.check({ force: !!(opts && opts.force === true) }),
    'updater.download': () => updater.download(),
    'updater.install': () => updater.install(),

    // --- publisher (GitHub releases with the gh CLI; it checks for itself who may publish) ---
    'publisher.status': () => publisher.status(),
    'publisher.publishAddon': async (opts) => publisher.publishAddon(opts && typeof opts === 'object' ? opts : {}),
    'publisher.publishApp': async (opts) => publisher.publishApp(opts && typeof opts === 'object' ? opts : {}),
    'publisher.cancel': async () => publisher.cancel(),
    'publisher.setRepoDir': async (dir) => publisher.setRepoDir(dir === null || dir === '' ? null : absolutePath(dir, 'folder')),

    // --- notifications --------------------------------------------------------------------
    'notify.test': () => notify.test(),
  };
}

module.exports = {
  createIpc,
  buildMethods,
  forwardEvents,
  dispatch,
  serialiseError,
  cleanFileName,
  checkApiPath,
  checkDownloadPath,
  serverPathname,
  METHOD_NAMES,
  EVENT_CHANNELS,
  RENDERER_SECRETS,
  INVOKE_CHANNEL,
  EVENT_CHANNEL,
};
