#!/usr/bin/env node
'use strict';
// Publishes Guild Camp updates to the server: the addon, the app, or both.
// The work happens in app/src/shared/release.js (the app's Releases page uses it too).
// Run with --help for the options; docs/RELEASING.md walks through a release.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const release = require('../app/src/shared/release');
const version = require('../app/src/shared/version');

const DEFAULT_ROOT = path.join(__dirname, '..');
const DEFAULT_SERVER = 'https://wow.cjplumbing.co.za';

const USAGE = `Publish Guild Camp updates.

Usage: node scripts/release.js <addon|app|all|status> [options]

  addon    bump addon/WowGuild/WowGuild.toc, zip the addon, upload it
  app      bump app/package.json, build the installer, upload it
  all      addon, then app
  status   local versions next to what the server has published

Versions:
  --bump patch|minor|major|beta   bump the version first
  --version x.y.z                 set an exact version first
  --no-bump                       release the version already in the files (the default)

Release notes:
  --notes "text"                  the notes players see
  --notes-file FILE               read the notes from a file
  --notes-from-git                commit subjects since the last addon-v*/app-v* tag

Publishing:
  --server URL                    server address (or GUILDCAMP_SERVER, or .release.json)
  --token TOKEN                   publish token  (or GUILDCAMP_PUBLISH_TOKEN, or .release.json)
  --dry-run                       build and zip, but upload nothing; shows where the files are
  --force                         addon: publish even when the server has this or a newer version (rollback)
  --skip-published                if the server already has this exact version, skip the upload (CI uses this)
  --curseforge                    also upload the addon zip to CurseForge (needs CF_API_TOKEN)

Git:
  --git                           commit the version bump and tag addon-v<version> / app-v<version>
  --push                          push that commit and tag (implies --git)
  --tag-only                      bump, commit and tag, but don't build or upload: pushing the tag
                                  (add --push) lets GitHub Actions build and publish

  -h, --help                      this help
`;

const FLAGS = {
  bump: 'string', version: 'string', 'no-bump': 'boolean', notes: 'string', 'notes-file': 'string',
  'notes-from-git': 'boolean', 'dry-run': 'boolean', git: 'boolean', push: 'boolean', curseforge: 'boolean',
  server: 'string', token: 'string', force: 'boolean', 'skip-published': 'boolean', 'tag-only': 'boolean', help: 'boolean',
};

class UsageError extends Error {}

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
    if (!type) throw new UsageError(`Unknown option --${name}. Run with --help to see the options.`);
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
  return { command: positional[0], extra: positional.slice(1), flags };
}

// flags > environment > .release.json at the repo root > the default server.
function loadConfig({ flags = {}, env = process.env, root = DEFAULT_ROOT } = {}) {
  const file = path.join(root, '.release.json');
  let saved = {};
  if (fs.existsSync(file)) {
    try { saved = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (e) {
      throw new UsageError(`.release.json isn't valid JSON (${e.message}). It should look like {"server": "https://…", "token": "…"}.`);
    }
  }
  const pick = (flag, envName, key, fallback) => {
    if (flags[flag]) return { value: flags[flag], from: `--${flag}` };
    if (env[envName]) return { value: env[envName], from: envName };
    if (saved[key]) return { value: saved[key], from: '.release.json' };
    return { value: fallback, from: fallback ? 'default' : null };
  };
  const server = pick('server', 'GUILDCAMP_SERVER', 'server', DEFAULT_SERVER);
  const token = pick('token', 'GUILDCAMP_PUBLISH_TOKEN', 'token', '');
  return { server: server.value.replace(/\/+$/, ''), serverFrom: server.from, token: token.value, tokenFrom: token.from };
}

const NO_TOKEN_HELP = `No publish token.
  1. On the server, set PUBLISH_TOKEN to a long random string and restart it.
     (Make one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  2. Give this script the same value, in one of these ways:
       set GUILDCAMP_PUBLISH_TOKEN in your shell (PowerShell: $env:GUILDCAMP_PUBLISH_TOKEN = "…")
       pass --token <value>
       put {"token": "<value>"} in .release.json at the repo root (it's gitignored)
     In GitHub Actions, add it as the repository secret GUILDCAMP_PUBLISH_TOKEN.`;

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim();
}

function tagExists(root, tag) {
  try { git(root, 'rev-parse', '-q', '--verify', `refs/tags/${tag}`); return true; } catch { return false; }
}

function lastTag(root, kind) {
  try { return git(root, 'describe', '--tags', '--abbrev=0', '--match', `${kind}-v*`, 'HEAD'); } catch { return null; }
}

function gitError(e) {
  const said = e && e.stderr ? String(e.stderr).trim().split(/\r?\n/).slice(-3).join(' ') : (e && e.message) || '';
  return said;
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
  const tag = `${kind}-v${ver}`;
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
    throw new Error(`Git failed: ${gitError(e)}. The release itself is done; commit and tag by hand.`);
  }
  if (push) {
    try {
      git(root, 'push', '--atomic', 'origin', 'HEAD', `refs/tags/${tag}`);
      log(`Pushed the commit and ${tag} to origin.`);
    } catch (e) {
      throw new Error(`git push failed: ${gitError(e)}. Push by hand: git push origin HEAD ${tag}`);
    }
  }
  return tag;
}

async function fetchPublished(cfg, opts, { required }) {
  try {
    return await release.getReleases(cfg.server, { fetch: opts.fetch });
  } catch (e) {
    if (required) throw e;
    opts.warn(`Couldn't check what the server has. ${e.message}`);
    return null;
  }
}

function needToken(cfg) {
  if (!cfg.token) { const e = new Error(NO_TOKEN_HELP); e.code = 'NO_TOKEN'; throw e; }
}

// Works out the version to release, refusing early when it can't be published.
// → { current, next, skip } — skip: the server already has exactly this version (--skip-published).
function planVersion({ kind, current, how, published, flags, log }) {
  const next = how ? release.nextVersion(current, how, kind === 'addon' ? 'WowGuild.toc' : 'app/package.json') : current;
  if (!version.valid(next)) throw new UsageError(`The ${kind} version "${next}" isn't valid. Pass --version x.y.z.`);
  // The addon bundled in the server image (source 'bundled') stands in until one is published; the
  // server takes any first upload over it, so it doesn't count as published here.
  const rec = published && published[kind];
  const live = rec && rec.source !== 'bundled' ? rec.version : null;
  if (live && !version.gt(next, live)) {
    if (flags['skip-published'] && version.compare(next, live) === 0) {
      log(`The server already has ${kind} ${next}. Nothing to upload.`);
      return { current, next, skip: true };
    }
    const forceable = kind === 'addon' && flags.force;
    if (!forceable && !flags['dry-run']) {
      const hint = kind === 'addon' ? ' Use --bump patch for a new version, or --force to roll back to this one.' : ' Use --bump patch (or --version) for a new version.';
      throw new UsageError(`The server already has ${kind} ${live}, and ${next} isn't newer.${hint}`);
    }
    if (!forceable) log(`Note: the server has ${kind} ${live}; ${next} isn't newer, so a real run would be refused.`);
  }
  return { current, next, skip: false };
}

async function releaseAddon(cfg, flags, opts) {
  const { root, log } = opts;
  const addonDir = path.join(root, 'addon', 'WowGuild');
  const tocFile = path.join(addonDir, 'WowGuild.toc');
  const current = release.readAddonVersion(addonDir);
  const tagOnly = flags['tag-only'];
  const upload = !flags['dry-run'] && !tagOnly;
  if (upload) needToken(cfg);
  const published = tagOnly ? null : await fetchPublished(cfg, opts, { required: upload });
  const plan = planVersion({ kind: 'addon', current, how: bumpHow(flags), published, flags, log });
  if (flags.git && tagExists(root, `addon-v${plan.next}`)) throw new UsageError(`The tag addon-v${plan.next} already exists. Bump to a new version.`);
  const notes = readNotes(flags, root, 'addon');

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
  if (notes) log(`Notes:\n${notes.split('\n').map((l) => `  ${l}`).join('\n')}`);

  if (flags['dry-run']) {
    const out = path.join(root, 'dist', pack.fileName);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, pack.zip);
    log(`Dry run: nothing uploaded. The zip is at ${out}`);
  } else if (!plan.skip) {
    await release.publishAddon({ server: cfg.server, token: cfg.token, pack, notes, force: Boolean(flags.force), onLog: log, fetch: opts.fetch });
  }

  if (flags.curseforge) {
    const cf = require('./curseforge');
    const toc = cf.readAddonToc(addonDir);
    await cf.uploadToCurseForge({ zip: pack.zip, fileName: pack.fileName, toc, notes, dryRun: Boolean(flags['dry-run']), onLog: log, onWarn: opts.warn, fetch: opts.fetch });
  }

  let tag = null;
  if (flags.git && !flags['dry-run']) tag = commitAndTag(root, { kind: 'addon', ver: plan.next, files: [tocFile], push: flags.push, log });
  return { kind: 'addon', version: plan.next, pack, skipped: plan.skip, tag };
}

async function releaseApp(cfg, flags, opts) {
  const { root, log } = opts;
  const appDir = path.join(root, 'app');
  const current = release.readAppVersion(appDir);
  const tagOnly = flags['tag-only'];
  const upload = !flags['dry-run'] && !tagOnly;
  if (upload) needToken(cfg);
  // Check the server before a build that takes minutes.
  const published = tagOnly ? null : await fetchPublished(cfg, opts, { required: upload });
  const plan = planVersion({ kind: 'app', current, how: bumpHow(flags), published, flags, log });
  if (plan.skip) return { kind: 'app', version: plan.next, skipped: true };
  if (flags.git && tagExists(root, `app-v${plan.next}`)) throw new UsageError(`The tag app-v${plan.next} already exists. Bump to a new version.`);
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

  const { distDir } = await (opts.buildApp || release.buildApp)(appDir, { onLog: log });
  const build = release.readAppBuild(distDir);
  if (build.version !== plan.next) {
    throw new Error(`The build in ${distDir} is version ${build.version}, but app/package.json says ${plan.next}. The build probably failed; check the output above.`);
  }
  if (notes) log(`Notes:\n${notes.split('\n').map((l) => `  ${l}`).join('\n')}`);

  if (flags['dry-run']) {
    log('Dry run: nothing uploaded. The build is in:');
    for (const f of build.files) log(`  ${f}`);
    log(`  ${path.join(distDir, 'latest.yml')}`);
  } else {
    await release.publishApp({ server: cfg.server, token: cfg.token, distDir, notes, onLog: log, fetch: opts.fetch });
  }

  let tag = null;
  if (flags.git && !flags['dry-run']) tag = commitAndTag(root, { kind: 'app', ver: plan.next, files: bumped, push: flags.push, log });
  return { kind: 'app', version: plan.next, build, tag };
}

async function status(cfg, opts) {
  const { root, log } = opts;
  const addon = (() => { try { return release.readAddonVersion(path.join(root, 'addon', 'WowGuild')); } catch { return null; } })();
  const app = (() => { try { return release.readAppVersion(path.join(root, 'app')); } catch { return null; } })();
  log(`Server: ${cfg.server} (${cfg.serverFrom})`);
  log(`Token:  ${cfg.token ? `set (${cfg.tokenFrom})` : 'not set'}`);
  const published = await fetchPublished(cfg, opts, { required: false });
  // The server's bundled addon (source 'bundled') isn't a published release.
  const liveOf = (k) => (published && published[k] && published[k].source !== 'bundled' ? published[k].version : null);
  const shown = (k) => {
    if (!published) return '?';
    const rec = published[k];
    if (rec && rec.source === 'bundled') return `none (bundled ${rec.version})`;
    return (rec && rec.version) || 'none';
  };
  const rows = [
    ['', 'Local', 'Published', 'Last tag'],
    ['Addon', addon || '-', shown('addon'), lastTag(root, 'addon') || '-'],
    ['App', app || '-', shown('app'), lastTag(root, 'app') || '-'],
  ];
  const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => String(r[c]).length)));
  for (const r of rows) log(`  ${r.map((v, c) => String(v).padEnd(widths[c])).join('   ')}`.trimEnd());
  if (published) {
    for (const [kind, local] of [['addon', addon], ['app', app]]) {
      const live = liveOf(kind);
      if (local && version.gt(local, live)) log(`The ${kind} ${local} isn't published yet: node scripts/release.js ${kind}`);
      else if (local && live && version.lt(local, live)) log(`The server has a newer ${kind} (${live}) than this checkout (${local}). Pull first.`);
    }
  }
  return { local: { addon, app }, published };
}

// Entry point, also used by the tests. opts: { root, env, log, warn, fetch, buildApp }
async function run(argv, opts = {}) {
  const o = {
    root: opts.root || DEFAULT_ROOT,
    env: opts.env || process.env,
    log: opts.log || ((line) => console.log(line)),
    warn: opts.warn || ((line) => console.warn(line)),
    fetch: opts.fetch,
    buildApp: opts.buildApp,
  };
  const { command, extra, flags } = parseArgs(argv);
  if (flags.help || !command) { o.log(USAGE); if (!command && !flags.help) throw new UsageError('Pass a command: addon, app, all or status.'); return null; }
  if (extra.length) throw new UsageError(`Unexpected argument "${extra[0]}". Put notes in quotes: --notes "…"`);
  if (!['addon', 'app', 'all', 'status'].includes(command)) throw new UsageError(`Unknown command "${command}". Use addon, app, all or status.`);
  const cfg = loadConfig({ flags, env: o.env, root: o.root });
  if (command === 'status') return status(cfg, o);
  if (!flags['tag-only']) o.log(`Server: ${cfg.server}${flags['dry-run'] ? ' (dry run)' : ''}`);
  const results = [];
  if (command === 'addon' || command === 'all') results.push(await releaseAddon(cfg, flags, o));
  if (command === 'app' || command === 'all') results.push(await releaseApp(cfg, flags, o));
  return results;
}

if (require.main === module) {
  run(process.argv.slice(2)).catch((e) => {
    if (e.code === 'NO_TOKEN') console.error(e.message);
    else {
      console.error(`Error: ${e.message}`);
      if (e.status === 401 || e.status === 403) {
        console.error('The token must match PUBLISH_TOKEN on the server (or be the guild owner\'s device token). Set it with GUILDCAMP_PUBLISH_TOKEN, --token, or .release.json.');
      }
    }
    process.exitCode = 1;
  });
}

module.exports = { run, parseArgs, loadConfig, USAGE, DEFAULT_SERVER, NO_TOKEN_HELP };
