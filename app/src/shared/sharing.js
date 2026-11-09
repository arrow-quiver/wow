'use strict';
// The Guild Camp sharing codec (docs/SHARING.md, protocol v1). Zero dependencies.
//
// One record shape travels between guildmates' addons, sits in WowGuildDB and in the app's
// shared_records table:   <type>:<key>^<v>^<author>^<flags>^<field 1>^<field 2>…
// addon/WowGuild/ShareCodec.lua is the same codec in Lua 5.1 and MUST produce the same bytes;
// test/sharing-codec.test.js checks both against test/fixtures/sharing-vectors.json
// (regenerate with `node test/fixtures/make-sharing-vectors.js` after a deliberate change).
//
// What lives here
//   TYPES                      the type table (§4.3): space, key rule, named fields, final, expiry, max bytes
//   encode / decode / parse    records to and from { id, type, key, v, t, author, del, fields }
//   encodeBody                 just the fields part (what the app puts in an outbox entry's body)
//   escape / unescape / cutUtf8, toB36 / fromB36 / pad36, encodeIds / decodeIds, djb2
//   bucket / shortId / digestTerm / digestValue / digestString      (§6)
//   makeVersion / nextT / tOfVersion / isFinalV / compareVersions / compareRecords   (§4.2)
//   expiresAt / isExpired / hourStart / isFinal / isFoldable         (§4.3, §11)
//   checkRecord / acceptRecord / overAuthorCaps                      (§5, §11)
//   message framing for H / I / G / R / M                            (§6)
//   derived state: raidStatus, countingReserves, craftRequestState, bankRequestState,
//                  driveState, loyaltyFold, loyaltyCheckpoint        (§4.4, JS only)
//   ACCEPT_CASES               one accept/refuse table for the addon and the core
//
// Conventions
//   - Strings are JS strings; byte lengths, limits, hashes and comparisons use their UTF-8 bytes,
//     so the results match the Lua codec, which sees raw bytes.
//   - Numbers on the wire are base36, made by our own loops. All arithmetic stays below 2^53.
//   - Nothing here throws on bad input: decoders return null, checks return a reason.
//   - Field names are listed in docs/SHARING.md, Appendix A.

// ------------------------------------------------------------------------------------------
// Constants (one table; ShareCodec.lua mirrors it as C.K)
// ------------------------------------------------------------------------------------------
const K = Object.freeze({
  MAJOR: 1,
  MINOR: 1,
  PREFIX: 'GuildCamp',
  FINAL_BASE: 2700000000000, // final band: v = FINAL_BASE - t*64 + h
  FINAL_MIN: 1350000000000, // any v at or above this is in the final band
  HOUR: 3600,
  DAY: 86400,
  FUTURE_SLACK: 300, // §5 rule 4: t more than 300 s in the future is refused
  PARENT_FALLBACK_DAYS: 120, // "with the parent", while the parent is unknown
  TOMB_NEVER_DAYS: 180, // tombstones of types that never expire
  UNKNOWN_DAYS: 14, // records of types this version does not know (anyone may write them in anyone's name)
  ID_MAX: 64,
  NAME_MAX: 48,
  RECORD_MAX: 8715, // 35 parts × 249 bytes: the largest record the wire can carry
  MEMBER_BUCKETS: 32,
  OFFICER_BUCKETS: 16,
  BUCKETS: 48,
  SHORT_MOD: 1679616, // 36^4
  DIGEST_MOD: 1679615,
  INT_MAX_CHARS: 10, // 36^10 < 2^53
  MSG_MAX: 255,
  HELLO_MAX: 210,
  HELLO_VERSION_MAX: 11,
  INV_PER_PAGE: 20,
  INV_MAX: 250,
  INV_PAGES_MAX: 35,
  GET_MAX_IDS: 55,
  R_SINGLE_MAX: 253, // a record longer than this goes in M parts
  M_DATA_MAX: 249,
  M_PARTS_MAX: 35,
  MID_MOD: 1296,
  AUTHOR_MAX_RECORDS: 300,
  AUTHOR_MAX_BYTES: 65536,
  AUTHOR_MAX_RC_BYTES: 32768,
  STORE_MAX_RECORDS: 4000,
  STORE_MAX_BYTES: 614400,
  UNKNOWN_MAX_RECORDS: 200, // records of unknown types: one store-wide budget, no per-author caps
  UNKNOWN_MAX_BYTES: 32768,
  BONUS_STEP: 10,
  LY_EVERY_DAYS: 14,
  LY_FOLD_DAYS: 30,
  SHRINK_ROUNDS: 16,
});

const TWO32 = 4294967296;
const B36 = '0123456789abcdefghijklmnopqrstuvwxyz';
const VARINT = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_';
const HEX = '0123456789ABCDEF';

// English names for skill-line ids (rc keys and sh items carry the id).
const SKILLS = Object.freeze({
  129: 'First Aid', 164: 'Blacksmithing', 165: 'Leatherworking', 171: 'Alchemy', 182: 'Herbalism',
  185: 'Cooking', 186: 'Mining', 197: 'Tailoring', 202: 'Engineering', 333: 'Enchanting', 356: 'Fishing',
  393: 'Skinning', 755: 'Jewelcrafting', 773: 'Inscription',
});

// ------------------------------------------------------------------------------------------
// The type table (§4.3). ShareCodec.lua holds the same table; a test compares them.
//
// Field kinds: text (max = byte limit before escaping), int (base36; dash: null is written "-"),
// enum (one char of `values`), flag ("1" or empty), ids (varint id list), list (items joined
// with ";": `of` = one scalar per item, or `parts` = named parts joined with "," plus an
// optional variadic `rest`), tuple (named parts joined with ","), switch (layout picked by an
// earlier field's value).
// Key segments (split on ":"): name, b36x6 (random key or instance key), int, pid, tab, one.
// ------------------------------------------------------------------------------------------
const text = (n, max) => ({ n, k: 'text', max });
const int = (n, extra) => Object.assign({ n, k: 'int' }, extra || {});
const enm = (n, values) => ({ n, k: 'enum', values });
const flag = (n) => ({ n, k: 'flag' });
const list = (n, maxItems, item) => Object.assign({ n, k: 'list', maxItems }, item);
const tuple = (n, parts) => ({ n, k: 'tuple', parts });
const pText = (n, max) => ({ n, k: 'text', max });
const pInt = (n) => ({ n, k: 'int' });
const ITEM_COUNT = [pInt('id'), pInt('count')];

const TYPES = {
  ch: {
    key: ['name'], author: 'key', max: 400, expiry: { days: 60 },
    fields: [
      text('pid', 64), text('battletag', 32), flag('main'), list('alts', 20, { of: { k: 'text', max: 48 } }),
      text('class', 20), text('race', 20), int('level'), text('faction', 12), int('ilvl'), int('repair'),
      tuple('consumables', [pInt('flask'), pInt('elixir'), pInt('potion'), pInt('food'), pInt('bandage')]),
      list('professions', 12, { parts: [pInt('skill'), pInt('rank'), pInt('max')] }),
      tuple('pvp', [pInt('rank'), pInt('hk')]), text('addon', 16),
      // Raid readiness (appended fields: older addons leave them out): points per talent tree, resistances, unenchanted slot ids.
      tuple('talents', [pInt('a'), pInt('b'), pInt('c'), pInt('unspent')]),
      tuple('resists', [pInt('fire'), pInt('nature'), pInt('frost'), pInt('shadow'), pInt('arcane')]),
      list('unenchanted', 10, { of: { k: 'int' } }),
    ],
  },
  rc: {
    key: ['name', 'int'], author: 'key', max: 2048, maxIf: { field: 'kind', value: 'n', max: 6144 },
    expiry: { days: 60, newerOf: 'ch' },
    fields: [
      enm('kind', 'sin'), int('count'),
      { n: 'list', k: 'switch', on: 'kind', cases: { n: { k: 'list', maxItems: 500, of: { k: 'text', max: 100 } } }, default: { k: 'ids', maxItems: 2000 } },
    ],
  },
  su: {
    key: ['b36x6', 'pid'], max: 400, expiry: { parent: 'RD', seg: 1 },
    fields: [
      text('character', 48), enm('role', 'thd'), enm('status', 'ytnb'), text('note', 120),
      list('reserves', 10, { of: { k: 'text', max: 12 } }), int('reservesAt'),
      list('prev', 10, { of: { k: 'text', max: 12 } }), int('prevAt'),
    ],
  },
  cr: {
    key: ['b36x6'], max: 400, final: { field: 'state', values: 'xd' }, expiry: { days: 30, finalDays: 7 },
    fields: [text('pid', 64), text('item', 100), text('notes', 200), enm('state', 'oxd')],
  },
  cl: {
    key: ['b36x6', 'pid'], max: 60, expiry: { parent: 'cr', seg: 1 },
    fields: [enm('state', 'cdw'), int('claimedAt')],
  },
  lp: {
    key: ['pid', 'name'], max: 400, expiry: { days: 3 },
    fields: [text('character', 48), int('level'), text('zone', 60), text('when', 60), text('note', 140)],
  },
  ca: {
    key: ['b36x6'], max: 300, expiry: { days: 1 },
    fields: [text('character', 48), text('zone', 60), int('needed'), text('message', 200)],
  },
  // Dungeon groups: dg is a group a guildmate puts together (the leader fills one of the role slots); dj is a
  // guildmate joining it with a role (withdrawn 'w'). First come, first in; the rest wait (dungeonGroupState).
  dg: {
    key: ['b36x6'], max: 400, final: { field: 'state', values: 'xd' }, expiry: { field: 'startsAt', days: 1 },
    fields: [
      text('pid', 64), text('character', 48), text('dungeon', 60), int('startsAt'), enm('role', 'thd'), int('level'),
      int('tank'), int('heal'), int('dps'), text('note', 140), enm('state', 'oxd'),
    ],
  },
  dj: {
    key: ['b36x6', 'pid'], max: 160, expiry: { parent: 'dg', seg: 1 },
    fields: [text('character', 48), enm('role', 'thd'), enm('status', 'yw'), text('class', 20), int('level'), int('joinedAt')],
  },
  dc: {
    key: ['b36x6'], max: 250, expiry: { parent: 'DR', field: 'drive' },
    fields: [text('pid', 64), text('drive', 8), text('character', 48), int('amount'), text('note', 120)],
  },
  bq: {
    key: ['b36x6'], max: 400, final: { field: 'state', values: 'x' }, expiry: { days: 30 },
    fields: [text('pid', 64), text('item', 100), int('count'), text('note', 200), enm('state', 'ox')],
  },
  gb: {
    key: ['tab'], max: 1536, expiry: { days: 30 },
    variants: {
      0: [
        int('scannedAt'), int('money'), list('tabs', 8, { of: { k: 'text', max: 32 } }),
        list('log', 25, { parts: [pInt('at'), pText('kind', 12), pText('who', 48), pInt('item'), pInt('count'), pInt('amount')] }),
      ],
    },
    fields: [list('items', 98, { parts: ITEM_COUNT })],
  },
  bk: {
    key: ['name'], author: 'key', max: 2048, expiry: { days: 30 },
    fields: [list('bags', 200, { parts: ITEM_COUNT }), list('bank', 300, { parts: ITEM_COUNT })],
  },
  sh: {
    key: ['pid'], max: 1024, expiry: { days: 30 },
    fields: [list('items', 20, { parts: [pText('name', 100), pInt('qty'), pInt('skill')] })],
  },
  pr: {
    key: ['pid'], max: 800, expiry: { days: 14 },
    fields: [int('day'), list('prices', 60, { parts: [pInt('id'), pInt('copper')] })],
  },
  RD: {
    key: ['b36x6'], max: 600, expiry: { field: 'startsAt', days: 45 },
    fields: [
      enm('kind', 'rpe'), text('title', 60), text('instance', 60), int('startsAt'), int('minutes'), int('size'),
      int('srLimit'), text('notes', 300),
    ],
  },
  RT: {
    key: ['b36x6'], max: 2048, final: { field: 'status', values: 'xd' }, expiry: { parent: 'RD', seg: 1 },
    fold: { field: 'status', value: 'd', kindField: 'kind', kind: 'r' },
    fields: [
      enm('status', 'olxd'), int('lockedAt'), enm('kind', 'rpe'), text('instance', 8), int('closedAt'),
      list('attendees', 60, { parts: [pText('pid', 64)], rest: { n: 'items', k: 'text', max: 12, maxItems: 20 } }),
      list('noShows', 60, { of: { k: 'text', max: 64 } }),
    ],
  },
  LA: {
    key: ['b36x6'], max: 300, expiry: { days: 180 }, fold: {},
    fields: [
      text('raid', 8), text('instance', 8), text('item', 12), text('itemName', 100), text('character', 48),
      text('pid', 64), enm('kind', 'smof'), int('roll'), int('bonus'),
    ],
  },
  LL: {
    key: ['b36x6'], max: 8192, expiry: { never: true },
    fields: [
      text('name', 60), list('bosses', 40, { of: { k: 'text', max: 60 } }),
      list('items', 150, { parts: [pText('item', 12), pInt('boss'), pText('name', 100)] }),
    ],
  },
  LY: {
    key: ['b36x6'], max: 3072, expiry: { never: true },
    fields: [int('upto'), list('bonuses', 200, { parts: [pText('pid', 64), pText('item', 12), pInt('bonus')] })],
  },
  AN: { key: ['b36x6'], max: 600, expiry: { days: 60 }, fields: [text('body', 500)] },
  DR: {
    key: ['b36x6'], max: 500, final: { field: 'state', values: 'c' }, expiry: { days: 180, finalDays: 60 },
    fields: [text('title', 80), text('unit', 40), int('goal'), text('notes', 300), enm('state', 'oc')],
  },
  BH: { key: ['b36x6'], max: 40, expiry: { parent: 'bq', seg: 1 }, fields: [enm('state', 'sd')] },
  BC: { key: ['one'], max: 700, expiry: { never: true }, fields: [list('names', 50, { of: { k: 'text', max: 48 } })] },
  CFG: {
    key: ['one'], max: 40, rank: 'gm', expiry: { never: true },
    fields: [int('officerRankMax'), int('relayRankMax', { dash: true })],
  },
  WH: {
    key: ['one'], max: 300, channel: 'OFFICER', noBucket: true, firstHand: true, expiry: { never: true },
    fields: [text('url', 250)],
  },
};
for (const code of Object.keys(TYPES)) {
  TYPES[code].code = code;
  TYPES[code].space = code === code.toUpperCase() ? 'officer' : 'member';
}

function spaceOf(type) {
  if (typeof type !== 'string') return null;
  if (/^[a-z]{1,4}$/.test(type)) return 'member';
  if (/^[A-Z]{1,4}$/.test(type)) return 'officer';
  return null;
}

// ------------------------------------------------------------------------------------------
// Bytes, hashes, base36
// ------------------------------------------------------------------------------------------
const isAscii = (s) => !/[^\x00-\x7f]/.test(s);
const utf8 = (s) => Buffer.from(s, 'utf8');
function byteLength(s) {
  if (typeof s !== 'string') return 0;
  return isAscii(s) ? s.length : Buffer.byteLength(s, 'utf8');
}

// djb2 over the UTF-8 bytes: h = 5381; h = (h*33 + byte) mod 2^32. Exact in doubles.
function djb2(s) {
  s = typeof s === 'string' ? s : '';
  let h = 5381;
  if (isAscii(s)) {
    for (let i = 0; i < s.length; i++) h = (h * 33 + s.charCodeAt(i)) % TWO32;
    return h;
  }
  for (const b of utf8(s)) h = (h * 33 + b) % TWO32;
  return h;
}

// A non-negative whole number below 36^10, else null.
function wholeNumber(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null;
  n = Math.floor(n);
  return n < 3656158440062976 ? n : null;
}

function toB36(n) {
  n = wholeNumber(n);
  if (n === null) return '';
  if (n === 0) return '0';
  let out = '';
  while (n > 0) {
    const d = n % 36;
    out = B36[d] + out;
    n = (n - d) / 36;
  }
  return out;
}

function pad36(n, width) {
  width = typeof width === 'number' && width >= 0 ? Math.floor(Math.min(width, 16)) : 0;
  let s = toB36(n);
  if (s.length > width) s = s.slice(s.length - width); // callers keep n below 36^width
  while (s.length < width) s = '0' + s;
  return s;
}

// '' or bad characters → null. At most INT_MAX_CHARS characters.
function fromB36(s) {
  if (typeof s !== 'string' || s.length === 0 || s.length > K.INT_MAX_CHARS) return null;
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const d = B36.indexOf(s[i]);
    if (d < 0) return null;
    n = n * 36 + d;
  }
  return n;
}

// Cut to at most max bytes without splitting a UTF-8 sequence.
function cutUtf8(s, max) {
  if (typeof s !== 'string') return '';
  if (typeof max !== 'number' || Number.isNaN(max)) return s;
  if (isAscii(s)) return s.length > max ? s.slice(0, Math.max(0, max)) : s;
  const b = utf8(s);
  if (b.length <= max) return b.toString('utf8');
  let cut = Math.max(0, max);
  while (cut > 0 && (b[cut] & 0xc0) === 0x80) cut--;
  return b.subarray(0, cut).toString('utf8');
}

// ~ ^ ; , # | , bytes below 0x20 and 0x7F → "~XX" (uppercase hex). UTF-8 passes through.
const MUST_ESCAPE = (c) => c < 0x20 || c === 0x7f || c === 0x7e || c === 0x5e || c === 0x3b || c === 0x2c || c === 0x23 || c === 0x7c;
function escape(s, max) {
  if (typeof s !== 'string') return '';
  if (max !== undefined && max !== null) s = cutUtf8(s, max);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out += c < 0x80 && MUST_ESCAPE(c) ? '~' + HEX[c >> 4] + HEX[c & 15] : s[i];
  }
  return out;
}

// Cut an escaped text to at most max bytes, never inside a "~XX" escape or a UTF-8 sequence.
function cutEscaped(e, max) {
  if (typeof e !== 'string') return '';
  if (typeof max !== 'number' || Number.isNaN(max)) return e;
  if (byteLength(e) <= max) return e;
  const b = utf8(e);
  let cut = Math.max(0, max);
  while (cut > 0 && (b[cut] & 0xc0) === 0x80) cut--;
  if (cut >= 1 && b[cut - 1] === 0x7e) cut -= 1;
  else if (cut >= 2 && b[cut - 2] === 0x7e) cut -= 2;
  return b.subarray(0, cut).toString('utf8');
}

// Strict: only "~" + two uppercase hex digits of a byte that must be escaped; no raw specials.
function unescape(s) {
  if (typeof s !== 'string') return null;
  if (s.indexOf('~') < 0) return /[\x00-\x1f\x7f^;,#|]/.test(s) ? null : s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const c = s.charCodeAt(i);
    if (ch === '~') {
      const hi = HEX.indexOf(s[i + 1] || 'x');
      const lo = HEX.indexOf(s[i + 2] || 'x');
      if (hi < 0 || lo < 0) return null;
      const b = hi * 16 + lo;
      if (!MUST_ESCAPE(b)) return null;
      out += String.fromCharCode(b);
      i += 2;
    } else if (c < 0x80 && MUST_ESCAPE(c)) return null;
    else out += ch;
  }
  return out;
}

// ------------------------------------------------------------------------------------------
// Varint id lists: sorted, unique, first value then deltas. Each number is written most
// significant group first, five bits per character; characters 0–31 of VARINT end a number,
// 32–63 mean "five more bits follow".
// ------------------------------------------------------------------------------------------
function varint(n) {
  const groups = [];
  do { const d = n % 32; groups.push(d); n = (n - d) / 32; } while (n > 0);
  let out = '';
  for (let i = groups.length - 1; i >= 0; i--) out += VARINT[i > 0 ? groups[i] + 32 : groups[i]];
  return out;
}

function encodeIds(ids, maxItems) {
  if (!Array.isArray(ids)) return '';
  const vals = [];
  for (const x of ids) {
    if (x === null || x === undefined) break;
    const n = wholeNumber(x);
    if (n !== null) vals.push(n);
  }
  vals.sort((a, b) => a - b);
  let out = '';
  let prev = -1;
  let count = 0;
  for (const n of vals) {
    if (n === prev) continue;
    if (maxItems && count >= maxItems) break;
    out += varint(prev < 0 ? n : n - prev);
    prev = n;
    count++;
  }
  return out;
}

function decodeIds(s) {
  if (typeof s !== 'string') return null;
  const out = [];
  let acc = 0;
  let digits = 0;
  let prev = null;
  for (let i = 0; i < s.length; i++) {
    const d = VARINT.indexOf(s[i]);
    if (d < 0) return null;
    acc = acc * 32 + (d % 32);
    digits++;
    if (digits > 10) return null;
    if (d < 32) {
      const n = prev === null ? acc : prev + acc;
      out.push(n);
      prev = n;
      acc = 0;
      digits = 0;
    }
  }
  return digits === 0 ? out : null;
}

// ------------------------------------------------------------------------------------------
// Buckets, short ids, digests (§6)
// ------------------------------------------------------------------------------------------
function typeOfId(id) {
  const i = typeof id === 'string' ? id.indexOf(':') : -1;
  return i > 0 ? id.slice(0, i) : '';
}

// 0–31 member buckets, 32–47 officer buckets, null for WH (no bucket) or a bad id.
function bucket(id) {
  const type = typeOfId(id);
  const space = spaceOf(type);
  if (!space || (TYPES[type] && TYPES[type].noBucket)) return null;
  const h = djb2(id);
  return space === 'member' ? h % K.MEMBER_BUCKETS : K.MEMBER_BUCKETS + (h % K.OFFICER_BUCKETS);
}

function shortId(id) { return pad36(djb2(String(id) + '#') % K.SHORT_MOD, 4); }

// A digest is kept as a running (sum, count): add digestTerm on store, subtract it on removal.
function digestTerm(id, v) { return djb2(String(id) + '^' + String(v)); }
function digestValue(sum, count) {
  const ok = typeof sum === 'number' && typeof count === 'number' && count > 0 && sum >= 0 && sum < 9007199254740992;
  return ok ? 1 + (sum % K.DIGEST_MOD) : 0;
}
function digestString(sum, count) { return pad36(digestValue(sum, count), 4); }
// Digest of a list of record strings (or {id, v}), for tests and full rebuilds.
function digestOf(records) {
  let sum = 0;
  let count = 0;
  for (const r of Array.isArray(records) ? records : []) {
    const p = typeof r === 'string' ? parse(r) : r;
    if (!p || typeof p !== 'object') continue;
    sum += digestTerm(p.id, p.v);
    count++;
  }
  return { sum, count, digest: digestString(sum, count) };
}

function mayServe(b, trustedMe) { return typeof b === 'number' && (b < K.MEMBER_BUCKETS || !!trustedMe); }

// ------------------------------------------------------------------------------------------
// Versions (§4.2)
// ------------------------------------------------------------------------------------------
function makeVersion(t, author, final) {
  t = wholeNumber(t) || 0;
  const h = djb2(author) % 64;
  return pad36(final ? K.FINAL_BASE - t * 64 + h : t * 64 + h, 8);
}

// An editor whose stored copy has t_old ≥ t uses t_old + 1.
function nextT(t, tOld) {
  t = wholeNumber(t) || 0;
  const o = wholeNumber(tOld);
  return o !== null && o >= t ? o + 1 : t;
}

function isFinalV(v) {
  const n = fromB36(v);
  return n !== null && n >= K.FINAL_MIN;
}

function tOfVersion(v) {
  const n = typeof v === 'string' && v.length === 8 ? fromB36(v) : null;
  if (n === null) return null;
  const h = n % 64;
  return n >= K.FINAL_MIN ? (K.FINAL_BASE - n + h) / 64 : (n - h) / 64;
}

// 1 when a wins, -1 when b wins, 0 when equal. Bigger v wins.
function compareVersions(a, b) {
  const x = fromB36(a);
  const y = fromB36(b);
  if (x === y) return 0;
  if (x === null) return -1;
  if (y === null) return 1;
  return x > y ? 1 : -1;
}

function compareBytes(a, b) {
  if (typeof a !== 'string') a = '';
  if (typeof b !== 'string') b = '';
  if (isAscii(a) && isAscii(b)) return a === b ? 0 : (a > b ? 1 : -1);
  const c = Buffer.compare(utf8(a), utf8(b));
  return c > 0 ? 1 : c < 0 ? -1 : 0;
}

// Two record strings for the same id: bigger v wins, equal v: the bigger record string (bytes).
function compareRecords(a, b) {
  const va = typeof a === 'string' ? a.split('^', 2)[1] : null;
  const vb = typeof b === 'string' ? b.split('^', 2)[1] : null;
  const c = compareVersions(va, vb);
  if (c !== 0) return c;
  return compareBytes(String(a || ''), String(b || ''));
}

function hourStart(now) { return typeof now === 'number' && Number.isFinite(now) ? Math.floor(now / K.HOUR) * K.HOUR : 0; }

// ------------------------------------------------------------------------------------------
// Keys
// ------------------------------------------------------------------------------------------
const B36X6 = /^[0-9a-z]{6}$/;
const PID = /^([^.]+)\.([0-9a-z]{4})$/;

// Bytes allowed in keys and authors: printable, none of ~ ^ ; , # | : (and "." only inside a pid).
function nameOk(s, allowDot) {
  if (typeof s !== 'string' || s.length === 0 || byteLength(s) > K.NAME_MAX) return false;
  if (/[\x00-\x20\x7f~^;,#|:]/.test(s)) return false;
  return allowDot || s.indexOf('.') < 0;
}
function authorOk(s) { return nameOk(s, false); }
function pidOk(s) {
  if (typeof s !== 'string' || byteLength(s) > 64) return false;
  const m = PID.exec(s);
  return !!m && nameOk(m[1], false);
}

function segOk(kind, s) {
  switch (kind) {
    case 'name': return nameOk(s, false);
    case 'b36x6': return B36X6.test(s);
    case 'int': return fromB36(s) !== null;
    case 'pid': return pidOk(s);
    case 'tab': return /^[0-8]$/.test(s);
    case 'one': return s === '1';
    default: return false;
  }
}

function keyOk(type, key) {
  const spec = TYPES[type];
  if (!spec) return true;
  const segs = key.split(':');
  if (segs.length !== spec.key.length) return false;
  for (let i = 0; i < segs.length; i++) if (!segOk(spec.key[i], segs[i])) return false;
  return true;
}

function randomKey(rng) {
  if (typeof rng !== 'function') rng = Math.random;
  let s = '';
  for (let i = 0; i < 6; i++) s += B36[Math.floor(rng() * 36) % 36];
  return s;
}

function newPid(anchor, rng) {
  if (typeof rng !== 'function') rng = Math.random;
  if (typeof anchor !== 'string') anchor = '';
  let s = '';
  for (let i = 0; i < 4; i++) s += B36[Math.floor(rng() * 36) % 36];
  return `${anchor}.${s}`;
}

function asciiLowerTrim(s) {
  return String(typeof s === 'string' ? s : '').replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '').replace(/[A-Z]/g, (c) => c.toLowerCase());
}
// Game item id → base36; else "h" + 5-character hash of the trimmed, ASCII-lowercased name.
function itemKey(idOrName) {
  if (typeof idOrName === 'number') {
    const n = wholeNumber(idOrName);
    return n ? toB36(n) : '';
  }
  const name = asciiLowerTrim(idOrName);
  return name ? 'h' + pad36(djb2(name) % 60466176, 5) : '';
}
function instanceKey(name) {
  const n = asciiLowerTrim(name);
  return n ? pad36(djb2(n) % 2176782336, 6) : '';
}

// ------------------------------------------------------------------------------------------
// Field values
// ------------------------------------------------------------------------------------------
// escCap (top-level text fields only): a further limit on the escaped bytes, set while shrinking.
function encodeScalar(spec, value, escCap) {
  switch (spec.k) {
    case 'text': {
      const e = escape(typeof value === 'string' ? value : '', spec.max);
      return escCap === undefined ? e : cutEscaped(e, escCap);
    }
    case 'int': {
      const s = toB36(value);
      return s === '' && spec.dash ? '-' : s;
    }
    case 'enum': return typeof value === 'string' && value.length === 1 && spec.values.indexOf(value) >= 0 ? value : '';
    case 'flag': return value === true || value === 1 || value === '1' ? '1' : '';
    default: return '';
  }
}

const UNSET = Symbol('bad');
function decodeScalar(spec, s) {
  switch (spec.k) {
    case 'text': { const t = unescape(s); return t === null ? UNSET : t; }
    case 'int': {
      if (s === '' || (spec.dash && s === '-')) return null;
      const n = fromB36(s);
      return n === null ? UNSET : n;
    }
    case 'enum': return s === '' || (s.length === 1 && spec.values.indexOf(s) >= 0) ? s : UNSET;
    case 'flag': return s === '' ? false : s === '1' ? true : UNSET;
    default: return UNSET;
  }
}

function trimTrailing(arr) {
  let n = arr.length;
  while (n > 0 && arr[n - 1] === '') n--;
  return n === arr.length ? arr : arr.slice(0, n);
}

function arrayItems(v) {
  const out = [];
  if (!Array.isArray(v)) return out;
  for (const x of v) { if (x === null || x === undefined) break; out.push(x); }
  return out;
}

function encodeParts(parts, rest, obj) {
  const o = obj && typeof obj === 'object' ? obj : {};
  const strs = parts.map((p) => encodeScalar(p, o[p.n]));
  if (rest) {
    let n = 0;
    for (const x of arrayItems(o[rest.n])) {
      if (n >= rest.maxItems) break;
      const s = encodeScalar(rest, x);
      if (s !== '') { strs.push(s); n++; }
    }
  }
  return trimTrailing(strs).join(',');
}

function encodeValue(spec, value, fields, escCap) {
  switch (spec.k) {
    case 'list': {
      const out = [];
      for (const x of arrayItems(value)) {
        if (out.length >= spec.maxItems) break;
        const s = spec.of ? encodeScalar(spec.of, x) : encodeParts(spec.parts, spec.rest, x);
        if (s !== '') out.push(s);
      }
      return out.join(';');
    }
    case 'tuple': return encodeParts(spec.parts, null, value);
    case 'ids': return encodeIds(value, spec.maxItems);
    case 'switch': {
      const sel = fields ? fields[spec.on] : undefined;
      const sub = (typeof sel === 'string' && spec.cases[sel]) || spec.default;
      return encodeValue(sub, value, fields);
    }
    default: return encodeScalar(spec, value, escCap);
  }
}

function decodeParts(parts, rest, s) {
  const bits = s.split(',');
  const o = {};
  for (let i = 0; i < parts.length; i++) {
    const v = decodeScalar(parts[i], bits[i] === undefined ? '' : bits[i]);
    if (v === UNSET) return UNSET;
    o[parts[i].n] = v;
  }
  if (rest) {
    const r = [];
    for (let i = parts.length; i < bits.length; i++) {
      const v = decodeScalar(rest, bits[i]);
      if (v === UNSET) return UNSET;
      r.push(v);
    }
    o[rest.n] = r;
  }
  return o;
}

function decodeValue(spec, s, fields) {
  switch (spec.k) {
    case 'list': {
      if (s === '') return [];
      const out = [];
      for (const item of s.split(';')) {
        const v = spec.of ? decodeScalar(spec.of, item) : decodeParts(spec.parts, spec.rest, item);
        if (v === UNSET) return UNSET;
        out.push(v);
      }
      return out;
    }
    case 'tuple': return decodeParts(spec.parts, null, s);
    case 'ids': { const v = decodeIds(s); return v === null ? UNSET : v; }
    case 'switch': {
      const sel = fields[spec.on];
      const sub = (typeof sel === 'string' && spec.cases[sel]) || spec.default;
      return decodeValue(sub, s, fields);
    }
    default: return decodeScalar(spec, s);
  }
}

function fieldsFor(type, key) {
  const spec = TYPES[type];
  if (!spec) return null;
  if (spec.variants && spec.variants[key]) return spec.variants[key];
  return spec.fields;
}

function maxFor(type, fields) {
  const spec = TYPES[type];
  if (!spec) return K.RECORD_MAX;
  if (spec.maxIf && fields && fields[spec.maxIf.field] === spec.maxIf.value) return spec.maxIf.max;
  return spec.max;
}

// The fields part of a record ("" when there are none). When budget (bytes) is given and the body
// is longer, the longest escaped text field (ties: the later field) is cut by the overflow, again
// until the body fits or no text is left.
function encodeFieldList(specs, fields, budget) {
  const f = fields && typeof fields === 'object' ? fields : {};
  const caps = {};
  let body = '';
  for (let round = 0; round < K.SHRINK_ROUNDS; round++) {
    const strs = specs.map((s, i) => encodeValue(s, f[s.n], f, caps[i]));
    body = trimTrailing(strs).join('^');
    if (budget === undefined || budget === null || byteLength(body) <= budget) return body;
    const over = byteLength(body) - budget;
    let best = -1;
    let bestLen = 0;
    for (let i = 0; i < specs.length; i++) {
      if (specs[i].k !== 'text') continue;
      const len = byteLength(strs[i]);
      if (len > 0 && len >= bestLen) { best = i; bestLen = len; }
    }
    if (best < 0) return body;
    caps[best] = Math.max(0, bestLen - over);
  }
  return body;
}

function headLength(id, author, del) {
  return byteLength(id) + 1 + 8 + 1 + byteLength(author || '') + 1 + (del ? 1 : 0);
}

// Body for an outbox entry. author is optional: without it, room is kept for the longest name.
function encodeBody(type, key, fields, author) {
  if (typeof key !== 'string') return '';
  const specs = fieldsFor(type, key);
  if (!specs) return '';
  const id = `${type}:${key}`;
  const head = headLength(id, typeof author === 'string' && author ? author : 'x'.repeat(K.NAME_MAX), false);
  return encodeFieldList(specs, fields, maxFor(type, fields) - head - 1);
}

// { type, key } or { id }, v (8 chars, or a number), author, del, fields (named) or raw (unknown types).
function encode(rec) {
  if (!rec || typeof rec !== 'object') return '';
  let type = rec.type;
  let key = rec.key;
  if (typeof rec.id === 'string' && (!type || key === undefined)) {
    let i = rec.id.indexOf(':');
    if (i < 0) i = rec.id.length;
    type = rec.id.slice(0, i);
    key = rec.id.slice(i + 1);
  }
  if (typeof type !== 'string') type = '';
  if (typeof key !== 'string') key = '';
  const id = `${type}:${key}`;
  const v = typeof rec.v === 'number' ? pad36(rec.v, 8) : String(rec.v || '');
  const author = typeof rec.author === 'string' ? rec.author : '';
  const head = `${id}^${v}^${author}^${rec.del ? 'd' : ''}`;
  if (rec.del) return head;
  let body;
  const specs = fieldsFor(type, key);
  if (specs) body = encodeFieldList(specs, rec.fields, maxFor(type, rec.fields) - byteLength(head) - 1);
  else body = trimTrailing(arrayItems(rec.raw).map((x) => (typeof x === 'string' ? x : ''))).join('^');
  return body === '' ? head : `${head}^${body}`;
}

// ------------------------------------------------------------------------------------------
// Parsing and decoding
// ------------------------------------------------------------------------------------------
// Generic structure only (any type): { id, type, key, v, t, author, del, raw: [field strings] } or null.
function parse(str) {
  if (typeof str !== 'string' || str.length < 14 || byteLength(str) > K.RECORD_MAX) return null;
  if (/[\x00-\x1f\x7f#|]/.test(str)) return null;
  const parts = str.split('^');
  if (parts.length < 4) return null;
  const [id, v, author, flags] = parts;
  const colon = id.indexOf(':');
  if (colon < 1 || byteLength(id) > K.ID_MAX) return null;
  const type = id.slice(0, colon);
  const key = id.slice(colon + 1);
  if (!spaceOf(type) || key === '' || /[\x20~;,]/.test(key)) return null;
  if (!/^[0-9a-z]{8}$/.test(v) || !authorOk(author)) return null;
  if (flags !== '' && flags !== 'd') return null;
  if (flags === 'd' && parts.length !== 4) return null;
  // v carries the author's slot in both bands: v mod 64 = djb2(author) mod 64.
  if (fromB36(v) % 64 !== djb2(author) % 64) return null;
  return { id, type, key, v, t: tOfVersion(v), author, del: flags === 'd', raw: parts.slice(4) };
}

// Full decode: known types get named fields (missing trailing fields read as empty, extra ones
// are ignored); unknown types keep raw. null when malformed.
function decode(str) {
  const p = parse(str);
  if (!p) return null;
  const specs = fieldsFor(p.type, p.key);
  if (!specs) return { id: p.id, type: p.type, key: p.key, v: p.v, t: p.t, author: p.author, del: p.del, fields: null, raw: p.raw };
  if (!keyOk(p.type, p.key)) return null;
  const fields = {};
  if (!p.del) {
    for (let i = 0; i < specs.length; i++) {
      const val = decodeValue(specs[i], p.raw[i] === undefined ? '' : p.raw[i], fields);
      if (val === UNSET) return null;
      fields[specs[i].n] = val;
    }
  }
  return { id: p.id, type: p.type, key: p.key, v: p.v, t: p.t, author: p.author, del: p.del, fields };
}

function asRec(x) {
  if (!x) return null;
  if (typeof x === 'string') return decode(x);
  return typeof x === 'object' ? x : null;
}

// ------------------------------------------------------------------------------------------
// Final versions, expiry, folding (§4.2, §4.3, §11)
// ------------------------------------------------------------------------------------------
function isFinal(rec) {
  const spec = rec && TYPES[rec.type];
  if (!spec || !spec.final || rec.del || !rec.fields) return false;
  const val = rec.fields[spec.final.field];
  return typeof val === 'string' && val.length === 1 && spec.final.values.indexOf(val) >= 0;
}

// A raid close (kind raid) or a loot award: kept until an LY covers it.
function isFoldable(rec) {
  const spec = rec && TYPES[rec.type];
  if (!spec || !spec.fold || rec.del || !rec.fields) return false;
  const f = spec.fold;
  if (f.field && rec.fields[f.field] !== f.value) return false;
  if (f.kindField && rec.fields[f.kindField] !== f.kind) return false;
  return true;
}

function isFolded(rec, lookup) {
  const inst = rec.fields && rec.fields.instance;
  if (!inst || typeof lookup !== 'function') return false;
  const ly = asRec(lookup(`LY:${inst}`));
  return !!(ly && !ly.del && ly.fields && ly.fields.upto !== null && ly.fields.upto !== undefined && rec.t <= ly.fields.upto);
}

// When the record expires (server seconds), or null for never. lookup(id) → record string or
// decoded record (or null) gives the parent for "with the raid / request / drive" and rc's ch.
function expiresAt(recIn, lookup, depth = 0) {
  const rec = asRec(recIn);
  if (!rec || rec.t === null || rec.t === undefined) return null;
  const spec = TYPES[rec.type];
  const t = rec.t;
  if (!spec) return t + K.UNKNOWN_DAYS * K.DAY;
  const e = spec.expiry;
  if (e.never) return rec.del ? t + K.TOMB_NEVER_DAYS * K.DAY : null;
  if (e.parent) {
    let pkey = null;
    if (e.seg) pkey = rec.key.split(':')[e.seg - 1];
    else if (e.field && rec.fields && typeof rec.fields[e.field] === 'string' && rec.fields[e.field] !== '') pkey = rec.fields[e.field];
    const parent = pkey && depth < 3 && typeof lookup === 'function' ? asRec(lookup(`${e.parent}:${pkey}`)) : null;
    if (parent) return expiresAt(parent, lookup, depth + 1);
    return t + K.PARENT_FALLBACK_DAYS * K.DAY;
  }
  if (e.field) {
    const base = !rec.del && rec.fields && typeof rec.fields[e.field] === 'number' ? rec.fields[e.field] : t;
    return base + e.days * K.DAY;
  }
  let base = t;
  if (e.newerOf && typeof lookup === 'function') {
    const p = asRec(lookup(`${e.newerOf}:${rec.key.split(':')[0]}`));
    if (p && typeof p.t === 'number' && p.t > base) base = p.t;
  }
  const days = e.finalDays && isFinal(rec) ? e.finalDays : e.days;
  return base + days * K.DAY;
}

// Expired at the start of the hour `hour` (pass hourStart(now)). Unfolded closes and awards never expire.
function isExpired(recIn, hour, lookup) {
  if (typeof hour !== 'number' || !Number.isFinite(hour)) hour = 0;
  const rec = asRec(recIn);
  if (!rec) return true;
  if (isFoldable(rec) && !isFolded(rec, lookup)) return false;
  const at = expiresAt(rec, lookup);
  return at !== null && at <= hour;
}

// ------------------------------------------------------------------------------------------
// Checks (§5)
// ------------------------------------------------------------------------------------------
// Rule 4 (and the author rule of rule 2): null when fine, else
// 'malformed' | 'oversize' | 'author' | 'future' | 'expired'.
function checkRecord(str, now, lookup) {
  if (typeof now !== 'number' || !Number.isFinite(now)) now = 0;
  if (typeof str !== 'string') return 'malformed';
  const bytes = byteLength(str);
  if (bytes > K.RECORD_MAX) return 'oversize';
  const rec = decode(str);
  if (!rec) return 'malformed';
  const spec = TYPES[rec.type];
  if (spec) {
    // Final-band versions only on final states; tombstones are normal versions.
    if (isFinalV(rec.v) !== isFinal(rec)) return 'malformed';
    if (bytes > maxFor(rec.type, rec.fields)) return 'oversize';
    if (spec.author === 'key' && rec.author !== rec.key.split(':')[0]) return 'author';
  }
  if (rec.t > now + K.FUTURE_SLACK) return 'future';
  if (isExpired(rec, hourStart(now), lookup)) return 'expired';
  return null;
}

function rankOf(env, name) {
  const r = env && env.ranks ? env.ranks[name] : undefined;
  return typeof r === 'number' && Number.isFinite(r) ? r : null;
}
function isOfficer(env, name) {
  const r = rankOf(env, name);
  const max = env && typeof env.officerRankMax === 'number' ? env.officerRankMax : 1;
  return r !== null && (r === 0 || r <= max);
}
function isTrusted(env, name) {
  if (isOfficer(env, name)) return true;
  const r = rankOf(env, name);
  return r !== null && env && typeof env.relayRankMax === 'number' && r <= env.relayRankMax;
}

// The addon's receive rules 1–4 for one record from env.sender.
// env: { me, sender, channel ('GUILD'|'OFFICER'), ranks: { name: rankIndex }, officerRankMax (default 1),
// relayRankMax (null = none) }. Returns { ok: true, how: 'd'|'t'|'m', rec } or { ok: false, reason }
// with reason 'self' | 'malformed' | 'channel' | 'unknown' (sender not in my roster yet: buffer and
// retry) | 'rank' | 'oversize' | 'author' | 'future' | 'expired'.
function acceptRecord(str, now, lookup, env) {
  const e = env || {};
  if (e.sender === e.me) return { ok: false, reason: 'self' };
  const p = parse(str);
  if (!p) return { ok: false, reason: 'malformed' };
  const spec = TYPES[p.type];
  const wantChannel = spec && spec.channel ? spec.channel : 'GUILD';
  if ((e.channel || 'GUILD') !== wantChannel) return { ok: false, reason: 'channel' };
  if (rankOf(e, e.sender) === null) return { ok: false, reason: 'unknown' };
  let how;
  if (spaceOf(p.type) === 'member') how = e.sender === p.author ? 'd' : 'm';
  else if (e.sender === p.author) {
    const ok = spec && spec.rank === 'gm' ? rankOf(e, p.author) === 0 : isOfficer(e, p.author);
    if (!ok) return { ok: false, reason: 'rank' };
    how = 'd';
  } else {
    if ((spec && spec.firstHand) || !isTrusted(e, e.sender)) return { ok: false, reason: 'rank' };
    how = 't';
  }
  const reason = checkRecord(str, now, lookup);
  if (reason) return { ok: false, reason };
  return { ok: true, how, rec: decode(str) };
}

// §11 per-author caps (member space). usage = { count, bytes, rcBytes } for the author's records
// already stored (not counting the one being replaced). true when storing this one goes over.
function overAuthorCaps(usage, type, bytes) {
  if (spaceOf(type) !== 'member' || !TYPES[type]) return false; // unknown types: one store-wide budget instead
  if (typeof bytes !== 'number' || Number.isNaN(bytes)) bytes = 0;
  const u = usage || {};
  const count = u.count || 0;
  if (count + 1 > K.AUTHOR_MAX_RECORDS) return true;
  if (type === 'rc') return (u.rcBytes || 0) + bytes > K.AUTHOR_MAX_RC_BYTES;
  return (u.bytes || 0) + bytes > K.AUTHOR_MAX_BYTES;
}
function addAuthorUsage(usage, type, bytes, sign) {
  if (typeof sign !== 'number' || Number.isNaN(sign)) sign = 1;
  if (typeof bytes !== 'number' || Number.isNaN(bytes)) bytes = 0;
  const u = usage && typeof usage === 'object' ? usage : { count: 0, bytes: 0, rcBytes: 0 };
  u.count = (u.count || 0) + sign;
  if (type === 'rc') u.rcBytes = (u.rcBytes || 0) + sign * bytes;
  else u.bytes = (u.bytes || 0) + sign * bytes;
  return u;
}

// ------------------------------------------------------------------------------------------
// Messages (§6). Every encoder returns '' (or []) when the input cannot make a valid message;
// every parser returns null for anything malformed.
// ------------------------------------------------------------------------------------------
const VERSION_OK = /^[0-9A-Za-z.\-]*$/;

// { minor, count, digests: 48 numbers (0 = empty), addon }
function encodeHello(h) {
  if (!h || !Array.isArray(h.digests) || h.digests.length !== K.BUCKETS) return '';
  const addon = typeof h.addon === 'string' && VERSION_OK.test(h.addon) ? h.addon.slice(0, K.HELLO_VERSION_MAX) : '';
  let out = `${K.MAJOR}H${pad36(Math.min(wholeNumber(h.minor) || 0, 35), 1)}${pad36(Math.min(wholeNumber(h.count) || 0, 46655), 3)}`;
  for (const d of h.digests) out += pad36(Math.min(wholeNumber(d) || 0, K.DIGEST_MOD), 4);
  return `${out}^${addon}`;
}

function parseHello(msg) {
  if (typeof msg !== 'string' || msg.length < 199 || msg.length > K.HELLO_MAX || msg.slice(0, 2) !== '1H') return null;
  const minor = fromB36(msg[2]);
  const count = fromB36(msg.slice(3, 6));
  if (minor === null || count === null || msg[198] !== '^') return null;
  const digests = [];
  for (let i = 0; i < K.BUCKETS; i++) {
    const d = fromB36(msg.slice(6 + i * 4, 10 + i * 4));
    if (d === null || d > K.DIGEST_MOD) return null;
    digests.push(d);
  }
  const addon = msg.slice(199);
  if (!VERSION_OK.test(addon)) return null;
  return { minor, count, digests, addon };
}

// { bucket, digest, page, pages, entries: [{ shortId, v }] } (≤ 20 entries)
function encodeInventory(inv) {
  if (!inv || !Array.isArray(inv.entries) || inv.entries.length > K.INV_PER_PAGE) return '';
  const b = wholeNumber(inv.bucket);
  const page = wholeNumber(inv.page);
  const pages = wholeNumber(inv.pages);
  if (b === null || b >= K.BUCKETS || !page || !pages || page > pages || pages > K.INV_PAGES_MAX) return '';
  let out = `${K.MAJOR}I${pad36(b, 2)}${pad36(Math.min(wholeNumber(inv.digest) || 0, K.DIGEST_MOD), 4)}${pad36(page, 1)}${pad36(pages, 1)}`;
  for (const e of inv.entries) {
    if (!e || !/^[0-9a-z]{4}$/.test(e.shortId) || !/^[0-9a-z]{8}$/.test(e.v)) return '';
    out += e.shortId + e.v;
  }
  return out;
}

// All pages for a bucket: entries sorted by shortId then v, 20 per page, at most 35 pages.
function inventoryPages(b, digest, entries) {
  const list = (Array.isArray(entries) ? entries : []).filter((e) => e && /^[0-9a-z]{4}$/.test(e.shortId) && /^[0-9a-z]{8}$/.test(e.v))
    .map((e) => ({ shortId: e.shortId, v: e.v }))
    .sort((x, y) => (x.shortId < y.shortId ? -1 : x.shortId > y.shortId ? 1 : x.v < y.v ? -1 : x.v > y.v ? 1 : 0))
    .slice(0, K.INV_PER_PAGE * K.INV_PAGES_MAX);
  const pages = Math.max(1, Math.ceil(list.length / K.INV_PER_PAGE));
  const out = [];
  for (let p = 1; p <= pages; p++) {
    out.push(encodeInventory({ bucket: b, digest, page: p, pages, entries: list.slice((p - 1) * K.INV_PER_PAGE, p * K.INV_PER_PAGE) }));
  }
  return out;
}

function parseInventory(msg) {
  if (typeof msg !== 'string' || msg.length < 10 || msg.length > K.INV_MAX || msg.slice(0, 2) !== '1I') return null;
  const b = fromB36(msg.slice(2, 4));
  const digest = fromB36(msg.slice(4, 8));
  const page = fromB36(msg[8]);
  const pages = fromB36(msg[9]);
  if (b === null || b >= K.BUCKETS || digest === null || digest > K.DIGEST_MOD || !page || !pages || page > pages) return null;
  const body = msg.slice(10);
  if (body.length % 12 !== 0) return null;
  const entries = [];
  for (let i = 0; i < body.length; i += 12) {
    const shortIdS = body.slice(i, i + 4);
    const v = body.slice(i + 4, i + 12);
    if (!/^[0-9a-z]{4}$/.test(shortIdS) || !/^[0-9a-z]{8}$/.test(v)) return null;
    entries.push({ shortId: shortIdS, v });
  }
  return { bucket: b, digest, page, pages, entries };
}

// G messages for target asking for shortIds: as many as fit per message (≤ 55 each).
function encodeGet(target, shortIds) {
  if (!authorOk(target)) return [];
  const room = Math.min(K.GET_MAX_IDS, Math.floor((K.MSG_MAX - 3 - byteLength(target)) / 4));
  const ids = (Array.isArray(shortIds) ? shortIds : []).filter((s) => /^[0-9a-z]{4}$/.test(s));
  const out = [];
  for (let i = 0; i < ids.length; i += room) out.push(`${K.MAJOR}G${target}^${ids.slice(i, i + room).join('')}`);
  return out;
}

function parseGet(msg) {
  if (typeof msg !== 'string' || byteLength(msg) > K.MSG_MAX || msg.slice(0, 2) !== '1G') return null;
  const caret = msg.indexOf('^');
  if (caret < 3) return null;
  const target = msg.slice(2, caret);
  const ids = msg.slice(caret + 1);
  if (!authorOk(target) || ids.length === 0 || ids.length % 4 !== 0 || ids.length / 4 > K.GET_MAX_IDS || !/^[0-9a-z]+$/.test(ids)) return null;
  const shortIds = [];
  for (let i = 0; i < ids.length; i += 4) shortIds.push(ids.slice(i, i + 4));
  return { target, shortIds };
}

// R messages packing whole records (in order) up to 255 bytes. Records over 253 bytes are skipped:
// send those with splitRecord.
function packRecords(records) {
  const out = [];
  let cur = '';
  let curLen = 0;
  for (const r of Array.isArray(records) ? records : []) {
    if (typeof r !== 'string' || r === '') continue;
    const len = byteLength(r);
    if (len > K.R_SINGLE_MAX) continue;
    if (cur !== '' && curLen + 1 + len <= K.MSG_MAX) { cur += '#' + r; curLen += 1 + len; } else {
      if (cur !== '') out.push(cur);
      cur = `${K.MAJOR}R${r}`;
      curLen = 2 + len;
    }
  }
  if (cur !== '') out.push(cur);
  return out;
}

function parseRecords(msg) {
  if (typeof msg !== 'string' || msg.length < 3 || byteLength(msg) > K.MSG_MAX || msg.slice(0, 2) !== '1R') return null;
  const recs = msg.slice(2).split('#');
  for (const r of recs) if (r === '') return null;
  return recs;
}

// M messages for one record over 253 bytes: [] when it needs more than 35 parts. Parts are cut
// at most 249 bytes long on UTF-8 boundaries, so every part is valid text.
function splitRecord(record, mid) {
  if (typeof record !== 'string' || record === '') return [];
  const b = utf8(record);
  const chunks = [];
  let i = 0;
  while (i < b.length) {
    let end = Math.min(b.length, i + K.M_DATA_MAX);
    if (end < b.length) {
      while (end > i && (b[end] & 0xc0) === 0x80) end--;
      if (end === i) end = i + K.M_DATA_MAX;
    }
    chunks.push(b.subarray(i, end).toString('utf8'));
    if (chunks.length > K.M_PARTS_MAX) return [];
    i = end;
  }
  const m = pad36((wholeNumber(mid) || 0) % K.MID_MOD, 2);
  return chunks.map((c, n) => `${K.MAJOR}M${m}${pad36(n + 1, 1)}${pad36(chunks.length, 1)}${c}`);
}

function parseParts(msg) {
  if (typeof msg !== 'string' || msg.length < 7 || msg.slice(0, 2) !== '1M' || byteLength(msg) > K.MSG_MAX) return null;
  const mid = fromB36(msg.slice(2, 4));
  const part = fromB36(msg[4]);
  const parts = fromB36(msg[5]);
  const data = msg.slice(6);
  if (mid === null || !part || !parts || part > parts || data === '' || byteLength(data) > K.M_DATA_MAX) return null;
  return { mid, part, parts, data };
}

// datas[i] = data of part i+1. The record, or null if a part is missing.
function joinParts(datas) {
  if (!Array.isArray(datas) || datas.length === 0) return null;
  for (const d of datas) if (typeof d !== 'string' || d === '') return null;
  return datas.join('');
}

// First look at any message: { major, type } or null. Another major: ignore (and tell the player
// once if it is higher).
function messageKind(msg) {
  if (typeof msg !== 'string' || msg.length < 2) return null;
  const major = '0123456789'.indexOf(msg[0]);
  if (major < 0 || !/[A-Z]/.test(msg[1])) return null;
  return { major, type: msg[1] };
}

// ------------------------------------------------------------------------------------------
// Derived state (§4.4), pure. Inputs are record strings or decoded records.
// ------------------------------------------------------------------------------------------
const live = (r) => { const x = asRec(r); return x && !x.del && x.fields ? x : null; };
const RAID_STATUS = { o: 'open', l: 'locked', x: 'cancelled', d: 'done' };

// RT (or none) → { status: 'open'|'locked'|'cancelled'|'done', lockedAt, closedAt, kind, instance }.
function raidStatus(rt) {
  const r = live(rt);
  if (!r) return { status: 'open', lockedAt: null, closedAt: null, kind: '', instance: '' };
  const f = r.fields;
  return {
    status: RAID_STATUS[f.status] || 'open',
    lockedAt: f.lockedAt === undefined ? null : f.lockedAt,
    closedAt: f.status === 'd' ? (f.closedAt === undefined || f.closedAt === null ? r.t : f.closedAt) : null,
    kind: f.kind || '',
    instance: f.instance || '',
  };
}

// The reserves of a sign-up that count at a close with this lockedAt (null = never locked).
function countingReserves(su, lockedAt) {
  const s = live(su);
  if (!s) return [];
  const f = s.fields;
  if (lockedAt === null || lockedAt === undefined) return f.reserves.slice();
  const reservesAt = f.reservesAt !== null ? f.reservesAt : s.t;
  if (reservesAt <= lockedAt) return f.reserves.slice();
  if (f.prevAt !== null && f.prevAt <= lockedAt) return f.prev.slice();
  return [];
}

// cr + its cl records → { state: 'open'|'claimed'|'done'|'cancelled', claimer (pid|null) }.
function craftRequestState(cr, claims) {
  const c = asRec(cr);
  if (!c || c.del || !c.fields) return { state: 'cancelled', claimer: null };
  const requester = c.fields.pid;
  let best = null;
  for (const raw of Array.isArray(claims) ? claims : []) {
    const cl = live(raw);
    if (!cl || cl.type !== 'cl') continue;
    const [reqKey, pid] = cl.key.split(':');
    if (reqKey !== c.key || pid === requester) continue;
    if (cl.fields.state !== 'c' && cl.fields.state !== 'd') continue;
    const at = cl.fields.claimedAt === null ? cl.t : cl.fields.claimedAt;
    if (!best || at < best.at || (at === best.at && compareBytes(pid, best.pid) < 0)) best = { at, pid, state: cl.fields.state };
  }
  if (c.fields.state === 'x') return { state: 'cancelled', claimer: best ? best.pid : null };
  if (c.fields.state === 'd' || (best && best.state === 'd')) return { state: 'done', claimer: best ? best.pid : null };
  if (best) return { state: 'claimed', claimer: best.pid };
  return { state: 'open', claimer: null };
}

// dg + its dj records → { state: 'open'|'full'|'cancelled'|'done', slots: { t, h, d }, open: { t, h, d },
//   members: [{ pid, character, role, class, level, joinedAt }], waiting: [same] }.
// The leader takes one slot of their own role. Joins count in the order they were made (joinedAt, else t; a tie
// goes to the smaller pid by bytes); a join past its role's free slots waits. The leader's own join never counts.
function dungeonGroupState(dg, joins) {
  const g = asRec(dg);
  const none = { state: 'cancelled', slots: { t: 0, h: 0, d: 0 }, open: { t: 0, h: 0, d: 0 }, members: [], waiting: [] };
  if (!g || g.del || !g.fields) return none;
  const f = g.fields;
  const n = (v, d) => (typeof v === 'number' && v >= 0 ? Math.min(Math.floor(v), 10) : d);
  const slots = { t: n(f.tank, 1), h: n(f.heal, 1), d: n(f.dps, 3) };
  const open = { ...slots };
  if (open[f.role] > 0) open[f.role]--;
  const list = [];
  for (const raw of Array.isArray(joins) ? joins : []) {
    const j = live(raw);
    if (!j || j.type !== 'dj') continue;
    const [k, pid] = j.key.split(':');
    if (k !== g.key || pid === f.pid || j.fields.status !== 'y' || !(j.fields.role in slots)) continue;
    const at = typeof j.fields.joinedAt === 'number' ? j.fields.joinedAt : j.t;
    list.push({ pid, character: j.fields.character || '', role: j.fields.role, class: j.fields.class || '', level: j.fields.level ?? null, joinedAt: at });
  }
  list.sort((a, b) => (a.joinedAt - b.joinedAt) || compareBytes(a.pid, b.pid));
  const members = [];
  const waiting = [];
  for (const m of list) {
    if (open[m.role] > 0) { open[m.role]--; members.push(m); } else waiting.push(m);
  }
  let state = open.t + open.h + open.d === 0 ? 'full' : 'open';
  if (f.state === 'x') state = 'cancelled';
  else if (f.state === 'd') state = 'done';
  return { state, slots, open, members, waiting };
}

// bq + BH (either may be missing) → { state: 'open'|'cancelled'|'sent'|'declined', by, at }.
// The earlier (by t) of the requester's cancel and an officer's answer wins; a tie goes to the cancel.
function bankRequestState(bq, bh) {
  const q = asRec(bq);
  const h = live(bh);
  const cancel = q && (q.del || (q.fields && q.fields.state === 'x')) ? { state: 'cancelled', by: q.author, at: q.t } : null;
  const answer = h && (h.fields.state === 's' || h.fields.state === 'd') ? { state: h.fields.state === 's' ? 'sent' : 'declined', by: h.author, at: h.t } : null;
  if (cancel && answer) return answer.at < cancel.at ? answer : cancel;
  return cancel || answer || { state: 'open', by: null, at: null };
}

// DR + its dc records → { total, goal, reached, closed, status: 'open'|'done'|'closed' }.
function driveState(dr, contribs) {
  const any = asRec(dr);
  const d = live(dr);
  let total = 0;
  for (const raw of Array.isArray(contribs) ? contribs : []) {
    const c = live(raw);
    if (!c || c.type !== 'dc') continue;
    if (any && c.fields.drive !== any.key) continue;
    total += c.fields.amount || 0;
  }
  const goal = d && typeof d.fields.goal === 'number' ? d.fields.goal : 0;
  const reached = goal > 0 && total >= goal;
  const closed = d ? d.fields.state === 'c' : !!any; // a deleted drive counts as closed
  return { total, goal, reached, closed, status: closed ? 'closed' : reached ? 'done' : 'open' };
}

// SR+ loyalty for one instance, replaying the old server's closeRaid and awardItem:
// start from the LY (bonuses, upto), then apply every raid close (RT d, kind r) and LA with
// t > upto in (t, author, id) order. An award sets (pid, item) to 0. A close adds 10 to each
// attendee's snapshot items and zeroes their other bonuses for the instance, then zeroes each
// no-show's bonuses. Returns { upto, bonuses: { pid: { itemKey: bonus } } } (zero bonuses left out).
function foldEvents(instance, records, after, until) {
  const events = [];
  for (const raw of Array.isArray(records) ? records : []) {
    const r = live(raw);
    if (!r || r.fields.instance !== instance || !isFoldable(r)) continue;
    if (after !== null && r.t <= after) continue;
    if (until !== null && r.t > until) continue;
    events.push(r);
  }
  events.sort((a, b) => (a.t - b.t) || compareBytes(a.author, b.author) || compareBytes(a.id, b.id));
  return events;
}

function applyEvents(bonuses, events) {
  for (const e of events) {
    if (e.type === 'LA') {
      const pid = e.fields.pid;
      if (pid && bonuses[pid]) {
        delete bonuses[pid][e.fields.item];
        if (!Object.keys(bonuses[pid]).length) delete bonuses[pid];
      }
      continue;
    }
    const attending = new Set();
    for (const a of e.fields.attendees) {
      if (!a.pid) continue;
      attending.add(a.pid);
      const snap = new Set(a.items.filter(Boolean));
      const next = {};
      const cur = bonuses[a.pid] || {};
      for (const k of snap) next[k] = (cur[k] || 0) + K.BONUS_STEP;
      bonuses[a.pid] = next;
      if (!Object.keys(next).length) delete bonuses[a.pid];
    }
    for (const pid of e.fields.noShows) if (pid && !attending.has(pid)) delete bonuses[pid];
  }
  return bonuses;
}

function lyBonuses(ly) {
  const out = {};
  if (!ly) return out;
  for (const b of ly.fields.bonuses) {
    if (!b.pid || !b.item || !b.bonus) continue;
    (out[b.pid] = out[b.pid] || {})[b.item] = b.bonus;
  }
  return out;
}

function newestLY(instance, records) {
  let best = null;
  let bestStr = '';
  for (const raw of Array.isArray(records) ? records : []) {
    const r = asRec(raw);
    if (!r || r.type !== 'LY' || r.key !== instance) continue;
    const str = typeof raw === 'string' ? raw : encode(r);
    if (!best || compareRecords(str, bestStr) > 0) { best = r; bestStr = str; }
  }
  return best && !best.del && best.fields ? best : null;
}

function loyaltyFold(instance, records) {
  const ly = newestLY(instance, records);
  const upto = ly && ly.fields.upto !== null ? ly.fields.upto : null;
  const bonuses = applyEvents(lyBonuses(ly), foldEvents(instance, records, upto, null));
  return { upto, bonuses };
}

// Should an officer's app write a new LY now? When the newest is over 14 days old (or missing) and
// there are closes or awards older than 30 days that it does not cover.
function needsCheckpoint(instance, records, now) {
  const ly = newestLY(instance, records);
  if (ly && ly.t > now - K.LY_EVERY_DAYS * K.DAY) return false;
  const from = ly && ly.fields.upto !== null ? ly.fields.upto : null;
  return foldEvents(instance, records, from, now - K.LY_FOLD_DAYS * K.DAY).length > 0;
}

// The fields of the new LY: folds exactly the closes and awards older than 30 days.
function loyaltyCheckpoint(instance, records, now) {
  const ly = newestLY(instance, records);
  const from = ly && ly.fields.upto !== null ? ly.fields.upto : null;
  const upto = Math.max(from || 0, now - K.LY_FOLD_DAYS * K.DAY);
  const bonuses = applyEvents(lyBonuses(ly), foldEvents(instance, records, from, upto));
  const list = [];
  for (const pid of Object.keys(bonuses).sort(compareBytes)) {
    for (const item of Object.keys(bonuses[pid]).sort(compareBytes)) list.push({ pid, item, bonus: bonuses[pid][item] });
  }
  return { upto, bonuses: list };
}

// ------------------------------------------------------------------------------------------
// The shared accept/refuse table (§5, §13). Each case: record, now, optional lookup records
// (by id), optional env (sender rules); expect = how ('d'|'t'|'m') when accepted with env,
// 'ok' when accepted without env, else the refusal reason. Run with runAcceptCase.
// ------------------------------------------------------------------------------------------
const NOW = 1794067200; // 2026-11-07 ~ the spec's examples
const D = K.DAY;
function rec(type, key, t, author, fields, opts = {}) {
  return encode({ type, key, v: makeVersion(t, author, !!opts.final), author, del: !!opts.del, fields });
}
const RANKS = { Grommash: 0, Varok: 1, Thrallia: 3, Zuljinne: 3, Relayer: 2 };
const GUILD = (sender, extra) => Object.assign({ me: 'Me', sender, channel: 'GUILD', ranks: RANKS, officerRankMax: 1, relayRankMax: null }, extra || {});
const RD_K = rec('RD', 'k3f9a2', NOW - D, 'Grommash', { kind: 'r', title: 'Molten Core', instance: 'Molten Core', startsAt: NOW + D, minutes: 180, size: 40, srLimit: 2 });

const ACCEPT_CASES = [
  { name: 'member record first-hand', record: rec('ca', 'x8k2pq', NOW - 60, 'Thrallia', { character: 'Thrallia', zone: 'Crossroads', needed: 5, message: 'help' }), now: NOW, env: GUILD('Thrallia'), expect: 'd' },
  { name: 'member record relayed by a member', record: rec('ca', 'x8k2pq', NOW - 60, 'Thrallia', { character: 'Thrallia', zone: 'Crossroads' }), now: NOW, env: GUILD('Zuljinne'), expect: 'm' },
  { name: 'my own message echoed back', record: rec('ca', 'x8k2pq', NOW - 60, 'Me', { zone: 'Crossroads' }), now: NOW, env: GUILD('Me'), expect: 'self' },
  { name: 'sender not in my roster yet', record: rec('ca', 'x8k2pq', NOW - 60, 'Stranger', { zone: 'Crossroads' }), now: NOW, env: GUILD('Stranger'), expect: 'unknown' },
  { name: 'officer record from an officer author', record: RD_K, now: NOW, env: GUILD('Grommash'), expect: 'd' },
  { name: 'officer record first-hand from a member', record: rec('RT', 'k3f9a2', NOW - 60, 'Thrallia', { status: 'l', lockedAt: NOW - 60 }), now: NOW, env: GUILD('Thrallia'), expect: 'rank' },
  { name: 'officer record relayed by a member', record: RD_K, now: NOW, env: GUILD('Thrallia'), expect: 'rank' },
  { name: 'officer record relayed by an officer', record: RD_K, now: NOW, env: GUILD('Varok'), expect: 't' },
  { name: 'officer record relayed by a relay rank', record: RD_K, now: NOW, env: GUILD('Relayer', { relayRankMax: 2 }), expect: 't' },
  { name: 'relay rank cannot author officer records', record: rec('AN', 'q2w8zz', NOW - 60, 'Relayer', { body: 'hi' }), now: NOW, env: GUILD('Relayer', { relayRankMax: 2 }), expect: 'rank' },
  { name: 'officer rank max raised to 3', record: rec('AN', 'q2w8zz', NOW - 60, 'Thrallia', { body: 'hi' }), now: NOW, env: GUILD('Thrallia', { officerRankMax: 3 }), expect: 'd' },
  { name: 'guild settings from the Guild Master', record: rec('CFG', '1', NOW - 60, 'Grommash', { officerRankMax: 2, relayRankMax: null }), now: NOW, env: GUILD('Grommash'), expect: 'd' },
  { name: 'guild settings from an officer', record: rec('CFG', '1', NOW - 60, 'Varok', { officerRankMax: 2 }), now: NOW, env: GUILD('Varok'), expect: 'rank' },
  { name: 'webhook on the OFFICER channel', record: rec('WH', '1', NOW - 60, 'Varok', { url: 'https://discord.com/api/webhooks/1/x' }), now: NOW, env: GUILD('Varok', { channel: 'OFFICER' }), expect: 'd' },
  { name: 'webhook on the GUILD channel', record: rec('WH', '1', NOW - 60, 'Varok', { url: 'https://discord.com/api/webhooks/1/x' }), now: NOW, env: GUILD('Varok'), expect: 'channel' },
  { name: 'webhook relayed (first-hand only)', record: rec('WH', '1', NOW - 60, 'Varok', { url: 'https://discord.com/api/webhooks/1/x' }), now: NOW, env: GUILD('Grommash', { channel: 'OFFICER' }), expect: 'rank' },
  { name: 'other records on the OFFICER channel', record: RD_K, now: NOW, env: GUILD('Grommash', { channel: 'OFFICER' }), expect: 'channel' },
  { name: 'character record by that character', record: rec('ch', 'Thrallia', NOW - 60, 'Thrallia', { pid: 'Thrallia.p4m7', level: 60 }), now: NOW, expect: 'ok' },
  { name: 'character record by someone else', record: rec('ch', 'Thrallia', NOW - 60, 'Zuljinne', { pid: 'Zuljinne.a8x2' }), now: NOW, env: GUILD('Zuljinne'), expect: 'author' },
  { name: 'recipes by someone else', record: rec('rc', 'Thrallia:4k', NOW - 60, 'Zuljinne', { kind: 's', count: 1, list: [2660] }), now: NOW, expect: 'author' },
  { name: 'bank stock by someone else', record: rec('bk', 'Bankalt', NOW - 60, 'Thrallia', { bags: [{ id: 2589, count: 20 }] }), now: NOW, expect: 'author' },
  { name: 'up to 300 s in the future', record: rec('ca', 'x8k2pq', NOW + 300, 'Thrallia', { zone: 'Crossroads' }), now: NOW, expect: 'ok' },
  { name: 'more than 300 s in the future', record: rec('ca', 'x8k2pq', NOW + 301, 'Thrallia', { zone: 'Crossroads' }), now: NOW, expect: 'future' },
  { name: 'call to arms a day old (expired at the hour start)', record: rec('ca', 'x8k2pq', hourStart(NOW) - D, 'Thrallia', { zone: 'Crossroads' }), now: NOW, expect: 'expired' },
  { name: 'call to arms just under a day old at the hour start', record: rec('ca', 'x8k2pq', hourStart(NOW) - D + 1, 'Thrallia', { zone: 'Crossroads' }), now: NOW, expect: 'ok' },
  { name: 'sign-up expires with its raid', record: rec('su', 'k3f9a2:Thrallia.p4m7', NOW - 50 * D, 'Thrallia', { character: 'Thrallia', role: 'h', status: 'y' }), now: NOW, lookup: { 'RD:k3f9a2': rec('RD', 'k3f9a2', NOW - 100 * D, 'Grommash', { kind: 'r', title: 'Old', startsAt: NOW - 46 * D }) }, expect: 'expired' },
  { name: 'sign-up for an unknown raid lives 120 days', record: rec('su', 'k3f9a2:Thrallia.p4m7', NOW - 119 * D, 'Thrallia', { character: 'Thrallia', role: 'h', status: 'y' }), now: NOW, expect: 'ok' },
  { name: 'sign-up for an unknown raid after 120 days', record: rec('su', 'k3f9a2:Thrallia.p4m7', NOW - 121 * D, 'Thrallia', { character: 'Thrallia', role: 'h', status: 'y' }), now: NOW, expect: 'expired' },
  { name: 'unfolded raid close never expires', record: rec('RT', 'k3f9a2', NOW - 400 * D, 'Grommash', { status: 'd', kind: 'r', instance: 'abc123', closedAt: NOW - 400 * D }, { final: true }), now: NOW, expect: 'ok' },
  { name: 'folded raid close past its raid expires', record: rec('RT', 'k3f9a2', NOW - 400 * D, 'Grommash', { status: 'd', kind: 'r', instance: 'abc123', closedAt: NOW - 400 * D }, { final: true }), now: NOW, lookup: { 'LY:abc123': rec('LY', 'abc123', NOW - 10 * D, 'Grommash', { upto: NOW - 40 * D }) }, expect: 'expired' },
  { name: 'loot list never expires', record: rec('LL', 'abc123', NOW - 900 * D, 'Grommash', { name: 'Molten Core' }), now: NOW, expect: 'ok' },
  { name: 'tombstone of a never-expiring type after 180 days', record: rec('LL', 'abc123', NOW - 181 * D, 'Grommash', null, { del: true }), now: NOW, expect: 'expired' },
  { name: 'closed craft request lives 7 days', record: rec('cr', 'r1r1r1', NOW - 8 * D, 'Thrallia', { pid: 'Thrallia.p4m7', item: 'Robe', state: 'x' }, { final: true }), now: NOW, expect: 'expired' },
  { name: 'open craft request lives 30 days', record: rec('cr', 'r1r1r1', NOW - 8 * D, 'Thrallia', { pid: 'Thrallia.p4m7', item: 'Robe', state: 'o' }), now: NOW, expect: 'ok' },
  { name: 'final state with a normal version', record: rec('cr', 'r1r1r1', NOW - 60, 'Thrallia', { pid: 'Thrallia.p4m7', item: 'Robe', state: 'x' }), now: NOW, expect: 'malformed' },
  { name: 'normal state with a final version', record: rec('cr', 'r1r1r1', NOW - 60, 'Thrallia', { pid: 'Thrallia.p4m7', item: 'Robe', state: 'o' }, { final: true }), now: NOW, expect: 'malformed' },
  { name: 'version slot does not match the author', record: `ca:x8k2pq^${makeVersion(NOW - 60, 'Thrallia')}^Zuljinne^^Thrallia^Crossroads`, now: NOW, expect: 'malformed' },
  { name: 'bad escape', record: `AN:q2w8zz^${makeVersion(NOW - 60, 'Grommash')}^Grommash^^a~zzb`, now: NOW, expect: 'malformed' },
  { name: 'raw separator inside a text field', record: `AN:q2w8zz^${makeVersion(NOW - 60, 'Grommash')}^Grommash^^a,b`, now: NOW, expect: 'malformed' },
  { name: 'pipe character on the wire', record: `AN:q2w8zz^${makeVersion(NOW - 60, 'Grommash')}^Grommash^^a|b`, now: NOW, expect: 'malformed' },
  { name: 'bad enum value', record: `cl:r1r1r1:Thrallia.p4m7^${makeVersion(NOW - 60, 'Zuljinne')}^Zuljinne^^q`, now: NOW, expect: 'malformed' },
  { name: 'bad key for the type', record: `RD:toolongkey^${makeVersion(NOW - 60, 'Grommash')}^Grommash^^r`, now: NOW, expect: 'malformed' },
  { name: 'tombstone with fields', record: `AN:q2w8zz^${makeVersion(NOW - 60, 'Grommash')}^Grommash^d^x`, now: NOW, expect: 'malformed' },
  { name: 'mixed-case type', record: `Ab:q2w8zz^${makeVersion(NOW - 60, 'Grommash')}^Grommash^^x`, now: NOW, expect: 'malformed' },
  { name: 'oversize for its type', record: `BH:r1r1r1^${makeVersion(NOW - 60, 'Grommash')}^Grommash^^s^${'x'.repeat(40)}`, now: NOW, expect: 'oversize' },
  { name: 'unknown member type is kept', record: `zz:anything^${makeVersion(NOW - 60, 'Thrallia')}^Thrallia^^1^2^3`, now: NOW, env: GUILD('Zuljinne'), expect: 'm' },
  { name: 'unknown officer type from a member', record: `ZZ:anything^${makeVersion(NOW - 60, 'Thrallia')}^Thrallia^^1`, now: NOW, env: GUILD('Thrallia'), expect: 'rank' },
  { name: 'unknown officer type from an officer', record: `ZZ:anything^${makeVersion(NOW - 60, 'Varok')}^Varok^^1`, now: NOW, env: GUILD('Varok'), expect: 'd' },
  { name: 'unknown type expires after 120 days', record: `zz:anything^${makeVersion(NOW - 121 * D, 'Thrallia')}^Thrallia^^1`, now: NOW, expect: 'expired' },
];

function runAcceptCase(c, impl) {
  const S = impl || module.exports;
  const lookup = (id) => (c.lookup && c.lookup[id]) || null;
  if (c.env) {
    const r = S.acceptRecord(c.record, c.now, lookup, c.env);
    return r.ok ? r.how : r.reason;
  }
  return S.checkRecord(c.record, c.now, lookup) || 'ok';
}

module.exports = {
  K, TYPES, SKILLS, VARINT, spaceOf,
  djb2, toB36, fromB36, pad36, cutUtf8, cutEscaped, escape, unescape, byteLength,
  encodeIds, decodeIds,
  bucket, shortId, digestTerm, digestValue, digestString, digestOf, mayServe,
  makeVersion, nextT, isFinalV, tOfVersion, compareVersions, compareRecords, compareBytes, hourStart,
  keyOk, pidOk, authorOk, randomKey, newPid, itemKey, instanceKey,
  encode, encodeBody, decode, parse, fieldsFor, maxFor,
  isFinal, isFoldable, expiresAt, isExpired,
  checkRecord, acceptRecord, isOfficer, isTrusted, overAuthorCaps, addAuthorUsage,
  encodeHello, parseHello, encodeInventory, inventoryPages, parseInventory, encodeGet, parseGet,
  packRecords, parseRecords, splitRecord, parseParts, joinParts, messageKind,
  raidStatus, countingReserves, craftRequestState, bankRequestState, driveState, dungeonGroupState,
  loyaltyFold, needsCheckpoint, loyaltyCheckpoint,
  ACCEPT_CASES, runAcceptCase,
};
