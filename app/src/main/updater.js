'use strict';
// App self-update from GitHub releases. Installed builds use electron-updater's autoUpdater with the
// github provider that electron-builder wrote into resources/app-update.yml (owner arrow-quiver,
// repo wow): it follows the release marked Latest, reads its latest.yml, and downloads the installer
// (only the changed blocks, thanks to the .blockmap). No feed URL is set here and no server is involved.
// Development builds (not packaged) never update themselves: they report state 'dev' and read the
// newest app release from the GitHub API (cached, see shared/release.js readReleaseFeed) so the Updates
// page can say what is out.
//
//   const updater = createUpdater({ store, log, appVersion, isPackaged });
//   updater.status(); await updater.check(); await updater.check({ force: true }); await updater.download(); updater.install()
//   events: 'status' (status)
//
// status() → { state, current, available: {version, notes, date}|null, latest, progress, error,
//              lastCheckAt, autoUpdate, isPackaged, note, releasesUrl }
//   state: 'dev' | 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'
//
// No timers here: main.js checks on start and every 30 minutes. check({ force: true }) is for the
// person pressing "Check for updates" (dev builds then skip the 30-minute cache).
// Quitting to install: electron-updater calls app.quit(), whose 'before-quit' event is where
// main.js marks the app as quitting (so close-to-tray lets the window close). An optional
// onBeforeInstall callback runs first for anything else that must happen before the installer.

const path = require('path');
const { EventEmitter } = require('events');
const version = require('../shared/version');
const release = require('../shared/release');

// Low-level network failures (Chromium net:: codes and Node error codes) → "offline".
const OFFLINE = /ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_NAME_RESOLUTION_FAILED|ERR_CONNECTION_(REFUSED|RESET|CLOSED|TIMED_OUT|FAILED|ABORTED)|ERR_ADDRESS_UNREACHABLE|ERR_NETWORK_(CHANGED|ACCESS_DENIED)|ERR_TIMED_OUT|ERR_PROXY_CONNECTION_FAILED|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|socket hang up/i;

const NOT_PUBLISHED = 'No app release has been published on GitHub yet.';
const DEV_NOTE = "This is a development build, so it doesn't update itself. Pull the latest code and restart it instead.";
const RELEASES_URL = release.releasesPage(release.GITHUB_REPO);
const LATEST_URL = `${RELEASES_URL}/latest`;

/** releaseNotes from latest.yml / the GitHub feed: a string, or [{ version, note }] when several versions are skipped. */
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

// The github provider sends release notes as HTML (GitHub renders the Markdown); show them as text.
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

/** Anything electron-updater throws → one plain sentence for the Updates page. */
function friendlyError(err, { during = 'check' } = {}) {
  const raw = String((err && (err.message || err.toString && err.toString())) || err || '');
  const code = String((err && err.code) || '');
  const status = Number((err && (err.statusCode || err.status)) || 0);
  const firstLine = raw.split(/\r?\n/)[0].trim();
  if (code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' || code === 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND' || code === 'ERR_UPDATER_NO_PUBLISHED_VERSIONS'
    || status === 404 || /\b404\b/.test(firstLine) || /Cannot find (channel|latest)/i.test(raw) || /No published versions/i.test(raw)) {
    return during === 'download' ? 'The update file is missing from the GitHub release. Try again later.' : NOT_PUBLISHED;
  }
  if (OFFLINE.test(raw) || OFFLINE.test(code)) {
    return during === 'download'
      ? 'The download stopped because GitHub could not be reached. Check your internet connection and try again.'
      : "Couldn't reach GitHub to check for updates. Check your internet connection.";
  }
  if (/sha512 checksum mismatch|checksum mismatch/i.test(raw)) return 'The downloaded update was damaged. Try the download again.';
  if (code === 'ERR_UPDATER_INVALID_SIGNATURE' || /not signed by the application owner/i.test(raw)) {
    return `The update isn't signed the same way as this app, so it wasn't installed. Download the newest installer from ${LATEST_URL} instead.`;
  }
  if (/ENOSPC/.test(raw) || code === 'ENOSPC') return "There isn't enough free disk space to download the update.";
  if (/EACCES|EPERM/.test(raw)) return `Guild Camp wasn't allowed to save the update. Try again, or download the newest installer from ${LATEST_URL}.`;
  if (status === 403 || status === 429 || /\b(403|429)\b/.test(firstLine) || /rate limit/i.test(raw)) {
    return 'GitHub is limiting requests from this computer right now. Guild Camp tries again later.';
  }
  if (status >= 500 || /\b50[0-4]\b/.test(firstLine)) return 'GitHub had a problem. Try again in a few minutes.';
  if (code === 'ERR_UPDATER_INVALID_UPDATE_INFO' || code === 'ERR_UPDATER_INVALID_VERSION' || code === 'ERR_UPDATER_INVALID_RELEASE_FEED') {
    return "The update information on GitHub couldn't be read. Try again later.";
  }
  const detail = firstLine.replace(/^Error:\s*/, '').slice(0, 160);
  const what = during === 'download' ? 'download the update' : during === 'install' ? 'install the update' : 'check for updates';
  return detail ? `Couldn't ${what} (${detail}).` : `Couldn't ${what}.`;
}

/**
 * @param {object} deps
 * @param {object} deps.store        createStore(): get() → settings, emits 'change' (settings, keys); .file locates the cache
 * @param {object} deps.log          createLog() or a scope of it
 * @param {string} deps.appVersion   the running version
 * @param {boolean} deps.isPackaged
 * @param {object} [deps.autoUpdater]   injected for tests; defaults to require('electron-updater').autoUpdater
 * @param {() => void} [deps.onBeforeInstall] runs just before quitAndInstall
 * @param {typeof fetch} [deps.fetch]   dev builds: reads the GitHub API (tests inject a fake)
 * @param {string} [deps.releasesUrl]   dev builds: the release list address (tests point it at a fake)
 * @param {string|null} [deps.feedFile] dev builds: the shared cache of the release list
 *                                       (default <userData>/github-releases.json, next to settings.json)
 */
function createUpdater({ store, log, appVersion, isPackaged, autoUpdater: injected, onBeforeInstall, fetch: fetchImpl, releasesUrl, feedFile } = {}) {
  const emitter = new EventEmitter();
  const current = appVersion || '0.0.0';
  // main.js passes log.scope('updater'), so these lines are already tagged.
  const say = (level, msg) => { try { if (log && typeof log[level] === 'function') log[level](msg); } catch { /* never let logging break updates */ } };

  const settings = () => (store && typeof store.get === 'function' ? store.get() : {}) || {};
  const autoUpdate = () => settings().appAutoUpdate !== false;
  const cacheFile = feedFile !== undefined ? feedFile : (store && store.file ? path.join(path.dirname(store.file), 'github-releases.json') : null);

  const s = {
    state: isPackaged ? 'idle' : 'dev',
    available: null,
    latest: null,
    progress: null,
    error: null,
    lastCheckAt: null,
    releasesUrl: LATEST_URL,
  };
  let checking = null; // the check in flight
  let downloading = null; // the download in flight
  let updater = null; // electron-updater's autoUpdater, configured once
  let phase = 'check'; // what the updater is doing, for error wording

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
      releasesUrl: s.releasesUrl,
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
    // Follow the release marked Latest (every app release is), never the newest entry of the feed:
    // the repo's addon releases (addon-v*) sit in the same list.
    updater.allowPrerelease = false;
    if (log) {
      updater.logger = {
        info: (m) => say('info', String(m)),
        warn: (m) => say('warn', String(m)),
        error: (m) => say('warn', String(m && m.message ? m.message : m).split(/\r?\n/)[0]),
        debug: () => {},
      };
    }

    updater.on('checking-for-update', () => {
      phase = 'check';
      if (s.state !== 'checking' || s.error) set({ state: 'checking', error: null });
    });
    updater.on('update-available', (info) => {
      const available = infoOf(info);
      // With automatic updates on, electron-updater starts downloading straight away.
      set({ state: updater.autoDownload ? 'downloading' : 'available', available, latest: available, progress: null, error: null, lastCheckAt: new Date().toISOString() });
      if (updater.autoDownload) phase = 'download';
      say('info', `Guild Camp ${available ? available.version : '?'} is available${updater.autoDownload ? '; downloading it' : ''}.`);
    });
    updater.on('update-not-available', (info) => {
      set({ state: 'not-available', available: null, latest: infoOf(info), progress: null, error: null, lastCheckAt: new Date().toISOString() });
    });
    updater.on('download-progress', (p) => {
      phase = 'download';
      const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
      set({
        state: 'downloading',
        error: null,
        progress: { percent: Math.max(0, Math.min(100, num(p && p.percent))), bytesPerSecond: num(p && p.bytesPerSecond), transferred: num(p && p.transferred), total: num(p && p.total) },
      });
    });
    updater.on('update-downloaded', (info) => {
      const available = infoOf(info) || s.available;
      set({ state: 'downloaded', available, progress: null, error: null });
      say('info', `Guild Camp ${available ? `${available.version} ` : ''}is downloaded. It installs when the app restarts.`);
    });
    updater.on('update-cancelled', () => {
      set({ state: s.available ? 'available' : 'idle', progress: null });
    });
    updater.on('error', (err) => {
      const message = friendlyError(err, { during: phase });
      say('warn', `Update ${phase} failed: ${String((err && err.message) || err).split(/\r?\n/)[0]}`);
      const patch = { state: 'error', error: message, progress: null };
      if (phase === 'check') patch.lastCheckAt = new Date().toISOString();
      set(patch);
    });
    return updater;
  }

  // ---- dev builds -----------------------------------------------------------------------------
  async function devCheck(force) {
    set({ state: 'dev', error: null });
    const feed = await release.readReleaseFeed({
      cacheFile, url: releasesUrl || release.releasesApiUrl(), fetch: fetchImpl, userAgent: `GuildCamp/${current}`, force,
    });
    const rel = feed.releases ? release.newestRelease(feed.releases, 'app') : null;
    const latest = rel ? { version: rel.version, notes: rel.notes, date: rel.publishedAt || null } : null;
    return set({
      state: 'dev',
      latest,
      available: latest && version.gt(latest.version, current) ? latest : null,
      error: feed.error,
      releasesUrl: (rel && rel.url) || LATEST_URL,
      lastCheckAt: new Date().toISOString(),
    });
  }

  // ---- public ---------------------------------------------------------------------------------

  /** Asks GitHub for a newer version. Resolves with the status (problems are in status.error). */
  function check(opts) {
    const force = Boolean(opts && typeof opts === 'object' && opts.force);
    if (!isPackaged) {
      if (!checking) checking = devCheck(force).catch((err) => set({ state: 'dev', error: (err && err.message) || "Couldn't check GitHub for updates.", lastCheckAt: new Date().toISOString() })).finally(() => { checking = null; });
      return checking;
    }
    // A download in progress (or finished) is already the newest we know about.
    if (s.state === 'downloading' || s.state === 'downloaded') return Promise.resolve(status());
    if (checking) return checking;
    const run = (async () => {
      let u;
      try {
        u = getUpdater();
        u.autoDownload = autoUpdate();
      } catch (err) {
        say('warn', `The updater could not start: ${err && err.message}`);
        return set({ state: 'error', error: friendlyError(err), lastCheckAt: new Date().toISOString() });
      }
      phase = 'check';
      if (s.state !== 'checking') set({ state: 'checking', error: null });
      try {
        await u.checkForUpdates();
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

  // Settings: automatic updates on/off.
  function onSettings(next, keys) {
    const changed = Array.isArray(keys) ? keys : [];
    if (!changed.includes('appAutoUpdate')) return;
    const on = next && next.appAutoUpdate !== false;
    if (updater) updater.autoDownload = on;
    emitter.emit('status', status());
    // Switched on while an update waits: start downloading it now.
    if (on && isPackaged && s.state === 'available' && s.available) {
      download().catch((err) => say('warn', `Update download failed: ${err.message}`));
    }
  }
  if (store && typeof store.on === 'function') store.on('change', onSettings);

  return Object.assign(emitter, {
    status,
    check,
    download,
    install,
    dispose() { if (store && typeof store.off === 'function') store.off('change', onSettings); },
  });
}

module.exports = { createUpdater, friendlyError, notesText, NOT_PUBLISHED, RELEASES_URL, LATEST_URL };
