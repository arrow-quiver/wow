#!/usr/bin/env node
'use strict';
// Writes test/fixtures/sharing-vectors.json: golden vectors made by app/src/shared/sharing.js.
// sharing-codec.test.js checks that sharing.js still makes exactly these bytes and that
// addon/WowGuild/ShareCodec.lua (fengari, and a real Lua 5.1 when available) makes them too.
// Run after a deliberate codec change:   node test/fixtures/make-sharing-vectors.js
// The output is deterministic (no clock, no randomness).

const fs = require('fs');
const path = require('path');
const S = require('../../src/shared/sharing');
const { dump } = require('./sharing-lua');

const NOW = 1794067200;
const D = S.K.DAY;
const OUT = path.join(__dirname, 'sharing-vectors.json');

const v = (t, author, final) => S.makeVersion(t, author, final);
const strip = (x) => JSON.parse(JSON.stringify(x === undefined ? null : x));

// Every byte that must be escaped, plus UTF-8 that must pass through.
const ALL_ESCAPED = Array.from({ length: 32 }, (_, i) => String.fromCharCode(i)).join('') + '\x7f~^;,#|';
const UTF8 = 'Zulé Ærøn 東京 😀';

// ------------------------------------------------------------------------------- records
const inputs = [];
const add = (name, input, opts = {}) => inputs.push({ name, input, now: opts.now || NOW, lookup: opts.lookup || null });
const rec = (type, key, t, author, fields, extra = {}) => Object.assign({ type, key, v: v(t, author, !!extra.final), author, del: !!extra.del, fields }, extra.raw ? { raw: extra.raw } : {});

add('spec RD example', rec('RD', 'k3f9a2', 1794066000, 'Grommash', { kind: 'r', title: 'Molten Core Thursday', instance: 'Molten Core', startsAt: 1794358800, minutes: 180, size: 40, srLimit: 2, notes: 'Bring fire resist' }));
add('spec RT close example', { type: 'RT', key: 'k3f9a2', v: 'wzltl343', author: 'Grommash', fields: { status: 'd', lockedAt: 1794355200, kind: 'r', instance: '4kq1zm', closedAt: 1794373200, attendees: [{ pid: 'Thrallia.p4m7', items: ['d72', 'eim'] }, { pid: 'Zuljin.a8x2', items: ['eim'] }], noShows: ['Varok.7tq3'] } }, { now: 1794373300 });
add('spec ca example', rec('ca', 'x8k2pq', 1794068400, 'Thrallia', { character: 'Thrallia', zone: 'Crossroads', needed: 5, message: 'Alliance at the flight master' }), { now: 1794068400 });
add('ch full', rec('ch', 'Thrallia', NOW - 60, 'Thrallia', {
  pid: 'Thrallia.p4m7', battletag: 'Calvin#1234', main: true, alts: ['Thrallia', 'Zuljinne', 'Zulé'], class: 'Shaman', race: 'Orc', level: 60,
  faction: 'Horde', ilvl: 62, repair: 87, consumables: { flask: 2, elixir: 0, potion: 12, food: 20, bandage: 0 },
  professions: [{ skill: 164, rank: 300, max: 300 }, { skill: 186, rank: 275, max: 300 }], pvp: { rank: 7, hk: 1234 }, addon: '0.12.0',
}));
add('ch with raid readiness', rec('ch', 'Thrallia', NOW - 60, 'Thrallia', {
  pid: 'Thrallia.p4m7', class: 'Shaman', level: 60, ilvl: 62, repair: 87, addon: '0.12.0',
  talents: { a: 0, b: 21, c: 30 }, resists: { fire: 135, nature: 0, frost: 15, shadow: 42, arcane: 10 }, unenchanted: [9, 15],
}));
add('ch alt, sparse', rec('ch', 'Zuljinne', NOW - 60, 'Zuljinne', { pid: 'Thrallia.p4m7', level: 12, consumables: { potion: 3 }, pvp: {} }));
add('ch non-ASCII name', rec('ch', 'Zulé', NOW - 60, 'Zulé', { pid: 'Thrallia.p4m7', class: 'Mage', level: 60 }));
add('ch over the list limit', rec('ch', 'Thrallia', NOW - 60, 'Thrallia', { pid: 'Thrallia.p4m7', alts: Array.from({ length: 30 }, (_, i) => `Alt${i}`) }));
add('rc spell ids', rec('rc', 'Thrallia:4k', NOW - 60, 'Thrallia', { kind: 's', count: 6, list: [2660, 2661, 2662, 2663, 3115, 9811, 2660] }));
add('rc item ids', rec('rc', 'Thrallia:4k', NOW - 60, 'Thrallia', { kind: 'i', count: 3, list: [17102, 2589, 0] }));
add('rc names', rec('rc', 'Thrallia:5h', NOW - 60, 'Thrallia', { kind: 'n', count: 3, list: ['Linen Bandage', 'Heavy Silk; Bandage', 'Æther, cloth'] }));
add('rc empty', rec('rc', 'Thrallia:5h', NOW - 60, 'Thrallia', { kind: 's', count: 0, list: [] }));
add('su with reserves', rec('su', 'k3f9a2:Thrallia.p4m7', NOW - 60, 'Thrallia', { character: 'Thrallia', role: 'h', status: 'y', note: 'late 10 min', reserves: ['d72', 'eim'], reservesAt: NOW - 120, prev: ['d72'], prevAt: NOW - 3600 }));
add('su from the outbox example', rec('su', 'k3f9a2:Thrallia.p4m7', 1794067800, 'Thrallia', { character: 'Thrallia', role: 'h', status: 'y', note: 'late 10 min', reserves: ['d72', 'eim'], reservesAt: 1794067800 }), { now: 1794067800 });
add('su bench, no reserves', rec('su', 'k3f9a2:Zuljin.a8x2', NOW - 60, 'Zuljin', { character: 'Zuljin', role: 'd', status: 'b' }));
add('cr open', rec('cr', 'r1r1r1', NOW - 60, 'Thrallia', { pid: 'Thrallia.p4m7', item: 'Robe of the Archmage', notes: 'I bring the mats', state: 'o' }));
add('cr cancelled (final)', rec('cr', 'r1r1r1', NOW - 30, 'Thrallia', { pid: 'Thrallia.p4m7', item: 'Robe of the Archmage', state: 'x' }, { final: true }));
add('ek boss kill', rec('ek', 'e4e4e4', NOW - 95, 'Thrallia', { enc: 672, boss: 'Ragnaros', instance: 'Molten Core', at: NOW - 95, size: 40, names: ['Thrallia', 'Zuljinne', 'Jaina'] }));
add('mw mats wanted', rec('mw', 'Thrallia.p4m7', NOW - 85, 'Thrallia', { items: [{ id: 14342, qty: 4 }, { id: 2589, qty: 20 }] }));
add('ko added', rec('ko', 'Gankalot', NOW - 90, 'Thrallia', { pid: 'Thrallia.p4m7', reason: 'Camps the Crossroads', state: 'o' }));
add('kk bounty kill', rec('kk', 'k1k1k1', NOW - 80, 'Thrallia', { pid: 'Thrallia.p4m7', target: 'Gankalot', zone: 'The Barrens', at: NOW - 80, kos: 1, bounty: 'b2b2b2' }));
add('BT player bounty', rec('BT', 'b2b2b2', NOW - 70, 'Thrallia', { target: 'Gankalot', zone: '', points: 50, cap: 1, ends: NOW + 86400, note: 'Ganking lowbies', state: 'o' }));
add('bb selling', rec('bb', 'b1b1b1', NOW - 60, 'Thrallia', { pid: 'Thrallia.p4m7', character: 'Thrallia', kind: 's', text: 'Mooncloth, 4 left', price: 125000, state: 'o' }));
add('bb taken down (final)', rec('bb', 'b1b1b1', NOW - 30, 'Thrallia', { pid: 'Thrallia.p4m7', character: 'Thrallia', kind: 's', text: 'Mooncloth, 4 left', state: 'x' }, { final: true }));
add('cr done (final)', rec('cr', 'r1r1r1', NOW - 30, 'Thrallia', { pid: 'Thrallia.p4m7', item: 'Robe of the Archmage', state: 'd' }, { final: true }));
add('cl claim', rec('cl', 'r1r1r1:Zuljin.a8x2', NOW - 60, 'Zuljin', { state: 'c', claimedAt: NOW - 60 }));
add('lp partner post', rec('lp', 'Thrallia.p4m7:Zuljinne', NOW - 60, 'Zuljinne', { character: 'Zuljinne', level: 24, zone: 'Stranglethorn Vale', when: 'tonight 8pm', note: 'questing; anyone?' }));
add('dg dungeon group', rec('dg', 'dg1grp', NOW - 60, 'Thrallia', { pid: 'Thrallia.p4m7', character: 'Thrallia', dungeon: 'The Deadmines', startsAt: NOW + 3600, role: 'h', level: 20, tank: 1, heal: 1, dps: 3, note: 'quest run; bring VC quests', state: 'o' }));
add('dg with guests', rec('dg', 'dg1grp', NOW - 40, 'Thrallia', { pid: 'Thrallia.p4m7', character: 'Thrallia', dungeon: 'The Deadmines', startsAt: NOW + 3600, role: 'h', tank: 1, heal: 1, dps: 3, state: 'o', guests: [{ name: 'Brokk-Mirage', role: 't', class: 'WARRIOR', level: 21 }, { name: 'Zulé', role: 'd' }] }));
add('dg cancelled (final)', rec('dg', 'dg1grp', NOW - 30, 'Thrallia', { pid: 'Thrallia.p4m7', character: 'Thrallia', dungeon: 'The Deadmines', startsAt: NOW + 3600, role: 'h', state: 'x' }, { final: true }));
add('dj join', rec('dj', 'dg1grp:Zuljin.a8x2', NOW - 50, 'Zuljin', { character: 'Zuljin', role: 't', status: 'y', class: 'Warrior', level: 21, joinedAt: NOW - 50 }));
add('dc hand-in', rec('dc', 'h4nd1n', NOW - 60, 'Thrallia', { pid: 'Thrallia.p4m7', drive: 'dr1v3x', character: 'Thrallia', amount: 40, note: 'Linen' }));
add('bq open', rec('bq', 'b4nkrq', NOW - 60, 'Thrallia', { pid: 'Thrallia.p4m7', item: 'Runecloth', count: 20, note: 'for bandages', state: 'o' }));
add('bq cancelled (final)', rec('bq', 'b4nkrq', NOW - 30, 'Thrallia', { pid: 'Thrallia.p4m7', item: 'Runecloth', count: 20, state: 'x' }, { final: true }));
add('gb tab 0', rec('gb', '0', NOW - 60, 'Zuljinne', {
  scannedAt: NOW - 60, money: 123456789, tabs: ['Mats', 'Gear; misc', 'Ränge'],
  log: [{ at: NOW - 7200, kind: 'deposit', who: 'Thrallia', item: 2589, count: 20 }, { at: NOW - 3600, kind: 'withdraw', who: 'Zulé', amount: 5000 }],
}));
add('gb tab 3', rec('gb', '3', NOW - 60, 'Zuljinne', { items: [{ id: 2589, count: 200 }, { id: 4306, count: 40 }, { id: 0, count: 5 }] }));
add('bk bank character', rec('bk', 'Bankalt', NOW - 60, 'Bankalt', { bags: [{ id: 2589, count: 20 }], bank: [{ id: 14047, count: 100 }, { id: 4338, count: 60 }] }));
add('sh shopping list', rec('sh', 'Thrallia.p4m7', NOW - 60, 'Thrallia', { items: [{ name: 'Bolt of Silk Cloth', qty: 4, skill: 197 }, { name: 'Iron Bar', qty: 10, skill: 164 }] }));
add('ST store items', rec('ST', '1', NOW - 60, 'Thrallia', { items: [{ key: 'a1b2c3', item: 'Major Mana Potion', id: 13444, cost: 40, stock: 10 }, { key: 'd4e5f6', item: 'Runecloth Bag', id: 14046, cost: 120, stock: 2 }] }));
add('wm war marks', rec('wm', 'Thrallia.p4m7', NOW - 60, 'Thrallia', { marks: [{ map: 1424, x: 452, y: 381, at: NOW - 600, kind: 'd' }, { map: 1424, x: 460, y: 377, at: NOW - 300, kind: 'k', n: 2 }], maps: [{ id: 1424, name: 'Hillsbrad Foothills' }] }));
add('pr prices', rec('pr', 'Thrallia.p4m7', NOW - 60, 'Thrallia', { day: 20765, prices: [{ id: 2589, copper: 150 }, { id: 14047, copper: 2400 }] }));
add('RD pvp, no notes', rec('RD', 'pvp001', NOW - 60, 'Varok', { kind: 'p', title: 'Warsong Friday', instance: 'Warsong Gulch', startsAt: NOW + 3 * D, minutes: 120, size: 10, srLimit: 0 }));
add('RT locked (spec outbox body)', rec('RT', 'k3f9a2', 1794355200, 'Grommash', { status: 'l', lockedAt: 1794355200 }), { now: 1794355200 });
add('RT open again', rec('RT', 'k3f9a2', NOW - 30, 'Varok', { status: 'o' }));
add('RT cancelled (final)', rec('RT', 'k3f9a2', NOW - 30, 'Varok', { status: 'x' }, { final: true }));
add('LA award', rec('LA', 'aw4rd1', NOW - 60, 'Grommash', { raid: 'k3f9a2', instance: '2dv8n1', item: 'd72', itemName: 'Cloak of the Shrouded Mists', character: 'Thrallia', pid: 'Thrallia.p4m7', kind: 's', roll: 87, bonus: 20 }));
add('LL loot list', rec('LL', '2dv8n1', NOW - 60, 'Grommash', { name: 'Molten Core', bosses: ['Lucifron', 'Magmadar', 'Gehennas'], items: [{ item: 'd72', boss: 1, name: 'Cloak of the Shrouded Mists' }, { item: 'h0abcd', boss: 0, name: 'Trash, drop; any' }] }));
add('LY checkpoint', rec('LY', '2dv8n1', NOW - 60, 'Grommash', { upto: NOW - 30 * D, bonuses: [{ pid: 'Thrallia.p4m7', item: 'd72', bonus: 30 }, { pid: 'Zuljin.a8x2', item: 'eim', bonus: 10 }] }));
add('AN notice with every escape', rec('AN', 'q2w8zz', NOW - 60, 'Grommash', { body: `Raid ${ALL_ESCAPED} done ${UTF8}` }));
add('AN notice cut on a UTF-8 boundary', rec('AN', 'q2w8zz', NOW - 60, 'Grommash', { body: 'a'.repeat(499) + 'é' + 'b' }));
add('AN notice tombstone', rec('AN', 'q2w8zz', NOW - 30, 'Varok', null, { del: true }));
add('DR open', rec('DR', 'dr1v3x', NOW - 60, 'Grommash', { title: 'Bandages for Naxx', unit: 'Runecloth', goal: 2000, notes: 'Bank it with Bankalt', state: 'o' }));
add('DR closed (final)', rec('DR', 'dr1v3x', NOW - 30, 'Grommash', { title: 'Bandages for Naxx', unit: 'Runecloth', goal: 2000, state: 'c' }, { final: true }));
add('BH sent', rec('BH', 'b4nkrq', NOW - 60, 'Varok', { state: 's' }));
add('BC bank characters', rec('BC', '1', NOW - 60, 'Grommash', { names: ['Bankalt', 'Bänkalt'] }));
add('CFG no relay ranks', rec('CFG', '1', NOW - 60, 'Grommash', { officerRankMax: 1, relayRankMax: null }));
add('CFG relay rank 2', rec('CFG', '1', NOW - 60, 'Grommash', { officerRankMax: 1, relayRankMax: 2 }));
add('WH webhook', rec('WH', '1', NOW - 60, 'Varok', { url: 'https://discord.com/api/webhooks/123/abc_DEF-ghi' }));
add('ca shrunk to fit 300 bytes', rec('ca', 'big001', NOW - 60, 'Thrallia', { character: 'Thrallia', zone: 'Z'.repeat(60), needed: 5, message: `${'m'.repeat(150)}${';'.repeat(40)}` }));
add('ca shrunk, UTF-8', rec('ca', 'big002', NOW - 60, 'Zulé', { character: 'Zulé', zone: 'Ü'.repeat(30), needed: 1, message: '東'.repeat(66) }));
add('unknown member type kept raw', { type: 'zz', key: 'any:thing', v: v(NOW - 60, 'Thrallia'), author: 'Thrallia', raw: ['1', '', 'x~2Cy', ''] });
add('unknown officer type tombstone', { type: 'ZQ', key: '1', v: v(NOW - 60, 'Varok'), author: 'Varok', del: true });
add('expired call to arms', rec('ca', 'old001', NOW - 3 * D, 'Thrallia', { zone: 'Crossroads' }));
add('future call to arms', rec('ca', 'fut001', NOW + 3600, 'Thrallia', { zone: 'Crossroads' }));
add('ints: zero and big', rec('gb', '0', NOW - 60, 'Zuljinne', { scannedAt: 0, money: 3656158440062975 }));
add('ints: bad values written empty', rec('gb', '0', NOW - 60, 'Zuljinne', { scannedAt: -5, money: 3656158440062976, tabs: ['x'] }));

const records = inputs.map((c) => {
  const record = S.encode(c.input);
  const d = S.decode(record);
  const lookup = c.lookup ? (id) => c.lookup[id] || null : null;
  return {
    name: c.name, input: strip(c.input), record, now: c.now, lookup: c.lookup,
    dump: dump(d), reencode: d ? S.encode(d) : null, check: S.checkRecord(record, c.now, lookup), parseDump: dump(S.parse(record)),
    final: d ? S.isFinal(d) : false,
  };
});

// ------------------------------------------------------------------------------- bodies
const bodies = [
  ['su', 'k3f9a2:Thrallia.p4m7', { character: 'Thrallia', role: 'h', status: 'y', note: 'late 10 min', reserves: ['d72', 'eim'], reservesAt: 1794067800 }],
  ['RT', 'k3f9a2', { status: 'l', lockedAt: 1794355200 }],
  ['ca', 'big001', { character: 'Thrallia', zone: 'Z'.repeat(60), needed: 5, message: 'm'.repeat(200) }],
  ['ca', 'big001', { character: 'Thrallia', zone: 'Z'.repeat(60), needed: 5, message: 'm'.repeat(200) }, 'Thrallia'],
  ['AN', 'q2w8zz', { body: ALL_ESCAPED.repeat(20) }, 'Grommash'],
  ['WH', '1', { url: 'https://discord.com/api/webhooks/1/x' }],
  ['zz', 'any', { x: 1 }],
].map(([type, key, fields, author]) => ({ type, key, fields, author: author || null, body: S.encodeBody(type, key, fields, author) }));

// ------------------------------------------------------------------------------- primitives
const hashStrings = ['', 'a', 'Grommash', 'Thrallia', 'RD:k3f9a2', 'RD:k3f9a2#', UTF8, 'x'.repeat(300), ALL_ESCAPED];
const hashes = hashStrings.map((s) => ({ s, h: S.djb2(s) }));
const b36 = [0, 1, 35, 36, 1295, 1296, 17102, 1794066000, 114820224003, 2585160115203, 2821109907455, 3656158440062975, 1.0, 7.9, -1, 3656158440062976]
  .map((n) => ({ n, s: S.toB36(n), width: 8, pad: S.pad36(n, 8) }));
b36.push({ n: 46656, s: S.toB36(46656), width: 3, pad: S.pad36(46656, 3) });
const fromB36 = ['0', 'z', '10', 'd72', '1gqwzvur', 'wzltl343', 'zzzzzzzzzz', 'zzzzzzzzzzz', '', 'A', '-1', ' 1', '1.5'].map((s) => ({ s, n: S.fromB36(s) }));
const cuts = [['abcdef', 3], ['abé', 3], ['abé', 4], ['é', 1], ['😀x', 2], ['😀x', 4], ['😀x', 5], ['', 5], ['abc', 0]].map(([s, max]) => ({ s, max, out: S.cutUtf8(s, max) }));
const escCuts = [['a~3Bb', 1], ['a~3Bb', 2], ['a~3Bb', 3], ['a~3Bb', 4], ['a~3Bb', 5], ['é~2C', 1], ['é~2C', 3], ['~7E~7E', 4], ['abc', 9], ['', 0]].map(([s, max]) => ({ s, max, out: S.cutEscaped(s, max) }));
const escapes = [
  [ALL_ESCAPED], [UTF8], ['plain text'], ['~7E is not unescaped twice'], ['a'.repeat(10) + '~', 10], ['é~', 2], ['~~~~', 2], ['ab;cd', 4], [''],
].map(([s, max]) => { const escaped = S.escape(s, max); return { s, max: max === undefined ? null : max, escaped, unescaped: S.unescape(escaped) }; });
const unescapeBad = ['~', '~7', '~7e', '~G0', '~41', 'a,b', 'a;b', 'a^b', 'a#b', 'a|b', 'a\x01b', '~C3~A9'];
for (const s of unescapeBad) if (S.unescape(s) !== null) throw new Error(`unescape should refuse ${JSON.stringify(s)}`);
const varints = [
  [[], undefined], [[0], undefined], [[31], undefined], [[32], undefined], [[1023, 1024], undefined],
  [[2660, 2661, 2662, 2663, 3115, 9811, 2660], undefined], [[30000, 5, 5, 7.0, -3, 1.5], undefined],
  [[1099511627775], undefined], [[9, 8, 7, 6, 5, 4, 3, 2, 1], 4],
].map(([ids, maxItems]) => { const s = S.encodeIds(ids, maxItems); return { ids, maxItems: maxItems || null, s, decoded: dump(S.decodeIds(s)) }; });
const varintBad = ['W', 'a', '!', 'WWWWWWWWWWW0', '0 1'];
for (const s of varintBad) if (S.decodeIds(s) !== null) throw new Error(`decodeIds should refuse ${s}`);

const idList = ['RD:k3f9a2', 'RT:k3f9a2', 'ca:x8k2pq', 'ch:Zulé', 'WH:1', 'CFG:1', 'zz:any', 'ZZ:any', 'bad', 'Ab:x'];
const ids = idList.map((id, i) => {
  const b = S.bucket(id);
  const vv = v(NOW + i, 'Grommash');
  return { id, v: vv, bucket: b, shortId: S.shortId(id), term: S.digestTerm(id, vv), memberMayServe: S.mayServe(b, false) };
});
const dEntries = records.filter((r) => S.parse(r.record)).map((r) => S.parse(r.record)).map((p) => ({ id: p.id, v: p.v }));
const digestCase = (entries, removed) => {
  let sum = 0;
  let count = 0;
  for (const e of entries) { sum += S.digestTerm(e.id, e.v); count++; }
  for (const e of removed || []) { sum -= S.digestTerm(e.id, e.v); count--; }
  return { entries, removed: removed || [], sum, count, value: S.digestValue(sum, count), str: S.digestString(sum, count) };
};
const digests = [digestCase([]), digestCase(dEntries.slice(0, 1)), digestCase(dEntries), digestCase(dEntries, dEntries.slice(3, 9)), digestCase(dEntries.slice(0, 2), dEntries.slice(0, 2))];

const versions = [
  [1794066000, 'Grommash', false], [1794373200, 'Grommash', true], [0, 'a', false], [0, 'a', true], [1794068400, 'Thrallia', false],
  [1794068400.7, 'Zulé', false], [4102444800, 'Zuljin', true], [4102444800, 'Zuljin', false],
].map(([t, author, final]) => { const vv = S.makeVersion(t, author, final); return { t, author, final, v: vv, tBack: S.tOfVersion(vv), isFinal: S.isFinalV(vv) }; });
const nextT = [[100, 50], [100, 100], [100, 150], [100, null], [7.5, 7]].map(([t, tOld]) => ({ t, tOld, out: S.nextT(t, tOld) }));
const cmp = (a, b) => ({ a, b, out: S.compareRecords(a, b) });
const r1 = records[0].record;
const compare = [
  cmp(r1, r1),
  cmp(S.encode({ type: 'AN', key: 'q2w8zz', v: v(NOW, 'Grommash'), author: 'Grommash', fields: { body: 'a' } }), S.encode({ type: 'AN', key: 'q2w8zz', v: v(NOW - 1, 'Grommash'), author: 'Grommash', fields: { body: 'z' } })),
  cmp(S.encode({ type: 'AN', key: 'q2w8zz', v: v(NOW, 'Grommash'), author: 'Grommash', fields: { body: 'a' } }), S.encode({ type: 'AN', key: 'q2w8zz', v: v(NOW, 'Grommash'), author: 'Grommash', fields: { body: 'b' } })),
  cmp(S.encode({ type: 'AN', key: 'q2w8zz', v: v(NOW, 'Grommash'), author: 'Grommash', fields: { body: 'é' } }), S.encode({ type: 'AN', key: 'q2w8zz', v: v(NOW, 'Grommash'), author: 'Grommash', fields: { body: '￿' } })),
  cmp(S.encode({ type: 'AN', key: 'q2w8zz', v: v(NOW, 'Grommash'), author: 'Grommash', fields: { body: '😀' } }), S.encode({ type: 'AN', key: 'q2w8zz', v: v(NOW, 'Grommash'), author: 'Grommash', fields: { body: '￿' } })),
  cmp(records.find((r) => r.name === 'RT cancelled (final)').record, records.find((r) => r.name === 'RT open again').record),
  cmp(S.encode({ type: 'RT', key: 'k3f9a2', v: v(NOW - 100, 'Varok', true), author: 'Varok', fields: { status: 'x' } }), S.encode({ type: 'RT', key: 'k3f9a2', v: v(NOW, 'Grommash', true), author: 'Grommash', fields: { status: 'd' } })),
];
const keys = [
  ['item', 17102], ['item', 'Cloak of the Shrouded Mists'], ['item', '  cloak OF the shrouded mists '], ['item', 'Ränge'], ['item', ''], ['item', 0],
  ['instance', 'Molten Core'], ['instance', ' molten core\t'], ['instance', 'Zul\'Gurub'], ['instance', ''],
].map(([kind, input]) => ({ kind, input, out: kind === 'item' ? S.itemKey(input) : S.instanceKey(input) }));

// ------------------------------------------------------------------------------- expiry
const RDrec = (t, startsAt) => S.encode(rec('RD', 'k3f9a2', t, 'Grommash', { kind: 'r', title: 'MC', startsAt }));
const expiryCases = [
  ['ch 60 days', S.encode(rec('ch', 'Thrallia', NOW - 10 * D, 'Thrallia', { pid: 'Thrallia.p4m7' })), null],
  ['rc newer of itself and its ch', S.encode(rec('rc', 'Thrallia:4k', NOW - 70 * D, 'Thrallia', { kind: 's', list: [1] })), { 'ch:Thrallia': S.encode(rec('ch', 'Thrallia', NOW - 5 * D, 'Thrallia', { pid: 'Thrallia.p4m7' })) }],
  ['rc without its ch', S.encode(rec('rc', 'Thrallia:4k', NOW - 70 * D, 'Thrallia', { kind: 's', list: [1] })), null],
  ['su with the raid', S.encode(rec('su', 'k3f9a2:Thrallia.p4m7', NOW - 2 * D, 'Thrallia', { character: 'Thrallia' })), { 'RD:k3f9a2': RDrec(NOW - 10 * D, NOW - 50 * D) }],
  ['su raid unknown (120 days)', S.encode(rec('su', 'k3f9a2:Thrallia.p4m7', NOW - 2 * D, 'Thrallia', { character: 'Thrallia' })), null],
  ['cl with the request', S.encode(rec('cl', 'r1r1r1:Zuljin.a8x2', NOW - D, 'Zuljin', { state: 'c' })), { 'cr:r1r1r1': S.encode(rec('cr', 'r1r1r1', NOW - 8 * D, 'Thrallia', { pid: 'Thrallia.p4m7', item: 'x', state: 'd' }, { final: true })) }],
  ['dg startsAt + 1 day', S.encode(rec('dg', 'dg1grp', NOW - 2 * D, 'Thrallia', { pid: 'Thrallia.p4m7', dungeon: 'x', startsAt: NOW - D + 10, state: 'o' })), null],
  ['dj with the group', S.encode(rec('dj', 'dg1grp:Zuljin.a8x2', NOW - D, 'Zuljin', { role: 't', status: 'y' })), { 'dg:dg1grp': S.encode(rec('dg', 'dg1grp', NOW - 2 * D, 'Thrallia', { pid: 'Thrallia.p4m7', dungeon: 'x', startsAt: NOW - 2 * D, state: 'o' })) }],
  ['dc with the drive (field)', S.encode(rec('dc', 'h4nd1n', NOW - D, 'Thrallia', { pid: 'Thrallia.p4m7', drive: 'dr1v3x', amount: 1 })), { 'DR:dr1v3x': S.encode(rec('DR', 'dr1v3x', NOW - 61 * D, 'Grommash', { title: 'x', state: 'c' }, { final: true })) }],
  ['dc tombstone, drive unknown', S.encode(rec('dc', 'h4nd1n', NOW - D, 'Thrallia', null, { del: true })), null],
  ['BH with the bank request', S.encode(rec('BH', 'b4nkrq', NOW - D, 'Varok', { state: 'd' })), { 'bq:b4nkrq': S.encode(rec('bq', 'b4nkrq', NOW - 31 * D, 'Thrallia', { pid: 'Thrallia.p4m7', item: 'x', state: 'o' })) }],
  ['RT as RD', S.encode(rec('RT', 'k3f9a2', NOW - D, 'Grommash', { status: 'l', lockedAt: NOW - D })), { 'RD:k3f9a2': RDrec(NOW - 10 * D, NOW + D) }],
  ['RT close unfolded', S.encode(rec('RT', 'k3f9a2', NOW - 300 * D, 'Grommash', { status: 'd', kind: 'r', instance: '2dv8n1' }, { final: true })), { 'RD:k3f9a2': RDrec(NOW - 310 * D, NOW - 300 * D) }],
  ['RT close folded', S.encode(rec('RT', 'k3f9a2', NOW - 300 * D, 'Grommash', { status: 'd', kind: 'r', instance: '2dv8n1' }, { final: true })), { 'RD:k3f9a2': RDrec(NOW - 310 * D, NOW - 300 * D), 'LY:2dv8n1': S.encode(rec('LY', '2dv8n1', NOW - D, 'Grommash', { upto: NOW - 31 * D })) }],
  ['RT pvp close is not kept', S.encode(rec('RT', 'k3f9a2', NOW - 300 * D, 'Grommash', { status: 'd', kind: 'p', instance: '2dv8n1' }, { final: true })), null],
  ['LA unfolded', S.encode(rec('LA', 'aw4rd1', NOW - 200 * D, 'Grommash', { instance: '2dv8n1', item: 'd72', pid: 'Thrallia.p4m7', kind: 's' })), null],
  ['LA folded', S.encode(rec('LA', 'aw4rd1', NOW - 200 * D, 'Grommash', { instance: '2dv8n1', item: 'd72', pid: 'Thrallia.p4m7', kind: 's' })), { 'LY:2dv8n1': S.encode(rec('LY', '2dv8n1', NOW - D, 'Grommash', { upto: NOW - 31 * D })) }],
  ['LL never', S.encode(rec('LL', '2dv8n1', NOW - 999 * D, 'Grommash', { name: 'MC' })), null],
  ['LL tombstone 180 days', S.encode(rec('LL', '2dv8n1', NOW - 100 * D, 'Grommash', null, { del: true })), null],
  ['cr open 30 days', S.encode(rec('cr', 'r1r1r1', NOW - 29 * D, 'Thrallia', { pid: 'Thrallia.p4m7', item: 'x', state: 'o' })), null],
  ['cr final 7 days', S.encode(rec('cr', 'r1r1r1', NOW - 6 * D, 'Thrallia', { pid: 'Thrallia.p4m7', item: 'x', state: 'x' }, { final: true })), null],
  ['DR open 180 days', S.encode(rec('DR', 'dr1v3x', NOW - 10 * D, 'Grommash', { title: 'x', state: 'o' })), null],
  ['DR closed 60 days', S.encode(rec('DR', 'dr1v3x', NOW - 10 * D, 'Grommash', { title: 'x', state: 'c' }, { final: true })), null],
  ['RD startsAt + 45 days', RDrec(NOW - 100 * D, NOW - 44 * D), null],
  ['lp 3 days', S.encode(rec('lp', 'Thrallia.p4m7:Zuljinne', NOW - 3 * D + 10, 'Zuljinne', { character: 'Zuljinne' })), null],
  ['unknown type 14 days', S.encode({ type: 'zz', key: 'a', v: v(NOW - 10 * D, 'Thrallia'), author: 'Thrallia', raw: ['1'] }), null],
  ['unknown type gone after 14 days', S.encode({ type: 'zz', key: 'b', v: v(NOW - 15 * D, 'Thrallia'), author: 'Thrallia', raw: ['1'] }), null],
];
const hour = S.hourStart(NOW);
const expiry = expiryCases.map(([name, record, lookup]) => {
  const look = lookup ? (id) => lookup[id] || null : null;
  return { name, record, lookup, hour, at: S.expiresAt(record, look), expired: S.isExpired(record, hour, look) };
});

// ------------------------------------------------------------------------------- caps
const caps = [
  [{ count: 299, bytes: 100, rcBytes: 0 }, 'ca', 100], [{ count: 300, bytes: 100, rcBytes: 0 }, 'ca', 100],
  [{ count: 10, bytes: 65000, rcBytes: 0 }, 'ch', 400], [{ count: 10, bytes: 65000, rcBytes: 0 }, 'rc', 2000],
  [{ count: 10, bytes: 0, rcBytes: 31000 }, 'rc', 2000], [{ count: 999, bytes: 999999 }, 'RD', 500], [{}, 'su', 300],
  [{ count: 300, bytes: 65000, rcBytes: 0 }, 'zz', 100], [{ count: 300, bytes: 100, rcBytes: 0 }, 'ZQ', 100],
].map(([usage, type, bytes]) => ({ usage, type, bytes, over: S.overAuthorCaps(usage, type, bytes) }));

// ------------------------------------------------------------------------------- messages
const digests48 = Array.from({ length: 48 }, (_, i) => (i === 37 ? S.fromB36('zxbw') : i % 5 === 0 ? 0 : (i * 104729) % 1679615 + 1));
const helloIn = [
  { minor: 1, count: 1370, digests: digests48, addon: '0.12.0' },
  { minor: 1, count: 0, digests: Array(48).fill(0), addon: '' },
  { minor: 1, count: 99999, digests: digests48, addon: '0.12.0-beta.123456' },
  { minor: 1, count: 3, digests: digests48, addon: 'bad version^' },
  { minor: 1, count: 3, digests: digests48.slice(0, 47), addon: '1' },
];
const hello = helloIn.map((input) => { const msg = S.encodeHello(input); return { input, msg, parsed: dump(S.parseHello(msg)) }; });
const entry = (i) => ({ shortId: S.shortId(`ca:k${String(i).padStart(5, '0')}`), v: v(NOW - i, 'Thrallia') });
const invIn = [
  { bucket: 37, digest: S.fromB36('zxbw'), page: 1, pages: 1, entries: [{ shortId: 'frwo', v: '1gqwzvur' }, { shortId: 'ek9k', v: '1gr80lc3' }] },
  { bucket: 0, digest: 0, page: 1, pages: 1, entries: [] },
  { bucket: 5, digest: 77, page: 2, pages: 3, entries: Array.from({ length: 20 }, (_, i) => entry(i)) },
  { bucket: 48, digest: 1, page: 1, pages: 1, entries: [] },
  { bucket: 1, digest: 1, page: 2, pages: 1, entries: [] },
  { bucket: 1, digest: 1, page: 1, pages: 1, entries: Array.from({ length: 21 }, (_, i) => entry(i)) },
];
const inventory = invIn.map((input) => { const msg = S.encodeInventory(input); return { input, msg, parsed: dump(S.parseInventory(msg)) }; });
const pages = [
  { bucket: 3, digest: 12345, entries: Array.from({ length: 45 }, (_, i) => entry(i)) },
  { bucket: 40, digest: 0, entries: [] },
  { bucket: 9, digest: 5, entries: [{ shortId: 'zzzz', v: '00000001' }, { shortId: 'aaaa', v: '00000002' }, { shortId: 'aaaa', v: '00000001' }, { shortId: 'bad', v: 'x' }] },
].map((c) => Object.assign(c, { msgs: dump(S.inventoryPages(c.bucket, c.digest, c.entries)) }));
const getIn = [
  ['Grommash', ['frwo', 'ek9k']],
  ['Thrallia', Array.from({ length: 70 }, (_, i) => entry(i).shortId)],
  ['Averyveryverylongname-Argent Dawn', Array.from({ length: 60 }, (_, i) => entry(i).shortId)],
  ['Bad^Name', ['frwo']],
  ['Grommash', ['bad', 'frwo']],
];
const get = getIn.map(([target, idsIn]) => {
  const msgs = S.encodeGet(target, idsIn);
  return { target, ids: idsIn, msgs: dump(msgs), parsed: msgs.map((m) => ({ msg: m, dump: dump(S.parseGet(m)) })) };
});
const smalls = records.filter((r) => S.byteLength(r.record) <= 253).map((r) => r.record);
const bigs = records.filter((r) => S.byteLength(r.record) > 253).map((r) => r.record);
const pack = [smalls.slice(0, 3), smalls, [bigs[0], smalls[0]], []].map((list) => {
  const msgs = S.packRecords(list);
  return { records: list, msgs: dump(msgs), parsed: msgs.map((m) => ({ msg: m, dump: dump(S.parseRecords(m)) })) };
});
const llBig = S.encode(rec('LL', '2dv8n1', NOW - 60, 'Grommash', {
  name: 'Molten Core', bosses: ['Lucifron', 'Magmadar', 'Gehennas', 'Garr', 'Shazzrah', 'Baron Geddon', 'Golemagg', 'Sulfuron', 'Majordomo', 'Ragnaros'],
  items: Array.from({ length: 150 }, (_, i) => ({ item: S.toB36(16800 + i), boss: (i % 10) + 1, name: `Item ${i} of the Molten Ćore` })),
}));
const tooBig = 'ZZ:x^' + v(NOW, 'Varok') + '^Varok^^' + 'é'.repeat(4400);
const split = [[bigs[0], 0], [bigs[bigs.length - 1], 1295], [llBig, 1296 + 11], [records[0].record, 3], [tooBig, 1]].map(([record, mid]) => {
  const msgs = S.splitRecord(record, mid);
  return { record, mid, msgs: dump(msgs), parsed: msgs.map((m) => dump(S.parseParts(m))) };
});
const kinds = ['1H', '1Rxx', '2Hzz', 'xH', '1h', '', '9Z'].map((msg) => ({ msg, dump: dump(S.messageKind(msg)) }));
const bad = [
  ['parseHello', '1H' + '0'.repeat(195) + '^'], ['parseHello', '1H1' + '0'.repeat(194) + '^0.1'], ['parseHello', '1H1000' + 'ZZZZ'.repeat(48) + '^'],
  ['parseHello', hello[0].msg.replace('^', 'x')],
  ['parseInventory', '1I0z00001100'], ['parseInventory', '1I00000010'], ['parseInventory', '1I0000001100000000000'], ['parseInventory', '1I1c0000110000'],
  ['parseGet', '1G^frwo'], ['parseGet', '1GGrommash^'], ['parseGet', '1GGrommash^frw'], ['parseGet', '1GGrom,mash^frwo'], ['parseGet', '1GGrommash^FRWO'],
  ['parseRecords', '1R'], ['parseRecords', '1Ra##b'], ['parseRecords', '1Ra#'], ['parseRecords', '1R' + 'x'.repeat(254)],
  ['parseParts', '1M0011'], ['parseParts', '1M0021x'], ['parseParts', '1M0010x'], ['parseParts', '1M00' + '11' + 'x'.repeat(250)], ['parseParts', '1M!!11x'],
].map(([fn, msg]) => ({ fn, msg }));
for (const b of bad) if (S[b.fn](b.msg) !== null) throw new Error(`${b.fn} should refuse ${b.msg}`);

// ------------------------------------------------------------------------------- SR+ fold fixtures
// Hand-written expectations taken from the old server's raid tests (app/test/core/raids.test.js:
// "SR+ end to end" and "closing a PvP premade or guild event"), replayed as records. JS only (§4.4).
const INST = S.instanceKey('Hyjal Summit');
const OTHER = S.instanceKey('Molten Core');
const GREAVES = S.itemKey(30871);
const CLOAK = S.itemKey(30884);
const ME = 'Velanne.v1v1';
const MOKRA = 'Mokra.m0k1';
const CHARLIE = 'Charlie.c4c4';
const T0 = NOW - 100 * D;
const close = (key, t, kind, attendees, noShows, inst = INST, author = 'Grim') => S.encode(rec('RT', key, t, author, { status: 'd', kind, instance: inst, closedAt: t, attendees, noShows }, { final: true }));
const award = (key, t, item, itemName, pid, kind, inst = INST, author = 'Velanne') => S.encode(rec('LA', key, t, author, { raid: 'w2w2w2', instance: inst, item, itemName, character: pid ? pid.split('.')[0] : 'Pugsy', pid: pid || '', kind }));
const ly = (t, upto, bonuses, inst = INST) => S.encode(rec('LY', inst, t, 'Grim', { upto, bonuses }));
const LY0 = ly(T0, T0, [{ pid: CHARLIE, item: CLOAK, bonus: 30 }]);
const W1 = close('w1w1w1', T0 + 100, 'r', [{ pid: MOKRA, items: [GREAVES] }, { pid: ME, items: [GREAVES] }], [CHARLIE]);
const AW_GREAVES = award('aw0001', T0 + 200, GREAVES, 'Frost Greaves', MOKRA, 's');
const AW_RING = award('aw0002', T0 + 210, S.itemKey('random ring'), 'random ring', ME, 'o');
const AW_TRINKET = award('aw0003', T0 + 220, S.itemKey('Loose Trinket'), 'Loose Trinket', null, 'f');
const AW_CLOAK = award('aw0004', T0 + 230, CLOAK, 'Night Cloak', MOKRA, 'm');
const W2 = close('w2w2w2', T0 + 300, 'r', [{ pid: MOKRA, items: [] }, { pid: ME, items: [GREAVES] }], []);
const AW_LATE = award('aw0005', T0 + 400, S.itemKey('Late find'), 'Late find', MOKRA, 'o');
const fold = [
  { name: 'week 1: attendees grow, the no-show resets', instance: INST, records: [LY0, W1], expect: { [MOKRA]: { [GREAVES]: 10 }, [ME]: { [GREAVES]: 10 } } },
  { name: 'week 2: the winner resets, I grow to 20', instance: INST, records: [W2, AW_LATE, AW_CLOAK, LY0, AW_TRINKET, W1, AW_RING, AW_GREAVES], expect: { [ME]: { [GREAVES]: 20 } } },
  { name: 'an award recorded late (t before the close) still counts first', instance: INST, records: [LY0, W1, W2, AW_GREAVES], expect: { [ME]: { [GREAVES]: 20 } } },
  {
    name: 'PvP and event closes leave loyalty alone', instance: INST,
    records: [
      ly(T0, T0, [{ pid: MOKRA, item: GREAVES, bonus: 30 }, { pid: ME, item: CLOAK, bonus: 20 }]),
      close('pvp001', T0 + 100, 'p', [{ pid: MOKRA, items: [] }], [ME]),
      close('evt001', T0 + 200, 'e', [{ pid: MOKRA, items: [] }, { pid: ME, items: [] }], []),
    ],
    expect: { [MOKRA]: { [GREAVES]: 30 }, [ME]: { [CLOAK]: 20 } },
  },
  { name: 'switched reserve: the old streak ends', instance: INST, records: [ly(T0, T0, [{ pid: MOKRA, item: GREAVES, bonus: 30 }]), close('w3w3w3', T0 + 100, 'r', [{ pid: MOKRA, items: [CLOAK, CLOAK] }], [])], expect: { [MOKRA]: { [CLOAK]: 10 } } },
  { name: 'records of another instance are ignored', instance: INST, records: [LY0, W1, close('mc0001', T0 + 150, 'r', [{ pid: ME, items: [] }], [CHARLIE, MOKRA], OTHER), award('aw0009', T0 + 160, GREAVES, 'Frost Greaves', ME, 's', OTHER)], expect: { [MOKRA]: { [GREAVES]: 10 }, [ME]: { [GREAVES]: 10 } } },
  { name: 'closes and awards the checkpoint covers are not applied twice', instance: INST, records: [ly(T0 + 150, T0 + 150, [{ pid: MOKRA, item: GREAVES, bonus: 10 }, { pid: ME, item: GREAVES, bonus: 10 }]), W1, AW_GREAVES, W2], expect: { [ME]: { [GREAVES]: 20 } } },
  { name: 'no checkpoint: start from nothing; attending without a reserve ends a streak', instance: INST, records: [W1, W2], expect: { [ME]: { [GREAVES]: 20 } } },
  { name: 'an attendee also listed as a no-show keeps the bonus', instance: INST, records: [close('w4w4w4', T0 + 100, 'r', [{ pid: ME, items: [GREAVES] }], [ME])], expect: { [ME]: { [GREAVES]: 10 } } },
];
for (const f of fold) {
  const got = S.loyaltyFold(f.instance, f.records).bonuses;
  if (!require('util').isDeepStrictEqual(got, f.expect)) {
    throw new Error(`fold fixture "${f.name}": got ${JSON.stringify(got)}`);
  }
}

// ------------------------------------------------------------------------------- the type table and constants
const typesDump = dump(S.TYPES);

const vectors = {
  about: 'Golden vectors from app/src/shared/sharing.js. Regenerate: node test/fixtures/make-sharing-vectors.js',
  K: S.K,
  typesDump,
  hashes, b36, fromB36, cuts, escCuts, escapes, unescapeBad, varints, varintBad, ids, digests, versions, nextT, compare, keys,
  records, bodies, expiry,
  accept: S.ACCEPT_CASES,
  caps,
  messages: { hello, inventory, pages, get, pack, split, kinds, bad },
  fold,
};

if (require.main === module) {
  fs.writeFileSync(OUT, JSON.stringify(vectors, null, 1) + '\n');
  console.log(`Wrote ${path.relative(process.cwd(), OUT)}: ${records.length} records, ${JSON.stringify(vectors).length} bytes.`);
}
module.exports = { vectors };
