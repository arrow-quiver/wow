'use strict';
// Guild Camp main process entry.
//
// Responsibilities: single instance, guildcamp:// links, app lifecycle, building the services in
// order (log → store → credentials → auth → wow → addon → updater → local core → api → sync → publisher →
// notify → session → ipc → window → tray), start-hidden in the tray, quitting, and the --smoke screenshot run.
//
// There is no Guild Camp server. The guild data lives in the local core (src/core): an Express app on
// 127.0.0.1 with a per-launch token, inside this process, over userData/guildcamp.db. Everything works
// without Battle.net: sync starts at once, the guild comes from the game's saved data, roles from in-game
// ranks. Battle.net sign-in (auth.js, optional) only adds the BattleTag and the character list, which go
// to the core with core.setIdentity().
//
// Notifications come from the core's event bus (core.emitter 'event') → native notification + the
// renderer's 'server-event' channel (same name as before, so pages keep working).
//
// Command line:
//   --hidden                 start in the tray (used by "start with Windows")
//   --dev                    dev conveniences (reload keys, log echo); unpackaged runs get them anyway
//   --user-data <dir>        use another user data folder (also env GUILDCAMP_USER_DATA); not for smoke runs
//   --smoke                  open the window, screenshot routes, write smoke-report.json, exit 0/1. Always in its
//                            own user data folder (<smoke out>/user-data), whatever GUILDCAMP_USER_DATA says
//   --smoke-user-data <dir>  a smoke run's user data folder instead (a scratch folder with fake game folders)
//   --smoke-seed             fill the local data with a demo guild first (and pretend to be signed in
//                            to Battle.net as the demo player), so every page has something to show
//   --smoke-routes=/,/raids  routes to capture (default: every route the renderer reports)
//   --smoke-out=<dir>        where screenshots go (default app/dist/smoke)
//   --smoke-scan             let a smoke run look in the usual game folders (off by default)

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const APP_ID = 'com.arrowquiver.guildcamp';
const PROTOCOL = 'guildcamp';
const SMOKE_TIMEOUT_MS = 120000;
const SMOKE_READY_WAIT_MS = 30000;
const SMOKE_ROUTE_WAIT_MS = 1500;
const UPDATE_CHECK_MS = 30 * 60 * 1000;
const ADDON_CHECK_MS = 60 * 60 * 1000;

// GET endpoints the pages use; a smoke run checks that each answers, so a broken one shows in the report.
const SMOKE_API_PATHS = [
  '/api/me', '/api/meta', '/api/camp', '/api/activity', '/api/roster', '/api/crafters', '/api/requests', '/api/partners',
  '/api/raids', '/api/loot', '/api/bank', '/api/bank/alts', '/api/prices', '/api/drives', '/api/coach', '/api/guild',
  '/api/members', '/api/admin', '/api/admin/status', '/api/inbox', '/api/calendar.ics',
];

// ---------------------------------------------------------------------------------------------
// Pure helpers (exported for tests)

function parseArgs(argv) {
  const out = { hidden: false, dev: false, smoke: false, smokeScan: false, smokeSeed: false, userData: null, smokeUserData: null, smokeRoutes: null, smokeOut: null };
  const list = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < list.length; i++) {
    const arg = list[i];
    if (typeof arg !== 'string' || !arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? null : arg.slice(eq + 1);
    const value = () => {
      if (inline !== null) return inline;
      const next = list[i + 1];
      if (typeof next === 'string' && !next.startsWith('--') && !next.toLowerCase().startsWith(`${PROTOCOL}://`)) {
        i += 1;
        return next;
      }
      return null;
    };
    switch (flag) {
      case '--hidden': out.hidden = true; break;
      case '--dev': out.dev = true; break;
      case '--smoke': out.smoke = true; break;
      case '--user-data': out.userData = value(); break;
      case '--smoke-scan': out.smokeScan = true; break;
      case '--smoke-seed': out.smokeSeed = true; break;
      case '--smoke-user-data': out.smokeUserData = value(); break;
      case '--smoke-out': out.smokeOut = value(); break;
      case '--smoke-routes': {
        const v = value();
        out.smokeRoutes = v ? v.split(',').map((s) => s.trim()).filter(Boolean) : null;
        break;
      }
      default: break;
    }
  }
  return out;
}

// App routes a guildcamp:// link may open (first path segment). Kept to read-only pages.
const DEEP_LINK_ROOTS = new Set(['raids', 'characters', 'coach', 'crafters', 'requests', 'partners', 'roster', 'bank', 'prices', 'drives', 'loot', 'addon', 'updates', 'settings']);

function findDeepLink(argv) {
  return (Array.isArray(argv) ? argv : []).find((a) => typeof a === 'string' && a.toLowerCase().startsWith(`${PROTOCOL}://`)) || null;
}

/**
 * guildcamp://raids/12, guildcamp://characters/Name, guildcamp://coach … → the same app route.
 * Anything else → null (just focus the app).
 */
function deepLinkRoute(url) {
  if (typeof url !== 'string') return null;
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== `${PROTOCOL}:`) return null;
  let parts;
  try {
    parts = [u.host, ...u.pathname.split('/')].filter(Boolean).map((p) => decodeURIComponent(p));
  } catch {
    return null;
  }
  const first = (parts[0] || '').toLowerCase();
  if (DEEP_LINK_ROOTS.has(first) && parts.length <= 3 && parts.every((p) => /^[\p{L}\p{N} _'-]{1,64}$/u.test(p))) {
    return `/${[first, ...parts.slice(1)].map((p) => encodeURIComponent(p)).join('/')}`;
  }
  return null;
}

/**
 * The user data folder to use instead of Electron's default, or null for the default.
 * A smoke run always gets its own (--smoke-user-data, else <smokeOut>/user-data): GUILDCAMP_USER_DATA and
 * --user-data are for dev runs and never point a smoke run at a real or dev profile.
 */
function pickUserDataDir(args, env, smokeOut) {
  const a = args || {};
  const e = env || {};
  if (a.smoke) return path.resolve(a.smokeUserData || path.join(smokeOut, 'user-data'));
  const dir = a.userData || e.GUILDCAMP_USER_DATA || null;
  return dir ? path.resolve(dir) : null;
}

// A smoke run's settings for that run only (store overrides, never written to settings.json): nothing installs,
// updates, syncs or notifies in the background.
const SMOKE_SETTINGS = Object.freeze({ addonAutoUpdate: false, addonAutoInstall: false, appAutoUpdate: false, syncEnabled: false, notifications: false });

/** "/" → "home", "/guild-settings" → "guild-settings", "/raids?x=1" → "raids-x-1". */
function routeSlug(route) {
  const slug = String(route || '').replace(/^\/+/, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
  return slug || 'home';
}

function detectRepoDir(appDir) {
  const repo = path.dirname(appDir);
  const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
  return isDir(path.join(repo, 'app')) && isDir(path.join(repo, 'addon')) ? repo : null;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** What the core needs from a Battle.net state: the BattleTag and characters, or nothing when signed out. */
function identityOf(authState) {
  const s = authState && typeof authState === 'object' ? authState : {};
  if (!s.signedIn) return { battletag: null, characters: [] };
  return {
    battletag: typeof s.battletag === 'string' ? s.battletag : null,
    characters: Array.isArray(s.characters) ? s.characters : [],
    profileAt: s.profileAt || null,
  };
}

/**
 * The session the renderer sees as auth.*: Battle.net sign-in in the app (auth.js) plus who I am in the
 * local core (user, guild, role from in-game ranks). Plain Node, tested without Electron.
 *
 *   const session = createSession({ auth, core, log });
 *   session.state() → { ...auth.state(), user, guild, role }
 *   session.signIn() / signOut() / refresh() → state
 *   session.on('change', (state) => ...)   Battle.net changed, or the core's session did (first sync made the
 *                                           guild, a new rank made me an officer, ...)
 * Battle.net changes are passed on to the core (core.setIdentity) as they happen.
 */
function createSession({ auth, core, log }) {
  const emitter = new EventEmitter();
  let lastIdentity = null;
  let lastEmitted = null;

  const local = () => {
    try { return core.session(); } catch (err) {
      if (log) log.warn(`Couldn't read your guild details: ${err.message}`);
      return { user: null, guild: null, role: null };
    }
  };
  const state = () => {
    const a = (auth && auth.state()) || {};
    const l = local();
    return { ...a, user: l.user || null, guild: l.guild || null, role: l.role || null };
  };
  const pushIdentity = (authState) => {
    const id = identityOf(authState);
    const key = JSON.stringify([id.battletag, id.characters]);
    if (key === lastIdentity) return;
    lastIdentity = key;
    core.setIdentity(id);
  };
  const changed = () => {
    const s = state();
    const json = JSON.stringify(s);
    if (json === lastEmitted) return s;
    lastEmitted = json;
    emitter.emit('change', s);
    return s;
  };

  lastIdentity = JSON.stringify((() => { const id = identityOf(auth && auth.state()); return [id.battletag, id.characters]; })());
  lastEmitted = JSON.stringify(state());
  if (auth && typeof auth.on === 'function') {
    auth.on('change', (s) => {
      try { pushIdentity(s); } catch (err) { if (log) log.warn(`Couldn't save your Battle.net details: ${err.message}`); }
      changed();
    });
  }
  if (core && core.emitter) core.emitter.on('session', () => changed());

  const after = (fn) => async (...args) => {
    await fn(...args);
    pushIdentity(auth.state());
    return changed();
  };
  return Object.assign(emitter, {
    state,
    signIn: after(() => auth.signIn()),
    signOut: after(() => auth.signOut()),
    refresh: after(() => (typeof auth.refresh === 'function' ? auth.refresh() : null)),
  });
}

/**
 * The background sync engine (sync.js), wired to the local core: a change queued for the guild (the core's
 * 'outbox' event, after sharing.queue()) rewrites the inbox within 2 s, without waiting for an upload.
 */
function createAppSync({ core, ...deps }) {
  const { createSync } = require('./sync');
  return createSync({ ...deps, coreEvents: core && core.emitter });
}

/**
 * A game folder that just got the addon gets its news folder (WowGuild_Inbox) within a second or two, through the
 * same writer as every sync. Left to the next upload or the 5-minute refresh, the news folder could appear while the
 * game runs, and only a game restart loads a new addon folder. → stop()
 */
function wireInboxAfterInstall({ addon, sync }) {
  if (!addon || typeof addon.on !== 'function' || !sync || typeof sync.outboxChanged !== 'function') return () => {};
  let had = null; // game folders that had the addon at the last status
  const onStatus = (s) => {
    if (!s || !Array.isArray(s.installs)) return;
    const now = new Set(s.installs.filter((i) => i && i.installed && typeof i.dir === 'string').map((i) => i.dir.toLowerCase()));
    const added = had !== null && [...now].some((dir) => !had.has(dir));
    had = now;
    if (added) sync.outboxChanged();
  };
  try { onStatus(addon.status()); } catch { /* not ready yet: the first status event sets the baseline */ }
  addon.on('status', onStatus);
  return () => { if (typeof addon.off === 'function') addon.off('status', onStatus); };
}

/**
 * Smoke runs: the addon manager's and the updater's checks (which ask GitHub, and may install or update the
 * addon) do nothing and just report the current status, whoever calls them (the pages do, through IPC).
 */
function skipChecksForSmoke({ addon, updater }) {
  if (addon) addon.check = async () => addon.status();
  if (updater) updater.check = async () => updater.status();
}

/** The newest app and addon versions the updater and addon manager know about, for the core. */
function createLatestTracker({ updater, addon }) {
  const latest = { app: null, addon: null };
  const fromUpdater = (s) => {
    if (!s || typeof s !== 'object') return;
    latest.app = (s.available && s.available.version) || s.current || latest.app;
  };
  const fromAddon = (s) => {
    if (!s || typeof s !== 'object') return;
    latest.addon = (s.latest && s.latest.version) || latest.addon;
  };
  const read = (source, fn) => {
    if (!source) return;
    try {
      const s = typeof source.status === 'function' ? source.status() : null;
      if (s && typeof s.then === 'function') s.then(fn, () => {});
      else fn(s);
    } catch { /* not ready yet */ }
    if (typeof source.on === 'function') source.on('status', fn);
  };
  read(updater, fromUpdater);
  read(addon, fromAddon);
  return () => ({ app: latest.app, addon: latest.addon });
}

/** Core events → the renderer ('server-event') and a native notification when notifications are on. */
function wireNotifications({ core, notify, broadcast, store, log }) {
  const onEvent = (ev) => {
    if (!ev || typeof ev !== 'object') return;
    broadcast('server-event', ev);
    if (store.get().notifications === false) return;
    try { notify.show(ev); } catch (err) { if (log) log.warn(`A notification couldn't be shown: ${err.message}`); }
  };
  core.emitter.on('event', onEvent);
  return () => core.emitter.off('event', onEvent);
}

// ---------------------------------------------------------------------------------------------
// Electron bootstrap

function bootstrap() {
  const { app, dialog, shell, safeStorage, nativeTheme, session, Menu } = require('electron');
  const { createLog } = require('./log');
  const { createStore } = require('./store');
  const { createApi } = require('./api');
  const { createAuth } = require('./auth');
  const { loadBnetCredentials } = require('./credentials');
  const wow = require('./wow');
  const { createAddonManager } = require('./addon');
  const { createUpdater } = require('./updater');
  const { createPublisher } = require('./publisher');
  const { createNotify } = require('./notify');
  const { createStartup } = require('./startup');
  const { createIpc, buildMethods, forwardEvents } = require('./ipc');
  const { registerScheme, registerAppProtocol, createMainWindow, showWindow, findIcon } = require('./window');
  const { createTray } = require('./tray');
  const { createCore } = require('../core');

  const args = parseArgs(process.argv.slice(1));
  const isPackaged = app.isPackaged;
  const devMode = !isPackaged || args.dev;
  const appDir = app.getAppPath();
  const version = app.getVersion();
  const smokeOut = path.resolve(args.smokeOut || path.join(appDir, 'dist', 'smoke'));

  // A separate user data folder keeps dev and smoke runs away from real settings and data.
  // Smoke runs always get their own folder (pickUserDataDir).
  const userDataOverride = pickUserDataDir(args, process.env, smokeOut);
  if (userDataOverride) app.setPath('userData', userDataOverride);

  app.setAppUserModelId(APP_ID);
  registerScheme();

  if (!args.smoke && !app.requestSingleInstanceLock()) {
    // Another Guild Camp is running; it receives our arguments (and any link) and shows itself.
    app.quit();
    return;
  }

  // Isolated runs (smoke, or a dev run with its own user data folder) leave guildcamp:// links alone so
  // they keep opening the normal install.
  if (!args.smoke && !(userDataOverride && !isPackaged)) {
    try {
      if (isPackaged) app.setAsDefaultProtocolClient(PROTOCOL);
      else app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(appDir)]);
    } catch { /* not fatal: links just won't open the app */ }
  }

  // ---- state ---------------------------------------------------------------------------------
  let quitting = false;
  let mainWindow = null;
  let firstWindow = true;
  let tray = null;
  let rendererIsReady = false;
  let pendingRoute = deepLinkRoute(findDeepLink(process.argv));
  let services = null; // set once ready
  const timers = [];
  let resolveSmokeReady = null;
  const smokeReady = new Promise((resolve) => { resolveSmokeReady = resolve; });

  const broadcast = (channel, payload) => { if (services && services.ipc) services.ipc.broadcast(channel, payload); };

  function navigateTo(route) {
    if (!route) return;
    if (rendererIsReady && mainWindow && !mainWindow.isDestroyed()) broadcast('navigate', route);
    else pendingRoute = route; // delivered when the renderer calls app.rendererReady
  }

  function handleDeepLink(url) {
    const route = deepLinkRoute(url);
    if (services) {
      services.log.info(route ? `Opened a link to ${route}.` : `Opened a ${PROTOCOL}:// link.`);
      showMain();
      navigateTo(route);
    } else if (route) {
      pendingRoute = route;
    }
  }

  function showMain() {
    if (!services) return;
    if (!mainWindow || mainWindow.isDestroyed()) createWindow();
    showWindow(mainWindow);
  }

  function quit() {
    quitting = true;
    app.quit();
  }

  function relaunch() {
    quitting = true;
    app.relaunch({ args: process.argv.slice(1).filter((a) => a !== '--hidden') });
    app.quit();
  }

  function createWindow() {
    const { log, store } = services;
    const hidden = firstWindow && args.hidden && !args.smoke;
    firstWindow = false;
    let lastCrash = 0;
    rendererIsReady = false;
    mainWindow = createMainWindow({
      store,
      log: log.scope('window'),
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      iconPath: services.iconPath,
      startHidden: hidden,
      startQuery: args.smoke ? 'splash=0' : '',
      isQuitting: () => quitting,
      canHideToTray: () => Boolean(tray && tray.exists()),
      allowReloadKeys: devMode,
    });
    const wc = mainWindow.webContents;
    // A reload starts the renderer over; it calls app.rendererReady again when it is up.
    wc.on('did-navigate', () => { rendererIsReady = false; });
    wc.on('render-process-gone', (_e, details) => {
      rendererIsReady = false;
      log.error(`The window's page stopped (${details.reason}, exit code ${details.exitCode}).`);
      if (args.smoke || details.reason === 'clean-exit') return;
      // Reload once; if it keeps crashing, leave it so the log isn't flooded.
      if (Date.now() - lastCrash > 30000) {
        lastCrash = Date.now();
        setTimeout(() => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.reload(); }, 1000);
      }
    });
    wc.on('unresponsive', () => log.warn('The window stopped responding.'));
    mainWindow.on('closed', () => { mainWindow = null; rendererIsReady = false; });
  }

  function rendererReady(info) {
    rendererIsReady = true;
    if (resolveSmokeReady) resolveSmokeReady(info || {});
    if (pendingRoute) {
      const route = pendingRoute;
      pendingRoute = null;
      // After the renderer's invoke() has resolved, so its router is listening.
      setTimeout(() => broadcast('navigate', route), 50);
    }
    return { smoke: args.smoke, version };
  }

  // ---- lifecycle -----------------------------------------------------------------------------
  app.on('second-instance', (_event, argv) => {
    const link = findDeepLink(argv);
    if (link) handleDeepLink(link);
    else showMain();
  });

  // macOS delivers links here (also before 'ready').
  app.on('open-url', (event, url) => {
    event.preventDefault();
    handleDeepLink(url);
  });

  // The local data service is closed once, after everything that writes to it has stopped.
  let coreClosed = false;
  app.on('before-quit', (event) => {
    quitting = true;
    for (const t of timers) clearInterval(t);
    if (!services || coreClosed) return;
    try { services.sync.stop(); } catch { /* quitting anyway */ }
    if (!services.core) return;
    event.preventDefault();
    coreClosed = true;
    const core = services.core;
    // An upload in progress gets a moment to finish; the database is closed either way.
    const settle = Promise.race([Promise.resolve().then(() => services.sync.whenIdle()), delay(3000)]);
    settle
      .catch(() => {})
      .then(() => Promise.race([core.close(), delay(3000)]))
      .catch((err) => services.log.warn(`Closing the local data didn't finish cleanly: ${err.message}`))
      .finally(() => app.quit());
  });

  app.on('will-quit', () => {
    if (tray) tray.destroy();
    if (services) services.log.info('Guild Camp stopped.');
  });

  app.on('window-all-closed', () => {
    // With close-to-tray the window only hides, so getting here means the user really closed it.
    if (process.platform !== 'darwin' || quitting) app.quit();
  });

  app.on('activate', () => showMain());

  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (e) => e.preventDefault());
  });

  app.whenReady().then(start).catch((err) => {
    const message = (err && err.message) || String(err);
    try { if (services) services.log.error('Guild Camp could not start:', err); } catch { /* ignore */ }
    if (args.smoke) {
      try {
        fs.mkdirSync(smokeOut, { recursive: true });
        fs.writeFileSync(path.join(smokeOut, 'smoke-report.json'), JSON.stringify({ routes: [], errors: [`Startup failed: ${message}`] }, null, 2));
      } catch { /* ignore */ }
    } else {
      dialog.showErrorBox('Guild Camp could not start', message);
    }
    app.exit(1);
  });

  // ---- start ---------------------------------------------------------------------------------
  async function start() {
    const userData = app.getPath('userData');
    const log = createLog(path.join(userData, 'logs'), { echo: devMode || args.smoke });
    process.on('uncaughtException', (err) => log.error('Unexpected error:', err));
    process.on('unhandledRejection', (reason) => log.warn('Unhandled promise rejection:', reason instanceof Error ? reason : String(reason)));
    log.info(`Guild Camp ${version} starting (${isPackaged ? 'installed' : 'dev'}; Electron ${process.versions.electron}; ${process.platform} ${process.arch}).`);
    if (userDataOverride) log.info(`User data folder: ${userData}`);

    // Smoke runs are for screenshots only: they must never read or change a real game install.
    // Default folder scanning is off (add fake folders with extraWowFolders in a scratch folder given with
    // --smoke-user-data, or pass --smoke-scan), and nothing installs, updates or syncs in the background. Those
    // switches hold for this run only: settings.json keeps what was chosen there.
    const store = createStore(userData, {
      encrypt: (text) => safeStorage.encryptString(text),
      decrypt: (buf) => safeStorage.decryptString(buf),
      isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
      overrides: args.smoke ? SMOKE_SETTINGS : null,
    });
    for (const problem of store.problems) log.warn(problem);
    if (args.smoke && !args.smokeScan) process.env.GUILDCAMP_NO_SCAN = '1';

    // Light/dark: the renderer's prefers-color-scheme follows the Theme setting.
    nativeTheme.themeSource = store.get().theme || 'system';
    store.on('change', (s, keys) => { if (keys.includes('theme')) nativeTheme.themeSource = s.theme || 'system'; });

    // Permissions: notifications and clipboard writes only.
    const allowed = new Set(['notifications', 'clipboard-sanitized-write', 'fullscreen']);
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed.has(permission)));
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));

    if (process.platform === 'darwin') {
      Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }]));
    } else {
      Menu.setApplicationMenu(null); // shortcuts are handled in window.js
    }

    // Battle.net: the client id and secret built into the installer (or env vars in development).
    // A smoke run with demo data never talks to Battle.net: it is "signed in" as the demo player.
    const credentials = loadBnetCredentials({ appDir, log: log.scope('auth') });
    let demo = null;
    let auth;
    if (args.smoke && args.smokeSeed) {
      demo = require('../core/demo');
      auth = demo.createDemoAuth();
    } else {
      auth = createAuth({ store, log: log.scope('auth'), appVersion: version, credentials, openExternal: (url) => shell.openExternal(url) });
    }
    if (!credentials && !demo) log.info('This copy of Guild Camp has no Battle.net app built in. Everything works without signing in.');

    // A smoke run stays off the network and never runs the GitHub CLI: addon and app update checks do
    // nothing, and the Releases page sees no gh (unless --smoke-scan, which also lets it scan game folders).
    const offline = args.smoke && !args.smokeScan;
    const offlineFetch = async () => { throw new Error('Smoke runs stay offline.'); };
    const resourcesDir = isPackaged ? process.resourcesPath : path.resolve(appDir, '..');
    const addon = createAddonManager({ store, log: log.scope('addon'), wow, resourcesDir, fetch: offline ? offlineFetch : globalThis.fetch });
    const updater = createUpdater({ store, log: log.scope('updater'), appVersion: version, isPackaged, ...(offline ? { fetch: offlineFetch } : {}) });
    if (offline) skipChecksForSmoke({ addon, updater });
    const latest = createLatestTracker({ updater, addon });

    // The local core: guild data, on this computer only.
    const core = await createCore({
      dataDir: userData,
      log: log.scope('core'),
      getIdentity: () => identityOf(auth.state()),
      getSecret: (name) => store.getSecret(name),
      getSettings: () => store.get(),
      credentials,
      getLatest: latest,
    });
    if (demo) {
      try {
        await demo.loadDemo(core);
        log.info('Demo guild loaded for the smoke run.');
      } catch (err) {
        log.error('Loading the demo guild failed:', err);
      }
    }

    const api = createApi({ getBase: () => core.url, getToken: () => core.token, appVersion: version, log: log.scope('api') });
    const sync = createAppSync({ api, store, log: log.scope('sync'), wow, appVersion: version, core });
    const publisher = createPublisher({
      store, log: log.scope('publisher'), appVersion: version, isPackaged, appDir,
      // No GitHub CLI and no network in a smoke run: the Releases page shows its "not set up" state.
      ...(offline ? { gh: path.join(userData, 'smoke-has-no-gh', 'gh'), fetch: offlineFetch } : {}),
    });
    const iconPath = findIcon();
    const notify = createNotify({ showWindow: () => showMain(), broadcast, iconPath, log: log.scope('notify') });
    const startup = createStartup();
    const userSession = createSession({ auth, core, log: log.scope('auth') });

    services = { log, store, api, auth, core, session: userSession, wow, sync, addon, updater, publisher, notify, startup, iconPath, ipc: null };

    if (!store.secretsEncrypted()) log.warn('Secure storage is not available. Your Battle.net sign-in and API key are saved without encryption.');

    const methods = buildMethods({
      store, log, auth: userSession, api, wow, sync, addon, updater, publisher, notify, startup, shell, dialog,
      getWindow: () => mainWindow,
      downloadsDir: app.getPath('downloads'),
      quit,
      relaunch,
      rendererReady,
      appInfo: () => ({
        version,
        isPackaged,
        platform: process.platform,
        arch: process.arch,
        electron: process.versions.electron,
        logFile: log.file,
        userData,
        dataFile: path.join(userData, 'guildcamp.db'),
        repoDir: store.get().repoDir || (isPackaged ? null : detectRepoDir(appDir)),
        bnetAvailable: Boolean(credentials),
        secretsEncrypted: store.secretsEncrypted(),
        startWithWindowsSupported: startup.supported,
        smoke: args.smoke,
      }),
    });
    services.ipc = createIpc({
      methods,
      getWindows: () => (mainWindow && !mainWindow.isDestroyed() ? [mainWindow] : []),
      log: log.scope('ipc'),
    });
    forwardEvents({ broadcast, store, log, auth: userSession, sync, addon, updater, publisher });
    wireNotifications({ core, notify, broadcast, store, log: log.scope('notify') });
    // A folder that just got the addon gets its news folder at once, so the game finds both when it next starts.
    wireInboxAfterInstall({ addon, sync });

    registerAppProtocol(path.join(__dirname, '..', 'renderer'), log.scope('protocol'));
    createWindow();

    if (args.smoke) {
      runSmoke().catch((err) => {
        log.error('Smoke run failed:', err);
        app.exit(1);
      });
      return;
    }

    tray = createTray({
      iconPath,
      log: log.scope('tray'),
      onOpen: () => showMain(),
      onSyncNow: () => sync.syncNow(),
      onCheckUpdates: () => {
        showMain();
        navigateTo('/updates');
        return updater.check();
      },
      onQuit: quit,
    });
    tray.setSyncStatus(sync.status());
    sync.on('status', (s) => tray.setSyncStatus(s));
    if (args.hidden && !tray.exists()) showMain(); // nowhere to hide: show the window after all

    const background = (fn, what) => Promise.resolve().then(fn).catch((err) => log.warn(`${what}: ${err.message}`));

    // Sync needs nothing but the game folders: it starts now.
    background(() => sync.start(), 'Sync failed to start');
    // Only while the token is still good: refresh() with an expired token signs the person out.
    if (auth.state().canRefresh) background(() => auth.refresh(), "Couldn't read your Battle.net characters");

    background(() => addon.check(), 'Addon check failed');
    background(() => updater.check(), 'Update check failed');
    timers.push(setInterval(() => background(() => updater.check(), 'Update check failed'), UPDATE_CHECK_MS));
    timers.push(setInterval(() => background(() => addon.check(), 'Addon check failed'), ADDON_CHECK_MS));
    store.on('change', (s, keys) => {
      if (keys.includes('extraWowFolders') || keys.includes('otherGameFolders')) background(() => addon.check(), 'Addon check failed');
    });

    // The first launch of an installed app turns "start with Windows" on once, so the guild stays in
    // sync in the background. The person's own choice in Settings is never overridden.
    if (isPackaged && !store.get().startupDefaulted) {
      let on = false;
      if (startup.supported) {
        try { on = Boolean(startup.set(true)); } catch (err) { log.warn(`Couldn't turn on "start with Windows": ${err.message}`); }
      }
      store.set({ startWithWindows: on, startupDefaulted: true });
      if (on) log.info('Guild Camp now starts with Windows, in the tray, so your guild stays in sync. Turn this off in Settings.');
    } else if (isPackaged && store.get().startWithWindows && startup.supported) {
      // Keep the login item pointing at the current install (the path can change between versions).
      try { startup.set(true); } catch (err) { log.warn(`Couldn't refresh "start with Windows": ${err.message}`); }
    }
  }

  // ---- smoke run -----------------------------------------------------------------------------
  async function runSmoke() {
    const { log, api } = services;
    fs.mkdirSync(smokeOut, { recursive: true });
    const report = { app: version, startedAt: new Date().toISOString(), outDir: smokeOut, seeded: args.smokeSeed, routes: [], api: [], errors: [], warnings: [] };
    let sink = report.errors; // errors go to the route being captured, or the run as a whole
    let finished = false;

    const finish = (extraError) => {
      if (finished) return;
      finished = true;
      if (extraError) report.errors.push(extraError);
      const problems = report.errors.length + report.routes.reduce((n, r) => n + r.errors.length, 0);
      report.ok = problems === 0;
      report.finishedAt = new Date().toISOString();
      try {
        fs.writeFileSync(path.join(smokeOut, 'smoke-report.json'), `${JSON.stringify(report, null, 2)}\n`);
      } catch (err) {
        log.error(`Couldn't write the smoke report: ${err.message}`);
      }
      log.info(report.ok ? `Smoke run passed (${report.routes.length} route(s)).` : `Smoke run found ${problems} problem(s). See ${path.join(smokeOut, 'smoke-report.json')}.`);
      quitting = true;
      const done = () => app.exit(report.ok ? 0 : 1);
      Promise.resolve(services.core && services.core.close()).catch(() => {}).finally(done);
    };
    const hardStop = setTimeout(() => finish(`The smoke run took longer than ${SMOKE_TIMEOUT_MS / 1000} seconds and was stopped.`), SMOKE_TIMEOUT_MS);

    const wc = mainWindow.webContents;
    // Electron 45 passes one details object { level: 'info'|'warning'|'error'|'debug', message, lineNumber, sourceId }.
    wc.on('console-message', (details) => {
      if (details.level !== 'error') return;
      const source = details.sourceId || '';
      const text = `${details.message}${source ? ` (${source}:${details.lineNumber})` : ''}`;
      // Errors from web addresses (Wowhead tooltip data or icons failing offline) are noted, not counted.
      if (/^https?:/i.test(source || '')) report.warnings.push(text);
      else sink.push(text);
    });
    wc.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
      if (code === -3) return; // aborted navigation
      (isMainFrame ? sink : report.warnings).push(`Failed to load ${url}: ${description} (${code})`);
    });
    wc.on('did-navigate', (_e, url, httpCode) => {
      if (httpCode >= 400) sink.push(`${url} answered ${httpCode}. Is src/renderer/index.html there?`);
    });
    wc.on('render-process-gone', (_e, details) => sink.push(`The page crashed (${details.reason}).`));
    wc.on('preload-error', (_e, file, error) => sink.push(`Preload failed (${file}): ${error.message}`));
    wc.once('did-finish-load', () => showWindow(mainWindow));

    // The local core answers on its own; record what each page's endpoint says.
    for (const p of SMOKE_API_PATHS) {
      try {
        await api.request('GET', p, undefined, { raw: true });
        report.api.push({ path: p, ok: true });
      } catch (err) {
        report.api.push({ path: p, ok: false, status: err.status || 0, error: err.message });
      }
    }

    const info = await Promise.race([smokeReady, delay(SMOKE_READY_WAIT_MS).then(() => null)]);
    if (!info) report.errors.push('The page never reported that it was ready (gc.app.rendererReady was not called).');

    const reported = info && Array.isArray(info.routes) ? info.routes : null;
    const routes = (args.smokeRoutes || reported || ['/'])
      .map((r) => (typeof r === 'string' ? r : r && r.path))
      .filter((r) => typeof r === 'string' && r.startsWith('/') && !r.includes(':'));
    // (From Git Bash, quote or set MSYS_NO_PATHCONV=1: it rewrites "--smoke-routes=/" into a Windows path.)
    if (!routes.length) report.errors.push('There were no routes to capture. Routes must start with "/".');

    for (const route of [...new Set(routes)]) {
      if (finished) return;
      const entry = { route, file: null, errors: [] };
      report.routes.push(entry);
      sink = entry.errors;
      broadcast('navigate', route);
      await delay(SMOKE_ROUTE_WAIT_MS);
      if (finished) return;
      try {
        const image = await wc.capturePage();
        const file = `${routeSlug(route)}.png`;
        fs.writeFileSync(path.join(smokeOut, file), image.toPNG());
        entry.file = file;
      } catch (err) {
        entry.errors.push(`Screenshot failed: ${err.message}`);
      }
    }
    sink = report.errors;
    clearTimeout(hardStop);
    finish();
  }
}

if (process.versions.electron && process.type === 'browser') bootstrap();

module.exports = {
  parseArgs, findDeepLink, deepLinkRoute, routeSlug, detectRepoDir, identityOf, createSession,
  createLatestTracker, wireNotifications, skipChecksForSmoke, createAppSync, wireInboxAfterInstall, pickUserDataDir, SMOKE_API_PATHS, SMOKE_SETTINGS,
};
