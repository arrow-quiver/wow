#!/usr/bin/env node
'use strict';
// Uploads the addon (addon/WowGuild) to CurseForge as a new file. Optional: Guild Camp players
// get the addon from the app; CurseForge is for everyone else.
//
//   node scripts/curseforge.js --dry-run                   build the zip and show what would be sent
//   CF_API_TOKEN=... node scripts/curseforge.js --dry-run  also look up CurseForge's game versions
//   CF_API_TOKEN=... node scripts/curseforge.js addon-v0.11.1
//
// scripts/release.js addon --curseforge calls uploadToCurseForge() with the same zip it
// publishes as a GitHub release.
// The project id comes from "## X-Curse-Project-ID:" in WowGuild.toc (or CF_PROJECT_ID).
const fs = require('fs');
const path = require('path');
const { readToc: parseToc, tocField } = require('../app/src/shared/toc');
const release = require('../app/src/shared/release');

const ROOT = path.join(__dirname, '..');
const ADDON_DIR = path.join(ROOT, 'addon', 'WowGuild');
const API = 'https://wow.curseforge.com/api';
// CurseForge's game version types (the same ids the BigWigs packager uses).
const TYPE_IDS = { retail: 517, classic: 67408, forever: 88568 };

// The parts of WowGuild.toc CurseForge needs.
function readAddonToc(dir = ADDON_DIR) {
  const text = fs.readFileSync(path.join(release.resolveAddonDir(dir), 'WowGuild.toc'), 'utf8');
  const field = (k) => tocField(text, k) || '';
  return {
    title: field('Title'),
    version: field('Version'),
    interfaces: field('Interface').split(',').map((s) => s.trim()).filter(Boolean),
    projectId: field('X-Curse-Project-ID'),
    fields: parseToc(text).fields,
  };
}

// 120105 → retail 12.1.5, 16001 → forever 1.60.1, 11507 → classic 1.15.7.
function interfaceToVersion(iface) {
  const n = String(iface).trim();
  if (!/^\d{5,6}$/.test(n)) throw new Error(`"${n}" isn't an interface number.`);
  const name = `${Number(n.slice(0, -4))}.${Number(n.slice(-4, -2))}.${Number(n.slice(-2))}`;
  const type = /^16\d{3}$/.test(n) ? 'forever' : /^11\d{3}$/.test(n) ? 'classic' : n.length === 6 ? 'retail' : null;
  if (!type) throw new Error(`Interface ${n} is for a game type this script doesn't upload to yet.`);
  return { type, name };
}

// Game versions are dotted numbers of any length ("1.15.7", "12.0"), so compare part by part.
function versionCompare(a, b) {
  const pa = a.split('.').map(Number); const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

// Exact match if CurseForge has it; otherwise the newest version below it, like the packager does.
// Never borrows a version from another game type.
function pickVersion(versions, { type, name }) {
  const ofType = versions.filter((v) => v.gameVersionTypeID === TYPE_IDS[type] && /^\d+(\.\d+)*$/.test(v.name));
  const exact = ofType.find((v) => v.name === name);
  if (exact) return { version: exact };
  const sorted = ofType.sort((a, b) => versionCompare(a.name, b.name));
  const fallback = sorted.filter((v) => versionCompare(v.name, name) < 0).pop() || sorted[sorted.length - 1];
  if (!fallback) throw new Error(`CurseForge lists no ${type} game versions.`);
  return { version: fallback, warning: `CurseForge has no ${type} ${name} yet, so the file is tagged ${fallback.name}.` };
}

// Versions or tags containing "alpha" / "beta" upload as alpha / beta files.
function releaseTypeFor(versionOrTag) {
  const s = String(versionOrTag || '');
  return /alpha/i.test(s) ? 'alpha' : /beta/i.test(s) ? 'beta' : 'release';
}

// The zip holds one WowGuild/ folder, like every addon zip (the same zip the GitHub release gets).
function buildZip(dir = ADDON_DIR) {
  const pack = release.packAddon(dir);
  return { zip: pack.zip, files: pack.files, pack };
}

function changelogMarkdown(toc, notes) {
  return `## ${toc.title || 'Guild Camp'} ${toc.version}\n\n${String(notes || '').trim() || '- Maintenance release.'}\n`;
}

// Uploads one zip. → { uploaded, metadata, projectId, response }
// Without a token: a dry run just reports; a real run throws a message that says how to get one.
async function uploadToCurseForge({
  zip, fileName, toc, notes = '', releaseType, token = process.env.CF_API_TOKEN || process.env.CF_API_KEY,
  projectId = process.env.CF_PROJECT_ID, dryRun = false, onLog = console.log, onWarn = console.warn, fetch: fetchImpl = globalThis.fetch,
} = {}) {
  if (!Buffer.isBuffer(zip)) throw new Error('uploadToCurseForge needs the addon zip.');
  if (!toc || !toc.version) throw new Error('uploadToCurseForge needs the addon\'s TOC details (title, version, interfaces).');
  const type = releaseType || releaseTypeFor(toc.version);
  const name = fileName || `WowGuild-${toc.version}.zip`;
  const wanted = (toc.interfaces || []).map(interfaceToVersion);
  if (!wanted.length) throw new Error('WowGuild.toc has no "## Interface:" line, so CurseForge wouldn\'t know which game it is for.');
  onLog(`CurseForge: ${toc.title} ${toc.version} (${type}), ${Math.round(zip.length / 1024)} KB, for ${wanted.map((w) => `${w.type} ${w.name}`).join(', ')}`);

  if (!token) {
    if (dryRun) { onLog('CurseForge: no CF_API_TOKEN, so the game versions were not looked up.'); return { uploaded: false, metadata: null }; }
    throw new Error('CF_API_TOKEN is not set. Make one on CurseForge (author dashboard → API tokens), then set it in your shell or as a GitHub secret.');
  }

  const res = await fetchImpl(`${API}/game/wow/versions`, { headers: { 'X-Api-Token': token } });
  if (!res.ok) throw new Error(`Couldn't read CurseForge's game versions (${res.status}). Check CF_API_TOKEN.`);
  const versions = await res.json();
  const picked = wanted.map((w) => pickVersion(versions, w));
  for (const p of picked) if (p.warning) onWarn(`Warning: ${p.warning}`);
  const metadata = {
    displayName: `${toc.title} ${toc.version}`,
    changelog: changelogMarkdown(toc, notes),
    changelogType: 'markdown',
    gameVersions: [...new Set(picked.map((p) => p.version.id))],
    releaseType: type,
  };
  if (dryRun) { onLog(`CurseForge dry run: would upload ${JSON.stringify(metadata, null, 2)}`); return { uploaded: false, metadata }; }

  const project = String(projectId || toc.projectId || '').trim();
  if (!/^\d+$/.test(project)) {
    throw new Error('No CurseForge project id. Add "## X-Curse-Project-ID: <id>" to WowGuild.toc (the number in the About Project box on the project page).');
  }
  const form = new FormData();
  form.append('metadata', JSON.stringify(metadata));
  form.append('file', new Blob([zip], { type: 'application/zip' }), name);
  const up = await fetchImpl(`${API}/projects/${project}/upload-file`, { method: 'POST', headers: { 'X-Api-Token': token }, body: form });
  const text = await up.text();
  if (!up.ok) throw new Error(`CurseForge upload failed (${up.status}): ${text.slice(0, 300)}`);
  let response = null;
  try { response = JSON.parse(text); } catch { /* CurseForge normally answers { id } */ }
  onLog(`CurseForge: uploaded ${name} to project ${project}. It appears on the project page once CurseForge has processed it.`);
  return { uploaded: true, metadata, projectId: project, response };
}

async function main(argv = process.argv.slice(2)) {
  const dry = argv.includes('--dry-run');
  const tag = argv.find((a) => !a.startsWith('--')) || '';
  const toc = readAddonToc();
  if (!toc.version) throw new Error('WowGuild.toc has no "## Version:" line.');
  if (!tag && !dry) throw new Error('Pass the tag (e.g. addon-v0.11.1), or --dry-run.');
  if (tag && tag !== `addon-v${toc.version}`) {
    throw new Error(`Tag ${tag} doesn't match "## Version: ${toc.version}" in WowGuild.toc. Bump the version, commit, then tag addon-v<version>.`);
  }
  const { zip, files, pack } = buildZip();
  const notes = release.gitChangelog(ROOT, 'addon', { ref: tag || 'HEAD' });
  console.log(`${toc.title} ${toc.version}: ${files.length} files`);
  if (dry) {
    const out = path.join(ROOT, 'dist', pack.fileName);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, zip);
    console.log(`Dry run: wrote ${out}\n\n${changelogMarkdown(toc, notes)}`);
  }
  await uploadToCurseForge({ zip, fileName: pack.fileName, toc, notes, releaseType: releaseTypeFor(tag || toc.version), dryRun: dry });
}

if (require.main === module) {
  main().catch((e) => { console.error(e.message); process.exitCode = 1; });
}

module.exports = {
  readAddonToc,
  readToc: readAddonToc, // the old script's name
  interfaceToVersion,
  pickVersion,
  releaseTypeFor,
  buildZip,
  changelogMarkdown,
  uploadToCurseForge,
  TYPE_IDS,
};
