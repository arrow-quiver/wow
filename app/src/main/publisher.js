'use strict';
// Backend of the Releases page: publishes addon and app updates as GitHub releases on arrow-quiver/wow
// with shared/release.js (the same pipeline as scripts/release.js and CI), running the GitHub CLI (gh)
// on this computer.
//
//   const publisher = createPublisher({ store, log, appVersion, isPackaged, appDir });
//   await publisher.status();
//   await publisher.publishAddon({ sourceDir, bump, notes });           // bump: null | patch | minor | major | beta | "1.2.3"
//   await publisher.publishAddon({ sourceDir, bump, preview: true });  // reads the folder, publishes nothing
//   await publisher.publishApp({ bump, notes });                       // bump, npm run dist, gh release create
//   publisher.cancel();                                                // stops a running build or upload
//   await publisher.setRepoDir(dir | null);
//   events: 'log' ({ t, kind, level, line }), 'job' ({ kind, startedAt } | null)
//
// Who can publish: anyone whose computer has a source checkout of Guild Camp, GitHub CLI installed and
// signed in (gh auth login), with push access to the repo. status().canPublish says so, and
// status().setup lists what is missing, in order, for the page's setup instructions. There are no
// guild roles here: publishing is about the code, not the guild.
//
// One job runs at a time. A version bump that doesn't end in a published release is undone, so trying
// again doesn't skip a number. The app build gets the Battle.net credentials from the environment
// (GUILDCAMP_BNET_CLIENT_ID / _SECRET) or the checkout's .release.json, like scripts/release.js.
// Plain Node (no Electron), so it is unit tested with temp folders and a fake gh.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { EventEmitter } = require('events');
const sharedRelease = require('../shared/release');
const version = require('../shared/version');

const MAX_NOTES = 4000;
const LOG_KEEP = 400; // lines kept for a page that opens in the middle of a build
const CHANGELOG_TTL_MS = 60 * 1000;
const STATUS_TTL_MS = 30 * 1000; // gh checks and the release list are reused this long by status()
const REPO = sharedRelease.GITHUB_REPO;

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const exists = (p) => { try { fs.statSync(p); return true; } catch { return false; } };

/** A Guild Camp source checkout: app/package.json and addon/WowGuild/WowGuild.toc. */
function looksLikeRepo(dir) {
  return Boolean(dir) && isFile(path.join(dir, 'app', 'package.json')) && isFile(path.join(dir, 'addon', 'WowGuild', 'WowGuild.toc'));
}

/** Walks up from `start` (the running app's folder in dev) to the checkout that contains it. */
function findRepoFrom(start, maxUp = 8) {
  if (!start) return null;
  let dir = path.resolve(start);
  for (let i = 0; i <= maxUp; i++) {
    if (looksLikeRepo(dir)) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

// git, without blocking: the main process also runs the window, so no execFileSync here.
function git(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout).trim());
    });
  });
}

/**
 * Same result as release.gitChangelog (commit subjects that touched the addon or the app since the
 * previous addon-v* / v* tag, release commits left out), but asynchronous.
 */
async function gitChangelogAsync(repoDir, kind, { max = 60 } = {}) {
  const paths = kind === 'addon' ? ['addon/WowGuild'] : ['app'];
  let prev = '';
  try { prev = await git(repoDir, ['describe', '--tags', '--abbrev=0', '--match', sharedRelease.TAG_MATCH[kind], 'HEAD^']); } catch { /* first release */ }
  let subjects = [];
  try {
    subjects = (await git(repoDir, ['log', '--no-merges', '--format=%s', prev ? `${prev}..HEAD` : 'HEAD', '--', ...paths])).split(/\r?\n/);
  } catch { /* not a git checkout, or git is missing */ }
  return sharedRelease.changelogFrom(subjects, max);
}

/** null | 'patch' | 'minor' | 'major' | 'beta' | an exact version. Anything else is refused. */
function cleanBump(bump) {
  if (bump === undefined || bump === null || bump === false) return null;
  const b = String(bump).trim();
  if (!b || b === 'none') return null;
  if (version.BUMPS.includes(b) || version.valid(b)) return b;
  throw userError(`"${b.slice(0, 40)}" isn't a choice. Choose patch, minor, major or beta, or type an exact version like 1.2.3.`, 400, 'bad-bump');
}

function cleanNotes(notes) {
  if (notes === undefined || notes === null) return '';
  if (typeof notes !== 'string') throw userError('Release notes must be text.', 400, 'bad-notes');
  const text = notes.replace(/\r\n?/g, '\n').trim();
  if (text.length > MAX_NOTES) throw userError(`Release notes can be up to ${MAX_NOTES.toLocaleString('en')} characters. These are ${text.length.toLocaleString('en')}.`, 400, 'bad-notes');
  return text;
}

function userError(message, status, code) {
  const e = new Error(message);
  if (status) e.status = status;
  if (code) e.code = code;
  return e;
}

const FS_PROBLEMS = {
  EACCES: 'permission denied',
  EPERM: 'not allowed',
  EBUSY: 'a file is in use',
  ENOENT: 'a file is missing',
  EROFS: 'the folder is read-only',
  ENOSPC: 'the disk is full',
};

/**
 * Everything a job can throw → an Error with a plain message and a lowercase code the IPC layer
 * passes to the page. Programming errors (TypeError and friends) are rethrown as they are, so the
 * IPC layer logs them as bugs.
 */
function plainError(err, { cancelled = false } = {}) {
  if (cancelled || (err && (err.code === 'ABORTED' || err.code === 'cancelled' || err.name === 'AbortError'))) {
    return userError('Cancelled. Nothing was published.', undefined, 'cancelled');
  }
  if (err instanceof sharedRelease.ReleaseError) {
    return userError(err.message, err.status, err.code ? String(err.code).toLowerCase().replace(/_/g, '-') : undefined);
  }
  if (err && typeof err.code === 'string' && FS_PROBLEMS[err.code]) {
    const where = err.path ? ` (${err.path})` : '';
    return userError(`Guild Camp couldn't read or change the release files${where}: ${FS_PROBLEMS[err.code]}. Close anything using them and try again.`, undefined, 'files');
  }
  if (err instanceof Error) return err;
  return userError(String(err || 'Publishing failed.'));
}

/**
 * The setup checklist for the page, in order. Each step: { id, done, title, detail, command? }.
 * reason: the first step that isn't done, as one sentence (null when everything is ready).
 */
function setupSteps({ repoDir, repoProblem, gh, isPackaged }) {
  const g = gh || {};
  const steps = [
    {
      id: 'repo',
      done: Boolean(repoDir),
      title: 'Get the Guild Camp source code',
      detail: repoDir ? `Found at ${repoDir}.`
        : repoProblem || (isPackaged
          ? 'Clone the repository, run npm install in it, then choose its folder on this page.'
          : 'Clone the repository and run npm install in it. A development build finds it by itself.'),
      command: repoDir ? null : `git clone https://github.com/${REPO}.git`,
    },
    {
      id: 'gh',
      done: Boolean(g.installed),
      title: 'Install GitHub CLI',
      detail: g.installed ? `GitHub CLI ${g.version || ''} is installed.`.replace('  ', ' ') : 'Guild Camp publishes with GitHub CLI (gh). Install it from cli.github.com, then restart Guild Camp.',
      command: g.installed ? null : 'winget install --id GitHub.cli',
    },
    {
      id: 'login',
      done: Boolean(g.loggedIn),
      title: 'Sign in to GitHub',
      detail: g.loggedIn ? `Signed in${g.account ? ` as ${g.account}` : ''}.` : 'Run this in a terminal, choose GitHub.com, and sign in.',
      command: g.loggedIn ? null : 'gh auth login',
    },
    {
      id: 'push',
      done: g.push !== false && Boolean(g.loggedIn),
      title: `Have push access to ${REPO}`,
      detail: g.push === true ? 'Your account can publish releases.'
        : g.push === false ? `Your account${g.account ? ` (${g.account})` : ''} can't push to ${REPO}. Ask the owner to add you, or sign in with another account.`
          : g.loggedIn ? "Couldn't check yet. Publishing tells you if your account isn't allowed." : 'Your GitHub account needs to be able to push to the repository.',
      command: g.push === false ? 'gh auth login' : null,
    },
  ];
  const first = steps.find((s) => !s.done);
  let reason = null;
  if (first) {
    if (first.id === 'repo') reason = repoProblem || 'Publishing needs a source checkout of Guild Camp on this computer. Choose its folder first.';
    else if (first.id === 'gh') reason = 'Install GitHub CLI and run gh auth login to publish releases.';
    else if (first.id === 'login') reason = 'Run gh auth login to sign in to GitHub, then refresh this page.';
    else reason = g.problem || `Your GitHub account can't push to ${REPO}.`;
  }
  return { steps, reason };
}

/**
 * @param {object} deps
 * @param {object} deps.store   createStore(): get() → settings (repoDir, addonSourceDir), set(patch)
 * @param {object} deps.log     log.scope('publisher')
 * @param {string} deps.appVersion            the running app's version
 * @param {boolean} deps.isPackaged
 * @param {string} deps.appDir                app.getAppPath() (the repo's app/ folder in dev)
 * @param {string} [deps.gh]                  the gh command or full path (default 'gh' on PATH)
 * @param {object} [deps.env]                 extra environment for gh and the build (tests point PATH at a fake gh)
 * @param {typeof fetch} [deps.fetch]         for the public release list when gh can't answer
 * @param {Function} [deps.buildApp]          stand-in for release.buildApp (tests)
 * @param {object} [deps.release]             stand-in for shared/release.js (tests)
 * @param {object|Function} [deps.bnetCredentials]  { clientId, clientSecret } (or a function giving it) to build in,
 *                                            when neither the environment nor .release.json has them
 */
function createPublisher({
  store, log, appVersion, isPackaged, appDir, gh, env, fetch: fetchImpl, buildApp, release: releaseOverride, bnetCredentials,
} = {}) {
  const rel = releaseOverride || sharedRelease;
  const emitter = new EventEmitter();
  const say = (level, msg) => { try { if (log && typeof log[level] === 'function') log[level](msg); } catch { /* logging never breaks publishing */ } };
  const settings = () => (store && typeof store.get === 'function' ? store.get() : {}) || {};
  const runEnv = env || undefined;
  const fullEnv = () => ({ ...process.env, ...(env || {}) });

  let job = null; // { kind, startedAt, step, controller }
  let recent = []; // log lines of the current (or last) job
  let lastResult = null;
  let lastError = null;
  let changelogCache = null; // { repo, at, value }
  let ghCache = null; // { at, value: ghStatus() }
  let publishedCache = null; // { at, value, error }

  // ---- log lines --------------------------------------------------------------------------------
  function line(text, level = 'info') {
    const kind = job ? job.kind : null;
    for (const part of String(text == null ? '' : text).split(/\r?\n/)) {
      if (!part.trim()) continue;
      const entry = { t: new Date().toISOString(), kind, level, line: part };
      recent.push(entry);
      if (recent.length > LOG_KEEP) recent.splice(0, recent.length - LOG_KEEP);
      say(level === 'error' || level === 'warn' ? 'warn' : 'info', part);
      emitter.emit('log', entry);
    }
  }

  // ---- where things are ---------------------------------------------------------------------------
  function repoInfo() {
    const chosen = settings().repoDir;
    if (chosen) {
      if (looksLikeRepo(chosen)) return { dir: path.resolve(chosen), source: 'chosen', problem: null };
      const problem = `The source folder you chose (${chosen}) isn't a Guild Camp checkout any more. Choose it again.`;
      const detected = !isPackaged ? findRepoFrom(appDir) : null;
      return detected ? { dir: detected, source: 'detected', problem } : { dir: null, source: null, problem };
    }
    const detected = !isPackaged ? findRepoFrom(appDir) : null;
    return detected ? { dir: detected, source: 'detected', problem: null } : { dir: null, source: null, problem: null };
  }

  function readAddon(dir) {
    try {
      const resolved = rel.resolveAddonDir(dir);
      return { dir: resolved, version: rel.readAddonVersion(resolved) || null };
    } catch {
      return null;
    }
  }

  function defaultAddonDir(repo) {
    const own = settings().addonSourceDir;
    if (own && readAddon(own)) return own;
    return repo ? path.join(repo, 'addon', 'WowGuild') : null;
  }

  function readApp(repo) {
    if (!repo) return null;
    const dir = path.join(repo, 'app');
    try { return { dir, version: rel.readAppVersion(dir) || null }; } catch { return null; }
  }

  async function changelog(repo) {
    if (!repo || !exists(path.join(repo, '.git'))) return null;
    if (changelogCache && changelogCache.repo === repo && Date.now() - changelogCache.at < CHANGELOG_TTL_MS) return changelogCache.value;
    let value = null;
    try {
      const [addon, app] = await Promise.all([gitChangelogAsync(repo, 'addon'), gitChangelogAsync(repo, 'app')]);
      value = { addon, app };
    } catch (err) {
      say('warn', `Couldn't read the git history for release notes: ${err.message}`);
    }
    changelogCache = { repo, at: Date.now(), value };
    return value;
  }

  // gh installed, signed in, push access. Cached briefly: it runs gh three times.
  async function ghInfo({ fresh = false } = {}) {
    if (!fresh && ghCache && Date.now() - ghCache.at < STATUS_TTL_MS) return ghCache.value;
    let value;
    try {
      value = await rel.ghStatus({ gh, env: runEnv, repo: REPO });
    } catch (err) {
      value = { installed: false, version: null, loggedIn: false, account: null, push: null, private: null, problem: err.message };
    }
    ghCache = { at: Date.now(), value };
    return value;
  }

  // What's on GitHub: through gh when it is signed in (works while the repo is private), else the public list.
  async function published({ fresh = false, useGh = true } = {}) {
    if (!fresh && publishedCache && Date.now() - publishedCache.at < STATUS_TTL_MS) {
      if (publishedCache.error) throw userError(publishedCache.error, undefined, 'unreachable');
      return publishedCache.value;
    }
    try {
      const value = await rel.getReleases({ gh, env: runEnv, fetch: fetchImpl, repo: REPO, useGh, userAgent: `GuildCamp/${appVersion || '0.0.0'}` });
      publishedCache = { at: Date.now(), value, error: null };
      return value;
    } catch (err) {
      const message = `Couldn't read the releases on GitHub. ${err.message}`;
      publishedCache = { at: Date.now(), value: null, error: message };
      throw userError(message, err.status, 'unreachable');
    }
  }

  function bnetInfo(repo) {
    let config = {};
    if (repo) {
      try { config = JSON.parse(fs.readFileSync(path.join(repo, '.release.json'), 'utf8')) || {}; } catch { /* none, or not JSON */ }
    }
    try {
      const found = rel.bnetCredentialsFrom({ env: fullEnv(), config });
      if (found) return { creds: found, ready: true, from: found.from, problem: null };
    } catch (err) {
      return { creds: null, ready: false, from: null, problem: err.message };
    }
    const injected = typeof bnetCredentials === 'function' ? bnetCredentials() : bnetCredentials;
    if (injected && injected.clientId && injected.clientSecret) {
      return { creds: { clientId: injected.clientId, clientSecret: injected.clientSecret, from: 'this app' }, ready: true, from: 'this app', problem: null };
    }
    return { creds: null, ready: false, from: null, problem: null };
  }

  function who(repo, ghValue) {
    const { steps, reason } = setupSteps({ repoDir: repo.dir, repoProblem: repo.problem, gh: ghValue, isPackaged });
    return { canPublish: !reason, reason, steps };
  }

  async function requirePublisher() {
    const repo = repoInfo();
    const g = await ghInfo({ fresh: !ghCache || Date.now() - ghCache.at > 5000 });
    const w = who(repo, g);
    if (!w.canPublish) throw userError(w.reason, 403, 'cannot-publish');
    return { repo, gh: g };
  }

  // ---- status -----------------------------------------------------------------------------------
  async function status() {
    const repo = repoInfo();
    const addonDir = defaultAddonDir(repo.dir);
    const appSrc = readApp(repo.dir);
    const [g, notes] = await Promise.all([ghInfo(), changelog(repo.dir)]);
    let pub = null;
    let publishedError = null;
    try {
      pub = await published({ useGh: Boolean(g.loggedIn) });
    } catch (err) {
      publishedError = err.message;
    }
    const w = who(repo, g);
    const bnet = bnetInfo(repo.dir);
    return {
      canPublish: w.canPublish,
      reason: w.reason,
      setup: {
        steps: w.steps,
        gh: { installed: g.installed, version: g.version, loggedIn: g.loggedIn, account: g.account, push: g.push, problem: g.problem || null, note: g.note || null },
      },
      repo: REPO,
      releasesUrl: rel.releasesPage(REPO),
      repoPrivate: typeof g.private === 'boolean' ? g.private : null,
      isPackaged: Boolean(isPackaged),
      runningVersion: appVersion || '0.0.0',
      repoDir: repo.dir,
      repoSource: repo.source,
      repoProblem: repo.problem,
      hasGit: Boolean(repo.dir && exists(path.join(repo.dir, '.git'))),
      addonSource: addonDir ? readAddon(addonDir) : null,
      appSource: appSrc,
      appVersion: (appSrc && appSrc.version) || appVersion || '0.0.0',
      published: pub ? { app: pub.app || null, addon: pub.addon || null, history: Array.isArray(pub.history) ? pub.history : [] } : null,
      publishedError,
      bnet: { ready: bnet.ready, from: bnet.from, problem: bnet.problem },
      building: Boolean(job),
      job: job ? { kind: job.kind, startedAt: job.startedAt, step: job.step } : null,
      canCancel: Boolean(job),
      changelog: notes,
      log: recent.slice(),
      lastResult,
      lastError,
    };
  }

  // ---- jobs -------------------------------------------------------------------------------------
  // Works out the version to publish and refuses early (before a long build) when GitHub already has
  // that release, or a newer version. Same rule as scripts/release.js.
  async function planVersion(kind, current, bump, pub) {
    const where = kind === 'addon' ? 'WowGuild.toc' : 'app/package.json';
    const next = bump ? rel.nextVersion(current, bump, where) : current;
    if (!version.valid(next)) {
      throw userError(`The ${kind} version in ${where} ("${next || ''}") isn't valid. Choose an exact version like 1.2.3.`, 400, 'bad-version');
    }
    const tag = rel.tagFor(kind, next);
    const live = pub && pub[kind] ? pub[kind].version : null;
    const info = await rel.ghReleaseInfo(tag, { gh, env: runEnv, repo: REPO });
    if (info.exists && !info.draft) {
      throw userError(`GitHub already has the release ${tag}. Choose a bump (patch, for example) or an exact newer version.`, 409, 'exists');
    }
    if (info.exists && info.draft) {
      line(`GitHub has an unfinished draft release for ${tag} (from a cancelled upload). Delete it on GitHub when you can.`, 'warn');
    }
    if (live && !version.gt(next, live)) {
      throw userError(`GitHub already has ${kind} ${live}, and ${next} isn't newer. Choose a bump (patch, for example) or an exact newer version.`, 409, 'not-newer');
    }
    return { next, tag, live };
  }

  async function runJob(kind, fn) {
    if (job) {
      throw userError(job.kind === 'app' ? 'An app build is already running. Wait for it to finish.' : 'An addon is being published. Wait for it to finish.', 409, 'busy');
    }
    const controller = new AbortController();
    job = { kind, startedAt: new Date().toISOString(), step: 'prepare', controller };
    recent = [];
    lastError = null;
    emitter.emit('job', { kind, startedAt: job.startedAt });
    try {
      const result = await fn(controller.signal, (step) => { if (job) job.step = step; });
      lastResult = { kind, version: result.version, url: result.url || null, at: new Date().toISOString() };
      return result;
    } catch (err) {
      const e = plainError(err, { cancelled: controller.signal.aborted });
      lastError = { kind, message: e.message, at: new Date().toISOString(), code: e.code || null };
      line(e.message, e.code === 'cancelled' ? 'info' : 'error');
      throw e;
    } finally {
      job = null;
      changelogCache = null; // versions (and maybe commits) changed
      publishedCache = null;
      emitter.emit('job', null);
    }
  }

  const checkCancelled = (signal) => { if (signal.aborted) throw userError('Cancelled.', undefined, 'cancelled'); };

  // Saves files before a version bump so a failed publish can put them back.
  function snapshot(files) {
    return files.filter(isFile).map((file) => ({ file, data: fs.readFileSync(file) }));
  }
  function restore(saved, what) {
    try {
      for (const { file, data } of saved) fs.writeFileSync(file, data);
      line(what);
    } catch (err) {
      line(`Couldn't put the old version back (${err.message}). Check the version in the files before trying again.`, 'error');
    }
  }

  async function previewAddon(sourceDir, bump) {
    const found = readAddon(sourceDir);
    if (!found) {
      throw userError(`There's no WowGuild.toc in ${sourceDir}. Choose the WowGuild addon folder.`, 404, 'no-toc');
    }
    let next = found.version;
    let problem = null;
    try {
      next = bump ? rel.nextVersion(found.version, bump, 'WowGuild.toc') : found.version;
    } catch (err) {
      problem = err.message;
    }
    if (!problem && !version.valid(next)) problem = `WowGuild.toc needs a "## Version:" line with a version like 1.2.3 (found "${found.version || 'nothing'}").`;
    return { preview: true, dir: found.dir, version: found.version, next, problem };
  }

  const ghLine = (l) => line(l);

  /**
   * Bumps (optional), zips and publishes the WowGuild addon as release addon-v<version>.
   * → { kind: 'addon', version, previous, dir, fileName, size, files, tag, url }
   */
  async function publishAddon(opts = {}) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const bump = cleanBump(o.bump);
    const repo = repoInfo();
    const given = typeof o.sourceDir === 'string' && o.sourceDir.trim() ? o.sourceDir.trim() : null;
    if (given && !path.isAbsolute(given)) throw userError('The addon folder must be a full folder path.', 400, 'bad-folder');
    const sourceDir = given ? path.resolve(given) : defaultAddonDir(repo.dir);
    if (!sourceDir) throw userError('Choose the WowGuild addon folder to publish.', 400, 'no-folder');
    if (o.preview) return previewAddon(sourceDir, bump);

    const notes = cleanNotes(o.notes);
    await requirePublisher();

    return runJob('addon', async (signal, step) => {
      const dir = rel.resolveAddonDir(sourceDir);
      const current = rel.readAddonVersion(dir);
      line(`Publishing the addon from ${dir}`);
      const pub = await published({ fresh: true });
      const plan = await planVersion('addon', current, bump, pub);
      checkCancelled(signal);

      const tocFile = path.join(dir, 'WowGuild.toc');
      const saved = snapshot([tocFile]);
      let bumped = false;
      try {
        if (plan.next !== current) {
          rel.bumpAddonVersion(dir, plan.next);
          bumped = true;
          line(`Addon version: ${current} → ${plan.next} (WowGuild.toc)`);
        } else {
          line(`Addon version: ${plan.next}`);
        }
        step('pack');
        const pack = rel.packAddon(dir);
        line(`Packed ${pack.files.length} files: ${pack.fileName}, ${rel.formatBytes(pack.size)}`);
        checkCancelled(signal);
        step('upload');
        const out = await rel.publishAddon({ pack, notes, gh, env: runEnv, repo: REPO, onLog: ghLine, signal });
        if (bumped) line('Commit the new version in WowGuild.toc and push it, so the code on GitHub matches the release.');
        return {
          kind: 'addon', version: pack.version, previous: current, dir, fileName: pack.fileName,
          size: pack.size, files: pack.files.length, tag: out.tag, url: out.url,
        };
      } catch (err) {
        if (bumped) restore(saved, `Put WowGuild.toc back to ${current}, because the addon wasn't published.`);
        throw err;
      }
    });
  }

  /**
   * Bumps (optional) app/package.json, builds the installer (npm run dist, a few minutes) and publishes
   * it as release v<version>, marked Latest. Needs a source checkout with npm install done.
   * → { kind: 'app', version, previous, files: [{ name, size, sha512 }], tag, url }
   */
  async function publishApp(opts = {}) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const bump = cleanBump(o.bump);
    const notes = cleanNotes(o.notes);
    const { repo } = await requirePublisher();
    const appSrc = path.join(repo.dir, 'app');
    const bnet = bnetInfo(repo.dir);
    if (bnet.problem) throw userError(bnet.problem, 400, 'bnet-half');

    return runJob('app', async (signal, step) => {
      const current = rel.readAppVersion(appSrc);
      line(`Publishing the app from ${repo.dir}`);
      // Check GitHub before a build that takes minutes.
      const pub = await published({ fresh: true });
      const plan = await planVersion('app', current, bump, pub);
      checkCancelled(signal);
      const builder = ['electron-builder', 'electron-builder.cmd'];
      const hasBuilder = [path.join(appSrc, 'node_modules', '.bin'), path.join(repo.dir, 'node_modules', '.bin')]
        .some((bin) => builder.some((b) => exists(path.join(bin, b))));
      if (!buildApp && !hasBuilder) line("electron-builder isn't installed in this checkout. If the build fails, run npm install in the app folder first.", 'warn');

      const saved = snapshot([path.join(appSrc, 'package.json'), path.join(appSrc, 'package-lock.json')]);
      let bumped = false;
      try {
        if (plan.next !== current) {
          rel.bumpAppVersion(appSrc, plan.next);
          bumped = true;
          line(`App version: ${current} → ${plan.next} (app/package.json)`);
        } else {
          line(`App version: ${plan.next}`);
        }
        step('build');
        const { distDir } = await (buildApp || rel.buildApp)(appSrc, {
          onLog: (l) => line(l), onWarn: (l) => line(l, 'warn'), signal, env: runEnv, bnet: bnet.creds || null,
        });
        checkCancelled(signal);
        const build = rel.readAppBuild(distDir);
        if (build.version !== plan.next) {
          throw userError(`The build in ${distDir} is version ${build.version}, but app/package.json says ${plan.next}. The build probably failed; check the output above.`, undefined, 'mismatch');
        }
        step('upload');
        const out = await rel.publishApp({ distDir, notes, gh, env: runEnv, repo: REPO, onLog: ghLine, signal });
        if (bumped) line('Commit the new version in app/package.json (and package-lock.json) and push it, so the code on GitHub matches the release.');
        return { kind: 'app', version: out.version, previous: current, files: out.files, tag: out.tag, url: out.url };
      } catch (err) {
        if (bumped) restore(saved, `Put app/package.json back to ${current}, because the app wasn't published.`);
        throw err;
      }
    });
  }

  /** Stops the running build or upload. → true when there was something to stop. */
  function cancel() {
    if (!job) return false;
    if (!job.controller.signal.aborted) {
      line(job.kind === 'app' ? 'Cancelling the app build…' : 'Cancelling…');
      job.controller.abort();
    }
    return true;
  }

  /** Saves the source checkout folder (or null to go back to automatic). → status() */
  async function setRepoDir(dir) {
    if (dir === null || dir === undefined || dir === '') {
      if (store) store.set({ repoDir: null });
      changelogCache = null;
      return status();
    }
    if (typeof dir !== 'string' || !path.isAbsolute(dir.trim())) throw userError('That folder is not a full path.', 400, 'bad-folder');
    const picked = path.resolve(dir.trim());
    // People often pick the app or addon folder (or addon\WowGuild) instead of the checkout itself.
    const found = [picked, path.dirname(picked), path.dirname(path.dirname(picked))].find((d) => isDir(d) && looksLikeRepo(d));
    if (!found) {
      throw userError('That folder isn\'t a Guild Camp source checkout. Choose the folder that holds "app" and "addon" (with the addon in addon\\WowGuild).', 400, 'not-repo');
    }
    if (store) store.set({ repoDir: found });
    changelogCache = null;
    say('info', `Source checkout set to ${found}.`);
    return status();
  }

  return Object.assign(emitter, { status, publishAddon, publishApp, cancel, setRepoDir, isBusy: () => Boolean(job) });
}

module.exports = { createPublisher, looksLikeRepo, findRepoFrom, cleanBump, cleanNotes, plainError, gitChangelogAsync, setupSteps, MAX_NOTES };
