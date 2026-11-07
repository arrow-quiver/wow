// Release pipeline (app/src/shared/release.js), the release CLI (scripts/release.js) and the
// CurseForge helper (scripts/curseforge.js), against a fake publish server started here.
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
const { tocVersion } = require('../src/shared/toc');
const version = require('../src/shared/version');
const cli = require('../../scripts/release');
const cf = require('../../scripts/curseforge');

const REPO = path.join(__dirname, '..', '..');
const TOKEN = 'test-publish-token';

function tmpDir(t, label = 'gc-release-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), label));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const sha512b64 = (buf) => crypto.createHash('sha512').update(buf).digest('base64');

// A stand-in for the server's release endpoints. Records every request; behaves like the
// contract in docs/ARCHITECTURE.md "Release hosting".
async function fakeServer(t) {
  const state = { app: null, addon: null, files: {}, requests: [], failNext: null };
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url, 'http://x');
      state.requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body });
      const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (state.failNext) { const f = state.failNext; state.failNext = null; return f(req, res); }
      if (req.method === 'GET' && url.pathname === '/api/releases') return json(200, { app: state.app, addon: state.addon, history: [] });
      if (!url.pathname.startsWith('/api/publish/')) return json(404, { error: 'Not found.' });
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { error: 'That publish token is wrong.' });
      let m;
      if (req.method === 'PUT' && (m = /^\/api\/publish\/app\/files\/(.+)$/.exec(url.pathname))) {
        const name = decodeURIComponent(m[1]);
        if (!release.APP_FILE_RE.test(name)) return json(400, { error: 'Bad file name.' });
        if (Number(req.headers['content-length']) !== body.length) return json(400, { error: 'Length mismatch.' });
        if (req.headers['x-sha512'] !== sha512b64(body)) return json(400, { error: 'Checksum mismatch.' });
        state.files[name] = body;
        return json(200, { ok: true, name, size: body.length });
      }
      if (req.method === 'POST' && url.pathname === '/api/publish/app/commit') {
        const { version: v, notes, latestYml } = JSON.parse(body.toString('utf8'));
        const info = release.parseLatestYml(latestYml);
        for (const f of info.files) {
          const got = state.files[f.url];
          if (!got || sha512b64(got) !== f.sha512 || got.length !== f.size) return json(400, { error: `${f.url} is missing or different.` });
        }
        state.app = { version: v, notes, file: info.path };
        return json(200, { ok: true, version: v });
      }
      if (req.method === 'PUT' && url.pathname === '/api/publish/addon') {
        const toc = readZip(body).find((e) => e.name === 'WowGuild/WowGuild.toc');
        if (!toc) return json(400, { error: 'The zip has no WowGuild/WowGuild.toc.' });
        const v = tocVersion(toc.data.toString('utf8'));
        // Like the real server: the bundled addon (source 'bundled') never blocks an upload.
        if (state.addon && state.addon.source !== 'bundled' && !version.gt(v, state.addon.version) && url.searchParams.get('force') !== '1') {
          return json(409, { error: `Version ${v} isn't newer than ${state.addon.version}.` });
        }
        state.addon = { version: v, notes: url.searchParams.get('notes') };
        return json(200, { ok: true, version: v });
      }
      return json(404, { error: 'Not found.' });
    });
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => srv.close(resolve)));
  state.url = `http://127.0.0.1:${srv.address().port}`;
  return state;
}

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

// A whole repo checkout: addon/WowGuild, app/ (with a "dist" script that fakes electron-builder).
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
console.log('  • building        target=nsis file=dist/' + name);
`;
function fakeRepo(t, { addonVersion = '1.0.0', appVersion = '1.0.0', git: withGit = false } = {}) {
  const root = tmpDir(t, 'gc-repo-');
  fakeAddon(path.join(root, 'addon'), addonVersion);
  fs.rmSync(path.join(root, 'addon', 'WowGuild', '.git'), { recursive: true, force: true });
  const app = path.join(root, 'app');
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(app, 'package.json'), `{\n  "name": "guild-camp",\n  "version": "${appVersion}",\n  "private": true,\n  "scripts": {\n    "dist": "node make-dist.js"\n  }\n}\n`);
  fs.writeFileSync(path.join(app, 'make-dist.js'), MAKE_DIST);
  fs.writeFileSync(path.join(root, '.gitignore'), 'dist/\n');
  if (withGit) { gitInit(root); commitAll(root, 'Initial commit'); }
  return root;
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

// ---------------------------------------------------------------------------------------------
// Publishing

test('publishApp streams every file with its checksum, then commits latest.yml', async (t) => {
  const srv = await fakeServer(t);
  const dir = tmpDir(t);
  const { exeName, exe, yml } = fakeDist(dir, '0.11.1');
  const lines = [];
  const out = await release.publishApp({ server: `${srv.url}/`, token: TOKEN, distDir: dir, notes: 'Faster sync.\nNew Releases page.', onLog: (l) => lines.push(l) });
  assert.strictEqual(out.version, '0.11.1');
  assert.deepStrictEqual(out.result, { ok: true, version: '0.11.1' });
  assert.deepStrictEqual(srv.requests.map((r) => `${r.method} ${r.path}`), [
    `PUT /api/publish/app/files/${exeName}`, `PUT /api/publish/app/files/${exeName}.blockmap`, 'POST /api/publish/app/commit',
  ]);
  const put = srv.requests[0];
  assert.strictEqual(put.headers.authorization, `Bearer ${TOKEN}`);
  assert.strictEqual(put.headers['content-type'], 'application/octet-stream');
  assert.strictEqual(put.headers['content-length'], String(exe.length));
  assert.strictEqual(put.headers['x-sha512'], sha512b64(exe));
  assert.ok(put.body.equals(exe));
  const commit = JSON.parse(srv.requests[2].body.toString('utf8'));
  assert.deepStrictEqual(commit, { version: '0.11.1', notes: 'Faster sync.\nNew Releases page.', latestYml: yml });
  assert.strictEqual(srv.requests[2].headers['content-type'], 'application/json');
  assert.deepStrictEqual(srv.app, { version: '0.11.1', notes: 'Faster sync.\nNew Releases page.', file: exeName });
  assert.ok(lines.some((l) => /Uploading Guild-Camp-Setup-0\.11\.1\.exe \(3\.0 MB\)/.test(l)));
  assert.ok(lines.some((l) => /\d0% \(/.test(l)), 'progress lines for a big file');
  assert.ok(/is live/.test(lines[lines.length - 1]));
});

test('publishApp refuses a build that does not match latest.yml before uploading anything', async (t) => {
  const srv = await fakeServer(t);
  const dir = tmpDir(t);
  const { exeName } = fakeDist(dir, '0.11.1');
  fs.appendFileSync(path.join(dir, exeName), 'tampered');
  await assert.rejects(release.publishApp({ server: srv.url, token: TOKEN, distDir: dir }), (e) => e.code === 'MISMATCH');
  assert.strictEqual(srv.requests.length, 0);
  await assert.rejects(release.publishApp({ server: srv.url, token: '', distDir: dir }), (e) => e.code === 'NO_TOKEN');
  await assert.rejects(release.publishApp({ server: 'wow.example.com', token: TOKEN, distDir: dir }), (e) => e.code === 'BAD_SERVER');
});

test('publishAddon uploads the zip with notes and force in the query string', async (t) => {
  const srv = await fakeServer(t);
  const dir = tmpDir(t);
  const addon = fakeAddon(dir, '1.0.0');
  const notes = 'Fixes & tweaks: "quotes", ünïcödé, 100% more\nsecond line?=';
  const lines = [];
  const res = await release.publishAddon({ server: srv.url, token: TOKEN, pack: release.packAddon(addon), notes, onLog: (l) => lines.push(l) });
  assert.deepStrictEqual(res, { ok: true, version: '1.0.0' });
  const req = srv.requests[0];
  assert.strictEqual(req.method, 'PUT');
  assert.strictEqual(req.path, '/api/publish/addon');
  assert.deepStrictEqual(req.query, { notes, force: '0' });
  assert.strictEqual(req.headers.authorization, `Bearer ${TOKEN}`);
  assert.strictEqual(req.headers['content-type'], 'application/zip');
  assert.strictEqual(req.headers['x-sha256'], crypto.createHash('sha256').update(req.body).digest('hex'));
  assert.ok(readZip(req.body).some((e) => e.name === 'WowGuild/WowGuild.toc'));
  assert.ok(lines.some((l) => /is live/.test(l)));

  // The same version again is refused by the server; --force rolls back.
  await assert.rejects(release.publishAddon({ server: srv.url, token: TOKEN, pack: release.packAddon(addon) }),
    (e) => e.status === 409 && /isn't newer than 1\.0\.0/.test(e.message));
  await release.publishAddon({ server: srv.url, token: TOKEN, pack: release.packAddon(addon), force: true });
  assert.strictEqual(srv.requests[srv.requests.length - 1].query.force, '1');
  await assert.rejects(release.publishAddon({ server: srv.url, token: TOKEN, pack: null }), (e) => e.code === 'NO_PACK');
  await assert.rejects(release.publishAddon({ server: srv.url, token: TOKEN, pack: release.packAddon(addon), notes: 'x'.repeat(13000) }), (e) => e.code === 'NOTES_TOO_LONG');
});

test('server errors come back as plain sentences', async (t) => {
  const srv = await fakeServer(t);
  const dir = tmpDir(t);
  const pack = release.packAddon(fakeAddon(dir));
  await assert.rejects(release.publishAddon({ server: srv.url, token: 'wrong', pack }),
    (e) => e instanceof release.ReleaseError && e.status === 401 && /That publish token is wrong/.test(e.message) && /Check the publish token/.test(e.message));
  // The server's own full stop and trailing spaces are trimmed, never letters ("updates." stays "updates").
  srv.failNext = (req, res) => { res.writeHead(403, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Only the owner can publish updates. ' })); };
  await assert.rejects(release.publishAddon({ server: srv.url, token: TOKEN, pack }),
    (e) => e.status === 403 && e.message === 'The server refused the request (403): Only the owner can publish updates. Check the publish token.');
  srv.failNext = (req, res) => { res.writeHead(500, { 'Content-Type': 'text/html' }); res.end('<h1>Bad Gateway</h1>'); };
  await assert.rejects(release.publishAddon({ server: srv.url, token: TOKEN, pack }), (e) => e.status === 500 && /Bad Gateway/.test(e.message));
  srv.failNext = (req, res) => { res.writeHead(301, { Location: 'https://elsewhere.example/api' }); res.end(); };
  await assert.rejects(release.publishAddon({ server: srv.url, token: TOKEN, pack }), (e) => e.code === 'REDIRECT' && /elsewhere\.example/.test(e.message));
  srv.failNext = (req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html>hello</html>'); };
  await assert.rejects(release.getReleases(srv.url), (e) => e.code === 'NOT_JSON');
  srv.failNext = (req, res) => { res.writeHead(413); res.end(); };
  await assert.rejects(release.publishAddon({ server: srv.url, token: TOKEN, pack }), (e) => e.status === 413 && /too big/.test(e.message));
  // Nothing listening: a network error that says what to check.
  const closed = http.createServer();
  await new Promise((r) => closed.listen(0, '127.0.0.1', r));
  const deadUrl = `http://127.0.0.1:${closed.address().port}`;
  await new Promise((r) => closed.close(r));
  await assert.rejects(release.getReleases(deadUrl), (e) => e.code === 'NETWORK' && /Couldn't reach/.test(e.message));
});

test('getReleases reads what is published', async (t) => {
  const srv = await fakeServer(t);
  assert.deepStrictEqual(await release.getReleases(srv.url), { app: null, addon: null, history: [] });
  srv.addon = { version: '1.2.3' };
  assert.strictEqual((await release.getReleases(`${srv.url}///`)).addon.version, '1.2.3');
  assert.strictEqual(srv.requests[0].headers.authorization, undefined, 'no token needed');
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
  git(root, 'tag', 'app-v1.0.0');
  fs.appendFileSync(path.join(root, 'addon', 'WowGuild', 'Core.lua'), '-- 1\n'); commitAll(root, 'Addon: fix the tooltip');
  fs.appendFileSync(path.join(root, 'app', 'make-dist.js'), '// 1\n'); commitAll(root, 'App: faster sync');
  fs.appendFileSync(path.join(root, 'addon', 'WowGuild', 'Core.lua'), '-- 2\n'); commitAll(root, 'Release addon 1.0.1');
  fs.appendFileSync(path.join(root, 'addon', 'WowGuild', 'Core.lua'), '-- 3\n'); commitAll(root, 'Addon: new coach tips');
  assert.strictEqual(release.gitChangelog(root, 'addon'), '- Addon: new coach tips\n- Addon: fix the tooltip');
  assert.strictEqual(release.gitChangelog(root, 'app'), '- App: faster sync');
  // In CI the new tag sits on HEAD: it is skipped, so the notes still cover the whole release.
  git(root, 'tag', 'addon-v1.0.1');
  assert.strictEqual(release.gitChangelog(root, 'addon'), '- Addon: new coach tips\n- Addon: fix the tooltip');
  fs.writeFileSync(path.join(root, 'README.md'), 'x'); commitAll(root, 'Docs only');
  assert.strictEqual(release.gitChangelog(root, 'addon'), '- Maintenance release.');
  assert.strictEqual(release.gitChangelog(os.tmpdir(), 'app'), '- Maintenance release.', 'outside git: a placeholder');
  assert.throws(() => release.gitChangelog(root, 'server'), /kind must be/);
});

// ---------------------------------------------------------------------------------------------
// CLI (scripts/release.js)

function cliRun(argv, { root, env = {}, fetchImpl, buildApp } = {}) {
  const lines = []; const warnings = [];
  const p = cli.run(argv, { root, env, log: (l) => lines.push(l), warn: (l) => warnings.push(l), fetch: fetchImpl, buildApp });
  return p.then((result) => ({ result, lines, warnings, text: lines.join('\n') }));
}

test('CLI arguments are checked', () => {
  assert.deepStrictEqual(cli.parseArgs(['addon', '--bump', 'patch', '--notes=Hello there', '--git']).flags, { bump: 'patch', notes: 'Hello there', git: true });
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
});

test('CLI config: flags beat environment beat .release.json beat the default', (t) => {
  const root = tmpDir(t);
  assert.deepStrictEqual(cli.loadConfig({ root, env: {} }), { server: cli.DEFAULT_SERVER, serverFrom: 'default', token: '', tokenFrom: null });
  fs.writeFileSync(path.join(root, '.release.json'), JSON.stringify({ server: 'https://file.example/', token: 'from-file' }));
  assert.deepStrictEqual(cli.loadConfig({ root, env: {} }), { server: 'https://file.example', serverFrom: '.release.json', token: 'from-file', tokenFrom: '.release.json' });
  const env = { GUILDCAMP_SERVER: 'https://env.example', GUILDCAMP_PUBLISH_TOKEN: 'from-env' };
  assert.deepStrictEqual(cli.loadConfig({ root, env }), { server: 'https://env.example', serverFrom: 'GUILDCAMP_SERVER', token: 'from-env', tokenFrom: 'GUILDCAMP_PUBLISH_TOKEN' });
  assert.deepStrictEqual(cli.loadConfig({ root, env, flags: { server: 'https://flag.example', token: 'from-flag' } }),
    { server: 'https://flag.example', serverFrom: '--server', token: 'from-flag', tokenFrom: '--token' });
  fs.writeFileSync(path.join(root, '.release.json'), '{ not json');
  assert.throws(() => cli.loadConfig({ root, env: {} }), /isn't valid JSON/);
});

test('CLI addon: bump, zip, upload, commit and tag', async (t) => {
  if (!hasGit()) { t.skip('git is not installed'); return; }
  const srv = await fakeServer(t);
  const root = fakeRepo(t, { addonVersion: '1.0.0', git: true });
  const env = { GUILDCAMP_SERVER: srv.url, GUILDCAMP_PUBLISH_TOKEN: TOKEN };
  srv.addon = { version: '1.0.0' };
  // Same version as the server: refused before anything changes.
  await assert.rejects(cliRun(['addon'], { root, env }), /already has addon 1\.0\.0.*--bump patch/);
  assert.strictEqual(release.readAddonVersion(path.join(root, 'addon')), '1.0.0');

  const { text, result } = await cliRun(['addon', '--bump', 'patch', '--notes', 'Tooltip fix', '--git'], { root, env });
  assert.strictEqual(result[0].version, '1.0.1');
  assert.strictEqual(srv.addon.version, '1.0.1');
  assert.strictEqual(srv.addon.notes, 'Tooltip fix');
  assert.match(text, /1\.0\.0 → 1\.0\.1/);
  assert.match(text, /Tagged addon-v1\.0\.1/);
  assert.strictEqual(git(root, 'log', '-1', '--format=%s'), 'Release addon 1.0.1');
  assert.strictEqual(git(root, 'status', '--porcelain'), '', 'the bump is committed');
  assert.strictEqual(git(root, 'describe', '--tags', '--exact-match'), 'addon-v1.0.1');

  // --skip-published (CI after a laptop release): nothing uploaded, no error.
  const before = srv.requests.length;
  const skipped = await cliRun(['addon', '--no-bump', '--skip-published', '--notes-from-git'], { root, env });
  assert.strictEqual(skipped.result[0].skipped, true);
  assert.match(skipped.text, /already has addon 1\.0\.1\. Nothing to upload/);
  assert.deepStrictEqual(srv.requests.slice(before).map((r) => r.method), ['GET']);

  // Rollback: an older version with --force.
  await cliRun(['addon', '--version', '1.0.0', '--force', '--notes', 'Roll back'], { root, env });
  assert.strictEqual(srv.addon.version, '1.0.0');
  assert.strictEqual(srv.requests[srv.requests.length - 1].query.force, '1');
});

test('CLI addon --dry-run zips into dist/ and uploads nothing; a missing token explains itself', async (t) => {
  const srv = await fakeServer(t);
  const root = fakeRepo(t, { addonVersion: '2.3.4' });
  const { text } = await cliRun(['addon', '--dry-run'], { root, env: { GUILDCAMP_SERVER: srv.url } });
  const zipFile = path.join(root, 'dist', 'WowGuild-2.3.4.zip');
  assert.ok(fs.existsSync(zipFile));
  assert.ok(text.includes(zipFile));
  assert.ok(readZip(fs.readFileSync(zipFile)).some((e) => e.name === 'WowGuild/WowGuild.toc'));
  assert.ok(srv.requests.every((r) => r.method === 'GET'), 'nothing uploaded');

  await assert.rejects(cliRun(['addon'], { root, env: { GUILDCAMP_SERVER: srv.url } }),
    (e) => e.code === 'NO_TOKEN' && /On the server, set PUBLISH_TOKEN/.test(e.message) && /GUILDCAMP_PUBLISH_TOKEN/.test(e.message) && /\.release\.json/.test(e.message));
  await assert.rejects(cliRun(['addon', '--token', 'wrong'], { root, env: { GUILDCAMP_SERVER: srv.url } }), (e) => e.status === 401);
  await assert.rejects(cliRun(['ship'], { root }), /Unknown command "ship"/);
  await assert.rejects(cliRun([], { root }), /Pass a command/);
  await assert.rejects(cliRun(['addon', 'stray words'], { root }), /Put notes in quotes/);
  const help = await cliRun(['--help'], { root });
  assert.match(help.text, /Usage: node scripts\/release\.js/);
});

test('CLI app: bump, build with npm run dist, upload, commit latest.yml', async (t) => {
  const srv = await fakeServer(t);
  const root = fakeRepo(t, { appVersion: '0.11.0' });
  srv.app = { version: '0.11.0' };
  const env = { GUILDCAMP_SERVER: srv.url, GUILDCAMP_PUBLISH_TOKEN: TOKEN };
  await assert.rejects(cliRun(['app', '--no-bump'], { root, env }), /already has app 0\.11\.0/);
  const { text, result } = await cliRun(['app', '--bump', 'minor', '--notes', 'New look'], { root, env });
  assert.strictEqual(result[0].version, '0.12.0');
  assert.strictEqual(release.readAppVersion(path.join(root, 'app')), '0.12.0');
  assert.match(text, /building\s+target=nsis/, 'the build output is streamed');
  assert.deepStrictEqual(srv.requests.filter((r) => r.method !== 'GET').map((r) => `${r.method} ${r.path}`), [
    'PUT /api/publish/app/files/Guild-Camp-Setup-0.12.0.exe', 'PUT /api/publish/app/files/Guild-Camp-Setup-0.12.0.exe.blockmap', 'POST /api/publish/app/commit',
  ]);
  assert.deepStrictEqual(srv.app, { version: '0.12.0', notes: 'New look', file: 'Guild-Camp-Setup-0.12.0.exe' });

  // A build step that leaves an older dist/ behind is caught instead of being published.
  const before = srv.requests.length;
  const noBuild = async (appDir) => ({ distDir: path.join(appDir, 'dist') });
  await assert.rejects(cliRun(['app', '--bump', 'patch'], { root, env, buildApp: noBuild }), /is version 0\.12\.0, but app\/package\.json says 0\.12\.1/);
  assert.ok(srv.requests.slice(before).every((r) => r.method === 'GET'), 'nothing uploaded');

  // A dry run builds but uploads nothing, and says where the files are.
  const dry = await cliRun(['app', '--no-bump', '--dry-run'], { root, env });
  const exe = path.join(root, 'app', 'dist', 'Guild-Camp-Setup-0.12.1.exe');
  assert.ok(fs.existsSync(exe));
  assert.ok(dry.text.includes(exe));
  assert.ok(srv.requests.slice(before).every((r) => r.method === 'GET'), 'still nothing uploaded');
});

test('CLI status shows local and published versions', async (t) => {
  const srv = await fakeServer(t);
  const root = fakeRepo(t, { addonVersion: '1.1.0', appVersion: '0.11.0' });
  srv.addon = { version: '1.0.0' };
  srv.app = { version: '0.11.0' };
  const { text, result } = await cliRun(['status'], { root, env: { GUILDCAMP_SERVER: srv.url } });
  assert.deepStrictEqual(result.local, { addon: '1.1.0', app: '0.11.0' });
  assert.match(text, /Addon\s+1\.1\.0\s+1\.0\.0/);
  assert.match(text, /App\s+0\.11\.0\s+0\.11\.0/);
  assert.match(text, /The addon 1\.1\.0 isn't published yet/);
  assert.match(text, /Token:\s+not set/);
  // An unreachable server still shows the local side.
  const offline = await cliRun(['status'], { root, env: { GUILDCAMP_SERVER: 'http://127.0.0.1:9' } });
  assert.match(offline.text, /Addon\s+1\.1\.0\s+\?/);
  assert.ok(offline.warnings.some((w) => /Couldn't check/.test(w)));
});

test('CLI: the addon bundled with the server counts as not published', async (t) => {
  const srv = await fakeServer(t);
  const root = fakeRepo(t, { addonVersion: '1.1.0', appVersion: '0.11.0' });
  const env = { GUILDCAMP_SERVER: srv.url, GUILDCAMP_PUBLISH_TOKEN: TOKEN };
  // A fresh server offers the addon from its image (the same version as the checkout here).
  srv.addon = { version: '1.1.0', source: 'bundled' };
  const st = await cliRun(['status'], { root, env });
  assert.match(st.text, /Addon\s+1\.1\.0\s+none \(bundled 1\.1\.0\)/);
  assert.match(st.text, /The addon 1\.1\.0 isn't published yet/);

  // --skip-published doesn't skip it, and the first release isn't refused as "not newer".
  const { text, result } = await cliRun(['addon', '--no-bump', '--skip-published', '--notes', 'First release'], { root, env });
  assert.strictEqual(result[0].version, '1.1.0');
  assert.notStrictEqual(result[0].skipped, true);
  assert.doesNotMatch(text, /Nothing to upload/);
  const put = srv.requests.find((r) => r.method === 'PUT' && r.path === '/api/publish/addon');
  assert.ok(put, 'uploaded');
  assert.strictEqual(put.query.force, '0', 'not sent as a roll back');
  assert.deepStrictEqual(srv.addon, { version: '1.1.0', notes: 'First release' });

  // A bundled addon newer than the checkout doesn't block either.
  srv.addon = { version: '9.0.0', source: 'bundled' };
  assert.strictEqual((await cliRun(['addon', '--bump', 'patch', '--notes', 'x'], { root, env })).result[0].version, '1.1.1');
  assert.strictEqual(srv.addon.version, '1.1.1');
});

test('CLI --tag-only --push bumps, commits, tags and pushes without uploading', async (t) => {
  if (!hasGit()) { t.skip('git is not installed'); return; }
  const srv = await fakeServer(t);
  const root = fakeRepo(t, { addonVersion: '1.0.0', appVersion: '0.11.0', git: true });
  const remote = tmpDir(t, 'gc-remote-');
  git(remote, 'init', '-q', '--bare');
  git(root, 'remote', 'add', 'origin', remote);
  const env = { GUILDCAMP_SERVER: srv.url };
  const { text } = await cliRun(['all', '--bump', 'patch', '--tag-only', '--push'], { root, env });
  assert.strictEqual(srv.requests.length, 0, 'no server calls at all');
  assert.match(text, /Pushed the commit and addon-v1\.0\.1/);
  assert.match(text, /Pushed the commit and app-v0\.11\.1/);
  assert.deepStrictEqual(git(remote, 'tag', '--list').split(/\r?\n/).sort(), ['addon-v1.0.1', 'app-v0.11.1']);
  assert.strictEqual(git(remote, 'log', '-1', '--format=%s', 'main'), 'Release app 0.11.1');
  // The same tag twice is refused up front.
  git(root, 'tag', 'addon-v1.0.2');
  await assert.rejects(cliRun(['addon', '--bump', 'patch', '--tag-only'], { root, env }), /tag addon-v1\.0\.2 already exists/);
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
