'use strict';
// Lua 5.1 guard for the addon. Tests run the addon on fengari (Lua 5.3), but the game runs Lua 5.1:
// code that only works on 5.3 would pass every test and break in game. So:
//   1. every addon/WowGuild/*.lua must parse as Lua 5.1 (luaparse, luaVersion '5.1');
//   2. a scan of the code (comments and strings removed) for constructs that are not Lua 5.1 or that
//      behave differently on fengari: //, goto and labels, bit operators, utf8.*, string.pack,
//      math.type, tonumber(s, 36);
//   3. when a real Lua 5.1 (lua5.1, lua51 or luajit) is on PATH, ShareCodec.lua runs the golden
//      vectors there too. Without one, that part is skipped with a message.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ADDON_DIR, CODEC_FILE, CHECK_FILE, loadVectors, toLuaSrc } = require('./fixtures/sharing-lua');

let luaparse = null;
try { luaparse = require('luaparse'); } catch { luaparse = null; }

const luaFiles = () => fs.readdirSync(ADDON_DIR).filter((f) => f.endsWith('.lua')).sort();

// Blank out comments and strings (newlines kept, so line numbers stay right).
function stripLua(src) {
  let out = '';
  let i = 0;
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  const longClose = (at) => {
    const m = /^\[(=*)\[/.exec(src.slice(at, at + 64));
    if (!m) return -1;
    const end = src.indexOf(`]${m[1]}]`, at + m[0].length);
    return end < 0 ? src.length : end + m[1].length + 2;
  };
  while (i < src.length) {
    const c = src[i];
    if (c === '-' && src[i + 1] === '-') {
      const end = src[i + 2] === '[' ? longClose(i + 2) : -1;
      if (end > 0) { out += blank(src.slice(i, end)); i = end; continue; }
      const nl = src.indexOf('\n', i);
      const stop = nl < 0 ? src.length : nl;
      out += blank(src.slice(i, stop));
      i = stop;
      continue;
    }
    if (c === '[' && (src[i + 1] === '[' || src[i + 1] === '=')) {
      const end = longClose(i);
      if (end > 0) { out += blank(src.slice(i, end)); i = end; continue; }
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      out += ' ' + blank(src.slice(i + 1, j)) + ' ';
      i = j + 1;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const BANNED = [
  [/\/\//, 'integer division (//) is Lua 5.3'],
  [/\bgoto\b/, 'goto is Lua 5.2+'],
  [/::[A-Za-z_]\w*::/, 'labels are Lua 5.2+'],
  [/&/, 'bit operator & is Lua 5.3'],
  [/\|/, 'bit operator | is Lua 5.3'],
  [/~(?!=)/, 'bit operator ~ is Lua 5.3'],
  [/<<|>>/, 'shift operators are Lua 5.3'],
  [/\butf8\s*\./, 'utf8.* is Lua 5.3'],
  [/\bstring\s*\.\s*(pack|unpack|packsize)\b/, 'string.pack/unpack is Lua 5.3'],
  [/\bmath\s*\.\s*(type|tointeger|ult)\b/, 'math.type/tointeger/ult is Lua 5.3'],
  [/\bbit32\s*\./, 'bit32 is Lua 5.2 only'],
  [/\btonumber\s*\((?:[^()]|\([^()]*\))*,\s*36\s*\)/, 'tonumber(s, 36) differs between Lua 5.1 (32-bit strtoul) and fengari'],
];

function scan(src) {
  const code = stripLua(src);
  const problems = [];
  code.split('\n').forEach((line, n) => {
    for (const [re, why] of BANNED) if (re.test(line)) problems.push(`line ${n + 1}: ${why}: ${src.split('\n')[n].trim()}`);
  });
  return problems;
}

test('the scanner finds every banned construct and ignores comments and strings', () => {
  const bad = ['local a = 7 // 2', 'goto continue', '::continue::', 'local b = x & 1', 'local c = x | 1', 'local d = ~x', 'local e = 1 << 3',
    'local f = utf8.char(1)', 'local g = string.pack("i", 1)', 'local h = math.type(1)', 'local i = bit32.band(1, 2)', 'local j = tonumber(s, 36)',
    'local k = tonumber(sub(s, 1, 2), 36)'];
  for (const line of bad) assert.equal(scan(line).length, 1, line);
  const fine = ['local a = x ~= y', '-- 7 // 2 goto & | ~ utf8.char', 'local s = "a // b | c ~ d & e"', "local t = 'tonumber(s, 36)'",
    '--[[ goto\n x // y ]] local z = 1', 'local u = [[ a | b ]]', 'local v = [==[ ]] // ]==]', 'local w = tonumber(s, 10)', 'local p = "a\\"//"'];
  for (const line of fine) assert.deepEqual(scan(line), [], line);
});

test('every addon Lua file avoids constructs that are not Lua 5.1', () => {
  const problems = [];
  for (const f of luaFiles()) for (const p of scan(fs.readFileSync(path.join(ADDON_DIR, f), 'utf8'))) problems.push(`${f} ${p}`);
  assert.deepEqual(problems, []);
});

test('every addon Lua file parses as Lua 5.1 (luaparse)', { skip: luaparse ? false : 'luaparse is not installed (npm install --save-dev luaparse)' }, () => {
  const problems = [];
  for (const f of luaFiles()) {
    try {
      luaparse.parse(fs.readFileSync(path.join(ADDON_DIR, f), 'utf8'), { luaVersion: '5.1', comments: false, locations: false });
    } catch (e) {
      problems.push(`${f}: ${e.message}`);
    }
  }
  assert.deepEqual(problems, []);
});

test('luaparse in 5.1 mode refuses 5.3 syntax (the guard really guards)', { skip: luaparse ? false : 'luaparse is not installed' }, () => {
  for (const src of ['local a = 7 // 2', 'local b = 1 & 2', 'goto x', '::x::']) {
    assert.throws(() => luaparse.parse(src, { luaVersion: '5.1' }), undefined, src);
  }
  assert.doesNotThrow(() => luaparse.parse('local a = 7 % 2; local b = a ~= 1', { luaVersion: '5.1' }));
});

// A real Lua 5.1 on PATH, if any.
function findLua51() {
  for (const bin of ['lua5.1', 'lua51', 'luajit', 'lua']) {
    const r = spawnSync(bin, ['-v'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    if (r.error || r.status !== 0) continue;
    const v = `${r.stdout || ''}${r.stderr || ''}`;
    if (/Lua 5\.1|LuaJIT/.test(v)) return bin;
  }
  return null;
}
const lua51 = findLua51();

// The runner a real Lua 5.1 executes: ShareCodec.lua alone, the shared checker, the vectors as Lua source.
const RUNNER = [
  'local codec, checker, vectors = arg[1], arg[2], arg[3]',
  'local SC = assert(loadfile(codec))("WowGuild", {})',
  'local check = assert(loadfile(checker))()',
  'local fails = check(SC, assert(loadfile(vectors))())',
  'local out = table.concat(fails, "\\n") .. (#fails > 0 and "\\n" or "") .. "DONE " .. #fails .. "\\n"',
  'io.write(out)',
  'return out',
].join('\n');

function writeRunner(dir) {
  const vecFile = path.join(dir, 'vectors.lua');
  const runFile = path.join(dir, 'run.lua');
  fs.writeFileSync(vecFile, `return ${toLuaSrc(loadVectors(), false)}\n`);
  fs.writeFileSync(runFile, RUNNER);
  return { vecFile, runFile };
}

test('the Lua 5.1 runner works (checked on fengari, so the real run cannot rot unseen)', () => {
  const { lua, lauxlib, lualib, to_luastring } = require('fengari');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guildcamp-lua51-'));
  try {
    const { vecFile, runFile } = writeRunner(dir);
    const L = lauxlib.luaL_newstate();
    lualib.luaL_openlibs(L);
    lua.lua_newtable(L);
    [CODEC_FILE, CHECK_FILE, vecFile].forEach((f, i) => { lua.lua_pushstring(L, to_luastring(f)); lua.lua_rawseti(L, -2, i + 1); });
    lua.lua_setglobal(L, to_luastring('arg'));
    // Keep the runner's io.write out of the test output.
    lauxlib.luaL_dostring(L, to_luastring('io.write = function() end'));
    assert.equal(lauxlib.luaL_loadbuffer(L, to_luastring(fs.readFileSync(runFile, 'utf8')), null, to_luastring('@run.lua')), lua.LUA_OK);
    const status = lua.lua_pcall(L, 0, 1, 0);
    const out = lua.lua_tojsstring(L, -1);
    assert.equal(status, lua.LUA_OK, out);
    assert.match(out, /^DONE 0\n$/, out.slice(0, 4000));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ShareCodec.lua makes the golden vectors on a real Lua 5.1', { skip: lua51 ? false : 'no lua5.1, lua51 or luajit on PATH: the real Lua 5.1 run is skipped (CI with Lua 5.1 installed runs it)' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guildcamp-lua51-'));
  try {
    const { vecFile, runFile } = writeRunner(dir);
    const r = spawnSync(lua51, [runFile, CODEC_FILE, CHECK_FILE, vecFile], { encoding: 'utf8', timeout: 120000, windowsHide: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /DONE 0\s*$/, r.stdout.slice(0, 4000));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
