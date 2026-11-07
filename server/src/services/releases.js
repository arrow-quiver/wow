'use strict';
// Release hosting: the app installers and addon zips published to this server, and what the
// desktop app should update to. Routes live in routes/releases.js; shapes in docs/api/releases.md.
//
// Files live under cfg.updatesDir (UPDATES_DIR, /data/updates in Docker):
//   app/latest.yml                    electron-updater's manifest, written LAST and atomically
//   app/Guild-Camp-Setup-0.11.1.exe   + .blockmap (the newest 5 versions are kept)
//   addon/latest.json                 { version, notes, sha256, size, file, publishedAt }
//   addon/WowGuild-0.11.1.zip
// Uploads stream to a dot-named temp file in the same folder (".upload-<hex>.part"), so a
// finished upload is moved into place with one rename, and a failed one is simply deleted.
// Dot files are never served and never count as releases.
//
// The releases table is the record of what was published (notes, who, when). When it has no
// rows (a replaced database), the manifests on disk stand in. When no addon was ever published,
// the addon bundled with the server (cfg.bundledAddonDir) is offered instead, zipped on demand.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { HttpError } = require('../http');
const release = require('../../../app/src/shared/release');
const version = require('../../../app/src/shared/version');
const zip = require('../../../app/src/shared/zip');
const toc = require('../../../app/src/shared/toc');
const hash = require('../../../app/src/shared/hash');

const ADDON = 'WowGuild';
const ADDON_TOC = `${ADDON}/${ADDON}.toc`;
const APP_FILE_RE = release.APP_FILE_RE;
const KEEP_APP_VERSIONS = 5;
const MAX_NOTES = 4000;
const MAX_YML = 100 * 1024;
const HISTORY_MAX = 30;
// Upload caps. cfg.maxAppFileBytes / cfg.maxAddonBytes override them (tests use small ones).
const DEFAULT_MAX_APP_FILE = 600 * 1024 * 1024;
const DEFAULT_MAX_ADDON = 20 * 1024 * 1024;
// An addon zip may not unpack to more than this (the real addon is well under 1 MB).
const MAX_ADDON_UNPACKED = 200 * 1024 * 1024;
// Temp files older than this are leftovers from a crash and get swept.
const STALE_TEMP_MS = 60 * 60 * 1000;
const TEMP_RE = /^\.(?:upload-[0-9a-f]+\.part|.+\.tmp-[0-9a-f]+)$/;

const rand = () => crypto.randomBytes(8).toString('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// SQLite's datetime('now') format, so the releases row and latest.json carry the same time.
function sqliteNow() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

// Release notes as people wrote them: newlines kept, trimmed, capped. '' → null.
function cleanNotes(v) {
  const raw = Array.isArray(v) ? v.find((x) => typeof x === 'string') : v;
  if (raw == null || typeof raw === 'object') return null;
  const s = String(raw).replace(/\r\n?/g, '\n').replace(/\u0000/g, '').trim().slice(0, MAX_NOTES).trim();
  return s || null;
}

// The first line of the notes, without a list bullet, for the notification body.
function firstLine(notes) {
  const line = String(notes || '').split('\n').map((l) => l.trim()).find(Boolean);
  return line ? line.replace(/^[-*•]\s+/, '') : null;
}

// latest.yml "url" values are file names next to it (sometimes URL-encoded).
function fileNameFromUrl(url) {
  let name = String(url || '').split(/[?#]/)[0];
  name = name.slice(name.lastIndexOf('/') + 1);
  try { name = decodeURIComponent(name); } catch { /* keep it as it is */ }
  return name;
}

// "Guild-Camp-Setup-0.11.1-beta.2.exe.blockmap" → "0.11.1-beta.2"; no version in the name → null.
function versionFromFileName(name) {
  const base = String(name).replace(/\.blockmap$/i, '').replace(/\.(exe|dmg|zip|AppImage|yml|json)$/i, '');
  const m = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(base);
  return m && version.valid(m[1]) ? m[1] : null;
}

// The files a parsed latest.yml lists → [{ name, sha512, size }]. Throws a 400 on names the
// server would never accept.
function listedFiles(info) {
  let listed = Array.isArray(info.files) ? info.files.filter((f) => f && typeof f === 'object' && f.url) : [];
  if (info.path && !listed.some((f) => fileNameFromUrl(f.url) === fileNameFromUrl(info.path))) {
    listed = [...listed, { url: info.path, sha512: info.sha512 }];
  }
  const out = [];
  for (const f of listed) {
    const name = fileNameFromUrl(f.url);
    if (!APP_FILE_RE.test(name) || name.startsWith('.') || name.length > 200) {
      throw new HttpError(400, `latest.yml lists "${name.slice(0, 120)}", which isn't an installer file name the server accepts.`);
    }
    if (!out.some((x) => x.name === name)) {
      out.push({ name, sha512: typeof f.sha512 === 'string' ? f.sha512 : null, size: typeof f.size === 'number' ? f.size : null });
    }
  }
  return out;
}

// Same-folder rename that survives Windows briefly holding the target open (a download in flight).
async function renameRetry(from, to) {
  for (let i = 0; ; i++) {
    try {
      await fsp.rename(from, to);
      return;
    } catch (e) {
      if (i >= 8 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      await sleep(25 * (i + 1));
    }
  }
}

// Writes the whole file to a temp name, flushes it to disk, then renames it over the target, so
// readers only ever see the old file or the complete new one.
async function writeAtomic(file, data) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${rand()}`);
  try {
    const fh = await fsp.open(tmp, 'wx');
    try {
      await fh.writeFile(data);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await renameRetry(tmp, file);
  } catch (e) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

const rmQuiet = (file) => fsp.rm(file, { force: true }).catch(() => {});
const statQuiet = (file) => fsp.stat(file).catch(() => null);

// Upload problems that come from the disk rather than the request.
function diskError(e) {
  if (e instanceof HttpError) return e;
  if (e && e.code === 'ENOSPC') return new HttpError(507, "The server's disk is full, so the upload couldn't be saved.");
  return e;
}

function createReleases(ctx) {
  const { db, cfg } = ctx;
  const log = ctx.log || console;
  const root = path.resolve(cfg.updatesDir);
  const appDir = path.join(root, 'app');
  const addonDir = path.join(root, 'addon');
  const limits = {
    appFile: Number(cfg.maxAppFileBytes) > 0 ? Number(cfg.maxAppFileBytes) : DEFAULT_MAX_APP_FILE,
    addon: Number(cfg.maxAddonBytes) > 0 ? Number(cfg.maxAddonBytes) : DEFAULT_MAX_ADDON,
  };
  const q = {
    newest: db.prepare('SELECT * FROM releases WHERE kind = ? ORDER BY id DESC LIMIT 1'),
    insert: db.prepare(`INSERT INTO releases (kind, version, notes, file, size, sha256, sha512, published_by, created_at)
      VALUES (@kind, @version, @notes, @file, @size, @sha256, @sha512, @publishedBy, @createdAt)`),
    history: db.prepare(`SELECT r.kind, r.version, r.notes, r.created_at AS publishedAt, u.battletag AS by
      FROM releases r LEFT JOIN users u ON u.id = r.published_by ORDER BY r.id DESC LIMIT ?`),
    guilds: db.prepare('SELECT id FROM guilds ORDER BY id'),
  };

  function ensureDirs() {
    fs.mkdirSync(appDir, { recursive: true });
    fs.mkdirSync(addonDir, { recursive: true });
  }

  // One publish step at a time: commits, addon publishes and the final move of each upload.
  // Uploads themselves stream in parallel; only the short "make it live" parts queue here.
  let chain = Promise.resolve();
  function locked(fn) {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  }

  // sha512 of uploaded files, so a commit doesn't re-read a 100 MB installer it just received.
  const shaCache = new Map(); // name → { size, mtimeMs, sha512 }
  async function sha512Of(abs, st) {
    const name = path.basename(abs);
    const hit = shaCache.get(name);
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.sha512;
    const sha512 = await hash.sha512File(abs);
    shaCache.set(name, { size: st.size, mtimeMs: st.mtimeMs, sha512 });
    return sha512;
  }

  // ---- What is published ----

  // The live latest.yml, parsed. → { text, info, files } or null when there is none (or it's broken).
  function readLatestYml() {
    let text;
    try { text = fs.readFileSync(path.join(appDir, 'latest.yml'), 'utf8'); } catch { return null; }
    try {
      const info = release.parseLatestYml(text);
      return { text, info, files: listedFiles(info) };
    } catch (e) {
      log.warn(`updates/app/latest.yml can't be read: ${e.message}`);
      return null;
    }
  }

  // Names the live app release needs: every file latest.yml lists, plus each one's .blockmap.
  function liveAppFiles() {
    const live = readLatestYml();
    const names = new Set();
    if (live) for (const f of live.files) { names.add(f.name); names.add(`${f.name}.blockmap`); }
    return names;
  }

  function readLatestJson() {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(addonDir, 'latest.json'), 'utf8'));
      if (!m || !version.valid(m.version) || typeof m.file !== 'string') return null;
      return m;
    } catch { return null; }
  }

  const appUrl = (file) => (file ? `/updates/app/${encodeURIComponent(file)}` : null);
  const addonUrl = (file) => (file ? `/updates/addon/${encodeURIComponent(file)}` : null);

  // → { version, notes, publishedAt, file, url, size } or null
  function currentApp() {
    const row = q.newest.get('app');
    if (row) {
      return { version: row.version, notes: row.notes ?? null, publishedAt: row.created_at, file: row.file ?? null, url: appUrl(row.file), size: row.size ?? null };
    }
    const live = readLatestYml();
    if (!live || !version.valid(String(live.info.version || ''))) return null;
    const main = live.files.find((f) => f.name === fileNameFromUrl(live.info.path)) || live.files[0];
    if (!main) return null;
    const notes = typeof live.info.releaseNotes === 'string' ? cleanNotes(live.info.releaseNotes) : null;
    const date = typeof live.info.releaseDate === 'string' ? live.info.releaseDate : null;
    return { version: String(live.info.version), notes, publishedAt: date, file: main.name, url: appUrl(main.name), size: main.size };
  }

  // The newest published addon (not the bundled one). → { version, notes, publishedAt, sha256, size, url, source } or null
  function publishedAddon() {
    const row = q.newest.get('addon');
    if (row) {
      return { version: row.version, notes: row.notes ?? null, publishedAt: row.created_at, sha256: row.sha256 ?? null, size: row.size ?? null, url: addonUrl(row.file), source: 'published' };
    }
    const m = readLatestJson();
    if (!m) return null;
    return {
      version: m.version, notes: cleanNotes(m.notes), publishedAt: typeof m.publishedAt === 'string' ? m.publishedAt : null,
      sha256: typeof m.sha256 === 'string' ? m.sha256 : null, size: Number.isFinite(m.size) ? m.size : null, url: addonUrl(m.file), source: 'published',
    };
  }

  // ---- The addon bundled with the server ----
  // Zipped the first time someone needs it, then kept until the toc's version changes.
  let bundledCache = null; // { mtimeMs, version, pack }
  let bundledWarned = false;
  function bundledPack() {
    const dir = cfg.bundledAddonDir;
    if (!dir) return null;
    const tocFile = path.join(dir, `${ADDON}.toc`);
    let st;
    try { st = fs.statSync(tocFile); } catch { return null; }
    if (bundledCache && bundledCache.mtimeMs === st.mtimeMs) return bundledCache.pack;
    let ver;
    try { ver = toc.tocVersion(fs.readFileSync(tocFile, 'utf8')); } catch { return null; }
    if (bundledCache && bundledCache.version === ver) {
      bundledCache.mtimeMs = st.mtimeMs;
      return bundledCache.pack;
    }
    try {
      const pack = release.packAddon(dir);
      bundledCache = { mtimeMs: st.mtimeMs, version: pack.version, pack };
      return pack;
    } catch (e) {
      if (!bundledWarned) log.warn(`The bundled addon in ${dir} can't be offered: ${e.message}`);
      bundledWarned = true;
      return null;
    }
  }

  // The bundled zip for a download name, or null. Only offered while nothing was published.
  function bundledFor(name) {
    if (publishedAddon()) return null;
    const pack = bundledPack();
    return pack && pack.fileName === name ? pack : null;
  }

  function currentAddon() {
    const published = publishedAddon();
    if (published) return published;
    const pack = bundledPack();
    if (!pack) return null;
    return { version: pack.version, notes: null, publishedAt: null, sha256: pack.sha256, size: pack.size, url: addonUrl(pack.fileName), source: 'bundled' };
  }

  // What the app should update to. ctx.latest() (and so /api/meta and sync replies) use this.
  function latest() {
    return { app: currentApp(), addon: currentAddon() };
  }

  function history(limit = HISTORY_MAX) {
    return q.history.all(Math.min(Math.max(1, limit), HISTORY_MAX)).map((r) => ({
      kind: r.kind, version: r.version, notes: r.notes ?? null, publishedAt: r.publishedAt, by: r.by ?? null,
    }));
  }

  // ---- Uploads ----

  // Streams `stream` (the raw request) into a temp file in `dir` while hashing it.
  // → { tmp, size, digest }. Rejects with an HttpError (413 when over maxBytes) and leaves no
  // file behind. On overflow the rest of the request is read and thrown away, so the route
  // can still answer.
  function receive(stream, { dir, maxBytes, algorithm, encoding, declaredLength, what }) {
    const declared = declaredLength == null || declaredLength === '' ? null : Number(declaredLength);
    const tooBig = () => new HttpError(413, `That upload is too large. ${what} can be up to ${release.formatBytes(maxBytes)}.`);
    if (declared != null && Number.isFinite(declared) && declared > maxBytes) return Promise.reject(tooBig());
    try { ensureDirs(); } catch (e) { return Promise.reject(diskError(e)); }
    const tmp = path.join(dir, `.upload-${rand()}.part`);
    return new Promise((resolve, reject) => {
      const out = fs.createWriteStream(tmp, { flags: 'wx' });
      const digest = crypto.createHash(algorithm);
      let size = 0;
      let ended = false;
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        stream.removeListener('data', onData);
        stream.resume(); // drain whatever is still coming, so the reply can be sent
        out.destroy();
        const done = () => { rmQuiet(tmp).then(() => reject(diskError(err))); };
        if (out.closed) done(); else out.once('close', done);
      };
      function onData(chunk) {
        if (settled) return;
        size += chunk.length;
        if (size > maxBytes) { fail(tooBig()); return; }
        digest.update(chunk);
        if (!out.write(chunk)) {
          stream.pause();
          out.once('drain', () => { if (!settled) stream.resume(); });
        }
      }
      stream.on('data', onData);
      stream.once('end', () => {
        ended = true;
        if (settled) return;
        if (declared != null && size !== declared) { fail(new HttpError(400, 'The upload was cut off before it finished. Try again.')); return; }
        if (size === 0) { fail(new HttpError(400, 'The upload was empty.')); return; }
        out.end();
      });
      stream.once('error', () => fail(new HttpError(400, 'The upload was cut off before it finished. Try again.')));
      stream.once('close', () => { if (!ended) fail(new HttpError(400, 'The upload was cut off before it finished. Try again.')); });
      out.once('error', (e) => fail(e));
      out.once('finish', () => {
        if (settled) return;
        settled = true;
        resolve({ tmp, size, digest: digest.digest(encoding) });
      });
    });
  }

  // PUT /api/publish/app/files/:name → { name, size, sha512, unchanged }
  async function uploadAppFile(name, stream, { sha512, contentLength } = {}) {
    if (typeof name !== 'string' || name.length > 200 || name.startsWith('.') || !APP_FILE_RE.test(name)) {
      throw new HttpError(400, "That file name isn't allowed. Upload the installer (.exe) or its .blockmap under a plain file name.");
    }
    const up = await receive(stream, {
      dir: appDir, maxBytes: limits.appFile, algorithm: 'sha512', encoding: 'base64', declaredLength: contentLength, what: 'App files',
    });
    try {
      const expected = typeof sha512 === 'string' ? sha512.trim() : '';
      if (expected && expected !== up.digest) {
        throw new HttpError(400, `${name} didn't arrive intact (its checksum doesn't match). Try the upload again.`);
      }
      return await locked(async () => {
        const dest = path.join(appDir, name);
        // Never swap the bytes of a file the live release points at: players are downloading it.
        if (liveAppFiles().has(name)) {
          const st = await statQuiet(dest);
          if (st && st.isFile()) {
            if ((await sha512Of(dest, st)) !== up.digest) {
              throw new HttpError(409, `${name} belongs to the live release and can't be replaced. Publish a new version instead.`);
            }
            return { name, size: up.size, sha512: up.digest, unchanged: true };
          }
        }
        await renameRetry(up.tmp, dest);
        up.tmp = null;
        const st = await fsp.stat(dest);
        shaCache.set(name, { size: st.size, mtimeMs: st.mtimeMs, sha512: up.digest });
        return { name, size: up.size, sha512: up.digest, unchanged: false };
      });
    } catch (e) {
      throw diskError(e);
    } finally {
      if (up.tmp) await rmQuiet(up.tmp);
    }
  }

  // ---- App commit ----

  // POST /api/publish/app/commit. Checks every file latest.yml lists against what was uploaded,
  // then writes latest.yml (which makes the release live for electron-updater), records it and
  // tells the guild. → { app, pruned, forced }
  async function commitApp({ version: v, notes, latestYml, force = false, publisher = {} } = {}) {
    const ver = typeof v === 'string' ? v.trim() : '';
    if (!version.valid(ver)) throw new HttpError(400, 'Send the version being published, like 1.2.3.');
    if (typeof latestYml !== 'string' || !latestYml.trim()) throw new HttpError(400, 'Send the latest.yml that the app build made.');
    if (Buffer.byteLength(latestYml) > MAX_YML) throw new HttpError(400, 'That latest.yml is too large to be a real one.');
    let info;
    try {
      info = release.parseLatestYml(latestYml);
    } catch (e) {
      throw new HttpError(400, `That latest.yml can't be read. ${e.message}`);
    }
    const ymlVersion = info.version == null ? '' : String(info.version);
    if (ymlVersion !== ver) {
      throw new HttpError(400, `latest.yml is for version ${ymlVersion || '(none)'}, not ${ver}. Build the app again.`);
    }
    const files = listedFiles(info);
    if (!files.length) throw new HttpError(400, 'latest.yml lists no files.');
    for (const f of files) if (!f.sha512) throw new HttpError(400, `latest.yml has no checksum for ${f.name}.`);
    const cleanedNotes = cleanNotes(notes);

    return locked(async () => {
      const current = currentApp();
      const newer = !current || version.gt(ver, current.version);
      if (!newer && !force) {
        throw new HttpError(409, `Guild Camp ${current.version} is already published, and ${ver} isn't newer. Publish a higher version.`);
      }
      // Every listed file must be here, whole, before anything goes live.
      const sizes = {};
      for (const f of files) {
        const abs = path.join(appDir, f.name);
        const st = await statQuiet(abs);
        if (!st || !st.isFile()) {
          throw new HttpError(400, `${f.name} hasn't been uploaded. Upload every file latest.yml lists, then try again.`);
        }
        if (f.size != null && st.size !== f.size) {
          throw new HttpError(400, `${f.name} on the server doesn't match latest.yml (different size). Upload it again.`);
        }
        if ((await sha512Of(abs, st)) !== f.sha512) {
          throw new HttpError(400, `${f.name} on the server doesn't match latest.yml (different checksum). Upload it again.`);
        }
        sizes[f.name] = st.size;
      }
      ensureDirs();
      // electron-builder leaves releaseNotes out of latest.yml, and installed apps read the notes for
      // their Updates card from there (electron-updater's info.releaseNotes). Add the published notes
      // as a literal block scalar. cleanNotes trims, so line 1 never starts with a space and the
      // block's indentation is unambiguous. Only when the key is absent: a second one would be a
      // duplicate key, which electron-updater's YAML parser refuses.
      let yml = latestYml;
      if (cleanedNotes && !Object.prototype.hasOwnProperty.call(info, 'releaseNotes')) {
        yml = yml.replace(/\s*$/, '\n') + 'releaseNotes: |-\n' + cleanedNotes.split('\n').map((l) => (l ? '  ' + l : '')).join('\n') + '\n';
      }
      await writeAtomic(path.join(appDir, 'latest.yml'), yml);

      const main = files.find((f) => f.name === fileNameFromUrl(info.path)) || files[0];
      q.insert.run({
        kind: 'app', version: ver, notes: cleanedNotes, file: main.name, size: sizes[main.name], sha256: null, sha512: main.sha512,
        publishedBy: publisher.userId || null, createdAt: sqliteNow(),
      });
      const pruned = await pruneApp();
      await sweepTemp();
      announce(publisher, 'app', ver, cleanedNotes, !newer);
      return { app: currentApp(), pruned, forced: !newer };
    });
  }

  // Keeps the newest KEEP_APP_VERSIONS versions found on disk (by version number), and always
  // every file the live latest.yml points at. Files without a version in their name are left
  // alone. → names deleted
  async function pruneApp(keep = KEEP_APP_VERSIONS) {
    const live = readLatestYml();
    if (!live) return []; // without a readable manifest, don't guess what is safe to delete
    const protectedNames = liveAppFiles();
    let names;
    try { names = await fsp.readdir(appDir); } catch { return []; }
    const byVersion = new Map();
    for (const name of names) {
      if (name.startsWith('.') || !APP_FILE_RE.test(name)) continue;
      const v = versionFromFileName(name);
      if (!v) continue;
      if (!byVersion.has(v)) byVersion.set(v, []);
      byVersion.get(v).push(name);
    }
    const versions = [...byVersion.keys()].sort((a, b) => version.compare(b, a));
    const deleted = [];
    for (const v of versions.slice(keep)) {
      for (const name of byVersion.get(v)) {
        if (protectedNames.has(name)) continue;
        try {
          await fsp.rm(path.join(appDir, name), { force: true });
          shaCache.delete(name);
          deleted.push(name);
        } catch (e) {
          log.warn(`Couldn't delete old update file ${name}: ${e.message}`);
        }
      }
    }
    return deleted.sort();
  }

  // Deletes temp files left behind by a crash (older than an hour, so a second server sharing
  // the folder during a deploy keeps its in-flight uploads).
  async function sweepTemp(now = Date.now()) {
    for (const dir of [appDir, addonDir]) {
      let names;
      try { names = await fsp.readdir(dir); } catch { continue; }
      for (const name of names) {
        if (!TEMP_RE.test(name)) continue;
        const st = await statQuiet(path.join(dir, name));
        if (st && now - st.mtimeMs > STALE_TEMP_MS) await rmQuiet(path.join(dir, name));
      }
    }
  }

  // ---- Addon publish ----

  // PUT /api/publish/addon. The zip must hold exactly one WowGuild/ folder with WowGuild.toc.
  // → { addon, forced }
  async function publishAddon(stream, { sha256, contentLength, notes, force = false, publisher = {} } = {}) {
    const up = await receive(stream, {
      dir: addonDir, maxBytes: limits.addon, algorithm: 'sha256', encoding: 'hex', declaredLength: contentLength, what: 'Addon zips',
    });
    try {
      const expected = typeof sha256 === 'string' ? sha256.trim().toLowerCase() : '';
      if (expected && expected !== up.digest) {
        throw new HttpError(400, "The addon zip didn't arrive intact (its checksum doesn't match). Try the upload again.");
      }
      const ver = checkAddonZip(await fsp.readFile(up.tmp));
      const cleanedNotes = cleanNotes(notes);
      return await locked(async () => {
        const current = publishedAddon();
        const newer = !current || version.gt(ver, current.version);
        if (!newer && !force) {
          throw new HttpError(409, `Addon ${current.version} is already published, and ${ver} isn't newer. Bump the version, or force it to roll back.`);
        }
        const file = `${ADDON}-${ver}.zip`;
        await renameRetry(up.tmp, path.join(addonDir, file));
        up.tmp = null;
        const publishedAt = sqliteNow();
        const manifest = { version: ver, notes: cleanedNotes, sha256: up.digest, size: up.size, file, publishedAt };
        await writeAtomic(path.join(addonDir, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
        q.insert.run({
          kind: 'addon', version: ver, notes: cleanedNotes, file, size: up.size, sha256: up.digest, sha512: null,
          publishedBy: publisher.userId || null, createdAt: publishedAt,
        });
        await sweepTemp();
        announce(publisher, 'addon', ver, cleanedNotes, !newer);
        return { addon: publishedAddon(), forced: !newer };
      });
    } catch (e) {
      throw diskError(e);
    } finally {
      if (up.tmp) await rmQuiet(up.tmp);
    }
  }

  // Checks an addon zip and returns its version. Throws a 400 that says what is wrong.
  function checkAddonZip(buf) {
    let entries;
    try {
      entries = zip.readZip(buf, { maxTotalSize: MAX_ADDON_UNPACKED });
    } catch (e) {
      if (e && e.code) throw new HttpError(400, e.message);
      throw e;
    }
    let tocEntry = null;
    for (const e of entries) {
      let segs;
      try { segs = zip.safeSegments(e.name); } catch (err) { throw new HttpError(400, err.message); }
      if (!segs.length) continue; // "./" is the zip's own root
      if (segs[0] !== ADDON) {
        throw new HttpError(400, `The zip has files outside the ${ADDON} folder ("${e.name.slice(0, 120)}"). Zip the ${ADDON} folder itself.`);
      }
      if (!e.isDir && segs.length === 2 && segs[1] === `${ADDON}.toc`) tocEntry = e;
    }
    if (!tocEntry) throw new HttpError(400, `The zip has no ${ADDON_TOC}. Zip the ${ADDON} addon folder itself.`);
    const ver = toc.tocVersion(tocEntry.data.toString('utf8'));
    if (!version.valid(ver)) {
      throw new HttpError(400, `${ADDON}.toc needs a "## Version:" line with a version like 1.2.3 (found "${String(ver || 'nothing').slice(0, 40)}").`);
    }
    return ver;
  }

  // ---- Telling the guild ----

  // A desktop notification for every guild on the server (one, for now), plus an audit line.
  function announce(publisher, kind, ver, notes, forced) {
    const title = kind === 'app' ? `Guild Camp ${ver} is out` : `Guild Camp addon ${ver} is out`;
    const body = firstLine(notes)
      || (kind === 'app' ? 'Guild Camp downloads it in the background.' : 'Guild Camp updates it in your game folders.');
    const route = kind === 'app' ? '/updates' : '/addon';
    const who = publisher.via === 'token' ? ' (release token)' : '';
    for (const { id } of q.guilds.all()) {
      ctx.emit(id, 'release', { title, body, route });
      ctx.audit({ guild: { id }, user: publisher.userId ? { id: publisher.userId } : null },
        `${kind} release published`, `${ver}${forced ? ' (forced)' : ''}${who}`);
    }
  }

  // Leftovers from an earlier crash.
  try { ensureDirs(); } catch (e) { log.warn(`The updates folder ${root} can't be created: ${e.message}`); }
  sweepTemp().catch(() => {});

  return {
    appDir,
    addonDir,
    limits,
    latest,
    history,
    currentApp,
    currentAddon,
    publishedAddon,
    bundledFor,
    uploadAppFile,
    commitApp,
    publishAddon,
    pruneApp,
    sweepTemp,
  };
}

module.exports = {
  createReleases,
  // exported for tests
  versionFromFileName,
  firstLine,
  cleanNotes,
  KEEP_APP_VERSIONS,
  MAX_NOTES,
};
