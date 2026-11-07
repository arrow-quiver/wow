'use strict';
// The release pipeline: version bumps, packing the addon, building the app, and publishing both
// to the Guild Camp server. Used by scripts/release.js (CLI and CI) and by the app's Publisher
// (the owner's Releases page). Zero dependencies: Node built-ins and the other shared modules.
//
// Server endpoints (see docs/ARCHITECTURE.md "Release hosting"), all with
// "Authorization: Bearer <token>" (the server's PUBLISH_TOKEN or the owner's device token):
//   PUT  /api/publish/app/files/:name    raw file, X-Sha512 (base64) + Content-Length
//   POST /api/publish/app/commit         { version, notes, latestYml }  → makes the app release live
//   PUT  /api/publish/addon?notes=&force raw zip containing WowGuild/WowGuild.toc
//   GET  /api/releases                   public: what is published now
const fs = require('fs');
const path = require('path');
const { spawn, execFile, execFileSync } = require('child_process');
const { Readable } = require('stream');
const zip = require('./zip');
const toc = require('./toc');
const version = require('./version');
const hash = require('./hash');

const ADDON = 'WowGuild';
// Same rule as the server: plain file names with an installer / update extension.
const APP_FILE_RE = /^[\w.\- ]+\.(exe|blockmap|dmg|zip|AppImage)$/;
const MAX_NOTES_URL = 12000; // addon notes travel in the query string; keep well under header limits

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

function normalizeServer(server) {
  const s = String(server || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^/\s]+/i.test(s)) {
    throw new ReleaseError(`"${server || ''}" isn't a server address. Use something like https://wow.example.com.`, { code: 'BAD_SERVER' });
  }
  return s;
}

function requireToken(token) {
  if (!token || !String(token).trim()) throw new ReleaseError('A publish token is needed to publish.', { code: 'NO_TOKEN' });
  return String(token).trim();
}

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

// ---------------------------------------------------------------------------------------------
// App build

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

// Runs `npm run dist` in the app folder (electron-builder --win --publish never), streaming each
// output line to onLog. Resolves { distDir } on success; rejects when the build fails.
// Aborting `signal` stops the whole build. On Windows npm runs under cmd.exe, and killing cmd.exe
// alone would leave npm and electron-builder running, so the abort kills the process tree with
// taskkill /T /F. The signal isn't handed to spawn there: if Node killed cmd.exe first, the tree
// would already be orphaned before taskkill could walk it.
function buildApp(appDir, { onLog, signal, env } = {}) {
  const log = logger(onLog);
  const cwd = path.resolve(appDir);
  if (!fs.existsSync(path.join(cwd, 'package.json'))) {
    return Promise.reject(new ReleaseError(`There's no package.json in ${cwd}. Pick the app folder.`, { code: 'NO_PACKAGE' }));
  }
  if (signal && signal.aborted) return Promise.reject(new ReleaseError('The app build was cancelled.', { code: 'ABORTED' }));
  return new Promise((resolve, reject) => {
    log(`Building the app in ${cwd} (npm run dist). This takes a few minutes.`);
    let child;
    try {
      const options = { cwd, env: { ...process.env, ...env }, windowsHide: true };
      // npm is npm.cmd on Windows, which needs a shell. Pass the whole command as one string
      // there: Node warns about (and doesn't escape) separate arguments with shell: true.
      child = process.platform === 'win32'
        ? spawn('npm run dist', { ...options, shell: true })
        : spawn('npm', ['run', 'dist'], options);
    } catch (e) {
      reject(new ReleaseError(`Couldn't start npm (${e.message}). Install Node.js and make sure npm is on your PATH.`, { code: 'NO_NPM' }));
      return;
    }
    let aborted = false;
    const onAbort = () => {
      if (aborted) return;
      aborted = true;
      log('Stopping the build…');
      if (process.platform === 'win32' && child.pid) {
        execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
      } else {
        try { child.kill('SIGTERM'); } catch { /* already gone */ }
      }
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

// Reads what electron-builder left in dist/. → { version, files: [absolute paths], latestYml, info }
// files = every file latest.yml lists, plus its .blockmap when there is one (for small
// differential downloads).
function readAppBuild(distDir) {
  const dir = path.resolve(distDir);
  const ymlFile = path.join(dir, 'latest.yml');
  if (!fs.existsSync(ymlFile)) {
    // A build of a -beta.N version without `detectUpdateChannel: false` writes beta.yml instead.
    let other = [];
    try { other = fs.readdirSync(dir).filter((f) => /\.yml$/i.test(f) && !/^builder-(debug|effective-config)\.yml$/i.test(f)); } catch { /* no dist folder */ }
    if (other.length) {
      throw new ReleaseError(`There's no latest.yml in ${dir}, only ${other.join(', ')}. The server only reads latest.yml: keep `
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
    if (!APP_FILE_RE.test(name)) throw new ReleaseError(`latest.yml lists "${name}", which isn't an installer file the server accepts.`, { code: 'BAD_YML' });
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) {
      throw new ReleaseError(`latest.yml lists ${name}, but it isn't in ${dir}. Build the app again.`, { code: 'NO_BUILD' });
    }
    if (!files.includes(file)) files.push(file);
    if (fs.existsSync(`${file}.blockmap`) && !files.includes(`${file}.blockmap`)) files.push(`${file}.blockmap`);
  }
  return { version: info.version, files, latestYml, info };
}

// ---------------------------------------------------------------------------------------------
// HTTP

function pickFetch(fetchImpl) {
  const f = fetchImpl || globalThis.fetch;
  if (typeof f !== 'function') throw new ReleaseError('This Node.js has no fetch. Use Node.js 20 or newer.', { code: 'NO_FETCH' });
  return f;
}

async function send(fetchImpl, url, init, what) {
  let res;
  try {
    res = await fetchImpl(url, { redirect: 'manual', ...init });
  } catch (e) {
    if (e && e.name === 'AbortError') throw new ReleaseError(`${what} was cancelled.`, { code: 'ABORTED' });
    if (e instanceof ReleaseError) throw e;
    const cause = e && e.cause ? (e.cause.code || e.cause.message) : (e && e.message);
    throw new ReleaseError(`Couldn't reach ${new URL(url).origin} (${cause || 'network error'}). Check the server address and your internet connection.`, { code: 'NETWORK' });
  }
  if (res.status >= 300 && res.status < 400) {
    const where = res.headers.get('location');
    throw new ReleaseError(`The server redirected the request${where ? ` to ${where}` : ''}. Use the server's exact address (usually https://).`, { status: res.status, code: 'REDIRECT' });
  }
  const text = await res.text();
  let body = null;
  if (text) { try { body = JSON.parse(text); } catch { body = null; } }
  if (!res.ok) {
    const said = body && typeof body.error === 'string' ? body.error : text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
    let message;
    if (res.status === 401 || res.status === 403) message = `The server refused the request (${res.status}): ${(said || 'not allowed').replace(/[.\s]+$/, '')}. Check the publish token.`;
    else if (res.status === 413) message = `The server says the upload is too big (413).${said ? ` ${said}` : ''}`;
    else if (res.status === 404 && !body) message = `${what} failed: the server doesn't have this endpoint (404). Is the address right and the server up to date?`;
    else message = `${what} failed (${res.status}): ${said || res.statusText || 'no details'}`;
    throw new ReleaseError(message, { status: res.status, code: 'HTTP' });
  }
  if (text && body === null) {
    throw new ReleaseError(`${what}: the server sent something that isn't JSON. Is ${new URL(url).origin} a Guild Camp server?`, { status: res.status, code: 'NOT_JSON' });
  }
  return body || {};
}

// Streams one file with a running byte count. Progress lines every 10% for files over 1 MB.
async function uploadFile(fetchImpl, base, token, { file, name, size, sha512 }, log, signal) {
  let sent = 0; let nextPct = 10;
  const counted = new TransformStream({
    transform(chunk, controller) {
      sent += chunk.byteLength;
      if (size > 1024 * 1024) {
        const pct = Math.floor((sent / size) * 100);
        if (pct >= nextPct && pct < 100) { log(`  ${name}: ${pct}% (${formatBytes(sent)} of ${formatBytes(size)})`); nextPct = Math.floor(pct / 10) * 10 + 10; }
      }
      controller.enqueue(chunk);
    },
  });
  const body = Readable.toWeb(fs.createReadStream(file)).pipeThrough(counted);
  return send(fetchImpl, `${base}/api/publish/app/files/${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(size),
      'X-Sha512': sha512,
    },
    body,
    duplex: 'half',
    signal,
  }, `Uploading ${name}`);
}

// Uploads the built installer (+ blockmap) and then commits latest.yml, which makes the release
// live. Every file is checked against latest.yml before anything is sent.
// → { version, files: [{ name, size, sha512 }], result }
async function publishApp({ server, token, distDir, notes = '', onLog, fetch: fetchImpl, signal } = {}) {
  const log = logger(onLog);
  const base = normalizeServer(server);
  const auth = requireToken(token);
  const f = pickFetch(fetchImpl);
  const build = readAppBuild(distDir);
  log(`Publishing Guild Camp ${build.version} to ${base}`);

  const uploads = [];
  for (const file of build.files) {
    const name = path.basename(file);
    if (!APP_FILE_RE.test(name)) throw new ReleaseError(`"${name}" isn't a file name the server accepts.`, { code: 'BAD_FILE' });
    const size = fs.statSync(file).size;
    const sha512 = await hash.sha512File(file);
    const listed = (build.info.files || []).find((x) => x && fileNameFromUrl(x.url) === name);
    if (listed && listed.sha512 && listed.sha512 !== sha512) {
      throw new ReleaseError(`${name} doesn't match latest.yml (different checksum). Build the app again.`, { code: 'MISMATCH' });
    }
    if (listed && typeof listed.size === 'number' && listed.size !== size) {
      throw new ReleaseError(`${name} doesn't match latest.yml (different size). Build the app again.`, { code: 'MISMATCH' });
    }
    uploads.push({ file, name, size, sha512 });
  }

  for (const u of uploads) {
    log(`Uploading ${u.name} (${formatBytes(u.size)})`);
    await uploadFile(f, base, auth, u, log, signal);
    log(`  ${u.name}: done`);
  }

  log('Making the release live');
  const result = await send(f, `${base}/api/publish/app/commit`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ version: build.version, notes: String(notes || ''), latestYml: build.latestYml }),
    signal,
  }, 'Publishing the app');
  log(`Guild Camp ${build.version} is live. Players get it the next time the app checks for updates.`);
  return { version: build.version, files: uploads.map(({ name, size, sha512 }) => ({ name, size, sha512 })), result };
}

// Uploads an addon zip made by packAddon. force: true lets the server accept a version that
// isn't newer than the current one (for rolling back). → the server's JSON reply.
async function publishAddon({ server, token, pack, notes = '', force = false, onLog, fetch: fetchImpl, signal } = {}) {
  const log = logger(onLog);
  const base = normalizeServer(server);
  const auth = requireToken(token);
  const f = pickFetch(fetchImpl);
  if (!pack || !Buffer.isBuffer(pack.zip)) throw new ReleaseError('Nothing to publish: pack the addon first.', { code: 'NO_PACK' });
  const url = `${base}/api/publish/addon?notes=${encodeURIComponent(String(notes || ''))}&force=${force ? 1 : 0}`;
  if (url.length > MAX_NOTES_URL) {
    throw new ReleaseError('The release notes are too long to send. Keep them under about 4,000 characters.', { code: 'NOTES_TOO_LONG' });
  }
  log(`Uploading ${ADDON} ${pack.version} (${formatBytes(pack.zip.length)}) to ${base}${force ? ' (forced)' : ''}`);
  const result = await send(f, url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${auth}`,
      'Content-Type': 'application/zip',
      'Content-Length': String(pack.zip.length),
      'X-Sha256': pack.sha256 || hash.sha256(pack.zip),
    },
    body: pack.zip,
    signal,
  }, 'Publishing the addon');
  log(`Addon ${pack.version} is live. Players get it from the Guild Camp app.`);
  return result;
}

// Public: what the server has published. → { app, addon, history }
async function getReleases(server, { fetch: fetchImpl, signal } = {}) {
  const base = normalizeServer(server);
  return send(pickFetch(fetchImpl), `${base}/api/releases`, { method: 'GET', redirect: 'follow', signal }, 'Reading the published releases');
}

// ---------------------------------------------------------------------------------------------
// Changelog from git

// Bullet list of commit subjects that touched the addon (kind 'addon') or the app (kind 'app')
// since the previous addon-v* / app-v* tag. The tag on `ref` itself is skipped, so this works
// both before tagging and in CI on the tag. Release commits made by --git are left out.
function gitChangelog(repoDir, kind, { ref = 'HEAD', max = 60 } = {}) {
  if (kind !== 'addon' && kind !== 'app') throw new ReleaseError(`gitChangelog: kind must be "addon" or "app", not "${kind}".`);
  const git = (...args) => execFileSync('git', args, { cwd: repoDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
  const paths = kind === 'addon' ? ['addon/WowGuild'] : ['app'];
  let prev = '';
  try { prev = git('describe', '--tags', '--abbrev=0', '--match', `${kind}-v*`, `${ref}^`); } catch { /* first release, or no git */ }
  let subjects = [];
  try {
    subjects = git('log', '--no-merges', '--format=%s', prev ? `${prev}..${ref}` : ref, '--', ...paths).split(/\r?\n/);
  } catch { /* not a git checkout */ }
  const seen = new Set();
  const lines = subjects.map((s) => s.trim())
    .filter((s) => s && !/^Release (addon|app) v?\d/i.test(s))
    .filter((s) => (seen.has(s) ? false : seen.add(s)));
  if (!lines.length) return '- Maintenance release.';
  const shown = lines.slice(0, max).map((s) => `- ${s}`);
  if (lines.length > max) shown.push(`- …and ${lines.length - max} more changes.`);
  return shown.join('\n');
}

module.exports = {
  // contract (docs/ARCHITECTURE.md)
  packAddon,
  bumpAddonVersion,
  bumpAppVersion,
  buildApp,
  readAppBuild,
  publishAddon,
  publishApp,
  getReleases,
  // extras shared with the CLI, the app's Publisher and the server
  parseLatestYml,
  gitChangelog,
  readAddonVersion,
  readAppVersion,
  resolveAddonDir,
  nextVersion,
  normalizeServer,
  formatBytes,
  ReleaseError,
  APP_FILE_RE,
};
