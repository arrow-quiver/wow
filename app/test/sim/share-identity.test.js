'use strict';
// Who I am in game (docs/SHARING.md §3), with the REAL addon on GuildNet: player ids per guild (inbox me.byG,
// WowGuildDB.shared.guilds[g].pid), adopting a pid only when it was made on a character of this account in
// this guild, and my addon overriding at once a ch of mine that someone else relayed. The last test runs the
// real app too (e2e-kit). Nothing here touches a game install, gh or the network.
const test = require('node:test');
const assert = require('node:assert');
const { createGuildNet, makeRecord } = require('./guildnet');
const { createE2E } = require('./e2e-kit');
const { toLua } = require('./wowsim');
const SJ = require('../../src/shared/sharing');

const G = 'Forever/wow';
const R = 'Forever/Rivals';
const recOf = (c, id) => c.lua(`local P = ns.Share._.P(); return P and P.recs[${toLua(id)}]`);
const sentOf = (c, op) => c.lua(`local P = ns.Share._.P(); return P and P.sent[${toLua(op)}]`);
const pidOf = (c) => c.lua('return ns.Share.myPid()');
const send = (c, msg, chan = 'GUILD') => c.lua(`return C_ChatInfo.SendAddonMessage("GuildCamp", ${toLua(msg)}, ${toLua(chan)})`);
const quiet = (c) => { c.lua('if ns.Collect then ns.Collect.sharedRecords = nil; ns.Collect.offerAll = function() end end'); return c; };
const noErrors = (net) => { for (const c of net.clients) assert.deepStrictEqual(c.errors, [], `${c.name} had no Lua errors`); };
const fieldsOf = (str) => (str ? (SJ.decode(str) || {}).fields : null);
const iso = (sec) => new Date(sec * 1000).toISOString();

// ------------------------------------------------------------------------------------- trust-1
test('trust-1: Thrallia is online and Jaina relays a forged ch:Thrallia listing Jaina: Thrallia\'s addon sends her own newer ch at once, every store keeps it, and so do her SavedVariables', () => {
  const net = createGuildNet({ seed: 61 });
  const a = net.client('Thrallia', { rank: 3, inbox: { me: { pid: 'Thrallia.p4m7', main: 'Thrallia', alts: ['Thrallia'] } } }).login();
  const j = net.client('Jaina', { rank: 3, inbox: { me: { pid: 'Jaina.j000' } } }).login();
  const z = net.client('Zuljin', { rank: 3, inbox: { me: { pid: 'Zuljin.a8x2' } } }).login();
  net.run(60);
  assert.deepStrictEqual(fieldsOf(recOf(z, 'ch:Thrallia')).alts, ['Thrallia']);
  const t = Math.floor(net.now());
  const forged = makeRecord({ type: 'ch', key: 'Thrallia', fields: { pid: 'Thrallia.p4m7', main: true, alts: ['Thrallia', 'Jaina'], level: 60 }, t, author: 'Thrallia' });
  send(j, `1R${forged}`);
  net.run(5);
  for (const c of [a, j, z]) {
    const str = recOf(c, 'ch:Thrallia');
    assert.deepStrictEqual(fieldsOf(str).alts, ['Thrallia'], `${c.name} holds Thrallia's own list`);
    assert.ok(SJ.compareRecords(str, forged) > 0, `${c.name}: hers is newer than the forged one`);
  }
  a.logout();
  assert.deepStrictEqual(fieldsOf(a.sv().shared.guilds[G].recs['ch:Thrallia']).alts, ['Thrallia'], 'the forged list never reaches her SavedVariables');
  noErrors(net);
});

// ------------------------------------------------------------------------------------- trust-2
test('trust-2: a fresh install never takes the player id a guildmate forged in a ch of my character; it makes its own, on me, and replaces the forged copy', () => {
  const net = createGuildNet({ seed: 62 });
  const mallory = net.client('Mallory', { rank: 3, inbox: { me: { pid: 'Mallory.m4l1' } } }).login();
  const zul = net.client('Zuljin', { rank: 3, inbox: { me: { pid: 'Zuljin.a8x2' } } }).login();
  const bob = net.client('Bob', { rank: 3 }); // no inbox, no SavedVariables: first install
  net.run(60);
  const forged = makeRecord({ type: 'ch', key: 'Bob', fields: { pid: 'Mallory.m4l1', level: 60 }, t: Math.floor(net.now()) - 10, author: 'Bob' });
  send(mallory, `1R${forged}`);
  net.run(5);
  assert.strictEqual(recOf(zul, 'ch:Bob'), forged, 'stores keep the forged copy (member space, author = key)');
  bob.login();
  net.run(200);
  const pid = pidOf(bob);
  assert.match(pid, /^Bob\.[0-9a-z]{4}$/);
  assert.strictEqual(fieldsOf(recOf(bob, 'ch:Bob')).pid, pid);
  assert.strictEqual(fieldsOf(recOf(zul, 'ch:Bob')).pid, pid, 'his own ch replaces the forged one');
  bob.logout();
  assert.strictEqual(bob.sv().shared.guilds[G].pid, pid, 'saved for the app, with the guild');
  noErrors(net);
});

test('trust-2: a guildmate\'s copy of my alt\'s ch still gives a second PC its id when the id was made on that alt of this account, in this guild', () => {
  const net = createGuildNet({ seed: 66 });
  net.member('Orgalt', { rank: 3 });
  const ch = makeRecord({ type: 'ch', key: 'Orgalt', fields: { pid: 'Orgalt.q1w2', main: true, alts: ['Orgalt', 'Orgrim'] }, t: Math.floor(net.now()) - 3600, author: 'Orgalt' });
  const zul = quiet(net.client('Zuljin', { rank: 3, inbox: { me: { pid: 'Zuljin.a8x2' } } }).login());
  net.run(10);
  zul.lua(`ns.Share._.store("ch:Orgalt", ${toLua(ch)}, "Orgalt", "d")`);
  // Orgalt is a character of this account (played here before); Orgrim is new.
  const o = quiet(net.client('Orgrim', { rank: 3, savedVariables: { characters: { Orgalt: { name: 'Orgalt', realm: 'Forever', guild: 'wow' } } } }).login());
  net.run(120);
  assert.strictEqual(pidOf(o), 'Orgalt.q1w2');
  noErrors(net);
});

// ------------------------------------------------------------------------------------- core-1
test('core-1: alt in another guild: with the app\'s me.byG, Bob in Rivals uses the Rivals id and his sign-up there goes out ok, not wait,link; Grunta in wow keeps the wow id', () => {
  const net = createGuildNet({ seed: 63 });
  const byG = { [G]: { pid: 'Grunta.kzrx', main: 'Grunta', alts: ['Grunta'] }, [R]: { pid: 'Bob.b0b0', main: 'Bob', alts: ['Bob'] } };
  const su = { op: 'o1', g: R, id: 'su:k3f9a2:Bob.b0b0', t: Math.floor(net.now()), base: '', body: SJ.encodeBody('su', 'k3f9a2:Bob.b0b0', { character: 'Bob', role: 'd', status: 'y' }) };
  const inbox = { me: { ...byG[G], g: G, byG }, outbox: [su] };
  const mate = quiet(net.client('Rivalmate', { rank: 3, guild: 'Rivals', inbox: { me: { pid: 'Rivalmate.r1r1' } } }).login());
  const zul = quiet(net.client('Zuljin', { rank: 3, inbox: { me: { pid: 'Zuljin.a8x2' } } }).login());
  const bob = net.client('Bob', { rank: 3, guild: 'Rivals', account: 'GRUNT', inbox }).login();
  net.run(30);
  assert.strictEqual(pidOf(bob), 'Bob.b0b0');
  assert.match(sentOf(bob, 'o1'), /^ok,[0-9a-z]{8},Bob$/);
  assert.ok(recOf(mate, 'su:k3f9a2:Bob.b0b0'));
  assert.deepStrictEqual([fieldsOf(recOf(mate, 'ch:Bob')).pid, fieldsOf(recOf(mate, 'ch:Bob')).alts], ['Bob.b0b0', ['Bob']],
    'his ch names the Rivals id and no character of wow');
  bob.logout();
  const grunta = net.client('Grunta', { rank: 3, account: 'GRUNT' }).login();
  net.run(30);
  assert.strictEqual(pidOf(grunta), 'Grunta.kzrx');
  assert.deepStrictEqual(fieldsOf(recOf(zul, 'ch:Grunta')).alts, ['Grunta'], 'no character of Rivals in the wow ch');
  assert.strictEqual(sentOf(grunta, 'o1'), null, 'the Rivals entry waits silently in wow');
  grunta.logout();
  const saved = grunta.sv().shared.guilds;
  assert.deepStrictEqual([saved[G].pid, saved[R].pid], ['Grunta.kzrx', 'Bob.b0b0']);
  noErrors(net);
});

test('core-1: shared.pid from before ids were per guild moves into the guild whose roster has its anchor; in another guild the addon neither uses it nor adopts an old ch naming it', () => {
  const net = createGuildNet({ seed: 64 });
  // The old addon used one id for the account everywhere, so Bob's ch in Rivals named Grunta's id.
  const old = makeRecord({ type: 'ch', key: 'Bob', fields: { pid: 'Grunta.kzrx', level: 30 }, t: Math.floor(net.now()) - 3600, author: 'Bob' });
  const mate = quiet(net.client('Rivalmate', { rank: 3, guild: 'Rivals', inbox: { me: { pid: 'Rivalmate.r1r1' } } }).login());
  net.run(10);
  mate.lua(`ns.Share._.store("ch:Bob", ${toLua(old)}, "Bob", "d")`);
  const sv = { shared: { v: 1, pid: 'Grunta.kzrx', guilds: {} }, characters: { Grunta: { name: 'Grunta', realm: 'Forever', guild: 'wow' } } };
  const bob = net.client('Bob', { rank: 3, guild: 'Rivals', account: 'GRUNT', savedVariables: sv }).login();
  net.run(30);
  assert.strictEqual(pidOf(bob), null, 'Grunta is not in Rivals: waits for guildmates\' copies first');
  net.run(100);
  const bobPid = pidOf(bob);
  assert.match(bobPid, /^Bob\.[0-9a-z]{4}$/);
  assert.strictEqual(fieldsOf(recOf(mate, 'ch:Bob')).pid, bobPid);
  bob.logout();
  const grunta = quiet(net.client('Grunta', { rank: 3, account: 'GRUNT' }).login());
  net.run(5);
  assert.strictEqual(pidOf(grunta), 'Grunta.kzrx', 'his own guild keeps it, at once');
  grunta.logout();
  const saved = grunta.sv().shared.guilds;
  assert.deepStrictEqual([saved[G].pid, saved[R].pid], ['Grunta.kzrx', bobPid]);
  noErrors(net);
});

test('core-1 end to end: Grunta plays in "wow", then his alt Bob in "Rivals"; Bob signs up for a Rivals raid in the app and it goes out ok under an id made on Bob; wow keeps Grunta\'s id', async (t) => {
  const kit = await createE2E(t, { seed: 65 });
  const { net } = kit;
  const grunt = await kit.player('Grunt', { accounts: { GRUNT: [['Grunta', { rank: 3 }], ['Bob', { rank: 3, guild: 'Rivals' }]] } });
  const rival = await kit.player('Rival', { accounts: { RIVAL: [['Rivalboss', { rank: 0, guild: 'Rivals' }]] } });
  const zul = await kit.player('Zul', { accounts: { ZUL: [['Zuljin', { rank: 3 }]] } });

  // 1. Grunta in wow (no inbox yet: his addon makes the id after the grace period).
  grunt.login('Grunta');
  zul.login('Zuljin');
  net.run(120);
  await grunt.logout('Grunta');
  await zul.logout('Zuljin');
  const wowPid = (await grunt.api('GET', '/api/share/status')).pid;
  assert.match(wowPid, /^Grunta\.[0-9a-z]{4}$/);

  // 2. The Rivals Guild Master schedules a raid; Bob is online in Rivals when it goes out.
  rival.login('Rivalboss');
  net.run(120);
  await rival.logout('Rivalboss');
  const made = await rival.api('POST', '/api/raids', { kind: 'raid', title: 'Rivals Night', instance: 'Molten Core', starts_at: iso(Math.floor(net.now()) + 3 * 86400), size: 40, sr_limit: 2 });
  assert.strictEqual(made.message, 'Raid scheduled.');
  await rival.flush();
  rival.login('Rivalboss');
  grunt.login('Bob');
  net.run(150);
  await grunt.logout('Bob');
  await rival.logout('Rivalboss');

  // Grunt's app now shows Rivals, with an id made on Bob; the inbox keeps wow's id for wow.
  const bobPid = (await grunt.api('GET', '/api/share/status')).pid;
  assert.match(bobPid, /^Bob\.[0-9a-z]{4}$/);
  const me = grunt.inbox().me;
  assert.deepStrictEqual([me.pid, me.g, Object.values(me.alts)], [bobPid, R, ['Bob']]);
  assert.strictEqual(me.byG[G].pid, wowPid);

  // 3. Bob signs up in the app; it goes out at his next login and Rivals' app links it to Bob's id.
  const raids = (await grunt.api('GET', '/api/raids')).upcoming;
  assert.deepStrictEqual(raids.map((r) => r.title), ['Rivals Night']);
  const signed = await grunt.api('POST', `/api/raids/${raids[0].id}/signup`, { character: 'Bob', role: 'healer', status: 'yes' });
  assert.strictEqual(signed.message, 'You’re signed up.');
  await grunt.flush();
  const out = Object.values(grunt.inbox().outbox);
  assert.deepStrictEqual(out.map((e) => [e.g, e.id.replace(/^su:[0-9a-z]{6}:/, 'su:')]), [[R, `su:${bobPid}`]]);
  rival.login('Rivalboss');
  grunt.login('Bob');
  net.run(60);
  await grunt.logout('Bob');
  assert.match(grunt.c('Bob').sv().shared.guilds[R].sent[out[0].op], /^ok,[0-9a-z]{8},Bob$/, 'not wait,link');
  assert.deepStrictEqual((await grunt.api('GET', '/api/share/status')).outbox.map((e) => e.state), ['sent']);
  await rival.logout('Rivalboss');
  const detail = await rival.api('GET', `/api/raids/${made.raid.id}`);
  assert.deepStrictEqual(detail.signups.map((s) => [s.character, s.role, s.status]), [['Bob', 'healer', 'yes']]);

  // 4. Back on Grunta in wow: the wow id, and his ch lists no character of Rivals.
  grunt.login('Grunta');
  zul.login('Zuljin');
  net.run(60);
  assert.strictEqual(pidOf(grunt.c('Grunta')), wowPid);
  assert.deepStrictEqual(fieldsOf(recOf(zul.c('Zuljin'), 'ch:Grunta')).alts, ['Grunta']);
  await grunt.logout('Grunta');
  await zul.logout('Zuljin');
  assert.strictEqual((await grunt.api('GET', '/api/share/status')).pid, wowPid, 'wow is current again, with its own id');
  noErrors(net);
});
