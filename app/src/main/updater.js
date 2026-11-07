'use strict';
// App self-update. Installed builds use electron-updater's autoUpdater with the generic provider
// at <server>/updates/app (the server keeps latest.yml, the installer and its .blockmap there).
// Development builds (not packaged) never update themselves: they report state 'dev' and only
// look at GET /api/releases so the Updates page can say what the server has.
//
//   const updater = createUpdater({ store, log, api, getServer, appVersion, isPackaged });
//   updater.status(); await updater.check(); await updater.download(); updater.install()
//   events: 'status' (status)
//
// status() → { state, current, available: {version, notes, date}|null, latest, progress, error,
//              lastCheckAt, autoUpdate, isPackaged, note }
//   state: 'dev' | 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'
//
// No timers here: main.js checks on start, every 30 minutes, and when a 'release' event arrives.
// Quitting to install: electron-updater calls app.quit(), whose 'before-quit' event is where
// main.js marks the app as quitting (so close-to-tray lets the window close). An optional
// onBeforeInstall callback runs first for anything else that must happen before the installer.

const { EventEmitter } = require('events');
const version = require('../shared/version');

// Low-level network failures (Chromium net:: codes and Node error codes) → "offline".
const OFFLINE = /ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_NAME_RESOLUTION_FAILED|ERR_CONNECTION_(REFUSED|RESET|CLOSED|TIMED_OUT|FAILED|ABORTED)|ERR_ADDRESS_UNREACHABLE|ERR_NETWORK_(CHANGED|ACCESS_DENIED)|ERR_TIMED_OUT|ERR_PROXY_CONNECTION_FAILED|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|socket hang up/i;

const NOT_PUBLISHED = 'No app release has been published on this server yet.';
const DEV_NOTE = "This is a development build, so it doesn't update itself. Pull the latest code and restart it instead.";

/** releaseNotes from latest.yml: a string, or [{ version, note }] when several versions are skipped. */
function notesText(releaseNotes) {
  if (!releaseNotes) return '';
  if (typeof releaseNotes === 'string') return stripHtml(releaseNotes);
  if (Array.isArray(releaseNotes)) {
    return releaseNotes
      .map((n) => {
        if (!n) return '';
        if (typeof n === 'string') return stripHtml(n);
        const note = stripHtml(n.note || '');
        return n.version && note ? `${n.version}:\n${note}` : note;
      })
      .filter(Boolean)
      .join('\n\n');
  }
  return '';
}

// GitHub-style providers send HTML notes; ours are plain text, but be safe either way.
function stripHtml(text) {
  const s = String(text);
  if (!/<[a-z][^>]*>/i.test(s)) return s.trim();
  return s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|li|h\d)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Anything electron-updater (or fetch) throws → one plain sentence for the Updates page. */
function friendlyError(err, { during = 'check' } = {}) {
  const raw = String((err && (err.message || err.toString && err.toString())) || err || '');
  const code = String((err && err.code) || '');
  const status = Number((err && (err.statusCode || err.status)) || 0);
  const firstLine = raw.split(/\r?\n/)[0].trim();
  if (code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' || code === 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND' || code === 'ERR_UPDATER_NO_PUBLISHED_VERSIONS'
    || status === 404 || /\b404\b/.test(firstLine) || /Cannot find channel/i.test(raw)) {
    return during === 'download' ? 'The update file is missing on the server. Ask the guild owner to publish the app again.' : NOT_PUBLISHED;
  }
  if (OFFLINE.test(raw) || OFFLINE.test(code)) {
    return during === 'download'
      ? 'The download stopped because the guild server could not be reached. Check your internet connection and try again.'
      : "Couldn't reach the guild server to check for updates. Check your internet connection.";
  }
  if (/sha512 checksum mismatch|checksum mismatch/i.test(raw)) return 'The downloaded update was damaged. Try the download again.';
  if (code === 'ERR_UPDATER_INVALID_SIGNATURE' || /not signed by the application owner/i.test(raw)) {
    return "The update isn't signed the same way as this app, so it wasn't installed. Ask the guild owner about it.";
  }
  if (/ENOSPC/.test(raw) || code === 'ENOSPC') return "There isn't enough free disk space to download the update.";
  if (/EACCES|EPERM/.test(raw)) return "Guild Camp wasn't allowed to save the update. Try again, or reinstall the app from the server's download page.";
  if (status >= 500 || /\b50[0-4]\b/.test(firstLine)) return 'The guild server had a problem. Try again in a few minutes.';
  if (code === 'ERR_UPDATER_INVALID_UPDATE_INFO' || code === 'ERR_UPDATER_INVALID_VERSION') {
    return "The server's update information couldn't be read. Ask the guild owner to publish the app again.";
  }
  const detail = firstLine.replace(/^Error:\s*/, '').slice(0, 160);
  const what = during === 'download' ? 'download the update' : during === 'install' ? 'install the update' : 'check for updates';
  return detail ? `Couldn't ${what} (${detail}).` : `Couldn't ${what}.`;
}

function feedUrlFor(server) {
  const base = String(server || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) return null;
  return `${base}/updates/app`;
}

/**
 * @param {object} deps
 * @param {object} deps.store        createStore(): get() → settings, emits 'change' (settings, keys)
 * @param {object} deps.log          createLog() or a scope of it
 * @param {object} deps.api          createApi(): request() (dev builds read /api/releases)
 * @param {() => string} deps.getServer
 * @param {string} deps.appVersion   the running version
 * @param {boolean} deps.isPackaged
 * @param {object} [deps.autoUpdater]   injected for tests; defaults to require('electron-updater').autoUpdater
 * @param {() => void} [deps.onBeforeInstall] runs just before quitAndInstall
 */
function createUpdater({ store, log, api, getServer, appVersion, isPackaged, autoUpdater: injected, onBeforeInstall } = {}) {
  const emitter = new EventEmitter();
  const current = appVersion || '0.0.0';
  // main.js passes log.scope('updater'), so these lines are already tagged.
  const say = (level, msg) => { try { if (log && typeof log[level] === 'function') log[level](msg); } catch { /* never let logging break updates */ } };

  const settings = () => (store && typeof store.get === 'function' ? store.get() : {}) || {};
  const autoUpdate = () => settings().appAutoUpdate !== false;

  const s = {
    state: isPackaged ? 'idle' : 'dev',
    available: null,
    latest: null,
    progress: null,
    error: null,
    lastCheckAt: null,
  };
  let checking = null; // the check in flight
  let downloading = null; // the download in flight
  let updater = null; // electron-updater's autoUpdater, configured once
  let phase = 'check'; // what the updater is doing, for error wording
  // The server address can change while electron-updater is busy. serverGen counts the changes;
  // feedGen is serverGen when the feed URL was last set, so answers from an older feed are ignored.
  // staleDownload: a download from the old server is still running; when it finishes it is dropped
  // (never installed on quit) instead of being offered.
  let serverGen = 0;
  let feedGen = 0;
  let staleDownload = false;
  let feedCheck = null; // electron-updater's own check in flight (a second call gets this same promise back)

  function status() {
    return {
      state: s.state,
      current,
      available: s.available ? { ...s.available } : null,
      latest: s.latest ? { ...s.latest } : null,
      progress: s.progress ? { ...s.progress } : null,
      error: s.error,
      lastCheckAt: s.lastCheckAt,
      autoUpdate: autoUpdate(),
      isPackaged: Boolean(isPackaged),
      note: isPackaged ? null : DEV_NOTE,
    };
  }

  function set(patch) {
    Object.assign(s, patch);
    const out = status();
    emitter.emit('status', out);
    return out;
  }

  const infoOf = (info) => (info && info.version ? {
    version: String(info.version),
    notes: notesText(info.releaseNotes),
    date: info.releaseDate || null,
  } : null);

  // ---- electron-updater (installed builds) ------------------------------------------------------
  function getUpdater() {
    if (updater) return updater;
    // Required lazily: electron-updater needs Electron, and tests inject a fake instead.
    updater = injected || require('electron-updater').autoUpdater;
    updater.autoDownload = autoUpdate();
    updater.autoInstallOnAppQuit = true; // a downloaded update installs the next time the app quits
    updater.allowDowngrade = false;
    if (log) {
      updater.logger = {
        info: (m) => say('info', String(m)),
        warn: (m) => say('warn', String(m)),
        error: (m) => say('warn', String(m && m.message ? m.message : m).split(/\r?\n/)[0]),
        debug: () => {},
      };
    }

    updater.on('checking-for-update', () => {
      if (feedGen !== serverGen) return;
      phase = 'check';
      if (s.state !== 'checking' || s.error) set({ state: 'checking', error: null });
    });
    updater.on('update-available', (info) => {
      if (feedGen !== serverGen) {
        // The old server answered after the address changed. With automatic downloads electron-updater
        // fetches it anyway; that download must not be offered or installed.
        if (updater.autoDownload) staleDownload = true;
        return;
      }
      const available = infoOf(info);
      // With automatic updates on, electron-updater starts downloading straight away.
      set({ state: updater.autoDownload ? 'downloading' : 'available', available, latest: available, progress: null, error: null, lastCheckAt: new Date().toISOString() });
      if (updater.autoDownload) phase = 'download';
      say('info', `Guild Camp ${available ? available.version : '?'} is available${updater.autoDownload ? '; downloading it' : ''}.`);
    });
    updater.on('update-not-available', (info) => {
      if (feedGen !== serverGen) return;
      set({ state: 'not-available', available: null, latest: infoOf(info), progress: null, error: null, lastCheckAt: new Date().toISOString() });
    });
    updater.on('download-progress', (p) => {
      if (staleDownload) return;
      phase = 'download';
      const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
      set({
        state: 'downloading',
        error: null,
        progress: { percent: Math.max(0, Math.min(100, num(p && p.percent))), bytesPerSecond: num(p && p.bytesPerSecond), transferred: num(p && p.transferred), total: num(p && p.total) },
      });
    });
    updater.on('update-downloaded', (info) => {
      if (staleDownload) {
        staleDownload = false;
        // electron-updater adds its "install when the app quits" handler right after this event; with
        // this off it doesn't (or, if already added, it does nothing).
        updater.autoInstallOnAppQuit = false;
        say('info', `Dropped the update ${info && info.version ? `${info.version} ` : ''}downloaded from the previous server.`);
        // The new server's own update may have been waiting for that download to finish.
        if (s.state === 'downloading') {
          set({ state: s.available ? 'available' : 'idle', progress: null });
          if (s.available && autoUpdate()) {
            setTimeout(() => { download().catch((err) => say('warn', `Update download failed: ${err.message}`)); }, 0);
          }
        }
        return;
      }
      updater.autoInstallOnAppQuit = true; // a fresh download from this server installs when the app quits
      const available = infoOf(info) || s.available;
      set({ state: 'downloaded', available, progress: null, error: null });
      say('info', `Guild Camp ${available ? `${available.version} ` : ''}is downloaded. It installs when the app restarts.`);
    });
    updater.on('update-cancelled', () => {
      if (staleDownload) { staleDownload = false; return; }
      set({ state: s.available ? 'available' : 'idle', progress: null });
    });
    updater.on('error', (err) => {
      if (staleDownload && phase === 'download') { staleDownload = false; return; }
      if (feedGen !== serverGen && phase === 'check') return;
      const message = friendlyError(err, { during: phase });
      say('warn', `Update ${phase} failed: ${String((err && err.message) || err).split(/\r?\n/)[0]}`);
      const patch = { state: 'error', error: message, progress: null };
      if (phase === 'check') patch.lastCheckAt = new Date().toISOString();
      set(patch);
    });
    return updater;
  }

  // ---- dev builds -----------------------------------------------------------------------------
  async function devCheck() {
    set({ state: 'dev', error: null });
    try {
      const data = api ? await api.request('GET', '/api/releases', null, { auth: false, timeout: 15000 }) : null;
      const app = data && data.app && data.app.version ? data.app : null;
      const latest = app ? { version: String(app.version), notes: String(app.notes || ''), date: app.publishedAt || null } : null;
      return set({
        state: 'dev',
        latest,
        available: latest && version.gt(latest.version, current) ? latest : null,
        error: null,
        lastCheckAt: new Date().toISOString(),
      });
    } catch (err) {
      const message = err && err.status === 404 ? "This server doesn't publish app releases yet." : (err && err.message) || "Couldn't check the server for updates.";
      return set({ state: 'dev', error: message, lastCheckAt: new Date().toISOString() });
    }
  }

  // ---- public ---------------------------------------------------------------------------------

  /** Asks the server for a newer version. Resolves with the status (problems are in status.error). */
  function check() {
    if (!isPackaged) {
      if (!checking) checking = devCheck().finally(() => { checking = null; });
      return checking;
    }
    // A download in progress (or finished) is already the newest we know about.
    if (s.state === 'downloading' || s.state === 'downloaded') return Promise.resolve(status());
    if (checking) return checking;
    const run = (async () => {
      // A check of the previous server still running: let it finish first, or electron-updater would
      // hand back its answer instead of asking the new address.
      if (feedCheck) await feedCheck.catch(() => {});
      const feed = feedUrlFor(getServer && getServer());
      if (!feed) return set({ state: 'error', error: 'Set the guild server address in Settings first.', lastCheckAt: new Date().toISOString() });
      let u;
      try {
        u = getUpdater();
        u.autoDownload = autoUpdate();
        // Set every time: the server address can change in Settings.
        u.setFeedURL({ provider: 'generic', url: feed });
        feedGen = serverGen;
      } catch (err) {
        say('warn', `The updater could not start: ${err && err.message}`);
        return set({ state: 'error', error: friendlyError(err), lastCheckAt: new Date().toISOString() });
      }
      phase = 'check';
      if (s.state !== 'checking') set({ state: 'checking', error: null });
      try {
        const p = Promise.resolve(u.checkForUpdates());
        feedCheck = p;
        try { await p; } finally { if (feedCheck === p) feedCheck = null; }
      } catch (err) {
        // electron-updater also emits 'error' (handled above); make sure the state isn't stuck.
        if (s.state === 'checking') set({ state: 'error', error: friendlyError(err), lastCheckAt: new Date().toISOString() });
      }
      if (s.state === 'checking') set({ state: 'idle', lastCheckAt: new Date().toISOString() });
      return status();
    })();
    const done = run.finally(() => { if (checking === done) checking = null; });
    checking = done;
    return done;
  }

  /** Downloads the available update (when automatic updates are off). Resolves with the status. */
  async function download() {
    if (!isPackaged) throw new Error(DEV_NOTE);
    if (s.state === 'downloaded') return status();
    if (downloading) return downloading;
    if (!s.available) {
      await check();
      if (s.state === 'downloading' || s.state === 'downloaded') return status();
      if (!s.available) throw new Error(s.error || 'There is no update to download. You have the newest version.');
    }
    const u = getUpdater();
    phase = 'download';
    set({ state: 'downloading', error: null, progress: s.progress || null });
    downloading = (async () => {
      try {
        await u.downloadUpdate();
      } catch (err) {
        if (s.state === 'downloading') set({ state: 'error', error: friendlyError(err, { during: 'download' }), progress: null });
      }
      return status();
    })().finally(() => { downloading = null; });
    return downloading;
  }

  /** Quits and runs the downloaded installer; the app starts again when it is done. */
  function install() {
    if (!isPackaged) throw new Error(DEV_NOTE);
    if (s.state !== 'downloaded') throw new Error("There's no downloaded update to install yet.");
    const u = getUpdater();
    say('info', `Restarting to install Guild Camp${s.available ? ` ${s.available.version}` : ''}.`);
    try {
      if (typeof onBeforeInstall === 'function') onBeforeInstall();
    } catch (err) {
      say('warn', `Before installing: ${err && err.message}`);
    }
    phase = 'install';
    // Not silent (the installer shows its progress), and the app runs again afterwards.
    u.quitAndInstall(false, true);
    return true;
  }

  // Settings: automatic updates on/off, and a new server (whatever we knew is about the old one).
  if (store && typeof store.on === 'function') {
    store.on('change', (next, keys) => {
      const changed = Array.isArray(keys) ? keys : [];
      if (changed.includes('appAutoUpdate')) {
        const on = next && next.appAutoUpdate !== false;
        if (updater) updater.autoDownload = on;
        emitter.emit('status', status());
        // Switched on while an update waits: start downloading it now.
        if (on && isPackaged && s.state === 'available' && s.available) {
          download().catch((err) => say('warn', `Update download failed: ${err.message}`));
        }
      }
      if (changed.includes('serverUrl')) {
        // Whatever the old server offered, including an update that is downloading or downloaded and
        // waiting to install, came from somewhere the person no longer uses: forget it, and don't
        // install it when the app quits. The next check asks the new server.
        serverGen += 1;
        checking = null; // a check still asking the old server is not an answer for the new one
        if (s.state === 'downloading' || downloading) staleDownload = true;
        if (updater) updater.autoInstallOnAppQuit = false;
        if (s.state === 'downloaded' || s.state === 'downloading') say('info', 'The server changed, so the update from the previous server will not be installed.');
        set({ state: isPackaged ? 'idle' : 'dev', available: null, latest: null, progress: null, error: null, lastCheckAt: null });
      }
    });
  }

  return Object.assign(emitter, { status, check, download, install });
}

module.exports = { createUpdater, friendlyError, notesText, feedUrlFor, NOT_PUBLISHED };
