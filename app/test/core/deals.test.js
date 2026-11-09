'use strict';
// Deal hunter: reading Auctionator's history, storing it per realm, and picking what to buy and sell again.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startCore, seedGuild } = require('./helpers');
const { extractMarket, marketParts } = require('../../src/shared/auctionator');
const D = require('../../src/core/services/deals');

const DAY0 = Date.UTC(2020, 0, 1);
const NOW = Date.now();
const today = Math.floor((NOW - DAY0) / 86400000);

// An Auctionator item record: `days` = { daysAgo: price }, `m` = the current lowest buyout.
function rec(days, m, avail) {
  const l = {}; const a = {};
  for (const [ago, p] of Object.entries(days)) { l[String(today - Number(ago))] = p; if (avail) a[String(today - Number(ago))] = avail; }
  return { m, l, h: { ...l }, ...(avail ? { a } : {}) };
}
const steady = (price, n = 20, skip = () => false) => Object.fromEntries([...Array(n).keys()].map((i) => i + 1).filter((d) => !skip(d)).map((d) => [d, price]));

function auctionatorDb() {
  return {
    __dbversion: 6,
    "Zul'jin Horde": {
      // A: steady 5g for 20 days, listed today at 3g → a good deal
      14047: rec({ ...steady(50000), 0: 30000 }, 30000, 25),
      // B: only two days of history → not judged
      2589: rec({ 1: 50000, 2: 50000, 0: 20000 }, 20000),
      // C: 10% under → not enough discount
      12359: rec({ ...steady(50000), 0: 45000 }, 45000),
      // D: falling this week (30-day median 5g, last week 3g), now 2.3g → valued at 3g, small profit, flagged
      13444: rec({ ...steady(50000, 20, (d) => d <= 7), ...steady(30000, 7), 0: 23000 }, 23000),
      // E: vendor flip (sell price 2000c, set below)
      4338: rec({ ...steady(900), 0: 500 }, 500),
      // F: not in today's scan → ignored
      13446: rec({ ...steady(50000), 2: 10000 }, 10000),
      // G: rarely listed (3 of the last 14 days), cheap now → deal, but slow and risky
      13510: rec({ 2: 400000, 6: 410000, 11: 405000, 16: 400000, 22: 395000, 0: 250000 }, 250000),
      'p:1234': rec({ 0: 5 }, 5), // a pet cage: skipped
    },
    "Zul'jin Alliance": { 14047: rec({ 40: 1000 }, 1000) }, // scanned over two weeks ago: dropped
    'Old Realm Horde': { 14047: rec({ 3: 70000, 4: 70000 }, 70000) },
  };
}

test('extractMarket keeps recent realms and each item\'s daily prices', () => {
  const m = extractMarket(auctionatorDb(), NOW);
  assert.deepEqual(m.realms.map((r) => r.key), ["Zul'jin Horde", 'Old Realm Horde']);
  const zj = m.realms[0];
  assert.equal(zj.newest, today);
  const a = zj.items.find((x) => x[0] === 14047);
  assert.equal(a[1], 30000); assert.equal(a[2], today);
  assert.equal(a[3].length, 21);
  assert.deepEqual(a[3][a[3].length - 1], [today, 30000, 25]);
  assert.ok(!zj.items.some((x) => x[0] === 1234), 'pet cages are skipped');
  assert.deepEqual(extractMarket(null), { realms: [] });
});

test('marketParts sends one realm per upload, trimmed to fit the size limit', () => {
  const m = extractMarket(auctionatorDb(), NOW);
  const parts = marketParts(m);
  assert.deepEqual(parts.map((p) => p.realms.map((r) => r.key)), [["Zul'jin Horde"], ['Old Realm Horde']]);
  assert.equal(parts[0].realms[0].items.length, m.realms[0].items.length);
  const limit = 1500;
  const small = marketParts(m, limit);
  for (const p of small) assert.ok(JSON.stringify(p).length <= limit);
  assert.ok(small[0].realms[0].items.length < m.realms[0].items.length);
  assert.deepEqual(small[0].realms[0].items[0], m.realms[0].items[0], 'keeps the most recently seen first');
  assert.deepEqual(marketParts(null), []);
});

test('findDeals: real discounts with enough history, vendor flips, flags, budget, stale scans', () => {
  const { DatabaseSync } = require('node:sqlite');
  const { open } = require('../../src/core/db');
  const db = open(':memory:');
  assert.ok(DatabaseSync);
  const stored = D.applyMarket(db, extractMarket(auctionatorDb(), NOW));
  assert.equal(stored.realms, 2);
  db.prepare("INSERT INTO item_info (item_id, name, found, sell_price) VALUES (4338, 'Mageweave Cloth', 1, 2000)").run();
  db.prepare("INSERT INTO item_names (item_id, name) VALUES (14047, 'Runecloth'), (13510, 'Flask of the Titans'), (13444, 'Major Mana Potion')").run();

  let r = D.findDeals(db, { now: NOW });
  assert.equal(r.realm, "Zul'jin Horde");
  assert.equal(r.scan.day, D.dayToDate(today));
  assert.deepEqual(r.notes, []);
  const ids = r.deals.map((d) => d.item_id);
  assert.ok(ids.includes(14047)); assert.ok(ids.includes(13510));
  for (const no of [2589, 12359, 13446, 4338]) assert.ok(!ids.includes(no), `${no} is not a resale deal`);
  const a = r.deals.find((d) => d.item_id === 14047);
  assert.equal(a.worth, 50000); assert.equal(a.resale, 47500); assert.equal(a.profit, 17500);
  assert.equal(a.sure, 'high'); assert.equal(a.listed, 25); assert.equal(a.name, 'Runecloth');
  assert.ok(a.flags.some((f) => f.kind === 'low'));
  const g = r.deals.find((d) => d.item_id === 13510);
  assert.ok(g.flags.some((f) => f.kind === 'slow'));
  assert.notEqual(g.sure, 'high');
  assert.equal(r.vendor.length, 1);
  assert.deepEqual([r.vendor[0].item_id, r.vendor[0].profit, r.vendor[0].sure], [4338, 1500, 'certain']);

  // The falling item is valued at last week's price, and flagged; a higher bar leaves it out.
  const d = r.deals.find((x) => x.item_id === 13444);
  assert.equal(d.worth, 30000); assert.equal(d.profit, 5500);
  assert.ok(!D.findDeals(db, { now: NOW, minProfit: 6000 }).deals.some((x) => x.item_id === 13444));
  assert.ok(d.flags.some((f) => f.kind === 'falling'));

  // Budget: the best that fits.
  r = D.findDeals(db, { now: NOW, budget: 40000 });
  assert.deepEqual(r.plan.items, [4338, 14047]);
  assert.equal(r.plan.spend, 30500);
  // The plan only picks deals the page shows.
  r = D.findDeals(db, { now: NOW, budget: 1e9, limit: 1 });
  const shown = new Set([...r.deals, ...r.vendor].map((x) => x.item_id));
  assert.ok(r.plan.items.length >= 1 && r.plan.items.every((id) => shown.has(id)));
  assert.equal(r.plan.spend, [...r.deals, ...r.vendor].reduce((s, x) => s + x.buy, 0));
  r = D.findDeals(db, { now: NOW, maxPrice: 100000 });
  assert.ok(!r.deals.some((x) => x.item_id === 13510));

  // Another realm on request; an old scan says so.
  r = D.findDeals(db, { now: NOW, realm: 'Old Realm Horde' });
  assert.equal(r.realm, 'Old Realm Horde');
  assert.match(r.notes[0], /3 days ago\. Prices move fast/);
  assert.equal(D.findDeals(db, { now: NOW, preferRealms: ['Old Realm'] }).realm, 'Old Realm Horde');
});

test('GET /api/deals and POST /api/market; the addon gets the best deals', async () => {
  const c = await startCore();
  try {
    seedGuild(c.db, { realm: "Zul'jin", faction: 'Horde' });
    let r = await c.api.get('/api/deals');
    assert.equal(r.status, 200);
    assert.equal(r.body.realm, null);
    assert.equal((await c.api.post('/api/market', { nope: 1 })).status, 400);
    r = await c.api.post('/api/market', extractMarket(auctionatorDb(), NOW));
    assert.deepEqual([r.status, r.body.realms], [200, 2]);
    r = await c.api.get('/api/deals?min_profit=10000&budget=100000');
    assert.equal(r.body.realm, "Zul'jin Horde");
    assert.ok(r.body.deals.every((d) => d.profit >= 10000));
    assert.ok(r.body.plan.items.length >= 1);
    r = await c.api.get('/api/inbox');
    assert.equal(r.body.deals.realm, "Zul'jin Horde");
    assert.ok(r.body.deals.items.some((d) => d.id === 14047));
    assert.ok(r.body.deals.vendor.some((d) => d.id === 4338) === false, 'no vendor price known in this guild yet');
  } finally { await c.close(); }
});
