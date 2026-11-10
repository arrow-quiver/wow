// The hunt: the guild's kill-on-sight list and bounties. API: docs/api/war.md ("Kill on sight and bounties").
//
// Kill on sight ("ko" records, table kos): Alliance players the guild hunts. Any member adds one or takes one off.
// Bounties ("BT", officers, table bounties): points for killing one named player (the first kill claims it), or
// for each kill in a zone, up to `cap` kills, until a time.
// Kills that count ("kk", by the killer's addon, table hunt_kills): an honorable kill of a kill-on-sight target or
// a bounty's. Season points (services/seasons.js): KOS_POINTS for each kill-on-sight kill, plus the bounty's points.
const KOS_POINTS = 8;
const DAY = 86400;

const parseTime = (s) => {
  if (typeof s === 'number') return s < 1e11 ? s : Math.floor(s / 1000);
  const str = String(s || '');
  return Math.floor(Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(str) ? str : `${str.replace(' ', 'T')}Z`) / 1000);
};
const lower = (s) => String(s || '').toLowerCase();

// Bounty payouts: [{ bounty (share_id), userId, target, at, points }], in kill order. A kill pays when it was made
// while the bounty was up (created .. until), matches its target (or zone), and the bounty still had kills to pay.
function payouts(db, gid) {
  const bounties = db.prepare('SELECT * FROM bounties WHERE guild_id = ?').all(gid);
  if (!bounties.length) return [];
  const kills = db.prepare('SELECT * FROM hunt_kills WHERE guild_id = ? AND bounty IS NOT NULL ORDER BY at, share_id').all(gid);
  const out = [];
  for (const b of bounties) {
    const from = parseTime(b.created_at) - 300; // clocks differ a little between players
    let left = b.target ? 1 : Math.max(1, b.cap);
    for (const k of kills) {
      if (left <= 0) break;
      if (k.bounty !== b.share_id || !k.user_id || k.at < from || k.at > b.until) continue;
      if (b.target ? lower(k.target) !== lower(b.target) : lower(k.zone) !== lower(b.zone)) continue;
      out.push({ bounty: b.share_id, userId: k.user_id, target: k.target, at: k.at, points: b.points });
      left -= 1;
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

// Season events (ms times): kill-on-sight kills and bounty payouts.
function events(db, gid, from, to) {
  const out = [];
  for (const k of db.prepare('SELECT user_id, at FROM hunt_kills WHERE guild_id = ? AND kos = 1 AND user_id IS NOT NULL AND at >= ? AND at < ?')
    .all(gid, Math.floor(from / 1000), Math.ceil(to / 1000))) out.push({ userId: k.user_id, kind: 'kos', n: 1, at: k.at * 1000 });
  for (const p of payouts(db, gid)) if (p.at * 1000 >= from && p.at * 1000 < to) out.push({ userId: p.userId, kind: 'bounty', n: p.points, at: p.at * 1000 });
  return out;
}

function nameOf(db, gid) {
  const rows = db.prepare(`SELECT u.id, (SELECT name FROM characters c WHERE c.user_id = u.id AND c.guild_id = ? AND c.is_bank = 0
      ORDER BY c.is_main DESC, c.level DESC LIMIT 1) AS name, u.battletag FROM users u`).all(gid);
  const m = new Map(rows.map((r) => [r.id, r.name || String(r.battletag || '').split('#')[0] || null]));
  return (id) => (id ? m.get(id) || null : null);
}

function kos(db, gid) {
  const who = nameOf(db, gid);
  const kills = db.prepare('SELECT target, COUNT(*) AS n, MAX(at) AS last FROM hunt_kills WHERE guild_id = ? AND kos = 1 GROUP BY lower(target)').all(gid);
  const byName = new Map(kills.map((k) => [lower(k.target), k]));
  return db.prepare('SELECT * FROM kos WHERE guild_id = ? ORDER BY added_at DESC').all(gid).map((r) => {
    const k = byName.get(lower(r.name));
    return { name: r.name, reason: r.reason, addedBy: who(r.added_by), addedAt: r.added_at, kills: k ? k.n : 0, lastKill: k ? k.last : null };
  });
}

function bounties(db, gid, { now = Math.floor(Date.now() / 1000) } = {}) {
  const who = nameOf(db, gid);
  const paid = payouts(db, gid);
  return db.prepare('SELECT * FROM bounties WHERE guild_id = ? ORDER BY created_at DESC').all(gid).map((b) => {
    const claims = paid.filter((p) => p.bounty === b.share_id).map((p) => ({ name: who(p.userId), target: p.target, at: p.at, points: p.points }));
    const cap = b.target ? 1 : b.cap;
    const status = b.state === 'x' ? 'closed' : claims.length >= cap ? 'claimed' : b.until < now ? 'expired' : 'open';
    return { id: b.id, key: b.share_id, target: b.target, zone: b.zone, points: b.points, cap, until: b.until, note: b.note, createdAt: b.created_at, status, claims, left: Math.max(0, cap - claims.length) };
  });
}

module.exports = { KOS_POINTS, DAY, payouts, events, kos, bounties };
