// Guild life: the bulletin board, leveling matches and the weekly guild digest. API: docs/api/community.md
// ("Guild life").
//
// Bulletin board: posts guildmates put up ("bb" records, shared like crafting requests): looking for group,
// selling, buying, help wanted. A post lasts a week; its author takes it down.
//
// Leveling matches: for each of my characters still leveling, guildmates' characters within LEVEL_GAP levels who
// were online lately, ranked by how many hours of the week we're both usually on (seen_hours, from roster
// scans), then by how close in level.
//
// Weekly digest: the guild's week (Monday 00:00 UTC to the next): who joined, raids, season points and the week's
// top players, donations, crafts, kills and deaths, calls to arms and board posts. The Guild Master's app posts it
// to Discord on Sunday evening; any officer can post it by hand. Each week goes out once per app (digest_posts).
const identity = require('../identity');
const Seasons = require('./seasons');

const LEVEL_GAP = 3;
const MAX_LEVEL = 60;
const ACTIVE_DAYS = 14;
const DAY_MS = 86400000;
const WEEK_MS = 7 * DAY_MS;
const KINDS = { lfg: 'Looking for group', wts: 'Selling', wtb: 'Buying', help: 'Help wanted' };
const KIND_CODE = { lfg: 'l', wts: 's', wtb: 'w', help: 'h' };
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const sqlTime = (t) => new Date(t).toISOString().replace('T', ' ').slice(0, 19);
const parseTime = (s) => (s ? Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${String(s).replace(' ', 'T')}Z`) : NaN);

// ---------- bulletin board ----------
function board(db, gid, meId) {
  return db.prepare(`SELECT b.id, b.user_id, b.character, b.kind, b.text, b.price, b.share_id, b.created_at, c.class, c.level
      FROM bulletin_posts b LEFT JOIN characters c ON c.guild_id = b.guild_id AND c.name = b.character
      WHERE b.guild_id = ? ORDER BY b.created_at DESC, b.id DESC LIMIT 200`).all(gid)
    .map((p) => ({ id: p.id, character: p.character, class: p.class || null, level: p.level ?? null, kind: p.kind, kindLabel: KINDS[p.kind],
      text: p.text, price: p.price, created_at: p.created_at, mine: p.user_id === meId }));
}

// ---------- leveling matches ----------
function hoursOf(db, gid, names) {
  const out = new Map();
  if (!names.length) return out;
  const rows = db.prepare(`SELECT slot, SUM(n) AS n FROM seen_hours WHERE guild_id = ? AND name IN (SELECT value FROM json_each(?)) GROUP BY slot`)
    .all(gid, JSON.stringify(names));
  for (const r of rows) out.set(r.slot, r.n);
  return out;
}

// "Weekday evenings", "Weekend afternoons"… from the slots someone is on most, or null.
function usually(hours) {
  if (!hours.size) return null;
  const parts = { 'Late nights': [0, 6], Mornings: [6, 12], Afternoons: [12, 18], Evenings: [18, 24] };
  const score = {};
  for (const [slot, n] of hours) {
    const day = Math.floor(slot / 24), hour = slot % 24;
    const side = day === 0 || day === 6 ? 'weekend' : 'weekday';
    const part = Object.keys(parts).find((p) => hour >= parts[p][0] && hour < parts[p][1]);
    const k = `${side}|${part}`;
    score[k] = (score[k] || 0) + n;
  }
  const [best] = Object.entries(score).sort((a, b) => b[1] - a[1]);
  const [side, part] = best[0].split('|');
  return `${side === 'weekend' ? 'Weekend' : 'Weekday'} ${part.toLowerCase()}`;
}

function matches(db, gid, meId, { now = Date.now() } = {}) {
  const here = identity.notElsewhere('c');
  const mine = db.prepare(`SELECT c.name, c.class, c.level FROM characters c WHERE c.guild_id = ? AND c.user_id = ? AND c.is_bank = 0
      AND c.level BETWEEN 1 AND ? AND ${here} ORDER BY c.is_main DESC, c.level DESC`).all(gid, meId, MAX_LEVEL - 1);
  const myHours = hoursOf(db, gid, db.prepare('SELECT name FROM characters WHERE guild_id = ? AND user_id = ?').all(gid, meId).map((r) => r.name));
  const since = new Date(now - ACTIVE_DAYS * DAY_MS).toISOString();
  const others = db.prepare(`SELECT c.name, c.class, c.level, c.zone, c.online, c.last_seen, c.user_id FROM characters c
      WHERE c.guild_id = ? AND (c.user_id IS NULL OR c.user_id != ?) AND c.is_bank = 0 AND c.level BETWEEN 1 AND ?
      AND (c.online = 1 OR c.last_seen >= ?) AND ${here}`).all(gid, meId, MAX_LEVEL - 1, since);
  const lfp = new Set(db.prepare('SELECT character FROM buddy_posts WHERE guild_id = ? AND active = 1').all(gid).map((r) => r.character));
  const hoursCache = new Map();
  const theirHours = (name) => { if (!hoursCache.has(name)) hoursCache.set(name, hoursOf(db, gid, [name])); return hoursCache.get(name); };
  return mine.map((me) => {
    const list = others.filter((o) => Math.abs(o.level - me.level) <= LEVEL_GAP).map((o) => {
      const h = theirHours(o.name);
      let shared = 0;
      for (const slot of h.keys()) if (myHours.has(slot)) shared += 1;
      return {
        name: o.name, class: o.class || null, level: o.level, zone: o.zone || null, online: Boolean(o.online), lastSeen: o.last_seen || null,
        sharedHours: shared, usually: usually(h), lookingForPartners: lfp.has(o.name),
      };
    }).sort((a, b) => Number(b.online) - Number(a.online) || Number(b.lookingForPartners) - Number(a.lookingForPartners)
      || b.sharedHours - a.sharedHours || Math.abs(a.level - me.level) - Math.abs(b.level - me.level) || a.name.localeCompare(b.name))
      .slice(0, 8);
    return { character: me.name, class: me.class || null, level: me.level, usually: usually(myHours), matches: list };
  });
}

// ---------- weekly digest ----------
// The Monday (00:00 UTC) a week starts on, as YYYY-MM-DD.
function weekOf(t) {
  const d = new Date(t);
  const day = (d.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day)).toISOString().slice(0, 10);
}

function digest(db, gid, { week, now = Date.now() } = {}) {
  const w = /^\d{4}-\d{2}-\d{2}$/.test(String(week || '')) ? weekOf(Date.parse(`${week}T00:00:00Z`)) : weekOf(now);
  const from = Date.parse(`${w}T00:00:00Z`);
  const to = from + WEEK_MS;
  const current = now >= from && now < to;
  const guild = db.prepare('SELECT name FROM guilds WHERE id = ?').get(gid) || {};
  const people = Seasons.members(db, gid);
  const nameOf = new Map(people.map((p) => [p.userId, p.name]));

  const joined = db.prepare('SELECT user_id, joined_at FROM memberships WHERE guild_id = ?').all(gid)
    .filter((m) => { const t = parseTime(m.joined_at); return t >= from && t < to; })
    .map((m) => nameOf.get(m.user_id)).filter(Boolean).sort();

  // Season points this week, by player.
  const byUser = new Map();
  const totals = { gold: 0, kill: 0, craft: 0, raid: 0 };
  for (const e of Seasons.events(db, gid, from, to)) {
    totals[e.kind] = (totals[e.kind] || 0) + e.n;
    byUser.set(e.userId, (byUser.get(e.userId) || 0) + e.n * Seasons.POINTS[e.kind]);
  }
  const top = [...byUser.entries()].filter(([u]) => nameOf.has(u)).map(([u, points]) => ({ name: nameOf.get(u), points: Math.round(points) }))
    .filter((p) => p.points > 0).sort((a, b) => b.points - a.points || a.name.localeCompare(b.name)).slice(0, 3);

  const raids = db.prepare(`SELECT r.id, r.title, r.starts_at, r.status, (SELECT COUNT(*) FROM attendance a WHERE a.raid_id = r.id) AS came
      FROM raids r WHERE r.guild_id = ? AND r.status != 'cancelled' AND r.starts_at >= ? AND r.starts_at < ? ORDER BY r.starts_at`)
    .all(gid, new Date(from).toISOString(), new Date(to).toISOString())
    .map((r) => ({ title: r.title, startsAt: r.starts_at, done: r.status === 'done', attended: r.came }));

  const don = db.prepare('SELECT who, user_id, value, at FROM donations WHERE guild_id = ? AND value > 0').all(gid)
    .filter((d) => { const t = parseTime(d.at); return t >= from && t < to; });
  const givers = new Map();
  for (const d of don) { const n = nameOf.get(d.user_id) || d.who; givers.set(n, (givers.get(n) || 0) + d.value); }
  const topGiver = [...givers.entries()].sort((a, b) => b[1] - a[1])[0];

  const pvp = db.prepare("SELECT kind, SUM(COALESCE(n, 1)) AS n FROM war_marks WHERE guild_id = ? AND at >= ? AND at < ? GROUP BY kind")
    .all(gid, Math.floor(from / 1000), Math.floor(to / 1000));
  const count = (sql, ...a) => db.prepare(sql).get(...a).n;
  const range = [sqlTime(from), sqlTime(to)];

  return {
    week: w, from: new Date(from).toISOString(), to: new Date(to).toISOString(), current,
    previous: weekOf(from - DAY_MS), next: current ? null : weekOf(to),
    guild: guild.name || 'the guild',
    members: { total: people.length, joined, atMax: count(`SELECT COUNT(*) AS n FROM characters c WHERE c.guild_id = ? AND c.level >= ? AND c.is_bank = 0`, gid, MAX_LEVEL) },
    top,
    points: { gold: Math.round(totals.gold * 100) / 100, kills: totals.kill, crafts: totals.craft, raidNights: totals.raid },
    raids,
    bosses: require('./bosskills').kills(db, gid, { from: Math.floor(from / 1000), to: Math.floor(to / 1000) }).reverse().map((k) => ({ boss: k.boss, instance: k.instance, at: k.at })),
    donations: { count: don.length, value: don.reduce((s, d) => s + d.value, 0), top: topGiver ? { name: topGiver[0], value: topGiver[1] } : null },
    crafts: count("SELECT COUNT(*) AS n FROM craft_requests WHERE guild_id = ? AND status = 'done' AND updated_at >= ? AND updated_at < ?", gid, ...range),
    war: { kills: (pvp.find((p) => p.kind === 'k') || {}).n || 0, deaths: (pvp.find((p) => p.kind === 'd') || {}).n || 0 },
    ctas: count('SELECT COUNT(*) AS n FROM ctas WHERE guild_id = ? AND created_at >= ? AND created_at < ?', gid, ...range),
    board: count('SELECT COUNT(*) AS n FROM bulletin_posts WHERE guild_id = ? AND created_at >= ? AND created_at < ?', gid, ...range),
    posted: Boolean(db.prepare('SELECT 1 FROM digest_posts WHERE guild_id = ? AND week = ?').get(gid, w)),
  };
}

function gold(c) {
  const g = Math.floor(c / 10000);
  return g ? `${g.toLocaleString('en-US')}g` : `${Math.floor((c % 10000) / 100)}s`;
}
const day = (iso) => DAYS[new Date(iso).getUTCDay()];

// The Discord post for a week.
function discordText(d) {
  const lines = [`📰 **${d.guild} — the week of ${d.week}**`];
  if (d.top.length) lines.push(`🏆 Top of the week: ${d.top.map((p, i) => `${['🥇', '🥈', '🥉'][i]} ${p.name} (${p.points})`).join('  ')}`);
  if (d.raids.length) lines.push(`🗓️ Raids: ${d.raids.map((r) => `${r.title} (${day(r.startsAt)}${r.attended ? `, ${r.attended} came` : ''})`).join(', ')}`);
  if (d.bosses && d.bosses.length) lines.push(`💀 Bosses down: ${[...new Set(d.bosses.map((b) => b.boss))].join(', ')}`);
  if (d.war.kills || d.war.deaths) lines.push(`⚔️ Out in the world: ${d.war.kills} Alliance slain, ${d.war.deaths} deaths${d.ctas ? `, ${d.ctas} call${d.ctas === 1 ? '' : 's'} to arms` : ''}`);
  else if (d.ctas) lines.push(`⚔️ ${d.ctas} call${d.ctas === 1 ? '' : 's'} to arms`);
  if (d.donations.count) lines.push(`🎁 ${d.donations.count} donation${d.donations.count === 1 ? '' : 's'} to the guild bank, worth ${gold(d.donations.value)}${d.donations.top ? `. Most generous: ${d.donations.top.name}` : ''}`);
  if (d.crafts) lines.push(`🔨 ${d.crafts} crafting request${d.crafts === 1 ? '' : 's'} made`);
  if (d.board) lines.push(`📌 ${d.board} new post${d.board === 1 ? '' : 's'} on the bulletin board`);
  if (d.members.joined.length) lines.push(`👋 Welcome ${d.members.joined.join(', ')}!`);
  if (lines.length === 1) lines.push('A quiet week. Log in, the Horde needs you!');
  lines.push(`${d.members.total} members, ${d.members.atMax} at level ${MAX_LEVEL}. For the Horde!`);
  return lines.join('\n');
}

// Posts the week once (this app). → 'posted' | 'already' | 'failed'.
async function post(db, ctx, gid, week, { force = false } = {}) {
  const d = digest(db, gid, { week });
  if (d.posted && !force) return 'already';
  if (!(await ctx.discord(null, discordText(d)))) return 'failed';
  db.prepare('INSERT OR REPLACE INTO digest_posts (guild_id, week, posted_at) VALUES (?, ?, datetime(\'now\'))').run(gid, d.week);
  return 'posted';
}

// Sunday from 18:00 (this computer's time), from the Guild Master's app.
function dueNow(now = new Date()) { return now.getDay() === 0 && now.getHours() >= 18; }

module.exports = { board, matches, digest, discordText, post, dueNow, usually, weekOf, KINDS, KIND_CODE, LEVEL_GAP };
