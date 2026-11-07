// Community domain: Camp dashboard, calls to arms, notices, roster, characters and mains, crafters and
// shopping lists, crafting requests and leveling partners (routes/community.js, services/community.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, seed, client, addUser } = require('./helpers');
const { applyPayload } = require('../src/services/sync');

const WEBHOOK = 'https://discord.com/api/webhooks/1/abc';
const today = () => Math.floor((Date.now() - Date.UTC(2020, 0, 1)) / 86400000);
const nowSec = () => Math.floor(Date.now() / 1000);

// A server with a fake Discord, a seeded guild (owner/officer/member) and a webhook.
async function setup(overrides = {}) {
  const posts = [];
  const fetch = async (url, init) => {
    posts.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 204, json: async () => ({}), text: async () => '' };
  };
  const srv = await startServer({ fetch, ...overrides });
  const s = seed(srv.db);
  srv.db.prepare('UPDATE guilds SET discord_webhook = ? WHERE id = ?').run(WEBHOOK, s.guildId);
  return {
    srv, s, posts, db: srv.db,
    owner: client(srv.url, s.owner.token),
    officer: client(srv.url, s.officer.token),
    member: client(srv.url, s.member.token),
    discordText: () => posts.map((p) => p.body.content),
  };
}

const eventsFor = async (c) => (await c.get('/api/events?after=0')).body.events;

test('community routes need a signed-in guild member', async () => {
  const t = await setup();
  try {
    const anon = client(t.srv.url);
    for (const p of ['/api/camp', '/api/roster', '/api/characters/X', '/api/crafters', '/api/requests', '/api/partners', '/api/activity']) {
      assert.equal((await anon.get(p)).status, 401, p);
    }
    const loner = addUser(t.db, 'Loner#4444');
    const lc = client(t.srv.url, loner.token);
    assert.equal((await lc.get('/api/camp')).status, 403);
    assert.equal((await lc.post('/api/ctas', { zone: 'X' })).status, 403);
    assert.equal((await lc.get('/api/camp')).body.error, 'Join a guild first.');
  } finally { await t.srv.close(); }
});

test('camp dashboard: online, calls to arms, notices, activity, raids, realm and onboarding', async () => {
  const t = await setup({ discordPublicKey: 'abc' });
  const { db, s } = t;
  try {
    const scanned = nowSec();
    applyPayload(db, s.guildId, s.member.id, {
      characters: [
        { name: 'Mokra', class: 'SHAMAN', race: 'Tauren', level: 58, zone: 'Winterspring', updated: scanned - 60,
          professions: [{ name: 'Alchemy', skill: 250, max: 300 }] },
        { name: 'Altie', class: 'MAGE', level: 20, zone: 'The Barrens', updated: scanned },
      ],
      roster: { scannedAt: scanned, members: [
        { name: 'Mokra', class: 'SHAMAN', level: 58, rank: 'Member', zone: 'Winterspring', online: true },
        { name: 'Grim', class: 'WARRIOR', level: 60, rank: 'Officer', zone: 'Orgrimmar', online: true },
        { name: 'Sleepy', class: 'PRIEST', level: 60, rank: 'Member', zone: 'Undercity', online: false },
      ] },
    });
    db.prepare("INSERT INTO sync_log (guild_id, user_id, bytes) VALUES (?,?,100)").run(s.guildId, s.member.id);
    db.prepare("INSERT INTO ctas (guild_id, user_id, character, zone, message, needed, created_at) VALUES (?,?,?,?,?,?, datetime('now','-2 days'))")
      .run(s.guildId, s.owner.id, 'Grim', 'Old fight', '', 5);
    db.prepare("UPDATE guilds SET realm_status = ? WHERE id = ?").run(JSON.stringify({ found: true, name: 'Mirage', up: true, queue: false, checkedAt: new Date().toISOString() }), s.guildId);
    const soon = new Date(Date.now() + 2 * 86400000).toISOString();
    const later = new Date(Date.now() + 5 * 86400000).toISOString();
    const past = new Date(Date.now() - 86400000).toISOString();
    const r1 = Number(db.prepare("INSERT INTO raids (guild_id, title, instance, starts_at) VALUES (?, 'Molten Core', 'Molten Core', ?)").run(s.guildId, soon).lastInsertRowid);
    db.prepare("INSERT INTO raids (guild_id, title, instance, starts_at, kind) VALUES (?, 'Premade', 'Warsong Gulch', ?, 'pvp')").run(s.guildId, later);
    db.prepare("INSERT INTO raids (guild_id, title, instance, starts_at) VALUES (?, 'Old raid', 'Onyxia', ?)").run(s.guildId, past);
    db.prepare("INSERT INTO signups (raid_id, user_id, character, role, status) VALUES (?,?,?,?,?)").run(r1, s.owner.id, 'Grim', 'tank', 'yes');

    // New member: 2 of 5 done (synced, professions); no main, no Discord, not signed up.
    let camp = (await t.member.get('/api/camp')).body;
    assert.deepEqual(camp.online.map((c) => c.name), ['Grim', 'Mokra'], 'online only, highest level first');
    assert.equal(camp.online[1].battletag, 'Member#3333');
    assert.deepEqual(camp.ctas, [], 'calls older than a day are left out');
    assert.equal(camp.realm.name, 'Mirage');
    assert.equal(camp.rosterScannedAt, new Date(scanned * 1000).toISOString());
    assert.ok(camp.mySync);
    assert.deepEqual(camp.raids.map((r) => r.title), ['Molten Core', 'Premade']);
    assert.equal(camp.raids[0].coming, 1);
    assert.equal(camp.raids[0].mySignup, null);
    assert.deepEqual(camp.onboarding.steps.map((x) => [x.key, x.done]),
      [['synced', true], ['professions', true], ['main', false], ['discord', false], ['signup', false]]);
    assert.equal(camp.onboarding.done, 2);
    assert.equal(camp.onboarding.total, 5);
    assert.equal(camp.onboarding.steps.find((x) => x.key === 'main').href, '/characters/Mokra');
    // The Discord step uses the Settings deep link that opens the Discord card and makes a link code.
    assert.equal(camp.onboarding.steps.find((x) => x.key === 'discord').href, '/settings?section=discord&link=1');
    assert.equal(camp.onboarding.steps.find((x) => x.key === 'signup').href, `/raids/${r1}`);
    assert.equal(camp.onboarding.steps.find((x) => x.key === 'signup').label, 'Sign up for Molten Core');
    assert.equal(camp.me.main.name, 'Mokra');
    assert.equal(camp.me.lastZone, 'The Barrens', 'zone of the character seen most recently');
    assert.equal(camp.isOfficer, false);
    assert.ok(camp.activity.some((a) => a.text === 'Mokra linked their character'));

    // The owner's sign-up shows on the preview.
    camp = (await t.owner.get('/api/camp')).body;
    assert.deepEqual(camp.raids[0].mySignup, { status: 'yes', role: 'tank', character: 'Grim' });
    assert.equal(camp.isOfficer, true);
    assert.equal(camp.onboarding.steps[0].href, '/addon');

    // Without a Discord app the Discord step is left out; with nothing scheduled the raid step too.
    await t.srv.close();
    const t2 = await setup();
    try {
      const c2 = (await t2.member.get('/api/camp')).body;
      assert.deepEqual(c2.onboarding.steps.map((x) => x.key), ['synced', 'professions', 'main']);
      assert.equal(c2.onboarding.steps[2].href, '/roster');
      assert.equal(c2.realm, null);
    } finally { await t2.srv.close(); }
  } finally { await t.srv.close(); }
});

test('activity paging', async () => {
  const t = await setup();
  try {
    for (let i = 1; i <= 15; i++) t.srv.ctx.activity(t.s.guildId, 'test', `line ${i}`);
    const camp = (await t.member.get('/api/camp')).body;
    assert.equal(camp.activity.length, 12);
    assert.equal(camp.activity[0].text, 'line 15');
    const more = (await t.member.get(`/api/activity?before=${camp.activity[11].id}&limit=10`)).body;
    assert.deepEqual(more.activity.map((a) => a.text), ['line 3', 'line 2', 'line 1']);
    assert.equal(more.more, false);
    const page = (await t.member.get('/api/activity?limit=5')).body;
    assert.equal(page.activity.length, 5);
    assert.equal(page.more, true);
  } finally { await t.srv.close(); }
});

test('call to arms: validation, Discord, notification for everyone else', async () => {
  const t = await setup();
  const { db, s } = t;
  try {
    applyPayload(db, s.guildId, s.member.id, { characters: [{ name: 'Mokra', class: 'SHAMAN', level: 58 }, { name: 'Altie', level: 10 }] });
    let r = await t.member.post('/api/ctas', { zone: '   ', message: 'help' });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'Say where the fight is.');

    r = await t.member.post('/api/ctas', { zone: 'Tarren Mill', needed: 99, message: 'Alliance at the flight master' });
    assert.equal(r.status, 201);
    assert.equal(r.body.message, 'Horn sounded.');
    assert.equal(r.body.cta.needed, 40, 'needed is capped at 40');
    assert.equal(r.body.cta.character, 'Mokra', 'signed with the highest-level character when no main is set');
    assert.equal(r.body.cta.source, 'app');
    assert.deepEqual(t.discordText(), ['⚔️ **Call to arms: Tarren Mill** (need 40)\nAlliance at the flight master\n— Mokra']);
    assert.equal(t.posts[0].url, WEBHOOK);

    // Everyone but the caller gets a notification.
    const ownerEvents = await eventsFor(t.owner);
    assert.equal(ownerEvents.length, 1);
    assert.equal(ownerEvents[0].kind, 'cta');
    assert.equal(ownerEvents[0].title, '⚔️ Call to arms: Tarren Mill');
    assert.equal(ownerEvents[0].body, 'Need 40. Alliance at the flight master (Mokra)');
    assert.equal(ownerEvents[0].route, '/');
    assert.deepEqual(await eventsFor(t.member), []);

    // needed is optional; 0 rounds up to 1; a caller with no characters signs with their name.
    r = await t.officer.post('/api/ctas', { zone: 'Crossroads' });
    assert.equal(r.body.cta.needed, null);
    assert.equal(r.body.cta.character, null);
    assert.equal(t.discordText()[1], '⚔️ **Call to arms: Crossroads**\n\n— Officer');
    r = await t.officer.post('/api/ctas', { zone: 'Crossroads', needed: 0 });
    assert.equal(r.body.cta.needed, 1);

    // A long zone and message are cut to 60 and 200 characters.
    r = await t.owner.post('/api/ctas', { zone: 'Z'.repeat(80), message: 'm'.repeat(300) });
    assert.equal(r.body.cta.zone.length, 60);
    assert.equal(r.body.cta.message.length, 200);

    const camp = (await t.owner.get('/api/camp')).body;
    assert.equal(camp.ctas.length, 4);
    assert.equal(camp.ctas[3].zone, 'Tarren Mill');
    assert.equal(camp.ctas[3].class, 'SHAMAN');
    assert.equal(camp.ctas[3].battletag, 'Member#3333');
  } finally { await t.srv.close(); }
});

test('notices: officers post and remove, with audit, Discord and notifications', async () => {
  const t = await setup();
  const { db, s } = t;
  try {
    let r = await t.member.post('/api/announcements', { body: 'Hi' });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'Officers only.');
    r = await t.officer.post('/api/announcements', { body: '  ' });
    assert.equal(r.status, 400);

    r = await t.officer.post('/api/announcements', { body: 'Raid sign-ups open Sunday' });
    assert.equal(r.status, 201);
    assert.equal(r.body.message, 'Notice posted.');
    const id = r.body.announcement.id;
    assert.equal(r.body.announcement.battletag, 'Officer#2222');
    assert.deepEqual(t.discordText(), ['📜 **Notice**\nRaid sign-ups open Sunday']);
    const ev = await eventsFor(t.member);
    assert.equal(ev[0].kind, 'notice');
    assert.equal(ev[0].title, '📜 Guild notice');
    assert.equal(ev[0].body, 'Raid sign-ups open Sunday');
    assert.deepEqual(await eventsFor(t.officer), [], 'the poster is not notified');
    const audit = db.prepare('SELECT action, detail, user_id FROM audit_log ORDER BY id').all();
    assert.deepEqual(audit, [{ action: 'notice posted', detail: 'Raid sign-ups open Sunday', user_id: s.officer.id }]);

    // Capped at 500 characters; the camp shows the newest 5.
    r = await t.owner.post('/api/announcements', { body: 'x'.repeat(600) });
    assert.equal(r.body.announcement.body.length, 500);
    for (let i = 0; i < 5; i++) await t.owner.post('/api/announcements', { body: `n${i}` });
    let camp = (await t.member.get('/api/camp')).body;
    assert.deepEqual(camp.announcements.map((a) => a.body), ['n4', 'n3', 'n2', 'n1', 'n0']);
    assert.equal(camp.announcements[0].canDelete, false);
    assert.equal((await t.owner.get('/api/camp')).body.announcements[0].canDelete, true);

    assert.equal((await t.member.del(`/api/announcements/${id}`)).status, 403);
    r = await t.owner.del(`/api/announcements/${id}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.message, 'Notice removed.');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM announcements WHERE id = ?').get(id).n, 0);
    assert.deepEqual(db.prepare("SELECT action, detail FROM audit_log WHERE action = 'notice deleted'").get(), { action: 'notice deleted', detail: 'Raid sign-ups open Sunday' });
    assert.equal((await t.owner.del(`/api/announcements/${id}`)).status, 404);
    assert.equal((await t.owner.del('/api/announcements/abc')).status, 404);
    camp = (await t.member.get('/api/camp')).body;
    assert.equal(camp.announcements.length, 5);
  } finally { await t.srv.close(); }
});

test('roster lists every character with its player, online first', async () => {
  const t = await setup();
  const { db, s } = t;
  try {
    const scanned = nowSec();
    applyPayload(db, s.guildId, s.member.id, {
      characters: [{ name: 'Mokra', class: 'SHAMAN', level: 58, money: 123456 }],
      roster: { scannedAt: scanned, members: [
        { name: 'Mokra', class: 'SHAMAN', level: 58, rank: 'Member', zone: 'Winterspring', online: false },
        { name: 'Grim', class: 'WARRIOR', level: 60, rank: 'Officer', zone: 'Orgrimmar', online: true },
        { name: 'Zed', class: 'ROGUE', level: 60, rank: 'Member', zone: 'Undercity', online: false },
      ] },
    });
    db.prepare("UPDATE characters SET is_main = 1 WHERE name = 'Mokra'").run();
    const r = await t.owner.get('/api/roster');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.characters.map((c) => c.name), ['Grim', 'Zed', 'Mokra'], 'online first, then by level');
    const mokra = r.body.characters[2];
    assert.equal(mokra.battletag, 'Member#3333');
    assert.equal(mokra.is_main, 1);
    assert.equal(mokra.rank, 'Member');
    assert.equal(mokra.zone, 'Winterspring');
    assert.ok(!('money' in mokra), 'gold is not on the roster');
    assert.equal(r.body.characters[0].battletag, null);
    assert.deepEqual(r.body.counts, { total: 3, online: 1, linked: 1, mains: 1 });
    assert.equal(r.body.scannedAt, new Date(scanned * 1000).toISOString());
  } finally { await t.srv.close(); }
});

test('character page and choosing a main', async () => {
  const t = await setup();
  const { db, s } = t;
  try {
    applyPayload(db, s.guildId, s.member.id, {
      characters: [
        { name: 'Mokra', class: 'SHAMAN', race: 'Tauren', level: 58, zone: 'Winterspring', money: 98765, faction: 'Horde',
          professions: [{ name: 'Herbalism', skill: 150, max: 225 }, { name: 'Alchemy', skill: 250, max: 300 }],
          recipes: { Alchemy: [{ name: 'Major Healing Potion', id: 17556 }, { name: 'Elixir of Fortitude', id: 3450 }] },
          readiness: { ilvl: 52.4, durability: 34, consumables: { flask: 1, potion: 12 } },
          pvp: { rank: 6, rankName: 'Stone Guard', honor: 4500, hk: 300 },
          reputations: [{ name: 'Thunder Bluff', standing: 6, value: 3000, max: 12000 }],
          currencies: [{ id: 1, name: "Merchant's Favor", qty: 12 }] },
        { name: 'Altie', class: 'MAGE', level: 20 },
      ],
    });
    applyPayload(db, s.guildId, s.owner.id, { characters: [{ name: 'Grim', class: 'WARRIOR', level: 60 }] });

    let r = await t.member.get('/api/characters/Mokra');
    assert.equal(r.status, 200);
    const c = r.body.character;
    assert.equal(c.race, 'Tauren');
    assert.equal(c.battletag, 'Member#3333');
    assert.equal(c.money, 98765, 'your own gold is shown');
    assert.deepEqual(c.readiness.consumables, { flask: 1, potion: 12 });
    assert.equal(c.readiness.durability, 34);
    assert.equal(c.extras.pvp.rankName, 'Stone Guard');
    assert.equal(c.extras.reputations[0].name, 'Thunder Bluff');
    assert.equal(c.extras.currencies[0].qty, 12);
    assert.deepEqual(r.body.professions.map((p) => [p.name, p.skill, p.max_skill]), [['Alchemy', 250, 300], ['Herbalism', 150, 225]]);
    assert.deepEqual(r.body.recipes.map((x) => x.name), ['Elixir of Fortitude', 'Major Healing Potion']);
    assert.equal(r.body.recipes[1].recipe_id, 17556);
    assert.deepEqual(r.body.alts.map((a) => a.name), ['Altie']);
    assert.equal(r.body.isMine, true);
    assert.equal(r.body.canMakeMain, true);

    // Someone else's view: no gold, no "make main".
    r = await t.owner.get('/api/characters/mokra');
    assert.equal(r.status, 200, 'names match in any capitalisation');
    assert.equal(r.body.character.name, 'Mokra');
    assert.equal(r.body.character.money, null);
    assert.equal(r.body.isMine, false);
    assert.equal(r.body.canMakeMain, false);

    r = await t.member.get('/api/characters/Nobody');
    assert.equal(r.status, 404);
    assert.equal(r.body.error, "That character isn't on the guild roster yet.");

    // Mains: only your own characters, and only one at a time.
    r = await t.owner.post('/api/characters/Mokra/main');
    assert.equal(r.status, 404);
    assert.equal(r.body.error, "That isn't one of your characters.");
    r = await t.member.post('/api/characters/Mokra/main');
    assert.equal(r.status, 200);
    assert.equal(r.body.message, 'Mokra is now your main.');
    r = await t.member.post('/api/characters/Altie/main');
    assert.equal(r.status, 200);
    const mains = db.prepare('SELECT name FROM characters WHERE is_main = 1').all().map((x) => x.name);
    assert.deepEqual(mains, ['Altie']);
    assert.equal((await t.member.get('/api/characters/Altie')).body.canMakeMain, false);
    // The call to arms is now signed with the main.
    const cta = await t.member.post('/api/ctas', { zone: 'Ashenvale' });
    assert.equal(cta.body.cta.character, 'Altie');
    // And the onboarding step is done.
    const camp = (await t.member.get('/api/camp')).body;
    assert.equal(camp.onboarding.steps.find((x) => x.key === 'main').done, true);
  } finally { await t.srv.close(); }
});

test('crafters: recipe search, professions summary, shopping lists priced from the guild index', async () => {
  const t = await setup();
  const { db, s } = t;
  try {
    applyPayload(db, s.guildId, s.member.id, {
      characters: [
        { name: 'Thrallia', class: 'WARRIOR', level: 30, professions: [{ name: 'Blacksmithing', skill: 120, max: 150 }],
          recipes: { Blacksmithing: [{ name: 'Copper Chain Vest', id: 2661 }, { name: 'Rough Copper Vest', id: 2662 }] },
          inventory: { bags: [{ id: 2589, name: 'Linen Cloth', count: 2 }] } },
        { name: 'Altie', class: 'MAGE', level: 12, inventory: { bank: [{ id: 2589, name: 'Linen Cloth', count: 7 }] } },
      ],
      guildBank: { scannedAt: nowSec(), money: 0, tabs: [{ name: 'Mats', items: [{ id: 2589, name: 'Linen Cloth', count: 20 }] }] },
      prices: { items: [[2589, 12, today()], [2840, 55, today()]] },
      shopping: [{ name: 'Linen Belt', qty: 6, prof: 'Leatherworking', reagents: [{ id: 2589, name: 'Linen Cloth', qty: 1 }, { id: 9999, name: 'Mystery Thread', qty: 2 }] }],
    });
    applyPayload(db, s.guildId, s.owner.id, {
      characters: [{ name: 'Grim', class: 'WARRIOR', level: 60, professions: [{ name: 'Blacksmithing', skill: 300, max: 300 }],
        recipes: { Blacksmithing: [{ name: 'copper chain vest', id: 2661 }, { name: 'Arcanite Reaper', id: 16994 }] } }],
      shopping: [{ name: 'Bronze Tube', qty: 2, reagents: [{ id: 2840, name: 'Copper Bar', qty: 3 }] }],
    });

    // Search: case-insensitive "contains", grouped by recipe, one row per crafter.
    let r = await t.member.get('/api/crafters?q=CHAIN');
    assert.equal(r.status, 200);
    assert.equal(r.body.results.length, 1);
    assert.equal(r.body.results[0].recipeId, 2661);
    assert.equal(r.body.results[0].profession, 'Blacksmithing');
    assert.deepEqual(r.body.results[0].crafters.map((c) => c.name).sort(), ['Grim', 'Thrallia']);
    r = await t.member.get('/api/crafters?q=vest');
    assert.deepEqual(r.body.results.map((x) => x.recipe.toLowerCase()), ['copper chain vest', 'rough copper vest']);
    // LIKE wildcards are matched literally.
    assert.deepEqual((await t.member.get('/api/crafters?q=%25')).body.results, []);
    assert.deepEqual((await t.member.get('/api/crafters?q=_')).body.results, []);

    // Professions summary: highest skill first.
    const bs = r.body.professions.find((p) => p.name === 'Blacksmithing');
    assert.deepEqual(bs.crafters.map((c) => [c.name, c.skill]), [['Grim', 300], ['Thrallia', 120]]);
    assert.equal(bs.count, 2);

    // My shopping list: where my mats are, guild bank stock, prices and a total for the priced mats.
    const shop = r.body.shopping;
    assert.deepEqual(shop.items, [{ name: 'Linen Belt', qty: 6, prof: 'Leatherworking' }]);
    const linen = shop.mats.find((m) => m.id === 2589);
    assert.equal(linen.need, 6);
    assert.deepEqual(linen.chars, [{ name: 'Altie', n: 7 }, { name: 'Thrallia', n: 2 }]);
    assert.equal(linen.guildBank, 20);
    assert.equal(linen.price, 12);
    const thread = shop.mats.find((m) => m.id === 9999);
    assert.equal(thread.need, 12);
    assert.equal(thread.price, null);
    assert.equal(shop.total, 72, '6 × 12c, as on the old Crafters page');
    assert.equal(shop.unpriced, 1);

    // Other members' lists, with totals. Mine is not repeated there.
    assert.deepEqual(r.body.lists.map((l) => l.battletag), ['Owner#1111']);
    assert.equal(r.body.lists[0].total, 2 * 3 * 55);
    assert.equal(r.body.lists[0].main.name, 'Grim');
    assert.equal(r.body.lists[0].mats[0].need, 6);
    const ownerView = (await t.owner.get('/api/crafters')).body;
    assert.deepEqual(ownerView.lists.map((l) => l.battletag), ['Member#3333']);
    assert.deepEqual(ownerView.results, []);
    assert.equal(ownerView.q, '');

    // An emptied list disappears.
    applyPayload(db, s.guildId, s.owner.id, { shopping: [] });
    assert.equal((await t.owner.get('/api/crafters')).body.shopping, null);
    assert.deepEqual((await t.member.get('/api/crafters')).body.lists, []);
  } finally { await t.srv.close(); }
});

test('crafting requests: post, notify crafters, claim, deliver, cancel, with the old rules', async () => {
  const t = await setup();
  const { db, s } = t;
  try {
    applyPayload(db, s.guildId, s.officer.id, {
      characters: [{ name: 'Smithy', class: 'WARRIOR', level: 40, recipes: { Blacksmithing: [{ name: 'Copper Chain Vest', id: 2661 }] } }],
    });
    let r = await t.member.post('/api/requests', { item: ' ' });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'Name the item you need.');

    r = await t.member.post('/api/requests', { item: 'copper chain vest', notes: 'mats in mail' });
    assert.equal(r.status, 201);
    const id = r.body.request.id;
    assert.equal(r.body.request.status, 'open');
    assert.deepEqual(r.body.request.crafters.map((c) => c.name), ['Smithy']);
    assert.equal(r.body.message, 'Request posted. Crafters who know it have been told.');
    assert.deepEqual(t.discordText(), ['🔨 **Crafting request:** copper chain vest (mats in mail), for Member']);
    assert.ok(db.prepare("SELECT 1 FROM activity WHERE text = 'Member asked for copper chain vest'").get());
    // Only the member who can craft it is notified (recipe match ignores case).
    const officerEvents = await eventsFor(t.officer);
    assert.equal(officerEvents.length, 1);
    assert.equal(officerEvents[0].kind, 'request');
    assert.equal(officerEvents[0].title, '🔨 Member needs copper chain vest');
    assert.equal(officerEvents[0].body, 'You can craft it. mats in mail');
    assert.equal(officerEvents[0].route, '/requests');
    assert.deepEqual(await eventsFor(t.owner), []);

    // Nobody can craft it: posted, but nobody is notified.
    r = await t.owner.post('/api/requests', { item: 'Thunderfury' });
    assert.equal(r.body.message, 'Request posted.');
    assert.deepEqual(r.body.request.crafters, []);

    // The list and what each member may do.
    let list = (await t.officer.get('/api/requests')).body;
    let row = list.requests.find((x) => x.id === id);
    assert.equal(row.requester, 'Member#3333');
    assert.equal(row.i_can_craft, true);
    assert.equal(row.canClaim, true);
    assert.equal(row.canCancel, false);
    assert.deepEqual(list.counts, { open: 2, claimed: 0, done: 0 });
    row = (await t.member.get('/api/requests')).body.requests.find((x) => x.id === id);
    assert.equal(row.canClaim, false, 'you cannot claim your own request');
    assert.equal(row.canCancel, true);
    assert.equal(row.mine, true);

    // Claim: not your own; only while open.
    r = await t.member.post(`/api/requests/${id}/claim`);
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'That request has already moved on.');
    r = await t.officer.post(`/api/requests/${id}/claim`);
    assert.equal(r.status, 200);
    assert.equal(r.body.request.status, 'claimed');
    assert.equal(r.body.request.crafter, 'Officer#2222');
    assert.ok(db.prepare("SELECT 1 FROM activity WHERE text = 'Officer is making copper chain vest'").get());
    const memberEvents = await eventsFor(t.member);
    assert.deepEqual(memberEvents.map((e) => e.title), ['🔨 Officer is making copper chain vest']);
    assert.equal((await t.owner.post(`/api/requests/${id}/claim`)).status, 409, 'already claimed');

    // Delivered: only the crafter or the requester.
    assert.equal((await t.owner.post(`/api/requests/${id}/done`)).status, 409);
    r = await t.officer.post(`/api/requests/${id}/done`);
    assert.equal(r.status, 200);
    assert.equal(r.body.request.status, 'done');
    assert.ok(db.prepare("SELECT 1 FROM activity WHERE text = 'copper chain vest delivered'").get());
    assert.deepEqual((await eventsFor(t.member)).map((e) => e.title), ['🔨 Officer is making copper chain vest', '📦 copper chain vest delivered']);
    assert.equal((await t.member.post(`/api/requests/${id}/cancel`)).status, 409, 'delivered requests cannot be cancelled');

    // Cancel: only the requester; cancelled requests leave the board.
    const id2 = (await t.member.post('/api/requests', { item: 'Linen Belt' })).body.request.id;
    assert.equal((await t.owner.post(`/api/requests/${id2}/cancel`)).status, 409);
    r = await t.member.post(`/api/requests/${id2}/cancel`);
    assert.equal(r.status, 200);
    assert.equal(r.body.message, 'Request cancelled.');
    assert.equal((await t.member.post(`/api/requests/${id2}/cancel`)).status, 409);

    // The requester can also mark a claimed request delivered (and is not notified about it).
    const id3 = (await t.member.post('/api/requests', { item: 'Copper Chain Vest' })).body.request.id;
    await t.officer.post(`/api/requests/${id3}/claim`);
    const before = (await eventsFor(t.member)).length;
    assert.equal((await t.member.post(`/api/requests/${id3}/done`)).status, 200);
    assert.equal((await eventsFor(t.member)).length, before);

    // Delivered requests stay for 7 days.
    db.prepare("UPDATE craft_requests SET updated_at = datetime('now','-8 days') WHERE id = ?").run(id);
    list = (await t.member.get('/api/requests')).body;
    assert.ok(!list.requests.some((x) => x.id === id));
    assert.ok(!list.requests.some((x) => x.id === id2));
    assert.deepEqual(list.counts, { open: 1, claimed: 0, done: 1 });

    assert.equal((await t.member.post('/api/requests/999/claim')).status, 404);
    assert.equal((await t.member.post(`/api/requests/${id}/frobnicate`)).status, 404);
    assert.equal((await t.member.post('/api/requests', { item: 'x'.repeat(150), notes: 'n'.repeat(300) })).body.request.item.length, 100);
  } finally { await t.srv.close(); }
});

test('leveling partners: post, replace, expire, remove your own', async () => {
  const t = await setup();
  const { db, s } = t;
  try {
    applyPayload(db, s.guildId, s.member.id, { characters: [{ name: 'Zuljinne', class: 'HUNTER', level: 18 }, { name: 'Altie', level: 9 }] });
    let r = await t.member.post('/api/partners', { zone: 'Stonetalon' });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'Pick the character you are leveling.');

    r = await t.member.post('/api/partners', { character: 'Zuljinne', zone: 'Stonetalon Mountains', when_text: 'Tonight 8pm', note: 'Venture Co. chain' });
    assert.equal(r.status, 201);
    assert.equal(r.body.post.level, 18);
    assert.equal(r.body.post.class, 'HUNTER');
    assert.equal(r.body.post.mine, true);
    assert.ok(db.prepare("SELECT 1 FROM activity WHERE text = 'Zuljinne is looking for leveling partners in Stonetalon Mountains'").get());

    // A new post for the same character replaces the old one.
    r = await t.member.post('/api/partners', { character: 'Zuljinne', zone: 'Desolace', when: 'Saturday' });
    assert.equal(r.body.post.when_text, 'Saturday');
    await t.owner.post('/api/partners', { character: 'Newbie', note: 'anyone?' });
    assert.ok(db.prepare("SELECT 1 FROM activity WHERE text = 'Newbie is looking for leveling partners'").get());

    let list = (await t.owner.get('/api/partners')).body;
    assert.deepEqual(list.posts.map((p) => [p.character, p.zone, p.mine]), [['Newbie', '', true], ['Zuljinne', 'Desolace', false]]);
    assert.equal(list.posts[0].level, null);
    assert.deepEqual((await t.member.get('/api/partners')).body.myCharacters.map((c) => c.name), ['Zuljinne', 'Altie']);

    // Only your own posts can be removed.
    const mine = list.posts.find((p) => p.character === 'Zuljinne').id;
    r = await t.owner.post(`/api/partners/${mine}/close`);
    assert.equal(r.status, 403);
    r = await t.member.post(`/api/partners/${mine}/close`);
    assert.equal(r.status, 200);
    assert.equal(r.body.message, 'Post removed.');
    assert.equal((await t.member.post('/api/partners/9999/close')).status, 404);

    // Posts older than 3 days are hidden.
    db.prepare("UPDATE buddy_posts SET created_at = datetime('now','-4 days') WHERE character = 'Newbie'").run();
    list = (await t.owner.get('/api/partners')).body;
    assert.deepEqual(list.posts, []);
  } finally { await t.srv.close(); }
});
