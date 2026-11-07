'use strict';
// Backend of the owner-only Releases page: publishes addon and app updates to the guild server
// with shared/release.js (the same pipeline as scripts/release.js and CI).
//
//   const publisher = createPublisher({ store, log, auth, api, getServer, getToken, appVersion, isPackaged, appDir });
//   await publisher.status();
//   await publisher.publishAddon({ sourceDir, bump, notes, force });   // bump: null | patch | minor | major | beta | "1.2.3"
//   await publisher.publishAddon({ sourceDir, bump, preview: true });  // reads the folder, publishes nothing
//   await publisher.publishApp({ bump, notes });                       // bump, npm run dist, upload, make it live
//   publisher.cancel();                                                // stops a running build or upload
//   await publisher.setRepoDir(dir | null);
//   events: 'log' ({ t, kind, level, line }), 'job' ({ kind, startedAt } | null)
//
// Uploads use the owner's device token (getToken()); the server's publish endpoints accept it from
// the guild owner, so no publish token is needed in the app. One job runs at a time. A version
// bump that doesn't end in a published release is undone, so trying again doesn't skip a number.
// Plain Node (no Electron), so it is unit tested with temp folders and a local HTTP server.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { EventEmitter } = require('events');
const sharedRelease = require('../shared/release');
const version = require('../shared/version');

const MAX_NOTES = 4000;
const LOG_KEEP = 400; // lines kept for a page that opens in the middle of a build
const CHANGELOG_TTL_MS = 60 * 1000;

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
 * previous addon-v* / app-v* tag, release commits left out), but asynchronous.
 */
async function gitChangelogAsync(repoDir, kind, { max = 60 } = {}) {
  const paths = kind === 'addon' ? ['addon/WowGuild'] : ['app'];
  let prev = '';
  try { prev = await git(repoDir, ['describe', '--tags', '--abbrev=0', '--match', `${kind}-v*`, 'HEAD^']); } catch { /* first release */ }
  let subjects = [];
  try {
    subjects = (await git(repoDir, ['log', '--no-merges', '--format=%s', prev ? `${prev}..HEAD` : 'HEAD', '--', ...paths])).split(/\r?\n/);
  } catch { /* not a git checkout, or git is missing */ }
  const seen = new Set();
  const lines = subjects.map((s) => s.trim())
    .filter((s) => s && !/^Release (addon|app) v?\d/i.test(s))
    .filter((s) => (seen.has(s) ? false : seen.add(s)));
  if (!lines.length) return '- Maintenance release.';
  const shown = lines.slice(0, max).map((s) => `- ${s}`);
  if (lines.length > max) shown.push(`- …and ${lines.length - max} more changes.`);
  return shown.join('\n');
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
  if (err instanceof Error && ['TypeError', 'ReferenceError', 'SyntaxError', 'RangeError'].includes(err.name)) return err;
  if (err instanceof Error) return err;
  return userError(String(err || 'Publishing failed.'));
}

/**
 * @param {object} deps
 * @param {object} deps.store   createStore(): get() → settings (repoDir, addonSourceDir), set(patch)
 * @param {object} deps.log     log.scope('publisher')
 * @param {object} deps.auth    auth.state() → { signedIn, role }
 * @param {object} [deps.api]   createApi(): request() for GET /api/releases
 * @param {() => string} deps.getServer
 * @param {() => string|null} deps.getToken   the owner's device token
 * @param {string} deps.appVersion            the running app's version
 * @param {boolean} deps.isPackaged
 * @param {string} deps.appDir                app.getAppPath() (the repo's app/ folder in dev)
 * @param {Function} [deps.buildApp]          stand-in for release.buildApp (tests)
 * @param {typeof fetch} [deps.fetch]         stand-in for fetch in uploads (tests)
 * @param {object} [deps.release]             stand-in for shared/release.js (tests)
 */
function createPublisher({ store, log, auth, api, getServer, getToken, appVersion, isPackaged, appDir, buildApp, fetch: fetchImpl, release: releaseOverride } = {}) {
  const rel = releaseOverride || sharedRelease;
  const emitter = new EventEmitter();
  const say = (level, msg) => { try { if (log && typeof log[level] === 'function') log[level](msg); } catch { /* logging never breaks publishing */ } };
  const settings = () => (store && typeof store.get === 'function' ? store.get() : {}) || {};

  let job = null; // { kind, startedAt, step, controller }
  let recent = []; // log lines of the current (or last) job
  let lastResult = null;
  let lastError = null;
  let changelogCache = null; // { repo, at, value }

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

  async function fetchPublished() {
    if (api && typeof api.request === 'function') {
      try {
        const data = await api.request('GET', '/api/releases', null, { auth: false, timeout: 20000 });
        return data && typeof data === 'object' ? data : { app: null, addon: null, history: [] };
      } catch (err) {
        if (err && err.status === 404) throw userError("This server doesn't take releases yet (it has no /api/releases). Update the server first.", 404, 'no-releases');
        throw userError((err && err.message) || "Couldn't read what the server has published.", err && err.status, 'unreachable');
      }
    }
    try {
      return await rel.getReleases(getServer(), { fetch: fetchImpl });
    } catch (err) {
      throw plainError(err);
    }
  }

  function who() {
    const s = auth && typeof auth.state === 'function' ? auth.state() : {};
    const token = typeof getToken === 'function' ? getToken() : null;
    let reason = null;
    if (!s.signedIn || !token) reason = 'Sign in to publish releases.';
    else if (s.role !== 'owner') reason = 'Only the guild owner can publish releases.';
    return { signedIn: Boolean(s.signedIn && token), role: s.role || null, canPublish: !reason, reason, token };
  }

  function requirePublisher() {
    const w = who();
    if (!w.canPublish) throw userError(w.reason, w.signedIn ? 403 : 401, 'not-owner');
    return w.token;
  }

  // ---- status -----------------------------------------------------------------------------------
  async function status() {
    const w = who();
    const repo = repoInfo();
    const addonDir = defaultAddonDir(repo.dir);
    const appSrc = readApp(repo.dir);
    let published = null;
    let publishedError = null;
    const [, notes] = await Promise.all([
      fetchPublished().then((p) => { published = p; }, (err) => { publishedError = err.message; }),
      changelog(repo.dir),
    ]);
    return {
      canPublish: w.canPublish,
      reason: w.reason,
      signedIn: w.signedIn,
      role: w.role,
      server: typeof getServer === 'function' ? getServer() : null,
      isPackaged: Boolean(isPackaged),
      runningVersion: appVersion || '0.0.0',
      repoDir: repo.dir,
      repoSource: repo.source,
      repoProblem: repo.problem,
      hasGit: Boolean(repo.dir && exists(path.join(repo.dir, '.git'))),
      addonSource: addonDir ? readAddon(addonDir) : null,
      appSource: appSrc,
      appVersion: (appSrc && appSrc.version) || appVersion || '0.0.0',
      published: published ? { app: published.app || null, addon: published.addon || null, history: Array.isArray(published.history) ? published.history : [] } : null,
      publishedError,
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
  // Works out the version to publish and refuses early (before a long build) when the server
  // already has it or something newer. Same rule as scripts/release.js.
  function planVersion(kind, current, bump, published, force) {
    const where = kind === 'addon' ? 'WowGuild.toc' : 'app/package.json';
    const next = bump ? rel.nextVersion(current, bump, where) : current;
    if (!version.valid(next)) {
      throw userError(`The ${kind} version in ${where} ("${next || ''}") isn't valid. Choose an exact version like 1.2.3.`, 400, 'bad-version');
    }
    // The addon bundled in the server image (source 'bundled') only stands in until one is
    // published: the server accepts any first upload over it, so it doesn't count here.
    const rec = published && published[kind];
    const live = rec && rec.source !== 'bundled' ? rec.version : null;
    if (live && !version.gt(next, live) && !(kind === 'addon' && force)) {
      const hint = kind === 'addon'
        ? 'Choose a bump (patch, for example), or tick "Roll back" to publish this version anyway.'
        : 'Choose a bump (patch, for example) or an exact newer version.';
      throw userError(`The server already has ${kind} ${live}, and ${next} isn't newer. ${hint}`, 409, 'not-newer');
    }
    return { next, live: live || null };
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
      lastResult = { kind, version: result.version, at: new Date().toISOString() };
      return result;
    } catch (err) {
      const e = plainError(err, { cancelled: controller.signal.aborted });
      lastError = { kind, message: e.message, at: new Date().toISOString(), code: e.code || null };
      line(e.message, e.code === 'cancelled' ? 'info' : 'error');
      throw e;
    } finally {
      job = null;
      changelogCache = null; // versions (and maybe commits) changed
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

  /**
   * Bumps (optional), zips and uploads the WowGuild addon.
   * → { kind: 'addon', version, previous, dir, fileName, size, files, result } (result = the server's reply)
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

    const token = requirePublisher();
    const notes = cleanNotes(o.notes);
    const force = Boolean(o.force);
    const server = getServer();

    return runJob('addon', async (signal, step) => {
      const dir = rel.resolveAddonDir(sourceDir);
      const current = rel.readAddonVersion(dir);
      line(`Publishing the addon from ${dir}`);
      const published = await fetchPublished();
      const plan = planVersion('addon', current, bump, published, force);
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
          line(`Addon version: ${plan.next}${force && plan.live ? ` (rolling back from ${plan.live})` : ''}`);
        }
        step('pack');
        const pack = rel.packAddon(dir);
        line(`Packed ${pack.files.length} files: ${pack.fileName}, ${rel.formatBytes(pack.size)}`);
        checkCancelled(signal);
        step('upload');
        const result = await rel.publishAddon({ server, token, pack, notes, force, onLog: (l) => line(l), signal, fetch: fetchImpl });
        return {
          kind: 'addon', version: pack.version, previous: current, dir, fileName: pack.fileName,
          size: pack.size, files: pack.files.length, result,
        };
      } catch (err) {
        if (bumped) restore(saved, `Put WowGuild.toc back to ${current}, because the addon wasn't published.`);
        throw err;
      }
    });
  }

  /**
   * Bumps (optional) app/package.json, builds the installer (npm run dist, a few minutes), uploads it
   * and makes it live. Needs a source checkout with npm install done.
   * → { kind: 'app', version, previous, files: [{ name, size, sha512 }], result }
   */
  async function publishApp(opts = {}) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const bump = cleanBump(o.bump);
    const notes = cleanNotes(o.notes);
    const token = requirePublisher();
    const repo = repoInfo();
    if (!repo.dir) {
      throw userError(repo.problem || 'Building the app needs a source checkout of Guild Camp (with npm install done). Choose its folder first.', 400, 'no-repo');
    }
    const appSrc = path.join(repo.dir, 'app');
    const server = getServer();

    return runJob('app', async (signal, step) => {
      const current = rel.readAppVersion(appSrc);
      line(`Publishing the app from ${repo.dir}`);
      // Check the server before a build that takes minutes.
      const published = await fetchPublished();
      const plan = planVersion('app', current, bump, published, false);
      checkCancelled(signal);
      const builder = ['electron-builder', 'electron-builder.cmd'];
      const hasBuilder = [path.join(appSrc, 'node_modules', '.bin'), path.join(repo.dir, 'node_modules', '.bin')]
        .some((bin) => builder.some((b) => exists(path.join(bin, b))));
      if (!buildApp && !hasBuilder) line("electron-builder isn't installed in this checkout. If the build fails, run npm install at the repo root first.", 'warn');

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
        const { distDir } = await (buildApp || rel.buildApp)(appSrc, { onLog: (l) => line(l), signal });
        checkCancelled(signal);
        const build = rel.readAppBuild(distDir);
        if (build.version !== plan.next) {
          throw userError(`The build in ${distDir} is version ${build.version}, but app/package.json says ${plan.next}. The build probably failed; check the output above.`, undefined, 'mismatch');
        }
        step('upload');
        const out = await rel.publishApp({ server, token, distDir, notes, onLog: (l) => line(l), signal, fetch: fetchImpl });
        return { kind: 'app', version: out.version, previous: current, files: out.files, result: out.result };
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
    const found = [picked, path.dirname(picked), path.dirname(path.dirname(picked))].find(looksLikeRepo);
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

module.exports = { createPublisher, looksLikeRepo, findRepoFrom, cleanBump, cleanNotes, plainError, gitChangelogAsync, MAX_NOTES };
