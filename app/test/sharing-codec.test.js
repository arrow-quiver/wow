'use strict';
// The sharing codec (docs/SHARING.md step 1): app/src/shared/sharing.js and addon/WowGuild/ShareCodec.lua
// must make identical bytes. Golden vectors: test/fixtures/sharing-vectors.json (made by
// test/fixtures/make-sharing-vectors.js). ShareCodec.lua is loaded alone in fengari (Lua 5.3, 32-bit
// integers) and fed both integers and floats. No game install, no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const S = require('../src/shared/sharing');
const { toLua, parseSavedVariables } = require('../src/shared/lua');
const { LuaCodec, loadVectors, dump, toLuaSrc, luaStr, CODEC_FILE } = require('./fixtures/sharing-lua');

const V = loadVectors();
let lc = null;
const luaCodec = () => (lc = lc || new LuaCodec());

// A small seeded PRNG (mulberry32) so fuzzing is repeatable.
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NOW = 1794067200;

test('sharing.js still makes the golden vectors byte for byte', () => {
  const { vectors } = require('./fixtures/make-sharing-vectors');
  assert.deepEqual(JSON.parse(JSON.stringify(vectors)), V,
    'sharing.js changed its output. If that was deliberate, run: node test/fixtures/make-sharing-vectors.js');
});

test('the spec examples (§4.2, §6) come out exactly', () => {
  const rd = 'RD:k3f9a2^1gqwzvur^Grommash^^r^Molten Core Thursday^Molten Core^tobc40^50^14^2^Bring fire resist';
  const rt = 'RT:k3f9a2^wzltl343^Grommash^^d^tob9c0^r^4kq1zm^tobn80^Thrallia.p4m7,d72,eim;Zuljin.a8x2,eim^Varok.7tq3';
  const ca = 'ca:x8k2pq^1gqx36dy^Thrallia^^Thrallia^Crossroads^5^Alliance at the flight master';
  assert.equal(S.makeVersion(1794066000, 'Grommash'), '1gqwzvur');
  assert.equal(S.makeVersion(1794373200, 'Grommash', true), 'wzltl343');
  for (const r of [rd, rt, ca]) {
    assert.equal(S.encode(S.decode(r)), r);
    assert.equal(S.checkRecord(r, S.tOfVersion(r.split('^')[1]) + 10), null);
  }
  assert.equal(S.decode(rt).fields.closedAt, S.tOfVersion('wzltl343'));
  assert.equal(S.itemKey(17102), 'd72');
  assert.equal(S.shortId('RD:k3f9a2'), 'frwo');
  assert.equal(S.shortId('RT:k3f9a2'), 'ek9k');
  assert.equal(S.bucket('RD:k3f9a2'), 37);
  assert.equal(S.bucket('RT:k3f9a2'), 37);
  const hello = S.encodeHello({ minor: 1, count: 1370, digests: Array(48).fill(0).map((_, i) => (i === 37 ? S.fromB36('zxbw') : 0)), addon: '0.12.0' });
  assert.equal(hello.slice(0, 6), '1H1122');
  assert.equal(hello.slice(6 + 37 * 4, 10 + 37 * 4), 'zxbw');
  assert.ok(hello.endsWith('^0.12.0'));
  assert.equal(S.encodeInventory({ bucket: 37, digest: S.fromB36('zxbw'), page: 1, pages: 1, entries: [{ shortId: 'frwo', v: '1gqwzvur' }, { shortId: 'ek9k', v: '1gr80lc3' }] }),
    '1I11zxbw11frwo1gqwzvurek9k1gr80lc3');
  assert.deepEqual(S.encodeGet('Grommash', ['frwo', 'ek9k']), ['1GGrommash^frwoek9k']);
  assert.deepEqual(S.packRecords([ca]), [`1R${ca}`]);
  // The outbox example's RT body (§9).
  assert.equal(S.encodeBody('RT', 'k3f9a2', { status: 'l', lockedAt: S.fromB36('tob9c0') }), 'l^tob9c0');
});

test('ShareCodec.lua loads on its own, sets ns.ShareCodec and leaks no globals', () => {
  const L = new LuaCodec();
  assert.equal(L.text('return type(__ns.ShareCodec) == "table" and __ns.ShareCodec == SC and "yes" or "no"'), 'yes');
  // A fresh state: the globals after loading the file are exactly the globals before.
  const out = L.text(`
    local before = {}
    for k in pairs(_G) do before[k] = true end
    local chunk = assert(loadstring and loadstring(${luaStr(fs.readFileSync(CODEC_FILE, 'utf8'))}) or load(${luaStr(fs.readFileSync(CODEC_FILE, 'utf8'))}))
    local ns = {}
    local ret = chunk("WowGuild", ns)
    local extra = {}
    for k in pairs(_G) do if not before[k] then extra[#extra + 1] = tostring(k) end end
    table.sort(extra)
    return (ret == ns.ShareCodec and "same" or "different") .. "|" .. table.concat(extra, ",")`);
  assert.equal(out, 'same|');
});

test('ShareCodec.lua makes every golden vector (integers)', () => {
  const fails = luaCodec().checkVectors(V, false);
  assert.deepEqual(fails, []);
});

test('ShareCodec.lua makes every golden vector when fed floats such as 1.0', () => {
  const fails = luaCodec().checkVectors(V, true);
  assert.deepEqual(fails, []);
});

test('the Lua type table and constants mirror sharing.js', () => {
  assert.equal(V.typesDump, dump(S.TYPES));
  assert.deepEqual(V.K, JSON.parse(JSON.stringify(S.K)));
  const L = luaCodec();
  assert.equal(L.text(`local n = 0 for _ in pairs(SC.TYPES) do n = n + 1 end return string.format("%d", n)`), String(Object.keys(S.TYPES).length));
  // Every type of §4.3 is present, in the right space.
  const spec = ['ch', 'rc', 'su', 'cr', 'cl', 'lp', 'ca', 'dg', 'dj', 'dc', 'bq', 'gb', 'bk', 'sh', 'pr', 'wm', 'RD', 'RT', 'LA', 'LL', 'LY', 'AN', 'DR', 'BH', 'BC', 'CFG', 'WH'];
  assert.deepEqual(Object.keys(S.TYPES).sort(), spec.slice().sort());
  for (const t of spec) assert.equal(S.TYPES[t].space, t === t.toUpperCase() ? 'officer' : 'member');
  assert.equal(S.bucket('WH:1'), null, 'WH has no bucket');
  assert.equal(S.TYPES.WH.channel, 'OFFICER');
});

// Random field values for every type, from a seeded PRNG.
function randomFields(rng, type, key) {
  const pick = (s) => s[Math.floor(rng() * s.length)];
  const words = ['Thrallia', 'Zulé', 'a;b', 'c,d', 'x^y', '#1', 'p|q', '~7E', '東京', '😀', 'tab\there', 'line\nbreak', '', ' spaced ', 'Ærøn'];
  const text = (max) => {
    let s = '';
    const n = Math.floor(rng() * 6);
    for (let i = 0; i < n; i++) s += pick(words);
    return rng() < 0.1 ? s.repeat(Math.ceil((max + 10) / Math.max(1, s.length))) : s;
  };
  const num = () => (rng() < 0.1 ? null : rng() < 0.5 ? Math.floor(rng() * 100) : Math.floor(rng() * 2e9));
  const scalar = (spec) => {
    switch (spec.k) {
      case 'text': return text(spec.max);
      case 'int': return num();
      case 'enum': return rng() < 0.9 ? pick(spec.values) : 'Q';
      case 'flag': return rng() < 0.5;
      default: return null;
    }
  };
  const value = (spec, fields) => {
    switch (spec.k) {
      case 'list': {
        const n = Math.floor(rng() * Math.min(spec.maxItems + 3, 12));
        return Array.from({ length: n }, () => {
          if (spec.of) return scalar(spec.of);
          const o = {};
          for (const p of spec.parts) o[p.n] = scalar(p);
          if (spec.rest) o[spec.rest.n] = Array.from({ length: Math.floor(rng() * 4) }, () => scalar(spec.rest));
          return o;
        });
      }
      case 'tuple': { const o = {}; for (const p of spec.parts) o[p.n] = scalar(p); return o; }
      case 'ids': return Array.from({ length: Math.floor(rng() * 30) }, () => Math.floor(rng() * 40000));
      case 'switch': return value((typeof fields[spec.on] === 'string' && spec.cases[fields[spec.on]]) || spec.default, fields);
      default: return scalar(spec);
    }
  };
  const fields = {};
  for (const spec of S.fieldsFor(type, key)) fields[spec.n] = value(spec, fields);
  return fields;
}
const KEYS = {
  ch: 'Thrallia', rc: 'Thrallia:4k', su: 'k3f9a2:Thrallia.p4m7', cr: 'r1r1r1', cl: 'r1r1r1:Zuljin.a8x2', lp: 'Thrallia.p4m7:Zuljinne',
  ca: 'x8k2pq', dc: 'h4nd1n', bq: 'b4nkrq', gb: '0', bk: 'Bankalt', sh: 'Thrallia.p4m7', pr: 'Thrallia.p4m7', RD: 'k3f9a2', RT: 'k3f9a2',
  LA: 'aw4rd1', LL: '2dv8n1', LY: '2dv8n1', AN: 'q2w8zz', DR: 'dr1v3x', BH: 'b4nkrq', BC: '1', CFG: '1', WH: '1',
};
function randomRecordCases(seed, count) {
  const rng = prng(seed);
  const types = Object.keys(KEYS);
  const cases = [];
  for (let i = 0; i < count; i++) {
    const type = types[i % types.length];
    let key = KEYS[type];
    if (type === 'gb' && rng() < 0.5) key = String(1 + Math.floor(rng() * 8));
    const author = S.TYPES[type].author === 'key' ? key.split(':')[0] : ['Grommash', 'Zulé', 'Varok'][i % 3];
    const fields = randomFields(rng, type, key);
    const probe = { type, key, author, del: rng() < 0.05, fields, v: S.makeVersion(0, author) };
    const final = S.isFinal(S.decode(S.encode(probe)));
    const input = Object.assign({}, probe, { v: S.makeVersion(NOW - Math.floor(rng() * 1e6), author, final) });
    const record = S.encode(input);
    const d = S.decode(record);
    cases.push({
      name: `random ${type} #${i}`, input: JSON.parse(JSON.stringify(input)), record, now: NOW, lookup: null,
      dump: dump(d), reencode: d ? S.encode(d) : null, check: S.checkRecord(record, NOW, null), parseDump: dump(S.parse(record)), final: d ? S.isFinal(d) : false,
    });
  }
  return cases;
}

test('random records of every type: JS round trips and Lua makes the same bytes', () => {
  const cases = randomRecordCases(20261107, 480);
  for (const c of cases) {
    assert.ok(S.decode(c.record), `${c.name} decodes: ${c.record}`);
    assert.equal(c.reencode, c.record, `${c.name} is canonical`);
    const spec = S.TYPES[c.input.type];
    // Text is shrunk to fit; only long lists can still go over (the check then refuses the record).
    if (c.check === 'oversize') assert.ok(spec.fields.concat(spec.variants ? spec.variants[0] : []).some((f) => f.k === 'list' || f.k === 'switch'), c.name);
    assert.ok(c.check === null || c.check === 'oversize' || c.check === 'expired', `${c.name}: ${c.check}`);
  }
  for (const floats of [false, true]) assert.deepEqual(luaCodec().checkVectors({ records: cases }, floats), []);
});

// Fuzz inputs: random bytes, and valid records and messages with random edits.
function fuzzStrings(seed, count) {
  const rng = prng(seed);
  const pick = (a) => a[Math.floor(rng() * a.length)];
  const alphabet = ['^', '^', ':', '~', ';', ',', '#', '|', 'd', '0', 'z', 'Z', 'a', '.', '-', '_', ' ', '\x01', '\x7f', 'é', '東', '😀', '~3B', '~ZZ', '1', 'W'];
  const seeds = V.records.map((r) => r.record)
    .concat(V.messages.hello.map((h) => h.msg), V.messages.inventory.map((i) => i.msg).filter(Boolean))
    .concat(V.messages.get.flatMap((g) => g.parsed.map((p) => p.msg)), V.messages.pack.flatMap((p) => p.parsed.map((x) => x.msg)))
    .concat(['1M0012abc', '1Rx', '1H', '1G^', '']);
  const out = [];
  for (let i = 0; i < count; i++) {
    let s;
    if (rng() < 0.15) {
      s = '';
      const n = Math.floor(rng() * 60);
      for (let j = 0; j < n; j++) s += pick(alphabet);
    } else {
      s = pick(seeds);
      const edits = 1 + Math.floor(rng() * 4);
      for (let e = 0; e < edits; e++) {
        const at = Math.floor(rng() * (s.length + 1));
        const op = rng();
        if (op < 0.35) s = s.slice(0, at) + pick(alphabet) + s.slice(at);
        else if (op < 0.6) s = s.slice(0, at) + s.slice(at + 1 + Math.floor(rng() * 3));
        else if (op < 0.8) s = s.slice(0, at) + pick(alphabet) + s.slice(at + 1);
        else if (op < 0.9) s = s.slice(0, at);
        else s = s + s.slice(0, at);
      }
    }
    // Keep it valid UTF-16 (no lone surrogates) so JS and Lua see the same bytes.
    out.push(Buffer.from(s, 'utf8').toString('utf8'));
  }
  return out;
}

test('fuzz: no JS decoder or check throws on garbage', () => {
  const env = { me: 'Me', sender: 'Zuljinne', channel: 'GUILD', ranks: { Zuljinne: 3, Grommash: 0, Thrallia: 3 } };
  for (const s of fuzzStrings(7, 4000)) {
    for (const fn of ['parse', 'decode', 'parseHello', 'parseInventory', 'parseGet', 'parseRecords', 'parseParts', 'messageKind', 'unescape', 'decodeIds', 'fromB36', 'tOfVersion', 'bucket', 'shortId']) {
      assert.doesNotThrow(() => S[fn](s), `${fn}(${JSON.stringify(s)})`);
    }
    assert.doesNotThrow(() => S.checkRecord(s, NOW, () => s));
    assert.doesNotThrow(() => S.acceptRecord(s, NOW, null, env));
    assert.doesNotThrow(() => S.isExpired(s, NOW, () => s));
    const d = S.decode(s);
    if (d) assert.equal(typeof S.encode(d), 'string');
  }
  // Odd argument types.
  for (const x of [null, undefined, 1, 1.5, {}, [], true, NaN, Infinity, -1]) {
    for (const fn of Object.keys(S).filter((k) => typeof S[k] === 'function' && k !== 'runAcceptCase')) {
      assert.doesNotThrow(() => S[fn](x, x), `${fn}(${String(x)})`);
    }
  }
});

test('fuzz: ShareCodec.lua never throws and gives the same answers as sharing.js', () => {
  const env = { me: 'Me', sender: 'Zuljinne', channel: 'GUILD', ranks: { Zuljinne: 3, Grommash: 0, Thrallia: 3, Varok: 1 } };
  const strings = fuzzStrings(11, process.env.GUILDCAMP_SIM_HEAVY === '1' ? 20000 : 2500);
  const fuzz = strings.map((s) => {
    const d = S.decode(s);
    const acc = S.acceptRecord(s, NOW, null, env);
    return { s, now: NOW, check: S.checkRecord(s, NOW, null), decodes: !!d, reencode: d ? S.encode(d) : null, env, accept: acc.ok ? acc.how : acc.reason };
  });
  assert.ok(fuzz.filter((f) => f.decodes).length > 100, 'enough fuzz inputs still decode');
  assert.deepEqual(luaCodec().checkVectors({ fuzz }, false), []);
  // Odd argument types in Lua: nothing errors.
  const out = luaCodec().text(`
    local bad = {}
    local odd = { 1, 1.5, true, {}, -1, 0/0, 1/0 }
    for _, name in ipairs({ "parse", "decode", "escape", "unescape", "cutUtf8", "encode", "encodeIds", "decodeIds", "toB36", "fromB36",
      "encodeHello", "parseHello", "encodeInventory", "parseInventory", "encodeGet", "parseGet", "packRecords", "parseRecords",
      "splitRecord", "parseParts", "joinParts", "messageKind", "checkRecord", "isExpired", "expiresAt", "bucket", "shortId",
      "djb2", "makeVersion", "tOfVersion", "compareRecords", "itemKey", "instanceKey", "encodeBody", "inventoryPages",
      "cutEscaped", "pad36", "digestTerm", "digestValue", "digestString", "nextT", "isFinalV", "compareVersions", "compareBytes",
      "keyOk", "pidOk", "authorOk", "fieldsFor", "maxFor", "isFinal", "isFoldable", "overAuthorCaps", "addAuthorUsage", "mayServe",
      "spaceOf", "split", "hourStart", "newPid", "randomKey", "isOfficer", "isTrusted" }) do
      for _, x in ipairs(odd) do
        local ok, err = pcall(SC[name], x, x)
        if not ok then bad[#bad + 1] = name .. ": " .. tostring(err) end
      end
      local ok, err = pcall(SC[name])
      if not ok then bad[#bad + 1] = name .. "(): " .. tostring(err) end
    end
    local ok, err = pcall(SC.acceptRecord, "x", 0, nil, nil)
    if not ok then bad[#bad + 1] = "acceptRecord: " .. tostring(err) end
    return table.concat(bad, "\\n")`);
  assert.equal(out, '');
});

test('the shared accept/refuse table passes in JS and in Lua', () => {
  assert.ok(S.ACCEPT_CASES.length >= 40);
  for (const c of S.ACCEPT_CASES) assert.equal(S.runAcceptCase(c), c.expect, c.name);
  // Every refusal reason and every "how" is covered.
  const seen = new Set(S.ACCEPT_CASES.map((c) => c.expect));
  for (const r of ['d', 't', 'm', 'ok', 'self', 'unknown', 'channel', 'rank', 'author', 'future', 'expired', 'malformed', 'oversize']) assert.ok(seen.has(r), r);
  assert.deepEqual(luaCodec().checkVectors({ accept: S.ACCEPT_CASES }, true), []);
});

test('versions: final beats normal, the earliest final wins, ties go to the bigger record', () => {
  const t = 1794066000;
  const normalLate = S.makeVersion(t + 1e8, 'Varok');
  const finalLate = S.makeVersion(t + 1e8, 'Varok', true);
  const finalEarly = S.makeVersion(t, 'Grommash', true);
  assert.equal(S.compareVersions(finalLate, normalLate), 1);
  assert.equal(S.compareVersions(finalEarly, finalLate), 1);
  assert.ok(S.isFinalV(finalLate) && !S.isFinalV(normalLate));
  assert.equal(S.tOfVersion(finalEarly), t);
  assert.equal(S.tOfVersion(normalLate), t + 1e8);
  // v is 8 characters, so plain string order is numeric order.
  const vs = [0, 1, 1794066000, 4102444800].flatMap((x) => [S.makeVersion(x, 'a'), S.makeVersion(x, 'a', true)]);
  for (const a of vs) for (const b of vs) assert.equal(Math.sign(S.compareVersions(a, b)), a === b ? 0 : a > b ? 1 : -1);
  assert.equal(S.nextT(100, 100), 101);
  assert.equal(S.nextT(100, 99), 100);
  // Cancel and close by two officers settle the same way whatever the order.
  const cancel = S.encode({ type: 'RT', key: 'k3f9a2', v: S.makeVersion(t + 50, 'Varok', true), author: 'Varok', fields: { status: 'x' } });
  const closeR = S.encode({ type: 'RT', key: 'k3f9a2', v: S.makeVersion(t + 60, 'Grommash', true), author: 'Grommash', fields: { status: 'd', kind: 'r' } });
  const lock = S.encode({ type: 'RT', key: 'k3f9a2', v: S.makeVersion(t + 90, 'Grommash'), author: 'Grommash', fields: { status: 'l', lockedAt: t + 90 } });
  for (const order of [[cancel, closeR, lock], [lock, closeR, cancel], [closeR, lock, cancel]]) {
    const winner = order.reduce((best, r) => (S.compareRecords(r, best) > 0 ? r : best));
    assert.equal(winner, cancel);
  }
});

test('digests: incremental add and remove equal a full rebuild', () => {
  const recs = V.records.map((r) => r.record).filter((r) => S.parse(r));
  let sum = 0;
  let count = 0;
  for (const r of recs) { const p = S.parse(r); sum += S.digestTerm(p.id, p.v); count++; }
  assert.equal(S.digestString(sum, count), S.digestOf(recs).digest);
  for (const r of recs.slice(0, 10)) { const p = S.parse(r); sum -= S.digestTerm(p.id, p.v); count--; }
  assert.equal(S.digestString(sum, count), S.digestOf(recs.slice(10)).digest);
  assert.equal(S.digestString(0, 0), '0000');
  assert.ok(Number.isSafeInteger(4000 * 4294967295), 'the running sum stays exact');
});

test('message framing respects every size limit', () => {
  for (const h of V.messages.hello.filter((x) => x.msg)) assert.ok(h.msg.length <= S.K.HELLO_MAX);
  for (const i of V.messages.inventory.filter((x) => x.msg)) assert.ok(i.msg.length <= S.K.INV_MAX);
  const recs = V.records.map((r) => r.record);
  for (const m of S.packRecords(recs)) assert.ok(S.byteLength(m) <= 255, m);
  assert.deepEqual(S.packRecords(recs).flatMap((m) => S.parseRecords(m)), recs.filter((r) => S.byteLength(r) <= 253));
  for (const r of recs.filter((x) => S.byteLength(x) > 253)) {
    const parts = S.splitRecord(r, 1295);
    assert.ok(parts.length >= 2);
    for (const p of parts) assert.ok(S.byteLength(p) <= 255);
    assert.equal(S.joinParts(parts.map((p) => S.parseParts(p).data)), r);
  }
  // A full-size loot list (8 KB) fits in 35 parts.
  const ll = V.messages.split.find((x) => x.record.startsWith('LL:'));
  assert.ok(S.byteLength(ll.record) > 4000);
  assert.ok(S.splitRecord(ll.record, 1).length <= 35);
  for (const g of S.encodeGet('Averyveryverylongname-Argent Dawn', Array(200).fill('frwo'))) assert.ok(S.byteLength(g) <= 255);
});

test('SavedVariables round trip keeps every escape and UTF-8 byte', () => {
  const recs = {};
  for (const r of V.records) recs[r.input.type + ':' + r.input.key] = r.record;
  const db = { shared: { v: 1, pid: 'Thrallia.p4m7', guilds: { 'Forever/wow': { recs } } } };
  // App → Inbox.lua style text → back.
  const parsed = parseSavedVariables(Buffer.from(`WowGuildDB = ${toLua(db)}\n`, 'utf8'));
  assert.deepEqual(parsed.WowGuildDB, db);
  // Through real Lua: load the text, write each record back the way the game writes strings (%q), parse it.
  const L = luaCodec();
  const lines = L.text(`
    local f = (loadstring or load)(${luaStr(`WowGuildDB = ${toLua(db)}`)})
    f()
    local out = {}
    for id, rec in pairs(WowGuildDB.shared.guilds["Forever/wow"].recs) do
      out[#out + 1] = string.format("[%q] = %q,", id, rec)
    end
    return "X = {\\n" .. table.concat(out, "\\n") .. "\\n}\\n"`);
  assert.deepEqual(parseSavedVariables(Buffer.from(lines, 'utf8')).X, recs);
  // Every escaped record is printable ASCII plus UTF-8: nothing below 0x20, no 0x7F, no "|".
  for (const r of Object.values(recs)) assert.doesNotMatch(r, /[\x00-\x1f\x7f|]/);
  // And the escapes decode back to the original bytes.
  const every = V.records.find((r) => r.name === 'AN notice with every escape');
  assert.equal(S.decode(every.record).fields.body, every.input.fields.body);
});

test('loading the Lua vectors from a Lua source file works on plain Lua 5.1 syntax', () => {
  // The generated source is ASCII with \\ddd escapes only (what a real lua5.1 reads in lua51-guard).
  const src = toLuaSrc(V, false);
  assert.doesNotMatch(src, /[^\x20-\x7e]/);
});
