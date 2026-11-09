'use strict';
// Lua tables in and out.
//
// parseSavedVariables reads the files WoW writes into WTF/Account/<name>/SavedVariables.
// It is a port of the old companion's parser and behaves the same way:
//   - the file is read byte for byte (latin1) and every string is decoded as UTF-8, so
//     character names such as "Zulé" survive;
//   - ["key"] = value, [1] = value, bare sequential values, nested tables, "-- comments",
//     --[[ long comments ]], [[long strings]], escapes, hex numbers and exponents;
//   - inf / nan become null (JSON has no such numbers);
//   - a table whose keys are exactly 1..n becomes an array, anything else an object.
//
// toLua / luaAssignment write the Inbox.lua file the addon reads back (WowGuild_Inbox).
// Zero dependencies: this file is shared by the app, the server and the release scripts.

// Pass the raw file Buffer (or a latin1 string) so UTF-8 names survive.
// { bytes: true } keeps every string as raw bytes (a latin1 string, one char per byte) instead: for addons that
// store binary data in strings (Auctionator 8+ keeps each realm's prices as CBOR). Buffer.from(s, 'latin1') gives the bytes.
function parseSavedVariables(input, { bytes = false } = {}) {
  const src = Buffer.isBuffer(input) ? input.toString('latin1') : String(input);
  const out = {};
  const p = new Parser(src, { bytes });
  p.ws();
  while (!p.eof()) {
    const name = p.ident();
    p.ws(); p.expect('='); p.ws();
    out[name] = p.value();
    p.ws();
    if (p.peek() === ';') { p.i++; p.ws(); }
  }
  return out;
}

const ESCAPES = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', f: '\f', v: '\v', '\\': '\\', '"': '"', "'": "'", '\n': '\n' };

class Parser {
  constructor(src, { bytes = false } = {}) { this.s = src; this.i = 0; this.bytes = bytes; }
  eof() { return this.i >= this.s.length; }
  peek() { return this.s[this.i]; }
  err(msg) {
    const line = this.s.slice(0, this.i).split('\n').length;
    throw new Error(`Lua parse error on line ${line}: ${msg}`);
  }
  expect(ch) {
    if (this.s[this.i] !== ch) this.err(`expected "${ch}" but found "${this.s[this.i] ?? 'end of file'}"`);
    this.i++;
  }
  ws() {
    for (;;) {
      const c = this.s[this.i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { this.i++; continue; }
      if (c === '-' && this.s[this.i + 1] === '-') {
        // --[[ ... ]] and --[==[ ... ]==] are long comments; anything else runs to the end of the line.
        // (WoW writes "-- [1]" after every array item, so only look closer when a "[" follows.)
        const long = this.s[this.i + 2] === '[' && /^--\[(=*)\[/.exec(this.s.slice(this.i, this.i + 64));
        if (long) {
          const close = `]${long[1]}]`;
          const end = this.s.indexOf(close, this.i + long[0].length);
          this.i = end < 0 ? this.s.length : end + close.length;
        } else {
          const nl = this.s.indexOf('\n', this.i);
          this.i = nl < 0 ? this.s.length : nl + 1;
        }
        continue;
      }
      break;
    }
  }
  ident() {
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.s.slice(this.i, this.i + 200));
    if (!m) this.err('expected a variable name');
    this.i += m[0].length;
    return m[0];
  }
  value() {
    this.ws();
    const c = this.peek();
    if (c === '{') return this.table();
    if (c === '"' || c === "'") return this.string();
    if (c === '[' && (this.s[this.i + 1] === '[' || this.s[this.i + 1] === '=')) return this.longString();
    if (this.s.startsWith('true', this.i)) { this.i += 4; return true; }
    if (this.s.startsWith('false', this.i)) { this.i += 5; return false; }
    if (this.s.startsWith('nil', this.i)) { this.i += 3; return null; }
    return this.number();
  }
  number() {
    const m = /^-?(0[xX][0-9a-fA-F]+|(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?|inf|nan)/.exec(this.s.slice(this.i, this.i + 64));
    if (!m) this.err(`unexpected "${this.peek() ?? 'end of file'}"`);
    this.i += m[0].length;
    const t = m[0];
    if (/inf|nan/.test(t)) return null;
    return /0[xX]/.test(t) ? (t.startsWith('-') ? -parseInt(t.slice(1), 16) : parseInt(t, 16)) : Number(t);
  }
  string(text = false) {
    const q = this.s[this.i++];
    let out = '';
    for (;;) {
      if (this.eof()) this.err('unterminated string');
      const c = this.s[this.i++];
      if (c === q) break;
      if (c !== '\\') { out += c; continue; }
      const e = this.s[this.i++];
      if (e in ESCAPES) out += ESCAPES[e];
      else if (/\d/.test(e)) {
        // \ddd: up to three decimal digits, one byte.
        let digits = e;
        while (digits.length < 3 && /\d/.test(this.s[this.i])) digits += this.s[this.i++];
        out += String.fromCharCode(Number(digits));
      } else out += e;
    }
    // The source is read byte for byte (latin1), so decode each string as UTF-8 (or keep the bytes).
    // Table keys are always text (realm and character names), even in bytes mode.
    return this.bytes && !text ? out : Buffer.from(out, 'latin1').toString('utf8');
  }
  longString() {
    const m = /^\[(=*)\[/.exec(this.s.slice(this.i, this.i + 64));
    if (!m) this.err('expected a long string');
    const close = `]${m[1]}]`;
    const start = this.i + m[0].length;
    const end = this.s.indexOf(close, start);
    if (end < 0) this.err('unterminated long string');
    this.i = end + close.length;
    // Lua drops a newline straight after the opening bracket. Long strings are UTF-8 too.
    return Buffer.from(this.s.slice(start, end).replace(/^\r?\n/, ''), 'latin1').toString('utf8');
  }
  table() {
    this.expect('{');
    const entries = [];
    let seq = 1;
    for (;;) {
      this.ws();
      if (this.eof()) this.err('unterminated table');
      if (this.peek() === '}') { this.i++; break; }
      let key;
      if (this.peek() === '[') {
        this.i++; this.ws();
        const kc = this.peek();
        key = kc === '"' || kc === "'" ? this.string(true) : this.value();
        this.ws(); this.expect(']'); this.ws(); this.expect('=');
      } else {
        const save = this.i;
        const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.s.slice(this.i, this.i + 200));
        if (m && !['true', 'false', 'nil'].includes(m[0])) {
          this.i += m[0].length; this.ws();
          if (this.peek() === '=') { this.i++; key = m[0]; } else this.i = save;
        }
      }
      if (key === undefined) key = seq++;
      const v = this.value();
      entries.push([key, v]);
      this.ws();
      if (this.peek() === ',' || this.peek() === ';') this.i++;
    }
    // A table whose keys are exactly 1..n (in any order, no gaps, no repeats) becomes an array.
    // (The max is a reduce, not Math.max(...keys), so a table with 200k keys can't overflow the stack.)
    const isArray = entries.length > 0 && entries.every(([k], idx) => k === idx + 1)
      || (entries.length > 0 && entries.every(([k]) => Number.isInteger(k) && k >= 1) && new Set(entries.map(([k]) => k)).size === entries.length
        && entries.reduce((max, [k]) => (k > max ? k : max), 0) === entries.length);
    if (isArray) {
      const arr = new Array(entries.length);
      for (const [k, v] of entries) arr[k - 1] = v;
      return arr;
    }
    const obj = {};
    for (const [k, v] of entries) obj[String(k)] = v;
    return obj;
  }
}

// Lua 5.1 reserved words can't be bare table keys (`end = 1` is a syntax error).
const RESERVED = new Set(['and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function', 'if', 'in',
  'local', 'nil', 'not', 'or', 'repeat', 'return', 'then', 'true', 'until', 'while', 'goto']);
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isLuaIdentifier(name) {
  return typeof name === 'string' && IDENT.test(name) && !RESERVED.has(name);
}

// A double-quoted Lua string. JSON's escapes (\" \\ \n \r \t \b \f) mean the same in Lua;
// JSON's \u00XX for other control characters becomes Lua's \ddd. Three digits are always
// written so a following digit can't be read as part of the escape ("\0012" is char 1 then "2").
// Non-ASCII characters stay as they are: the file is written as UTF-8.
function luaString(s) {
  return JSON.stringify(s).replace(/\\(\\|u([0-9a-fA-F]{4}))/g, (m, what, hex) => {
    if (what === '\\') return m; // an escaped backslash, keep it (and don't misread what follows)
    const n = parseInt(hex, 16);
    return n < 128 ? '\\' + String(n).padStart(3, '0') : m;
  });
}

// Lua serialiser for the inbox file. Port of the old server's sync.js toLua: two-space indent,
// trailing commas, identifier keys bare, every other key as ["key"].
function toLua(value, indent = '') {
  if (value === null || value === undefined) return 'nil';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'nil';
  if (typeof value === 'string') return luaString(value);
  if (typeof value === 'bigint') return String(value);
  if (typeof value !== 'object') return 'nil'; // functions, symbols: nothing Lua can hold
  const next = indent + '  ';
  if (Array.isArray(value)) {
    if (!value.length) return '{}';
    return '{\n' + value.map((v) => next + toLua(v, next) + ',').join('\n') + '\n' + indent + '}';
  }
  const keys = Object.keys(value);
  if (!keys.length) return '{}';
  return '{\n' + keys.map((k) => {
    const key = isLuaIdentifier(k) ? k : `[${luaString(k)}]`;
    return `${next}${key} = ${toLua(value[k], next)},`;
  }).join('\n') + '\n' + indent + '}';
}

// A whole Lua file that sets one global, e.g. Inbox.lua: `WowGuildInbox = {...}`.
function luaAssignment(name, value) {
  if (!isLuaIdentifier(name)) throw new Error(`"${name}" can't be used as a Lua variable name.`);
  return `-- Written by the Guild Camp app. Do not edit.\n${name} = ${toLua(value)}\n`;
}

module.exports = { parseSavedVariables, toLua, luaAssignment, isLuaIdentifier };
