// Guild seasons: a monthly leaderboard from what guildies actually did, with titles, badges, streaks and a hall of
// fame. Every app works it out the same way from the guild's shared data, so everyone sees the same board.
//
//   season(db, guildId, { month, now }) → { month, start, end, players: [...], leaders, ... }   (docs/api/seasons.md)
//   hall(db, guildId, { months, now }) → [{ month, mvp, leaders }]   the past months' winners
//   badgesOf(db, guildId) → { [userId]: [badge] }                     lifetime badges
//   inboxPart(db, guildId) → the addon's `seasons` inbox field (titles and badges on player tooltips)
//   announceText(s) → the Discord post crowning a month's winners
//   donationText(d) / badgeText(name, badge) → the shout-outs
//
// Points (POINTS): donations 1 per gold of value (the Auctionator price of the day, services/donations.js), each
// PvP kill in the open world (the war map's kill marks) 2, each crafting request filled 5, each raid attended 10.
// Streak: weeks in a row (Monday to Sunday, UTC) with any points, up to this week or last week. Each week of streak
// after the first adds 5% to the season's points, up to +25%.
// Raid boss kills the guild's addons recorded count as raids attended too (services/bosskills.js), once a raid.
// A recruit who stays a week: 25 for whoever found them (services/recruiting.js; players' `recruits`).
// The hunt (services/hunt.js): each kill of a kill-on-sight target 8 more, and a bounty's points (bounty: n = points).
const POINTS = { gold: 1, kill: 2, craft: 5, raid: 10, kos: 8, bounty: 1, recruit: 25 };
const STREAK_STEP = 0.05;
const STREAK_MAX = 0.25;
const WEEK_MS = 7 * 86400000;

const CATEGORIES = [
  { id: 'donor', title: 'Quartermaster', label: 'Most given to the guild bank', unit: 'gold' },
  { id: 'pvp', title: 'Warlord', label: 'Most kills in the open world', unit: 'kills' },
  { id: 'crafter', title: 'Master Crafter', label: 'Most crafting requests filled', unit: 'crafts' },
  { id: 'raider', title: 'Stalwart', label: 'Most raids attended', unit: 'raids' },
];

// Lifetime badges: [id, name, what it counts, threshold].
const BADGES = [
  ['donor1', 'Benefactor', 'gold', 100], ['donor2', 'Patron', 'gold', 500], ['donor3', 'Guild Treasure', 'gold', 2000],
  ['pvp1', 'Bloodied', 'kills', 10], ['pvp2', 'Slayer', 'kills', 100], ['pvp3', 'Warbringer', 'kills', 500],
  ['craft1', 'Helping Hands', 'crafts', 10], ['craft2', 'Artisan of the Guild', 'crafts', 50],
  ['raid1', 'Raid Regular', 'raids', 5], ['raid2', 'Veteran', 'raids', 20], ['raid3', 'Raid Legend', 'raids', 50],
  ['streak1', 'Steady', 'streak', 4], ['streak2', 'Devoted', 'streak', 8], ['streak3', 'Unbreakable', 'streak', 12],
];

const pad = (n) => String(n).padStart(2, '0');
const monthOf = (t) => { const d = new Date(t); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`; };
function bounds(month) {
  const [y, m] = month.split('-').map(Number);
  return { start: Date.UTC(y, m - 1, 1), end: Date.UTC(y, m, 1) };
}
const iso = (t) => new Date(t).toISOString();
const sqlTime = (t) => iso(t).replace('T', ' ').slice(0, 19);
// Monday 00:00 UTC of the week of t, as a number of weeks since 1970-01-05 (a Monday).
const weekOf = (t) => Math.floor((t - Date.UTC(1970, 0, 5)) / WEEK_MS);
const parseTime = (s) => {
  if (typeof s === 'number') return s < 1e11 ? s * 1000 : s;
  const str = String(s || '');
  return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(str) ? str : `${str.replace(' ', 'T')}Z`);
};

function members(db, guildId) {
  return db.prepare(`SELECT u.id AS userId, u.battletag,
      (SELECT name FROM characters c WHERE c.user_id = u.id AND c.guild_id = m.guild_id AND c.is_bank = 0 ORDER BY c.is_main DESC, c.level DESC LIMIT 1) AS name,
      (SELECT class FROM characters c WHERE c.user_id = u.id AND c.guild_id = m.guild_id AND c.is_bank = 0 ORDER BY c.is_main DESC, c.level DESC LIMIT 1) AS class
    FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.guild_id = ?`).all(guildId)
    .map((r) => ({ userId: r.userId, name: r.name || String(r.battletag || '').split('#')[0] || `Player ${r.userId}`, class: r.class || null }));
}

// Every point-earning event of the guild between from and to (ms): [{ userId, kind, n, at }].
function events(db, guildId, from, to) {
  const out = [];
  for (const d of db.prepare('SELECT user_id, value, at FROM donations WHERE guild_id = ? AND user_id IS NOT NULL AND value > 0').all(guildId)) {
    const at = parseTime(d.at);
    if (at >= from && at < to) out.push({ userId: d.user_id, kind: 'gold', n: d.value / 10000, at });
  }
  for (const k of db.prepare("SELECT user_id, at FROM war_marks WHERE guild_id = ? AND kind = 'k' AND user_id IS NOT NULL AND at >= ? AND at < ?")
    .all(guildId, Math.floor(from / 1000), Math.ceil(to / 1000))) out.push({ userId: k.user_id, kind: 'kill', n: 1, at: k.at * 1000 });
  for (const c of db.prepare("SELECT crafter_id, updated_at FROM craft_requests WHERE guild_id = ? AND status = 'done' AND crafter_id IS NOT NULL AND updated_at >= ? AND updated_at < ?")
    .all(guildId, sqlTime(from), sqlTime(to))) out.push({ userId: c.crafter_id, kind: 'craft', n: 1, at: parseTime(c.updated_at) });
  for (const a of db.prepare(`SELECT a.user_id, r.starts_at FROM attendance a JOIN raids r ON r.id = a.raid_id
      WHERE r.guild_id = ? AND r.status != 'cancelled' AND r.starts_at >= ? AND r.starts_at < ?`).all(guildId, iso(from), iso(to)))
    out.push({ userId: a.user_id, kind: 'raid', n: 1, at: parseTime(a.starts_at) });
  out.push(...require('./bosskills').events(db, guildId, from, to));
  out.push(...require('./hunt').events(db, guildId, from, to));
  out.push(...require('./recruiting').events(db, guildId, from, to));
  return out;
}

const tally = () => ({ gold: 0, kills: 0, crafts: 0, raids: 0, hunt: 0, recruits: 0, base: 0 });
function add(t, e) {
  if (e.kind === 'gold') t.gold += e.n; else if (e.kind === 'kill') t.kills += e.n; else if (e.kind === 'craft') t.crafts += e.n;
  else if (e.kind === 'raid') t.raids += e.n; else if (e.kind === 'recruit') t.recruits += e.n; else t.hunt += e.n * POINTS[e.kind];
  t.base += e.n * POINTS[e.kind];
}

// Weeks in a row with points, ending this week or last week (this week may not have started for them yet).
function streakOf(weeks, nowWeek) {
  let w = weeks.has(nowWeek) ? nowWeek : weeks.has(nowWeek - 1) ? nowWeek - 1 : null;
  let n = 0;
  while (w != null && weeks.has(w)) { n += 1; w -= 1; }
  return n;
}
const bonusOf = (streak) => Math.min(STREAK_MAX, Math.max(0, streak - 1) * STREAK_STEP);

function season(db, guildId, { month, now = Date.now() } = {}) {
  const m = /^\d{4}-\d{2}$/.test(String(month || '')) ? month : monthOf(now);
  const { start, end } = bounds(m);
  const current = m === monthOf(now);
  const people = members(db, guildId);
  const byUser = new Map(people.map((p) => [p.userId, { ...p, ...tally(), weeks: new Set() }]));
  for (const e of events(db, guildId, start, end)) {
    const p = byUser.get(e.userId);
    if (!p) continue;
    add(p, e);
    p.weeks.add(weekOf(e.at));
  }
  // Streaks run across months: count weeks from the last 16 weeks, ending at "now" (or the month's end for a past month).
  const at = current ? now : end - 1;
  const recent = events(db, guildId, at - 16 * WEEK_MS, at + 1);
  const weeksByUser = new Map();
  for (const e of recent) { if (!weeksByUser.has(e.userId)) weeksByUser.set(e.userId, new Set()); weeksByUser.get(e.userId).add(weekOf(e.at)); }

  const players = [...byUser.values()].map((p) => {
    const streak = streakOf(weeksByUser.get(p.userId) || new Set(), weekOf(at));
    const bonus = bonusOf(streak);
    return {
      userId: p.userId, name: p.name, class: p.class,
      gold: Math.round(p.gold * 100) / 100, kills: p.kills, crafts: p.crafts, raids: p.raids, hunt: p.hunt, recruits: p.recruits,
      base: Math.round(p.base), streak, bonus, score: Math.round(p.base * (1 + bonus)), titles: [],
    };
  }).filter((p) => p.base > 0 || p.streak > 0)
    .sort((a, b) => b.score - a.score || b.base - a.base || a.name.localeCompare(b.name));
  players.forEach((p, i) => { p.rank = i + 1; });

  const value = { donor: (p) => p.gold, pvp: (p) => p.kills, crafter: (p) => p.crafts, raider: (p) => p.raids };
  const leaders = {};
  for (const c of CATEGORIES) {
    const top = [...players].filter((p) => value[c.id](p) > 0).sort((a, b) => value[c.id](b) - value[c.id](a) || b.score - a.score)[0];
    if (top) { leaders[c.id] = { userId: top.userId, name: top.name, value: value[c.id](top) }; top.titles.push(c.title); }
  }
  const mvp = players[0] && players[0].score > 0 ? { userId: players[0].userId, name: players[0].name, score: players[0].score } : null;
  if (mvp) players[0].titles.unshift('MVP');
  return {
    month: m, start: iso(start), end: iso(end), current, daysLeft: current ? Math.ceil((end - now) / 86400000) : 0,
    points: POINTS, streak: { step: STREAK_STEP, max: STREAK_MAX },
    categories: CATEGORIES, players, leaders, mvp,
  };
}

// Lifetime totals per player (all time), for badges.
function lifetime(db, guildId, now = Date.now()) {
  const t = new Map();
  for (const e of events(db, guildId, 0, now + 1)) {
    if (!t.has(e.userId)) t.set(e.userId, { ...tally(), weeks: new Set() });
    const x = t.get(e.userId);
    add(x, e); x.weeks.add(weekOf(e.at));
  }
  return t;
}

// The longest run of weeks in a row, ever.
function bestStreak(weeks) {
  const list = [...weeks].sort((a, b) => a - b);
  let best = 0; let run = 0; let prev = null;
  for (const w of list) { run = prev != null && w === prev + 1 ? run + 1 : 1; best = Math.max(best, run); prev = w; }
  return best;
}

function badgesOf(db, guildId, now = Date.now()) {
  const out = {};
  for (const [userId, x] of lifetime(db, guildId, now)) {
    const have = { gold: x.gold, kills: x.kills, crafts: x.crafts, raids: x.raids, streak: bestStreak(x.weeks) };
    out[userId] = BADGES.filter(([, , what, n]) => have[what] >= n).map(([id, name, what, n]) => ({ id, name, what, n }));
  }
  return out;
}

// Lifetime points per player (no streak bonus): what the guild bank store spends. → { [userId]: points }
function lifetimePoints(db, guildId, now = Date.now()) {
  const out = {};
  for (const [userId, x] of lifetime(db, guildId, now)) out[userId] = Math.round(x.base);
  return out;
}

function hall(db, guildId, { months = 6, now = Date.now() } = {}) {
  const out = [];
  const d = new Date(now);
  for (let k = 1; k <= months; k++) {
    const m = `${new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - k, 1)).getUTCFullYear()}-${pad(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - k, 1)).getUTCMonth() + 1)}`;
    const s = season(db, guildId, { month: m, now });
    if (!s.mvp) continue;
    out.push({ month: m, mvp: s.mvp, leaders: s.leaders, players: s.players.length });
  }
  return out;
}

// For the addon: titles and badges by character name (every character of each player).
function inboxPart(db, guildId, now = Date.now()) {
  const s = season(db, guildId, { now });
  const badges = badgesOf(db, guildId, now);
  const chars = db.prepare('SELECT user_id, name FROM characters WHERE guild_id = ? AND user_id IS NOT NULL AND is_bank = 0').all(guildId);
  const byUser = new Map(s.players.map((p) => [p.userId, p]));
  const out = {};
  for (const c of chars) {
    const p = byUser.get(c.user_id);
    const b = badges[c.user_id] || [];
    if (!p && !b.length) continue;
    out[c.name] = {
      title: p && p.titles.length ? p.titles[0] : '', rank: p ? p.rank : 0, score: p ? p.score : 0, streak: p ? p.streak : 0,
      badges: b.length, best: b.length ? b[b.length - 1].name : '',
    };
  }
  return { month: s.month, players: out };
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthName = (m) => { const [y, mo] = m.split('-').map(Number); return `${MONTHS[mo - 1]} ${y}`; };
const clean = (s) => String(s).replace(/[*_~`|>]/g, '');
const fmtGold = (g) => `${Math.round(g).toLocaleString('en-US')}g`;

function announceText(s) {
  if (!s.mvp) return null;
  const lines = [`🏆 **${monthName(s.month)} season: the winners**`, `👑 MVP: **${clean(s.mvp.name)}** with ${s.mvp.score} points`];
  const show = { donor: (v) => `${fmtGold(v)} given`, pvp: (v) => `${v} kills`, crafter: (v) => `${v} crafts`, raider: (v) => `${v} raids` };
  const icon = { donor: '💰', pvp: '⚔️', crafter: '🔨', raider: '🛡️' };
  for (const c of CATEGORIES) {
    const l = s.leaders[c.id];
    if (l) lines.push(`${icon[c.id]} ${c.title}: **${clean(l.name)}** (${show[c.id](l.value)})`);
  }
  const top = s.players.slice(1, 5).map((p) => `${clean(p.name)} ${p.score}`);
  if (top.length) lines.push(`Also on the board: ${top.join(' · ')}`);
  lines.push('Thank you all. A new season starts now!');
  return lines.join('\n');
}

function donationText(d) {
  const what = d.kind === 'gold' ? fmtGoldCopper(d.value) : `${d.count > 1 ? `${d.count} × ` : ''}${clean(d.item_name || 'an item')}${d.value ? ` (worth ${fmtGoldCopper(d.value)})` : ''}`;
  return `🎁 **${clean(d.who)}** topped up the guild bank: ${what}. Thank you!`;
}
function fmtGoldCopper(c) {
  const g = Math.floor(c / 10000); const s = Math.floor((c % 10000) / 100);
  return g ? `${g.toLocaleString('en-US')}g${s ? ` ${s}s` : ''}` : `${s}s`;
}
const badgeText = (name, badge) => `🏅 **${clean(name)}** earned the **${badge.name}** badge!`;

module.exports = {
  season, hall, badgesOf, lifetimePoints, inboxPart, events, members, announceText, donationText, badgeText, monthOf, bounds,
  POINTS, CATEGORIES, BADGES, STREAK_STEP, STREAK_MAX, _bestStreak: bestStreak, _streakOf: streakOf, _weekOf: weekOf,
};
