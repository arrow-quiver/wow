// How I actually play, measured: the app's live link follows the combat log (main/live.js) and saves each play
// session (play_sessions); deaths with their killer are in pvp_deaths (services/war.js). The Coach uses this
// instead of guessing from a quiz, and the weekly report compares this week with last week.
//
//   measure(db, userId, character, { from, to }) → { hours, sessions, kills, pvpKills, deaths, pvpDeaths, fights,
//       fightShare, killsPerHour, deathsPerHour, pvpPerHour, damageDone, damageTaken }
//   style(m) → { aggression, survival, labels: [...] } | null (under MIN_MINUTES of play)
//   report(db, userId, character, { now }) → the weekly report (docs/api/coach.md "Weekly report")
//   contextText(db, userId, character, now) → a line for the Coach's prompt ('' with too little data)
const WEEK = 7 * 86400000;
const MIN_MINUTES = 30;

const round = (n, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

function measure(db, userId, character, { from, to }) {
  const rows = db.prepare(`SELECT * FROM play_sessions WHERE user_id = ? AND lower(character) = lower(?) AND last_at >= ? AND started_at < ?`)
    .all(userId, character, from, to);
  const m = { sessions: rows.length, minutes: 0, kills: 0, pvpKills: 0, deaths: 0, pvpDeaths: 0, fights: 0, damageDone: 0, damageTaken: 0, combatMinutes: 0 };
  for (const r of rows) {
    m.minutes += r.minutes; m.kills += r.kills; m.pvpKills += r.pvp_kills; m.deaths += r.deaths; m.pvpDeaths += r.pvp_deaths;
    m.fights += r.fights; m.damageDone += r.damage_done; m.damageTaken += r.damage_taken; m.combatMinutes += r.minutes * (r.fight_share || 0);
  }
  const hours = m.minutes / 60;
  const per = (n) => (hours >= MIN_MINUTES / 60 ? round(n / hours) : null);
  return {
    sessions: m.sessions, hours: round(hours), kills: m.kills, pvpKills: m.pvpKills, deaths: m.deaths, pvpDeaths: m.pvpDeaths,
    fights: m.fights, damageDone: m.damageDone, damageTaken: m.damageTaken,
    fightShare: m.minutes ? round(m.combatMinutes / m.minutes, 2) : 0,
    killsPerHour: per(m.kills), deathsPerHour: per(m.deaths), pvpPerHour: per(m.pvpKills + m.pvpDeaths),
  };
}

// 0-100 scores and plain labels. Aggression: time spent fighting and fights with players. Survival: few deaths.
function style(m) {
  if (!m || m.hours * 60 < MIN_MINUTES) return null;
  const aggression = Math.max(0, Math.min(100, Math.round(m.fightShare * 120 + (m.pvpPerHour || 0) * 8)));
  const survival = Math.max(0, Math.min(100, Math.round(100 - (m.deathsPerHour || 0) * 25)));
  const labels = [];
  labels.push(aggression >= 65 ? 'Goes looking for fights' : aggression >= 35 ? 'Fights when it matters' : 'Mostly out of combat (questing, travel, crafting)');
  labels.push(survival >= 80 ? 'Rarely dies' : survival >= 50 ? 'Dies now and then' : 'Dies a lot');
  if ((m.pvpKills + m.pvpDeaths) >= 3) {
    labels.push(m.pvpKills >= m.pvpDeaths ? `Wins more PvP fights than it loses (${m.pvpKills}:${m.pvpDeaths})` : `Loses more PvP fights than it wins (${m.pvpKills}:${m.pvpDeaths})`);
  }
  return { aggression, survival, labels };
}

function deaths(db, userId, character, { from, to }) {
  const rows = db.prepare('SELECT * FROM pvp_deaths WHERE user_id = ? AND lower(character) = lower(?) AND at >= ? AND at < ?').all(userId, character, from, to);
  const count = (key) => {
    const m = new Map();
    for (const r of rows) { const k = key(r); if (k) m.set(k, (m.get(k) || 0) + 1); }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name, n]) => ({ name, n }));
  };
  const secs = rows.map((r) => r.seconds).filter((s) => s > 0).sort((a, b) => a - b);
  return {
    total: rows.length, pvp: rows.filter((r) => r.pvp).length,
    killers: count((r) => (r.pvp ? r.killer : null)), spells: count((r) => r.spell), zones: count((r) => r.zone),
    medianSeconds: secs.length ? secs[Math.floor(secs.length / 2)] : null,
    unhealed: rows.filter((r) => !r.healed).length,
  };
}

function tips(cur, prev, d, st) {
  const out = [];
  if (cur.hours * 60 < MIN_MINUTES) return ['Play a little with the live link on (Settings → Overlay & live, and /wow live on in game), and the Coach can measure how you play.'];
  if (prev.deathsPerHour != null && cur.deathsPerHour != null && cur.deathsPerHour > prev.deathsPerHour * 1.5 && cur.deaths >= 3) {
    out.push(`You died ${cur.deathsPerHour} times an hour this week, up from ${prev.deathsPerHour}. Slow down when you pull more than one enemy, and keep an escape ready.`);
  }
  if (d.medianSeconds != null && d.medianSeconds < 5 && d.total >= 2) {
    out.push(`Most deaths took under ${Math.ceil(d.medianSeconds)} seconds from first hit: you were caught out. Fight with your defensive cooldowns up, and watch for stealthed classes in contested zones.`);
  }
  if (d.spells[0] && d.spells[0].n >= 2) out.push(`${d.spells[0].name} killed you ${d.spells[0].n} times. Ask the Coach how your class counters it.`);
  if (d.killers[0] && d.killers[0].n >= 2) out.push(`${d.killers[0].name} got you ${d.killers[0].n} times. Group up or call the guild (Call for help) when they're around.`);
  if (d.unhealed >= 2 && d.unhealed >= d.total / 2) out.push('More than half your deaths had no healing at all: carry potions and bandages, and use them before 30% health.');
  if (st && st.aggression >= 65 && st.survival < 50) out.push('You fight a lot and die a lot: pick fights you can win (level, numbers, cooldowns) and reset the rest.');
  if (st && st.aggression < 25 && cur.hours >= 3) out.push('You rarely fight: that is efficient for leveling. If you want PvP, group with a guildie in contested zones.');
  if (!out.length) out.push(cur.deaths === 0 ? 'No deaths this week. Whatever you are doing, keep doing it.' : 'A steady week. Keep it up, and ask the Coach about your next talent.');
  return out.slice(0, 4);
}

function report(db, userId, character, { now = Date.now() } = {}) {
  const thisWeek = { from: now - WEEK, to: now + 1 };
  const lastWeek = { from: now - 2 * WEEK, to: now - WEEK };
  const cur = measure(db, userId, character, thisWeek);
  const prev = measure(db, userId, character, lastWeek);
  const st = style(cur);
  const d = deaths(db, userId, character, thisWeek);
  const out = { character, from: thisWeek.from, to: now, week: cur, lastWeek: prev, style: st, deaths: d, tips: tips(cur, prev, d, st) };
  out.text = reportText(out);
  return out;
}

function reportText(r) {
  const w = r.week;
  if (!w.sessions) return '';
  const lines = [`My week on ${r.character} (from the combat log): ${w.hours} hours over ${w.sessions} session${w.sessions === 1 ? '' : 's'}, ${w.kills} kills (${w.pvpKills} players), ${w.deaths} deaths (${w.pvpDeaths} to players), in combat ${Math.round(w.fightShare * 100)}% of the time.`];
  if (r.lastWeek.sessions) lines.push(`Last week: ${r.lastWeek.hours} hours, ${r.lastWeek.kills} kills, ${r.lastWeek.deaths} deaths.`);
  if (r.style) lines.push(`Measured style: ${r.style.labels.join('; ')}.`);
  if (r.deaths.spells.length) lines.push(`What killed me most: ${r.deaths.spells.map((s) => `${s.name} ×${s.n}`).join(', ')}.`);
  if (r.deaths.killers.length) lines.push(`Players who killed me most: ${r.deaths.killers.map((s) => `${s.name} ×${s.n}`).join(', ')}.`);
  if (r.deaths.zones.length) lines.push(`Where I died: ${r.deaths.zones.map((s) => `${s.name} ×${s.n}`).join(', ')}.`);
  return lines.join('\n');
}

function contextText(db, userId, character, now = Date.now()) {
  if (!userId || !character) return '';
  const m = measure(db, userId, character, { from: now - 4 * WEEK, to: now + 1 });
  const st = style(m);
  if (!st) return '';
  return `How they actually play, measured from the combat log over the last 4 weeks (${m.hours} hours): ${st.labels.join('; ')}. `
    + `Aggression ${st.aggression}/100, survival ${st.survival}/100, ${m.killsPerHour} kills and ${m.deathsPerHour} deaths an hour, in combat ${Math.round(m.fightShare * 100)}% of the time. Trust this over the quiz answers.`;
}

module.exports = { measure, style, report, reportText, contextText, MIN_MINUTES };
