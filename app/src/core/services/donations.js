// Donations: gold and items guildies put in the guild bank, valued at the price of the day they went in.
//
//   capture(db, guildId) → how many new donations       every 'deposit' line of bank_log becomes a donations row
//       (bank characters' deposits are moves, not gifts, and are left out). Rows without a price yet are priced again.
//   priceOn(db, guildId, itemId, day) → { value, from: 'auction'|'vendor', day } | null   per item
//   unitPriceByName(db, guildId, name) → { itemId, price, from } | null   for bank requests (typed by name)
//   board(db, guildId, { since }) → [{ userId, who, value, gold, items, count }]   most given first
//   overview(db, guildId, userId, { days }) → the Donate page (docs/api/economy.md "Donations")
//
// "Auctionator price on that day": the guild price index (prices, the lowest scan of each day from everyone's
// Auctionator) on the deposit day, else the newest earlier day within PRICE_LOOKBACK_DAYS; else what a vendor pays
// (item_info.sell_price). Once a donation has an auction (or gold) value it never changes; a vendor value is replaced
// by the auction price when a scan from that day (or the lookback before it) arrives within RETRY_DAYS.
// A character marked as a bank character later drops off the board and the recent list (BANK_CHAR below).
const PRICE_LOOKBACK_DAYS = 14;
const RETRY_DAYS = 30;
// SQL: the donation d was made by a character that is (now) a guild bank character.
const BANK_CHAR = 'EXISTS (SELECT 1 FROM characters c WHERE c.guild_id = d.guild_id AND lower(c.name) = lower(d.who) AND c.is_bank = 1)';

const day = (iso) => String(iso).slice(0, 10);

function priceOn(db, guildId, itemId, onDay) {
  const p = db.prepare(`SELECT price, day FROM prices WHERE guild_id = ? AND item_id = ? AND day <= ? AND day >= date(?, '-${PRICE_LOOKBACK_DAYS} days')
    ORDER BY day DESC LIMIT 1`).get(guildId, itemId, onDay, onDay);
  if (p) return { value: p.price, from: 'auction', day: p.day };
  const v = db.prepare('SELECT sell_price FROM item_info WHERE item_id = ? AND sell_price > 0').get(itemId);
  if (v) return { value: v.sell_price, from: 'vendor', day: onDay };
  return null;
}

function capture(db, guildId) {
  const fresh = db.prepare(`SELECT l.* FROM bank_log l
    WHERE l.guild_id = ? AND l.kind = 'deposit' AND l.who IS NOT NULL AND (l.item_id IS NOT NULL OR l.amount > 0)
      AND NOT EXISTS (SELECT 1 FROM donations d WHERE d.log_id = l.id)
      AND NOT EXISTS (SELECT 1 FROM characters c WHERE c.guild_id = l.guild_id AND lower(c.name) = lower(l.who) AND c.is_bank = 1)`).all(guildId);
  const userOf = db.prepare('SELECT user_id FROM characters WHERE guild_id = ? AND lower(name) = lower(?) AND user_id IS NOT NULL');
  const ins = db.prepare(`INSERT OR IGNORE INTO donations (guild_id, log_id, who, user_id, kind, item_id, count, value, priced_from, price_day, at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  let n = 0;
  for (const l of fresh) {
    const u = userOf.get(guildId, l.who);
    if (l.item_id) {
      const count = Math.max(1, l.count || 1);
      const p = priceOn(db, guildId, l.item_id, day(l.at));
      ins.run(guildId, l.id, l.who, u ? u.user_id : null, 'item', l.item_id, count, p ? p.value * count : null, p ? p.from : null, p ? p.day : null, l.at);
    } else {
      ins.run(guildId, l.id, l.who, u ? u.user_id : null, 'gold', null, null, l.amount, 'gold', day(l.at), l.at);
    }
    n += 1;
  }
  // Prices that arrived later (a scan from the deposit day): unpriced gifts get one, vendor-priced gifts get the
  // auction price. And players linked later.
  const retry = db.prepare(`SELECT * FROM donations WHERE guild_id = ? AND kind = 'item' AND (value IS NULL OR priced_from = 'vendor')
    AND at >= datetime('now', '-${RETRY_DAYS} days')`).all(guildId);
  const setValue = db.prepare('UPDATE donations SET value = ?, priced_from = ?, price_day = ? WHERE id = ?');
  for (const d of retry) {
    const p = priceOn(db, guildId, d.item_id, day(d.at));
    if (!p || (d.value != null && p.from !== 'auction')) continue;
    setValue.run(p.value * (d.count || 1), p.from, p.day, d.id);
  }
  db.prepare(`UPDATE donations SET user_id = (SELECT c.user_id FROM characters c WHERE c.guild_id = donations.guild_id AND lower(c.name) = lower(donations.who))
    WHERE guild_id = ? AND user_id IS NULL`).run(guildId);
  return n;
}

function unitPriceByName(db, guildId, name) {
  const row = db.prepare(`SELECT item_id FROM item_names WHERE lower(name) = lower(?)
    UNION SELECT item_id FROM item_info WHERE lower(name) = lower(?) LIMIT 1`).get(name, name);
  if (!row) return null;
  const p = priceOn(db, guildId, row.item_id, new Date().toISOString().slice(0, 10));
  return { itemId: row.item_id, price: p ? p.value : null, from: p ? p.from : null };
}

function board(db, guildId, { since }) {
  return db.prepare(`SELECT d.user_id AS userId, COALESCE(
      (SELECT name FROM characters c WHERE c.user_id = d.user_id AND c.guild_id = d.guild_id ORDER BY c.is_main DESC, c.level DESC LIMIT 1), MAX(d.who)) AS who,
      SUM(COALESCE(d.value, 0)) AS value, SUM(CASE WHEN d.kind = 'gold' THEN d.value ELSE 0 END) AS gold,
      SUM(CASE WHEN d.kind = 'item' THEN COALESCE(d.value, 0) ELSE 0 END) AS items, COUNT(*) AS count
    FROM donations d WHERE d.guild_id = ? AND d.at >= ? AND NOT ${BANK_CHAR}
    GROUP BY COALESCE(CAST(d.user_id AS TEXT), 'w:' || lower(d.who))
    ORDER BY value DESC, count DESC`).all(guildId, since);
}

function overview(db, guildId, userId, { days = 30 } = {}) {
  capture(db, guildId);
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const recent = db.prepare(`SELECT d.*, COALESCE(n.name, i.name) AS item_name, i.quality FROM donations d
    LEFT JOIN item_names n ON n.item_id = d.item_id LEFT JOIN item_info i ON i.item_id = d.item_id
    WHERE d.guild_id = ? AND NOT ${BANK_CHAR} ORDER BY d.at DESC, d.id DESC LIMIT 40`).all(guildId);
  const requests = db.prepare(`SELECT b.id, b.item, b.count, b.note, b.created_at, u.battletag AS requester_tag,
      (SELECT name FROM characters c WHERE c.user_id = b.requester_id AND c.guild_id = b.guild_id ORDER BY c.is_main DESC, c.level DESC LIMIT 1) AS requester
    FROM bank_requests b JOIN users u ON u.id = b.requester_id WHERE b.guild_id = ? AND b.status = 'open' ORDER BY b.created_at`).all(guildId)
    .map((r) => {
      const p = unitPriceByName(db, guildId, r.item);
      return {
        id: r.id, item: r.item, count: r.count, note: r.note, created_at: r.created_at,
        requester: r.requester || String(r.requester_tag || '').split('#')[0] || null,
        item_id: p ? p.itemId : null, unit_price: p ? p.price : null, total: p && p.price ? p.price * r.count : null, priced_from: p ? p.from : null,
      };
    });
  const top = board(db, guildId, { since });
  const mine = top.find((t) => t.userId === userId) || { value: 0, gold: 0, items: 0, count: 0 };
  return {
    days,
    requests,
    toBuy: requests.reduce((a, r) => a + (r.total || 0), 0),
    unpricedRequests: requests.filter((r) => !r.total).length,
    total: top.reduce((a, t) => a + t.value, 0),
    board: top.slice(0, 20).map((t, i) => ({ rank: i + 1, ...t, me: t.userId === userId })),
    mine: { value: mine.value, gold: mine.gold, items: mine.items, count: mine.count, rank: top.findIndex((t) => t.userId === userId) + 1 || null },
    recent: recent.map((d) => ({
      id: d.id, who: d.who, kind: d.kind, item_id: d.item_id, item_name: d.item_name, quality: d.quality, count: d.count,
      value: d.value, priced_from: d.priced_from, at: d.at, me: d.user_id === userId,
    })),
  };
}

module.exports = { capture, priceOn, unitPriceByName, board, overview, PRICE_LOOKBACK_DAYS, RETRY_DAYS };
