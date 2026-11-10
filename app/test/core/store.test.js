'use strict';
// The guild bank store (services/store.js, routes/store.js): officers' items as the "ST" record, orders as tagged
// bank requests, points held while open, spent when sent, given back when declined or cancelled.
const test = require('node:test');
const assert = require('node:assert');
const { setupShare } = require('./sharing-helpers');
const Store = require('../../src/core/services/store');

// My points: gold given to the bank (1 point per gold).
function give(h, gold) {
  const at = new Date(h.clock * 1000 - 3600000).toISOString();
  const log = h.db.prepare("INSERT INTO bank_log (guild_id, kind, who, amount, at, dedupe) VALUES (?, 'deposit', 'Thrallia', ?, ?, ?)")
    .run(h.gid, gold * 10000, at, `g${Math.random()}`);
  h.db.prepare("INSERT INTO donations (guild_id, log_id, who, user_id, kind, value, priced_from, at) VALUES (?, ?, 'Thrallia', ?, 'gold', ?, 'gold', ?)")
    .run(h.gid, log.lastInsertRowid, h.me, gold * 10000, at);
}

test('tags', () => {
  assert.strictEqual(Store.tag('a1b2c3', 40, 'for MC'), '[store:a1b2c3:40] for MC');
  assert.deepStrictEqual(Store.parse('[store:a1b2c3:40] for MC'), { key: 'a1b2c3', cost: 40, note: 'for MC' });
  assert.strictEqual(Store.parse('a normal request'), null);
});

test('officers set the store; I order with my points; held, then spent or given back', async (t) => {
  const h = await setupShare(t, { role: 'officer' });
  const api = h.srv.api;
  give(h, 150);
  let r = await api.put('/api/store', { items: [{ item: 'Major Mana Potion', itemId: 13444, cost: 40, stock: 3 }, { item: 'Runecloth Bag', cost: 120, stock: 1 }] });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body.items.map((i) => [i.item, i.cost, i.stock, i.left]), [['Major Mana Potion', 40, 3, 3], ['Runecloth Bag', 120, 1, 1]]);
  assert.deepStrictEqual(r.body.balance, { earned: 150, spent: 0, held: 0, available: 150 });
  const pot = r.body.items[0].key;
  const bag = r.body.items[1].key;
  // The list is the shared ST record.
  assert.strictEqual(h.db.prepare("SELECT COUNT(*) AS n FROM share_outbox").get().n >= 1, true);

  r = await api.post('/api/store/order', { key: pot, count: 2, note: 'raid night' });
  assert.strictEqual(r.status, 201);
  assert.deepStrictEqual(r.body.balance, { earned: 150, spent: 0, held: 80, available: 70 });
  assert.strictEqual(r.body.items[0].left, 1);
  assert.strictEqual(r.body.mine[0].status, 'open');
  // It's an ordinary bank request.
  const req = h.db.prepare("SELECT * FROM bank_requests WHERE note LIKE '[store:%'").get();
  assert.strictEqual(req.item, 'Major Mana Potion');
  assert.strictEqual(req.note, `[store:${pot}:40] raid night`);
  // Not enough points; sold out.
  assert.match((await api.post('/api/store/order', { key: bag })).body.error, /costs 120 points and you have 70/);
  assert.match((await api.post('/api/store/order', { key: pot, count: 2 })).body.error, /Only 1 left/);
  assert.strictEqual((await api.post('/api/store/order', { key: 'zzzzzz' })).status, 404);
  // Officers see it with my balance; sending it spends the points.
  r = await api.get('/api/store');
  assert.strictEqual(r.body.pending.length, 1);
  assert.strictEqual(r.body.pending[0].balance.held, 80);
  await api.post(`/api/bank/requests/${req.id}/sent`, {});
  r = await api.get('/api/store');
  assert.deepStrictEqual(r.body.balance, { earned: 150, spent: 80, held: 0, available: 70 });
  assert.strictEqual(r.body.pending.length, 0);
  // Declined gives the points back.
  await api.post('/api/store/order', { key: pot, count: 1 });
  const second = h.db.prepare("SELECT id FROM bank_requests WHERE note LIKE '[store:%' AND status = 'open'").get();
  await api.post(`/api/bank/requests/${second.id}/declined`, {});
  r = await api.get('/api/store');
  assert.deepStrictEqual(r.body.balance, { earned: 150, spent: 80, held: 0, available: 70 });
  assert.strictEqual(r.body.items[0].left, 1);
  // Bad lists.
  assert.strictEqual((await api.put('/api/store', { items: [{ item: 'x' }] })).status, 400);
});

test('members can order but not set the store', async (t) => {
  const h = await setupShare(t, { role: 'member' });
  const r = await h.srv.api.put('/api/store', { items: [] });
  assert.strictEqual(r.status, 403);
  const g = await h.srv.api.get('/api/store');
  assert.strictEqual(g.body.canEdit, false);
  assert.deepStrictEqual(g.body.pending, []);
});
