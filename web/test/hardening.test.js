// Hardening: backups, rate limits, member management, audit log, versions, onboarding, extras, addon options.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const dbm = require('../src/db');
const backup = require('../src/backup');
const { rateLimit } = require('../src/ratelimit');
const { createApp, config } = require('../src/server');
const { applyPayload, toLua } = require('../src/sync');
const { WowClient } = require('./wowsim');
const { parseSavedVariables } = require('../../companion/lua');
const { versionLess } = require('../../companion/companion');

test('backups are consistent snapshots and old ones rotate out', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wowbk-'));
  const db = dbm.open(path.join(dir, 'wow.db'));
  db.prepare("INSERT INTO guilds (name, invite_code) VALUES ('wow','x')").run();
  const bdir = backup.backupDir(path.join(dir, 'wow.db'));
  for (let d = 1; d <= 4; d++) backup.runBackup(db, bdir, { keep: 2, now: new Date(Date.UTC(2026, 10, d, 3)) });
  const list = backup.listBackups(bdir);
  assert.deepStrictEqual(list.map((b) => b.file), ['wow-20261104-030000.db', 'wow-20261103-030000.db']);
  const copy = dbm.open(path.join(bdir, list[0].file));
  assert.strictEqual(copy.prepare('SELECT name FROM guilds').get().name, 'wow');
  assert.strictEqual(backup.backupIfDue(db, bdir, 24 * 365 * 10), null, 'fresh backup means nothing is due');
});

test('rate limiter answers 429 once the limit is passed', () => {
  const mw = rateLimit({ max: 2, windowMs: 60000 });
  const codes = [];
  for (let i = 0; i < 3; i++) {
    const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { codes.push(c); return this; }, type() { return this; }, send() { return this; } };
    mw({ ip: '1.2.3.4' }, res, () => codes.push(200));
  }
  assert.deepStrictEqual(codes, [200, 200, 429]);
});

test('versions compare numerically', () => {
  assert.ok(versionLess('0.4.0', '0.10.0'));
  assert.ok(!versionLess('1.0.0', '0.9.9'));
  assert.ok(!versionLess('0.5.0', '0.5.0'));
});

async function site() {
  const db = dbm.open(':memory:');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wowdl-'));
  const cfg = { ...config({}), devLogin: true, timers: false, dbFile: path.join(dir, 'wow.db') };
  const app = createApp(cfg, db);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const url = `http://127.0.0.1:${srv.address().port}`;
  const login = async (bt) => {
    const res = await fetch(`${url}/login/dev`, { method: 'POST', body: new URLSearchParams({ battletag: bt }), redirect: 'manual' });
    const cookie = res.headers.get('set-cookie').split(';')[0];
    const html = await (await fetch(`${url}/`, { headers: { cookie } })).text();
    return { cookie, csrf: (/name="_csrf" value="([^"]+)"/.exec(html) || [])[1] };
  };
  const post = (s, p, body = {}) => fetch(url + p, { method: 'POST', headers: { cookie: s.cookie }, body: new URLSearchParams({ _csrf: s.csrf, ...body }), redirect: 'manual' });
  const get = async (s, p) => { const r = await fetch(url + p, { headers: { cookie: s.cookie } }); return { status: r.status, text: await r.text(), headers: r.headers }; };
  return { db, srv, url, login, post, get, cfg };
}

test('member management, removed members lose sync access, audit log and sync health', async () => {
  const { db, srv, url, login, post, get } = await site();
  try {
    const owner = await login('Owner#1');
    await post(owner, '/guild/create', { name: 'wow', faction: 'Horde' });
    const invite = db.prepare('SELECT invite_code FROM guilds').get().invite_code;
    const off = await login('Officer#2'); await post(off, `/join/${invite}`);
    const mem = await login('Member#3'); await post(mem, `/join/${invite}`);
    const id = (bt) => db.prepare('SELECT id FROM users WHERE battletag = ?').get(bt).id;
    const role = (bt) => db.prepare('SELECT role FROM memberships WHERE user_id = ?').get(id(bt))?.role;
    await post(owner, `/members/${id('Officer#2')}/promote`);
    assert.strictEqual(role('Officer#2'), 'officer');
    // An officer can't remove another officer or demote; a member can't open officer tools.
    assert.strictEqual((await post(off, `/members/${id('Owner#1')}/remove`)).status, 302);
    assert.strictEqual(role('Owner#1'), 'owner');
    assert.strictEqual((await post(off, `/members/${id('Officer#2')}/demote`)).status, 403);
    assert.strictEqual((await get(mem, '/admin')).status, 403);

    // The member syncs with versions, then gets removed: their key stops working.
    await post(mem, '/settings/token');
    const key = /<code class="token">(wowg_[^<]+)<\/code>/.exec((await (await post(mem, '/settings/token')).text()))[1];
    const sync = (k) => fetch(`${url}/api/sync`, { method: 'POST', headers: { Authorization: `Bearer ${k}`, 'Content-Type': 'application/json', 'X-Companion-Version': '0.4.0' },
      body: JSON.stringify({ addonVersion: '0.5.0', characters: { Bravo: { name: 'Bravo', level: 20, pvp: { rankName: 'Scout', rank: 1, hk: 42 }, currencies: [{ name: "Merchant's Favor", qty: 12 }], reputations: [{ name: 'Durotar Supply and Logistics', standing: 5, value: 1500, max: 6000 }] } } }) });
    const ok = await sync(key);
    assert.strictEqual(ok.status, 200);
    assert.ok((await ok.json()).latest, 'sync tells the companion the latest versions');
    const u = db.prepare('SELECT addon_version, companion_version, last_sync_at FROM users WHERE id = ?').get(id('Member#3'));
    assert.deepStrictEqual([u.addon_version, u.companion_version, Boolean(u.last_sync_at)], ['0.5.0', '0.4.0', true]);
    const charPage = await get(owner, '/characters/Bravo');
    assert.match(charPage.text, /Rank: <strong>Scout<\/strong>/);
    assert.match(charPage.text, /Merchant&#39;s Favor: <strong>12<\/strong>/);
    assert.match(charPage.text, /Durotar Supply and Logistics/);

    const admin = await get(owner, '/admin');
    assert.match(admin.text, /Member#3[\s\S]*0\.5\.0[\s\S]*0\.4\.0/);
    await post(owner, `/members/${id('Member#3')}/remove`);
    assert.strictEqual(role('Member#3'), undefined);
    assert.strictEqual((await sync(key)).status, 401);
    assert.strictEqual(db.prepare('SELECT user_id FROM characters WHERE name = ?').get('Bravo').user_id, null);

    // Owner demotes the officer; invite link replaced; all audited.
    await post(owner, `/members/${id('Officer#2')}/demote`);
    assert.strictEqual(role('Officer#2'), 'member');
    await post(owner, '/settings/invite/reset');
    assert.notStrictEqual(db.prepare('SELECT invite_code FROM guilds').get().invite_code, invite);
    const actions = db.prepare('SELECT action FROM audit_log ORDER BY id').all().map((r) => r.action);
    for (const a of ['promoted to officer', 'sync key created', 'removed from guild', 'demoted to member', 'invite link replaced']) assert.ok(actions.includes(a), a);
    // Backups from the officer page; only the owner may download.
    await post(owner, '/admin/backups');
    const file = /href="\/admin\/backups\/([^"]+)"/.exec((await get(owner, '/admin')).text)[1];
    assert.strictEqual((await get(owner, `/admin/backups/${file}`)).status, 200);
    assert.strictEqual((await get(off, `/admin/backups/${file}`)).status, 403);
    assert.strictEqual((await get(owner, '/admin/backups/..%2Fwow.db')).status, 404);
  } finally { srv.close(); }
});

test('security headers and onboarding checklist', async () => {
  const { db, srv, login, post, get } = await site();
  try {
    const s = await login('New#1');
    await post(s, '/guild/create', { name: 'wow', faction: 'Horde' });
    const camp = await get(s, '/');
    assert.match(camp.headers.get('content-security-policy'), /default-src 'self'/);
    assert.strictEqual(camp.headers.get('x-frame-options'), 'DENY');
    assert.match(camp.text, /Get set up <span class="muted small">0 of 3 done/);
    const uid = db.prepare('SELECT id FROM users').get().id;
    db.prepare("INSERT INTO sync_log (guild_id, user_id) VALUES (1, ?)").run(uid);
    db.prepare("INSERT INTO characters (guild_id, user_id, name, is_main) VALUES (1, ?, 'Thrallia', 1)").run(uid);
    db.prepare("INSERT INTO professions (character_id, name, skill, max_skill) VALUES (1, 'Mining', 1, 75)").run();
    assert.doesNotMatch((await get(s, '/')).text, /Get set up/, 'checklist disappears once everything is done');
  } finally { srv.close(); }
});

test('addon: PvP/rep/currency data, version reporting, update notice and options', () => {
  const MOCK = `
function UnitPVPRank() return 6 end
function GetPVPRankInfo(r) return "Scout", r - 4 end
function GetPVPLifetimeStats() return 120, 3, 7 end
function GetPVPThisWeekStats() return 15, 900 end
C_Reputation = { GetNumFactions = function() return 2 end, GetFactionDataByIndex = function(i)
  if i == 1 then return { name = "Horde", isHeader = true } end
  return { name = "Durotar Supply and Logistics", reaction = 5, currentStanding = 4500, currentReactionThreshold = 3000, nextReactionThreshold = 9000 } end }
C_CurrencyInfo = { GetCurrencyListSize = function() return 1 end, GetCurrencyListInfo = function() return { name = "Merchant's Favor", quantity = 12, currencyID = 3001 } end,
  GetCurrencyInfo = function() return { quantity = 5400 } end }
function GetAddOnMetadata(a, k) if k == "Version" then return "0.5.0" end end`;
  const inboxFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-')), 'Inbox.lua');
  fs.writeFileSync(inboxFile, `WowGuildInbox = ${toLua({ guild: 'wow', latestAddon: '0.6.0', site: 'https://wow.example', announcements: [{ body: 'Hello' }] })}\n`);
  const wow = new WowClient({ inboxFile });
  wow.exec(MOCK);
  wow.fire('ADDON_LOADED', 'WowGuild');
  wow.fire('PLAYER_LOGIN');
  assert.match(wow.printed(), /A newer version of this addon \(0\.6\.0\) is out\.\|r Get it at https:\/\/wow\.example\/get/);
  assert.match(wow.printed(), /latest notice: Hello/);
  wow.fire('PLAYER_LOGOUT');
  const sv = parseSavedVariables(wow.saveVariables()).WowGuildDB;
  assert.strictEqual(sv.addonVersion, '0.5.0');
  const me = sv.characters.Thrallia;
  assert.deepStrictEqual([me.pvp.rankName, me.pvp.rank, me.pvp.hk, me.pvp.weekHk, me.pvp.honor, me.pvp.highestRank], ['Scout', 2, 120, 15, 5400, 3]);
  assert.deepStrictEqual(me.reputations, [{ name: 'Durotar Supply and Logistics', header: 'Horde', standing: 5, value: 1500, max: 6000 }]);
  assert.strictEqual(me.currencies[0].name, "Merchant's Favor");
  // Turning login news off silences it next login.
  wow.exec('WowGuildDB.options.loginNews = false; WowGuildDB.options.updateNotice = false; __printed = {}');
  wow.fire('PLAYER_LOGIN');
  assert.doesNotMatch(wow.printed(), /latest notice|newer version/);
  wow.slash('options');
  assert.strictEqual(wow.eval('__ns.debugError'), null);
});
