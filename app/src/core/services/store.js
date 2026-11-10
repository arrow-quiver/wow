// The guild bank store: officers put items up for season points (the "ST" record), guildies order them with the
// points they've earned. An order is an ordinary guild bank request (bq) whose note starts "[store:<key>:<cost>]",
// so officers send or decline it like any other request, in the app or in game, and it travels the same way.
//
//   tag(key, cost, note) → the note of an order      parse(note) → { key, cost, note } | null
//   balance(db, guildId, userId) → { earned, spent, held, available }
//       earned: lifetime season points (services/seasons.js lifetimePoints, no streak bonus); spent: orders sent;
//       held: orders still open (the points are kept until an officer sends or declines). Declined and cancelled
//       orders give the points back.
//   items(db, guildId) → [{ key, item, itemId, cost, stock, left }]   left = stock − orders sent or open
//   orders(db, guildId, { userId?, status? }) → [{ id, key, item, count, cost, total, status, requester, ... }]
const Seasons = require('./seasons');

const TAG = /^\[store:([0-9a-z]{6}):(\d{1,7})\]\s*/;

const tag = (key, cost, note) => `[store:${key}:${cost}]${note ? ` ${note}` : ''}`.slice(0, 200);
function parse(note) {
  const m = TAG.exec(String(note || ''));
  return m ? { key: m[1], cost: Number(m[2]), note: String(note).slice(m[0].length) } : null;
}

function orders(db, guildId, { userId = null, status = null } = {}) {
  const rows = db.prepare(`SELECT b.*, u.battletag,
      (SELECT name FROM characters c WHERE c.user_id = b.requester_id AND c.guild_id = b.guild_id ORDER BY c.is_main DESC, c.level DESC LIMIT 1) AS requester
    FROM bank_requests b JOIN users u ON u.id = b.requester_id
    WHERE b.guild_id = ? AND b.note LIKE '[store:%' ${userId ? 'AND b.requester_id = ?' : ''} ORDER BY b.created_at DESC, b.id DESC`)
    .all(...[guildId, ...(userId ? [userId] : [])]);
  return rows.map((r) => {
    const t = parse(r.note);
    if (!t) return null;
    return {
      id: r.id, key: t.key, item: r.item, count: r.count, cost: t.cost, total: t.cost * r.count, note: t.note, status: r.status,
      requesterId: r.requester_id, requester: r.requester || String(r.battletag || '').split('#')[0], created_at: r.created_at,
    };
  }).filter((o) => o && (!status || o.status === status));
}

function balance(db, guildId, userId, now = Date.now()) {
  const earned = Seasons.lifetimePoints(db, guildId, now)[userId] || 0;
  let spent = 0; let held = 0;
  for (const o of orders(db, guildId, { userId })) {
    if (o.status === 'sent') spent += o.total;
    else if (o.status === 'open') held += o.total;
  }
  return { earned, spent, held, available: Math.max(0, earned - spent - held) };
}

function items(db, guildId) {
  const used = {};
  for (const o of orders(db, guildId)) if (o.status === 'sent' || o.status === 'open') used[o.key] = (used[o.key] || 0) + o.count;
  return db.prepare('SELECT * FROM store_items WHERE guild_id = ? ORDER BY pos, item').all(guildId).map((r) => ({
    key: r.key, item: r.item, itemId: r.item_id, cost: r.cost, stock: r.stock, left: Math.max(0, r.stock - (used[r.key] || 0)),
  }));
}

module.exports = { tag, parse, balance, items, orders, TAG };
