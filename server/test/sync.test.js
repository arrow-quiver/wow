// Sync: POST /api/sync (the app uploads the addon's saved data), GET /api/inbox and the legacy
// GET /api/inbox.lua (the guild news the addon shows in game). Payloads come from the real addon
// running in the simulated client (wowsim) wherever the addon can produce them.
//
// Ported from the old web/test: e2e (upload, dedupe, bad keys), hardening (versions, PvP extras,
// removed members), phase3 (bank, inventory, prices), professions (shopping list, reagent prices,
// stock), polish (holdings, crafters), raids (readiness, inbox raids and reserves), reset (fresh
// start), gamedata (realm capture), coach / coach-addon (play style and questions upload).
//
// Only the core, releases and sync route files are loaded, so this file doesn't depend on the other
// domains. The Coach service is a stand-in that counts kick() calls.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startServer, seed, client, addUser, addLegacyKey } = require('./helpers');
const { WowClient, toLua } = require('./wowsim');
const { parseSavedVariables } = require('../../app/src/shared/lua');
const release = require('../../app/src/shared/release');
const E = require('../src/services/economy');
const R = require('../src/services/raids');
const C = require('../src/services/coach');
const { resetGuild } = require('../src/services/reset');
const { freshOnly } = require('../src/services/sync');

const ROUTES = ['auth', 'guild', 'events', 'releases', 'sync'];
const WEBHOOK = 'https://discord.com/api/webhooks/123/abc';
const REPO_ADDON = path.join(__dirname, '..', '..', 'addon', 'WowGuild');
const TOC_VERSION = /^## Version:\s*(\S+)/m.exec(fs.readFileSync(path.join(REPO_ADDON, 'WowGuild.toc'), 'utf8'))[1];
const NOW = () => Math.floor(Date.now() / 1000);
const TODAY = () => Math.floor((Date.now() - Date.UTC(2020, 0, 1)) / 86400000); // Auctionator's day number

// Discord stand-in for cfg.fetch: records every webhook post.
function fakeDiscord() {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, body: init.body ? JSON.parse(init.body) : null });
    return { ok: true, status: 204, json: async () => ({}), text: async () => '' };
  };
  return { calls, fetch };
}

function tmpDir(t, prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

async function setup(t, overrides = {}) {
  const discord = fakeDiscord();
  const srv = await startServer({ routes: ROUTES, fetch: discord.fetch, ...overrides });
  t.after(() => srv.close());
  const s = seed(srv.db);
  const kicks = [];
  srv.ctx.services.coach = { kick: () => kicks.push(Date.now()), run: async () => ({}) };
  const count = (sql, ...args) => srv.db.prepare(`SELECT COUNT(*) AS n FROM ${sql}`).get(...args).n;
  return {
    srv, s, discord, kicks, count, db: srv.db,
    owner: client(srv.url, s.owner.token),
    officer: client(srv.url, s.officer.token),
    member: client(srv.url, s.member.token),
    anon: client(srv.url),
  };
}

// The app's upload: WowGuildDB as JSON with the app's version header.
const upload = (c, payload, headers = {}) => c.raw('POST', '/api/sync', {
  headers: { 'Content-Type': 'application/json', 'X-App-Version': '0.11.2', ...headers },
  body: typeof payload === 'string' ? payload : JSON.stringify(payload),
});

// One play session in the simulated game, returned as the WowGuildDB the app would upload.
function playSession({ mocks, cta = true, during } = {}) {
  const wow = new WowClient(mocks ? { mocks } : {});
  wow.login();
  wow.fire('GUILD_ROSTER_UPDATE');
  wow.fire('TRADE_SKILL_SHOW');
  if (cta) wow.slash('cta Crossroads 8 Alliance at the flight master');
  if (during) during(wow);
  wow.logout();
  return { wow, sv: parseSavedVariables(wow.saveVariablesBuffer()).WowGuildDB };
}

function inboxFile(t, inbox) {
  const f = path.join(tmpDir(t, 'gc-inbox-'), 'Inbox.lua');
  fs.writeFileSync(f, `WowGuildInbox = ${toLua(inbox)}\n`);
  return f;
}

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

const COACH_GAME = `
__t = 1000
function GetTime() return __t end
function GetRealmName() return "Forever" end
function UnitIsPVP() return __flagged == true end
function IsInGroup() return __grouped == true end
function GetPVPLifetimeStats() return __hk or 0, 0, 0 end
function GetNumTalentTabs() return 3 end
local tabs = { {"Elemental", 0}, {"Enhancement", 11}, {"Restoration", 0} }
function GetTalentTabInfo(i) return tabs[i][1], "icon", tabs[i][2], "bg" end
function GetNumTalents(tab) return tab == 2 and 2 or 0 end
function GetTalentInfo(tab, i) if i == 1 then return "Ancestral Knowledge", "icon", 1, 1, 5, 5 else return "Shield Specialization", "icon", 1, 2, 0, 5 end end
function UnitCharacterPoints() return 1 end
function GetInventoryItemLink(_, slot) if slot == 16 then return "|cff1eff00|Hitem:15223::|h[Big Stick]|h|r" end end
function GetItemInfo() return "Big Stick", nil, 2, 25 end
`;

// What the old coach tests uploaded: one character's play style and one question asked in game.
const coachPayload = (extra = {}) => ({
  coach: {
    chars: { Grom: { name: 'Grom', class: 'WARRIOR', level: 24, realm: 'Forever',
      profile: { scores: { aggression: 82, risk: 40, social: 30, pvp: 75, pace: 60 }, archetype: 'Warmonger', blurb: 'You go looking for fights.', minutes: 300, quiz: true },
      stats: { pullsPerHour: 41, deathsPerHour: 0.8 }, quiz: { aggression: 5, pvp: 4 },
      talents: { trees: [{ name: 'Arms', points: 15 }, { name: 'Fury', points: 0 }, { name: 'Protection', points: 0 }], unspent: 1, picked: [{ name: 'Improved Rend', rank: 3, max: 3 }] },
      gear: { items: [{ slot: 'MainHand', name: 'Bonebiter', ilvl: 30 }] } } },
    questions: [{ id: 'q1', char: 'Grom', text: 'Deflection or Improved Charge?', at: 1 }],
    ...extra,
  },
});

// ---------------------------------------------------------------- upload

test('upload from the game: characters, roster, recipes and a call to arms; versions and the sync log are recorded', async (t) => {
  const { srv, s, db, owner, officer, discord, count } = await setup(t);
  assert.strictEqual((await owner.put('/api/guild/settings', { discord_webhook: WEBHOOK })).status, 200);
  const { sv } = playSession();
  const json = JSON.stringify(sv);

  const r = await upload(owner, json);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const { latest, ...counts } = r.body;
  assert.deepStrictEqual(counts, { ok: true, characters: 1, roster: 3, recipes: 2, ctas: 1, inventory: 3, bank: 0, prices: 0, coachPending: 0 });
  assert.deepStrictEqual(Object.keys(latest).sort(), ['addon', 'app']);
  assert.strictEqual(latest.app, null);
  assert.strictEqual(latest.addon.version, TOC_VERSION, 'the bundled addon is offered until one is published');

  // Own character is linked to the uploader; roster entries are not claimed.
  const chars = db.prepare('SELECT name, user_id, online, level, class, rank, zone, money FROM characters WHERE guild_id = ? ORDER BY name').all(s.guildId);
  assert.deepStrictEqual(chars.map((c) => c.name), ['Grommash Hellscream', 'Thrallia', 'Zuljinne']);
  const me = chars.find((c) => c.name === 'Thrallia');
  assert.deepStrictEqual([me.user_id, me.level, me.class, me.zone, me.money, me.rank], [s.owner.id, 23, 'SHAMAN', 'The Barrens', 123456, 'Guild Master']);
  assert.strictEqual(chars.find((c) => c.name === 'Grommash Hellscream').user_id, null, 'roster entries are not claimed');
  assert.strictEqual(chars.filter((c) => c.online).length, 2);
  const profs = db.prepare('SELECT p.name, p.skill, p.max_skill FROM professions p JOIN characters c ON c.id = p.character_id WHERE c.name = ? ORDER BY p.name').all('Thrallia');
  assert.deepStrictEqual(profs.map((p) => [p.name, p.skill, p.max_skill]), [['Blacksmithing', 120, 150], ['Cooking', 80, 150], ['Fishing', 40, 75]]);
  assert.deepStrictEqual(db.prepare('SELECT profession, recipe_id, name FROM recipes ORDER BY recipe_id').all().map((x) => ({ ...x })),
    [{ profession: 'Blacksmithing', recipe_id: 101, name: 'Rough Sharpening Stone' }, { profession: 'Blacksmithing', recipe_id: 102, name: 'Copper Chain Vest' }]);
  assert.strictEqual(count('activity WHERE text = ?', 'Thrallia linked their character'), 1);
  assert.ok(db.prepare('SELECT roster_scanned_at FROM guilds').get().roster_scanned_at);

  // The call to arms: stored once, posted to Discord in the old format, and a notification for everyone else.
  const cta = db.prepare('SELECT * FROM ctas').get();
  assert.deepStrictEqual([cta.user_id, cta.character, cta.zone, cta.message, cta.needed, cta.source],
    [s.owner.id, 'Thrallia', 'Crossroads', 'Alliance at the flight master', 8, 'addon']);
  assert.strictEqual(discord.calls.length, 1);
  assert.strictEqual(discord.calls[0].url, WEBHOOK);
  assert.strictEqual(discord.calls[0].body.content, '⚔️ **Call to arms: Crossroads** (need 8)\nAlliance at the flight master\n— Thrallia (from in game)');
  assert.deepStrictEqual(discord.calls[0].body.allowed_mentions, { parse: [] });
  const seen = (await officer.get('/api/events?after=0')).body.events;
  assert.deepStrictEqual(seen.map((e) => [e.kind, e.title, e.body, e.route]),
    [['cta', '⚔️ Call to arms: Crossroads', 'Need 8. Alliance at the flight master (Thrallia)', '/']]);
  assert.deepStrictEqual((await owner.get('/api/events?after=0')).body.events, [], 'not sent to the player who called it');

  // Versions, last sync and the sync log.
  const u = db.prepare('SELECT addon_version, app_version, companion_version, last_sync_at FROM users WHERE id = ?').get(s.owner.id);
  assert.deepStrictEqual([u.addon_version, u.app_version, u.companion_version], [TOC_VERSION, '0.11.2', null]);
  assert.match(u.last_sync_at, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
  const dev = db.prepare('SELECT addon_version, app_version FROM devices WHERE id = ?').get(s.owner.deviceId);
  assert.deepStrictEqual([dev.addon_version, dev.app_version], [TOC_VERSION, '0.11.2']);
  const log = db.prepare('SELECT guild_id, user_id, bytes FROM sync_log').all();
  assert.deepStrictEqual(log.map((x) => ({ ...x })), [{ guild_id: s.guildId, user_id: s.owner.id, bytes: Buffer.byteLength(json) }]);
  const row = (await owner.get('/api/members')).body.members.find((m) => m.id === s.owner.id);
  assert.deepStrictEqual([row.addon_version, row.app_version, row.characters], [TOC_VERSION, '0.11.2', 1]);
  assert.strictEqual(row.last_sync_at, u.last_sync_at);

  // Re-uploading the same file changes nothing that should happen once.
  const again = await upload(owner, json);
  assert.strictEqual(again.status, 200);
  assert.strictEqual(again.body.ctas, 0);
  assert.strictEqual(count('ctas'), 1, 'no duplicate call to arms');
  assert.strictEqual(discord.calls.length, 1, 'no second Discord post');
  assert.strictEqual((await officer.get('/api/events?after=0')).body.events.length, 1, 'no second notification');
  assert.strictEqual(count('activity WHERE text = ?', 'Thrallia linked their character'), 1);
  assert.strictEqual(count('characters'), 3);
  assert.strictEqual(count('recipes'), 2);
  assert.strictEqual(count('sync_log'), 2);
  // Without a webhook nothing is posted, but the call still notifies the guild.
  await owner.put('/api/guild/settings', { discord_webhook: '' });
  const later = playSession({ cta: false, during: (w) => w.slash('cta Tarren Mill 5') }).sv;
  later.ctaQueue[0].at = sv.ctaQueue[0].at + 7; // calls are told apart by time and character
  assert.strictEqual((await upload(owner, later)).body.ctas, 1);
  assert.strictEqual(discord.calls.length, 1);
  const tm = (await officer.get('/api/events?after=0')).body.events.at(-1);
  assert.deepStrictEqual([tm.title, tm.body], ['⚔️ Call to arms: Tarren Mill', 'Need 5. (Thrallia)']);
  // With a webhook again, a call without a message skips the empty line.
  await owner.put('/api/guild/settings', { discord_webhook: WEBHOOK });
  later.ctaQueue[0].at += 1;
  await upload(owner, later);
  assert.strictEqual(discord.calls.at(-1).body.content, '⚔️ **Call to arms: Tarren Mill** (need 5)\n— Thrallia (from in game)');
  await srv.close();
});

test('sign-in, guild membership and the upload itself are checked', async (t) => {
  const { srv, db, anon, owner, count } = await setup(t);
  let r = await upload(anon, {});
  assert.deepStrictEqual([r.status, r.body], [401, { error: 'Sign in first.' }]);
  r = await upload(client(srv.url, 'gcd_not-a-real-token'), {});
  assert.strictEqual(r.status, 401);
  assert.match(r.body.error, /This device was signed out/);
  r = await upload(client(srv.url, 'wowg_nope'), {});
  assert.strictEqual(r.status, 401);
  assert.match(r.body.error, /That sync key no longer works/);
  for (const p of ['/api/inbox', '/api/inbox.lua']) assert.strictEqual((await anon.get(p)).status, 401, p);

  // Signed in but not in the guild yet: the inbox is refused; an upload whose characters don't match
  // the guild roster is refused with 409 NO_GUILD_MATCH and stores nothing (see membership.test.js).
  const loner = client(srv.url, addUser(db, 'Loner#4444').token);
  for (const res of [await loner.get('/api/inbox'), await loner.get('/api/inbox.lua')]) {
    assert.deepStrictEqual([res.status, res.body], [403, { error: 'Join a guild first.' }]);
  }
  r = await upload(loner, {});
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.body.code, 'NO_GUILD_MATCH');
  assert.strictEqual(r.body.autoJoin.status, 'no-match');
  assert.strictEqual(r.body.error, r.body.autoJoin.reason);
  r = await upload(loner, [1, 2]);
  assert.strictEqual(r.status, 400, 'a malformed upload is still a 400');

  // The body must be the addon's data as a JSON object.
  r = await upload(owner, [1, 2]);
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /must be a JSON object/);
  r = await upload(owner, '{"characters":');
  assert.deepStrictEqual([r.status, r.body], [400, { error: 'That request was not valid JSON.' }]);
  assert.strictEqual(count('sync_log'), 0, 'refused uploads are not logged');

  // An empty object is fine (a fresh install with nothing saved yet).
  r = await upload(owner, {});
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual([r.body.characters, r.body.roster, r.body.recipes, r.body.ctas], [0, 0, 0, 0]);
  // Odd values from a hand-edited or broken file are skipped, not fatal.
  r = await upload(owner, {
    characters: { a: null, b: 5, c: { name: '' }, d: { name: 'Okay', level: 'high', professions: 'x', recipes: { X: 'y' } } },
    roster: { members: [null, 'x', { name: 'Fine', online: 1 }] },
    ctaQueue: [null, { zone: '' }, { zone: 'Orgrimmar', at: 'soon' }],
    guildBank: { tabs: [null, { items: [{ id: 'x', count: 2 }] }], log: [null, { at: 'x' }] },
    prices: { items: [null, [1, 2], ['a', 'b', 'c']] },
    reagentIds: ['x', -1, 7],
    shopping: [null, { name: 'Belt', reagents: [{ id: 'no' }] }],
    coach: { chars: { Z: null }, questions: [null, { id: 'z' }] },
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.deepStrictEqual([r.body.characters, r.body.roster, r.body.ctas], [1, 1, 1]);
  assert.strictEqual(db.prepare('SELECT level FROM characters WHERE name = ?').get('Okay').level, null);
  await srv.close();
});

test('old companion sync keys: versions, PvP extras, the inbox as Lua, and removal ends access', async (t) => {
  const { srv, s, db, owner } = await setup(t);
  const key = addLegacyKey(db, s.member.id, s.guildId);
  const legacy = client(srv.url, key);
  const payload = { addonVersion: '0.5.0', characters: { Bravo: { name: 'Bravo', level: 20, addonVersion: '0.5.0',
    pvp: { rankName: 'Scout', rank: 1, hk: 42 }, currencies: [{ name: "Merchant's Favor", qty: 12 }],
    reputations: [{ name: 'Durotar Supply and Logistics', standing: 5, value: 1500, max: 6000 }] } } };

  const ok = await upload(legacy, payload, { 'X-Companion-Version': '0.4.0', 'X-App-Version': '9.9.9' });
  assert.strictEqual(ok.status, 200);
  assert.ok(ok.body.latest && 'addon' in ok.body.latest, 'sync tells the companion the latest versions');
  const u = db.prepare('SELECT addon_version, companion_version, app_version, last_sync_at FROM users WHERE id = ?').get(s.member.id);
  assert.deepStrictEqual([u.addon_version, u.companion_version, u.app_version, Boolean(u.last_sync_at)], ['0.5.0', '0.4.0', null, true]);
  assert.strictEqual(db.prepare('SELECT addon_version FROM devices WHERE id = ?').get(s.member.deviceId).addon_version, null, 'devices are untouched');
  assert.ok(db.prepare('SELECT last_used_at FROM api_tokens').get().last_used_at);

  // PvP, currencies and reputations are kept for the character page.
  const extras = JSON.parse(db.prepare('SELECT extras FROM characters WHERE name = ?').get('Bravo').extras);
  assert.deepStrictEqual(extras.pvp, { rank: 1, hk: 42, rankName: 'Scout' });
  assert.deepStrictEqual(extras.currencies, [{ id: null, name: "Merchant's Favor", qty: 12, max: null }]);
  assert.deepStrictEqual(extras.reputations, [{ name: 'Durotar Supply and Logistics', standing: 5, value: 1500, max: 6000, header: null }]);
  assert.strictEqual(extras.addonVersion, '0.5.0');

  // Officer tools see the versions.
  const row = (await owner.get('/api/members')).body.members.find((m) => m.id === s.member.id);
  assert.deepStrictEqual([row.addon_version, row.companion_version, Boolean(row.last_sync_at), row.sync_keys], ['0.5.0', '0.4.0', true, 1]);

  // A device token doesn't touch companion_version.
  await upload(client(srv.url, s.member.token), { addonVersion: '0.11.0' }, { 'X-Companion-Version': '0.9.9' });
  assert.deepStrictEqual({ ...db.prepare('SELECT addon_version, companion_version FROM users WHERE id = ?').get(s.member.id) },
    { addon_version: '0.11.0', companion_version: '0.4.0' });
  // A junk version header is ignored.
  await upload(legacy, {}, { 'X-Companion-Version': 'not a version!' });
  assert.strictEqual(db.prepare('SELECT companion_version FROM users WHERE id = ?').get(s.member.id).companion_version, '0.4.0');

  // The inbox, as JSON and as the Lua file old companions save as-is.
  const inbox = await legacy.get('/api/inbox');
  assert.strictEqual(inbox.status, 200);
  assert.strictEqual(inbox.body.guild, 'wow');
  assert.strictEqual(inbox.body.site, srv.cfg.baseUrl);
  const lua = await legacy.get('/api/inbox.lua');
  assert.strictEqual(lua.status, 200);
  assert.match(lua.headers.get('content-type'), /^text\/plain/);
  assert.match(lua.body, /^-- Written by Guild Camp\. Do not edit\.\nWowGuildInbox = \{/);
  const parsed = parseSavedVariables(Buffer.from(lua.body, 'utf8')).WowGuildInbox;
  assert.strictEqual(parsed.guild, 'wow');
  assert.strictEqual(parsed.latestAddon, TOC_VERSION);
  assert.strictEqual(parsed.site, srv.cfg.baseUrl);
  // ... and it loads in game.
  const wow = new WowClient({ inboxLua: lua.body }).login();
  assert.strictEqual(wow.eval('WowGuildInbox.guild'), 'wow');
  assert.strictEqual(wow.eval('__ns.debugError'), null);

  // Removed from the guild: the key stops working and the character is unlinked.
  assert.strictEqual((await owner.post(`/api/members/${s.member.id}/remove`)).status, 200);
  const after = await upload(legacy, payload);
  assert.strictEqual(after.status, 401);
  assert.match(after.body.error, /sync key no longer works/);
  assert.strictEqual((await legacy.get('/api/inbox')).status, 401);
  assert.strictEqual(db.prepare('SELECT user_id FROM characters WHERE name = ?').get('Bravo').user_id, null);
  assert.strictEqual((await upload(client(srv.url, s.member.token), {})).status, 401, 'their app is signed out too');
  await srv.close();
});

test('nobody takes over another member\'s character; roster scans never claim or go back in time', async (t) => {
  const { srv, s, db, member, officer } = await setup(t);
  await upload(member, { characters: { Thrallia: { name: 'Thrallia', class: 'SHAMAN', level: 23 } } });
  const r = await upload(officer, { characters: { Thrallia: { name: 'Thrallia', class: 'MAGE', level: 60 }, Jaina: { name: 'Jaina', level: 30 } } });
  assert.strictEqual(r.body.characters, 1, 'only the officer\'s own character counts');
  const th = db.prepare('SELECT user_id, class, level FROM characters WHERE name = ?').get('Thrallia');
  assert.deepStrictEqual({ ...th }, { user_id: s.member.id, class: 'SHAMAN', level: 23 });
  assert.strictEqual(db.prepare('SELECT user_id FROM characters WHERE name = ?').get('Jaina').user_id, s.officer.id);

  // A roster scan from someone else: online status and rank for everyone, nobody's character changes hands.
  const at = NOW();
  const scan = (scannedAt, online) => ({ roster: { scannedAt, guild: 'wow', members: [
    { name: 'Thrallia', class: 'SHAMAN', level: 24, rank: 'Officer', zone: 'Orgrimmar', online },
    { name: 'Newbie', class: 'MAGE', level: 5, rank: 'Initiate', zone: 'Durotar', online: true },
  ] } });
  assert.strictEqual((await upload(officer, scan(at, true))).body.roster, 2);
  let rows = Object.fromEntries(db.prepare('SELECT name, user_id, online, rank, zone FROM characters').all().map((c) => [c.name, c]));
  assert.deepStrictEqual([rows.Thrallia.user_id, rows.Thrallia.online, rows.Thrallia.rank, rows.Thrallia.zone], [s.member.id, 1, 'Officer', 'Orgrimmar']);
  assert.deepStrictEqual([rows.Newbie.user_id, rows.Newbie.online], [null, 1]);
  assert.strictEqual(rows.Jaina.online, 0, 'not in the scan: offline');
  const scannedAt = db.prepare('SELECT roster_scanned_at AS t FROM guilds').get().t;

  // An older scan is ignored.
  assert.strictEqual((await upload(member, scan(at - 3600, false))).body.roster, 0);
  rows = Object.fromEntries(db.prepare('SELECT name, online FROM characters').all().map((c) => [c.name, c]));
  assert.strictEqual(rows.Thrallia.online, 1);
  assert.strictEqual(db.prepare('SELECT roster_scanned_at AS t FROM guilds').get().t, scannedAt);
  await srv.close();
});

// ---------------------------------------------------------------- economy

test('bags, bank and guild bank arrive with auction prices; repeats and older scans change nothing', async (t) => {
  const { srv, s, db, owner, count } = await setup(t);
  const { sv } = playSession({ mocks: GUILD_BANK_MOCK, cta: false, during: (w) => {
    w.fire('BANKFRAME_OPENED');
    w.fire('GUILDBANKFRAME_OPENED');
    w.fire('GUILDBANKFRAME_CLOSED');
  } });
  assert.strictEqual(sv.guildBank.log.length, 2);
  sv.prices = { items: [[14047, 120, TODAY()], [13444, 900, TODAY() - 1]] };

  const r = await upload(owner, sv);
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual([r.body.bank, r.body.prices, r.body.inventory], [3, 2, 4]);
  assert.strictEqual(db.prepare('SELECT name FROM item_names WHERE item_id = 14047').get().name, 'Runecloth');
  assert.strictEqual(db.prepare('SELECT count FROM inventory WHERE location = ? AND item_id = 14047').get('bank').count, 35);
  assert.deepStrictEqual({ ...db.prepare('SELECT bank_money FROM guilds').get() }, { bank_money: 1234567 });
  assert.deepStrictEqual(db.prepare('SELECT tab, item_id, count FROM guild_bank ORDER BY tab, item_id').all().map((x) => [x.tab, x.item_id, x.count]),
    [['Mats', 13444, 4], ['Mats', 14047, 30], ['Raid', 13457, 6]]);
  assert.strictEqual(E.latestPrices(db, s.guildId, [14047])[14047].price, 120);
  assert.strictEqual(E.searchPrices(db, s.guildId, 'rune')[0].name, 'Runecloth');
  assert.deepStrictEqual(db.prepare('SELECT kind, who, item_id, count, amount FROM bank_log ORDER BY kind').all().map((x) => ({ ...x })), [
    { kind: 'deposit', who: 'Grommash', item_id: 14047, count: 10, amount: null },
    { kind: 'withdraw', who: 'Thrallia', item_id: null, count: null, amount: 50000 },
  ]);

  // Uploading the same log again doesn't duplicate it; a cheaper price the same day wins.
  sv.prices.items[0][1] = 100;
  await upload(owner, sv);
  assert.strictEqual(count('bank_log'), 2);
  assert.strictEqual(E.latestPrices(db, s.guildId, [14047])[14047].price, 100);
  // An older guild bank scan doesn't overwrite a newer one.
  const older = JSON.parse(JSON.stringify(sv));
  older.guildBank.scannedAt -= 3600;
  older.guildBank.tabs = [];
  assert.strictEqual((await upload(owner, older)).body.bank, 0);
  assert.strictEqual(count('guild_bank'), 3);
  // The bank only refreshes when the player opened it: bags alone keep the bank rows.
  const bagsOnly = JSON.parse(JSON.stringify(sv));
  delete bagsOnly.characters.Thrallia.inventory.bank;
  delete bagsOnly.guildBank;
  await upload(owner, bagsOnly);
  assert.strictEqual(count('inventory WHERE location = ?', 'bank'), 1);
  await srv.close();
});

test('shopping list, reagent prices, alt and guild bank stock, holdings and crafters come back in the inbox', async (t) => {
  const { srv, s, db, owner, member } = await setup(t);
  const today = TODAY();
  const r = await upload(owner, {
    characters: {
      Thrallia: { name: 'Thrallia', inventory: { bags: [{ id: 2589, name: 'Linen Cloth', count: 2 }] } },
      Altie: { name: 'Altie', inventory: { bank: [{ id: 2589, name: 'Linen Cloth', count: 7 }] }, recipes: { Tailoring: [{ name: 'Linen Belt', id: 7 }] } },
    },
    guildBank: { scannedAt: NOW(), money: 0, tabs: [{ name: 'Mats', items: [{ id: 2589, name: 'Linen Cloth', count: 20 }] }] },
    prices: { items: [[2589, 12, today], [2840, 55, today]] },
    reagentIds: [2589, 2840, 2835],
    shopping: [{ name: 'Linen Belt', qty: 6, prof: 'Blacksmithing', reagents: [{ id: 2589, name: 'Linen Cloth', qty: 1 }] }],
  });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(db.prepare('SELECT item_id FROM wanted_items WHERE user_id = ? ORDER BY item_id').all(s.owner.id).map((x) => x.item_id), [2589, 2835, 2840]);
  assert.deepStrictEqual(JSON.parse(db.prepare('SELECT items FROM shopping_lists WHERE user_id = ?').get(s.owner.id).items),
    [{ name: 'Linen Belt', qty: 6, prof: 'Blacksmithing', reagents: [{ id: 2589, name: 'Linen Cloth', qty: 1 }] }]);

  const inbox = (await owner.get('/api/inbox')).body;
  assert.deepStrictEqual([...inbox.prices].sort((a, b) => a.id - b.id), [{ id: 2589, price: 12 }, { id: 2840, price: 55 }]);
  assert.deepStrictEqual(inbox.stock, [{ id: 2589, chars: [{ name: 'Altie', count: 7 }, { name: 'Thrallia', count: 2 }], guildBank: 20 }]);
  assert.deepStrictEqual(inbox.holdings, [{ id: 2589, chars: [{ name: 'Altie', count: 7 }, { name: 'Thrallia', count: 2 }], guildBank: 20 }]);
  assert.deepStrictEqual(inbox.crafters, [{ name: 'Linen Belt', who: 'Altie' }]);
  // Another member sees the guild bank and the crafters, but not your bags or your list.
  const theirs = (await member.get('/api/inbox')).body;
  assert.deepStrictEqual(theirs.holdings, [{ id: 2589, chars: [], guildBank: 20 }]);
  assert.deepStrictEqual(theirs.stock, []);
  assert.deepStrictEqual(theirs.crafters, [{ name: 'Linen Belt', who: 'Altie' }]);

  // The addon shows the stock on the shopping list tracker.
  const wow = new WowClient({ inboxFile: inboxFile(t, inbox) }).login();
  assert.strictEqual(wow.get('WowGuildInbox.stock[1].guildBank'), 20);
  assert.strictEqual(wow.eval('__ns.debugError'), null);

  // An empty list clears it; an upload without one (older addon) leaves it alone.
  await upload(owner, { shopping: {} });
  assert.strictEqual(db.prepare('SELECT items FROM shopping_lists WHERE user_id = ?').get(s.owner.id).items, '[]');
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM wanted_items WHERE user_id = ?').get(s.owner.id).n, 3, 'reagents stay wanted');
  await upload(owner, { shopping: [{ name: 'Copper Bar', reagents: [{ id: 2770, qty: 1 }] }] });
  await upload(owner, { characters: {} });
  assert.match(db.prepare('SELECT items FROM shopping_lists WHERE user_id = ?').get(s.owner.id).items, /Copper Bar/);
  // New reagents replace the old ones.
  await upload(owner, { reagentIds: [2589] });
  assert.deepStrictEqual(db.prepare('SELECT item_id FROM wanted_items WHERE user_id = ?').all(s.owner.id).map((x) => x.item_id), [2589]);
  await srv.close();
});

// ---------------------------------------------------------------- raids

test('raid readiness reaches the sign-up list; raids, sign-ups and reserves reach the addon', async (t) => {
  const { srv, s, db, owner, member } = await setup(t);
  const { sv } = playSession({ cta: false });
  assert.deepStrictEqual(sv.characters.Thrallia.readiness.consumables, { potion: 5, bandage: 10 });
  await upload(owner, sv);

  R.importItems(db, s.guildId, 'Hyjal Summit', 'Rage Winterchill | Frost Greaves\nAnetheron | Night Cloak\nArchimonde | Tear of the Earth');
  const items = Object.fromEntries(R.itemsForInstance(db, s.guildId, 'Hyjal Summit').map((i) => [i.name, i.id]));
  const addRaid = (title, startsIn, status = 'open') => {
    const id = db.prepare('INSERT INTO raids (guild_id, title, instance, starts_at, sr_limit, status, created_by) VALUES (?,?,?,?,2,?,?)')
      .run(s.guildId, title, 'Hyjal Summit', new Date(Date.now() + startsIn).toISOString(), status, s.owner.id).lastInsertRowid;
    return R.raidFor(db, s.guildId, Number(id));
  };
  const week1 = addRaid('Week 1', 86400000);
  addRaid('Week 2', 2 * 86400000, 'locked');
  addRaid('Long gone', -5 * 3600000);
  addRaid('Called off', 3 * 86400000, 'cancelled');
  db.prepare("INSERT INTO signups (raid_id, user_id, character, role, status) VALUES (?,?, 'Thrallia', 'healer', 'yes')").run(week1.id, s.owner.id);
  db.prepare("INSERT INTO signups (raid_id, user_id, character, role, status) VALUES (?,?, 'Grommash', 'tank', 'yes')").run(week1.id, s.member.id);
  R.setReserves(db, week1, s.owner.id, [items['Night Cloak']]);
  db.prepare('INSERT INTO loyalty (guild_id, user_id, item_id, bonus) VALUES (?,?,?,20)').run(s.guildId, s.owner.id, items['Night Cloak']);

  const signups = R.signupsFor(db, week1);
  const mine = signups.find((x) => x.character === 'Thrallia');
  assert.strictEqual(mine.ready.ilvl, 58.2);
  assert.strictEqual(mine.ready.durability, 50);

  const inbox = (await owner.get('/api/inbox')).body;
  assert.deepStrictEqual(inbox.raids.map((r) => r.title), ['Week 1', 'Week 2'], 'open and locked raids ahead; not past or cancelled ones');
  const r1 = inbox.raids[0];
  assert.deepStrictEqual([r1.signup, r1.role, r1.character, r1.coming, r1.status, r1.instance], ['yes', 'healer', 'Thrallia', 2, 'open', 'Hyjal Summit']);
  assert.deepStrictEqual(r1.reserves, [{ name: 'Night Cloak', bonus: 20 }]);
  assert.strictEqual(r1.startsAt, Math.floor(Date.parse(week1.starts_at) / 1000));
  assert.strictEqual(r1.starts_at, undefined);
  assert.deepStrictEqual([inbox.raids[1].signup, inbox.raids[1].reserves], [null, []]);
  // Each member sees their own sign-up.
  const theirs = (await member.get('/api/inbox')).body.raids[0];
  assert.deepStrictEqual([theirs.signup, theirs.role, theirs.reserves], ['yes', 'tank', []]);

  // The addon shows them without errors.
  const wow = new WowClient({ inboxFile: inboxFile(t, inbox) }).login();
  assert.match(wow.eval('__ns.textRaids()'), /Week 1[^\n]*2 coming[\s\S]*you're coming\|r as healer[\s\S]*Night Cloak \(\+20\)/);
  wow.slash('');
  assert.strictEqual(wow.eval('__ns.debugError'), null);
  await srv.close();
});

// ---------------------------------------------------------------- fresh start and realm

test('fresh start: stale or off-realm uploads stay out; the first new login sets the realm', async (t) => {
  const { srv, s, db, owner, discord, count } = await setup(t);
  await owner.put('/api/guild/settings', { discord_webhook: WEBHOOK });
  const before = NOW() - 3600;
  const retail = {
    characters: { Testy: { name: 'Testy', class: 'MAGE', level: 80, realm: 'Ragnaros', guild: 'Test Guild', updated: before,
      inventory: { bags: [{ id: 2589, name: 'Linen Cloth', count: 5 }] }, professions: [{ name: 'Tailoring', skill: 300, max: 300 }], recipes: { Tailoring: [{ name: 'Linen Belt' }] } } },
    roster: { scannedAt: before, guild: 'Test Guild', members: [{ name: 'Testy', level: 80, class: 'MAGE', online: true }] },
    guildBank: { scannedAt: before, guild: 'Test Guild', money: 100, tabs: [{ name: 'T', items: [{ id: 2589, name: 'Linen Cloth', count: 1 }] }] },
    prices: { items: [[2589, 100, 2000]] },
    ctaQueue: [{ at: before, character: 'Testy', zone: 'Orgrimmar', msg: 'test', needed: 5 }],
  };
  assert.strictEqual((await upload(owner, retail)).body.ctas, 1);
  assert.strictEqual(discord.calls.length, 1);
  assert.ok(count('characters') > 0);

  const r = resetGuild(db, s.guildId, null);
  assert.strictEqual(r.removed.sync_log, 1);
  for (const tbl of ['characters', 'inventory', 'recipes', 'professions', 'guild_bank', 'prices', 'ctas', 'sync_log']) assert.strictEqual(count(tbl), 0, tbl);

  // The old Retail file uploads again: none of it comes back, and nothing is announced.
  const again = await upload(owner, retail);
  assert.strictEqual(again.status, 200);
  assert.deepStrictEqual([again.body.characters, again.body.roster, again.body.ctas, again.body.bank, again.body.prices], [0, 0, 0, 0, 0]);
  for (const tbl of ['characters', 'guild_bank', 'prices', 'ctas']) assert.strictEqual(count(tbl), 0, `stale ${tbl}`);
  assert.strictEqual(discord.calls.length, 1);
  assert.strictEqual(count('sync_log'), 1, 'the upload itself still counts as a sync');

  // First Forever login after the wipe: accepted, and it sets the realm.
  const now = NOW() + 5;
  const today = TODAY();
  await upload(owner, {
    characters: { Grom: { name: 'Grom', class: 'WARRIOR', level: 1, realm: 'Forever Realm', guild: 'wow', updated: now } },
    roster: { scannedAt: now, guild: 'wow', members: [{ name: 'Grom', level: 1, class: 'WARRIOR', online: true }] },
    prices: { items: [[2589, 120, today]] },
  });
  assert.deepStrictEqual(db.prepare('SELECT name FROM characters').all().map((c) => c.name), ['Grom']);
  assert.deepStrictEqual({ ...db.prepare('SELECT realm, game_guild FROM guilds').get() }, { realm: 'Forever Realm', game_guild: 'wow' });
  assert.strictEqual(count('prices'), 1);

  // Retail played after launch: characters, roster, bank and prices from that upload are kept out.
  const late = await upload(owner, { ...retail, characters: { Testy: { ...retail.characters.Testy, updated: now } },
    roster: { ...retail.roster, scannedAt: now }, guildBank: { ...retail.guildBank, scannedAt: now }, prices: { items: [[999, 5, today]] } });
  assert.deepStrictEqual([late.body.characters, late.body.roster, late.body.bank, late.body.prices], [0, 0, 0, 0]);
  assert.deepStrictEqual(db.prepare('SELECT name FROM characters').all().map((c) => c.name), ['Grom']);
  assert.strictEqual(count('prices WHERE item_id = 999'), 0);
  assert.strictEqual(count('guild_bank'), 0);

  // freshOnly on its own: calls to arms from before the reset are dropped, newer ones kept.
  const p = freshOnly(db, s.guildId, { ctaQueue: [{ zone: 'Old', at: before }, { zone: 'New', at: now }] });
  assert.deepStrictEqual(p.ctaQueue.map((q) => q.zone), ['New']);
  await srv.close();
});

test('the first synced character tells the server the realm and the in-game guild', async (t) => {
  const { srv, db, owner, member } = await setup(t);
  // An old addon without a realm doesn't set anything.
  await upload(member, { characters: { Oldie: { name: 'Oldie', level: 10 } } });
  assert.deepStrictEqual({ ...db.prepare('SELECT realm, game_guild FROM guilds').get() }, { realm: null, game_guild: null });

  await upload(owner, { characters: { Grommash: { name: 'Grommash', class: 'WARRIOR', level: 58, guild: 'wow', realm: "Zul'jin" } } });
  assert.deepStrictEqual({ ...db.prepare('SELECT realm, game_guild FROM guilds').get() }, { realm: "Zul'jin", game_guild: 'wow' });
  const g = (await owner.get('/api/guild')).body.guild;
  assert.deepStrictEqual([g.realm, g.game_guild], ["Zul'jin", 'wow']);

  // Later uploads never move it; characters on another realm are left out from now on.
  const r = await upload(member, { characters: { Elsewhere: { name: 'Elsewhere', level: 70, guild: 'Other', realm: 'Ragnaros' }, Here: { name: 'Here', level: 12, realm: "Zul'jin" } } });
  assert.strictEqual(r.body.characters, 1);
  assert.deepStrictEqual({ ...db.prepare('SELECT realm, game_guild FROM guilds').get() }, { realm: "Zul'jin", game_guild: 'wow' });
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM characters WHERE name = ?').get('Elsewhere').n, 0);
  // A guild bank or roster from another in-game guild is ignored too.
  const other = await upload(member, { characters: { Here: { name: 'Here', realm: "Zul'jin" } },
    roster: { scannedAt: NOW(), guild: 'Not Us', members: [{ name: 'Stranger', online: true }] },
    guildBank: { scannedAt: NOW(), guild: 'Not Us', money: 5, tabs: [{ name: 'X', items: [{ id: 1, count: 1 }] }] } });
  assert.deepStrictEqual([other.body.roster, other.body.bank], [0, 0]);
  await srv.close();
});

// ---------------------------------------------------------------- Coach

test('Coach: play style and questions are stored once, and the Coach is started for new questions', async (t) => {
  const { srv, s, db, owner, kicks, count } = await setup(t);
  let r = await upload(owner, coachPayload());
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.coachPending, 1, 'the question waits; without a Claude key no plan is pending');
  assert.strictEqual(kicks.length, 1, 'a new question starts the Coach (it answers "not set up" without a key)');
  assert.strictEqual(count('coach_qa'), 1);
  const row = db.prepare('SELECT * FROM coach_chars').get();
  assert.deepStrictEqual([row.user_id, row.name, row.class, row.level, row.realm], [s.owner.id, 'Grom', 'WARRIOR', 24, 'Forever']);
  assert.strictEqual(JSON.parse(row.profile).archetype, 'Warmonger');

  // The same question again: stored once, nothing new to start.
  r = await upload(owner, coachPayload());
  assert.strictEqual(count('coach_qa'), 1);
  assert.strictEqual(r.body.coachPending, 1);
  assert.strictEqual(kicks.length, 1);

  const coach = (await owner.get('/api/inbox')).body.coach;
  assert.deepStrictEqual(coach.plans, {});
  assert.deepStrictEqual(coach.answers.map((a) => [a.qid, a.char, a.q, a.a, a.status]), [['q1', 'Grom', 'Deflection or Improved Charge?', null, 'pending']]);
  assert.strictEqual(typeof coach.answers[0].at, 'number');
  assert.deepStrictEqual([coach.pending, coach.enabled], [1, true]);

  // Answered: nothing pending any more.
  db.prepare("UPDATE coach_qa SET status = 'answered', answer = 'Take **Deflection** — it’s better in duels.', answered_at = datetime('now')").run();
  r = await upload(owner, { characters: {} });
  assert.strictEqual(r.body.coachPending, 0);
  const answered = (await owner.get('/api/inbox')).body.coach.answers[0];
  assert.strictEqual(answered.a, "Take Deflection - it's better in duels.", 'plain text for the game');

  // Coach switched off by the officers: the addon is told.
  db.prepare('UPDATE guilds SET coach_enabled = 0').run();
  assert.strictEqual((await owner.get('/api/inbox')).body.coach.enabled, false);
  // No coach service registered: the upload still works.
  delete srv.ctx.services.coach;
  r = await upload(owner, coachPayload({ questions: [{ id: 'q2', char: 'Grom', text: 'Best weapon?' }] }));
  assert.strictEqual(r.status, 200);
  assert.strictEqual(count('coach_qa'), 2);
  await srv.close();
});

test('Coach with a Claude key: a first plan, a plan asked for in game, and levels gained start it', async (t) => {
  const { srv, db, owner, kicks } = await setup(t, { anthropicKey: 'sk-test' });
  try {
    let r = await upload(owner, coachPayload({ questions: [] }));
    assert.strictEqual(r.body.coachPending, 1, 'a first plan is wanted');
    assert.strictEqual(kicks.length, 1);

    // The plan is written: nothing pending, nothing started.
    db.prepare("UPDATE coach_chars SET plan = ?, plan_level = level, plan_at = datetime('now', '+1 minute')").run(JSON.stringify({ headline: 'Arms', spec: 'Arms', sources: [{ url: 'x' }] }));
    r = await upload(owner, coachPayload({ questions: [] }));
    assert.strictEqual(r.body.coachPending, 0);
    assert.strictEqual(kicks.length, 1);
    const plans = (await owner.get('/api/inbox')).body.coach.plans;
    assert.deepStrictEqual(plans, { Grom: { headline: 'Arms', spec: 'Arms' } }, 'sources stay on the server');

    // Asking for a fresh plan in game queues one.
    r = await upload(owner, coachPayload({ chars: { Grom: { name: 'Grom', planRequest: NOW() + 120 } }, questions: [] }));
    assert.strictEqual(r.body.coachPending, 1);
    assert.strictEqual(kicks.length, 2);
    // So do three more levels.
    db.prepare("UPDATE coach_chars SET plan_requested_at = NULL, plan_at = datetime('now', '+1 minute')").run();
    assert.strictEqual((await upload(owner, { characters: {} })).body.coachPending, 0);
    r = await upload(owner, coachPayload({ chars: { Grom: { name: 'Grom', level: 27 } }, questions: [] }));
    assert.strictEqual(r.body.coachPending, 1);
    assert.strictEqual(kicks.length, 3);
  } finally {
    C.setKeyPresent(false); // module-level switch: don't leak into later tests
    await srv.close();
  }
});

test('the Coach in game: play style and a question upload; the answer and plan come back through the inbox', async (t) => {
  const { srv, s, db, owner, kicks } = await setup(t);
  const first = new WowClient({ mocks: COACH_GAME }).login();
  first.exec('__ns.coach.ask("Enhancement or Elemental for world PvP?")');
  first.exec('__ns.coach.saveQuiz({ aggression = 5, risk = 2, social = 1, pvp = 5, pace = 3, role = "Damage", goal = "World PvP" })');
  first.logout();
  const sv = parseSavedVariables(first.saveVariablesBuffer()).WowGuildDB;
  const r = await upload(owner, sv);
  assert.strictEqual(r.body.coachPending, 1);
  assert.strictEqual(kicks.length, 1);

  const row = db.prepare('SELECT * FROM coach_chars WHERE name = ?').get('Thrallia');
  assert.deepStrictEqual([row.user_id, row.class, row.level, row.realm], [s.owner.id, 'SHAMAN', 23, 'Forever']);
  assert.strictEqual(JSON.parse(row.profile).archetype, 'Warmonger');
  assert.strictEqual(JSON.parse(row.quiz).goal, 'World PvP');
  assert.strictEqual(JSON.parse(row.talents).picked[0].name, 'Ancestral Knowledge');
  assert.strictEqual(JSON.parse(row.gear).items[0].name, 'Big Stick');
  assert.match(C.charContext(row), /Talents: Elemental 0 \/ Enhancement 11 \/ Restoration 0, 1 unspent/);
  const qa = db.prepare('SELECT * FROM coach_qa').get();
  assert.deepStrictEqual([qa.question, qa.char_name, qa.source, qa.status], ['Enhancement or Elemental for world PvP?', 'Thrallia', 'game', 'pending']);

  // The Coach answers (stand-in for Claude) and writes the plan; the next inbox brings both back.
  db.prepare("UPDATE coach_qa SET status = 'answered', answer = 'Enhancement: Stormstrike burst wins world fights.', answered_at = datetime('now')").run();
  db.prepare('UPDATE coach_chars SET plan = ?').run(JSON.stringify({ headline: 'Enhancement for world PvP', summary: 'Burst with Stormstrike.', spec: 'Enhancement', split: '0/31/20',
    talents: [{ name: 'Ancestral Knowledge', tree: 'Enhancement', points: 5, why: 'More mana' }, { name: 'Flurry', tree: 'Enhancement', points: 5, why: 'Big speed' }],
    stats: ['Strength', 'Agility'], tips: ['Open with Earth Shock interrupts'], next_steps: [{ title: 'Get a slow two-hander', detail: 'Windfury loves it' }], confidence: 'classic', level: 23, at: 1 }));
  const inbox = (await owner.get('/api/inbox')).body;
  assert.strictEqual(inbox.coach.pending, 0);
  const lua = (await owner.get('/api/inbox.lua')).body;
  const wow = new WowClient({ mocks: COACH_GAME, savedVariables: first.saveVariablesBuffer(), inboxLua: lua }).login();
  wow.exec('__ns.coachUI.show("ask")');
  assert.strictEqual(wow.eval('#__ns.db.coach.questions'), '0', 'the answered question leaves the queue');
  assert.match(wow.eval('__ns.coach.answers()[1].a'), /Stormstrike burst/);
  wow.exec('__ns.coachUI.view("build")');
  assert.strictEqual(wow.eval('__ns.coach.plan().spec'), 'Enhancement');
  assert.strictEqual(wow.eval('__ns.debugError'), null);
  await srv.close();
});

// ---------------------------------------------------------------- the inbox

test('inbox: notices, requests you can craft, your requests, leveling partners, latest addon and site', async (t) => {
  const { srv, s, db, owner, officer } = await setup(t);
  await upload(owner, playSession({ cta: false }).sv); // Thrallia knows Copper Chain Vest
  for (let i = 1; i <= 6; i++) db.prepare("INSERT INTO announcements (guild_id, user_id, body, created_at) VALUES (?,?,?, datetime('now', ?))").run(s.guildId, s.officer.id, `Notice ${i}`, `-${10 - i} minutes`);
  const req = (who, item, status = 'open', crafter = null, notes = null) => Number(db.prepare('INSERT INTO craft_requests (guild_id, requester_id, item, notes, status, crafter_id) VALUES (?,?,?,?,?,?)')
    .run(s.guildId, who, item, notes, status, crafter).lastInsertRowid);
  const vest = req(s.member.id, 'copper chain vest', 'open', null, 'mats in mail');
  req(s.member.id, 'Thorium Helm');
  req(s.member.id, 'Copper Chain Vest', 'done');
  req(s.owner.id, 'Copper Chain Vest'); // your own request: not in "you can make"
  req(s.owner.id, 'Linen Belt', 'claimed', s.officer.id);
  req(s.owner.id, 'Old Thing', 'cancelled');
  db.prepare("INSERT INTO buddy_posts (guild_id, user_id, character, level, zone, when_text, note, active) VALUES (?,?, 'Grom', 22, 'The Barrens', 'evenings', 'questing', 1)").run(s.guildId, s.member.id);
  db.prepare("INSERT INTO buddy_posts (guild_id, user_id, character, active) VALUES (?,?, 'Gone', 0)").run(s.guildId, s.member.id);
  db.prepare("INSERT INTO buddy_posts (guild_id, user_id, character, active) VALUES (?,?, 'Thrallia', 1)").run(s.guildId, s.owner.id);

  const r = await owner.get('/api/inbox');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers.get('cache-control'), 'no-store');
  const inbox = r.body;
  assert.deepStrictEqual(Object.keys(inbox).sort(), ['announcements', 'buddies', 'canCraft', 'coach', 'crafters', 'generatedAt', 'guild', 'holdings',
    'latestAddon', 'myRequests', 'prices', 'raids', 'site', 'stock'].sort());
  assert.strictEqual(inbox.guild, 'wow');
  assert.strictEqual(inbox.site, srv.cfg.baseUrl);
  assert.strictEqual(inbox.latestAddon, TOC_VERSION);
  assert.ok(Math.abs(inbox.generatedAt - NOW()) < 5);
  assert.deepStrictEqual(inbox.announcements.map((a) => a.body), ['Notice 6', 'Notice 5', 'Notice 4', 'Notice 3', 'Notice 2'], 'the newest five');
  assert.strictEqual(inbox.announcements[0].by, 'Officer#2222');
  assert.match(inbox.announcements[0].at, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
  assert.deepStrictEqual(inbox.canCraft, [{ id: vest, item: 'copper chain vest', notes: 'mats in mail', requester: 'Member#3333' }]);
  assert.deepStrictEqual(inbox.myRequests, [{ item: 'Linen Belt', status: 'claimed', crafter: 'Officer#2222' }, { item: 'Copper Chain Vest', status: 'open', crafter: null }]);
  assert.deepStrictEqual(inbox.buddies, [{ character: 'Grom', level: 22, zone: 'The Barrens', whenText: 'evenings', note: 'questing' }]);
  // Someone who can't make anything gets no craft requests.
  assert.deepStrictEqual((await officer.get('/api/inbox')).body.canCraft, []);

  // The same news as Lua: what an old companion saves.
  const lua = parseSavedVariables(Buffer.from((await owner.get('/api/inbox.lua')).body, 'utf8')).WowGuildInbox;
  assert.deepStrictEqual(lua.canCraft, inbox.canCraft);
  assert.deepStrictEqual(lua.myRequests, inbox.myRequests);
  assert.strictEqual(lua.announcements.length, 5);

  // In game: the login news counts the request you can make and shows the latest notice.
  const wow = new WowClient({ inbox }).login();
  assert.match(wow.printed(), /1 crafting request you can make\./);
  assert.match(wow.printed(), /latest notice: Notice 6/);
  wow.slash('');
  wow.exec('__ns.ui.show("guild")');
  assert.strictEqual(wow.eval('__ns.debugError'), null);
  await srv.close();
});

test('inbox and sync reply: latest addon follows what was published, or none at all', async (t) => {
  const { srv, s, owner } = await setup(t, { bundledAddonDir: path.join(os.tmpdir(), `gc-no-addon-${process.pid}-${Date.now()}`) });
  let inbox = (await owner.get('/api/inbox')).body;
  assert.strictEqual(inbox.latestAddon, null, 'no addon published and none bundled');
  assert.strictEqual((await upload(owner, {})).body.latest.addon, null);
  const lua = (await owner.get('/api/inbox.lua')).body;
  assert.match(lua, /\n {2}latestAddon = nil,\n/, 'nil in Lua');
  // Without news of a newer version, the addon stays quiet about updates.
  assert.doesNotMatch(new WowClient({ inboxLua: lua }).login().printed(), /newer version/);

  // The owner publishes 0.12.0 (the real release client): the inbox and the sync reply follow.
  const dir = path.join(tmpDir(t, 'gc-addon-'), 'WowGuild');
  fs.cpSync(REPO_ADDON, dir, { recursive: true });
  release.bumpAddonVersion(dir, '0.12.0');
  await release.publishAddon({ server: srv.url, token: s.owner.token, pack: release.packAddon(dir), notes: 'Tooltips.' });
  inbox = (await owner.get('/api/inbox')).body;
  assert.strictEqual(inbox.latestAddon, '0.12.0');
  const reply = (await upload(owner, {})).body;
  assert.strictEqual(reply.latest.addon.version, '0.12.0');
  assert.strictEqual(reply.latest.addon.url, '/updates/addon/WowGuild-0.12.0.zip');
  const wow = new WowClient({ inbox, addonVersion: '0.11.0' }).login();
  assert.match(wow.printed(), /A newer version of this addon \(0\.12\.0\) is out\.\|r Update it from the Guild Camp app/);
  await srv.close();
});
