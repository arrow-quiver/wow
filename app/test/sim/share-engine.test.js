'use strict';
// The in-game sharing engine (addon/WowGuild/Share.lua and ShareSync.lua, docs/SHARING.md §5-§9, §11) piece by
// piece: throttle and queues, refused sends, record parts, suppression, the repeat guard, the outbox (compare-and-
// set, wait reasons, acknowledgements, crashes), the roster buffer, the flood guard, names, the re-stamp policy,
// the player id, the seed and the status line. The real addon runs on GuildNet; nothing touches a game install.

const test = require('node:test');
const assert = require('node:assert');
const { createGuildNet, makeRecord, sharedDb } = require('./guildnet');
const { toLua } = require('./wowsim');
const SJ = require('../../src/shared/sharing');

const G = 'Forever/wow';
const recOf = (c, id) => c.lua(`local P = ns.Share._.P(); return P and P.recs[${toLua(id)}]`);
const viaOf = (c, id) => c.lua(`local P = ns.Share._.P(); return P and P.via[${toLua(id)}]`);
const statsOf = (c) => c.lua('return ns.Share._.P().stats');
const sentOf = (c, op) => c.lua(`local P = ns.Share._.P(); return P and P.sent[${toLua(op)}]`);
const debugOf = (c) => c.lua('return ns.Share._.debug()');
const send = (c, msg, chan = 'GUILD') => c.lua(`return C_ChatInfo.SendAddonMessage("GuildCamp", ${toLua(msg)}, ${toLua(chan)})`);
// A message straight into a client's game (no throttle), as if `from` had sent it.
const inject = (c, msg, from, chan = 'GUILD') => { c.wow.receive('GuildCamp', msg, chan, `${from}-Forever`); };
const quiet = (c) => { c.lua('if ns.Collect then ns.Collect.sharedRecords = nil; ns.Collect.offerAll = function() end end'); return c; };
const noErrors = (net) => { for (const c of net.clients) assert.deepStrictEqual(c.errors, [], `${c.name} had no Lua errors`); };
const sentBy = (net, name, type) => net.log.filter((e) => e.from === name && (!type || e.type === type));
// Record ids carried by an R message.
const idsIn = (text) => text.slice(2).split('#').map((r) => r.slice(0, r.indexOf('^')));
// Chat lines start with the addon's coloured "Guild Camp" tag.
const said = (c, text) => c.chat.some((l) => l === text || l.endsWith(`|r ${text}`));
const lastLine = (c) => c.chat[c.chat.length - 1].replace(/^\|c[0-9a-f]{8}Guild Camp\|r /, '');

// ---------------------------------------------------------------------------------------------------------------
// §7 throttle, queues, refused sends
// ---------------------------------------------------------------------------------------------------------------
test('token bucket: 30 records go out 8 at once, then one every 1.25 s; the game never drops one', () => {
  const net = createGuildNet({ seed: 21 });
  const o = quiet(net.client('Grommash', { rank: 1, inbox: { me: { pid: 'Grommash.k2k2' } } }).login());
  const b = quiet(net.client('Zuljin', { rank: 3, interface: 120105 }).login());
  net.run(60);
  net.resetStats();
  o.lua(`for i = 1, 30 do ns.Share.putLocal("AN", string.format("an%04d", i), { body = ${toLua('x'.repeat(180))} .. i }) end`);
  net.run(60);
  const out = sentBy(net, 'Grommash', '1R');
  assert.strictEqual(out.length, 30, 'one notice per message (each is about 215 bytes)');
  const t0 = out[0].t;
  assert.ok(out[7].t - t0 < 0.5, 'the first 8 go at once');
  for (let i = 8; i < out.length; i++) assert.ok(out[i].t - out[i - 1].t >= 1.2, `message ${i + 1} waited for a token`);
  assert.strictEqual(net.stats().dropped.throttle, 0);
  assert.strictEqual(b.lua('#ns.Share.list("AN")'), 30);
  noErrors(net);
});

test('queues: P0 (H, G) before P1 (my new records, a call to arms first) before P3 (re-stamps)', () => {
  const net = createGuildNet({ seed: 22 });
  const o = quiet(net.client('Grommash', { rank: 1, inbox: { me: { pid: 'Grommash.k2k2' } } }).login());
  quiet(net.client('Zuljin', { rank: 3 }).login());
  net.run(60);
  o.setCombat(true);
  net.resetStats();
  o.lua('ns.Share.offer("ch", "Grommash", { pid = "Grommash.k2k2", class = "WARRIOR", level = 60 })'); // P3
  o.lua('ns.Share.putLocal("AN", "aaaaaa", { body = "Raid times change" })'); // P1
  o.lua('ns.Share.putLocal("ca", "cccccc", { character = "Grommash", zone = "Crossroads", needed = 2 })'); // P1, at the front
  o.lua('ns.Share._.enqueue(0, { m = ns.ShareCodec.encodeGet("Zuljin", { "abcd" })[1], chan = "GUILD" })'); // P0
  net.run(5);
  assert.strictEqual(sentBy(net, 'Grommash').length, 0, 'nothing in combat');
  o.setCombat(false);
  net.run(5);
  const out = sentBy(net, 'Grommash');
  assert.deepStrictEqual(out.map((e) => e.type), ['1G', '1R', '1R']);
  assert.deepStrictEqual(idsIn(out[1].text), ['ca:cccccc', 'AN:aaaaaa'], 'my new records, packed, the call to arms first');
  assert.deepStrictEqual(idsIn(out[2].text), ['ch:Grommash']);
  noErrors(net);
});

test('P2 + P3 hold at most 400 entries; the overflow is dropped and counted', () => {
  const net = createGuildNet({ seed: 24 });
  const o = quiet(net.client('Grommash', { rank: 1 }).login());
  net.run(30);
  o.setCombat(true);
  const r = o.lua('local I = ns.Share._; for i = 1, 450 do I.pushRecord(i % 2 + 2, "ch:Nobody") end return { q = I.queued(2) + I.queued(3), dropped = I.P().stats.dropped }');
  assert.deepStrictEqual(r, { q: 400, dropped: 50 });
  o.setCombat(false);
  net.run(5);
  assert.strictEqual(o.lua('ns.Share._.queued()'), 0, 'entries whose record is gone are skipped');
  noErrors(net);
});

for (const iface of [16001, 120105]) {
  test(`a refused send goes back to the head; sending pauses 3 s and refills at half speed for 60 s (${iface === 16001 ? 'boolean' : 'enum'} result, interface ${iface})`, () => {
    const net = createGuildNet({ seed: 23, throttle: { burst: 3, perSecond: 0.25, mode: 'result' } });
    const o = quiet(net.client('Grommash', { rank: 1, interface: iface, inbox: { me: { pid: 'Grommash.k2k2' } } }).login());
    const b = quiet(net.client('Zuljin', { rank: 3, interface: iface === 16001 ? 120105 : 16001 }).login());
    net.run(60);
    net.resetStats();
    o.lua(`for i = 1, 12 do ns.Share.putLocal("AN", string.format("an%04d", i), { body = ${toLua('x'.repeat(180))} .. i }) end`);
    net.run(180);
    const tries = sentBy(net, 'Grommash');
    const refused = tries.filter((e) => e.status === 'refused:throttle');
    assert.ok(refused.length >= 1, 'the game refused some');
    for (const r of refused) {
      const next = tries.find((e) => e.t > r.t);
      assert.ok(!next || next.t - r.t >= 2.95, `after a refusal at ${r.t} the next try waited 3 s (${next && next.t - r.t})`);
    }
    assert.strictEqual(b.lua('#ns.Share.list("AN")'), 12, 'nothing was lost');
    assert.strictEqual(statsOf(o).failed, refused.length);
    // The refused message is the one sent next.
    for (const r of refused) assert.strictEqual(tries.find((e) => e.t > r.t).text, r.text);
    noErrors(net);
  });
}

// ---------------------------------------------------------------------------------------------------------------
// §6 M parts
// ---------------------------------------------------------------------------------------------------------------
function bigRc(key, t, author, n = 500) {
  const list = [];
  let id = 2000;
  for (let i = 0; i < n; i++) { id += 1 + (i % 37); list.push(id); }
  return makeRecord({ type: 'rc', key, fields: { kind: 's', count: n, list }, t, author });
}

test('M parts: parts out of order join; a part missing for 60 s drops the record; a late part starts over', () => {
  const net = createGuildNet({ seed: 25 });
  const b = quiet(net.client('Zuljin', { rank: 3 }).login());
  const p = quiet(net.client('Sneaky', { rank: 3 }).login());
  net.run(30);
  const one = bigRc('Sneaky:4k', net.now(), 'Sneaky');
  const parts = SJ.splitRecord(one, 7);
  assert.strictEqual(parts.length, 3);
  for (const i of [1, 2, 0]) send(p, parts[i]);
  net.run(2);
  assert.strictEqual(recOf(b, 'rc:Sneaky:4k'), one, 'joined from parts 2, 3, 1');
  assert.match(viaOf(b, 'rc:Sneaky:4k'), /^Sneaky,\d+,d$/);

  const two = bigRc('Sneaky:5h', net.now(), 'Sneaky', 520);
  const parts2 = SJ.splitRecord(two, 8);
  send(p, parts2[0]);
  send(p, parts2[2]);
  net.run(30);
  assert.strictEqual(recOf(b, 'rc:Sneaky:5h'), null);
  assert.strictEqual(debugOf(b).partials, 1);
  net.run(31);
  assert.strictEqual(debugOf(b).partials, 0, 'dropped after 60 s');
  assert.strictEqual(statsOf(b).partsLost, 1);
  send(p, parts2[1]);
  net.run(5);
  assert.strictEqual(recOf(b, 'rc:Sneaky:5h'), null, 'the late part alone is not a record');
  noErrors(net);
});

test('M parts: a record whose part was lost on the way arrives through the next exchange', () => {
  let tried = 0;
  for (let seed = 1; seed < 40; seed++) {
    const net = createGuildNet({ seed: 2500 + seed, loss: 0.15 });
    const a = quiet(net.client('Thrallia', { rank: 3 }).login());
    const b = quiet(net.client('Zuljin', { rank: 3 }).login());
    net.runUntil(() => net.converged(), { max: 300 });
    const rec = bigRc('Thrallia:4k', net.now(), 'Thrallia');
    a.lua(`ns.Share.putLocal("rc", "Thrallia:4k", ns.ShareCodec.decode(${toLua(rec)}).fields)`);
    net.run(5);
    if (recOf(b, 'rc:Thrallia:4k')) continue; // every part arrived: try another seed
    tried++;
    assert.ok(net.runUntil(() => !!recOf(b, 'rc:Thrallia:4k'), { max: 1800, step: 5 }), 'fixed by a later exchange');
    assert.ok(net.runUntil(() => net.converged(), { max: 600, step: 5 }));
    noErrors(net);
    if (tried >= 2) break;
  }
  assert.ok(tried >= 1, 'some seed lost a part');
});

// ---------------------------------------------------------------------------------------------------------------
// §8 suppression and the repeat guard
// ---------------------------------------------------------------------------------------------------------------
test('suppression: three guildmates could serve each record; each goes out about once', () => {
  const net = createGuildNet({ seed: 26 });
  const t0 = net.now();
  const recs = [];
  for (let i = 0; i < 80; i++) {
    const who = `Char${String.fromCharCode(97 + (i % 20))}x`;
    recs.push(makeRecord({ type: 'ca', key: `k${String(i).padStart(5, '0')}`, fields: { character: who, zone: 'Crossroads', needed: 1 + (i % 5), message: 'come help' }, t: t0 - 3600 + i, author: who }));
  }
  for (const n of ['Grommash', 'Zuljin', 'Varok']) quiet(net.client(n, { rank: 3, savedVariables: sharedDb(recs) }).login());
  net.run(60);
  net.resetStats();
  const nb = quiet(net.client('Newbie', { rank: 3 }).login());
  assert.ok(net.runUntil(() => net.converged(), { max: 300, step: 5 }));
  const carried = {};
  for (const e of net.log.filter((x) => x.type === '1R' && x.status === 'sent')) for (const id of idsIn(e.text)) carried[id] = (carried[id] || 0) + 1;
  const total = Object.values(carried).reduce((a, n) => a + n, 0);
  assert.strictEqual(Object.keys(carried).length, 80);
  assert.ok(total <= 80 * 1.25, `${total} records sent for 80`);
  assert.strictEqual(nb.lua('#ns.Share.list("ca")'), 80);
  noErrors(net);
});

test('suppression: a G with the same shortIds as one already seen is dropped, whoever it was for', () => {
  const net = createGuildNet({ seed: 27 });
  const a = quiet(net.client('Thrallia', { rank: 3 }).login());
  net.member('Varok', { rank: 3, online: true });
  net.run(30);
  assert.strictEqual(a.lua('return ns.ShareSync.stale({ gkey = "efghabcd" })'), false);
  inject(a, '1GZuljin^efghabcd', 'Varok'); // a request from someone else, to someone else
  net.run(1);
  assert.strictEqual(a.lua('return ns.ShareSync.stale({ gkey = "efghabcd" })'), true, 'my identical request to another server is pointless now');
  noErrors(net);
});

test('repeat guard: a gap nobody online can fix (a member holds officer data, no officer has it) costs one inventory per peer per 2 hours', () => {
  const net = createGuildNet({ seed: 28 });
  const t0 = net.now();
  net.member('Grommash', { rank: 1 }); // the officer who wrote it is offline
  const rd = makeRecord({ type: 'RD', key: 'k3f9a2', fields: { kind: 'r', title: 'Molten Core', instance: 'Molten Core', startsAt: t0 + 86400 * 5, minutes: 180 }, t: t0 - 3600, author: 'Grommash' });
  const m = quiet(net.client('Zuljin', { rank: 3, savedVariables: sharedDb([rd]) }).login());
  const o = quiet(net.client('Saurfang', { rank: 1 }).login());
  const b = SJ.bucket('RD:k3f9a2');
  const invs = (from, until) => net.log.filter((e) => e.from === from && e.type === '1I' && e.status === 'sent' && parseInt(e.text.slice(2, 4), 36) === b && e.t < until);
  const start = net.now();
  // Hellos from both sides, more often than the beacon would.
  for (let i = 0; i < 30; i++) {
    net.run(360);
    (i % 2 ? m : o).lua('ns.ShareSync.sendHello()');
  }
  assert.strictEqual(recOf(o, 'RD:k3f9a2'), null, 'members never pass on officer records');
  assert.ok(invs('Saurfang', start + 7100).length <= 1, 'the officer answered once in the first 2 hours');
  assert.ok(invs('Zuljin', start + 7100).length <= 1, 'the member answered once in the first 2 hours');
  assert.ok(invs('Saurfang', Infinity).length <= 2 && invs('Zuljin', Infinity).length <= 2, 'and once more after 2 hours');
  noErrors(net);
});

// ---------------------------------------------------------------------------------------------------------------
// §9 outbox
// ---------------------------------------------------------------------------------------------------------------
test('compare-and-set: a stale base gives no,stale; an edit of a final record gives no,final; 14 days waiting gives no,expired', () => {
  const net = createGuildNet({ seed: 29 });
  const t0 = net.now();
  const rd1 = makeRecord({ type: 'RD', key: 'aaaaaa', fields: { kind: 'r', title: 'MC', startsAt: t0 + 86400 }, t: t0 - 7200, author: 'Saurfang' });
  const rt1 = makeRecord({ type: 'RT', key: 'aaaaaa', fields: { status: 'l', lockedAt: t0 - 3600 }, t: t0 - 3600, author: 'Saurfang' });
  const rd2 = makeRecord({ type: 'RD', key: 'bbbbbb', fields: { kind: 'r', title: 'BWL', startsAt: t0 + 86400 }, t: t0 - 7200, author: 'Saurfang' });
  const rt2 = makeRecord({ type: 'RT', key: 'bbbbbb', fields: { status: 'x' }, t: t0 - 3600, author: 'Saurfang' });
  const v1 = rt1.split('^')[1];
  const db = sharedDb([rd1, rt1, rd2, rt2]);
  const body = (f) => SJ.encodeBody('RT', 'aaaaaa', f);
  const o = quiet(net.client('Grommash', { rank: 1, savedVariables: db, inbox: { me: { pid: 'Grommash.k2k2' }, outbox: [
    { op: 'o1', g: G, id: 'RT:aaaaaa', t: t0, need: 'o', base: v1, body: body({ status: 'o' }) },
    { op: 'o3', g: G, id: 'AN:cccccc', t: t0, need: 'o', base: 'zzzzzzzz', body: SJ.encodeBody('AN', 'cccccc', { body: 'hi' }) },
    { op: 'o4', g: G, id: 'RT:bbbbbb', t: t0, need: 'o', base: rt2.split('^')[1], body: SJ.encodeBody('RT', 'bbbbbb', { status: 'd', kind: 'r', closedAt: t0 }) },
    { op: 'o5', g: G, id: 'RT:bbbbbb', t: t0, need: 'o', base: rt2.split('^')[1], body: SJ.encodeBody('RT', 'bbbbbb', { status: 'o' }) },
    { op: 'o6', g: G, id: 'AN:dddddd', t: t0 - 15 * 86400, need: 'o', base: '', body: SJ.encodeBody('AN', 'dddddd', { body: 'old' }) },
  ] } }).login());
  net.run(30);
  const ok1 = sentOf(o, 'o1');
  assert.match(ok1, /^ok,[0-9a-z]{8},Grommash$/, 'base matches: sent');
  assert.strictEqual(o.lua('return ns.Share.get("RT:aaaaaa").fields.status'), 'o');
  assert.match(sentOf(o, 'o3'), /^ok,/, 'single-writer types ignore base');
  assert.strictEqual(sentOf(o, 'o4'), 'no,final', 'cancelled raids stay cancelled (earliest final wins)');
  assert.strictEqual(sentOf(o, 'o5'), 'no,final');
  assert.strictEqual(recOf(o, 'RT:bbbbbb'), rt2);
  assert.strictEqual(sentOf(o, 'o6'), 'no,expired');
  // The app edited from v1 again before it heard back about o1 (it replaces an unanswered entry and keeps
  // the first base). The record moved on only through my own change, so this is not stale.
  o.setInbox({ me: { pid: 'Grommash.k2k2' }, outbox: [
    { op: 'o1', g: G, id: 'RT:aaaaaa', t: t0, need: 'o', base: v1, body: body({ status: 'o' }) },
    { op: 'o2', g: G, id: 'RT:aaaaaa', t: net.now(), need: 'o', base: v1, body: body({ status: 'l', lockedAt: net.now() }) },
  ] });
  o.reload();
  net.run(30);
  assert.match(sentOf(o, 'o2'), /^ok,[0-9a-z]{8},Grommash$/, 'an edit over my own earlier change goes out');
  assert.strictEqual(sentOf(o, 'o1'), ok1, 'an acknowledged entry is not sent again');
  assert.strictEqual(o.lua('return ns.Share.get("RT:aaaaaa").fields.status'), 'l');
  // Another officer changes it; an edit from the copy my app had (o2's version) is now stale.
  const v2 = recOf(o, 'RT:aaaaaa').split('^')[1];
  const sau = quiet(net.client('Saurfang', { rank: 1 }).login());
  net.run(20);
  sau.lua(`ns.Share.putLocal("RT", "aaaaaa", { status = "o" })`);
  net.run(10);
  assert.strictEqual(o.lua('return ns.Share.get("RT:aaaaaa").author'), 'Saurfang');
  o.setInbox({ me: { pid: 'Grommash.k2k2' }, outbox: [
    { op: 'o7', g: G, id: 'RT:aaaaaa', t: net.now(), need: 'o', base: v2, body: body({ status: 'l', lockedAt: net.now() }) },
  ] });
  o.reload();
  net.run(30);
  assert.strictEqual(sentOf(o, 'o7'), 'no,stale');
  assert.strictEqual(o.lua('return ns.Share.get("RT:aaaaaa").fields.status'), 'o');
  // Entries the app dropped are forgotten.
  o.setInbox({ me: { pid: 'Grommash.k2k2' }, outbox: [] });
  o.reload();
  net.run(10);
  assert.deepStrictEqual(o.lua('local n = 0; for _ in pairs(ns.Share._.P().sent) do n = n + 1 end return n'), 0);
  noErrors(net);
});

test('outbox wait reasons: wait,officer and wait,gm with the login line; wait,link until the anchor lists the alt; another guild waits silently', () => {
  const net = createGuildNet({ seed: 30 });
  const t0 = net.now();
  const an = (k) => ({ op: `o${k}`, g: G, id: `AN:${k}aaaaa`, t: t0, need: 'o', base: '', body: SJ.encodeBody('AN', `${k}aaaaa`, { body: 'notice' }) });
  const m = net.client('Varok', { rank: 3, inbox: { me: { pid: 'Varok.7tq3' }, outbox: [an('1'), an('2'),
    { op: 'o3', g: 'Forever/other', id: 'AN:3aaaaa', t: t0, need: 'o', base: '', body: SJ.encodeBody('AN', '3aaaaa', { body: 'elsewhere' }) }] } }).login();
  net.run(20);
  assert.strictEqual(sentOf(m, 'o1'), 'wait,officer');
  assert.strictEqual(sentOf(m, 'o2'), 'wait,officer');
  assert.strictEqual(sentOf(m, 'o3'), null, 'another guild\'s entry waits silently');
  assert.ok(said(m, '2 officer changes are waiting. Log in on an officer character to send them.'), m.chat.join(' | '));

  const o = net.client('Grommash', { rank: 1, inbox: { me: { pid: 'Grommash.k2k2' }, outbox: [
    { op: 'o4', g: G, id: 'CFG:1', t: t0, need: 'g', base: '', body: SJ.encodeBody('CFG', '1', { officerRankMax: 2 }) }] } }).login();
  net.run(20);
  assert.strictEqual(sentOf(o, 'o4'), 'wait,gm');
  assert.ok(said(o, '1 officer change is waiting. Log in on an officer character to send it.'));
  assert.strictEqual(recOf(o, 'CFG:1'), null);

  // Zuljinne is Thrallia's alt (one account). Until Thrallia's ch lists her, her sign-up waits.
  const me = { pid: 'Thrallia.p4m7', main: 'Thrallia', alts: ['Thrallia', 'Zuljinne'] };
  const su = (op, raid) => ({ op, g: G, id: `su:${raid}:Thrallia.p4m7`, t: net.now(), base: '', body: SJ.encodeBody('su', `${raid}:Thrallia.p4m7`, { character: 'Zuljinne', role: 'h', status: 'y' }) });
  const alt = net.client('Zuljinne', { rank: 3, account: 'calvin', inbox: { me, outbox: [su('o5', 'k3f9a2')] } }).login();
  net.run(20);
  assert.strictEqual(sentOf(alt, 'o5'), 'wait,link');
  assert.ok(said(alt, '1 change is waiting. Log in on Thrallia once so guildmates know Zuljinne is yours.'), alt.chat.join(' | '));
  alt.logout();
  const anchor = net.client('Thrallia', { rank: 3, account: 'calvin' }).login(); // the real collectors build ch with alts
  net.run(30);
  assert.match(sentOf(anchor, 'o5'), /^ok,[0-9a-z]{8},Thrallia$/, 'the anchor itself may send it');
  assert.deepStrictEqual(anchor.lua('return ns.Share.get("ch:Thrallia").fields.alts'), ['Thrallia', 'Zuljinne']);
  anchor.logout();
  alt.setInbox({ me, outbox: [su('o6', 'k3f9a3')] });
  alt.login();
  net.run(30);
  assert.match(sentOf(alt, 'o6'), /^ok,[0-9a-z]{8},Zuljinne$/, 'linked now');
  assert.ok(recOf(m, 'su:k3f9a3:Thrallia.p4m7'));
  noErrors(net);
});

test('the acknowledgement is written only after every part of the record went to the game', () => {
  const net = createGuildNet({ seed: 31, throttle: { burst: 2, perSecond: 0.2, mode: 'result' } });
  const t0 = net.now();
  const items = Array.from({ length: 60 }, (_, k) => ({ item: (17000 + k).toString(36), boss: 1 + (k % 4), name: `Epic item number ${k}` }));
  const body = SJ.encodeBody('LL', '2dv8n1', { name: 'Molten Core', bosses: ['Lucifron', 'Magmadar'], items });
  const o = net.client('Grommash', { rank: 1, inbox: { me: { pid: 'Grommash.k2k2' }, outbox: [{ op: 'o1', g: G, id: 'LL:2dv8n1', t: t0, need: 'o', base: '', body }] } });
  const b = quiet(net.client('Zuljin', { rank: 3 }).login());
  net.run(30);
  quiet(o.login());
  let sawPartial = false;
  for (let i = 0; i < 300 && !sentOf(o, 'o1'); i++) {
    net.run(1);
    const parts = net.log.filter((e) => e.from === 'Grommash' && e.type === '1M' && e.status === 'sent');
    if (parts.length >= 1 && !sentOf(o, 'o1')) sawPartial = true;
    if (sentOf(o, 'o1')) {
      const n = parseInt(parts[0].text[5], 36);
      assert.strictEqual(parts.length, n, 'every part went before the acknowledgement');
    }
  }
  assert.ok(sawPartial, 'some parts were out while the entry was still unacknowledged');
  assert.match(sentOf(o, 'o1'), /^ok,/);
  net.run(10);
  assert.ok(recOf(b, 'LL:2dv8n1'));
  noErrors(net);
});

test('a crash loses that session (received records, acknowledgements); the outbox entry goes again with the same id and t', () => {
  const net = createGuildNet({ seed: 32 });
  const t0 = net.now();
  const id = 'su:k3f9a2:Thrallia.p4m7';
  const body = SJ.encodeBody('su', 'k3f9a2:Thrallia.p4m7', { character: 'Thrallia', role: 'h', status: 'y' });
  const a = quiet(net.client('Thrallia', { rank: 3, inbox: { me: { pid: 'Thrallia.p4m7' }, outbox: [{ op: 'o1', g: G, id, t: t0 - 120, base: '', body }] } }).login());
  const b = quiet(net.client('Zuljin', { rank: 3 }).login());
  net.run(30);
  const first = recOf(b, id);
  assert.ok(first);
  const via = viaOf(b, id);
  b.lua('SlashCmdList.WOWGUILD("cta Crossroads 2 come")');
  net.run(5);
  assert.strictEqual(a.lua('#ns.Share.list("ca")'), 1);
  assert.match(sentOf(a, 'o1'), /^ok,/);
  a.crash();
  assert.strictEqual(a.sv(), null, 'nothing was written');
  net.run(60);
  b.logout(); // A will not get the call to arms back from anyone
  a.login();
  quiet(a);
  net.run(30);
  assert.strictEqual(a.lua('#ns.Share.list("ca")'), 0, 'records received in the crashed session are gone');
  assert.strictEqual(recOf(a, id), first, 'the same record again: same id, same t, same version');
  a.logout();
  assert.strictEqual(a.sv().shared.guilds[G].sent.o1, `ok,${first.split('^')[1]},Thrallia`);
  b.login();
  net.run(30);
  assert.strictEqual(viaOf(b, id), via, 'nothing changed for guildmates');
  noErrors(net);
});

// ---------------------------------------------------------------------------------------------------------------
// §5 receive rules: roster buffer, flood guard, newer protocol
// ---------------------------------------------------------------------------------------------------------------
test('a sender missing from my roster is buffered up to 30 s while the roster refreshes, then dropped', () => {
  const net = createGuildNet({ seed: 33 });
  const b = quiet(net.client('Zuljin', { rank: 3 }).login());
  net.run(30);
  const ca = (who, key) => `1R${makeRecord({ type: 'ca', key, fields: { character: who, zone: 'Crossroads' }, t: net.now(), author: who })}`;
  inject(b, ca('Stranger', 'aaaaaa'), 'Stranger');
  inject(b, ca('Ghost', 'bbbbbb'), 'Ghost');
  net.run(1);
  assert.strictEqual(recOf(b, 'ca:aaaaaa'), null);
  assert.strictEqual(debugOf(b).unknown, 2);
  net.run(10);
  net.member('Stranger', { rank: 3 });
  net.setOnline('Stranger', true); // the roster now has Stranger
  net.run(2);
  assert.match(viaOf(b, 'ca:aaaaaa'), /^Stranger,\d+,d$/, 'replayed once the roster knew the sender');
  net.run(30);
  assert.strictEqual(debugOf(b).unknown, 0);
  assert.strictEqual(recOf(b, 'ca:bbbbbb'), null, 'never in the roster: dropped');
  noErrors(net);
});

test('flood guard: a sender above 90 messages a minute is ignored for 10 minutes', () => {
  const net = createGuildNet({ seed: 34 });
  const b = quiet(net.client('Zuljin', { rank: 3 }).login());
  net.member('Sneaky', { rank: 3, online: true });
  net.run(30);
  const ca = (i) => `1R${makeRecord({ type: 'ca', key: `f${String(i).padStart(5, '0')}`, fields: { character: 'Sneaky' }, t: net.now(), author: 'Sneaky' })}`;
  for (let i = 0; i < 100; i++) inject(b, ca(i), 'Sneaky');
  net.run(1);
  assert.strictEqual(b.lua('#ns.Share.list("ca")'), 90);
  assert.strictEqual(statsOf(b).flood, 1);
  net.run(300);
  inject(b, ca(200), 'Sneaky');
  net.run(1);
  assert.strictEqual(recOf(b, 'ca:f00200'), null, 'still ignored after 5 minutes');
  net.run(300);
  inject(b, ca(201), 'Sneaky');
  net.run(1);
  assert.ok(recOf(b, 'ca:f00201'), 'heard again after 10 minutes');
  noErrors(net);
});

test('another protocol major is ignored; a higher one prints the update line once', () => {
  const net = createGuildNet({ seed: 35 });
  const b = quiet(net.client('Zuljin', { rank: 3 }).login());
  net.member('Future', { rank: 3, online: true });
  net.run(30);
  inject(b, '2H1000', 'Future');
  inject(b, '2Rca:aaaaaa^00000000^Future^^x', 'Future');
  inject(b, '0Hzzz', 'Future');
  net.run(1);
  const line = 'A guildmate has a newer Guild Camp addon. Update it from the Guild Camp app.';
  assert.strictEqual(b.chat.filter((l) => l.endsWith(line)).length, 1);
  assert.strictEqual(debugOf(b).records, 0);
  noErrors(net);
});

test('garbage never errors: broken messages of every kind are dropped', () => {
  const net = createGuildNet({ seed: 36 });
  const b = quiet(net.client('Zuljin', { rank: 3, interface: 120105 }).login());
  net.member('Sneaky', { rank: 3, online: true });
  net.run(30);
  const junk = ['', '1', '1H', '1Hzz', '1I', '1Izz0000', '1G^', '1GZuljin^ab', '1R', '1R^^^', '1Rca:x^1^a^^', '1M', '1M001', '1M0012x', '1M00z1abc',
    '1Q', `1R${'#'.repeat(200)}`, '1Hxyz\u0001', `1I0a${'z'.repeat(240)}`];
  for (const m of junk) inject(b, m, 'Sneaky');
  inject(b, '1R', 'Sneaky', 'OFFICER');
  b.wow.receive('GuildCamp', '1H', 'WHISPER', 'Sneaky-Forever');
  b.wow.receive('OtherPrefix', '1H', 'GUILD', 'Sneaky-Forever');
  net.run(70);
  assert.strictEqual(debugOf(b).records, 0);
  noErrors(net);
});

// ---------------------------------------------------------------------------------------------------------------
// §9 names from game data
// ---------------------------------------------------------------------------------------------------------------
test('names: spells at once, items after ITEM_DATA_LOAD_RESULT, at most 50 item requests a minute', () => {
  const items = {};
  for (let i = 0; i < 70; i++) items[30000 + i] = `Item ${i}`;
  items[17102] = 'Cloak of the Shrouded Mists';
  const net = createGuildNet({ seed: 37, items, spells: { 2660: 'Rough Sharpening Stone', 3275: 'Linen Bandage' } });
  const b = quiet(net.client('Zuljin', { rank: 3, interface: 120105 }).login());
  const p = quiet(net.client('Sneaky', { rank: 3 }).login());
  net.run(30);
  const rc = makeRecord({ type: 'rc', key: 'Sneaky:4k', fields: { kind: 's', count: 2, list: [2660, 3275] }, t: net.now(), author: 'Sneaky' });
  const bags = Array.from({ length: 70 }, (_, k) => ({ id: 30000 + k, count: 1 }));
  const bk = makeRecord({ type: 'bk', key: 'Sneaky', fields: { bags: [{ id: 17102, count: 1 }, ...bags] }, t: net.now(), author: 'Sneaky' });
  send(p, `1R${rc}`);
  for (const part of SJ.splitRecord(bk, 3)) send(p, part);
  net.run(1);
  assert.deepStrictEqual(b.lua('return ns.Share._.P().names.s'), { 2660: 'Rough Sharpening Stone', 3275: 'Linen Bandage' });
  const d = debugOf(b);
  assert.ok(d.namesRequested <= 50, `${d.namesRequested} requested`);
  assert.ok(d.namesPending >= 21, 'the rest wait for the next minute');
  net.run(65);
  net.run(5);
  const names = b.lua('return ns.Share._.P().names.i');
  assert.strictEqual(names[17102], 'Cloak of the Shrouded Mists');
  assert.strictEqual(Object.keys(names).length, 71);
  b.logout();
  assert.strictEqual(b.sv().shared.guilds[G].names.i[30069], 'Item 69', 'saved for the app');
  noErrors(net);
});

// ---------------------------------------------------------------------------------------------------------------
// offer(): the re-stamp policy (§4.3, §11)
// ---------------------------------------------------------------------------------------------------------------
test('offer: ch on a real change at most every 30 min, and weekly; rc, bk and sh on change; gb by the §11 rule', () => {
  const net = createGuildNet({ seed: 38 });
  const t0 = net.now();
  const week = 7 * 86400;
  const oldCh = makeRecord({ type: 'ch', key: 'Thrallia', fields: { pid: 'Thrallia.p4m7', level: 60 }, t: t0 - week - 60, author: 'Thrallia' });
  const a = quiet(net.client('Thrallia', { rank: 3, savedVariables: sharedDb([oldCh]), inbox: { me: { pid: 'Thrallia.p4m7' } } }).login());
  quiet(net.client('Zuljin', { rank: 3 }).login());
  net.run(30);
  const offer = (type, key, fields) => a.lua(`return ns.Share.offer(${toLua(type)}, ${toLua(key)}, ${toLua(fields)})`);
  const tOf = (id) => SJ.tOfVersion(recOf(a, id).split('^')[1]);

  assert.strictEqual(offer('ch', 'Thrallia', { pid: 'Thrallia.p4m7', level: 60 }), true, 'unchanged but over a week old: re-stamped');
  assert.ok(tOf('ch:Thrallia') >= t0);
  assert.strictEqual(offer('ch', 'Thrallia', { pid: 'Thrallia.p4m7', level: 60 }), false, 'unchanged');
  assert.strictEqual(offer('ch', 'Thrallia', { pid: 'Thrallia.p4m7', level: 61 }), false, 'a change within 30 min waits');
  net.run(25 * 60);
  assert.strictEqual(a.lua('return ns.Share.get("ch:Thrallia").fields.level'), 60);
  net.run(6 * 60);
  assert.strictEqual(a.lua('return ns.Share.get("ch:Thrallia").fields.level'), 61, 'then goes out by itself');
  assert.strictEqual(offer('ch', 'Zuljin', { pid: 'Zuljin.a8x2' }), false, 'only my own character');

  for (const [type, key, f1, f2] of [
    ['rc', 'Thrallia:4k', { kind: 's', count: 1, list: [2660] }, { kind: 's', count: 2, list: [2660, 2661] }],
    ['bk', 'Thrallia', { bags: [{ id: 2589, count: 1 }] }, { bags: [{ id: 2589, count: 2 }] }],
    ['sh', 'Thrallia.p4m7', { items: [{ name: 'Copper Bar', qty: 1, skill: 164 }] }, { items: [{ name: 'Copper Bar', qty: 2, skill: 164 }] }],
  ]) {
    assert.strictEqual(offer(type, key, f1), true, `${type}: new`);
    assert.strictEqual(offer(type, key, f1), false, `${type}: unchanged`);
    assert.strictEqual(offer(type, key, f2), true, `${type}: changed, at once`);
  }

  assert.strictEqual(offer('gb', '1', { items: [{ id: 2589, count: 20 }] }), true);
  assert.strictEqual(offer('gb', '1', { items: [{ id: 2589, count: 19 }] }), false, 'tab changed but the stored copy is under 15 minutes old');
  assert.strictEqual(offer('gb', '0', { scannedAt: net.now(), money: 100 }), true);
  net.run(16 * 60);
  assert.strictEqual(a.lua('return ns.Share.get("gb:1").fields.items[1].count'), 19, 'went out once 15 minutes had passed');
  assert.strictEqual(offer('gb', '0', { scannedAt: net.now(), money: 200 }), false, 'tab 0 at most every 2 hours');
  net.run(2 * 3600);
  assert.strictEqual(a.lua('return ns.Share.get("gb:0").fields.money'), 200);
  noErrors(net);
});

test('every ready rebuilds my records: an emptied shopping list, a dropped profession and leaving the bank characters become tombstones', () => {
  const net = createGuildNet({ seed: 39 });
  const a = net.client('Thrallia', { rank: 3, inbox: { me: { pid: 'Thrallia.p4m7' } } }).login();
  quiet(net.client('Zuljin', { rank: 3 }).login());
  net.run(30);
  // As if Collect had built these earlier (a shopping list, Tailoring recipes, a bank character's stock).
  a.lua(`ns.Share.offer("sh", "Thrallia.p4m7", { items = { { name = "Copper Bar", qty = 2, skill = 164 } } })
         ns.Share.offer("rc", "Thrallia:5h", { kind = "s", count = 1, list = { 3275 } })
         ns.Share.offer("bk", "Thrallia", { bags = { { id = 2589, count = 1 } } })`);
  assert.ok(a.lua('return ns.Share.get("sh:Thrallia.p4m7")'));
  const ch = a.lua('return ns.Share.get("ch:Thrallia")');
  assert.ok(ch, 'the real collectors built ch at ready');
  a.reload();
  net.run(30);
  for (const id of ['sh:Thrallia.p4m7', 'rc:Thrallia:5h', 'bk:Thrallia']) {
    assert.strictEqual(a.lua(`return ns.Share.get(${toLua(id)}).del`), true, `${id} is a tombstone`);
  }
  assert.ok(net.converged());
  noErrors(net);
});

// ---------------------------------------------------------------------------------------------------------------
// §3 player id, §9 seed, status line
// ---------------------------------------------------------------------------------------------------------------
test('player id: inbox me.pid, else shared.pid, else a guildmate\'s copy of one of my characters\' ch, else a new one', () => {
  const net = createGuildNet({ seed: 40 });
  const a = quiet(net.client('Thrallia', { rank: 3, savedVariables: { shared: { v: 1, pid: 'Thrallia.aaaa', guilds: {} } }, inbox: { me: { pid: 'Thrallia.p4m7' } } }).login());
  net.run(10);
  assert.strictEqual(a.lua('ns.Share.myPid()'), 'Thrallia.p4m7', 'the app\'s pid wins');
  a.setInbox(null);
  a.reload();
  net.run(10);
  assert.strictEqual(a.lua('ns.Share.myPid()'), 'Thrallia.p4m7', 'kept in shared.pid');

  // A second PC: no pid anywhere, but a guildmate holds ch:Orgrim with the player's pid.
  const ch = makeRecord({ type: 'ch', key: 'Orgrim', fields: { pid: 'Orgrim.q1w2', main: true }, t: net.now() - 3600, author: 'Orgrim' });
  quiet(net.client('Zuljin', { rank: 3, savedVariables: sharedDb([ch]) }).login());
  const o = quiet(net.client('Orgrim', { rank: 3 }).login());
  net.run(120);
  assert.strictEqual(o.lua('ns.Share.myPid()'), 'Orgrim.q1w2');

  const n = quiet(net.client('Newcomer', { rank: 3 }).login());
  net.run(60);
  assert.strictEqual(n.lua('ns.Share.myPid()'), null, 'waits 90 s for guildmates\' copies first');
  net.run(40);
  assert.match(n.lua('ns.Share.myPid()'), /^Newcomer\.[0-9a-z]{4}$/);
  n.logout();
  assert.strictEqual(n.sv().shared.guilds[G].pid.slice(0, 9), 'Newcomer.', 'saved for the app, with the guild (ids are per guild)');
  noErrors(net);
});

test('seed: records the app hands over load with how s and cost no bulk traffic; a seed for another guild is skipped', () => {
  const net = createGuildNet({ seed: 41 });
  const t0 = net.now();
  const recs = [];
  for (let i = 0; i < 40; i++) recs.push(makeRecord({ type: 'cr', key: `s${String(i).padStart(5, '0')}`, fields: { pid: 'Varok.7tq3', item: `Thing ${i}`, state: 'o' }, t: t0 - 3600 - i, author: 'Varok' }));
  recs.push(makeRecord({ type: 'RD', key: 'k3f9a2', fields: { kind: 'r', title: 'MC', startsAt: t0 + 86400 }, t: t0 - 7200, author: 'Grommash' }));
  quiet(net.client('Zuljin', { rank: 3, savedVariables: sharedDb(recs) }).login());
  net.run(60);
  net.resetStats();
  const a = quiet(net.client('Thrallia', { rank: 3, inbox: { me: { pid: 'Thrallia.p4m7' }, seed: recs, seedG: G } }).login());
  net.run(120);
  assert.strictEqual(debugOf(a).records, 41);
  assert.match(viaOf(a, 'RD:k3f9a2'), /^Thrallia,\d+,s$/);
  assert.ok(net.converged());
  assert.strictEqual(net.stats().perType['1R'], undefined, 'no record had to be sent');
  const other = quiet(net.client('Varok', { rank: 3, inbox: { me: { pid: 'Varok.7tq3' }, seed: recs, seedG: 'Forever/other' } }).login());
  net.run(2.5);
  assert.strictEqual(debugOf(other).records, 0, 'not this guild\'s seed');
  noErrors(net);
});

test('status line and /wow share', () => {
  const net = createGuildNet({ seed: 42 });
  const a = quiet(net.client('Thrallia', { rank: 3, inbox: { me: { pid: 'Thrallia.p4m7' }, outbox: [
    { op: 'o1', g: G, id: 'AN:aaaaaa', t: net.now(), need: 'o', base: '', body: SJ.encodeBody('AN', 'aaaaaa', { body: 'x' }) }] } }).login());
  const b = quiet(net.client('Zuljin', { rank: 3 }).login());
  net.run(60);
  b.lua('SlashCmdList.WOWGUILD("cta Crossroads 2 come")');
  net.run(5);
  assert.strictEqual(a.lua('ns.Share.statusLine()'), 'Sharing with 1 guildmate. 1 record. 1 change waiting.');
  a.lua('ns.Share.slash("")');
  assert.strictEqual(lastLine(a), 'Sharing with 1 guildmate. 1 record. 1 change waiting.');
  a.lua('ns.Share.slash("help")');
  assert.ok(said(a, '/wow share  how sharing with your guild is going'), a.chat.join(' | '));
  a.setInstance(true);
  net.run(3);
  assert.strictEqual(a.lua('ns.Share.statusLine()'), 'Waiting until you leave the dungeon.');
  const c = net.client('Loner', { rank: 3, guild: null }).login();
  net.run(5);
  assert.strictEqual(c.lua('ns.Share.statusLine()'), 'You are not in a guild, so nothing is shared.');
  noErrors(net);
});
