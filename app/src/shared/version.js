'use strict';
// Version strings for the app and the addon: MAJOR.MINOR.PATCH with an optional
// pre-release part such as "-beta.2". Compared the semver way: 1.2.0-beta.1 < 1.2.0.
// Zero dependencies: shared by the app, the server and the release scripts.

const RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const BUMPS = ['patch', 'minor', 'major', 'beta'];

// → { major, minor, patch, pre } (pre is a string or null), or null when v isn't a version.
function parse(v) {
  if (typeof v !== 'string') return null;
  const m = RE.exec(v.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] || null };
}

function valid(v) {
  return parse(v) !== null;
}

function format({ major, minor, patch, pre }) {
  return `${major}.${minor}.${patch}${pre ? `-${pre}` : ''}`;
}

function cmpNum(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Pre-release identifiers: numbers compare as numbers and sort before words; a longer list
// wins when one is a prefix of the other (beta < beta.1).
function comparePre(a, b) {
  if (a === b) return 0;
  if (a === null) return 1; // a release beats any pre-release of the same version
  if (b === null) return -1;
  const pa = a.split('.'); const pb = b.split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if (pa[i] === undefined) return -1;
    if (pb[i] === undefined) return 1;
    const na = /^\d+$/.test(pa[i]); const nb = /^\d+$/.test(pb[i]);
    if (na && nb) { const c = cmpNum(Number(pa[i]), Number(pb[i])); if (c) return c; continue; }
    if (na !== nb) return na ? -1 : 1;
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

// -1, 0 or 1. Something that isn't a version sorts below every real version, so a missing or
// broken version always counts as "older".
function compare(a, b) {
  const pa = parse(a); const pb = parse(b);
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0;
  return cmpNum(pa.major, pb.major) || cmpNum(pa.minor, pb.minor) || cmpNum(pa.patch, pb.patch) || comparePre(pa.pre, pb.pre);
}

function lt(a, b) { return compare(a, b) < 0; }
function gt(a, b) { return compare(a, b) > 0; }

// Next version. 'patch' | 'minor' | 'major' work like `npm version`: a pre-release graduates
// to its release (1.3.0-beta.2 + minor → 1.3.0). 'beta' starts or continues a beta series:
// 1.2.3 → 1.2.4-beta.1 → 1.2.4-beta.2.
function bump(v, kind = 'patch') {
  const p = parse(v);
  if (!p) throw new Error(`"${v}" isn't a version like 1.2.3.`);
  if (!BUMPS.includes(kind)) throw new Error(`Can't bump by "${kind}". Use patch, minor, major or beta.`);
  const n = { ...p, pre: null };
  if (kind === 'major') {
    if (!(p.pre && p.minor === 0 && p.patch === 0)) { n.major++; n.minor = 0; n.patch = 0; }
  } else if (kind === 'minor') {
    if (!(p.pre && p.patch === 0)) { n.minor++; n.patch = 0; }
  } else if (kind === 'patch') {
    if (!p.pre) n.patch++;
  } else {
    const m = p.pre && /^beta(?:\.(\d+))?$/.exec(p.pre);
    if (m) n.pre = `beta.${Number(m[1] || 0) + 1}`;
    else { if (!p.pre) n.patch++; n.pre = 'beta.1'; }
  }
  return format(n);
}

module.exports = { parse, valid, compare, lt, gt, bump, format, BUMPS };
