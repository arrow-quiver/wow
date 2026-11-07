'use strict';
// Installs, updates, repairs and removes the WowGuild addon (listed in the game as "Guild Camp") in
// every World of Warcraft folder Guild Camp knows about.
//
//   const addon = createAddonManager({ store, log, wow, api, resourcesDir, fetch });
//   addon.status()            → { bundled, remote, latest, autoUpdate, autoInstall, supportedFlavors, checking,
//                                 lastCheckAt, error, installs }
//   await addon.check()       → asks the server for its newest addon, looks for game folders again, then
//                               - settings.addonAutoUpdate: updates outdated installs
//                               - settings.addonAutoInstall: installs the addon into game folders that don't have
//                                 it yet, but only for game versions the addon supports (from the bundled
//                                 WowGuild.toc "## Interface:" list, see flavorsForInterface) and never where the
//                                 person removed it (settings.addonOptOut, until they install it there again)
//   await addon.install(dir)  · update(dir) · repair(dir) · uninstall(dir) · updateAll()   → status
//   events: 'status' (status) after every change
//
// Where the addon comes from:
//   bundled  <resourcesDir>/addon/WowGuild, shipped inside the app (in dev, the repo's addon/WowGuild).
//   remote   GET /api/releases → addon { version, notes, publishedAt, sha256, size, url }. The zip is downloaded
//            from the server, checked against sha256 and cached as <userData>/addon-cache/WowGuild-<version>.zip.
// The higher version of the two is "latest"; on a tie the server's copy wins.
//
// Every change is atomic, so a failure never leaves a half-copied addon behind:
//   1. unpack into AddOns/.guildcamp-tmp-<random>/WowGuild and check that its WowGuild.toc has the right version
//   2. rename AddOns/WowGuild → AddOns/WowGuild.old-<timestamp>
//   3. rename the new folder to AddOns/WowGuild
//   4. delete the old folder and the temp folder
// If step 3 fails the old folder is put back. Windows keeps files locked while the game has them open, so renames
// are retried a few times before giving up with "Close World of Warcraft and try again". Leftovers from a crash
// (temp folders, an old folder without a new one) are tidied up or restored before the next change.
//
// Only AddOns/WowGuild is ever replaced, and only WowGuild + WowGuild_Inbox are ever removed (after checking their
// .toc says they are ours). Other addons are never touched. WowGuild_Inbox itself is written by sync.js.
//
// Plain Node (no Electron): everything outside is injected so tests can run against temp folders.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const version = require('../shared/version');
const toc = require('../shared/toc');
const zip = require('../shared/zip');
const { sha256 } = require('../shared/hash');
const release = require('../shared/release');

const fsp = fs.promises;

const ADDON = 'WowGuild';
const INBOX = 'WowGuild_Inbox';
const TMP_PREFIX = '.guildcamp-tmp-';
const OLD_MARK = '.old-'; // WowGuild.old-<ts>: the previous version while a new one moves in
const REMOVED_MARK = '.removed-'; // WowGuild.removed-<ts>: an uninstalled folder waiting to be deleted
const MAX_DOWNLOAD = 50 * 1024 * 1024;
const RELEASES_TIMEOUT = 15000;
const DOWNLOAD_TIMEOUT = 2 * 60 * 1000;
const INSTALLS_TTL = 3000; // how long a scan of the game folders is reused by status()
const CACHE_KEEP = 3; // cached addon zips kept on disk
// Waits between rename attempts while Windows holds a lock (about 5.5 seconds in all).
const RETRY_DELAYS = [150, 300, 600, 1000, 1500, 2000];
// Error codes Windows (and POSIX) give when a file or folder is in use or briefly locked.
const LOCK_CODES = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY', 'EEXIST']);
const PERMISSION_CODES = new Set(['EPERM', 'EACCES', 'EROFS']);
// Titles our .toc files have used: "Guild Camp" (addon), "Guild Camp news" (inbox), "WowGuild" (early builds).
const OUR_TITLE = /^(guild camp|wowguild)\b/i;
const INBOX_TITLE = /^guild camp\b/i;

const ACTION_WORDS = {
  install: { doing: 'Installing', done: 'installed', fail: 'install' },
  update: { doing: 'Updating', done: 'updated', fail: 'update' },
  repair: { doing: 'Repairing', done: 'repaired', fail: 'repair' },
  uninstall: { doing: 'Removing', done: 'removed', fail: 'remove' },
};

class AddonError extends Error {
  constructor(message, code, status) {
    super(message);
    this.name = 'AddonError';
    if (code) this.code = code;
    if (status) this.status = status;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------------------------
// Pure helpers (exported for tests)

/** Removes WoW colour codes ("|cffeaa93aGuild|r Camp") from a .toc title. */
function cleanTitle(title) {
  return String(title || '').replace(/\|c[0-9a-f]{8}/gi, '').replace(/\|r/gi, '').trim();
}

/**
 * Game flavor folders an addon supports, from its .toc "## Interface:" value ("16001, 120105").
 *   16000–16999 → _forever_ · 100000 and up → _retail_ · 11000–11999 → _classic_era_ · anything else is ignored.
 * → ['_forever_', '_retail_']
 */
function flavorsForInterface(value) {
  const out = [];
  for (const part of String(value == null ? '' : value).split(/[\s,]+/)) {
    if (!/^\d{1,7}$/.test(part)) continue;
    const n = Number(part);
    let flavor = null;
    if (n >= 16000 && n < 17000) flavor = '_forever_';
    else if (n >= 100000) flavor = '_retail_';
    else if (n >= 11000 && n < 12000) flavor = '_classic_era_';
    if (flavor && !out.includes(flavor)) out.push(flavor);
  }
  return out;
}

/** The newer of the bundled and the server's addon; the server wins a tie. → { version, source } | null */
function pickLatest(bundled, remote) {
  const b = bundled && version.valid(bundled.version) ? bundled : null;
  const r = remote && version.valid(remote.version) ? remote : null;
  if (r && (!b || version.compare(r.version, b.version) >= 0)) return { version: r.version, source: 'remote' };
  if (b) return { version: b.version, source: 'bundled' };
  return null;
}

/**
 * missing | outdated | current | newer, from the installed addon ({ version } or null) and latest.
 * An install whose .toc has no readable version counts as outdated, so updating repairs it.
 */
function computeState(installed, latest) {
  if (!installed) return 'missing';
  if (!latest || !latest.version) return 'current';
  if (!installed.version) return 'outdated';
  const c = version.compare(installed.version, latest.version);
  return c < 0 ? 'outdated' : c > 0 ? 'newer' : 'current';
}

/** The addon entry of GET /api/releases, cleaned up. → { version, notes, publishedAt, sha256, size, url } | null */
function normalizeRemote(raw) {
  if (!raw || typeof raw !== 'object' || !version.valid(raw.version)) return null;
  const size = Number(raw.size);
  return {
    version: String(raw.version).trim(),
    notes: typeof raw.notes === 'string' ? raw.notes : '',
    publishedAt: raw.publishedAt || raw.published_at || raw.created_at || null,
    sha256: typeof raw.sha256 === 'string' ? raw.sha256.trim().toLowerCase() : null,
    size: Number.isFinite(size) && size > 0 ? size : null,
    url: typeof raw.url === 'string' ? raw.url.trim() : null,
  };
}

/** Reads a folder's .toc. → { version: string|null, title, text } | null when there is no .toc. */
function readAddonToc(folder, name) {
  let text;
  try {
    text = fs.readFileSync(path.join(folder, `${name}.toc`), 'utf8');
  } catch {
    return null;
  }
  const v = toc.tocVersion(text);
  return { version: version.valid(v) ? v : null, title: cleanTitle(toc.tocField(text, 'Title')), text };
}

/** True when AddOns/<folder> is a Guild Camp addon folder (its .toc title says so). */
function looksLikeOurs(folder, name = path.basename(folder)) {
  const info = readAddonToc(folder, name);
  if (!info) return false;
  return name === INBOX ? INBOX_TITLE.test(info.title) : OUR_TITLE.test(info.title);
}

function samePath(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const ra = path.resolve(a);
  const rb = path.resolve(b);
  return process.platform === 'win32' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}

const pathKey = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));

function exists(p) {
  try { fs.statSync(p); return true; } catch { return false; }
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return 'the server'; }
}

// Plain wording for a failed download (fetch wraps the real reason in err.cause).
function networkReason(err) {
  if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) return 'it took too long';
  const code = (err && err.cause && err.cause.code) || (err && err.code) || '';
  const words = { ENOTFOUND: 'address not found', ECONNREFUSED: 'connection refused', ECONNRESET: 'connection dropped', ETIMEDOUT: 'connection timed out', ENETUNREACH: 'no network' };
  return words[code] || code || (err && err.message) || 'unknown error';
}

// ---------------------------------------------------------------------------------------------

/**
 * @param {object} deps
 * @param {object} deps.store         settings store (get, on 'change', file)
 * @param {object} [deps.log]         logger (info/warn/error), already scoped to "addon" by main.js
 * @param {object} deps.wow           { findInstalls({ extraRoots, scanDefaults }) }
 * @param {object} deps.api           { request(method, path, body, opts) }
 * @param {string} [deps.resourcesDir] folder that holds addon/WowGuild
 * @param {typeof fetch} [deps.fetch] used for the zip download
 * @param {string} [deps.cacheDir]    default <folder of settings.json>/addon-cache
 * @param {() => string} [deps.getServer] default settings.serverUrl
 * @param {boolean} [deps.scanDefaults=true] passed to wow.findInstalls
 * @param {number[]} [deps.retryDelays] waits between rename attempts (tests shorten them)
 * @param {number} [deps.downloadTimeout]
 * @param {object} [deps.fsOps]       { rename(from, to), rm(path) } overrides (tests inject failures)
 */
function createAddonManager({
  store, log: logger, wow, api, resourcesDir, fetch: fetchImpl, cacheDir, getServer, scanDefaults = true,
  retryDelays = RETRY_DELAYS, downloadTimeout = DOWNLOAD_TIMEOUT, fsOps = {},
} = {}) {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(50);
  const noop = () => {};
  const log = logger || { info: noop, warn: noop, error: noop };
  const doFetch = fetchImpl || globalThis.fetch;
  const bundledDir = resourcesDir ? path.join(resourcesDir, 'addon', ADDON) : null;
  const cacheFolder = cacheDir || (store && store.file ? path.join(path.dirname(store.file), 'addon-cache') : null);
  const ops = {
    rename: fsOps.rename || ((from, to) => fsp.rename(from, to)),
    rm: fsOps.rm || ((p) => fsp.rm(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })),
  };

  let remote = null; // normalizeRemote() of the server's addon
  let remoteError = null; // why the last server check failed
  let lastCheckAt = null;
  let checkPromise = null;
  let scan = { list: [], at: 0 };
  let bundledWarned = false;
  const busy = new Map(); // pathKey(dir) → action
  const errors = new Map(); // pathKey(dir) → message of the last failed action
  const downloads = new Map(); // version → Promise<Buffer>
  const tidying = new Map(); // pathKey(dir) → Promise of a background tidy() started by check()

  const settings = () => (store ? store.get() : {});
  const autoUpdateOn = () => settings().addonAutoUpdate !== false;
  const autoInstallOn = () => settings().addonAutoInstall !== false;
  const serverBase = () => String((getServer ? getServer() : settings().serverUrl) || '').trim().replace(/\/+$/, '');

  // ---- what is where ------------------------------------------------------------------------

  function bundled() {
    if (!bundledDir) return null;
    const info = readAddonToc(bundledDir, ADDON);
    if (!info) return null;
    if (!info.version) {
      if (!bundledWarned) log.warn(`The addon that came with Guild Camp has no valid version in ${path.join(bundledDir, `${ADDON}.toc`)}.`);
      bundledWarned = true;
      return null;
    }
    return { version: info.version };
  }

  /** Game flavors the addon is made for, from the bundled WowGuild.toc. [] when it can't be read. */
  function supportedFlavors() {
    const info = bundledDir ? readAddonToc(bundledDir, ADDON) : null;
    return info ? flavorsForInterface(toc.tocField(info.text, 'Interface')) : [];
  }

  const isSupported = (inst, flavors) => Boolean(inst.flavor && flavors.includes(String(inst.flavor).toLowerCase()));

  // Game folders where the person removed the addon (settings.addonOptOut): no automatic installs there.
  function optedOut() {
    const list = settings().addonOptOut;
    return new Set((Array.isArray(list) ? list : []).filter((d) => typeof d === 'string' && d).map(pathKey));
  }

  function setOptOut(dir, out) {
    if (!store || typeof store.set !== 'function') return;
    const list = (Array.isArray(settings().addonOptOut) ? settings().addonOptOut : []).filter((d) => typeof d === 'string' && d);
    const has = list.some((d) => samePath(d, dir));
    if (out && !has) store.set({ addonOptOut: [...list, dir].slice(-50) });
    else if (!out && has) store.set({ addonOptOut: list.filter((d) => !samePath(d, dir)) });
  }

  function latest() {
    return pickLatest(bundled(), remote);
  }

  function setScan(found) {
    const list = Array.isArray(found) ? found.filter((i) => i && typeof i.dir === 'string' && typeof i.addonsDir === 'string') : [];
    scan = { list, at: Date.now() };
    return list;
  }

  // wow.findInstalls is synchronous today; a Promise is accepted too (status() then uses the last scan).
  function scanInstalls(force = false) {
    if (!force && Date.now() - scan.at < INSTALLS_TTL) return scan.list;
    if (!wow || typeof wow.findInstalls !== 'function') return setScan([]);
    let found;
    try {
      found = wow.findInstalls({ extraRoots: settings().extraWowFolders || [], scanDefaults });
    } catch (err) {
      log.warn(`Couldn't look for game folders: ${err.message}`);
      return setScan([]);
    }
    if (found && typeof found.then === 'function') {
      scan.at = Date.now(); // don't start another scan while this one runs
      found.then((list) => { setScan(list); emitStatus(); }, (err) => log.warn(`Couldn't look for game folders: ${err.message}`));
      return scan.list;
    }
    return setScan(found);
  }

  async function freshInstalls() {
    if (!wow || typeof wow.findInstalls !== 'function') return setScan([]);
    try {
      return setScan(await wow.findInstalls({ extraRoots: settings().extraWowFolders || [], scanDefaults }));
    } catch (err) {
      log.warn(`Couldn't look for game folders: ${err.message}`);
      return scan.list;
    }
  }

  function installed(addonsDir) {
    const folder = path.join(addonsDir, ADDON);
    const info = readAddonToc(folder, ADDON);
    if (info) return { version: info.version };
    // A WowGuild folder without its .toc is a broken copy: report it so Repair can fix it.
    try { if (fs.statSync(folder).isDirectory()) return { version: null }; } catch { /* not there */ }
    return null;
  }

  function status() {
    const b = bundled();
    const lat = pickLatest(b, remote);
    const flavors = supportedFlavors();
    const optOut = optedOut();
    return {
      bundled: b,
      remote: remote ? { version: remote.version, notes: remote.notes, publishedAt: remote.publishedAt, size: remote.size } : null,
      latest: lat,
      autoUpdate: autoUpdateOn(),
      autoInstall: autoInstallOn(),
      supportedFlavors: flavors,
      checking: Boolean(checkPromise),
      lastCheckAt,
      error: remoteError,
      installs: scanInstalls().map((inst) => {
        const have = installed(inst.addonsDir);
        const key = pathKey(inst.dir);
        return {
          dir: inst.dir,
          root: inst.root || null,
          flavor: inst.flavor || null,
          label: inst.label || inst.flavor || path.basename(inst.dir),
          addonsDir: inst.addonsDir,
          installed: have,
          state: computeState(have, lat),
          damaged: Boolean(have && !have.version),
          supported: isSupported(inst, flavors),
          optedOut: optOut.has(key),
          busy: busy.has(key),
          action: busy.get(key) || null,
          error: errors.get(key) || null,
        };
      }),
    };
  }

  function emitStatus() {
    try {
      emitter.emit('status', status());
    } catch (err) {
      log.error('Sending the addon status failed:', err);
    }
  }

  async function findInstall(dir) {
    if (typeof dir !== 'string' || !dir.trim()) throw new AddonError('Pick a game folder first.', 'not-found', 400);
    const list = await freshInstalls();
    const inst = list.find((i) => samePath(i.dir, dir));
    if (!inst) throw new AddonError("That game folder isn't in the list any more. Check for updates to look again.", 'not-found', 404);
    return inst;
  }

  const labelOf = (inst) => inst.label || inst.flavor || path.basename(inst.dir);

  // ---- server release + download ------------------------------------------------------------

  async function refreshRemote() {
    if (!api || typeof api.request !== 'function') return;
    try {
      const data = await api.request('GET', '/api/releases', null, { auth: false, timeout: RELEASES_TIMEOUT });
      const next = normalizeRemote(data && data.addon);
      if (next && (!remote || remote.version !== next.version)) log.info(`The server has addon ${next.version}.`);
      remote = next;
      remoteError = null;
    } catch (err) {
      remoteError = err && err.message ? err.message : "Couldn't reach the server.";
      log.warn(`Couldn't check the server for addon updates: ${remoteError}`);
    }
  }

  function downloadUrl(u) {
    if (typeof u === 'string' && /^https?:\/\//i.test(u)) return u;
    if (typeof u === 'string' && u.startsWith('/') && !u.startsWith('//')) {
      const base = serverBase();
      if (base) return base + u;
    }
    throw new AddonError("The server didn't say where to download the addon from. Try again later.", 'bad-package');
  }

  function cacheFile(v) {
    return cacheFolder ? path.join(cacheFolder, `${ADDON}-${v}.zip`) : null;
  }

  async function readCache(v, want) {
    const file = cacheFile(v);
    if (!file) return null;
    let buf;
    try { buf = await fsp.readFile(file); } catch { return null; }
    if (sha256(buf) === want) return buf;
    await fsp.rm(file, { force: true }).catch(noop); // stale or damaged: download again
    return null;
  }

  async function writeCache(v, buf) {
    const file = cacheFile(v);
    if (!file) return;
    try {
      await fsp.mkdir(cacheFolder, { recursive: true });
      const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
      await fsp.writeFile(tmp, buf);
      await fsp.rename(tmp, file);
      // Keep the newest few zips; older ones are only taking space.
      const names = (await fsp.readdir(cacheFolder)).filter((n) => n.startsWith(`${ADDON}-`) && n.endsWith('.zip'));
      const dated = await Promise.all(names.map(async (n) => ({ n, t: (await fsp.stat(path.join(cacheFolder, n)).catch(() => ({ mtimeMs: 0 }))).mtimeMs })));
      dated.sort((a, b) => b.t - a.t);
      for (const old of dated.slice(CACHE_KEEP)) {
        if (old.n !== path.basename(file)) await fsp.rm(path.join(cacheFolder, old.n), { force: true }).catch(noop);
      }
    } catch (err) {
      log.warn(`Couldn't save the addon download for later: ${err.message}`);
    }
  }

  async function download(rel) {
    const v = rel.version;
    const want = rel.sha256;
    if (!want || !/^[0-9a-f]{64}$/.test(want)) {
      throw new AddonError(`The server didn't publish a checksum for addon ${v}, so Guild Camp can't check the download. Ask the guild owner to publish the addon again.`, 'bad-package');
    }
    const cached = await readCache(v, want);
    if (cached) {
      log.info(`Using the saved download of addon ${v}.`);
      return cached;
    }
    const url = downloadUrl(rel.url);
    log.info(`Downloading addon ${v} from ${hostOf(url)}.`);
    let res;
    try {
      res = await doFetch(url, { signal: AbortSignal.timeout(downloadTimeout), headers: { Accept: 'application/zip, application/octet-stream' } });
    } catch (err) {
      throw new AddonError(`Couldn't download addon ${v} (${networkReason(err)}). Check your internet connection and try again.`, 'download');
    }
    if (!res.ok) throw new AddonError(`The server couldn't send addon ${v} (it answered ${res.status}). Try again later.`, 'download');
    const length = Number(res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-length') : 0);
    if (length > MAX_DOWNLOAD) throw new AddonError(`The addon download is far too large (${Math.round(length / 1048576)} MB), so it wasn't installed.`, 'bad-package');
    let buf;
    try {
      buf = Buffer.from(await res.arrayBuffer());
    } catch (err) {
      throw new AddonError(`The download of addon ${v} was cut off (${networkReason(err)}). Try again.`, 'download');
    }
    if (buf.length > MAX_DOWNLOAD) throw new AddonError('The addon download is far too large, so it wasn\'t installed.', 'bad-package');
    const got = sha256(buf);
    if (got !== want) {
      log.warn(`Addon ${v} download checksum ${got} doesn't match the published ${want}.`);
      throw new AddonError(`The download of addon ${v} didn't match the checksum the server published, so it wasn't installed. Your current addon was left as it was. Try again in a few minutes.`, 'checksum');
    }
    await writeCache(v, buf);
    return buf;
  }

  async function remotePackage(rel) {
    // Two folders updating at once share one download.
    if (!downloads.has(rel.version)) {
      const p = download(rel).finally(() => downloads.delete(rel.version));
      downloads.set(rel.version, p);
    }
    return { version: rel.version, zip: await downloads.get(rel.version), source: 'remote' };
  }

  function bundledPackage() {
    try {
      const pack = release.packAddon(bundledDir);
      return { version: pack.version, zip: pack.zip, source: 'bundled' };
    } catch (err) {
      throw new AddonError(`The addon that came with Guild Camp couldn't be read (${err.message}). Reinstall Guild Camp.`, 'bad-package');
    }
  }

  // The zip for the latest addon. When the server's copy can't be fetched (offline, server down, a broken release
  // entry), the copy that came with the app is used instead if it is still an improvement. A checksum mismatch never
  // falls back: that download may have been tampered with, and the user should see it.
  async function packageFor(target, current, rel) {
    if (target.source !== 'remote') return bundledPackage();
    try {
      return await remotePackage(rel);
    } catch (err) {
      const b = bundled();
      if (err.code === 'checksum' || !b || (current && current.version && !version.gt(b.version, current.version))) throw err;
      log.warn(`${err.message} Installing the addon that came with Guild Camp (${b.version}) instead.`);
      return bundledPackage();
    }
  }

  // ---- file work ----------------------------------------------------------------------------

  async function retry(fn) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (attempt >= retryDelays.length || !LOCK_CODES.has(err && err.code)) throw err;
        await sleep(retryDelays[attempt]);
      }
    }
  }

  // Only called once the retries are used up. When the game is known not to be running, something else holds the
  // files (a File Explorer window, an antivirus scan), and telling people to close the game would only confuse them.
  async function inUse(err, inst, verb) {
    if (err instanceof AddonError) return err;
    if (err && LOCK_CODES.has(err.code)) {
      let running = null;
      if (wow && typeof wow.isWowRunning === 'function') {
        try { running = await wow.isWowRunning(); } catch { running = null; }
      }
      const fix = running === false
        ? 'Another program has them open. Close any File Explorer window showing the AddOns folder, wait a moment and try again.'
        : 'Close World of Warcraft and try again.';
      return new AddonError(`Couldn't ${verb} the addon in ${labelOf(inst)} because its files are in use. ${fix}`, 'in-use');
    }
    return new AddonError(`Couldn't ${verb} the addon in ${labelOf(inst)}: ${(err && err.message) || err}`, 'failed');
  }

  function writeProblem(err, inst) {
    if (err instanceof AddonError) return err;
    if (err && err.code && /^ZIP_/.test(err.code)) return new AddonError(`The addon package is damaged (${err.message}). Nothing was changed.`, 'bad-package');
    if (err && PERMISSION_CODES.has(err.code)) {
      return new AddonError(`Guild Camp isn't allowed to write to ${inst.addonsDir}. Make sure your Windows account can change files in the game folder, then try again.`, 'no-permission');
    }
    if (err && err.code === 'ENOSPC') return new AddonError('The disk is full, so the addon could not be installed. Free some space and try again.', 'disk-full');
    return new AddonError(`Couldn't unpack the addon into ${inst.addonsDir}: ${(err && err.message) || err}`, 'failed');
  }

  // Finishes or undoes whatever an interrupted change left in AddOns: a WowGuild.old-* without a WowGuild folder is
  // the previous version and goes back; everything else of ours (.guildcamp-tmp-*, *.old-*, *.removed-*) is deleted.
  async function tidy(addonsDir) {
    let names;
    try { names = await fsp.readdir(addonsDir); } catch { return; }
    const olds = names.filter((n) => n.startsWith(`${ADDON}${OLD_MARK}`)).sort();
    if (olds.length && !exists(path.join(addonsDir, ADDON))) {
      const newest = olds.pop();
      try {
        await retry(() => ops.rename(path.join(addonsDir, newest), path.join(addonsDir, ADDON)));
        log.warn(`Put back the previous addon in ${addonsDir} (a change was interrupted).`);
      } catch (err) {
        log.warn(`Couldn't put back the previous addon from ${newest}: ${err.message}`);
        olds.push(newest); // keep it: deleting it would lose the only copy
        return;
      }
    }
    const junk = names.filter((n) => n.startsWith(TMP_PREFIX)
      || n.startsWith(`${ADDON}${REMOVED_MARK}`) || n.startsWith(`${INBOX}${REMOVED_MARK}`)).concat(olds);
    for (const n of junk) {
      await ops.rm(path.join(addonsDir, n)).catch((err) => log.warn(`Couldn't delete the leftover folder ${path.join(addonsDir, n)}: ${err.message}`));
    }
  }

  async function swapIn(inst, pkg) {
    const { addonsDir } = inst;
    const target = path.join(addonsDir, ADDON);
    const tmp = path.join(addonsDir, `${TMP_PREFIX}${crypto.randomBytes(4).toString('hex')}`);
    let old = null;
    try {
      try {
        await fsp.mkdir(addonsDir, { recursive: true });
        zip.extractZip(pkg.zip, tmp);
      } catch (err) {
        throw writeProblem(err, inst);
      }
      const fresh = path.join(tmp, ADDON);
      const info = readAddonToc(fresh, ADDON);
      if (!info) throw new AddonError(`The addon package has no ${ADDON}/${ADDON}.toc, so it wasn't installed. Nothing was changed.`, 'bad-package');
      if (info.version !== pkg.version) {
        throw new AddonError(`The addon package says it is version ${info.version || 'unknown'}, but ${pkg.version} was expected. Nothing was changed.`, 'bad-package');
      }

      if (exists(target)) {
        old = path.join(addonsDir, `${ADDON}${OLD_MARK}${Date.now()}`);
        try {
          await retry(() => ops.rename(target, old));
        } catch (err) {
          old = null; // still in place, nothing to undo
          throw await inUse(err, inst, 'replace');
        }
      }
      try {
        await retry(() => ops.rename(fresh, target));
      } catch (err) {
        if (old) {
          try {
            await retry(() => ops.rename(old, target));
            old = null;
          } catch (restoreErr) {
            // The previous version stays as WowGuild.old-*; tidy() puts it back before the next change.
            log.error(`Couldn't put the previous addon back in ${addonsDir}: ${restoreErr.message}`);
          }
        }
        throw await inUse(err, inst, 'replace');
      }
      if (old) {
        await ops.rm(old).catch((err) => log.warn(`Couldn't delete the previous addon folder ${old}: ${err.message}. It will be removed later.`));
        old = null;
      }
    } finally {
      await ops.rm(tmp).catch(noop);
    }
    const now = installed(addonsDir);
    if (!now || now.version !== pkg.version) {
      throw new AddonError(`The addon in ${labelOf(inst)} still reports version ${(now && now.version) || 'none'} after installing ${pkg.version}. Close World of Warcraft and try again.`, 'failed');
    }
  }

  async function removeFolder(inst, name) {
    const folder = path.join(inst.addonsDir, name);
    const gone = path.join(inst.addonsDir, `${name}${REMOVED_MARK}${Date.now()}`);
    try {
      await retry(() => ops.rename(folder, gone));
    } catch (err) {
      throw await inUse(err, inst, 'remove');
    }
    // Renamed away, the game no longer loads it. Deleting can fail on a locked file; tidy() finishes it later.
    await ops.rm(gone).catch((err) => log.warn(`Couldn't delete ${gone}: ${err.message}. It will be removed later.`));
  }

  // ---- actions ------------------------------------------------------------------------------

  // Runs one action for one game folder: marks it busy, tidies leftovers first, records the outcome.
  async function withInstall(dir, action, work) {
    const inst = await findInstall(dir);
    const key = pathKey(inst.dir);
    if (busy.has(key)) throw new AddonError('Guild Camp is already working on the addon in this game folder. Wait a moment.', 'busy', 409);
    busy.set(key, action);
    errors.delete(key);
    emitStatus();
    try {
      if (tidying.has(key)) await tidying.get(key).catch(noop);
      await tidy(inst.addonsDir);
      await work(inst);
    } catch (err) {
      const e = err instanceof AddonError ? err : await inUse(err, inst, ACTION_WORDS[action].fail);
      errors.set(key, e.message);
      log.warn(`Couldn't ${ACTION_WORDS[action].fail} the addon in ${labelOf(inst)}: ${e.message}`);
      throw e;
    } finally {
      busy.delete(key);
      scan.at = 0;
      emitStatus();
    }
    return status();
  }

  function installLatest(dir, action, { auto = false } = {}) {
    return withInstall(dir, action, async (inst) => {
      const rel = remote; // a check finishing meanwhile must not change what this install fetches
      const target = pickLatest(bundled(), rel);
      if (!target) {
        throw new AddonError("There's no addon to install: this copy of Guild Camp has none built in and the server hasn't published one. Check for updates and try again.", 'nothing-to-install');
      }
      const current = installed(inst.addonsDir);
      const state = computeState(current, target);
      if (action === 'update' && (state === 'current' || state === 'newer')) {
        log.info(`The addon in ${labelOf(inst)} is already ${current.version}; nothing to update.`);
        return;
      }
      const from = current && current.version ? ` (was ${current.version})` : '';
      log.info(`${ACTION_WORDS[action].doing} addon ${target.version} in ${labelOf(inst)}${from}${auto ? ' automatically' : ''}: ${inst.addonsDir}`);
      const pkg = await packageFor(target, current, rel);
      await swapIn(inst, pkg);
      log.info(`Addon ${pkg.version} ${ACTION_WORDS[action].done} in ${labelOf(inst)}${pkg.source === 'bundled' ? ' (the copy that came with Guild Camp)' : ''}.`);
      // Installed by hand where it was removed before: automatic installs may look after it again.
      if (!auto) setOptOut(inst.dir, false);
    });
  }

  // Automatic installs (settings.addonAutoInstall): every game folder without the addon whose game version the addon
  // supports, except folders where the person removed it. Failures are logged and shown per folder, never thrown.
  async function installMissing() {
    if (!autoInstallOn() || !latest()) return [];
    const flavors = supportedFlavors();
    if (!flavors.length) return [];
    const targets = status().installs.filter((i) => i.state === 'missing' && !i.busy && i.supported && !i.optedOut);
    const done = [];
    for (const inst of targets) {
      try {
        await installLatest(inst.dir, 'install', { auto: true });
        done.push(inst.dir);
      } catch {
        // withInstall logged it and keeps the message on the folder's status.
      }
    }
    return done;
  }

  function uninstall(dir) {
    return withInstall(dir, 'uninstall', async (inst) => {
      const main = path.join(inst.addonsDir, ADDON);
      const inbox = path.join(inst.addonsDir, INBOX);
      const hasMain = exists(main);
      const hasInbox = exists(inbox);
      if (!hasMain && !hasInbox) {
        log.info(`The addon isn't installed in ${labelOf(inst)}; nothing to remove.`);
        return;
      }
      // Both folders are checked before either is touched.
      if (hasMain && !looksLikeOurs(main, ADDON)) {
        throw new AddonError(`The ${ADDON} folder in ${labelOf(inst)} doesn't look like the Guild Camp addon, so it was left alone. Remove it by hand if you're sure.`, 'not-ours');
      }
      const inboxOurs = hasInbox && looksLikeOurs(inbox, INBOX);
      log.info(`Removing the addon from ${labelOf(inst)}: ${inst.addonsDir}`);
      if (hasMain) await removeFolder(inst, ADDON);
      if (inboxOurs) await removeFolder(inst, INBOX);
      else if (hasInbox) log.warn(`Left ${inbox} alone: it doesn't look like Guild Camp's news folder.`);
      // The person chose this: automatic installs leave this folder alone from now on.
      setOptOut(inst.dir, true);
      log.info(`Addon removed from ${labelOf(inst)}. Guild Camp won't put it back there by itself.`);
    });
  }

  async function updateAll({ auto = false } = {}) {
    await freshInstalls();
    const outdated = status().installs.filter((i) => i.state === 'outdated' && !i.busy);
    const failed = [];
    for (const inst of outdated) {
      try {
        await installLatest(inst.dir, 'update', { auto });
      } catch (err) {
        failed.push(`${inst.label}: ${err.message}`);
      }
    }
    if (failed.length && !auto) {
      const err = new AddonError(failed.length === 1 ? failed[0] : `The addon couldn't be updated in ${failed.length} game folders. ${failed.join(' ')}`, 'failed');
      throw err;
    }
    return status();
  }

  async function runCheck() {
    try {
      await refreshRemote();
      const list = await freshInstalls();
      // Finish or undo interrupted changes in folders nobody is working on. An action that starts meanwhile waits
      // for this (see withInstall), so the two never step on each other's temp folders.
      for (const inst of list) {
        const key = pathKey(inst.dir);
        if (busy.has(key) || tidying.has(key)) continue;
        const p = tidy(inst.addonsDir).finally(() => tidying.delete(key));
        tidying.set(key, p);
        await p;
      }
      const lat = latest();
      log.info(lat ? `Checked for addon updates. The newest is ${lat.version} (${lat.source === 'remote' ? 'from the server' : 'built in'}).` : 'Checked for addon updates. No addon is available yet.');
      if (autoUpdateOn()) await updateAll({ auto: true });
      if (autoInstallOn()) await installMissing();
    } catch (err) {
      log.warn(`The addon check failed: ${err.message}`);
    } finally {
      lastCheckAt = new Date().toISOString();
      checkPromise = null;
      emitStatus();
    }
    return status();
  }

  // Concurrent calls share one check.
  function check() {
    if (!checkPromise) {
      checkPromise = Promise.resolve().then(runCheck);
      emitStatus(); // checking: true
    }
    return checkPromise;
  }

  // ---- settings ---------------------------------------------------------------------------

  function onSettings(_settings, keys) {
    if (!Array.isArray(keys)) return;
    let changed = false;
    if (keys.includes('serverUrl')) { remote = null; remoteError = null; changed = true; }
    if (keys.includes('extraWowFolders')) { scan.at = 0; changed = true; }
    if (keys.includes('addonAutoUpdate')) {
      changed = true;
      // Turning automatic updates on catches up straight away with what the last check found.
      if (autoUpdateOn()) updateAll({ auto: true }).catch((err) => log.warn(`Automatic addon update failed: ${err.message}`));
    }
    if (keys.includes('addonAutoInstall')) {
      changed = true;
      // Same for automatic installs: new game folders get the addon now, not at the next check.
      if (autoInstallOn()) installMissing().catch((err) => log.warn(`Automatic addon install failed: ${err.message}`));
    }
    if (changed) emitStatus();
  }
  if (store && typeof store.on === 'function') store.on('change', onSettings);

  return Object.assign(emitter, {
    status,
    check,
    install: (dir) => installLatest(dir, 'install'),
    update: (dir) => installLatest(dir, 'update'),
    repair: (dir) => installLatest(dir, 'repair'),
    uninstall,
    updateAll: () => updateAll(),
    dispose() {
      if (store && typeof store.off === 'function') store.off('change', onSettings);
    },
  });
}

module.exports = {
  createAddonManager,
  AddonError,
  flavorsForInterface,
  pickLatest,
  computeState,
  normalizeRemote,
  looksLikeOurs,
  cleanTitle,
  ADDON,
  INBOX,
};
