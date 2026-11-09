'use strict';
// Robustness of the addon's sharing engine against one member who makes things up, and against the game being slow
// to say which guild we are in (docs/SHARING.md §5, §8, §11). The real addon on GuildNet; no game install.
//
//   trust-3   the per-author caps (§11) count the author FIELD, which anyone may write: forged records in a
//             guildmate's name must not lock her out, and made-up authors or types must not grow every store; forged
//             records in many members' names must not take a store past its caps or push out price lists, officer
//             records or records heard from their author, and a full store costs no pass over it per record
//   trust-4   a hello that says "my store is empty", repeated, must not make the guild send its whole store or its
//             inventories again and again; G requests for the whole store, repeated, must not either (a real
//             empty store, a game that crashed before saving: share-refill.test.js)
//   addon-1   sharing starts once the game gives the guild's name, also after leaving one guild for another (and the
//             new guild waits its own 90 s before making a player id)
//   addon-2   a missing sharing module asks for a game restart (a /reload doesn't load new addon files)
//   addon-3   the problem report shows the game build and interface

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createGuildNet, makeRecord, sharedDb, guildStore, digestsOf } = require('./guildnet');
const { toLua } = require('./wowsim');
const SJ = require('../../src/shared/sharing');

const ADDON = path.join(__dirname, '..', '..', '..', 'addon', 'WowGuild');
const send = (c, msg, chan = 'GUILD') => c.lua(`return C_ChatInfo.SendAddonMessage("GuildCamp", ${toLua(msg)}, ${toLua(chan)})`);
const recOf = (c, id) => c.lua(`local P = ns.Share._.P(); return P and P.recs[${toLua(id)}]`);
const quiet = (c) => { c.lua('if ns.Collect then ns.Collect.sharedRecords = nil; ns.Collect.offerAll = function() end end'); return c; };
const usageOf = (c, author) => c.lua(`local u = ns.Share._.X().usage[${toLua(author)}]; return u and u.count or 0`);
const noErrors = (net) => { for (const c of net.clients) assert.deepEqual(c.errors, [], `${c.name} had no Lua errors`); };
// One R message a second (the game's throttle), from c's own addon-message API.
function sendRecords(net, c, records) {
  for (const m of SJ.packRecords(records)) {
    send(c, m);
    net.run(1.1);
  }
}
const forgedCr = (i, t, author = 'Thrallia') => SJ.encode({
  type: 'cr', key: `f${String(i).padStart(5, '0')}`, v: SJ.makeVersion(t, author, false), author,
  fields: { pid: 'Thrallia.p4m7', item: 'Junk', notes: '', state: 'o' },
});
const unknownRec = (i, t, author) => `zz:${i.toString(36)}^${SJ.makeVersion(t, author, false)}^${author}^^x`;

// ------------------------------------------------------------------------------------------------- trust-3
test('trust-3: Sneaky sends 300 forged unknown-type records in Thrallia\'s name; her real sign-up still reaches every guildmate, and the junk keeps to the unknown-type budget', () => {
  const net = createGuildNet({ seed: 77 });
  const zul = quiet(net.client('Zuljin', { rank: 3, inbox: { me: { pid: 'Zuljin.a8x2' } } }).login());
  const sneaky = quiet(net.client('Sneaky', { rank: 3, inbox: { me: { pid: 'Sneaky.s000' } } }).login());
  const thr = quiet(net.client('Thrallia', { rank: 3, inbox: { me: { pid: 'Thrallia.p4m7' } } }).login());
  net.run(30);
  const t = net.now() - 60;
  const junk = [];
  for (let i = 0; i < 300; i++) junk.push(unknownRec(i, t + i, 'Thrallia'));
  sendRecords(net, sneaky, junk);
  net.run(5);
  for (const c of [zul, thr]) {
    assert.equal(usageOf(c, 'Thrallia'), 0, `${c.name}: records of unknown types don't count as Thrallia's`);
    const unk = c.lua('return ns.Share._.X().unk.count');
    assert.ok(unk <= SJ.K.UNKNOWN_MAX_RECORDS, `${c.name} keeps ${unk} unknown-type records, at most ${SJ.K.UNKNOWN_MAX_RECORDS}`);
    assert.ok(recOf(c, `zz:${(299).toString(36)}`), `${c.name} kept the newest`);
    assert.equal(recOf(c, 'zz:0'), null, `${c.name} let the oldest go`);
  }
  const id = 'su:k3f9a2:Thrallia.p4m7';
  assert.ok(thr.lua(`return ns.Share.putLocal("su", "k3f9a2:Thrallia.p4m7", { character = "Thrallia", role = "h", status = "y" }) ~= nil`));
  net.run(30);
  assert.ok(recOf(zul, id), 'Zuljin stored Thrallia\'s sign-up');
  assert.ok(recOf(sneaky, id), 'so did Sneaky');
  noErrors(net);
});

test('trust-3: after 300 forged known-type records in Thrallia\'s name, her new sign-up reaches every guildmate, also one who gets it relayed later, and her earlier record stays', () => {
  const net = createGuildNet({ seed: 78 });
  const zul = quiet(net.client('Zuljin', { rank: 3, inbox: { me: { pid: 'Zuljin.a8x2' } } }).login());
  const sneaky = quiet(net.client('Sneaky', { rank: 3, inbox: { me: { pid: 'Sneaky.s000' } } }).login());
  const thr = quiet(net.client('Thrallia', { rank: 3, inbox: { me: { pid: 'Thrallia.p4m7' } } }).login());
  const varok = quiet(net.client('Varok', { rank: 3, inbox: { me: { pid: 'Varok.v000' } } }).login());
  net.run(60);
  // Her own looking-for-party post, heard from her by everyone.
  assert.ok(thr.lua('return ns.Share.putLocal("lp", "Thrallia.p4m7:Thrallia", { character = "Thrallia", level = 60, zone = "Tanaris", when = "now" }) ~= nil'));
  net.run(20);
  const lp = 'lp:Thrallia.p4m7:Thrallia';
  for (const c of [zul, sneaky, varok]) assert.ok(recOf(c, lp), `${c.name} has her lp`);
  // Sneaky forges 300 craft requests in her name: her whole quota.
  const t = net.now() - 120;
  const junk = [];
  for (let i = 0; i < 300; i++) junk.push(forgedCr(i, t));
  sendRecords(net, sneaky, junk);
  net.run(10);
  for (const c of [zul, varok]) {
    assert.ok(usageOf(c, 'Thrallia') <= SJ.K.AUTHOR_MAX_RECORDS, `${c.name} keeps her caps`);
    assert.ok(recOf(c, lp), `${c.name} still has her lp: the forged batch can't push it out`);
  }
  // Varok is away when she signs up; he gets it later through the exchange (relayed).
  varok.logout();
  net.run(5);
  const su = 'su:k3f9a2:Thrallia.p4m7';
  assert.ok(thr.lua('return ns.Share.putLocal("su", "k3f9a2:Thrallia.p4m7", { character = "Thrallia", role = "h", status = "y" }) ~= nil'));
  net.run(30);
  assert.ok(recOf(zul, su), 'Zuljin, who heard it from her, stored it');
  assert.ok(recOf(sneaky, su), 'so did Sneaky');
  varok.login();
  quiet(varok);
  const got = net.runUntil(() => Boolean(recOf(varok, su)), { max: 900, step: 10 });
  assert.ok(got, 'Varok got her sign-up relayed by a guildmate');
  for (const c of [zul, sneaky, varok, thr]) {
    assert.ok(recOf(c, lp), `${c.name} still has her lp`);
    // Thrallia's own store too: her new records push out what was passed on in her name, like everyone's.
    assert.ok(usageOf(c, 'Thrallia') <= SJ.K.AUTHOR_MAX_RECORDS, `${c.name} keeps her caps`);
  }
  // Nothing goes round in circles: ten quiet minutes later the stores no longer change, and they are equal.
  net.run(600);
  net.resetStats();
  net.run(1200);
  assert.ok(net.stats().sent < 40, `${net.stats().sent} messages in 20 quiet minutes`);
  assert.ok(net.converged(), 'every store holds the same records');
  noErrors(net);
});

test('trust-3: a guildmate sending her own records past her caps still gets them stored, and her caps still hold', () => {
  const net = createGuildNet({ seed: 79 });
  const zul = quiet(net.client('Zuljin', { rank: 3 }).login());
  const thr = quiet(net.client('Thrallia', { rank: 3 }).login());
  net.run(30);
  const t = net.now() - 600;
  const own = [];
  for (let i = 0; i < 320; i++) own.push(forgedCr(i, t + i));
  sendRecords(net, thr, own); // first-hand: Thrallia sends records in her own name
  net.run(10);
  assert.ok(usageOf(zul, 'Thrallia') <= SJ.K.AUTHOR_MAX_RECORDS);
  assert.ok(recOf(zul, 'cr:f00319'), 'the newest is stored');
  assert.equal(recOf(zul, 'cr:f00000'), null, 'her oldest made room');
  assert.equal(zul.lua('return ns.Share._.P().stats.refused or 0'), 0, 'nothing heard from its author was refused');
  noErrors(net);
});

test('trust-3: Thrallia\'s addon never passes on records made up in her name, so a newcomer never takes them as heard from her', () => {
  const net = createGuildNet({ seed: 81 });
  const zul = quiet(net.client('Zuljin', { rank: 3 }).login());
  const sneaky = quiet(net.client('Sneaky', { rank: 3 }).login());
  const thr = quiet(net.client('Thrallia', { rank: 3 }).login());
  net.run(60);
  const t = net.now() - 120;
  const junk = [];
  for (let i = 0; i < 40; i++) junk.push(forgedCr(i, t));
  sendRecords(net, sneaky, junk);
  net.run(10);
  const ids = junk.map((r) => r.slice(0, r.indexOf('^')));
  assert.ok(ids.every((id) => recOf(thr, id)), 'Thrallia\'s store holds them too');
  // Her own record, which she does pass on.
  const lp = 'lp:Thrallia.p4m7:Thrallia';
  assert.ok(thr.lua('return ns.Share.putLocal("lp", "Thrallia.p4m7:Thrallia", { character = "Thrallia", level = 60, zone = "Tanaris", when = "now" }) ~= nil'));
  net.run(10);
  // Rexxar joins while only Thrallia is online: she alone could pass them on.
  zul.logout();
  sneaky.logout();
  net.run(5);
  net.resetStats();
  const rex = quiet(net.client('Rexxar', { rank: 3 }).login());
  assert.ok(net.runUntil(() => Boolean(recOf(rex, lp)), { max: 600, step: 10 }), 'the newcomer got her own record from her');
  net.run(900);
  assert.deepEqual(ids.filter((id) => recOf(rex, id)), [], 'but none of the made-up ones');
  const sentByHer = net.log.filter((e) => e.from === 'Thrallia' && e.status === 'sent' && /cr:f0/.test(e.text));
  assert.equal(sentByHer.length, 0, 'Thrallia passed none of them on');
  // Zuljin comes back: guildmates pass them on, as relayed records.
  zul.login();
  quiet(zul);
  assert.ok(net.runUntil(() => ids.every((id) => recOf(rex, id)), { max: 900, step: 10 }), 'Rexxar got them from Zuljin');
  const viaOfRex = (id) => rex.lua(`return ns.Share._.P().via[${toLua(id)}]`);
  assert.deepEqual(ids.filter((id) => /,d$/.test(viaOfRex(id))), [], 'none of the made-up ones is stored as heard from Thrallia');
  assert.ok(net.runUntil(() => net.converged(), { max: 600, step: 10 }), 'and everyone online holds the same store');
  noErrors(net);
});

test('trust-3: records with made-up authors and types go first when the store is over its caps; price lists stay', () => {
  const net = createGuildNet({ seed: 80 });
  const t0 = net.now();
  // 50 guildmates without the addon, each with a price list.
  const names = [];
  for (let i = 0; i < 50; i++) names.push(`Pr${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`);
  for (const n of names) net.member(n);
  const prices = names.map((n, i) => makeRecord({ type: 'pr', key: `${n}.aaaa`, fields: { day: 1, prices: [{ id: 2589, copper: 100 + i }] }, t: t0 - 3600 + i, author: n }));
  const junk = [];
  for (let i = 0; i < 3700; i++) junk.push(forgedCr(i, t0 - 7200, `A${i.toString(36)}`));
  const unknown = [];
  for (let i = 0; i < 250; i++) unknown.push(unknownRec(i, t0 - 7200 + i, `B${i.toString(36)}`));
  const saved = sharedDb([...prices, ...junk, ...unknown]);
  const zul = quiet(net.client('Zuljin', { rank: 3, savedVariables: saved }).login());
  const sneaky = quiet(net.client('Sneaky', { rank: 3, savedVariables: saved }).login()); // same store: no big exchange
  net.run(30);
  assert.equal(zul.lua('return ns.Share._.X().unk.count'), SJ.K.UNKNOWN_MAX_RECORDS, 'a saved store keeps to the unknown-type budget');
  const more = [];
  for (let i = 0; i < 400; i++) more.push(forgedCr(5000 + i, net.now() - 30, `C${i.toString(36)}`));
  sendRecords(net, sneaky, more);
  net.run(5);
  const d = zul.lua('return ns.Share._.debug()');
  assert.ok(d.records <= SJ.K.STORE_MAX_RECORDS, `${d.records} records, at most ${SJ.K.STORE_MAX_RECORDS}`);
  assert.equal(zul.lua('return #ns.Share.list("pr")'), 50, 'every price list stays');
  assert.equal(zul.lua('return ns.Share._.X().unk.count'), 0, 'made-up types went first');
  const left = zul.lua('local n = 0 for id in pairs(ns.Share._.P().recs) do if id:sub(1, 3) == "cr:" then n = n + 1 end end return n');
  assert.ok(left < 3700 + 400, `records of made-up authors went next: ${left} left`);
  assert.ok(recOf(zul, 'cr:f05399'), 'the newest of them stays');
  noErrors(net);
});

// A saved store whose via says who passed each record on and how: entries [record, from, how].
function storeWithVia(entries, at) {
  const recs = {};
  const via = {};
  for (const [r, from, how] of entries) {
    const id = r.slice(0, r.indexOf('^'));
    recs[id] = r;
    via[id] = `${from},${at},${how}`;
  }
  return { shared: { v: 1, guilds: { 'Forever/wow': { recs, via, sent: {}, names: { s: {}, i: {} }, stats: {} } } } };
}

// 50 guildmates without the addon, each with a ch and a price list keyed by their own id (passed on by Varok), 10
// notices by Grommash (an officer record, passed on by Varok, a trusted relay), and 20 craft requests heard from
// their authors. `junk` forged craft requests in their names (74 each, under the 300 author cap) passed on by
// `junkFrom`. → { net, names, legit (ids that must stay), saved }
function rosterStore(seed, { junk, junkFrom, junkT }) {
  const net = createGuildNet({ seed });
  const t0 = net.now();
  const at = Math.floor(t0) - 86400;
  const names = [];
  for (let i = 0; i < 50; i++) names.push(`Pr${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`);
  for (const n of names) net.member(n);
  net.member('Grommash', { rank: 1 });
  const entries = [];
  names.forEach((n, i) => {
    entries.push([makeRecord({ type: 'ch', key: n, fields: { pid: `${n}.aaaa`, level: 60 }, t: t0 - 7300 + i, author: n }), 'Varok', 'm']);
    entries.push([makeRecord({ type: 'pr', key: `${n}.aaaa`, fields: { day: 1, prices: [{ id: 2589, copper: 100 + i }] }, t: t0 - 7300 + i, author: n }), 'Varok', 'm']);
  });
  for (let i = 0; i < 10; i++) entries.push([makeRecord({ type: 'AN', key: `an${String(i).padStart(4, '0')}`, fields: { body: `Notice ${i}` }, t: t0 - 7400 + i, author: 'Grommash' }), 'Varok', 't']);
  for (let i = 0; i < 20; i++) {
    const n = names[i];
    entries.push([SJ.encode({ type: 'cr', key: `h${String(i).padStart(5, '0')}`, v: SJ.makeVersion(t0 - 7400 + i, n, false), author: n, fields: { pid: `${n}.aaaa`, item: 'Real request', notes: '', state: 'o' } }), n, 'd']);
  }
  const legit = entries.map(([r]) => r.slice(0, r.indexOf('^')));
  for (let i = 0; i < junk; i++) {
    const n = names[i % 50];
    entries.push([SJ.encode({ type: 'cr', key: `f${String(i).padStart(5, '0')}`, v: SJ.makeVersion(junkT(i, t0), n, false), author: n, fields: { pid: `${n}.aaaa`, item: 'Junk', notes: '', state: 'o' } }), junkFrom, 'm']);
  }
  return { net, names, legit, saved: storeWithVia(entries, at) };
}
const forgedIn = (names, i, t) => SJ.encode({ type: 'cr', key: `g${String(i).padStart(5, '0')}`, v: SJ.makeVersion(t, names[i % 50], false), author: names[i % 50],
  fields: { pid: `${names[i % 50]}.aaaa`, item: 'Junk', notes: '', state: 'o' } });
// One R message a second from Sneaky; → the most records Zuljin's store held after any of them.
function floodAndWatch(net, sneaky, zul, records) {
  let most = 0;
  for (const m of SJ.packRecords(records)) {
    send(sneaky, m);
    net.run(1.1);
    most = Math.max(most, zul.lua('return ns.Share._.debug().records'));
  }
  net.run(5);
  return most;
}
const capPasses = (c) => c.lua('return ns.ShareSync.debugCounts().capPasses');

test('trust-3: Sneaky passes on 4,100 forged records in 50 roster members\' names, each under the author cap: the store never goes past 4,000 records, keeps every price list, officer record and record heard from its author, and needs a pass per 40 records, not one per record', () => {
  // The 3,700 already stored came from Sneaky earlier, dated 2 hours ago.
  const { net, names, legit, saved } = rosterStore(82, { junk: 3700, junkFrom: 'Sneaky', junkT: (i, t0) => t0 - 7200 });
  const zul = quiet(net.client('Zuljin', { rank: 3, savedVariables: saved }).login());
  const sneaky = quiet(net.client('Sneaky', { rank: 3, savedVariables: saved }).login());
  net.run(30);
  assert.equal(zul.lua('return ns.Share._.debug().records'), 3830);
  const before = capPasses(zul);
  const more = [];
  for (let i = 0; i < 400; i++) more.push(forgedIn(names, i, net.now() - 30));
  const most = floodAndWatch(net, sneaky, zul, more);
  const d = zul.lua('return ns.Share._.debug()');
  assert.ok(most <= SJ.K.STORE_MAX_RECORDS, `at most ${most} records, never past ${SJ.K.STORE_MAX_RECORDS}`);
  assert.ok(d.records <= SJ.K.STORE_MAX_RECORDS && d.bytes <= SJ.K.STORE_MAX_BYTES, `${d.records} records, ${d.bytes} bytes: under the caps`);
  assert.deepEqual(legit.filter((id) => !recOf(zul, id)), [], 'every price list, ch, notice and record heard from its author stays');
  assert.equal(zul.lua('return #ns.Share.list("pr")'), 50);
  assert.ok(recOf(zul, 'cr:g00399'), 'the newest forged one is in (it pushed out older ones Sneaky passed on)');
  assert.equal(recOf(zul, 'cr:f00000'), null, 'the oldest Sneaky passed on went first');
  const passes = capPasses(zul) - before;
  assert.ok(passes <= 10, `${passes} passes over the store for 400 records`);
  noErrors(net);
});

test('trust-3: the forged records came through Varok, an honest guildmate who passed on everything Zuljin holds: over the caps Varok\'s oldest passed-on records go, never a price list, an officer record or a record heard from its author', () => {
  const { net, names, legit, saved } = rosterStore(83, { junk: 3700, junkFrom: 'Varok', junkT: (i, t0) => t0 - 7000 + i });
  const zul = quiet(net.client('Zuljin', { rank: 3, savedVariables: saved }).login());
  const sneaky = quiet(net.client('Sneaky', { rank: 3, savedVariables: saved }).login());
  net.run(30);
  const more = [];
  for (let i = 0; i < 400; i++) more.push(forgedIn(names, i, net.now() - 30));
  const most = floodAndWatch(net, sneaky, zul, more);
  assert.ok(most <= SJ.K.STORE_MAX_RECORDS, `at most ${most} records`);
  assert.deepEqual(legit.filter((id) => !recOf(zul, id)), [], 'every price list, notice and record heard from its author stays');
  assert.equal(zul.lua('return #ns.Share.list("AN")'), 10);
  assert.equal(recOf(zul, 'cr:f00000'), null, 'the oldest record Varok passed on went first');
  noErrors(net);
});

test('trust-3: forged records each older than the last can push nothing out: a full store refuses them with a pass a minute, not a pass per record, and still takes a record heard from its author', () => {
  // A full store: 3,970 forged records Sneaky passed on earlier, newer than anything he sends now.
  const { net, names, legit, saved } = rosterStore(84, { junk: 3870, junkFrom: 'Sneaky', junkT: (i, t0) => t0 - 3600 + i });
  const zul = quiet(net.client('Zuljin', { rank: 3, savedVariables: saved }).login());
  const sneaky = quiet(net.client('Sneaky', { rank: 3, savedVariables: saved }).login());
  const thr = quiet(net.client('Thrallia', { rank: 3, savedVariables: saved }).login());
  net.run(30);
  const before = capPasses(zul);
  const start = net.now();
  const more = [];
  for (let i = 0; i < 400; i++) more.push(forgedIn(names, i, net.now() - 4000 - i));
  const most = floodAndWatch(net, sneaky, zul, more);
  const minutes = (net.now() - start) / 60;
  const passes = capPasses(zul) - before;
  assert.ok(most <= SJ.K.STORE_MAX_RECORDS, `at most ${most} records`);
  assert.ok(passes <= Math.ceil(minutes) + 2, `${passes} passes in ${minutes.toFixed(1)} minutes for 400 refused records`);
  assert.deepEqual(legit.filter((id) => !recOf(zul, id)), []);
  // Thrallia's own record, heard from her, still gets in (Sneaky's records make room).
  assert.ok(thr.lua('return ns.Share.putLocal("lp", "Thrallia.p4m7:Thrallia", { character = "Thrallia", level = 60, zone = "Tanaris", when = "now" }) ~= nil'));
  net.run(10);
  assert.ok(recOf(zul, 'lp:Thrallia.p4m7:Thrallia'), 'Zuljin stored Thrallia\'s new record');
  assert.ok(zul.lua('return ns.Share._.debug().records') <= SJ.K.STORE_MAX_RECORDS);
  noErrors(net);
});

test('trust-3: Sneaky passes on a made-up 2 KB bank record (bk) for each of 400 roster characters that have none; the store never goes past its caps and keeps every price list and ch Varok passed on (one guildmate\'s made-up ch, bk or price lists never push out those another guildmate passed on)', () => {
  const net = createGuildNet({ seed: 86 });
  const t0 = net.now();
  const names = [];
  const letter = (n) => String.fromCharCode(97 + n);
  for (let i = 0; i < 800; i++) names.push(`M${letter(i % 26)}${letter(Math.floor(i / 26) % 26)}${letter(Math.floor(i / 676))}x`);
  for (const n of names) net.member(n);
  // Varok passed on the ch of 400 characters, 50 price lists (older than the ch's) and 1,000 craft requests: his
  // ch's and price lists outnumber the bank records Sneaky can hold at once (the byte cap).
  const entries = [];
  names.slice(0, 400).forEach((n, i) => entries.push([makeRecord({ type: 'ch', key: n, fields: { pid: `${n}.aaaa`, level: 60 }, t: t0 - 5000 + i, author: n }), 'Varok', 'm']));
  names.slice(0, 50).forEach((n, i) => entries.push([makeRecord({ type: 'pr', key: `${n}.aaaa`, fields: { day: 1, prices: Array.from({ length: 20 }, (_, k) => ({ id: 2500 + k, copper: 100 + i })) }, t: t0 - 9000 + i, author: n }), 'Varok', 'm']));
  for (let i = 0; i < 1000; i++) {
    const n = names[i % 300];
    entries.push([SJ.encode({ type: 'cr', key: `h${String(i).padStart(5, '0')}`, v: SJ.makeVersion(t0 - 20000 + i, n, false), author: n, fields: { pid: `${n}.aaaa`, item: `Real request ${i}`, notes: 'mats in the bank', state: 'o' } }), 'Varok', 'm']);
  }
  const saved = storeWithVia(entries, Math.floor(t0) - 86400);
  const zul = quiet(net.client('Zuljin', { rank: 3, savedVariables: saved }).login());
  const sneaky = quiet(net.client('Sneaky', { rank: 3, savedVariables: saved }).login());
  net.run(30);
  // One bk per character (author = key, so the author caps hold), about 1.8 KB each: 400 of them are more than the
  // store's byte cap. Each goes in M parts, one message a second.
  const msgs = [];
  names.slice(400).forEach((n, i) => {
    const fields = { bags: Array.from({ length: 120 }, (_, k) => ({ id: 2000 + k * 11 + i, count: 1 + (k % 19) })), bank: Array.from({ length: 160 }, (_, k) => ({ id: 4000 + k * 17 + i, count: 1 + (k % 199) })) };
    let r = makeRecord({ type: 'bk', key: n, fields, t: t0 - 30, author: n });
    while (r.length > 2048) {
      fields.bank.pop();
      r = makeRecord({ type: 'bk', key: n, fields, t: t0 - 30, author: n });
    }
    msgs.push(...SJ.splitRecord(r, i + 1));
  });
  let most = 0;
  let mostBytes = 0;
  msgs.forEach((m, k) => {
    send(sneaky, m);
    net.run(1.1);
    if (k % 8 === 7) {
      const d = zul.lua('return ns.Share._.debug()');
      most = Math.max(most, d.records);
      mostBytes = Math.max(mostBytes, d.bytes);
    }
  });
  net.run(5);
  assert.ok(most <= SJ.K.STORE_MAX_RECORDS && mostBytes <= SJ.K.STORE_MAX_BYTES, `at most ${most} records, ${mostBytes} bytes`);
  // Without the rule, Sneaky's bank records pushed out 49 of the 50 price lists and 168 of the 400 ch's.
  const prLeft = names.slice(0, 50).filter((n) => recOf(zul, `pr:${n}.aaaa`)).length;
  const chLeft = names.slice(0, 400).filter((n) => recOf(zul, `ch:${n}`)).length;
  assert.equal(prLeft, 50, 'every price list Varok passed on stays');
  assert.equal(chLeft, 400, 'every ch Varok passed on stays');
  noErrors(net);
});

test('trust-3: Sneaky passes on a made-up 2 KB bank record (bk) for each of 300 roster characters while 2,500 craft requests three honest guildmates passed on fill the store; over the caps his bank records go, not their requests (who passed on the most bytes goes first, his bank records with the rest of what he passed on)', () => {
  const net = createGuildNet({ seed: 91 });
  const t0 = net.now();
  const names = [];
  for (let i = 0; i < 300; i++) names.push(`M${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26) % 26)}x`);
  for (const n of names) net.member(n);
  net.member('Grommash', { rank: 1 });
  const entries = [];
  names.slice(0, 120).forEach((n, i) => entries.push([makeRecord({ type: 'ch', key: n, fields: { pid: `${n}.aaaa`, level: 60 }, t: t0 - 5000 + i, author: n }), 'Varok', 'm']));
  names.slice(0, 50).forEach((n, i) => entries.push([makeRecord({ type: 'pr', key: `${n}.aaaa`, fields: { day: 1, prices: Array.from({ length: 20 }, (_, k) => ({ id: 2500 + k, copper: 100 + i })) }, t: t0 - 9000 + i, author: n }), 'Varok', 'm']));
  const requests = [];
  for (let i = 0; i < 2500; i++) {
    const n = names[i % 300];
    const r = SJ.encode({ type: 'cr', key: `h${String(i).padStart(5, '0')}`, v: SJ.makeVersion(t0 - 20000 + i, n, false), author: n, fields: { pid: `${n}.aaaa`, item: `Real request ${i}`, notes: 'mats in the bank', state: 'o' } });
    entries.push([r, ['Varok', 'Thrallia', 'Garona'][i % 3], 'm']);
    requests.push(r.slice(0, r.indexOf('^')));
  }
  const saved = storeWithVia(entries, Math.floor(t0) - 86400);
  const zul = quiet(net.client('Zuljin', { rank: 3, savedVariables: saved }).login());
  const sneaky = quiet(net.client('Sneaky', { rank: 3, savedVariables: saved }).login());
  net.run(30);
  const msgs = [];
  names.forEach((n, i) => {
    const fields = { bags: Array.from({ length: 120 }, (_, k) => ({ id: 2000 + k * 11 + i, count: 1 + (k % 19) })), bank: Array.from({ length: 160 }, (_, k) => ({ id: 4000 + k * 17 + i, count: 1 + (k % 199) })) };
    let r = makeRecord({ type: 'bk', key: n, fields, t: net.now() - 30, author: n });
    while (r.length > 2048) {
      fields.bank.pop();
      r = makeRecord({ type: 'bk', key: n, fields, t: net.now() - 30, author: n });
    }
    msgs.push(...SJ.splitRecord(r, i + 1));
  });
  let most = 0;
  let mostBytes = 0;
  msgs.forEach((m, k) => {
    send(sneaky, m);
    net.run(1.1);
    if (k % 8 === 7) {
      const d = zul.lua('return ns.Share._.debug()');
      most = Math.max(most, d.records);
      mostBytes = Math.max(mostBytes, d.bytes);
    }
  });
  net.run(5);
  assert.ok(most <= SJ.K.STORE_MAX_RECORDS && mostBytes <= SJ.K.STORE_MAX_BYTES, `at most ${most} records, ${mostBytes} bytes`);
  // Counted in records, his 300 bank records were the smallest group, and a ch or bk (class 8) went after every
  // craft request (class 3): his pushed out 1,459 of the 2,500.
  let left = requests.filter((id) => recOf(zul, id)).length;
  assert.equal(left, 2500, `${left} of 2,500 craft requests stay`);
  // Zuljin's own new records always get in, and the pass makes room with Sneaky's bank records first: who passed on
  // the most goes first, his bk with the rest (else 90 of the honest requests went: the order put every craft
  // request before any bk).
  for (let i = 0; i < 40; i++) zul.lua(`ns.Share.putLocal("cr", "z${String(i).padStart(5, '0')}", { pid = "Zuljin.zzzz", item = "My own request ${i}", notes = "mats ready, please craft soon", state = "o" })`);
  net.run(5);
  const d = zul.lua('return ns.Share._.debug()');
  assert.ok(d.records <= SJ.K.STORE_MAX_RECORDS && d.bytes <= SJ.K.STORE_MAX_BYTES, `${d.records} records, ${d.bytes} bytes`);
  left = requests.filter((id) => recOf(zul, id)).length;
  assert.equal(left, 2500, `after Zuljin's own records, ${left} of 2,500 craft requests stay`);
  assert.equal(names.slice(0, 50).filter((n) => recOf(zul, `pr:${n}.aaaa`)).length, 50, 'every price list stays');
  assert.equal(names.slice(0, 120).filter((n) => recOf(zul, `ch:${n}`)).length, 120, 'every ch stays');
  noErrors(net);
});

test('trust-3: Varok passed on 2 KB bank records of 250 characters (the most bytes of anyone), Thrallia and Garona craft requests; Sneaky passes on made-up bank records for 300 others: his never push out the requests of a guildmate who passed on fewer bytes than he has', (t) => {
  const net = createGuildNet({ seed: 92 });
  const t0 = net.now();
  const names = [];
  for (let i = 0; i < 560; i++) names.push(`M${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26) % 26)}y`);
  for (const n of names) net.member(n);
  const bank = (n, i, t) => {
    const fields = { bags: Array.from({ length: 120 }, (_, k) => ({ id: 2000 + k * 11 + i, count: 1 + (k % 19) })), bank: Array.from({ length: 160 }, (_, k) => ({ id: 4000 + k * 17 + i, count: 1 + (k % 199) })) };
    let r = makeRecord({ type: 'bk', key: n, fields, t, author: n });
    while (r.length > 2048) {
      fields.bank.pop();
      r = makeRecord({ type: 'bk', key: n, fields, t, author: n });
    }
    return r;
  };
  const entries = [];
  names.slice(0, 250).forEach((n, i) => entries.push([bank(n, i, t0 - 9000 + i), 'Varok', 'm']));
  const requests = [];
  for (let i = 0; i < 1000; i++) {
    const n = names[i % 250];
    const r = SJ.encode({ type: 'cr', key: `h${String(i).padStart(5, '0')}`, v: SJ.makeVersion(t0 - 20000 + i, n, false), author: n, fields: { pid: `${n}.aaaa`, item: `Real request ${i}`, notes: 'mats in the bank', state: 'o' } });
    entries.push([r, i % 2 ? 'Thrallia' : 'Garona', 'm']);
    requests.push(r.slice(0, r.indexOf('^')));
  }
  const saved = storeWithVia(entries, Math.floor(t0) - 86400);
  const zul = quiet(net.client('Zuljin', { rank: 3, savedVariables: saved }).login());
  const sneaky = quiet(net.client('Sneaky', { rank: 3, savedVariables: saved }).login());
  net.run(30);
  const msgs = [];
  names.slice(260).forEach((n, i) => msgs.push(...SJ.splitRecord(bank(n, 300 + i, net.now() - 30), i + 1)));
  let most = 0;
  let mostBytes = 0;
  msgs.forEach((m, k) => {
    send(sneaky, m);
    net.run(1.1);
    if (k % 8 === 7) {
      const d = zul.lua('return ns.Share._.debug()');
      most = Math.max(most, d.records);
      mostBytes = Math.max(mostBytes, d.bytes);
    }
  });
  net.run(5);
  assert.ok(most <= SJ.K.STORE_MAX_RECORDS && mostBytes <= SJ.K.STORE_MAX_BYTES, `at most ${most} records, ${mostBytes} bytes`);
  // Varok's bank records are ch-like (class 8): none of Sneaky's may push them out. Thrallia's and Garona's requests
  // go only while they had passed on more bytes than Sneaky (else every one of them went).
  const left = requests.filter((id) => recOf(zul, id)).length;
  t.diagnostic(`${left} of 1,000 craft requests stay`);
  assert.ok(left >= 500, `${left} of 1,000 craft requests stay`);
  assert.equal(names.slice(0, 250).filter((n) => recOf(zul, `bk:${n}`)).length, 250, 'every bank record Varok passed on stays');
  noErrors(net);
});

test('trust-3: Zuljin\'s store is full of Sneaky\'s newest forged records and Sneaky passes on a backdated one every 15 s; Zuljin still stores each new ch Varok passes on and each notice an officer passes on (only Sneaky\'s own records wait out the minute without a pass)', () => {
  // Full: 3,870 forged records Sneaky passed on in the last 10 minutes, newer than everything else in the store.
  const { net, names, legit, saved } = rosterStore(85, { junk: 3870, junkFrom: 'Sneaky', junkT: (i, t0) => t0 - 600 + Math.floor(i / 10) });
  const newNames = [];
  for (let i = 0; i < 10; i++) {
    newNames.push(`Nw${String.fromCharCode(97 + i)}`);
    net.member(newNames[i]);
  }
  const zul = quiet(net.client('Zuljin', { rank: 3, savedVariables: saved }).login());
  const sneaky = quiet(net.client('Sneaky', { rank: 3, savedVariables: saved }).login());
  const varok = quiet(net.client('Varok', { rank: 3, savedVariables: saved }).login());
  const saur = quiet(net.client('Saurfang', { rank: 1, savedVariables: saved }).login());
  net.run(30);
  assert.equal(zul.lua('return ns.Share._.debug().records'), SJ.K.STORE_MAX_RECORDS);
  const t0 = net.now();
  const before = capPasses(zul);
  const fresh = [];
  for (let s = 0; s < 600; s += 15) {
    // A backdated forged record: it can push nothing out, so its pass finds no room.
    send(sneaky, `1R${forgedIn(names, 1000 + s, t0 - 90000 - s)}`);
    net.run(7);
    if (s % 60 === 30) {
      const k = fresh.length / 2;
      const n = newNames[k];
      const ch = makeRecord({ type: 'ch', key: n, fields: { pid: `${n}.bbbb`, level: 60 }, t: net.now() - 5, author: n });
      const an = makeRecord({ type: 'AN', key: `nw${String(k).padStart(4, '0')}`, fields: { body: `Raid moved ${k}` }, t: net.now() - 5, author: 'Grommash' });
      send(varok, `1R${ch}`);
      send(saur, `1R${an}`);
      fresh.push(ch, an);
    }
    net.run(8);
  }
  net.run(5);
  // Without a minute's wait for Sneaky's records only, his failed pass made the store refuse everyone's: 14 of 20.
  const missing = fresh.filter((r) => recOf(zul, r.slice(0, r.indexOf('^'))) !== r).map((r) => r.slice(0, r.indexOf('^')));
  assert.deepEqual(missing, [], 'every new ch Varok passed on and every notice Saurfang passed on is stored');
  assert.deepEqual(legit.filter((id) => !recOf(zul, id)), []);
  const passes = capPasses(zul) - before;
  assert.ok(passes <= 22, `${passes} passes in 10 minutes`);
  assert.ok(zul.lua('return ns.Share._.debug().records') <= SJ.K.STORE_MAX_RECORDS);
  noErrors(net);
});

// ------------------------------------------------------------------------------------------------- trust-4
// A converged guild of four holding the §7-sized store, plus Sneaky, who logged in and got it the normal way.
function convergedGuild(seed) {
  const net = createGuildNet({ seed });
  const store = guildStore({ now: net.now() });
  const cs = ['Grommash', 'Saurfang', 'Zuljin', 'Varok'].map((n, i) => quiet(net.client(n, { rank: i < 2 ? 1 : 3, savedVariables: sharedDb(store), inbox: { me: { pid: `${n}.aaaa` } } }).login()));
  net.run(600);
  const sneaky = net.client('Sneaky', { rank: 3, inbox: { me: { pid: 'Sneaky.s000' } } }).login();
  quiet(sneaky);
  net.run(900);
  assert.ok(net.converged(), 'the guild converged, Sneaky included');
  return { net, store, cs, sneaky };
}
const zeroHello = SJ.encodeHello({ minor: 1, count: 0, digests: new Array(SJ.K.BUCKETS).fill(0), addon: '0.11.0' });

// Messages the guild (everyone but Sneaky) sent since the last resetStats.
const guildSent = (net) => Object.entries(net.stats().perSender).filter(([n]) => n !== 'Sneaky').reduce((a, [, v]) => a + v.sent, 0);

// Sneaky's made-up hellos: `buckets` of the 48 digests random (the others equal to the store's), one every `every` s
// for 10 minutes. → { inventories, sent, late } (late: inventory messages sent after the first `quietAfter` s).
function madeUpHellos(seed, { buckets, every, quietAfter }) {
  const { net, cs, sneaky } = convergedGuild(seed);
  const real = cs[0].lua('local out = {} for b = 0, 47 do out[b + 1] = ns.Share._.digestValue(b) end return out');
  let x = 12345 + seed;
  const rnd = () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; };
  net.resetStats();
  const t0 = net.now();
  for (let i = 0; i < 600 / every; i++) {
    const digests = real.slice();
    const order = digests.map((_, b) => b);
    for (let j = order.length - 1; j > 0; j--) {
      const k = Math.floor(rnd() * (j + 1));
      [order[j], order[k]] = [order[k], order[j]];
    }
    for (const b of order.slice(0, buckets)) digests[b] = 1 + Math.floor(rnd() * (SJ.K.DIGEST_MOD - 1));
    send(sneaky, SJ.encodeHello({ minor: 1, count: 1400, digests, addon: '0.11.0' }));
    net.run(every);
  }
  net.run(60);
  noErrors(net);
  const invs = net.log.filter((e) => e.type === '1I' && e.status === 'sent' && e.t >= t0);
  return { inventories: invs.length, sent: net.stats().sent, late: invs.filter((e) => e.t >= t0 + quietAfter).length };
}

test('trust-4: Sneaky sends a hello with made-up digests in every bucket each minute; the guild answers the first few, then nobody', () => {
  // Each answered one costs an inventory of the store (~100 messages, shared by the guild); without the per-guildmate
  // answer budget, 10 cost about 1,000.
  const r = madeUpHellos(10, { buckets: SJ.K.BUCKETS, every: 60, quietAfter: 180 });
  assert.ok(r.inventories < 320, `${r.inventories} inventory messages for 10 made-up hellos`);
  assert.equal(r.late, 0, 'from the fourth hello on, nobody answers');
  assert.ok(r.sent < 340, `${r.sent} messages in 11 minutes`);
});

test('trust-4: Sneaky sends hellos with made-up digests in 20 buckets (no more than a catch-up differs in) every 30 s; the guild answers the first few, then nobody', () => {
  // Without the answer budget, about 830 inventory messages in these 11 minutes.
  const r = madeUpHellos(11, { buckets: 20, every: 30, quietAfter: 300 });
  assert.ok(r.inventories < 320, `${r.inventories} inventory messages for 20 made-up hellos`);
  assert.equal(r.late, 0, 'after 5 minutes, nobody answers');
});

// One of Sneaky's hellos every 10 minutes, `rounds` times: hello(r) is round r's; then(r) runs 5 minutes in.
// → inventory messages the guild sent in each round.
function inventoryRounds(net, sneaky, { rounds, hello, then }) {
  const out = [];
  for (let r = 0; r < rounds; r++) {
    const from = net.log.length;
    const start = net.now();
    send(sneaky, hello(r));
    net.run(300);
    if (then) then(r);
    net.run(Math.max(0, start + 600 - net.now()));
    out.push(net.log.slice(from).filter((e) => e.type === '1I' && e.status === 'sent' && e.from !== 'Sneaky').length);
  }
  return out;
}
// The most of `rounds` with an inventory round (over 20 inventory messages) within any 2 hours (12 rounds).
const mostIn2h = (rounds) => {
  let most = 0;
  for (let i = 0; i < rounds.length; i++) most = Math.max(most, rounds.slice(i, i + 12).filter((n) => n > 20).length);
  return most;
};

test('trust-4: Sneaky sends a hello with new made-up digests in every bucket every 10 minutes for 2.5 hours; the guild answers at most 4 of them in any 2 hours (a guildmate back after a while needs one, or two when the first was lost)', () => {
  const { net, sneaky } = convergedGuild(9);
  let x = 777;
  const rnd = () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; };
  const rounds = inventoryRounds(net, sneaky, {
    rounds: 15,
    hello: () => SJ.encodeHello({ minor: 1, count: 1400, digests: new Array(SJ.K.BUCKETS).fill(0).map(() => 1 + Math.floor(rnd() * (SJ.K.DIGEST_MOD - 1))), addon: '0.11.0' }),
  });
  // Without the limit, an inventory round of the store every time: about 110 messages per 10 minutes.
  assert.ok(mostIn2h(rounds) <= 4, `inventory messages per round: ${rounds.join(', ')}`);
  noErrors(net);
});

test('trust-4: Sneaky repeats one made-up hello every 10 minutes for 2.5 hours, each time asking every guildmate for one record of each bucket he hasn\'t asked them for (a first-time G clears the repeat guard); the inventory round comes back at most 4 times in any 2 hours', () => {
  const { net, cs, sneaky } = convergedGuild(22);
  const hello = SJ.encodeHello({ minor: 1, count: 1400, digests: new Array(SJ.K.BUCKETS).fill(0).map((_, b) => 5000 + b * 13), addon: '0.11.0' });
  const asked = new Set();
  const rounds = inventoryRounds(net, sneaky, {
    rounds: 15,
    hello: () => hello,
    then: () => {
      for (const c of cs) {
        const all = c.lua('local X = ns.Share._.X(); local out = {} for b = 0, 47 do local l = {} for id in pairs(X.inB[b]) do l[#l + 1] = X.sidOf[id] end table.sort(l) out[b + 1] = l end return out');
        const sids = [];
        for (const l of all) {
          const s = (l || []).find((sid) => !asked.has(`${c.name}:${sid}`));
          if (s) { asked.add(`${c.name}:${s}`); sids.push(s); }
        }
        for (const m of SJ.encodeGet(c.name, sids)) { send(sneaky, m); net.run(1.1); }
      }
    },
  });
  // Without the limit, an inventory round every time (about 100 inventory messages).
  assert.ok(mostIn2h(rounds) <= 4, `inventory messages per round: ${rounds.join(', ')}`);
  noErrors(net);
});

test('trust-4: Sneaky repeats a made-up hello shaped like a catch-up (made-up digests in 23 buckets, count 0) every 10 minutes; once two guildmates have answered it, nobody does until the 2-hour guard ends (a catch-up whose answer was lost still gets one more)', () => {
  const { net, cs, sneaky } = convergedGuild(21);
  const digests = cs[0].lua('local out = {} for b = 0, 47 do out[b + 1] = ns.Share._.digestValue(b) end return out');
  for (let b = 0; b < 23; b++) digests[b * 2] = 1000 + b * 7;
  const hello = SJ.encodeHello({ minor: 1, count: 0, digests, addon: '0.11.0' });
  const rounds = inventoryRounds(net, sneaky, { rounds: 12, hello: () => hello });
  // Each guildmate answering it in turn kept the guild answering it for 70 to 130 minutes.
  assert.ok(rounds.slice(4).every((n) => n === 0), `inventory messages per round: ${rounds.join(', ')}`);
  noErrors(net);
});

// Records (R, and M records by their first part) `who` sent in log entries from `from` on.
function recordsSent(net, who, from) {
  let n = 0;
  for (const e of net.log.slice(from)) {
    if (e.from !== who || e.status !== 'sent') continue;
    if (e.type === '1R') n += e.text.slice(2).split('#').length;
    else if (e.type === '1M') { const p = SJ.parseParts(e.text); if (p && p.part === 1) n++; }
  }
  return n;
}

test('trust-4: Sneaky asks Grommash for the whole store with G requests every 10 minutes for 2 hours and more; after the first round Grommash sends at most 64 records again in each 10 minutes, also past the 2-hour mark (the whole store doesn\'t go out again)', () => {
  const { net, cs, sneaky } = convergedGuild(9);
  const sids = cs[0].lua('local X = ns.Share._.X(); local out = {} for _, sid in pairs(X.sidOf) do out[#out + 1] = sid end table.sort(out) return out');
  const gets = SJ.encodeGet('Grommash', sids);
  const rounds = [];
  // 14 rounds: records sent in the first one were last sent 2 hours before rounds 12 and 13. While he keeps asking,
  // they stay "sent again" (without that, rounds 12 and 13 sent about 370 and 140 messages).
  for (let round = 0; round < 14; round++) {
    const from = net.log.length;
    for (const m of gets) { send(sneaky, m); net.run(1.1); }
    net.run(600 - gets.length * 1.1);
    rounds.push(recordsSent(net, 'Grommash', from));
  }
  // The first round sends what he asks for (he never asked before), as far as the reply queue holds (QUEUE_MAX);
  // without a budget every round did (about 430 records, 330 messages).
  assert.ok(rounds[0] > 300, `the first round: ${rounds[0]} records`);
  assert.ok(rounds.slice(1).every((n) => n <= 64), `records per 10 minutes: ${rounds.join(', ')}`);
  noErrors(net);
});

test('trust-4: Varok comes back after days away and catches up; his game crashes before saving, and when he logs in again within the 2-hour guard he still catches up within 20 minutes', () => {
  const net = createGuildNet({ seed: 14 });
  const store = guildStore({ now: net.now() });
  const want = digestsOf(store);
  // Varok's saved store lacks 4 in 10 records, in nearly every bucket: his hello differs in most of them.
  const old = store.filter((_, i) => i % 10 >= 4);
  const cs = ['Grommash', 'Saurfang', 'Zuljin', 'Thrallia'].map((n, i) => quiet(net.client(n, { rank: i < 2 ? 1 : 3, savedVariables: sharedDb(store), inbox: { me: { pid: `${n}.aaaa` } } }).login()));
  net.run(300);
  const varok = quiet(net.client('Varok', { rank: 3, savedVariables: sharedDb(old), inbox: { me: { pid: 'Varok.v000' } } }).login());
  assert.ok(net.runUntil(() => varok.digests() === want, { max: 1800, step: 10 }), 'Varok caught up');
  net.run(120);
  varok.crash(); // nothing of this session is saved
  net.run(60);
  varok.login();
  quiet(varok);
  assert.notEqual(varok.digests(), want, 'back with his old store');
  // His hello is the same as the first, and every guildmate's I for it is under the repeat guard (the same I sent by
  // one counts for all, so they no longer answer in turn). His own inventories, answering their hellos (the beacon),
  // still make them push what he lacks.
  const start = net.now();
  assert.ok(net.runUntil(() => varok.digests() === want, { max: 1800, step: 10 }), 'Varok caught up again');
  assert.ok(net.now() - start <= 1200, `within 20 minutes: ${((net.now() - start) / 60).toFixed(1)} min`);
  assert.ok(cs.every((c) => c.online));
  noErrors(net);
});

test('trust-4: Sneaky follows each all-zero hello with a G for one record of every bucket from each guildmate; such a refill counts as unused, so after the second one his all-zero hellos are not answered for 30 minutes', () => {
  const { net, cs, sneaky } = convergedGuild(13);
  // Inventory messages the guild sent for one all-zero hello, after which he asks for one record per bucket.
  const round = (ask) => {
    const from = net.log.length;
    send(sneaky, zeroHello);
    net.run(300);
    const n = net.log.slice(from).filter((e) => e.type === '1I' && e.status === 'sent' && e.from !== 'Sneaky').length;
    if (ask) {
      for (const c of cs) {
        const sids = c.lua('local X = ns.Share._.X(); local out = {} for b = 0, 47 do for id in pairs(X.inB[b]) do out[#out + 1] = X.sidOf[id]; break end end table.sort(out) return out');
        for (const m of SJ.encodeGet(c.name, sids)) { send(sneaky, m); net.run(1.1); }
      }
    }
    net.run(420);
    return n;
  };
  const counts = [round(true), round(true), round(false), round(false)];
  // 48 of his 1,400 records asked for is no use of a refill. The first unused one is free (a game may crash before it
  // could ask), the second makes him wait 30 minutes. (Counted as used, he got an inventory round every time.)
  assert.ok(counts[0] > 0 && counts[0] < 200, `a refill: ${counts.join(', ')}`);
  assert.ok(counts[1] < 200, `at most one more: ${counts.join(', ')}`);
  assert.deepEqual(counts.slice(2), [0, 0], `then none for 30 minutes: ${counts.join(', ')}`);
  noErrors(net);
});

test('trust-4: a catch-up hello of a guildmate who holds fewer records, whose inventory answer was lost, is answered once more within the 2-hour repeat guard (scenario 9 with loss)', () => {
  const net = createGuildNet({ seed: 12 });
  const t0 = net.now();
  // Two notices in one bucket (an officer bucket: only Grommash may serve it). Newbie holds the first only.
  const notices = [];
  const byBucket = new Map();
  for (let i = 0; notices.length < 2 && i < 5000; i++) {
    const key = `n${i.toString(36).padStart(5, '0')}`;
    const b = SJ.bucket(`AN:${key}`);
    const list = byBucket.get(b) || byBucket.set(b, []).get(b);
    list.push(key);
    if (list.length === 2) for (const k of list) notices.push(makeRecord({ type: 'AN', key: k, t: t0 - 3600, author: 'Grommash', fields: { body: `Notice ${k}` } }));
  }
  const [first, second] = notices;
  const secondId = second.slice(0, second.indexOf('^'));
  quiet(net.client('Grommash', { rank: 1, savedVariables: sharedDb(notices) }).login());
  net.run(60);
  // The first inventory Grommash sends to answer Newbie is lost on the way.
  let dropped = 0;
  const deliver = net._deliver;
  net._deliver = function (r, target, m, sender, from) {
    if (from === 'Grommash' && r.name === 'Newbie' && m.bytes.toString('latin1', 0, 2) === '1I' && dropped === 0) { dropped++; return; }
    return deliver.call(this, r, target, m, sender, from);
  };
  const nb = quiet(net.client('Newbie', { rank: 3, savedVariables: sharedDb([first]) }).login());
  net.run(60);
  assert.equal(dropped, 1, 'the inventory answering Newbie\'s login hello was lost');
  assert.equal(recOf(nb, secondId), null);
  // Two minutes later Newbie says hello again (a catch-up): one bucket differs, as before.
  net.run(60);
  nb.lua('ns.ShareSync.sendHello(true)');
  net.run(60);
  assert.ok(recOf(nb, secondId), 'Grommash answered the catch-up and Newbie got the notice');
  noErrors(net);
});

// ------------------------------------------------------------------------------------------------- addon-1
// GetGuildInfo("player") gives nothing for a while after login (or a guild invite) on the real client, while
// IsInGuild() is already true and the roster has come in. Here it gives nothing while __lateGuild is true.
const LATE_GUILD = `
local realGGI = GetGuildInfo
__lateGuild = false
GetGuildInfo = function(unit)
  if __lateGuild then return nil end
  return realGGI(unit)
end
`;
const state = (c) => c.lua('return { ready = ns.Share.ready(), open = ns.Share._.P() ~= nil, gkey = ns.Share._.gkey() or false }');
const hellosFrom = (net, name) => net.log.filter((e) => e.from === name && e.type === '1H' && e.status === 'sent').length;

test('addon-1: the guild name comes a few seconds after login; sharing starts once it does, with the login hello', () => {
  const net = createGuildNet({ seed: 7 });
  const thr = net.client('Thrallia', { rank: 3 }).login();
  net.run(60);
  const zul = net.client('Zuljin', { rank: 3, mocks: `${LATE_GUILD}\n__lateGuild = true` }).login();
  net.run(5); // the roster came in (0.3 s and 2 s after login); the name still hasn't
  assert.deepEqual(state(zul), { ready: false, open: false, gkey: false }, 'not ready without the guild\'s name');
  zul.lua('__lateGuild = false'); // no event comes with it: the retry finds it
  net.run(10);
  assert.deepEqual(state(zul), { ready: true, open: true, gkey: 'Forever/wow' });
  assert.ok(net.runUntil(() => hellosFrom(net, 'Zuljin') > 0, { max: 60 }), 'Zuljin said hello');
  assert.ok(net.runUntil(() => net.converged(), { max: 300, step: 5 }), 'and converged with Thrallia');
  assert.ok(thr.online);
  noErrors(net);
});

test('addon-1: Zuljin leaves "wow" and joins "Rivals", whose name comes late; sharing moves to Rivals with a hello, nothing queued for "wow" goes to Rivals, and back in "wow" the app\'s change goes out', () => {
  const net = createGuildNet({ seed: 8 });
  const thr = quiet(net.client('Thrallia', { rank: 3 }).login());
  const notice = makeRecord({ type: 'AN', key: 'rv0001', t: net.now() - 3600, author: 'Garrosh', fields: { body: 'Rivals raid Friday' } });
  const rival = quiet(net.client('Garrosh', { rank: 0, guild: 'Rivals', savedVariables: sharedDb([notice], { guildKey: 'Forever/Rivals' }) }).login());
  // The app has a change for "wow" in Zuljin's outbox; he is in a fight from the moment he logs in.
  const lp = 'lp:Zuljin.a8x2:Zuljin';
  const zul = net.client('Zuljin', { rank: 3, mocks: LATE_GUILD, inbox: { me: { pid: 'Zuljin.a8x2' }, outbox: [
    { op: 'o1', g: 'Forever/wow', id: lp, t: net.now(), body: SJ.encodeBody('lp', 'Zuljin.a8x2:Zuljin', { character: 'Zuljin', level: 60, zone: 'Tanaris', when: 'now' }) },
  ] } }).login();
  zul.setCombat(true);
  quiet(zul);
  net.run(120);
  assert.equal(state(zul).gkey, 'Forever/wow');
  const sentOf = (op) => zul.lua(`return ns.Share._.P().sent[${toLua(op)}] or false`);
  assert.equal(sentOf('o1'), false, 'the app\'s change waits in his queue');
  // Still in the fight, Zuljin calls to arms in "wow": it waits in his queue too.
  zul.lua('SlashCmdList.WOWGUILD("cta Crossroads 3 help")');
  net.run(2);
  const ca = zul.lua('local out; for id in pairs(ns.Share._.P().recs) do if id:sub(1, 3) == "ca:" then out = id end end return out');
  assert.ok(ca, 'the call to arms is stored in wow');
  // He leaves the guild ...
  zul.guild = null;
  net._rosterChanged();
  zul.lua('__player.guild = nil');
  zul.fire('PLAYER_GUILD_UPDATE', 'player');
  net.run(15);
  assert.equal(state(zul).ready, false);
  assert.deepEqual(zul.lua('return { scanned = ns.Share._.debug().rosterScanned, thrallia = ns.Share._.rankOf("Thrallia") or false }'),
    { scanned: false, thrallia: false }, 'wow\'s roster no longer counts once he left');
  // ... and accepts an invite to Rivals; the game gives the new guild's name only a few seconds later.
  zul.lua('__lateGuild = true; __player.guild = "Rivals"');
  zul.guild = 'Rivals';
  net._rosterChanged();
  zul.fire('PLAYER_GUILD_UPDATE', 'player');
  net.run(5);
  assert.equal(state(zul).ready, false, 'not ready before the new guild\'s name');
  zul.lua('__lateGuild = false');
  net.run(10);
  assert.deepEqual(state(zul), { ready: true, open: true, gkey: 'Forever/Rivals' });
  zul.setCombat(false);
  const before = hellosFrom(net, 'Zuljin');
  assert.ok(net.runUntil(() => hellosFrom(net, 'Zuljin') > before, { max: 60 }), 'Zuljin said hello in Rivals');
  net.run(120);
  assert.equal(recOf(rival, ca), null, 'the call to arms queued in wow never reached Rivals');
  assert.ok(!net.log.some((e) => e.from === 'Zuljin' && e.text && e.text.includes(ca) && e.status === 'sent'), 'nor went out at all');
  assert.ok(recOf(zul, 'AN:rv0001'), 'Zuljin got the Rivals notice');
  assert.equal(zul.digests(), rival.digests(), 'Zuljin and Garrosh hold the same Rivals store');
  assert.equal(recOf(rival, lp), null, 'the app\'s change for wow stayed out of Rivals');
  // He goes back to "wow": the app's change, cleared from his queue unsent, goes out there now.
  zul.guild = null;
  net._rosterChanged();
  zul.lua('__player.guild = nil');
  zul.fire('PLAYER_GUILD_UPDATE', 'player');
  net.run(15);
  zul.lua('__player.guild = "wow"');
  zul.guild = 'wow';
  net._rosterChanged();
  zul.fire('PLAYER_GUILD_UPDATE', 'player');
  assert.ok(net.runUntil(() => /^ok,/.test(sentOf('o1') || ''), { max: 120 }), 'the app\'s change went out in wow');
  assert.ok(net.runUntil(() => Boolean(recOf(thr, lp)), { max: 60 }), 'and Thrallia has it');
  assert.ok(thr.online);
  noErrors(net);
});

test('addon-1: Zuljin is in "Rivals" without the game ever saying he left "wow" (both during a loading screen); sharing moves to Rivals with Rivals\' roster', () => {
  const net = createGuildNet({ seed: 9 });
  const thr = quiet(net.client('Thrallia', { rank: 3 }).login());
  const notice = makeRecord({ type: 'AN', key: 'rv0002', t: net.now() - 3600, author: 'Garrosh', fields: { body: 'Rivals raid Friday' } });
  const rival = quiet(net.client('Garrosh', { rank: 0, guild: 'Rivals', savedVariables: sharedDb([notice], { guildKey: 'Forever/Rivals' }) }).login());
  const zul = quiet(net.client('Zuljin', { rank: 3 }).login());
  net.run(120);
  assert.equal(state(zul).gkey, 'Forever/wow');
  assert.equal(zul.lua('return ns.Share._.rankOf("Thrallia")'), 3);
  zul.lua('__player.guild = "Rivals"');
  zul.guild = 'Rivals';
  net._rosterChanged();
  const before = hellosFrom(net, 'Zuljin');
  zul.fire('PLAYER_GUILD_UPDATE', 'player');
  net.run(15);
  assert.deepEqual(state(zul), { ready: true, open: true, gkey: 'Forever/Rivals' });
  assert.deepEqual(zul.lua('return { thrallia = ns.Share._.rankOf("Thrallia") or false, garrosh = ns.Share._.rankOf("Garrosh") or false }'),
    { thrallia: false, garrosh: 0 }, 'the ranks are Rivals\'');
  assert.ok(net.runUntil(() => hellosFrom(net, 'Zuljin') > before, { max: 60 }), 'Zuljin said hello in Rivals');
  assert.ok(net.runUntil(() => Boolean(recOf(zul, 'AN:rv0002')), { max: 300, step: 5 }), 'Zuljin got the Rivals notice');
  assert.ok(net.runUntil(() => zul.digests() === rival.digests(), { max: 300, step: 5 }), 'Zuljin and Garrosh hold the same Rivals store');
  assert.ok(thr.online);
  noErrors(net);
});

test('addon-1: Bob has no player id yet and moves from "wow" to "Rivals" 70 s into the 90 s wait for guildmates\' copies; Rivals gets its own 90 s, so a copy of his alt\'s ch that comes 40 s in still gives him the id', () => {
  const net = createGuildNet({ seed: 10 });
  net.member('Bobalt', { rank: 3, guild: 'Rivals' }); // his alt, in Rivals, played on his other PC
  const mate = quiet(net.client('Rivalmate', { rank: 3, guild: 'Rivals', inbox: { me: { pid: 'Rivalmate.r1r1' } } }).login());
  quiet(net.client('Thrallia', { rank: 3, inbox: { me: { pid: 'Thrallia.p4m7' } } }).login());
  // No inbox and no id anywhere; Bobalt is a character of this account.
  const bob = quiet(net.client('Bob', { rank: 3, savedVariables: { characters: { Bobalt: { name: 'Bobalt', realm: 'Forever', guild: 'Rivals' } } } }).login());
  net.run(70);
  assert.equal(state(bob).gkey, 'Forever/wow');
  assert.equal(bob.lua('return ns.Share.myPid()'), null, 'still waiting in wow');
  bob.lua('__player.guild = "Rivals"');
  bob.guild = 'Rivals';
  net._rosterChanged();
  bob.fire('PLAYER_GUILD_UPDATE', 'player');
  net.run(5);
  assert.equal(state(bob).gkey, 'Forever/Rivals');
  net.run(25); // past the end of wow's wait
  assert.equal(bob.lua('return ns.Share.myPid()'), null, 'Rivals waits its own 90 s');
  const ch = makeRecord({ type: 'ch', key: 'Bobalt', fields: { pid: 'Bobalt.q1w2', main: true, alts: ['Bobalt', 'Bob'] }, t: net.now() - 3600, author: 'Bobalt' });
  send(mate, `1R${ch}`); // Rivalmate passes it on
  net.run(90);
  assert.equal(bob.lua('return ns.Share.myPid()'), 'Bobalt.q1w2', 'the id his other PC uses in Rivals');
  noErrors(net);
});

// ------------------------------------------------------------------------------------------------- addon-2, addon-3
test('addon-2: when the sharing files didn\'t load after an update, /wow cta and /wow share ask for a game restart, not a /reload', () => {
  const net = createGuildNet({ seed: 3 });
  const c = net.client('Thrallia', { rank: 3 }).login();
  net.run(5);
  c.lua('ns.Share = nil; ns.ShareCodec = nil');
  const from = c.chat.length;
  c.lua('SlashCmdList.WOWGUILD("cta Crossroads 2 help")');
  c.lua('SlashCmdList.WOWGUILD("share")');
  const lines = c.chat.slice(from);
  assert.equal(lines.length, 2, lines.join('\n'));
  for (const l of lines) {
    assert.match(l, /Restart World of Warcraft to finish the addon update\. A \/reload isn't enough\./);
    assert.doesNotMatch(l, /Type \/reload/);
  }
  noErrors(net);
});

for (const iface of [16001, 120105]) {
  test(`addon-3: the problem report shows the game build and interface (${iface}), not "nil"`, () => {
    const net = createGuildNet({ seed: 4 });
    const c = net.client('Thrallia', { rank: 3, interface: iface }).login();
    net.run(5);
    const [version, build, , ifc] = c.lua('return { GetBuildInfo() }');
    const report = c.lua('return ns.diagnostics()');
    const line = report.split('\n').find((l) => l.startsWith('game build:'));
    assert.equal(line, `game build: ${version} (${build}) interface ${ifc} project ${c.lua('return WOW_PROJECT_ID')}`);
    assert.equal(ifc, iface);
    assert.doesNotMatch(line, /nil/);
  });
}

// ------------------------------------------------------------------------------------------------- known issue 7
test('known issue 7: no addon file says data goes to a guild server (there is none: the app and guildmates\' games)', () => {
  for (const f of fs.readdirSync(ADDON).filter((n) => n.endsWith('.lua'))) {
    const text = fs.readFileSync(path.join(ADDON, f), 'utf8');
    assert.doesNotMatch(text, /guild server/i, f);
  }
});
