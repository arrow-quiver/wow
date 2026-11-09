'use strict';
// Donations (services/donations.js, GET /api/donations): deposits in the guild bank log, valued at the price of
// their day; open bank requests with today's price; the donor board.
const test = require('node:test');
const assert = require('node:assert');
const { startCore, seedGuild, addPlayer } = require('./helpers');
const Dn = require('../../src/core/services/donations');

const iso = (daysAgo, h = 12) => { const d = new Date(Date.now() - daysAgo * 86400000); d.setUTCHours(h, 0, 0, 0); return d.toISOString(); };
const dayOf = (daysAgo) => iso(daysAgo).slice(0, 10);

async function setup(t) {
  const c = await startCore();
  t.after(() => c.close());
  const g = seedGuild(c.db, { character: 'Mychar' });
  const grom = addPlayer(c.db, g.guildId, 'Grom#3333', { role: 'member', character: 'Grommash' }).id;
  const db = c.db;
  db.prepare("INSERT INTO characters (guild_id, name, class, level, is_bank) VALUES (?, 'Bankalt', 'MAGE', 1, 1)").run(g.guildId);
  const log = db.prepare('INSERT INTO bank_log (guild_id, kind, who, item_id, count, amount, at, dedupe) VALUES (?,?,?,?,?,?,?,?)');
  let n = 0;
  const add = (kind, who, item, count, amount, at) => log.run(g.guildId, kind, who, item, count, amount, at, `k${n += 1}`);
  const price = db.prepare('INSERT INTO prices (guild_id, item_id, day, price) VALUES (?,?,?,?)');
  db.prepare("INSERT INTO item_names (item_id, name) VALUES (13444, 'Major Mana Potion'), (14047, 'Runecloth'), (2589, 'Linen Cloth')").run();
  db.prepare("INSERT INTO item_info (item_id, name, quality, sell_price) VALUES (2589, 'Linen Cloth', 'COMMON', 13)").run();
  return { c, db, g, grom, add, price };
}

test('deposits are valued at the price of their day, once; bank characters and withdrawals are not donations', async (t) => {
  const { c, db, g, grom, add, price } = await setup(t);
  price.run(g.guildId, 14047, dayOf(5), 1200);  // Runecloth: price 5 days ago
  price.run(g.guildId, 14047, dayOf(1), 2000);  // and yesterday (after the deposit)
  add('deposit', 'Grommash', 14047, 20, null, iso(3));    // 20 Runecloth 3 days ago → 20 × 1200
  add('deposit', 'Grommash', null, null, 500000, iso(2)); // 50 gold
  add('deposit', 'Mychar', 2589, 10, null, iso(1));       // Linen: no auction price → vendor 13 each
  add('deposit', 'Mychar', 13444, 5, null, iso(1));       // Mana potions: no price yet
  add('withdraw', 'Grommash', 14047, 5, null, iso(1));
  add('deposit', 'Bankalt', 14047, 100, null, iso(1));
  assert.strictEqual(Dn.capture(db, g.guildId), 4);
  assert.strictEqual(Dn.capture(db, g.guildId), 0, 'once');
  const rows = db.prepare('SELECT who, kind, value, priced_from FROM donations ORDER BY id').all();
  assert.deepStrictEqual(rows.map((r) => [r.who, r.kind, r.value, r.priced_from]), [
    ['Grommash', 'item', 24000, 'auction'], ['Grommash', 'gold', 500000, 'gold'], ['Mychar', 'item', 130, 'vendor'], ['Mychar', 'item', null, null]]);
  // A scan from the deposit day arrives later: the potion gets its price; a newer price doesn't change the others.
  price.run(g.guildId, 13444, dayOf(1), 9000);
  price.run(g.guildId, 14047, dayOf(3), 1);
  Dn.capture(db, g.guildId);
  assert.deepStrictEqual(db.prepare('SELECT value FROM donations ORDER BY id').all().map((r) => r.value), [24000, 500000, 130, 45000]);

  const r = (await c.api.get('/api/donations')).body;
  assert.strictEqual(r.total, 24000 + 500000 + 130 + 45000);
  assert.deepStrictEqual(r.board.map((b) => [b.rank, b.who, b.value, b.gold, b.count]), [[1, 'Grommash', 524000, 500000, 2], [2, 'Mychar', 45130, 0, 2]]);
  assert.strictEqual(r.board[0].userId, grom);
  assert.deepStrictEqual({ rank: r.mine.rank, value: r.mine.value }, { rank: 2, value: 45130 });
  assert.strictEqual(r.recent[0].who, 'Mychar');
  assert.strictEqual(r.recent.find((d) => d.kind === 'gold').value, 500000);
  assert.strictEqual(r.recent.find((d) => d.item_id === 14047).item_name, 'Runecloth');
});

test('open bank requests show today\'s price and the total to buy them all', async (t) => {
  const { c, db, g, grom, price } = await setup(t);
  price.run(g.guildId, 13444, dayOf(0), 9000);
  const req = db.prepare("INSERT INTO bank_requests (guild_id, requester_id, item, count, note, status) VALUES (?,?,?,?,?,?)");
  req.run(g.guildId, grom, 'Major Mana Potion', 4, 'for MC', 'open');
  req.run(g.guildId, grom, 'Linen Cloth', 20, null, 'open');
  req.run(g.guildId, grom, 'Mystery Thing', 1, null, 'open');
  req.run(g.guildId, grom, 'Runecloth', 9, null, 'sent');
  const r = (await c.api.get('/api/donations?days=7')).body;
  assert.deepStrictEqual(r.requests.map((x) => [x.item, x.count, x.unit_price, x.total, x.priced_from, x.requester]), [
    ['Major Mana Potion', 4, 9000, 36000, 'auction', 'Grommash'], ['Linen Cloth', 20, 13, 260, 'vendor', 'Grommash'], ['Mystery Thing', 1, null, null, null, 'Grommash']]);
  assert.strictEqual(r.toBuy, 36260);
  assert.strictEqual(r.unpricedRequests, 1);
  assert.strictEqual(r.days, 7);
});
