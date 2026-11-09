#!/usr/bin/env node
// Uploads the addon (addon/WowGuild) to CurseForge as a new file.
// .github/workflows/curseforge.yml runs this when you push a tag like addon-v0.9.0.
//
//   node web/scripts/curseforge.js --dry-run                 build the zip and show what would be sent
//   CF_API_TOKEN=... node web/scripts/curseforge.js --dry-run  also look up CurseForge's game versions
//   CF_API_TOKEN=... node web/scripts/curseforge.js addon-v0.9.0
//
// The project id comes from "## X-Curse-Project-ID:" in WowGuild.toc (or CF_PROJECT_ID).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { writeZip } = require('../src/zipkit');

const ROOT = path.join(__dirname, '..', '..');
const ADDON_DIR = path.join(ROOT, 'addon', 'WowGuild');
const API = 'https://wow.curseforge.com/api';
// CurseForge's game version types (the same ids the BigWigs packager uses).
const TYPE_IDS = { retail: 517, classic: 67408, forever: 88568 };

function readToc(dir = ADDON_DIR) {
  const text = fs.readFileSync(path.join(dir, 'WowGuild.toc'), 'utf8');
  const field = (k) => { const m = new RegExp(`^## ${k}:[ \\t]*(.*?)\\s*$`, 'm').exec(text); return m ? m[1] : ''; };
  return {
    title: field('Title'),
    version: field('Version'),
    interfaces: field('Interface').split(',').map((s) => s.trim()).filter(Boolean),
    projectId: field('X-Curse-Project-ID'),
  };
}

// 120105 → retail 12.1.5, 16001 → forever 1.60.1, 11507 → classic 1.15.7.
function interfaceToVersion(iface) {
  const n = String(iface);
  if (!/^\d{5,6}$/.test(n)) throw new Error(`"${n}" isn't an interface number.`);
  const name = `${Number(n.slice(0, -4))}.${Number(n.slice(-4, -2))}.${Number(n.slice(-2))}`;
  const type = /^16\d{3}$/.test(n) ? 'forever' : /^11\d{3}$/.test(n) ? 'classic' : n.length === 6 ? 'retail' : null;
  if (!type) throw new Error(`Interface ${n} is for a game type this script doesn't upload to yet.`);
  return { type, name };
}

function versionCompare(a, b) {
  const pa = a.split('.').map(Number); const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

// Exact match if CurseForge has it; otherwise the newest version below it, like the packager does.
function pickVersion(versions, { type, name }) {
  const ofType = versions.filter((v) => v.gameVersionTypeID === TYPE_IDS[type] && /^\d+(\.\d+)*$/.test(v.name));
  const exact = ofType.find((v) => v.name === name);
  if (exact) return { version: exact };
  const sorted = ofType.sort((a, b) => versionCompare(a.name, b.name));
  const fallback = sorted.filter((v) => versionCompare(v.name, name) < 0).pop() || sorted[sorted.length - 1];
  if (!fallback) throw new Error(`CurseForge lists no ${type} game versions.`);
  return { version: fallback, warning: `CurseForge has no ${type} ${name} yet, so the file is tagged ${fallback.name}.` };
}

// The zip holds one WowGuild/ folder, like every addon zip.
function buildZip(dir = ADDON_DIR) {
  const entries = [];
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, `${rel}/${e.name}`);
      else entries.push({ name: `${rel}/${e.name}`, data: fs.readFileSync(p) });
    }
  };
  walk(dir, path.basename(dir));
  return { zip: writeZip(entries), files: entries.map((e) => e.name) };
}

function changelog(ref, toc) {
  const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  let prev = '';
  try { prev = git('describe', '--tags', '--abbrev=0', '--match', 'addon-v*', `${ref}^`); } catch { /* first release */ }
  let lines = '';
  try { lines = git('log', '--no-merges', '--format=- %s', prev ? `${prev}..${ref}` : ref, '--', 'addon/WowGuild'); } catch { /* no git */ }
  return `## ${toc.title} ${toc.version}\n\n${lines || '- Maintenance release.'}\n`;
}

async function main() {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry-run');
  const tag = args.find((a) => !a.startsWith('--')) || '';
  const toc = readToc();
  if (!toc.version) throw new Error('WowGuild.toc has no "## Version:" line.');
  if (!tag && !dry) throw new Error('Pass the tag (e.g. addon-v0.9.0), or --dry-run.');
  if (tag && tag !== `addon-v${toc.version}`) {
    throw new Error(`Tag ${tag} doesn't match "## Version: ${toc.version}" in WowGuild.toc. Bump the version, commit, then tag addon-v<version>.`);
  }

  const releaseType = /alpha/i.test(tag) ? 'alpha' : /beta/i.test(tag) ? 'beta' : 'release';
  const wanted = toc.interfaces.map(interfaceToVersion);
  const { zip, files } = buildZip();
  const fileName = `WowGuild-${toc.version}.zip`;
  const notes = changelog(tag || 'HEAD', toc);
  console.log(`${toc.title} ${toc.version} (${releaseType}): ${files.length} files, ${Math.round(zip.length / 1024)} KB`);
  console.log(`Game versions: ${wanted.map((w) => `${w.type} ${w.name}`).join(', ')}`);

  const token = process.env.CF_API_TOKEN || process.env.CF_API_KEY;
  if (!token) {
    if (!dry) throw new Error('CF_API_TOKEN is not set. Make one on CurseForge (author dashboard → API tokens) and add it as a GitHub secret.');
    const out = path.join(os.tmpdir(), fileName);
    fs.writeFileSync(out, zip);
    console.log(`Dry run: wrote ${out}\n\n${notes}`);
    return;
  }

  const res = await fetch(`${API}/game/wow/versions`, { headers: { 'X-Api-Token': token } });
  if (!res.ok) throw new Error(`Couldn't read CurseForge's game versions (${res.status}). Check CF_API_TOKEN.`);
  const versions = await res.json();
  const picked = wanted.map((w) => pickVersion(versions, w));
  for (const p of picked) if (p.warning) console.warn(`Warning: ${p.warning}`);
  const metadata = {
    displayName: `${toc.title} ${toc.version}`,
    changelog: notes,
    changelogType: 'markdown',
    gameVersions: [...new Set(picked.map((p) => p.version.id))],
    releaseType,
  };
  if (dry) { console.log('Dry run: would upload', JSON.stringify(metadata, null, 2)); return; }

  const projectId = process.env.CF_PROJECT_ID || toc.projectId;
  if (!/^\d+$/.test(projectId || '')) {
    throw new Error('No CurseForge project id. Add "## X-Curse-Project-ID: <id>" to WowGuild.toc (the number in the About Project box on the project page).');
  }
  const form = new FormData();
  form.append('metadata', JSON.stringify(metadata));
  form.append('file', new Blob([zip], { type: 'application/zip' }), fileName);
  const up = await fetch(`${API}/projects/${projectId}/upload-file`, { method: 'POST', headers: { 'X-Api-Token': token }, body: form });
  const text = await up.text();
  if (!up.ok) throw new Error(`CurseForge upload failed (${up.status}): ${text.slice(0, 300)}`);
  console.log(`Uploaded ${fileName} to CurseForge project ${projectId}. It appears on the project page once CurseForge has processed it.`);
}

if (require.main === module) {
  main().catch((e) => { console.error(e.message); process.exitCode = 1; });
}

module.exports = { readToc, interfaceToVersion, pickVersion, buildZip };
