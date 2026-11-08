'use strict';
// Economy: guild bank, bank requests, bank characters, alt search, price index, supply drives.
// Every request is "me" (I play Grunta and the alt Stashy); Thrallia (the Guild Master) and Velanne (an
// officer) are guildmates. Bank requests, bank characters and drives are shared records (docs/SHARING.md §10):
// the tests check what each action queues and that rows and replies come out as before through the
// projection; Garona's records arrive the way an upload brings them in.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startCore, seedGuild, addPlayer, asRole } = require('./helpers');
const { shareKit } = require('./share-kit');
const sharing = require('../../src/core/sharing');
const { applyPayload } = require('../../src/core/services/sync');
const identity = require('../../src/core/identity');
const { priceChange } = require('../../src/core/routes/economy');

const WEBHOOK = 'https://discord.com/api/webhooks/123/abc';
const DAY0 = Date.UTC(2020, 0, 1);
const today = Math.floor((Date.now() - DAY0) / 86400000);
const dayStr = (d) => new Date(DAY0 + d * 86400000).toISOString().slice(0, 10);

async function setup({ role = 'member' } = {}) {
  const discord = [];
  const fetch = async (url, init) => {
    discord.push({ url, content: JSON.parse(init.body).content });
    return new Response(null, { status: 204 });
  };
  const c = await startCore({ fetch, settings: { discordWebhook: WEBHOOK } });
  const g = seedGuild(c.db, { role, character: 'Grunta', cls: 'WARRIOR', level: 58 });
  const thrall = addPlayer(c.db, g.guildId, 'Thrall#1111', { role: 'owner', character: 'Thrallia', cls: 'SHAMAN' });
  const velanne = addPlayer(c.db, g.guildId, 'Velanne#2222', { role: 'officer', character: 'Velanne', cls: 'PRIEST' });
  const scannedAt = Math.floor(Date.now() / 1000) - 600;
  applyPayload(c.db, g.guildId, thrall.id, {
    characters: {
      Thrallia: {
        name: 'Thrallia', class: 'SHAMAN', level: 60,
        inventory: {
          bags: [{ id: 14047, name: 'Runecloth', count: 12 }, { id: 13444, name: 'Major Mana Potion', count: 3 }],
          bank: [{ id: 14047, name: 'Runecloth', count: 40 }],
        },
      },
    },
  });
  applyPayload(c.db, g.guildId, g.me, {
    characters: {
      Grunta: { name: 'Grunta', class: 'WARRIOR', level: 58, inventory: { bags: [{ id: 2589, name: 'Linen Cloth', count: 5 }] } },
      Stashy: {
        name: 'Stashy', class: 'MAGE', level: 12,
        inventory: { bags: [{ id: 13444, name: 'Major Mana Potion', count: 10 }], bank: [{ id: 14047, name: 'Runecloth', count: 100 }] },
      },
    },
    guildBank: {
      scannedAt,
      money: 1234567,
      tabs: [
        { name: 'Raid', items: [{ id: 13457, name: 'Greater Fire Protection Potion', count: 6 }] },
        { name: 'Mats', items: [{ id: 14047, name: 'Runecloth', count: 30 }, { id: 12359, name: 'Thorium Bar', count: 20 }] },
      ],
      log: [
        { kind: 'deposit', who: 'Grommash', id: 14047, name: 'Runecloth', count: 10, at: scannedAt - 3600 },
        { kind: 'withdraw', who: 'Thrallia', amount: 50000, at: scannedAt - 7200 },
      ],
    },
    prices: {
      items: [
        [14047, 150, today - 6], [14047, 130, today - 3], [14047, 120, today],
        [13457, 9000, today - 1],
        [13444, 4000, today],
        [99999, 77, today], // never named: only findable by number
      ],
    },
  });
  identity.refreshMyName(c.db);
  const kit = shareKit(c);
  return {
    c, db: c.db, g, me: g.me, thrall, velanne, discord, api: c.api, kit,
    close: async () => { kit.restore(); await c.close(); },
    audit: () => c.db.prepare('SELECT action, detail FROM audit_log ORDER BY id').all(),
    activity: () => c.db.prepare('SELECT kind, text FROM activity ORDER BY id').all().map((a) => `${a.kind}: ${a.text}`),
  };
}

test('priceChange: percent from the oldest to the newest point', () => {
  assert.equal(priceChange([]), null);
  assert.equal(priceChange([{ day: 'a', price: 100 }]), null);
  assert.equal(priceChange([{ price: 150 }, { price: 130 }, { price: 120 }]), -20);
  assert.equal(priceChange([{ price: 300 }, { price: 400 }]), 33.3);
});

test('guild bank: tabs in game order, priced items, gold, log; needs the guild', async () => {
  const t = await setup();
  try {
    const { status, body } = await t.api.get('/api/bank');
    assert.equal(status, 200);
    assert.equal(body.money, 1234567);
    assert.match(body.scanned_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(body.tabs.map((x) => x.name), ['Raid', 'Mats']);
    const mats = body.tabs[1];
    assert.deepEqual(mats.items.map((i) => i.name), ['Runecloth', 'Thorium Bar']);
    assert.deepEqual(mats.items[0], { item_id: 14047, name: 'Runecloth', count: 30, unit: 120, value: 3600 });
    assert.equal(mats.items[1].unit, null, 'no price for Thorium Bar');
    assert.equal(mats.value, 3600);
    assert.equal(body.tabs[0].value, 54000);
    assert.deepEqual(body.value, { guildBank: 57600, bankCharacters: 0, total: 57600 });
    assert.deepEqual(body.bankCharacters, []);
    assert.equal(body.log.length, 2);
    assert.deepEqual(body.log[0], { id: body.log[0].id, kind: 'deposit', who: 'Grommash', item_id: 14047, count: 10, amount: null, at: body.log[0].at, name: 'Runecloth' });
    assert.equal(body.log[1].amount, 50000);
    assert.equal(body.log[1].name, null);
    assert.deepEqual(body.requests, []);
  } finally { await t.close(); }
  const empty = await startCore();
  try { assert.equal((await empty.api.get('/api/bank')).status, 403); } finally { await empty.close(); }
});

test('alt search finds items on your own characters only', async () => {
  const t = await setup();
  try {
    let r = await t.api.get('/api/bank/search?q=rune');
    assert.equal(r.status, 200);
    assert.equal(r.body.q, 'rune');
    assert.deepEqual(r.body.results, [{ character: 'Stashy', class: 'MAGE', location: 'bank', item_id: 14047, count: 100, name: 'Runecloth' }]);
    r = await t.api.get('/api/bank/search?q=mana');
    assert.deepEqual(r.body.results.map((x) => x.character), ['Stashy'], 'Thrallia\'s potions are not mine');
    // LIKE wildcards are matched literally.
    assert.deepEqual((await t.api.get('/api/bank/search?q=%25')).body.results, []);
    assert.deepEqual((await t.api.get('/api/bank/search?q=_')).body.results, []);
    assert.deepEqual((await t.api.get('/api/bank/search')).body, { q: '', results: [] });
    assert.equal((await t.api.get(`/api/bank/search?q=${'x'.repeat(200)}`)).body.q.length, 60);
  } finally { await t.close(); }
});

test('bank requests: bq to ask and cancel, BH when officers send or decline; the old rules, audit and activity', async () => {
  const t = await setup();
  try {
    assert.equal((await t.api.post('/api/bank/requests', { item: '   ' })).body.error, 'Name the item you need.');
    let r = await t.api.post('/api/bank/requests', { item: 'Runecloth', count: '20', note: 'bandages' });
    assert.equal(r.status, 201);
    assert.equal(r.body.message, 'Request posted.');
    assert.deepEqual({ ...r.body.request, created_at: 0, updated_at: 0 }, {
      id: r.body.request.id, item: 'Runecloth', count: 20, note: 'bandages', status: 'open', requester_id: t.me,
      requester: 'Grunta', handled_by: null, handler: null, created_at: 0, updated_at: 0, mine: true,
    });
    const reqId = r.body.request.id;
    const bq = t.kit.last('bq');
    assert.deepEqual([bq.need, bq.base, bq.del, bq.final], [null, '', false, false]);
    assert.deepEqual(bq.fields, { pid: sharing.myPid(t.db), item: 'Runecloth', count: 20, note: 'bandages', state: 'o' });
    assert.ok(t.activity().includes('bank: Grunta asked the bank for 20 × Runecloth'));
    assert.deepEqual(t.c.events, [], 'I asked: I am not told');
    assert.deepEqual(t.discord, [], 'Discord waits until the game sends it');
    t.kit.ack(bq);
    await t.kit.settle();
    assert.deepEqual(t.discord.map((d) => [d.url, d.content]), [[WEBHOOK, '🏦 **Bank request:** 20 × Runecloth, for Grunta']]);

    // Counts are clamped to 1-1000; a missing count is 1.
    assert.equal((await t.api.post('/api/bank/requests', { item: 'Silk', count: 5000 })).body.request.count, 1000);
    assert.equal((await t.api.post('/api/bank/requests', { item: 'Wool', count: 'lots' })).body.request.count, 1);
    const woolId = reqId + 2;
    // A guildmate's request.
    const garona = t.kit.mate('Garona', { battletag: 'Garona#4' });
    t.kit.imp([t.kit.rec('bq', 'ga0001', { pid: garona.pid, item: 'Thorium Bar', count: 5, state: 'o' }, { author: 'Garona' })]);
    assert.deepEqual(t.c.events, [], 'bank requests are for officers to hear about');

    let bank = (await t.api.get('/api/bank')).body;
    assert.deepEqual(bank.requests.map((x) => [x.item, x.mine]), [['Thorium Bar', false], ['Wool', true], ['Silk', true], ['Runecloth', true]]);
    const theirs = bank.requests[0].id;
    assert.equal(bank.requests[0].requester, 'Garona');

    // Members can't mark sent; officers can. Only the asker can cancel.
    r = await t.api.post(`/api/bank/requests/${reqId}/sent`);
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'Only officers can mark bank requests sent or declined.');
    r = await t.api.post(`/api/bank/requests/${theirs}/cancel`);
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'Only the person who asked can cancel a request.');
    r = await t.api.post(`/api/bank/requests/${woolId}/cancel`);
    assert.equal(r.body.message, 'Request cancelled.');
    assert.equal(r.body.request.status, 'cancelled');
    const cancel = t.kit.last('bq');
    assert.deepEqual([cancel.final, cancel.fields.state, cancel.fields.item, cancel.need], [true, 'x', 'Wool', null]);
    assert.deepEqual(t.kit.queued('BH'), []);

    asRole(t.db, 'officer');
    r = await t.api.post(`/api/bank/requests/${theirs}/sent`);
    assert.equal(r.status, 200);
    assert.equal(r.body.message, 'Marked as sent.');
    assert.equal(r.body.request.status, 'sent');
    assert.equal(r.body.request.handler, 'Grunta');
    assert.equal(r.body.request.handled_by, t.me);
    const bh = t.kit.last('BH');
    assert.deepEqual([bh.key, bh.need, bh.fields], ['ga0001', 'o', { state: 's' }]);
    assert.equal((await t.api.post(`/api/bank/requests/${theirs}/declined`)).status, 409);
    assert.equal((await t.api.post(`/api/bank/requests/${theirs}/cancel`)).body.error, 'That request has already been handled.');
    r = await t.api.post(`/api/bank/requests/${reqId + 1}/declined`);
    assert.equal(r.body.message, 'Request declined.');
    assert.deepEqual(t.kit.last('BH').fields, { state: 'd' });
    assert.equal((await t.api.post('/api/bank/requests/9999/sent')).status, 404);
    assert.equal((await t.api.post(`/api/bank/requests/${reqId}/approve`)).status, 404);
    assert.equal((await t.api.post('/api/bank/requests/abc/sent')).status, 404);
    assert.deepEqual(t.c.events, [], 'telling Garona is her app\'s business');

    assert.deepEqual(t.audit().filter((a) => a.action.startsWith('bank')), [
      { action: 'bank request sent', detail: '5 × Thorium Bar' },
      { action: 'bank request declined', detail: '1000 × Silk' },
    ]);
    assert.ok(t.activity().includes('bank: 5 × Thorium Bar sent from the bank'));

    // Handled requests stay listed for a week; cancelled ones disappear.
    bank = (await t.api.get('/api/bank')).body;
    assert.deepEqual(bank.requests.map((x) => [x.item, x.status]), [['Runecloth', 'open'], ['Thorium Bar', 'sent'], ['Silk', 'declined']]);
    t.db.prepare("UPDATE bank_requests SET updated_at = datetime('now', '-8 days') WHERE id = ?").run(reqId + 1);
    assert.deepEqual((await t.api.get('/api/bank')).body.requests.map((x) => x.item), ['Runecloth', 'Thorium Bar']);

    // A request from before sharing can be read but not changed.
    const old = Number(t.db.prepare("INSERT INTO bank_requests (guild_id, requester_id, item, count) VALUES (?,?, 'Old', 1)").run(t.g.guildId, t.me).lastInsertRowid);
    r = await t.api.post(`/api/bank/requests/${old}/cancel`);
    assert.deepEqual([r.status, r.body.error], [409, 'This was made with an older Guild Camp and can’t be changed. Make it again.']);
  } finally { await t.close(); }
});

test('bank characters: officers mark them (one BC list, edited on top of the stored version), their bags and banks show up priced', async () => {
  const t = await setup();
  try {
    assert.equal((await t.api.get('/api/bank/alts')).status, 403);
    assert.equal((await t.api.put('/api/bank/alts', { names: ['Stashy'] })).status, 403);
    asRole(t.db, 'officer');
    let r = await t.api.get('/api/bank/alts');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.characters.map((c) => [c.name, c.owner, c.is_bank]), [['Grunta', 'Grunta', 0], ['Stashy', 'Grunta', 0], ['Thrallia', 'Thrall', 0], ['Velanne', 'Velanne', 0]]);
    assert.equal(r.body.characters.find((c) => c.name === 'Stashy').items, 2);

    assert.equal((await t.api.put('/api/bank/alts', { names: 'Stashy' })).status, 400);
    r = await t.api.put('/api/bank/alts', { names: ['Nobody'] });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'There is no character called Nobody in the guild.');
    assert.deepEqual(t.kit.queued('BC'), []);

    r = await t.api.put('/api/bank/alts', { names: ['stashy'] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.bankCharacters, ['Stashy']);
    assert.equal(r.body.message, 'Stashy is now a bank character. Its bags and bank show here after its next sync.');
    const bc = t.kit.last('BC');
    assert.deepEqual([bc.key, bc.need, bc.base, bc.fields], ['1', 'o', '', { names: ['Stashy'] }]);

    const bank = (await t.api.get('/api/bank')).body;
    assert.equal(bank.bankCharacters.length, 1);
    const st = bank.bankCharacters[0];
    assert.equal(st.name, 'Stashy');
    assert.equal(st.class, 'MAGE');
    assert.equal(st.owner, 'Grunta');
    // Bags and bank are added together per item.
    assert.deepEqual(st.items.map((i) => [i.name, i.count, i.unit, i.value]), [['Major Mana Potion', 10, 4000, 40000], ['Runecloth', 100, 120, 12000]]);
    assert.equal(st.value, 52000);
    assert.deepEqual(bank.value, { guildBank: 57600, bankCharacters: 52000, total: 109600 });

    r = await t.api.put('/api/bank/alts', { names: ['Stashy', 'Grunta'] });
    assert.equal(r.body.message, 'Grunta is now a bank character. Its bags and bank show here after its next sync.');
    r = await t.api.put('/api/bank/alts', { names: ['Grunta'] });
    assert.equal(r.body.message, 'Stashy is no longer a bank character.');
    const queuedBefore = t.kit.queued().length;
    r = await t.api.put('/api/bank/alts', { names: ['Grunta'] });
    assert.equal(r.body.message, 'No changes.');
    assert.equal(t.kit.queued().length, queuedBefore, 'no change, nothing to share');
    assert.deepEqual(t.kit.queued('BC').map((e) => [e.fields.names, e.base]), [[['Grunta'], '']], 'one list, replaced while it waits');
    t.kit.ack(t.kit.last('BC'));
    r = await t.api.put('/api/bank/alts', { names: ['Thrallia', 'Stashy'] });
    assert.deepEqual([r.body.added, r.body.removed], [['Thrallia', 'Stashy'], ['Grunta']]);
    assert.match(r.body.message, /^Bank characters saved/);
    assert.equal(t.kit.last('BC').base, sharing.baseOf(t.db, t.g.guildId, 'BC:1'), 'an edit of the list the game confirmed');
    assert.notEqual(t.kit.last('BC').base, '');
    assert.deepEqual(t.audit().filter((a) => a.action.startsWith('bank character')), [
      { action: 'bank character added', detail: 'Stashy' },
      { action: 'bank character added', detail: 'Grunta' },
      { action: 'bank character removed', detail: 'Stashy' },
      { action: 'bank character added', detail: 'Thrallia' },
      { action: 'bank character added', detail: 'Stashy' },
      { action: 'bank character removed', detail: 'Grunta' },
    ]);

    // Someone changed the list in the meantime: the game refuses mine, and the list goes back to the guild's.
    t.kit.ack(t.kit.last('BC'), 'no,stale');
    assert.deepEqual((await t.api.get('/api/bank/alts')).body.characters.filter((c) => c.is_bank).map((c) => c.name), ['Grunta']);

    r = await t.api.put('/api/bank/alts', { names: [] });
    assert.deepEqual(r.body.bankCharacters, []);
    assert.deepEqual(t.kit.last('BC').fields, { names: [] });
    assert.equal((await t.api.put('/api/bank/alts', { names: new Array(51).fill('Stashy') })).status, 400);
  } finally { await t.close(); }
});

test('prices: stats, what the guild holds, search with trend and change, bank stock value', async () => {
  const t = await setup();
  try {
    let r = await t.api.get('/api/prices');
    assert.equal(r.status, 200);
    assert.equal(r.body.q, '');
    assert.deepEqual(r.body.stats, { items: 4, newest: dayStr(today) });
    assert.deepEqual(r.body.results, []);
    // Most-held first: Runecloth is on Thrallia (bags + bank), Stashy and in the guild bank.
    assert.equal(r.body.held[0].name, 'Runecloth');
    assert.equal(r.body.held[0].holders, 4);
    assert.deepEqual(r.body.held.map((h) => h.name).sort(), ['Greater Fire Protection Potion', 'Major Mana Potion', 'Runecloth']);
    const rune = r.body.held[0];
    assert.deepEqual(rune.latest, { day: dayStr(today), price: 120 });
    assert.deepEqual(rune.history.map((h) => h.price), [150, 130, 120]);
    assert.equal(rune.change, -20);
    assert.equal(r.body.held.find((h) => h.name === 'Major Mana Potion').change, null);
    assert.deepEqual({ ...r.body.bank, top: r.body.bank.top.map((x) => x.name) }, {
      guildBank: 57600, bankCharacters: 0, total: 57600, priced: 2, unpriced: 1,
      top: ['Greater Fire Protection Potion', 'Runecloth'],
    });
    assert.deepEqual(r.body.bank.top[1], { item_id: 14047, name: 'Runecloth', count: 30, unit: 120, value: 3600, tab: 'Mats', character: null });
    t.db.prepare("UPDATE characters SET is_bank = 1 WHERE name = 'Stashy'").run();
    const top = (await t.api.get('/api/prices')).body.bank.top;
    assert.deepEqual(top.map((x) => [x.name, x.tab, x.character]), [
      ['Greater Fire Protection Potion', 'Raid', null], ['Major Mana Potion', null, 'Stashy'], ['Runecloth', null, 'Stashy'], ['Runecloth', 'Mats', null],
    ]);

    r = await t.api.get('/api/prices?q=mana');
    assert.equal(r.body.q, 'mana');
    assert.deepEqual(r.body.held, []);
    assert.deepEqual(r.body.results.map((x) => [x.item_id, x.name, x.latest.price]), [[13444, 'Major Mana Potion', 4000]]);
    r = await t.api.get('/api/prices?q=99999');
    assert.deepEqual(r.body.results.map((x) => [x.item_id, x.name, x.latest.price]), [[99999, null, 77]]);
    assert.deepEqual((await t.api.get('/api/prices?q=nothing-like-this')).body.results, []);

    // Only the newest 14 scan days are kept in the trend.
    const ins = t.db.prepare('INSERT OR REPLACE INTO prices (guild_id, item_id, day, price) VALUES (?,?,?,?)');
    for (let d = 1; d <= 20; d++) ins.run(t.g.guildId, 12359, dayStr(today - d), 1000 + d);
    r = await t.api.get('/api/prices?q=thorium');
    assert.equal(r.body.results[0].history.length, 14);
    assert.equal(r.body.results[0].history[13].price, 1001);
  } finally { await t.close(); }
});

test('supply drives: DR to start and close (final), dc for hand-ins; officers start and close, everyone gives, goal reached once', async () => {
  const t = await setup();
  try {
    assert.equal((await t.api.post('/api/drives', { title: 'Crates', unit: 'crates', goal: 10 })).status, 403);
    asRole(t.db, 'officer');
    for (const bad of [{ unit: 'crates', goal: 10 }, { title: 'Crates', goal: 10 }, { title: 'Crates', unit: 'crates' }, { title: 'Crates', unit: 'crates', goal: 0 }]) {
      const r = await t.api.post('/api/drives', bad);
      assert.equal(r.status, 400);
      assert.equal(r.body.error, 'Give the drive a name, what you’re collecting, and a goal.');
    }
    let r = await t.api.post('/api/drives', { title: 'Durotar crates', unit: 'crates', goal: '10', notes: 'Hand in at Razor Hill' });
    assert.equal(r.status, 201);
    assert.equal(r.body.message, 'Drive started.');
    const d = r.body.drive;
    assert.deepEqual({ ...d, id: 0, created_at: 0 }, {
      id: 0, title: 'Durotar crates', unit: 'crates', goal: 10, notes: 'Hand in at Razor Hill', status: 'open',
      created_by: t.me, creator: 'Grunta', created_at: 0, total: 0, pct: 0, contributors: 0, mine: 0, leaderboard: [],
    });
    const dr = t.kit.last('DR');
    assert.deepEqual([dr.need, dr.base, dr.final], ['o', '', false]);
    assert.deepEqual(dr.fields, { title: 'Durotar crates', unit: 'crates', goal: 10, notes: 'Hand in at Razor Hill', state: 'o' });
    assert.equal((await t.api.post('/api/drives', { title: 'Huge', unit: 'gold', goal: 1e12 })).body.drive.goal, 1e7);
    const hugeId = d.id + 1;
    assert.deepEqual(t.c.events, [], 'the officer who started it is not told');
    assert.deepEqual(t.discord, []);
    for (const e of t.kit.queued('DR')) t.kit.ack(e);
    await t.kit.settle();
    assert.deepEqual(t.discord.map((x) => x.content), [
      '📦 **Supply drive: Durotar crates**. Goal: 10 crates. Log what you hand in under Drives in Guild Camp.',
      '📦 **Supply drive: Huge**. Goal: 10,000,000 gold. Log what you hand in under Drives in Guild Camp.',
    ]);

    // Giving
    assert.equal((await t.api.post(`/api/drives/${d.id}/give`, { amount: 0 })).body.error, 'How many did you hand in?');
    assert.equal((await t.api.post(`/api/drives/${d.id}/give`, { amount: 'some' })).status, 400);
    assert.equal((await t.api.post('/api/drives/999/give', { amount: 1 })).status, 404);
    r = await t.api.post(`/api/drives/${d.id}/give`, { amount: 4, character: 'Grunta', note: 'first batch' });
    assert.equal(r.status, 200);
    assert.equal(r.body.message, 'Logged 4 crates.');
    assert.equal(r.body.reached, false);
    const dc = t.kit.last('dc');
    assert.deepEqual([dc.need, dc.final], [null, false]);
    assert.deepEqual(dc.fields, { pid: sharing.myPid(t.db), drive: dr.key, character: 'Grunta', amount: 4, note: 'first batch' });
    const garona = t.kit.mate('Garona', { battletag: 'Garona#4' });
    t.kit.imp([t.kit.rec('dc', 'ga0002', { pid: garona.pid, drive: dr.key, character: 'Garona', amount: 2 }, { author: 'Garona' })]);
    r = await t.api.post(`/api/drives/${d.id}/give`, { amount: 1 }); // no character: my name counts
    assert.equal(t.kit.last('dc').fields.character, '');
    assert.equal(t.kit.queued('dc').length, 2, 'each hand-in is its own record');
    assert.deepEqual([r.body.drive.total, r.body.drive.pct, r.body.drive.mine, r.body.drive.contributors], [7, 70, 5, 2]);
    assert.deepEqual(r.body.drive.leaderboard, [{ who: 'Grunta', amount: 5 }, { who: 'Garona', amount: 2 }]);
    let list = (await t.api.get('/api/drives')).body;
    assert.deepEqual(list.myCharacters, ['Grunta', 'Stashy']);
    assert.deepEqual(list.open.map((x) => x.title), ['Huge', 'Durotar crates']);
    assert.equal(list.open[1].mine, 5);
    assert.deepEqual(list.past, []);

    // Reaching the goal finishes the drive, once.
    r = await t.api.post(`/api/drives/${d.id}/give`, { amount: 5, character: 'Grunta' });
    assert.equal(r.body.reached, true);
    assert.equal(r.body.message, 'Goal reached. Thank you!');
    assert.equal(r.body.drive.status, 'done');
    assert.equal(r.body.drive.pct, 100);
    r = await t.api.post(`/api/drives/${d.id}/give`, { amount: 5 });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'That drive has finished.');
    assert.equal(t.kit.queued('dc').length, 3);

    // Closing
    asRole(t.db, 'member');
    assert.equal((await t.api.post(`/api/drives/${hugeId}/close`)).status, 403);
    asRole(t.db, 'officer');
    assert.equal((await t.api.post('/api/drives/999/close')).status, 404);
    r = await t.api.post(`/api/drives/${hugeId}/close`);
    assert.equal(r.body.message, 'Drive closed.');
    assert.equal(r.body.drive.status, 'closed');
    const closing = t.kit.last('DR');
    assert.deepEqual([closing.final, closing.fields.state, closing.fields.title, closing.need], [true, 'c', 'Huge', 'o']);
    assert.equal(closing.base, sharing.baseOf(t.db, t.g.guildId, `DR:${closing.key}`), 'closed on top of the version the game confirmed');
    assert.notEqual(closing.base, '');
    assert.equal((await t.api.post(`/api/drives/${hugeId}/close`)).status, 200);
    assert.equal(t.kit.queued('DR').length, 1, 'closing a closed drive changes nothing');
    list = (await t.api.get('/api/drives')).body;
    assert.deepEqual(list.open, []);
    assert.deepEqual(list.past.map((x) => [x.title, x.status]), [['Huge', 'closed'], ['Durotar crates', 'done']]);

    assert.deepEqual(t.audit().filter((a) => a.action.startsWith('drive')), [
      { action: 'drive started', detail: 'Durotar crates' },
      { action: 'drive started', detail: 'Huge' },
      { action: 'drive closed', detail: `#${hugeId}` },
    ]);
    const act = t.activity();
    assert.ok(act.includes('drive: New supply drive: Durotar crates'));
    assert.ok(act.includes('drive: Durotar crates reached its goal!'));

    // A drive from before sharing can be read but not given to.
    const old = Number(t.db.prepare("INSERT INTO drives (guild_id, title, unit, goal) VALUES (?, 'Old', 'bars', 5)").run(t.g.guildId).lastInsertRowid);
    r = await t.api.post(`/api/drives/${old}/give`, { amount: 1 });
    assert.deepEqual([r.status, r.body.error], [409, 'This was made with an older Guild Camp and can’t be changed. Make it again.']);
  } finally { await t.close(); }
});

test('a new bank request cancelled from the outbox, or refused by the game (no,expired), leaves no open request that can never be cancelled', async () => {
  const t = await setup();
  try {
    const rows = (key) => t.db.prepare('SELECT status FROM bank_requests WHERE guild_id = ? AND share_id = ?').all(t.g.guildId, key).map((x) => x.status);
    const shown = async () => (await t.api.get('/api/bank')).body.requests.map((x) => [x.item, x.status]);
    let r = await t.api.post('/api/bank/requests', { item: 'Runecloth', count: 5 });
    assert.equal(r.status, 201);
    const first = t.kit.last('bq');
    assert.deepEqual(rows(first.key), ['open'], 'shown at once');
    assert.equal((await t.api.post(`/api/share/outbox/${first.op}/cancel`)).status, 200);
    assert.deepEqual(rows(first.key), [], 'dropped before the guild had it: gone');
    assert.deepEqual(await shown(), []);
    assert.equal((await t.api.post(`/api/bank/requests/${r.body.request.id}/cancel`)).status, 404);

    // Waited too long and was never sent.
    await t.api.post('/api/bank/requests', { item: 'Silk', count: 2 });
    const second = t.kit.last('bq');
    t.kit.ack(second, 'no,expired');
    assert.equal(t.kit.entry(second.op).note, 'This waited too long and was not sent.');
    assert.deepEqual(rows(second.key), []);
    assert.deepEqual(await shown(), []);

    // A request the guild has keeps its row when a later change of mine is refused.
    r = await t.api.post('/api/bank/requests', { item: 'Wool', count: 1 });
    const third = t.kit.last('bq');
    t.kit.ack(third);
    assert.equal((await t.api.post(`/api/bank/requests/${r.body.request.id}/cancel`)).status, 200);
    t.kit.ack(t.kit.last('bq'), 'no,stale');
    assert.deepEqual(rows(third.key), ['open']);
    assert.deepEqual(await shown(), [['Wool', 'open']]);
  } finally { await t.close(); }
});

test('bank characters: a first-ever list cancelled from the outbox or refused by the game leaves no bank characters behind', async () => {
  const t = await setup({ role: 'officer' });
  try {
    const bank = () => t.db.prepare('SELECT name FROM characters WHERE guild_id = ? AND is_bank = 1 ORDER BY name').all(t.g.guildId).map((x) => x.name);
    await t.api.put('/api/bank/alts', { names: ['Stashy'] });
    assert.deepEqual(bank(), ['Stashy'], 'shown at once');
    const first = t.kit.last('BC');
    assert.equal(first.base, '');
    assert.equal((await t.api.post(`/api/share/outbox/${first.op}/cancel`)).status, 200);
    assert.deepEqual(bank(), []);
    assert.deepEqual((await t.api.get('/api/bank')).body.bankCharacters, []);

    await t.api.put('/api/bank/alts', { names: ['Stashy', 'Grunta'] });
    t.kit.ack(t.kit.last('BC'), 'no,expired');
    assert.deepEqual(bank(), []);
  } finally { await t.close(); }
});

test('my own hand-in that brings a drive to its goal posts the old Discord line when its "ok" arrives, once; earlier hand-ins and later ones do not', async () => {
  const t = await setup();
  try {
    const garona = t.kit.mate('Garona', { battletag: 'Garona#4' });
    t.kit.imp([t.kit.rec('DR', 'dr0001', { title: 'Durotar crates', unit: 'crates', goal: 10, notes: '', state: 'o' }, { author: 'Thrallia' })]);
    const id = t.db.prepare("SELECT id FROM drives WHERE share_id = 'dr0001'").get().id;
    await t.api.post(`/api/drives/${id}/give`, { amount: 3 });
    const a = t.kit.last('dc');
    const r = await t.api.post(`/api/drives/${id}/give`, { amount: 5 });
    assert.equal(r.body.reached, false);
    const b = t.kit.last('dc');
    // Garona's hand-in reaches the guild first; the goal still needs one of mine.
    t.kit.imp([t.kit.rec('dc', 'ga0003', { pid: garona.pid, drive: 'dr0001', character: 'Garona', amount: 2 }, { author: 'Garona' })]);
    t.kit.ack(a);
    await t.kit.settle();
    assert.deepEqual(t.discord, [], '5 of 10 at the guild');
    t.kit.ack(b);
    await t.kit.settle();
    assert.deepEqual(t.discord.map((x) => [x.url, x.content]), [[WEBHOOK, '🎉 **Durotar crates** reached its goal of 10 crates. Thanks everyone!']]);
    // A hand-in that was still on its way when the goal was reached: no second post.
    sharing.queue(t.db, t.c.ctx, { type: 'dc', key: 'dc0009', fields: { pid: sharing.myPid(t.db), drive: 'dr0001', character: '', amount: 4, note: '' } });
    t.kit.ack(t.kit.last('dc'));
    await t.kit.settle();
    assert.equal(t.discord.length, 1);
    // A drive a guildmate's hand-in finished: their app's business.
    t.kit.imp([t.kit.rec('DR', 'dr0002', { title: 'Linen', unit: 'bolts', goal: 5, notes: '', state: 'o' }, { author: 'Thrallia' })]);
    const linen = t.db.prepare("SELECT id FROM drives WHERE share_id = 'dr0002'").get().id;
    await t.api.post(`/api/drives/${linen}/give`, { amount: 1 });
    t.kit.ack(t.kit.last('dc'));
    t.kit.imp([t.kit.rec('dc', 'ga0004', { pid: garona.pid, drive: 'dr0002', character: 'Garona', amount: 9 }, { author: 'Garona' })]);
    await t.kit.settle();
    assert.equal(t.discord.length, 1);
  } finally { await t.close(); }
});

test('a drive I start and fill with my own hand-in at once: both "ok"s in one upload, in either order, post the goal once', async () => {
  for (const handInFirst of [false, true]) {
    const t = await setup({ role: 'officer' });
    try {
      const r = await t.api.post('/api/drives', { title: 'Linen', unit: 'bolts', goal: 5 });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      const dr = t.kit.last('DR');
      assert.equal((await t.api.post(`/api/drives/${r.body.drive.id}/give`, { amount: 5 })).body.reached, true);
      const dc = t.kit.last('dc');
      // The addon's answers come in whatever order its table has them.
      const ok = (e) => [e.op, `ok,${e.v},${e.author}`];
      t.kit.imp([], { sent: Object.fromEntries(handInFirst ? [ok(dc), ok(dr)] : [ok(dr), ok(dc)]) });
      await t.kit.settle();
      assert.deepEqual(t.discord.map((x) => x.content).filter((x) => x.startsWith('🎉')), ['🎉 **Linen** reached its goal of 5 bolts. Thanks everyone!'],
        handInFirst ? 'the hand-in answered before the drive' : 'the drive answered before the hand-in');
    } finally { await t.close(); }
  }
});

test('a guildmate\'s hand-in that comes in the same upload as my "ok" (both played in one evening): the hand-in that reached the goal first posts it, so it is posted once', async () => {
  for (const mineReachesIt of [true, false]) {
    const t = await setup();
    try {
      const garona = t.kit.mate('Garona', { battletag: 'Garona#4' });
      t.kit.imp([t.kit.rec('DR', 'dr0001', { title: 'Durotar crates', unit: 'crates', goal: 10, notes: '', state: 'o' }, { author: 'Thrallia', t: t.kit.now() - 7200 })]);
      const id = t.db.prepare("SELECT id FROM drives WHERE share_id = 'dr0001'").get().id;
      // 20:00 one of us hands in, 20:30 the other: my addon has her record and my "ok" at logout.
      let hers;
      if (mineReachesIt) hers = t.kit.rec('dc', 'ga0003', { pid: garona.pid, drive: 'dr0001', character: 'Garona', amount: 6 }, { author: 'Garona', t: t.kit.now() - 1800 });
      await t.api.post(`/api/drives/${id}/give`, { amount: 4 });
      const mine = t.kit.last('dc');
      if (!mineReachesIt) {
        t.kit.tick(1800);
        hers = t.kit.rec('dc', 'ga0003', { pid: garona.pid, drive: 'dr0001', character: 'Garona', amount: 6 }, { author: 'Garona', t: t.kit.now() });
      }
      t.kit.imp([hers], { sent: { [mine.op]: `ok,${mine.v},${mine.author}` } });
      await t.kit.settle();
      assert.equal(t.db.prepare("SELECT status FROM drives WHERE share_id = 'dr0001'").get().status, 'done');
      assert.deepEqual(t.discord.map((x) => x.content).filter((x) => x.startsWith('🎉')),
        mineReachesIt ? ['🎉 **Durotar crates** reached its goal of 10 crates. Thanks everyone!'] : [],
        mineReachesIt ? 'mine came last and reached it: my app posts' : 'hers reached it: her app posts, mine stays quiet');
    } finally { await t.close(); }
  }
});

test('economy works without a Discord webhook', async () => {
  const t = await setup({ role: 'officer' });
  try {
    t.c.settings.discordWebhook = null;
    assert.equal((await t.api.post('/api/bank/requests', { item: 'Runecloth' })).status, 201);
    assert.equal((await t.api.post('/api/drives', { title: 'Gold', unit: 'gold', goal: 5 })).status, 201);
    assert.equal(t.discord.length, 0);
  } finally { await t.close(); }
});
