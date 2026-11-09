// App self-update (src/main/updater.js): installed builds drive electron-updater's autoUpdater (a fake here) with
// the github provider from app-update.yml; development builds read the newest app release from the GitHub API (a
// local fake server here). Nothing talks to GitHub.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { EventEmitter } = require('events');

const { createUpdater, friendlyError, notesText, NOT_PUBLISHED, LATEST_URL } = require('../src/main/updater');

// A stand-in for electron-updater's autoUpdater. Each method records its call; tests script what
// GitHub "answers" by setting fake.onCheck / fake.onDownload. setFeedURL throws: the feed comes from
// app-update.yml, and the updater must never point electron-updater anywhere else.
function fakeAutoUpdater() {
  const fake = new EventEmitter();
  fake.calls = [];
  fake.autoDownload = true;
  fake.autoInstallOnAppQuit = false;
  fake.allowPrerelease = true;
  fake.allowDowngrade = true;
  fake.logger = null;
  fake.onCheck = async () => { fake.emit('update-not-available', { version: '0.11.0' }); return { isUpdateAvailable: false }; };
  fake.onDownload = async () => {
    fake.emit('download-progress', { percent: 50, bytesPerSecond: 1000, transferred: 500, total: 1000 });
    fake.emit('update-downloaded', { version: '0.12.0', releaseNotes: 'Faster.' });
    return ['C:/fake/Guild-Camp-Setup-0.12.0.exe'];
  };
  fake.setFeedURL = () => { throw new Error('setFeedURL must not be called: the github provider comes from app-update.yml'); };
  fake.checkForUpdates = async () => {
    fake.calls.push('checkForUpdates');
    fake.emit('checking-for-update');
    return fake.onCheck();
  };
  fake.downloadUpdate = async () => { fake.calls.push('downloadUpdate'); return fake.onDownload(); };
  fake.quitAndInstall = (...args) => { fake.calls.push(['quitAndInstall', ...args]); };
  return fake;
}

// The bits of store.js the updater uses.
function fakeStore(initial = {}, file = null) {
  const s = new EventEmitter();
  let settings = { appAutoUpdate: true, ...initial };
  s.file = file;
  s.get = () => ({ ...settings });
  s.set = (patch) => {
    const keys = Object.keys(patch).filter((k) => settings[k] !== patch[k]);
    settings = { ...settings, ...patch };
    if (keys.length) s.emit('change', s.get(), keys);
    return s.get();
  };
  return s;
}

function fakeLog() {
  const lines = [];
  const log = {};
  for (const level of ['info', 'warn', 'error']) log[level] = (...a) => lines.push([level, a.join(' ')]);
  log.lines = lines;
  return log;
}

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-updater-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// feedFile: where dev builds cache the release list (default: none, unless storeFile is given; then next to it).
function setup({ isPackaged = true, settings, appVersion = '0.11.0', onBeforeInstall, releasesUrl, feedFile, storeFile = null } = {}) {
  const store = fakeStore(settings, storeFile);
  const fake = fakeAutoUpdater();
  const log = fakeLog();
  const feed = feedFile !== undefined || storeFile ? { feedFile } : { feedFile: null };
  const updater = createUpdater({ store, log, appVersion, isPackaged, onBeforeInstall, autoUpdater: fake, releasesUrl, ...feed });
  const states = [];
  updater.on('status', (st) => states.push(st.state));
  return { store, fake, log, updater, states };
}

const tick = () => new Promise((r) => setImmediate(r));

// A GitHub API stand-in: GET /repos/arrow-quiver/wow/releases?per_page=30, with ETags.
async function fakeGithub(t, releases) {
  const state = { releases, requests: [], status: 200, etag: '"r1"' };
  const srv = http.createServer((req, res) => {
    state.requests.push({ url: req.url, headers: req.headers });
    if (state.status !== 200) { res.writeHead(state.status, { 'Content-Type': 'application/json' }); res.end('{"message":"Not Found"}'); return; }
    if (req.headers['if-none-match'] === state.etag) { res.writeHead(304, { ETag: state.etag }); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json', ETag: state.etag });
    res.end(JSON.stringify(state.releases));
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => srv.close(resolve)));
  state.url = `http://127.0.0.1:${srv.address().port}/repos/arrow-quiver/wow/releases?per_page=30`;
  return state;
}

const appRelease = (v, extra = {}) => ({
  tag_name: `v${v}`, name: `Guild Camp ${v}`, body: `Notes for ${v}.`, draft: false, prerelease: false,
  published_at: '2026-11-06T10:00:00Z', html_url: `https://github.com/arrow-quiver/wow/releases/tag/v${v}`, assets: [], ...extra,
});
const addonRelease = (v) => ({ ...appRelease(v), tag_name: `addon-v${v}`, html_url: `https://github.com/arrow-quiver/wow/releases/tag/addon-v${v}` });

// ---------------------------------------------------------------------------------------------
// installed builds

test('configures electron-updater for GitHub: auto download from settings, install on quit, Latest only, no feed URL', async () => {
  const { updater, fake, log } = setup({ settings: { appAutoUpdate: false } });
  const st = await updater.check();
  assert.strictEqual(st.state, 'not-available');
  assert.deepStrictEqual(fake.calls, ['checkForUpdates'], 'only checkForUpdates: the feed comes from app-update.yml');
  assert.strictEqual(fake.autoDownload, false);
  assert.strictEqual(fake.autoInstallOnAppQuit, true);
  assert.strictEqual(fake.allowDowngrade, false);
  assert.strictEqual(fake.allowPrerelease, false, 'follows the release marked Latest, never an addon-v* entry of the feed');
  assert.ok(fake.logger && typeof fake.logger.info === 'function');
  fake.logger.info('Checking for update');
  assert.ok(log.lines.some(([lvl, msg]) => lvl === 'info' && msg === 'Checking for update'));
  assert.strictEqual(st.releasesUrl, 'https://github.com/arrow-quiver/wow/releases/latest');
  assert.strictEqual(LATEST_URL, st.releasesUrl);
});

test('no update: checking → not-available, with the latest version and the check time', async () => {
  const { updater, states } = setup();
  const st = await updater.check();
  assert.strictEqual(st.state, 'not-available');
  assert.strictEqual(st.current, '0.11.0');
  assert.strictEqual(st.available, null);
  assert.strictEqual(st.latest.version, '0.11.0');
  assert.ok(st.lastCheckAt);
  assert.strictEqual(st.isPackaged, true);
  assert.strictEqual(st.note, null);
  assert.deepStrictEqual(states, ['checking', 'not-available']);
});

test('update with automatic updates on: available → downloading (progress) → downloaded → install', async () => {
  let quittingMarked = false;
  const { updater, fake, states } = setup({ onBeforeInstall: () => { quittingMarked = true; } });
  fake.onCheck = async () => {
    // The github provider hands over the release notes as HTML.
    fake.emit('update-available', { version: '0.12.0', releaseNotes: '<p>Faster sync.</p><ul><li>New Updates page.</li></ul>', releaseDate: '2026-11-06T10:00:00.000Z' });
    // electron-updater downloads by itself when autoDownload is true.
    setImmediate(() => {
      fake.emit('download-progress', { percent: 42.5, bytesPerSecond: 2048, transferred: 425, total: 1000 });
      fake.emit('update-downloaded', { version: '0.12.0', releaseNotes: '<p>Faster sync.</p>' });
    });
    return { isUpdateAvailable: true };
  };
  const afterCheck = await updater.check({ force: true });
  assert.strictEqual(afterCheck.state, 'downloading');
  assert.deepStrictEqual(afterCheck.available, { version: '0.12.0', notes: 'Faster sync.\n- New Updates page.', date: '2026-11-06T10:00:00.000Z' });
  await tick();
  const st = updater.status();
  assert.strictEqual(st.state, 'downloaded');
  assert.strictEqual(st.progress, null);
  assert.ok(states.includes('downloading'));
  assert.deepStrictEqual(states.slice(-1), ['downloaded']);

  // While an update is downloaded, checking again leaves it alone.
  const calls = fake.calls.length;
  assert.strictEqual((await updater.check()).state, 'downloaded');
  assert.strictEqual(fake.calls.length, calls);

  assert.strictEqual(updater.install(), true);
  assert.ok(quittingMarked, 'onBeforeInstall runs first');
  assert.deepStrictEqual(fake.calls[fake.calls.length - 1], ['quitAndInstall', false, true]);
});

test('download progress is reported as numbers', async () => {
  const { updater, fake } = setup({ settings: { appAutoUpdate: false } });
  const seen = [];
  updater.on('status', (st) => { if (st.progress) seen.push(st.progress); });
  fake.onCheck = async () => { fake.emit('update-available', { version: '0.12.0' }); return {}; };
  assert.strictEqual((await updater.check()).state, 'available');
  const st = await updater.download();
  assert.strictEqual(st.state, 'downloaded');
  assert.deepStrictEqual(seen[0], { percent: 50, bytesPerSecond: 1000, transferred: 500, total: 1000 });
  assert.ok(fake.calls.includes('downloadUpdate'));
});

test('automatic updates off: waits at available; turning it on starts the download', async () => {
  const { updater, fake, store } = setup({ settings: { appAutoUpdate: false } });
  fake.onCheck = async () => { fake.emit('update-available', { version: '0.12.0' }); return {}; };
  const st = await updater.check();
  assert.strictEqual(st.state, 'available');
  assert.strictEqual(st.autoUpdate, false);
  assert.ok(!fake.calls.includes('downloadUpdate'));
  store.set({ appAutoUpdate: true });
  assert.strictEqual(fake.autoDownload, true);
  await tick(); await tick();
  assert.ok(fake.calls.includes('downloadUpdate'));
  assert.strictEqual(updater.status().state, 'downloaded');
  assert.strictEqual(updater.status().autoUpdate, true);
});

test('errors become plain sentences: nothing on GitHub yet, and offline', async () => {
  const { updater, fake } = setup();
  fake.onCheck = async () => {
    const err = new Error('Unable to find latest version on GitHub (https://github.com/arrow-quiver/wow/releases/latest), please ensure a production release exists: HttpError: 404');
    err.code = 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND';
    fake.emit('error', err);
    throw err;
  };
  let st = await updater.check();
  assert.strictEqual(st.state, 'error');
  assert.strictEqual(st.error, NOT_PUBLISHED);
  assert.strictEqual(st.error, 'No app release has been published on GitHub yet.');

  fake.onCheck = async () => {
    const err = new Error('net::ERR_INTERNET_DISCONNECTED');
    fake.emit('error', err);
    throw err;
  };
  st = await updater.check();
  assert.strictEqual(st.state, 'error');
  assert.match(st.error, /Couldn't reach GitHub/);
  assert.match(st.error, /internet connection/);

  // A rejection without an 'error' event still ends the check.
  fake.onCheck = async () => { throw Object.assign(new Error('getaddrinfo ENOTFOUND github.com'), { code: 'ENOTFOUND' }); };
  st = await updater.check();
  assert.strictEqual(st.state, 'error');
  assert.match(st.error, /Couldn't reach/);
});

test('a failed download keeps the update on offer so it can be retried', async () => {
  const { updater, fake } = setup({ settings: { appAutoUpdate: false } });
  fake.onCheck = async () => { fake.emit('update-available', { version: '0.12.0' }); return {}; };
  await updater.check();
  fake.onDownload = async () => {
    const err = new Error('sha512 checksum mismatch, expected abc, got def');
    fake.emit('error', err);
    throw err;
  };
  const st = await updater.download();
  assert.strictEqual(st.state, 'error');
  assert.match(st.error, /damaged/);
  assert.strictEqual(st.available.version, '0.12.0');
  assert.throws(() => updater.install(), /no downloaded update/);
});

test('install refuses when nothing is downloaded', () => {
  const { updater, fake } = setup();
  assert.throws(() => updater.install(), /no downloaded update/);
  assert.ok(!fake.calls.some((c) => Array.isArray(c) && c[0] === 'quitAndInstall'));
});

test('one check at a time', async () => {
  const { updater, fake } = setup();
  let release;
  fake.onCheck = () => new Promise((resolve) => { release = () => { fake.emit('update-not-available', { version: '0.11.0' }); resolve({}); }; });
  const a = updater.check();
  const b = updater.check({ force: true });
  await tick();
  assert.strictEqual(fake.calls.filter((c) => c === 'checkForUpdates').length, 1);
  assert.strictEqual(updater.status().state, 'checking');
  release();
  const [sa, sb] = await Promise.all([a, b]);
  assert.strictEqual(sa.state, 'not-available');
  assert.strictEqual(sb.state, 'not-available');
});

test('settings other than automatic updates leave the updater alone; dispose stops listening', async () => {
  const { updater, fake, store, states } = setup({ settings: { appAutoUpdate: false } });
  fake.onCheck = async () => { fake.emit('update-available', { version: '0.12.0' }); return {}; };
  await updater.check();
  const before = states.length;
  store.set({ theme: 'dark', serverUrl: 'https://anything.example' });
  assert.strictEqual(states.length, before);
  assert.strictEqual(updater.status().available.version, '0.12.0', 'there is no server to switch away from');
  updater.dispose();
  store.set({ appAutoUpdate: true });
  await tick();
  assert.ok(!fake.calls.includes('downloadUpdate'));
});

// ---------------------------------------------------------------------------------------------
// development builds

test('dev builds: state dev, never touch electron-updater, report a newer release from GitHub', async (t) => {
  const gh = await fakeGithub(t, [addonRelease('0.13.0'), appRelease('0.12.0'), appRelease('0.11.0'), appRelease('0.14.0', { draft: true })]);
  const dir = tmpDir(t);
  const { updater, fake, states } = setup({ isPackaged: false, releasesUrl: gh.url, storeFile: path.join(dir, 'settings.json') });
  assert.strictEqual(updater.status().state, 'dev');
  assert.match(updater.status().note, /development build/);
  const st = await updater.check();
  assert.strictEqual(st.state, 'dev');
  assert.deepStrictEqual(st.available, { version: '0.12.0', notes: 'Notes for 0.12.0.', date: '2026-11-06T10:00:00Z' });
  assert.strictEqual(st.latest.version, '0.12.0', 'addon releases and drafts are not app releases');
  assert.strictEqual(st.releasesUrl, 'https://github.com/arrow-quiver/wow/releases/tag/v0.12.0');
  assert.strictEqual(st.error, null);
  assert.ok(st.lastCheckAt);
  const h = gh.requests[0].headers;
  assert.strictEqual(h.accept, 'application/vnd.github+json');
  assert.strictEqual(h['user-agent'], 'GuildCamp/0.11.0');
  assert.ok(fs.existsSync(path.join(dir, 'github-releases.json')), 'the answer is cached next to settings.json, shared with the addon manager');
  assert.deepStrictEqual(fake.calls, []);
  assert.ok(states.every((x) => x === 'dev'));
  await assert.rejects(updater.download(), /development build/);
  assert.throws(() => updater.install(), /development build/);

  // The next automatic check uses the cached answer; a check the person asks for goes to GitHub (with the ETag).
  await updater.check();
  assert.strictEqual(gh.requests.length, 1);
  // (Forced checks are at most every 10 seconds: make the last attempt a minute old.)
  const cache = path.join(dir, 'github-releases.json');
  const saved = JSON.parse(fs.readFileSync(cache, 'utf8'));
  fs.writeFileSync(cache, JSON.stringify({ ...saved, attemptAt: new Date(Date.now() - 60000).toISOString() }));
  const forced = await updater.check({ force: true });
  assert.strictEqual(gh.requests.length, 2);
  assert.strictEqual(gh.requests[1].headers['if-none-match'], '"r1"');
  assert.strictEqual(forced.available.version, '0.12.0');
});

test('dev builds: same or older on GitHub → nothing available; errors are kept as text', async (t) => {
  const gh = await fakeGithub(t, [appRelease('0.11.0')]);
  const dir = tmpDir(t);
  const feedFile = path.join(dir, 'feed.json');
  const { updater } = setup({ isPackaged: false, releasesUrl: gh.url, feedFile });
  let st = await updater.check({ force: true });
  assert.strictEqual(st.available, null);
  assert.strictEqual(st.latest.version, '0.11.0');

  fs.rmSync(feedFile);
  gh.releases = [addonRelease('0.12.0')];
  gh.etag = '"r2"';
  st = await updater.check({ force: true });
  assert.strictEqual(st.latest, null, 'no app release yet');
  assert.strictEqual(st.releasesUrl, LATEST_URL);

  fs.rmSync(feedFile);
  gh.status = 404;
  st = await updater.check({ force: true });
  assert.strictEqual(st.state, 'dev');
  assert.match(st.error, /couldn't find its releases on GitHub\. The project may not be public yet/);

  // Unreachable: still a sentence, and still dev.
  const off = setup({ isPackaged: false, releasesUrl: 'http://127.0.0.1:9/repos/arrow-quiver/wow/releases?per_page=30', feedFile: path.join(dir, 'off.json') });
  st = await off.updater.check();
  assert.strictEqual(st.state, 'dev');
  assert.match(st.error, /Couldn't reach GitHub/);
});

// ---------------------------------------------------------------------------------------------
// wording

test('release notes: strings, per-version arrays and HTML become plain text', () => {
  assert.strictEqual(notesText('Line one\nLine two'), 'Line one\nLine two');
  assert.strictEqual(notesText([{ version: '0.12.0', note: 'B' }, { version: '0.11.1', note: 'A' }]), '0.12.0:\nB\n\n0.11.1:\nA');
  assert.strictEqual(notesText('<p>Hello &amp; welcome</p><ul><li>One</li><li>Two</li></ul>'), 'Hello & welcome\n- One\n- Two');
  assert.strictEqual(notesText(null), '');
});

test('friendlyError wording', () => {
  assert.strictEqual(friendlyError(Object.assign(new Error('x'), { statusCode: 404 })), NOT_PUBLISHED);
  assert.strictEqual(friendlyError(Object.assign(new Error('No published versions on GitHub'), { code: 'ERR_UPDATER_NO_PUBLISHED_VERSIONS' })), NOT_PUBLISHED);
  assert.match(friendlyError(Object.assign(new Error('Cannot find latest.yml in the latest release artifacts'), { code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' }), { during: 'download' }), /missing from the GitHub release/);
  assert.match(friendlyError(new Error('net::ERR_NAME_NOT_RESOLVED')), /Couldn't reach GitHub/);
  assert.match(friendlyError(new Error('net::ERR_CONNECTION_REFUSED'), { during: 'download' }), /download stopped because GitHub could not be reached/);
  assert.match(friendlyError(new Error('ENOSPC: no space left on device')), /disk space/);
  assert.match(friendlyError(new Error('HttpError: 502 Bad Gateway')), /GitHub had a problem/);
  assert.match(friendlyError(new Error('HttpError: 403 Forbidden rate limit exceeded')), /limiting requests/);
  assert.match(friendlyError(new Error('EPERM: operation not permitted')), /github\.com\/arrow-quiver\/wow\/releases\/latest/);
  assert.match(friendlyError(Object.assign(new Error('bad feed'), { code: 'ERR_UPDATER_INVALID_RELEASE_FEED' })), /update information on GitHub couldn't be read/);
  assert.match(friendlyError(new Error('Something odd\n    at stack')), /^Couldn't check for updates \(Something odd\)\.$/);
  for (const msg of [NOT_PUBLISHED, friendlyError(new Error('net::ERR_TIMED_OUT'))]) assert.doesNotMatch(msg, /server|guild owner/i, 'no server left to mention');
});
