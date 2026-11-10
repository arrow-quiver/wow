'use strict';
// Live link: follows the game's combat log (Logs/WoWCombatLog*.txt) while you play, so the app knows about kills,
// deaths and fights without waiting for a /reload. The game writes that file itself while combat logging is on
// (/combatlog, or "/wow live on" in the addon, which turns it on at every login). Reading it is how Warcraft Logs'
// live uploader works too; nothing touches the game.
//
//   const live = createLive({ findInstalls, myNames, log, now, pollMs })
//   live.start(); live.stop()
//   live.state() → { status: 'off'|'waiting'|'live', file, since, session, lastDeath, hint }
//   live.on('update', (state) => …); live.on('death', (death) => …)
//
// Starts at the end of the newest log (no replay of old sessions), reads what was added once a second, and looks
// for a newer file every 30 s (Retail starts a new file per session; Classic keeps appending to one).

const { baseName } = require('../shared/names');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { parseLine, createSession, deathText, sessionText } = require('../shared/combatlog');

const LIVE_MS = 120 * 1000;      // events within the last 2 minutes: "live"
const FRESH_FILE_MS = 6 * 3600 * 1000;
const MAX_READ = 4 * 1024 * 1024;

function newestLog(installs) {
  let best = null;
  for (const inst of installs || []) {
    const dir = path.join(inst.dir, 'Logs');
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (!/^WoWCombatLog.*\.txt$/i.test(n)) continue;
      const file = path.join(dir, n);
      let st; try { st = fs.statSync(file); } catch { continue; }
      if (!best || st.mtimeMs > best.mtimeMs) best = { file, size: st.size, mtimeMs: st.mtimeMs, install: inst };
    }
  }
  return best;
}

function createLive({ findInstalls, myNames = async () => [], log = console, now = () => Date.now(), pollMs = 1000, rescanMs = 30000 } = {}) {
  const em = new EventEmitter();
  let current = null; // { file, offset, install }
  let session = createSession();
  let partial = '';
  let timer = null; let rescanTimer = null; let namesTimer = null;
  let lastSeen = null;
  let reading = false;

  function state() {
    const sum = session.summary();
    const t = now();
    const status = !current ? 'off' : (sum.lastAt && t - lastSeen < LIVE_MS ? 'live' : 'waiting');
    return {
      status,
      file: current ? current.file : null,
      game: current && current.install ? current.install.label : null,
      session: sum.lastAt ? sum : null,
      lastDeath: session.lastDeath,
      // Plain text for the Coach (POST /api/coach/ask { live }).
      context: { death: deathText(session.lastDeath) || null, session: sum.lastAt ? sessionText(sum) : null },
      hint: status === 'off'
        ? 'Turn on combat logging in game: type /combatlog (or /wow live on to have the addon do it at every login).'
        : status === 'waiting' ? 'Combat logging is on. The live link picks up your next fight.' : null,
    };
  }

  async function refreshNames() {
    try { const n = await myNames(); if (Array.isArray(n) && n.length) session.setNames(n); } catch (err) { log.warn(`Live link couldn't read your characters: ${err.message}`); }
  }

  function rescan() {
    let found = null;
    try { found = newestLog(findInstalls()); } catch (err) { log.warn(`Live link couldn't look for combat logs: ${err.message}`); }
    if (!found || now() - found.mtimeMs > FRESH_FILE_MS) {
      if (current && !found) { current = null; em.emit('update', state()); }
      return;
    }
    if (!current || current.file !== found.file) {
      // A new file: start at its end, and a new session.
      const isNew = Boolean(current);
      current = { file: found.file, offset: found.size, install: found.install };
      partial = '';
      if (isNew) session = createSession();
      refreshNames();
      log.info(`Live link: following ${found.file}.`);
      em.emit('update', state());
    }
  }

  function readMore() {
    if (!current || reading) return;
    let st;
    try { st = fs.statSync(current.file); } catch { current = null; em.emit('update', state()); return; }
    if (st.size < current.offset) { current.offset = 0; partial = ''; } // the game started the file again
    if (st.size === current.offset) return;
    reading = true;
    try {
      const len = Math.min(st.size - current.offset, MAX_READ);
      const buf = Buffer.alloc(len);
      const fd = fs.openSync(current.file, 'r');
      try { fs.readSync(fd, buf, 0, len, current.offset); } finally { fs.closeSync(fd); }
      current.offset += len;
      const text = partial + buf.toString('utf8');
      const lines = text.split('\n');
      partial = lines.pop();
      let changed = false;
      for (const line of lines) {
        const e = parseLine(line);
        if (!e) continue;
        const before = session.lastDeath;
        const entry = session.add(e);
        if (entry) { changed = true; lastSeen = now(); }
        if (session.lastDeath && session.lastDeath !== before) em.emit('death', session.lastDeath);
      }
      if (changed) em.emit('update', state());
    } catch (err) {
      log.warn(`Live link couldn't read the combat log: ${err.message}`);
    } finally { reading = false; }
  }

  return {
    start() {
      if (timer) return;
      rescan();
      refreshNames();
      timer = setInterval(readMore, pollMs);
      rescanTimer = setInterval(rescan, rescanMs);
      namesTimer = setInterval(refreshNames, 5 * 60 * 1000);
      for (const t of [timer, rescanTimer, namesTimer]) if (t.unref) t.unref();
    },
    stop() { for (const t of [timer, rescanTimer, namesTimer]) clearInterval(t); timer = rescanTimer = namesTimer = null; },
    state,
    tick() { rescan(); readMore(); }, // for tests
    on: (ev, fn) => { em.on(ev, fn); return () => em.off(ev, fn); },
  };
}

// ---------- the chat log: my calls to arms, for Discord ----------
// The addon also says each call to arms in guild chat, as
// "[Guild Camp] Call to arms: Hillsbrad Foothills (3 needed): help at the mill! — from Grom" (Core.lua ns.ctaText).
// While chat logging is on (/chatlog, or /wow live on) the game writes it to Logs/WoWChatLog*.txt.
const CTA = /\[Guild Camp\] Call to arms: (.+?) — from ([^\s—]+)\s*$/;
// The sender: the chat log's line is "<date> <time>  [Guild] Grom-Zuljin: [Guild Camp] …", and the first name after
// the channel tag must be who the line says it's from, with the Guild Camp text right after it. So a guildmate typing
// "[Guild Camp] … — from <my character>" (or "Grom: [Guild Camp] …" inside their own message) can't post to my
// Discord. A line without a sender is refused.
// The sender may show a surname ("[Guild] Gorm Tshabalala: …"): the character is its first word.
const SENDER = /^\d+\/\d+ [\d:.]+\s+\[[^\]]+\] ([^:\]]+?): \[Guild Camp\] /;
function senderOk(line, from) {
  const s = SENDER.exec(String(line || ''));
  return Boolean(s) && baseName(s[1]).toLowerCase() === baseName(from).toLowerCase();
}

function parseCta(line) {
  const m = CTA.exec(String(line || '').replace(/\r$/, ''));
  if (!m || !senderOk(line, m[2])) return null;
  const body = /^(.*?)(?: \((\d+) needed\))?(?:: (.*))?$/.exec(m[1]);
  return { character: m[2].split('-')[0], zone: body[1], needed: body[2] ? Number(body[2]) : null, message: body[3] || '' };
}

// Any other Guild Camp line (Celebrate.lua): "[Guild Camp] Grom reached level 40! — from Grom" → { what, from }.
const ANY = /\[Guild Camp\] (.+?) — from ([^\s—]+)\s*$/;
function parseGuildCamp(line) {
  const m = ANY.exec(String(line || '').replace(/\r$/, ''));
  return m && senderOk(line, m[2]) ? { what: m[1], from: m[2].split('-')[0] } : null;
}

function newestChatLog(installs) {
  let best = null;
  for (const inst of installs || []) {
    const dir = path.join(inst.dir, 'Logs');
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (!/^WoWChatLog.*\.txt$/i.test(n)) continue;
      const file = path.join(dir, n);
      let st; try { st = fs.statSync(file); } catch { continue; }
      if (!best || st.mtimeMs > best.mtimeMs) best = { file, size: st.size, mtimeMs: st.mtimeMs };
    }
  }
  return best;
}

//   const chat = createChatWatch({ findInstalls, log }); chat.on('cta', ({ character, zone, needed, message }) => …)
// Starts at the end of the newest chat log (old lines are never sent again) and reads what's added every 2 s.
function createChatWatch({ findInstalls, log = console, pollMs = 2000, rescanMs = 30000 } = {}) {
  const em = new EventEmitter();
  let current = null; let partial = ''; let timer = null; let rescanTimer = null;
  function rescan() {
    let found = null;
    try { found = newestChatLog(findInstalls()); } catch { /* no game folder */ }
    if (!found) { current = null; return; }
    if (!current || current.file !== found.file) { current = { file: found.file, offset: found.size }; partial = ''; }
  }
  function readMore() {
    if (!current) return;
    let st; try { st = fs.statSync(current.file); } catch { current = null; return; }
    if (st.size < current.offset) { current.offset = 0; partial = ''; }
    if (st.size === current.offset) return;
    try {
      const len = Math.min(st.size - current.offset, MAX_READ);
      const buf = Buffer.alloc(len);
      const fd = fs.openSync(current.file, 'r');
      try { fs.readSync(fd, buf, 0, len, current.offset); } finally { fs.closeSync(fd); }
      current.offset += len;
      const lines = (partial + buf.toString('utf8')).split('\n');
      partial = lines.pop();
      for (const line of lines) {
        const c = parseCta(line);
        if (c) { em.emit('cta', c); continue; }
        const g = parseGuildCamp(line);
        if (g) em.emit('celebrate', g);
      }
    } catch (err) { log.warn(`Couldn't read the chat log: ${err.message}`); }
  }
  return {
    start() {
      if (timer) return;
      rescan();
      timer = setInterval(readMore, pollMs); rescanTimer = setInterval(rescan, rescanMs);
      for (const t of [timer, rescanTimer]) if (t.unref) t.unref();
    },
    stop() { clearInterval(timer); clearInterval(rescanTimer); timer = rescanTimer = null; },
    tick() { rescan(); readMore(); },
    on: (ev, fn) => { em.on(ev, fn); return () => em.off(ev, fn); },
  };
}

module.exports = { createLive, newestLog, createChatWatch, parseCta, parseGuildCamp, newestChatLog };
