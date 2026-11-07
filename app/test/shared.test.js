// Shared zero-dependency modules: lua, version, toc, zip, hash, auctionator.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const { parseSavedVariables, toLua, luaAssignment, isLuaIdentifier } = require('../src/shared/lua');
const version = require('../src/shared/version');
const { readToc, tocField, tocVersion, setTocField } = require('../src/shared/toc');
const { createZip, readZip, extractZip, zipDirectory, directoryEntries, safeSegments, crc32 } = require('../src/shared/zip');
const { sha256, sha512Base64, sha256File, sha512File } = require('../src/shared/hash');
const { extractPrices } = require('../src/shared/auctionator');

const REPO = path.join(__dirname, '..', '..');

function tmpDir(t, label = 'gc-shared-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), label));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Every file under dir, as "a/b.txt" → Buffer.
function readTree(dir) {
  const out = {};
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else out[r] = fs.readFileSync(path.join(d, e.name));
    }
  };
  walk(dir, '');
  return out;
}

// ---------------------------------------------------------------------------------------------
// lua.js

test('Lua SavedVariables parser handles WoW output', () => {
  const src = Buffer.from('\nWowGuildDB = {\n\t["a"] = "x\\"y\\n",\n\t["list"] = {\n\t\t"one", -- [1]\n\t\t2, -- [2]\n\t},\n\t["map"] = { [5] = true, ["k"] = nil },\n\t["n"] = -1.5e2,\n\t["name"] = "Zul\xc3\xa9",\n}\nOther = 0x1F\n', 'latin1');
  const out = parseSavedVariables(src);
  assert.deepStrictEqual(out.WowGuildDB.list, ['one', 2]);
  assert.strictEqual(out.WowGuildDB.a, 'x"y\n');
  assert.strictEqual(out.WowGuildDB.n, -150);
  assert.strictEqual(out.WowGuildDB.name, 'Zulé');
  assert.strictEqual(out.WowGuildDB.map['5'], true);
  assert.strictEqual(out.Other, 31);
});

test('Lua parser: escapes, long strings, comments, odd numbers and separators', () => {
  const src = [
    '-- a header comment',
    '--[[ a long',
    'comment ]]',
    "A = 'single \\'quoted\\''",
    'B = "tab\\tbell\\a\\065\\0661"', // \065 = A, \0661 = B then "1"
    'C = [[',
    'long "string" with Zul\xc3\xa9]]',
    'D = [==[has ]] inside]==]',
    'E = -0x10; F = 1e3; G = .5; H = inf; I = -nan; J = nil',
    '--[==[ level ]] long comment ]==]',
    'K = { 1, 2; 3, [4] = 4 }',
    'L = { [2] = "b", [1] = "a" }', // out of order but exactly 1..n: an array
    'M = { [1] = "a", [3] = "c" }', // a gap: an object
    'N = { 1, nil, 3 }',
    'O = { x = 1, ["y z"] = { } }',
    'P = { [true] = 1, [1.5] = 2 }',
    'Q = "line\\',
    'two"',
  ].join('\n');
  const out = parseSavedVariables(Buffer.from(src, 'latin1'));
  assert.strictEqual(out.A, "single 'quoted'");
  assert.strictEqual(out.B, 'tab\tbell\x07AB1');
  assert.strictEqual(out.C, 'long "string" with Zulé');
  assert.strictEqual(out.D, 'has ]] inside');
  assert.strictEqual(out.E, -16);
  assert.strictEqual(out.F, 1000);
  assert.strictEqual(out.G, 0.5);
  assert.strictEqual(out.H, null);
  assert.strictEqual(out.I, null);
  assert.strictEqual(out.J, null);
  assert.deepStrictEqual(out.K, [1, 2, 3, 4]);
  assert.deepStrictEqual(out.L, ['a', 'b']);
  assert.deepStrictEqual(out.M, { 1: 'a', 3: 'c' });
  assert.deepStrictEqual(out.N, [1, null, 3]);
  assert.deepStrictEqual(out.O, { x: 1, 'y z': {} });
  assert.deepStrictEqual(out.P, { true: 1, 1.5: 2 });
  assert.strictEqual(out.Q, 'line\ntwo');
});

test('Lua parser reports the line of a syntax error', () => {
  assert.throws(() => parseSavedVariables('A = {\n  1,\n  @\n}'), /line 3/);
  assert.throws(() => parseSavedVariables('A = "never closed'), /unterminated string/);
  assert.throws(() => parseSavedVariables('A = { 1, 2'), /Lua parse error/);
  assert.throws(() => parseSavedVariables('= 1'), /variable name/);
  assert.deepStrictEqual(parseSavedVariables(''), {});
  assert.deepStrictEqual(parseSavedVariables('-- only a comment\n'), {});
});

test('Lua parser copes with big tables', () => {
  const n = 200000;
  const parts = [];
  for (let i = n; i >= 1; i--) parts.push(`[${i}] = ${i * 2}, -- [${i}]`);
  const out = parseSavedVariables(Buffer.from(`Big = {\n${parts.join('\n')}\n}\n`, 'latin1'));
  assert.strictEqual(out.Big.length, n, 'explicit keys 1..n in any order: an array');
  assert.strictEqual(out.Big[0], 2);
  assert.strictEqual(out.Big[n - 1], n * 2);
});

test('toLua writes the same layout as the old server', () => {
  assert.strictEqual(toLua({ a: 1, 'b c': 'x', list: [true, null], empty: {}, none: [] }),
    '{\n  a = 1,\n  ["b c"] = "x",\n  list = {\n    true,\n    nil,\n  },\n  empty = {},\n  none = {},\n}');
  assert.strictEqual(toLua('say "hi"\n\\'), '"say \\"hi\\"\\n\\\\"');
  assert.strictEqual(toLua(Infinity), 'nil');
  assert.strictEqual(toLua(NaN), 'nil');
  assert.strictEqual(toLua(undefined), 'nil');
  assert.strictEqual(toLua(-2.5), '-2.5');
  assert.strictEqual(toLua('\x01\x1f'), '"\\001\\031"');
  assert.strictEqual(toLua({ end: 1, nil: 2, _ok: 3, '1abc': 4 }), '{\n  ["end"] = 1,\n  ["nil"] = 2,\n  _ok = 3,\n  ["1abc"] = 4,\n}');
});

test('luaAssignment writes a whole file the addon can load', () => {
  assert.strictEqual(luaAssignment('WowGuildInbox', { a: 1 }), '-- Written by the Guild Camp app. Do not edit.\nWowGuildInbox = {\n  a = 1,\n}\n');
  assert.throws(() => luaAssignment('not a name', {}), /can't be used/);
  assert.throws(() => luaAssignment('end', {}), /can't be used/);
  assert.ok(isLuaIdentifier('WowGuildInbox'));
  assert.ok(!isLuaIdentifier('until'));
});

const ROUND_TRIP = {
  guild: 'Camp of the Sun',
  generatedAt: 1762500000,
  unicode: 'Zulé · Thrall 🐺 日本語 Ærøskøbing',
  quotes: 'He said "go" and \'went\'',
  backslashes: 'C:\\Games\\World of Warcraft\\_forever_ \\u0041 \\\\n',
  newlines: 'line one\nline two\r\nline three\ttabbed',
  control: '\x01' + '2' + '\x07' + '\x1f9\x7f',
  numbers: [0, 1, -1, 1.5, -0.25, 1e21, 123456789012, 3.14159],
  booleans: [true, false],
  emptyObject: {},
  nested: { deeper: { deepest: [{ id: 14047, name: 'Runecloth', count: 20 }, { id: 13444, name: 'Major Mana Potion', count: 4 }] } },
  'key with spaces': 1,
  'key"quote': 2,
  'key\nnewline': 3,
  '123': 'numeric-looking key stays a string key',
  end: 'reserved word key',
  sparse: [1, null, 3],
  mixed: { 1: 'a', 2: 'b' }, // string keys "1", "2": still an object after the round trip
};

test('toLua → parse round trip keeps nested data, unicode, quotes, newlines and numbers', () => {
  const text = luaAssignment('WowGuildInbox', ROUND_TRIP);
  const parsed = parseSavedVariables(Buffer.from(text, 'utf8')).WowGuildInbox;
  assert.deepStrictEqual(parsed, ROUND_TRIP);
  // Lua can't tell an empty array from an empty table: both come back as {}.
  assert.deepStrictEqual(parseSavedVariables(Buffer.from(luaAssignment('X', { a: [] }), 'utf8')).X, { a: {} });
});

test('toLua output is valid Lua (checked with fengari when it is installed)', (t) => {
  let fengari;
  try { fengari = require(require.resolve('fengari', { paths: [path.join(REPO, 'server')] })); } catch { t.skip('fengari is not installed (npm install in server/)'); return; }
  const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari;
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const run = (code) => {
    if (lauxlib.luaL_loadstring(L, to_luastring(code)) !== lua.LUA_OK) throw new Error(to_jsstring(lua.lua_tostring(L, -1)));
    lua.lua_call(L, 0, 1);
    const v = lua.lua_isnil(L, -1) ? null : to_jsstring(lua.lua_tolstring(L, -1));
    lua.lua_pop(L, 1);
    return v;
  };
  run(luaAssignment('T', ROUND_TRIP));
  assert.strictEqual(run('return T["end"]'), 'reserved word key');
  assert.strictEqual(run('return tostring(T.control == string.char(1) .. "2" .. string.char(7) .. string.char(31) .. "9" .. string.char(127))'), 'true');
  assert.strictEqual(run('return T.backslashes'), ROUND_TRIP.backslashes);
  assert.strictEqual(run('return T.unicode'), ROUND_TRIP.unicode);
  assert.strictEqual(run('return T.quotes'), ROUND_TRIP.quotes);
  assert.strictEqual(run('return T["key\\nnewline"]'), '3');
  assert.strictEqual(run('return T.nested.deeper.deepest[2].name'), 'Major Mana Potion');
  assert.strictEqual(run('return tostring(#T.numbers)'), '8');
});

// ---------------------------------------------------------------------------------------------
// version.js

test('versions parse, validate and compare the semver way', () => {
  assert.deepStrictEqual(version.parse('0.11.0'), { major: 0, minor: 11, patch: 0, pre: null });
  assert.deepStrictEqual(version.parse('1.2.3-beta.4'), { major: 1, minor: 2, patch: 3, pre: 'beta.4' });
  for (const bad of ['', '1.2', '1.2.3.4', 'v1.2.3', '01.2.3', '1.2.x', '1.2.3-', null, undefined, 123]) {
    assert.strictEqual(version.valid(bad), false, String(bad));
  }
  assert.ok(version.valid(' 1.2.3 '));
  const ordered = ['0.9.9', '0.10.0', '0.11.0-alpha', '0.11.0-beta', '0.11.0-beta.2', '0.11.0-beta.10', '0.11.0', '0.11.1', '1.0.0'];
  for (let i = 0; i < ordered.length - 1; i++) {
    assert.strictEqual(version.compare(ordered[i], ordered[i + 1]), -1, `${ordered[i]} < ${ordered[i + 1]}`);
    assert.strictEqual(version.compare(ordered[i + 1], ordered[i]), 1);
    assert.ok(version.lt(ordered[i], ordered[i + 1]));
    assert.ok(version.gt(ordered[i + 1], ordered[i]));
  }
  assert.strictEqual(version.compare('1.2.3', '1.2.3'), 0);
  assert.strictEqual(version.compare('garbage', '0.0.1'), -1, 'anything broken counts as older');
  assert.strictEqual(version.compare('1.0.0', null), 1);
  assert.strictEqual(version.compare(null, undefined), 0);
});

test('version bumps', () => {
  assert.strictEqual(version.bump('0.11.0', 'patch'), '0.11.1');
  assert.strictEqual(version.bump('0.11.9', 'minor'), '0.12.0');
  assert.strictEqual(version.bump('0.11.9', 'major'), '1.0.0');
  assert.strictEqual(version.bump('1.3.0-beta.2', 'minor'), '1.3.0', 'a pre-release graduates');
  assert.strictEqual(version.bump('1.3.1-beta.2', 'minor'), '1.4.0');
  assert.strictEqual(version.bump('1.3.1-beta.2', 'patch'), '1.3.1');
  assert.strictEqual(version.bump('2.0.0-rc.1', 'major'), '2.0.0');
  assert.strictEqual(version.bump('1.2.3', 'beta'), '1.2.4-beta.1');
  assert.strictEqual(version.bump('1.2.4-beta.1', 'beta'), '1.2.4-beta.2');
  assert.strictEqual(version.bump('1.2.4-rc.1', 'beta'), '1.2.4-beta.1');
  assert.strictEqual(version.bump('1.2.3'), '1.2.4');
  assert.throws(() => version.bump('1.2', 'patch'), /isn't a version/);
  assert.throws(() => version.bump('1.2.3', 'huge'), /Can't bump/);
});

// ---------------------------------------------------------------------------------------------
// toc.js

const TOC = '\uFEFF## Interface: 16001, 120105\r\n## Title: Guild Camp\r\n## Version: 0.11.0\r\n## X-Curse-Project-ID: 12345\r\n# a comment\r\n\r\nCore.lua\r\n  UI.lua  \r\nSub\\File.lua\r\n';

test('readToc reads fields and files', () => {
  const { fields, files } = readToc(TOC);
  assert.deepStrictEqual(fields, { Interface: '16001, 120105', Title: 'Guild Camp', Version: '0.11.0', 'X-Curse-Project-ID': '12345' });
  assert.deepStrictEqual(files, ['Core.lua', 'UI.lua', 'Sub\\File.lua']);
  assert.strictEqual(tocVersion(TOC), '0.11.0');
  assert.strictEqual(tocField(TOC, 'title'), 'Guild Camp');
  assert.strictEqual(tocField(TOC, 'Missing'), null);
  assert.strictEqual(tocVersion('## Title: x\n'), null);
  assert.strictEqual(readToc('## Version: 1.0.0\n## Version: 2.0.0\n').fields.Version, '1.0.0', 'first one wins');
  assert.strictEqual(tocVersion('##Version:1.2.3'), '1.2.3');
});

test('setTocField changes one line and keeps everything else, line endings included', () => {
  const out = setTocField(TOC, 'Version', '0.11.1');
  assert.strictEqual(out, TOC.replace('## Version: 0.11.0', '## Version: 0.11.1'));
  assert.strictEqual(setTocField(TOC, 'version', '2.0.0'), TOC.replace('## Version: 0.11.0', '## Version: 2.0.0'), 'field names ignore case');
  const lf = '## Title: A\n## Version: 1.0.0\n\nCore.lua\n';
  assert.strictEqual(setTocField(lf, 'Version', '1.0.1'), '## Title: A\n## Version: 1.0.1\n\nCore.lua\n');
  // A missing field goes after the last header line.
  assert.strictEqual(setTocField('## Title: A\r\n\r\nCore.lua\r\n', 'Version', '1.0.0'), '## Title: A\r\n## Version: 1.0.0\r\n\r\nCore.lua\r\n');
  assert.strictEqual(setTocField('Core.lua\n', 'Version', '1.0.0'), '## Version: 1.0.0\nCore.lua\n');
  assert.strictEqual(setTocField('## Version: 1.0.0', 'Version', '1.0.1'), '## Version: 1.0.1', 'no final newline');
  assert.throws(() => setTocField(lf, 'Bad:Name', 'x'), /valid \.toc field/);
});

test('the real addon .toc reads cleanly', () => {
  const text = fs.readFileSync(path.join(REPO, 'addon', 'WowGuild', 'WowGuild.toc'), 'utf8');
  const { fields, files } = readToc(text);
  assert.strictEqual(fields.Title, 'Guild Camp');
  assert.ok(version.valid(tocVersion(text)), `"${tocVersion(text)}" is a version`);
  assert.ok(files.includes('Core.lua'));
});

// ---------------------------------------------------------------------------------------------
// hash.js

test('hashes match known values, in memory and streamed from disk', async (t) => {
  assert.strictEqual(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  const abc512 = 'ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f';
  assert.strictEqual(sha512Base64(Buffer.from('abc')), Buffer.from(abc512, 'hex').toString('base64'));
  const dir = tmpDir(t);
  const file = path.join(dir, 'big.bin');
  const data = crypto.randomBytes(3 * 1024 * 1024 + 17);
  fs.writeFileSync(file, data);
  assert.strictEqual(await sha256File(file), sha256(data));
  assert.strictEqual(await sha512File(file), sha512Base64(data));
  await assert.rejects(sha256File(path.join(dir, 'missing')), /ENOENT/);
});

// ---------------------------------------------------------------------------------------------
// auctionator.js

test('extracts recent Auctionator prices and ignores stale ones', () => {
  const now = Date.UTC(2026, 10, 3);
  const today = Math.floor((now - Date.UTC(2020, 0, 1)) / 86400000);
  const db = {
    __dbversion: 6,
    'Forever Horde': {
      14047: { m: 120, h: { [today - 1]: 120, [today - 5]: 150 } },
      'g:19019:0': { m: 500000, h: { [today - 2]: 500000 } },
      13444: { m: 900, h: { [today - 40]: 900 } },
      'p:1234': { m: 1, h: { [today]: 1 } },
    },
    'Other Realm': { 14047: { m: 100, h: { [today - 1]: 100 } } },
  };
  const out = extractPrices(db, now).items.sort((a, b) => a[0] - b[0]);
  assert.deepStrictEqual(out, [[14047, 100, today - 1], [19019, 500000, today - 2]]);
});

test('Auctionator: newest day wins, history price fills a missing m, junk is skipped', () => {
  const now = Date.UTC(2026, 10, 3);
  const today = Math.floor((now - Date.UTC(2020, 0, 1)) / 86400000);
  const db = {
    'Realm A': { 1: { m: 50, h: { [today - 3]: 50 } }, 2: { h: { [today - 1]: 70, [today - 2]: 60 } }, 3: { m: 10 }, 4: null, 5: 'x' },
    'Realm B': { 1: { m: 80, h: { [today - 1]: 80 } } },
    junk: null,
  };
  const out = extractPrices(db, now).items.sort((a, b) => a[0] - b[0]);
  assert.deepStrictEqual(out, [[1, 80, today - 1], [2, 70, today - 1]]);
  assert.deepStrictEqual(extractPrices(null), { items: [] });
  assert.deepStrictEqual(extractPrices({}), { items: [] });
  // The parsed SavedVariables shape works directly.
  const sv = parseSavedVariables(`AUCTIONATOR_PRICE_DATABASE = { ["__dbversion"] = 6, ["Forever Horde"] = { ["14047"] = { ["m"] = 120, ["h"] = { ["${today}"] = 120 } } } }`);
  assert.deepStrictEqual(extractPrices(sv.AUCTIONATOR_PRICE_DATABASE, now).items, [[14047, 120, today]]);
});

// ---------------------------------------------------------------------------------------------
// zip.js

// Replaces a name inside a zip's bytes (local header and central directory), same length only.
function renameRaw(buf, from, to) {
  const a = Buffer.from(from, 'latin1'); const b = Buffer.from(to, 'latin1');
  assert.strictEqual(a.length, b.length);
  const out = Buffer.from(buf);
  let i = 0; let n = 0;
  while ((i = out.indexOf(a, i)) >= 0) { b.copy(out, i); i += b.length; n++; }
  assert.ok(n >= 2, 'found the name in both headers');
  return out;
}

function centralOffset(buf) {
  for (let i = buf.length - 22; i >= 0; i--) if (buf.readUInt32LE(i) === 0x06054b50) return buf.readUInt32LE(i + 16);
  throw new Error('no end record');
}

test('zip round trip: text, binary, empty file, nested folders, unicode names', () => {
  const binary = crypto.randomBytes(100 * 1024);
  const text = 'Guild Camp '.repeat(5000);
  const when = new Date(2026, 10, 7, 12, 34, 56);
  const buf = createZip([
    { name: 'WowGuild/WowGuild.toc', data: '## Version: 1.0.0\n', mtime: when },
    { name: 'WowGuild/Media/icon.blp', data: binary },
    { name: 'WowGuild/Empty.lua', data: '' },
    { name: 'WowGuild\\Deep\\Er\\Text.lua', data: text },
    { name: 'WowGuild/Zulé 日本.txt', data: Buffer.from('ü') },
    { name: 'WowGuild/EmptyFolder/', data: null },
    { name: 'u8.bin', data: new Uint8Array([1, 2, 3]) },
  ]);
  const entries = readZip(buf);
  assert.deepStrictEqual(entries.map((e) => [e.name, e.isDir]), [
    ['WowGuild/WowGuild.toc', false], ['WowGuild/Media/icon.blp', false], ['WowGuild/Empty.lua', false],
    ['WowGuild/Deep/Er/Text.lua', false], ['WowGuild/Zulé 日本.txt', false], ['WowGuild/EmptyFolder/', true], ['u8.bin', false],
  ]);
  assert.strictEqual(entries[0].data.toString(), '## Version: 1.0.0\n');
  assert.ok(entries[1].data.equals(binary));
  assert.strictEqual(entries[2].data.length, 0);
  assert.strictEqual(entries[3].data.toString(), text);
  assert.strictEqual(entries[4].data.toString(), 'ü');
  assert.deepStrictEqual([...entries[6].data], [1, 2, 3]);
  assert.strictEqual(entries[0].mtime.getTime(), when.getTime());
  assert.ok(buf.length < binary.length + text.length / 10, 'text is deflated');
  // Random bytes don't compress: stored (method 0). Repetitive text: deflate (method 8).
  const methods = [];
  for (let p = centralOffset(buf), n = 0; n < entries.length; n++) {
    methods.push(buf.readUInt16LE(p + 10));
    p += 46 + buf.readUInt16LE(p + 28) + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  assert.strictEqual(methods[1], 0, 'random bytes stored');
  assert.strictEqual(methods[2], 0, 'empty file stored');
  assert.strictEqual(methods[3], 8, 'text deflated');
  assert.strictEqual(readZip(createZip([])).length, 0, 'an empty zip is fine');
});

test('extractZip writes files and folders', (t) => {
  const dir = tmpDir(t);
  const buf = createZip([
    { name: 'WowGuild/WowGuild.toc', data: 'toc' },
    { name: 'WowGuild/Sub/Dir/File.lua', data: 'lua' },
    { name: 'WowGuild/Empty.lua', data: '' },
    { name: 'WowGuild/Folder/', data: null },
    { name: './WowGuild/./Dot.lua', data: 'dot' },
  ]);
  const written = extractZip(buf, path.join(dir, 'out'));
  assert.strictEqual(written.length, 5);
  assert.ok(written.every((w) => w.path.startsWith(path.join(dir, 'out'))));
  const tree = readTree(path.join(dir, 'out'));
  assert.deepStrictEqual(Object.keys(tree).sort(), ['WowGuild/Dot.lua', 'WowGuild/Empty.lua', 'WowGuild/Sub/Dir/File.lua', 'WowGuild/WowGuild.toc']);
  assert.strictEqual(tree['WowGuild/Sub/Dir/File.lua'].toString(), 'lua');
  assert.ok(fs.statSync(path.join(dir, 'out', 'WowGuild', 'Folder')).isDirectory());
});

test('extractZip refuses zip-slip names and writes nothing', (t) => {
  const dir = tmpDir(t);
  const dest = path.join(dir, 'dest');
  // [name in the zip, how it is made]. Raw names bypass createZip's "\" → "/" conversion.
  const cases = [
    ['../evil.txt'],
    ['a/../../evil.txt'],
    ['/abs/evil.txt'],
    ['C:/evil.txt'],
    ['C:evil.txt'],
    ['ok/.. /evil.txt'],
    ['ok/.../evil.txt'],
    ['ok/CON'],
    ['ok/nul.txt'],
    ['ok/file.txt:stream'],
    ['..\\evil.txt', '..+evil.txt'],
    ['a\\..\\..\\evil.txt', 'a+..+..+evil.txt'],
    ['\\\\server\\share\\x', '++server+share+x'],
    ['\\evil.txt', '+evil.txt'],
  ];
  for (const [name, placeholder] of cases) {
    let buf = createZip([{ name: 'fine.txt', data: 'fine' }, { name: placeholder || name, data: 'evil' }]);
    if (placeholder) buf = renameRaw(buf, placeholder, name);
    assert.throws(() => extractZip(buf, dest), (e) => e.code === 'ZIP_UNSAFE_PATH' && /unsafe file name/.test(e.message), name);
    assert.ok(!fs.existsSync(dest), `nothing written for ${name}`);
    assert.ok(!fs.existsSync(path.join(dir, 'evil.txt')));
  }
  assert.deepStrictEqual(safeSegments('a/./b//c'), ['a', 'b', 'c']);
  assert.deepStrictEqual(safeSegments('a\\b'), ['a', 'b']);
  assert.deepStrictEqual(safeSegments('..foo/bar..'), ['..foo', 'bar..'], 'dots inside a name are fine');
});

test('readZip refuses encrypted, ZIP64, unsupported and damaged zips clearly', () => {
  const good = createZip([{ name: 'a.txt', data: 'hello hello hello hello hello hello' }]);
  const cd = centralOffset(good);
  const end = good.length - 22;

  const encrypted = Buffer.from(good); encrypted.writeUInt16LE(encrypted.readUInt16LE(cd + 8) | 1, cd + 8);
  assert.throws(() => readZip(encrypted), (e) => e.code === 'ZIP_ENCRYPTED' && /password-protected/.test(e.message));

  const zip64 = Buffer.from(good); zip64.writeUInt32LE(0xffffffff, end + 16);
  assert.throws(() => readZip(zip64), (e) => e.code === 'ZIP_UNSUPPORTED' && /ZIP64/.test(e.message));
  const zip64b = Buffer.from(good); zip64b.writeUInt32LE(0xffffffff, cd + 20);
  assert.throws(() => readZip(zip64b), /ZIP64/);

  const bzip = Buffer.from(good); bzip.writeUInt16LE(12, cd + 10);
  assert.throws(() => readZip(bzip), (e) => e.code === 'ZIP_UNSUPPORTED' && /BZip2/.test(e.message));

  const split = Buffer.from(good); split.writeUInt16LE(1, end + 4);
  assert.throws(() => readZip(split), /several parts/);

  const badCrc = Buffer.from(good); badCrc.writeUInt32LE(123, cd + 16);
  assert.throws(() => readZip(badCrc), (e) => e.code === 'ZIP_INVALID' && /checksum/.test(e.message));

  assert.throws(() => readZip(Buffer.from('not a zip at all, just some words here')), (e) => e.code === 'ZIP_INVALID');
  assert.throws(() => readZip(Buffer.alloc(5)), /too small/);
  assert.throws(() => readZip(good.subarray(0, good.length - 40)), (e) => e.code === 'ZIP_INVALID');
  assert.throws(() => readZip(createZip([{ name: 'big', data: Buffer.alloc(5000) }]), { maxTotalSize: 1000 }), (e) => e.code === 'ZIP_TOO_BIG');
});

test('readZip reads data-descriptor zips and CP437 names', () => {
  // Rewrite a zip the way streaming writers do: sizes and CRC zeroed in the local header.
  const buf = createZip([{ name: 'stream.txt', data: 'streamed content '.repeat(20) }]);
  const dd = Buffer.from(buf);
  dd.writeUInt16LE(dd.readUInt16LE(6) | 0x08, 6);
  dd.writeUInt32LE(0, 14); dd.writeUInt32LE(0, 18); dd.writeUInt32LE(0, 22);
  assert.strictEqual(readZip(dd)[0].data.toString(), 'streamed content '.repeat(20));
  // No UTF-8 flag and bytes that aren't UTF-8: code page 437 (0x81 = ü).
  const cp = Buffer.from(createZip([{ name: 'Gr+n.txt', data: 'x' }]));
  let i = 0;
  while ((i = cp.indexOf('Gr+n', i, 'latin1')) >= 0) { cp[i + 2] = 0x81; i += 4; }
  for (const off of [6, centralOffset(cp) + 8]) cp.writeUInt16LE(cp.readUInt16LE(off) & ~0x800, off);
  assert.strictEqual(readZip(cp)[0].name, 'Grün.txt');
  assert.strictEqual(crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('zipDirectory: forward-slash names under a prefix, sorted, junk skipped, empty folders kept', (t) => {
  const dir = tmpDir(t);
  const src = path.join(dir, 'WowGuild');
  fs.mkdirSync(path.join(src, 'Media', 'Icons'), { recursive: true });
  fs.mkdirSync(path.join(src, 'Empty'), { recursive: true });
  fs.writeFileSync(path.join(src, 'WowGuild.toc'), '## Version: 1.0.0\n');
  fs.writeFileSync(path.join(src, 'Core.lua'), 'print("hi")');
  fs.writeFileSync(path.join(src, 'Media', 'Icons', 'a.blp'), crypto.randomBytes(2048));
  fs.writeFileSync(path.join(src, 'Thumbs.db'), 'junk');
  fs.writeFileSync(path.join(src, '.DS_Store'), 'junk');
  fs.writeFileSync(path.join(src, '.pkgmeta'), 'kept unless filtered');
  const names = readZip(zipDirectory(src, { prefix: 'WowGuild' })).map((e) => e.name);
  assert.deepStrictEqual(names, ['WowGuild/.pkgmeta', 'WowGuild/Core.lua', 'WowGuild/Empty/', 'WowGuild/Media/Icons/a.blp', 'WowGuild/WowGuild.toc']);
  const noPrefix = readZip(zipDirectory(src, { filter: (rel) => !rel.startsWith('.') && rel !== 'Media' })).map((e) => e.name);
  assert.deepStrictEqual(noPrefix, ['Core.lua', 'Empty/', 'WowGuild.toc']);
  assert.strictEqual(directoryEntries(src).find((e) => e.name === 'Core.lua').data.toString(), 'print("hi")');
  // Zip a folder and extract it elsewhere: the same files come back.
  const out = path.join(dir, 'out');
  extractZip(zipDirectory(src, { prefix: 'Copy' }), out);
  const before = readTree(src); delete before['Thumbs.db']; delete before['.DS_Store'];
  const after = readTree(path.join(out, 'Copy'));
  assert.deepStrictEqual(Object.keys(after).sort(), Object.keys(before).sort());
  for (const k of Object.keys(before)) assert.ok(after[k].equals(before[k]), k);
  assert.throws(() => zipDirectory(path.join(dir, 'missing')), /Folder not found/);
  assert.throws(() => zipDirectory(path.join(src, 'Core.lua')), /Not a folder/);
});

test('readZip reads a zip made by PowerShell Compress-Archive', (t) => {
  if (process.platform !== 'win32') { t.skip('needs Windows PowerShell'); return; }
  const dir = tmpDir(t);
  const src = path.join(dir, 'WowGuild');
  fs.mkdirSync(path.join(src, 'Sub', 'Deeper'), { recursive: true });
  const big = 'local x = 1\n'.repeat(4000);
  const bin = crypto.randomBytes(5000);
  fs.writeFileSync(path.join(src, 'WowGuild.toc'), '## Version: 1.0.0\r\n');
  fs.writeFileSync(path.join(src, 'Sub', 'Big.lua'), big);
  fs.writeFileSync(path.join(src, 'Sub', 'Deeper', 'bin.dat'), bin);
  fs.writeFileSync(path.join(src, 'Empty.lua'), '');
  const zipFile = path.join(dir, 'ps.zip');
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Compress-Archive -Path '${src.replace(/'/g, "''")}' -DestinationPath '${zipFile.replace(/'/g, "''")}' -Force`], { stdio: 'pipe', timeout: 60000 });
  } catch (e) {
    t.skip(`PowerShell Compress-Archive isn't available (${String(e.message).split('\n')[0]})`);
    return;
  }
  const entries = readZip(fs.readFileSync(zipFile));
  const files = Object.fromEntries(entries.filter((e) => !e.isDir).map((e) => [e.name, e.data]));
  assert.deepStrictEqual(Object.keys(files).sort(), ['WowGuild/Empty.lua', 'WowGuild/Sub/Big.lua', 'WowGuild/Sub/Deeper/bin.dat', 'WowGuild/WowGuild.toc']);
  assert.strictEqual(files['WowGuild/Sub/Big.lua'].toString(), big);
  assert.ok(files['WowGuild/Sub/Deeper/bin.dat'].equals(bin));
  assert.strictEqual(files['WowGuild/Empty.lua'].length, 0);
  const out = path.join(dir, 'out');
  extractZip(fs.readFileSync(zipFile), out);
  assert.strictEqual(fs.readFileSync(path.join(out, 'WowGuild', 'Sub', 'Big.lua'), 'utf8'), big);
});
