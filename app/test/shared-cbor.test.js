'use strict';
// Auctionator 8+ keeps each realm's prices as a CBOR string in its SavedVariables (C_EncodingUtil.SerializeCBOR).
// shared/cbor.js decodes it; shared/auctionator.js reads both that and the old Lua tables.
const test = require('node:test');
const assert = require('node:assert');
const { decode } = require('../src/shared/cbor');
const { parseSavedVariables } = require('../src/shared/lua');
const A = require('../src/shared/auctionator');

// A tiny CBOR writer for the tests (maps with byte-string keys, as the game writes them).
function enc(v) {
  const head = (major, n) => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    if (n < 65536) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b; }
    const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(n, 1); return b;
  };
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'string') { const s = Buffer.from(v, 'latin1'); return Buffer.concat([head(2, s.length), s]); }
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(enc)]);
  const keys = Object.keys(v);
  return Buffer.concat([head(5, keys.length), ...keys.flatMap((k) => [enc(k), enc(v[k])])]);
}
// How WoW writes a binary string into a SavedVariables file: \n, \", \\ and \ddd escapes.
const luaQuote = (buf) => `"${[...buf].map((c) => (c === 10 ? '\\n' : c === 34 ? '\\"' : c === 92 ? '\\\\' : c === 13 ? '\\r' : c === 0 ? '\\000' : String.fromCharCode(c))).join('')}"`;

test('cbor: integers, strings, arrays, maps, floats, simple values, indefinite lengths, errors', () => {
  assert.deepStrictEqual(decode(Buffer.from([0x00])), 0);
  assert.deepStrictEqual(decode(Buffer.from([0x19, 0x01, 0xf4])), 500);
  assert.deepStrictEqual(decode(Buffer.from([0x1a, 0x00, 0x07, 0xa1, 0x20])), 500000);
  assert.deepStrictEqual(decode(Buffer.from([0x38, 0x63])), -100);
  assert.deepStrictEqual(decode(Buffer.from([0x63, 0x61, 0x62, 0x63])), 'abc');
  assert.deepStrictEqual(decode(Buffer.from([0x82, 0x01, 0x02])), [1, 2]);
  assert.deepStrictEqual(decode(Buffer.from([0xa1, 0x41, 0x61, 0x05])), { a: 5 });
  assert.strictEqual(decode(Buffer.from([0xf9, 0x3c, 0x00])), 1);
  assert.strictEqual(decode(Buffer.from([0xfb, 0x40, 0x09, 0x21, 0xfb, 0x54, 0x44, 0x2d, 0x18])), Math.PI);
  assert.deepStrictEqual([decode(Buffer.from([0xf4])), decode(Buffer.from([0xf5])), decode(Buffer.from([0xf6]))], [false, true, null]);
  assert.deepStrictEqual(decode(Buffer.from([0x9f, 0x01, 0x02, 0xff])), [1, 2]);
  assert.deepStrictEqual(decode(Buffer.from([0xbf, 0x41, 0x61, 0x01, 0xff])), { a: 1 });
  assert.deepStrictEqual(decode(Buffer.from([0xc1, 0x05])), 5, 'tags keep their value');
  assert.deepStrictEqual(decode('\xa1\x41\x61\x05'), { a: 5 }, 'a latin1 string works too');
  assert.throws(() => decode(Buffer.from([0x19, 0x01])), /cut off/);
});

test('Auctionator 8 (CBOR per realm) reads the same as the old Lua tables', () => {
  const today = 2504;
  const now = Date.UTC(2020, 0, 1) + today * 86400000 + 3600000;
  const items = {
    35: { a: { 2500: 7, 2504: 1 }, l: { 2500: 900 }, h: { 2500: 1000, 2504: 1200 }, m: 1100 },
    36: { a: { 2501: 2 }, l: [], h: { 2501: 100 }, m: 100 },
    'g:19019:0:0': { h: { 2503: 2500000 }, m: 2400000 },
    37: { h: { 2400: 5 }, m: 5 }, // too old
  };
  const file = `AUCTIONATOR_PRICE_DATABASE = {\n["__dbversion"] = 8,\n["PvP"] = ${luaQuote(enc(items))},\n}\n`;
  const binary = parseSavedVariables(Buffer.from(file, 'latin1'), { bytes: true }).AUCTIONATOR_PRICE_DATABASE;
  const asTables = { __dbversion: 6, PvP: items };
  for (const db of [binary, asTables]) {
    assert.deepStrictEqual(A.realmTables(db).map(([k, t]) => [k, Object.keys(t).length]), [['PvP', 4]]);
    const p = A.extractPrices(db, now).items.sort((a, b) => a[0] - b[0]);
    assert.deepStrictEqual(p, [[35, 1100, 2504], [36, 100, 2501], [19019, 2400000, 2503]]);
    const m = A.extractMarket(db, now);
    assert.deepStrictEqual(m.realms.map((r) => [r.key, r.newest, r.items.length]), [['PvP', 2504, 3]]);
    assert.deepStrictEqual(m.realms[0].items.find((x) => x[0] === 35), [35, 1100, 2504, [[2500, 900, 7], [2504, 1200, 1]]]);
  }
  // Without { bytes: true } the binary string is mangled (read as UTF-8), and the realm is skipped, not a crash.
  const mangled = parseSavedVariables(Buffer.from(file, 'latin1')).AUCTIONATOR_PRICE_DATABASE;
  assert.doesNotThrow(() => A.extractPrices(mangled, now));
  assert.deepStrictEqual(A.realmTables({ __dbversion: 8, Broken: '\x19\x01' }), []);
});
