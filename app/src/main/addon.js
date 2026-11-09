'use strict';
// Installs, updates, repairs and removes the WowGuild addon (listed in the game as "Guild Camp") in
// every World of Warcraft folder Guild Camp knows about.
//
//   const addon = createAddonManager({ store, log, wow, resourcesDir, fetch });
//   addon.status()            → { bundled, remote, latest, releases, autoUpdate, autoInstall, supportedFlavors, checking,
//                                 lastCheckAt, error, installs }
//   await addon.check()       → reads GitHub's newest addon release (cached, see below), looks for game folders again, then,
//                               once World of Warcraft is closed (see below):
//                               - settings.addonAutoUpdate: updates outdated installs
//                               - settings.addonAutoInstall: installs the addon into game folders that don't have
//                                 it yet, but only for game versions the addon supports (from the bundled
//                                 WowGuild.toc "## Interface:" list, see flavorsForInterface) and never where the
//                                 person removed it (settings.addonOptOut, until they install it there again)
//   await addon.check({ force: true })   the same, for the person pressing Check: asks GitHub now
//   await addon.install(dir)  · update(dir) · repair(dir) · uninstall(dir) · updateAll()   → status
//                               install/update/repair/updateAll add restartNeeded: true when the game may be running
//                               and the change added the WowGuild folder or changed its .toc file list (see below)
//   events: 'status' (status) after every change
//
// World of Warcraft reads the AddOns folders and each addon's .toc file list when it starts; a /reload reloads the
// same files. So:
//   - automatic installs and updates wait while the game runs, or when Guild Camp can't tell (wow.isWowRunning()
//     true or null): the folder shows waitingForGame, and Guild Camp looks again every minute and runs the check
//     once the game has closed. It asks again right before the folder is replaced, in case the game started while
//     the new addon was downloading;
//   - an install, update or repair the person starts still happens, and says restartNeeded when a /reload can't load
//     it: a new WowGuild folder, or a WowGuild.toc that lists other files than before.
//
// Where the addon comes from:
//   bundled  <resourcesDir>/addon/WowGuild, shipped inside the app (in dev, the repo's addon/WowGuild).
//   remote   the newest GitHub release whose tag starts with addon-v (and that has its zip), from
//            GET https://api.github.com/repos/arrow-quiver/wow/releases?per_page=30 (no sign-in). The answer is
//            kept in <userData>/github-releases.json with its ETag; automatic checks ask GitHub at most every
//            30 minutes, a check the person asks for at most every 10 seconds (shared/release.js readReleaseFeed).
//            WowGuild-<v>.zip is downloaded from the release, checked against WowGuild-<v>.zip.sha256 (and the
//            digest GitHub reports, when it does) and cached as <userData>/addon-cache/WowGuild-<version>.zip.
// The higher version of the two is "latest"; on a tie the GitHub copy wins.
// status().releases carries the newest app release and the release history for the Updates page.
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
// .toc says they are ours). Other addons are never touched. WowGuild_Inbox itself is written by sync.js (main.js asks
// for it as soon as a folder gets the addon, so the game finds both folders when it next starts).
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
const MAX_SHA_FILE = 4096;
const SHA_TIMEOUT = 15000;
const DOWNLOAD_TIMEOUT = 2 * 60 * 1000;
const HISTORY_NOTES_MAX = 4000; // characters of notes per release in status().releases.history
const INSTALLS_TTL = 3000; // how long a scan of the game folders is reused by status()
const CACHE_KEEP = 3; // cached addon zips kept on disk
// Waits between rename attempts while Windows holds a lock (about 5.5 seconds in all).
const RETRY_DELAYS = [150, 300, 600, 1000, 1500, 2000];
const GAME_WAIT_MS = 60 * 1000; // how often a waiting automatic install or update asks whether the game has closed
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

// The app's own version, for the User-Agent GitHub asks API callers to send.
function ownVersion() {
  try { return require('../../package.json').version || '0.0.0'; } catch { return '0.0.0'; }
}

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

/** The newer of the bundled addon and GitHub's; GitHub's wins a tie. → { version, source } | null */
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

/**
 * One GitHub release (raw from the API, or release.normalizeRelease()) → what the addon manager needs, or null
 * when it isn't a published addon release with its zip:
 * { version, tag, notes, publishedAt, url, zipUrl, shaUrl, size, digest }
 *   url: the release page · zipUrl / shaUrl: WowGuild-<v>.zip and WowGuild-<v>.zip.sha256
 *   digest: the zip's sha256 as GitHub reports it ("sha256:<hex>" → hex), when it does
 */
function normalizeRemote(raw) {
  const rel = release.normalizeRelease(raw);
  if (!rel || rel.kind !== 'addon' || rel.draft || rel.prerelease) return null;
  const names = release.addonAssetNames(rel.version);
  const zipAsset = rel.assets.find((a) => a.name === names.zip && a.url);
  if (!zipAsset) return null;
  const shaAsset = rel.assets.find((a) => a.name === names.sha && a.url);
  const digest = typeof zipAsset.digest === 'string' && /^sha256:[0-9a-f]{64}$/i.test(zipAsset.digest) ? zipAsset.digest.slice(7).toLowerCase() : null;
  return {
    version: rel.version,
    tag: rel.tag,
    notes: rel.notes,
    publishedAt: rel.publishedAt,
    url: rel.url,
    zipUrl: zipAsset.url,
    shaUrl: shaAsset ? shaAsset.url : null,
    size: zipAsset.size,
    digest,
  };
}

/** The newest addon release (by version) that has its zip. → normalizeRemote() | null */
function pickRemote(list) {
  let best = null;
  for (const raw of Array.isArray(list) ? list : []) {
    const r = normalizeRemote(raw);
    if (r && (!best || version.gt(r.version, best.version))) best = r;
  }
  return best;
}

/** A release for status().releases: what the Updates page shows. */
function releaseCard(r) {
  if (!r) return null;
  const notes = String(r.notes || '');
  return {
    kind: r.kind,
    version: r.version,
    tag: r.tag,
    notes: notes.length > HISTORY_NOTES_MAX ? `${notes.slice(0, HISTORY_NOTES_MAX).trimEnd()}…` : notes,
    publishedAt: r.publishedAt || null,
    url: r.url || null,
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

/**
 * The files an addon's .toc loads, in order ("Core.lua", "Share.lua" ...): its lines that aren't empty or comments
 * ("## Title: ..." directives are comments too), with / for \ and in lower case. null when there is no .toc.
 */
function tocFiles(text) {
  if (typeof text !== 'string') return null;
  return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => l.replace(/\\/g, '/').toLowerCase());
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
  try { return new URL(url).host; } catch { return 'GitHub'; }
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
 * @param {object} deps.wow           { findInstalls({ extraRoots, scanDefaults }), isWowRunning() → true|false|null }
 *                                    (without isWowRunning the game counts as closed)
 * @param {string} [deps.resourcesDir] folder that holds addon/WowGuild
 * @param {typeof fetch} [deps.fetch] used for the GitHub release list and the downloads
 * @param {string} [deps.appVersion]  for the User-Agent GitHub asks for (default: app/package.json's version)
 * @param {string} [deps.releasesUrl] the release list address (default: the GitHub API for arrow-quiver/wow)
 * @param {string|null} [deps.feedFile] cache of the release list (default <folder of settings.json>/github-releases.json)
 * @param {number} [deps.minCheckInterval] automatic checks ask GitHub at most this often (default 30 minutes)
 * @param {string} [deps.cacheDir]    default <folder of settings.json>/addon-cache
 * @param {boolean} [deps.scanDefaults=true] passed to wow.findInstalls
 * @param {number[]} [deps.retryDelays] waits between rename attempts (tests shorten them)
 * @param {number} [deps.downloadTimeout]
 * @param {object} [deps.fsOps]       { rename(from, to), rm(path) } overrides (tests inject failures)
 * @param {number} [deps.gameWaitMs]  how often a waiting automatic change asks whether the game has closed (1 minute)
 */
function createAddonManager({
  store, log: logger, wow, resourcesDir, fetch: fetchImpl, appVersion, releasesUrl, feedFile, minCheckInterval = release.FEED_MIN_INTERVAL,
  cacheDir, scanDefaults = true, retryDelays = RETRY_DELAYS, downloadTimeout = DOWNLOAD_TIMEOUT, fsOps = {}, gameWaitMs = GAME_WAIT_MS,
} = {}) {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(50);
  const noop = () => {};
  const log = logger || { info: noop, warn: noop, error: noop };
  const doFetch = fetchImpl || globalThis.fetch;
  const bundledDir = resourcesDir ? path.join(resourcesDir, 'addon', ADDON) : null;
  const cacheFolder = cacheDir || (store && store.file ? path.join(path.dirname(store.file), 'addon-cache') : null);
  const feedCache = feedFile !== undefined ? feedFile
    : store && store.file ? path.join(path.dirname(store.file), 'github-releases.json')
      : cacheFolder ? path.join(cacheFolder, 'github-releases.json') : null;
  const listUrl = releasesUrl || release.releasesApiUrl();
  const userAgent = `GuildCamp/${appVersion || ownVersion()}`;
  const ops = {
    rename: fsOps.rename || ((from, to) => fsp.rename(from, to)),
    rm: fsOps.rm || ((p) => fsp.rm(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })),
  };

  let remote = null; // normalizeRemote() of GitHub's newest addon release
  let remoteError = null; // why the last GitHub check failed
  let releases = { app: null, history: [], checkedAt: null }; // for the Updates page
  let lastCheckAt = null;
  let checkPromise = null;
  let scan = { list: [], at: 0 };
  let bundledWarned = false;
  const busy = new Map(); // pathKey(dir) → action
  const errors = new Map(); // pathKey(dir) → message of the last failed action
  const downloads = new Map(); // version → Promise<Buffer>
  const tidying = new Map(); // pathKey(dir) → Promise of a background tidy() started by check()
  const waiting = new Map(); // pathKey(dir) → 'install' | 'update': an automatic change waiting for the game to close
  let gameTimer = null; // looks every gameWaitMs whether the game has closed, while something waits
  let gameAsking = false;

  const settings = () => (store ? store.get() : {});
  const autoUpdateOn = () => settings().addonAutoUpdate !== false;
  const autoInstallOn = () => settings().addonAutoInstall !== false;

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
      found = wow.findInstalls({ extraRoots: settings().extraWowFolders || [], scanDefaults, otherFolders: settings().otherGameFolders || [] });
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
      return setScan(await wow.findInstalls({ extraRoots: settings().extraWowFolders || [], scanDefaults, otherFolders: settings().otherGameFolders || [] }));
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

  // An automatic change still waiting for the game: only while the folder still needs it and automatic care is on.
  function isWaiting(key, state) {
    const kind = waiting.get(key);
    if (kind === 'update') return state === 'outdated' && autoUpdateOn();
    if (kind === 'install') return state === 'missing' && autoInstallOn();
    return false;
  }

  function status() {
    const b = bundled();
    const lat = pickLatest(b, remote);
    const flavors = supportedFlavors();
    const optOut = optedOut();
    return {
      bundled: b,
      remote: remote ? { version: remote.version, notes: remote.notes, publishedAt: remote.publishedAt, size: remote.size, url: remote.url } : null,
      latest: lat,
      releases: { app: releases.app ? { ...releases.app } : null, history: releases.history.map((r) => ({ ...r })), checkedAt: releases.checkedAt },
      autoUpdate: autoUpdateOn(),
      autoInstall: autoInstallOn(),
      supportedFlavors: flavors,
      checking: Boolean(checkPromise),
      lastCheckAt,
      error: remoteError,
      installs: scanInstalls().map((inst) => {
        const have = installed(inst.addonsDir);
        const key = pathKey(inst.dir);
        const state = computeState(have, lat);
        return {
          dir: inst.dir,
          root: inst.root || null,
          flavor: inst.flavor || null,
          label: inst.label || inst.flavor || path.basename(inst.dir),
          addonsDir: inst.addonsDir,
          installed: have,
          state,
          damaged: Boolean(have && !have.version),
          supported: isSupported(inst, flavors),
          optedOut: optOut.has(key),
          // WoW Forever, or another game the person turned on: synced and looked after automatically.
          mainGame: inst.mainGame !== false,
          inUse: inst.inUse !== false,
          busy: busy.has(key),
          action: busy.get(key) || null,
          error: errors.get(key) || null,
          // An automatic install or update waits until World of Warcraft is closed.
          waitingForGame: isWaiting(key, state),
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

  // ---- GitHub release + download -------------------------------------------------------------

  // Reads the release list through the shared cache. Without force, GitHub is asked at most every
  // minCheckInterval; the last answer (maybe from an earlier run) is used in between.
  async function refreshRemote(force) {
    let feed;
    try {
      feed = await release.readReleaseFeed({ cacheFile: feedCache, url: listUrl, fetch: doFetch, userAgent, force, minInterval: minCheckInterval });
    } catch (err) {
      feed = { releases: null, error: (err && err.message) || "Couldn't reach GitHub.", fetchedAt: null, fromNetwork: false };
    }
    if (feed.releases) {
      const next = pickRemote(feed.releases);
      if (next && (!remote || remote.version !== next.version)) log.info(`GitHub has addon ${next.version}.`);
      remote = next;
      const sum = release.summarizeReleases(feed.releases);
      releases = { app: releaseCard(sum.app), history: sum.history.map(releaseCard), checkedAt: feed.fetchedAt || null };
    }
    remoteError = feed.error || null;
    if (remoteError && feed.fromNetwork) log.warn(`Couldn't check GitHub for addon updates: ${remoteError}`);
  }

  function downloadUrl(u, what) {
    if (typeof u === 'string' && /^https:\/\//i.test(u)) return u;
    if (typeof u === 'string' && /^http:\/\/(127\.0\.0\.1|localhost)[:/]/i.test(u)) return u; // tests' local stand-in for GitHub
    throw new AddonError(`The addon release on GitHub has no usable ${what} link. Try again later.`, 'bad-package');
  }

  // The published checksum: WowGuild-<v>.zip.sha256 from the release.
  async function publishedSha(rel) {
    const v = rel.version;
    if (!rel.shaUrl) {
      throw new AddonError(`The addon ${v} release on GitHub has no checksum file, so Guild Camp can't check the download. It will be offered again once the release is fixed.`, 'bad-package');
    }
    const url = downloadUrl(rel.shaUrl, 'checksum');
    let res;
    try {
      res = await doFetch(url, { signal: AbortSignal.timeout(SHA_TIMEOUT), headers: { Accept: 'text/plain, application/octet-stream', 'User-Agent': userAgent } });
    } catch (err) {
      throw new AddonError(`Couldn't download the checksum of addon ${v} (${networkReason(err)}). Check your internet connection and try again.`, 'download');
    }
    if (!res.ok) throw new AddonError(`GitHub couldn't send the checksum of addon ${v} (it answered ${res.status}). Try again later.`, 'download');
    let text = '';
    try { text = (await res.text()).slice(0, MAX_SHA_FILE); } catch (err) {
      throw new AddonError(`The checksum download of addon ${v} was cut off (${networkReason(err)}). Try again.`, 'download');
    }
    const want = release.parseSha256Text(text, release.addonAssetNames(v).zip);
    if (!want) {
      throw new AddonError(`The checksum file of addon ${v} on GitHub can't be read, so Guild Camp can't check the download. It will be offered again once the release is fixed.`, 'bad-package');
    }
    if (rel.digest && rel.digest !== want) {
      log.warn(`Addon ${v}: the .sha256 file says ${want} but GitHub reports ${rel.digest} for the zip.`);
      throw new AddonError(`The checksums published for addon ${v} don't agree, so it wasn't installed. Your current addon was left as it was.`, 'checksum');
    }
    return want;
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
    const want = await publishedSha(rel);
    const cached = await readCache(v, want);
    if (cached) {
      log.info(`Using the saved download of addon ${v}.`);
      return cached;
    }
    if (rel.size && rel.size > MAX_DOWNLOAD) throw new AddonError(`The addon download is far too large (${Math.round(rel.size / 1048576)} MB), so it wasn't installed.`, 'bad-package');
    const url = downloadUrl(rel.zipUrl, 'download');
    log.info(`Downloading addon ${v} from ${hostOf(url)}.`);
    let res;
    try {
      res = await doFetch(url, { signal: AbortSignal.timeout(downloadTimeout), headers: { Accept: 'application/zip, application/octet-stream', 'User-Agent': userAgent } });
    } catch (err) {
      throw new AddonError(`Couldn't download addon ${v} (${networkReason(err)}). Check your internet connection and try again.`, 'download');
    }
    if (!res.ok) throw new AddonError(`GitHub couldn't send addon ${v} (it answered ${res.status}). Try again later.`, 'download');
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
      throw new AddonError(`The download of addon ${v} didn't match the checksum published with it, so it wasn't installed. Your current addon was left as it was. Try again in a few minutes.`, 'checksum');
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

  // The zip for the latest addon. When GitHub's copy can't be fetched (offline, GitHub down, a broken release),
  // the copy that came with the app is used instead if it is still an improvement. A checksum mismatch never
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

  // ---- the game -----------------------------------------------------------------------------

  // true / false, or null when Guild Camp can't tell. Without wow.isWowRunning there is nothing to ask: closed.
  async function gameRunning() {
    if (!wow || typeof wow.isWowRunning !== 'function') return false;
    try {
      const r = await wow.isWowRunning();
      return r === true ? true : r === false ? false : null;
    } catch {
      return null;
    }
  }

  // Automatic installs and updates wait while the game runs (or when Guild Camp can't tell): the game reads the
  // AddOns folders and each .toc's file list only when it starts, so after a /reload it would run half of the new
  // addon. → true when the change must wait (the folders are marked waitingForGame and a watch starts).
  async function waitsForGame(targets, kind) {
    const running = await gameRunning();
    if (running === false) {
      for (const inst of targets) waiting.delete(pathKey(inst.dir));
      return false;
    }
    let added = false;
    for (const inst of targets) {
      const key = pathKey(inst.dir);
      if (waiting.get(key) !== kind) {
        added = true;
        log.info(running
          ? `Waiting for World of Warcraft to close before ${kind === 'install' ? 'installing' : 'updating'} the addon in ${labelOf(inst)}.`
          : `Couldn't tell whether World of Warcraft is running, so the addon in ${labelOf(inst)} is ${kind === 'install' ? 'installed' : 'updated'} once Guild Camp sees it closed.`);
      }
      waiting.set(key, kind);
    }
    watchGame();
    if (added) emitStatus();
    return true;
  }

  function stopWatching() {
    if (gameTimer) clearInterval(gameTimer);
    gameTimer = null;
  }

  // While something waits, ask every gameWaitMs whether the game has closed; then run the check again.
  function watchGame() {
    if (gameTimer) return;
    gameTimer = setInterval(async () => {
      if (gameAsking) return;
      gameAsking = true;
      try {
        if (!status().installs.some((i) => i.waitingForGame)) {
          waiting.clear();
          stopWatching();
          return;
        }
        if ((await gameRunning()) !== false) return;
        stopWatching();
        log.info('World of Warcraft has closed.');
        await check();
      } catch (err) {
        log.warn(`Couldn't finish the addon change that waited for the game: ${err.message}`);
      } finally {
        gameAsking = false;
      }
    }, Math.max(10, gameWaitMs));
    if (typeof gameTimer.unref === 'function') gameTimer.unref();
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
  // → status(), plus what work() returned ({ restartNeeded }).
  async function withInstall(dir, action, work) {
    const inst = await findInstall(dir);
    const key = pathKey(inst.dir);
    if (busy.has(key)) throw new AddonError('Guild Camp is already working on the addon in this game folder. Wait a moment.', 'busy', 409);
    busy.set(key, action);
    errors.delete(key);
    emitStatus();
    let extra = null;
    try {
      if (tidying.has(key)) await tidying.get(key).catch(noop);
      await tidy(inst.addonsDir);
      extra = await work(inst);
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
    return extra && typeof extra === 'object' ? { ...status(), ...extra } : status();
  }

  // After a change the person made: true when the game may be running and a /reload can't load what changed,
  // because the WowGuild folder is new (or had no .toc) or its .toc now lists other files.
  async function needsRestart(before, inst) {
    const after = tocFiles((readAddonToc(path.join(inst.addonsDir, ADDON), ADDON) || {}).text);
    const changed = !before || !after || before.join('\n') !== after.join('\n');
    return changed && (await gameRunning()) !== false;
  }

  function installLatest(dir, action, { auto = false } = {}) {
    return withInstall(dir, action, async (inst) => {
      const rel = remote; // a check finishing meanwhile must not change what this install fetches
      const target = pickLatest(bundled(), rel);
      if (!target) {
        throw new AddonError("There's no addon to install: this copy of Guild Camp has none built in and none could be found on GitHub. Check for updates and try again.", 'nothing-to-install');
      }
      const current = installed(inst.addonsDir);
      const state = computeState(current, target);
      if (action === 'update' && (state === 'current' || state === 'newer')) {
        log.info(`The addon in ${labelOf(inst)} is already ${current.version}; nothing to update.`);
        return { restartNeeded: false };
      }
      const from = current && current.version ? ` (was ${current.version})` : '';
      log.info(`${ACTION_WORDS[action].doing} addon ${target.version} in ${labelOf(inst)}${from}${auto ? ' automatically' : ''}: ${inst.addonsDir}`);
      const pkg = await packageFor(target, current, rel);
      // The game may have started while the package was downloaded: an automatic change still waits for it to close.
      if (auto && await waitsForGame([inst], action === 'install' ? 'install' : 'update')) return { restartNeeded: false, waited: true };
      const filesBefore = tocFiles((readAddonToc(path.join(inst.addonsDir, ADDON), ADDON) || {}).text);
      await swapIn(inst, pkg);
      waiting.delete(pathKey(inst.dir));
      log.info(`Addon ${pkg.version} ${ACTION_WORDS[action].done} in ${labelOf(inst)}${pkg.source === 'bundled' ? ' (the copy that came with Guild Camp)' : ''}.`);
      // Installed by hand where it was removed before: automatic installs may look after it again.
      if (!auto) setOptOut(inst.dir, false);
      // Automatic changes only happen with the game closed; one the person made may need a game restart.
      const restartNeeded = !auto && await needsRestart(filesBefore, inst);
      if (restartNeeded) log.info(`Restart World of Warcraft to load addon ${pkg.version} in ${labelOf(inst)}. A /reload isn't enough this time.`);
      return { restartNeeded };
    });
  }

  // Automatic installs (settings.addonAutoInstall): every game folder without the addon whose game version the addon
  // supports, except folders where the person removed it. Failures are logged and shown per folder, never thrown.
  // They wait while the game runs (waitsForGame).
  async function installMissing() {
    if (!autoInstallOn() || !latest()) return [];
    const flavors = supportedFlavors();
    if (!flavors.length) return [];
    const targets = status().installs.filter((i) => i.state === 'missing' && !i.busy && i.supported && !i.optedOut && i.inUse);
    if (!targets.length || await waitsForGame(targets, 'install')) return [];
    const done = [];
    for (const inst of targets) {
      try {
        const r = await installLatest(inst.dir, 'install', { auto: true });
        if (!(r && r.waited)) done.push(inst.dir);
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

  // Updates every outdated install. Automatic updates wait while the game runs (waitsForGame); the person's own
  // "Update all" goes ahead and says restartNeeded when any folder needs a game restart.
  async function updateAll({ auto = false } = {}) {
    await freshInstalls();
    // Folders not in use (another game, not turned on) are left alone.
    const outdated = status().installs.filter((i) => i.state === 'outdated' && !i.busy && i.inUse);
    if (auto && outdated.length && await waitsForGame(outdated, 'update')) return status();
    const failed = [];
    let restartNeeded = false;
    for (const inst of outdated) {
      try {
        const r = await installLatest(inst.dir, 'update', { auto });
        if (r && r.restartNeeded) restartNeeded = true;
      } catch (err) {
        failed.push(`${inst.label}: ${err.message}`);
      }
    }
    if (failed.length && !auto) {
      const err = new AddonError(failed.length === 1 ? failed[0] : `The addon couldn't be updated in ${failed.length} game folders. ${failed.join(' ')}`, 'failed');
      throw err;
    }
    return auto ? status() : { ...status(), restartNeeded };
  }

  async function runCheck(force) {
    try {
      await refreshRemote(force);
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
      log.info(lat ? `Checked for addon updates. The newest is ${lat.version} (${lat.source === 'remote' ? 'on GitHub' : 'built in'}).` : 'Checked for addon updates. No addon is available yet.');
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

  // Concurrent calls share one check. { force: true } (the person pressed Check) asks GitHub now instead of
  // using an answer from the last 30 minutes.
  function check(opts) {
    const force = Boolean(opts && typeof opts === 'object' && opts.force);
    if (!checkPromise) {
      checkPromise = Promise.resolve().then(() => runCheck(force));
      emitStatus(); // checking: true
    }
    return checkPromise;
  }

  // ---- settings ---------------------------------------------------------------------------

  function onSettings(_settings, keys) {
    if (!Array.isArray(keys)) return;
    let changed = false;
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
      stopWatching();
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
  pickRemote,
  looksLikeOurs,
  cleanTitle,
  tocFiles,
  ADDON,
  INBOX,
};
