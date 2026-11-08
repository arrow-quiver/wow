'use strict';
// Finds World of Warcraft game folders ("installs") on this computer.
//
//   findInstalls({ extraRoots, scanDefaults, otherFolders }) →
//     [{ dir, root, flavor, label, addonsDir, wtfDir, accounts: [svFile...], addonInstalled, mainGame, inUse }]
//
// Guild Camp is for WoW Forever. A _forever_ folder, or a game folder with no flavor folder (a private-server
// layout, or one the person picked directly), is the main game and always in use. Every other flavor
// (_retail_, _classic_era_, ...) is listed but left alone (inUse: false: no sync, no automatic addon care)
// until the person turns it on (settings.otherGameFolders, passed as otherFolders).
//
// A root is a "World of Warcraft" folder: one of the usual install places, or a folder the person
// added under Addon & sync (settings.extraWowFolders). Inside a root, every flavor folder
// (_forever_, _retail_, _classic_era_, ...) that has an Interface or WTF folder is an install.
// A root that itself has both Interface and WTF is an install too (some private-server layouts,
// or the person picked the flavor folder directly).
//
// Unlike the old companion, an install counts even when the WowGuild addon is not installed yet:
// the app installs it. `accounts` lists the WowGuild.lua SavedVariables files the addon has
// written so far (WTF/Account/<ACCOUNT>/SavedVariables/WowGuild.lua).
//
//   detectGuild({ extraRoots, scanDefaults }) →
//     { characters: [{ name, realm, guild, faction, level, class, updated, install, account }],
//       guild: { name, realm, faction } | null }
//
// detectGuild reads (never writes) WowGuildDB.characters from every SavedVariables file of every
// install, newest first. `guild` is the in-game guild of the most recently updated character that
// has one. The app sends these characters to the server to work out which guild the person is in.
//
// Plain Node (no Electron). Nothing in here throws because of a missing or unreadable folder.
// Tests: pass scanDefaults: false, or set GUILDCAMP_NO_SCAN=1, so a real game install is never used.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { parseSavedVariables } = require('../shared/lua');

const ADDON = 'WowGuild';
const INBOX_ADDON = 'WowGuild_Inbox';
const FLAVOR_RE = /^_.+_$/;
const MAIN_FLAVOR = '_forever_';

const FLAVOR_LABELS = {
  _forever_: 'WoW Forever',
  _retail_: 'Retail',
  _classic_era_: 'Classic Era',
  _classic_: 'Classic',
  _ptr_: 'PTR',
  _beta_: 'Beta',
};

// Words that are not simply capitalised when a label is made from an unknown flavor folder.
const SPECIAL_WORDS = { ptr: 'PTR', xptr: 'XPTR', wow: 'WoW' };

const DRIVE_LETTERS = 'CDEFGH';
const DRIVE_CACHE_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------------------------
// Small file helpers (never throw)

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

/** Key for comparing paths: Windows paths are case-insensitive. */
function pathKey(p, platform = process.platform) {
  const resolved = path.resolve(String(p));
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

// ---------------------------------------------------------------------------------------------
// Labels

/** The game Guild Camp is for: WoW Forever, or a folder with no flavor (a private-server layout). */
function isMainGame(install) {
  const flavor = install && install.flavor;
  return !flavor || String(flavor).toLowerCase() === MAIN_FLAVOR;
}

/** "_forever_" → "WoW Forever"; unknown flavors are spelled out ("_classic_ptr_" → "Classic PTR"). */
function flavorLabel(flavor) {
  if (!flavor || typeof flavor !== 'string') return 'World of Warcraft';
  const key = flavor.toLowerCase();
  if (FLAVOR_LABELS[key]) return FLAVOR_LABELS[key];
  const words = key.replace(/^_+|_+$/g, '').split(/[_\s]+/).filter(Boolean);
  if (!words.length) return 'World of Warcraft';
  return words.map((w) => SPECIAL_WORDS[w] || w[0].toUpperCase() + w.slice(1)).join(' ');
}

function isFlavorFolder(name) {
  return typeof name === 'string' && FLAVOR_RE.test(name);
}

// Sort order for installs inside one root: WoW Forever first (the game Guild Camp is for), then
// the other known flavors in table order, then anything else alphabetically.
function flavorRank(flavor) {
  const known = Object.keys(FLAVOR_LABELS).indexOf(String(flavor).toLowerCase());
  return known === -1 ? Object.keys(FLAVOR_LABELS).length : known;
}

// ---------------------------------------------------------------------------------------------
// Roots

/**
 * People sometimes pick a folder inside the game folder. Walk back up from
 * .../Interface/AddOns/WowGuild, .../Interface/AddOns, .../Interface or .../WTF.
 */
function normaliseRoot(dir) {
  let d = path.resolve(String(dir));
  const base = (p) => path.basename(p).toLowerCase();
  if (base(d) === ADDON.toLowerCase() && base(path.dirname(d)) === 'addons') d = path.dirname(d);
  if (base(d) === 'addons' && base(path.dirname(d)) === 'interface') d = path.dirname(d);
  if (base(d) === 'interface' || base(d) === 'wtf') d = path.dirname(d);
  return d;
}

let driveCache = null; // { at, list } so a slow (network) drive isn't probed on every scan

function existingDrives(exists) {
  const now = Date.now();
  if (exists === isDir && driveCache && now - driveCache.at < DRIVE_CACHE_MS) return driveCache.list;
  const list = DRIVE_LETTERS.split('').filter((d) => exists(`${d}:\\`));
  if (exists === isDir) driveCache = { at: now, list };
  return list;
}

/**
 * The usual places a World of Warcraft folder lives: the old companion's list plus the common
 * folders on every drive from C: to H: that exists.
 *
 * @param {object} [o] injectable for tests
 * @param {string} [o.platform=process.platform]
 * @param {(dir: string) => boolean} [o.exists] does a drive root exist
 * @param {string} [o.home=os.homedir()]
 */
function defaultRoots({ platform = process.platform, exists = isDir, home } = {}) {
  const roots = [];
  if (platform === 'win32') {
    for (const d of existingDrives(exists)) {
      roots.push(
        `${d}:\\Program Files (x86)\\World of Warcraft`,
        `${d}:\\Program Files\\World of Warcraft`,
        `${d}:\\World of Warcraft`,
        `${d}:\\Games\\World of Warcraft`,
        `${d}:\\Battle.net\\World of Warcraft`,
      );
    }
    return roots;
  }
  let homeDir = home;
  if (homeDir === undefined) {
    try { homeDir = os.homedir(); } catch { homeDir = ''; }
  }
  roots.push('/Applications/World of Warcraft');
  if (homeDir) {
    if (platform === 'darwin') {
      roots.push(path.posix.join(homeDir, 'Applications', 'World of Warcraft'));
    } else {
      // Wine and Lutris prefixes on Linux.
      roots.push(
        path.posix.join(homeDir, 'Games', 'world-of-warcraft', 'drive_c', 'Program Files (x86)', 'World of Warcraft'),
        path.posix.join(homeDir, '.wine', 'drive_c', 'Program Files (x86)', 'World of Warcraft'),
      );
    }
  }
  return roots;
}

function scanningDisabled(env = process.env) {
  const v = String(env.GUILDCAMP_NO_SCAN || '').trim().toLowerCase();
  return v !== '' && v !== '0' && v !== 'false' && v !== 'no';
}

// ---------------------------------------------------------------------------------------------
// Installs

/** WTF/Account/<ACCOUNT>/SavedVariables/WowGuild.lua files that exist, sorted. Never throws. */
function savedVariablesFiles(gameDir, addon = ADDON) {
  if (typeof gameDir !== 'string' || !gameDir) return [];
  const acctRoot = path.join(gameDir, 'WTF', 'Account');
  let names;
  try {
    names = fs.readdirSync(acctRoot);
  } catch {
    return [];
  }
  return names
    // WTF/Account/SavedVariables holds Blizzard's account-wide data, not an account.
    .filter((name) => name.toLowerCase() !== 'savedvariables')
    .map((name) => path.join(acctRoot, name, 'SavedVariables', `${addon}.lua`))
    .filter(isFile)
    .sort((a, b) => a.localeCompare(b));
}

/** .../WTF/Account/ACCOUNT1/SavedVariables/WowGuild.lua → "ACCOUNT1". */
function accountName(svFile) {
  return path.basename(path.dirname(path.dirname(String(svFile || ''))));
}

function describeInstall(dir, root, flavor) {
  const addonsDir = path.join(dir, 'Interface', 'AddOns');
  let label;
  if (flavor) label = flavorLabel(flavor);
  else label = path.basename(dir) || 'World of Warcraft';
  return {
    dir,
    root,
    flavor: flavor || null,
    label,
    addonsDir,
    wtfDir: path.join(dir, 'WTF'),
    accounts: savedVariablesFiles(dir),
    addonInstalled: isDir(path.join(addonsDir, ADDON)),
  };
}

/** Installs inside (or at) one root, in display order. */
function installsInRoot(root) {
  const found = [];
  const has = (dir, sub) => isDir(path.join(dir, sub));
  const ownName = path.basename(root);

  if (isFlavorFolder(ownName)) {
    // The person picked a flavor folder itself.
    if (has(root, 'Interface') || has(root, 'WTF')) found.push(describeInstall(root, root, ownName));
  } else if (has(root, 'Interface') && has(root, 'WTF')) {
    found.push(describeInstall(root, root, null));
  }

  let entries = [];
  try {
    entries = fs.readdirSync(root);
  } catch {
    entries = [];
  }
  const flavors = entries
    .filter(isFlavorFolder)
    .sort((a, b) => flavorRank(a) - flavorRank(b) || a.localeCompare(b));
  for (const name of flavors) {
    const dir = path.join(root, name);
    if (!isDir(dir)) continue;
    if (has(dir, 'Interface') || has(dir, 'WTF')) found.push(describeInstall(dir, root, name));
  }
  return found;
}

/**
 * @param {object} [opts]
 * @param {string[]} [opts.extraRoots=[]]   folders the person added (settings.extraWowFolders)
 * @param {boolean} [opts.scanDefaults=true] also look in the usual install places
 *                                          (GUILDCAMP_NO_SCAN=1 turns this off)
 */
function findInstalls({ extraRoots = [], scanDefaults = true, otherFolders = [] } = {}) {
  const others = new Set();
  for (const d of Array.isArray(otherFolders) ? otherFolders : []) {
    if (typeof d === 'string' && d.trim()) { try { others.add(pathKey(d.trim())); } catch { /* not a path */ } }
  }
  const roots = [];
  for (const r of Array.isArray(extraRoots) ? extraRoots : []) {
    // Only full paths: a relative one would depend on where the app happened to start.
    if (typeof r !== 'string' || !r.trim() || r.includes('\0') || !path.isAbsolute(r.trim())) continue;
    try { roots.push(normaliseRoot(r.trim())); } catch { /* not a usable path */ }
  }
  if (scanDefaults && !scanningDisabled()) {
    try { roots.push(...defaultRoots()); } catch { /* no defaults then */ }
  }

  const seenRoots = new Set();
  const seenInstalls = new Set();
  const out = [];
  for (const root of roots) {
    let key;
    try { key = pathKey(root); } catch { continue; }
    if (seenRoots.has(key)) continue;
    seenRoots.add(key);
    if (!isDir(root)) continue;
    let list = [];
    try { list = installsInRoot(path.resolve(root)); } catch { list = []; }
    for (const install of list) {
      const k = pathKey(install.dir);
      if (seenInstalls.has(k)) continue; // the same game folder reached from two roots
      seenInstalls.add(k);
      const mainGame = isMainGame(install);
      out.push({ ...install, mainGame, inUse: mainGame || others.has(k) });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Which characters (and guild) the addon has seen on this computer

const SV_CACHE_SIZE = 64;
// pathKey(file) → { mtimeMs, size, characters }: WowGuildDB can be several MB, and the app asks
// every minute while it waits to match a guild, so a file is only parsed again when it changed.
const svCache = new Map();

function cleanText(value, max) {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  return t ? t.slice(0, max) : null;
}

function cleanNumber(value) {
  const n = Number(value);
  return value !== null && value !== '' && Number.isFinite(n) ? n : null;
}

/** WowGuildDB.characters (a name → record table, or a list) → plain character rows. */
function readCharacters(db) {
  const table = db && typeof db === 'object' ? db.characters : null;
  if (!table || typeof table !== 'object') return [];
  const entries = Array.isArray(table) ? table.map((rec) => [null, rec]) : Object.entries(table);
  const out = [];
  for (const [key, rec] of entries) {
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) continue;
    const name = cleanText(rec.name, 40) || cleanText(key, 40);
    if (!name) continue;
    const level = cleanNumber(rec.level);
    out.push({
      name,
      realm: cleanText(rec.realm, 60),
      guild: cleanText(rec.guild, 60),
      faction: cleanText(rec.faction, 10),
      level: level === null ? null : Math.max(0, Math.floor(level)),
      class: cleanText(rec.class, 20),
      updated: cleanNumber(rec.updated),
    });
  }
  return out;
}

/** Characters saved in one WowGuild.lua (read-only, cached by modification time). Never throws. */
function charactersInFile(svFile) {
  let st;
  try { st = fs.statSync(svFile); } catch { return []; }
  const key = pathKey(svFile);
  const hit = svCache.get(key);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.characters;
  let characters = [];
  try {
    characters = readCharacters(parseSavedVariables(fs.readFileSync(svFile)).WowGuildDB);
  } catch {
    characters = []; // half written or not ours: the next save is read again
  }
  svCache.delete(key);
  svCache.set(key, { mtimeMs: st.mtimeMs, size: st.size, characters });
  while (svCache.size > SV_CACHE_SIZE) svCache.delete(svCache.keys().next().value);
  return characters;
}

/**
 * Every character the addon has saved, newest first, and the guild of the newest one in a guild.
 * @param {object} [opts]
 * @param {string[]} [opts.extraRoots=[]]    settings.extraWowFolders
 * @param {boolean} [opts.scanDefaults=true] also look in the usual install places
 * @param {object[]} [opts.installs]         use these installs instead of looking (findInstalls() shape)
 * @returns {{ characters: object[], guild: { name, realm, faction } | null }}
 */
function detectGuild({ extraRoots = [], scanDefaults = true, otherFolders = [], installs } = {}) {
  let list = installs;
  if (!Array.isArray(list)) {
    try { list = findInstalls({ extraRoots, scanDefaults, otherFolders }); } catch { list = []; }
  }
  list = list.filter((i) => i && i.inUse !== false);
  const byKey = new Map();
  for (const install of list) {
    if (!install || typeof install.dir !== 'string') continue;
    for (const file of savedVariablesFiles(install.dir)) {
      for (const c of charactersInFile(file)) {
        const row = { ...c, install: install.dir, account: accountName(file) };
        // The same character seen twice (a copied WTF folder, say): keep the newest record.
        const k = `${c.name.toLowerCase()}|${(c.realm || '').toLowerCase()}`;
        const prev = byKey.get(k);
        if (!prev || (row.updated || 0) > (prev.updated || 0)) byKey.set(k, row);
      }
    }
  }
  const characters = [...byKey.values()].sort((a, b) => (b.updated || 0) - (a.updated || 0)
    || a.name.localeCompare(b.name));
  const inGuild = characters.find((c) => c.guild);
  return {
    characters,
    guild: inGuild ? { name: inGuild.guild, realm: inGuild.realm, faction: inGuild.faction } : null,
  };
}

// ---------------------------------------------------------------------------------------------
// Is the game running? Best effort, only used for hints in the UI ("WoW saves your data when you
// log out or type /reload"). Resolves true/false, or null when it can't tell.

const WIN_GAME_EXE = /^wow(classic|forever)?(t|b|beta|-64)?\.exe$/i;
const UNIX_GAME_PROC = /^(world of warcraft|wow(classic|forever)?(t|b|beta|-64)?(\.exe)?)$/i;

function runCommand(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout));
    });
  });
}

/**
 * @param {object} [o] injectable for tests
 * @param {string} [o.platform=process.platform]
 * @param {(cmd: string, args: string[]) => Promise<string>} [o.exec]
 * @returns {Promise<boolean|null>}
 */
async function isWowRunning({ platform = process.platform, exec = runCommand } = {}) {
  try {
    if (platform === 'win32') {
      const out = await exec('tasklist', ['/FO', 'CSV', '/NH']);
      return out.split(/\r?\n/).some((line) => {
        const m = /^"([^"]+)"/.exec(line.trim());
        return Boolean(m && WIN_GAME_EXE.test(m[1]));
      });
    }
    const out = await exec('ps', ['-A', '-o', 'comm=']);
    return out.split(/\r?\n/).some((line) => {
      const name = line.trim().split('/').pop();
      return Boolean(name && UNIX_GAME_PROC.test(name));
    });
  } catch {
    return null;
  }
}

/**
 * The process ids of the running game clients: [] when none runs, null when it can't tell. sync.js uses them to see
 * that the game session it wrote a new news folder in has ended, also after a quick restart it never saw closed.
 * @param {object} [o] injectable for tests (as isWowRunning)
 * @returns {Promise<number[]|null>}
 */
async function gameProcessIds({ platform = process.platform, exec = runCommand } = {}) {
  try {
    const ids = [];
    if (platform === 'win32') {
      // "Wow.exe","12345","Console","1","2,000,000 K"
      const out = await exec('tasklist', ['/FO', 'CSV', '/NH']);
      for (const line of out.split(/\r?\n/)) {
        const m = /^"([^"]+)","(\d+)"/.exec(line.trim());
        if (m && WIN_GAME_EXE.test(m[1])) ids.push(Number(m[2]));
      }
      return ids;
    }
    // "  4321 /Applications/World of Warcraft/_retail_/World of Warcraft.app/Contents/MacOS/World of Warcraft"
    const out = await exec('ps', ['-A', '-o', 'pid=,comm=']);
    for (const line of out.split(/\r?\n/)) {
      const m = /^\s*(\d+)\s+(.+)$/.exec(line);
      const name = m && m[2].trim().split('/').pop();
      if (name && UNIX_GAME_PROC.test(name)) ids.push(Number(m[1]));
    }
    return ids;
  } catch {
    return null;
  }
}

module.exports = {
  findInstalls,
  detectGuild,
  readCharacters,
  savedVariablesFiles,
  accountName,
  flavorLabel,
  isMainGame,
  defaultRoots,
  normaliseRoot,
  isWowRunning,
  gameProcessIds,
  pathKey,
  FLAVOR_LABELS,
  MAIN_FLAVOR,
  ADDON,
  INBOX_ADDON,
};
