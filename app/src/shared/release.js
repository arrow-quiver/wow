'use strict';
// The release pipeline: version bumps, packing the addon, building the app, and publishing both as
// GitHub releases on arrow-quiver/wow with the GitHub CLI (gh). Used by scripts/release.js (CLI and
// CI) and by the app's Publisher (the Releases page). It also reads the public release list, which the
// app uses for addon updates and the Updates page. Zero dependencies: Node built-ins and the other
// shared modules (never Electron).
//
// What a release looks like on GitHub (docs/RELEASING.md):
//   app    tag v<version>        Guild-Camp-Setup-<v>.exe, <exe>.blockmap, latest.yml    marked Latest
//   addon  tag addon-v<version>  WowGuild-<v>.zip, WowGuild-<v>.zip.sha256              never Latest
// The app updates itself with electron-updater's github provider, which follows the release marked
// Latest, so addon releases are made with --latest=false and never hide the app's newest release.
//
// Battle.net credentials for builds are written to app/src/main/bnet-credentials.json (gitignored)
// just before electron-builder runs, and removed afterwards (buildApp's `bnet` option).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile, execFileSync } = require('child_process');
const zip = require('./zip');
const toc = require('./toc');
const version = require('./version');
const hash = require('./hash');

const ADDON = 'WowGuild';
// Installer and update files the app release may carry (also the rule for latest.yml's file names).
const APP_FILE_RE = /^[\w.\- ]+\.(exe|blockmap|dmg|zip|AppImage)$/;
const IS_WIN = process.platform === 'win32';

const GITHUB_REPO = 'arrow-quiver/wow';
const GITHUB_API = 'https://api.github.com';
const TAG_PREFIX = Object.freeze({ app: 'v', addon: 'addon-v' });

// Where the generated Battle.net credentials go, relative to the app folder. credentials.js reads it.
const BNET_FILE = path.join('src', 'main', 'bnet-credentials.json');

const GH_MISSING = "GitHub CLI (gh) isn't installed. Install GitHub CLI from https://cli.github.com, then run gh auth login.";
const GH_LOGIN = "GitHub CLI isn't signed in. Run gh auth login, then try again.";
const BNET_MISSING = 'No Battle.net client id and secret were found, so this build has no Battle.net sign-in (people can still use the app without signing in). '
  + 'To include it, set GUILDCAMP_BNET_CLIENT_ID and GUILDCAMP_BNET_CLIENT_SECRET, or put bnetClientId and bnetClientSecret in .release.json, then build again.';

class ReleaseError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = 'ReleaseError';
    if (status !== undefined) this.status = status;
    if (code !== undefined) this.code = code;
  }
}

const noop = () => {};
const logger = (onLog) => (typeof onLog === 'function' ? onLog : noop);

function formatBytes(n) {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} bytes`;
}

// ---------------------------------------------------------------------------------------------
// Tags and GitHub addresses

/** 'app' + '1.2.3' → 'v1.2.3'; 'addon' + '1.2.3' → 'addon-v1.2.3'. */
function tagFor(kind, v) {
  if (!TAG_PREFIX[kind]) throw new ReleaseError(`Unknown release kind "${kind}".`);
  return `${TAG_PREFIX[kind]}${v}`;
}

/** 'v1.2.3' → { kind: 'app', version }, 'addon-v1.2.3' → { kind: 'addon', version }, anything else → null. */
function parseTag(tag) {
  const s = String(tag == null ? '' : tag).trim();
  let m = /^addon-v(.+)$/.exec(s);
  if (m) return version.valid(m[1]) ? { kind: 'addon', version: m[1] } : null;
  m = /^v(.+)$/.exec(s);
  if (m && version.valid(m[1])) return { kind: 'app', version: m[1] };
  return null;
}

const releasesApiUrl = (repo = GITHUB_REPO, perPage = 30) => `${GITHUB_API}/repos/${repo}/releases?per_page=${perPage}`;
const releasesPage = (repo = GITHUB_REPO) => `https://github.com/${repo}/releases`;

// ---------------------------------------------------------------------------------------------
// Versions

// "patch" | "minor" | "major" | "beta" bumps the current version; anything else must be an
// exact version such as 1.4.0.
function nextVersion(current, bumpOrVersion, where) {
  const how = String(bumpOrVersion || '').trim();
  if (version.BUMPS.includes(how)) {
    if (!version.valid(current)) {
      throw new ReleaseError(`The version in ${where} ("${current || ''}") isn't valid, so it can't be bumped. Pass an exact version like 1.2.3 instead.`, { code: 'BAD_VERSION' });
    }
    return version.bump(current, how);
  }
  if (version.valid(how)) return how;
  throw new ReleaseError(`"${how}" isn't a version (like 1.2.3) or a bump (patch, minor, major, beta).`, { code: 'BAD_VERSION' });
}

// Accepts the WowGuild folder itself, its parent (addon/), or the repo root.
function resolveAddonDir(dir) {
  const abs = path.resolve(String(dir || '.'));
  for (const candidate of [abs, path.join(abs, ADDON), path.join(abs, 'addon', ADDON)]) {
    if (fs.existsSync(path.join(candidate, `${ADDON}.toc`))) return candidate;
  }
  throw new ReleaseError(`There's no ${ADDON}.toc in ${abs}. Pick the ${ADDON} addon folder.`, { code: 'NO_TOC' });
}

function readAddonVersion(addonDir) {
  const dir = resolveAddonDir(addonDir);
  return toc.tocVersion(fs.readFileSync(path.join(dir, `${ADDON}.toc`), 'utf8'));
}

// Sets "## Version:" in WowGuild.toc. → the new version.
function bumpAddonVersion(addonDir, bumpOrVersion) {
  const dir = resolveAddonDir(addonDir);
  const file = path.join(dir, `${ADDON}.toc`);
  const text = fs.readFileSync(file, 'utf8');
  const current = toc.tocVersion(text);
  const next = nextVersion(current, bumpOrVersion, `${ADDON}.toc`);
  if (next !== current) fs.writeFileSync(file, toc.setTocField(text, 'Version', next));
  return next;
}

// Finds where the value at keyPath sits in a JSON text, so it can be replaced without
// reformatting the rest of the file. The text must already be valid JSON. → [start, end] or null.
function jsonValueSpan(text, keyPath) {
  let i = 0;
  let found = null;
  const ws = () => { while (i < text.length && /\s/.test(text[i])) i++; };
  const str = () => {
    const s = i++;
    while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    i++;
    return JSON.parse(text.slice(s, i));
  };
  const value = (at) => {
    ws();
    const start = i;
    const c = text[i];
    if (c === '{') {
      i++; ws();
      if (text[i] === '}') i++;
      else {
        for (;;) {
          ws(); const key = str(); ws(); i++; // ':'
          value([...at, key]); ws();
          if (text[i++] === ',') continue;
          break; // '}'
        }
      }
    } else if (c === '[') {
      i++; ws();
      if (text[i] === ']') i++;
      else {
        for (let n = 0; ; n++) {
          value([...at, n]); ws();
          if (text[i++] === ',') continue;
          break; // ']'
        }
      }
    } else if (c === '"') str();
    else while (i < text.length && !/[\s,\]}]/.test(text[i])) i++;
    if (!found && at.length === keyPath.length && at.every((k, n) => k === keyPath[n])) found = [start, i];
  };
  value([]);
  return found;
}

function setJsonString(text, keyPath, value) {
  const span = jsonValueSpan(text, keyPath);
  if (!span) return text;
  return text.slice(0, span[0]) + JSON.stringify(value) + text.slice(span[1]);
}

// Sets "version" in app/package.json (and the matching fields in package-lock.json, as
// `npm version` does), keeping the files' formatting. → the new version.
function bumpAppVersion(appDir, bumpOrVersion) {
  const file = path.join(path.resolve(appDir), 'package.json');
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { throw new ReleaseError(`There's no package.json in ${path.resolve(appDir)}. Pick the app folder.`, { code: 'NO_PACKAGE' }); }
  const pkg = JSON.parse(text);
  const next = nextVersion(pkg.version, bumpOrVersion, 'app/package.json');
  if (next === pkg.version) return next;
  fs.writeFileSync(file, setJsonString(text, ['version'], next));
  const lockFile = path.join(path.dirname(file), 'package-lock.json');
  if (fs.existsSync(lockFile)) {
    let lock = fs.readFileSync(lockFile, 'utf8');
    try {
      const parsed = JSON.parse(lock);
      if (typeof parsed.version === 'string') lock = setJsonString(lock, ['version'], next);
      if (parsed.packages && parsed.packages[''] && typeof parsed.packages[''].version === 'string') {
        lock = setJsonString(lock, ['packages', '', 'version'], next);
      }
      fs.writeFileSync(lockFile, lock);
    } catch { /* a broken lockfile is npm's problem, not the release's */ }
  }
  return next;
}

function readAppVersion(appDir) {
  return JSON.parse(fs.readFileSync(path.join(path.resolve(appDir), 'package.json'), 'utf8')).version;
}

// ---------------------------------------------------------------------------------------------
// Addon

// What goes in the addon zip: everything in the folder except dotfiles (.git, .pkgmeta, …) and
// the news file old addons kept in Data/Inbox.lua (it lives in WowGuild_Inbox now).
function addonFilter(rel) {
  if (rel.split('/').some((seg) => seg.startsWith('.'))) return false;
  if (/^Data\/Inbox\.lua$/i.test(rel)) return false;
  return true;
}

// Zips the addon as one WowGuild/ folder, like every addon zip.
// → { version, zip, sha256, size, fileName, files, toc, dir }
function packAddon(addonDir) {
  const dir = resolveAddonDir(addonDir);
  const text = fs.readFileSync(path.join(dir, `${ADDON}.toc`), 'utf8');
  const ver = toc.tocVersion(text);
  if (!version.valid(ver)) {
    throw new ReleaseError(`${ADDON}.toc needs a "## Version:" line with a version like 1.2.3 (found "${ver || 'nothing'}").`, { code: 'BAD_VERSION' });
  }
  const entries = zip.directoryEntries(dir, { prefix: ADDON, filter: addonFilter });
  const buf = zip.createZip(entries);
  return {
    version: ver,
    zip: buf,
    sha256: hash.sha256(buf),
    size: buf.length,
    fileName: `${ADDON}-${ver}.zip`,
    files: entries.filter((e) => !e.isDir).map((e) => e.name),
    toc: toc.readToc(text).fields,
    dir,
  };
}

/** The two files of an addon release. */
function addonAssetNames(v) {
  return { zip: `${ADDON}-${v}.zip`, sha: `${ADDON}-${v}.zip.sha256` };
}

/** The .sha256 file next to the zip, in the usual `sha256sum` format. */
function sha256Text(pack) {
  return `${pack.sha256}  ${pack.fileName}\n`;
}

/**
 * Reads a .sha256 file: "<64 hex>  WowGuild-1.2.3.zip", or just the hex. With several lines, the one
 * naming fileName wins. → lowercase hex, or null when there is none.
 */
function parseSha256Text(text, fileName) {
  const lines = String(text || '').replace(/^﻿/, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const parsed = lines.map((l) => /^([0-9a-fA-F]{64})(?:\s+\*?(.+))?$/.exec(l)).filter(Boolean);
  if (!parsed.length) return null;
  const named = fileName ? parsed.find((m) => m[2] && path.basename(m[2].trim()) === fileName) : null;
  return (named || parsed[0])[1].toLowerCase();
}

/** Writes WowGuild-<v>.zip and WowGuild-<v>.zip.sha256 into dir. → { zipFile, shaFile } */
function writeAddonAssets(pack, dir) {
  if (!pack || !Buffer.isBuffer(pack.zip)) throw new ReleaseError('Nothing to publish: pack the addon first.', { code: 'NO_PACK' });
  fs.mkdirSync(dir, { recursive: true });
  const names = addonAssetNames(pack.version);
  const zipFile = path.join(dir, names.zip);
  const shaFile = path.join(dir, names.sha);
  fs.writeFileSync(zipFile, pack.zip);
  fs.writeFileSync(shaFile, sha256Text({ sha256: pack.sha256 || hash.sha256(pack.zip), fileName: names.zip }));
  return { zipFile, shaFile };
}

// ---------------------------------------------------------------------------------------------
// Battle.net credentials for builds

const cleanValue = (v) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim());

/**
 * The Battle.net client id and secret to build into the installer:
 * env GUILDCAMP_BNET_CLIENT_ID / GUILDCAMP_BNET_CLIENT_SECRET first, then .release.json's
 * bnetClientId / bnetClientSecret. → { clientId, clientSecret, from } | null (none set).
 * Only one of the pair is a mistake and throws, so a release never goes out half set up.
 */
function bnetCredentialsFrom({ env = process.env, config = {} } = {}) {
  const pairs = [
    [cleanValue(env && env.GUILDCAMP_BNET_CLIENT_ID), cleanValue(env && env.GUILDCAMP_BNET_CLIENT_SECRET), 'GUILDCAMP_BNET_CLIENT_ID', 'GUILDCAMP_BNET_CLIENT_SECRET', 'environment variables'],
    [cleanValue(config && config.bnetClientId), cleanValue(config && config.bnetClientSecret), 'bnetClientId', 'bnetClientSecret', '.release.json'],
  ];
  for (const [id, secret, idName, secretName, from] of pairs) {
    if (!id && !secret) continue;
    if (!id || !secret) {
      const [have, missing] = id ? [idName, secretName] : [secretName, idName];
      throw new ReleaseError(`${have} is set but ${missing} isn't (${from}). Set both, or neither.`, { code: 'BNET_HALF' });
    }
    return { clientId: id, clientSecret: secret, from };
  }
  return null;
}

const maskId = (id) => (id.length > 6 ? `${id.slice(0, 4)}…` : '…');

// Writes the credentials file for one build. → a function that puts things back as they were.
// bnet: undefined → leave the file alone (no message); null → none for this build (warns, unless a
// file is already there, which is then used); { clientId, clientSecret, from } → write it.
function prepareBnetFile(appDir, bnet, log, warn) {
  if (bnet === undefined) return noop;
  const file = path.join(appDir, BNET_FILE);
  let previous = null;
  try { previous = fs.readFileSync(file); } catch { /* none: the usual case */ }
  if (bnet && bnet.clientId && bnet.clientSecret) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ clientId: bnet.clientId, clientSecret: bnet.clientSecret }, null, 2)}\n`, { mode: 0o600 });
    log(`Battle.net sign-in is built in (client id ${maskId(bnet.clientId)}, from ${bnet.from || 'the release settings'}).`);
    return () => {
      try {
        if (previous) fs.writeFileSync(file, previous);
        else fs.rmSync(file, { force: true });
      } catch (err) {
        warn(`Couldn't remove ${file} (${err.message}). Delete it by hand: it holds the Battle.net secret.`);
      }
    };
  }
  if (previous) log(`Using the Battle.net credentials already in ${path.join('app', BNET_FILE)}.`);
  else warn(BNET_MISSING);
  return noop;
}

// ---------------------------------------------------------------------------------------------
// App build

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

function killTree(child) {
  if (IS_WIN && child && child.pid) {
    execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
  } else {
    // The build runs as its own process group (detached): signal the whole group, npm and what it started.
    try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* already gone */ } }
  }
}

// Runs `npm run dist` in the app folder (electron-builder --win --publish never), streaming each
// output line to onLog. Resolves { distDir } on success; rejects when the build fails.
// bnet: the Battle.net credentials to build in (see prepareBnetFile); the file is removed again
// when the build ends, whatever happens.
// Aborting `signal` stops the whole build. On Windows npm runs under cmd.exe, and killing cmd.exe
// alone would leave npm and electron-builder running, so the abort kills the process tree with
// taskkill /T /F. The signal isn't handed to spawn there: if Node killed cmd.exe first, the tree
// would already be orphaned before taskkill could walk it. Elsewhere the build starts as its own process group, and
// the abort signals the group: killing npm alone leaves electron-builder running and the output pipe open.
function buildApp(appDir, { onLog, onWarn, signal, env, bnet } = {}) {
  const log = logger(onLog);
  const warn = typeof onWarn === 'function' ? onWarn : log;
  const cwd = path.resolve(appDir);
  if (!fs.existsSync(path.join(cwd, 'package.json'))) {
    return Promise.reject(new ReleaseError(`There's no package.json in ${cwd}. Pick the app folder.`, { code: 'NO_PACKAGE' }));
  }
  if (signal && signal.aborted) return Promise.reject(new ReleaseError('The app build was cancelled.', { code: 'ABORTED' }));
  let restore;
  try {
    restore = prepareBnetFile(cwd, bnet, log, warn);
  } catch (err) {
    return Promise.reject(new ReleaseError(`Couldn't write the Battle.net credentials for the build (${err.message}).`, { code: 'BNET_FILE' }));
  }
  const run = new Promise((resolve, reject) => {
    log(`Building the app in ${cwd} (npm run dist). This takes a few minutes.`);
    let child;
    try {
      const options = { cwd, env: mergeEnv(process.env, env), windowsHide: true };
      // npm is npm.cmd on Windows, which needs a shell. Pass the whole command as one string
      // there: Node warns about (and doesn't escape) separate arguments with shell: true.
      child = IS_WIN
        ? spawn('npm run dist', { ...options, shell: true })
        : spawn('npm', ['run', 'dist'], { ...options, detached: true });
    } catch (e) {
      reject(new ReleaseError(`Couldn't start npm (${e.message}). Install Node.js and make sure npm is on your PATH.`, { code: 'NO_NPM' }));
      return;
    }
    let aborted = false;
    const onAbort = () => {
      if (aborted) return;
      aborted = true;
      log('Stopping the build…');
      killTree(child);
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const done = () => { if (signal) signal.removeEventListener('abort', onAbort); };
    const pending = { out: '', err: '' };
    const feed = (which) => (chunk) => {
      pending[which] += chunk.toString('utf8');
      const lines = pending[which].split(/\r?\n|\r/);
      pending[which] = lines.pop();
      for (const line of lines) { const clean = line.replace(ANSI, '').trimEnd(); if (clean) log(clean); }
    };
    child.stdout.on('data', feed('out'));
    child.stderr.on('data', feed('err'));
    let settled = false;
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      done();
      if (aborted || e.name === 'AbortError') reject(new ReleaseError('The app build was cancelled.', { code: 'ABORTED' }));
      else reject(new ReleaseError(`Couldn't start npm (${e.message}). Install Node.js and make sure npm is on your PATH.`, { code: 'NO_NPM' }));
    });
    child.on('close', (code, sig) => {
      for (const rest of [pending.out, pending.err]) { const clean = rest.replace(ANSI, '').trimEnd(); if (clean) log(clean); }
      if (settled) return;
      settled = true;
      done();
      if (aborted) reject(new ReleaseError('The app build was cancelled.', { code: 'ABORTED' }));
      else if (code === 0) resolve({ distDir: path.join(cwd, 'dist') });
      else if (sig) reject(new ReleaseError(`The app build was stopped (${sig}).`, { code: 'ABORTED' }));
      else reject(new ReleaseError(`The app build failed (npm run dist exited with code ${code}). The build output above says why.`, { code: 'BUILD_FAILED' }));
    });
  });
  return run.finally(restore);
}

// ---------------------------------------------------------------------------------------------
// latest.yml (electron-builder's update manifest)

// Keys whose values always stay strings, even when they look like numbers.
const YML_STRING_KEYS = new Set(['version', 'url', 'path', 'sha512', 'sha2', 'releaseName', 'releaseNotes', 'releaseDate']);

function ymlScalar(raw, key) {
  const s = String(raw).trim();
  if (s === '' || s === '~' || s === 'null') return null;
  if (s.startsWith("'")) {
    const end = s.lastIndexOf("'");
    return (end > 0 ? s.slice(1, end) : s.slice(1)).replace(/''/g, "'");
  }
  if (s.startsWith('"')) {
    const end = s.lastIndexOf('"');
    const quoted = end > 0 ? s.slice(0, end + 1) : `${s}"`;
    try { return JSON.parse(quoted); } catch { return quoted.slice(1, -1); }
  }
  const plain = s.replace(/\s+#.*$/, '');
  if (YML_STRING_KEYS.has(key)) return plain;
  if (plain === 'true') return true;
  if (plain === 'false') return false;
  if (/^-?\d+$/.test(plain)) return Number(plain);
  return plain;
}

// "key: value" → [key, rawValue] or null. Keys may be quoted.
function ymlPair(text) {
  const m = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s'"#][^:#]*?)\s*:(?:\s+(.*))?$/.exec(text.trim());
  if (!m) return null;
  const key = /^["']/.test(m[1]) ? ymlScalar(m[1], '') : m[1].trim();
  return [String(key), m[2] === undefined ? '' : m[2]];
}

// A tiny parser for the flat YAML electron-builder writes:
//   version: 0.11.1
//   files:
//     - url: Guild-Camp-Setup-0.11.1.exe
//       sha512: <base64>
//       size: 123
//       blockMapSize: 456
//   path: Guild-Camp-Setup-0.11.1.exe
//   sha512: <base64>
//   releaseDate: '2026-11-07T10:00:00.000Z'
// Also handles a nested map of scalars and | / > block scalars (release notes).
function parseLatestYml(text) {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/);
  const indentOf = (l) => /^ */.exec(l)[0].length;
  const blank = (l) => !l.trim() || /^\s*#/.test(l);
  const out = {};
  let i = 0;
  const fail = (n, why) => { throw new ReleaseError(`latest.yml line ${n + 1}: ${why}`, { code: 'BAD_YML' }); };
  while (i < lines.length) {
    const line = lines[i];
    if (blank(line) || /^(---|\.\.\.)\s*$/.test(line)) { i++; continue; }
    if (indentOf(line) !== 0) fail(i, 'unexpected indent');
    const pair = ymlPair(line);
    if (!pair) fail(i, "isn't a \"key: value\" line");
    const [key, rest] = pair;
    i++;
    const block = /^([|>])([+-]?)\s*(?:#.*)?$/.exec(rest.trim());
    if (block) {
      const body = [];
      while (i < lines.length && (!lines[i].trim() || indentOf(lines[i]) > 0)) body.push(lines[i++]);
      const ind = Math.min(...body.filter((l) => l.trim()).map(indentOf), Infinity);
      let textOut = body.map((l) => l.slice(Number.isFinite(ind) ? ind : 0));
      while (block[2] !== '+' && textOut.length && !textOut[textOut.length - 1].trim()) textOut.pop();
      let joined = block[1] === '|' ? textOut.join('\n') : textOut.join('\n').replace(/([^\n])\n(?=[^\n])/g, '$1 ');
      if (block[2] !== '-') joined += '\n';
      out[key] = joined;
      continue;
    }
    if (rest.trim() !== '') { out[key] = ymlScalar(rest, key); continue; }
    // Nothing after the colon: a list ("- ...") or a nested map follows, or the value is empty.
    const children = [];
    while (i < lines.length && (blank(lines[i]) || indentOf(lines[i]) > 0 || /^-(\s|$)/.test(lines[i]))) {
      if (!blank(lines[i])) children.push([i, lines[i]]);
      i++;
    }
    if (!children.length) { out[key] = null; continue; }
    if (/^\s*-(\s|$)/.test(children[0][1])) {
      const items = [];
      let item = null; let itemIndent = -1;
      for (const [n, l] of children) {
        const ind = indentOf(l); const t = l.trim();
        if (/^-(\s|$)/.test(t)) {
          const bodyText = t.slice(1).trim();
          const kv = bodyText && !/^["']/.test(bodyText) ? ymlPair(bodyText) : null;
          if (kv) { item = { [kv[0]]: ymlScalar(kv[1], kv[0]) }; items.push(item); } else { item = null; items.push(ymlScalar(bodyText, key)); }
          itemIndent = ind;
        } else if (item && ind > itemIndent) {
          const kv = ymlPair(t);
          if (!kv) fail(n, "isn't a \"key: value\" line");
          item[kv[0]] = ymlScalar(kv[1], kv[0]);
        } else fail(n, 'unexpected line in a list');
      }
      out[key] = items;
    } else {
      const map = {};
      for (const [n, l] of children) {
        const kv = ymlPair(l);
        if (!kv) fail(n, "isn't a \"key: value\" line");
        map[kv[0]] = ymlScalar(kv[1], kv[0]);
      }
      out[key] = map;
    }
  }
  return out;
}

// latest.yml "url" values are file names next to it (sometimes URL-encoded, rarely full URLs).
function fileNameFromUrl(url) {
  let name = String(url || '').split(/[?#]/)[0];
  name = name.slice(name.lastIndexOf('/') + 1);
  try { name = decodeURIComponent(name); } catch { /* keep it as it is */ }
  return name;
}

// Reads what electron-builder left in dist/. → { version, files: [absolute paths], latestYml, latestYmlFile, info }
// files = every file latest.yml lists, plus its .blockmap when there is one (for small
// differential downloads). latest.yml itself is latestYmlFile.
function readAppBuild(distDir) {
  const dir = path.resolve(distDir);
  const ymlFile = path.join(dir, 'latest.yml');
  if (!fs.existsSync(ymlFile)) {
    // A build of a -beta.N version without `detectUpdateChannel: false` writes beta.yml instead.
    let other = [];
    try { other = fs.readdirSync(dir).filter((f) => /\.yml$/i.test(f) && !/^builder-(debug|effective-config)\.yml$/i.test(f)); } catch { /* no dist folder */ }
    if (other.length) {
      throw new ReleaseError(`There's no latest.yml in ${dir}, only ${other.join(', ')}. The app's updater only reads latest.yml: keep `
        + '"detectUpdateChannel: false" in app/electron-builder.yml so every build (beta ones too) writes latest.yml, then build again.', { code: 'NO_BUILD' });
    }
    throw new ReleaseError(`There's no latest.yml in ${dir}. Build the app first (npm run dist in app/).`, { code: 'NO_BUILD' });
  }
  const latestYml = fs.readFileSync(ymlFile, 'utf8');
  const info = parseLatestYml(latestYml);
  if (!version.valid(info.version)) throw new ReleaseError(`latest.yml in ${dir} has no valid version.`, { code: 'BAD_YML' });
  let listed = Array.isArray(info.files) ? info.files.filter((f) => f && typeof f === 'object' && f.url) : [];
  if (!listed.length && info.path) listed = [{ url: info.path, sha512: info.sha512 }];
  if (!listed.length) throw new ReleaseError('latest.yml lists no files.', { code: 'BAD_YML' });
  const files = [];
  for (const f of listed) {
    const name = fileNameFromUrl(f.url);
    if (!APP_FILE_RE.test(name)) throw new ReleaseError(`latest.yml lists "${name}", which isn't an installer file.`, { code: 'BAD_YML' });
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) {
      throw new ReleaseError(`latest.yml lists ${name}, but it isn't in ${dir}. Build the app again.`, { code: 'NO_BUILD' });
    }
    if (!files.includes(file)) files.push(file);
    if (fs.existsSync(`${file}.blockmap`) && !files.includes(`${file}.blockmap`)) files.push(`${file}.blockmap`);
  }
  return { version: info.version, files, latestYml, latestYmlFile: ymlFile, info };
}

// Every file of a build checked against latest.yml (checksum and size), before anything is sent.
// → [{ file, name, size, sha512 }]
async function checkAppBuild(build) {
  const out = [];
  for (const file of build.files) {
    const name = path.basename(file);
    if (!APP_FILE_RE.test(name)) throw new ReleaseError(`"${name}" isn't an installer file name the release can carry.`, { code: 'BAD_FILE' });
    const size = fs.statSync(file).size;
    const sha512 = await hash.sha512File(file);
    const listed = (build.info.files || []).find((x) => x && fileNameFromUrl(x.url) === name);
    if (listed && listed.sha512 && listed.sha512 !== sha512) {
      throw new ReleaseError(`${name} doesn't match latest.yml (different checksum). Build the app again.`, { code: 'MISMATCH' });
    }
    if (listed && typeof listed.size === 'number' && listed.size !== size) {
      throw new ReleaseError(`${name} doesn't match latest.yml (different size). Build the app again.`, { code: 'MISMATCH' });
    }
    out.push({ file, name, size, sha512 });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// GitHub's release list (public API, no sign-in)

/**
 * One release from the GitHub API (or from gh, or already normalized) → the fields Guild Camp uses:
 * { kind, version, tag, name, notes, publishedAt, url, draft, prerelease, assets: [{ name, url, size, digest }] }.
 * Releases whose tag isn't v<version> or addon-v<version> → null.
 */
function normalizeRelease(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const tag = raw.tag_name ?? raw.tagName ?? raw.tag;
  const info = parseTag(tag);
  if (!info) return null;
  const assets = (Array.isArray(raw.assets) ? raw.assets : [])
    .filter((a) => a && typeof a.name === 'string')
    .map((a) => {
      const size = Number(a.size);
      return {
        name: a.name,
        url: a.browser_download_url || a.url || null,
        size: Number.isFinite(size) && size > 0 ? size : null,
        digest: typeof a.digest === 'string' ? a.digest : null,
      };
    });
  const notes = raw.body ?? raw.notes;
  return {
    kind: info.kind,
    version: info.version,
    tag: String(tag).trim(),
    name: typeof raw.name === 'string' ? raw.name : '',
    notes: typeof notes === 'string' ? notes.replace(/\r\n?/g, '\n') : '',
    publishedAt: raw.published_at ?? raw.publishedAt ?? raw.created_at ?? raw.createdAt ?? null,
    url: raw.html_url ?? raw.url ?? null,
    draft: Boolean(raw.draft ?? raw.isDraft),
    prerelease: Boolean(raw.prerelease ?? raw.isPrerelease),
    assets,
  };
}

const timeOf = (r) => Date.parse(r && r.publishedAt ? r.publishedAt : '') || 0;

/** The newest (by version) published, non-prerelease release of a kind that passes `test`. */
function newestRelease(list, kind, test = () => true) {
  let best = null;
  for (const raw of Array.isArray(list) ? list : []) {
    const r = normalizeRelease(raw);
    if (!r || r.kind !== kind || r.draft || r.prerelease || !test(r)) continue;
    if (!best || version.gt(r.version, best.version)) best = r;
  }
  return best;
}

/**
 * A release list → { app, addon, history }: the newest app and addon releases (by version; drafts
 * and prereleases left out) and every published release, newest first.
 */
function summarizeReleases(list, { historyMax = 30 } = {}) {
  const all = (Array.isArray(list) ? list : []).map(normalizeRelease).filter((r) => r && !r.draft);
  const history = all.slice()
    .sort((a, b) => timeOf(b) - timeOf(a) || version.compare(b.version, a.version))
    .slice(0, historyMax);
  return { app: newestRelease(all, 'app'), addon: newestRelease(all, 'addon'), history };
}

function networkWords(err) {
  if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) return 'it took too long';
  const code = (err && err.cause && err.cause.code) || (err && err.code) || '';
  const words = { ENOTFOUND: 'address not found', EAI_AGAIN: 'address not found', ECONNREFUSED: 'connection refused', ECONNRESET: 'connection dropped', ETIMEDOUT: 'connection timed out', ENETUNREACH: 'no network', EHOSTUNREACH: 'no network' };
  return words[code] || code || (err && err.message) || 'network error';
}

/**
 * GET the release list from the GitHub API. etag: the ETag of the answer you have (If-None-Match), so
 * an unchanged list costs nothing. → { notModified: true, etag } | { notModified: false, etag, releases }
 * Throws a ReleaseError with code NETWORK, RATE_LIMITED (with resetAt), NOT_FOUND, HTTP or BAD_ANSWER.
 */
async function fetchReleaseList({ fetch: fetchImpl, url = releasesApiUrl(), etag = null, userAgent = 'GuildCamp', timeout = 15000, signal } = {}) {
  const f = fetchImpl || globalThis.fetch;
  if (typeof f !== 'function') throw new ReleaseError('This Node.js has no fetch. Use Node.js 20 or newer.', { code: 'NO_FETCH' });
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': userAgent, 'X-GitHub-Api-Version': '2022-11-28' };
  if (etag) headers['If-None-Match'] = etag;
  let res;
  try {
    res = await f(url, { headers, signal: signal || AbortSignal.timeout(timeout) });
  } catch (err) {
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new ReleaseError('GitHub took too long to answer. Try again later.', { code: 'NETWORK' });
    }
    throw new ReleaseError(`Couldn't reach GitHub (${networkWords(err)}). Check your internet connection.`, { code: 'NETWORK' });
  }
  const header = (name) => (res.headers && typeof res.headers.get === 'function' ? res.headers.get(name) : null);
  if (res.status === 304) return { notModified: true, etag };
  if (res.status === 200) {
    let list;
    try { list = await res.json(); } catch { list = null; }
    if (!Array.isArray(list)) throw new ReleaseError("GitHub sent a release list Guild Camp can't read. Try again later.", { status: 200, code: 'BAD_ANSWER' });
    return { notModified: false, etag: header('etag') || null, releases: list.map(normalizeRelease).filter(Boolean) };
  }
  let text = '';
  try { text = await res.text(); } catch { /* no body */ }
  if (res.status === 429 || (res.status === 403 && (header('x-ratelimit-remaining') === '0' || /rate limit/i.test(text)))) {
    const reset = Number(header('x-ratelimit-reset'));
    const retry = Number(header('retry-after'));
    const resetAt = Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000).toISOString()
      : Number.isFinite(retry) && retry > 0 ? new Date(Date.now() + retry * 1000).toISOString() : null;
    const e = new ReleaseError('GitHub is limiting how often this computer can check for updates. Guild Camp tries again later.', { status: res.status, code: 'RATE_LIMITED' });
    e.resetAt = resetAt;
    throw e;
  }
  if (res.status === 404) {
    throw new ReleaseError("Guild Camp couldn't find its releases on GitHub. The project may not be public yet.", { status: 404, code: 'NOT_FOUND' });
  }
  throw new ReleaseError(`GitHub answered ${res.status} when Guild Camp asked for the releases. Try again later.`, { status: res.status, code: 'HTTP' });
}

const FEED_MIN_INTERVAL = 30 * 60 * 1000; // automatic checks ask GitHub at most this often
const FEED_FORCE_GAP = 10 * 1000; // a check the person asked for, at most this often
const feedMemory = new Map(); // key → state, when there is no cache file (and as a mirror of it)
const feedInflight = new Map(); // key → Promise: callers asking at the same time share one request

// With a cache file, the file is the truth (other readers share it); the copy in memory only stands in
// when the file couldn't be written.
function loadFeed(key, cacheFile, url) {
  const memory = feedMemory.get(key) || null;
  let state = cacheFile ? null : memory;
  if (cacheFile) {
    try {
      const saved = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (saved && saved.v === 1 && saved.url === url) state = saved;
    } catch {
      if (memory && memory.unsaved) state = memory; // nothing on disk because writing failed
    }
  }
  const out = state ? { ...state } : { v: 1, url, etag: null, releases: null, fetchedAt: null, attemptAt: null, error: null, code: null, retryAfter: null };
  delete out.unsaved;
  return out;
}

function saveFeed(key, cacheFile, state) {
  let unsaved = false;
  if (cacheFile) {
    try {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      const tmp = `${cacheFile}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, cacheFile);
    } catch {
      unsaved = true; // the copy in memory still works until the app restarts
    }
  }
  feedMemory.set(key, { ...state, unsaved });
}

/**
 * The release list through a small cache, so the app stays far below GitHub's limit for
 * unauthenticated requests (60 an hour per address). An automatic check asks GitHub only when the last
 * attempt is older than minInterval (30 minutes); force (the person pressed Check) only when it is older
 * than forceGap (10 seconds). The ETag makes an unchanged list free. After a rate limit, nothing is
 * asked until GitHub's reset time. The cache file is shared: the addon manager and the updater both
 * use <userData>/github-releases.json, and calls at the same moment share one request.
 * → { releases: [normalized]|null, fetchedAt, attemptAt, error, code, fromNetwork }
 *   releases is the last list GitHub sent (maybe from an earlier run); error says why the latest
 *   attempt failed, if it did.
 */
function readReleaseFeed({
  cacheFile = null, url = releasesApiUrl(), fetch: fetchImpl, userAgent = 'GuildCamp', force = false,
  minInterval = FEED_MIN_INTERVAL, forceGap = FEED_FORCE_GAP, timeout, now = Date.now,
} = {}) {
  const key = cacheFile ? `file:${path.resolve(cacheFile)}` : `url:${url}`;
  if (feedInflight.has(key)) return feedInflight.get(key);
  const view = (s, fromNetwork) => ({
    releases: Array.isArray(s.releases) ? s.releases.slice() : null,
    fetchedAt: s.fetchedAt || null,
    attemptAt: s.attemptAt || null,
    error: s.error || null,
    code: s.code || null,
    fromNetwork,
  });
  const p = (async () => {
    const state = loadFeed(key, cacheFile, url);
    const t = now();
    let since = state.attemptAt ? t - Date.parse(state.attemptAt) : Infinity;
    if (!Number.isFinite(since) || since < 0) since = Infinity; // no attempt yet, or the clock went back
    const limited = state.retryAfter && Date.parse(state.retryAfter) > t;
    if (limited || since < (force ? forceGap : minInterval)) return view(state, false);
    state.attemptAt = new Date(t).toISOString();
    try {
      const r = await fetchReleaseList({ fetch: fetchImpl, url, etag: Array.isArray(state.releases) ? state.etag : null, userAgent, timeout });
      if (!r.notModified) {
        state.releases = r.releases;
        state.etag = r.etag;
      }
      state.fetchedAt = state.attemptAt;
      state.error = null;
      state.code = null;
      state.retryAfter = null;
    } catch (err) {
      state.error = (err && err.message) || "Couldn't reach GitHub.";
      state.code = (err && err.code) || null;
      state.retryAfter = err && err.code === 'RATE_LIMITED' && err.resetAt ? err.resetAt : null;
    }
    saveFeed(key, cacheFile, state);
    return view(state, true);
  })().finally(() => feedInflight.delete(key));
  feedInflight.set(key, p);
  return p;
}

// ---------------------------------------------------------------------------------------------
// GitHub CLI (gh)

function envGet(env, name) {
  if (!env) return undefined;
  if (!IS_WIN) return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

// base with extra on top. On Windows, names match whatever their case (Path and PATH are one).
// undefined/null values in extra remove the variable.
function mergeEnv(base, extra) {
  const out = { ...(base || {}) };
  for (const [k, v] of Object.entries(extra || {})) {
    if (IS_WIN) for (const have of Object.keys(out)) if (have !== k && have.toUpperCase() === k.toUpperCase()) delete out[have];
    if (v === undefined || v === null) delete out[k];
    else out[k] = String(v);
  }
  return out;
}

const isFileSync = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const runnable = (p) => {
  if (!isFileSync(p)) return false;
  if (IS_WIN || /\.[cm]?js$/i.test(p)) return true; // a .js file runs with Node, no exec bit needed
  try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; }
};

/**
 * Finds a program like the shell would: an absolute path as it is, otherwise each PATH folder (with
 * .exe, .cmd, .bat, .com on Windows). For gh it also looks where its installers put it, for apps
 * started before PATH was updated. → full path | null
 */
function findExecutable(command, env = process.env) {
  const cmd = String(command || '').trim();
  if (!cmd) return null;
  const exts = IS_WIN ? ['.exe', '.cmd', '.bat', '.com'] : [''];
  const candidates = (base) => (IS_WIN && path.extname(base) ? [base] : exts.map((e) => base + e));
  if (path.isAbsolute(cmd) || /[\\/]/.test(cmd)) {
    return candidates(path.resolve(cmd)).find(runnable) || null;
  }
  const dirs = String(envGet(env, 'PATH') || '').split(path.delimiter).map((d) => d.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean);
  for (const dir of dirs) {
    const hit = candidates(path.join(dir, cmd)).find(runnable);
    if (hit) return hit;
  }
  if (cmd.toLowerCase() === 'gh') {
    const known = IS_WIN
      ? [[envGet(env, 'ProgramFiles'), 'GitHub CLI'], [envGet(env, 'LOCALAPPDATA'), 'Programs', 'GitHub CLI'], [envGet(env, 'LOCALAPPDATA'), 'Microsoft', 'WinGet', 'Links']]
        .filter(([root]) => root).map(([root, ...rest]) => path.join(root, ...rest, 'gh.exe'))
      : process.platform === 'darwin' ? ['/opt/homebrew/bin/gh', '/usr/local/bin/gh'] : [];
    const hit = known.find(runnable);
    if (hit) return hit;
  }
  return null;
}

// One argument for a .cmd/.bat run through cmd.exe. Quotes keep & | < > ^ and spaces literal; a quote,
// % or line break can't be passed safely, so those are refused.
function cmdArg(a) {
  const s = String(a);
  if (/["%\r\n]/.test(s)) {
    throw new ReleaseError(`"${s.slice(0, 80)}" can't be passed to a gh.cmd script safely. Install the official GitHub CLI (gh.exe) from https://cli.github.com.`, { code: 'BAD_ARG' });
  }
  return `"${s}"`;
}

const MAX_GH_OUTPUT = 32 * 1024 * 1024;

// Running inside a test (node --test, or a *.test.js file run directly)?
function inTest() {
  return Boolean(process.env.NODE_TEST_CONTEXT) || /\.test\.[cm]?js$/i.test(String(process.argv[1] || ''));
}

const realPath = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };

// Tests must never reach the real GitHub CLI: signed in on a developer's computer, it would publish real
// releases to arrow-quiver/wow. Inside a test only a gh in the temp folder (a test's fake) may run.
function testGuard(exe) {
  if (!inTest()) return null;
  const tmp = realPath(os.tmpdir());
  const rel = path.relative(tmp, realPath(exe));
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return null;
  return new ReleaseError(`A test tried to run the real GitHub CLI (${exe}). Tests may only run a fake gh from the temp folder: pass an env whose PATH starts with the fake's folder.`, { code: 'TEST_GUARD' });
}

/**
 * Runs gh with arguments. Resolves { code, stdout, stderr } whatever the exit code (callers decide
 * what a failure means); rejects only when gh can't start (code NO_GH), is cancelled (ABORTED) or
 * takes longer than timeout (TIMEOUT).
 * gh: the command or a full path (default 'gh' on PATH). A .js file runs with this Node (or Electron
 * as Node); a .cmd/.bat file (Windows) runs through cmd.exe.
 * onLine(line, stream): called for each output line, for live logs.
 */
function runGh(args, { gh = 'gh', env, cwd, onLine, signal, timeout } = {}) {
  const fullEnv = mergeEnv(mergeEnv(process.env, { GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_SPINNER_DISABLED: '1', NO_COLOR: '1' }), env);
  const exe = findExecutable(gh || 'gh', fullEnv);
  if (!exe) return Promise.reject(new ReleaseError(GH_MISSING, { code: 'NO_GH' }));
  const guard = testGuard(exe);
  if (guard) return Promise.reject(guard);
  if (signal && signal.aborted) return Promise.reject(new ReleaseError('Cancelled.', { code: 'ABORTED' }));
  const options = { cwd, env: fullEnv, windowsHide: true };
  const ext = path.extname(exe).toLowerCase();
  let command;
  let argv;
  if (['.js', '.cjs', '.mjs'].includes(ext)) {
    command = process.execPath;
    argv = [exe, ...args.map(String)];
    options.env = { ...fullEnv, ELECTRON_RUN_AS_NODE: '1' };
  } else if (IS_WIN && (ext === '.cmd' || ext === '.bat')) {
    let line;
    try { line = [exe, ...args].map(cmdArg).join(' '); } catch (err) { return Promise.reject(err); }
    command = envGet(fullEnv, 'ComSpec') || 'cmd.exe';
    argv = ['/d', '/v:off', '/s', '/c', `"${line}"`];
    options.windowsVerbatimArguments = true;
  } else {
    command = exe;
    argv = args.map(String);
  }
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, argv, options);
    } catch (err) {
      reject(new ReleaseError(`Couldn't start GitHub CLI (${err.message}).`, { code: 'NO_GH' }));
      return;
    }
    const chunks = { stdout: [], stderr: [] };
    const sizes = { stdout: 0, stderr: 0 };
    const pending = { stdout: '', stderr: '' };
    const take = (which) => (chunk) => {
      if (sizes[which] < MAX_GH_OUTPUT) { chunks[which].push(chunk); sizes[which] += chunk.length; }
      if (typeof onLine !== 'function') return;
      pending[which] += chunk.toString('utf8');
      const lines = pending[which].split(/\r?\n|\r/);
      pending[which] = lines.pop();
      for (const l of lines) { const clean = l.replace(ANSI, '').trimEnd(); if (clean.trim()) onLine(clean, which); }
    };
    child.stdout.on('data', take('stdout'));
    child.stderr.on('data', take('stderr'));
    if (child.stdin) child.stdin.end();
    let stopped = null;
    const onAbort = () => { if (!stopped) { stopped = 'aborted'; killTree(child); } };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const timer = timeout ? setTimeout(() => { if (!stopped) { stopped = 'timeout'; killTree(child); } }, timeout) : null;
    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      fn();
    };
    child.on('error', (err) => finish(() => reject(err && err.code === 'ENOENT'
      ? new ReleaseError(GH_MISSING, { code: 'NO_GH' })
      : new ReleaseError(`Couldn't start GitHub CLI (${err && err.message}).`, { code: 'NO_GH' }))));
    child.on('close', (code) => {
      if (typeof onLine === 'function') {
        for (const which of ['stdout', 'stderr']) { const clean = pending[which].replace(ANSI, '').trimEnd(); if (clean.trim()) onLine(clean, which); }
      }
      finish(() => {
        if (stopped === 'aborted') reject(new ReleaseError('Cancelled.', { code: 'ABORTED' }));
        else if (stopped === 'timeout') reject(new ReleaseError('GitHub CLI took too long to answer. Check your internet connection and try again.', { code: 'TIMEOUT' }));
        else resolve({ code: code == null ? 1 : code, stdout: Buffer.concat(chunks.stdout).toString('utf8'), stderr: Buffer.concat(chunks.stderr).toString('utf8') });
      });
    });
  });
}

/** A failed gh run → a ReleaseError with a sentence people can act on. */
function ghFailure(res, what, repo = GITHUB_REPO) {
  const text = `${res.stderr || ''}\n${res.stdout || ''}`.replace(ANSI, '');
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const said = lines.slice(-3).join(' ').slice(0, 300);
  if (/not logged in|gh auth login|authentication required|HTTP 401|Bad credentials/i.test(text)) {
    return new ReleaseError(`${what} failed: ${GH_LOGIN}`, { code: 'NOT_LOGGED_IN' });
  }
  if (/HTTP 403|Resource not accessible|must have (?:push|write|admin) access|Permission to \S+ denied/i.test(text)) {
    return new ReleaseError(`${what} failed: your GitHub account can't publish to ${repo} (${said}). Sign in with an account that can push to it: gh auth login`, { status: 403, code: 'NO_PUSH' });
  }
  if (/already exists/i.test(text)) return new ReleaseError(`${what} failed: ${said}`, { code: 'EXISTS' });
  if (/error connecting to|dial tcp|no such host|i\/o timeout|TLS handshake|connection refused|could not resolve host/i.test(text)) {
    return new ReleaseError(`${what} failed: couldn't reach GitHub (${said}). Check your internet connection.`, { code: 'NETWORK' });
  }
  if (/HTTP 404|Not Found|Could not resolve to a Repository/i.test(text)) {
    return new ReleaseError(`${what} failed: GitHub couldn't find it (${said}).`, { status: 404, code: 'NOT_FOUND' });
  }
  return new ReleaseError(`${what} failed${said ? `: ${said}` : ` (gh exited with code ${res.code})`}`, { code: 'GH_FAILED' });
}

/**
 * Can this computer publish? Runs gh --version, gh auth status, and gh api repos/<repo> (push access
 * and whether the repo is private).
 * → { installed, version, loggedIn, account, push: true|false|null, private: true|false|null, problem, note }
 *   push null: couldn't be checked (offline, or a token that doesn't report permissions; CI's
 *   GITHUB_TOKEN is like that). problem: the first thing that stops publishing, as a sentence, or null.
 */
async function ghStatus({ gh, env, repo = GITHUB_REPO, timeout = 30000, checkRepo = true } = {}) {
  const out = { installed: false, version: null, loggedIn: false, account: null, push: null, private: null, problem: null, note: null };
  const run = (args) => runGh(args, { gh, env, timeout });
  let res;
  try {
    res = await run(['--version']);
  } catch (err) {
    out.problem = err.code === 'NO_GH' ? GH_MISSING : err.message;
    return out;
  }
  if (res.code !== 0) {
    out.problem = `GitHub CLI didn't start properly (${(res.stderr || res.stdout).trim().split(/\r?\n/)[0] || `exit code ${res.code}`}). Reinstall it from https://cli.github.com.`;
    return out;
  }
  out.installed = true;
  out.version = (/gh version (\S+)/.exec(res.stdout) || [])[1] || null;
  try {
    res = await run(['auth', 'status', '--hostname', 'github.com']);
  } catch (err) {
    out.problem = err.message;
    return out;
  }
  const said = `${res.stdout}\n${res.stderr}`;
  if (res.code !== 0) {
    out.problem = GH_LOGIN;
    return out;
  }
  out.loggedIn = true;
  out.account = (/Logged in to \S+ (?:account|as) ([^\s(]+)/i.exec(said) || [])[1] || null;
  if (!checkRepo) return out;
  try {
    res = await run(['api', `repos/${repo}`]);
  } catch (err) {
    out.note = `Couldn't check push access to ${repo}: ${err.message}`;
    return out;
  }
  if (res.code === 0) {
    try {
      const info = JSON.parse(res.stdout);
      // An Actions GITHUB_TOKEN (github-actions[bot]) reports push: false even with "contents: write",
      // so in CI push access stays unknown and the publish itself is the check.
      const ci = mergeEnv(process.env, env).GITHUB_ACTIONS === 'true' || /^github-actions(\[bot\])?$/i.test(out.account || '');
      if (!ci && info && info.permissions && typeof info.permissions.push === 'boolean') out.push = info.permissions.push;
      if (info && typeof info.private === 'boolean') out.private = info.private;
    } catch { out.note = `Couldn't read GitHub's answer about ${repo}.`; }
  } else if (/HTTP 404|Not Found/i.test(`${res.stderr}${res.stdout}`)) {
    out.push = false; // a private repo this account can't even see
  } else {
    out.note = ghFailure(res, `Checking push access to ${repo}`, repo).message;
  }
  if (out.push === false) {
    out.problem = `Your GitHub account${out.account ? ` (${out.account})` : ''} can't push to ${repo}. Sign in with an account that can: gh auth login`;
  }
  return out;
}

/** Is there a release with this tag? → { exists, draft, url } */
async function ghReleaseInfo(tag, { gh, env, repo = GITHUB_REPO, timeout = 60000 } = {}) {
  const res = await runGh(['release', 'view', tag, '--repo', repo, '--json', 'tagName,isDraft,url'], { gh, env, timeout });
  if (res.code === 0) {
    let info = {};
    try { info = JSON.parse(res.stdout) || {}; } catch { /* exists, details unreadable */ }
    return { exists: true, draft: Boolean(info.isDraft), url: info.url || null };
  }
  if (/release not found|HTTP 404|Not Found/i.test(`${res.stderr}${res.stdout}`)) return { exists: false, draft: false, url: null };
  throw ghFailure(res, `Looking up the release ${tag}`, repo);
}

/** The newest 30 releases, through gh (works while the repo is private). → [normalized] */
async function ghListReleases({ gh, env, repo = GITHUB_REPO, timeout = 60000 } = {}) {
  const res = await runGh(['api', `repos/${repo}/releases?per_page=30`], { gh, env, timeout });
  if (res.code !== 0) throw ghFailure(res, 'Reading the releases on GitHub', repo);
  let list;
  try { list = JSON.parse(res.stdout); } catch { list = null; }
  if (!Array.isArray(list)) throw new ReleaseError("GitHub CLI sent a release list Guild Camp can't read.", { code: 'BAD_ANSWER' });
  return list.map(normalizeRelease).filter(Boolean);
}

/**
 * What's on GitHub: through gh when it is installed and signed in, otherwise the public API.
 * → { app, addon, history, source: 'gh' | 'api' }
 */
async function getReleases({ gh, env, fetch: fetchImpl, repo = GITHUB_REPO, userAgent = 'GuildCamp-release', useGh = true } = {}) {
  if (useGh) {
    try {
      return { ...summarizeReleases(await ghListReleases({ gh, env, repo })), source: 'gh' };
    } catch (err) {
      if (err.code === 'ABORTED') throw err;
      // Not installed, not signed in or offline: the public list may still answer.
    }
  }
  const r = await fetchReleaseList({ fetch: fetchImpl, url: releasesApiUrl(repo), userAgent });
  return { ...summarizeReleases(r.releases), source: 'api' };
}

/**
 * gh release create. kind 'app' is marked Latest (electron-updater follows it); 'addon' never is.
 * verifyTag: the tag must already be on GitHub (after --git --push). target: the commit or branch a
 * new tag is made on (otherwise the default branch). → { tag, url }
 */
async function createGithubRelease({ kind, version: ver, files, notes = '', gh, env, repo = GITHUB_REPO, verifyTag = false, target, onLog, signal } = {}) {
  const log = logger(onLog);
  const tag = tagFor(kind, ver);
  const title = kind === 'app' ? `Guild Camp ${ver}` : `Guild Camp addon ${ver}`;
  const notesFile = path.join(os.tmpdir(), `guildcamp-notes-${process.pid}-${crypto.randomBytes(4).toString('hex')}.md`);
  fs.writeFileSync(notesFile, `${String(notes || '').replace(/\r\n?/g, '\n').trim()}\n`);
  const args = ['release', 'create', tag, ...files, '--repo', repo, '--title', title, '--notes-file', notesFile, kind === 'app' ? '--latest' : '--latest=false'];
  if (verifyTag) args.push('--verify-tag');
  else if (target) args.push('--target', String(target));
  let res;
  try {
    res = await runGh(args, { gh, env, signal, onLine: (l) => log(`  ${l}`) });
  } finally {
    try { fs.rmSync(notesFile, { force: true }); } catch { /* temp file */ }
  }
  if (res.code !== 0) throw ghFailure(res, `Creating the GitHub release ${tag}`, repo);
  const url = (res.stdout.match(/https:\/\/\S+/g) || []).pop() || `${releasesPage(repo)}/tag/${tag}`;
  return { tag, url };
}

/**
 * Publishes a built app (dist/ from electron-builder) as release v<version>, marked Latest, with the
 * installer, its .blockmap and latest.yml. Every file is checked against latest.yml first.
 * → { version, tag, url, files: [{ name, size, sha512 }] }
 */
async function publishApp({ distDir, notes = '', gh, env, repo = GITHUB_REPO, verifyTag, target, onLog, signal } = {}) {
  const log = logger(onLog);
  const build = readAppBuild(distDir);
  const checked = await checkAppBuild(build);
  const files = [...checked.map((c) => c.file), build.latestYmlFile];
  const total = checked.reduce((n, c) => n + c.size, 0);
  log(`Publishing Guild Camp ${build.version} to GitHub (${repo}) as ${tagFor('app', build.version)}`);
  log(`Uploading ${files.map((f) => path.basename(f)).join(', ')} (${formatBytes(total)}). This can take a few minutes.`);
  const { tag, url } = await createGithubRelease({ kind: 'app', version: build.version, files, notes, gh, env, repo, verifyTag, target, onLog: log, signal });
  log(`Guild Camp ${build.version} is live: ${url}`);
  log('Players get it the next time their app checks for updates.');
  return { version: build.version, tag, url, files: checked.map(({ name, size, sha512 }) => ({ name, size, sha512 })) };
}

/**
 * Publishes an addon zip made by packAddon as release addon-v<version> (never marked Latest), with
 * WowGuild-<v>.zip and its .sha256. outDir: where the two files are written (a temp folder, removed
 * afterwards, when not given). → { version, tag, url, sha256, zipFile, shaFile }
 */
async function publishAddon({ pack, notes = '', outDir, gh, env, repo = GITHUB_REPO, verifyTag, target, onLog, signal } = {}) {
  const log = logger(onLog);
  if (!pack || !Buffer.isBuffer(pack.zip)) throw new ReleaseError('Nothing to publish: pack the addon first.', { code: 'NO_PACK' });
  const dir = outDir || fs.mkdtempSync(path.join(os.tmpdir(), 'guildcamp-addon-'));
  try {
    const { zipFile, shaFile } = writeAddonAssets(pack, dir);
    log(`Publishing ${ADDON} ${pack.version} (${formatBytes(pack.zip.length)}) to GitHub (${repo}) as ${tagFor('addon', pack.version)}`);
    const { tag, url } = await createGithubRelease({ kind: 'addon', version: pack.version, files: [zipFile, shaFile], notes, gh, env, repo, verifyTag, target, onLog: log, signal });
    log(`Addon ${pack.version} is live: ${url}`);
    log('Players get it from the Guild Camp app.');
    return { version: pack.version, tag, url, sha256: pack.sha256, zipFile: outDir ? zipFile : null, shaFile: outDir ? shaFile : null };
  } finally {
    if (!outDir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp folder */ } }
  }
}

// ---------------------------------------------------------------------------------------------
// Changelog from git

const TAG_MATCH = { app: 'v[0-9]*', addon: 'addon-v[0-9]*' };

// Bullet list of commit subjects that touched the addon (kind 'addon') or the app (kind 'app')
// since the previous addon-v* / v* tag. The tag on `ref` itself is skipped, so this works both
// before tagging and in CI on the tag. Release commits made by --git are left out.
function gitChangelog(repoDir, kind, { ref = 'HEAD', max = 60 } = {}) {
  if (kind !== 'addon' && kind !== 'app') throw new ReleaseError(`gitChangelog: kind must be "addon" or "app", not "${kind}".`);
  const git = (...args) => execFileSync('git', args, { cwd: repoDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
  const paths = kind === 'addon' ? ['addon/WowGuild'] : ['app'];
  let prev = '';
  try { prev = git('describe', '--tags', '--abbrev=0', '--match', TAG_MATCH[kind], `${ref}^`); } catch { /* first release, or no git */ }
  let subjects = [];
  try {
    subjects = git('log', '--no-merges', '--format=%s', prev ? `${prev}..${ref}` : ref, '--', ...paths).split(/\r?\n/);
  } catch { /* not a git checkout */ }
  return changelogFrom(subjects, max);
}

/** Commit subjects → "- one\n- two", release commits and repeats left out. */
function changelogFrom(subjects, max = 60) {
  const seen = new Set();
  const lines = (subjects || []).map((s) => String(s).trim())
    .filter((s) => s && !/^Release (addon|app) v?\d/i.test(s))
    .filter((s) => (seen.has(s) ? false : seen.add(s)));
  if (!lines.length) return '- Maintenance release.';
  const shown = lines.slice(0, max).map((s) => `- ${s}`);
  if (lines.length > max) shown.push(`- …and ${lines.length - max} more changes.`);
  return shown.join('\n');
}

module.exports = {
  // building and versions
  packAddon,
  bumpAddonVersion,
  bumpAppVersion,
  buildApp,
  readAppBuild,
  checkAppBuild,
  parseLatestYml,
  readAddonVersion,
  readAppVersion,
  resolveAddonDir,
  nextVersion,
  gitChangelog,
  changelogFrom,
  formatBytes,
  // publishing with gh
  publishAddon,
  publishApp,
  createGithubRelease,
  getReleases,
  ghStatus,
  ghReleaseInfo,
  ghListReleases,
  runGh,
  findExecutable,
  mergeEnv,
  // the public release list
  fetchReleaseList,
  readReleaseFeed,
  normalizeRelease,
  newestRelease,
  summarizeReleases,
  // names and formats
  tagFor,
  parseTag,
  releasesApiUrl,
  releasesPage,
  addonAssetNames,
  sha256Text,
  parseSha256Text,
  writeAddonAssets,
  bnetCredentialsFrom,
  BNET_FILE,
  BNET_MISSING,
  GITHUB_REPO,
  GITHUB_API,
  TAG_MATCH,
  GH_MISSING,
  GH_LOGIN,
  FEED_MIN_INTERVAL,
  ReleaseError,
  APP_FILE_RE,
};
