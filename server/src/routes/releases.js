// Release hosting: what is published (GET /api/releases), the publish endpoints used by
// scripts/release.js, CI and the owner's Releases page, the update files themselves
// (/updates/app/*, /updates/addon/*), and two small public pages: /get and /join/:code.
// Shapes are documented in docs/api/releases.md; the logic lives in services/releases.js.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { needPublisher, bool, esc, htmlPage, sendHtml } = require('../http');
const { createReleases, versionFromFileName } = require('../services/releases');
const { formatBytes } = require('../../../app/src/shared/release');

// Download names: no folders, no leading dot (temp files) or space.
const SAFE_NAME = /^\w[\w.\- ]{0,199}$/;
const CONTENT_TYPES = {
  '.yml': 'text/yaml; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.exe': 'application/octet-stream',
  '.blockmap': 'application/octet-stream',
  '.dmg': 'application/octet-stream',
  '.appimage': 'application/octet-stream',
  '.zip': 'application/zip',
};
const MANIFESTS = new Set(['latest.yml', 'latest.json']);
// electron-updater asks for up to 1000 ranges at once for a differential download.
const MAX_RANGES = 1000;

// Same rule as POST /api/guild/join: a bare invite code.
const inviteCode = (v) => (typeof v === 'string' && /^[\w-]{1,40}$/.test(v) ? v : null);

// Headers for a file under /updates. Manifests must always be re-checked; versioned files
// never change once published, so browsers and proxies may keep them.
function fileHeaders(name) {
  const ext = path.extname(name).toLowerCase();
  const headers = { 'Content-Type': CONTENT_TYPES[ext] || 'application/octet-stream' };
  headers['Cache-Control'] = !MANIFESTS.has(name) && versionFromFileName(name)
    ? 'public, max-age=31536000, immutable'
    : 'no-cache';
  if (['.exe', '.zip', '.dmg', '.appimage'].includes(ext)) headers['Content-Disposition'] = `attachment; filename="${name}"`;
  return headers;
}

// "bytes=0-99, 200-299, -50" → [{ start, end }] (inclusive), in the order asked. null when the
// header is malformed or any range can't be served, so send()'s own handling answers instead.
function parseRanges(header, size) {
  const m = /^bytes=(.+)$/i.exec(String(header || '').trim());
  if (!m || size === 0) return null;
  const out = [];
  for (const part of m[1].split(',')) {
    const r = /^(\d*)-(\d*)$/.exec(part.trim());
    if (!r || (r[1] === '' && r[2] === '')) return null;
    let start;
    let end;
    if (r[1] === '') {
      const n = Number(r[2]);
      if (!n) return null;
      start = Math.max(0, size - n);
      end = size - 1;
    } else {
      start = Number(r[1]);
      end = r[2] === '' ? size - 1 : Math.min(Number(r[2]), size - 1);
      if (r[2] !== '' && Number(r[2]) < start) return null;
    }
    if (start >= size) return null;
    out.push({ start, end });
    if (out.length > MAX_RANGES) return null;
  }
  return out;
}

// 206 multipart/byteranges, the way electron-updater's differential download expects it: every
// part in the order asked, none merged. (send() answers a multi-range request with the whole file.)
function sendMultipart(req, res, abs, st, ranges, type, headers) {
  const boundary = crypto.randomBytes(16).toString('hex');
  const heads = ranges.map((r, i) => Buffer.from(`${i ? '\r\n' : ''}--${boundary}\r\nContent-Type: ${type}\r\nContent-Range: bytes ${r.start}-${r.end}/${st.size}\r\n\r\n`));
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const length = heads.reduce((n, h) => n + h.length, 0) + ranges.reduce((n, r) => n + (r.end - r.start + 1), 0) + tail.length;
  res.status(206);
  res.set({
    'Cache-Control': headers['Cache-Control'],
    'Accept-Ranges': 'bytes',
    'Last-Modified': st.mtime.toUTCString(),
    'Content-Type': `multipart/byteranges; boundary=${boundary}`,
    'Content-Length': String(length),
  });
  if (req.method === 'HEAD') { res.end(); return; }
  let i = 0;
  let current = null;
  res.on('close', () => { if (current) current.destroy(); });
  const next = () => {
    if (res.destroyed) return;
    if (i === ranges.length) { res.end(tail); return; }
    const r = ranges[i];
    res.write(heads[i]);
    current = fs.createReadStream(abs, { start: r.start, end: r.end });
    current.on('error', (e) => res.destroy(e));
    current.on('end', () => { i += 1; next(); });
    current.pipe(res, { end: false });
  };
  next();
}

// Serves one file from `dir`: HEAD, conditional GETs and single ranges through res.sendFile,
// several ranges through sendMultipart. `fallback(req, res, name)` → true when it answered.
async function serveFile(req, res, next, dir, name, fallback) {
  if (typeof name !== 'string' || !SAFE_NAME.test(name)) return next();
  const abs = path.join(dir, name);
  const st = await fs.promises.stat(abs).catch(() => null);
  if (!st || !st.isFile()) {
    if (fallback && fallback(req, res, name)) return undefined;
    return next();
  }
  const headers = fileHeaders(name);
  // If-Range needs validators compared; leave that (and the single-range case) to send().
  const ranges = req.headers.range && !req.headers['if-range'] ? parseRanges(req.headers.range, st.size) : null;
  if (ranges && ranges.length > 1) return sendMultipart(req, res, abs, st, ranges, headers['Content-Type'], headers);
  res.sendFile(name, { root: dir, dotfiles: 'deny', headers, cacheControl: false, lastModified: true, acceptRanges: true }, (err) => {
    if (!err || res.headersSent) return; // sent, or the player went away mid-download
    if (err.code === 'ENOENT' || err.status === 404) return next();
    next(err);
  });
  return undefined;
}

// "2026-11-07 18:02:11" (UTC) or ISO → "7 Nov 2026"
function shortDate(t) {
  if (!t) return null;
  const s = String(t);
  const d = new Date(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(s) ? `${s.replace(' ', 'T')}Z` : s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

// Styles for /get and /join on top of http.js htmlPage. Colours come from htmlPage's variables.
const PAGE_STYLE = `<style>
  .lede { margin: 0 0 6px; color: var(--muted); }
  .btn { display: inline-block; margin: 18px 0 8px; padding: 14px 28px; border-radius: 8px; background: var(--gold);
    color: var(--frame); font-weight: 700; font-size: 18px; text-decoration: none; letter-spacing: .2px;
    box-shadow: 0 6px 18px rgba(0,0,0,.35); }
  .btn:hover, .btn:focus-visible { filter: brightness(1.08); }
  .meta { color: var(--muted); font-size: 14px; margin: 0; }
  .steps { text-align: left; margin: 22px 0 6px; padding: 0 0 0 22px; }
  .steps li { margin: 6px 0; }
  .note { text-align: left; margin: 18px 0 0; padding: 10px 12px; border: 1px solid var(--line); border-left: 3px solid var(--blue);
    border-radius: 6px; color: var(--muted); font-size: 14px; }
  .note strong { color: var(--cream); font-weight: 600; }
  .code { display: block; margin: 10px auto 4px; padding: 12px 16px; border: 1px dashed var(--line); border-radius: 8px;
    background: var(--frame); color: var(--cream); font: 600 28px/1.2 Consolas, "Cascadia Mono", "Courier New", monospace;
    letter-spacing: 2px; word-break: break-all; user-select: all; }
  .divider { margin: 22px 0 0; padding-top: 16px; border-top: 1px solid var(--line); }
  .mark.icon { font-size: 0; }
  .mark.icon::before { font-size: 28px; content: var(--icon); }
</style>`;

// htmlPage draws a check mark; these pages swap it for their own symbol.
const withIcon = (html, icon) => html.replace('<div class="mark">', `<div class="mark icon" style="--icon: '${icon}'">`);

function register(app, ctx) {
  const svc = createReleases(ctx);
  ctx.services.releases = svc;
  const q = {
    firstGuild: ctx.db.prepare('SELECT name FROM guilds ORDER BY id LIMIT 1'),
    byInvite: ctx.db.prepare('SELECT id, name, faction FROM guilds WHERE invite_code = ?'),
    members: ctx.db.prepare('SELECT COUNT(*) AS n FROM memberships WHERE guild_id = ?'),
  };

  // ---- What is published (public) ----
  app.get('/api/releases', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.json({ ...svc.latest(), history: svc.history() });
  });

  // ---- Publishing (owner device token or PUBLISH_TOKEN) ----
  // Uploads are raw bodies: app.js skips JSON parsing for PUT /api/publish/*. When an upload is
  // refused before its body was read (401, 413, ...), Node reads and drops the rest after the
  // reply, so the client still gets the JSON error. (Closing the connection instead makes
  // fetch report a reset rather than the reason.)
  app.put('/api/publish/app/files/:name', needPublisher, async (req, res) => {
    const out = await svc.uploadAppFile(req.params.name, req, {
      sha512: req.get('X-Sha512'), contentLength: req.get('Content-Length'),
    });
    res.json({ ok: true, ...out });
  });

  app.post('/api/publish/app/commit', needPublisher, async (req, res) => {
    const b = req.body || {};
    const out = await svc.commitApp({
      version: b.version, notes: b.notes, latestYml: b.latestYml, force: bool(b.force), publisher: req.publisher,
    });
    res.json({ ok: true, ...out });
  });

  app.put('/api/publish/addon', needPublisher, async (req, res) => {
    const out = await svc.publishAddon(req, {
      sha256: req.get('X-Sha256'),
      contentLength: req.get('Content-Length'),
      notes: req.query.notes,
      force: bool(Array.isArray(req.query.force) ? req.query.force[0] : req.query.force),
      publisher: req.publisher,
    });
    res.json({ ok: true, ...out });
  });

  // ---- Update files (public; electron-updater and the app's addon manager read these) ----
  app.get('/updates/app/:name', (req, res, next) => serveFile(req, res, next, svc.appDir, req.params.name));

  // Until an addon is published, the bundled one answers at its own versioned name.
  const bundled = (req, res, name) => {
    const pack = svc.bundledFor(name);
    if (!pack) return false;
    res.set({
      'Content-Type': 'application/zip',
      'Cache-Control': 'public, max-age=3600',
      'Content-Disposition': `attachment; filename="${pack.fileName}"`,
      ETag: `"${pack.sha256}"`,
    });
    res.send(pack.zip); // handles HEAD and If-None-Match
    return true;
  };
  app.get('/updates/addon/:name', (req, res, next) => serveFile(req, res, next, svc.addonDir, req.params.name, bundled));

  // ---- /get: the download page linked from Discord and the invite page ----
  app.get('/get', (req, res) => {
    const guild = q.firstGuild.get();
    const latest = svc.currentApp();
    const forWho = guild ? `The desktop app for <strong>${esc(guild.name)}</strong>.` : 'The desktop app for your guild.';
    let download;
    if (latest && latest.url) {
      const bits = [`Version ${esc(latest.version)}`];
      const date = shortDate(latest.publishedAt);
      if (date) bits.push(esc(date));
      if (latest.size) bits.push(esc(formatBytes(latest.size)));
      download = `<a class="btn" href="${esc(latest.url)}">Download for Windows</a>
        <p class="meta">${bits.join(' &middot; ')}</p>`;
    } else {
      download = `<p class="note">No Windows installer has been published on this server yet.
        Check back soon, or ask the guild owner.</p>`;
    }
    const body = `${PAGE_STYLE}
      <p class="lede">${forWho} Raids, the guild bank, crafting and your addon, all in one place.</p>
      ${download}
      <ol class="steps">
        <li>Run the installer. Guild Camp opens when it's done.</li>
        <li>Sign in with Battle.net.</li>
        <li>Guild Camp finds World of Warcraft and installs the addon for you, then keeps it up to date.</li>
      </ol>
      <p class="note"><strong>Windows may warn you the first time</strong>, because the app isn't code-signed yet.
        Choose <strong>More info</strong>, then <strong>Run anyway</strong>.</p>`;
    sendHtml(res, 200, withIcon(htmlPage({ title: 'Get Guild Camp', heading: 'Get Guild Camp', body }), '\\2193'));
  });

  // ---- /join/:code: invite links open the app, or explain how to get it ----
  app.get('/join/:code', (req, res) => {
    const code = inviteCode(req.params.code);
    const guild = code ? q.byInvite.get(code) : null;
    if (!guild) {
      const body = `<p>Ask an officer for a fresh invite link.</p>
        <p class="muted">New to Guild Camp? <a href="/get">Get the app</a>.</p>`;
      return sendHtml(res, 404, htmlPage({ title: 'Invite not found', heading: "That invite link doesn't work", body, tone: 'error' }));
    }
    const members = q.members.get(guild.id).n;
    const facts = [esc(guild.faction), `${members} ${members === 1 ? 'member' : 'members'}`].filter(Boolean).join(' &middot; ');
    const link = `guildcamp://join/${encodeURIComponent(code)}`;
    const body = `${PAGE_STYLE}
      <p class="meta">${facts}</p>
      <a class="btn" href="${esc(link)}">Open in Guild Camp</a>
      <p class="meta">This opens the app and asks you to join.</p>
      <div class="divider">
        <p>Don't have the app yet? <a href="/get">Download it</a>, sign in, then paste this invite code:</p>
        <span class="code">${esc(code)}</span>
      </div>`;
    sendHtml(res, 200, withIcon(htmlPage({ title: `Join ${guild.name}`, heading: `Join ${guild.name}`, body }), '\\2691'));
  });
}

module.exports = { register, parseRanges, fileHeaders };
