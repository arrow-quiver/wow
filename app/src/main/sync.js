'use strict';
// Background sync engine: the old companion's watch → upload → inbox loop, inside the app.
//
//   const sync = createSync({ api, store, log, wow, appVersion });
//   sync.start()          start watching; resolves (never rejects) after the first full sync.
//                         main.js calls it on sign-in and stop() on sign-out / quit.
//   sync.stop()
//   await sync.syncNow()  upload every SavedVariables file now and rewrite the inbox → status.
//                         Rejects with a plain sentence when signed out, no game folder was found,
//                         or an upload failed.
//   sync.setEnabled(bool) background sync on/off (saved as settings.syncEnabled) → status
//   sync.clearNoGuild()   forget "the server has no guild for you yet" (main.js calls it once the
//                         member is in a guild) so waiting files upload at the next check → status
//   sync.status()         → see status() below (ARCHITECTURE.md "sync.status")
//   events: 'status' (status; only when something changed)
//           'log' (message, level)              every line this engine logs
//           'uploaded' (serverResult, { file, account, install, label })
//           'joined' (joined, where)            an upload put this member into a guild:
//                                               joined = { guild: { id, name, faction }, role, via, character }
//           'no-guild' ({ reason, autoJoin, file?, account?, install?, label? })
//                                               the server had no guild for this member (409 NO_GUILD_MATCH,
//                                               or "Join a guild first." from an older server). autoJoin is the
//                                               server's match result when the reply carried it, else null.
//
// How it works
//  - Every 4 s it checks the modification time of WTF/Account/*/SavedVariables/WowGuild.lua in every
//    install. WoW writes that file when you log out or type /reload.
//  - When one changed, it waits 1.5 s and checks again so it never reads a half-written file, then
//    uploads WowGuildDB to POST /api/sync, with Auctionator prices when Auctionator.lua (next to it)
//    changed since the last successful upload.
//  - After an upload it saves the guild news (GET /api/inbox) for the addon in
//    Interface/AddOns/WowGuild_Inbox: a tiny addon the WowGuild addon loads first, so the addon's own
//    folder stays exactly as released. The news is refreshed every 5 minutes as well.
//  - When the server says a Coach answer is on its way (coachPending), it checks the inbox every
//    6 s for up to 2 minutes and saves the answer as soon as it is there.
//  - A failed upload is retried per file with exponential backoff: 5 s, 10 s, 20 s ... up to 5 min.
//  - Signed in but not in a guild yet: the server tries to match the uploaded characters to its guild.
//    When it joins the member, the reply says so ('joined' event) and the upload counts as normal.
//    When it can't (409 NO_GUILD_MATCH), nothing is stored: the state is 'no-guild', lastError is the
//    server's plain reason, and the file is tried again when the game saves it again or after 60 s.
//    That is waiting, not failing: no backoff and no "Couldn't upload" lines on every try.
//  - Game folders are looked for again every 60 s and whenever settings.extraWowFolders changes.
//  - Uploads never overlap.
//
// Plain Node (no Electron). Tests can override timing with createSync({ ..., now, sleep, setTimeout,
// clearTimeout, pollMs, settleMs, ... }) and drive one check at a time with sync.poll().

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { parseSavedVariables, luaAssignment } = require('../shared/lua');
const { extractPrices } = require('../shared/auctionator');
const { tocField } = require('../shared/toc');
const versions = require('../shared/version');
const { writeFileAtomic } = require('./store');
const wowHelpers = require('./wow');

const { ADDON, INBOX_ADDON } = wowHelpers;

const DEFAULTS = Object.freeze({
  pollMs: 4000, // how often SavedVariables are checked
  settleMs: 1500, // wait after a change before reading the file
  rescanMs: 60 * 1000, // look for game folders again
  inboxRefreshMs: 5 * 60 * 1000, // refresh the guild news for the addon
  coachEveryMs: 6000, // check for a Coach answer
  coachTimeoutMs: 2 * 60 * 1000, // ... for this long
  retryBaseMs: 5000, // first retry after a failed upload
  retryMaxMs: 5 * 60 * 1000, // longest wait between retries
  noGuildRetryMs: 60 * 1000, // try again this long after the server had no guild for this member
  uploadTimeoutMs: 120 * 1000, // big guilds send a lot
});

const HISTORY_SIZE = 20;
// Used when the installed WowGuild.toc can't be read (the addon writes both game versions).
const DEFAULT_INTERFACE = '16001, 120105';

// ---------------------------------------------------------------------------------------------
// Pure helpers (exported for tests)

/** Backoff after the count-th failure in a row: 5 s, 10 s, 20 s, ... capped at 5 min. */
function retryDelay(count, base = DEFAULTS.retryBaseMs, max = DEFAULTS.retryMaxMs) {
  const n = Math.max(1, Math.floor(Number(count) || 1));
  return Math.min(max, base * 2 ** Math.min(n - 1, 30));
}

/** 5000 → "5 seconds", 300000 → "5 minutes". */
function describeWait(ms) {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s} second${s === 1 ? '' : 's'}`;
  const m = Math.round(s / 60);
  return `${m} minute${m === 1 ? '' : 's'}`;
}

/** The old companion's upload line, without the final full stop. */
function uploadSummary(result) {
  const r = result && typeof result === 'object' ? result : {};
  const n = (k) => Number(r[k]) || 0;
  const extra = [
    n('ctas') ? `${n('ctas')} call(s) to arms` : '',
    n('prices') ? `${n('prices')} auction prices` : '',
    n('bank') ? `${n('bank')} guild bank items` : '',
  ].filter(Boolean);
  return `Uploaded: ${n('characters')} character(s), ${n('roster')} roster entries, ${n('recipes')} recipes${extra.length ? `, ${extra.join(', ')}` : ''}`;
}

/**
 * The WowGuild_Inbox .toc. The Interface line is copied from the installed WowGuild.toc so the game
 * never lists the news addon as out of date.
 */
function inboxToc(addonsDir, appVersion) {
  let iface = DEFAULT_INTERFACE;
  try {
    const v = tocField(fs.readFileSync(path.join(addonsDir, ADDON, `${ADDON}.toc`), 'utf8'), 'Interface');
    if (v) iface = v;
  } catch { /* keep the default */ }
  const version = String(appVersion || '0.0.0').replace(/[\r\n]+/g, ' ').trim() || '0.0.0';
  return [
    `## Interface: ${iface}`,
    '## Title: Guild Camp news',
    '## Notes: News from your guild for the Guild Camp addon. The Guild Camp app rewrites this on every sync.',
    `## Version: ${version}`,
    '',
    'Inbox.lua',
    '',
  ].join('\r\n');
}

function writeIfChanged(file, data) {
  let old = null;
  try { old = fs.readFileSync(file); } catch { /* new file */ }
  if (old && old.equals(data)) return false;
  writeFileAtomic(file, data); // temp file + rename, so the game never loads half a file
  return true;
}

/**
 * Writes Interface/AddOns/WowGuild_Inbox/{WowGuild_Inbox.toc, Inbox.lua}. Each file is only
 * rewritten when its content changed. → { dir, toc: changed?, lua: changed? }
 */
function writeInboxFiles(addonsDir, inbox, appVersion) {
  const dir = path.join(addonsDir, INBOX_ADDON);
  fs.mkdirSync(dir, { recursive: true });
  const toc = writeIfChanged(path.join(dir, `${INBOX_ADDON}.toc`), Buffer.from(inboxToc(addonsDir, appVersion), 'utf8'));
  const lua = writeIfChanged(path.join(dir, 'Inbox.lua'), Buffer.from(luaAssignment('WowGuildInbox', inbox), 'utf8'));
  return { dir, toc, lua };
}

// ---------------------------------------------------------------------------------------------

const plain = (err) => {
  const text = String((err && err.message) || err || 'Unknown problem.').trim();
  return /[.!?]$/.test(text) ? text : `${text}.`;
};

const userError = (message) => Object.assign(new Error(message), { status: 400 });

/**
 * Is this failed upload the server saying "you're not in a guild (yet)"? → { reason, autoJoin } | null.
 * New servers answer 409 { error, code: 'NO_GUILD_MATCH', autoJoin }; older ones 403 "Join a guild first.".
 * api.js puts code and autoJoin on the ApiError (and the whole reply on err.body), so the 'no-guild' event
 * carries the server's match result and main.js records it instead of asking POST /api/guild/auto-join
 * again. Without one (an older server, or the inbox's 403) autoJoin is null and main.js asks.
 */
function noGuildReply(err) {
  if (!err || typeof err !== 'object') return null;
  const body = [err.body, err.data].find((b) => b && typeof b === 'object') || {};
  const code = err.code || body.code || null;
  if (code !== 'NO_GUILD_MATCH' && err.status !== 409 && err.status !== 403) return null;
  const autoJoin = [err.autoJoin, body.autoJoin].find((r) => r && typeof r === 'object' && !Array.isArray(r)) || null;
  return { reason: plain(err), autoJoin };
}

function mtimeOf(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return null; }
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

const noopLog = { info() {}, warn() {}, error() {} };

/**
 * @param {object} deps
 * @param {object} deps.api        createApi() result: request(method, path, body, opts)
 * @param {object} [deps.store]    createStore() result (settings + device token)
 * @param {object} [deps.log]      logger with info/warn/error
 * @param {object} deps.wow        { findInstalls } (the wow.js module)
 * @param {string} deps.appVersion written into the inbox .toc
 * Test overrides (all optional): now() → ms, sleep(ms) → Promise, setTimeout/clearTimeout (the 4 s
 * check timer), scanDefaults (false: only settings.extraWowFolders), and any key of DEFAULTS.
 */
function createSync({ api, store, log, wow, appVersion, ...opts } = {}) {
  const o = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    if (Number.isFinite(opts[key]) && opts[key] >= 0) o[key] = opts[key];
  }
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  // Waits (settle, Coach checks) end early on stop(), so nothing keeps the app or a test alive.
  const sleeping = new Set();
  const realSleep = (ms) => new Promise((resolve) => {
    const entry = { resolve, t: null };
    entry.t = setTimeout(() => { sleeping.delete(entry); resolve(); }, ms);
    sleeping.add(entry);
  });
  const wakeSleepers = () => {
    for (const entry of sleeping) { clearTimeout(entry.t); entry.resolve(); }
    sleeping.clear();
  };
  const sleep = typeof opts.sleep === 'function' ? opts.sleep : realSleep;
  const setTimer = typeof opts.setTimeout === 'function' ? opts.setTimeout : setTimeout;
  const clearTimer = typeof opts.clearTimeout === 'function' ? opts.clearTimeout : clearTimeout;
  const scanDefaults = opts.scanDefaults !== false;
  const logger = log || noopLog;
  const emitter = new EventEmitter();
  const keyOf = (p) => wowHelpers.pathKey(p);
  const iso = (t) => new Date(t).toISOString();

  let enabled = store ? store.get().syncEnabled !== false : true;
  let running = false;
  let timer = null;
  let stopGen = 0; // bumped by stop(): a background check in progress gives up
  let startPromise = null;

  let installs = null; // last scan
  let fileList = []; // [{ file, key, account, install, installKey, label, flavor }]
  let dirty = true; // look for installs again before the next use
  let lastScanAt = 0;
  let lastInboxTryAt = 0;
  let installsLogged = null;

  let current = null; // the check/sync holding the lock
  let working = 0; // uploads and inbox writes in progress → state 'syncing'
  let coach = null; // { cancelled, promise } while following a Coach answer

  const seen = new Map(); // file key → mtimeMs that was uploaded (or had nothing to upload)
  const failures = new Map(); // file key → { count, retryAt, error }
  const records = new Map(); // file key → { lastUploadAt, lastError }
  const auctionatorSent = new Map(); // Auctionator.lua key → mtimeMs included in a successful upload
  const inboxErrors = new Map(); // install key → message
  const guildWaits = new Map(); // file key → { mtime, retryAt } after the server had no guild for this member
  const recent = []; // newest first, HISTORY_SIZE entries

  let lastSyncAt = null;
  let lastResult = null;
  let lastError = null;
  let lastEmitted = null;
  let appNagged = false;
  let noGuild = null; // { reason, autoJoin, since } while the server has no guild for this member

  function safeEmit(event, ...args) {
    try { emitter.emit(event, ...args); } catch (err) { logger.warn(`A "${event}" listener failed: ${err.message}`); }
  }

  function say(level, message) {
    (logger[level] || logger.info)(message);
    safeEmit('log', message, level);
  }

  const hasToken = () => (store ? Boolean(store.getSecret('deviceToken')) : true);

  function remember(entry) {
    recent.unshift(entry);
    if (recent.length > HISTORY_SIZE) recent.length = HISTORY_SIZE;
  }

  function clearProblemIfSolved() {
    if (!failures.size && !inboxErrors.size) lastError = noGuild ? noGuild.reason : null;
  }

  // ---- not in a guild yet --------------------------------------------------------------------

  /** The server has no guild for this member yet. Logged once per reason; the event fires every time. */
  function enterNoGuild(info, where = {}) {
    const fresh = !noGuild || noGuild.reason !== info.reason;
    noGuild = { reason: info.reason, autoJoin: info.autoJoin || null, since: fresh ? iso(now()) : noGuild.since };
    clearProblemIfSolved();
    if (fresh) {
      const message = `Waiting to match you to a guild: ${info.reason} Guild Camp tries again when the game saves, and every minute.`;
      say('info', message);
      remember({ at: iso(now()), kind: 'guild', ok: false, message, ...where });
    }
    safeEmit('no-guild', { reason: info.reason, autoJoin: info.autoJoin || null, ...where });
  }

  /** In a guild now: files that were waiting go up at the next check. */
  function leaveNoGuild() {
    if (!noGuild && !guildWaits.size) return false;
    noGuild = null;
    for (const key of guildWaits.keys()) {
      const rec = records.get(key);
      if (rec && rec.lastError) records.set(key, { ...rec, lastError: null });
    }
    guildWaits.clear();
    clearProblemIfSolved();
    return true;
  }

  // ---- installs ------------------------------------------------------------------------------

  function filesOf(install) {
    const fromDisk = wowHelpers.savedVariablesFiles(install.dir);
    if (fromDisk.length) return fromDisk;
    return (Array.isArray(install.accounts) ? install.accounts : []).filter((f) => typeof f === 'string' && mtimeOf(f) !== null);
  }

  function addonsDirOf(install) {
    return install.addonsDir || path.join(install.dir, 'Interface', 'AddOns');
  }

  function refreshFileList() {
    const out = [];
    const keys = new Set();
    for (const install of installs || []) {
      for (const file of filesOf(install)) {
        const key = keyOf(file);
        if (keys.has(key)) continue;
        keys.add(key);
        out.push({
          file,
          key,
          account: wowHelpers.accountName(file),
          install: install.dir,
          installKey: keyOf(install.dir),
          label: install.label || wowHelpers.flavorLabel(install.flavor),
          flavor: install.flavor || null,
        });
      }
    }
    fileList = out;
    // Retry state for files that are gone is meaningless now.
    for (const key of [...failures.keys()]) if (!keys.has(key)) failures.delete(key);
    for (const key of [...guildWaits.keys()]) if (!keys.has(key)) guildWaits.delete(key);
    clearProblemIfSolved();
  }

  function logInstalls(list) {
    const signature = list.map((i) => keyOf(i.dir)).join('|');
    if (signature === installsLogged) return;
    installsLogged = signature;
    if (!list.length) {
      say('info', "No World of Warcraft folder found yet. If the game is installed somewhere unusual, add its folder on the Addon & sync page.");
      return;
    }
    for (const install of list) {
      const n = filesOf(install).length;
      say('info', `Game folder: ${install.dir} (${install.label || wowHelpers.flavorLabel(install.flavor)}, ${n} account(s) with saved data${install.addonInstalled === false ? ', addon not installed yet' : ''}).`);
    }
  }

  function scan() {
    let found = [];
    try {
      const extraRoots = store ? store.get().extraWowFolders || [] : [];
      const result = wow && typeof wow.findInstalls === 'function' ? wow.findInstalls({ extraRoots, scanDefaults }) : [];
      found = Array.isArray(result) ? result.filter((i) => i && typeof i.dir === 'string' && i.dir) : [];
    } catch (err) {
      say('warn', `Couldn't look for game folders: ${plain(err)}`);
    }
    installs = found;
    dirty = false;
    lastScanAt = now();
    refreshFileList();
    logInstalls(found);
    return found;
  }

  function currentInstalls() {
    if (dirty || !installs) scan();
    return installs;
  }

  // ---- status --------------------------------------------------------------------------------

  function state() {
    if (!hasToken()) return 'signed-out';
    if (working > 0) return 'syncing';
    if (!enabled) return 'off';
    if (!currentInstalls().length) return 'no-game';
    if (noGuild) return 'no-guild';
    if (failures.size || inboxErrors.size) return 'error';
    return 'idle';
  }

  /**
   * {
   *   enabled, running, state: 'off'|'idle'|'syncing'|'error'|'signed-out'|'no-game'|'no-guild',
   *   lastSyncAt, lastResult: { characters, roster, recipes, ctas, inventory, bank, prices,
   *     coachPending, account, label }|null, lastError,
   *   noGuild: { reason, since }|null   (state 'no-guild': the server has no guild for this member yet;
   *                                      lastError is the same reason)
   *   files: [{ file, account, install (game folder), label, flavor, lastUploadAt, lastError, nextRetryAt }],
   *   nextRetryAt, installCount, coachWaiting,
   *   recent: [{ at, kind: 'upload'|'inbox'|'coach'|'guild', ok, message, file?, account?, install?, label?, result? }]
   * }   (times are ISO strings)
   */
  function status() {
    const list = currentInstalls();
    const s = state();
    let next = null;
    for (const f of failures.values()) if (next === null || f.retryAt < next) next = f.retryAt;
    for (const w of guildWaits.values()) if (next === null || w.retryAt < next) next = w.retryAt;
    return {
      enabled,
      running,
      state: s,
      lastSyncAt,
      lastResult: lastResult ? { ...lastResult } : null,
      lastError,
      noGuild: noGuild ? { reason: noGuild.reason, since: noGuild.since } : null,
      files: fileList.map((f) => {
        const rec = records.get(f.key);
        const fail = failures.get(f.key);
        const wait = guildWaits.get(f.key);
        let retryAt = null;
        if (fail) retryAt = fail.retryAt;
        else if (wait) retryAt = wait.retryAt;
        return {
          file: f.file,
          account: f.account,
          install: f.install,
          label: f.label,
          flavor: f.flavor,
          lastUploadAt: rec ? rec.lastUploadAt : null,
          lastError: fail ? fail.error : (wait && noGuild ? noGuild.reason : null),
          nextRetryAt: retryAt === null ? null : iso(retryAt),
        };
      }),
      nextRetryAt: next === null ? null : iso(next),
      installCount: list.length,
      coachWaiting: Boolean(coach),
      recent: recent.map((r) => ({ ...r, result: r.result ? { ...r.result } : undefined })),
    };
  }

  /** Emits 'status' when anything in it changed since the last emit. */
  function changed() {
    const s = status();
    const json = JSON.stringify(s);
    if (json !== lastEmitted) {
      lastEmitted = json;
      safeEmit('status', s);
    }
    return s;
  }

  // ---- one at a time -------------------------------------------------------------------------

  async function exclusive(fn) {
    while (current) {
      try { await current; } catch { /* the other run reports its own problems */ }
    }
    const run = (async () => fn())();
    current = run;
    try {
      return await run;
    } finally {
      if (current === run) current = null;
    }
  }

  // ---- upload --------------------------------------------------------------------------------

  // Auctionator keeps its scan results in its own SavedVariables file next to ours. Prices are sent
  // only when that file changed since the last successful upload.
  function auctionatorPrices(svFile) {
    const file = path.join(path.dirname(svFile), 'Auctionator.lua');
    const mtime = mtimeOf(file);
    if (mtime === null) return null;
    const key = keyOf(file);
    if (auctionatorSent.get(key) === mtime) return null;
    try {
      const db = parseSavedVariables(fs.readFileSync(file)).AUCTIONATOR_PRICE_DATABASE;
      if (!db || typeof db !== 'object') return null;
      return { key, mtime, prices: extractPrices(db, now()) };
    } catch (err) {
      say('warn', `Couldn't read Auctionator prices (${err.message}). Everything else still uploads.`);
      auctionatorSent.set(key, mtime); // don't try this exact file again
      return null;
    }
  }

  function nagAboutApp(latest) {
    if (appNagged || !latest || !appVersion) return;
    const v = typeof latest.app === 'string' ? latest.app : latest.app && latest.app.version;
    if (v && versions.valid(v) && versions.valid(appVersion) && versions.lt(appVersion, v)) {
      appNagged = true;
      say('info', `Guild Camp ${v} is available (you have ${appVersion}). Open the Updates page to install it.`);
    }
  }

  function readDb(entry) {
    let buf;
    try {
      buf = fs.readFileSync(entry.file);
    } catch (err) {
      throw new Error(`Couldn't read ${entry.file} (${err.code || err.message}).`);
    }
    try {
      return parseSavedVariables(buf).WowGuildDB;
    } catch (err) {
      throw new Error(`The saved data in ${entry.file} couldn't be read (${err.message}).`);
    }
  }

  /** → { uploaded: true, result } | { uploaded: false, error? } */
  async function uploadFile(entry, mtime) {
    const where = { file: entry.file, account: entry.account, install: entry.install, label: entry.label };
    const multi = fileList.length > 1;
    working += 1;
    changed();
    try {
      const db = readDb(entry);
      if (!db || typeof db !== 'object' || Array.isArray(db) || !Object.keys(db).length) {
        say('info', `No Guild Camp data for ${entry.account} yet. Log in to a character, then log out or type /reload once.`);
        seen.set(entry.key, mtime);
        failures.delete(entry.key);
        guildWaits.delete(entry.key);
        clearProblemIfSolved();
        return { uploaded: false };
      }
      const auc = auctionatorPrices(entry.file);
      if (auc) db.prices = auc.prices;
      const result = (await api.request('POST', '/api/sync', db, { timeout: o.uploadTimeoutMs })) || {};
      if (auc) auctionatorSent.set(auc.key, auc.mtime);

      const at = iso(now());
      seen.set(entry.key, mtime);
      failures.delete(entry.key);
      guildWaits.delete(entry.key);
      records.set(entry.key, { lastUploadAt: at, lastError: null });
      // An upload went through, so this member is in a guild now. When this very upload put them
      // there, say so; files that were waiting for a guild go up straight after.
      const joined = result.joined && typeof result.joined === 'object' && result.joined.guild ? result.joined : null;
      leaveNoGuild();
      if (joined) {
        const who = joined.character ? ` (matched ${joined.character})` : '';
        say('info', `You're in ${joined.guild.name || 'the guild'}${who}. Guild Camp joined you automatically.`);
        remember({ at, kind: 'guild', ok: true, message: `Joined ${joined.guild.name || 'the guild'}${who}.`, ...where });
      }
      lastSyncAt = at;
      lastResult = {
        characters: Number(result.characters) || 0,
        roster: Number(result.roster) || 0,
        recipes: Number(result.recipes) || 0,
        ctas: Number(result.ctas) || 0,
        inventory: Number(result.inventory) || 0,
        bank: Number(result.bank) || 0,
        prices: Number(result.prices) || 0,
        coachPending: Number(result.coachPending) || 0,
        account: entry.account,
        label: entry.label,
      };
      clearProblemIfSolved();
      const message = `${uploadSummary(result)}${multi ? ` (${entry.account}, ${entry.label})` : ''}.`;
      say('info', message);
      remember({ at, kind: 'upload', ok: true, message, ...where, result: { ...lastResult } });
      nagAboutApp(result.latest);
      if (joined) safeEmit('joined', { guild: { ...joined.guild }, role: joined.role || null, via: joined.via || null, character: joined.character || null }, where);
      safeEmit('uploaded', result, where);
      return { uploaded: true, result };
    } catch (err) {
      const waiting = noGuildReply(err);
      if (waiting) {
        // Not stored on the server, but not a failure either: wait for the next save or a minute.
        guildWaits.set(entry.key, { mtime, retryAt: now() + o.noGuildRetryMs });
        failures.delete(entry.key);
        enterNoGuild(waiting, where);
        return { uploaded: false, noGuild: true };
      }
      const prev = failures.get(entry.key);
      const count = (prev ? prev.count : 0) + 1;
      const wait = retryDelay(count, o.retryBaseMs, o.retryMaxMs);
      const error = plain(err);
      failures.set(entry.key, { count, retryAt: now() + wait, error });
      records.set(entry.key, { ...(records.get(entry.key) || { lastUploadAt: null }), lastError: error });
      lastError = error;
      const message = `Couldn't upload the saved data for ${entry.account}: ${error} Trying again in ${describeWait(wait)}.`;
      say('warn', message);
      remember({ at: iso(now()), kind: 'upload', ok: false, message, ...where });
      return { uploaded: false, error };
    } finally {
      working -= 1;
    }
  }

  // ---- inbox ---------------------------------------------------------------------------------

  /**
   * Saves the guild news into every given install that has the addon. Fetches GET /api/inbox once
   * unless `inbox` is given. → number of installs written.
   */
  async function writeInboxes(list, { inbox = null, announce = false } = {}) {
    const targets = (list || []).filter((i) => isDir(path.join(addonsDirOf(i), ADDON)));
    if (!targets.length) return 0;
    working += 1;
    changed();
    try {
      let data = inbox;
      if (!data) {
        lastInboxTryAt = now();
        try {
          data = await api.request('GET', '/api/inbox');
        } catch (err) {
          // Not in a guild yet: there is no news, and that is not a sync problem.
          if (err && err.status === 403) {
            for (const t of targets) inboxErrors.delete(keyOf(t.dir));
            if (!noGuild) enterNoGuild({ reason: plain(err), autoJoin: null }); // keep the server's better reason
            return 0;
          }
          const error = plain(err);
          for (const t of targets) inboxErrors.set(keyOf(t.dir), error);
          lastError = error;
          const message = `Couldn't get the guild news from the server: ${error}`;
          say('warn', message);
          remember({ at: iso(now()), kind: 'inbox', ok: false, message });
          return 0;
        }
      }
      // News only comes for guild members, so the "no guild yet" wait is over.
      if (!inbox) leaveNoGuild();
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        const message = 'The guild server sent news Guild Camp could not read.';
        lastError = message;
        for (const t of targets) inboxErrors.set(keyOf(t.dir), message);
        say('warn', message);
        remember({ at: iso(now()), kind: 'inbox', ok: false, message });
        return 0;
      }
      let written = 0;
      for (const t of targets) {
        const label = t.label || wowHelpers.flavorLabel(t.flavor);
        try {
          writeInboxFiles(addonsDirOf(t), data, appVersion);
          inboxErrors.delete(keyOf(t.dir));
          written += 1;
        } catch (err) {
          const error = plain(err);
          inboxErrors.set(keyOf(t.dir), error);
          lastError = error;
          const message = `Couldn't save the guild news for the addon (${label}): ${error}`;
          say('warn', message);
          remember({ at: iso(now()), kind: 'inbox', ok: false, message, install: t.dir, label });
        }
      }
      clearProblemIfSolved();
      if (written && announce) say('info', 'Guild news saved for the addon. It shows after your next /reload.');
      return written;
    } finally {
      working -= 1;
    }
  }

  // ---- Coach ---------------------------------------------------------------------------------

  // The Coach answers questions asked in game on the server, which takes a little while. Keep
  // checking for up to two minutes and save the answer for the addon as soon as it is there.
  function followCoach() {
    if (coach) return coach.promise;
    const job = { cancelled: false, promise: null };
    coach = job;
    const tries = Math.max(1, Math.ceil(o.coachTimeoutMs / Math.max(1, o.coachEveryMs)));
    say('info', 'The Coach is working on your question or build plan...');
    job.promise = (async () => {
      for (let i = 0; i < tries; i++) {
        await sleep(o.coachEveryMs);
        if (job.cancelled) return false;
        const inbox = await api.request('GET', '/api/inbox');
        if (job.cancelled) return false;
        if (!inbox || typeof inbox !== 'object') throw new Error('The guild server sent news Guild Camp could not read.');
        if (!inbox.coach || !inbox.coach.pending) {
          await exclusive(() => writeInboxes(currentInstalls(), { inbox }));
          say('info', 'The Coach has answered. Type /reload in game (or press "Check for answers" in the Coach) to see it.');
          remember({ at: iso(now()), kind: 'coach', ok: true, message: 'The Coach has answered.' });
          return true;
        }
      }
      say('info', 'The Coach is taking a while. The answer will show after a later /reload.');
      return false;
    })()
      .catch((err) => {
        say('warn', `Couldn't check on the Coach: ${plain(err)}`);
        return false;
      })
      .finally(() => {
        if (coach === job) coach = null;
        changed();
      });
    changed();
    return job.promise;
  }

  // ---- checks --------------------------------------------------------------------------------

  /**
   * One pass over every SavedVariables file. force: upload everything now (no settle wait, no
   * backoff) and rewrite every inbox. → { uploads, failed: [message] }
   */
  async function pass({ force = false } = {}) {
    const gen = stopGen;
    const list = dirty || !installs || now() - lastScanAt >= o.rescanMs ? scan() : installs;
    refreshFileList();
    const needInbox = [];
    const failed = [];
    let uploads = 0;
    let coachPending = 0;

    for (const install of list) {
      const installKey = keyOf(install.dir);
      let uploadedHere = false;
      for (const entry of fileList.filter((f) => f.installKey === installKey)) {
        if (!force && gen !== stopGen) return { uploads, failed, stopped: true };
        const mtime = mtimeOf(entry.file);
        if (mtime === null) continue;
        if (!force) {
          if (seen.get(entry.key) === mtime) continue;
          // The server had no guild for this member: the same file is tried again after a minute
          // (no need to wait for it to settle, it hasn't changed); a new save goes up as usual.
          const wait = guildWaits.get(entry.key);
          const sameAsWaiting = Boolean(wait && wait.mtime === mtime);
          if (sameAsWaiting && now() < wait.retryAt) continue;
          const fail = failures.get(entry.key);
          if (fail && now() < fail.retryAt) continue;
          if (!sameAsWaiting) {
            // Wait until WoW has finished writing the file; if it is still changing, the next check
            // picks it up.
            await sleep(o.settleMs);
            if (mtimeOf(entry.file) !== mtime) continue;
            if (gen !== stopGen) return { uploads, failed, stopped: true };
          }
        }
        const r = await uploadFile(entry, mtime);
        if (r.uploaded) {
          uploadedHere = true;
          uploads += 1;
          coachPending += Number(r.result.coachPending) || 0;
        } else if (r.error) {
          failed.push(r.error);
        }
      }
      if (uploadedHere || force) needInbox.push(install);
    }

    // No guild, no news: the 5-minute refresh in poll() checks again later.
    if (needInbox.length && noGuild) lastInboxTryAt = now();
    else if (needInbox.length) await writeInboxes(needInbox, { announce: true });
    if (coachPending > 0 && (force || gen === stopGen)) followCoach();
    return { uploads, failed };
  }

  /** One background check (what the 4 s timer runs). Skipped while another check is running. */
  async function poll() {
    if (current) return;
    if (!enabled || !hasToken()) {
      changed();
      return;
    }
    try {
      await exclusive(async () => {
        await pass({ force: false });
        if (now() - lastInboxTryAt >= o.inboxRefreshMs) await writeInboxes(currentInstalls());
      });
    } catch (err) {
      say('warn', `Sync check failed: ${plain(err)}`);
    }
    changed();
  }

  function schedule() {
    if (!running || timer) return;
    timer = setTimer(async () => {
      timer = null;
      try { await poll(); } finally { schedule(); }
    }, o.pollMs);
  }

  // ---- public API ----------------------------------------------------------------------------

  async function syncNow() {
    if (!hasToken()) throw userError('Sign in to sync with your guild.');
    dirty = true;
    if (!currentInstalls().length) {
      changed();
      throw userError("Guild Camp can't find your World of Warcraft folder. Add it on the Addon & sync page.");
    }
    let result;
    try {
      result = await exclusive(() => pass({ force: true }));
    } finally {
      changed();
    }
    if (result.failed.length) throw Object.assign(new Error(result.failed[0]), { status: 502 });
    // Nothing went up because the server has no guild for this member yet: say why.
    if (noGuild && !result.uploads && fileList.length) throw Object.assign(new Error(noGuild.reason), { status: 409, code: 'no-guild' });
    if (!fileList.length) say('info', 'No saved data from the addon yet. Log in to a character, then log out or type /reload once.');
    return status();
  }

  function start() {
    if (running) return startPromise || Promise.resolve(status());
    running = true;
    dirty = true;
    schedule();
    const go = enabled && hasToken();
    if (go) say('info', 'Watching your game folders for logouts and reloads.');
    startPromise = (go ? exclusive(() => pass({ force: true })) : Promise.resolve())
      .catch((err) => say('warn', `Sync failed: ${plain(err)}`))
      .then(() => changed());
    changed();
    return startPromise;
  }

  function stop() {
    if (timer) {
      clearTimer(timer);
      timer = null;
    }
    const wasRunning = running;
    running = false;
    startPromise = null;
    stopGen += 1;
    if (coach) coach.cancelled = true;
    wakeSleepers();
    // Retry timers belong to the session that is ending (and so does "no guild yet").
    failures.clear();
    inboxErrors.clear();
    guildWaits.clear();
    noGuild = null;
    lastError = null;
    if (wasRunning) say('info', 'Sync stopped.');
    return changed();
  }

  function setEnabled(value) {
    const next = Boolean(value);
    if (next === enabled) return status();
    enabled = next;
    if (store && store.get().syncEnabled !== next) store.set({ syncEnabled: next });
    say('info', next ? 'Sync is on.' : 'Sync is off. Your game data stays on this computer until you turn it back on.');
    if (!next) {
      failures.clear();
      inboxErrors.clear();
      guildWaits.clear();
      noGuild = null;
      lastError = null;
    }
    return changed();
  }

  /** The member is in a guild now (main.js saw it): waiting files upload at the next check. */
  function clearNoGuild() {
    if (leaveNoGuild()) {
      lastInboxTryAt = 0; // the guild news is due at the next check too
      say('info', "You're in a guild now. Uploading your saved data.");
    }
    return changed();
  }

  /** Resolves when no check, sync or Coach follow-up is running (for tests and shutdown). */
  async function whenIdle() {
    for (;;) {
      const busy = current || (coach && coach.promise) || startPromise;
      if (!busy) return;
      try { await busy; } catch { /* reported already */ }
      if (busy === startPromise) startPromise = null;
    }
  }

  if (store && typeof store.on === 'function') {
    store.on('change', (settings, keys) => {
      if (!Array.isArray(keys)) return;
      if (keys.includes('syncEnabled')) setEnabled(settings.syncEnabled !== false);
      if (keys.includes('serverUrl')) {
        // A different server has none of this data yet.
        seen.clear();
        auctionatorSent.clear();
        failures.clear();
        records.clear();
        guildWaits.clear();
        noGuild = null;
        lastSyncAt = null;
        lastResult = null;
      }
      if (keys.includes('extraWowFolders') || keys.includes('serverUrl')) {
        dirty = true;
        changed();
      }
    });
  }

  return Object.assign(emitter, {
    status,
    syncNow,
    start,
    stop,
    setEnabled,
    clearNoGuild,
    poll,
    followCoach,
    whenIdle,
    rescan: () => { dirty = true; return changed(); },
  });
}

module.exports = {
  createSync,
  noGuildReply,
  inboxToc,
  writeInboxFiles,
  uploadSummary,
  retryDelay,
  describeWait,
  SYNC_DEFAULTS: DEFAULTS,
};
