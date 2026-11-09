'use strict';
// HTTP helpers shared by every route file: errors, input validators, guards and JSON shapes.
//
// The local core answers only the app's own main process, and every request is the player on this
// computer ("me", see identity.js). req.user is always set; req.guild is the current guild (row plus
// `role`, from in-game ranks) or null until the first sync has seen the player's guild.

// Throw this from any handler; app.js turns it into `status` + { error: message } (+ code).
class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    if (code) this.code = code;
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

// ---- Roles (from in-game guild ranks, see identity.js) ----
const isOfficer = (req) => Boolean(req.guild && (req.guild.role === 'owner' || req.guild.role === 'officer'));
const isOwner = (req) => Boolean(req.guild && req.guild.role === 'owner');

// ---- Guards (Express middleware) ----
const NO_GUILD = 'Guild Camp hasn\'t seen your guild yet. Log in to World of Warcraft with the Guild Camp addon on a character in your guild, then log out or type /reload.';

// Every request is the player on this computer, so this only guards against a broken setup.
function needUser(req, res, next) {
  if (!req.user) return next(new HttpError(500, 'Guild Camp could not load your profile. Restart Guild Camp.'));
  next();
}

function needGuild(req, res, next) {
  if (!req.user) return next(new HttpError(500, 'Guild Camp could not load your profile. Restart Guild Camp.'));
  if (!req.guild) return next(new HttpError(403, NO_GUILD, 'NO_GUILD'));
  next();
}

function needOfficer(req, res, next) {
  needGuild(req, res, (err) => {
    if (err) return next(err);
    if (!isOfficer(req)) return next(new HttpError(403, 'Only officers can do that. Your rank in the in-game guild decides who is an officer.'));
    next();
  });
}

function needOwner(req, res, next) {
  needGuild(req, res, (err) => {
    if (err) return next(err);
    if (!isOwner(req)) return next(new HttpError(403, 'Only the Guild Master can do that.'));
    next();
  });
}

// ---- JSON shapes ----
// Convention for the whole API: database rows keep their column names (snake_case) and stored
// values; fields the core computes (notifyPrefs, latestId, …) are camelCase.

// A guild row for JSON. discord_webhook (the local setting) only for officers.
function guildJson(row, { role = null, discordWebhook = null } = {}) {
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
    coach_enabled: row.coach_enabled ?? 1,
    coach_budget_usd: row.coach_budget_usd ?? 15,
    officer_rank_max: row.officer_rank_max ?? null,
    relay_rank_max: row.relay_rank_max ?? null,
    reset_at: row.reset_at ?? null,
    created_at: row.created_at,
    role,
  };
  if (officer) out.discord_webhook = discordWebhook || null;
  return out;
}

// A user row for JSON. Never includes bnet_id, calendar_token or notify_prefs.
function userJson(row) {
  if (!row) return null;
  return {
    id: row.id,
    battletag: row.battletag,
    name: String(row.battletag || '').split('#')[0],
    addon_version: row.addon_version ?? null,
    app_version: row.app_version ?? null,
    last_sync_at: row.last_sync_at ?? null,
    created_at: row.created_at,
  };
}

module.exports = {
  HttpError,
  str, int, num, bool, oneOf, list, ver, parseJson,
  isOfficer, isOwner,
  needUser, needGuild, needOfficer, needOwner,
  guildJson, userJson,
  NO_GUILD,
};
