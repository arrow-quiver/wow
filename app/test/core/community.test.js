'use strict';
// Community domain: Camp dashboard, calls to arms, notices, roster, characters and mains, crafters and
// shopping lists, crafting requests and leveling partners (routes/community.js, services/community.js).
// Every request is "me". Calls to arms, notices, requests, claims and partner posts are shared records
// (docs/SHARING.md §10): the tests check what each action queues and that rows and replies come out as
// before through the projection. Guildmates' records arrive the way an upload brings them in.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startCore, seedGuild, addPlayer, asRole } = require('./helpers');
const { shareKit } = require('./share-kit');
const sharing = require('../../src/core/sharing');
const services = require('../../src/core/services/sync');
const identity = require('../../src/core/identity');

// What POST /api/sync does with an upload, minus HTTP: store it, then my name follows my main character.
function applyPayload(db, guildId, userId, payload) {
  const stats = services.applyPayload(db, guildId, userId, payload);
  identity.refreshMyName(db);
  return stats;
}

const WEBHOOK = 'https://discord.com/api/webhooks/1/abc';
const today = () => Math.floor((Date.now() - Date.UTC(2020, 0, 1)) / 86400000);
const nowSec = () => Math.floor(Date.now() / 1000);

// A core with a fake Discord and the webhook set in Settings; a guild where I have `role` (my character
// is "Mychar"); guildmates Jaina (officer) and Grom (member).
async function setup({ role = 'member', character = 'Mychar' } = {}) {
  const posts = [];
  const fetch = async (url, init) => {
    posts.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 204, json: async () => ({}), text: async () => '' };
  };
  const c = await startCore({ fetch, settings: { discordWebhook: WEBHOOK } });
  const g = seedGuild(c.db, { role, character });
  const jaina = addPlayer(c.db, g.guildId, 'Jaina#2222', { role: 'officer' });
  const grom = addPlayer(c.db, g.guildId, 'Grom#3333', { role: 'member' });
  const kit = shareKit(c);
  const close = async () => { kit.restore(); await c.close(); };
  return { c, db: c.db, g, me: g.me, jaina, grom, api: c.api, posts, kit, close, discordText: () => posts.map((p) => p.body.content) };
}

test('community routes need the guild', async () => {
  const c = await startCore();
  try {
    for (const p of ['/api/camp', '/api/roster', '/api/characters/X', '/api/crafters', '/api/requests', '/api/partners', '/api/activity']) {
      const r = await c.api.get(p);
      assert.equal(r.status, 403, p);
      assert.equal(r.body.code, 'NO_GUILD', p);
    }
    assert.equal((await c.api.post('/api/ctas', { zone: 'X' })).status, 403);
  } finally { await c.close(); }
});

test('camp dashboard: online, calls to arms, notices, activity, raids, realm and onboarding', async () => {
  const t = await setup({ character: null });
  const { db, g, me } = t;
  try {
    const scanned = nowSec();
    applyPayload(db, g.guildId, me, {
      characters: [
        { name: 'Mokra', class: 'SHAMAN', race: 'Tauren', level: 58, zone: 'Winterspring', updated: scanned - 60,
          professions: [{ name: 'Alchemy', skill: 250, max: 300 }] },
        { name: 'Altie', class: 'MAGE', level: 20, zone: 'The Barrens', updated: scanned },
      ],
      roster: { scannedAt: scanned, members: [
        { name: 'Mokra', class: 'SHAMAN', level: 58, rank: 'Member', rankIndex: 4, zone: 'Winterspring', online: true },
        { name: 'Grim', class: 'WARRIOR', level: 60, rank: 'Officer', rankIndex: 1, zone: 'Orgrimmar', online: true },
        { name: 'Sleepy', class: 'PRIEST', level: 60, rank: 'Member', rankIndex: 4, zone: 'Undercity', online: false },
      ] },
    });
    db.prepare("UPDATE characters SET user_id = ? WHERE name = 'Grim'").run(t.jaina.id);
    db.prepare('INSERT INTO sync_log (guild_id, user_id, bytes) VALUES (?,?,100)').run(g.guildId, me);
    db.prepare("INSERT INTO ctas (guild_id, user_id, character, zone, message, needed, created_at) VALUES (?,?,?,?,?,?, datetime('now','-2 days'))")
      .run(g.guildId, t.jaina.id, 'Grim', 'Old fight', '', 5);
    db.prepare('UPDATE guilds SET realm_status = ? WHERE id = ?').run(JSON.stringify({ found: true, name: 'Mirage', up: true, queue: false, checkedAt: new Date().toISOString() }), g.guildId);
    const soon = new Date(Date.now() + 2 * 86400000).toISOString();
    const later = new Date(Date.now() + 5 * 86400000).toISOString();
    const past = new Date(Date.now() - 86400000).toISOString();
    const r1 = Number(db.prepare("INSERT INTO raids (guild_id, title, instance, starts_at) VALUES (?, 'Molten Core', 'Molten Core', ?)").run(g.guildId, soon).lastInsertRowid);
    db.prepare("INSERT INTO raids (guild_id, title, instance, starts_at, kind) VALUES (?, 'Premade', 'Warsong Gulch', ?, 'pvp')").run(g.guildId, later);
    db.prepare("INSERT INTO raids (guild_id, title, instance, starts_at) VALUES (?, 'Old raid', 'Onyxia', ?)").run(g.guildId, past);
    db.prepare('INSERT INTO signups (raid_id, user_id, character, role, status) VALUES (?,?,?,?,?)').run(r1, t.jaina.id, 'Grim', 'tank', 'yes');
    asRole(db, 'member');

    // 2 of 4 done (synced, professions); no main, not signed up. No Discord step any more.
    let camp = (await t.api.get('/api/camp')).body;
    assert.deepEqual(camp.online.map((c) => c.name), ['Grim', 'Mokra'], 'online only, highest level first');
    assert.equal(camp.online[1].battletag, 'Mokra', 'my name is my main character until Battle.net says otherwise');
    assert.equal(camp.online[0].battletag, 'Jaina#2222');
    assert.deepEqual(camp.ctas, [], 'calls older than a day are left out');
    assert.equal(camp.realm.name, 'Mirage');
    assert.equal(camp.rosterScannedAt, new Date(scanned * 1000).toISOString());
    assert.ok(camp.mySync);
    assert.deepEqual(camp.raids.map((r) => r.title), ['Molten Core', 'Premade']);
    assert.equal(camp.raids[0].coming, 1);
    assert.equal(camp.raids[0].mySignup, null);
    assert.deepEqual(camp.onboarding.steps.map((x) => [x.key, x.done]),
      [['synced', true], ['professions', true], ['main', false], ['signup', false]]);
    assert.equal(camp.onboarding.done, 2);
    assert.equal(camp.onboarding.total, 4);
    assert.equal(camp.onboarding.steps.find((x) => x.key === 'main').href, '/characters/Mokra');
    assert.equal(camp.onboarding.steps.find((x) => x.key === 'signup').href, `/raids/${r1}`);
    assert.equal(camp.onboarding.steps.find((x) => x.key === 'signup').label, 'Sign up for Molten Core');
    assert.equal(camp.onboarding.steps[0].href, '/addon');
    assert.equal(camp.me.main.name, 'Mokra');
    assert.equal(camp.me.lastZone, 'The Barrens', 'zone of the character seen most recently');
    assert.equal(camp.isOfficer, false);
    assert.ok(camp.activity.some((a) => a.text === 'Mokra linked their character'));

    // My sign-up shows on the preview; officers see that they are.
    db.prepare('INSERT INTO signups (raid_id, user_id, character, role, status) VALUES (?,?,?,?,?)').run(r1, me, 'Mokra', 'healer', 'yes');
    asRole(db, 'officer');
    camp = (await t.api.get('/api/camp')).body;
    assert.deepEqual(camp.raids[0].mySignup, { status: 'yes', role: 'healer', character: 'Mokra' });
    assert.equal(camp.isOfficer, true);
    assert.equal(camp.onboarding.steps.find((x) => x.key === 'signup').done, true);
  } finally { await t.close(); }
  // With nothing scheduled the raid step is left out.
  const t2 = await setup({ character: null });
  try {
    const c2 = (await t2.api.get('/api/camp')).body;
    assert.deepEqual(c2.onboarding.steps.map((x) => x.key), ['synced', 'professions', 'main']);
    assert.equal(c2.onboarding.steps[2].href, '/roster');
    assert.equal(c2.realm, null);
  } finally { await t2.close(); }
});

test('activity paging', async () => {
  const t = await setup();
  try {
    for (let i = 1; i <= 15; i++) t.c.ctx.activity(t.g.guildId, 'test', `line ${i}`);
    const camp = (await t.api.get('/api/camp')).body;
    assert.equal(camp.activity.length, 12);
    assert.equal(camp.activity[0].text, 'line 15');
    const more = (await t.api.get(`/api/activity?before=${camp.activity[11].id}&limit=10`)).body;
    assert.deepEqual(more.activity.map((a) => a.text), ['line 3', 'line 2', 'line 1', 'Guild Camp set up wow']);
    assert.equal(more.more, false);
    const page = (await t.api.get('/api/activity?limit=5')).body;
    assert.equal(page.activity.length, 5);
    assert.equal(page.more, true);
  } finally { await t.close(); }
});

test('call to arms: a ca record, validation, Discord once the game sends it, no notification for the caller', async () => {
  const t = await setup({ character: null });
  const { db, g, me } = t;
  try {
    let r = await t.api.post('/api/ctas', { zone: 'Tarren Mill' });
    assert.equal(r.status, 409, 'no character yet: nothing to sign it with');
    assert.equal(r.body.error, 'Log in to World of Warcraft on a character in your guild first, then log out or type /reload.');
    applyPayload(db, g.guildId, me, { characters: [{ name: 'Mokra', class: 'SHAMAN', level: 58 }, { name: 'Altie', level: 10 }] });
    r = await t.api.post('/api/ctas', { zone: '   ', message: 'help' });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'Say where the fight is.');

    r = await t.api.post('/api/ctas', { zone: 'Tarren Mill', needed: 99, message: 'Alliance at the flight master' });
    assert.equal(r.status, 201);
    assert.equal(r.body.message, 'Call to arms posted.');
    assert.equal(r.body.cta.needed, 40, 'needed is capped at 40');
    assert.equal(r.body.cta.character, 'Mokra', 'signed with the highest-level character when no main is set');
    assert.equal(r.body.cta.source, 'app');
    const ca = t.kit.last('ca');
    assert.deepEqual([ca.need, ca.base, ca.del, ca.author], [null, '', false, 'Mokra']);
    assert.match(ca.key, /^[0-9a-z]{6}$/);
    assert.deepEqual(ca.fields, { character: 'Mokra', zone: 'Tarren Mill', needed: 40, message: 'Alliance at the flight master' });
    assert.deepEqual(t.posts, [], 'Discord waits until the game sends it');
    assert.deepEqual(t.c.events, [], 'I sounded it: no notification for me');
    t.kit.ack(ca);
    await t.kit.settle();
    assert.deepEqual(t.discordText(), ['⚔️ **Call to arms: Tarren Mill** (need 40)\nAlliance at the flight master\n— Mokra']);
    assert.equal(t.posts[0].url, WEBHOOK);

    // needed is optional; 0 rounds up to 1.
    r = await t.api.post('/api/ctas', { zone: 'Crossroads' });
    assert.equal(r.body.cta.needed, null);
    assert.deepEqual(t.kit.last('ca').fields, { character: 'Mokra', zone: 'Crossroads', needed: null, message: '' });
    r = await t.api.post('/api/ctas', { zone: 'Crossroads', needed: 0 });
    assert.equal(r.body.cta.needed, 1);

    // A long zone and message are cut to 60 and 200 characters.
    r = await t.api.post('/api/ctas', { zone: 'Z'.repeat(80), message: 'm'.repeat(300) });
    assert.equal(r.body.cta.zone.length, 60);
    assert.equal(r.body.cta.message.length, 200);
    assert.equal(t.kit.queued('ca').length, 3, 'each call is its own record (the first one has gone out)');

    // Without a webhook nothing is posted, and it still works.
    t.c.settings.discordWebhook = null;
    assert.equal((await t.api.post('/api/ctas', { zone: 'Ashenvale' })).status, 201);
    t.kit.ack(t.kit.last('ca'));
    await t.kit.settle();
    assert.equal(t.posts.length, 1);

    const camp = (await t.api.get('/api/camp')).body;
    assert.equal(camp.ctas.length, 5);
    assert.equal(camp.ctas[4].zone, 'Tarren Mill');
    assert.equal(camp.ctas[4].class, 'SHAMAN');
    assert.equal(camp.ctas[4].battletag, 'Mokra');

    // A guildmate's call (from in game) shows too, marked as such, and tells me.
    const thrall = t.kit.mate('Thrall', { battletag: 'Thrall#1' });
    t.kit.imp([t.kit.rec('ca', 'th0001', { character: 'Thrall', zone: 'Barrens', needed: 3, message: 'Help' }, { author: 'Thrall', t: t.kit.now() - 30 })]);
    const theirs = (await t.api.get('/api/camp')).body.ctas[0];
    assert.deepEqual([theirs.zone, theirs.source, theirs.user_id, theirs.battletag], ['Barrens', 'addon', thrall.id, 'Thrall#1']);
    assert.deepEqual(t.c.events.map((e) => e.title), ['⚔️ Call to arms: Barrens']);
  } finally { await t.close(); }
});

test('notices: officers post (AN) and remove (its tombstone, any officer), with audit; Discord once the game sends it', async () => {
  const t = await setup({ role: 'member' });
  const { db, me } = t;
  try {
    let r = await t.api.post('/api/announcements', { body: 'Hi' });
    assert.equal(r.status, 403);
    assert.match(r.body.error, /^Only officers can do that\./);
    asRole(db, 'officer');
    r = await t.api.post('/api/announcements', { body: '  ' });
    assert.equal(r.status, 400);

    r = await t.api.post('/api/announcements', { body: 'Raid sign-ups open Sunday' });
    assert.equal(r.status, 201);
    assert.equal(r.body.message, 'Notice posted.');
    const id = r.body.announcement.id;
    assert.equal(r.body.announcement.battletag, 'Mychar');
    assert.equal(r.body.announcement.canDelete, true);
    const an = t.kit.last('AN');
    assert.deepEqual([an.need, an.base, an.del, an.fields], ['o', '', false, { body: 'Raid sign-ups open Sunday' }]);
    assert.deepEqual(t.posts, []);
    assert.deepEqual(t.c.events, [], 'the poster is not notified');
    const audit = db.prepare('SELECT action, detail, user_id FROM audit_log ORDER BY id').all();
    assert.deepEqual(audit, [{ action: 'notice posted', detail: 'Raid sign-ups open Sunday', user_id: me }]);
    t.kit.ack(an);
    await t.kit.settle();
    assert.deepEqual(t.discordText(), ['📜 **Notice**\nRaid sign-ups open Sunday']);

    // Capped at 500 characters; the camp shows the newest 5.
    r = await t.api.post('/api/announcements', { body: 'x'.repeat(600) });
    assert.equal(r.body.announcement.body.length, 500);
    for (let i = 0; i < 5; i++) await t.api.post('/api/announcements', { body: `n${i}` });
    let camp = (await t.api.get('/api/camp')).body;
    assert.deepEqual(camp.announcements.map((a) => a.body), ['n4', 'n3', 'n2', 'n1', 'n0']);
    assert.equal(camp.announcements[0].canDelete, true);
    asRole(db, 'member');
    assert.equal((await t.api.get('/api/camp')).body.announcements[0].canDelete, false);
    assert.equal((await t.api.del(`/api/announcements/${id}`)).status, 403);
    asRole(db, 'owner');
    r = await t.api.del(`/api/announcements/${id}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.message, 'Notice removed.');
    const gone = t.kit.last('AN');
    assert.deepEqual([gone.key, gone.del, gone.need, gone.fields, gone.base], [an.key, true, 'o', null, an.v]);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM announcements WHERE id = ?').get(id).n, 0);
    assert.deepEqual(db.prepare("SELECT action, detail FROM audit_log WHERE action = 'notice deleted'").get(), { action: 'notice deleted', detail: 'Raid sign-ups open Sunday' });
    assert.equal((await t.api.del(`/api/announcements/${id}`)).status, 404);
    assert.equal((await t.api.del('/api/announcements/abc')).status, 404);
    camp = (await t.api.get('/api/camp')).body;
    assert.equal(camp.announcements.length, 5);

    // Any officer may delete another officer's notice.
    t.kit.mate('Jainx', { role: 'officer', battletag: 'Jainx#1' });
    t.kit.imp([t.kit.rec('AN', 'jn0001', { body: 'From Jainx' }, { author: 'Jainx' })]);
    const theirs = (await t.api.get('/api/camp')).body.announcements.find((a) => a.body === 'From Jainx');
    assert.equal(theirs.battletag, 'Jainx#1');
    assert.equal((await t.api.del(`/api/announcements/${theirs.id}`)).status, 200);
    assert.deepEqual([t.kit.last('AN').key, t.kit.last('AN').del], ['jn0001', true]);
    // A notice from before sharing was only on this computer: it just goes.
    const old = Number(db.prepare("INSERT INTO announcements (guild_id, user_id, body) VALUES (?,?, 'Old one')").run(t.g.guildId, me).lastInsertRowid);
    const before = t.kit.queued().length;
    assert.equal((await t.api.del(`/api/announcements/${old}`)).status, 200);
    assert.equal(t.kit.queued().length, before);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM announcements WHERE id = ?').get(old).n, 0);
  } finally { await t.close(); }
});

test('roster lists every character with its player, online first', async () => {
  const t = await setup({ character: null });
  const { db, g } = t;
  try {
    const scanned = nowSec();
    applyPayload(db, g.guildId, t.grom.id, { characters: [{ name: 'Mokra', class: 'SHAMAN', level: 58, money: 123456 }] });
    applyPayload(db, g.guildId, g.me, {
      roster: { scannedAt: scanned, members: [
        { name: 'Mokra', class: 'SHAMAN', level: 58, rank: 'Member', zone: 'Winterspring', online: false },
        { name: 'Grimx', class: 'WARRIOR', level: 60, rank: 'Officer', zone: 'Orgrimmar', online: true },
        { name: 'Zed', class: 'ROGUE', level: 60, rank: 'Member', zone: 'Undercity', online: false },
      ] },
    });
    db.prepare("UPDATE characters SET is_main = 1 WHERE name = 'Mokra'").run();
    const r = await t.api.get('/api/roster');
    assert.equal(r.status, 200);
    const names = r.body.characters.map((c) => c.name);
    assert.deepEqual(names.slice(0, 1), ['Grimx'], 'online first');
    const mokra = r.body.characters.find((c) => c.name === 'Mokra');
    assert.equal(mokra.battletag, 'Grom#3333');
    assert.equal(mokra.is_main, 1);
    assert.equal(mokra.rank, 'Member');
    assert.equal(mokra.zone, 'Winterspring');
    assert.ok(!('money' in mokra), 'gold is not on the roster');
    assert.equal(r.body.characters[0].battletag, null);
    assert.equal(r.body.counts.online, 1);
    assert.equal(r.body.counts.mains, 1);
    assert.equal(r.body.scannedAt, new Date(scanned * 1000).toISOString());
  } finally { await t.close(); }
});

test('character page and choosing a main', async () => {
  const t = await setup({ character: null });
  const { db, g, me } = t;
  try {
    applyPayload(db, g.guildId, me, {
      characters: [
        { name: 'Mokra', class: 'SHAMAN', race: 'Tauren', level: 58, zone: 'Winterspring', money: 98765, faction: 'Horde', guild: 'wow',
          professions: [{ name: 'Herbalism', skill: 150, max: 225 }, { name: 'Alchemy', skill: 250, max: 300 }],
          recipes: { Alchemy: [{ name: 'Major Healing Potion', id: 17556 }, { name: 'Elixir of Fortitude', id: 3450 }] },
          readiness: { ilvl: 52.4, durability: 34, consumables: { flask: 1, potion: 12 } },
          pvp: { rank: 6, rankName: 'Stone Guard', honor: 4500, hk: 300 },
          reputations: [{ name: 'Thunder Bluff', standing: 6, value: 3000, max: 12000 }],
          currencies: [{ id: 1, name: "Merchant's Favor", qty: 12 }] },
        { name: 'Altie', class: 'MAGE', level: 20, guild: 'wow' },
      ],
    });
    applyPayload(db, g.guildId, t.jaina.id, { characters: [{ name: 'Grimz', class: 'WARRIOR', level: 60, money: 5 }] });

    let r = await t.api.get('/api/characters/Mokra');
    assert.equal(r.status, 200);
    const c = r.body.character;
    assert.equal(c.race, 'Tauren');
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

    // Someone else's character: no gold, no "make main".
    r = await t.api.get('/api/characters/grimz');
    assert.equal(r.status, 200, 'names match in any capitalisation');
    assert.equal(r.body.character.name, 'Grimz');
    assert.equal(r.body.character.battletag, 'Jaina#2222');
    assert.equal(r.body.character.money, null);
    assert.equal(r.body.isMine, false);
    assert.equal(r.body.canMakeMain, false);

    r = await t.api.get('/api/characters/Nobody');
    assert.equal(r.status, 404);
    assert.equal(r.body.error, "That character isn't on the guild roster yet.");

    // Mains: only your own characters, and only one at a time.
    r = await t.api.post('/api/characters/Grimz/main');
    assert.equal(r.status, 404);
    assert.equal(r.body.error, "That isn't one of your characters.");
    const outbox = [];
    t.c.core.emitter.on('outbox', () => outbox.push(1));
    r = await t.api.post('/api/characters/Mokra/main');
    assert.equal(r.status, 200);
    assert.equal(r.body.message, 'Mokra is now your main.');
    assert.equal(outbox.length, 1, 'the inbox is rewritten so the addon learns my main');
    assert.equal(sharing.exportMe(db).main, 'Mokra');
    r = await t.api.post('/api/characters/Altie/main');
    assert.equal(r.status, 200);
    const mains = db.prepare('SELECT name FROM characters WHERE is_main = 1 AND user_id = ?').all(me).map((x) => x.name);
    assert.deepEqual(mains, ['Altie']);
    assert.equal((await t.api.get('/api/characters/Altie')).body.canMakeMain, false);
    // The call to arms is now signed with the main, and my name follows it.
    const cta = await t.api.post('/api/ctas', { zone: 'Ashenvale' });
    assert.equal(cta.body.cta.character, 'Altie');
    assert.equal((await t.api.get('/api/me')).body.user.battletag, 'Altie');
    const camp = (await t.api.get('/api/camp')).body;
    assert.equal(camp.onboarding.steps.find((x) => x.key === 'main').done, true);
  } finally { await t.close(); }
});

test('crafters: recipe search, professions summary, shopping lists priced from the guild index', async () => {
  const t = await setup({ character: null });
  const { db, g, me } = t;
  try {
    applyPayload(db, g.guildId, me, {
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
    applyPayload(db, g.guildId, t.jaina.id, {
      characters: [{ name: 'Grimz', class: 'WARRIOR', level: 60, professions: [{ name: 'Blacksmithing', skill: 300, max: 300 }],
        recipes: { Blacksmithing: [{ name: 'copper chain vest', id: 2661 }, { name: 'Arcanite Reaper', id: 16994 }] } }],
      shopping: [{ name: 'Bronze Tube', qty: 2, reagents: [{ id: 2840, name: 'Copper Bar', qty: 3 }] }],
    });

    // Search: case-insensitive "contains", grouped by recipe, one row per crafter.
    let r = await t.api.get('/api/crafters?q=CHAIN');
    assert.equal(r.status, 200);
    assert.equal(r.body.results.length, 1);
    assert.equal(r.body.results[0].recipeId, 2661);
    assert.equal(r.body.results[0].profession, 'Blacksmithing');
    assert.deepEqual(r.body.results[0].crafters.map((c) => c.name).sort(), ['Grimz', 'Thrallia']);
    r = await t.api.get('/api/crafters?q=vest');
    assert.deepEqual(r.body.results.map((x) => x.recipe.toLowerCase()), ['copper chain vest', 'rough copper vest']);
    // LIKE wildcards are matched literally.
    assert.deepEqual((await t.api.get('/api/crafters?q=%25')).body.results, []);
    assert.deepEqual((await t.api.get('/api/crafters?q=_')).body.results, []);

    // Professions summary: highest skill first.
    const bs = r.body.professions.find((p) => p.name === 'Blacksmithing');
    assert.deepEqual(bs.crafters.map((c) => [c.name, c.skill]), [['Grimz', 300], ['Thrallia', 120]]);
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

    // Guildmates' lists, with totals. Mine is not repeated there.
    assert.deepEqual(r.body.lists.map((l) => l.battletag), ['Jaina#2222']);
    assert.equal(r.body.lists[0].total, 2 * 3 * 55);
    assert.equal(r.body.lists[0].main.name, 'Grimz');
    assert.equal(r.body.lists[0].mats[0].need, 6);
    assert.equal((await t.api.get('/api/crafters')).body.q, '');

    // An emptied list disappears.
    applyPayload(db, g.guildId, me, { shopping: [] });
    assert.equal((await t.api.get('/api/crafters')).body.shopping, null);
    applyPayload(db, g.guildId, t.jaina.id, { shopping: [] });
    assert.deepEqual((await t.api.get('/api/crafters')).body.lists, []);
  } finally { await t.close(); }
});

test('crafting requests: cr for the request, cl for claims (never on your own); post, claim, deliver, withdraw, cancel with the old rules', async () => {
  const t = await setup({ character: null });
  const { db, g, me } = t;
  try {
    applyPayload(db, g.guildId, t.jaina.id, {
      characters: [{ name: 'Smithy', class: 'WARRIOR', level: 40, recipes: { Blacksmithing: [{ name: 'Copper Chain Vest', id: 2661 }] } }],
    });
    applyPayload(db, g.guildId, me, { characters: [{ name: 'Mokra', class: 'SHAMAN', level: 58, guild: 'wow' }] });
    let r = await t.api.post('/api/requests', { item: ' ' });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'Name the item you need.');

    r = await t.api.post('/api/requests', { item: 'copper chain vest', notes: 'mats in mail' });
    assert.equal(r.status, 201);
    const id = r.body.request.id;
    assert.equal(r.body.request.status, 'open');
    assert.equal(r.body.request.requester_id, me);
    assert.deepEqual(r.body.request.crafters.map((c) => c.name), ['Smithy']);
    assert.equal(r.body.message, 'Request posted.');
    const cr = t.kit.last('cr');
    const myPid = sharing.myPid(db);
    assert.deepEqual([cr.need, cr.base, cr.del, cr.final], [null, '', false, false]);
    assert.deepEqual(cr.fields, { pid: myPid, item: 'copper chain vest', notes: 'mats in mail', state: 'o' });
    assert.ok(db.prepare("SELECT 1 FROM activity WHERE text = 'Mokra asked for copper chain vest'").get());
    assert.deepEqual(t.c.events, [], 'I asked: no notification for me');
    assert.deepEqual(t.posts, []);
    t.kit.ack(cr);
    await t.kit.settle();
    assert.deepEqual(t.discordText(), ['🔨 **Crafting request:** copper chain vest (mats in mail), for Mokra']);

    r = await t.api.post('/api/requests', { item: 'Thunderfury' });
    assert.equal(r.body.message, 'Request posted.');
    assert.deepEqual(r.body.request.crafters, []);

    // What I may do with my own request.
    let row = (await t.api.get('/api/requests')).body.requests.find((x) => x.id === id);
    assert.equal(row.requester, 'Mokra');
    assert.equal(row.canClaim, false, 'you cannot claim your own request');
    assert.equal(row.canCancel, true);
    assert.equal(row.canWithdraw, false);
    assert.equal(row.mine, true);
    r = await t.api.post(`/api/requests/${id}/claim`);
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'That request has already moved on.');
    assert.deepEqual(t.kit.queued('cl'), [], 'never a claim on my own request');

    // A guildmate's request that I can craft: I'm told (recipe match ignores case), I claim and deliver it.
    applyPayload(db, g.guildId, me, { characters: [{ name: 'Mokra', recipes: { Blacksmithing: [{ name: 'Linen Belt', id: 1 }] } }] });
    const grom = t.kit.mate('Grom', { battletag: 'Grom#3333' });
    t.kit.imp([t.kit.rec('cr', 'gr0001', { pid: grom.pid, item: 'linen belt', notes: '', state: 'o' }, { author: 'Grom' })]);
    assert.deepEqual(t.c.events.map((e) => e.title), ['🔨 Grom needs linen belt']);
    let list = (await t.api.get('/api/requests')).body;
    row = list.requests.find((x) => x.item === 'linen belt');
    const theirs = row.id;
    assert.equal(row.requester_id, grom.id);
    assert.equal(row.i_can_craft, true);
    assert.equal(row.canClaim, true);
    assert.equal(row.canCancel, false);
    assert.deepEqual(list.counts, { open: 3, claimed: 0, done: 0 });
    r = await t.api.post(`/api/requests/${theirs}/claim`);
    assert.equal(r.status, 200);
    assert.equal(r.body.request.status, 'claimed');
    assert.equal(r.body.request.crafter, 'Mokra');
    assert.equal(r.body.request.canWithdraw, true);
    assert.equal(r.body.message, "You're making linen belt.");
    const cl = t.kit.last('cl');
    assert.deepEqual([cl.key, cl.need, cl.fields], [`gr0001:${myPid}`, null, { state: 'c', claimedAt: t.kit.now() }]);
    assert.ok(db.prepare("SELECT 1 FROM activity WHERE text = 'Mokra is making linen belt'").get());
    assert.equal((await t.api.post(`/api/requests/${theirs}/claim`)).status, 409, 'already claimed');
    t.kit.tick(60);
    r = await t.api.post(`/api/requests/${theirs}/done`);
    assert.equal(r.status, 200);
    assert.equal(r.body.request.status, 'done');
    assert.deepEqual(t.kit.last('cl').fields, { state: 'd', claimedAt: cl.fields.claimedAt }, 'done keeps when I claimed it');
    assert.ok(db.prepare("SELECT 1 FROM activity WHERE text = 'linen belt delivered'").get());
    assert.equal(t.c.events.length, 1, 'notifications to Grom are his app\'s business, not mine');

    // Withdrawing as the crafter opens the request again.
    t.kit.imp([t.kit.rec('cr', 'gr0002', { pid: grom.pid, item: 'Linen Bag', state: 'o' }, { author: 'Grom' })]);
    const bag = (await t.api.get('/api/requests')).body.requests.find((x) => x.item === 'Linen Bag').id;
    await t.api.post(`/api/requests/${bag}/claim`);
    r = await t.api.post(`/api/requests/${bag}/withdraw`);
    assert.equal(r.status, 200);
    assert.equal(r.body.message, "You're no longer making Linen Bag.");
    assert.deepEqual([r.body.request.status, r.body.request.crafter_id], ['open', null]);
    assert.equal(t.kit.last('cl').fields.state, 'w');
    assert.equal((await t.api.post(`/api/requests/${bag}/withdraw`)).status, 409);

    // My request claimed by a guildmate: I can mark it delivered myself (cr done, final), or cancel while it is open.
    t.kit.imp([t.kit.rec('cl', `${cr.key}:${grom.pid}`, { state: 'c', claimedAt: t.kit.now() - 30 }, { author: 'Grom' })]);
    row = (await t.api.get('/api/requests')).body.requests.find((x) => x.id === id);
    assert.deepEqual([row.status, row.crafter_id, row.canDone, row.canCancel], ['claimed', grom.id, true, true]);
    assert.deepEqual(t.c.events.map((e) => e.title).at(-1), '🔨 Grom is making copper chain vest', 'I hear about what happens to mine');
    assert.equal((await t.api.post(`/api/requests/${id}/done`)).status, 200);
    const done = t.kit.last('cr');
    assert.deepEqual([done.key, done.final, done.fields.state, done.base], [cr.key, true, 'd', cr.v]);
    assert.equal((await t.api.post(`/api/requests/${id}/cancel`)).status, 409, 'delivered requests cannot be cancelled');
    const id2 = (await t.api.post('/api/requests', { item: 'Linen Shirt' })).body.request.id;
    r = await t.api.post(`/api/requests/${id2}/cancel`);
    assert.equal(r.status, 200);
    assert.equal(r.body.message, 'Request cancelled.');
    assert.deepEqual([t.kit.last('cr').final, t.kit.last('cr').fields.state, t.kit.last('cr').fields.item], [true, 'x', 'Linen Shirt']);
    assert.equal((await t.api.post(`/api/requests/${id2}/cancel`)).status, 409);
    // Someone else's request can't be cancelled by me.
    assert.equal((await t.api.post(`/api/requests/${bag}/cancel`)).status, 409);
    // A request from before sharing can be read but not changed.
    const old = Number(db.prepare("INSERT INTO craft_requests (guild_id, requester_id, item) VALUES (?,?, 'Something')").run(g.guildId, t.grom.id).lastInsertRowid);
    r = await t.api.post(`/api/requests/${old}/claim`);
    assert.deepEqual([r.status, r.body.error], [409, 'This was made with an older Guild Camp and can’t be changed. Make it again.']);

    // Delivered requests stay for 7 days; cancelled ones leave the board at once.
    db.prepare("UPDATE craft_requests SET updated_at = datetime('now','-8 days') WHERE id = ?").run(id);
    list = (await t.api.get('/api/requests')).body;
    assert.ok(!list.requests.some((x) => x.id === id));
    assert.ok(!list.requests.some((x) => x.id === id2));
    assert.deepEqual(list.counts, { open: 3, claimed: 0, done: 1 });

    assert.equal((await t.api.post('/api/requests/999/claim')).status, 404);
    assert.equal((await t.api.post(`/api/requests/${id}/frobnicate`)).status, 404);
    assert.equal((await t.api.post('/api/requests', { item: 'x'.repeat(150), notes: 'n'.repeat(300) })).body.request.item.length, 100);
  } finally { await t.close(); }
});

test('leveling partners: one lp record per player and character; post, replace, expire, remove your own', async () => {
  const t = await setup({ character: null });
  const { db, g, me } = t;
  try {
    applyPayload(db, g.guildId, me, { characters: [{ name: 'Zuljinne', class: 'HUNTER', level: 18, guild: 'wow' }, { name: 'Altie', level: 9, guild: 'wow' }] });
    let r = await t.api.post('/api/partners', { zone: 'Stonetalon' });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'Pick the character you are leveling.');
    r = await t.api.post('/api/partners', { character: 'Zul Jinne' });
    assert.deepEqual([r.status, r.body.error], [400, 'That character name can’t be shared. Pick one of your characters.']);

    r = await t.api.post('/api/partners', { character: 'Zuljinne', zone: 'Stonetalon Mountains', when_text: 'Tonight 8pm', note: 'Venture Co. chain' });
    assert.equal(r.status, 201);
    assert.equal(r.body.post.level, 18);
    assert.equal(r.body.post.class, 'HUNTER');
    assert.equal(r.body.post.mine, true);
    const firstId = r.body.post.id;
    const lp = t.kit.last('lp');
    const key = `${sharing.myPid(db)}:Zuljinne`;
    assert.deepEqual([lp.key, lp.need, lp.del], [key, null, false]);
    assert.deepEqual(lp.fields, { character: 'Zuljinne', level: 18, zone: 'Stonetalon Mountains', when: 'Tonight 8pm', note: 'Venture Co. chain' });
    assert.ok(db.prepare("SELECT 1 FROM activity WHERE text = 'Zuljinne is looking for leveling partners in Stonetalon Mountains'").get());

    // A new post for the same character replaces the old one.
    r = await t.api.post('/api/partners', { character: 'Zuljinne', zone: 'Desolace', when: 'Saturday' });
    assert.equal(r.body.post.when_text, 'Saturday');
    assert.equal(r.body.post.id, firstId, 'the same post, changed');
    assert.deepEqual(t.kit.queued('lp').map((e) => [e.key, e.fields.zone]), [[key, 'Desolace']]);
    const grom = t.kit.mate('Grom', { battletag: 'Grom#3333', alts: ['Newbie'] });
    t.kit.imp([t.kit.rec('lp', `${grom.pid}:Newbie`, { character: 'Newbie', zone: '', note: 'anyone?' }, { author: 'Grom' })]);

    let list = (await t.api.get('/api/partners')).body;
    assert.deepEqual(list.posts.map((p) => [p.character, p.zone, p.mine]), [['Newbie', null, false], ['Zuljinne', 'Desolace', true]]);
    assert.equal(list.posts[0].level, 10, 'the level of their character');
    assert.deepEqual(list.myCharacters.map((c) => c.name), ['Zuljinne', 'Altie']);

    // Only your own posts can be removed; removing sends its tombstone.
    const theirs = list.posts.find((p) => p.character === 'Newbie').id;
    r = await t.api.post(`/api/partners/${theirs}/close`);
    assert.equal(r.status, 403);
    const mine = list.posts.find((p) => p.character === 'Zuljinne').id;
    r = await t.api.post(`/api/partners/${mine}/close`);
    assert.equal(r.status, 200);
    assert.equal(r.body.message, 'Post removed.');
    assert.deepEqual([t.kit.last('lp').key, t.kit.last('lp').del], [key, true]);
    assert.equal((await t.api.post('/api/partners/9999/close')).status, 404);

    // Posts older than 3 days are hidden.
    db.prepare("UPDATE buddy_posts SET created_at = datetime('now','-4 days') WHERE character = 'Newbie'").run();
    list = (await t.api.get('/api/partners')).body;
    assert.deepEqual(list.posts, []);

    // Posting again after closing (or 3 days later) shows the post again, for another 3 days.
    db.prepare("UPDATE buddy_posts SET created_at = datetime('now','-4 days') WHERE id = ?").run(mine);
    t.kit.tick(5);
    r = await t.api.post('/api/partners', { character: 'Zuljinne', zone: 'Feralas' });
    assert.equal(r.body.post.id, mine, 'the same post, back');
    assert.deepEqual((await t.api.get('/api/partners')).body.posts.map((p) => p.zone), ['Feralas']);

    // My posts from before sharing: a new post retires them; closing one just closes it here.
    const old = Number(db.prepare("INSERT INTO buddy_posts (guild_id, user_id, character, zone) VALUES (?,?, 'Altie', 'Mulgore')").run(g.guildId, me).lastInsertRowid);
    const before = t.kit.queued().length;
    assert.equal((await t.api.post(`/api/partners/${old}/close`)).status, 200);
    assert.equal(t.kit.queued().length, before);
    assert.equal(db.prepare('SELECT active FROM buddy_posts WHERE id = ?').get(old).active, 0);
  } finally { await t.close(); }
});

test("leveling partners: a new post replies that it stays up for 3 days, without promising guildmates see it before the game sends it (K6)", async () => {
  const t = await setup({ character: null });
  const { db, g, me } = t;
  try {
    applyPayload(db, g.guildId, me, { characters: [{ name: 'Zuljinne', class: 'HUNTER', level: 18, guild: 'wow' }] });
    const r = await t.api.post('/api/partners', { character: 'Zuljinne', zone: 'Stonetalon Mountains' });
    assert.equal(r.status, 201);
    assert.equal(r.body.message, 'Posted. It stays up for 3 days.');
    assert.doesNotMatch(r.body.message, /can see|have been told|\bnow\b/);
    assert.equal(t.kit.last('lp').fields.zone, 'Stonetalon Mountains', 'it goes out through the game');
  } finally { await t.close(); }
});

test('Y1: a guildmate\'s crafting request tells me "You can craft it" only when a character of mine in the guild knows the recipe, not one in another game guild or in no guild (as "I can craft" on the page)', async () => {
  const t = await setup({ character: null });
  const { db, g, me } = t;
  try {
    const now = nowSec();
    const belt = { Blacksmithing: [{ name: 'Linen Belt', id: 1 }] };
    applyPayload(db, g.guildId, me, { characters: [
      { name: 'Mychar', realm: 'Forever', guild: 'wow', faction: 'Horde', level: 60, updated: now - 600 },
      { name: 'Spyalt', realm: 'Forever', guild: 'Rivals', faction: 'Horde', level: 60, updated: now - 3600, recipes: belt },
      { name: 'Loner', realm: 'Forever', faction: 'Horde', level: 60, updated: now - 3000, recipes: belt },
    ] });
    // Loner saved a second time with no guild: in no guild (identity.notElsewhere).
    applyPayload(db, g.guildId, me, { characters: [{ name: 'Loner', realm: 'Forever', faction: 'Horde', level: 60, updated: now - 2000, recipes: belt }] });
    const grom = t.kit.mate('Grom', { battletag: 'Grom#3333' });
    t.c.events.length = 0;
    t.kit.imp([t.kit.rec('cr', 'gr0001', { pid: grom.pid, item: 'linen belt', notes: '', state: 'o' }, { author: 'Grom' })]);
    const row = (await t.api.get('/api/requests')).body.requests.find((x) => x.item === 'linen belt');
    assert.equal(row.i_can_craft, false);
    assert.deepEqual(t.c.events.map((e) => e.title), [], 'no "You can craft it"');

    // Spyalt joins the guild: the next request tells me.
    applyPayload(db, g.guildId, me, { characters: [{ name: 'Spyalt', realm: 'Forever', guild: 'wow', faction: 'Horde', level: 60, updated: now - 60, recipes: belt }] });
    t.kit.imp([t.kit.rec('cr', 'gr0002', { pid: grom.pid, item: 'linen belt', notes: '', state: 'o' }, { author: 'Grom' })]);
    assert.deepEqual(t.c.events.map((e) => [e.title, e.body]), [['🔨 Grom needs linen belt', 'You can craft it.']]);
  } finally { await t.close(); }
});
