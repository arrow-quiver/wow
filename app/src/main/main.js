'use strict';
// Guild Camp main process entry.
//
// Responsibilities: single instance, guildcamp:// links, app lifecycle, building the services in
// order (log → store → api → auth → wow → sync → addon → membership → updater → publisher → events →
// ipc → window → tray), start-hidden in the tray, quitting, and the --smoke screenshot run.
//
// After "Sign in with Battle.net" everything else happens here by itself:
//   - sync and the event feed start; the addon check runs again (it installs the addon into game
//     folders that don't have it, where the game version is supported)
//   - while signed in without a guild, membership.js asks the server to match the member to its guild
//     right away, every 60 s, and whenever the game saves (the sync upload tries too and reports
//     'joined' / 'no-guild'); once in a guild, sync uploads at once
//   - the first sign-in of an installed app turns "start with Windows" on once (startupDefaulted)
//
// Command line:
//   --hidden                 start in the tray (used by "start with Windows")
//   --dev                    dev conveniences (reload keys, log echo); unpackaged runs get them anyway
//   --user-data <dir>        use another user data folder (also env GUILDCAMP_USER_DATA)
//   --smoke                  open the window, screenshot routes, write smoke-report.json, exit 0/1
//   --smoke-login=<BattleTag>   dev sign-in first (needs a DEV_LOGIN server via GUILDCAMP_SERVER)
//   --smoke-routes=/,/raids     routes to capture (default: every route the renderer reports)
//   --smoke-out=<dir>           where screenshots go (default app/dist/smoke)
//   --smoke-scan                let a smoke run look in the usual game folders (off by default)
// Env: GUILDCAMP_SERVER overrides the server address at startup.

const fs = require('fs');
const path = require('path');
const { joinedResult } = require('./membership');

const APP_ID = 'com.arrowquiver.guildcamp';
const PROTOCOL = 'guildcamp';
const SMOKE_TIMEOUT_MS = 90000;
const SMOKE_READY_WAIT_MS = 30000;
const SMOKE_ROUTE_WAIT_MS = 1500;
const UPDATE_CHECK_MS = 30 * 60 * 1000;
const ADDON_CHECK_MS = 60 * 60 * 1000;
// Roles change on the server (an officer promotes or demotes someone): the profile is read again on
// this timer while signed in, and when the window is shown or focused (at most every PROFILE_FOCUS_GAP_MS).
const PROFILE_REFRESH_MS = 5 * 60 * 1000;
const PROFILE_FOCUS_GAP_MS = 20 * 1000;

// ---------------------------------------------------------------------------------------------
// Pure helpers (exported for tests)

function parseArgs(argv) {
  const out = { hidden: false, dev: false, smoke: false, smokeScan: false, userData: null, smokeLogin: null, smokeRoutes: null, smokeOut: null };
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
      case '--smoke-login': out.smokeLogin = value(); break;
      case '--smoke-scan': out.smokeScan = true; break;
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
 * guildcamp://join/<code> → "/welcome?join=<code>".
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
  if (parts[0] && parts[0].toLowerCase() === 'join' && parts[1] && /^[A-Za-z0-9_-]{1,64}$/.test(parts[1])) {
    return `/welcome?join=${encodeURIComponent(parts[1])}`;
  }
  const first = (parts[0] || '').toLowerCase();
  if (DEEP_LINK_ROOTS.has(first) && parts.length <= 3 && parts.every((p) => /^[\p{L}\p{N} _'-]{1,64}$/u.test(p))) {
    return `/${[first, ...parts.slice(1)].map((p) => encodeURIComponent(p)).join('/')}`;
  }
  return null;
}

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

/**
 * fn, but at most once per gapMs: calls in between are dropped (returns false). mark() counts as a
 * call without running fn (for a refresh that already happened another way).
 */
function throttle(fn, gapMs, now = Date.now) {
  let last = -Infinity;
  const run = (...args) => {
    const t = now();
    if (t - last < gapMs) return false;
    last = t;
    fn(...args);
    return true;
  };
  run.mark = () => { last = now(); };
  return run;
}

/**
 * Wires the automatic "sign in → join the guild → sync" flow between the services. Plain Node (the
 * services are injected), so it is tested without Electron. Returns the auth 'change' handler; call
 * it once with auth.state() at startup.
 *
 * @param {object} d
 * @param {object} d.auth @param {object} d.sync @param {object} d.events @param {object} d.addon
 * @param {object} d.membership @param {object} d.store @param {object} d.startup @param {object} d.log
 * @param {boolean} d.isPackaged  "start with Windows" is only defaulted in an installed app
 */
function wireSession({ auth, sync, events, addon, membership, store, startup, log, isPackaged }) {
  const background = (fn, what) => Promise.resolve().then(fn).catch((err) => log.warn(`${what}: ${err.message}`));
  let wasSignedIn = null;
  let hadGuild = null;
  // "First sign-in": only a sign-in that happens while the app runs counts, so people who were already
  // signed in before this version keep the choice they made.
  let sawSignedOut = false;

  function defaultStartup(s) {
    if (!isPackaged || !sawSignedOut || !s.user || store.get().startupDefaulted) return;
    let on = false;
    if (startup && startup.supported) {
      try { on = Boolean(startup.set(true)); } catch (err) { log.warn(`Couldn't turn on "start with Windows": ${err.message}`); }
    }
    store.set({ startWithWindows: on, startupDefaulted: true });
    if (on) log.info('Guild Camp now starts with Windows, in the tray, so your guild stays in sync. Turn this off in Settings.');
  }

  const applyAuth = (s) => {
    const state = s || {};
    if (state.signedIn !== wasSignedIn) {
      const first = wasSignedIn === null;
      wasSignedIn = Boolean(state.signedIn);
      if (state.signedIn) {
        sync.start();
        events.start();
        // A fresh sign-in: look for game folders and install the addon now, not at the next hourly check.
        if (!first) background(() => addon.check(), 'Addon check failed');
      } else {
        sawSignedOut = true;
        sync.stop();
        events.stop();
        membership.stop({ forget: true });
      }
    }
    if (!state.signedIn) {
      hadGuild = null;
      return;
    }
    const inGuild = Boolean(state.guild);
    if (inGuild) {
      membership.stop();
      // Just joined (automatically, by invite or by setting up the guild): waiting uploads go now.
      if (hadGuild === false) sync.clearNoGuild();
    } else {
      membership.start();
    }
    hadGuild = inGuild;
    defaultStartup(state);
  };

  // An upload put the member into the guild, or the server still has no guild for them.
  sync.on('joined', (joined) => {
    membership.record(joinedResult(joined));
    background(() => auth.refresh(), "Couldn't load your profile");
  });
  sync.on('no-guild', (info) => {
    if (info && info.autoJoin) membership.record(info.autoJoin);
    else background(() => membership.kick(), 'Guild check failed');
  });

  auth.on('change', applyAuth);
  return applyAuth;
}

// ---------------------------------------------------------------------------------------------
// Electron bootstrap

function bootstrap() {
  const { app, dialog, shell, safeStorage, nativeTheme, session, Menu } = require('electron');
  const { createLog } = require('./log');
  const { createStore, normaliseServerUrl } = require('./store');
  const { createApi } = require('./api');
  const { createAuth, AUTH_PARTITION } = require('./auth');
  const wow = require('./wow');
  const { createSync } = require('./sync');
  const { createAddonManager } = require('./addon');
  const { createMembership } = require('./membership');
  const { createUpdater } = require('./updater');
  const { createPublisher } = require('./publisher');
  const { createEvents } = require('./events');
  const { createNotify } = require('./notify');
  const { createStartup } = require('./startup');
  const { createIpc, buildMethods, forwardEvents } = require('./ipc');
  const { registerScheme, registerAppProtocol, createMainWindow, showWindow, findIcon } = require('./window');
  const { createTray } = require('./tray');

  const args = parseArgs(process.argv.slice(1));
  const isPackaged = app.isPackaged;
  const devMode = !isPackaged || args.dev;
  const appDir = app.getAppPath();
  const version = app.getVersion();
  const smokeOut = path.resolve(args.smokeOut || path.join(appDir, 'dist', 'smoke'));

  // A separate user data folder keeps dev and smoke runs away from real settings and sign-ins.
  // Smoke runs get their own folder by default.
  const userDataOverride = args.userData || process.env.GUILDCAMP_USER_DATA || (args.smoke ? path.join(smokeOut, 'user-data') : null);
  if (userDataOverride) app.setPath('userData', path.resolve(userDataOverride));

  app.setAppUserModelId(APP_ID);
  registerScheme();

  if (!args.smoke && !app.requestSingleInstanceLock()) {
    // Another Guild Camp is running; it receives our arguments (and any join link) and shows itself.
    app.quit();
    return;
  }

  // Isolated runs (smoke, or a dev run with its own user data folder) leave join links alone so
  // they keep opening the normal install.
  if (!args.smoke && !(userDataOverride && !isPackaged)) {
    try {
      if (isPackaged) app.setAsDefaultProtocolClient(PROTOCOL);
      else app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(appDir)]);
    } catch { /* not fatal: join links just won't open the app */ }
  }

  // ---- state ---------------------------------------------------------------------------------
  let quitting = false;
  let mainWindow = null;
  let firstWindow = true;
  let tray = null;
  let rendererIsReady = false;
  let pendingRoute = deepLinkRoute(findDeepLink(process.argv));
  let services = null; // set once ready
  let onWindowShown = () => {}; // set in start(): re-reads the profile (throttled)
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
      services.log.info(route ? `Opened a join link (${route}).` : `Opened a ${PROTOCOL}:// link.`);
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
    // Opened from the tray or switched back to: pick up a role change made while it was away.
    mainWindow.on('show', () => onWindowShown());
    mainWindow.on('focus', () => onWindowShown());
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

  app.on('before-quit', () => {
    quitting = true;
    for (const t of timers) clearInterval(t);
    if (services) {
      try { services.sync.stop(); } catch { /* quitting anyway */ }
      try { services.events.stop(); } catch { /* quitting anyway */ }
      try { services.membership.stop(); } catch { /* quitting anyway */ }
    }
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

    const store = createStore(userData, {
      encrypt: (text) => safeStorage.encryptString(text),
      decrypt: (buf) => safeStorage.decryptString(buf),
      isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    });
    for (const problem of store.problems) log.warn(problem);

    // Smoke runs are for screenshots only: they must never read or change a real game install.
    // Default folder scanning is off (add fake folders with extraWowFolders in a scratch user data
    // folder, or pass --smoke-scan), and nothing installs, updates or syncs in the background.
    if (args.smoke) {
      if (!args.smokeScan) process.env.GUILDCAMP_NO_SCAN = '1';
      store.set({ addonAutoUpdate: false, addonAutoInstall: false, appAutoUpdate: false, syncEnabled: false, notifications: false });
    }

    if (process.env.GUILDCAMP_SERVER) {
      try {
        const url = normaliseServerUrl(process.env.GUILDCAMP_SERVER);
        if (url !== store.get().serverUrl) {
          // A token for the previous server is useless here.
          store.setSecret('deviceToken', null);
          store.setSecret('me', null);
          store.set({ serverUrl: url, lastEventId: 0 });
        }
        log.info(`Using server ${url} (from GUILDCAMP_SERVER).`);
      } catch (err) {
        log.warn(`Ignoring GUILDCAMP_SERVER: ${err.message}`);
      }
    }

    // Light/dark: the renderer's prefers-color-scheme follows the Theme setting.
    nativeTheme.themeSource = store.get().theme || 'system';
    store.on('change', (s, keys) => { if (keys.includes('theme')) nativeTheme.themeSource = s.theme || 'system'; });

    // Permissions: notifications and clipboard writes only; the sign-in window gets nothing.
    const allowed = new Set(['notifications', 'clipboard-sanitized-write', 'fullscreen']);
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed.has(permission)));
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));
    session.fromPartition(AUTH_PARTITION).setPermissionRequestHandler((_wc, _permission, cb) => cb(false));

    if (process.platform === 'darwin') {
      Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }]));
    } else {
      Menu.setApplicationMenu(null); // shortcuts are handled in window.js
    }

    const getServer = () => store.get().serverUrl;
    const getToken = () => store.getSecret('deviceToken');
    const api = createApi({ getServer, getToken, appVersion: version, log: log.scope('api') });
    const auth = createAuth({ store, api, log: log.scope('auth'), appVersion: version, getServer, getParentWindow: () => mainWindow });
    const sync = createSync({ api, store, log: log.scope('sync'), wow, appVersion: version });
    const resourcesDir = isPackaged ? process.resourcesPath : path.resolve(appDir, '..');
    const addon = createAddonManager({ store, log: log.scope('addon'), wow, api, resourcesDir, fetch: globalThis.fetch });
    const membership = createMembership({ api, wow, auth, log: log.scope('membership'), store });
    const updater = createUpdater({ store, log: log.scope('updater'), api, getServer, appVersion: version, isPackaged });
    const publisher = createPublisher({ store, log: log.scope('publisher'), auth, api, getServer, getToken, appVersion: version, isPackaged, appDir });
    const iconPath = findIcon();
    const notify = createNotify({ showWindow: () => showMain(), broadcast, iconPath, log: log.scope('notify') });
    const events = createEvents({ api, store, notify, broadcast, log: log.scope('events') });
    const startup = createStartup();

    services = { log, store, api, auth, wow, sync, addon, membership, updater, publisher, notify, events, startup, iconPath, ipc: null };

    if (!store.secretsEncrypted()) log.warn('Secure storage is not available. Your sign-in is saved without encryption.');

    const methods = buildMethods({
      store, log, auth, api, wow, sync, addon, updater, publisher, notify, startup, membership, shell, dialog,
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
        repoDir: store.get().repoDir || (isPackaged ? null : detectRepoDir(appDir)),
        server: getServer(),
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
    forwardEvents({ broadcast, store, log, auth, sync, addon, updater, publisher, membership });

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

    // Signed in → sync and the event feed run, and (without a guild) the guild is looked for;
    // signed out → they stop. See wireSession.
    const applyAuth = wireSession({ auth, sync, events, addon, membership, store, startup, log, isPackaged });
    applyAuth(auth.state()); // the token on disk says whether we are signed in
    auth.refresh().catch((err) => log.warn(`Couldn't load your profile: ${err.message}`));

    const background = (fn, what) => Promise.resolve().then(fn).catch((err) => log.warn(`${what}: ${err.message}`));

    // Role changes reach a running app: auth.refresh() re-reads GET /api/me and, when the role (or
    // anything else) changed, emits 'change' → the renderer's session (nav, officer pages) updates.
    const refreshProfile = () => {
      if (auth.state().signedIn) background(() => auth.refresh(), "Couldn't load your profile");
    };
    const refreshProfileSoon = throttle(refreshProfile, PROFILE_FOCUS_GAP_MS);
    refreshProfileSoon.mark(); // just refreshed above
    onWindowShown = refreshProfileSoon;
    timers.push(setInterval(() => { refreshProfile(); refreshProfileSoon.mark(); }, PROFILE_REFRESH_MS));

    background(() => addon.check(), 'Addon check failed');
    background(() => updater.check(), 'Update check failed');
    timers.push(setInterval(() => background(() => updater.check(), 'Update check failed'), UPDATE_CHECK_MS));
    timers.push(setInterval(() => background(() => addon.check(), 'Addon check failed'), ADDON_CHECK_MS));
    // A release published on the server shows up at once instead of at the next timer.
    events.on('event', (ev) => {
      if (ev && ev.kind === 'release') {
        background(() => updater.check(), 'Update check failed');
        background(() => addon.check(), 'Addon check failed');
      }
    });

    // Keep the login item pointing at the current install (the path can change between versions).
    if (isPackaged && store.get().startWithWindows && startup.supported) {
      try { startup.set(true); } catch (err) { log.warn(`Couldn't refresh "start with Windows": ${err.message}`); }
    }
  }

  // ---- smoke run -----------------------------------------------------------------------------
  async function runSmoke() {
    const { log, auth } = services;
    fs.mkdirSync(smokeOut, { recursive: true });
    const report = { app: version, startedAt: new Date().toISOString(), outDir: smokeOut, routes: [], errors: [], warnings: [] };
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
      app.exit(report.ok ? 0 : 1);
    };
    const hardStop = setTimeout(() => finish(`The smoke run took longer than ${SMOKE_TIMEOUT_MS / 1000} seconds and was stopped.`), SMOKE_TIMEOUT_MS);

    const wc = mainWindow.webContents;
    // Electron 45 passes one details object { level: 'info'|'warning'|'error'|'debug', message, lineNumber, sourceId }.
    // (A listener with more parameters triggers a deprecation warning, so take just the one.)
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

    const info = await Promise.race([smokeReady, delay(SMOKE_READY_WAIT_MS).then(() => null)]);
    if (!info) report.errors.push('The page never reported that it was ready (gc.app.rendererReady was not called).');

    if (args.smokeLogin) {
      try {
        const s = await auth.devSignIn(args.smokeLogin);
        report.signedInAs = s.user ? (s.user.battletag || s.user.name || s.user.id || null) : null;
        await delay(500);
      } catch (err) {
        report.errors.push(`Dev sign-in as ${args.smokeLogin} failed: ${err.message}`);
      }
    }

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

module.exports = { parseArgs, findDeepLink, deepLinkRoute, routeSlug, detectRepoDir, wireSession, throttle };
