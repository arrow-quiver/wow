'use strict';
// Test helper (not a test file): load addon/WowGuild/ShareCodec.lua ON ITS OWN in fengari and run
// the shared vector checker (sharing-check.lua) against it. Also turns JS values into Lua source,
// optionally writing every number as a float (1.0) so the codec is fed what Lua 5.3 calls floats.
// Used by sharing-codec.test.js and lua51-guard.test.js. Nothing here touches a game install.

const fs = require('fs');
const path = require('path');
const { lua, lauxlib, lualib, to_luastring } = require('fengari');

const ADDON_DIR = path.join(__dirname, '..', '..', '..', 'addon', 'WowGuild');
const CODEC_FILE = path.join(ADDON_DIR, 'ShareCodec.lua');
const CHECK_FILE = path.join(__dirname, 'sharing-check.lua');
const VECTORS_FILE = path.join(__dirname, 'sharing-vectors.json');

const RESERVED = new Set(['and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function', 'goto', 'if', 'in',
  'local', 'nil', 'not', 'or', 'repeat', 'return', 'then', 'true', 'until', 'while']);

// A Lua string literal holding exactly the UTF-8 bytes of s (every byte outside printable ASCII
// as a \ddd escape, so the source is plain ASCII and Lua 5.1 reads it the same way).
function luaStr(s) {
  let out = '"';
  for (const b of Buffer.from(s, 'utf8')) {
    if (b === 0x22) out += '\\"';
    else if (b === 0x5c) out += '\\\\';
    else if (b >= 0x20 && b < 0x7f) out += String.fromCharCode(b);
    else out += '\\' + String(b).padStart(3, '0');
  }
  return out + '"';
}

function toLuaSrc(v, floats) {
  if (v === null || v === undefined) return 'nil';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return 'nil';
    if (Number.isInteger(v)) return floats ? `${v}.0` : String(v);
    return String(v);
  }
  if (typeof v === 'string') return luaStr(v);
  if (Array.isArray(v)) {
    // nil holes would cut a Lua array short; vectors never hold them, but keep the position anyway.
    return `{${v.map((x) => toLuaSrc(x, floats)).join(',')}}`;
  }
  const parts = [];
  for (const k of Object.keys(v)) {
    if (v[k] === null || v[k] === undefined) continue;
    const key = /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && !RESERVED.has(k) ? k : `[${luaStr(k)}]`;
    parts.push(`${key}=${toLuaSrc(v[k], floats)}`);
  }
  return `{${parts.join(',')}}`;
}

function errorText(L) {
  const s = lua.lua_tojsstring(L, -1);
  lua.lua_pop(L, 1);
  return s;
}

class LuaCodec {
  constructor() {
    this.L = lauxlib.luaL_newstate();
    lualib.luaL_openlibs(this.L);
    const L = this.L;
    // ShareCodec.lua, alone, called like the game calls an addon file: (addonName, namespace).
    if (lauxlib.luaL_loadbuffer(L, fs.readFileSync(CODEC_FILE), null, to_luastring('@ShareCodec.lua')) !== lua.LUA_OK) throw new Error(errorText(L));
    lua.lua_pushstring(L, to_luastring('WowGuild'));
    lua.lua_newtable(L);
    lua.lua_pushvalue(L, -1);
    lua.lua_setglobal(L, to_luastring('__ns'));
    if (lua.lua_pcall(L, 2, 1, 0) !== lua.LUA_OK) throw new Error(errorText(L));
    lua.lua_setglobal(L, to_luastring('SC'));
    if (lauxlib.luaL_loadbuffer(L, fs.readFileSync(CHECK_FILE), null, to_luastring('@sharing-check.lua')) !== lua.LUA_OK) throw new Error(errorText(L));
    if (lua.lua_pcall(L, 0, 1, 0) !== lua.LUA_OK) throw new Error(errorText(L));
    lua.lua_setglobal(L, to_luastring('CHECK'));
  }

  // Run Lua source; returns the first result as raw bytes (Buffer) when it is a string, else null.
  run(src, name = 'test') {
    const L = this.L;
    const top = lua.lua_gettop(L);
    if (lauxlib.luaL_loadbuffer(L, to_luastring(src), null, to_luastring(name)) !== lua.LUA_OK) throw new Error(errorText(L));
    if (lua.lua_pcall(L, 0, 1, 0) !== lua.LUA_OK) throw new Error(errorText(L));
    let out = null;
    if (lua.lua_type(L, -1) === lua.LUA_TSTRING) out = Buffer.from(lua.lua_tolstring(L, -1));
    lua.lua_settop(L, top);
    return out;
  }

  text(src, name) { const b = this.run(src, name); return b === null ? null : b.toString('utf8'); }

  // Runs sharing-check.lua over the vectors; returns the list of failure lines.
  checkVectors(vectors, floats) {
    const out = this.text(`local V = ${toLuaSrc(vectors, floats)}\nreturn table.concat(CHECK(SC, V), "\\n")`, 'vectors');
    return out ? out.split('\n') : [];
  }
}

// The canonical dump sharing-check.lua makes of Lua values, made of JS values: nil fields left out,
// empty arrays and objects both "{}", strings length-prefixed (bytes), keys sorted.
function dump(v) {
  if (v === null || v === undefined) return 'nil';
  if (typeof v === 'boolean') return v ? 'T' : 'F';
  if (typeof v === 'number') return 'n' + String(v);
  if (typeof v === 'string') return 's' + Buffer.byteLength(v, 'utf8') + ':' + v;
  if (Array.isArray(v)) return v.length ? '[' + v.map(dump).join(',') + ']' : '{}';
  const keys = Object.keys(v).filter((k) => v[k] !== null && v[k] !== undefined && typeof v[k] !== 'function').sort();
  if (!keys.length) return '{}';
  return '{' + keys.map((k) => k + '=' + dump(v[k])).join(';') + '}';
}

function loadVectors() { return JSON.parse(fs.readFileSync(VECTORS_FILE, 'utf8')); }

module.exports = { LuaCodec, toLuaSrc, dump, luaStr, loadVectors, CODEC_FILE, CHECK_FILE, VECTORS_FILE, ADDON_DIR };
