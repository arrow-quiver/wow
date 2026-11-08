'use strict';
// Who I am (docs/SHARING.md §3): which characters are mine, my player id per guild, and my anchor's ch.
// Only what this computer saw itself makes a character mine (its own uploads, my Battle.net characters, or a
// name I confirmed with "It was me"); a ch any guildmate can relay never does. Player ids are per guild,
// made on a character of mine in that guild.
const test = require('node:test');
const assert = require('node:assert/strict');
const sharing = require('../../src/core/sharing');
const st = require('../../src/core/share/store');
const identity = require('../../src/core/identity');
const { startCore } = require('./helpers');
const { setupShare, NOW, G, PIDS, ME_PID } = require('./sharing-helpers');

const ownerOf = (h, name) => (h.row('SELECT user_id FROM characters WHERE guild_id = ? AND name = ?', h.gid, name) || {}).user_id;
// A payload whose partition carries the addon's own pid for the guild (shared.guilds[g].pid).
const withPartPid = (h, records, pid, opts = {}) => {
  const p = h.payload(records, opts);
  p.guilds[G].pid = pid;
  return p;
};
const post = (h, id, action) => h.srv.api.post(`/api/share/author-checks/${id}`, { action });

// ------------------------------------------------------------------------------------- trust-1
test('trust-1: a guildmate relays a forged ch of my anchor listing her character and makes her ch name my pid: she never becomes mine, my inbox keeps my own alts, and an author check asks', async (t) => {
  const h = await setupShare(t);
  h.imp([h.chFor('Jaina', PIDS.Jaina, { alts: ['Jaina'], main: true, t: NOW - 3000 })]);
  const jainaUser = h.userOf(PIDS.Jaina).id;
  h.imp([h.chFor('Thrallia', ME_PID, { alts: ['Thrallia'], main: true, t: NOW - 2000 })]);

  const forged = h.chFor('Thrallia', ME_PID, { alts: ['Thrallia', 'Jaina'], main: true, t: NOW - 100 });
  const hers = h.chFor('Jaina', ME_PID, { alts: ['Jaina'], main: true, t: NOW - 100 });
  const r = h.imp([forged, hers], { via: { 'ch:Thrallia': `Jaina,${NOW},m`, 'ch:Jaina': `Jaina,${NOW},d` } });
  assert.notEqual(ownerOf(h, 'Jaina'), h.me, 'a shared ch never makes her mine');
  assert.equal(st.isMine(h.db, h.gid, 'Jaina'), false);
  assert.equal(st.isLinked(h.db, h.gid, 'Jaina', ME_PID), false, 'her records in my name are not mine');
  const me = sharing.exportMe(h.db);
  assert.deepEqual([me.pid, me.main, me.alts], [ME_PID, 'Thrallia', ['Thrallia']], 'my addon never signs her as my alt');
  assert.equal(r.checks, 1);
  assert.deepEqual(sharing.status(h.db).authorChecks.map((c) => [c.summary, c.via]),
    [['Character Thrallia lists Jaina as your character', 'Jaina']]);

  // She goes back to her own player id: linked to her player again, never to me.
  h.imp([h.chFor('Jaina', PIDS.Jaina, { alts: ['Jaina'], main: true, t: NOW - 50 })]);
  assert.equal(ownerOf(h, 'Jaina'), jainaUser);
  // My addon re-stamps my anchor with the list the app gave it.
  h.imp([h.chFor('Thrallia', ME_PID, { alts: me.alts, main: true, t: NOW - 10 })]);
  assert.equal(ownerOf(h, 'Jaina'), jainaUser);
  assert.deepEqual(sharing.exportMe(h.db).alts, ['Thrallia']);
  assert.equal(sharing.status(h.db).authorChecks.length, 1, 'my own list asks nothing');
});

test('trust-1: "It was me" on "Character Thrallia lists Zulalt as your character" makes Zulalt mine (my other PC); "Undo it" sends nothing and links nobody', async (t) => {
  const h = await setupShare(t);
  h.imp([h.chFor('Thrallia', ME_PID, { alts: ['Thrallia'], main: true, t: NOW - 2000 })]);
  // My other PC stamps my anchor with its list, and Zulalt's own ch names my pid.
  h.imp([h.chFor('Thrallia', ME_PID, { alts: ['Thrallia', 'Zulalt'], main: true, t: NOW - 100 }), h.chFor('Zulalt', ME_PID, { t: NOW - 100 })],
    { via: { 'ch:Thrallia': `Zulalt,${NOW},m`, 'ch:Zulalt': `Zulalt,${NOW},d` } });
  assert.notEqual(ownerOf(h, 'Zulalt'), h.me, 'not mine before I say so');
  const [check] = sharing.status(h.db).authorChecks;
  assert.equal(check.summary, 'Character Thrallia lists Zulalt as your character');
  const mine = await post(h, check.id, 'mine');
  assert.equal(mine.status, 200, JSON.stringify(mine.body));
  assert.equal(mine.body.message, 'Thanks. Zulalt now counts as yours.');
  assert.equal(ownerOf(h, 'Zulalt'), h.me);
  assert.deepEqual(sharing.exportMe(h.db).alts, ['Thrallia', 'Zulalt'], 'my anchor lists it from now on');
  assert.deepEqual(st.confirmedAlts(h.db, h.gid), ['Zulalt']);

  // A forged list naming Jaina: "Undo it" sends nothing (ch is the addon's) and Jaina stays hers.
  h.imp([h.chFor('Thrallia', ME_PID, { alts: ['Thrallia', 'Zulalt', 'Jaina'], main: true, t: NOW - 50 }), h.chFor('Jaina', ME_PID, { t: NOW - 50 })],
    { via: { 'ch:Thrallia': `Jaina,${NOW},m` } });
  const [again] = sharing.status(h.db).authorChecks;
  assert.equal(again.summary, 'Character Thrallia lists Jaina as your character');
  const undo = await post(h, again.id, 'undo');
  assert.equal(undo.body.message, 'Saved. Log in on Thrallia once to put your own list back.');
  assert.deepEqual(h.outbox(), [], 'nothing queued');
  assert.notEqual(ownerOf(h, 'Jaina'), h.me);
  assert.deepEqual(sharing.exportMe(h.db).alts, ['Thrallia', 'Zulalt']);
  assert.deepEqual(sharing.status(h.db).authorChecks, []);
});

test('trust-1: a Battle.net character of mine that my anchor lists, and whose ch names my pid, is mine without a question', async (t) => {
  const h = await setupShare(t);
  identity.applyIdentity(h.db, { battletag: 'Calvin#1234', characters: [{ name: 'Zulalt', realm: 'Forever', level: 60 }] });
  const r = h.imp([h.chFor('Thrallia', ME_PID, { alts: ['Thrallia', 'Zulalt'], main: true }), h.chFor('Zulalt', ME_PID)]);
  assert.equal(ownerOf(h, 'Zulalt'), h.me);
  assert.equal(r.checks, 0);
});

// ------------------------------------------------------------------------------------- trust-2
test('trust-2: a first upload whose addon took a pid made on a guildmate\'s character, with a forged ch of my character naming it: my pid is made on my own character and she keeps hers', async (t) => {
  const h = await setupShare(t, { pid: null });
  const forged = h.chFor('Thrallia', PIDS.Jaina, { t: NOW - 100 });
  const hers = h.chFor('Jaina', PIDS.Jaina, { alts: ['Jaina', 'Thrallia'], main: true, t: NOW - 100 });
  h.impRaw(withPartPid(h, [forged, hers], PIDS.Jaina, { pid: PIDS.Jaina, via: { 'ch:Thrallia': `Jaina,${NOW},m` } }), { file: { account: 'ACC', install: 'C:/WoW' } });
  const pid = sharing.myPid(h.db);
  assert.match(pid, /^Thrallia\.[0-9a-z]{4}$/);
  assert.equal(ownerOf(h, 'Thrallia'), h.me);
  assert.equal(ownerOf(h, 'Jaina'), h.userOf(PIDS.Jaina).id, 'Jaina stays hers');
  // Her later ch changes nothing: her id is not mine.
  h.imp([h.chFor('Jaina', PIDS.Jaina, { alts: ['Jaina', 'Thrallia'], main: true, t: NOW - 50 })]);
  assert.equal(ownerOf(h, 'Jaina'), h.userOf(PIDS.Jaina).id);
  assert.deepEqual(sharing.exportMe(h.db).alts, [`${pid.split('.')[0]}`]);
});

test('trust-2: second PC still converges: a pid made on my Battle.net character, live in its ch, wins over this addon\'s fresh one', async (t) => {
  const h = await setupShare(t, { pid: null });
  identity.applyIdentity(h.db, { battletag: 'Calvin#1234', characters: [{ name: 'Orgrim', realm: 'Forever', level: 60 }] });
  const fresh = h.chFor('Thrallia', 'Thrallia.n3w1', { alts: ['Thrallia'] }); // this addon's own, made after the grace period
  const other = h.chFor('Orgrim', 'Orgrim.q1w2', { alts: ['Orgrim'], t: NOW - 7200 }); // my other PC's
  h.impRaw(withPartPid(h, [fresh, other], 'Thrallia.n3w1', { via: { 'ch:Orgrim': `Zuljinne,${NOW},m` } }));
  assert.equal(sharing.myPid(h.db), 'Orgrim.q1w2');
  assert.deepEqual(sharing.exportMe(h.db).alts.sort(), ['Orgrim', 'Thrallia']);

  // Without that evidence (Orgrim is not mine here), the addon's own pid is used.
  const k = await setupShare(t, { pid: null });
  k.impRaw(withPartPid(k, [fresh, other], 'Thrallia.n3w1', { via: { 'ch:Orgrim': `Zuljinne,${NOW},m` } }));
  assert.equal(sharing.myPid(k.db), 'Thrallia.n3w1');

  // A relayed ch of my alt naming a made-up id on my main (no ch of the anchor names it) is no other PC's id.
  const m = await setupShare(t, { pid: null });
  m.db.prepare("INSERT INTO characters (guild_id, user_id, name, level) VALUES (?,?, 'Zalt', 10)").run(m.gid, m.me);
  const madeUp = m.chFor('Zalt', 'Thrallia.ev1l', { t: NOW - 60 });
  m.impRaw(withPartPid(m, [fresh, madeUp], 'Thrallia.n3w1', { via: { 'ch:Zalt': `Jaina,${NOW},m` } }));
  assert.equal(sharing.myPid(m.db), 'Thrallia.n3w1');
});

// ------------------------------------------------------------------------------------- core-1 and core-5
async function play(t) {
  const c = await startCore({});
  t.after(() => c.close());
  const now = Math.floor(Date.now() / 1000);
  const sync = async (characters, roster) => {
    const r = await c.api.post('/api/sync', { characters, ...(roster ? { roster } : {}) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  };
  const member = (name) => ({ name, rank: 'Member', rankIndex: 4, level: 60, class: 'WARRIOR', online: true });
  return { c, now, sync, member, guild: (name) => c.db.prepare('SELECT * FROM guilds WHERE game_guild = ?').get(name) };
}

test('core-1: alt in another guild: after Grunta in "wow" and then Bob in "Rivals", Rivals gets its own player id made on Bob, wow keeps Grunta\'s, and a sign-up in Rivals is keyed by Bob\'s id', async (t) => {
  const { c, now, sync, guild } = await play(t);
  const grunta = { name: 'Grunta', realm: 'Forever', guild: 'wow', faction: 'Horde', level: 60, updated: now - 7200 };
  await sync({ Grunta: grunta });
  const a = (await c.api.get('/api/inbox')).body.me;
  assert.match(a.pid, /^Grunta\.[0-9a-z]{4}$/);
  await sync({ Grunta: grunta, Bob: { name: 'Bob', realm: 'Forever', guild: 'Rivals', faction: 'Horde', level: 30, updated: now - 60 } });
  const b = (await c.api.get('/api/inbox')).body;
  assert.equal(b.guild, 'Rivals');
  assert.match(b.me.pid, /^Bob\.[0-9a-z]{4}$/, 'made on a character of this guild');
  assert.deepEqual([b.me.main, b.me.alts, b.me.g], ['Bob', ['Bob'], 'Forever/Rivals']);
  assert.deepEqual(Object.keys(b.me.byG).sort(), ['Forever/Rivals', 'Forever/wow']);
  assert.deepEqual(b.me.byG['Forever/Rivals'], { pid: b.me.pid, main: 'Bob', alts: ['Bob'] });
  assert.deepEqual(b.me.byG['Forever/wow'], { pid: a.pid, main: 'Grunta', alts: ['Grunta'] }, 'wow keeps its id and list');
  assert.equal(st.myPid(c.db, guild('wow').id), a.pid);

  // The sign-up routes key my records with sharing.myPid(db): the current guild's id.
  assert.equal(sharing.myPid(c.db), b.me.pid);
  c.db.transaction(() => sharing.queue(c.db, c.ctx, { type: 'su', key: `k3f9a2:${sharing.myPid(c.db)}`, fields: { character: 'Bob', role: 'd', status: 'y' } }))();
  const out = (await c.api.get('/api/inbox')).body.outbox;
  assert.deepEqual(out.map((e) => [e.g, e.id]), [['Forever/Rivals', `su:k3f9a2:${b.me.pid}`]]);
});

test('core-1: the one player id from before ids were per guild stays in each guild its anchor is in; a guild without it gets its own', async (t) => {
  const { c, now, sync, member, guild } = await play(t);
  const grunta = { name: 'Grunta', realm: 'Forever', guild: 'wow', faction: 'Horde', level: 60, updated: now - 7200 };
  await sync({ Grunta: grunta }, { guild: 'wow', scannedAt: now - 7200, members: [member('Grunta')] });
  await sync({ Grunta: grunta, Bob: { name: 'Bob', realm: 'Forever', guild: 'Rivals', faction: 'Horde', level: 30, updated: now - 60 } },
    { guild: 'Rivals', scannedAt: now - 60, members: [member('Bob')] });
  // A database from before: one 'me_pid', and no character knows its game guild yet.
  c.db.prepare("DELETE FROM app_settings WHERE key LIKE 'me_pid%'").run();
  c.db.prepare("INSERT INTO app_settings (key, value) VALUES ('me_pid', 'Grunta.kzrx')").run();
  c.db.prepare('UPDATE characters SET game_guild = NULL').run();
  assert.equal(st.myPid(c.db, guild('wow').id), 'Grunta.kzrx', 'wow: Grunta is on its roster');
  assert.equal(st.myPid(c.db, guild('Rivals').id), null, 'Rivals: Grunta was only uploaded there');
  assert.match(sharing.myPid(c.db), /^Bob\.[0-9a-z]{4}$/, 'Rivals (current) gets an id made on Bob');
  assert.equal(st.get(c.db, `me_pid:${guild('wow').id}`), 'Grunta.kzrx');
});

test('core-5: a character of mine in another guild on the same realm is not in this guild\'s me (alts, main) and does not count as mine there', async (t) => {
  const { c, now, sync, guild } = await play(t);
  await sync({
    Grunta: { name: 'Grunta', class: 'WARRIOR', level: 60, realm: 'Forever', guild: 'wow', faction: 'Horde', updated: now - 60 },
    Spyalt: { name: 'Spyalt', class: 'ROGUE', level: 60, realm: 'Forever', guild: 'Rivals', faction: 'Horde', updated: now - 3600 },
  });
  const inbox = (await c.api.get('/api/inbox')).body;
  assert.equal(inbox.guild, 'wow');
  assert.deepEqual([inbox.me.main, inbox.me.alts], ['Grunta', ['Grunta']]);
  assert.deepEqual(Object.keys(inbox.me.byG), ['Forever/wow']);
  const gid = guild('wow').id;
  assert.equal(st.isMine(c.db, gid, 'Spyalt'), false);
  assert.equal(st.isMine(c.db, gid, 'Grunta'), true);
  assert.deepEqual(st.myCharacters(c.db, gid), ['Grunta']);
  assert.equal(c.db.prepare("SELECT game_guild FROM characters WHERE guild_id = ? AND name = 'Spyalt'").get(gid).game_guild, 'Rivals');
});

// ------------------------------------------------------------------------------------- D2
test('D2: a character of mine uploaded with no guild counts as mine but is never my main, my author or my player id\'s anchor, and is listed in my alts only once the guild\'s roster has it', async (t) => {
  const { c, now, sync, member, guild } = await play(t);
  const grunta = { name: 'Grunta', class: 'WARRIOR', level: 60, realm: 'Forever', guild: 'wow', faction: 'Horde', updated: now - 3600 };
  // Loner (no guild) is played most recently and was even made my main by hand.
  const loner = { name: 'Loner', class: 'ROGUE', level: 20, realm: 'Forever', faction: 'Horde', updated: now - 60 };
  await sync({ Grunta: grunta, Loner: loner });
  const gid = guild('wow').id;
  c.db.prepare("UPDATE characters SET is_main = 1 WHERE guild_id = ? AND name = 'Loner'").run(gid);
  const me = (await c.api.get('/api/inbox')).body.me;
  assert.match(me.pid, /^Grunta\.[0-9a-z]{4}$/, 'the anchor is a character of the guild');
  assert.deepEqual([me.main, me.alts], ['Grunta', ['Grunta']]);
  assert.equal(st.myAuthor(c.db, gid), 'Grunta');
  assert.equal(st.isMine(c.db, gid, 'Loner'), true, 'still mine: records it wrote are mine');
  assert.equal(st.pidCouldBeMine(c.db, gid, 'Loner.abcd'), false, 'never an anchor');
  // Once the guild's roster lists Loner, it is a character of the guild like any other.
  await sync({ Grunta: grunta, Loner: loner }, { guild: 'wow', scannedAt: now, members: [member('Grunta'), member('Loner')] });
  const after = (await c.api.get('/api/inbox')).body.me;
  assert.deepEqual([after.pid, after.alts.sort()], [me.pid, ['Grunta', 'Loner']]);
});

test('D2: a character of mine in another game guild stays off this guild\'s roster, its counts, the members list and the character pickers', async (t) => {
  const { c, now, sync, guild } = await play(t);
  await sync({
    Grunta: { name: 'Grunta', class: 'WARRIOR', level: 60, realm: 'Forever', guild: 'wow', faction: 'Horde', updated: now - 60 },
    Spyalt: { name: 'Spyalt', class: 'ROGUE', level: 60, realm: 'Forever', guild: 'Rivals', faction: 'Horde', updated: now - 3600 },
    Loner: { name: 'Loner', class: 'MAGE', level: 12, realm: 'Forever', faction: 'Horde', updated: now - 7200 },
  });
  assert.equal(guild('wow').id, (await c.api.get('/api/me')).body.guild.id);
  const roster = (await c.api.get('/api/roster')).body;
  assert.deepEqual(roster.characters.map((x) => x.name).sort(), ['Grunta', 'Loner']);
  assert.equal(roster.counts.total, 2);
  assert.equal(roster.counts.linked, 2);
  const members = (await c.api.get('/api/members')).body.members;
  assert.deepEqual(members.map((m) => m.characters), [2]);
  const page = (await c.api.get('/api/characters/Grunta')).body;
  assert.deepEqual(page.alts.map((a) => a.name), ['Loner']);
  const raidId = Number(c.db.prepare("INSERT INTO raids (guild_id, title, instance, starts_at) VALUES (?, 'MC', 'Molten Core', ?)")
    .run(guild('wow').id, new Date((now + 86400) * 1000).toISOString()).lastInsertRowid);
  const r = await c.api.get(`/api/raids/${raidId}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.myCharacters.map((x) => x.name).sort(), ['Grunta', 'Loner'], 'Spyalt is not offered for a sign-up here');
});

test('D2: a guildless character of mine made my main by hand still never signs my call to arms or my loot in the guild, nor shows as my main on the members page or as my name, while a character of the guild is known', async (t) => {
  const { c, now, sync, guild } = await play(t);
  const S = require('../../src/shared/sharing');
  await sync({
    Grunta: { name: 'Grunta', class: 'WARRIOR', level: 60, realm: 'Forever', guild: 'wow', faction: 'Horde', updated: now - 3600 },
    Loner: { name: 'Loner', class: 'ROGUE', level: 60, realm: 'Forever', faction: 'Horde', updated: now - 60 },
  });
  assert.equal((await c.api.post('/api/characters/Loner/main', {})).status, 200);
  assert.equal((await c.api.post('/api/ctas', { zone: 'Crossroads' })).status, 201);
  const ca = S.decode(c.db.prepare("SELECT record FROM share_outbox WHERE rec_id LIKE 'ca:%'").get().record);
  assert.deepEqual([ca.author, ca.fields.character], ['Grunta', 'Grunta'], 'the guild sees a character of the guild');
  // Loot given to me (no sign-up) goes to my main of the guild.
  const gid = guild('wow').id;
  c.db.prepare("UPDATE memberships SET role = 'officer' WHERE guild_id = ?").run(gid);
  const me = c.db.prepare("SELECT user_id FROM characters WHERE name = 'Grunta'").get().user_id;
  const made = await c.api.post('/api/raids', { title: 'MC', instance: 'Molten Core', starts_at: new Date((now + 3600) * 1000).toISOString(), size: 20, sr_limit: 2, duration_min: 180 });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const raidId = made.body.raid.id;
  const award = await c.api.post(`/api/raids/${raidId}/award`, { item_name: 'Earthshaker', user_id: me, kind: 'ms' });
  assert.equal(award.status, 200, JSON.stringify(award.body));
  assert.equal(c.db.prepare('SELECT character FROM loot_log WHERE raid_id = ?').get(raidId).character, 'Grunta');
  const members = (await c.api.get('/api/members')).body.members;
  assert.equal(members.length, 1);
  assert.equal(JSON.stringify(members[0]).includes('"Loner"'), false, JSON.stringify(members[0]));
  assert.equal(identity.refreshMyName(c.db).battletag, 'Grunta', 'my name without a BattleTag');
  // With no character of the guild known yet, the guildless one is all there is.
  c.db.prepare("UPDATE characters SET game_guild = NULL WHERE name = 'Grunta'").run();
  assert.equal(identity.refreshMyName(c.db).battletag, 'Loner');
});

// ------------------------------------------------------------------------------------- D2 leftovers (crafters, guildless, names)
const tailor = (extra) => ({
  class: 'MAGE', level: 60, realm: 'Forever', faction: 'Horde',
  professions: [{ name: 'Tailoring', skill: 300, max: 300 }], recipes: { Tailoring: [{ name: 'Runecloth Bag', id: 13856 }] }, ...extra,
});
const rosterNames = async (c) => (await c.api.get('/api/roster')).body.characters.map((x) => x.name).sort();

test('Y1: recipes of my character in another game guild are left out of the crafter search, the professions list, who can craft a request, "I can craft" and the inbox crafters', async (t) => {
  const { c, now, sync } = await play(t);
  await sync({
    Grunta: { name: 'Grunta', class: 'WARRIOR', level: 60, realm: 'Forever', guild: 'wow', faction: 'Horde', updated: now - 60 },
    Spyalt: { name: 'Spyalt', ...tailor({ guild: 'Rivals', updated: now - 3600 }) },
  });
  const crafters = (await c.api.get('/api/crafters?q=Runecloth')).body;
  assert.deepEqual(crafters.results, [], 'the search finds no crafter');
  assert.deepEqual(crafters.professions, [], 'nobody in the professions list');
  const made = await c.api.post('/api/requests', { item: 'Runecloth Bag' });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.deepEqual(made.body.request.crafters, [], 'nobody can craft it here');
  const list = (await c.api.get('/api/requests')).body.requests;
  assert.deepEqual([list[0].crafters, list[0].i_can_craft], [[], false]);
  const inbox = (await c.api.get('/api/inbox')).body;
  assert.deepEqual(inbox.crafters, [], 'the game\'s tooltips don\'t list Spyalt either');

  // The same character in the guild counts as a crafter everywhere.
  await sync({ Spyalt: { name: 'Spyalt', ...tailor({ guild: 'wow', updated: now - 30 }) } });
  const again = (await c.api.get('/api/crafters?q=Runecloth')).body;
  assert.deepEqual(again.results.map((r) => r.crafters.map((x) => x.name)), [['Spyalt']]);
  assert.deepEqual(again.professions.map((p) => [p.name, p.count]), [['Tailoring', 1]]);
  const req = (await c.api.get('/api/requests')).body.requests[0];
  assert.deepEqual([req.crafters.map((x) => x.name), req.i_can_craft], [['Spyalt'], true]);
  assert.deepEqual((await c.api.get('/api/inbox')).body.crafters.map((x) => [x.name, x.who]), [['Runecloth Bag', 'Spyalt']]);
});

test('Y7: a character of mine uploaded with no guild stays on the roster after one upload (the game may not have said its guild yet), the same save uploaded again changes nothing, and a second save with no guild takes it off the roster, the alts, the pickers, the counts and the crafters until an upload sees it in the guild', async (t) => {
  const { c, now, sync, guild } = await play(t);
  const grunta = { name: 'Grunta', class: 'WARRIOR', level: 60, realm: 'Forever', guild: 'wow', faction: 'Horde', updated: now - 3600 };
  const loner = (updated, extra = {}) => ({ name: 'Loner', ...tailor({ updated, ...extra }) });
  await sync({ Grunta: grunta, Loner: loner(now - 600) });
  assert.deepEqual(await rosterNames(c), ['Grunta', 'Loner'], 'one upload with no guild: kept');
  // The same saved data again (another character of the account logged out): no new evidence.
  await sync({ Grunta: grunta, Loner: loner(now - 600) });
  assert.deepEqual(await rosterNames(c), ['Grunta', 'Loner']);
  // Loner saved again, still in no guild: in no guild.
  await sync({ Grunta: grunta, Loner: loner(now - 300) });
  const roster = (await c.api.get('/api/roster')).body;
  assert.deepEqual(roster.characters.map((x) => x.name), ['Grunta']);
  assert.deepEqual([roster.counts.total, roster.counts.linked], [1, 1]);
  assert.deepEqual((await c.api.get('/api/characters/Grunta')).body.alts, []);
  assert.deepEqual((await c.api.get('/api/members')).body.members.map((m) => m.characters), [1]);
  const raidId = Number(c.db.prepare("INSERT INTO raids (guild_id, title, instance, starts_at) VALUES (?, 'MC', 'Molten Core', ?)")
    .run(guild('wow').id, new Date((now + 86400) * 1000).toISOString()).lastInsertRowid);
  assert.deepEqual((await c.api.get(`/api/raids/${raidId}`)).body.myCharacters.map((x) => x.name), ['Grunta']);
  assert.deepEqual((await c.api.get('/api/crafters?q=Runecloth')).body.results, []);
  assert.equal(st.isMine(c.db, guild('wow').id, 'Loner'), false, 'not mine in a guild it is not in');
  // It joins the guild: back on every list.
  await sync({ Grunta: grunta, Loner: loner(now - 60, { guild: 'wow' }) });
  assert.deepEqual(await rosterNames(c), ['Grunta', 'Loner']);
  assert.deepEqual((await c.api.get(`/api/raids/${raidId}`)).body.myCharacters.map((x) => x.name).sort(), ['Grunta', 'Loner']);
  // It leaves the guild: one save with no guild keeps it (it may just be the game not saying yet), two take it off.
  await sync({ Grunta: grunta, Loner: loner(now - 50) });
  assert.deepEqual(await rosterNames(c), ['Grunta', 'Loner']);
  await sync({ Grunta: grunta, Loner: loner(now - 40) });
  assert.deepEqual(await rosterNames(c), ['Grunta']);
});

test('Y7: once an upload sees my character in a guild, it leaves the lists of my other guilds on that realm too, also when that upload is from another account and the other guild is not the current one', async (t) => {
  const { c, now, sync, guild } = await play(t);
  // Account 1: Grunta in wow, and Loner before the game said its guild.
  await sync({ Grunta: { name: 'Grunta', class: 'WARRIOR', level: 60, realm: 'Forever', guild: 'wow', faction: 'Horde', updated: now - 7200 }, Loner: { name: 'Loner', ...tailor({ updated: now - 7000 }) } });
  assert.deepEqual(await rosterNames(c), ['Grunta', 'Loner']);
  const wow = guild('wow').id;
  // Loner's own account says it is in Rivals, played last: Rivals is the current guild now.
  await sync({ Loner: { name: 'Loner', ...tailor({ guild: 'Rivals', updated: now - 600 }) } });
  assert.equal((await c.api.get('/api/me')).body.guild.id, guild('Rivals').id);
  assert.equal(c.db.prepare('SELECT game_guild FROM characters WHERE guild_id = ? AND name = ?').get(wow, 'Loner').game_guild, 'Rivals');
  // Back to wow on account 1 (whose upload doesn't have Loner): Loner is not on wow's lists.
  await sync({ Grunta: { name: 'Grunta', class: 'WARRIOR', level: 60, realm: 'Forever', guild: 'wow', faction: 'Horde', updated: now - 60 } });
  assert.equal((await c.api.get('/api/me')).body.guild.id, wow);
  assert.deepEqual(await rosterNames(c), ['Grunta']);
  assert.deepEqual((await c.api.get('/api/crafters?q=Runecloth')).body.results, []);
});

test('Y6: guild names compare the same way in SQL and in JS, also for letters past ASCII: a guild set as "ölwyn" in Guild settings keeps my characters the game puts in "Ölwyn" on its roster, and a later upload finds the same guild and keeps its roster scan', async (t) => {
  const { c, now, sync, member } = await play(t);
  const ole = { name: 'Olaf', class: 'WARRIOR', level: 60, realm: 'Forever', guild: 'Ölwyn', faction: 'Horde', updated: now - 600 };
  await sync({ Olaf: ole });
  const g = c.db.prepare('SELECT * FROM guilds').get();
  c.db.prepare("UPDATE memberships SET role = 'owner' WHERE guild_id = ?").run(g.id);
  const put = await c.api.put('/api/guild/settings', { game_guild: 'ölwyn' });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.deepEqual(await rosterNames(c), ['Olaf']);
  const row = c.db.prepare('SELECT * FROM characters WHERE name = ?').get('Olaf');
  assert.equal(st.placeOf(row, c.db.prepare('SELECT * FROM guilds WHERE id = ?').get(g.id)), 'in', 'JS agrees');
  assert.equal(identity.guildKey('ÖLWYN'), identity.guildKey('ölwyn'));
  // The next upload names the guild as the game does: the same guild, not a new one, and its roster scan is the guild's.
  await sync({ Olaf: { ...ole, updated: now - 60 } }, { guild: 'Ölwyn', scannedAt: now - 30, members: [member('Olaf'), member('Mate')] });
  assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM guilds').get().n, 1);
  assert.deepEqual(await rosterNames(c), ['Mate', 'Olaf']);
});

test('Y7: a guild bank character of mine (an officer marked it as the guild\'s) stays on the roster even when two saves in a row see it in no guild', async (t) => {
  const { c, now, sync, guild } = await play(t);
  const grunta = { name: 'Grunta', class: 'WARRIOR', level: 60, realm: 'Forever', guild: 'wow', faction: 'Horde', updated: now - 3600 };
  const mule = (updated) => ({ name: 'Mule', class: 'MAGE', level: 1, realm: 'Forever', faction: 'Horde', updated });
  await sync({ Grunta: grunta, Mule: mule(now - 600) });
  c.db.prepare('UPDATE characters SET is_bank = 1 WHERE guild_id = ? AND name = ?').run(guild('wow').id, 'Mule');
  await sync({ Grunta: grunta, Mule: mule(now - 300) });
  assert.equal(c.db.prepare('SELECT no_guild FROM characters WHERE name = ?').get('Mule').no_guild, 2);
  assert.deepEqual(await rosterNames(c), ['Grunta', 'Mule']);
  assert.equal(st.isMine(c.db, guild('wow').id, 'Mule'), true);
});

test('Y7: an older save of my character (a second copy of the game\'s files, uploaded again at the next app start) changes nothing: it does not put a character two newer saves saw in no guild back on the roster, nor move one to the guild it was in before', async (t) => {
  const { c, now, sync, guild } = await play(t);
  const grunta = { name: 'Grunta', class: 'WARRIOR', level: 60, realm: 'Forever', guild: 'wow', faction: 'Horde', updated: now - 7200 };
  const altie = (updated, g) => ({ name: 'Altie', class: 'MAGE', level: 60, realm: 'Forever', faction: 'Horde', updated, ...(g ? { guild: g } : {}) });
  await sync({ Grunta: grunta, Altie: altie(now - 7000, 'wow') });
  await sync({ Grunta: grunta, Altie: altie(now - 600) });
  await sync({ Grunta: grunta, Altie: altie(now - 300) });
  assert.deepEqual(await rosterNames(c), ['Grunta'], 'two saves with no guild');
  // The old copy, from when Altie was in the guild, then the current file again (nothing new in it).
  await sync({ Grunta: grunta, Altie: altie(now - 30 * 86400, 'wow') });
  await sync({ Grunta: grunta, Altie: altie(now - 300) });
  assert.deepEqual(await rosterNames(c), ['Grunta']);
  // Altie joins Rivals; an old copy saying "wow" doesn't bring it back to wow's lists.
  await sync({ Grunta: grunta, Altie: altie(now - 200, 'Rivals') });
  await sync({ Grunta: { ...grunta, updated: now - 100 }, Altie: altie(now - 30 * 86400, 'wow') });
  assert.equal((await c.api.get('/api/me')).body.guild.id, guild('wow').id);
  assert.deepEqual(await rosterNames(c), ['Grunta']);
  assert.equal(c.db.prepare('SELECT game_guild FROM characters WHERE guild_id = ? AND name = ?').get(guild('wow').id, 'Altie').game_guild, 'Rivals');
  // A newer save in the guild brings it back.
  await sync({ Grunta: grunta, Altie: altie(now - 50, 'wow') });
  assert.deepEqual(await rosterNames(c), ['Altie', 'Grunta']);
});
