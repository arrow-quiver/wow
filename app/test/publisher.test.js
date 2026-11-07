// The Releases page backend (src/main/publisher.js): temp source checkouts, a fake `npm run dist`,
// and a local HTTP server that behaves like the server's publish endpoints.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const { createPublisher, findRepoFrom, looksLikeRepo, cleanBump, cleanNotes } = require('../src/main/publisher');
const { createApi } = require('../src/main/api');
const { createStore } = require('../src/main/store');
const release = require('../src/shared/release');
const { readZip } = require('../src/shared/zip');
const { tocVersion } = require('../src/shared/toc');
const version = require('../src/shared/version');

const OWNER_TOKEN = 'gcd_owner_device_token';
const sha512b64 = (buf) => crypto.createHash('sha512').update(buf).digest('base64');

function tmpDir(t, label = 'gc-publisher-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), label));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
}

// Writes dist/latest.yml + installer + blockmap for whatever version package.json says, like
// electron-builder does. Used as the checkout's "npm run dist".
const FAKE_BUILD = `
const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const v = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version;
console.log('  \\u2022 fake electron-builder  version=26');
const dist = path.join(__dirname, 'dist'); fs.mkdirSync(dist, { recursive: true });
const exe = 'Guild-Camp-Setup-' + v + '.exe';
const data = Buffer.from('MZ fake installer ' + v + ' ' + 'x'.repeat(4096));
fs.writeFileSync(path.join(dist, exe), data);
fs.writeFileSync(path.join(dist, exe + '.blockmap'), Buffer.from('blockmap ' + v));
const sha = crypto.createHash('sha512').update(data).digest('base64');
fs.writeFileSync(path.join(dist, 'latest.yml'), 'version: ' + v + '\\nfiles:\\n  - url: ' + exe + '\\n    sha512: ' + sha + '\\n    size: ' + data.length + '\\npath: ' + exe + '\\nsha512: ' + sha + "\\nreleaseDate: '2026-11-07T10:00:00.000Z'\\n");
console.log('  \\u2022 building        target=nsis file=dist/' + exe);
`;

// A source checkout: app/ (package.json with the fake dist script) and addon/WowGuild.
function makeRepo(t, { appVersion = '1.0.0', addonVersion = '1.0.0' } = {}) {
  const root = tmpDir(t);
  fs.mkdirSync(path.join(root, 'app', 'src', 'main'), { recursive: true });
  fs.writeFileSync(path.join(root, 'app', 'package.json'), `${JSON.stringify({ name: 'guild-camp', version: appVersion, private: true, scripts: { dist: 'node build.js' } }, null, 2)}\n`);
  fs.writeFileSync(path.join(root, 'app', 'build.js'), FAKE_BUILD);
  const addon = path.join(root, 'addon', 'WowGuild');
  fs.mkdirSync(path.join(addon, 'Data'), { recursive: true });
  fs.writeFileSync(path.join(addon, 'WowGuild.toc'), `## Interface: 11507\r\n## Title: Guild Camp\r\n## Version: ${addonVersion}\r\n## SavedVariables: WowGuildDB\r\n\r\nWowGuild.lua\r\n`);
  fs.writeFileSync(path.join(addon, 'WowGuild.lua'), 'WowGuild = WowGuild or {}\n');
  fs.writeFileSync(path.join(addon, 'Data', 'Items.lua'), 'WowGuild.items = {}\n');
  return { root, appDir: path.join(root, 'app'), addonDir: addon };
}

// The server's release endpoints (docs/ARCHITECTURE.md "Release hosting"), accepting only the
// owner's device token.
async function fakeServer(t) {
  const state = { app: null, addon: null, history: [], files: {}, requests: [], failNext: null, noReleases: false };
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url, 'http://x');
      state.requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body });
      const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (state.failNext && url.pathname.startsWith('/api/publish/')) { const f = state.failNext; state.failNext = null; return f(req, res, json); }
      if (req.method === 'GET' && url.pathname === '/api/releases') {
        if (state.noReleases) return json(404, { error: 'Not found.' });
        return json(200, { app: state.app, addon: state.addon, history: state.history });
      }
      if (!url.pathname.startsWith('/api/publish/')) return json(404, { error: 'Not found.' });
      if (req.headers.authorization !== `Bearer ${OWNER_TOKEN}`) return json(403, { error: 'Only the guild owner can publish.' });
      let m;
      if (req.method === 'PUT' && url.pathname === '/api/publish/addon') {
        const entries = readZip(body);
        const tocEntry = entries.find((e) => e.name === 'WowGuild/WowGuild.toc');
        if (!tocEntry) return json(400, { error: 'The zip has no WowGuild/WowGuild.toc.' });
        const v = tocVersion(tocEntry.data.toString('utf8'));
        const force = url.searchParams.get('force') === '1';
        // Like the real server: the bundled addon (source 'bundled') never blocks an upload.
        if (state.addon && state.addon.source !== 'bundled' && !version.gt(v, state.addon.version) && !force) return json(409, { error: `Addon ${v} isn't newer than ${state.addon.version}.` });
        state.addon = { version: v, notes: url.searchParams.get('notes') || '', publishedAt: '2026-11-07 10:00:00', size: body.length };
        state.addonZip = entries;
        state.history.unshift({ kind: 'addon', version: v, notes: state.addon.notes, publishedAt: state.addon.publishedAt, by: 'Owner#1' });
        return json(200, { ok: true, kind: 'addon', version: v });
      }
      if (req.method === 'PUT' && (m = /^\/api\/publish\/app\/files\/(.+)$/.exec(url.pathname))) {
        const name = decodeURIComponent(m[1]);
        if (!release.APP_FILE_RE.test(name)) return json(400, { error: 'Bad file name.' });
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
        if (state.app && !version.gt(v, state.app.version)) return json(409, { error: `App ${v} isn't newer than ${state.app.version}.` });
        state.app = { version: v, notes, publishedAt: '2026-11-07 10:00:00', file: info.path };
        state.history.unshift({ kind: 'app', version: v, notes, publishedAt: state.app.publishedAt, by: 'Owner#1' });
        return json(200, { ok: true, kind: 'app', version: v });
      }
      return json(404, { error: 'Not found.' });
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => srv.close(r)));
  state.url = `http://127.0.0.1:${srv.address().port}`;
  return state;
}

function setup(t, { repo, server, role = 'owner', signedIn = true, isPackaged = false, appDir, buildApp, settings } = {}) {
  const userData = tmpDir(t, 'gc-publisher-ud-');
  const store = createStore(userData);
  store.set({ serverUrl: server.url, ...(settings || {}) });
  const getServer = () => store.get().serverUrl;
  const getToken = () => (signedIn ? OWNER_TOKEN : null);
  const api = createApi({ getServer, getToken, appVersion: '0.11.0' });
  const auth = { state: () => ({ signedIn, role: signedIn ? role : null }) };
  const logged = [];
  const log = { info: (m) => logged.push(['info', m]), warn: (m) => logged.push(['warn', m]), error: (m) => logged.push(['error', m]) };
  const publisher = createPublisher({
    store, log, auth, api, getServer, getToken, appVersion: '0.11.0', isPackaged,
    appDir: appDir || (repo ? repo.appDir : userData), buildApp,
  });
  const lines = [];
  publisher.on('log', (entry) => lines.push(entry));
  return { store, publisher, lines, logged };
}

const readToc = (dir) => tocVersion(fs.readFileSync(path.join(dir, 'WowGuild.toc'), 'utf8'));
const readPkg = (appDir) => JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8')).version;

// ---------------------------------------------------------------------------------------------

test('finds the checkout by walking up from the running app', (t) => {
  const repo = makeRepo(t);
  assert.ok(looksLikeRepo(repo.root));
  assert.strictEqual(findRepoFrom(path.join(repo.appDir, 'src', 'main')), repo.root);
  assert.strictEqual(findRepoFrom(repo.appDir), repo.root);
  assert.strictEqual(findRepoFrom(tmpDir(t)), null);
});

test('status: the owner of a dev build sees the checkout, its versions and what is published', async (t) => {
  const repo = makeRepo(t, { appVersion: '1.2.0', addonVersion: '1.0.3' });
  const server = await fakeServer(t);
  server.addon = { version: '1.0.2', notes: 'Old.', publishedAt: '2026-11-01 10:00:00' };
  server.history = [{ kind: 'addon', version: '1.0.2', notes: 'Old.', publishedAt: '2026-11-01 10:00:00', by: 'Owner#1' }];
  const { publisher } = setup(t, { repo, server });
  const st = await publisher.status();
  assert.strictEqual(st.canPublish, true);
  assert.strictEqual(st.reason, null);
  assert.strictEqual(st.isPackaged, false);
  assert.strictEqual(st.repoDir, repo.root);
  assert.strictEqual(st.repoSource, 'detected');
  assert.deepStrictEqual(st.addonSource, { dir: repo.addonDir, version: '1.0.3' });
  assert.deepStrictEqual(st.appSource, { dir: repo.appDir, version: '1.2.0' });
  assert.strictEqual(st.appVersion, '1.2.0');
  assert.strictEqual(st.runningVersion, '0.11.0');
  assert.strictEqual(st.published.addon.version, '1.0.2');
  assert.strictEqual(st.published.app, null);
  assert.strictEqual(st.published.history.length, 1);
  assert.strictEqual(st.publishedError, null);
  assert.strictEqual(st.building, false);
  assert.strictEqual(st.changelog, null, 'no .git, no suggestions');
});

test('status: installed builds need a chosen folder; members and signed-out people cannot publish', async (t) => {
  const repo = makeRepo(t);
  const server = await fakeServer(t);
  server.noReleases = true;
  const packaged = setup(t, { repo, server, isPackaged: true, appDir: path.join(tmpDir(t), 'resources', 'app.asar') });
  let st = await packaged.publisher.status();
  assert.strictEqual(st.repoDir, null);
  assert.strictEqual(st.addonSource, null);
  assert.strictEqual(st.appVersion, '0.11.0', 'falls back to the running version');
  assert.strictEqual(st.published, null);
  assert.match(st.publishedError, /doesn't take releases yet/);

  st = await setup(t, { repo, server, role: 'officer' }).publisher.status();
  assert.strictEqual(st.canPublish, false);
  assert.strictEqual(st.reason, 'Only the guild owner can publish releases.');
  st = await setup(t, { repo, server, signedIn: false }).publisher.status();
  assert.strictEqual(st.canPublish, false);
  assert.match(st.reason, /Sign in/);
});

test('setRepoDir accepts the checkout (or its app folder), refuses other folders, and null resets', async (t) => {
  const repo = makeRepo(t);
  const server = await fakeServer(t);
  const { publisher, store } = setup(t, { repo, server, isPackaged: true, appDir: tmpDir(t) });
  let st = await publisher.setRepoDir(path.join(repo.root, 'app'));
  assert.strictEqual(st.repoDir, repo.root);
  assert.strictEqual(st.repoSource, 'chosen');
  assert.strictEqual(store.get().repoDir, repo.root);
  st = await publisher.setRepoDir(repo.addonDir);
  assert.strictEqual(st.repoDir, repo.root);
  await assert.rejects(publisher.setRepoDir(tmpDir(t)), (e) => e.status === 400 && /isn't a Guild Camp source checkout/.test(e.message));
  await assert.rejects(publisher.setRepoDir('relative/path'), (e) => e.status === 400);
  st = await publisher.setRepoDir(null);
  assert.strictEqual(store.get().repoDir, null);
  assert.strictEqual(st.repoDir, null);

  // A chosen folder that disappears is reported, not silently used.
  store.set({ repoDir: path.join(repo.root, 'gone') });
  st = await publisher.status();
  assert.strictEqual(st.repoDir, null);
  assert.match(st.repoProblem, /isn't a Guild Camp checkout any more/);
});

test('publishAddon bumps the toc, zips WowGuild/ and uploads it with the owner token', async (t) => {
  const repo = makeRepo(t, { addonVersion: '1.0.0' });
  const server = await fakeServer(t);
  server.addon = { version: '1.0.0', notes: '', publishedAt: '2026-11-01 10:00:00' };
  const { publisher, lines } = setup(t, { repo, server });
  const out = await publisher.publishAddon({ bump: 'patch', notes: 'Tooltips show guild bank stock.\r\nFaster sync.' });
  assert.strictEqual(out.kind, 'addon');
  assert.strictEqual(out.version, '1.0.1');
  assert.strictEqual(out.previous, '1.0.0');
  assert.deepStrictEqual(out.result, { ok: true, kind: 'addon', version: '1.0.1' });
  assert.strictEqual(readToc(repo.addonDir), '1.0.1');
  assert.ok(fs.readFileSync(path.join(repo.addonDir, 'WowGuild.toc'), 'utf8').includes('\r\n'), 'keeps CRLF line endings');

  const upload = server.requests.find((r) => r.path === '/api/publish/addon');
  assert.strictEqual(upload.headers.authorization, `Bearer ${OWNER_TOKEN}`);
  assert.strictEqual(upload.query.notes, 'Tooltips show guild bank stock.\nFaster sync.');
  assert.strictEqual(upload.query.force, '0');
  const names = server.addonZip.map((e) => e.name);
  assert.ok(names.includes('WowGuild/WowGuild.lua'));
  assert.ok(names.includes('WowGuild/Data/Items.lua'));
  assert.strictEqual(server.addon.version, '1.0.1');

  const text = lines.map((l) => l.line);
  assert.ok(text.some((l) => /Addon version: 1\.0\.0 → 1\.0\.1/.test(l)));
  assert.ok(text.some((l) => /Packed 3 files: WowGuild-1\.0\.1\.zip/.test(l)));
  assert.ok(text.some((l) => /is live/.test(l)));
  assert.ok(lines.every((l) => l.kind === 'addon' && l.t && l.level));
  const st = await publisher.status();
  assert.strictEqual(st.lastResult.version, '1.0.1');
  assert.ok(st.log.length >= 3, 'status keeps the log for a page that opens later');
});

test('publishAddon refuses a version that is not newer before touching anything; force rolls back', async (t) => {
  const repo = makeRepo(t, { addonVersion: '1.0.0' });
  const server = await fakeServer(t);
  server.addon = { version: '1.0.1', notes: '', publishedAt: '2026-11-01 10:00:00' };
  const { publisher } = setup(t, { repo, server });
  await assert.rejects(publisher.publishAddon({ bump: null }),
    (e) => e.status === 409 && e.code === 'not-newer' && /already has addon 1\.0\.1, and 1\.0\.0 isn't newer/.test(e.message) && /Roll back/.test(e.message));
  await assert.rejects(publisher.publishAddon({ bump: 'patch' }), (e) => e.code === 'not-newer');
  assert.strictEqual(readToc(repo.addonDir), '1.0.0', 'toc untouched');
  assert.ok(!server.requests.some((r) => r.path === '/api/publish/addon'), 'nothing uploaded');

  const out = await publisher.publishAddon({ force: true, notes: 'Rolled back.' });
  assert.strictEqual(out.version, '1.0.0');
  assert.strictEqual(server.requests.find((r) => r.path === '/api/publish/addon').query.force, '1');
  assert.strictEqual(server.addon.version, '1.0.0');
});

test('the addon bundled with the server is not a published release: the first upload goes ahead', async (t) => {
  const repo = makeRepo(t, { addonVersion: '1.0.0' });
  const server = await fakeServer(t);
  // A fresh server offers the addon from its image, with the same or a newer version than the checkout.
  server.addon = { version: '1.0.0', notes: null, publishedAt: null, sha256: 'abc', size: 10, url: '/updates/addon/WowGuild-1.0.0.zip', source: 'bundled' };
  const { publisher } = setup(t, { repo, server });
  const out = await publisher.publishAddon({ bump: null, notes: 'First release.' });
  assert.strictEqual(out.version, '1.0.0');
  const put = server.requests.find((r) => r.path === '/api/publish/addon');
  assert.ok(put, 'uploaded');
  assert.notStrictEqual(put.query.force, '1', 'not sent as a roll back');
  assert.strictEqual(server.addon.version, '1.0.0');
  assert.strictEqual(server.addon.source, undefined, 'now a real release');

  // A bundled addon newer than the checkout doesn't block either.
  const repo2 = makeRepo(t, { addonVersion: '1.0.0' });
  const server2 = await fakeServer(t);
  server2.addon = { version: '2.0.0', source: 'bundled' };
  const { publisher: p2 } = setup(t, { repo: repo2, server: server2 });
  assert.strictEqual((await p2.publishAddon({ bump: 'patch' })).version, '1.0.1');
  assert.strictEqual(server2.addon.version, '1.0.1');
});

test('a failed addon upload puts the toc version back', async (t) => {
  const repo = makeRepo(t, { addonVersion: '2.3.4' });
  const server = await fakeServer(t);
  server.failNext = (_req, _res, json) => json(500, { error: 'Disk full on the server.' });
  const { publisher, lines } = setup(t, { repo, server });
  await assert.rejects(publisher.publishAddon({ bump: 'minor' }), (e) => /Disk full on the server/.test(e.message) && !e.stack.includes('ReleaseError:'));
  assert.strictEqual(readToc(repo.addonDir), '2.3.4');
  assert.ok(lines.some((l) => /Put WowGuild\.toc back to 2\.3\.4/.test(l.line)));
  assert.ok(lines.some((l) => l.level === 'error' && /Disk full/.test(l.line)));
  const st = await publisher.status();
  assert.match(st.lastError.message, /Disk full/);
  assert.strictEqual(st.building, false);
});

test('publishAddon from another folder, preview, and input checks', async (t) => {
  const repo = makeRepo(t);
  const other = makeRepo(t, { addonVersion: '3.0.0-beta.1' });
  const server = await fakeServer(t);
  const { publisher } = setup(t, { repo, server });
  const pv = await publisher.publishAddon({ sourceDir: path.dirname(other.addonDir), bump: 'beta', preview: true });
  assert.deepStrictEqual(pv, { preview: true, dir: other.addonDir, version: '3.0.0-beta.1', next: '3.0.0-beta.2', problem: null });
  assert.strictEqual(readToc(other.addonDir), '3.0.0-beta.1', 'preview writes nothing');
  assert.strictEqual(server.requests.length, 0, 'preview sends nothing');
  await assert.rejects(publisher.publishAddon({ sourceDir: tmpDir(t), preview: true }), (e) => e.status === 404 && /no WowGuild\.toc/.test(e.message));

  const out = await publisher.publishAddon({ sourceDir: other.addonDir, bump: '3.0.0' });
  assert.strictEqual(out.version, '3.0.0');
  assert.strictEqual(readToc(other.addonDir), '3.0.0');
  assert.strictEqual(readToc(repo.addonDir), '1.0.0');

  await assert.rejects(publisher.publishAddon({ bump: 'huge' }), (e) => e.status === 400 && /isn't a choice/.test(e.message));
  await assert.rejects(publisher.publishAddon({ sourceDir: 'addon/WowGuild' }), (e) => e.status === 400 && /full folder path/.test(e.message));
  await assert.rejects(publisher.publishAddon({ notes: 'x'.repeat(4001) }), (e) => e.status === 400 && /up to 4,000 characters/.test(e.message));
});

test('only the signed-in owner can publish', async (t) => {
  const repo = makeRepo(t);
  const server = await fakeServer(t);
  await assert.rejects(setup(t, { repo, server, role: 'member' }).publisher.publishAddon({ bump: 'patch' }), (e) => e.status === 403 && /Only the guild owner/.test(e.message));
  await assert.rejects(setup(t, { repo, server, signedIn: false }).publisher.publishApp({ bump: 'patch' }), (e) => e.status === 401);
  assert.strictEqual(server.requests.length, 0);
  assert.strictEqual(readToc(repo.addonDir), '1.0.0');
});

test('publishApp bumps, runs npm run dist, uploads installer + blockmap and makes it live', async (t) => {
  const repo = makeRepo(t, { appVersion: '1.0.0' });
  const server = await fakeServer(t);
  server.app = { version: '1.0.0', notes: '', publishedAt: '2026-11-01 10:00:00' };
  const { publisher, lines } = setup(t, { repo, server });
  const out = await publisher.publishApp({ bump: 'minor', notes: 'New Updates page.' });
  assert.strictEqual(out.kind, 'app');
  assert.strictEqual(out.version, '1.1.0');
  assert.strictEqual(out.previous, '1.0.0');
  assert.deepStrictEqual(out.files.map((f) => f.name).sort(), ['Guild-Camp-Setup-1.1.0.exe', 'Guild-Camp-Setup-1.1.0.exe.blockmap']);
  assert.strictEqual(readPkg(repo.appDir), '1.1.0');
  assert.strictEqual(server.app.version, '1.1.0');
  assert.strictEqual(server.app.notes, 'New Updates page.');
  const commit = server.requests.find((r) => r.path === '/api/publish/app/commit');
  assert.strictEqual(commit.headers.authorization, `Bearer ${OWNER_TOKEN}`);
  const text = lines.map((l) => l.line);
  assert.ok(text.some((l) => /App version: 1\.0\.0 → 1\.1\.0/.test(l)));
  assert.ok(text.some((l) => /fake electron-builder/.test(l)), 'build output is streamed');
  assert.ok(text.some((l) => /Guild Camp 1\.1\.0 is live/.test(l)));
  assert.ok(lines.every((l) => l.kind === 'app'));
});

test('publishApp: one job at a time, and cancel stops the build and undoes the bump', async (t) => {
  const repo = makeRepo(t, { appVersion: '1.0.0' });
  const server = await fakeServer(t);
  let started;
  const startedP = new Promise((r) => { started = r; });
  const buildApp = (appDir, { onLog, signal }) => new Promise((resolve, reject) => {
    onLog('  • building target=nsis');
    started();
    signal.addEventListener('abort', () => reject(new release.ReleaseError('The app build was cancelled.', { code: 'ABORTED' })));
  });
  const { publisher, lines } = setup(t, { repo, server, buildApp });
  const job = publisher.publishApp({ bump: 'patch' });
  await startedP;
  assert.strictEqual(readPkg(repo.appDir), '1.0.1');
  const st = await publisher.status();
  assert.strictEqual(st.building, true);
  assert.deepStrictEqual({ kind: st.job.kind, step: st.job.step }, { kind: 'app', step: 'build' });
  await assert.rejects(publisher.publishAddon({ bump: 'patch' }), (e) => e.status === 409 && e.code === 'busy' && /already running/.test(e.message));

  assert.strictEqual(publisher.cancel(), true);
  await assert.rejects(job, (e) => e.code === 'cancelled' && /Nothing was published/.test(e.message));
  assert.strictEqual(readPkg(repo.appDir), '1.0.0', 'bump undone');
  assert.ok(lines.some((l) => /Cancelling the app build/.test(l.line)));
  assert.strictEqual((await publisher.status()).building, false);
  assert.strictEqual(publisher.cancel(), false, 'nothing left to cancel');
  assert.ok(!server.requests.some((r) => r.path.startsWith('/api/publish/')));
});

test('publishApp refuses a build whose version does not match, and needs a checkout', async (t) => {
  const repo = makeRepo(t, { appVersion: '1.0.0' });
  const server = await fakeServer(t);
  const buildApp = async (appDir) => {
    // A stale dist/ from an older build.
    const dist = path.join(appDir, 'dist');
    fs.mkdirSync(dist, { recursive: true });
    const data = Buffer.from('old');
    fs.writeFileSync(path.join(dist, 'Guild-Camp-Setup-0.9.0.exe'), data);
    fs.writeFileSync(path.join(dist, 'latest.yml'), `version: 0.9.0\nfiles:\n  - url: Guild-Camp-Setup-0.9.0.exe\n    sha512: ${sha512b64(data)}\n    size: 3\npath: Guild-Camp-Setup-0.9.0.exe\n`);
    return { distDir: dist };
  };
  const { publisher } = setup(t, { repo, server, buildApp });
  await assert.rejects(publisher.publishApp({ bump: 'patch' }), (e) => e.code === 'mismatch' && /is version 0\.9\.0, but app\/package\.json says 1\.0\.1/.test(e.message));
  assert.strictEqual(readPkg(repo.appDir), '1.0.0');

  server.app = { version: '1.0.0' };
  await assert.rejects(publisher.publishApp({}), (e) => e.code === 'not-newer' && /already has app 1\.0\.0/.test(e.message));

  const packaged = setup(t, { repo, server, isPackaged: true, appDir: tmpDir(t), buildApp });
  await assert.rejects(packaged.publisher.publishApp({ bump: 'patch' }), (e) => e.code === 'no-repo' && /source checkout/.test(e.message));
});

test('release notes are suggested from git history when the checkout is a git repo', async (t) => {
  const repo = makeRepo(t);
  const server = await fakeServer(t);
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: repo.root, stdio: 'pipe' });
  try {
    git('init', '-q');
  } catch {
    t.skip('git is not installed');
    return;
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'First commit');
  fs.writeFileSync(path.join(repo.addonDir, 'WowGuild.lua'), 'WowGuild = {}\n-- tooltips\n');
  git('commit', '-q', '-am', 'Tooltips show guild bank stock');
  const { publisher } = setup(t, { repo, server });
  const st = await publisher.status();
  assert.strictEqual(st.hasGit, true);
  assert.match(st.changelog.addon, /- Tooltips show guild bank stock/);
  assert.match(st.changelog.app, /- First commit/);
  // Same text as the CLI's (synchronous) version.
  assert.strictEqual(st.changelog.addon, release.gitChangelog(repo.root, 'addon'));
  assert.strictEqual(st.changelog.app, release.gitChangelog(repo.root, 'app'));
});

test('cleanBump and cleanNotes', () => {
  assert.strictEqual(cleanBump(null), null);
  assert.strictEqual(cleanBump(''), null);
  assert.strictEqual(cleanBump('none'), null);
  assert.strictEqual(cleanBump('patch'), 'patch');
  assert.strictEqual(cleanBump(' 1.4.0 '), '1.4.0');
  assert.throws(() => cleanBump('1.4'), /isn't a choice/);
  assert.strictEqual(cleanNotes('  a\r\nb  '), 'a\nb');
  assert.strictEqual(cleanNotes(undefined), '');
  assert.throws(() => cleanNotes(42), /must be text/);
});
