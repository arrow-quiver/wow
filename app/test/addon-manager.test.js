// The addon manager (src/main/addon.js): finding versions, installing, updating, repairing and removing the
// WowGuild addon in temp game folders, against a local stand-in for GitHub (the release list API and the release
// downloads). Never touches a real WoW install, and never talks to GitHub.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { pathToFileURL } = require('url');

const {
  createAddonManager, pickLatest, computeState, normalizeRemote, pickRemote, cleanTitle, looksLikeOurs, flavorsForInterface,
} = require('../src/main/addon');
const { createStore } = require('../src/main/store');
const realWow = require('../src/main/wow');
const { createZip } = require('../src/shared/zip');
const { sha256 } = require('../src/shared/hash');
const { setTocField, tocVersion } = require('../src/shared/toc');

const REPO = path.join(__dirname, '..', '..');
const REAL_ADDON = path.join(REPO, 'addon', 'WowGuild');
const FAST = [5, 5, 5];

// ---------------------------------------------------------------------------------------------
// helpers

function tmpDir(t, label = 'gc-addon-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), label));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return dir;
}

function setTocVersion(dir, v) {
  const file = path.join(dir, 'WowGuild.toc');
  fs.writeFileSync(file, setTocField(fs.readFileSync(file, 'utf8'), 'Version', v));
}

// A resources folder with a real copy of the repo's addon at the given version.
function makeResources(t, v = '0.11.0') {
  const res = tmpDir(t, 'gc-res-');
  const dir = path.join(res, 'addon', 'WowGuild');
  fs.cpSync(REAL_ADDON, dir, { recursive: true });
  setTocVersion(dir, v);
  return res;
}

// A fake game folder: <root>/<flavor>/Interface/AddOns plus a neighbouring addon that must never be touched.
function makeGame(root, flavor = '_forever_', label = 'WoW Forever') {
  const dir = path.join(root, flavor);
  const addonsDir = path.join(dir, 'Interface', 'AddOns');
  fs.mkdirSync(addonsDir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'WTF'), { recursive: true });
  const other = path.join(addonsDir, 'Auctionator');
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(other, 'Auctionator.toc'), '## Title: Auctionator\n## Version: 1.2.3\n\nAuctionator.lua\n');
  fs.writeFileSync(path.join(other, 'Auctionator.lua'), '-- not ours');
  return { dir, root, flavor, label, addonsDir, wtfDir: path.join(dir, 'WTF'), accounts: [] };
}

// Writes a small WowGuild folder (as if an older version had been installed).
function putAddon(addonsDir, v, { title = 'Guild Camp', name = 'WowGuild' } = {}) {
  const dir = path.join(addonsDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.toc`), `## Interface: 16001\n## Title: ${title}\n## Version: ${v}\n\nCore.lua\n`);
  fs.writeFileSync(path.join(dir, 'Core.lua'), `-- version ${v}`);
  return dir;
}

function putInbox(addonsDir, title = 'Guild Camp news') {
  const dir = path.join(addonsDir, 'WowGuild_Inbox');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'WowGuild_Inbox.toc'), `## Interface: 16001\n## Title: ${title}\n## Version: 0.11.0\n\nInbox.lua\n`);
  fs.writeFileSync(path.join(dir, 'Inbox.lua'), 'WowGuildInbox = {}\n');
  return dir;
}

const installedVersion = (addonsDir) => {
  try { return tocVersion(fs.readFileSync(path.join(addonsDir, 'WowGuild', 'WowGuild.toc'), 'utf8')); } catch { return null; }
};
const leftovers = (addonsDir) => fs.readdirSync(addonsDir).filter((n) => n.startsWith('.guildcamp-tmp-') || /^WowGuild(_Inbox)?\.(old|removed)-/.test(n));

// A zip shaped like a published addon: WowGuild/WowGuild.toc + WowGuild/Core.lua.
function addonZip(v, { tocVersionInZip = v, title = 'Guild Camp' } = {}) {
  return createZip([
    { name: 'WowGuild/WowGuild.toc', data: `## Interface: 16001\n## Title: ${title}\n## Version: ${tocVersionInZip}\n\nCore.lua\n` },
    { name: 'WowGuild/Core.lua', data: `-- served version ${v}\n` },
  ]);
}

const LIST_PATH = '/repos/arrow-quiver/wow/releases?per_page=30';
const NO_GITHUB = `http://127.0.0.1:9${LIST_PATH}`; // port 9 on localhost refuses connections at once

// A local stand-in for GitHub: the release list (GET /repos/arrow-quiver/wow/releases?per_page=30, with ETags) and
// the release downloads it links to. The list holds an app release (v0.12.0), the addon release (addon-v<v>, with
// WowGuild-<v>.zip and WowGuild-<v>.zip.sha256) and an older addon release.
// sha: the text of the .sha256 file (default: the checksum of the zip as published); shaFile: false leaves it out;
// digest: the digest GitHub reports for the zip. state.zip can be swapped later to serve other bytes.
async function githubServer(t, { version: v = '0.12.0', zip, sha, shaFile = true, digest = null, notes = 'Shopping list shows bank stock.', zipStatus = 200 } = {}) {
  const body = zip || addonZip(v);
  const state = { requests: [], zip: body, zipStatus, shaText: sha || `${sha256(body)}  WowGuild-${v}.zip\n`, etag: '"list-1"', listStatus: 200, listHeaders: {} };
  const srv = http.createServer((req, res) => {
    state.requests.push({ url: req.url, headers: req.headers });
    const base = state.base;
    if (req.url === LIST_PATH) {
      if (state.listStatus !== 200) {
        res.writeHead(state.listStatus, { 'Content-Type': 'application/json', ...state.listHeaders });
        res.end('{"message":"API rate limit exceeded for 127.0.0.1."}');
        return;
      }
      if (req.headers['if-none-match'] === state.etag) { res.writeHead(304, { ETag: state.etag }); res.end(); return; }
      const assets = [{ name: `WowGuild-${v}.zip`, size: state.zip.length, digest, browser_download_url: `${base}/download/addon-v${v}/WowGuild-${v}.zip` }];
      if (shaFile) assets.push({ name: `WowGuild-${v}.zip.sha256`, size: 85, browser_download_url: `${base}/download/addon-v${v}/WowGuild-${v}.zip.sha256` });
      const list = [
        { tag_name: 'v0.12.0', name: 'Guild Camp 0.12.0', body: 'App notes.', draft: false, prerelease: false, published_at: '2026-11-07T09:00:00Z', html_url: 'https://github.com/arrow-quiver/wow/releases/tag/v0.12.0', assets: [] },
        { tag_name: `addon-v${v}`, name: `Guild Camp addon ${v}`, body: notes, draft: false, prerelease: false, published_at: '2026-11-06T10:00:00Z', html_url: `https://github.com/arrow-quiver/wow/releases/tag/addon-v${v}`, assets },
        { tag_name: 'addon-v0.10.0', name: 'Guild Camp addon 0.10.0', body: 'Old.', draft: false, prerelease: false, published_at: '2026-10-01T10:00:00Z', html_url: 'https://github.com/arrow-quiver/wow/releases/tag/addon-v0.10.0', assets: [{ name: 'WowGuild-0.10.0.zip', size: 1, browser_download_url: `${base}/download/addon-v0.10.0/WowGuild-0.10.0.zip` }] },
      ];
      res.writeHead(200, { 'Content-Type': 'application/json', ETag: state.etag });
      res.end(JSON.stringify(list));
      return;
    }
    if (req.url === `/download/addon-v${v}/WowGuild-${v}.zip`) {
      if (state.zipStatus !== 200) { res.writeHead(state.zipStatus); res.end('nope'); return; }
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': state.zip.length });
      res.end(state.zip);
      return;
    }
    if (shaFile && req.url === `/download/addon-v${v}/WowGuild-${v}.zip.sha256`) {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(state.shaText);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'Not Found' }));
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => srv.close(resolve)));
  state.base = `http://127.0.0.1:${srv.address().port}`;
  state.url = `${state.base}${LIST_PATH}`;
  state.listCalls = () => state.requests.filter((r) => r.url === LIST_PATH).length;
  state.downloads = () => state.requests.filter((r) => r.url.startsWith('/download/') && r.url.endsWith('.zip')).length;
  return state;
}

// Makes the cached release list look a minute old, so a check the person asks for goes to GitHub again
// (such checks are at most every 10 seconds).
function ageFeed(userData) {
  const file = path.join(userData, 'github-releases.json');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...saved, attemptAt: new Date(Date.now() - 60000).toISOString() }));
}

function memLog() {
  const lines = [];
  const add = (level) => (...parts) => lines.push({ level, msg: parts.map((p) => (p instanceof Error ? p.message : String(p))).join(' ') });
  return { lines, info: add('info'), warn: add('warn'), error: add('error'), text: () => lines.map((l) => `${l.level}: ${l.msg}`).join('\n') };
}

// Builds a manager over temp folders. `server` is a githubServer() or null (GitHub can't be reached).
// Every game folder is turned on (settings.otherGameFolders) unless `otherGamesOn: false`.
function setup(t, { bundled = '0.11.0', server = null, games = [['_forever_', 'WoW Forever']], settings = {}, fsOps, noBundled = false, gameWaitMs, otherGamesOn = true } = {}) {
  const base = tmpDir(t);
  const root = path.join(base, 'World of Warcraft');
  const installs = games.map(([flavor, label]) => makeGame(root, flavor, label));
  const userData = path.join(base, 'userData');
  const store = createStore(userData);
  // Automatic updates and installs are off unless a test turns them on.
  const otherGameFolders = otherGamesOn ? installs.filter((i) => !realWow.isMainGame(i)).map((i) => i.dir) : [];
  store.set({ addonAutoUpdate: false, addonAutoInstall: false, otherGameFolders, ...settings });
  // Marks folders in use the way wow.js does: WoW Forever always, other games once turned on (otherFolders).
  const wow = {
    calls: 0,
    findInstalls: ({ otherFolders = [] } = {}) => {
      wow.calls += 1;
      const on = new Set(otherFolders.map((d) => realWow.pathKey(d)));
      return installs.map((i) => ({ ...i, mainGame: realWow.isMainGame(i), inUse: realWow.isMainGame(i) || on.has(realWow.pathKey(i.dir)) }));
    },
  };
  const log = memLog();
  const resourcesDir = noBundled ? tmpDir(t, 'gc-nores-') : makeResources(t, bundled);
  const addon = createAddonManager({
    store, log, wow, resourcesDir, fetch: globalThis.fetch, releasesUrl: server ? server.url : NO_GITHUB, appVersion: '0.11.0', retryDelays: FAST, fsOps, gameWaitMs,
  });
  const events = [];
  addon.on('status', (s) => events.push(s));
  t.after(() => addon.dispose());
  return { addon, store, log, wow, installs, events, userData, root, base, resourcesDir, game: installs[0] };
}

const stateOf = (status, dir) => status.installs.find((i) => i.dir === dir);

// ---------------------------------------------------------------------------------------------
// pure helpers

test('latest is the higher of bundled and GitHub; GitHub wins a tie', () => {
  assert.deepStrictEqual(pickLatest({ version: '0.11.0' }, { version: '0.12.0' }), { version: '0.12.0', source: 'remote' });
  assert.deepStrictEqual(pickLatest({ version: '0.12.0' }, { version: '0.11.5' }), { version: '0.12.0', source: 'bundled' });
  assert.deepStrictEqual(pickLatest({ version: '0.11.0' }, { version: '0.11.0' }), { version: '0.11.0', source: 'remote' });
  assert.deepStrictEqual(pickLatest(null, { version: '0.11.0' }), { version: '0.11.0', source: 'remote' });
  assert.deepStrictEqual(pickLatest({ version: '0.11.0' }, null), { version: '0.11.0', source: 'bundled' });
  assert.deepStrictEqual(pickLatest({ version: '0.12.0-beta.1' }, { version: '0.12.0' }), { version: '0.12.0', source: 'remote' });
  assert.strictEqual(pickLatest(null, null), null);
  assert.deepStrictEqual(pickLatest({ version: 'junk' }, { version: '0.1.0' }), { version: '0.1.0', source: 'remote' });
});

test('install state compares the installed toc version with latest', () => {
  const latest = { version: '0.11.1', source: 'remote' };
  assert.strictEqual(computeState(null, latest), 'missing');
  assert.strictEqual(computeState({ version: '0.11.0' }, latest), 'outdated');
  assert.strictEqual(computeState({ version: '0.11.1' }, latest), 'current');
  assert.strictEqual(computeState({ version: '0.12.0' }, latest), 'newer');
  assert.strictEqual(computeState({ version: '0.11.1-beta.2' }, latest), 'outdated');
  assert.strictEqual(computeState({ version: null }, latest), 'outdated', 'a damaged install needs updating');
  assert.strictEqual(computeState({ version: '0.11.0' }, null), 'current', 'nothing to compare with');
  assert.strictEqual(computeState(null, null), 'missing');
});

test('normalizeRemote reads an addon release from the GitHub API; pickRemote takes the newest with its zip', () => {
  const asset = (name, extra = {}) => ({ name, size: 120, browser_download_url: `https://github.com/arrow-quiver/wow/releases/download/x/${name}`, ...extra });
  const rel = (tag, assets, extra = {}) => ({ tag_name: tag, name: tag, body: 'Hi', draft: false, prerelease: false, published_at: '2026-11-01T10:00:00Z', html_url: `https://github.com/arrow-quiver/wow/releases/tag/${tag}`, assets, ...extra });
  assert.strictEqual(normalizeRemote(null), null);
  assert.strictEqual(normalizeRemote(rel('v0.11.2', [asset('WowGuild-0.11.2.zip')])), null, 'app releases are not addon releases');
  assert.strictEqual(normalizeRemote(rel('addon-v0.11.2', [asset('WowGuild-0.11.2.zip.sha256')])), null, 'no zip, no release');
  const r = normalizeRemote(rel('addon-v0.11.2', [asset('WowGuild-0.11.2.zip', { digest: `sha256:${'AB'.repeat(32)}` }), asset('WowGuild-0.11.2.zip.sha256')]));
  assert.deepStrictEqual(r, {
    version: '0.11.2', tag: 'addon-v0.11.2', notes: 'Hi', publishedAt: '2026-11-01T10:00:00Z', url: 'https://github.com/arrow-quiver/wow/releases/tag/addon-v0.11.2',
    zipUrl: 'https://github.com/arrow-quiver/wow/releases/download/x/WowGuild-0.11.2.zip', shaUrl: 'https://github.com/arrow-quiver/wow/releases/download/x/WowGuild-0.11.2.zip.sha256',
    size: 120, digest: 'ab'.repeat(32),
  });
  assert.strictEqual(normalizeRemote(rel('addon-v0.11.2', [asset('WowGuild-0.11.2.zip')])).shaUrl, null);
  const list = [
    rel('v0.20.0', [asset('Guild-Camp-Setup-0.20.0.exe')]),
    rel('addon-v0.14.0', [asset('WowGuild-0.14.0.zip')], { draft: true }),
    rel('addon-v0.13.0', [asset('WowGuild-0.13.0.zip')], { prerelease: true }),
    rel('addon-v0.12.5', [asset('WowGuild-0.12.5.zip.sha256')]), // upload still running: no zip yet
    rel('addon-v0.11.0', [asset('WowGuild-0.11.0.zip')]),
    rel('addon-v0.12.0', [asset('WowGuild-0.12.0.zip')], { published_at: '2026-10-01T10:00:00Z' }),
  ];
  assert.strictEqual(pickRemote(list).version, '0.12.0', 'newest by version, not by date');
  assert.strictEqual(pickRemote([]), null);
  assert.strictEqual(pickRemote(null), null);
});

test('titles with colour codes still count as ours', (t) => {
  assert.strictEqual(cleanTitle('|cffeaa93aGuild|r Camp'), 'Guild Camp');
  const dir = tmpDir(t);
  assert.strictEqual(looksLikeOurs(putAddon(dir, '0.1.0', { title: '|cffeaa93aGuild Camp|r' })), true);
  assert.strictEqual(looksLikeOurs(putInbox(dir)), true);
  const other = tmpDir(t);
  assert.strictEqual(looksLikeOurs(putAddon(other, '0.1.0', { title: 'Totally Different' })), false);
  assert.strictEqual(looksLikeOurs(path.join(other, 'Nothing')), false);
});

// ---------------------------------------------------------------------------------------------
// status

test('status reports bundled, latest and one state per install', async (t) => {
  const { addon, installs } = setup(t, {
    bundled: '0.11.1',
    games: [['_forever_', 'WoW Forever'], ['_retail_', 'Retail'], ['_classic_', 'Classic'], ['_ptr_', 'PTR'], ['_beta_', 'Beta']],
  });
  putAddon(installs[1].addonsDir, '0.11.0');
  putAddon(installs[2].addonsDir, '0.11.1');
  putAddon(installs[3].addonsDir, '0.12.0');
  fs.mkdirSync(path.join(installs[4].addonsDir, 'WowGuild')); // a copy without its toc

  const s = await addon.check();
  assert.deepStrictEqual(s.bundled, { version: '0.11.1' });
  assert.strictEqual(s.remote, null);
  assert.deepStrictEqual(s.latest, { version: '0.11.1', source: 'bundled' });
  assert.match(s.error, /Couldn't reach GitHub/, 'GitHub being out of reach is reported');
  assert.deepStrictEqual(s.releases, { app: null, history: [], checkedAt: null });
  assert.strictEqual(s.checking, false);
  assert.ok(s.lastCheckAt);
  assert.strictEqual(s.autoUpdate, false);
  assert.deepStrictEqual(s.installs.map((i) => i.state), ['missing', 'outdated', 'current', 'newer', 'outdated']);
  assert.deepStrictEqual(s.installs.map((i) => i.installed && i.installed.version), [null, '0.11.0', '0.11.1', '0.12.0', null]);
  assert.strictEqual(s.installs[4].damaged, true);
  assert.strictEqual(s.installs[0].installed, null);
  const first = s.installs[0];
  assert.strictEqual(first.dir, installs[0].dir);
  assert.strictEqual(first.label, 'WoW Forever');
  assert.strictEqual(first.flavor, '_forever_');
  assert.strictEqual(first.addonsDir, installs[0].addonsDir);
  assert.strictEqual(first.busy, false);
  assert.strictEqual(first.error, null);
});

test("GitHub's addon release becomes latest when it is newer; the status carries the release history", async (t) => {
  const server = await githubServer(t, { version: '0.12.0' });
  const { addon, game } = setup(t, { server });
  putAddon(game.addonsDir, '0.11.0');
  const s = await addon.check();
  assert.strictEqual(s.error, null);
  assert.strictEqual(s.remote.version, '0.12.0');
  assert.strictEqual(s.remote.notes, 'Shopping list shows bank stock.');
  assert.strictEqual(s.remote.publishedAt, '2026-11-06T10:00:00Z');
  assert.strictEqual(s.remote.url, 'https://github.com/arrow-quiver/wow/releases/tag/addon-v0.12.0');
  assert.deepStrictEqual(s.latest, { version: '0.12.0', source: 'remote' });
  assert.strictEqual(stateOf(s, game.dir).state, 'outdated');
  assert.strictEqual(server.downloads(), 0, 'checking never downloads when auto-update is off');
  // For the Updates page: the newest app release and the history, newest first.
  assert.deepStrictEqual(s.releases.app, { kind: 'app', version: '0.12.0', tag: 'v0.12.0', notes: 'App notes.', publishedAt: '2026-11-07T09:00:00Z', url: 'https://github.com/arrow-quiver/wow/releases/tag/v0.12.0' });
  assert.deepStrictEqual(s.releases.history.map((r) => r.tag), ['v0.12.0', 'addon-v0.12.0', 'addon-v0.10.0']);
  assert.ok(s.releases.checkedAt);
  // The list request says who is asking, as GitHub wants.
  const list = server.requests.find((r) => r.url === LIST_PATH);
  assert.strictEqual(list.headers.accept, 'application/vnd.github+json');
  assert.strictEqual(list.headers['user-agent'], 'GuildCamp/0.11.0');
});

test('GitHub is asked at most every 30 minutes, unless the person presses Check; the answer survives a restart', async (t) => {
  const server = await githubServer(t, { version: '0.12.0' });
  const { addon, store, userData, resourcesDir } = setup(t, { server });
  await addon.check();
  await addon.check();
  assert.strictEqual(server.listCalls(), 1, 'the second automatic check used the cached answer');
  ageFeed(userData);
  const forced = await addon.check({ force: true });
  assert.strictEqual(server.listCalls(), 2);
  const second = server.requests.filter((r) => r.url === LIST_PATH)[1];
  assert.strictEqual(second.headers['if-none-match'], '"list-1"', 'unchanged lists cost nothing (ETag)');
  assert.strictEqual(forced.remote.version, '0.12.0', 'a 304 keeps what was cached');
  assert.strictEqual(forced.error, null);
  // A fresh start of the app within the half hour reads the saved answer instead of asking again.
  const restarted = createAddonManager({ store, wow: { findInstalls: () => [] }, resourcesDir, releasesUrl: server.url, appVersion: '0.11.0', retryDelays: FAST });
  t.after(() => restarted.dispose());
  const s = await restarted.check();
  assert.strictEqual(server.listCalls(), 2);
  assert.strictEqual(s.remote.version, '0.12.0');
  assert.strictEqual(s.releases.history.length, 3);
});

test('a rate limit from GitHub is reported, and what was found before is kept', async (t) => {
  const server = await githubServer(t, { version: '0.12.0' });
  const { addon, userData, game } = setup(t, { server });
  putAddon(game.addonsDir, '0.11.0');
  await addon.check();
  server.listStatus = 403;
  server.listHeaders = { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 600) };
  ageFeed(userData);
  const s = await addon.check({ force: true });
  assert.match(s.error, /GitHub is limiting how often/);
  assert.strictEqual(s.remote.version, '0.12.0');
  assert.strictEqual(stateOf(s, game.dir).state, 'outdated');
  // Until GitHub's reset time, even a forced check doesn't ask again.
  ageFeed(userData);
  await addon.check({ force: true });
  assert.strictEqual(server.listCalls(), 2);
});

// ---------------------------------------------------------------------------------------------
// installing

test('installs the bundled addon when GitHub is out of reach, without touching other addons', async (t) => {
  const { addon, game, events, log } = setup(t, { bundled: '0.11.0' });
  const before = fs.readFileSync(path.join(game.addonsDir, 'Auctionator', 'Auctionator.lua'), 'utf8');
  const s = await addon.install(game.dir);
  assert.strictEqual(stateOf(s, game.dir).state, 'current');
  assert.strictEqual(installedVersion(game.addonsDir), '0.11.0');
  // The real addon files arrived (compare with the repo copy).
  for (const f of ['Core.lua', 'MainUI.lua', 'Bindings.xml']) {
    assert.ok(fs.readFileSync(path.join(game.addonsDir, 'WowGuild', f)).equals(fs.readFileSync(path.join(REAL_ADDON, f))), `${f} matches`);
  }
  assert.strictEqual(fs.readFileSync(path.join(game.addonsDir, 'Auctionator', 'Auctionator.lua'), 'utf8'), before);
  assert.deepStrictEqual(leftovers(game.addonsDir), []);
  assert.deepStrictEqual(fs.readdirSync(game.addonsDir).sort(), ['Auctionator', 'WowGuild']);
  // Busy while working, then idle again.
  assert.ok(events.some((e) => stateOf(e, game.dir).busy && stateOf(e, game.dir).action === 'install'), 'busy was reported');
  assert.strictEqual(stateOf(events.at(-1), game.dir).busy, false);
  assert.match(log.text(), /Installing addon 0\.11\.0 in WoW Forever/);
  assert.match(log.text(), /Addon 0\.11\.0 installed in WoW Forever/);
});

test('creates a missing AddOns folder', async (t) => {
  const { addon, game } = setup(t);
  fs.rmSync(path.join(game.dir, 'Interface'), { recursive: true });
  await addon.install(game.dir);
  assert.strictEqual(installedVersion(game.addonsDir), '0.11.0');
});

test('downloads the GitHub release, checks it against its .sha256 and caches it', async (t) => {
  const server = await githubServer(t, { version: '0.12.0' });
  const { addon, installs, userData } = setup(t, { server, games: [['_forever_', 'WoW Forever'], ['_retail_', 'Retail']] });
  await addon.check();
  await addon.install(installs[0].dir);
  assert.strictEqual(installedVersion(installs[0].addonsDir), '0.12.0');
  assert.match(fs.readFileSync(path.join(installs[0].addonsDir, 'WowGuild', 'Core.lua'), 'utf8'), /served version 0\.12\.0/);
  const cached = path.join(userData, 'addon-cache', 'WowGuild-0.12.0.zip');
  assert.ok(fs.existsSync(cached), 'the zip is cached');
  assert.ok(fs.readFileSync(cached).equals(server.zip));
  assert.strictEqual(server.downloads(), 1);
  const zipReq = server.requests.find((r) => r.url.endsWith('.zip'));
  assert.strictEqual(zipReq.headers['user-agent'], 'GuildCamp/0.11.0');
  assert.ok(server.requests.some((r) => r.url === '/download/addon-v0.12.0/WowGuild-0.12.0.zip.sha256'), 'the checksum file was read');

  // The second game uses the cached zip.
  const s = await addon.install(installs[1].dir);
  assert.strictEqual(server.downloads(), 1);
  assert.strictEqual(installedVersion(installs[1].addonsDir), '0.12.0');
  assert.deepStrictEqual(s.installs.map((i) => i.state), ['current', 'current']);
  assert.deepStrictEqual(leftovers(installs[0].addonsDir), []);
});

test('updating replaces the old version and keeps WowGuild_Inbox', async (t) => {
  const server = await githubServer(t, { version: '0.12.0' });
  const { addon, game } = setup(t, { server });
  putAddon(game.addonsDir, '0.11.0');
  fs.writeFileSync(path.join(game.addonsDir, 'WowGuild', 'OldOnly.lua'), '-- removed in 0.12');
  putInbox(game.addonsDir);
  await addon.check();
  const s = await addon.update(game.dir);
  assert.strictEqual(stateOf(s, game.dir).state, 'current');
  assert.strictEqual(installedVersion(game.addonsDir), '0.12.0');
  assert.ok(!fs.existsSync(path.join(game.addonsDir, 'WowGuild', 'OldOnly.lua')), 'files from the old version are gone');
  assert.ok(fs.existsSync(path.join(game.addonsDir, 'WowGuild_Inbox', 'Inbox.lua')), 'the inbox belongs to sync and stays');
  assert.deepStrictEqual(leftovers(game.addonsDir), []);
});

test('update does nothing when the addon is already current or newer', async (t) => {
  const { addon, installs, log } = setup(t, { bundled: '0.11.0', games: [['_forever_', 'WoW Forever'], ['_retail_', 'Retail']] });
  putAddon(installs[0].addonsDir, '0.11.0');
  putAddon(installs[1].addonsDir, '0.13.0');
  const marker = path.join(installs[1].addonsDir, 'WowGuild', 'Core.lua');
  const mtime = fs.statSync(marker).mtimeMs;
  await addon.update(installs[0].dir);
  await addon.update(installs[1].dir);
  assert.strictEqual(installedVersion(installs[1].addonsDir), '0.13.0', 'never downgrades');
  assert.strictEqual(fs.statSync(marker).mtimeMs, mtime);
  assert.match(log.text(), /already 0\.13\.0; nothing to update/);
});

test('repair reinstalls latest, also over a damaged copy', async (t) => {
  const { addon, game } = setup(t, { bundled: '0.11.0' });
  const dir = putAddon(game.addonsDir, '0.11.0');
  fs.rmSync(path.join(dir, 'WowGuild.toc'));
  let s = addon.status();
  assert.strictEqual(stateOf(s, game.dir).damaged, true);
  s = await addon.repair(game.dir);
  assert.strictEqual(stateOf(s, game.dir).state, 'current');
  assert.strictEqual(stateOf(s, game.dir).damaged, false);
  assert.ok(fs.existsSync(path.join(game.addonsDir, 'WowGuild', 'MainUI.lua')));
});

test('a tampered download fails its checksum and leaves the old version intact', async (t) => {
  const good = addonZip('0.12.0');
  const server = await githubServer(t, { version: '0.12.0', zip: good });
  server.zip = addonZip('0.12.0', { title: 'Guild Camp (evil)' }); // served bytes differ from the published sha256
  const { addon, game, userData } = setup(t, { server });
  putAddon(game.addonsDir, '0.11.0');
  await addon.check();
  await assert.rejects(addon.update(game.dir), (err) => {
    assert.strictEqual(err.code, 'checksum');
    assert.match(err.message, /didn't match the checksum/);
    assert.match(err.message, /current addon was left as it was/);
    return true;
  });
  assert.strictEqual(installedVersion(game.addonsDir), '0.11.0');
  assert.strictEqual(fs.readFileSync(path.join(game.addonsDir, 'WowGuild', 'Core.lua'), 'utf8'), '-- version 0.11.0');
  assert.deepStrictEqual(leftovers(game.addonsDir), []);
  assert.ok(!fs.existsSync(path.join(userData, 'addon-cache', 'WowGuild-0.12.0.zip')), 'a bad download is never cached');
  const s = addon.status();
  assert.strictEqual(stateOf(s, game.dir).state, 'outdated');
  assert.match(stateOf(s, game.dir).error, /checksum/);
  assert.strictEqual(stateOf(s, game.dir).busy, false);

  // Once the server serves the right bytes, the update works and clears the error.
  server.zip = good;
  const after = await addon.update(game.dir);
  assert.strictEqual(stateOf(after, game.dir).state, 'current');
  assert.strictEqual(stateOf(after, game.dir).error, null);
});

test('a damaged cached zip is thrown away and downloaded again', async (t) => {
  const server = await githubServer(t, { version: '0.12.0' });
  const { addon, game, userData } = setup(t, { server });
  fs.mkdirSync(path.join(userData, 'addon-cache'), { recursive: true });
  fs.writeFileSync(path.join(userData, 'addon-cache', 'WowGuild-0.12.0.zip'), 'garbage');
  await addon.check();
  await addon.install(game.dir);
  assert.strictEqual(server.downloads(), 1);
  assert.strictEqual(installedVersion(game.addonsDir), '0.12.0');
});

test('a package whose toc has another version is refused', async (t) => {
  const zip = addonZip('0.12.0', { tocVersionInZip: '0.12.1' });
  const server = await githubServer(t, { version: '0.12.0', zip });
  const { addon, game } = setup(t, { server });
  putAddon(game.addonsDir, '0.11.0');
  await addon.check();
  await assert.rejects(addon.update(game.dir), (err) => err.code === 'bad-package' && /0\.12\.1/.test(err.message) && /Nothing was changed/.test(err.message));
  assert.strictEqual(installedVersion(game.addonsDir), '0.11.0');
  assert.deepStrictEqual(leftovers(game.addonsDir), []);
});

test('a package without WowGuild/WowGuild.toc is refused', async (t) => {
  const zip = createZip([{ name: 'Other/Other.toc', data: '## Version: 0.12.0\n' }]);
  const server = await githubServer(t, { version: '0.12.0', zip });
  const { addon, game } = setup(t, { server });
  await addon.check();
  await assert.rejects(addon.install(game.dir), (err) => err.code === 'bad-package' && /WowGuild\/WowGuild\.toc/.test(err.message));
  assert.deepStrictEqual(fs.readdirSync(game.addonsDir), ['Auctionator']);
});

test('falls back to the bundled addon when the download fails', async (t) => {
  const server = await githubServer(t, { version: '0.12.0', zipStatus: 500 });
  const { addon, game, log } = setup(t, { server, bundled: '0.11.0' });
  await addon.check();
  const s = await addon.install(game.dir);
  assert.strictEqual(installedVersion(game.addonsDir), '0.11.0');
  assert.strictEqual(stateOf(s, game.dir).state, 'outdated', 'the server version is still offered');
  assert.match(log.text(), /answered 500.*came with Guild Camp \(0\.11\.0\) instead/);

  // With the bundled copy already installed, there is nothing to fall back to: the error shows.
  await assert.rejects(addon.update(game.dir), (err) => err.code === 'download' && /answered 500/.test(err.message));
});

test('a GitHub release without a readable checksum file is never installed', async (t) => {
  const server = await githubServer(t, { version: '0.12.0', sha: 'not-a-checksum' });
  const { addon, game, log } = setup(t, { server, bundled: '0.11.0' });
  putAddon(game.addonsDir, '0.11.0');
  await addon.check();
  await assert.rejects(addon.update(game.dir), (err) => err.code === 'bad-package' && /checksum file of addon 0\.12\.0 on GitHub can't be read/.test(err.message));
  assert.strictEqual(server.downloads(), 0);
  assert.strictEqual(installedVersion(game.addonsDir), '0.11.0');
  // Where the bundled copy is still an improvement (nothing installed), it is used instead.
  fs.rmSync(path.join(game.addonsDir, 'WowGuild'), { recursive: true });
  await addon.install(game.dir);
  assert.strictEqual(installedVersion(game.addonsDir), '0.11.0');
  assert.match(log.text(), /came with Guild Camp \(0\.11\.0\) instead/);
});

test('a GitHub release with no .sha256 at all is refused the same way', async (t) => {
  const server = await githubServer(t, { version: '0.12.0', shaFile: false });
  const { addon, game } = setup(t, { server, bundled: '0.11.0' });
  putAddon(game.addonsDir, '0.11.0');
  await addon.check();
  await assert.rejects(addon.update(game.dir), (err) => err.code === 'bad-package' && /has no checksum file/.test(err.message));
  assert.strictEqual(server.downloads(), 0);
  assert.strictEqual(installedVersion(game.addonsDir), '0.11.0');
});

test("when GitHub's own digest and the .sha256 file disagree, nothing is downloaded or installed", async (t) => {
  const server = await githubServer(t, { version: '0.12.0', digest: `sha256:${'f'.repeat(64)}` });
  const { addon, game } = setup(t, { server, bundled: '0.11.0' });
  putAddon(game.addonsDir, '0.11.0');
  await addon.check();
  await assert.rejects(addon.update(game.dir), (err) => err.code === 'checksum' && /don't agree/.test(err.message));
  assert.strictEqual(server.downloads(), 0);
  assert.strictEqual(installedVersion(game.addonsDir), '0.11.0');
  // A digest that matches is fine.
  const good = await githubServer(t, { version: '0.12.0', digest: `sha256:${sha256(addonZip('0.12.0'))}` });
  const second = setup(t, { server: good, bundled: '0.11.0' });
  putAddon(second.game.addonsDir, '0.11.0');
  await second.addon.check();
  await second.addon.update(second.game.dir);
  assert.strictEqual(installedVersion(second.game.addonsDir), '0.12.0');
});

test('refuses when there is no addon at all', async (t) => {
  const { addon, game } = setup(t, { noBundled: true });
  const s = addon.status();
  assert.strictEqual(s.bundled, null);
  assert.strictEqual(s.latest, null);
  await assert.rejects(addon.install(game.dir), (err) => err.code === 'nothing-to-install');
});

test('unknown folders are refused', async (t) => {
  const { addon, base } = setup(t);
  await assert.rejects(addon.install(path.join(base, 'Nowhere', '_forever_')), (err) => err.status === 404);
  await assert.rejects(addon.install(''), (err) => err.status === 400);
});

test('a second action on the same folder waits its turn', async (t) => {
  const { addon, game } = setup(t);
  const first = addon.install(game.dir);
  await assert.rejects(addon.repair(game.dir), (err) => err.code === 'busy');
  await first;
  assert.strictEqual(installedVersion(game.addonsDir), '0.11.0');
});

// ---------------------------------------------------------------------------------------------
// locks and rollback

function lockError(code = 'EBUSY') {
  return Object.assign(new Error(`${code}: resource busy or locked`), { code });
}

test('renames are retried while Windows holds a lock', async (t) => {
  let failures = 2;
  const fsOps = {
    rename: async (from, to) => {
      if (failures > 0) { failures -= 1; throw lockError('EPERM'); }
      return fs.promises.rename(from, to);
    },
  };
  const { addon, game } = setup(t, { fsOps });
  putAddon(game.addonsDir, '0.10.0');
  await addon.update(game.dir);
  assert.strictEqual(installedVersion(game.addonsDir), '0.11.0');
  assert.strictEqual(failures, 0);
  assert.deepStrictEqual(leftovers(game.addonsDir), []);
});

test('if the new folder cannot move in, the old one is put back', async (t) => {
  const fsOps = {
    rename: async (from, to) => {
      // Moving the unpacked copy into place always fails (as if the game held it).
      if (path.basename(path.dirname(from)).startsWith('.guildcamp-tmp-')) throw lockError('EBUSY');
      return fs.promises.rename(from, to);
    },
  };
  const { addon, game } = setup(t, { fsOps });
  putAddon(game.addonsDir, '0.10.0');
  await assert.rejects(addon.update(game.dir), (err) => {
    assert.strictEqual(err.code, 'in-use');
    assert.match(err.message, /Close World of Warcraft and try again/);
    return true;
  });
  assert.strictEqual(installedVersion(game.addonsDir), '0.10.0', 'the old version is back');
  assert.strictEqual(fs.readFileSync(path.join(game.addonsDir, 'WowGuild', 'Core.lua'), 'utf8'), '-- version 0.10.0');
  assert.deepStrictEqual(leftovers(game.addonsDir), [], 'temp folder cleaned up');
  assert.match(stateOf(addon.status(), game.dir).error, /Close World of Warcraft/);
});

test('if the old folder is locked, nothing changes', async (t) => {
  const fsOps = {
    rename: async (from, to) => {
      if (path.basename(from) === 'WowGuild' && /WowGuild\.old-/.test(path.basename(to))) throw lockError('EPERM');
      return fs.promises.rename(from, to);
    },
  };
  const { addon, game } = setup(t, { fsOps });
  putAddon(game.addonsDir, '0.10.0');
  await assert.rejects(addon.update(game.dir), (err) => err.code === 'in-use');
  assert.strictEqual(installedVersion(game.addonsDir), '0.10.0');
  assert.deepStrictEqual(leftovers(game.addonsDir), []);
});

test('when the game is not running, the lock message points at other programs', async (t) => {
  const fsOps = { rename: async () => { throw lockError('EPERM'); } };
  const { addon, game, wow } = setup(t, { fsOps });
  wow.isWowRunning = async () => false;
  putAddon(game.addonsDir, '0.10.0');
  await assert.rejects(addon.update(game.dir), (err) => err.code === 'in-use' && /Another program has them open/.test(err.message) && !/Close World of Warcraft/.test(err.message));
  wow.isWowRunning = async () => true;
  await assert.rejects(addon.update(game.dir), (err) => /Close World of Warcraft and try again/.test(err.message));
  assert.strictEqual(installedVersion(game.addonsDir), '0.10.0');
});

test('an interrupted change is undone before the next one', async (t) => {
  const { addon, game } = setup(t);
  // As if the app stopped between "rename old away" and "move new in".
  putAddon(game.addonsDir, '0.10.0', { name: 'WowGuild' });
  fs.renameSync(path.join(game.addonsDir, 'WowGuild'), path.join(game.addonsDir, 'WowGuild.old-1700000000000'));
  fs.mkdirSync(path.join(game.addonsDir, '.guildcamp-tmp-deadbeef', 'WowGuild'), { recursive: true });
  fs.mkdirSync(path.join(game.addonsDir, 'WowGuild_Inbox.removed-1'));
  assert.strictEqual(stateOf(addon.status(), game.dir).state, 'missing');
  await addon.check();
  assert.strictEqual(installedVersion(game.addonsDir), '0.10.0', 'the previous version is restored');
  assert.deepStrictEqual(leftovers(game.addonsDir), []);
  assert.deepStrictEqual(fs.readdirSync(game.addonsDir).sort(), ['Auctionator', 'WowGuild']);
});

// ---------------------------------------------------------------------------------------------
// uninstall

test('uninstall removes WowGuild and WowGuild_Inbox only', async (t) => {
  const { addon, game } = setup(t);
  putAddon(game.addonsDir, '0.11.0');
  putInbox(game.addonsDir);
  const s = await addon.uninstall(game.dir);
  assert.strictEqual(stateOf(s, game.dir).state, 'missing');
  assert.deepStrictEqual(fs.readdirSync(game.addonsDir), ['Auctionator']);
  // Nothing to remove the second time: still fine.
  await addon.uninstall(game.dir);
});

test('uninstall leaves folders that are not ours', async (t) => {
  const { addon, game } = setup(t);
  putAddon(game.addonsDir, '2.0.0', { title: 'Some Other Addon' });
  putInbox(game.addonsDir);
  await assert.rejects(addon.uninstall(game.dir), (err) => err.code === 'not-ours' && /left alone/.test(err.message));
  assert.ok(fs.existsSync(path.join(game.addonsDir, 'WowGuild', 'WowGuild.toc')));
  assert.ok(fs.existsSync(path.join(game.addonsDir, 'WowGuild_Inbox', 'Inbox.lua')), 'nothing is removed when the check fails');

  // An inbox folder that isn't ours stays even when the addon goes.
  fs.rmSync(path.join(game.addonsDir, 'WowGuild'), { recursive: true });
  putAddon(game.addonsDir, '0.11.0');
  fs.rmSync(path.join(game.addonsDir, 'WowGuild_Inbox'), { recursive: true });
  putInbox(game.addonsDir, 'Someone Else');
  await addon.uninstall(game.dir);
  assert.deepStrictEqual(fs.readdirSync(game.addonsDir).sort(), ['Auctionator', 'WowGuild_Inbox']);
});

test('uninstall says to close the game when the folder stays locked', async (t) => {
  const fsOps = { rename: async () => { throw lockError('EBUSY'); } };
  const { addon, game } = setup(t, { fsOps });
  putAddon(game.addonsDir, '0.11.0');
  await assert.rejects(addon.uninstall(game.dir), (err) => err.code === 'in-use' && /remove the addon/.test(err.message) && /Close World of Warcraft/.test(err.message));
  assert.strictEqual(installedVersion(game.addonsDir), '0.11.0');
});

// ---------------------------------------------------------------------------------------------
// check, auto-update and update all

test('check updates outdated installs automatically but installs nothing new while automatic installs are off', async (t) => {
  const server = await githubServer(t, { version: '0.12.0' });
  const { addon, installs, log } = setup(t, {
    server,
    settings: { addonAutoUpdate: true },
    games: [['_forever_', 'WoW Forever'], ['_retail_', 'Retail'], ['_ptr_', 'PTR']],
  });
  putAddon(installs[0].addonsDir, '0.11.0');
  putAddon(installs[2].addonsDir, '0.13.0');
  const s = await addon.check();
  assert.deepStrictEqual(s.installs.map((i) => i.state), ['current', 'missing', 'newer']);
  assert.strictEqual(installedVersion(installs[0].addonsDir), '0.12.0');
  assert.strictEqual(installedVersion(installs[1].addonsDir), null, 'missing stays missing');
  assert.strictEqual(installedVersion(installs[2].addonsDir), '0.13.0', 'never downgrades');
  assert.match(log.text(), /Updating addon 0\.12\.0 in WoW Forever \(was 0\.11\.0\) automatically/);
  assert.strictEqual(server.downloads(), 1);
});

test('check leaves outdated installs alone when automatic updates are off', async (t) => {
  const server = await githubServer(t, { version: '0.12.0' });
  const { addon, game } = setup(t, { server, settings: { addonAutoUpdate: false } });
  putAddon(game.addonsDir, '0.11.0');
  const s = await addon.check();
  assert.strictEqual(stateOf(s, game.dir).state, 'outdated');
  assert.strictEqual(installedVersion(game.addonsDir), '0.11.0');
  assert.strictEqual(server.downloads(), 0);
});

test('a failing automatic update is logged, not thrown', async (t) => {
  const good = addonZip('0.12.0');
  const server = await githubServer(t, { version: '0.12.0', zip: good });
  server.zip = addonZip('0.12.0', { title: 'Changed' });
  const { addon, game, log } = setup(t, { server, settings: { addonAutoUpdate: true } });
  putAddon(game.addonsDir, '0.11.0');
  const s = await addon.check();
  assert.strictEqual(stateOf(s, game.dir).state, 'outdated');
  assert.match(stateOf(s, game.dir).error, /checksum/);
  assert.ok(log.lines.some((l) => l.level === 'warn' && /Couldn't update the addon in WoW Forever/.test(l.msg)));
});

test('concurrent checks share one run and report checking while they work', async (t) => {
  const server = await githubServer(t, { version: '0.12.0' });
  const { addon, events } = setup(t, { server });
  const [a, b] = await Promise.all([addon.check(), addon.check()]);
  assert.strictEqual(a.latest.version, '0.12.0');
  assert.strictEqual(b.latest.version, '0.12.0');
  assert.strictEqual(server.listCalls(), 1);
  assert.ok(events.some((e) => e.checking === true));
  assert.strictEqual(events.at(-1).checking, false);
});

test('updateAll updates every outdated install and nothing else', async (t) => {
  const server = await githubServer(t, { version: '0.12.0' });
  const { addon, installs } = setup(t, { server, games: [['_forever_', 'WoW Forever'], ['_retail_', 'Retail'], ['_classic_', 'Classic']] });
  putAddon(installs[0].addonsDir, '0.11.0');
  putAddon(installs[1].addonsDir, '0.10.0');
  await addon.check();
  const s = await addon.updateAll();
  assert.deepStrictEqual(s.installs.map((i) => i.state), ['current', 'current', 'missing']);
  assert.strictEqual(server.downloads(), 1, 'one download serves every folder');
});

test('updateAll reports the folders it could not update', async (t) => {
  const fsOps = {
    rename: async (from, to) => {
      if (from.includes('_retail_') && path.basename(path.dirname(from)).startsWith('.guildcamp-tmp-')) throw lockError('EBUSY');
      return fs.promises.rename(from, to);
    },
  };
  const { addon, installs } = setup(t, { fsOps, games: [['_forever_', 'WoW Forever'], ['_retail_', 'Retail']] });
  putAddon(installs[0].addonsDir, '0.10.0');
  putAddon(installs[1].addonsDir, '0.10.0');
  await assert.rejects(addon.updateAll(), (err) => /Retail/.test(err.message) && /Close World of Warcraft/.test(err.message));
  assert.strictEqual(installedVersion(installs[0].addonsDir), '0.11.0');
  assert.strictEqual(installedVersion(installs[1].addonsDir), '0.10.0');
});

test('settings changes are reflected in the status', async (t) => {
  const { addon, store, events, game } = setup(t, { settings: { addonAutoUpdate: false } });
  putAddon(game.addonsDir, '0.10.0');
  store.set({ addonAutoUpdate: true });
  assert.strictEqual(events.at(-1).autoUpdate, true);
  // Turning automatic updates on catches up at once.
  for (let i = 0; i < 100 && installedVersion(game.addonsDir) !== '0.11.0'; i++) await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(installedVersion(game.addonsDir), '0.11.0');
  for (let i = 0; i < 100 && stateOf(addon.status(), game.dir).busy; i++) await new Promise((r) => setTimeout(r, 20));
  store.set({ addonAutoUpdate: false });
  assert.strictEqual(events.at(-1).autoUpdate, false);
  assert.strictEqual(addon.status().autoUpdate, false);
});

// ---------------------------------------------------------------------------------------------
// automatic installs (settings.addonAutoInstall)

test('supported game versions come from the toc Interface list', () => {
  assert.deepStrictEqual(flavorsForInterface('16001, 120105'), ['_forever_', '_retail_']);
  assert.deepStrictEqual(flavorsForInterface('11507'), ['_classic_era_']);
  assert.deepStrictEqual(flavorsForInterface('16000,16999 17000 15999'), ['_forever_'], '16000 ≤ n < 17000 only');
  assert.deepStrictEqual(flavorsForInterface('100000'), ['_retail_']);
  assert.deepStrictEqual(flavorsForInterface('11000, 12000, 10999, 11999'), ['_classic_era_']);
  assert.deepStrictEqual(flavorsForInterface('40400, 50500, 99999'), [], 'other game versions are ignored');
  assert.deepStrictEqual(flavorsForInterface(''), []);
  assert.deepStrictEqual(flavorsForInterface(null), []);
  assert.deepStrictEqual(flavorsForInterface('abc, 16001x'), []);
});

const ALL_FLAVORS = [['_forever_', 'WoW Forever'], ['_retail_', 'Retail'], ['_classic_', 'Classic'], ['_classic_era_', 'Classic Era'], ['_ptr_', 'PTR']];

test('check installs the addon into game folders without it, only for supported game versions', async (t) => {
  // The repo's toc says "## Interface: 16001, 120105": WoW Forever and Retail.
  const { addon, installs, log, events } = setup(t, { settings: { addonAutoInstall: true }, games: ALL_FLAVORS });
  putAddon(installs[0].addonsDir, '0.11.0'); // already there: left as it is
  const before = addon.status();
  assert.strictEqual(before.autoInstall, true);
  assert.deepStrictEqual(before.supportedFlavors, ['_forever_', '_retail_']);
  assert.deepStrictEqual(before.installs.map((i) => i.supported), [true, true, false, false, false]);

  const s = await addon.check();
  assert.deepStrictEqual(s.installs.map((i) => i.state), ['current', 'current', 'missing', 'missing', 'missing']);
  assert.deepStrictEqual(installs.map((i) => installedVersion(i.addonsDir)), ['0.11.0', '0.11.0', null, null, null]);
  assert.match(log.text(), /Installing addon 0\.11\.0 in Retail automatically/);
  assert.match(log.text(), /Addon 0\.11\.0 installed in Retail/);
  assert.ok(!/in WoW Forever automatically/.test(log.text()), 'an existing install is not touched');
  assert.ok(events.some((e) => e.installs.some((i) => i.label === 'Retail' && i.busy && i.action === 'install')), 'progress is shown');
  assert.strictEqual(stateOf(events.at(-1), installs[1].dir).state, 'current');
  for (const inst of installs) assert.ok(fs.existsSync(path.join(inst.addonsDir, 'Auctionator', 'Auctionator.lua')), 'other addons untouched');
  assert.deepStrictEqual(leftovers(installs[1].addonsDir), []);
});

test('another game is left alone until the person turns it on: no automatic installs or updates there', async (t) => {
  const { addon, installs, store, log } = setup(t, { settings: { addonAutoInstall: true, addonAutoUpdate: true }, games: [['_forever_', 'WoW Forever'], ['_retail_', 'Retail']], otherGamesOn: false });
  putAddon(installs[1].addonsDir, '0.10.0'); // an older copy already in Retail
  let s = await addon.check();
  assert.deepStrictEqual(s.installs.map((i) => [i.mainGame, i.inUse]), [[true, true], [false, false]]);
  assert.strictEqual(installedVersion(installs[0].addonsDir), '0.11.0', 'WoW Forever gets it automatically');
  assert.strictEqual(installedVersion(installs[1].addonsDir), '0.10.0', 'Retail is not updated');
  assert.ok(!/in Retail automatically/.test(log.text()));
  await addon.updateAll();
  assert.strictEqual(installedVersion(installs[1].addonsDir), '0.10.0', '"Update all" skips it too');

  store.set({ otherGameFolders: [installs[1].dir] });
  s = await addon.check();
  assert.strictEqual(stateOf(s, installs[1].dir).inUse, true);
  assert.strictEqual(installedVersion(installs[1].addonsDir), '0.11.0', 'turned on: looked after like Forever');
});

test('a Classic Era addon goes into Classic Era folders only', async (t) => {
  const { addon, installs, resourcesDir } = setup(t, { settings: { addonAutoInstall: true }, games: ALL_FLAVORS });
  const tocFile = path.join(resourcesDir, 'addon', 'WowGuild', 'WowGuild.toc');
  fs.writeFileSync(tocFile, setTocField(fs.readFileSync(tocFile, 'utf8'), 'Interface', '11507'));
  const s = await addon.check();
  assert.deepStrictEqual(s.supportedFlavors, ['_classic_era_']);
  assert.deepStrictEqual(s.installs.map((i) => i.state), ['missing', 'missing', 'missing', 'current', 'missing']);
});

test('nothing new is installed while automatic installs are off', async (t) => {
  const { addon, installs, log } = setup(t, { settings: { addonAutoInstall: false, addonAutoUpdate: true }, games: ALL_FLAVORS });
  const s = await addon.check();
  assert.strictEqual(s.autoInstall, false);
  assert.ok(s.installs.every((i) => i.state === 'missing'));
  assert.ok(installs.every((i) => installedVersion(i.addonsDir) === null));
  assert.ok(!/Installing addon/.test(log.text()));
});

test('a folder where the person removed the addon is left alone until they install it again', async (t) => {
  const { addon, installs, store } = setup(t, { settings: { addonAutoInstall: true }, games: [['_forever_', 'WoW Forever'], ['_retail_', 'Retail']] });
  await addon.check();
  assert.deepStrictEqual(installs.map((i) => installedVersion(i.addonsDir)), ['0.11.0', '0.11.0']);

  await addon.uninstall(installs[1].dir);
  assert.deepStrictEqual(store.get().addonOptOut, [installs[1].dir]);
  let s = await addon.check();
  assert.strictEqual(installedVersion(installs[1].addonsDir), null, 'not put back');
  assert.strictEqual(stateOf(s, installs[1].dir).optedOut, true);
  assert.strictEqual(stateOf(s, installs[0].dir).optedOut, false);

  // Installing by hand there brings automatic care back.
  await addon.install(installs[1].dir);
  assert.deepStrictEqual(store.get().addonOptOut, []);
  s = addon.status();
  assert.strictEqual(stateOf(s, installs[1].dir).optedOut, false);
  // The renderer can't change the list (it is managed by the app).
  assert.throws(() => require('../src/main/store').sanitizeSettingsPatch({ addonAutoInstall: 'yes' }), /on or off/);
  assert.deepStrictEqual(require('../src/main/store').sanitizeSettingsPatch({ addonOptOut: ['C:\\x'], addonAutoInstall: false }), { addonAutoInstall: false });
});

test('a failing automatic install is logged and shown on the folder, not thrown', async (t) => {
  const fsOps = {
    rename: async (from, to) => {
      if (from.includes('_retail_') && path.basename(path.dirname(from)).startsWith('.guildcamp-tmp-')) throw lockError('EBUSY');
      return fs.promises.rename(from, to);
    },
  };
  const { addon, installs, log } = setup(t, { fsOps, settings: { addonAutoInstall: true }, games: [['_forever_', 'WoW Forever'], ['_retail_', 'Retail']] });
  const s = await addon.check();
  assert.strictEqual(installedVersion(installs[0].addonsDir), '0.11.0');
  assert.strictEqual(installedVersion(installs[1].addonsDir), null);
  assert.match(stateOf(s, installs[1].dir).error, /files are in use/);
  assert.ok(log.lines.some((l) => l.level === 'warn' && /Couldn't install the addon in Retail/.test(l.msg)));
});

test('turning automatic installs on catches up at once', async (t) => {
  const { addon, store, game } = setup(t, { settings: { addonAutoInstall: false } });
  await addon.check();
  assert.strictEqual(installedVersion(game.addonsDir), null);
  store.set({ addonAutoInstall: true });
  assert.strictEqual(addon.status().autoInstall, true);
  for (let i = 0; i < 100 && installedVersion(game.addonsDir) !== '0.11.0'; i++) await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(installedVersion(game.addonsDir), '0.11.0');
  for (let i = 0; i < 100 && stateOf(addon.status(), game.dir).busy; i++) await new Promise((r) => setTimeout(r, 20));
});

test('new game folders show up after the folder list changes', async (t) => {
  const { addon, store, base } = setup(t, { games: [] });
  assert.deepStrictEqual(addon.status().installs, []);
  const extra = path.join(base, 'Games', 'WoW');
  const game = makeGame(extra);
  // A wow module that honours extraRoots, like the real one.
  const wow = { findInstalls: ({ extraRoots }) => (extraRoots.some((r) => r === extra) ? [game] : []) };
  const other = createAddonManager({ store, wow, resourcesDir: makeResources(t), retryDelays: FAST });
  t.after(() => other.dispose());
  assert.strictEqual(other.status().installs.length, 0);
  store.set({ extraWowFolders: [extra] });
  assert.strictEqual(other.status().installs.length, 1);
  assert.strictEqual(other.status().installs[0].root, extra);
});

// ---------------------------------------------------------------------------------------------
// the game running (main-1, addon-2): the game reads the AddOns folders and each .toc's file list only when it starts

const until = async (fn, ms = 3000) => {
  for (const end = Date.now() + ms; Date.now() < end && !fn();) await new Promise((r) => setTimeout(r, 10));
  return fn();
};

// An install of the bundled addon at an older version, with exactly the same files (so only the version changes).
function putSameFiles(addonsDir, resourcesDir, v) {
  const dir = path.join(addonsDir, 'WowGuild');
  fs.cpSync(path.join(resourcesDir, 'addon', 'WowGuild'), dir, { recursive: true });
  setTocVersion(dir, v);
  return dir;
}

test('the hourly check never replaces the addon under a running game: the update waits, shows waitingForGame, and runs once the game has closed', async (t) => {
  const { addon, game, wow, log, store } = setup(t, { settings: { addonAutoUpdate: true }, gameWaitMs: 20 });
  let running = true;
  let asked = 0;
  wow.isWowRunning = async () => { asked += 1; return running; };
  putAddon(game.addonsDir, '0.10.0');

  const s = await addon.check();
  assert.strictEqual(installedVersion(game.addonsDir), '0.10.0', 'the old addon stays while the game runs');
  assert.ok(asked >= 1, 'the game was asked about');
  assert.strictEqual(stateOf(s, game.dir).state, 'outdated');
  assert.strictEqual(stateOf(s, game.dir).waitingForGame, true);
  assert.match(log.text(), /Waiting for World of Warcraft to close before updating the addon in WoW Forever\./);
  // Nothing waits while automatic updates are off; turning them back on (which catches up at once) still waits.
  store.set({ addonAutoUpdate: false });
  assert.strictEqual(stateOf(addon.status(), game.dir).waitingForGame, false);
  store.set({ addonAutoUpdate: true });
  assert.ok(await until(() => stateOf(addon.status(), game.dir).waitingForGame));
  await new Promise((r) => setTimeout(r, 60));
  assert.strictEqual(installedVersion(game.addonsDir), '0.10.0');

  running = false;
  assert.ok(await until(() => installedVersion(game.addonsDir) === '0.11.0'), 'updated once the game closed');
  assert.ok(await until(() => !addon.status().checking && !stateOf(addon.status(), game.dir).busy));
  assert.strictEqual(stateOf(addon.status(), game.dir).waitingForGame, false);
  assert.match(log.text(), /World of Warcraft has closed\./);
  assert.match(log.text(), /Updating addon 0\.11\.0 in WoW Forever \(was 0\.10\.0\) automatically/);
});

test("when Guild Camp can't tell whether the game is running, the automatic update waits too", async (t) => {
  const { addon, game, wow, log } = setup(t, { settings: { addonAutoUpdate: true }, gameWaitMs: 60000 });
  wow.isWowRunning = async () => null;
  putAddon(game.addonsDir, '0.10.0');
  const s = await addon.check();
  assert.strictEqual(installedVersion(game.addonsDir), '0.10.0');
  assert.strictEqual(stateOf(s, game.dir).waitingForGame, true);
  assert.match(log.text(), /Couldn't tell whether World of Warcraft is running, so the addon in WoW Forever is updated once Guild Camp sees it closed\./);
  // A failing check counts as "can't tell".
  wow.isWowRunning = async () => { throw new Error('tasklist failed'); };
  const again = await addon.check();
  assert.strictEqual(installedVersion(game.addonsDir), '0.10.0');
  assert.strictEqual(stateOf(again, game.dir).waitingForGame, true);
});

test('with the game known to be closed, automatic updates and installs go ahead at once', async (t) => {
  const { addon, installs, wow } = setup(t, { settings: { addonAutoUpdate: true, addonAutoInstall: true }, games: [['_forever_', 'WoW Forever'], ['_retail_', 'Retail']] });
  wow.isWowRunning = async () => false;
  putAddon(installs[0].addonsDir, '0.10.0');
  const s = await addon.check();
  assert.deepStrictEqual(installs.map((i) => installedVersion(i.addonsDir)), ['0.11.0', '0.11.0']);
  assert.deepStrictEqual(s.installs.map((i) => i.waitingForGame), [false, false]);
});

test('an automatic install into a game folder waits while the game runs (a new addon folder needs a game start)', async (t) => {
  const { addon, game, wow, log } = setup(t, { settings: { addonAutoInstall: true }, gameWaitMs: 60000 });
  wow.isWowRunning = async () => true;
  const s = await addon.check();
  assert.strictEqual(installedVersion(game.addonsDir), null);
  assert.strictEqual(stateOf(s, game.dir).state, 'missing');
  assert.strictEqual(stateOf(s, game.dir).waitingForGame, true);
  assert.match(log.text(), /Waiting for World of Warcraft to close before installing the addon in WoW Forever\./);
  // Installing by hand still works, and says the game needs a restart.
  const r = await addon.install(game.dir);
  assert.strictEqual(installedVersion(game.addonsDir), '0.11.0');
  assert.strictEqual(r.restartNeeded, true);
  assert.strictEqual(stateOf(r, game.dir).waitingForGame, false);
});

test('a manual update while the game runs, to an addon whose .toc lists new files, says restartNeeded (a /reload is not enough)', async (t) => {
  const { addon, game, wow, log } = setup(t);
  wow.isWowRunning = async () => true;
  putAddon(game.addonsDir, '0.10.0'); // its .toc lists Core.lua only; 0.11.0 adds ShareCodec.lua, Share.lua ...
  const r = await addon.update(game.dir);
  assert.strictEqual(installedVersion(game.addonsDir), '0.11.0', 'the update still happens');
  assert.strictEqual(r.restartNeeded, true);
  assert.match(log.text(), /Restart World of Warcraft to load addon 0\.11\.0 in WoW Forever\. A \/reload isn't enough this time\./);
  // Update all says the same.
  fs.rmSync(path.join(game.addonsDir, 'WowGuild'), { recursive: true });
  putAddon(game.addonsDir, '0.10.0');
  assert.strictEqual((await addon.updateAll()).restartNeeded, true);
  // With the game closed there is nothing to restart.
  wow.isWowRunning = async () => false;
  fs.rmSync(path.join(game.addonsDir, 'WowGuild'), { recursive: true });
  putAddon(game.addonsDir, '0.10.0');
  assert.strictEqual((await addon.update(game.dir)).restartNeeded, false);
});

test('a manual update while the game runs with the same .toc file list needs only a /reload', async (t) => {
  const { addon, game, wow, resourcesDir } = setup(t);
  wow.isWowRunning = async () => true;
  putSameFiles(game.addonsDir, resourcesDir, '0.10.0');
  const r = await addon.update(game.dir);
  assert.strictEqual(installedVersion(game.addonsDir), '0.11.0');
  assert.strictEqual(r.restartNeeded, false);
  assert.strictEqual((await addon.repair(game.dir)).restartNeeded, false, 'a repair of the same version neither');
  assert.strictEqual((await addon.updateAll()).restartNeeded, false);
});

test('the game starting while an automatic update downloads: the addon is not replaced under it, the update waits for the game to close', async (t) => {
  const server = await githubServer(t, { version: '0.12.0' });
  const { addon, game, wow, log } = setup(t, { server, settings: { addonAutoUpdate: true }, gameWaitMs: 20 });
  let closed = false;
  // The game is closed when the check starts and has started by the time the zip has been downloaded.
  wow.isWowRunning = async () => !closed && server.downloads() > 0;
  putAddon(game.addonsDir, '0.10.0');
  const s = await addon.check();
  assert.strictEqual(server.downloads(), 1, 'the update was under way');
  assert.strictEqual(installedVersion(game.addonsDir), '0.10.0', 'the old addon stays under the game that started meanwhile');
  assert.strictEqual(stateOf(s, game.dir).waitingForGame, true);
  assert.match(log.text(), /Waiting for World of Warcraft to close before updating the addon in WoW Forever\./);
  closed = true;
  assert.ok(await until(() => installedVersion(game.addonsDir) === '0.12.0'), 'updated once the game closed');
  assert.ok(await until(() => !addon.status().checking && !stateOf(addon.status(), game.dir).busy));
  assert.strictEqual(stateOf(addon.status(), game.dir).waitingForGame, false);
  assert.strictEqual(server.downloads(), 1, 'the saved download was used');
});

test('tocFiles reads the file list of a .toc', () => {
  const { tocFiles } = require('../src/main/addon');
  assert.deepStrictEqual(tocFiles('## Interface: 16001\r\n## Title: Guild Camp\r\n# a comment\r\n\r\nCore.lua\r\n  Libs\\LibStub.lua \r\nShare.lua\r\n'), ['core.lua', 'libs/libstub.lua', 'share.lua']);
  assert.strictEqual(tocFiles(undefined), null);
});

// ---------------------------------------------------------------------------------------------
// page helpers (pages/addon.js exports its pure logic)

test('addon page helpers', async () => {
  const page = await import(pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'pages', 'addon.js')).href);
  // Which buttons a game folder gets.
  assert.deepStrictEqual(page.installActions({ state: 'missing' }, { version: '0.11.0' }), ['install']);
  assert.deepStrictEqual(page.installActions({ state: 'outdated' }, { version: '0.11.0' }), ['update', 'uninstall']);
  assert.deepStrictEqual(page.installActions({ state: 'current' }, { version: '0.11.0' }), ['repair', 'uninstall']);
  assert.deepStrictEqual(page.installActions({ state: 'newer' }, { version: '0.11.0' }), ['repair', 'uninstall']);
  assert.deepStrictEqual(page.installActions({ state: 'outdated', damaged: true }, { version: '0.11.0' }), ['repair', 'uninstall']);
  assert.deepStrictEqual(page.installActions({ state: 'missing' }, null), [], 'nothing to install');
  // Another game, not turned on: no install or update, only removing a copy that is there.
  assert.deepStrictEqual(page.installActions({ state: 'missing', inUse: false }, { version: '0.11.0' }), []);
  assert.deepStrictEqual(page.installActions({ state: 'outdated', inUse: false }, { version: '0.11.0' }), ['uninstall']);
  // Turning another game on or off in settings.otherGameFolders.
  assert.deepStrictEqual(page.withOtherFolder(['D:\\WoW\\_retail_'], 'd:\\wow\\_retail_\\', false), []);
  assert.deepStrictEqual(page.withOtherFolder(null, 'D:\\WoW\\_retail_', true), ['D:\\WoW\\_retail_']);
  assert.deepStrictEqual(page.withOtherFolder(['D:\\WoW\\_retail_'], 'D:\\WoW\\_retail_', true), ['D:\\WoW\\_retail_'], 'no duplicates');
  // Log lines that belong on this page.
  assert.strictEqual(page.isSyncOrAddonLine({ scope: 'sync' }), true);
  assert.strictEqual(page.isSyncOrAddonLine({ scope: 'addon' }), true);
  assert.strictEqual(page.isSyncOrAddonLine({ scope: 'sync:inbox' }), true);
  assert.strictEqual(page.isSyncOrAddonLine({ scope: 'wow' }), true);
  assert.strictEqual(page.isSyncOrAddonLine({ scope: 'updater' }), false);
  assert.strictEqual(page.isSyncOrAddonLine({ scope: 'app' }), false);
  // Custom folders: which settings entry a found install came from.
  const folders = ['D:\\Games\\WoW', 'E:\\Empty'];
  assert.strictEqual(page.customFolderFor({ root: 'd:\\games\\wow', dir: 'D:\\Games\\WoW\\_forever_' }, folders), 'D:\\Games\\WoW');
  assert.strictEqual(page.customFolderFor({ root: 'D:\\Games', dir: 'D:\\Games\\WoW\\_retail_' }, folders), 'D:\\Games\\WoW');
  assert.strictEqual(page.customFolderFor({ root: 'C:\\Program Files (x86)\\World of Warcraft', dir: 'C:\\Program Files (x86)\\World of Warcraft\\_forever_' }, folders), null);
  assert.deepStrictEqual(page.unusedFolders([{ root: 'D:\\Games\\WoW', dir: 'D:\\Games\\WoW\\_forever_' }], folders), ['E:\\Empty']);
  // Saved-variables paths are shown from the game folder.
  assert.strictEqual(page.shortFile('C:\\WoW\\_forever_\\WTF\\Account\\CALVIN\\SavedVariables\\WowGuild.lua', 'C:\\WoW\\_forever_'), 'WTF\\Account\\CALVIN\\SavedVariables\\WowGuild.lua');
  assert.strictEqual(page.shortFile('C:\\WoW\\_forever_\\WTF\\x.lua', 'c:\\wow\\_forever_\\'), 'WTF\\x.lua');
  assert.strictEqual(page.shortFile('D:\\Other\\x.lua', 'C:\\WoW\\_forever_'), 'D:\\Other\\x.lua');
  assert.strictEqual(page.shortFile('D:\\Other\\x.lua', null), 'D:\\Other\\x.lua');
  // After a change: a /reload when that loads it, a game restart when the main process says restartNeeded.
  assert.strictEqual(page.actionDoneText('update', '0.12.0', 'WoW Forever'), 'Addon updated to 0.12.0 in WoW Forever. Type /reload in the game to load it.');
  assert.strictEqual(page.actionDoneText('update', '0.12.0', 'WoW Forever', true), "Addon updated to 0.12.0 in WoW Forever. Restart World of Warcraft to load it. A /reload isn't enough this time.");
  assert.strictEqual(page.actionDoneText('install', '0.12.0', 'Retail', true), "Addon 0.12.0 installed in Retail. Restart World of Warcraft to load it. A /reload isn't enough this time.");
  assert.strictEqual(page.actionDoneText('install', '0.12.0', 'Retail'), 'Addon 0.12.0 installed in Retail. Start the game to load it.', 'no /reload for a new addon folder');
  assert.strictEqual(page.actionDoneText('repair', '0.12.0', 'Retail', true), `Addon 0.12.0 reinstalled in Retail. ${page.RESTART_LINE}`);
  assert.strictEqual(page.actionDoneText('uninstall', '', 'Retail', true), 'Addon removed from Retail.');
  assert.strictEqual(page.updateAllText('0.12.0', true), `Addon updated to 0.12.0. ${page.RESTART_LINE}`);
  assert.strictEqual(page.updateAllText(null), 'Addon updated to the newest version. Type /reload in the game to load it.');
  // A folder whose automatic change waits for the game to close.
  assert.strictEqual(page.waitingText({ state: 'outdated', waitingForGame: false }), '');
  assert.match(page.waitingText({ state: 'outdated', waitingForGame: true }), /updates the addon here once World of Warcraft is closed/);
  assert.match(page.waitingText({ state: 'missing', waitingForGame: true }), /installs the addon here once World of Warcraft is closed/);
  // Sync result summary.
  assert.strictEqual(page.describeResult({ characters: 2, roster: 9, recipes: 141 }), '2 characters, 9 roster rows, 141 recipes');
  assert.strictEqual(page.describeResult({ characters: 1 }), '1 character');
  assert.strictEqual(page.describeResult(null), '');
});
