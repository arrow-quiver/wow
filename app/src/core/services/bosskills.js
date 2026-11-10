// Raid boss kills ("ek" records, table boss_kills): written by raiders' addons the moment a boss dies, with who was
// in the raid. API: docs/api/raids.md ("Boss kills").
//
// A kill belongs to a scheduled raid of the same instance that started up to 6 hours before it (or up to 2 hours
// after: early pulls). It counts as raid attendance for season points (services/seasons.js) for everyone in it whose
// character the guild knows: once per raid, or, with no scheduled raid, once per instance and day; at most two a day
// from kills. Kills must be written by a raider in them (share/import.js). Raids closed by an
// officer count through their attendance, so nobody gets a raid twice. Closing a raid ticks who the kills saw.
const BEFORE = 6 * 3600;
const AFTER = 2 * 3600;
const RAIDS_PER_DAY = 2;

const lower = (s) => String(s || '').trim().toLowerCase().replace(/^the /, '');
const day = (at) => new Date(at * 1000).toISOString().slice(0, 10);

function userMap(db, gid) {
  const m = new Map();
  for (const c of db.prepare('SELECT name, user_id FROM characters WHERE guild_id = ? AND user_id IS NOT NULL').all(gid)) m.set(lower(c.name), c.user_id);
  return m;
}

function raidsNear(db, gid) {
  return db.prepare("SELECT id, instance, starts_at, status FROM raids WHERE guild_id = ? AND status != 'cancelled'").all(gid)
    .map((r) => ({ ...r, start: Math.floor(Date.parse(r.starts_at) / 1000) }));
}

// The scheduled raid a kill belongs to, or null.
function raidOf(raids, k) {
  let best = null;
  for (const r of raids) {
    if (!r.instance || lower(r.instance) !== lower(k.instance)) continue;
    if (k.at < r.start - AFTER || k.at > r.start + BEFORE) continue;
    if (!best || Math.abs(k.at - r.start) < Math.abs(k.at - best.start)) best = r;
  }
  return best;
}

// Kills between from and to (unix seconds), newest first, with the guild's players in each.
function kills(db, gid, { from = 0, to = 2 ** 31 } = {}) {
  const users = userMap(db, gid);
  const raids = raidsNear(db, gid);
  return db.prepare('SELECT * FROM boss_kills WHERE guild_id = ? AND at >= ? AND at < ? ORDER BY at DESC').all(gid, from, to).map((k) => {
    let names = [];
    try { names = JSON.parse(k.names); } catch { names = []; }
    const raid = raidOf(raids, k);
    return {
      key: k.share_id, boss: k.boss, instance: k.instance, at: k.at, size: k.size, names,
      userIds: [...new Set(names.map((n) => users.get(lower(n))).filter(Boolean))], raidId: raid ? raid.id : null,
    };
  });
}

// Season events (ms): one 'raid' per player per raid night the kills saw, minus those a raid close already counted.
function events(db, gid, from, to) {
  const attended = new Set(db.prepare('SELECT a.raid_id, a.user_id FROM attendance a JOIN raids r ON r.id = a.raid_id WHERE r.guild_id = ?').all(gid)
    .map((a) => `${a.user_id}|r${a.raid_id}`));
  const seen = new Map();
  const daily = new Map();
  for (const k of kills(db, gid, { from: Math.floor(from / 1000), to: Math.ceil(to / 1000) }).reverse()) {
    for (const uid of k.userIds) {
      const key = k.raidId ? `${uid}|r${k.raidId}` : `${uid}|${lower(k.instance)}|${day(k.at)}`;
      // At most RAIDS_PER_DAY raids a day per player from kills, and never one a close already counted.
      const perDay = `${uid}|${day(k.at)}`;
      if (attended.has(key) || seen.has(key) || (daily.get(perDay) || 0) >= RAIDS_PER_DAY) continue;
      seen.set(key, { userId: uid, kind: 'raid', n: 1, at: k.at * 1000 });
      daily.set(perDay, (daily.get(perDay) || 0) + 1);
    }
  }
  return [...seen.values()];
}

// For a raid page: its kills, and who they saw.
function forRaid(db, gid, raidId) {
  // The same boss on the same day once (two raid leaders in a night make two records).
  const once = new Set();
  const list = kills(db, gid).filter((k) => k.raidId === raidId).reverse()
    .filter((k) => { const id = `${k.boss}|${day(k.at)}`; if (once.has(id)) return false; once.add(id); return true; });
  return { kills: list.map((k) => ({ boss: k.boss, at: k.at, size: k.size })), seen: [...new Set(list.flatMap((k) => k.userIds))] };
}

module.exports = { kills, events, forRaid, raidOf };
