// Release hosting: publishing with the real client (app/src/shared/release.js), auth, version
// rules, integrity checks, pruning, the /updates file server (ranges, caching), the bundled
// addon fallback, release notifications, and the /get and /join pages.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { startServer, seed, client, addLegacyKey } = require('./helpers');
const release = require('../../app/src/shared/release');
const hash = require('../../app/src/shared/hash');
const zip = require('../../app/src/shared/zip');
const { HTML_CSP } = require('../src/http');
const { versionFromFileName, firstLine, cleanNotes } = require('../src/services/releases');
const { parseRanges, fileHeaders } = require('../src/routes/releases');

const REPO_ADDON = path.join(__dirname, '..', '..', 'addon', 'WowGuild');
const TOKEN = 'publish-token-for-tests-123';

function tmpDir(t, prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

// A copy of the real addon folder with "## Version:" set to `ver`.
function addonCopy(t, ver) {
  const dest = path.join(tmpDir(t, 'gc-addon-'), 'WowGuild');
  fs.cpSync(REPO_ADDON, dest, { recursive: true });
  release.bumpAddonVersion(dest, ver);
  return dest;
}

// A fake electron-builder dist folder: installer, blockmap and a latest.yml that matches them.
function fakeDist(t, ver, { size = 150000 } = {}) {
  const dir = tmpDir(t, 'gc-dist-');
  const name = `Guild-Camp-Setup-${ver}.exe`;
  const exe = crypto.randomBytes(size);
  const blockmap = crypto.randomBytes(1500);
  fs.writeFileSync(path.join(dir, name), exe);
  fs.writeFileSync(path.join(dir, `${name}.blockmap`), blockmap);
  const sha512 = hash.sha512Base64(exe);
  const yml = [
    `version: ${ver}`,
    'files:',
    `  - url: ${name}`,
    `    sha512: ${sha512}`,
    `    size: ${exe.length}`,
    `path: ${name}`,
    `sha512: ${sha512}`,
    "releaseDate: '2026-11-07T10:00:00.000Z'",
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'latest.yml'), yml);
  return { dir, name, exe, blockmap, sha512, yml };
}

async function start(t, overrides = {}) {
  const srv = await startServer({ publishToken: TOKEN, rateLimits: { publish: 10000 }, ...overrides });
  t.after(() => srv.close());
  const s = seed(srv.db);
  return {
    srv,
    s,
    svc: srv.ctx.services.releases,
    anon: client(srv.url),
    pub: client(srv.url, TOKEN),
    owner: client(srv.url, s.owner.token),
    member: client(srv.url, s.member.token),
  };
}

// Raw bytes (the test client decodes non-JSON as text).
async function fetchBuf(url, { method = 'GET', headers = {} } = {}) {
  const res = await fetch(url, { method, headers });
  return { status: res.status, headers: res.headers, buf: Buffer.from(await res.arrayBuffer()) };
}
// A conditional GET the way a browser revalidates. (fetch adds "Cache-Control: no-cache" to
// conditional requests unless one is given, and no-cache rightly forces a full answer.)
const revalidate = (etag) => ({ 'If-None-Match': etag, 'Cache-Control': 'max-age=0' });

const listDir = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);
const putFile = (c, name, data, headers = {}) => c.raw('PUT', `/api/publish/app/files/${encodeURIComponent(name)}`, {
  headers: { 'Content-Type': 'application/octet-stream', ...headers }, body: data,
});
const putAddon = (c, data, { query = 'notes=x&force=0', headers = {} } = {}) => c.raw('PUT', `/api/publish/addon?${query}`, {
  headers: { 'Content-Type': 'application/zip', ...headers }, body: data,
});
// The whole app publish done by hand (no blockmap), for tests that need many versions fast.
async function quickApp(t, c, ver, extra = {}) {
  const d = fakeDist(t, ver, { size: 4000 });
  assert.equal((await putFile(c, d.name, d.exe)).status, 200);
  assert.equal((await putFile(c, `${d.name}.blockmap`, d.blockmap)).status, 200);
  const r = await c.post('/api/publish/app/commit', { version: ver, notes: `Release ${ver}`, latestYml: d.yml, ...extra });
  return { d, r };
}

const silence = (t) => {
  const warn = console.warn;
  console.warn = () => {};
  t.after(() => { console.warn = warn; });
};

// ---------- units ----------

test('helpers: versions in file names, notes, ranges, headers', () => {
  assert.equal(versionFromFileName('Guild-Camp-Setup-0.11.1.exe'), '0.11.1');
  assert.equal(versionFromFileName('Guild-Camp-Setup-0.11.1.exe.blockmap'), '0.11.1');
  assert.equal(versionFromFileName('Guild Camp Setup 1.2.0-beta.3.exe'), '1.2.0-beta.3');
  assert.equal(versionFromFileName('Guild-Camp-Setup-1.2.0-beta.3.exe.blockmap'), '1.2.0-beta.3');
  assert.equal(versionFromFileName('WowGuild-0.11.2.zip'), '0.11.2');
  assert.equal(versionFromFileName('setup.exe'), null);
  assert.equal(versionFromFileName('latest.yml'), null);

  assert.equal(firstLine('- Faster sync.\n- New page.'), 'Faster sync.');
  assert.equal(firstLine('\n\n  Fixes.  \nMore'), 'Fixes.');
  assert.equal(firstLine(''), null);
  assert.equal(firstLine(null), null);
  assert.equal(cleanNotes('  a\r\nb  '), 'a\nb');
  assert.equal(cleanNotes(''), null);
  assert.equal(cleanNotes({ x: 1 }), null);
  assert.equal(cleanNotes(['first', 'second']), 'first');
  assert.equal(cleanNotes('x'.repeat(5000)).length, 4000);

  assert.deepEqual(parseRanges('bytes=0-9', 100), [{ start: 0, end: 9 }]);
  assert.deepEqual(parseRanges('bytes=0-9, 20-29,-5', 100), [{ start: 0, end: 9 }, { start: 20, end: 29 }, { start: 95, end: 99 }]);
  assert.deepEqual(parseRanges('bytes=90-', 100), [{ start: 90, end: 99 }]);
  assert.deepEqual(parseRanges('bytes=90-500', 100), [{ start: 90, end: 99 }]);
  assert.equal(parseRanges('bytes=100-120', 100), null, 'past the end: send() answers 416');
  assert.equal(parseRanges('bytes=9-1', 100), null);
  assert.equal(parseRanges('bytes=-0', 100), null);
  assert.equal(parseRanges('items=0-1', 100), null);
  assert.equal(parseRanges('bytes=a-b', 100), null);

  assert.deepEqual(fileHeaders('latest.yml'), { 'Content-Type': 'text/yaml; charset=utf-8', 'Cache-Control': 'no-cache' });
  assert.deepEqual(fileHeaders('latest.json'), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
  assert.equal(fileHeaders('Guild-Camp-Setup-0.11.1.exe')['Content-Type'], 'application/octet-stream');
  assert.equal(fileHeaders('Guild-Camp-Setup-0.11.1.exe')['Cache-Control'], 'public, max-age=31536000, immutable');
  assert.equal(fileHeaders('Guild-Camp-Setup-0.11.1.exe.blockmap')['Content-Type'], 'application/octet-stream');
  assert.equal(fileHeaders('WowGuild-0.11.1.zip')['Content-Type'], 'application/zip');
  assert.equal(fileHeaders('setup.exe')['Cache-Control'], 'no-cache', 'no version in the name: may change');
});

// ---------- bundled addon ----------

test('bundled addon: offered until an addon is published, zipped on demand', async (t) => {
  const bundledDir = addonCopy(t, '0.11.0');
  const { srv, s, anon, svc } = await start(t, { bundledAddonDir: bundledDir });

  let r = await anon.get('/api/releases');
  assert.equal(r.status, 200);
  assert.equal(r.body.app, null);
  assert.deepEqual(r.body.history, []);
  const b = r.body.addon;
  assert.equal(b.source, 'bundled');
  assert.equal(b.version, '0.11.0');
  assert.equal(b.url, '/updates/addon/WowGuild-0.11.0.zip');
  assert.equal(b.publishedAt, null);
  assert.equal(b.notes, null);
  assert.match(b.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(b).sort(), ['notes', 'publishedAt', 'sha256', 'size', 'source', 'url', 'version']);

  // /api/meta and ctx.latest() use the releases service.
  r = await anon.get('/api/meta');
  assert.equal(r.body.releases.addon.source, 'bundled');
  assert.deepEqual(srv.ctx.latest(), svc.latest());

  // The zip itself: same checksum, one WowGuild/ folder with the toc.
  const z = await fetchBuf(srv.url + b.url);
  assert.equal(z.status, 200);
  assert.equal(z.headers.get('content-type'), 'application/zip');
  assert.equal(z.buf.length, b.size);
  assert.equal(hash.sha256(z.buf), b.sha256);
  const names = zip.readZip(z.buf).map((e) => e.name);
  assert.ok(names.includes('WowGuild/WowGuild.toc'));
  assert.ok(names.every((n) => n.startsWith('WowGuild/')));
  const head = await fetchBuf(srv.url + b.url, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.buf.length, 0);
  assert.equal(head.headers.get('content-length'), String(b.size));
  const again = await fetchBuf(srv.url + b.url, { headers: revalidate(z.headers.get('etag')) });
  assert.equal(again.status, 304);
  assert.equal((await anon.get('/updates/addon/WowGuild-0.10.0.zip')).status, 404);

  // Cached by toc version: the same zip until the version changes.
  assert.equal(svc.currentAddon().sha256, b.sha256);
  release.bumpAddonVersion(bundledDir, '0.11.1');
  assert.equal(svc.currentAddon().version, '0.11.1');
  assert.equal(svc.currentAddon().url, '/updates/addon/WowGuild-0.11.1.zip');
  release.bumpAddonVersion(bundledDir, '0.11.0');

  // Once an addon is published, the bundled one steps aside.
  await release.publishAddon({ server: srv.url, token: s.owner.token, pack: release.packAddon(addonCopy(t, '0.11.0')), notes: 'First.' });
  r = await anon.get('/api/releases');
  assert.equal(r.body.addon.source, 'published');
  assert.equal(r.body.addon.version, '0.11.0');
  assert.equal(svc.bundledFor('WowGuild-0.11.0.zip'), null);
  // The published file answers at that name now (from disk, long cache).
  const pz = await fetchBuf(srv.url + r.body.addon.url);
  assert.equal(pz.status, 200);
  assert.equal(hash.sha256(pz.buf), r.body.addon.sha256);
  assert.equal(pz.headers.get('cache-control'), 'public, max-age=31536000, immutable');
});

test('bundled addon: missing or broken folder → no addon', async (t) => {
  silence(t);
  const { anon } = await start(t, { bundledAddonDir: path.join(os.tmpdir(), 'gc-no-such-addon-dir') });
  let r = await anon.get('/api/releases');
  assert.deepEqual(r.body, { app: null, addon: null, history: [] });

  const broken = addonCopy(t, '0.11.0');
  fs.writeFileSync(path.join(broken, 'WowGuild.toc'), '## Title: Guild Camp\n## Version: soon\nCore.lua\n');
  const other = await start(t, { bundledAddonDir: broken });
  r = await other.anon.get('/api/releases');
  assert.equal(r.body.addon, null);
});

// ---------- auth ----------

test('publish auth: owner device token or PUBLISH_TOKEN only', async (t) => {
  const { srv, s, anon, pub, owner, member } = await start(t);
  const officer = client(srv.url, s.officer.token);
  const wrong = client(srv.url, 'not-the-token');
  const legacy = client(srv.url, addLegacyKey(srv.db, s.owner.id, s.guildId));
  const calls = {
    file: (c) => putFile(c, 'Guild-Camp-Setup-0.11.1.exe', Buffer.from('x')),
    commit: (c) => c.post('/api/publish/app/commit', {}),
    addon: (c) => putAddon(c, Buffer.from('not a zip')),
  };
  for (const [what, call] of Object.entries(calls)) {
    let r = await call(anon);
    assert.equal(r.status, 401, `${what}: no token`);
    assert.equal(r.body.error, 'Sign in first.');
    r = await call(legacy);
    assert.equal(r.status, 401, `${what}: old sync key`);
    for (const [who, c] of [['member', member], ['officer', officer], ['wrong token', wrong]]) {
      r = await call(c);
      assert.equal(r.status, 403, `${what}: ${who}`);
      assert.equal(r.body.error, 'Only the guild owner or the release token can publish updates.');
    }
    // Past the guard: the request itself is checked (400), not refused (401/403).
    for (const c of [owner, pub]) {
      r = await call(c);
      assert.ok(r.status === 400 || r.status === 200, `${what}: allowed (${r.status} ${JSON.stringify(r.body)})`);
    }
  }
  // Without PUBLISH_TOKEN set, no bearer value works as one.
  const none = await startServer({ publishToken: '' });
  t.after(() => none.close());
  assert.equal((await client(none.url, '').raw('PUT', '/api/publish/addon', { body: 'x' })).status, 401);
  assert.equal((await client(none.url, TOKEN).raw('PUT', '/api/publish/addon', { body: 'x' })).status, 403);
});

// ---------- addon ----------

test('addon publish: real client, files, latest.json, history, notification, audit', async (t) => {
  const { srv, s, anon, member, svc } = await start(t);
  const pack = release.packAddon(addonCopy(t, '0.11.1'));
  const result = await release.publishAddon({ server: srv.url, token: s.owner.token, pack, notes: '- Tooltips show bank stock.\n- Fixes a Lua error.' });
  assert.equal(result.ok, true);
  assert.equal(result.forced, false);
  assert.deepEqual(result.addon, {
    version: '0.11.1', notes: '- Tooltips show bank stock.\n- Fixes a Lua error.', publishedAt: result.addon.publishedAt,
    sha256: pack.sha256, size: pack.size, url: '/updates/addon/WowGuild-0.11.1.zip', source: 'published',
  });
  assert.match(result.addon.publishedAt, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);

  // On disk: the zip and latest.json, nothing else (no temp files).
  assert.deepEqual(listDir(svc.addonDir), ['WowGuild-0.11.1.zip', 'latest.json']);
  assert.ok(fs.readFileSync(path.join(svc.addonDir, 'WowGuild-0.11.1.zip')).equals(pack.zip));
  const manifest = JSON.parse(fs.readFileSync(path.join(svc.addonDir, 'latest.json'), 'utf8'));
  assert.deepEqual(manifest, {
    version: '0.11.1', notes: '- Tooltips show bank stock.\n- Fixes a Lua error.', sha256: pack.sha256, size: pack.size,
    file: 'WowGuild-0.11.1.zip', publishedAt: result.addon.publishedAt,
  });

  const row = srv.db.prepare("SELECT * FROM releases WHERE kind = 'addon'").get();
  assert.equal(row.version, '0.11.1');
  assert.equal(row.file, 'WowGuild-0.11.1.zip');
  assert.equal(row.size, pack.size);
  assert.equal(row.sha256, pack.sha256);
  assert.equal(row.published_by, s.owner.id);
  assert.equal(row.created_at, result.addon.publishedAt);

  const r = await anon.get('/api/releases');
  assert.deepEqual(r.body.addon, result.addon);
  assert.deepEqual(r.body.history, [{
    kind: 'addon', version: '0.11.1', notes: '- Tooltips show bank stock.\n- Fixes a Lua error.', publishedAt: row.created_at, by: 'Owner#1111',
  }]);
  assert.deepEqual(await release.getReleases(srv.url), r.body);

  // Every member hears about it.
  const ev = await member.get('/api/events?after=0');
  const e = ev.body.events.find((x) => x.kind === 'release');
  assert.ok(e, 'release event');
  assert.equal(e.title, 'Guild Camp addon 0.11.1 is out');
  assert.equal(e.body, 'Tooltips show bank stock.');
  assert.equal(e.route, '/addon');
  const audit = srv.db.prepare('SELECT * FROM audit_log').all();
  assert.equal(audit.length, 1);
  assert.equal(audit[0].action, 'addon release published');
  assert.equal(audit[0].detail, '0.11.1');
  assert.equal(audit[0].user_id, s.owner.id);

  // The files as players get them.
  const z = await fetchBuf(`${srv.url}/updates/addon/WowGuild-0.11.1.zip`);
  assert.equal(z.status, 200);
  assert.ok(z.buf.equals(pack.zip));
  assert.equal(z.headers.get('content-type'), 'application/zip');
  assert.match(z.headers.get('content-disposition'), /attachment; filename="WowGuild-0\.11\.1\.zip"/);
  const j = await fetchBuf(`${srv.url}/updates/addon/latest.json`);
  assert.equal(j.headers.get('cache-control'), 'no-cache');
  assert.match(j.headers.get('content-type'), /^application\/json/);
  assert.deepEqual(JSON.parse(j.buf.toString('utf8')), manifest);
});

test('addon publish: a version that isn\'t newer is refused (409) unless forced', async (t) => {
  const { srv, pub, svc } = await start(t);
  const opts = { server: srv.url, token: TOKEN };
  await release.publishAddon({ ...opts, pack: release.packAddon(addonCopy(t, '0.11.1')), notes: 'One' });

  const same = release.packAddon(addonCopy(t, '0.11.1'));
  await assert.rejects(release.publishAddon({ ...opts, pack: same, notes: 'Again' }), (e) => {
    assert.equal(e.status, 409);
    assert.match(e.message, /Addon 0\.11\.1 is already published, and 0\.11\.1 isn't newer/);
    return true;
  });
  const older = release.packAddon(addonCopy(t, '0.10.9'));
  assert.equal((await putAddon(pub, older.zip)).status, 409);
  assert.deepEqual(listDir(svc.addonDir), ['WowGuild-0.11.1.zip', 'latest.json'], 'refused uploads leave nothing behind');

  // force=1 rolls back.
  const rolled = await release.publishAddon({ ...opts, pack: older, notes: 'Rolled back.', force: true });
  assert.equal(rolled.forced, true);
  assert.equal(rolled.addon.version, '0.10.9');
  assert.equal(svc.publishedAddon().version, '0.10.9');
  assert.equal(JSON.parse(fs.readFileSync(path.join(svc.addonDir, 'latest.json'), 'utf8')).version, '0.10.9');
  const hist = (await client(srv.url).get('/api/releases')).body.history;
  assert.deepEqual(hist.map((h) => [h.version, h.by]), [['0.10.9', null], ['0.11.1', null]]);
  assert.equal(srv.db.prepare("SELECT detail FROM audit_log ORDER BY id DESC LIMIT 1").get().detail, '0.10.9 (forced) (release token)');
  // From the rolled-back version, 0.11.1 counts as newer again.
  const back = await release.publishAddon({ ...opts, pack: same, notes: 'Forward again.' });
  assert.equal(back.forced, false);
});

test('addon publish: broken, tampered or oversized zips are refused and leave nothing behind', async (t) => {
  const { pub, svc, srv } = await start(t, { maxAddonBytes: 200000 });
  const good = release.packAddon(addonCopy(t, '0.11.1'));
  const toc = '## Interface: 16001\n## Title: Guild Camp\n## Version: 0.11.1\nCore.lua\n';
  const cases = [
    ['tampered checksum', putAddon(pub, good.zip, { headers: { 'X-Sha256': 'ab'.repeat(32) } }), 400, /didn't arrive intact/],
    ['outside WowGuild', putAddon(pub, zip.createZip([{ name: 'WowGuild/WowGuild.toc', data: toc }, { name: 'Other/evil.lua', data: 'x' }])), 400, /outside the WowGuild folder \("Other\/evil\.lua"\)/],
    ['macOS junk outside', putAddon(pub, zip.createZip([{ name: 'WowGuild/WowGuild.toc', data: toc }, { name: '__MACOSX/._x', data: 'x' }])), 400, /outside the WowGuild folder/],
    ['parent folder', putAddon(pub, zip.createZip([{ name: 'WowGuild/WowGuild.toc', data: toc }, { name: 'WowGuild/../evil.lua', data: 'x' }])), 400, /unsafe file name/],
    ['no toc', putAddon(pub, zip.createZip([{ name: 'WowGuild/Core.lua', data: 'x' }])), 400, /no WowGuild\/WowGuild\.toc/],
    ['toc in a subfolder', putAddon(pub, zip.createZip([{ name: 'WowGuild/Sub/WowGuild.toc', data: toc }])), 400, /no WowGuild\/WowGuild\.toc/],
    ['bad version', putAddon(pub, zip.createZip([{ name: 'WowGuild/WowGuild.toc', data: toc.replace('0.11.1', 'next') }])), 400, /"## Version:" line/],
    ['not a zip', putAddon(pub, Buffer.from('hello, this is not a zip file at all')), 400, /isn't a zip/],
    ['empty', putAddon(pub, Buffer.alloc(0)), 400, /empty/],
    ['too large (declared)', putAddon(pub, crypto.randomBytes(250000)), 413, /Addon zips can be up to/],
    ['too large (streamed)', putAddon(pub, Readable.from([crypto.randomBytes(150000), crypto.randomBytes(150000)])), 413, /too large/],
  ];
  for (const [what, pending, status, message] of cases) {
    const r = await pending;
    assert.equal(r.status, status, `${what}: ${JSON.stringify(r.body)}`);
    assert.match(r.body.error, message, what);
  }
  assert.deepEqual(listDir(svc.addonDir), []);
  assert.equal(srv.db.prepare('SELECT COUNT(*) AS n FROM releases').get().n, 0);
  // The right checksum (any case) and a plain zip go through.
  const ok = await putAddon(pub, good.zip, { headers: { 'X-Sha256': good.sha256.toUpperCase() } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.addon.version, '0.11.1');
  assert.equal(ok.body.addon.notes, 'x');
});

// ---------- app ----------

test('app publish: real client, latest.yml, history, notification, audit', async (t) => {
  const { srv, s, anon, member, svc } = await start(t);
  const d = fakeDist(t, '0.11.1');
  const logs = [];
  const out = await release.publishApp({ server: srv.url, token: TOKEN, distDir: d.dir, notes: 'Faster sync after /reload.\nNew Updates page.', onLog: (l) => logs.push(l) });
  assert.equal(out.version, '0.11.1');
  assert.deepEqual(out.files.map((f) => f.name), [d.name, `${d.name}.blockmap`]);
  assert.equal(out.result.ok, true);
  assert.equal(out.result.forced, false);
  assert.deepEqual(out.result.pruned, []);

  assert.deepEqual(listDir(svc.appDir), [d.name, `${d.name}.blockmap`, 'latest.yml']);
  // Stored as built, plus the notes as a releaseNotes block (electron-builder leaves them out, and
  // installed apps show the notes on their Updates card from latest.yml).
  const storedYml = fs.readFileSync(path.join(svc.appDir, 'latest.yml'), 'utf8');
  assert.equal(storedYml, `${d.yml}releaseNotes: |-\n  Faster sync after /reload.\n  New Updates page.\n`);
  const served = await fetchBuf(`${srv.url}/updates/app/latest.yml`);
  assert.equal(served.buf.toString('utf8'), storedYml);
  const parsed = release.parseLatestYml(served.buf.toString('utf8'));
  assert.equal(parsed.releaseNotes, 'Faster sync after /reload.\nNew Updates page.');
  assert.equal(parsed.version, '0.11.1');
  assert.equal(parsed.sha512, d.sha512);
  assert.ok(fs.readFileSync(path.join(svc.appDir, d.name)).equals(d.exe));
  assert.ok(fs.readFileSync(path.join(svc.appDir, `${d.name}.blockmap`)).equals(d.blockmap));

  const row = srv.db.prepare("SELECT * FROM releases WHERE kind = 'app'").get();
  assert.equal(row.version, '0.11.1');
  assert.equal(row.file, d.name);
  assert.equal(row.size, d.exe.length);
  assert.equal(row.sha512, d.sha512);
  assert.equal(row.published_by, null);
  assert.equal(row.notes, 'Faster sync after /reload.\nNew Updates page.');

  let r = await anon.get('/api/releases');
  assert.deepEqual(r.body.app, {
    version: '0.11.1', notes: 'Faster sync after /reload.\nNew Updates page.', publishedAt: row.created_at,
    file: d.name, url: `/updates/app/${d.name}`, size: d.exe.length,
  });
  assert.deepEqual(out.result.app, r.body.app);
  assert.deepEqual(r.body.history[0], { kind: 'app', version: '0.11.1', notes: row.notes, publishedAt: row.created_at, by: null });
  r = await anon.get('/api/meta');
  assert.equal(r.body.releases.app.version, '0.11.1');

  const ev = (await member.get('/api/events?after=0')).body.events.filter((x) => x.kind === 'release');
  assert.deepEqual(ev.map((e) => [e.title, e.body, e.route]), [['Guild Camp 0.11.1 is out', 'Faster sync after /reload.', '/updates']]);
  const audit = srv.db.prepare('SELECT action, detail, user_id FROM audit_log').all();
  assert.deepEqual(audit.map((a) => ({ ...a })), [{ action: 'app release published', detail: '0.11.1 (release token)', user_id: null }]);

  // The owner's device token works too, and history names them.
  const d2 = fakeDist(t, '0.11.2');
  await release.publishApp({ server: srv.url, token: s.owner.token, distDir: d2.dir, notes: '' });
  assert.equal(fs.readFileSync(path.join(svc.appDir, 'latest.yml'), 'utf8'), d2.yml, 'no notes: latest.yml is stored exactly as built');
  r = await anon.get('/api/releases');
  assert.equal(r.body.app.version, '0.11.2');
  assert.equal(r.body.app.notes, null);
  assert.deepEqual(r.body.history.map((h) => [h.kind, h.version, h.by]), [['app', '0.11.2', 'Owner#1111'], ['app', '0.11.1', null]]);
  const last = (await member.get('/api/events?after=0')).body.events.filter((x) => x.kind === 'release').pop();
  assert.equal(last.body, 'Guild Camp downloads it in the background.', 'a default line when there are no notes');
});

test('app commit: version rules, missing or mismatched files, latest.yml only changes on success', async (t) => {
  const { srv, pub, svc } = await start(t);
  const d1 = fakeDist(t, '0.11.1');
  await release.publishApp({ server: srv.url, token: TOKEN, distDir: d1.dir, notes: 'One' });
  const ymlFile = path.join(svc.appDir, 'latest.yml');
  assert.equal(fs.readFileSync(ymlFile, 'utf8'), `${d1.yml}releaseNotes: |-\n  One\n`);
  const rows = () => srv.db.prepare("SELECT COUNT(*) AS n FROM releases WHERE kind = 'app'").get().n;

  // Same version again → 409 from the real client; force → accepted.
  await assert.rejects(release.publishApp({ server: srv.url, token: TOKEN, distDir: d1.dir }), (e) => {
    assert.equal(e.status, 409);
    assert.match(e.message, /Guild Camp 0\.11\.1 is already published, and 0\.11\.1 isn't newer/);
    return true;
  });
  let r = await pub.post('/api/publish/app/commit', { version: '0.11.1', notes: 'Again', latestYml: d1.yml, force: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.forced, true);
  assert.equal(rows(), 2);
  const liveYml = `${d1.yml}releaseNotes: |-\n  Again\n`;
  assert.equal(fs.readFileSync(ymlFile, 'utf8'), liveYml);

  // 0.11.2: only the blockmap was uploaded → 400, latest.yml untouched.
  const d2 = fakeDist(t, '0.11.2');
  assert.equal((await putFile(pub, `${d2.name}.blockmap`, d2.blockmap)).status, 200);
  r = await pub.post('/api/publish/app/commit', { version: '0.11.2', notes: 'Two', latestYml: d2.yml });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Guild-Camp-Setup-0\.11\.2\.exe hasn't been uploaded/);
  assert.equal(fs.readFileSync(ymlFile, 'utf8'), liveYml);
  assert.equal(rows(), 2);

  // The installer arrives with different bytes (same size) → checksum mismatch.
  const evil = Buffer.from(d2.exe);
  evil[10] ^= 0xff;
  assert.equal((await putFile(pub, d2.name, evil)).status, 200);
  r = await pub.post('/api/publish/app/commit', { version: '0.11.2', latestYml: d2.yml });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /doesn't match latest\.yml \(different checksum\)/);
  // ...or a different size.
  assert.equal((await putFile(pub, d2.name, d2.exe.subarray(1))).status, 200);
  r = await pub.post('/api/publish/app/commit', { version: '0.11.2', latestYml: d2.yml });
  assert.match(r.body.error, /different size/);
  assert.equal(fs.readFileSync(ymlFile, 'utf8'), liveYml);

  // Bad requests.
  const bad = [
    [{ version: 'nope', latestYml: d2.yml }, /like 1\.2\.3/],
    [{ version: '0.11.2' }, /Send the latest\.yml/],
    [{ version: '0.11.2', latestYml: 'x'.repeat(200 * 1024) }, /too large/],
    [{ version: '0.11.2', latestYml: '  bad: [yaml\n  - nope' }, /can't be read/],
    [{ version: '0.11.3', latestYml: d2.yml }, /latest\.yml is for version 0\.11\.2, not 0\.11\.3/],
    [{ version: '0.11.2', latestYml: 'version: 0.11.2\n' }, /lists no files/],
    [{ version: '0.11.2', latestYml: 'version: 0.11.2\nfiles:\n  - url: notes.txt\n    sha512: abc\n' }, /"notes\.txt", which isn't an installer file name/],
    [{ version: '0.11.2', latestYml: 'version: 0.11.2\nfiles:\n  - url: Setup-0.11.2.exe\n    size: 3\n' }, /no checksum for Setup-0\.11\.2\.exe/],
  ];
  for (const [body, message] of bad) {
    r = await pub.post('/api/publish/app/commit', body);
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 80));
    assert.match(r.body.error, message);
  }
  assert.equal(fs.readFileSync(ymlFile, 'utf8'), liveYml);

  // Fix the installer and it goes live.
  assert.equal((await putFile(pub, d2.name, d2.exe, { 'X-Sha512': d2.sha512 })).status, 200);
  r = await pub.post('/api/publish/app/commit', { version: '0.11.2', latestYml: d2.yml });
  assert.equal(r.status, 200);
  assert.equal(fs.readFileSync(ymlFile, 'utf8'), d2.yml);
  assert.equal(r.body.app.version, '0.11.2');
});

test('app commit: release notes reach the updater through latest.yml', async (t) => {
  const { srv, pub, svc } = await start(t);
  const ymlFile = path.join(svc.appDir, 'latest.yml');
  const servedYml = async () => (await fetchBuf(`${srv.url}/updates/app/latest.yml`)).buf.toString('utf8');

  // Several lines, a blank line, an indented line, a "#" and a ":", from a CRLF latest.yml.
  const notes = 'Fixes:\n\n  - sync after /reload # no longer stalls\nNew: Updates page';
  const d1 = fakeDist(t, '0.11.1', { size: 4000 });
  const crlf = d1.yml.replace(/\n/g, '\r\n');
  assert.equal((await putFile(pub, d1.name, d1.exe)).status, 200);
  let r = await pub.post('/api/publish/app/commit', { version: '0.11.1', notes: `\r\n${notes.replace(/\n/g, '\r\n')}  \r\n`, latestYml: crlf });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  let yml = await servedYml();
  assert.equal(yml, fs.readFileSync(ymlFile, 'utf8'));
  assert.ok(yml.endsWith('releaseNotes: |-\n  Fixes:\n\n    - sync after /reload # no longer stalls\n  New: Updates page\n'), yml);
  let info = release.parseLatestYml(yml);
  assert.equal(info.releaseNotes, notes);
  assert.equal(info.version, '0.11.1');
  assert.equal(info.files[0].sha512, d1.sha512);
  assert.equal(info.releaseDate, '2026-11-07T10:00:00.000Z');
  // The manifest fallback (no releases rows) reads the same notes back.
  srv.db.prepare('DELETE FROM releases').run();
  assert.equal((await client(srv.url).get('/api/releases')).body.app.notes, notes);

  // A latest.yml that already has release notes is stored as it is (a second key would break it).
  const d2 = fakeDist(t, '0.11.2', { size: 4000 });
  const own = `${d2.yml}releaseNotes: Built-in notes\n`;
  assert.equal((await putFile(pub, d2.name, d2.exe)).status, 200);
  r = await pub.post('/api/publish/app/commit', { version: '0.11.2', notes: 'Typed notes', latestYml: own });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  yml = await servedYml();
  assert.equal(yml, own);
  info = release.parseLatestYml(yml);
  assert.equal(info.releaseNotes, 'Built-in notes');
  assert.equal(r.body.app.notes, 'Typed notes', 'the release record keeps the notes that were sent');
});

test('app uploads: names, checksums, size cap, and the live release can\'t be swapped', async (t) => {
  const { srv, pub, svc } = await start(t, { maxAppFileBytes: 300000 });
  const d = fakeDist(t, '0.11.1');
  for (const name of ['latest.yml', '.hidden.exe', 'notes.txt', 'a/b.exe', `${'x'.repeat(250)}.exe`]) {
    const r = await pub.raw('PUT', `/api/publish/app/files/${encodeURIComponent(name)}`, { body: 'x' });
    assert.equal(r.status, 400, name);
    assert.match(r.body.error, /file name isn't allowed/);
  }
  let r = await putFile(pub, d.name, d.exe, { 'X-Sha512': hash.sha512Base64(Buffer.from('other')) });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /didn't arrive intact/);
  r = await putFile(pub, d.name, crypto.randomBytes(400000));
  assert.equal(r.status, 413);
  assert.match(r.body.error, /App files can be up to 293 KB/);
  r = await putFile(pub, d.name, Readable.from([crypto.randomBytes(200000), crypto.randomBytes(200000)]));
  assert.equal(r.status, 413);
  assert.deepEqual(listDir(svc.appDir), [], 'nothing left behind, not even temp files');

  // A good upload answers with what it stored. Spaces in names are fine.
  r = await putFile(pub, 'Guild Camp Setup 0.11.0.exe', Buffer.from('spaced'), { 'X-Sha512': hash.sha512Base64(Buffer.from('spaced')) });
  assert.deepEqual(r.body, { ok: true, name: 'Guild Camp Setup 0.11.0.exe', size: 6, sha512: hash.sha512Base64(Buffer.from('spaced')), unchanged: false });

  await release.publishApp({ server: srv.url, token: TOKEN, distDir: d.dir });
  // Re-uploading a live file: identical bytes are fine, different bytes are refused.
  r = await putFile(pub, d.name, d.exe);
  assert.equal(r.status, 200);
  assert.equal(r.body.unchanged, true);
  r = await putFile(pub, d.name, crypto.randomBytes(1000));
  assert.equal(r.status, 409);
  assert.match(r.body.error, /belongs to the live release/);
  r = await putFile(pub, `${d.name}.blockmap`, crypto.randomBytes(10));
  assert.equal(r.status, 409, 'its blockmap too');
  assert.ok(fs.readFileSync(path.join(svc.appDir, d.name)).equals(d.exe));
  assert.equal(listDir(svc.appDir).filter((n) => n.startsWith('.')).length, 0);
});

test('app pruning: newest five versions stay, plus whatever latest.yml points at', async (t) => {
  const { pub, svc } = await start(t);
  const versionsOnDisk = () => [...new Set(listDir(svc.appDir).filter((n) => n !== 'latest.yml').map(versionFromFileName))];
  for (let p = 1; p <= 7; p++) {
    const { r } = await quickApp(t, pub, `0.11.${p}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    if (p === 7) assert.deepEqual(r.body.pruned, ['Guild-Camp-Setup-0.11.2.exe', 'Guild-Camp-Setup-0.11.2.exe.blockmap']);
  }
  assert.deepEqual(versionsOnDisk(), ['0.11.3', '0.11.4', '0.11.5', '0.11.6', '0.11.7']);
  assert.ok(listDir(svc.appDir).includes('latest.yml'));

  // Roll back to 0.11.1 (forced): its files come back and are kept although they're old.
  let { r } = await quickApp(t, pub, '0.11.1', { force: true });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.pruned, []);
  assert.deepEqual(versionsOnDisk(), ['0.11.1', '0.11.3', '0.11.4', '0.11.5', '0.11.6', '0.11.7']);
  assert.match(fs.readFileSync(path.join(svc.appDir, 'latest.yml'), 'utf8'), /^version: 0\.11\.1$/m);

  // A new version: 0.11.1 is no longer live, so it goes, and so does 0.11.3.
  ({ r } = await quickApp(t, pub, '0.11.8'));
  assert.equal(r.status, 200);
  assert.deepEqual(versionsOnDisk(), ['0.11.4', '0.11.5', '0.11.6', '0.11.7', '0.11.8']);
  // Files without a version in their name are never touched.
  fs.writeFileSync(path.join(svc.appDir, 'readme.zip'), 'x');
  assert.deepEqual(await svc.pruneApp(1), [
    'Guild-Camp-Setup-0.11.4.exe', 'Guild-Camp-Setup-0.11.4.exe.blockmap', 'Guild-Camp-Setup-0.11.5.exe', 'Guild-Camp-Setup-0.11.5.exe.blockmap',
    'Guild-Camp-Setup-0.11.6.exe', 'Guild-Camp-Setup-0.11.6.exe.blockmap', 'Guild-Camp-Setup-0.11.7.exe', 'Guild-Camp-Setup-0.11.7.exe.blockmap',
  ]);
  assert.ok(listDir(svc.appDir).includes('readme.zip'));
});

// ---------- serving /updates ----------

test('updates files: content types, caching, HEAD, ranges (single and multipart), safe names', async (t) => {
  const { srv, anon, svc } = await start(t);
  const d = fakeDist(t, '0.11.1', { size: 50000 });
  await release.publishApp({ server: srv.url, token: TOKEN, distDir: d.dir });
  const base = `${srv.url}/updates/app`;

  let r = await fetchBuf(`${base}/latest.yml?noCache=123`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'text/yaml; charset=utf-8');
  assert.equal(r.headers.get('cache-control'), 'no-cache');
  assert.equal(r.buf.toString('utf8'), d.yml);

  r = await fetchBuf(`${base}/${d.name}`);
  assert.equal(r.status, 200);
  assert.ok(r.buf.equals(d.exe));
  assert.equal(r.headers.get('content-type'), 'application/octet-stream');
  assert.equal(r.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal(r.headers.get('accept-ranges'), 'bytes');
  assert.match(r.headers.get('content-disposition'), /attachment/);
  const etag = r.headers.get('etag');
  assert.ok(etag);
  assert.equal((await fetchBuf(`${base}/${d.name}`, { headers: revalidate(etag) })).status, 304);

  r = await fetchBuf(`${base}/${d.name}`, { method: 'HEAD' });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-length'), String(d.exe.length));
  assert.equal(r.buf.length, 0);

  r = await fetchBuf(`${base}/${d.name}`, { headers: { Range: 'bytes=100-199' } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-range'), `bytes 100-199/${d.exe.length}`);
  assert.ok(r.buf.equals(d.exe.subarray(100, 200)));
  r = await fetchBuf(`${base}/${d.name}`, { headers: { Range: 'bytes=-10' } });
  assert.ok(r.buf.equals(d.exe.subarray(d.exe.length - 10)));
  r = await fetchBuf(`${base}/${d.name}`, { headers: { Range: `bytes=${d.exe.length + 5}-` } });
  assert.equal(r.status, 416);

  // Several ranges at once (electron-updater's differential download): multipart/byteranges,
  // every part in the order asked, none merged.
  const asked = [[0, 9], [10, 19], [40000, 40999], [5, 6]];
  r = await fetchBuf(`${base}/${d.name}`, { headers: { Range: `bytes=${asked.map(([a, b]) => `${a}-${b}`).join(', ')}` } });
  assert.equal(r.status, 206);
  const m = /^multipart\/byteranges; boundary=(\S+)$/.exec(r.headers.get('content-type'));
  assert.ok(m, r.headers.get('content-type'));
  assert.equal(Number(r.headers.get('content-length')), r.buf.length);
  assert.equal(r.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  let at = 0;
  const expectText = (s) => {
    assert.equal(r.buf.subarray(at, at + s.length).toString('latin1'), s);
    at += s.length;
  };
  asked.forEach(([a, b], i) => {
    expectText(`${i ? '\r\n' : ''}--${m[1]}\r\nContent-Type: application/octet-stream\r\nContent-Range: bytes ${a}-${b}/${d.exe.length}\r\n\r\n`);
    assert.ok(r.buf.subarray(at, at + (b - a + 1)).equals(d.exe.subarray(a, b + 1)), `part ${i}`);
    at += b - a + 1;
  });
  expectText(`\r\n--${m[1]}--\r\n`);
  assert.equal(at, r.buf.length);
  r = await fetchBuf(`${base}/${d.name}`, { method: 'HEAD', headers: { Range: 'bytes=0-1,4-5' } });
  assert.equal(r.status, 206);
  assert.equal(r.buf.length, 0);

  r = await fetchBuf(`${base}/${d.name}.blockmap`);
  assert.equal(r.headers.get('content-type'), 'application/octet-stream');
  assert.ok(r.buf.equals(d.blockmap));

  // Missing files, temp files and anything path-like are 404s.
  fs.writeFileSync(path.join(svc.appDir, '.upload-0123abcd.part'), 'partial');
  fs.writeFileSync(path.join(srv.cfg.updatesDir, 'secret.txt'), 'secret');
  for (const p of ['/updates/app/nope.exe', '/updates/app/.upload-0123abcd.part', '/updates/app/..%2Fsecret.txt',
    '/updates/app/%2e%2e%2fsecret.txt', '/updates/app/..%5Csecret.txt', '/updates/app/', '/updates/addon/..%2Fapp%2Flatest.yml', '/updates/secret.txt']) {
    const x = await anon.get(p);
    assert.equal(x.status, 404, p);
  }
  // POST etc. aren't file reads.
  assert.equal((await anon.post('/updates/app/latest.yml', {})).status, 404);
});

// ---------- other behaviour ----------

test('history: newest first, 30 at most; the manifests stand in when the table is empty', async (t) => {
  const { srv, anon, svc } = await start(t);
  const d = fakeDist(t, '0.11.1');
  await release.publishApp({ server: srv.url, token: TOKEN, distDir: d.dir, notes: 'Hello' });
  await release.publishAddon({ server: srv.url, token: TOKEN, pack: release.packAddon(addonCopy(t, '0.11.1')), notes: 'Addon notes' });
  const before = (await anon.get('/api/releases')).body;

  // A replaced database: the files on disk still say what is live.
  srv.db.prepare('DELETE FROM releases').run();
  let r = await anon.get('/api/releases');
  assert.deepEqual(r.body.history, []);
  assert.equal(r.body.app.version, '0.11.1');
  assert.equal(r.body.app.file, d.name);
  assert.equal(r.body.app.url, `/updates/app/${d.name}`);
  assert.equal(r.body.app.size, d.exe.length);
  assert.equal(r.body.app.publishedAt, '2026-11-07T10:00:00.000Z');
  assert.deepEqual(r.body.addon, before.addon);
  // ...and still guard against publishing an older version.
  assert.equal((await client(srv.url, TOKEN).post('/api/publish/app/commit', { version: '0.11.1', latestYml: d.yml })).status, 409);

  const ins = srv.db.prepare("INSERT INTO releases (kind, version, notes, created_at) VALUES ('addon', ?, 'n', datetime('now', ?))");
  for (let i = 1; i <= 35; i++) ins.run(`1.0.${i}`, `-${100 - i} minutes`);
  r = await anon.get('/api/releases');
  assert.equal(r.body.history.length, 30);
  assert.equal(r.body.history[0].version, '1.0.35');
  assert.equal(r.body.history[29].version, '1.0.6');
  assert.equal(svc.history(500).length, 30);
});

test('temp files from a crash are swept after an hour', async (t) => {
  const { svc } = await start(t);
  const old = path.join(svc.appDir, '.upload-deadbeef.part');
  const oldAtomic = path.join(svc.addonDir, '.latest.json.tmp-0a1b2c');
  const fresh = path.join(svc.appDir, '.upload-cafe.part');
  const keep = path.join(svc.appDir, '.keep');
  for (const f of [old, oldAtomic, fresh, keep]) fs.writeFileSync(f, 'x');
  const past = new Date(Date.now() - 2 * 3600 * 1000);
  for (const f of [old, oldAtomic, keep]) fs.utimesSync(f, past, past);
  await svc.sweepTemp();
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(oldAtomic), false);
  assert.equal(fs.existsSync(fresh), true, 'an upload that may still be running');
  assert.equal(fs.existsSync(keep), true, 'not ours');
});

// ---------- pages ----------

test('/get: download page with the latest installer, or a note when there is none', async (t) => {
  const { srv, anon } = await start(t);
  let r = await anon.get('/get');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /^text\/html/);
  assert.equal(r.headers.get('content-security-policy'), HTML_CSP);
  assert.match(r.body, /<title>Get Guild Camp · Guild Camp<\/title>/);
  assert.match(r.body, /The desktop app for <strong>wow<\/strong>/);
  assert.match(r.body, /No Windows installer has been published on this server yet/);
  assert.doesNotMatch(r.body, /Download for Windows/);
  assert.match(r.body, /Sign in with Battle\.net/);
  assert.match(r.body, /installs the addon for you/);
  assert.match(r.body, /<strong>More info<\/strong>, then <strong>Run anyway<\/strong>/);
  assert.doesNotMatch(r.body, /<script/i);

  const d = fakeDist(t, '0.11.1');
  await release.publishApp({ server: srv.url, token: TOKEN, distDir: d.dir });
  r = await anon.get('/get');
  assert.match(r.body, new RegExp(`<a class="btn" href="/updates/app/${d.name.replace(/\./g, '\\.')}">Download for Windows</a>`));
  assert.match(r.body, /Version 0\.11\.1 &middot; \d{1,2} [A-Z][a-z]{2} \d{4} &middot; 146 KB/);
  assert.doesNotMatch(r.body, /No Windows installer/);

  // A server with no guild yet still has a sensible page.
  const bare = await startServer();
  t.after(() => bare.close());
  r = await client(bare.url).get('/get');
  assert.equal(r.status, 200);
  assert.match(r.body, /The desktop app for your guild\./);
});

test('/join/:code: opens the app, explains how to get it, friendly 404', async (t) => {
  const { srv, anon, s } = await start(t);
  let r = await anon.get(`/join/${s.inviteCode}`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-security-policy'), HTML_CSP);
  assert.match(r.body, /<h1>Join wow<\/h1>/);
  assert.match(r.body, /Horde &middot; 3 members/);
  assert.match(r.body, /<a class="btn" href="guildcamp:\/\/join\/TESTINVITE">Open in Guild Camp<\/a>/);
  assert.match(r.body, /Don't have the app yet\? <a href="\/get">Download it<\/a>/);
  assert.match(r.body, /<span class="code">TESTINVITE<\/span>/);

  for (const code of ['nope', 'TESTINVITE2', '%3Cscript%3Ealert(1)%3C%2Fscript%3E', 'a'.repeat(50)]) {
    r = await anon.get(`/join/${code}`);
    assert.equal(r.status, 404, code);
    assert.match(r.headers.get('content-type'), /^text\/html/);
    assert.match(r.body, /That invite link doesn&#39;t work/);
    assert.match(r.body, /Ask an officer for a fresh invite link/);
    assert.match(r.body, /href="\/get"/);
    assert.doesNotMatch(r.body, /<script/i);
  }
  // A replaced invite code stops working at once.
  srv.db.prepare("UPDATE guilds SET invite_code = 'NEWCODE'").run();
  assert.equal((await anon.get(`/join/${s.inviteCode}`)).status, 404);
  assert.equal((await anon.get('/join/NEWCODE')).status, 200);
});
