// App self-update (src/main/updater.js) with a fake electron-updater autoUpdater, plus the dev-build
// path that only reads GET /api/releases.
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');

const { createUpdater, friendlyError, notesText, feedUrlFor, NOT_PUBLISHED } = require('../src/main/updater');

// A stand-in for electron-updater's autoUpdater. Each method records its call; tests script what
// the "server" answers by setting fake.onCheck / fake.onDownload.
function fakeAutoUpdater() {
  const fake = new EventEmitter();
  fake.calls = [];
  fake.feeds = [];
  fake.autoDownload = true;
  fake.autoInstallOnAppQuit = false;
  fake.logger = null;
  fake.onCheck = async () => { fake.emit('update-not-available', { version: '0.11.0' }); return { isUpdateAvailable: false }; };
  fake.onDownload = async () => {
    fake.emit('download-progress', { percent: 50, bytesPerSecond: 1000, transferred: 500, total: 1000 });
    fake.emit('update-downloaded', { version: '0.12.0', releaseNotes: 'Faster.' });
    return ['C:/fake/Guild-Camp-Setup-0.12.0.exe'];
  };
  fake.setFeedURL = (opts) => { fake.calls.push('setFeedURL'); fake.feeds.push(opts); };
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
function fakeStore(initial = {}) {
  const s = new EventEmitter();
  let settings = { serverUrl: 'https://guild.example.com', appAutoUpdate: true, ...initial };
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

function setup({ isPackaged = true, settings, api, appVersion = '0.11.0', onBeforeInstall } = {}) {
  const store = fakeStore(settings);
  const fake = fakeAutoUpdater();
  const log = fakeLog();
  const updater = createUpdater({
    store, log, api, appVersion, isPackaged, onBeforeInstall,
    getServer: () => store.get().serverUrl,
    autoUpdater: fake,
  });
  const states = [];
  updater.on('status', (st) => states.push(st.state));
  return { store, fake, log, updater, states };
}

const tick = () => new Promise((r) => setImmediate(r));

test('feed URL is <server>/updates/app and is set before every check', async () => {
  const { updater, fake, store } = setup();
  await updater.check();
  assert.deepStrictEqual(fake.feeds[0], { provider: 'generic', url: 'https://guild.example.com/updates/app' });
  store.set({ serverUrl: 'http://127.0.0.1:3928/' });
  await updater.check();
  assert.deepStrictEqual(fake.feeds[1], { provider: 'generic', url: 'http://127.0.0.1:3928/updates/app' });
  assert.deepStrictEqual(fake.calls, ['setFeedURL', 'checkForUpdates', 'setFeedURL', 'checkForUpdates']);
  assert.strictEqual(feedUrlFor('https://a.example/x/'), 'https://a.example/x/updates/app');
  assert.strictEqual(feedUrlFor(''), null);
});

test('configures electron-updater: auto download from settings, install on quit, logger', async () => {
  const { updater, fake, log } = setup({ settings: { appAutoUpdate: false } });
  await updater.check();
  assert.strictEqual(fake.autoDownload, false);
  assert.strictEqual(fake.autoInstallOnAppQuit, true);
  assert.ok(fake.logger && typeof fake.logger.info === 'function');
  fake.logger.info('Checking for update');
  assert.ok(log.lines.some(([lvl, msg]) => lvl === 'info' && msg === 'Checking for update'));
});

test('no update: checking → not-available, with the latest version and the check time', async () => {
  const { updater, states } = setup();
  const st = await updater.check();
  assert.strictEqual(st.state, 'not-available');
  assert.strictEqual(st.current, '0.11.0');
  assert.strictEqual(st.available, null);
  assert.strictEqual(st.latest.version, '0.11.0');
  assert.ok(st.lastCheckAt);
  assert.deepStrictEqual(states, ['checking', 'not-available']);
});

test('update with automatic updates on: available → downloading (progress) → downloaded → install', async () => {
  let quittingMarked = false;
  const { updater, fake, states } = setup({ onBeforeInstall: () => { quittingMarked = true; } });
  fake.onCheck = async () => {
    fake.emit('update-available', { version: '0.12.0', releaseNotes: 'Faster sync.\nNew Updates page.', releaseDate: '2026-11-06T10:00:00.000Z' });
    // electron-updater downloads by itself when autoDownload is true.
    setImmediate(() => {
      fake.emit('download-progress', { percent: 42.5, bytesPerSecond: 2048, transferred: 425, total: 1000 });
      fake.emit('update-downloaded', { version: '0.12.0', releaseNotes: 'Faster sync.\nNew Updates page.' });
    });
    return { isUpdateAvailable: true };
  };
  const afterCheck = await updater.check();
  assert.strictEqual(afterCheck.state, 'downloading');
  assert.deepStrictEqual(afterCheck.available, { version: '0.12.0', notes: 'Faster sync.\nNew Updates page.', date: '2026-11-06T10:00:00.000Z' });
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

test('errors become plain sentences: nothing published (404) and offline', async () => {
  const { updater, fake } = setup();
  fake.onCheck = async () => {
    const err = new Error('Cannot find channel "latest.yml" update info: HttpError: 404 Not Found');
    err.code = 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND';
    fake.emit('error', err);
    throw err;
  };
  let st = await updater.check();
  assert.strictEqual(st.state, 'error');
  assert.strictEqual(st.error, NOT_PUBLISHED);
  assert.strictEqual(st.error, 'No app release has been published on this server yet.');

  fake.onCheck = async () => {
    const err = new Error('net::ERR_INTERNET_DISCONNECTED');
    fake.emit('error', err);
    throw err;
  };
  st = await updater.check();
  assert.strictEqual(st.state, 'error');
  assert.match(st.error, /Couldn't reach the guild server/);
  assert.match(st.error, /internet connection/);

  // A rejection without an 'error' event still ends the check.
  fake.onCheck = async () => { throw Object.assign(new Error('getaddrinfo ENOTFOUND guild.example.com'), { code: 'ENOTFOUND' }); };
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
  const b = updater.check();
  await tick();
  assert.strictEqual(fake.calls.filter((c) => c === 'checkForUpdates').length, 1);
  assert.strictEqual(updater.status().state, 'checking');
  release();
  const [sa, sb] = await Promise.all([a, b]);
  assert.strictEqual(sa.state, 'not-available');
  assert.strictEqual(sb.state, 'not-available');
});

test('a new server address forgets what the old one offered', async () => {
  const { updater, fake, store } = setup({ settings: { appAutoUpdate: false } });
  fake.onCheck = async () => { fake.emit('update-available', { version: '0.12.0' }); return {}; };
  await updater.check();
  assert.strictEqual(updater.status().available.version, '0.12.0');
  store.set({ serverUrl: 'https://other.example.com' });
  assert.strictEqual(updater.status().state, 'idle');
  assert.strictEqual(updater.status().available, null);
});

test('a new server address drops a downloaded update: not offered, not installed on quit', async () => {
  const { updater, fake, store, log } = setup({ settings: { appAutoUpdate: false } });
  fake.onCheck = async () => { fake.emit('update-available', { version: '0.12.0' }); return {}; };
  await updater.check();
  await updater.download();
  assert.strictEqual(updater.status().state, 'downloaded');
  assert.strictEqual(fake.autoInstallOnAppQuit, true);

  store.set({ serverUrl: 'https://other.example.com' });
  const st = updater.status();
  assert.strictEqual(st.state, 'idle');
  assert.strictEqual(st.available, null);
  assert.strictEqual(fake.autoInstallOnAppQuit, false, 'electron-updater will not run the old installer when the app quits');
  assert.throws(() => updater.install(), /no downloaded update/);
  assert.ok(log.lines.some(([, m]) => /will not be installed/.test(m)));

  // The new server is asked next time (a check isn't skipped as "already downloaded").
  fake.onCheck = async () => { fake.emit('update-not-available', { version: '0.11.0' }); return {}; };
  const after = await updater.check();
  assert.strictEqual(after.state, 'not-available');
  assert.deepStrictEqual(fake.feeds.at(-1), { provider: 'generic', url: 'https://other.example.com/updates/app' });
  assert.strictEqual(fake.autoInstallOnAppQuit, false, 'still nothing to install');
});

test('a download from the old server that finishes after the change is dropped; a fresh one installs again', async () => {
  const { updater, fake, store } = setup({ settings: { appAutoUpdate: false } });
  fake.onCheck = async () => { fake.emit('update-available', { version: '0.12.0' }); return {}; };
  await updater.check();
  let finish;
  fake.onDownload = () => new Promise((resolve) => { finish = resolve; });
  const pending = updater.download();
  assert.strictEqual(updater.status().state, 'downloading');

  store.set({ serverUrl: 'https://other.example.com' });
  assert.strictEqual(updater.status().state, 'idle');
  fake.emit('download-progress', { percent: 90 });
  fake.emit('update-downloaded', { version: '0.12.0' });
  finish(['C:/fake/old.exe']);
  await pending;
  assert.strictEqual(updater.status().state, 'idle', 'not offered');
  assert.strictEqual(updater.status().progress, null);
  assert.strictEqual(fake.autoInstallOnAppQuit, false);

  // The new server offers its own update; downloading it turns install-on-quit back on.
  fake.onCheck = async () => { fake.emit('update-available', { version: '0.13.0' }); return {}; };
  fake.onDownload = async () => { fake.emit('update-downloaded', { version: '0.13.0' }); return []; };
  await updater.check();
  const st = await updater.download();
  assert.strictEqual(st.state, 'downloaded');
  assert.strictEqual(st.available.version, '0.13.0');
  assert.strictEqual(fake.autoInstallOnAppQuit, true);
});

test("an answer from the old server's check that arrives after the change is ignored", async () => {
  const { updater, fake, store } = setup({ settings: { appAutoUpdate: false } });
  let answer;
  fake.onCheck = () => new Promise((resolve) => { answer = resolve; });
  const first = updater.check();
  await tick();
  store.set({ serverUrl: 'https://other.example.com' });
  // The page asks again for the new server while the old check is still out.
  fake.onCheck = async () => { fake.emit('update-not-available', { version: '0.11.0' }); return {}; };
  const second = updater.check();
  fake.emit('update-available', { version: '6.6.6' }); // the old server's reply
  answer({});
  await first;
  const st = await second;
  assert.strictEqual(st.available, null);
  assert.strictEqual(st.state, 'not-available');
  assert.deepStrictEqual(fake.feeds.map((f) => f.url), ['https://guild.example.com/updates/app', 'https://other.example.com/updates/app'],
    'the new address is asked after the old check finished');
});

test('dev builds: state dev, never touch electron-updater, report a newer server release', async () => {
  const requests = [];
  const api = {
    request: async (method, path, body, opts) => {
      requests.push({ method, path, opts });
      return { app: { version: '0.12.0', notes: 'New Updates page.', publishedAt: '2026-11-06 10:00:00' }, addon: null, history: [] };
    },
  };
  const { updater, fake, states } = setup({ isPackaged: false, api });
  assert.strictEqual(updater.status().state, 'dev');
  assert.match(updater.status().note, /development build/);
  const st = await updater.check();
  assert.strictEqual(st.state, 'dev');
  assert.deepStrictEqual(st.available, { version: '0.12.0', notes: 'New Updates page.', date: '2026-11-06 10:00:00' });
  assert.strictEqual(st.latest.version, '0.12.0');
  assert.ok(st.lastCheckAt);
  assert.strictEqual(requests[0].method, 'GET');
  assert.strictEqual(requests[0].path, '/api/releases');
  assert.strictEqual(requests[0].opts.auth, false);
  assert.deepStrictEqual(fake.calls, []);
  assert.ok(states.every((x) => x === 'dev'));
  await assert.rejects(updater.download(), /development build/);
  assert.throws(() => updater.install(), /development build/);
});

test('dev builds: same or older on the server → nothing available; errors are kept as text', async () => {
  let answer = { app: { version: '0.11.0', notes: '', publishedAt: null } };
  const api = { request: async () => { if (answer instanceof Error) throw answer; return answer; } };
  const { updater } = setup({ isPackaged: false, api });
  let st = await updater.check();
  assert.strictEqual(st.available, null);
  assert.strictEqual(st.latest.version, '0.11.0');
  answer = { app: null, addon: null, history: [] };
  st = await updater.check();
  assert.strictEqual(st.latest, null);
  answer = Object.assign(new Error("Can't reach the guild server (guild.example.com: connection refused)."), { status: 0 });
  st = await updater.check();
  assert.strictEqual(st.state, 'dev');
  assert.match(st.error, /Can't reach the guild server/);
});

test('release notes: strings, per-version arrays and HTML become plain text', () => {
  assert.strictEqual(notesText('Line one\nLine two'), 'Line one\nLine two');
  assert.strictEqual(notesText([{ version: '0.12.0', note: 'B' }, { version: '0.11.1', note: 'A' }]), '0.12.0:\nB\n\n0.11.1:\nA');
  assert.strictEqual(notesText('<p>Hello &amp; welcome</p><ul><li>One</li><li>Two</li></ul>'), 'Hello & welcome\n- One\n- Two');
  assert.strictEqual(notesText(null), '');
});

test('friendlyError wording', () => {
  assert.strictEqual(friendlyError(Object.assign(new Error('x'), { statusCode: 404 })), NOT_PUBLISHED);
  assert.match(friendlyError(new Error('net::ERR_NAME_NOT_RESOLVED')), /Couldn't reach/);
  assert.match(friendlyError(new Error('net::ERR_CONNECTION_REFUSED'), { during: 'download' }), /download stopped/);
  assert.match(friendlyError(new Error('ENOSPC: no space left on device')), /disk space/);
  assert.match(friendlyError(new Error('HttpError: 502 Bad Gateway')), /server had a problem/);
  assert.match(friendlyError(new Error('Something odd\n    at stack')), /^Couldn't check for updates \(Something odd\)\.$/);
});
