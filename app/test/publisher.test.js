// Publisher (src/main/publisher.js): the Releases page backend. Publishes GitHub releases with a fake GitHub CLI
// (a small Node script first on PATH) over temp checkouts. Nothing here talks to GitHub.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const { createPublisher, findRepoFrom, looksLikeRepo, cleanBump, cleanNotes, setupSteps } = require('../src/main/publisher');
const { createStore } = require('../src/main/store');
const release = require('../src/shared/release');
const { readZip } = require('../src/shared/zip');
const { tocVersion } = require('../src/shared/toc');

const sha512b64 = (buf) => crypto.createHash('sha512').update(buf).digest('base64');
const sha256hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function tmpDir(t, label = 'gc-publisher-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), label));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
}

// Writes dist/latest.yml + installer + blockmap for whatever version package.json says, like
// electron-builder does. Used as the checkout's "npm run dist". It also copies
// src/main/bnet-credentials.json to dist/bnet-seen.json when it exists, so tests see what the build got.
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
const cred = path.join(__dirname, 'src', 'main', 'bnet-credentials.json');
const seen = path.join(dist, 'bnet-seen.json');
if (fs.existsSync(cred)) fs.copyFileSync(cred, seen); else if (fs.existsSync(seen)) fs.unlinkSync(seen);
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

async function offlineFetch() {
  throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
}
function apiFetch(list) {
  return async () => new Response(JSON.stringify(list), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

// A publisher over a temp user-data folder. `env` is what gh runs with (fake.env, or noGhEnv()).
function setup(t, { repo, env, isPackaged = false, appDir, buildApp, settings, fetchImpl = offlineFetch, bnetCredentials } = {}) {
  const userData = tmpDir(t, 'gc-publisher-ud-');
  const store = createStore(userData);
  if (settings) store.set(settings);
  const logged = [];
  const log = { info: (m) => logged.push(['info', m]), warn: (m) => logged.push(['warn', m]), error: (m) => logged.push(['error', m]) };
  const publisher = createPublisher({
    store, log, appVersion: '0.11.0', isPackaged, appDir: appDir || (repo ? repo.appDir : userData), buildApp, env, fetch: fetchImpl, bnetCredentials,
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

test('status: a dev build with gh signed in and push access can publish, and sees what is on GitHub', async (t) => {
  const repo = makeRepo(t, { appVersion: '1.2.0', addonVersion: '1.0.3' });
  const fake = makeFakeGh(t, { releases: [ghRelease('addon', '1.0.2', { notes: 'Old.' })] });
  const { publisher } = setup(t, { repo, env: fake.env });
  const st = await publisher.status();
  assert.strictEqual(st.canPublish, true);
  assert.strictEqual(st.reason, null);
  assert.deepStrictEqual(st.setup.steps.map((s) => [s.id, s.done]), [['repo', true], ['gh', true], ['login', true], ['push', true]]);
  assert.deepStrictEqual(st.setup.gh, { installed: true, version: '2.99.0', loggedIn: true, account: 'octo-owner', push: true, problem: null, note: null });
  assert.strictEqual(st.repo, 'arrow-quiver/wow');
  assert.strictEqual(st.releasesUrl, 'https://github.com/arrow-quiver/wow/releases');
  assert.strictEqual(st.repoPrivate, false);
  assert.strictEqual(st.isPackaged, false);
  assert.strictEqual(st.repoDir, repo.root);
  assert.strictEqual(st.repoSource, 'detected');
  assert.deepStrictEqual(st.addonSource, { dir: repo.addonDir, version: '1.0.3' });
  assert.deepStrictEqual(st.appSource, { dir: repo.appDir, version: '1.2.0' });
  assert.strictEqual(st.appVersion, '1.2.0');
  assert.strictEqual(st.runningVersion, '0.11.0');
  assert.strictEqual(st.published.addon.version, '1.0.2');
  assert.strictEqual(st.published.addon.url, 'https://github.com/arrow-quiver/wow/releases/tag/addon-v1.0.2');
  assert.strictEqual(st.published.app, null);
  assert.strictEqual(st.published.history.length, 1);
  assert.strictEqual(st.publishedError, null);
  assert.deepStrictEqual(st.bnet, { ready: false, from: null, problem: null });
  assert.strictEqual(st.building, false);
  assert.strictEqual(st.changelog, null, 'no .git, no suggestions');
  // gh is asked once, then the answer is reused for a while.
  const calls = fake.calls().length;
  await publisher.status();
  assert.strictEqual(fake.calls().length, calls);
});

test('status: what is missing is explained, one step at a time', async (t) => {
  const repo = makeRepo(t);
  // No GitHub CLI: the public release list still shows what is published.
  let st = await setup(t, { repo, env: noGhEnv(t), fetchImpl: apiFetch([ghRelease('app', '0.12.0')]) }).publisher.status();
  assert.strictEqual(st.canPublish, false);
  assert.strictEqual(st.reason, 'Install GitHub CLI and run gh auth login to publish releases.');
  assert.deepStrictEqual(st.setup.steps.map((s) => s.done), [true, false, false, false]);
  assert.strictEqual(st.setup.steps[1].command, 'winget install --id GitHub.cli');
  assert.strictEqual(st.published.app.version, '0.12.0');

  const fake = makeFakeGh(t, { authed: false });
  st = await setup(t, { repo, env: fake.env }).publisher.status();
  assert.strictEqual(st.canPublish, false);
  assert.match(st.reason, /Run gh auth login/);
  assert.strictEqual(st.setup.steps[2].command, 'gh auth login');
  assert.strictEqual(st.published, null);
  assert.match(st.publishedError, /Couldn't read the releases on GitHub/);

  fake.set({ authed: true, push: false });
  st = await setup(t, { repo, env: fake.env }).publisher.status();
  assert.strictEqual(st.canPublish, false);
  assert.match(st.reason, /\(octo-owner\) can't push to arrow-quiver\/wow/);
  assert.deepStrictEqual(st.setup.steps.map((s) => s.done), [true, true, true, false]);

  // Push access that can't be checked doesn't block (publishing says so if it fails).
  fake.set({ push: null, private: true });
  st = await setup(t, { repo, env: fake.env }).publisher.status();
  assert.strictEqual(st.canPublish, true);
  assert.strictEqual(st.repoPrivate, true);

  // An installed build without a chosen checkout.
  st = await setup(t, { repo, env: fake.env, isPackaged: true, appDir: path.join(tmpDir(t), 'resources', 'app.asar') }).publisher.status();
  assert.strictEqual(st.canPublish, false);
  assert.match(st.reason, /source checkout/);
  assert.strictEqual(st.setup.steps[0].command, 'git clone https://github.com/arrow-quiver/wow.git');
  assert.strictEqual(st.repoDir, null);
  assert.strictEqual(st.addonSource, null);
  assert.strictEqual(st.appVersion, '0.11.0', 'falls back to the running version');
});

test('a publisher made in a test without a fake gh can never publish for real', async (t) => {
  const repo = makeRepo(t);
  // No env: gh would come from the real PATH. Inside tests that is refused, so this computer looks unset.
  const { publisher } = setup(t, { repo });
  const st = await publisher.status();
  assert.strictEqual(st.canPublish, false);
  await assert.rejects(publisher.publishAddon({ bump: 'patch' }), (e) => e.code === 'cannot-publish');
  await assert.rejects(publisher.publishApp({ bump: 'patch' }), (e) => e.code === 'cannot-publish');
  assert.strictEqual(readToc(repo.addonDir), '1.0.0');
  assert.strictEqual(readPkg(repo.appDir), '1.0.0');
});

test('setupSteps is pure and says what to do next', () => {
  const ready = setupSteps({ repoDir: 'C:\\src\\wow', gh: { installed: true, version: '2.1.0', loggedIn: true, account: 'me', push: true } });
  assert.strictEqual(ready.reason, null);
  assert.ok(ready.steps.every((s) => s.done));
  const none = setupSteps({ repoDir: null, gh: null, isPackaged: true });
  assert.match(none.reason, /source checkout/);
  assert.match(none.steps[0].detail, /choose its folder on this page/);
  const problem = setupSteps({ repoDir: null, repoProblem: 'The source folder you chose (X) isn\'t a Guild Camp checkout any more. Choose it again.', gh: {} });
  assert.match(problem.reason, /isn't a Guild Camp checkout any more/);
});

test('setRepoDir accepts the checkout (or its app folder), refuses other folders, and null resets', async (t) => {
  const repo = makeRepo(t);
  const fake = makeFakeGh(t);
  const { publisher, store } = setup(t, { repo, env: fake.env, isPackaged: true, appDir: tmpDir(t) });
  let st = await publisher.setRepoDir(path.join(repo.root, 'app'));
  assert.strictEqual(st.repoDir, repo.root);
  assert.strictEqual(st.repoSource, 'chosen');
  assert.strictEqual(st.canPublish, true);
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
  assert.strictEqual(st.reason, st.repoProblem);
});

test('publishAddon bumps the toc, zips WowGuild/ and creates release addon-v<version> with the zip and its .sha256', async (t) => {
  const repo = makeRepo(t, { addonVersion: '1.0.0' });
  const fake = makeFakeGh(t, { releases: [ghRelease('addon', '1.0.0')] });
  const { publisher, lines } = setup(t, { repo, env: fake.env });
  const out = await publisher.publishAddon({ bump: 'patch', notes: 'Tooltips show guild bank stock.\r\nFaster sync.' });
  assert.strictEqual(out.kind, 'addon');
  assert.strictEqual(out.version, '1.0.1');
  assert.strictEqual(out.previous, '1.0.0');
  assert.strictEqual(out.tag, 'addon-v1.0.1');
  assert.strictEqual(out.url, 'https://github.com/arrow-quiver/wow/releases/tag/addon-v1.0.1');
  assert.strictEqual(readToc(repo.addonDir), '1.0.1');
  assert.ok(fs.readFileSync(path.join(repo.addonDir, 'WowGuild.toc'), 'utf8').includes('\r\n'), 'keeps CRLF line endings');

  const rel = fake.release('addon-v1.0.1');
  assert.strictEqual(rel.latest, false, 'never marked Latest');
  assert.strictEqual(rel.name, 'Guild Camp addon 1.0.1');
  assert.strictEqual(rel.body, 'Tooltips show guild bank stock.\nFaster sync.\n');
  assert.deepStrictEqual(rel.assets.map((a) => a.name), ['WowGuild-1.0.1.zip', 'WowGuild-1.0.1.zip.sha256']);
  const zip = fs.readFileSync(path.join(fake.uploads('addon-v1.0.1'), 'WowGuild-1.0.1.zip'));
  const names = readZip(zip).map((e) => e.name);
  assert.ok(names.includes('WowGuild/WowGuild.lua'));
  assert.ok(names.includes('WowGuild/Data/Items.lua'));
  assert.strictEqual(fs.readFileSync(path.join(fake.uploads('addon-v1.0.1'), 'WowGuild-1.0.1.zip.sha256'), 'utf8'), `${sha256hex(zip)}  WowGuild-1.0.1.zip\n`);

  const text = lines.map((l) => l.line);
  assert.ok(text.some((l) => /Addon version: 1\.0\.0 → 1\.0\.1/.test(l)));
  assert.ok(text.some((l) => /Packed 3 files: WowGuild-1\.0\.1\.zip/.test(l)));
  assert.ok(text.some((l) => /Addon 1\.0\.1 is live: https:\/\/github\.com/.test(l)));
  assert.ok(text.some((l) => /Commit the new version in WowGuild\.toc and push it/.test(l)));
  assert.ok(lines.every((l) => l.kind === 'addon' && l.t && l.level));
  const st = await publisher.status();
  assert.strictEqual(st.lastResult.version, '1.0.1');
  assert.strictEqual(st.lastResult.url, out.url);
  assert.strictEqual(st.published.addon.version, '1.0.1', 'the release list is read again after a job');
  assert.ok(st.log.length >= 3, 'status keeps the log for a page that opens later');
});

test('publishAddon refuses a version GitHub already has, or an older one, before touching anything', async (t) => {
  const repo = makeRepo(t, { addonVersion: '1.0.0' });
  const fake = makeFakeGh(t, { releases: [ghRelease('addon', '1.0.1'), ghRelease('addon', '1.0.0')] });
  const { publisher } = setup(t, { repo, env: fake.env });
  await assert.rejects(publisher.publishAddon({ bump: null }), (e) => e.status === 409 && e.code === 'exists' && /GitHub already has the release addon-v1\.0\.0/.test(e.message));
  await assert.rejects(publisher.publishAddon({ bump: '0.9.0' }), (e) => e.code === 'not-newer' && /GitHub already has addon 1\.0\.1, and 0\.9\.0 isn't newer/.test(e.message));
  await assert.rejects(publisher.publishAddon({ bump: 'patch' }), (e) => e.code === 'exists', '1.0.0 → 1.0.1 exists too');
  assert.strictEqual(readToc(repo.addonDir), '1.0.0', 'toc untouched');
  assert.strictEqual(fake.creates().length, 0, 'nothing published');
  assert.strictEqual((await publisher.publishAddon({ bump: 'minor' })).version, '1.1.0');
});

test('a failed gh release create puts the toc version back', async (t) => {
  const repo = makeRepo(t, { addonVersion: '2.3.4' });
  const fake = makeFakeGh(t, { failCreate: 'HTTP 502: Bad Gateway (https://uploads.github.com/)' });
  const { publisher, lines } = setup(t, { repo, env: fake.env });
  await assert.rejects(publisher.publishAddon({ bump: 'minor' }), (e) => /Bad Gateway/.test(e.message) && /Creating the GitHub release addon-v2\.4\.0 failed/.test(e.message) && !e.stack.includes('ReleaseError:'));
  assert.strictEqual(readToc(repo.addonDir), '2.3.4');
  assert.ok(lines.some((l) => /Put WowGuild\.toc back to 2\.3\.4/.test(l.line)));
  assert.ok(lines.some((l) => l.level === 'error' && /Bad Gateway/.test(l.line)));
  const st = await publisher.status();
  assert.match(st.lastError.message, /Bad Gateway/);
  assert.strictEqual(st.lastError.code, 'gh-failed');
  assert.strictEqual(st.building, false);
});

test('publishAddon from another folder, preview, and input checks', async (t) => {
  const repo = makeRepo(t);
  const other = makeRepo(t, { addonVersion: '3.0.0-beta.1' });
  const fake = makeFakeGh(t);
  const { publisher } = setup(t, { repo, env: fake.env });
  const pv = await publisher.publishAddon({ sourceDir: path.dirname(other.addonDir), bump: 'beta', preview: true });
  assert.deepStrictEqual(pv, { preview: true, dir: other.addonDir, version: '3.0.0-beta.1', next: '3.0.0-beta.2', problem: null });
  assert.strictEqual(readToc(other.addonDir), '3.0.0-beta.1', 'preview writes nothing');
  assert.deepStrictEqual(fake.calls(), [], 'preview runs no gh');
  await assert.rejects(publisher.publishAddon({ sourceDir: tmpDir(t), preview: true }), (e) => e.status === 404 && /no WowGuild\.toc/.test(e.message));

  const out = await publisher.publishAddon({ sourceDir: other.addonDir, bump: '3.0.0' });
  assert.strictEqual(out.version, '3.0.0');
  assert.strictEqual(readToc(other.addonDir), '3.0.0');
  assert.strictEqual(readToc(repo.addonDir), '1.0.0');

  await assert.rejects(publisher.publishAddon({ bump: 'huge' }), (e) => e.status === 400 && /isn't a choice/.test(e.message));
  await assert.rejects(publisher.publishAddon({ sourceDir: 'addon/WowGuild' }), (e) => e.status === 400 && /full folder path/.test(e.message));
  await assert.rejects(publisher.publishAddon({ notes: 'x'.repeat(4001) }), (e) => e.status === 400 && /up to 4,000 characters/.test(e.message));
});

test('nothing is published until this computer is set up', async (t) => {
  const repo = makeRepo(t);
  await assert.rejects(setup(t, { repo, env: noGhEnv(t) }).publisher.publishAddon({ bump: 'patch' }),
    (e) => e.status === 403 && e.code === 'cannot-publish' && /Install GitHub CLI and run gh auth login/.test(e.message));
  const fake = makeFakeGh(t, { push: false });
  await assert.rejects(setup(t, { repo, env: fake.env }).publisher.publishApp({ bump: 'patch' }), (e) => e.status === 403 && /can't push/.test(e.message));
  assert.strictEqual(fake.creates().length, 0);
  assert.strictEqual(readToc(repo.addonDir), '1.0.0');
  assert.strictEqual(readPkg(repo.appDir), '1.0.0');
  const packaged = setup(t, { repo, env: makeFakeGh(t).env, isPackaged: true, appDir: tmpDir(t) });
  await assert.rejects(packaged.publisher.publishApp({ bump: 'patch' }), (e) => e.code === 'cannot-publish' && /source checkout/.test(e.message));
});

test('publishApp bumps, builds with Battle.net built in, and creates release v<version>, marked Latest', async (t) => {
  const repo = makeRepo(t, { appVersion: '1.0.0' });
  fs.writeFileSync(path.join(repo.root, '.release.json'), JSON.stringify({ bnetClientId: 'repo-client-id', bnetClientSecret: 'repo-secret' }));
  const fake = makeFakeGh(t, { releases: [ghRelease('app', '1.0.0')] });
  const { publisher, lines } = setup(t, { repo, env: fake.env });
  assert.deepStrictEqual((await publisher.status()).bnet, { ready: true, from: '.release.json', problem: null });
  const out = await publisher.publishApp({ bump: 'minor', notes: 'New Updates page.' });
  assert.strictEqual(out.kind, 'app');
  assert.strictEqual(out.version, '1.1.0');
  assert.strictEqual(out.previous, '1.0.0');
  assert.strictEqual(out.tag, 'v1.1.0');
  assert.deepStrictEqual(out.files.map((f) => f.name).sort(), ['Guild-Camp-Setup-1.1.0.exe', 'Guild-Camp-Setup-1.1.0.exe.blockmap']);
  assert.strictEqual(readPkg(repo.appDir), '1.1.0');
  const rel = fake.release('v1.1.0');
  assert.strictEqual(rel.latest, true);
  assert.strictEqual(rel.body, 'New Updates page.\n');
  assert.deepStrictEqual(rel.assets.map((a) => a.name), ['Guild-Camp-Setup-1.1.0.exe', 'Guild-Camp-Setup-1.1.0.exe.blockmap', 'latest.yml']);
  const exe = fs.readFileSync(path.join(repo.appDir, 'dist', 'Guild-Camp-Setup-1.1.0.exe'));
  assert.strictEqual(out.files.find((f) => f.name.endsWith('.exe')).sha512, sha512b64(exe));
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(repo.appDir, 'dist', 'bnet-seen.json'), 'utf8')), { clientId: 'repo-client-id', clientSecret: 'repo-secret' });
  assert.strictEqual(fs.existsSync(path.join(repo.appDir, 'src', 'main', 'bnet-credentials.json')), false, 'the credentials file is gone after the build');
  const text = lines.map((l) => l.line);
  assert.ok(text.some((l) => /App version: 1\.0\.0 → 1\.1\.0/.test(l)));
  assert.ok(text.some((l) => /fake electron-builder/.test(l)), 'build output is streamed');
  assert.ok(text.some((l) => /Battle\.net sign-in is built in \(client id repo…, from \.release\.json\)/.test(l)));
  assert.ok(!text.some((l) => l.includes('repo-secret')), 'the secret never reaches the log');
  assert.ok(text.some((l) => /Guild Camp 1\.1\.0 is live: https:\/\/github\.com\/arrow-quiver\/wow\/releases\/tag\/v1\.1\.0/.test(l)));
  assert.ok(lines.every((l) => l.kind === 'app'));
});

test('publishApp without Battle.net credentials warns; the running app can hand over its own', async (t) => {
  const repo = makeRepo(t, { appVersion: '1.0.0' });
  const fake = makeFakeGh(t);
  const { publisher, lines } = setup(t, { repo, env: fake.env });
  await publisher.publishApp({ bump: 'patch' });
  assert.ok(lines.some((l) => l.level === 'warn' && /no Battle\.net sign-in/.test(l.line)));
  assert.strictEqual(fs.existsSync(path.join(repo.appDir, 'dist', 'bnet-seen.json')), false);

  const injected = setup(t, { repo, env: fake.env, bnetCredentials: () => ({ clientId: 'app-builtin-id', clientSecret: 'app-secret' }) });
  assert.deepStrictEqual((await injected.publisher.status()).bnet, { ready: true, from: 'this app', problem: null });
  await injected.publisher.publishApp({ bump: 'patch' });
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(repo.appDir, 'dist', 'bnet-seen.json'), 'utf8')).clientId, 'app-builtin-id');

  // Half a pair is refused before the build.
  const half = setup(t, { repo, env: { ...fake.env, GUILDCAMP_BNET_CLIENT_ID: 'only-the-id' } });
  assert.match((await half.publisher.status()).bnet.problem, /GUILDCAMP_BNET_CLIENT_SECRET isn't/);
  await assert.rejects(half.publisher.publishApp({ bump: 'patch' }), (e) => e.code === 'bnet-half');
  assert.strictEqual(readPkg(repo.appDir), '1.0.2');
});

test('publishApp: one job at a time, and cancel stops the build and undoes the bump', async (t) => {
  const repo = makeRepo(t, { appVersion: '1.0.0' });
  const fake = makeFakeGh(t);
  let started;
  const startedP = new Promise((r) => { started = r; });
  const buildApp = (appDir, { onLog, signal }) => new Promise((resolve, reject) => {
    onLog('  • building target=nsis');
    started();
    signal.addEventListener('abort', () => reject(new release.ReleaseError('The app build was cancelled.', { code: 'ABORTED' })));
  });
  const { publisher, lines } = setup(t, { repo, env: fake.env, buildApp });
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
  assert.strictEqual(fake.creates().length, 0);
});

test('publishApp refuses a build whose version does not match, and a version GitHub already has', async (t) => {
  const repo = makeRepo(t, { appVersion: '1.0.0' });
  const fake = makeFakeGh(t);
  const buildApp = async (appDir) => {
    // A stale dist/ from an older build.
    const dist = path.join(appDir, 'dist');
    fs.mkdirSync(dist, { recursive: true });
    const data = Buffer.from('old');
    fs.writeFileSync(path.join(dist, 'Guild-Camp-Setup-0.9.0.exe'), data);
    fs.writeFileSync(path.join(dist, 'latest.yml'), `version: 0.9.0\nfiles:\n  - url: Guild-Camp-Setup-0.9.0.exe\n    sha512: ${sha512b64(data)}\n    size: 3\npath: Guild-Camp-Setup-0.9.0.exe\n`);
    return { distDir: dist };
  };
  const { publisher } = setup(t, { repo, env: fake.env, buildApp });
  await assert.rejects(publisher.publishApp({ bump: 'patch' }), (e) => e.code === 'mismatch' && /is version 0\.9\.0, but app\/package\.json says 1\.0\.1/.test(e.message));
  assert.strictEqual(readPkg(repo.appDir), '1.0.0');
  assert.strictEqual(fake.creates().length, 0);

  fake.set({ releases: [ghRelease('app', '1.0.0')] });
  await assert.rejects(publisher.publishApp({}), (e) => e.code === 'exists' && /GitHub already has the release v1\.0\.0/.test(e.message));
});

test('release notes are suggested from git history when the checkout is a git repo', async (t) => {
  const repo = makeRepo(t);
  const fake = makeFakeGh(t);
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgSign=false', ...args], { cwd: repo.root, stdio: 'pipe' });
  try {
    git('init', '-q');
  } catch {
    t.skip('git is not installed');
    return;
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'First commit');
  git('tag', 'v1.0.0');
  fs.writeFileSync(path.join(repo.addonDir, 'WowGuild.lua'), 'WowGuild = {}\n-- tooltips\n');
  git('commit', '-q', '-am', 'Tooltips show guild bank stock');
  fs.writeFileSync(path.join(repo.appDir, 'build.js'), `${FAKE_BUILD}\n// tray\n`);
  git('commit', '-q', '-am', 'Tray menu');
  const { publisher } = setup(t, { repo, env: fake.env });
  const st = await publisher.status();
  assert.strictEqual(st.hasGit, true);
  assert.match(st.changelog.addon, /- Tooltips show guild bank stock/);
  assert.strictEqual(st.changelog.app, '- Tray menu', 'since the v1.0.0 tag');
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

test('Releases page helpers', async () => {
  const { pathToFileURL } = require('url');
  const page = await import(pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'pages', 'releases.js')).href);
  assert.deepStrictEqual(page.setupList({ setup: { steps: [{ id: 'repo', done: true }, { id: 'gh', done: false }, { id: 'login', done: false }] } }).map((s) => s.next), [false, true, false]);
  assert.deepStrictEqual(page.setupList(null), []);
  assert.strictEqual(page.bumpVersion('1.2.3', 'patch'), '1.2.4');
  assert.strictEqual(page.bumpVersion('1.2.3', 'beta'), '1.2.4-beta.1');
  assert.strictEqual(page.compareVersions('1.0.0-beta.2', '1.0.0'), -1);
  const updates = await import(pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'pages', 'updates.js')).href);
  assert.deepStrictEqual(updates.splitNotes('## Fixes\n- Tooltips\n- Faster sync\n\nThanks!'), [{ text: 'Fixes' }, { list: true, items: ['Tooltips', 'Faster sync'] }, { text: 'Thanks!' }]);
  const history = [{ kind: 'app', version: '0.12.0', tag: 'v0.12.0' }, { kind: 'addon', version: '0.12.0', tag: 'addon-v0.12.0' }, { kind: 'other' }];
  assert.deepStrictEqual(updates.historyRows({ releases: { history } }).map((r) => r.tag), ['v0.12.0', 'addon-v0.12.0']);
  assert.deepStrictEqual(updates.historyRows(null), []);
  assert.strictEqual(updates.RELEASES_URL, 'https://github.com/arrow-quiver/wow/releases');
});
