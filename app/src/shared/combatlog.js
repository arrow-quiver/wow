'use strict';
// The game's combat log file (Logs/WoWCombatLog*.txt, written while /combatlog is on): reading lines and following
// one player's session from them. Zero dependencies, shared by the app's live link (main/live.js) and its tests.
//
//   parseLine(text, { year })  → { t (ms), event, src: { guid, name, flags }, dst: {…}, fields } or null
//   createSession({ names })   → { add(entry), summary(), lastDeath, setNames(names) }
//
// Lines look like `11/9 17:30:12.345  SPELL_DAMAGE,Player-…,"Grom-Zuljin",0x511,0x0,Creature-…,"Defias Pillager",0x10a48,0x0,…`
// (Classic writes no year; Retail writes `11/9/2026 17:30:12.3451`). With "advanced combat logging" on, 17 or more
// unit-info fields come after the spell fields, before the amounts; we detect that by the info GUID that starts them.

const TYPE_PLAYER = 0x400;
// COMBATLOG_OBJECT_CONTROL_PLAYER: a player's pet, totem or guardian (and players themselves). Pets kill people too.
const CONTROL_PLAYER = 0x100;
const MAX_KNOWN = 500; // GUIDs remembered for naming pets' owners

// Split the CSV part: commas outside double quotes; quotes removed.
function splitFields(s) {
  const out = [];
  let cur = ''; let q = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') { q = !q; continue; }
    if (ch === ',' && !q) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

const STAMP = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))? (\d{1,2}):(\d{2}):(\d{2})\.(\d{1,4})(?:[-+]\d+)?\s{2}(.*)$/;

function parseLine(text, { year = new Date().getFullYear() } = {}) {
  const m = STAMP.exec(String(text).replace(/\r$/, ''));
  if (!m) return null;
  const [, mo, d, y, h, mi, s, frac, rest] = m;
  const t = new Date(Number(y || year), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), Number(frac.padEnd(3, '0').slice(0, 3))).getTime();
  const f = splitFields(rest);
  const event = f[0];
  if (!event) return null;
  const unit = (i) => ({ guid: f[i] || '', name: f[i + 1] || '', flags: parseInt(f[i + 2], 16) || 0 });
  if (f.length < 9) return { t, event, src: unit(1), dst: { guid: '', name: '', flags: 0 }, fields: f.slice(1) };
  return { t, event, src: unit(1), dst: unit(5), fields: f.slice(9) };
}

const isInfoGuid = (v) => /^(Player|Creature|Pet|Vehicle|GameObject|0000000000000000)/.test(String(v || ''));
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

// The amount of a damage or heal event, and the spell, whatever the logging mode.
function amountOf(e) {
  const f = e.fields;
  let spell = null; let i = 0;
  if (e.event.startsWith('SWING_')) { spell = 'Melee'; i = 0; } else if (e.event.startsWith('ENVIRONMENTAL_')) { spell = f[0] || 'Environment'; i = 1; } else { spell = f[1] || null; i = 3; }
  if (isInfoGuid(f[i])) i += 17;   // advanced combat logging
  if (e.event.startsWith('ENVIRONMENTAL_') && isInfoGuid(f[0])) { spell = f[17] || 'Environment'; i = 18; }
  return { spell, amount: num(f[i]) };
}

const DAMAGE = /^(SWING|SPELL|SPELL_PERIODIC|RANGE|ENVIRONMENTAL|DAMAGE_SHIELD|DAMAGE_SPLIT)_DAMAGE$/;
const HEAL = /^(SPELL|SPELL_PERIODIC)_HEAL$/;
const FIGHT_GAP_MS = 8000;
const RECAP_MS = 15000;

function shortName(n) { return String(n || '').split('-')[0]; }

function createSession({ names = [] } = {}) {
  let mine = new Set(names.map((n) => shortName(n).toLowerCase()));
  const s = {
    startedAt: null, lastAt: null, events: 0,
    kills: 0, pvpKills: 0, deaths: 0, pvpDeaths: 0,
    damageDone: 0, damageTaken: 0, healingTaken: 0,
    fights: 0, fightMs: 0, me: null,
  };
  let fightStart = null; let fightLast = null;
  // Where I am. `MAP_CHANGE,<uiMapID>,"Hillsbrad Foothills",…` names the zone; `ZONE_CHANGE,<instanceID>,"Eastern
  // Kingdoms",<difficulty>` only names the instance, which in the open world is the whole continent. So a MAP_CHANGE
  // always wins, and a ZONE_CHANGE (written when the instance changes, before that instance's first MAP_CHANGE) only
  // stands in until the next MAP_CHANGE.
  let map = null; // { id, name } from the last MAP_CHANGE since the last ZONE_CHANGE
  let instance = null; // { id, name } from the last ZONE_CHANGE
  const where = () => map || instance;
  // Player-controlled units' owners, so a hunter's pet's bite counts as the hunter's: player GUID → name (from any
  // line a player is named in) and pet GUID → owner GUID (SPELL_SUMMON lines, and the owner field of advanced logging).
  const playerNames = new Map(); const owners = new Map();
  const remember = (m, k, v) => { if (m.has(k)) m.delete(k); m.set(k, v); if (m.size > MAX_KNOWN) m.delete(m.keys().next().value); };
  const recent = []; // events involving me, last ~60
  let lastDeath = null;

  // Me: one of my character names, or the same GUID once a line has named me.
  const isMe = (u) => Boolean(u.name && mine.has(shortName(u.name).toLowerCase())) || Boolean(s.me && u.guid && u.guid === s.me.guid);
  const isPlayer = (u) => Boolean(u.flags & TYPE_PLAYER) || String(u.guid).startsWith('Player-');
  // A player or something a player controls (pets, totems, mind-controlled mobs).
  const isPlayerControlled = (u) => isPlayer(u) || Boolean(u.flags & CONTROL_PLAYER);

  // Who to blame for a hit: the player, or a pet's owner when we know them (else the pet's own name).
  function attacker(e) {
    if (isPlayer(e.src) || !(e.src.flags & CONTROL_PLAYER)) return { who: shortName(e.src.name), pet: null };
    let owner = owners.get(e.src.guid);
    // Advanced logging: the unit info after the spell fields starts with the source's GUID, then its owner's.
    const f = e.fields; const at = e.event.startsWith('SWING_') ? 0 : 3;
    if (!owner && f[at] === e.src.guid && String(f[at + 1] || '').startsWith('Player-')) owner = f[at + 1];
    const name = owner && playerNames.get(owner);
    return name ? { who: name, pet: shortName(e.src.name) || null } : { who: shortName(e.src.name), pet: null };
  }

  function closeFight() {
    if (fightStart != null && fightLast != null) { s.fights += 1; s.fightMs += Math.max(0, fightLast - fightStart); }
    fightStart = null; fightLast = null;
  }

  function add(e) {
    if (!e) return null;
    if (e.event === 'ZONE_CHANGE' || e.event === 'MAP_CHANGE') {
      // `MAP_CHANGE,1424,"Hillsbrad Foothills",…`: parseLine read the id and name as the source unit's.
      const id = Number(e.src.guid); const name = e.src.name;
      if (!name) return null;
      const z = { id: Number.isFinite(id) ? id : null, name };
      if (e.event === 'MAP_CHANGE') map = z; else { instance = z; map = null; }
      return null;
    }
    for (const u of [e.src, e.dst]) if (u.name && String(u.guid).startsWith('Player-')) remember(playerNames, u.guid, shortName(u.name));
    if (e.event === 'SPELL_SUMMON' && String(e.src.guid).startsWith('Player-') && e.dst.guid) remember(owners, e.dst.guid, e.src.guid);
    const srcMe = isMe(e.src); const dstMe = isMe(e.dst);
    if (!srcMe && !dstMe) return null;
    s.events += 1;
    if (s.startedAt == null) s.startedAt = e.t;
    s.lastAt = e.t;
    if (!s.me) s.me = srcMe ? { name: shortName(e.src.name), guid: e.src.guid } : { name: shortName(e.dst.name), guid: e.dst.guid };
    if (fightLast != null && e.t - fightLast > FIGHT_GAP_MS) closeFight();
    if (fightStart == null) fightStart = e.t;
    fightLast = e.t;

    let entry = null;
    if (DAMAGE.test(e.event)) {
      const { spell, amount } = amountOf(e);
      if (srcMe && !dstMe) s.damageDone += amount;
      if (dstMe) s.damageTaken += amount;
      if (dstMe) {
        // My own damage (a fall, Life Tap) is never an enemy's.
        const by = srcMe ? { who: shortName(e.src.name), pet: null } : attacker(e);
        entry = { t: e.t, kind: 'hit-me', who: by.who || spell, player: !srcMe && isPlayerControlled(e.src), spell: by.pet ? `${spell} (${by.pet})` : spell, amount };
      } else entry = { t: e.t, kind: 'hit', who: shortName(e.dst.name) || spell, player: isPlayer(e.dst), spell, amount };
    } else if (HEAL.test(e.event)) {
      const { spell, amount } = amountOf(e);
      if (dstMe) s.healingTaken += amount;
      entry = { t: e.t, kind: dstMe ? 'healed' : 'heal', who: shortName(dstMe ? e.src.name : e.dst.name), spell, amount };
    } else if (e.event === 'SPELL_CAST_SUCCESS' && srcMe) {
      entry = { t: e.t, kind: 'cast', who: shortName(e.dst.name), spell: e.fields[1] || null, amount: 0 };
    } else if (e.event === 'PARTY_KILL' && srcMe) {
      s.kills += 1;
      if (isPlayer(e.dst)) s.pvpKills += 1;
      entry = { t: e.t, kind: 'kill', who: shortName(e.dst.name), player: isPlayer(e.dst), amount: 0 };
    } else if (e.event === 'UNIT_DIED' && dstMe) {
      s.deaths += 1;
      const window = recent.filter((r) => e.t - r.t <= RECAP_MS);
      const hits = window.filter((r) => r.kind === 'hit-me');
      const bySource = {};
      for (const h of hits) {
        const k = `${h.who}|${h.spell || ''}`;
        bySource[k] = bySource[k] || { who: h.who, spell: h.spell, player: h.player, amount: 0, hits: 0 };
        bySource[k].amount += h.amount; bySource[k].hits += 1;
      }
      const killing = hits[hits.length - 1] || null;
      const enemies = [...new Set(hits.filter((h) => h.player).map((h) => h.who).filter(Boolean))];
      // Players (or their pets) hurt me in the last seconds: a death to players, even when a mob landed the last hit.
      const pvp = enemies.length > 0;
      if (pvp) s.pvpDeaths += 1;
      lastDeath = {
        at: e.t, character: s.me && s.me.name,
        killer: killing ? killing.who : null, killingBlow: killing ? { spell: killing.spell, amount: killing.amount } : null, pvp,
        enemies, zone: where() ? where().name : null, zoneId: where() ? where().id : null,
        seconds: window.length ? Math.round((e.t - window[0].t) / 100) / 10 : 0,
        damageTaken: hits.reduce((a, h) => a + h.amount, 0),
        healed: window.filter((r) => r.kind === 'healed').reduce((a, h) => a + h.amount, 0),
        sources: Object.values(bySource).sort((a, b) => b.amount - a.amount).slice(0, 6),
        myCasts: window.filter((r) => r.kind === 'cast').map((r) => r.spell).filter(Boolean).slice(-12),
      };
      closeFight();
      entry = { t: e.t, kind: 'died', who: lastDeath.killer, amount: 0 };
    }
    if (entry) { recent.push(entry); if (recent.length > 80) recent.shift(); }
    return entry;
  }

  function summary(now = s.lastAt) {
    const fightMs = s.fightMs + (fightStart != null && fightLast != null ? fightLast - fightStart : 0);
    const minutes = s.startedAt != null && now != null ? Math.max(0, (now - s.startedAt) / 60000) : 0;
    const perHour = (n) => (minutes >= 5 ? Math.round((n / minutes) * 60 * 10) / 10 : null);
    return {
      character: s.me && s.me.name, startedAt: s.startedAt, lastAt: s.lastAt, minutes: Math.round(minutes),
      kills: s.kills, pvpKills: s.pvpKills, deaths: s.deaths, pvpDeaths: s.pvpDeaths,
      damageDone: s.damageDone, damageTaken: s.damageTaken, healingTaken: s.healingTaken,
      fights: s.fights + (fightStart != null ? 1 : 0), zone: where() ? where().name : null, fightShare: minutes ? Math.round((fightMs / 60000 / minutes) * 100) / 100 : 0,
      killsPerHour: perHour(s.kills), deathsPerHour: perHour(s.deaths),
    };
  }

  return {
    add, summary,
    get lastDeath() { return lastDeath; },
    get zone() { return where(); },
    setNames(list) { mine = new Set(list.map((n) => shortName(n).toLowerCase())); },
  };
}

// The death recap as plain text for the Coach.
function deathText(d) {
  if (!d) return '';
  const others = d.enemies && d.enemies.length > 1 ? ` and ${d.enemies.length - 1} other player${d.enemies.length === 2 ? '' : 's'}` : '';
  const lines = [`Died${d.killer ? ` to ${d.killer}${d.pvp ? ' (a player)' : ''}${others}` : ''}${d.zone ? ` in ${d.zone}` : ''}${d.killingBlow && d.killingBlow.spell ? `, killing blow ${d.killingBlow.spell} for ${d.killingBlow.amount}` : ''}.`,
    `In the last ${d.seconds}s: took ${d.damageTaken} damage, was healed for ${d.healed}.`];
  if (d.sources.length) lines.push(`Damage taken by source: ${d.sources.map((x) => `${x.who}${x.player ? ' (player)' : ''} ${x.spell || ''} ${x.amount} in ${x.hits} hit${x.hits === 1 ? '' : 's'}`).join('; ')}.`);
  lines.push(d.myCasts.length ? `My casts: ${d.myCasts.join(', ')}.` : 'I cast nothing in that time.');
  return lines.join('\n');
}

// This session so far, as plain text for the Coach.
function sessionText(x) {
  if (!x) return '';
  return `This play session (${x.minutes} min${x.character ? ` on ${x.character}` : ''}): ${x.kills} kills (${x.pvpKills} players), ${x.deaths} deaths `
    + `(${x.pvpDeaths} to players), ${x.fights} fights, in combat ${Math.round((x.fightShare || 0) * 100)}% of the time, `
    + `damage done ${x.damageDone}, taken ${x.damageTaken}, healed for ${x.healingTaken}.`;
}

module.exports = { parseLine, splitFields, amountOf, createSession, deathText, sessionText, TYPE_PLAYER, CONTROL_PLAYER };
