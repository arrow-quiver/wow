// HTTP helpers shared by every route file: errors, input validators, auth guards,
// JSON shapes for common rows, and the small HTML pages the server still serves.
const { safeEqual } = require('./auth');

// Throw this from any handler; app.js turns it into `status` + { error: message }.
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

// ---- Input validators ----
// They never throw: they return a clean value or null, and the route decides what null means.

// Trimmed string capped at `max` characters. null/undefined, objects, arrays and empty strings → null.
function str(v, max = 80) {
  if (v == null || typeof v === 'object' || typeof v === 'function') return null;
  const s = String(v).trim().slice(0, max);
  return s || null;
}

// Whole number (truncated), clamped to [min, max] when given. Not a finite number → null.
// '' / null / booleans → null (Number('') would be 0, which is never what a form meant).
function int(v, min = -Infinity, max = Infinity) {
  if (v == null || v === '' || typeof v === 'boolean' || typeof v === 'object') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

// Like int() but keeps decimals (money in USD, percentages).
function num(v, min = -Infinity, max = Infinity) {
  if (v == null || v === '' || typeof v === 'boolean' || typeof v === 'object') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}

// true for true / 1 / '1' / 'true' / 'yes' / 'on'; false for everything else.
function bool(v) {
  if (typeof v === 'string') return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
  return v === true || v === 1;
}

// `v` when it is one of `options`, otherwise `fallback`.
function oneOf(v, options, fallback = null) {
  return options.includes(v) ? v : fallback;
}

// An array from an array or a Lua-style table object ({1: a, 2: b}), capped at `max` items.
function list(v, max = 1000) {
  const out = Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : [];
  return out.length > max ? out.slice(0, max) : out;
}

// A version string as clients report it ("0.11.0", "0.12.0-beta.1"), or null.
function ver(v) {
  return typeof v === 'string' && /^[\w.+-]{1,20}$/.test(v) ? v : null;
}

// Parses a JSON text column; returns `fallback` when empty or broken.
function parseJson(text, fallback = null) {
  if (text == null || text === '') return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}

// ---- Roles ----
const isOfficer = (req) => Boolean(req.guild && (req.guild.role === 'owner' || req.guild.role === 'officer'));
const isOwner = (req) => Boolean(req.guild && req.guild.role === 'owner');

// ---- Guards (Express middleware) ----
// req.authError is set by the bearer middleware in app.js when a token was sent but not accepted.
function signInMessage(req) {
  if (req.authError === 'revoked') return 'This device was signed out. Sign in again in Guild Camp.';
  if (req.authError === 'legacy') return 'That sync key no longer works. Install the Guild Camp app and sign in with Battle.net.';
  return 'Sign in first.';
}

function needUser(req, res, next) {
  if (!req.user) return next(new HttpError(401, signInMessage(req)));
  next();
}

function needGuild(req, res, next) {
  if (!req.user) return next(new HttpError(401, signInMessage(req)));
  if (!req.guild) return next(new HttpError(403, 'Join a guild first.'));
  next();
}

function needOfficer(req, res, next) {
  if (!req.user) return next(new HttpError(401, signInMessage(req)));
  if (!isOfficer(req)) return next(new HttpError(403, 'Officers only.'));
  next();
}

function needOwner(req, res, next) {
  if (!req.user) return next(new HttpError(401, signInMessage(req)));
  if (!isOwner(req)) return next(new HttpError(403, 'Only the guild owner can do that.'));
  next();
}

// Release publishing: the guild owner's device token, or `Authorization: Bearer <PUBLISH_TOKEN>`
// (release script / CI). Sets req.publisher = { userId: id|null, via: 'owner'|'token' }.
function needPublisher(req, res, next) {
  const cfg = req.app.locals.ctx.cfg;
  if (req.device && isOwner(req)) {
    req.publisher = { userId: req.user.id, via: 'owner' };
    return next();
  }
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
  if (m && cfg.publishToken && safeEqual(m[1], cfg.publishToken)) {
    req.publisher = { userId: null, via: 'token' };
    return next();
  }
  if (!req.user && (!m || req.authError)) return next(new HttpError(401, signInMessage(req)));
  next(new HttpError(403, 'Only the guild owner or the release token can publish updates.'));
}

// ---- JSON shapes ----
// Convention for the whole API: database rows keep their column names (snake_case) and stored
// values; fields the server computes (inviteUrl, notifyPrefs, latestId, …) are camelCase.

// A guild row for JSON. invite_code/inviteUrl only for members; discord_webhook only for officers.
function guildJson(row, { role = null, baseUrl = '', member = true } = {}) {
  if (!row) return null;
  const officer = role === 'owner' || role === 'officer';
  const out = {
    id: row.id,
    name: row.name,
    faction: row.faction,
    ruleset: row.ruleset,
    wowhead_game: row.wowhead_game,
    realm: row.realm ?? null,
    game_guild: row.game_guild ?? null,
    realm_status: parseJson(row.realm_status, null),
    official_roster_at: row.official_roster_at ?? null,
    official_roster_note: row.official_roster_note ?? null,
    roster_scanned_at: row.roster_scanned_at ?? null,
    bank_money: row.bank_money ?? null,
    bank_scanned_at: row.bank_scanned_at ?? null,
    discord_server_id: row.discord_server_id ?? null,
    coach_enabled: row.coach_enabled ?? 1,
    coach_budget_usd: row.coach_budget_usd ?? 15,
    reset_at: row.reset_at ?? null,
    created_at: row.created_at,
    role,
  };
  if (member) {
    out.invite_code = row.invite_code;
    out.inviteUrl = `${baseUrl}/join/${encodeURIComponent(row.invite_code)}`;
  }
  if (officer) out.discord_webhook = row.discord_webhook || null;
  return out;
}

// A user row for JSON. Never includes bnet_id, calendar_token or notify_prefs.
function userJson(row) {
  if (!row) return null;
  return {
    id: row.id,
    battletag: row.battletag,
    name: String(row.battletag || '').split('#')[0],
    discord_linked: Boolean(row.discord_id),
    addon_version: row.addon_version ?? null,
    app_version: row.app_version ?? null,
    last_sync_at: row.last_sync_at ?? null,
    created_at: row.created_at,
  };
}

// A device row for JSON (never the token hash). `current` marks the device making the request.
function deviceJson(row, currentId = null) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    platform: row.platform,
    prefix: row.prefix,
    app_version: row.app_version ?? null,
    addon_version: row.addon_version ?? null,
    created_at: row.created_at,
    last_used_at: row.last_used_at ?? null,
    current: row.id === currentId,
  };
}

// ---- Small HTML pages (Battle.net sign-in result, /get, /join/:code) ----
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// CSP for these pages: inline styles only. No scripts, no outside requests.
const HTML_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

// A self-contained page in the WoW: Forever colours. `body` is trusted HTML (escape your own values).
function htmlPage({ title, heading, body = '', tone = 'ok' }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer"><title>${esc(title)} · Guild Camp</title>
<style>
  :root { --frame: #18222e; --panel: #1f2c3b; --line: #2e3f52; --blue: #1a5d8f; --gold: #eaa93a; --cream: #f3e6c8; --muted: #b9ad94; --bad: #e0705a; }
  * { box-sizing: border-box; }
  html, body { margin: 0; min-height: 100%; }
  body { background: radial-gradient(ellipse at top, #22364d 0%, var(--frame) 60%); color: var(--cream);
    font: 17px/1.55 "Alegreya Sans", "Segoe UI", system-ui, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 24px; }
  main { width: 100%; max-width: 460px; background: var(--panel); border: 1px solid var(--line); border-top: 3px solid ${tone === 'error' ? 'var(--bad)' : 'var(--gold)'};
    border-radius: 10px; padding: 32px 28px; box-shadow: 0 12px 40px rgba(0,0,0,.45); text-align: center; }
  .mark { width: 54px; height: 54px; margin: 0 auto 14px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
    background: ${tone === 'error' ? 'rgba(224,112,90,.15)' : 'rgba(234,169,58,.15)'}; color: ${tone === 'error' ? 'var(--bad)' : 'var(--gold)'}; font-size: 28px; font-weight: 700; }
  h1 { font-family: Alegreya, Georgia, "Times New Roman", serif; color: var(--gold); font-size: 26px; margin: 0 0 10px; letter-spacing: .3px; }
  p { margin: 8px 0; color: var(--cream); }
  .muted { color: var(--muted); font-size: 15px; }
  a { color: var(--gold); }
  .brand { margin-top: 22px; font-family: Alegreya, Georgia, serif; color: var(--muted); font-size: 14px; letter-spacing: 1.5px; text-transform: uppercase; }
</style></head>
<body><main>
  <div class="mark">${tone === 'error' ? '!' : '&#10003;'}</div>
  <h1>${esc(heading || title)}</h1>
  ${body}
  <div class="brand">Guild Camp</div>
</main></body></html>`;
}

// Sends an HTML page with the HTML CSP and no caching.
function sendHtml(res, status, html) {
  res.status(status);
  res.setHeader('Content-Security-Policy', HTML_CSP);
  res.setHeader('Cache-Control', 'no-store');
  res.type('html').send(html);
}

// An error page for browser-facing routes (sign-in window).
function sendHtmlError(res, status, message) {
  sendHtml(res, status, htmlPage({ title: 'Something went wrong', heading: 'Something went wrong', tone: 'error',
    body: `<p>${esc(message)}</p><p class="muted">Close this window and try again from Guild Camp.</p>` }));
}

module.exports = {
  HttpError,
  str, int, num, bool, oneOf, list, ver, parseJson,
  isOfficer, isOwner,
  needUser, needGuild, needOfficer, needOwner, needPublisher,
  guildJson, userJson, deviceJson,
  esc, htmlPage, sendHtml, sendHtmlError, HTML_CSP,
};
