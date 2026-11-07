'use strict';
// Sign-in, sign-out and the cached "who am I" state.
//
//   const auth = createAuth({ store, api, log, appVersion, getParentWindow });
//   await auth.signIn()                  // Battle.net in a modal window → device token
//   await auth.devSignIn('Name#1234')    // DEV_LOGIN servers only
//   await auth.signOut()
//   auth.state()                         // { signedIn, server, user, guild, role, device, notifyPrefs, offline, error }
//   await auth.refresh()                 // re-reads GET /api/me
//   auth.on('change', (state) => ...)
//
// The device token lives in store secrets ('deviceToken'); the last /api/me answer is cached in
// secrets too ('me') so the app can show who is signed in while the server is unreachable.
// Electron is required lazily so the pure helpers can be tested in plain Node.

const os = require('os');
const { EventEmitter } = require('events');

const DONE_PATH = '/auth/app/done';
const TOKEN_RE = /^gcd_[A-Za-z0-9_-]{8,256}$/;
const AUTH_PARTITION = 'persist:auth';

/**
 * Looks for the server's "sign-in finished" page: <server>/auth/app/done#token=gcd_…
 * Returns { token } or { error } when the URL is that page, otherwise null.
 */
function parseDoneUrl(url, server) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.pathname.replace(/\/+$/, '') !== DONE_PATH) return null;
  if (server) {
    try {
      if (new URL(server).origin !== u.origin) return null; // only trust the configured server
    } catch { return null; }
  }
  const params = new URLSearchParams((u.hash || '').replace(/^#/, ''));
  const token = params.get('token');
  if (token && TOKEN_RE.test(token)) return { token };
  const error = params.get('error') || new URLSearchParams(u.search).get('error');
  if (error) return { error: error.slice(0, 300) };
  return null;
}

function signInUrl(server, { device, platform, appVersion }) {
  const q = new URLSearchParams({ device: device || 'Guild Camp', platform: platform || process.platform, appVersion: appVersion || '0.0.0' });
  return `${String(server).replace(/\/+$/, '')}/auth/bnet?${q}`;
}

/**
 * @param {object} deps
 * @param {object} deps.store            createStore() result
 * @param {object} deps.api              createApi() result
 * @param {object} deps.log
 * @param {string} deps.appVersion
 * @param {() => string} [deps.getServer]  defaults to store.get().serverUrl
 * @param {() => object|null} [deps.getParentWindow] main BrowserWindow (the sign-in window is modal to it)
 * @param {string} [deps.hostname]       device name shown under Settings → Devices
 * @param {object} [deps.electron]       injected for tests: { BrowserWindow, session, shell }
 */
function createAuth({ store, api, log, appVersion, getServer, getParentWindow, hostname, electron } = {}) {
  const emitter = new EventEmitter();
  const server = () => (getServer ? getServer() : store.get().serverUrl);
  // Shown under Settings → Devices; the server accepts up to 60 characters.
  const device = String(hostname || os.hostname() || 'Guild Camp').slice(0, 60);
  const el = () => electron || require('electron');

  let me = readCachedMe();
  let offline = false;
  let error = null;
  let lastEmitted = null;
  let refreshing = null;
  let pendingSignIn = null;

  function readCachedMe() {
    try {
      const raw = store.getSecret('me');
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function setMe(value) {
    me = value && typeof value === 'object' ? value : null;
    try { store.setSecret('me', me ? JSON.stringify(me) : null); } catch (err) { log.warn(`Couldn't cache your profile: ${err.message}`); }
  }

  function state() {
    const signedIn = Boolean(store.getSecret('deviceToken'));
    const m = signedIn && me ? me : {};
    return {
      signedIn,
      server: server(),
      user: m.user || null,
      guild: m.guild || null,
      role: m.role || null,
      device: m.device || null,
      notifyPrefs: m.notifyPrefs || null,
      offline: signedIn && offline,
      error,
    };
  }

  function emitIfChanged() {
    const s = state();
    const key = JSON.stringify(s);
    if (key !== lastEmitted) {
      lastEmitted = key;
      emitter.emit('change', s);
    }
    return s;
  }

  function clearLocal(reason) {
    store.setSecret('deviceToken', null);
    setMe(null);
    offline = false;
    error = reason || null;
    return emitIfChanged();
  }

  // A 401 means the token was revoked (Settings → Devices) or expired. Only clear it if it is
  // still the token that failed: a sign-in may have stored a new one in the meantime.
  api.on('unauthorized', (info) => {
    const current = store.getSecret('deviceToken');
    if (!current || (info && info.token && info.token !== current)) return;
    log.warn('The server no longer accepts this device. Signed out.');
    clearLocal('Your sign-in has expired or was removed. Sign in again.');
  });

  async function refresh() {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      if (!store.getSecret('deviceToken')) {
        if (me) setMe(null);
        offline = false;
        return emitIfChanged();
      }
      try {
        const data = await api.request('GET', '/api/me');
        setMe(data);
        offline = false;
        error = null;
      } catch (err) {
        if (err.status === 401) {
          // handled by the 'unauthorized' listener
        } else if (err.status === 0) {
          offline = true;
          error = err.message;
        } else {
          error = err.message;
        }
      }
      return emitIfChanged();
    })();
    try {
      return await refreshing;
    } finally {
      refreshing = null;
    }
  }

  async function acceptToken(token) {
    store.setSecret('deviceToken', token);
    setMe(null);
    error = null;
    log.info('Signed in. This device is now linked to your account.');
    return refresh();
  }

  function signIn() {
    if (pendingSignIn) {
      try { pendingSignIn.win.focus(); } catch { /* window already gone */ }
      return pendingSignIn.promise;
    }
    const { BrowserWindow, shell } = el();
    const base = server();
    const url = signInUrl(base, { device, platform: process.platform, appVersion });
    const parent = getParentWindow ? getParentWindow() : null;
    const win = new BrowserWindow({
      parent: parent && !parent.isDestroyed() && parent.isVisible() ? parent : undefined,
      modal: Boolean(parent && !parent.isDestroyed() && parent.isVisible()),
      width: 520,
      height: 720,
      show: false,
      title: 'Sign in with Battle.net',
      backgroundColor: '#18222e',
      autoHideMenuBar: true,
      minimizable: false,
      maximizable: false,
      webPreferences: {
        partition: AUTH_PARTITION,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        spellcheck: false,
      },
    });
    win.setMenuBarVisibility(false);
    // Some sign-in pages refuse embedded browsers. Present as plain Chrome.
    try {
      win.webContents.setUserAgent(win.webContents.getUserAgent().replace(/\s(Electron|guild-camp|Guild Camp)\/\S+/gi, ''));
    } catch { /* keep the default agent */ }

    const promise = new Promise((resolve, reject) => {
      let settled = false;
      let accepting = false; // token received; closing the window no longer means "cancelled"
      // Destroy on the next tick: tearing a window down inside its own navigation event is unsafe.
      const close = () => setImmediate(() => { if (!win.isDestroyed()) win.destroy(); });
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        pendingSignIn = null;
        close();
        fn(value);
      };

      const check = (event, target) => {
        if (accepting || settled) return;
        const found = parseDoneUrl(target, base);
        if (!found) return;
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        if (found.token) {
          accepting = true;
          close();
          acceptToken(found.token).then((s) => finish(resolve, s), (err) => finish(reject, err));
        } else {
          finish(reject, Object.assign(new Error(`Sign-in failed: ${found.error}`), { status: 400 }));
        }
      };

      const wc = win.webContents;
      // Different Electron versions report the final redirect through different events, and the
      // fragment (#token=…) is only visible on some of them, so listen to all four.
      wc.on('will-redirect', (e, legacyUrl) => check(e, (e && e.url) || legacyUrl));
      wc.on('will-navigate', (e, legacyUrl) => check(e, (e && e.url) || legacyUrl));
      wc.on('did-navigate', (e, navUrl) => check(null, navUrl || wc.getURL()));
      wc.on('did-navigate-in-page', (e, navUrl) => check(null, navUrl || wc.getURL()));
      wc.on('did-finish-load', () => check(null, wc.getURL()));

      wc.on('did-fail-load', (e, code, description, failedUrl, isMainFrame) => {
        if (!isMainFrame || code === -3) return; // -3: navigation aborted (we cancel the done page ourselves)
        if (parseDoneUrl(failedUrl, base)) return;
        log.warn(`Sign-in page failed to load: ${description} (${code})`);
        finish(reject, Object.assign(new Error(`The sign-in page didn't load (${description}). Check your connection and the server address in Settings.`), { status: 0 }));
      });

      // Pop-ups from the Battle.net page (help links, etc.) open in the normal browser.
      wc.setWindowOpenHandler(({ url: target }) => {
        if (/^https?:\/\//i.test(target)) shell.openExternal(target).catch(() => {});
        return { action: 'deny' };
      });

      win.once('ready-to-show', () => { if (!win.isDestroyed()) win.show(); });
      win.on('closed', () => {
        if (!accepting) finish(reject, Object.assign(new Error('Sign-in was cancelled.'), { code: 'cancelled' }));
      });

      log.info(`Opening Battle.net sign-in via ${new URL(base).host}`);
      win.loadURL(url).catch((err) => {
        // loadURL rejects when we cancel the done-page navigation; did-fail-load covers real failures.
        if (!settled && !/ERR_ABORTED/.test(String(err && err.message))) log.warn(`Sign-in window: ${err.message}`);
      });
    });

    pendingSignIn = { win, promise };
    return promise;
  }

  async function devSignIn(battletag) {
    const tag = String(battletag == null ? '' : battletag).trim();
    if (!tag) throw new Error('Enter a BattleTag, like Name#1234.');
    if (tag.length > 64) throw new Error('That BattleTag is too long.');
    const res = await api.request('POST', '/api/auth/dev', {
      battletag: tag,
      device: { name: device, platform: process.platform, appVersion: appVersion || '0.0.0' },
    }, { auth: false });
    if (!res || typeof res.token !== 'string' || !TOKEN_RE.test(res.token)) {
      throw new Error("The server didn't send back a sign-in token.");
    }
    return acceptToken(res.token);
  }

  async function signOut() {
    if (store.getSecret('deviceToken')) {
      try {
        await api.request('POST', '/api/auth/signout', null, { timeout: 5000 });
      } catch {
        // Offline or already revoked: forgetting the token locally is what matters.
      }
    }
    // Forget the Battle.net cookies too, so the next sign-in can pick a different account.
    try {
      const { session } = el();
      if (session && typeof session.fromPartition === 'function') {
        await session.fromPartition(AUTH_PARTITION).clearStorageData();
      }
    } catch { /* not fatal */ }
    log.info('Signed out.');
    return clearLocal(null);
  }

  return Object.assign(emitter, { signIn, devSignIn, signOut, state, refresh, clearLocal });
}

module.exports = { createAuth, parseDoneUrl, signInUrl, AUTH_PARTITION, TOKEN_RE };
