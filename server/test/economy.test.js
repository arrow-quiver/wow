// Economy: guild bank, bank requests, bank characters, alt search, price index, supply drives.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, seed, client, addUser } = require('./helpers');
const { applyPayload } = require('../src/services/sync');
const { priceChange } = require('../src/routes/economy');

const WEBHOOK = 'https://discord.com/api/webhooks/123/abc';
const DAY0 = Date.UTC(2020, 0, 1);
const today = Math.floor((Date.now() - DAY0) / 86400000);
const dayStr = (d) => new Date(DAY0 + d * 86400000).toISOString().slice(0, 10);

// A server with a guild, Discord captured by a fake fetch, and some synced economy data:
//   owner plays Thrallia; member plays Grunta and the alt Stashy; Mats + Raid guild bank tabs; prices.
async function setup() {
  const discord = [];
  const fetch = async (url, init) => {
    discord.push({ url, content: JSON.parse(init.body).content });
    return new Response(null, { status: 204 });
  };
  const srv = await startServer({ fetch });
  const s = seed(srv.db);
  srv.db.prepare('UPDATE guilds SET discord_webhook = ? WHERE id = ?').run(WEBHOOK, s.guildId);
  const scannedAt = Math.floor(Date.now() / 1000) - 600;
  applyPayload(srv.db, s.guildId, s.owner.id, {
    characters: {
      Thrallia: {
        name: 'Thrallia', class: 'SHAMAN', level: 60,
        inventory: {
          bags: [{ id: 14047, name: 'Runecloth', count: 12 }, { id: 13444, name: 'Major Mana Potion', count: 3 }],
          bank: [{ id: 14047, name: 'Runecloth', count: 40 }],
        },
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
  applyPayload(srv.db, s.guildId, s.member.id, {
    characters: {
      Grunta: { name: 'Grunta', class: 'WARRIOR', level: 58, inventory: { bags: [{ id: 2589, name: 'Linen Cloth', count: 5 }] } },
      Stashy: {
        name: 'Stashy', class: 'MAGE', level: 12,
        inventory: { bags: [{ id: 13444, name: 'Major Mana Potion', count: 10 }], bank: [{ id: 14047, name: 'Runecloth', count: 100 }] },
      },
    },
  });
  return {
    srv, s, discord,
    owner: client(srv.url, s.owner.token),
    officer: client(srv.url, s.officer.token),
    member: client(srv.url, s.member.token),
    audit: () => srv.db.prepare('SELECT action, detail FROM audit_log ORDER BY id').all(),
    activity: () => srv.db.prepare('SELECT kind, text FROM activity ORDER BY id').all().map((a) => `${a.kind}: ${a.text}`),
  };
}

async function eventsFor(c) {
  const r = await c.get('/api/events?after=0');
  assert.equal(r.status, 200);
  return r.body.events;
}

test('priceChange: percent from the oldest to the newest point', () => {
  assert.equal(priceChange([]), null);
  assert.equal(priceChange([{ day: 'a', price: 100 }]), null);
  assert.equal(priceChange([{ price: 150 }, { price: 130 }, { price: 120 }]), -20);
  assert.equal(priceChange([{ price: 300 }, { price: 400 }]), 33.3);
});

test('guild bank: tabs in game order, priced items, gold, log, sign-in and guild guards', async () => {
  const t = await setup();
  try {
    const { status, body } = await t.member.get('/api/bank');
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

    assert.equal((await client(t.srv.url).get('/api/bank')).status, 401);
    const outsider = addUser(t.srv.db, 'Outsider#9');
    assert.equal((await client(t.srv.url, outsider.token).get('/api/bank')).status, 403);
  } finally { await t.srv.close(); }
});

test('alt search finds items on your own characters only', async () => {
  const t = await setup();
  try {
    let r = await t.member.get('/api/bank/search?q=rune');
    assert.equal(r.status, 200);
    assert.equal(r.body.q, 'rune');
    assert.deepEqual(r.body.results, [{ character: 'Stashy', class: 'MAGE', location: 'bank', item_id: 14047, count: 100, name: 'Runecloth' }]);
    r = await t.owner.get('/api/bank/search?q=Runecloth');
    assert.deepEqual(r.body.results.map((x) => `${x.character}:${x.location}:${x.count}`), ['Thrallia:bags:12', 'Thrallia:bank:40']);
    r = await t.member.get('/api/bank/search?q=mana');
    assert.deepEqual(r.body.results.map((x) => x.character), ['Stashy']);
    // LIKE wildcards are matched literally.
    assert.deepEqual((await t.member.get('/api/bank/search?q=%25')).body.results, []);
    assert.deepEqual((await t.member.get('/api/bank/search?q=_')).body.results, []);
    assert.deepEqual((await t.member.get('/api/bank/search')).body, { q: '', results: [] });
    assert.equal((await t.member.get(`/api/bank/search?q=${'x'.repeat(200)}`)).body.q.length, 60);
  } finally { await t.srv.close(); }
});

test('bank requests: ask, officers get told, sent / declined / cancel rules, audit and activity', async () => {
  const t = await setup();
  try {
    assert.equal((await t.member.post('/api/bank/requests', { item: '   ' })).body.error, 'Name the item you need.');
    let r = await t.member.post('/api/bank/requests', { item: 'Runecloth', count: '20', note: 'bandages' });
    assert.equal(r.status, 201);
    assert.equal(r.body.message, 'Request sent to the officers.');
    assert.deepEqual({ ...r.body.request, created_at: 0, updated_at: 0 }, {
      id: r.body.request.id, item: 'Runecloth', count: 20, note: 'bandages', status: 'open', requester_id: t.s.member.id,
      requester: 'Member', handled_by: null, handler: null, created_at: 0, updated_at: 0, mine: true,
    });
    const reqId = r.body.request.id;
    assert.deepEqual(t.discord.map((d) => [d.url, d.content]), [[WEBHOOK, '🏦 **Bank request:** 20 × Runecloth, for Member']]);
    assert.ok(t.activity().includes('bank: Member asked the bank for 20 × Runecloth'));

    // Counts are clamped to 1-1000; a missing count is 1.
    assert.equal((await t.member.post('/api/bank/requests', { item: 'Silk', count: 5000 })).body.request.count, 1000);
    assert.equal((await t.member.post('/api/bank/requests', { item: 'Wool', count: 'lots' })).body.request.count, 1);
    const silkId = reqId + 1;
    const woolId = reqId + 2;

    // Officers (not the member who asked, not other members) are notified.
    const officerEvents = await eventsFor(t.officer);
    assert.equal(officerEvents.length, 3);
    assert.deepEqual({ ...officerEvents[0], id: 0, created_at: 0 }, {
      id: 0, kind: 'bank', title: '🏦 Bank request from Member', body: '20 × Runecloth', route: '/bank?tab=requests', created_at: 0,
    });
    assert.equal((await eventsFor(t.owner)).length, 3);
    assert.equal((await eventsFor(t.member)).length, 0);
    const other = addUser(t.srv.db, 'Other#5', { guildId: t.s.guildId });
    assert.equal((await eventsFor(client(t.srv.url, other.token))).length, 0);

    // Everyone sees the list; mine marks your own.
    let bank = (await t.owner.get('/api/bank')).body;
    assert.deepEqual(bank.requests.map((x) => [x.item, x.mine]), [['Wool', false], ['Silk', false], ['Runecloth', false]]);

    // Members can't mark sent; officers can. Only the asker can cancel.
    assert.equal((await t.member.post(`/api/bank/requests/${reqId}/sent`)).status, 403);
    r = await t.officer.post(`/api/bank/requests/${silkId}/cancel`);
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'Only the person who asked can cancel a request.');
    r = await t.officer.post(`/api/bank/requests/${reqId}/sent`);
    assert.equal(r.status, 200);
    assert.equal(r.body.message, 'Marked as sent.');
    assert.equal(r.body.request.status, 'sent');
    assert.equal(r.body.request.handler, 'Officer');
    assert.equal((await t.officer.post(`/api/bank/requests/${reqId}/declined`)).status, 409);
    assert.equal((await t.member.post(`/api/bank/requests/${reqId}/cancel`)).body.error, 'That request has already been handled.');
    r = await t.owner.post(`/api/bank/requests/${silkId}/declined`);
    assert.equal(r.body.message, 'Request declined.');
    r = await t.member.post(`/api/bank/requests/${woolId}/cancel`);
    assert.equal(r.body.message, 'Request cancelled.');
    assert.equal(r.body.request.status, 'cancelled');

    assert.equal((await t.owner.post('/api/bank/requests/9999/sent')).status, 404);
    assert.equal((await t.owner.post(`/api/bank/requests/${reqId}/approve`)).status, 404);
    assert.equal((await t.owner.post('/api/bank/requests/abc/sent')).status, 404);

    // The member hears back about sent and declined requests.
    const back = await eventsFor(t.member);
    assert.deepEqual(back.map((e) => [e.kind, e.title, e.body]), [
      ['bank', '🏦 Your bank request is on its way', '20 × Runecloth. Sent by Officer.'],
      ['bank', '🏦 Your bank request was declined', '1000 × Silk. Declined by Owner.'],
    ]);
    assert.deepEqual(t.audit().filter((a) => a.action.startsWith('bank')), [
      { action: 'bank request sent', detail: '20 × Runecloth' },
      { action: 'bank request declined', detail: '1000 × Silk' },
    ]);
    assert.ok(t.activity().includes('bank: 20 × Runecloth sent from the bank'));

    // Handled requests stay listed for a week; cancelled ones disappear.
    bank = (await t.member.get('/api/bank')).body;
    assert.deepEqual(bank.requests.map((x) => [x.item, x.status, x.mine]), [['Silk', 'declined', true], ['Runecloth', 'sent', true]]);
    t.srv.db.prepare("UPDATE bank_requests SET updated_at = datetime('now', '-8 days') WHERE id = ?").run(silkId);
    assert.deepEqual((await t.member.get('/api/bank')).body.requests.map((x) => x.item), ['Runecloth']);
  } finally { await t.srv.close(); }
});

test('bank characters: officers mark them, their bags and banks show up priced', async () => {
  const t = await setup();
  try {
    assert.equal((await t.member.get('/api/bank/alts')).status, 403);
    assert.equal((await t.member.put('/api/bank/alts', { names: ['Stashy'] })).status, 403);
    let r = await t.officer.get('/api/bank/alts');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.characters.map((c) => [c.name, c.owner, c.is_bank]), [['Grunta', 'Member', 0], ['Stashy', 'Member', 0], ['Thrallia', 'Owner', 0]]);
    assert.equal(r.body.characters.find((c) => c.name === 'Stashy').items, 2);

    assert.equal((await t.officer.put('/api/bank/alts', { names: 'Stashy' })).status, 400);
    r = await t.officer.put('/api/bank/alts', { names: ['Nobody'] });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'There is no character called Nobody in the guild.');

    r = await t.officer.put('/api/bank/alts', { names: ['stashy'] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.bankCharacters, ['Stashy']);
    assert.equal(r.body.message, 'Stashy is now a bank character. Its bags and bank show here after its next sync.');

    const bank = (await t.member.get('/api/bank')).body;
    assert.equal(bank.bankCharacters.length, 1);
    const st = bank.bankCharacters[0];
    assert.equal(st.name, 'Stashy');
    assert.equal(st.class, 'MAGE');
    assert.equal(st.owner, 'Member');
    // Bags and bank are added together per item.
    assert.deepEqual(st.items.map((i) => [i.name, i.count, i.unit, i.value]), [['Major Mana Potion', 10, 4000, 40000], ['Runecloth', 100, 120, 12000]]);
    assert.equal(st.value, 52000);
    assert.deepEqual(bank.value, { guildBank: 57600, bankCharacters: 52000, total: 109600 });

    r = await t.owner.put('/api/bank/alts', { names: ['Stashy', 'Grunta'] });
    assert.equal(r.body.message, 'Grunta is now a bank character. Its bags and bank show here after its next sync.');
    r = await t.owner.put('/api/bank/alts', { names: ['Grunta'] });
    assert.equal(r.body.message, 'Stashy is no longer a bank character.');
    r = await t.owner.put('/api/bank/alts', { names: ['Grunta'] });
    assert.equal(r.body.message, 'No changes.');
    r = await t.owner.put('/api/bank/alts', { names: ['Thrallia', 'Stashy'] });
    assert.deepEqual([r.body.added, r.body.removed], [['Thrallia', 'Stashy'], ['Grunta']]);
    assert.match(r.body.message, /^Bank characters saved/);
    assert.deepEqual(t.audit().filter((a) => a.action.startsWith('bank character')), [
      { action: 'bank character added', detail: 'Stashy' },
      { action: 'bank character added', detail: 'Grunta' },
      { action: 'bank character removed', detail: 'Stashy' },
      { action: 'bank character added', detail: 'Thrallia' },
      { action: 'bank character added', detail: 'Stashy' },
      { action: 'bank character removed', detail: 'Grunta' },
    ]);
    r = await t.owner.put('/api/bank/alts', { names: [] });
    assert.deepEqual(r.body.bankCharacters, []);
    assert.equal((await t.owner.put('/api/bank/alts', { names: new Array(51).fill('Stashy') })).status, 400);
  } finally { await t.srv.close(); }
});

test('prices: stats, what the guild holds, search with trend and change, bank stock value', async () => {
  const t = await setup();
  try {
    let r = await t.member.get('/api/prices');
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
    t.srv.db.prepare("UPDATE characters SET is_bank = 1 WHERE name = 'Stashy'").run();
    const top = (await t.member.get('/api/prices')).body.bank.top;
    assert.deepEqual(top.map((x) => [x.name, x.tab, x.character]), [
      ['Greater Fire Protection Potion', 'Raid', null], ['Major Mana Potion', null, 'Stashy'], ['Runecloth', null, 'Stashy'], ['Runecloth', 'Mats', null],
    ]);

    r = await t.member.get('/api/prices?q=mana');
    assert.equal(r.body.q, 'mana');
    assert.deepEqual(r.body.held, []);
    assert.deepEqual(r.body.results.map((x) => [x.item_id, x.name, x.latest.price]), [[13444, 'Major Mana Potion', 4000]]);
    r = await t.member.get('/api/prices?q=99999');
    assert.deepEqual(r.body.results.map((x) => [x.item_id, x.name, x.latest.price]), [[99999, null, 77]]);
    assert.deepEqual((await t.member.get('/api/prices?q=nothing-like-this')).body.results, []);

    // Only the newest 14 scan days are kept in the trend.
    const ins = t.srv.db.prepare('INSERT OR REPLACE INTO prices (guild_id, item_id, day, price) VALUES (?,?,?,?)');
    for (let d = 1; d <= 20; d++) ins.run(t.s.guildId, 12359, dayStr(today - d), 1000 + d);
    r = await t.member.get('/api/prices?q=thorium');
    assert.equal(r.body.results[0].history.length, 14);
    assert.equal(r.body.results[0].history[13].price, 1001);
  } finally { await t.srv.close(); }
});

test('supply drives: officers start and close, members give, goal reached once', async () => {
  const t = await setup();
  try {
    assert.equal((await t.member.post('/api/drives', { title: 'Crates', unit: 'crates', goal: 10 })).status, 403);
    for (const bad of [{ unit: 'crates', goal: 10 }, { title: 'Crates', goal: 10 }, { title: 'Crates', unit: 'crates' }, { title: 'Crates', unit: 'crates', goal: 0 }]) {
      const r = await t.officer.post('/api/drives', bad);
      assert.equal(r.status, 400);
      assert.equal(r.body.error, 'Give the drive a name, what you’re collecting, and a goal.');
    }
    let r = await t.officer.post('/api/drives', { title: 'Durotar crates', unit: 'crates', goal: '10', notes: 'Hand in at Razor Hill' });
    assert.equal(r.status, 201);
    assert.equal(r.body.message, 'Drive started.');
    const d = r.body.drive;
    assert.deepEqual({ ...d, id: 0, created_at: 0 }, {
      id: 0, title: 'Durotar crates', unit: 'crates', goal: 10, notes: 'Hand in at Razor Hill', status: 'open',
      created_by: t.s.officer.id, creator: 'Officer', created_at: 0, total: 0, pct: 0, contributors: 0, mine: 0, leaderboard: [],
    });
    assert.equal((await t.officer.post('/api/drives', { title: 'Huge', unit: 'gold', goal: 1e12 })).body.drive.goal, 1e7);
    const hugeId = d.id + 1;
    assert.deepEqual(t.discord.map((x) => x.content), [
      `📦 **Supply drive: Durotar crates**. Goal: 10 crates.\n${t.srv.cfg.baseUrl}/drives`,
      `📦 **Supply drive: Huge**. Goal: 10,000,000 gold.\n${t.srv.cfg.baseUrl}/drives`,
    ]);
    const started = (await eventsFor(t.member)).filter((e) => e.kind === 'drive');
    assert.deepEqual(started[0], { ...started[0], title: '📦 Supply drive: Durotar crates', body: 'Goal: 10 crates. Log what you hand in under Drives.', route: '/drives' });
    assert.equal((await eventsFor(t.officer)).filter((e) => e.kind === 'drive').length, 0, 'the officer who started it is not told');

    // Giving
    assert.equal((await t.member.post(`/api/drives/${d.id}/give`, { amount: 0 })).body.error, 'How many did you hand in?');
    assert.equal((await t.member.post(`/api/drives/${d.id}/give`, { amount: 'some' })).status, 400);
    assert.equal((await t.member.post('/api/drives/999/give', { amount: 1 })).status, 404);
    r = await t.member.post(`/api/drives/${d.id}/give`, { amount: 4, character: 'Grunta', note: 'first batch' });
    assert.equal(r.status, 200);
    assert.equal(r.body.message, 'Logged 4 crates.');
    assert.equal(r.body.reached, false);
    r = await t.owner.post(`/api/drives/${d.id}/give`, { amount: '2', character: 'Thrallia' });
    r = await t.member.post(`/api/drives/${d.id}/give`, { amount: 1 }); // no character: the BattleTag counts
    assert.deepEqual([r.body.drive.total, r.body.drive.pct, r.body.drive.mine, r.body.drive.contributors], [7, 70, 5, 2]);
    assert.deepEqual(r.body.drive.leaderboard, [{ who: 'Grunta', amount: 4 }, { who: 'Thrallia', amount: 2 }, { who: 'Member', amount: 1 }]);
    let list = (await t.member.get('/api/drives')).body;
    assert.deepEqual(list.myCharacters, ['Grunta', 'Stashy']);
    assert.deepEqual(list.open.map((x) => x.title), ['Huge', 'Durotar crates']);
    assert.equal(list.open[1].mine, 5);
    assert.deepEqual(list.past, []);

    // Reaching the goal finishes the drive, once.
    r = await t.member.post(`/api/drives/${d.id}/give`, { amount: 5, character: 'Grunta' });
    assert.equal(r.body.reached, true);
    assert.equal(r.body.message, 'Goal reached. Thank you!');
    assert.equal(r.body.drive.status, 'done');
    assert.equal(r.body.drive.pct, 100);
    r = await t.member.post(`/api/drives/${d.id}/give`, { amount: 5 });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'That drive has finished.');
    assert.equal(t.discord.at(-1).content, '🎉 **Durotar crates** reached its goal of 10 crates. Thanks everyone!');
    assert.equal(t.discord.length, 3);
    const reached = (await eventsFor(t.officer)).filter((e) => e.kind === 'drive');
    assert.deepEqual(reached.map((e) => [e.title, e.body]), [['🎉 Durotar crates reached its goal', '10 crates. Thanks everyone!']]);

    // Closing
    assert.equal((await t.member.post(`/api/drives/${hugeId}/close`)).status, 403);
    assert.equal((await t.officer.post('/api/drives/999/close')).status, 404);
    r = await t.officer.post(`/api/drives/${hugeId}/close`);
    assert.equal(r.body.message, 'Drive closed.');
    assert.equal(r.body.drive.status, 'closed');
    assert.equal((await t.officer.post(`/api/drives/${hugeId}/close`)).status, 200);
    list = (await t.member.get('/api/drives')).body;
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
  } finally { await t.srv.close(); }
});

test('economy works without a Discord webhook', async () => {
  const t = await setup();
  try {
    t.srv.db.prepare('UPDATE guilds SET discord_webhook = NULL').run();
    assert.equal((await t.member.post('/api/bank/requests', { item: 'Runecloth' })).status, 201);
    assert.equal((await t.officer.post('/api/drives', { title: 'Gold', unit: 'gold', goal: 5 })).status, 201);
    assert.equal(t.discord.length, 0);
  } finally { await t.srv.close(); }
});

test('the Discord drive link opens a small public page that points at the app', async () => {
  const t = await setup();
  try {
    const page = await client(t.srv.url).get('/drives');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.match(page.body, /guildcamp:\/\/drives/);
    assert.match(page.body, /href="\/get"/);
  } finally { await t.srv.close(); }
});
