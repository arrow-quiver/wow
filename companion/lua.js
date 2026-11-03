// Parser for the Lua tables WoW writes into SavedVariables files.
// Handles: ["key"] = value, [1] = value, bare sequential values, nested
// tables, strings with escapes, numbers (incl. hex/exponent), true/false/nil
// and "-- comments".

// Pass the raw file Buffer (or a latin1 string) so UTF-8 names survive.
function parseSavedVariables(input) {
  const src = Buffer.isBuffer(input) ? input.toString('latin1') : input;
  const out = {};
  const p = new Parser(src);
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

class Parser {
  constructor(src) { this.s = src; this.i = 0; }
  eof() { return this.i >= this.s.length; }
  peek() { return this.s[this.i]; }
  err(msg) {
    const line = this.s.slice(0, this.i).split('\n').length;
    throw new Error(`Lua parse error on line ${line}: ${msg}`);
  }
  expect(ch) { if (this.s[this.i] !== ch) this.err(`expected "${ch}" but found "${this.s[this.i] ?? 'end of file'}"`); this.i++; }
  ws() {
    for (;;) {
      const c = this.s[this.i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { this.i++; continue; }
      if (c === '-' && this.s[this.i + 1] === '-') {
        if (this.s.startsWith('--[[', this.i)) {
          const end = this.s.indexOf(']]', this.i + 4);
          this.i = end < 0 ? this.s.length : end + 2;
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
    if (!m) this.err(`unexpected "${this.peek()}"`);
    this.i += m[0].length;
    const t = m[0];
    if (/inf|nan/.test(t)) return null;
    return /0[xX]/.test(t) ? (t.startsWith('-') ? -parseInt(t.slice(1), 16) : parseInt(t, 16)) : Number(t);
  }
  string() {
    const q = this.s[this.i++];
    let out = '';
    for (;;) {
      if (this.eof()) this.err('unterminated string');
      const c = this.s[this.i++];
      if (c === q) break;
      if (c !== '\\') { out += c; continue; }
      const e = this.s[this.i++];
      const map = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', f: '\f', v: '\v', '\\': '\\', '"': '"', "'": "'", '\n': '\n' };
      if (e in map) out += map[e];
      else if (/\d/.test(e)) {
        let digits = e;
        while (digits.length < 3 && /\d/.test(this.s[this.i])) digits += this.s[this.i++];
        out += String.fromCharCode(Number(digits));
      } else out += e;
    }
    // The source is read byte-for-byte (latin1), so decode each string as UTF-8.
    return Buffer.from(out, 'latin1').toString('utf8');
  }
  longString() {
    const m = /^\[(=*)\[/.exec(this.s.slice(this.i));
    const close = `]${m[1]}]`;
    const start = this.i + m[0].length;
    const end = this.s.indexOf(close, start);
    if (end < 0) this.err('unterminated long string');
    this.i = end + close.length;
    return this.s.slice(start, end).replace(/^\r?\n/, '');
  }
  table() {
    this.expect('{');
    const entries = [];
    let seq = 1;
    for (;;) {
      this.ws();
      if (this.peek() === '}') { this.i++; break; }
      let key;
      if (this.peek() === '[') {
        this.i++; this.ws();
        key = this.value();
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
    // A table whose keys are exactly 1..n becomes an array.
    const isArray = entries.length > 0 && entries.every(([k], idx) => k === idx + 1)
      || (entries.length > 0 && entries.every(([k]) => Number.isInteger(k) && k >= 1) && new Set(entries.map(([k]) => k)).size === entries.length
        && Math.max(...entries.map(([k]) => k)) === entries.length);
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

module.exports = { parseSavedVariables };
