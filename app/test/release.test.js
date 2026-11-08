// Release pipeline (app/src/shared/release.js), the release CLI (scripts/release.js) and the
// CurseForge helper (scripts/curseforge.js). Publishing runs against a fake GitHub CLI (a small Node
// script put first on PATH) and the release list against a fake GitHub API server; nothing here talks
// to GitHub.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const release = require('../src/shared/release');
const { readZip } = require('../src/shared/zip');
const version = require('../src/shared/version');
const cli = require('../../scripts/release');
const cf = require('../../scripts/curseforge');

const REPO = path.join(__dirname, '..', '..');

function tmpDir(t, label = 'gc-release-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), label));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
}

const sha512b64 = (buf) => crypto.createHash('sha512').update(buf).digest('base64');
const sha256hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// A dist/ folder like electron-builder leaves: installer, blockmap and latest.yml.
function fakeDist(dir, ver, { blockmap = true, exeBytes = 3 * 1024 * 1024 } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const exeName = `Guild-Camp-Setup-${ver}.exe`;
  const exe = crypto.randomBytes(exeBytes);
  fs.writeFileSync(path.join(dir, exeName), exe);
  const bm = crypto.randomBytes(900);
  if (blockmap) fs.writeFileSync(path.join(dir, `${exeName}.blockmap`), bm);
  const yml = [
    `version: ${ver}`,
    'files:',
    `  - url: ${exeName}`,
    `    sha512: ${sha512b64(exe)}`,
    `    size: ${exe.length}`,
    blockmap ? `    blockMapSize: ${bm.length}` : null,
    `path: ${exeName}`,
    `sha512: ${sha512b64(exe)}`,
    "releaseDate: '2026-11-07T10:00:00.000Z'",
    '',
  ].filter((l) => l !== null).join('\n');
  fs.writeFileSync(path.join(dir, 'latest.yml'), yml);
  return { exeName, exe, yml };
}

// A tiny addon folder.
function fakeAddon(dir, ver = '1.0.0') {
  const addon = path.join(dir, 'WowGuild');
  fs.mkdirSync(path.join(addon, 'Media'), { recursive: true });
  fs.mkdirSync(path.join(addon, 'Data'), { recursive: true });
  fs.mkdirSync(path.join(addon, '.git'), { recursive: true });
  fs.writeFileSync(path.join(addon, 'WowGuild.toc'), `## Interface: 16001, 120105\r\n## Title: Guild Camp\r\n## Version: ${ver}\r\n\r\nCore.lua\r\n`);
  fs.writeFileSync(path.join(addon, 'Core.lua'), 'WowGuild = {}\n');
  fs.writeFileSync(path.join(addon, 'Media', 'icon.tga'), crypto.randomBytes(512));
  fs.writeFileSync(path.join(addon, 'Data', 'Inbox.lua'), 'WowGuildInbox = {}');
  fs.writeFileSync(path.join(addon, '.git', 'HEAD'), 'ref: x');
  fs.writeFileSync(path.join(addon, '.pkgmeta'), 'x');
  fs.writeFileSync(path.join(addon, 'Thumbs.db'), 'x');
  return addon;
}

let gitOk = null;
function hasGit() {
  if (gitOk === null) { try { execFileSync('git', ['--version'], { stdio: 'ignore' }); gitOk = true; } catch { gitOk = false; } }
  return gitOk;
}
function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function gitInit(dir) {
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Release Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'config', 'tag.gpgSign', 'false');
  git(dir, 'config', 'core.autocrlf', 'false');
}
function commitAll(dir, msg) { git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', msg); }

// A whole repo checkout: addon/WowGuild, app/ (with a "dist" script that fakes electron-builder). The fake build
// also copies app/src/main/bnet-credentials.json to dist/bnet-seen.json when it exists, so tests can see what a
// build got.
const MAKE_DIST = `
const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const v = require('./package.json').version;
const dir = path.join(__dirname, 'dist'); fs.mkdirSync(dir, { recursive: true });
const name = 'Guild-Camp-Setup-' + v + '.exe';
const exe = Buffer.from('installer ' + v + ' '.repeat(2000));
fs.writeFileSync(path.join(dir, name), exe);
fs.writeFileSync(path.join(dir, name + '.blockmap'), 'blockmap ' + v);
const sha = crypto.createHash('sha512').update(exe).digest('base64');
fs.writeFileSync(path.join(dir, 'latest.yml'), 'version: ' + v + '\\nfiles:\\n  - url: ' + name + '\\n    sha512: ' + sha + '\\n    size: ' + exe.length + '\\npath: ' + name + '\\nsha512: ' + sha + "\\nreleaseDate: '2026-11-07T10:00:00.000Z'\\n");
const cred = path.join(__dirname, 'src', 'main', 'bnet-credentials.json');
const seen = path.join(dir, 'bnet-seen.json');
if (fs.existsSync(cred)) fs.copyFileSync(cred, seen); else if (fs.existsSync(seen)) fs.unlinkSync(seen);
console.log('  • building        target=nsis file=dist/' + name);
`;
function fakeRepo(t, { addonVersion = '1.0.0', appVersion = '1.0.0', git: withGit = false } = {}) {
  const root = tmpDir(t, 'gc-repo-');
  fakeAddon(path.join(root, 'addon'), addonVersion);
  fs.rmSync(path.join(root, 'addon', 'WowGuild', '.git'), { recursive: true, force: true });
  const app = path.join(root, 'app');
  fs.mkdirSync(path.join(app, 'src', 'main'), { recursive: true });
  fs.writeFileSync(path.join(app, 'package.json'), `{\n  "name": "guild-camp",\n  "version": "${appVersion}",\n  "private": true,\n  "scripts": {\n    "dist": "node make-dist.js"\n  }\n}\n`);
  fs.writeFileSync(path.join(app, 'make-dist.js'), MAKE_DIST);
  fs.writeFileSync(path.join(app, 'src', 'main', 'main.js'), '// app\n');
  fs.writeFileSync(path.join(root, '.gitignore'), 'dist/\napp/src/main/bnet-credentials.json\n');
  if (withGit) { gitInit(root); commitAll(root, 'Initial commit'); }
  return root;
}

// A bare repository as "origin", for --push.
function addRemote(t, root) {
  const remote = tmpDir(t, 'gc-remote-');
  git(remote, 'init', '-q', '--bare');
  git(root, 'remote', 'add', 'origin', remote);
  return remote;
}

// fetch stand-ins for the public GitHub API (the CLI and getReleases fall back to it when gh can't answer).
function apiFetch(list, calls = []) {
  return async (url, init = {}) => {
    calls.push({ url, headers: init.headers || {} });
    return new Response(JSON.stringify(list), { status: 200, headers: { 'Content-Type': 'application/json', ETag: '"list"' } });
  };
}
async function offlineFetch() {
  throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
}

// A local stand-in for GET https://api.github.com/repos/arrow-quiver/wow/releases?per_page=30, with ETags.
async function fakeApi(t, { releases = [], etag = '"v1"' } = {}) {
  const state = { releases, etag, requests: [], status: 200, headers: {}, body: null };
  const srv = http.createServer((req, res) => {
    state.requests.push({ url: req.url, headers: req.headers });
    if (state.status !== 200) {
      res.writeHead(state.status, { 'Content-Type': 'application/json', ...state.headers });
      res.end(state.body || JSON.stringify({ message: 'Not Found' }));
      return;
    }
    if (req.url === '/repos/arrow-quiver/wow/releases?per_page=30') {
      if (state.etag && req.headers['if-none-match'] === state.etag) { res.writeHead(304, { ETag: state.etag }); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/json', ...(state.etag ? { ETag: state.etag } : {}) });
      res.end(JSON.stringify(state.releases));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{"message":"Not Found"}');
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => srv.close(resolve)));
  state.url = `http://127.0.0.1:${srv.address().port}/repos/arrow-quiver/wow/releases?per_page=30`;
  state.listCalls = () => state.requests.length;
  return state;
}

// ---------------------------------------------------------------------------------------------
// A fake GitHub CLI: a small Node script on PATH (gh.cmd on Windows, gh elsewhere) that answers the gh
// commands Guild Camp runs from a state.json next to it, records every call, and keeps the files a
// "release create" uploads. Never talks to GitHub.

const FAKE_GH = String.raw`'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const STATE = path.join(__dirname, 'state.json');

function main(args) {
  const st = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  st.calls.push(args);
  const save = () => fs.writeFileSync(STATE, JSON.stringify(st, null, 2));
  const ok = (text) => { save(); if (text !== undefined) process.stdout.write(text + '\n'); return 0; };
  const fail = (text) => { save(); process.stderr.write(text + '\n'); return 1; };
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  if (args[0] === '--version') return ok('gh version 2.99.0 (2026-01-01)\nhttps://github.com/cli/cli/releases/tag/v2.99.0');
  if (args[0] === 'auth' && args[1] === 'status') {
    if (!st.authed) return fail('You are not logged into any GitHub hosts. To log in, run: gh auth login');
    return ok('github.com\n  ✓ Logged in to github.com account ' + st.account + ' (keyring)\n  - Active account: true');
  }
  if (st.offline) return fail('error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com');
  if (args[0] === 'api') {
    if (!st.authed) return fail('gh: Requires authentication (HTTP 401)');
    if (args[1] === 'repos/' + st.repo) {
      if (st.repoMissing) return fail('gh: Not Found (HTTP 404)');
      const body = { full_name: st.repo, private: st.private };
      if (st.push !== null) body.permissions = { admin: false, push: st.push, pull: true };
      return ok(JSON.stringify(body));
    }
    if (args[1] === 'repos/' + st.repo + '/releases?per_page=30') return ok(JSON.stringify(st.releases));
    return fail('gh: Not Found (HTTP 404)');
  }
  if (args[0] === 'release' && args[1] === 'view') {
    const r = st.releases.find((x) => x.tag_name === args[2]);
    if (!r) return fail('release not found');
    return ok(JSON.stringify({ tagName: r.tag_name, isDraft: Boolean(r.draft), url: r.html_url }));
  }
  if (args[0] === 'release' && args[1] === 'create') {
    if (!st.authed) return fail('To get started with GitHub CLI, please run:  gh auth login');
    if (st.failCreate) return fail(st.failCreate);
    const tag = args[2];
    const files = [];
    let i = 3;
    while (i < args.length && !args[i].startsWith('--')) files.push(args[i++]);
    if (st.releases.some((x) => x.tag_name === tag && !x.draft)) return fail('HTTP 422: Validation Failed (https://api.github.com/repos/' + st.repo + '/releases)\nRelease.tag_name already exists');
    if (args.includes('--verify-tag')) {
      let found = false;
      try { execFileSync('git', ['--git-dir', st.remoteDir, 'rev-parse', '-q', '--verify', 'refs/tags/' + tag], { stdio: 'ignore' }); found = true; } catch { found = false; }
      if (!found) return fail('tag ' + tag + ' doesn\'t exist in the repo ' + st.repo + ', aborting due to --verify-tag flag');
    }
    const dir = path.join(__dirname, 'uploads', tag);
    fs.mkdirSync(dir, { recursive: true });
    const assets = files.map((f) => {
      const data = fs.readFileSync(f);
      fs.writeFileSync(path.join(dir, path.basename(f)), data);
      return { name: path.basename(f), size: data.length, browser_download_url: 'https://github.com/' + st.repo + '/releases/download/' + tag + '/' + path.basename(f) };
    });
    const rel = {
      tag_name: tag, name: opt('--title'), body: fs.readFileSync(opt('--notes-file'), 'utf8'), draft: false, prerelease: false,
      published_at: new Date().toISOString(), html_url: 'https://github.com/' + st.repo + '/releases/tag/' + tag, assets,
      latest: args.includes('--latest') ? true : args.includes('--latest=false') ? false : null,
      target: opt('--target') || null, verifyTag: args.includes('--verify-tag'), repo: opt('--repo'),
    };
    st.releases.unshift(rel);
    process.stderr.write('Uploading ' + files.length + ' files\n');
    return ok(rel.html_url);
  }
  return fail('unknown command: ' + args.join(' '));
}

process.exitCode = main(process.argv.slice(2));
`;

const ENV_PATH = process.env.PATH || process.env.Path || '';

// → { dir, env, state(), set(patch), calls(), creates(), uploads(tag) }. env puts the fake first on PATH.
function makeFakeGh(t, state = {}) {
  const dir = tmpDir(t, 'gc-fakegh-');
  fs.writeFileSync(path.join(dir, 'gh.js'), FAKE_GH);
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(dir, 'gh.cmd'), `@"${process.execPath}" "%~dp0gh.js" %*\r\n`);
  } else {
    fs.writeFileSync(path.join(dir, 'gh'), `#!${process.execPath}\nrequire(${JSON.stringify(path.join(dir, 'gh.js'))});\n`);
    fs.chmodSync(path.join(dir, 'gh'), 0o755);
  }
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, JSON.stringify({
    authed: true, account: 'octo-owner', push: true, private: false, repo: 'arrow-quiver/wow', releases: [], calls: [],
    failCreate: null, offline: false, repoMissing: false, remoteDir: null, ...state,
  }));
  const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  return {
    dir,
    env: { PATH: `${dir}${path.delimiter}${ENV_PATH}` },
    state: read,
    set: (patch) => fs.writeFileSync(file, JSON.stringify({ ...read(), ...patch })),
    calls: () => read().calls,
    creates: () => read().calls.filter((c) => c[0] === 'release' && c[1] === 'create'),
    release: (tag) => read().releases.find((r) => r.tag_name === tag) || null,
    uploads: (tag) => path.join(dir, 'uploads', tag),
  };
}

// No gh anywhere: PATH and the folders gh's installers use point at an empty folder.
function noGhEnv(t) {
  const empty = tmpDir(t, 'gc-nogh-');
  return { PATH: empty, ProgramFiles: empty, LOCALAPPDATA: empty };
}

// A release as the GitHub API lists it.
function ghRelease(kind, v, { publishedAt = '2026-11-01T10:00:00Z', notes = '', assets } = {}) {
  const tag = kind === 'app' ? `v${v}` : `addon-v${v}`;
  const names = assets || (kind === 'app' ? [`Guild-Camp-Setup-${v}.exe`, `Guild-Camp-Setup-${v}.exe.blockmap`, 'latest.yml'] : [`WowGuild-${v}.zip`, `WowGuild-${v}.zip.sha256`]);
  return {
    tag_name: tag, name: kind === 'app' ? `Guild Camp ${v}` : `Guild Camp addon ${v}`, body: notes, draft: false, prerelease: false,
    published_at: publishedAt, html_url: `https://github.com/arrow-quiver/wow/releases/tag/${tag}`,
    assets: names.map((n) => ({ name: n, size: 100, browser_download_url: `https://github.com/arrow-quiver/wow/releases/download/${tag}/${n}` })),
  };
}

// ---------------------------------------------------------------------------------------------
// Versions in files

test('bumpAddonVersion edits only the Version line of WowGuild.toc', (t) => {
  const dir = tmpDir(t);
  const addon = fakeAddon(dir, '0.11.0');
  const before = fs.readFileSync(path.join(addon, 'WowGuild.toc'), 'utf8');
  assert.strictEqual(release.bumpAddonVersion(addon, 'patch'), '0.11.1');
  assert.strictEqual(fs.readFileSync(path.join(addon, 'WowGuild.toc'), 'utf8'), before.replace('0.11.0', '0.11.1'));
  assert.strictEqual(release.bumpAddonVersion(dir, 'minor'), '0.12.0', 'the parent folder works too');
  assert.strictEqual(release.bumpAddonVersion(addon, '2.0.0-beta.1'), '2.0.0-beta.1');
  assert.strictEqual(release.bumpAddonVersion(addon, 'beta'), '2.0.0-beta.2');
  assert.strictEqual(release.readAddonVersion(addon), '2.0.0-beta.2');
  assert.throws(() => release.bumpAddonVersion(addon, 'sideways'), (e) => e.code === 'BAD_VERSION');
  assert.throws(() => release.bumpAddonVersion(path.join(dir, 'nowhere'), 'patch'), (e) => e.code === 'NO_TOC');
  fs.writeFileSync(path.join(addon, 'WowGuild.toc'), '## Title: x\n## Version: dev\n');
  assert.throws(() => release.bumpAddonVersion(addon, 'patch'), /isn't valid, so it can't be bumped/);
  assert.strictEqual(release.bumpAddonVersion(addon, '1.0.0'), '1.0.0', 'an exact version fixes it');
});

test('bumpAppVersion keeps package.json formatting and updates the lockfile like npm', (t) => {
  const dir = tmpDir(t);
  const pkg = '{\n  "name": "guild-camp",\n  "productName": "Guild Camp",\n  "version": "0.11.0",\n  "dependencies": {\n    "x": { "version": "9.9.9" }\n  },\n  "unicode": "Zul\\u00e9 ✓"\n}\n';
  const lock = '{\n  "name": "guild-camp",\n  "version": "0.11.0",\n  "lockfileVersion": 3,\n  "packages": {\n    "": {\n      "name": "guild-camp",\n      "version": "0.11.0"\n    },\n    "node_modules/foo": {\n      "version": "0.11.0"\n    }\n  }\n}\n';
  fs.writeFileSync(path.join(dir, 'package.json'), pkg);
  fs.writeFileSync(path.join(dir, 'package-lock.json'), lock);
  assert.strictEqual(release.bumpAppVersion(dir, 'minor'), '0.12.0');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'), pkg.replace('"version": "0.11.0"', '"version": "0.12.0"'));
  const newLock = fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8');
  assert.strictEqual(newLock, lock.replace('"version": "0.11.0",\n  "lockfileVersion"', '"version": "0.12.0",\n  "lockfileVersion"')
    .replace('"name": "guild-camp",\n      "version": "0.11.0"', '"name": "guild-camp",\n      "version": "0.12.0"'));
  assert.strictEqual(JSON.parse(newLock).packages['node_modules/foo'].version, '0.11.0', 'dependencies untouched');
  assert.strictEqual(release.bumpAppVersion(dir, '1.0.0'), '1.0.0');
  assert.strictEqual(release.readAppVersion(dir), '1.0.0');
  assert.throws(() => release.bumpAppVersion(path.join(dir, 'none'), 'patch'), (e) => e.code === 'NO_PACKAGE');
});

// ---------------------------------------------------------------------------------------------
// Addon packing

test('packAddon zips one WowGuild/ folder without dotfiles, junk or the old inbox', (t) => {
  const dir = tmpDir(t);
  const addon = fakeAddon(dir, '1.4.2');
  const pack = release.packAddon(addon);
  assert.strictEqual(pack.version, '1.4.2');
  assert.strictEqual(pack.fileName, 'WowGuild-1.4.2.zip');
  assert.strictEqual(pack.size, pack.zip.length);
  assert.strictEqual(pack.sha256, crypto.createHash('sha256').update(pack.zip).digest('hex'));
  const names = readZip(pack.zip).map((e) => e.name);
  assert.deepStrictEqual(names, ['WowGuild/Core.lua', 'WowGuild/Data/', 'WowGuild/Media/icon.tga', 'WowGuild/WowGuild.toc']);
  assert.deepStrictEqual(pack.files, ['WowGuild/Core.lua', 'WowGuild/Media/icon.tga', 'WowGuild/WowGuild.toc']);
  assert.strictEqual(pack.toc.Title, 'Guild Camp');
  fs.writeFileSync(path.join(addon, 'WowGuild.toc'), '## Title: x\n');
  assert.throws(() => release.packAddon(addon), /needs a "## Version:" line/);
});

test('the real addon packs cleanly', () => {
  const pack = release.packAddon(path.join(REPO, 'addon', 'WowGuild'));
  const names = readZip(pack.zip).map((e) => e.name);
  assert.ok(names.includes('WowGuild/WowGuild.toc'));
  assert.ok(names.every((n) => n.startsWith('WowGuild/')), 'one WowGuild folder at the top');
  assert.ok(!names.some((n) => /Inbox/i.test(n)), 'the news file lives in WowGuild_Inbox, outside the package');
  assert.ok(version.valid(pack.version));
});

// ---------------------------------------------------------------------------------------------
// latest.yml and dist/

test('parseLatestYml reads what electron-builder writes', () => {
  const yml = [
    'version: 0.11.1',
    'files:',
    '  - url: Guild-Camp-Setup-0.11.1.exe',
    '    sha512: AbC+/x==',
    '    size: 85123456',
    '    blockMapSize: 90123',
    '    isAdminRightsRequired: false',
    'path: Guild-Camp-Setup-0.11.1.exe',
    'sha512: AbC+/x==',
    "releaseDate: '2026-11-07T10:00:00.000Z'",
    'releaseNotes: |-',
    '  Line one',
    '',
    '  Line "two" # not a comment',
    'stagingPercentage: 50 # a comment',
    '',
  ].join('\r\n');
  assert.deepStrictEqual(release.parseLatestYml(yml), {
    version: '0.11.1',
    files: [{ url: 'Guild-Camp-Setup-0.11.1.exe', sha512: 'AbC+/x==', size: 85123456, blockMapSize: 90123, isAdminRightsRequired: false }],
    path: 'Guild-Camp-Setup-0.11.1.exe',
    sha512: 'AbC+/x==',
    releaseDate: '2026-11-07T10:00:00.000Z',
    releaseNotes: 'Line one\n\nLine "two" # not a comment',
    stagingPercentage: 50,
  });
  // Lists at the same indent as their key, quoted keys and values, a nested map, folded text.
  const odd = release.parseLatestYml('version: "1.0.0"\nfiles:\n- url: "a b.exe"\n  size: 12\n- url: \'it\'\'s.exe\'\n"quoted key": yes\nmeta:\n  a: 1\n  b: two\nnotes: >\n  folded\n  text\n');
  assert.deepStrictEqual(odd, { version: '1.0.0', files: [{ url: 'a b.exe', size: 12 }, { url: "it's.exe" }], 'quoted key': 'yes', meta: { a: 1, b: 'two' }, notes: 'folded text\n' });
  assert.strictEqual(release.parseLatestYml('version: 1\n').version, '1', 'version always stays a string');
  assert.throws(() => release.parseLatestYml('  indented: wrong\n'), (e) => e.code === 'BAD_YML');
  assert.throws(() => release.parseLatestYml('just words\n'), /key: value/);
});

test('readAppBuild lists the installer and its blockmap, and spots a broken build', (t) => {
  const dir = tmpDir(t);
  const { exeName, yml } = fakeDist(dir, '0.11.1');
  fs.writeFileSync(path.join(dir, 'builder-debug.yml'), 'x');
  const build = release.readAppBuild(dir);
  assert.strictEqual(build.version, '0.11.1');
  assert.deepStrictEqual(build.files, [path.join(dir, exeName), path.join(dir, `${exeName}.blockmap`)]);
  assert.strictEqual(build.latestYml, yml);
  assert.strictEqual(build.info.files[0].size, 3 * 1024 * 1024);

  const noBm = tmpDir(t);
  fakeDist(noBm, '0.11.2', { blockmap: false });
  assert.strictEqual(release.readAppBuild(noBm).files.length, 1);

  fs.unlinkSync(path.join(dir, exeName));
  assert.throws(() => release.readAppBuild(dir), (e) => e.code === 'NO_BUILD' && /isn't in/.test(e.message));
  assert.throws(() => release.readAppBuild(path.join(dir, 'nope')), (e) => e.code === 'NO_BUILD' && /Build the app first/.test(e.message));
  fs.writeFileSync(path.join(noBm, 'latest.yml'), 'version: 1.0.0\nfiles:\n  - url: ../../evil.exe\n');
  assert.throws(() => release.readAppBuild(noBm), /isn't in/, 'only the last part of a url is used');
  fs.writeFileSync(path.join(noBm, 'latest.yml'), 'version: 1.0.0\nfiles:\n  - url: setup.msi\n');
  assert.throws(() => release.readAppBuild(noBm), /isn't an installer file/);

  // A beta build that wrote beta.yml (channel detection on) says what went wrong.
  const beta = tmpDir(t);
  fakeDist(beta, '0.12.0-beta.1');
  fs.renameSync(path.join(beta, 'latest.yml'), path.join(beta, 'beta.yml'));
  fs.writeFileSync(path.join(beta, 'builder-debug.yml'), 'x');
  assert.throws(() => release.readAppBuild(beta), (e) => e.code === 'NO_BUILD' && /only beta\.yml\./.test(e.message) && /detectUpdateChannel: false/.test(e.message));
  // Only electron-builder's own debug files: the plain "build first" message.
  fs.unlinkSync(path.join(beta, 'beta.yml'));
  assert.throws(() => release.readAppBuild(beta), (e) => e.code === 'NO_BUILD' && /Build the app first/.test(e.message));
});

test('electron-builder writes latest.yml for every version, beta ones too', () => {
  const yml = fs.readFileSync(path.join(REPO, 'app', 'electron-builder.yml'), 'utf8');
  assert.match(yml, /^detectUpdateChannel: false\s*$/m);
});

test('electron-builder publishes to GitHub releases, and the Battle.net file is never committed', () => {
  const yml = fs.readFileSync(path.join(REPO, 'app', 'electron-builder.yml'), 'utf8');
  assert.match(yml, /^publish:\s*\n\s+- provider: github\s*\n\s+owner: arrow-quiver\s*\n\s+repo: wow\s*\n\s+releaseType: release\s*$/m);
  assert.doesNotMatch(yml, /provider: generic/);
  assert.match(yml, /^\s+artifactName: "Guild-Camp-Setup-\$\{version\}\.\$\{ext\}"\s*$/m, 'the installer name is unchanged');
  const ignore = fs.readFileSync(path.join(REPO, '.gitignore'), 'utf8').split(/\r?\n/);
  assert.ok(ignore.includes('app/src/main/bnet-credentials.json'));
  assert.ok(ignore.includes('.release.json'));
  assert.strictEqual(release.BNET_FILE, path.join('src', 'main', 'bnet-credentials.json'));
});

test('the release workflow publishes with gh on v* and addon-v* tags', () => {
  const yml = fs.readFileSync(path.join(REPO, '.github', 'workflows', 'release.yml'), 'utf8');
  assert.match(yml, /tags: \['v\*', 'addon-v\*'\]/);
  assert.match(yml, /permissions:\s*\n\s+contents: write/);
  assert.match(yml, /GH_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
  assert.match(yml, /GUILDCAMP_BNET_CLIENT_ID: \$\{\{ secrets\.GUILDCAMP_BNET_CLIENT_ID \}\}/);
  assert.match(yml, /GUILDCAMP_BNET_CLIENT_SECRET: \$\{\{ secrets\.GUILDCAMP_BNET_CLIENT_SECRET \}\}/);
  assert.match(yml, /"\$GITHUB_REF_NAME" != "v\$v"/, 'the app tag must match app/package.json');
  assert.match(yml, /"\$GITHUB_REF_NAME" != "addon-v\$v"/, 'the addon tag must match WowGuild.toc');
  assert.match(yml, /runs-on: windows-latest/);
  assert.match(yml, /runs-on: ubuntu-latest/);
  assert.doesNotMatch(yml, /PUBLISH_TOKEN|GUILDCAMP_SERVER/);
});

// ---------------------------------------------------------------------------------------------
// Tags, the release list and checksum files

test('tags: v<version> for the app, addon-v<version> for the addon', () => {
  assert.strictEqual(release.tagFor('app', '1.2.3'), 'v1.2.3');
  assert.strictEqual(release.tagFor('addon', '1.2.3-beta.1'), 'addon-v1.2.3-beta.1');
  assert.throws(() => release.tagFor('server', '1.0.0'), /Unknown release kind/);
  assert.deepStrictEqual(release.parseTag('v0.12.0'), { kind: 'app', version: '0.12.0' });
  assert.deepStrictEqual(release.parseTag('addon-v0.12.0'), { kind: 'addon', version: '0.12.0' });
  assert.strictEqual(release.parseTag('app-v0.12.0'), null, 'the old app tag is not an app release');
  assert.strictEqual(release.parseTag('addon-vlatest'), null);
  assert.strictEqual(release.parseTag('versions/0.11.0'), null);
  assert.strictEqual(release.parseTag(null), null);
  assert.strictEqual(release.releasesApiUrl(), 'https://api.github.com/repos/arrow-quiver/wow/releases?per_page=30');
  assert.strictEqual(release.releasesPage(), 'https://github.com/arrow-quiver/wow/releases');
});

test('summarizeReleases: newest app and addon by version, drafts and prereleases left out, history newest first', () => {
  const list = [
    ghRelease('addon', '0.12.0', { publishedAt: '2026-11-05T10:00:00Z', notes: 'Addon notes\r\n- one' }),
    ghRelease('app', '0.12.0', { publishedAt: '2026-11-06T10:00:00Z' }),
    { ...ghRelease('app', '0.13.0', { publishedAt: '2026-11-07T10:00:00Z' }), draft: true },
    { ...ghRelease('addon', '0.13.0-beta.1', { publishedAt: '2026-11-07T11:00:00Z' }), prerelease: true },
    ghRelease('addon', '0.11.5', { publishedAt: '2026-11-08T10:00:00Z' }), // published later, but older
    { tag_name: 'nightly', name: 'x', assets: [] },
  ];
  const sum = release.summarizeReleases(list);
  assert.strictEqual(sum.app.version, '0.12.0');
  assert.strictEqual(sum.app.tag, 'v0.12.0');
  assert.strictEqual(sum.addon.version, '0.12.0');
  assert.strictEqual(sum.addon.notes, 'Addon notes\n- one');
  assert.strictEqual(sum.addon.url, 'https://github.com/arrow-quiver/wow/releases/tag/addon-v0.12.0');
  assert.deepStrictEqual(sum.addon.assets.map((a) => a.name), ['WowGuild-0.12.0.zip', 'WowGuild-0.12.0.zip.sha256']);
  assert.deepStrictEqual(sum.history.map((r) => r.tag), ['addon-v0.11.5', 'addon-v0.13.0-beta.1', 'v0.12.0', 'addon-v0.12.0']);
  // gh's camelCase JSON and already-normalized releases read the same.
  const camel = release.normalizeRelease({ tagName: 'v1.0.0', isDraft: false, isPrerelease: true, publishedAt: 'p', url: 'u' });
  assert.deepStrictEqual([camel.kind, camel.version, camel.prerelease, camel.publishedAt, camel.url], ['app', '1.0.0', true, 'p', 'u']);
  assert.deepStrictEqual(release.normalizeRelease(sum.addon), sum.addon);
  assert.deepStrictEqual(release.summarizeReleases(null), { app: null, addon: null, history: [] });
});

test('the .sha256 file next to the addon zip', (t) => {
  const pack = release.packAddon(fakeAddon(tmpDir(t), '1.4.2'));
  assert.strictEqual(release.sha256Text(pack), `${pack.sha256}  WowGuild-1.4.2.zip\n`);
  assert.deepStrictEqual(release.addonAssetNames('1.4.2'), { zip: 'WowGuild-1.4.2.zip', sha: 'WowGuild-1.4.2.zip.sha256' });
  const out = tmpDir(t);
  const files = release.writeAddonAssets(pack, out);
  assert.ok(fs.readFileSync(files.zipFile).equals(pack.zip));
  assert.strictEqual(release.parseSha256Text(fs.readFileSync(files.shaFile, 'utf8'), 'WowGuild-1.4.2.zip'), sha256hex(pack.zip));
  const a = 'a'.repeat(64); const b = 'B'.repeat(64);
  assert.strictEqual(release.parseSha256Text(`${a}\n`), a, 'just the hex');
  assert.strictEqual(release.parseSha256Text(`${a}  other.zip\n${b} *WowGuild-1.0.0.zip\n`, 'WowGuild-1.0.0.zip'), b.toLowerCase(), 'the line naming the zip wins');
  assert.strictEqual(release.parseSha256Text('not a checksum'), null);
  assert.strictEqual(release.parseSha256Text(''), null);
  assert.throws(() => release.writeAddonAssets(null, out), (e) => e.code === 'NO_PACK');
});

test('fetchReleaseList: headers, ETag, and plain errors', async (t) => {
  const api = await fakeApi(t, { releases: [ghRelease('app', '0.12.0'), ghRelease('addon', '0.12.0')] });
  const first = await release.fetchReleaseList({ url: api.url, userAgent: 'GuildCamp/0.11.0' });
  assert.strictEqual(first.notModified, false);
  assert.strictEqual(first.etag, '"v1"');
  assert.deepStrictEqual(first.releases.map((r) => r.tag), ['v0.12.0', 'addon-v0.12.0']);
  const h = api.requests[0].headers;
  assert.strictEqual(h.accept, 'application/vnd.github+json');
  assert.strictEqual(h['user-agent'], 'GuildCamp/0.11.0');
  assert.strictEqual(h['if-none-match'], undefined);
  assert.deepStrictEqual(await release.fetchReleaseList({ url: api.url, etag: '"v1"' }), { notModified: true, etag: '"v1"' });
  assert.strictEqual(api.requests[1].headers['if-none-match'], '"v1"');

  api.status = 403;
  api.headers = { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1999999999' };
  await assert.rejects(release.fetchReleaseList({ url: api.url }), (e) => e.code === 'RATE_LIMITED' && /limiting how often/.test(e.message) && e.resetAt === new Date(1999999999 * 1000).toISOString());
  api.status = 404; api.headers = {};
  await assert.rejects(release.fetchReleaseList({ url: api.url }), (e) => e.code === 'NOT_FOUND' && /may not be public yet/.test(e.message));
  api.status = 502;
  await assert.rejects(release.fetchReleaseList({ url: api.url }), (e) => e.code === 'HTTP' && /answered 502/.test(e.message));
  await assert.rejects(release.fetchReleaseList({ url: api.url, fetch: offlineFetch }), (e) => e.code === 'NETWORK' && /Couldn't reach GitHub \(address not found\)/.test(e.message));
  const notJson = async () => new Response('<html>', { status: 200 });
  await assert.rejects(release.fetchReleaseList({ url: api.url, fetch: notJson }), (e) => e.code === 'BAD_ANSWER');
});

test('readReleaseFeed asks GitHub at most every 30 minutes, or every 10 seconds when forced, and shares its cache file', async (t) => {
  const api = await fakeApi(t, { releases: [ghRelease('addon', '0.12.0')] });
  const cacheFile = path.join(tmpDir(t), 'github-releases.json');
  let now = Date.parse('2026-11-07T10:00:00Z');
  const read = (extra = {}) => release.readReleaseFeed({ cacheFile, url: api.url, now: () => now, ...extra });

  let feed = await read();
  assert.strictEqual(feed.fromNetwork, true);
  assert.strictEqual(feed.releases[0].tag, 'addon-v0.12.0');
  assert.strictEqual(feed.error, null);
  assert.strictEqual(api.listCalls(), 1);
  const saved = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  assert.strictEqual(saved.etag, '"v1"');

  now += 29 * 60 * 1000;
  feed = await read();
  assert.strictEqual(feed.fromNetwork, false, 'within 30 minutes: the cache answers');
  assert.strictEqual(feed.releases[0].tag, 'addon-v0.12.0');
  assert.strictEqual(api.listCalls(), 1);

  // Forced (the person pressed Check): asked again, with the ETag, so an unchanged list costs nothing.
  feed = await read({ force: true });
  assert.strictEqual(feed.fromNetwork, true);
  assert.strictEqual(api.requests[1].headers['if-none-match'], '"v1"');
  assert.strictEqual(feed.releases[0].tag, 'addon-v0.12.0', '304 keeps the cached list');
  now += 5000;
  feed = await read({ force: true });
  assert.strictEqual(feed.fromNetwork, false, 'not more often than every 10 seconds');

  // Another reader of the same file (the updater, or the next app start) uses the same answer.
  assert.strictEqual((await release.readReleaseFeed({ cacheFile, url: api.url, now: () => now })).fromNetwork, false);
  // Callers at the same moment share one request.
  now += 31 * 60 * 1000;
  api.releases = [ghRelease('addon', '0.13.0')];
  api.etag = '"v2"';
  const [a, b] = await Promise.all([read(), release.readReleaseFeed({ cacheFile, url: api.url, now: () => now })]);
  assert.strictEqual(a.releases[0].version, '0.13.0');
  assert.strictEqual(b.releases[0].version, '0.13.0');
  assert.strictEqual(api.listCalls(), 3);

  // Rate limited: the old list stays, the error says why, and nothing is asked before GitHub's reset time.
  now += 31 * 60 * 1000;
  api.status = 403;
  api.headers = { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(now / 1000) + 3600) };
  feed = await read();
  assert.strictEqual(feed.code, 'RATE_LIMITED');
  assert.match(feed.error, /limiting/);
  assert.strictEqual(feed.releases[0].version, '0.13.0');
  now += 20 * 1000;
  assert.strictEqual((await read({ force: true })).fromNetwork, false, 'waits for the reset even when forced');
  now += 3600 * 1000;
  api.status = 200;
  feed = await read({ force: true });
  assert.strictEqual(feed.fromNetwork, true);
  assert.strictEqual(feed.error, null);

  // A damaged cache file is ignored.
  fs.writeFileSync(cacheFile, '{ nope');
  now += 31 * 60 * 1000;
  assert.strictEqual((await read()).fromNetwork, true);
});

// ---------------------------------------------------------------------------------------------
// Battle.net credentials for builds

test('Battle.net credentials come from the environment, then .release.json; half a pair is refused', () => {
  assert.strictEqual(release.bnetCredentialsFrom({ env: {}, config: {} }), null);
  assert.deepStrictEqual(release.bnetCredentialsFrom({ env: { GUILDCAMP_BNET_CLIENT_ID: ' id ', GUILDCAMP_BNET_CLIENT_SECRET: 'sec' }, config: { bnetClientId: 'x', bnetClientSecret: 'y' } }),
    { clientId: 'id', clientSecret: 'sec', from: 'environment variables' });
  assert.deepStrictEqual(release.bnetCredentialsFrom({ env: {}, config: { bnetClientId: 'x', bnetClientSecret: 'y' } }), { clientId: 'x', clientSecret: 'y', from: '.release.json' });
  assert.throws(() => release.bnetCredentialsFrom({ env: { GUILDCAMP_BNET_CLIENT_ID: 'id' } }), (e) => e.code === 'BNET_HALF' && /GUILDCAMP_BNET_CLIENT_SECRET isn't/.test(e.message));
  assert.throws(() => release.bnetCredentialsFrom({ env: {}, config: { bnetClientSecret: 'y' } }), (e) => e.code === 'BNET_HALF' && /bnetClientId isn't/.test(e.message));
  assert.strictEqual(release.bnetCredentialsFrom({ env: { GUILDCAMP_BNET_CLIENT_ID: '  ', GUILDCAMP_BNET_CLIENT_SECRET: '' } }), null, 'empty CI secrets count as not set');
});

test('buildApp writes bnet-credentials.json for the build only, and warns when there is none', async (t) => {
  const root = fakeRepo(t, { appVersion: '2.0.0' });
  const app = path.join(root, 'app');
  const cred = path.join(app, 'src', 'main', 'bnet-credentials.json');
  const seen = path.join(app, 'dist', 'bnet-seen.json');
  const lines = []; const warnings = [];
  await release.buildApp(app, { onLog: (l) => lines.push(l), onWarn: (l) => warnings.push(l), bnet: { clientId: 'client-12345', clientSecret: 's3cret', from: 'environment variables' } });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(seen, 'utf8')), { clientId: 'client-12345', clientSecret: 's3cret' });
  assert.strictEqual(fs.existsSync(cred), false, 'removed after the build');
  assert.ok(lines.some((l) => /Battle\.net sign-in is built in \(client id clie…, from environment variables\)/.test(l)));
  assert.ok(!lines.join('\n').includes('s3cret'), 'the secret is never logged');
  assert.deepStrictEqual(warnings, []);

  // Without credentials: a clear warning, and no file.
  await release.buildApp(app, { onLog: () => {}, onWarn: (l) => warnings.push(l), bnet: null });
  assert.strictEqual(fs.existsSync(seen), false);
  assert.match(warnings[0], /no Battle\.net sign-in/);
  assert.match(warnings[0], /GUILDCAMP_BNET_CLIENT_ID and GUILDCAMP_BNET_CLIENT_SECRET/);

  // A file someone put there by hand is used, and left as it was.
  fs.writeFileSync(cred, '{"clientId":"hand","clientSecret":"made"}');
  await release.buildApp(app, { onLog: (l) => lines.push(l), onWarn: (l) => warnings.push(l), bnet: null });
  assert.strictEqual(JSON.parse(fs.readFileSync(seen, 'utf8')).clientId, 'hand');
  assert.ok(lines.some((l) => /already in/.test(l)));
  assert.strictEqual(fs.readFileSync(cred, 'utf8'), '{"clientId":"hand","clientSecret":"made"}');
  // ...and put back after a build with other credentials, even a failing one.
  fs.writeFileSync(path.join(app, 'make-dist.js'), "require('fs').copyFileSync(require('path').join(__dirname,'src','main','bnet-credentials.json'), require('path').join(__dirname,'dist','bnet-seen.json')); process.exit(2);");
  await assert.rejects(release.buildApp(app, { onLog: () => {}, bnet: { clientId: 'ci-id-999', clientSecret: 'ci' } }), (e) => e.code === 'BUILD_FAILED');
  assert.strictEqual(JSON.parse(fs.readFileSync(seen, 'utf8')).clientId, 'ci-id-999');
  assert.strictEqual(fs.readFileSync(cred, 'utf8'), '{"clientId":"hand","clientSecret":"made"}');
});

// ---------------------------------------------------------------------------------------------
// GitHub CLI

test('findExecutable and runGh find gh on PATH (a .cmd shim on Windows) and pass arguments through', async (t) => {
  const fake = makeFakeGh(t);
  const found = release.findExecutable('gh', { PATH: fake.dir });
  assert.strictEqual(path.dirname(found), fake.dir);
  assert.strictEqual(release.findExecutable('gh', noGhEnv(t)), null);
  assert.strictEqual(release.findExecutable('', process.env), null);
  assert.strictEqual(release.findExecutable(path.join(fake.dir, 'gh.js'), {}), path.join(fake.dir, 'gh.js'), 'a full path is used as it is');

  const tricky = path.join(os.tmpdir(), 'a b', 'x & y (1)^!.exe');
  const res = await release.runGh(['release', 'view', tricky], { env: fake.env });
  assert.strictEqual(res.code, 1);
  assert.match(res.stderr, /release not found/);
  assert.deepStrictEqual(fake.calls().at(-1), ['release', 'view', tricky], 'spaces, &, ^, ! and brackets arrive unchanged');
  // A .js file as the gh command runs with Node.
  const viaJs = await release.runGh(['--version'], { gh: path.join(fake.dir, 'gh.js'), env: {} });
  assert.match(viaJs.stdout, /gh version 2\.99\.0/);
  await assert.rejects(release.runGh(['--version'], { env: noGhEnv(t) }), (e) => e.code === 'NO_GH' && e.message === release.GH_MISSING);
  if (process.platform === 'win32') {
    await assert.rejects(release.runGh(['100%'], { env: fake.env }), (e) => e.code === 'BAD_ARG');
  }
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(release.runGh(['--version'], { env: fake.env, signal: aborted.signal }), (e) => e.code === 'ABORTED');
});

test('inside a test, the real GitHub CLI is never run (it would publish to the real repository)', async (t) => {
  // Any program outside the temp folder counts as real: Node itself stands in for gh.exe here.
  await assert.rejects(release.runGh(['--version'], { gh: process.execPath }), (e) => e.code === 'TEST_GUARD' && /real GitHub CLI/.test(e.message));
  const st = await release.ghStatus({ gh: process.execPath });
  assert.strictEqual(st.installed, false, 'so nothing can be published');
  assert.match(st.problem, /fake gh/);
  const real = release.findExecutable('gh', process.env);
  if (real && !real.startsWith(os.tmpdir())) {
    await assert.rejects(release.runGh(['auth', 'status']), (e) => e.code === 'TEST_GUARD');
    await assert.rejects(release.publishAddon({ pack: release.packAddon(fakeAddon(tmpDir(t), '9.9.9')) }), (e) => e.code === 'TEST_GUARD');
  }
});

test('ghStatus: installed, signed in, push access, private repo', async (t) => {
  const fake = makeFakeGh(t, { private: true });
  let st = await release.ghStatus({ env: fake.env });
  assert.deepStrictEqual(
    { installed: st.installed, version: st.version, loggedIn: st.loggedIn, account: st.account, push: st.push, private: st.private, problem: st.problem },
    { installed: true, version: '2.99.0', loggedIn: true, account: 'octo-owner', push: true, private: true, problem: null },
  );
  fake.set({ push: false });
  st = await release.ghStatus({ env: fake.env });
  assert.strictEqual(st.push, false);
  assert.match(st.problem, /\(octo-owner\) can't push to arrow-quiver\/wow/);
  fake.set({ push: null }); // a token that doesn't report permissions (CI's GITHUB_TOKEN)
  assert.strictEqual((await release.ghStatus({ env: fake.env })).push, null);
  fake.set({ repoMissing: true });
  assert.strictEqual((await release.ghStatus({ env: fake.env })).push, false, "a private repo the account can't see");
  fake.set({ repoMissing: false, offline: true, push: true });
  st = await release.ghStatus({ env: fake.env });
  assert.strictEqual(st.push, null);
  assert.strictEqual(st.problem, null);
  assert.match(st.note, /couldn't reach GitHub/);
  fake.set({ authed: false, offline: false });
  st = await release.ghStatus({ env: fake.env });
  assert.strictEqual(st.loggedIn, false);
  assert.strictEqual(st.problem, release.GH_LOGIN);
  st = await release.ghStatus({ env: noGhEnv(t) });
  assert.strictEqual(st.installed, false);
  assert.match(st.problem, /Install GitHub CLI from https:\/\/cli\.github\.com, then run gh auth login/);
});

test('publishApp creates release v<version>, marked Latest, with the installer, blockmap and latest.yml', async (t) => {
  const fake = makeFakeGh(t);
  const dir = tmpDir(t);
  const { exeName, exe, yml } = fakeDist(dir, '0.11.1');
  const lines = [];
  const out = await release.publishApp({ distDir: dir, notes: 'Faster sync.\r\nNew Releases page.', env: fake.env, onLog: (l) => lines.push(l) });
  assert.strictEqual(out.version, '0.11.1');
  assert.strictEqual(out.tag, 'v0.11.1');
  assert.strictEqual(out.url, 'https://github.com/arrow-quiver/wow/releases/tag/v0.11.1');
  assert.deepStrictEqual(out.files.map((f) => f.name), [exeName, `${exeName}.blockmap`]);
  assert.strictEqual(out.files[0].sha512, sha512b64(exe));
  const call = fake.creates()[0];
  assert.deepStrictEqual(call.slice(0, 3), ['release', 'create', 'v0.11.1']);
  assert.deepStrictEqual(call.slice(3, 6).map((f) => path.basename(f)), [exeName, `${exeName}.blockmap`, 'latest.yml']);
  const opt = (n) => call[call.indexOf(n) + 1];
  assert.strictEqual(opt('--repo'), 'arrow-quiver/wow');
  assert.strictEqual(opt('--title'), 'Guild Camp 0.11.1');
  assert.ok(call.includes('--latest'));
  assert.ok(!call.includes('--latest=false'));
  const rel = fake.release('v0.11.1');
  assert.strictEqual(rel.body, 'Faster sync.\nNew Releases page.\n');
  assert.strictEqual(rel.latest, true);
  assert.ok(fs.readFileSync(path.join(fake.uploads('v0.11.1'), exeName)).equals(exe));
  assert.strictEqual(fs.readFileSync(path.join(fake.uploads('v0.11.1'), 'latest.yml'), 'utf8'), yml);
  assert.ok(lines.some((l) => /Uploading Guild-Camp-Setup-0\.11\.1\.exe, Guild-Camp-Setup-0\.11\.1\.exe\.blockmap, latest\.yml \(3\.0 MB\)/.test(l)));
  assert.ok(lines.some((l) => /is live: https:\/\/github\.com\/arrow-quiver\/wow\/releases\/tag\/v0\.11\.1/.test(l)));
  assert.ok(!fs.readdirSync(os.tmpdir()).some((n) => n.startsWith(`guildcamp-notes-${process.pid}-`)), 'the notes file is cleaned up');

  // The same tag again: gh's refusal comes back as a sentence.
  await assert.rejects(release.publishApp({ distDir: dir, env: fake.env }), (e) => e.code === 'EXISTS' && /already exists/.test(e.message));
  // verifyTag and target are passed on.
  const dir2 = tmpDir(t);
  fakeDist(dir2, '0.11.2');
  await release.publishApp({ distDir: dir2, env: fake.env, target: 'abc123' });
  assert.strictEqual(fake.release('v0.11.2').target, 'abc123');
});

test('publishApp refuses a build that does not match latest.yml before calling gh', async (t) => {
  const fake = makeFakeGh(t);
  const dir = tmpDir(t);
  const { exeName } = fakeDist(dir, '0.11.1');
  fs.appendFileSync(path.join(dir, exeName), 'tampered');
  await assert.rejects(release.publishApp({ distDir: dir, env: fake.env }), (e) => e.code === 'MISMATCH');
  assert.deepStrictEqual(fake.calls(), []);
  await assert.rejects(release.publishApp({ distDir: path.join(dir, 'nope'), env: fake.env }), (e) => e.code === 'NO_BUILD');
});

test('publishAddon creates release addon-v<version>, never Latest, with the zip and its .sha256', async (t) => {
  const fake = makeFakeGh(t);
  const pack = release.packAddon(fakeAddon(tmpDir(t), '1.0.0'));
  const out = await release.publishAddon({ pack, notes: 'Tooltip fix', env: fake.env });
  assert.strictEqual(out.tag, 'addon-v1.0.0');
  assert.strictEqual(out.zipFile, null, 'temp files are removed');
  const call = fake.creates()[0];
  assert.deepStrictEqual(call.slice(3, 5).map((f) => path.basename(f)), ['WowGuild-1.0.0.zip', 'WowGuild-1.0.0.zip.sha256']);
  assert.ok(call.includes('--latest=false'));
  assert.ok(!call.includes('--latest'));
  assert.strictEqual(call[call.indexOf('--title') + 1], 'Guild Camp addon 1.0.0');
  const rel = fake.release('addon-v1.0.0');
  assert.strictEqual(rel.latest, false);
  assert.strictEqual(rel.body, 'Tooltip fix\n');
  const zip = fs.readFileSync(path.join(fake.uploads('addon-v1.0.0'), 'WowGuild-1.0.0.zip'));
  assert.ok(zip.equals(pack.zip));
  assert.strictEqual(fs.readFileSync(path.join(fake.uploads('addon-v1.0.0'), 'WowGuild-1.0.0.zip.sha256'), 'utf8'), `${sha256hex(zip)}  WowGuild-1.0.0.zip\n`);
  assert.ok(!fs.existsSync(path.dirname(call[3])), 'the temp folder is gone');

  // Kept files when an outDir is given; plain errors from gh.
  const out2 = tmpDir(t);
  const pack2 = release.packAddon(fakeAddon(tmpDir(t), '1.0.1'));
  const kept = await release.publishAddon({ pack: pack2, env: fake.env, outDir: out2 });
  assert.ok(fs.existsSync(kept.zipFile) && fs.existsSync(kept.shaFile));
  fake.set({ authed: false });
  await assert.rejects(release.publishAddon({ pack: release.packAddon(fakeAddon(tmpDir(t), '1.0.2')), env: fake.env }), (e) => e.code === 'NOT_LOGGED_IN' && /gh auth login/.test(e.message));
  fake.set({ authed: true, failCreate: 'HTTP 403: Resource not accessible by integration' });
  await assert.rejects(release.publishAddon({ pack: release.packAddon(fakeAddon(tmpDir(t), '1.0.2')), env: fake.env }), (e) => e.code === 'NO_PUSH' && /can't publish to arrow-quiver\/wow/.test(e.message));
  await assert.rejects(release.publishAddon({ pack: null, env: fake.env }), (e) => e.code === 'NO_PACK');
});

test('getReleases reads through gh, or the public API when gh is missing; ghReleaseInfo finds a tag', async (t) => {
  const fake = makeFakeGh(t, { releases: [ghRelease('app', '0.12.0'), ghRelease('addon', '0.11.0'), { ...ghRelease('addon', '0.12.0'), draft: true }] });
  const viaGh = await release.getReleases({ env: fake.env, fetch: offlineFetch });
  assert.strictEqual(viaGh.source, 'gh');
  assert.strictEqual(viaGh.app.version, '0.12.0');
  assert.strictEqual(viaGh.addon.version, '0.11.0', 'drafts are not releases yet');
  const calls = [];
  const viaApi = await release.getReleases({ env: noGhEnv(t), fetch: apiFetch([ghRelease('addon', '0.9.0')], calls) });
  assert.strictEqual(viaApi.source, 'api');
  assert.strictEqual(viaApi.addon.version, '0.9.0');
  assert.strictEqual(calls[0].url, 'https://api.github.com/repos/arrow-quiver/wow/releases?per_page=30');
  await assert.rejects(release.getReleases({ env: noGhEnv(t), fetch: offlineFetch }), (e) => e.code === 'NETWORK');
  assert.deepStrictEqual(await release.ghReleaseInfo('v0.12.0', { env: fake.env }), { exists: true, draft: false, url: 'https://github.com/arrow-quiver/wow/releases/tag/v0.12.0' });
  assert.deepStrictEqual(await release.ghReleaseInfo('addon-v0.12.0', { env: fake.env }), { exists: true, draft: true, url: 'https://github.com/arrow-quiver/wow/releases/tag/addon-v0.12.0' });
  assert.deepStrictEqual(await release.ghReleaseInfo('v9.9.9', { env: fake.env }), { exists: false, draft: false, url: null });
  fake.set({ offline: true });
  await assert.rejects(release.ghReleaseInfo('v9.9.9', { env: fake.env }), (e) => e.code === 'NETWORK');
});

// ---------------------------------------------------------------------------------------------
// Building

test('buildApp runs npm run dist and streams its output', async (t) => {
  const dir = tmpDir(t);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0', scripts: { dist: 'node build.js' } }));
  fs.writeFileSync(path.join(dir, 'build.js'), "console.log('\\u001b[32mpacking\\u001b[39m'); console.error('a warning'); process.stdout.write('no newline at the end');");
  const lines = [];
  const res = await release.buildApp(dir, { onLog: (l) => lines.push(l) });
  assert.deepStrictEqual(res, { distDir: path.join(dir, 'dist') });
  assert.ok(lines.includes('packing'), 'colour codes are stripped');
  assert.ok(lines.includes('a warning'), 'stderr is streamed too');
  assert.ok(lines.includes('no newline at the end'));

  fs.writeFileSync(path.join(dir, 'build.js'), "console.error('electron-builder: something broke'); process.exit(3);");
  const failed = [];
  await assert.rejects(release.buildApp(dir, { onLog: (l) => failed.push(l) }), (e) => e.code === 'BUILD_FAILED' && /code 3/.test(e.message));
  assert.ok(failed.includes('electron-builder: something broke'));
  await assert.rejects(release.buildApp(path.join(dir, 'missing')), (e) => e.code === 'NO_PACKAGE');
});

test('cancelling buildApp stops the whole build, including what npm started', async (t) => {
  const dir = tmpDir(t);
  // A stand-in for electron-builder that never finishes on its own. On Windows it runs as
  // cmd.exe → npm → cmd.exe → node, so it only dies when the whole tree is killed.
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0', scripts: { dist: 'node build.js' } }));
  fs.writeFileSync(path.join(dir, 'build.js'), "require('fs').writeFileSync('pid.txt', String(process.pid)); console.log('building forever'); setInterval(() => {}, 1000);");
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
  let pid = null;
  t.after(() => { if (pid && alive(pid)) { try { process.kill(pid); } catch { /* gone */ } } });

  const controller = new AbortController();
  const lines = [];
  const build = release.buildApp(dir, {
    signal: controller.signal,
    onLog: (l) => { lines.push(l); if (l === 'building forever') controller.abort(); },
  });
  await assert.rejects(build, (e) => e instanceof release.ReleaseError && e.code === 'ABORTED' && /cancelled/.test(e.message));
  assert.ok(lines.includes('Stopping the build…'));
  pid = Number(fs.readFileSync(path.join(dir, 'pid.txt'), 'utf8'));
  assert.ok(pid > 0);
  for (let i = 0; i < 50 && alive(pid); i++) await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(alive(pid), false, 'the build process npm started is gone, not orphaned');

  // Already cancelled: nothing is started.
  const before = new AbortController();
  before.abort();
  fs.unlinkSync(path.join(dir, 'pid.txt'));
  await assert.rejects(release.buildApp(dir, { signal: before.signal }), (e) => e.code === 'ABORTED');
  assert.strictEqual(fs.existsSync(path.join(dir, 'pid.txt')), false);
});

// ---------------------------------------------------------------------------------------------
// Changelog

test('gitChangelog lists commits since the previous tag for the right folder', (t) => {
  if (!hasGit()) { t.skip('git is not installed'); return; }
  const root = fakeRepo(t, { git: true });
  git(root, 'tag', 'addon-v1.0.0');
  git(root, 'tag', 'v1.0.0');
  fs.appendFileSync(path.join(root, 'addon', 'WowGuild', 'Core.lua'), '-- 1\n'); commitAll(root, 'Addon: fix the tooltip');
  fs.appendFileSync(path.join(root, 'app', 'make-dist.js'), '// 1\n'); commitAll(root, 'App: faster sync');
  fs.appendFileSync(path.join(root, 'addon', 'WowGuild', 'Core.lua'), '-- 2\n'); commitAll(root, 'Release addon 1.0.1');
  fs.appendFileSync(path.join(root, 'addon', 'WowGuild', 'Core.lua'), '-- 3\n'); commitAll(root, 'Addon: new coach tips');
  assert.strictEqual(release.gitChangelog(root, 'addon'), '- Addon: new coach tips\n- Addon: fix the tooltip');
  assert.strictEqual(release.gitChangelog(root, 'app'), '- App: faster sync');
  // In CI the new tag sits on HEAD: it is skipped, so the notes still cover the whole release.
  git(root, 'tag', 'addon-v1.0.1');
  assert.strictEqual(release.gitChangelog(root, 'addon'), '- Addon: new coach tips\n- Addon: fix the tooltip');
  // The app's v* tags are not confused with addon-v* ones.
  fs.appendFileSync(path.join(root, 'app', 'make-dist.js'), '// 2\n'); commitAll(root, 'App: tray menu');
  git(root, 'tag', 'v1.1.0');
  assert.strictEqual(release.gitChangelog(root, 'app'), '- App: tray menu\n- App: faster sync');
  fs.writeFileSync(path.join(root, 'README.md'), 'x'); commitAll(root, 'Docs only');
  assert.strictEqual(release.gitChangelog(root, 'addon'), '- Maintenance release.');
  assert.strictEqual(release.gitChangelog(os.tmpdir(), 'app'), '- Maintenance release.', 'outside git: a placeholder');
  assert.throws(() => release.gitChangelog(root, 'server'), /kind must be/);
});

// ---------------------------------------------------------------------------------------------
// CLI (scripts/release.js)

function cliRun(argv, { root, env = {}, fetchImpl = offlineFetch, buildApp } = {}) {
  const lines = []; const warnings = [];
  const p = cli.run(argv, { root, env, log: (l) => lines.push(l), warn: (l) => warnings.push(l), fetch: fetchImpl, buildApp });
  return p.then((result) => ({ result, lines, warnings, text: lines.join('\n') }));
}

test('CLI arguments are checked; the server options are gone with a pointer to what replaced them', () => {
  assert.deepStrictEqual(cli.parseArgs(['addon', '--bump', 'patch', '--notes=Hello there', '--git', '--push']).flags, { bump: 'patch', notes: 'Hello there', git: true, push: true });
  assert.strictEqual(cli.parseArgs(['app', '--push']).flags.git, true, '--push implies --git');
  assert.strictEqual(cli.parseArgs(['app', '--tag-only']).flags.git, true);
  assert.throws(() => cli.parseArgs(['addon', '--bmp', 'patch']), /Unknown option --bmp/);
  assert.throws(() => cli.parseArgs(['addon', '--bump', 'huge']), /--bump must be/);
  assert.throws(() => cli.parseArgs(['addon', '--version', '1.2']), /--version must look like/);
  assert.throws(() => cli.parseArgs(['addon', '--bump', 'patch', '--no-bump']), /only one of/);
  assert.throws(() => cli.parseArgs(['addon', '--notes', 'x', '--notes-from-git']), /only one of/);
  assert.throws(() => cli.parseArgs(['addon', '--notes']), /needs a value/);
  assert.throws(() => cli.parseArgs(['addon', '--git=yes']), /doesn't take a value/);
  assert.throws(() => cli.parseArgs(['addon', '--tag-only', '--dry-run']), /don't go together/);
  assert.throws(() => cli.parseArgs(['addon', '--git']), /--git needs --push when you publish/);
  assert.strictEqual(cli.parseArgs(['addon', '--git', '--dry-run']).flags.git, true, 'a dry run never commits, so --git alone is fine');
  assert.throws(() => cli.parseArgs(['addon', '--server', 'https://x']), /--server is gone: releases go to GitHub/);
  assert.throws(() => cli.parseArgs(['addon', '--token=abc']), /--token is gone.*gh auth login/);
  assert.throws(() => cli.parseArgs(['addon', '--force']), /--force is gone/);
  assert.match(cli.USAGE, /gh auth login/);
  assert.doesNotMatch(cli.USAGE, /--server|--token|PUBLISH_TOKEN/);
});

test('CLI config: .release.json holds the Battle.net client id and secret', (t) => {
  const root = tmpDir(t);
  assert.deepStrictEqual(cli.loadConfig({ root }).config, {});
  fs.writeFileSync(path.join(root, '.release.json'), JSON.stringify({ bnetClientId: 'id', bnetClientSecret: 'secret', server: 'https://old.example', token: 'x' }));
  const cfg = cli.loadConfig({ root });
  assert.strictEqual(cfg.config.bnetClientId, 'id');
  assert.strictEqual(cfg.repo, 'arrow-quiver/wow');
  assert.deepStrictEqual(cfg.old, ['server', 'token']);
  fs.writeFileSync(path.join(root, '.release.json'), '{ not json');
  assert.throws(() => cli.loadConfig({ root }), /isn't valid JSON/);
  fs.writeFileSync(path.join(root, '.release.json'), '[1]');
  assert.throws(() => cli.loadConfig({ root }), /one JSON object/);
});

test('CLI addon: refuses what GitHub has, then bumps, zips, commits, tags, pushes and publishes on the tag', async (t) => {
  if (!hasGit()) { t.skip('git is not installed'); return; }
  const root = fakeRepo(t, { addonVersion: '1.0.0', git: true });
  const remote = addRemote(t, root);
  const fake = makeFakeGh(t, { releases: [ghRelease('addon', '1.0.0')], remoteDir: remote });
  const env = fake.env;
  // Same version as GitHub: refused before anything changes.
  await assert.rejects(cliRun(['addon'], { root, env }), /GitHub already has the release addon-v1\.0\.0.*--bump patch/);
  assert.strictEqual(release.readAddonVersion(path.join(root, 'addon')), '1.0.0');
  assert.strictEqual(fake.creates().length, 0);

  const { text, result } = await cliRun(['addon', '--bump', 'patch', '--notes', 'Tooltip fix', '--git', '--push'], { root, env });
  assert.strictEqual(result[0].version, '1.0.1');
  assert.strictEqual(result[0].tag, 'addon-v1.0.1');
  assert.strictEqual(result[0].url, 'https://github.com/arrow-quiver/wow/releases/tag/addon-v1.0.1');
  assert.match(text, /GitHub CLI 2\.99\.0: signed in as octo-owner/);
  assert.match(text, /1\.0\.0 → 1\.0\.1/);
  assert.match(text, /Tagged addon-v1\.0\.1/);
  assert.match(text, /Pushed the commit and addon-v1\.0\.1/);
  assert.strictEqual(git(root, 'log', '-1', '--format=%s'), 'Release addon 1.0.1');
  assert.strictEqual(git(root, 'status', '--porcelain'), '', 'the bump is committed');
  assert.deepStrictEqual(git(remote, 'tag', '--list').split(/\r?\n/), ['addon-v1.0.1']);
  const rel = fake.release('addon-v1.0.1');
  assert.strictEqual(rel.verifyTag, true, 'the release points at the pushed tag');
  assert.strictEqual(rel.latest, false);
  assert.strictEqual(rel.body, 'Tooltip fix\n');
  assert.deepStrictEqual(rel.assets.map((a) => a.name), ['WowGuild-1.0.1.zip', 'WowGuild-1.0.1.zip.sha256']);
  const zip = fs.readFileSync(path.join(root, 'dist', 'WowGuild-1.0.1.zip'));
  assert.ok(readZip(zip).some((e) => e.name === 'WowGuild/WowGuild.toc'));
  assert.strictEqual(fs.readFileSync(path.join(root, 'dist', 'WowGuild-1.0.1.zip.sha256'), 'utf8'), `${sha256hex(zip)}  WowGuild-1.0.1.zip\n`);

  // --skip-published (CI after a release from a computer): nothing published, no error.
  const before = fake.calls().length;
  const skipped = await cliRun(['addon', '--no-bump', '--skip-published', '--notes-from-git'], { root, env });
  assert.strictEqual(skipped.result[0].skipped, true);
  assert.match(skipped.text, /GitHub already has the release addon-v1\.0\.1\. Nothing to publish/);
  assert.ok(!fake.calls().slice(before).some((c) => c[1] === 'create'));

  // An older version is refused: GitHub releases only move forward.
  await assert.rejects(cliRun(['addon', '--version', '0.9.0', '--notes', 'x'], { root, env }), /GitHub already has addon 1\.0\.1, and 0\.9\.0 isn't newer/);
  assert.strictEqual(release.readAddonVersion(path.join(root, 'addon')), '1.0.1');

  // In GitHub Actions without --git (a manual workflow run), the new tag goes on the commit that ran.
  const ci = await cliRun(['addon', '--bump', 'patch', '--notes', 'CI'], { root, env: { ...env, GITHUB_ACTIONS: 'true', GITHUB_SHA: 'deadbeef' } });
  assert.strictEqual(ci.result[0].version, '1.0.2');
  assert.strictEqual(fake.release('addon-v1.0.2').target, 'deadbeef');
  assert.strictEqual(fake.release('addon-v1.0.2').verifyTag, false);

  // The tag pushed but the release failed: the message says how to finish.
  fake.set({ failCreate: 'HTTP 502: Bad Gateway' });
  await assert.rejects(cliRun(['addon', '--bump', 'patch', '--notes', 'x', '--git', '--push'], { root, env }),
    (e) => /Bad Gateway/.test(e.message) && /The tag addon-v1\.0\.3 is on GitHub, but the release wasn't made/.test(e.message) && /node scripts\/release\.js addon --no-bump/.test(e.message));
});

test('CLI: no GitHub CLI, not signed in, or no push access: a clear message before anything changes', async (t) => {
  const root = fakeRepo(t, { addonVersion: '2.3.4', appVersion: '0.11.0' });
  await assert.rejects(cliRun(['addon', '--bump', 'patch'], { root, env: noGhEnv(t) }),
    (e) => e.code === 'NO_GH' && /Install GitHub CLI and run gh auth login/.test(e.message) && /cli\.github\.com/.test(e.message));
  await assert.rejects(cliRun(['app', '--bump', 'patch'], { root, env: noGhEnv(t) }), (e) => e.code === 'NO_GH');
  const fake = makeFakeGh(t, { authed: false });
  await assert.rejects(cliRun(['addon', '--bump', 'patch'], { root, env: fake.env }), (e) => e.code === 'NOT_LOGGED_IN' && /Run gh auth login/.test(e.message));
  fake.set({ authed: true, push: false });
  await assert.rejects(cliRun(['addon', '--bump', 'patch'], { root, env: fake.env }), (e) => e.code === 'NO_PUSH' && /can't push to arrow-quiver\/wow/.test(e.message));
  assert.strictEqual(release.readAddonVersion(path.join(root, 'addon')), '2.3.4', 'nothing was bumped');
  assert.strictEqual(release.readAppVersion(path.join(root, 'app')), '0.11.0');
  await assert.rejects(cliRun(['ship'], { root }), /Unknown command "ship"/);
  await assert.rejects(cliRun([], { root }), /Pass a command/);
  await assert.rejects(cliRun(['addon', 'stray words'], { root }), /Put notes in quotes/);
  const help = await cliRun(['--help'], { root });
  assert.match(help.text, /Usage: node scripts\/release\.js/);
});

test('CLI addon --dry-run writes the zip and .sha256 into dist/ and needs no GitHub CLI', async (t) => {
  const root = fakeRepo(t, { addonVersion: '2.3.4' });
  const calls = [];
  const { text } = await cliRun(['addon', '--dry-run'], { root, env: noGhEnv(t), fetchImpl: apiFetch([ghRelease('addon', '2.3.4')], calls) });
  const zipFile = path.join(root, 'dist', 'WowGuild-2.3.4.zip');
  const shaFile = path.join(root, 'dist', 'WowGuild-2.3.4.zip.sha256');
  assert.ok(text.includes(zipFile) && text.includes(shaFile));
  assert.strictEqual(release.parseSha256Text(fs.readFileSync(shaFile, 'utf8'), 'WowGuild-2.3.4.zip'), sha256hex(fs.readFileSync(zipFile)));
  assert.match(text, /Dry run: nothing published/);
  assert.match(text, /GitHub has addon 2\.3\.4; 2\.3\.4 isn't newer, so a real run would be refused/);
  assert.strictEqual(calls.length, 1, 'the public release list was read');
});

test('CLI app: bump, build with Battle.net built in, publish installer, blockmap and latest.yml as Latest', async (t) => {
  const root = fakeRepo(t, { appVersion: '0.11.0' });
  const fake = makeFakeGh(t, { releases: [ghRelease('app', '0.11.0')] });
  const env = { ...fake.env, GUILDCAMP_BNET_CLIENT_ID: 'bnet-client-1', GUILDCAMP_BNET_CLIENT_SECRET: 'bnet-secret' };
  await assert.rejects(cliRun(['app', '--no-bump'], { root, env }), /GitHub already has the release v0\.11\.0/);
  const { text, result, warnings } = await cliRun(['app', '--bump', 'minor', '--notes', 'New look'], { root, env });
  assert.strictEqual(result[0].version, '0.12.0');
  assert.strictEqual(result[0].url, 'https://github.com/arrow-quiver/wow/releases/tag/v0.12.0');
  assert.strictEqual(release.readAppVersion(path.join(root, 'app')), '0.12.0');
  assert.match(text, /building\s+target=nsis/, 'the build output is streamed');
  assert.match(text, /Battle\.net sign-in is built in \(client id bnet…, from environment variables\)/);
  assert.deepStrictEqual(warnings, []);
  const dist = path.join(root, 'app', 'dist');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dist, 'bnet-seen.json'), 'utf8')), { clientId: 'bnet-client-1', clientSecret: 'bnet-secret' }, 'the build had the credentials');
  assert.strictEqual(fs.existsSync(path.join(root, 'app', 'src', 'main', 'bnet-credentials.json')), false, 'and they are gone again');
  const rel = fake.release('v0.12.0');
  assert.strictEqual(rel.latest, true);
  assert.strictEqual(rel.name, 'Guild Camp 0.12.0');
  assert.strictEqual(rel.body, 'New look\n');
  assert.deepStrictEqual(rel.assets.map((a) => a.name), ['Guild-Camp-Setup-0.12.0.exe', 'Guild-Camp-Setup-0.12.0.exe.blockmap', 'latest.yml']);
  assert.ok(fs.readFileSync(path.join(fake.uploads('v0.12.0'), 'Guild-Camp-Setup-0.12.0.exe')).equals(fs.readFileSync(path.join(dist, 'Guild-Camp-Setup-0.12.0.exe'))));

  // A build step that leaves an older dist/ behind is caught instead of being published.
  const creates = fake.creates().length;
  const noBuild = async (appDir) => ({ distDir: path.join(appDir, 'dist') });
  await assert.rejects(cliRun(['app', '--bump', 'patch'], { root, env, buildApp: noBuild }), /is version 0\.12\.0, but app\/package\.json says 0\.12\.1/);
  assert.strictEqual(fake.creates().length, creates, 'nothing published');

  // A dry run builds but publishes nothing, says where the files are, and warns about Battle.net.
  const dry = await cliRun(['app', '--no-bump', '--dry-run'], { root, env: fake.env });
  const exe = path.join(dist, 'Guild-Camp-Setup-0.12.1.exe');
  assert.ok(fs.existsSync(exe));
  assert.ok(dry.text.includes(exe));
  assert.ok(dry.text.includes(path.join(dist, 'latest.yml')));
  assert.ok(dry.warnings.some((w) => /no Battle\.net sign-in/.test(w)));
  assert.strictEqual(fs.existsSync(path.join(dist, 'bnet-seen.json')), false);
  assert.strictEqual(fake.creates().length, creates, 'still nothing published');

  // Credentials from .release.json; half a pair stops the release before the build.
  fs.writeFileSync(path.join(root, '.release.json'), JSON.stringify({ bnetClientId: 'file-client', bnetClientSecret: 'file-secret' }));
  await cliRun(['app', '--no-bump', '--dry-run'], { root, env: fake.env });
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dist, 'bnet-seen.json'), 'utf8')).clientId, 'file-client');
  await assert.rejects(cliRun(['app', '--bump', 'patch'], { root, env: { ...fake.env, GUILDCAMP_BNET_CLIENT_ID: 'only-id' } }), (e) => e.code === 'BNET_HALF');
  assert.strictEqual(release.readAppVersion(path.join(root, 'app')), '0.12.1');
});

test('CLI status shows the local versions next to the newest releases on GitHub', async (t) => {
  const root = fakeRepo(t, { addonVersion: '1.1.0', appVersion: '0.11.0' });
  const fake = makeFakeGh(t, { releases: [ghRelease('addon', '1.0.0'), ghRelease('app', '0.11.0')], private: true });
  const { text, result } = await cliRun(['status'], { root, env: fake.env });
  assert.deepStrictEqual(result.local, { addon: '1.1.0', app: '0.11.0' });
  assert.strictEqual(result.published.source, 'gh');
  assert.match(text, /Repository: arrow-quiver\/wow/);
  assert.match(text, /GitHub CLI: 2\.99\.0, signed in as octo-owner, can publish\./);
  assert.match(text, /gh repo edit arrow-quiver\/wow --visibility public --accept-visibility-change-consequences/);
  assert.match(text, /Battle\.net: not set, so app builds have no Battle\.net sign-in\./);
  assert.match(text, /Addon\s+1\.1\.0\s+1\.0\.0/);
  assert.match(text, /App\s+0\.11\.0\s+0\.11\.0/);
  assert.match(text, /The addon 1\.1\.0 isn't published yet/);

  // Without gh: the public list, and the hint to install gh.
  const noGh = await cliRun(['status'], { root, env: noGhEnv(t), fetchImpl: apiFetch([ghRelease('addon', '1.2.0')]) });
  assert.match(noGh.text, /GitHub CLI: not installed\. Install it from https:\/\/cli\.github\.com, then run gh auth login\./);
  assert.match(noGh.text, /Addon\s+1\.1\.0\s+1\.2\.0/);
  assert.match(noGh.text, /App\s+0\.11\.0\s+none/);
  assert.match(noGh.text, /GitHub has a newer addon \(1\.2\.0\) than this checkout \(1\.1\.0\)\. Pull first\./);
  // Offline: the local side still shows.
  const offline = await cliRun(['status'], { root, env: noGhEnv(t), fetchImpl: offlineFetch });
  assert.match(offline.text, /Addon\s+1\.1\.0\s+\?/);
  assert.ok(offline.warnings.some((w) => /Couldn't check what's on GitHub/.test(w)));
});

test('CLI --tag-only --push bumps, commits, tags and pushes without building or publishing', async (t) => {
  if (!hasGit()) { t.skip('git is not installed'); return; }
  const root = fakeRepo(t, { addonVersion: '1.0.0', appVersion: '0.11.0', git: true });
  const remote = addRemote(t, root);
  const fake = makeFakeGh(t);
  const { text } = await cliRun(['all', '--bump', 'patch', '--tag-only', '--push'], { root, env: fake.env });
  assert.deepStrictEqual(fake.calls(), [], 'no GitHub CLI calls at all');
  assert.match(text, /Pushed the commit and addon-v1\.0\.1/);
  assert.match(text, /Pushed the commit and v0\.11\.1/);
  assert.deepStrictEqual(git(remote, 'tag', '--list').split(/\r?\n/).sort(), ['addon-v1.0.1', 'v0.11.1']);
  assert.strictEqual(git(remote, 'log', '-1', '--format=%s', 'main'), 'Release app 0.11.1');
  assert.ok(!fs.existsSync(path.join(root, 'app', 'dist')), 'nothing was built');
  // The same tag twice is refused up front.
  git(root, 'tag', 'addon-v1.0.2');
  await assert.rejects(cliRun(['addon', '--bump', 'patch', '--tag-only'], { root, env: fake.env }), /tag addon-v1\.0\.2 already exists/);
  assert.strictEqual(release.readAddonVersion(path.join(root, 'addon')), '1.0.1', 'nothing changed');
});

// ---------------------------------------------------------------------------------------------
// CurseForge (scripts/curseforge.js)

test('interface numbers map to CurseForge game versions', () => {
  assert.deepStrictEqual(cf.interfaceToVersion('16001'), { type: 'forever', name: '1.60.1' });
  assert.deepStrictEqual(cf.interfaceToVersion('120105'), { type: 'retail', name: '12.1.5' });
  assert.deepStrictEqual(cf.interfaceToVersion('11507'), { type: 'classic', name: '1.15.7' });
  assert.throws(() => cf.interfaceToVersion('30403'), /game type/);
  assert.throws(() => cf.interfaceToVersion('abc'), /isn't an interface number/);
  assert.strictEqual(cf.releaseTypeFor('1.2.3-beta.1'), 'beta');
  assert.strictEqual(cf.releaseTypeFor('addon-v1.2.3-alpha'), 'alpha');
  assert.strictEqual(cf.releaseTypeFor('1.2.3'), 'release');
});

test('picks the exact game version, or the newest one below it', () => {
  const versions = [
    { id: 1, gameVersionTypeID: 517, name: '12.1.0' }, { id: 2, gameVersionTypeID: 517, name: '12.1.5' },
    { id: 3, gameVersionTypeID: 88568, name: '1.60.0' }, { id: 4, gameVersionTypeID: 88568, name: '1.61.0' },
    { id: 5, gameVersionTypeID: 67408, name: '1.60.1' },
  ];
  assert.deepStrictEqual(cf.pickVersion(versions, { type: 'retail', name: '12.1.5' }), { version: versions[1] });
  const p = cf.pickVersion(versions, { type: 'forever', name: '1.60.1' });
  assert.strictEqual(p.version.id, 3, 'never borrows a version from another game type');
  assert.match(p.warning, /no forever 1\.60\.1/);
  assert.throws(() => cf.pickVersion([], { type: 'forever', name: '1.60.1' }), /no forever/);
});

test('the real addon is ready for CurseForge: named, versioned, Forever and Retail', () => {
  const toc = cf.readAddonToc();
  assert.strictEqual(toc.title, 'Guild Camp');
  assert.ok(version.valid(toc.version));
  assert.deepStrictEqual(toc.interfaces.map((i) => cf.interfaceToVersion(i).type), ['forever', 'retail']);
  const { zip, files } = cf.buildZip();
  const names = readZip(zip).filter((e) => !e.isDir).map((e) => e.name);
  assert.deepStrictEqual(names, files);
  assert.ok(names.includes('WowGuild/WowGuild.toc'));
});

test('uploadToCurseForge sends the zip with tagged game versions', async () => {
  const zip = Buffer.from('zip bytes');
  const toc = { title: 'Guild Camp', version: '1.2.3-beta.1', interfaces: ['16001', '120105'], projectId: '' };
  const quiet = { onLog: () => {}, onWarn: () => {} };
  assert.deepStrictEqual(await cf.uploadToCurseForge({ zip, toc, token: '', dryRun: true, ...quiet }), { uploaded: false, metadata: null });
  await assert.rejects(cf.uploadToCurseForge({ zip, toc, token: '', ...quiet }), /CF_API_TOKEN is not set/);

  const calls = [];
  const fakeFetch = async (url, init = {}) => {
    calls.push({ url, init });
    if (url.endsWith('/game/wow/versions')) {
      return new Response(JSON.stringify([{ id: 11, gameVersionTypeID: 88568, name: '1.60.1' }, { id: 22, gameVersionTypeID: 517, name: '12.1.0' }]), { status: 200 });
    }
    return new Response(JSON.stringify({ id: 999 }), { status: 200 });
  };
  const dry = await cf.uploadToCurseForge({ zip, toc, token: 'cf', dryRun: true, fetch: fakeFetch, ...quiet });
  assert.deepStrictEqual(dry.metadata.gameVersions, [11, 22]);
  assert.strictEqual(dry.metadata.releaseType, 'beta');
  await assert.rejects(cf.uploadToCurseForge({ zip, toc, token: 'cf', fetch: fakeFetch, ...quiet }), /No CurseForge project id/);
  const up = await cf.uploadToCurseForge({ zip, toc, token: 'cf', projectId: '4242', notes: '- Better tips', fetch: fakeFetch, ...quiet });
  assert.strictEqual(up.uploaded, true);
  assert.deepStrictEqual(up.response, { id: 999 });
  const last = calls[calls.length - 1];
  assert.strictEqual(last.url, 'https://wow.curseforge.com/api/projects/4242/upload-file');
  assert.strictEqual(last.init.headers['X-Api-Token'], 'cf');
  const meta = JSON.parse(last.init.body.get('metadata'));
  assert.strictEqual(meta.changelog, '## Guild Camp 1.2.3-beta.1\n\n- Better tips\n');
  const file = last.init.body.get('file');
  assert.strictEqual(file.name, 'WowGuild-1.2.3-beta.1.zip');
  assert.strictEqual(Buffer.from(await file.arrayBuffer()).toString(), 'zip bytes');
});
