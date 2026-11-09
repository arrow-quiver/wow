// Formatting helpers: money, times (always shown in the viewer's own time zone), WoW classes and item quality.
// Server times are UTC: SQLite strings "YYYY-MM-DD HH:MM:SS" and ISO 8601 strings both parse as UTC.

// ---------- money ----------

// 1234567 → { neg: false, g: 123, s: 45, c: 67 }
export function moneyParts(copper) {
  if (copper === null || copper === undefined || copper === '' || Number.isNaN(Number(copper))) return null;
  const n = Math.round(Number(copper));
  const c = Math.abs(n);
  return { neg: n < 0, g: Math.floor(c / 10000), s: Math.floor((c % 10000) / 100), c: c % 100 };
}

// 1234567 → "123g 45s 67c"; 50000 → "5g 0s"; 120 → "1s 20c"; 0 → "0c". Exact port of the old site's money().
export function money(copper) {
  const p = moneyParts(copper);
  if (!p) return '';
  return `${p.neg ? '-' : ''}${p.g ? `${p.g.toLocaleString('en')}g ` : ''}${p.g || p.s ? `${p.s}s ` : ''}${p.c}c`
    .replace(/ 0c$/, '').trim();
}

// Accepts "12g 50s", "12.5g", "1250s", "300" (copper) → copper integer, or null when it cannot be read.
export function parseMoney(text) {
  const s = String(text ?? '').trim().toLowerCase().replace(/,/g, '');
  if (!s) return null;
  if (/^-?\d+$/.test(s)) return Number(s);
  const re = /(-?\d+(?:\.\d+)?)\s*([gsc])/g;
  let total = 0;
  let matched = '';
  for (const m of s.matchAll(re)) {
    total += Number(m[1]) * (m[2] === 'g' ? 10000 : m[2] === 's' ? 100 : 1);
    matched += m[0];
  }
  if (!matched || s.replace(/\s+/g, '') !== matched.replace(/\s+/g, '')) return null;
  return Math.round(total);
}

// ---------- numbers ----------

export const number = (n) => (n === null || n === undefined || n === '' ? '' : Number(n).toLocaleString('en'));

// plural(3, 'raid') → "3 raids"; plural(1, 'raid') → "1 raid"; plural(2, 'ally', 'allies').
export function plural(n, word, many) {
  const v = Number(n) || 0;
  return `${v.toLocaleString('en')} ${v === 1 ? word : many || `${word}s`}`;
}

export function bytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let x = v / 1024;
  let i = 0;
  while (x >= 1024 && i < units.length - 1) { x /= 1024; i++; }
  return `${x < 10 ? x.toFixed(1) : Math.round(x)} ${units[i]}`;
}

export const percent = (v, digits = 0) => (v === null || v === undefined ? '' : `${Number(v).toFixed(digits)}%`);

// ---------- time ----------

// Date | ms number | "YYYY-MM-DD HH:MM:SS" (UTC) | "YYYY-MM-DD" (UTC day) | ISO 8601 → Date, or null.
export function parseTime(t) {
  if (t === null || t === undefined || t === '') return null;
  if (t instanceof Date) return Number.isNaN(t.getTime()) ? null : t;
  if (typeof t === 'number') return Number.isFinite(t) ? new Date(t < 1e11 ? t * 1000 : t) : null; // seconds or ms
  const s = String(t).trim();
  let iso = s;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) iso = `${s}T00:00:00Z`;
  else if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) iso = `${s.replace(' ', 'T')}Z`; // no zone → UTC
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

// "just now", "5 min ago", "3 h ago", "2 d ago", "in 20 min"; "never" for empty. Port of the old site's ago().
export function timeAgo(t, now = Date.now()) {
  const d = parseTime(t);
  if (!d) return 'never';
  const diff = (now - d.getTime()) / 1000;
  const s = Math.abs(diff);
  let text;
  if (s < 90) return diff >= -90 ? 'just now' : 'in a moment';
  if (s < 3600) text = `${Math.round(s / 60)} min`;
  else if (s < 86400) text = `${Math.round(s / 3600)} h`;
  else if (s < 86400 * 45) text = `${Math.round(s / 86400)} d`;
  else return localDate(d);
  return diff >= 0 ? `${text} ago` : `in ${text}`;
}

const FORMATS = {
  full: { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' },
  time: { hour: '2-digit', minute: '2-digit' },
  date: { weekday: 'long', day: 'numeric', month: 'long' },
  short: { day: 'numeric', month: 'short' },
  day: { day: 'numeric', month: 'short', year: 'numeric' },
  long: { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' },
};

// localTime(iso, 'full'|'time'|'date'|'short'|'day'|'long') in the viewer's time zone.
export function localTime(t, style = 'full') {
  const d = parseTime(t);
  if (!d) return '';
  return d.toLocaleString(undefined, FORMATS[style] || FORMATS.full);
}
export const localDateTime = (t) => localTime(t, 'long');
export const localDate = (t) => localTime(t, 'day');

// For <input type="datetime-local">: Date/ISO → "YYYY-MM-DDTHH:MM" in local time, and back to an ISO UTC string.
export function toLocalInput(t) {
  const d = parseTime(t);
  if (!d) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function fromLocalInput(value) {
  if (!value) return null;
  const d = new Date(value); // no zone → local time
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// ---------- classes ----------

// Class colours as players know them from the game, tuned slightly for contrast on light paper (old layout.js).
export const CLASS = {
  WARRIOR: ['Warrior', '#9a6b3f'], PALADIN: ['Paladin', '#c0558a'], HUNTER: ['Hunter', '#5f8a2e'],
  ROGUE: ['Rogue', '#a88a12'], PRIEST: ['Priest', '#6b7280'], SHAMAN: ['Shaman', '#0b6fb8'],
  MAGE: ['Mage', '#2b8fb3'], WARLOCK: ['Warlock', '#6d5bb5'], DRUID: ['Druid', '#c4620e'],
};
export const CLASSES = Object.keys(CLASS);
const UNKNOWN_COLOR = '#6b7280';

function classKey(cls) { return String(cls || '').toUpperCase().replace(/[\s_-]+/g, ''); }
export function classInfo(cls) { return CLASS[classKey(cls)] || [cls ? String(cls) : 'Unknown', UNKNOWN_COLOR]; }
export const className = (cls) => classInfo(cls)[0];
export const classColor = (cls) => classInfo(cls)[1];

// ---------- item quality ----------

export const QUALITY = ['Poor', 'Common', 'Uncommon', 'Rare', 'Epic', 'Legendary', 'Artifact', 'Heirloom'];
const QUALITY_BY_NAME = Object.fromEntries(QUALITY.map((n, i) => [n.toLowerCase(), i]));

export function qualityIndex(q) {
  if (q === null || q === undefined || q === '') return null;
  if (typeof q === 'number' || /^\d+$/.test(String(q))) {
    const n = Number(q);
    return n >= 0 && n < QUALITY.length ? n : null;
  }
  const i = QUALITY_BY_NAME[String(q).toLowerCase()];
  return i === undefined ? null : i;
}
export const qualityName = (q) => { const i = qualityIndex(q); return i === null ? '' : QUALITY[i]; };
// A CSS colour for the quality (theme aware): use in style="color: ..." or prefer the class from qualityClass().
export const qualityColor = (q) => { const i = qualityIndex(q); return i === null ? 'inherit' : `var(--q-${i})`; };
export const qualityClass = (q) => { const i = qualityIndex(q); return i === null ? '' : `q-${i}`; };
