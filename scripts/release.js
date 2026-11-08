#!/usr/bin/env node
'use strict';
// Publishes Guild Camp releases on GitHub (arrow-quiver/wow) with the GitHub CLI (gh): the addon,
// the app, or both. The work happens in app/src/shared/release.js (the app's Releases page and CI use
// it too). Run with --help for the options; docs/RELEASING.md walks through a release.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const release = require('../app/src/shared/release');
const version = require('../app/src/shared/version');

const DEFAULT_ROOT = path.join(__dirname, '..');
const REPO = release.GITHUB_REPO;

const USAGE = `Publish Guild Camp releases on GitHub (${REPO}).

Usage: node scripts/release.js <addon|app|all|status> [options]

  addon    bump addon/WowGuild/WowGuild.toc, zip the addon, publish release addon-v<version>
  app      bump app/package.json, build the installer, publish release v<version>
  all      addon, then app
  status   the versions in this checkout next to the newest releases on GitHub

Versions:
  --bump patch|minor|major|beta   bump the version first
  --version x.y.z                 set an exact version first
  --no-bump                       release the version already in the files (the default)

Release notes:
  --notes "text"                  the notes players see
  --notes-file FILE               read the notes from a file
  --notes-from-git                commit subjects since the last addon-v* / v* tag

Publishing (needs GitHub CLI: install it from https://cli.github.com, then run gh auth login):
  --dry-run                       build and zip, but publish nothing; shows where the files are
  --skip-published                if GitHub already has this exact release, skip it (CI uses this)
  --curseforge                    also upload the addon zip to CurseForge (needs CF_API_TOKEN)

Git:
  --git --push                    commit the version bump, tag it (addon-v<version> / v<version>),
                                  push both, then publish the release on that tag
  --tag-only                      bump, commit and tag, but don't build or publish: pushing the tag
                                  (add --push) lets GitHub Actions build and publish

Battle.net sign-in is built into the app when GUILDCAMP_BNET_CLIENT_ID and
GUILDCAMP_BNET_CLIENT_SECRET are set (or bnetClientId and bnetClientSecret in .release.json).

  -h, --help                      this help
`;

const FLAGS = {
  bump: 'string', version: 'string', 'no-bump': 'boolean', notes: 'string', 'notes-file': 'string',
  'notes-from-git': 'boolean', 'dry-run': 'boolean', git: 'boolean', push: 'boolean', curseforge: 'boolean',
  'skip-published': 'boolean', 'tag-only': 'boolean', help: 'boolean',
};

// Options of the server days, with what to do instead.
const REMOVED = {
  server: '--server is gone: releases go to GitHub now (docs/RELEASING.md).',
  token: '--token is gone: publishing uses GitHub CLI. Run gh auth login once instead.',
  force: '--force is gone: a GitHub release can\'t be replaced by an older version. Publish a new version with the old code instead (docs/RELEASING.md, "Rolling back").',
};

const GH_HELP_MISSING = `GitHub CLI (gh) isn't installed. Install GitHub CLI and run gh auth login:
  1. Install it from https://cli.github.com (Windows: winget install --id GitHub.cli).
  2. Run gh auth login. Choose GitHub.com and sign in with an account that can push to ${REPO}.
In GitHub Actions, gh is already installed and uses GH_TOKEN.`;
const GH_HELP_LOGIN = `GitHub CLI isn't signed in. Run gh auth login, choose GitHub.com, and sign in with an account that can push to ${REPO}. Then try again.`;

class UsageError extends Error {}

function codeError(message, code, cause) {
  const e = new Error(message);
  if (code) e.code = code;
  if (cause && cause.status) e.status = cause.status;
  return e;
}

// Small, strict argument parser: --flag, --flag value, --flag=value. Unknown flags are errors.
function parseArgs(argv) {
  const flags = {}; const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h') { flags.help = true; continue; }
    if (!a.startsWith('--')) { positional.push(a); continue; }
    const eq = a.indexOf('=');
    const name = a.slice(2, eq < 0 ? undefined : eq);
    const type = FLAGS[name];
    if (!type) throw new UsageError(REMOVED[name] || `Unknown option --${name}. Run with --help to see the options.`);
    if (type === 'boolean') {
      if (eq >= 0) throw new UsageError(`--${name} doesn't take a value.`);
      flags[name] = true;
    } else {
      const value = eq >= 0 ? a.slice(eq + 1) : argv[++i];
      if (value === undefined || (eq < 0 && value.startsWith('--'))) throw new UsageError(`--${name} needs a value.`);
      flags[name] = value;
    }
  }
  if (flags.bump && !version.BUMPS.includes(flags.bump)) throw new UsageError(`--bump must be patch, minor, major or beta (not "${flags.bump}").`);
  if (flags.version && !version.valid(flags.version)) throw new UsageError(`--version must look like 1.2.3 or 1.2.3-beta.1 (not "${flags.version}").`);
  const bumps = ['bump', 'version', 'no-bump'].filter((k) => flags[k]);
  if (bumps.length > 1) throw new UsageError(`Use only one of --${bumps.join(', --')}.`);
  const notes = ['notes', 'notes-file', 'notes-from-git'].filter((k) => flags[k] !== undefined);
  if (notes.length > 1) throw new UsageError(`Use only one of --${notes.join(', --')}.`);
  if (flags.push || flags['tag-only']) flags.git = true;
  if (flags['tag-only'] && flags['dry-run']) throw new UsageError('--tag-only and --dry-run don\'t go together.');
  if (positional[0] !== 'status' && flags.git && !flags.push && !flags['tag-only'] && !flags['dry-run']) {
    throw new UsageError('--git needs --push when you publish: the GitHub release has to point at the tag on GitHub. Add --push, or use --tag-only to only make the tag.');
  }
  return { command: positional[0], extra: positional.slice(1), flags };
}

// .release.json at the repo root (gitignored): { "bnetClientId": "…", "bnetClientSecret": "…" }.
function loadConfig({ root = DEFAULT_ROOT } = {}) {
  const file = path.join(root, '.release.json');
  let config = {};
  if (fs.existsSync(file)) {
    try { config = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (e) {
      throw new UsageError(`.release.json isn't valid JSON (${e.message}). It should look like {"bnetClientId": "…", "bnetClientSecret": "…"}.`);
    }
    if (typeof config !== 'object' || Array.isArray(config)) throw new UsageError('.release.json must hold one JSON object, like {"bnetClientId": "…", "bnetClientSecret": "…"}.');
  }
  return { config, file, repo: REPO, old: ['server', 'token'].filter((k) => config[k] !== undefined) };
}

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim();
}

function tagExists(root, tag) {
  try { git(root, 'rev-parse', '-q', '--verify', `refs/tags/${tag}`); return true; } catch { return false; }
}

function lastTag(root, kind) {
  try { return git(root, 'describe', '--tags', '--abbrev=0', '--match', release.TAG_MATCH[kind], 'HEAD'); } catch { return null; }
}

function gitError(e) {
  return e && e.stderr ? String(e.stderr).trim().split(/\r?\n/).slice(-3).join(' ') : (e && e.message) || '';
}

function readNotes(flags, root, kind) {
  if (flags.notes !== undefined) return flags.notes;
  if (flags['notes-file']) {
    const file = path.resolve(flags['notes-file']);
    try { return fs.readFileSync(file, 'utf8').trim(); } catch { throw new UsageError(`Couldn't read the notes file ${file}.`); }
  }
  if (flags['notes-from-git']) return release.gitChangelog(root, kind);
  return '';
}

function bumpHow(flags) {
  if (flags.version) return flags.version;
  if (flags.bump) return flags.bump;
  return null; // --no-bump, or nothing given
}

// Commits the bumped files (only those: anything else staged stays staged) and tags the release.
function commitAndTag(root, { kind, ver, files, push, log }) {
  const tag = release.tagFor(kind, ver);
  const rel = files.map((f) => path.relative(root, f).split(path.sep).join('/'));
  let changed = false;
  try { git(root, 'diff', '--quiet', 'HEAD', '--', ...rel); } catch { changed = true; }
  try {
    if (changed) {
      git(root, 'add', '--', ...rel);
      git(root, 'commit', '-m', `Release ${kind} ${ver}`, '--', ...rel);
      log(`Committed "Release ${kind} ${ver}".`);
    }
    git(root, 'tag', '-a', tag, '-m', `Guild Camp ${kind} ${ver}`);
    log(`Tagged ${tag}.`);
  } catch (e) {
    throw new Error(`Git failed: ${gitError(e)}. Nothing was published; commit and tag by hand, or try again.`);
  }
  if (push) {
    try {
      git(root, 'push', '--atomic', 'origin', 'HEAD', `refs/tags/${tag}`);
      log(`Pushed the commit and ${tag} to origin.`);
    } catch (e) {
      throw new Error(`git push failed: ${gitError(e)}. Push by hand (git push origin HEAD ${tag}), then publish with --no-bump.`);
    }
  }
  return tag;
}

// Before a build or publish: gh installed, signed in, and allowed to push.
async function requireGh(o) {
  const st = await release.ghStatus({ gh: o.gh, env: o.env });
  if (!st.installed) throw codeError(GH_HELP_MISSING, 'NO_GH');
  if (!st.loggedIn) throw codeError(GH_HELP_LOGIN, 'NOT_LOGGED_IN');
  if (st.push === false) throw codeError(st.problem, 'NO_PUSH');
  o.log(`GitHub CLI${st.version ? ` ${st.version}` : ''}: signed in${st.account ? ` as ${st.account}` : ''}.`);
  if (st.note) o.warn(st.note);
  return st;
}

async function fetchPublished(o, { required, useGh = true }) {
  try {
    return await release.getReleases({ gh: o.gh, env: o.env, fetch: o.fetch, useGh });
  } catch (e) {
    if (required) throw e;
    o.warn(`Couldn't check what's on GitHub. ${e.message}`);
    return null;
  }
}

// In GitHub Actions without --git (a manual run of the workflow), a new tag goes on the commit that ran.
function ciTarget(env, flags) {
  return !flags.git && env.GITHUB_ACTIONS === 'true' && env.GITHUB_SHA ? env.GITHUB_SHA : undefined;
}

// Works out the version to release, refusing early (before a long build) when it can't be published.
// → { next, tag, live, skip } — skip: GitHub already has exactly this release (--skip-published).
async function planVersion({ kind, current, how, published, flags, o, publish }) {
  const next = how ? release.nextVersion(current, how, kind === 'addon' ? 'WowGuild.toc' : 'app/package.json') : current;
  if (!version.valid(next)) throw new UsageError(`The ${kind} version "${next}" isn't valid. Pass --version x.y.z.`);
  const tag = release.tagFor(kind, next);
  const live = published && published[kind] ? published[kind].version : null;
  let existing = Boolean(published && published.history.some((r) => r.tag === tag));
  if (publish) {
    const info = await release.ghReleaseInfo(tag, { gh: o.gh, env: o.env });
    existing = info.exists && !info.draft;
    if (info.exists && info.draft) {
      o.warn(`GitHub has an unfinished draft release for ${tag} (from a cancelled upload). Delete it when you can: gh release delete ${tag} --repo ${REPO}`);
    }
  }
  if (existing) {
    if (flags['skip-published']) {
      o.log(`GitHub already has the release ${tag}. Nothing to publish.`);
      return { next, tag, live, skip: true };
    }
    if (!flags['dry-run']) throw new UsageError(`GitHub already has the release ${tag}. Use --bump patch (or --version) for a new version.`);
  }
  if (live && !version.gt(next, live)) {
    if (!flags['dry-run']) throw new UsageError(`GitHub already has ${kind} ${live}, and ${next} isn't newer. Use --bump patch (or --version) for a new version.`);
    o.log(`Note: GitHub has ${kind} ${live}; ${next} isn't newer, so a real run would be refused.`);
  }
  return { next, tag, live, skip: false };
}

function pushedButNotPublished(err, kind, tag) {
  return codeError(`${err.message}\nThe tag ${tag} is on GitHub, but the release wasn't made. Publish it with: node scripts/release.js ${kind} --no-bump`, err.code, err);
}

function logNotes(log, notes) {
  if (notes) log(`Notes:\n${notes.split('\n').map((l) => `  ${l}`).join('\n')}`);
}

async function releaseAddon(cfg, flags, o) {
  const { root, log } = o;
  const addonDir = path.join(root, 'addon', 'WowGuild');
  const tocFile = path.join(addonDir, 'WowGuild.toc');
  const current = release.readAddonVersion(addonDir);
  const tagOnly = flags['tag-only'];
  const publish = !flags['dry-run'] && !tagOnly;
  if (publish) await requireGh(o);
  const published = tagOnly ? null : await fetchPublished(o, { required: publish });
  const plan = await planVersion({ kind: 'addon', current, how: bumpHow(flags), published, flags, o, publish });
  const notes = readNotes(flags, root, 'addon');

  if (plan.skip) {
    if (flags.curseforge && plan.next === current) {
      const pack = release.packAddon(addonDir);
      await uploadCurseForge({ addonDir, pack, notes, flags, o });
    }
    return { kind: 'addon', version: plan.next, skipped: true };
  }
  if (flags.git && tagExists(root, plan.tag)) throw new UsageError(`The tag ${plan.tag} already exists. Bump to a new version.`);

  if (plan.next !== current) {
    release.bumpAddonVersion(addonDir, plan.next);
    log(`Addon version: ${current} → ${plan.next} (WowGuild.toc)`);
  } else log(`Addon version: ${plan.next}`);

  if (tagOnly) {
    const tag = commitAndTag(root, { kind: 'addon', ver: plan.next, files: [tocFile], push: flags.push, log });
    if (!flags.push) log(`Push it to start the release workflow: git push origin HEAD ${tag}`);
    return { kind: 'addon', version: plan.next, tag };
  }

  const pack = release.packAddon(addonDir);
  log(`Packed ${pack.files.length} files: ${pack.fileName}, ${release.formatBytes(pack.size)}, sha256 ${pack.sha256.slice(0, 16)}…`);
  logNotes(log, notes);

  let tag = null;
  let url = null;
  if (flags['dry-run']) {
    const { zipFile, shaFile } = release.writeAddonAssets(pack, path.join(root, 'dist'));
    log(`Dry run: nothing published. The files are at ${zipFile} and ${shaFile}`);
  } else {
    if (flags.git) tag = commitAndTag(root, { kind: 'addon', ver: plan.next, files: [tocFile], push: true, log });
    try {
      const out = await release.publishAddon({
        pack, notes, outDir: path.join(root, 'dist'), gh: o.gh, env: o.env, onLog: log, verifyTag: Boolean(tag), target: ciTarget(o.env, flags),
      });
      url = out.url;
    } catch (e) {
      throw tag ? pushedButNotPublished(e, 'addon', tag) : e;
    }
  }

  if (flags.curseforge) await uploadCurseForge({ addonDir, pack, notes, flags, o });
  return { kind: 'addon', version: plan.next, pack, skipped: false, tag, url };
}

async function uploadCurseForge({ addonDir, pack, notes, flags, o }) {
  const cf = require('./curseforge');
  const toc = cf.readAddonToc(addonDir);
  await cf.uploadToCurseForge({ zip: pack.zip, fileName: pack.fileName, toc, notes, dryRun: Boolean(flags['dry-run']), onLog: o.log, onWarn: o.warn, fetch: o.fetch });
}

async function releaseApp(cfg, flags, o) {
  const { root, log } = o;
  const appDir = path.join(root, 'app');
  const current = release.readAppVersion(appDir);
  const tagOnly = flags['tag-only'];
  const publish = !flags['dry-run'] && !tagOnly;
  // Read (and check) the Battle.net credentials before anything slow.
  const bnet = tagOnly ? null : release.bnetCredentialsFrom({ env: o.env, config: cfg.config });
  if (publish) await requireGh(o);
  // Check GitHub before a build that takes minutes.
  const published = tagOnly ? null : await fetchPublished(o, { required: publish });
  const plan = await planVersion({ kind: 'app', current, how: bumpHow(flags), published, flags, o, publish });
  if (plan.skip) return { kind: 'app', version: plan.next, skipped: true };
  if (flags.git && tagExists(root, plan.tag)) throw new UsageError(`The tag ${plan.tag} already exists. Bump to a new version.`);
  const notes = readNotes(flags, root, 'app');

  const bumped = [path.join(appDir, 'package.json')];
  if (fs.existsSync(path.join(appDir, 'package-lock.json'))) bumped.push(path.join(appDir, 'package-lock.json'));
  if (plan.next !== current) {
    release.bumpAppVersion(appDir, plan.next);
    log(`App version: ${current} → ${plan.next} (app/package.json)`);
  } else log(`App version: ${plan.next}`);

  if (tagOnly) {
    const tag = commitAndTag(root, { kind: 'app', ver: plan.next, files: bumped, push: flags.push, log });
    if (!flags.push) log(`Push it to start the release workflow: git push origin HEAD ${tag}`);
    return { kind: 'app', version: plan.next, tag };
  }

  const { distDir } = await (o.buildApp || release.buildApp)(appDir, { onLog: log, onWarn: o.warn, bnet: bnet || null });
  const build = release.readAppBuild(distDir);
  if (build.version !== plan.next) {
    throw new Error(`The build in ${distDir} is version ${build.version}, but app/package.json says ${plan.next}. The build probably failed; check the output above.`);
  }
  logNotes(log, notes);

  let tag = null;
  let url = null;
  if (flags['dry-run']) {
    log('Dry run: nothing published. The build is in:');
    for (const f of build.files) log(`  ${f}`);
    log(`  ${build.latestYmlFile}`);
  } else {
    if (flags.git) tag = commitAndTag(root, { kind: 'app', ver: plan.next, files: bumped, push: true, log });
    try {
      const out = await release.publishApp({ distDir, notes, gh: o.gh, env: o.env, onLog: log, verifyTag: Boolean(tag), target: ciTarget(o.env, flags) });
      url = out.url;
    } catch (e) {
      throw tag ? pushedButNotPublished(e, 'app', tag) : e;
    }
  }
  return { kind: 'app', version: plan.next, build, tag, url };
}

async function status(cfg, o) {
  const { root, log } = o;
  const addon = (() => { try { return release.readAddonVersion(path.join(root, 'addon', 'WowGuild')); } catch { return null; } })();
  const app = (() => { try { return release.readAppVersion(path.join(root, 'app')); } catch { return null; } })();
  log(`Repository: ${REPO} (${release.releasesPage(REPO)})`);
  const gh = await release.ghStatus({ gh: o.gh, env: o.env });
  let ghLine;
  if (!gh.installed) ghLine = 'not installed. Install it from https://cli.github.com, then run gh auth login.';
  else if (!gh.loggedIn) ghLine = `${gh.version || 'installed'}, not signed in. Run gh auth login.`;
  else {
    const access = gh.push === true ? ', can publish' : gh.push === false ? `, can't push to ${REPO}` : '';
    ghLine = `${gh.version || 'installed'}, signed in${gh.account ? ` as ${gh.account}` : ''}${access}.`;
  }
  log(`GitHub CLI: ${ghLine}`);
  if (gh.private === true) {
    log(`The repository is private, so players can't download updates yet. The owner makes it public with: gh repo edit ${REPO} --visibility public --accept-visibility-change-consequences`);
  }
  let bnetLine;
  try {
    const bnet = release.bnetCredentialsFrom({ env: o.env, config: cfg.config });
    bnetLine = bnet ? `client id and secret set (${bnet.from}).` : 'not set, so app builds have no Battle.net sign-in.';
  } catch (e) {
    bnetLine = e.message;
  }
  log(`Battle.net: ${bnetLine}`);
  if (cfg.old.length) o.warn(`.release.json still has ${cfg.old.join(' and ')}. They aren't used any more; you can remove them.`);

  const published = await fetchPublished(o, { required: false, useGh: gh.loggedIn });
  const shown = (k) => (!published ? '?' : (published[k] && published[k].version) || 'none');
  const rows = [
    ['', 'Local', 'GitHub', 'Last tag'],
    ['Addon', addon || '-', shown('addon'), lastTag(root, 'addon') || '-'],
    ['App', app || '-', shown('app'), lastTag(root, 'app') || '-'],
  ];
  const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => String(r[c]).length)));
  for (const r of rows) log(`  ${r.map((v, c) => String(v).padEnd(widths[c])).join('   ')}`.trimEnd());
  if (published) {
    for (const [kind, local] of [['addon', addon], ['app', app]]) {
      const live = published[kind] ? published[kind].version : null;
      if (local && version.valid(local) && (!live || version.gt(local, live))) log(`The ${kind} ${local} isn't published yet: node scripts/release.js ${kind}`);
      else if (local && live && version.lt(local, live)) log(`GitHub has a newer ${kind} (${live}) than this checkout (${local}). Pull first.`);
    }
  }
  return { local: { addon, app }, published, gh };
}

// Entry point, also used by the tests. opts: { root, env, log, warn, fetch, buildApp, gh }
async function run(argv, opts = {}) {
  const o = {
    root: opts.root || DEFAULT_ROOT,
    env: opts.env || process.env,
    log: opts.log || ((line) => console.log(line)),
    warn: opts.warn || ((line) => console.warn(line)),
    fetch: opts.fetch,
    buildApp: opts.buildApp,
    gh: opts.gh,
  };
  const { command, extra, flags } = parseArgs(argv);
  if (flags.help || !command) { o.log(USAGE); if (!command && !flags.help) throw new UsageError('Pass a command: addon, app, all or status.'); return null; }
  if (extra.length) throw new UsageError(`Unexpected argument "${extra[0]}". Put notes in quotes: --notes "…"`);
  if (!['addon', 'app', 'all', 'status'].includes(command)) throw new UsageError(`Unknown command "${command}". Use addon, app, all or status.`);
  const cfg = loadConfig({ root: o.root });
  if (command === 'status') return status(cfg, o);
  if (!flags['tag-only']) o.log(`Publishing to GitHub: ${REPO}${flags['dry-run'] ? ' (dry run)' : ''}`);
  const results = [];
  if (command === 'addon' || command === 'all') results.push(await releaseAddon(cfg, flags, o));
  if (command === 'app' || command === 'all') results.push(await releaseApp(cfg, flags, o));
  return results;
}

if (require.main === module) {
  run(process.argv.slice(2)).catch((e) => {
    if (e.code === 'NO_GH' || e.code === 'NOT_LOGGED_IN') console.error(e.message);
    else console.error(`Error: ${e.message}`);
    process.exitCode = 1;
  });
}

module.exports = { run, parseArgs, loadConfig, USAGE, GH_HELP_MISSING, GH_HELP_LOGIN, REMOVED };
