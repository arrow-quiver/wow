'use strict';
// docs/SHARING.md §13 scenarios 1, 2, 3, 4, 10, 11 and 12, played by the real addon (Share.lua, ShareSync.lua,
// ShareCodec.lua and the rest of addon/WowGuild) on simulated guildmates (GuildNet). Every scenario ends with
// net.converged(): equal digests on every online client. Nothing here touches a game install or the network.

const test = require('node:test');
const assert = require('node:assert');
const { createGuildNet, makeRecord, sharedDb } = require('./guildnet');
const { toLua } = require('./wowsim');
const SJ = require('../../src/shared/sharing');

const G = 'Forever/wow';

// Lua helpers run in a client's game.
const recOf = (c, id) => c.lua(`local P = ns.Share._.P(); return P and P.recs[${toLua(id)}]`);
const viaOf = (c, id) => c.lua(`local P = ns.Share._.P(); return P and P.via[${toLua(id)}]`);
const statsOf = (c) => c.lua('return ns.Share._.P().stats');
const send = (c, msg, chan = 'GUILD') => c.lua(`return C_ChatInfo.SendAddonMessage("GuildCamp", ${toLua(msg)}, ${toLua(chan)})`);
const sentBy = (net, name) => net.log.filter((e) => e.from === name);
const records = (net, name) => sentBy(net, name).filter((e) => e.type === '1R' || e.type === '1M');
// The addon's own records (ch, rc …) are real traffic, but some tests count messages: this turns them off.
const quiet = (c) => { c.lua('if ns.Collect then ns.Collect.sharedRecords = nil; ns.Collect.offerAll = function() end end'); return c; };
const noErrors = (net) => { for (const c of net.clients) assert.deepStrictEqual(c.errors, [], `${c.name} had no Lua errors`); };

test('scenario 1: a call to arms reaches a guildmate within 2 s: chat line, sound and store (classic → retail and back)', () => {
  for (const [ia, ib] of [[16001, 120105], [120105, 16001]]) {
    const net = createGuildNet({ seed: 101 + ia });
    const a = net.client('Thrallia', { rank: 3, interface: ia, inbox: { me: { pid: 'Thrallia.p4m7' } } }).login();
    const b = net.client('Zuljin', { rank: 3, interface: ib, inbox: { me: { pid: 'Zuljin.a8x2' } } }).login();
    net.run(60);
    const at = net.now();
    a.lua('SlashCmdList.WOWGUILD("cta Crossroads 5 Alliance at the flight master")');
    assert.ok(a.chat.some((l) => /Call to arms sent to your guild: Crossroads\./.test(l)), a.chat.join('\n'));
    net.run(2);
    const line = b.chatLog.find((e) => e.text.includes('Call to arms from Thrallia in Crossroads, 5 needed: Alliance at the flight master'));
    assert.ok(line, `B's chat: ${b.chat.join(' | ')}`);
    assert.ok(line.t - at <= 2, `arrived after ${line.t - at} s`);
    assert.ok(b.sounds.some((s) => s.id === 8959 && s.t - at <= 2), 'a raid warning sound');
    const ca = b.lua('local list = ns.Share.list("ca"); return list[1]');
    assert.deepStrictEqual([ca.author, ca.fields.zone, ca.fields.needed, ca.fields.message],
      ['Thrallia', 'Crossroads', 5, 'Alliance at the flight master']);
    assert.match(viaOf(b, ca.id), /^Thrallia,\d+,d$/);
    assert.ok(!a.chat.some((l) => l.includes('Call to arms from')), 'no line for my own call');
    net.run(300);
    assert.strictEqual(b.chat.filter((l) => l.includes('Call to arms from')).length, 1, 'one line, however often it arrives');
    assert.ok(net.converged());
    noErrors(net);
  }
});

test('scenario 2: A signs up and logs off; B online; C logs in and gets the sign-up from B (how m)', () => {
  const net = createGuildNet({ seed: 2 });
  const t0 = net.now();
  const id = 'su:k3f9a2:Thrallia.p4m7';
  const body = SJ.encodeBody('su', 'k3f9a2:Thrallia.p4m7', { character: 'Thrallia', role: 'h', status: 'y', note: 'late 10 min' });
  const a = net.client('Thrallia', { rank: 3, inbox: { me: { pid: 'Thrallia.p4m7' }, outbox: [{ op: 'o18', g: G, id, t: t0 - 60, body }] } });
  const b = net.client('Zuljin', { rank: 3, inbox: { me: { pid: 'Zuljin.a8x2' } } });
  const c = net.client('Varok', { rank: 3, interface: 120105, inbox: { me: { pid: 'Varok.7tq3' } } });
  a.login();
  b.login();
  net.run(30);
  assert.match(viaOf(b, id), /^Thrallia,\d+,d$/, 'B took it first-hand');
  a.logout();
  assert.match(a.sv().shared.guilds[G].sent.o18, /^ok,[0-9a-z]{8},Thrallia$/, 'the acknowledgement for the app');
  c.login();
  net.run(90);
  const su = c.lua(`return ns.Share.get(${toLua(id)})`);
  assert.deepStrictEqual([su.author, su.fields.role, su.fields.status, su.fields.note], ['Thrallia', 'h', 'y', 'late 10 min']);
  assert.strictEqual(su.t, t0 - 60, 't is when the player acted in the app');
  assert.match(viaOf(c, id), /^Zuljin,\d+,m$/, 'passed on by a member');
  assert.ok(net.converged());
  noErrors(net);
});

test('scenario 3: an officer schedules and logs off; only members online; a newcomer gets the raid once an officer or a relay rank is online', () => {
  const run = (relay) => {
    const net = createGuildNet({ seed: relay ? 33 : 3 });
    const t0 = net.now();
    const gmCfg = makeRecord({ type: 'CFG', key: '1', fields: { officerRankMax: 1, relayRankMax: relay ? 2 : null }, t: t0 - 86400, author: 'Thrall' });
    const seed = { savedVariables: sharedDb([gmCfg]) };
    const body = SJ.encodeBody('RD', 'k3f9a2', { kind: 'r', title: 'Molten Core Thursday', instance: 'Molten Core', startsAt: t0 + 3 * 86400, minutes: 180, size: 40, srLimit: 2 });
    net.member('Thrall', { rank: 0 });
    const officer = net.client('Grommash', { rank: 1, ...seed, inbox: { me: { pid: 'Grommash.k2k2' }, outbox: [{ op: 'o1', g: G, id: 'RD:k3f9a2', t: t0, need: 'o', body }] } });
    const vet = net.client('Saurfang', { rank: 2, ...seed });
    const member = net.client('Zuljin', { rank: 3, ...seed });
    const newbie = net.client('Varok', { rank: 3, ...seed });
    for (const c of [officer, vet, member]) c.login();
    net.run(40);
    assert.ok(recOf(vet, 'RD:k3f9a2') && recOf(member, 'RD:k3f9a2'), 'members online take it first-hand');
    officer.logout();
    newbie.login();
    net.run(600);
    if (!relay) {
      assert.strictEqual(recOf(newbie, 'RD:k3f9a2'), null, 'members never pass on officer records');
      assert.ok(!net.log.some((e) => e.from !== 'Grommash' && e.type === '1R' && e.text.includes('RD:k3f9a2')), 'nobody sent it');
      assert.strictEqual(net.converged(), false, 'a gap only an officer can fill');
      officer.login();
      net.run(120);
      assert.match(viaOf(newbie, 'RD:k3f9a2'), /^Grommash,\d+,d$/);
    } else {
      assert.match(viaOf(newbie, 'RD:k3f9a2'), /^Saurfang,\d+,t$/, 'a relay rank (CFG relayRankMax 2) passed it on');
    }
    assert.ok(net.converged());
    noErrors(net);
  };
  run(false);
  run(true);
});

test('scenario 4: a patched client fakes officer records first-hand and relayed (refused everywhere) and a member\'s sign-up (stored with via; "Undo it" restores)', () => {
  const net = createGuildNet({ seed: 4 });
  const t0 = net.now();
  const gm = net.client('Thrall', { rank: 0, inbox: { me: { pid: 'Thrall.aaaa' } } });
  const officer = net.client('Grommash', { rank: 1, interface: 120105, inbox: { me: { pid: 'Grommash.k2k2' } } });
  const zul = net.client('Zuljin', { rank: 3, inbox: { me: { pid: 'Zuljin.a8x2' } } });
  const other = net.client('Varok', { rank: 3, interface: 120105 });
  const patch = net.client('Sneaky', { rank: 3 });
  for (const c of [gm, officer, zul, other, patch]) c.login();
  // Zuljin's real sign-up, from his app.
  const suId = 'su:k3f9a2:Zuljin.a8x2';
  const real = { character: 'Zuljin', role: 'd', status: 'y', note: 'ready' };
  zul.setInbox({ me: { pid: 'Zuljin.a8x2' }, outbox: [{ op: 'o1', g: G, id: suId, t: t0, body: SJ.encodeBody('su', 'k3f9a2:Zuljin.a8x2', real) }] });
  zul.reload();
  net.run(60);
  for (const c of [gm, officer, other, patch]) assert.ok(recOf(c, suId), `${c.name} has the real sign-up`);
  const before = statsOf(gm).refused || 0;

  const t = net.now();
  const fakes = [
    makeRecord({ type: 'RT', key: 'k3f9a2', fields: { status: 'x' }, t, author: 'Sneaky' }), // first-hand, not an officer
    makeRecord({ type: 'RT', key: 'k3f9a2', fields: { status: 'x' }, t, author: 'Grommash' }), // relayed by a member
    makeRecord({ type: 'LA', key: 'zz0001', fields: { raid: 'k3f9a2', item: 'd72', character: 'Sneaky', pid: 'Sneaky.bbbb', kind: 's' }, t, author: 'Sneaky' }),
    makeRecord({ type: 'LA', key: 'zz0002', fields: { raid: 'k3f9a2', item: 'd72', character: 'Sneaky', pid: 'Sneaky.bbbb', kind: 's' }, t, author: 'Thrall' }),
    makeRecord({ type: 'CFG', key: '1', fields: { officerRankMax: 3 }, t, author: 'Sneaky' }),
    makeRecord({ type: 'CFG', key: '1', fields: { officerRankMax: 3 }, t, author: 'Thrall' }),
  ];
  for (const f of fakes) send(patch, `1R${f}`);
  // A member record in Zuljin's name: his sign-up turned into "not coming".
  const forged = makeRecord({ type: 'su', key: 'k3f9a2:Zuljin.a8x2', fields: { ...real, status: 'n', note: 'not coming' }, t: t + 1, author: 'Zuljin' });
  send(patch, `1R${forged}`);
  net.run(30);

  for (const c of [gm, officer, zul, other]) {
    assert.strictEqual(recOf(c, 'RT:k3f9a2'), null, `${c.name} refused the fake raid status`);
    assert.strictEqual(recOf(c, 'LA:zz0001'), null);
    assert.strictEqual(recOf(c, 'LA:zz0002'), null);
    assert.strictEqual(recOf(c, 'CFG:1'), null, `${c.name} refused the fake guild settings`);
    assert.strictEqual(recOf(c, suId), forged, `${c.name} stored the forged member record (members' data is not signed)`);
    assert.match(viaOf(c, suId), /^Sneaky,\d+,m$/, 'with who passed it on');
  }
  assert.ok((statsOf(gm).refused || 0) - before >= 6);
  // Rank checks do not depend on the channel: the same fakes on OFFICER (only WH belongs there) are refused too.
  for (const f of fakes) send(patch, `1R${f}`, 'OFFICER');
  net.run(10);
  assert.strictEqual(recOf(gm, 'CFG:1'), null);

  // Zuljin's app flags the change it never made; "Undo it" queues the real version again.
  zul.setInbox({ me: { pid: 'Zuljin.a8x2' }, outbox: [{ op: 'o2', g: G, id: suId, t: net.now(), body: SJ.encodeBody('su', 'k3f9a2:Zuljin.a8x2', real) }] });
  zul.reload();
  net.run(120);
  for (const c of [gm, officer, zul, other, patch]) {
    const su = c.lua(`return ns.Share.get(${toLua(suId)})`);
    assert.deepStrictEqual([su.fields.status, su.fields.note], ['y', 'ready'], `${c.name} has the real sign-up back`);
  }
  assert.ok(net.converged());
  noErrors(net);
});

test('scenario 10: nothing is sent inside an instance or in combat; messages there are ignored; hello after a long stay', () => {
  const net = createGuildNet({ seed: 10 });
  const a = quiet(net.client('Thrallia', { rank: 3, inbox: { me: { pid: 'Thrallia.p4m7' } } }).login());
  const b = quiet(net.client('Zuljin', { rank: 3, interface: 120105, inbox: { me: { pid: 'Zuljin.a8x2' } } }).login());
  net.run(60);
  net.resetStats();

  // A zones into a dungeon and calls to arms from inside: it waits.
  a.setInstance(true, { loading: 3 });
  net.run(4);
  a.lua('SlashCmdList.WOWGUILD("cta Gates 3 waiting outside")');
  assert.ok(a.chat.some((l) => l.includes('Waiting until you leave the dungeon')), a.chat.slice(-2).join(' | '));
  net.run(1);
  b.lua('SlashCmdList.WOWGUILD("cta Crossroads 2 come")'); // reaches A inside: ignored
  net.run(355);
  assert.strictEqual(sentBy(net, 'Thrallia').length, 0, 'not even an attempt inside');
  assert.strictEqual(b.lua('#ns.Share.list("ca")'), 1, 'B only has its own call');
  assert.strictEqual(a.lua('#ns.Share.list("ca")'), 1, 'A ignored B\'s call while inside');
  a.setInstance(false, { loading: 2 });
  net.run(3);
  const out = sentBy(net, 'Thrallia');
  assert.ok(out.length >= 1 && out[0].type === '1R' && out[0].text.includes('waiting outside'), 'the call goes out on leaving');
  assert.ok(out.every((e) => !e.inInstance && !e.loading));
  net.run(60);
  assert.ok(sentBy(net, 'Thrallia').some((e) => e.type === '1H'), 'a hello after more than 5 minutes inside');
  assert.strictEqual(a.lua('#ns.Share.list("ca")'), 2, 'the exchange brought B\'s call');
  assert.ok(net.converged());

  // A short trip (under 5 minutes): no hello afterwards.
  net.run(400);
  net.resetStats();
  a.setInstance(true, { loading: 1 });
  net.run(60);
  a.setInstance(false, { loading: 1 });
  net.run(120);
  assert.ok(!sentBy(net, 'Thrallia').some((e) => e.type === '1H'), 'no hello after a short trip');

  // Combat: nothing goes out until the fight ends, then at once.
  net.resetStats();
  a.setCombat(true);
  a.lua('SlashCmdList.WOWGUILD("cta Hillsbrad 4 fight")');
  net.run(30);
  assert.strictEqual(sentBy(net, 'Thrallia').length, 0, 'nothing in combat');
  a.setCombat(false);
  net.run(1);
  assert.ok(sentBy(net, 'Thrallia').some((e) => e.text.includes('Hillsbrad') && !e.inCombat));
  net.run(5);
  assert.ok(b.chat.some((l) => l.includes('Call to arms from Thrallia in Hillsbrad')));
  assert.strictEqual(net.stats().refused.instance, 0, 'the game never had to refuse a send');
  assert.ok(net.converged());
  noErrors(net);
});

test('scenario 11: an officer demoted between create and relay: old records still spread, new ones are refused', () => {
  const net = createGuildNet({ seed: 11 });
  const t0 = net.now();
  const body = (title) => SJ.encodeBody('RD', 'aaaaaa', { kind: 'e', title, startsAt: t0 + 86400, minutes: 60 });
  const o = net.client('Grommash', { rank: 1, inbox: { me: { pid: 'Grommash.k2k2' }, outbox: [{ op: 'o1', g: G, id: 'RD:aaaaaa', t: t0, need: 'o', body: body('Fishing contest') }] } });
  const o2 = net.client('Saurfang', { rank: 1 });
  const m = net.client('Zuljin', { rank: 3 });
  o.login();
  o2.login();
  m.login();
  net.run(60);
  assert.ok(recOf(o2, 'RD:aaaaaa'));
  o.setRank(3); // demoted
  net.run(20);
  // The demoted officer's app still has an officer change: it now waits.
  o.setInbox({ me: { pid: 'Grommash.k2k2' }, outbox: [{ op: 'o2', g: G, id: 'RD:bbbbbb', t: net.now(), need: 'o', body: body('Second contest') }] });
  o.reload();
  net.run(30);
  assert.strictEqual(recOf(o, 'RD:bbbbbb'), null);
  assert.ok(o.chat.some((l) => l.includes('1 officer change is waiting. Log in on an officer character to send it.')));
  // A patched copy sends it anyway, first-hand: refused by everyone.
  const fresh = makeRecord({ type: 'RD', key: 'bbbbbb', fields: { kind: 'e', title: 'Second contest', startsAt: t0 + 86400, minutes: 60 }, t: net.now(), author: 'Grommash' });
  send(o, `1R${fresh}`);
  net.run(10);
  assert.strictEqual(recOf(o2, 'RD:bbbbbb'), null);
  assert.strictEqual(recOf(m, 'RD:bbbbbb'), null);
  // A newcomer still gets the old raid, passed on by the other officer.
  const c = net.client('Varok', { rank: 3 }).login();
  net.run(120);
  assert.match(viaOf(c, 'RD:aaaaaa'), /^Saurfang,\d+,t$/);
  assert.strictEqual(recOf(c, 'RD:bbbbbb'), null);
  o.logout();
  assert.strictEqual(o.sv().shared.guilds[G].sent.o2, 'wait,officer');
  assert.ok(net.converged());
  noErrors(net);
});

test('scenario 12: expiry, caps and tombstones; a peer back after 60 days brings nothing back', () => {
  const net = createGuildNet({ seed: 12 });
  const t0 = net.now();
  const day = 86400;
  const o = quiet(net.client('Grommash', { rank: 1, inbox: { me: { pid: 'Grommash.k2k2' }, outbox: [
    { op: 'o1', g: G, id: 'AN:nnnnnn', t: t0, need: 'o', body: SJ.encodeBody('AN', 'nnnnnn', { body: 'Raid times change next week' }) },
  ] } }).login());
  const a = quiet(net.client('Zuljin', { rank: 3, inbox: { me: { pid: 'Zuljin.a8x2' } } }).login());
  const z = quiet(net.client('Varok', { rank: 3, inbox: { me: { pid: 'Varok.7tq3' } } }).login());
  net.run(30);
  z.lua('SlashCmdList.WOWGUILD("cta Crossroads 2 old news")');
  net.run(60);
  for (const c of [o, a, z]) assert.ok(recOf(c, 'AN:nnnnnn'), `${c.name} has the notice`);
  assert.strictEqual(a.lua('#ns.Share.list("ca")'), 1);
  z.logout(); // Varok goes away for 60 days, holding the notice and the call to arms

  // The officer deletes the notice: a tombstone.
  o.setInbox({ me: { pid: 'Grommash.k2k2' }, outbox: [{ op: 'o2', g: G, id: 'AN:nnnnnn', t: net.now(), need: 'o', del: true }] });
  o.reload();
  net.run(60);
  assert.strictEqual(a.lua('return ns.Share.get("AN:nnnnnn").del'), true, 'deleted everywhere online');
  a.logout();
  o.logout();
  net.run(59 * day);

  a.login();
  o.login();
  net.run(60);
  assert.strictEqual(a.lua('#ns.Share.list("ca")'), 0, 'calls to arms expire after a day');
  z.login(); // back with a 59-day-old notice (still valid on its own) and a stale call to arms
  quiet(z);
  net.run(300);
  assert.strictEqual(z.lua('return ns.Share.get("AN:nnnnnn").del'), true, 'the tombstone wins over the old notice');
  assert.strictEqual(z.lua('#ns.Share.list("ca")'), 0, 'the old call to arms was pruned, never served');
  for (const c of [o, a]) assert.strictEqual(c.lua('#ns.Share.list("ca")'), 0, `${c.name} got nothing back`);
  assert.ok(net.converged());

  // Past the tombstone's own expiry (the notice's 60 days), it goes too, on every peer in the same hour.
  net.run(2 * day);
  for (const c of [o, a, z]) assert.strictEqual(recOf(c, 'AN:nnnnnn'), null, `${c.name} pruned the tombstone`);
  assert.ok(net.converged());
  noErrors(net);
});

test('scenario 12: the store stays bounded: author caps hold against a flood, store caps drop the oldest prices first', () => {
  const net = createGuildNet({ seed: 1212 });
  const t0 = net.now();
  // B's store already holds 300 records by Sneaky (the per-author cap) and 4,050 price lists.
  const sneaky = [];
  for (let i = 0; i < 300; i++) sneaky.push(makeRecord({ type: 'ca', key: `s${String(i).padStart(5, '0')}`, fields: { character: 'Sneaky', zone: 'Z' }, t: t0 - 60, author: 'Sneaky' }));
  const prices = [];
  for (let i = 0; i < 4050; i++) {
    const name = `P${String(i).padStart(4, '0')}`;
    prices.push(makeRecord({ type: 'pr', key: `${name}.aaaa`, fields: { day: 1, prices: [{ id: 2589, copper: 100 + i }] }, t: t0 - 3 * day(1) + i, author: name }));
  }
  function day(n) { return n * 86400; }
  const b = quiet(net.client('Zuljin', { rank: 3, savedVariables: sharedDb([...sneaky, ...prices]) }).login());
  const p = net.client('Sneaky', { rank: 3 }).login();
  quiet(p);
  const r = quiet(net.client('Relayer', { rank: 3, savedVariables: sharedDb([...sneaky, ...prices]) }).login());
  net.run(30);
  const d = b.lua('return ns.Share._.debug()');
  assert.ok(d.records <= SJ.K.STORE_MAX_RECORDS, `${d.records} records`);
  assert.ok(d.bytes <= SJ.K.STORE_MAX_BYTES);
  assert.strictEqual(recOf(b, `pr:P${'0000'}.aaaa`), null, 'the oldest price list went first');
  assert.ok(recOf(b, `pr:P${'4049'}.aaaa`), 'the newest stayed');
  assert.strictEqual(b.lua('#ns.Share.list("ca")'), 300, 'other records untouched');
  const refused = statsOf(b).refused || 0;
  // trust-3: heard from its author, a record over the author's cap is never refused (the author field of a relayed
  // one proves nothing, so forged ones must not lock the author out); the author's own oldest makes room instead.
  const extra = makeRecord({ type: 'ca', key: 'zzzzzz', fields: { character: 'Sneaky', zone: 'Z' }, t: net.now(), author: 'Sneaky' });
  send(p, `1R${extra}`);
  net.run(5);
  assert.ok(recOf(b, 'ca:zzzzzz'), 'heard from its author: stored');
  assert.strictEqual(b.lua('#ns.Share.list("ca")'), 300, 'the author cap holds: the oldest went');
  assert.strictEqual(statsOf(b).refused || 0, refused);
  // Passed on by someone else in Sneaky's name over the cap: refused (it may only push out relayed ones older than itself).
  const relayed = makeRecord({ type: 'ca', key: 'yyyyyy', fields: { character: 'Sneaky', zone: 'Z' }, t: net.now(), author: 'Sneaky' });
  send(r, `1R${relayed}`);
  net.run(5);
  assert.strictEqual(recOf(b, 'ca:yyyyyy'), null, 'relayed over the author cap: refused');
  assert.strictEqual(statsOf(b).refused, refused + 1);
  noErrors(net);
});
