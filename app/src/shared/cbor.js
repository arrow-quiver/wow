'use strict';
// A small CBOR (RFC 8949) decoder for data the game writes with C_EncodingUtil.SerializeCBOR: Auctionator 8+ keeps
// each realm's prices as one CBOR string inside its SavedVariables. Zero dependencies.
//
//   decode(bytes) → value     bytes: Buffer | Uint8Array | latin1 string (one char per byte)
// Maps become plain objects (keys as strings; byte-string keys read as latin1, which is what Lua sees), arrays
// become arrays, byte and text strings become strings, numbers numbers (64-bit integers past 2^53 lose precision),
// true/false/null as such; undefined and other simple values become null. Tags are skipped (their value is kept).
// Throws on truncated or malformed data.

function toBytes(input) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  return Buffer.from(String(input), 'latin1');
}

const BREAK = Symbol('break');

function decode(input) {
  const b = toBytes(input);
  let i = 0;
  const need = (n) => { if (i + n > b.length) throw new Error('CBOR data is cut off'); };

  function length(info) {
    if (info < 24) return info;
    if (info === 24) { need(1); return b[i++]; }
    if (info === 25) { need(2); const v = b.readUInt16BE(i); i += 2; return v; }
    if (info === 26) { need(4); const v = b.readUInt32BE(i); i += 4; return v; }
    if (info === 27) { need(8); const v = Number(b.readBigUInt64BE(i)); i += 8; return v; }
    if (info === 31) return -1; // indefinite
    throw new Error(`bad CBOR length (${info})`);
  }

  function half(bits) {
    const exp = (bits >> 10) & 0x1f; const mant = bits & 0x3ff; const sign = bits & 0x8000 ? -1 : 1;
    if (exp === 0) return sign * 2 ** -14 * (mant / 1024);
    if (exp === 31) return mant ? NaN : sign * Infinity;
    return sign * 2 ** (exp - 15) * (1 + mant / 1024);
  }

  function chunks(major, n, asText) {
    if (n >= 0) { need(n); const s = b.toString(asText ? 'utf8' : 'latin1', i, i + n); i += n; return s; }
    let s = '';
    for (;;) {
      need(1);
      if (b[i] === 0xff) { i++; return s; }
      const ib = b[i++];
      if (ib >> 5 !== major) throw new Error('bad CBOR string chunk');
      s += chunks(major, length(ib & 0x1f), asText);
    }
  }

  function item() {
    need(1);
    const ib = b[i++];
    const major = ib >> 5; const info = ib & 0x1f;
    switch (major) {
      case 0: return length(info);
      case 1: return -1 - length(info);
      case 2: return chunks(2, length(info), false);
      case 3: return chunks(3, length(info), true);
      case 4: {
        const n = length(info); const out = [];
        if (n >= 0) { for (let k = 0; k < n; k++) out.push(item()); return out; }
        for (;;) { const v = item(); if (v === BREAK) return out; out.push(v); }
      }
      case 5: {
        const n = length(info); const out = {};
        const pair = () => { const k = item(); if (k === BREAK) return false; out[String(k)] = item(); return true; };
        if (n >= 0) { for (let k = 0; k < n; k++) pair(); return out; }
        while (pair());
        return out;
      }
      case 6: length(info); return item(); // a tag: keep the value
      default: // 7: simple values and floats
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22 || info === 23) return null;
        if (info === 25) { need(2); const v = half(b.readUInt16BE(i)); i += 2; return v; }
        if (info === 26) { need(4); const v = b.readFloatBE(i); i += 4; return v; }
        if (info === 27) { need(8); const v = b.readDoubleBE(i); i += 8; return v; }
        if (info === 31) return BREAK;
        if (info === 24) { need(1); i++; return null; }
        return null;
    }
  }

  const v = item();
  if (v === BREAK) throw new Error('unexpected CBOR break');
  return v;
}

module.exports = { decode };
