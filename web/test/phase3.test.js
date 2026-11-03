// Phase 3: economy (inventory, guild bank, prices), Discord bot, supply drives, event kinds.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const dbm = require('../src/db');
const E = require('../src/economy');
const D = require('../src/discord');
const { applyPayload } = require('../src/sync');
const { createApp, config } = require('../src/server');
const { WowClient } = require('./wowsim');
const { parseSavedVariables } = require('../../companion/lua');
const { extractPrices } = require('../../companion/companion');

const GUILD_BANK_MOCK = `
local gb = {
  [1] = { name = "Mats", slots = { [1] = {"|Hitem:14047|h[Runecloth]|h", 20}, [2] = {"|Hitem:14047|h[Runecloth]|h", 10}, [5] = {"|Hitem:13444|h[Major Mana Potion]|h", 4} } },
  [2] = { name = "Raid", slots = { [1] = {"|Hitem:13457|h[Greater Fire Protection Potion]|h", 6} } },
}
function GetNumGuildBankTabs() return 2 end
function GetGuildBankTabInfo(t) return gb[t].name, "icon", true end
function GetGuildBankItemLink(t, s) local x = gb[t].slots[s]; return x and x[1] end
function GetGuildBankItemInfo(t, s) local x = gb[t].slots[s]; return "tex", x and x[2] or 0 end
function QueryGuildBankTab() end
function QueryGuildBankLog() end
function GetGuildBankMoney() return 1234567 end
function GetNumGuildBankTransactions(t) return t == 1 and 1 or 0 end
function GetGuildBankTransaction(t, i) return "deposit", "Grommash", "|Hitem:14047|h[Runecloth]|h", 10, 1, nil, 0, 0, 0, 3 end
function GetNumGuildBankMoneyTransactions() return 1 end
function GetGuildBankMoneyTransaction(i) return "withdraw", "Thrallia", 50000, 0, 0, 1, 0 end
`;

function freshDb() {
  const db = dbm.open(':memory:');
  const u = db.prepare("INSERT INTO users (bnet_id, battletag) VALUES ('dev:J#1','J#1')").run().lastInsertRowid;
  const g = db.prepare("INSERT INTO guilds (name, invite_code) VALUES ('wow','inv')").run().lastInsertRowid;
  db.prepare("INSERT INTO memberships (user_id, guild_id, role) VALUES (?,?,'owner')").run(u, g);
  return { db, u, g };
}

test('money formats copper the way players read it', () => {
  assert.strictEqual(E.money(1234567), '123g 45s 67c');
  assert.strictEqual(E.money(5000), '50s');
  assert.strictEqual(E.money(7), '7c');
  assert.strictEqual(E.money(10000), '1g 0s');
});

test('companion extracts recent Auctionator prices and ignores stale ones', () => {
  const now = Date.UTC(2026, 10, 3);
  const today = Math.floor((now - Date.UTC(2020, 0, 1)) / 86400000);
  const db = {
    __dbversion: 6,
    'Forever Horde': {
      14047: { m: 120, h: { [today - 1]: 120, [today - 5]: 150 } },
      'g:19019:0': { m: 500000, h: { [today - 2]: 500000 } },
      13444: { m: 900, h: { [today - 40]: 900 } },
      'p:1234': { m: 1, h: { [today]: 1 } },
    },
    'Other Realm': { 14047: { m: 100, h: { [today - 1]: 100 } } },
  };
  const out = extractPrices(db, now).items.sort((a, b) => a[0] - b[0]);
  assert.deepStrictEqual(out, [[14047, 100, today - 1], [19019, 500000, today - 2]]);
});

test('addon reads bags, bank and guild bank; site stores them with prices and log', () => {
  const wow = new WowClient();
  wow.exec(GUILD_BANK_MOCK);
  wow.fire('ADDON_LOADED', 'WowGuild');
  wow.fire('PLAYER_LOGIN');
  wow.fire('BANKFRAME_OPENED');
  wow.fire('GUILDBANKFRAME_OPENED');
  wow.fire('GUILDBANKFRAME_CLOSED');
  wow.fire('PLAYER_LOGOUT');
  const sv = parseSavedVariables(wow.saveVariables()).WowGuildDB;
  const me = sv.characters.Thrallia;
  assert.deepStrictEqual(me.inventory.bank, [{ id: 14047, name: 'Runecloth', count: 35 }]);
  assert.ok(me.inventory.bags.find((i) => i.name === 'Minor Healing Potion' && i.count === 5));
  assert.strictEqual(sv.guildBank.money, 1234567);
  assert.deepStrictEqual(sv.guildBank.tabs.map((t) => [t.name, t.items.map((i) => [i.name, i.count])]),
    [['Mats', [['Runecloth', 30], ['Major Mana Potion', 4]]], ['Raid', [['Greater Fire Protection Potion', 6]]]]);
  assert.strictEqual(sv.guildBank.log.length, 2);

  const { db, u, g } = freshDb();
  const today = Math.floor((Date.now() - Date.UTC(2020, 0, 1)) / 86400000);
  sv.prices = { items: [[14047, 120, today], [13444, 900, today - 1]] };
  const stats = applyPayload(db, g, u, sv);
  assert.strictEqual(stats.bank, 3);
  assert.strictEqual(stats.prices, 2);
  assert.strictEqual(db.prepare("SELECT name FROM item_names WHERE item_id = 14047").get().name, 'Runecloth');
  assert.strictEqual(db.prepare('SELECT count FROM inventory WHERE location = ? AND item_id = 14047').get('bank').count, 35);
  assert.strictEqual(E.latestPrices(db, g, [14047])[14047].price, 120);
  assert.strictEqual(E.searchPrices(db, g, 'rune')[0].name, 'Runecloth');
  // Uploading the same log again doesn't duplicate it, and an older bank scan doesn't overwrite a newer one.
  applyPayload(db, g, u, sv);
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM bank_log').get().n, 2);
  const older = JSON.parse(JSON.stringify(sv)); older.guildBank.scannedAt -= 3600; older.guildBank.tabs = [];
  applyPayload(db, g, u, older);
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM guild_bank').get().n, 3);
});

test('Discord: signature check, linking, commands', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const pubHex = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex');
  const body = Buffer.from('{"type":1}');
  const sig = crypto.sign(null, Buffer.concat([Buffer.from('123'), body]), privateKey).toString('hex');
  assert.ok(D.verify(pubHex, sig, '123', body));
  assert.ok(!D.verify(pubHex, sig, '124', body));
  assert.ok(!D.verify(pubHex, 'zz', '123', body));

  const { db, u, g } = freshDb();
  const cfg = { baseUrl: 'https://wow.test' };
  const cmd = (name, options = [], userId = '555', type = 2) => D.handle(db, cfg, { type, guild_id: 'srv1', member: { user: { id: userId } }, data: { name, options } });
  assert.deepStrictEqual(D.handle(db, cfg, { type: 1 }), { type: 1 });
  assert.match(cmd('online').data.content, /isn’t connected/);
  const code = D.newLinkCode(db, u, g);
  assert.match(cmd('link', [{ name: 'code', value: 'WRONG' }]).data.content, /didn’t work/);
  assert.match(cmd('link', [{ name: 'code', value: code.toLowerCase() }]).data.content, /Linked to J/);
  assert.strictEqual(db.prepare('SELECT discord_server_id FROM guilds').get().discord_server_id, 'srv1');

  db.prepare("INSERT INTO characters (guild_id, user_id, name, level, online, zone) VALUES (?,?, 'Thrallia', 30, 1, 'The Barrens')").run(g, u);
  assert.match(cmd('online', [], 'someone-else').data.content, /1 around the fire[\s\S]*Thrallia \(30\), The Barrens/);
  const raidId = db.prepare("INSERT INTO raids (guild_id, title, instance, starts_at) VALUES (?, 'Hyjal', 'Hyjal Summit', ?)").run(g, new Date(Date.now() + 86400000).toISOString()).lastInsertRowid;
  assert.strictEqual(cmd('signup', [{ name: 'raid', value: 'hy', focused: true }], '555', 4).data.choices[0].value, String(raidId));
  const s = cmd('signup', [{ name: 'raid', value: String(raidId) }, { name: 'role', value: 'healer' }]);
  assert.match(s.data.content, /Thrallia is coming for \*\*Hyjal\*\* as healer/);
  assert.strictEqual(s.data.flags, 64);
  assert.strictEqual(db.prepare('SELECT role FROM signups').get().role, 'healer');
  assert.match(cmd('signup', [{ name: 'raid', value: String(raidId) }, { name: 'role', value: 'dps' }], 'unlinked').data.content, /Link your Discord first/);
  const cta = cmd('cta', [{ name: 'zone', value: 'Tarren Mill' }, { name: 'needed', value: 5 }]);
  assert.match(cta.data.content, /Call to arms: Tarren Mill\*\* \(need 5\)/);
  assert.strictEqual(db.prepare("SELECT source FROM ctas").get().source, 'discord');
  assert.match(cmd('raids').data.content, /\*\*Hyjal\*\* <t:\d+:F>/);
  assert.match(cmd('craft', [{ name: 'item', value: 'x' }]).data.content, /Nobody has a recipe/);
});

test('Phase 3 pages over HTTP, including the Discord endpoint', async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const db = dbm.open(':memory:');
  const cfg = { ...config({}), devLogin: true, timers: false, discordAppId: '1', discordPublicKey: publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex') };
  const app = createApp(cfg, db);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const url = `http://127.0.0.1:${srv.address().port}`;
  try {
    // Discord endpoint: valid signature answers, bad signature is refused, no CSRF interference.
    const ping = Buffer.from('{"type":1}');
    const ts = String(Math.floor(Date.now() / 1000));
    const good = await fetch(`${url}/discord/interactions`, { method: 'POST', body: ping, headers: { 'Content-Type': 'application/json',
      'X-Signature-Ed25519': crypto.sign(null, Buffer.concat([Buffer.from(ts), ping]), privateKey).toString('hex'), 'X-Signature-Timestamp': ts } });
    assert.strictEqual(good.status, 200);
    assert.deepStrictEqual(await good.json(), { type: 1 });
    const bad = await fetch(`${url}/discord/interactions`, { method: 'POST', body: ping, headers: { 'Content-Type': 'application/json', 'X-Signature-Ed25519': '00', 'X-Signature-Timestamp': ts } });
    assert.strictEqual(bad.status, 401);

    const res = await fetch(`${url}/login/dev`, { method: 'POST', body: new URLSearchParams({ battletag: 'Owner#1' }), redirect: 'manual' });
    const cookie = res.headers.get('set-cookie').split(';')[0];
    const csrf = /name="_csrf" value="([^"]+)"/.exec(await (await fetch(`${url}/`, { headers: { cookie } })).text())[1];
    const post = (path, body) => fetch(url + path, { method: 'POST', headers: { cookie }, body: new URLSearchParams({ _csrf: csrf, ...body }), redirect: 'manual' });
    const get = async (path) => { const r = await fetch(url + path, { headers: { cookie } }); return { status: r.status, text: await r.text() }; };
    await post('/guild/create', { name: 'wow', faction: 'Horde' });

    // Supply drive reaches its goal
    await post('/drives', { title: 'Durotar crates', unit: 'crates', goal: '10' });
    await post('/drives/1/give', { amount: '6', character: 'Thrallia' });
    let d = await get('/drives');
    assert.match(d.text, /6 of 10 crates/);
    await post('/drives/1/give', { amount: '5', character: 'Thrallia' });
    assert.strictEqual(db.prepare('SELECT status FROM drives').get().status, 'done');

    // Bank request flow
    await post('/bank/requests', { item: 'Runecloth', count: '20', note: 'bandages' });
    assert.match((await get('/bank')).text, /20 × Runecloth/);
    await post('/bank/requests/1/sent', {});
    assert.strictEqual(db.prepare('SELECT status FROM bank_requests').get().status, 'sent');

    // PvP event has no reserves section
    const r = await post('/raids', { kind: 'pvp', title: 'Darkspear premade', instance: 'Darkspear Islands', starts: '2026-12-01T20:00', tz_offset: '-120' });
    const page = await get(r.headers.get('location'));
    assert.match(page.text, /PvP · Reserves open/);
    assert.doesNotMatch(page.text, /Soft reserves/);
    assert.strictEqual(db.prepare('SELECT sr_limit FROM raids').get().sr_limit, 0);

    // Discord link code shows up on Settings
    const link = await post('/settings/discord/link', {});
    assert.match(decodeURIComponent(link.headers.get('location')), /\/link [0-9A-F]{8}/);
    for (const p of ['/bank', '/bank?find=rune', '/prices', '/prices?q=rune', '/drives', '/settings']) assert.strictEqual((await get(p)).status, 200, p);
  } finally { srv.close(); }
});
