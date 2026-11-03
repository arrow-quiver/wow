#!/usr/bin/env node
// wow companion: uploads the WowGuild addon's saved data to the guild site
// whenever WoW writes it (logout or /reload), and writes the site's news back
// into the addon so it shows in game on the next reload.
//
// Usage:  node companion.js            keep running and watch
//         node companion.js --once     upload once and exit
//         node companion.js --check    show what it found and exit
//         wow-companion.exe --install-startup     start automatically with Windows
//         wow-companion.exe --uninstall-startup   stop starting with Windows

const fs = require('fs');
const path = require('path');
const { parseSavedVariables } = require('./lua');

const IS_EXE = Boolean(process.pkg) || (() => { try { return require('node:sea').isSea(); } catch { return false; } })();
const APP_DIR = IS_EXE ? path.dirname(process.execPath) : __dirname;
const CONFIG_FILE = process.env.WOW_COMPANION_CONFIG || path.join(APP_DIR, 'config.json');
const ADDON = 'WowGuild';
const POLL_MS = 4000;
const INBOX_REFRESH_MS = 5 * 60 * 1000;

const VERSION = require('./package.json').version;
const LOG_FILE = path.join(APP_DIR, 'companion.log');

// Log to the window and to companion.log (kept under 1 MB) so problems can be shared.
function log(...a) {
  const line = `${new Date().toLocaleTimeString()} ${a.join(' ')}`;
  console.log(line);
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 1024 * 1024) fs.renameSync(LOG_FILE, LOG_FILE + '.old');
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${a.join(' ')}\n`);
  } catch { /* logging must never stop the companion */ }
}

function versionLess(a, b) {
  const pa = String(a || '').split('.').map(Number); const pb = String(b || '').split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0);
  return false;
}

// Start with Windows: a small .cmd in the user's Startup folder.
function startupFile() {
  return path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'wow-companion.cmd');
}
function installStartup() {
  if (process.platform !== 'win32') throw new Error('Starting with Windows only works on Windows.');
  const cmd = IS_EXE ? `start "" /min "${process.execPath}"` : `start "" /min "${process.execPath}" "${path.join(__dirname, 'companion.js')}"`;
  fs.writeFileSync(startupFile(), `@echo off\r\ncd /d "${APP_DIR}"\r\n${cmd}\r\n`);
  return startupFile();
}
function uninstallStartup() {
  if (fs.existsSync(startupFile())) { fs.unlinkSync(startupFile()); return true; }
  return false;
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ siteUrl: 'https://wow.example.com', syncKey: 'paste-your-sync-key-here', wowFolder: '' }, null, 2));
    throw new Error(`Created ${CONFIG_FILE}. Fill in siteUrl and syncKey (from the website's Settings page), then start again.`);
  }
  const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  if (!cfg.syncKey || !cfg.syncKey.startsWith('wowg_')) throw new Error('config.json: syncKey is missing. Create one on the website under Settings.');
  if (!/^https?:\/\//.test(cfg.siteUrl || '')) throw new Error('config.json: siteUrl must start with https://');
  cfg.siteUrl = cfg.siteUrl.replace(/\/$/, '');
  return cfg;
}

// Find game folders (e.g. _forever_, _retail_) that have our addon installed.
function findGameFolders(cfg) {
  const roots = [];
  if (cfg.wowFolder) roots.push(cfg.wowFolder);
  roots.push(
    'C:\\Program Files (x86)\\World of Warcraft', 'C:\\Program Files\\World of Warcraft',
    'D:\\World of Warcraft', 'D:\\Games\\World of Warcraft', 'E:\\World of Warcraft',
    '/Applications/World of Warcraft',
  );
  const found = new Set();
  for (const root of roots) {
    if (!root || !fs.existsSync(root)) continue;
    const candidates = [root];
    try { for (const d of fs.readdirSync(root)) if (/^_.+_$/.test(d)) candidates.push(path.join(root, d)); } catch { /* ignore */ }
    for (const c of candidates) {
      if (fs.existsSync(path.join(c, 'Interface', 'AddOns', ADDON)) && fs.existsSync(path.join(c, 'WTF'))) found.add(path.resolve(c));
    }
  }
  return [...found];
}

function savedVariablesFiles(gameDir) {
  const acctRoot = path.join(gameDir, 'WTF', 'Account');
  if (!fs.existsSync(acctRoot)) return [];
  return fs.readdirSync(acctRoot)
    .map((a) => path.join(acctRoot, a, 'SavedVariables', `${ADDON}.lua`))
    .filter((f) => fs.existsSync(f));
}

async function api(cfg, method, route, body) {
  const res = await fetch(cfg.siteUrl + route, {
    method,
    headers: { Authorization: `Bearer ${cfg.syncKey}`, 'X-Companion-Version': VERSION, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try { msg = JSON.parse(text).error || text; } catch { /* plain text */ }
    throw new Error(`${route} failed (${res.status}): ${msg.slice(0, 200)}`);
  }
  return text;
}

// Auctionator keeps its scan results in its own SavedVariables file next to ours.
// We send the minimum price per item for days scanned in the last two weeks.
const auctionatorSent = new Map(); // file → mtime already uploaded
function auctionatorPrices(svFile) {
  const file = path.join(path.dirname(svFile), 'Auctionator.lua');
  if (!fs.existsSync(file)) return null;
  const m = fs.statSync(file).mtimeMs;
  if (auctionatorSent.get(file) === m) return null;
  try {
    const db = parseSavedVariables(fs.readFileSync(file)).AUCTIONATOR_PRICE_DATABASE;
    if (!db || typeof db !== 'object') return null;
    return { file, mtime: m, prices: extractPrices(db) };
  } catch (e) {
    log(`Couldn't read Auctionator prices (${e.message}). Everything else still uploads.`);
    auctionatorSent.set(file, m);
    return null;
  }
}

function extractPrices(db, now = Date.now()) {
  const today = Math.floor((now - Date.UTC(2020, 0, 1)) / 86400000);
  const best = new Map(); // itemId → [price, day]
  for (const [realm, items] of Object.entries(db)) {
    if (realm.startsWith('__') || !items || typeof items !== 'object') continue;
    for (const [key, rec] of Object.entries(items)) {
      const m = /^(?:g:)?(\d+)/.exec(key);
      if (!m || !rec || typeof rec !== 'object') continue;
      const days = rec.h && typeof rec.h === 'object' ? Object.keys(rec.h).map(Number).filter(Number.isFinite) : [];
      const day = days.length ? Math.max(...days) : null;
      const price = Number(rec.m) || (day != null ? Number(rec.h[String(day)]) : 0);
      if (!price || day == null || today - day > 14) continue;
      const id = Number(m[1]);
      const prev = best.get(id);
      if (!prev || day > prev[1] || (day === prev[1] && price < prev[0])) best.set(id, [price, day]);
    }
  }
  return { items: [...best].map(([id, [price, day]]) => [id, price, day]) };
}

async function upload(cfg, file) {
  const parsed = parseSavedVariables(fs.readFileSync(file));
  const db = parsed.WowGuildDB;
  if (!db) { log(`No data in ${file} yet. Log in and out once.`); return; }
  const auc = auctionatorPrices(file);
  if (auc) db.prices = auc.prices;
  const result = JSON.parse(await api(cfg, 'POST', '/api/sync', db));
  if (auc) auctionatorSent.set(auc.file, auc.mtime);
  if (result.latest && result.latest.companion && versionLess(VERSION, result.latest.companion) && !upload.nagged) {
    upload.nagged = true;
    log(`A newer companion (${result.latest.companion}) is available at ${cfg.siteUrl}/get (you have ${VERSION}).`);
  }
  const extra = [result.ctas ? `${result.ctas} call(s) to arms` : '', result.prices ? `${result.prices} auction prices` : '', result.bank ? `${result.bank} guild bank items` : ''].filter(Boolean);
  log(`Uploaded: ${result.characters} character(s), ${result.roster} roster entries, ${result.recipes} recipes${extra.length ? `, ${extra.join(', ')}` : ''}.`);
}

async function writeInbox(cfg, gameDir) {
  const lua = await api(cfg, 'GET', '/api/inbox.lua');
  const target = path.join(gameDir, 'Interface', 'AddOns', ADDON, 'Data', 'Inbox.lua');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, lua);
  fs.renameSync(tmp, target);
}

async function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has('--install-startup')) { log(`Will start with Windows: ${installStartup()}`); return; }
  if (args.has('--uninstall-startup')) { log(uninstallStartup() ? 'Removed from Windows startup.' : 'It wasn’t set to start with Windows.'); return; }
  log(`wow companion ${VERSION}`);
  const cfg = loadConfig();
  const games = findGameFolders(cfg);
  if (!games.length) {
    throw new Error('Could not find a WoW folder with the WowGuild addon installed. Put the full path of your game folder '
      + '(the one containing Interface and WTF, e.g. C:\\Program Files (x86)\\World of Warcraft\\_forever_) in config.json as "wowFolder".');
  }
  for (const g of games) log(`Game folder: ${g} (${savedVariablesFiles(g).length} account(s) with saved data)`);
  // Check the site and sync key before watching, so setup problems are obvious.
  try {
    await api(cfg, 'GET', '/api/inbox');
    log(`Connected to ${cfg.siteUrl}.`);
  } catch (e) {
    if (/\(401\)/.test(e.message)) throw new Error('The site doesn’t recognise your sync key. Create a new one on the site under Settings and paste it into config.json.');
    log(`Can't reach ${cfg.siteUrl} right now (${e.message}). Will keep trying.`);
  }
  if (args.has('--check')) return;

  const seen = new Map();
  const failures = new Map(); // file → { count, retryAt }
  let busy = false;
  const syncAll = async (force) => {
    if (busy) return; // a slow upload must not overlap the next poll
    busy = true;
    try {
      for (const g of games) {
        let uploaded = false;
        for (const f of savedVariablesFiles(g)) {
          const m = fs.statSync(f).mtimeMs;
          const fail = failures.get(f);
          if (!force && seen.get(f) === m) continue;
          if (!force && fail && Date.now() < fail.retryAt) continue;
          // Wait until WoW has finished writing the file.
          await new Promise((r) => setTimeout(r, force ? 0 : 1500));
          if (fs.statSync(f).mtimeMs !== m && !force) continue;
          try {
            await upload(cfg, f); uploaded = true; seen.set(f, m); failures.delete(f);
          } catch (e) {
            const count = (fail ? fail.count : 0) + 1;
            const wait = Math.min(5 * 60, 5 * 2 ** (count - 1)); // 5s, 10s, 20s ... up to 5 min
            failures.set(f, { count, retryAt: Date.now() + wait * 1000 });
            log(`${e.message} Trying again in ${wait < 60 ? `${wait}s` : `${Math.round(wait / 60)} min`}.`);
          }
        }
        if (uploaded || force) {
          try { await writeInbox(cfg, g); log('Guild news saved for the addon. It shows after your next /reload.'); } catch (e) { log(e.message); }
        }
      }
    } finally { busy = false; }
  };

  await syncAll(true);
  if (args.has('--once')) return;
  log('Watching for logouts and reloads. Leave this window open while you play (or run with --install-startup).');
  setInterval(() => syncAll(false).catch((e) => log(e.message)), POLL_MS);
  setInterval(async () => {
    for (const g of games) { try { await writeInbox(cfg, g); } catch (e) { log(e.message); } }
  }, INBOX_REFRESH_MS);
  process.on('SIGINT', () => { log('Stopped.'); process.exit(0); });
}

if (require.main === module) {
  main().catch((e) => { log(`Problem: ${e.message}`); if (process.platform === 'win32' && !process.argv.includes('--once')) setTimeout(() => {}, 60000); process.exitCode = 1; });
}

module.exports = { findGameFolders, savedVariablesFiles, extractPrices, versionLess };
