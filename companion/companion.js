#!/usr/bin/env node
// wow companion: uploads the WowGuild addon's saved data to the guild site
// whenever WoW writes it (logout or /reload), and writes the site's news back
// into the addon so it shows in game on the next reload.
//
// Usage:  node companion.js            keep running and watch
//         node companion.js --once     upload once and exit
//         node companion.js --check    show what it found and exit

const fs = require('fs');
const path = require('path');
const { parseSavedVariables } = require('./lua');

const IS_EXE = Boolean(process.pkg) || (() => { try { return require('node:sea').isSea(); } catch { return false; } })();
const APP_DIR = IS_EXE ? path.dirname(process.execPath) : __dirname;
const CONFIG_FILE = process.env.WOW_COMPANION_CONFIG || path.join(APP_DIR, 'config.json');
const ADDON = 'WowGuild';
const POLL_MS = 4000;
const INBOX_REFRESH_MS = 5 * 60 * 1000;

const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);

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
    headers: { Authorization: `Bearer ${cfg.syncKey}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
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

async function upload(cfg, file) {
  const parsed = parseSavedVariables(fs.readFileSync(file));
  const db = parsed.WowGuildDB;
  if (!db) { log(`No data in ${file} yet. Log in and out once.`); return; }
  const result = JSON.parse(await api(cfg, 'POST', '/api/sync', db));
  log(`Uploaded: ${result.characters} character(s), ${result.roster} roster entries, ${result.recipes} recipes${result.ctas ? `, ${result.ctas} call(s) to arms` : ''}.`);
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
  const cfg = loadConfig();
  const games = findGameFolders(cfg);
  if (!games.length) {
    throw new Error('Could not find a WoW folder with the WowGuild addon installed. Put the full path of your game folder '
      + '(the one containing Interface and WTF, e.g. C:\\Program Files (x86)\\World of Warcraft\\_forever_) in config.json as "wowFolder".');
  }
  for (const g of games) log(`Game folder: ${g} (${savedVariablesFiles(g).length} account(s) with saved data)`);
  if (args.has('--check')) return;

  const seen = new Map();
  const syncAll = async (force) => {
    for (const g of games) {
      let uploaded = false;
      for (const f of savedVariablesFiles(g)) {
        const m = fs.statSync(f).mtimeMs;
        if (!force && seen.get(f) === m) continue;
        // Wait until WoW has finished writing the file.
        await new Promise((r) => setTimeout(r, force ? 0 : 1500));
        if (fs.statSync(f).mtimeMs !== m && !force) continue;
        try { await upload(cfg, f); uploaded = true; seen.set(f, m); } catch (e) { log(e.message); }
      }
      if (uploaded || force) {
        try { await writeInbox(cfg, g); log('Guild news saved for the addon. It shows after your next /reload.'); } catch (e) { log(e.message); }
      }
    }
  };

  await syncAll(true);
  if (args.has('--once')) return;
  log('Watching for logouts and reloads. Leave this window open while you play.');
  setInterval(() => syncAll(false).catch((e) => log(e.message)), POLL_MS);
  setInterval(async () => {
    for (const g of games) { try { await writeInbox(cfg, g); } catch (e) { log(e.message); } }
  }, INBOX_REFRESH_MS);
}

if (require.main === module) {
  main().catch((e) => { console.error(e.message); if (process.platform === 'win32' && !process.argv.includes('--once')) setTimeout(() => {}, 60000); process.exitCode = 1; });
}

module.exports = { findGameFolders, savedVariablesFiles };
