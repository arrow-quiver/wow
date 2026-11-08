'use strict';
// Low-level sharing state in the local database (docs/SHARING.md §9, §10): the clock, my player id, the
// shared records, this computer's outbox, and who a player id or a character is in the users table.
//
// "Effective" record of an id = the bigger (S.compareRecords) of the stored record the rows show and this
// computer's provisional records (outbox entries still 'queued' or 'waiting'). Domain rows are always
// made from effective records, so a local change shows at once and a refused one disappears when the
// rows are made again.
const S = require('../../shared/sharing');
const identity = require('../identity');

const ACTIVE = ['queued', 'waiting'];
// The stored record the rows show: the 'ok' record, or for an ignored newer one the last 'ok' version (kept).
const SHOWN = "CASE WHEN state = 'ok' THEN body ELSE kept END";
const HAS_SHOWN = "(state = 'ok' OR kept IS NOT NULL)";
const KIND_OF = { r: 'raid', p: 'pvp', e: 'event' };

// ---- clock -------------------------------------------------------------------------------------
let clockMs = () => Date.now();
// Tests only: replace the computer's clock (ms). Pass nothing to restore Date.now.
function setClock(fn) { clockMs = typeof fn === 'function' ? fn : () => Date.now(); }
const localNow = () => Math.floor(clockMs() / 1000);

const get = (db, key) => identity.getSetting(db, key);
const set = (db, key, value) => identity.setSetting(db, key, value);
function getJson(db, key, fallback = null) {
  const v = get(db, key);
  if (v == null) return fallback;
  try { return JSON.parse(v); } catch { return fallback; }
}
const setJson = (db, key, value) => set(db, key, value == null ? null : JSON.stringify(value));

// Seconds to add to this computer's clock to get the game server's (saved by the addon).
function skew(db) {
  const v = Number(get(db, 'server_skew'));
  return Number.isFinite(v) && Math.abs(v) < 30 * 86400 ? Math.trunc(v) : 0;
}
const serverNow = (db) => localNow() + skew(db);
const iso = (sec) => {
  const n = Number(sec);
  return new Date((Number.isFinite(n) ? n : 0) * 1000).toISOString();
};

// ---- me ----------------------------------------------------------------------------------------
// Who I am is decided only by what this computer saw itself (§3): the characters in its own SavedVariables
// uploads (characters.user_id = me, game_guild from the upload), my Battle.net characters when signed in, and
// characters I confirmed with "It was me". A shared record never makes a character mine on its own.
// Player ids are per guild: app_settings 'me_pid:<guild id>', anchored on a character of mine in that guild.

// The guilds row (guildId null or undefined: the current guild).
function guildRow(db, guildId) {
  if (guildId == null) return identity.currentGuild(db);
  return db.prepare('SELECT * FROM guilds WHERE id = ?').get(Number(guildId)) || null;
}

// Where a characters row stands in a guild: 'in' when an upload of this computer said the character is in the
// guild's game guild (game_guild), or nothing said so and the guild's roster scan listed it (rank set); 'out' when
// an upload said it is in another game guild, or identity.GUILDLESS_AFTER uploads in a row saw it in no guild
// (no_guild), unless it is a guild bank character (is_bank); 'loose' when nothing is known (an upload with no guild:
// the character is in no guild, or the game hadn't told yet). The same rule as identity.notElsewhere in SQL.
function placeOf(row, guild) {
  if (!row || !guild) return 'out';
  if (Number(row.no_guild) >= identity.GUILDLESS_AFTER && !Number(row.is_bank)) return 'out';
  if (row.game_guild != null && row.game_guild !== '') return identity.guildKey(row.game_guild) === identity.guildKey(guild.game_guild || guild.name) ? 'in' : 'out';
  return row.rank != null || row.rank_index != null ? 'in' : 'loose';
}

// Is this characters row in the guild's game guild? strict: only 'in'; otherwise 'loose' counts too.
function inGameGuild(row, guild, { strict = false } = {}) {
  const p = placeOf(row, guild);
  return p === 'in' || (!strict && p === 'loose');
}

// My player id in the guild (default: the current one), or null.
function myPid(db, guildId) {
  const g = guildRow(db, guildId);
  if (!g) return null;
  const p = get(db, `me_pid:${g.id}`);
  if (p && S.pidOk(p)) return p;
  // Before ids were per guild there was one 'me_pid' for every guild. It stays mine in each guild its anchor is in,
  // when the anchor is mine there (share/repair.js asked once about the guilds known at the update).
  const old = legacyPid(db, g);
  const row = old ? characterRow(db, g.id, anchorOf(old)) : null;
  if (old && (row.user_id === identity.meId(db) || mayBeMine(db, g.id, row.name))) {
    set(db, `me_pid:${g.id}`, old);
    return old;
  }
  return null;
}
// The one player id from before ids were per guild, when its anchor is in this guild's game guild, else null.
function legacyPid(db, g) {
  const old = get(db, 'me_pid');
  return old && S.pidOk(old) && inGameGuild(characterRow(db, g.id, anchorOf(old)), g, { strict: true }) ? old : null;
}
function setMyPid(db, guildId, pid) {
  const g = guildRow(db, guildId);
  if (g && S.pidOk(pid)) set(db, `me_pid:${g.id}`, pid);
}

// My characters in the guild (names), from my own uploads: only characters known to be in the guild ('in'). They
// are my main, my alts in the guild's ch, the author of my records and the anchor of my player id. loose: also
// characters of mine whose guild isn't known (an upload with no guild): they are still mine (isMine), but never
// my main, my author or an anchor, and never listed as my alts. Characters of another game guild never count.
function myCharacters(db, guildId, { loose = false } = {}) {
  const g = guildRow(db, guildId);
  if (!g) return [];
  const me = identity.meId(db);
  return db.prepare(`SELECT name, game_guild, no_guild, is_bank, rank, rank_index FROM characters WHERE guild_id = ? AND user_id = ?
      ORDER BY is_main DESC, last_seen IS NULL, last_seen DESC, level DESC, name`)
    .all(g.id, me).filter((r) => inGameGuild(r, g, { strict: !loose })).map((r) => r.name);
}
// A character of this account (my uploads), in the guild or in no known guild: records it wrote are mine.
const isMine = (db, guildId, name) => Boolean(name) && myCharacters(db, guildId, { loose: true }).includes(name);
// The character my provisional records are signed with: my main, else my most recent character in the guild.
// Only when no character of mine is known to be in the guild yet, one of this account's whose guild isn't known.
function myAuthor(db, guildId) {
  const names = myCharacters(db, guildId).filter((n) => S.authorOk(n));
  if (names.length) return names[0];
  return myCharacters(db, guildId, { loose: true }).filter((n) => S.authorOk(n))[0] || null;
}

// My Battle.net characters (when signed in to Battle.net) on the guild's realm, unless Battle.net puts them
// in another guild.
function bnetNames(db, guildId) {
  const g = guildRow(db, guildId);
  if (!g) return [];
  const want = identity.guildKey(g.game_guild || g.name);
  return db.prepare('SELECT name, realm, realm_slug, guild FROM bnet_characters WHERE user_id = ?').all(identity.meId(db))
    .filter((c) => {
      const realm = c.realm || c.realm_slug;
      if (g.realm && realm && identity.realmKey(realm) !== identity.realmKey(g.realm)) return false;
      return !c.guild || identity.guildKey(c.guild) === want;
    })
    .map((c) => c.name);
}

// Characters I confirmed as mine ("It was me" on "<anchor> lists <name> as your character"), per guild.
function confirmedAlts(db, guildId) {
  const g = guildRow(db, guildId);
  const v = g ? getJson(db, `share_my_alts:${g.id}`, []) : [];
  return Array.isArray(v) ? v.filter((n) => typeof n === 'string' && n) : [];
}
function confirmAlts(db, guildId, names) {
  const g = guildRow(db, guildId);
  if (!g) return;
  const all = [...new Set([...confirmedAlts(db, g.id), ...(names || []).filter((n) => typeof n === 'string' && S.authorOk(n))])];
  setJson(db, `share_my_alts:${g.id}`, all.slice(-50));
}

// May a ch that links a character to my player id make it mine? Only one I confirmed or a Battle.net character.
function mayBeMine(db, guildId, name) {
  if (!name) return false;
  return confirmedAlts(db, guildId).includes(name) || bnetNames(db, guildId).includes(name);
}

// May this player id be mine in the guild? Its anchor must be one of my characters there (my uploads) or one
// of my Battle.net characters. A guildmate's forged ch can name any pid; one made on their character is not mine.
function pidCouldBeMine(db, guildId, pid) {
  const a = S.pidOk(pid) ? anchorOf(pid) : null;
  if (!a) return false;
  return myCharacters(db, guildId).includes(a) || bnetNames(db, guildId).includes(a);
}

// ---- author checks -----------------------------------------------------------------------------
// When this computer first shared in the guild (server seconds; 0 = not yet). Author checks look only at records
// newer than this: older ones in my name are from before this install (another install of mine, say).
const sinceOf = (db, guildId) => Number(get(db, `share_since:${guildId}`)) || 0;
function startSharing(db, guildId, now) {
  if (!sinceOf(db, guildId)) set(db, `share_since:${guildId}`, now);
}
// The last fresh start in the guild (server seconds; 0 = never).
const resetOf = (db, guildId) => Number(get(db, `share_reset:${guildId}`)) || 0;

// This computer's log of record versions that are mine for sure: sent from here (their "ok" arrived), or that I
// said were mine. It outlives the outbox history and a fresh start.
function noteSent(db, guildId, recId, v) {
  if (guildId && recId && v) db.prepare('INSERT OR IGNORE INTO share_sent (guild_id, rec_id, v) VALUES (?,?,?)').run(guildId, recId, v);
}
const wasSent = (db, guildId, recId, v) => Boolean(db.prepare('SELECT 1 FROM share_sent WHERE guild_id = ? AND rec_id = ? AND v = ?').get(guildId, recId, v));

// Records dropped from this computer's copy once the addon would have expired them (share/prune.js): id → v.
function prunedV(db, guildId, id) {
  const r = db.prepare('SELECT v FROM share_pruned WHERE guild_id = ? AND id = ?').get(guildId, id);
  return r ? r.v : null;
}
const wasPruned = (db, guildId, id) => prunedV(db, guildId, id) !== null;

// ---- records -----------------------------------------------------------------------------------
const decodeRow =(row) => (row ? Object.assign(S.decode(row.body) || {}, { str: row.body, state: row.state, row }) : null);

function storedRow(db, guildId, id) {
  return db.prepare('SELECT * FROM shared_records WHERE guild_id = ? AND id = ?').get(guildId, id) || null;
}

// The effective record of one id: { str, rec (decoded), pending, op } or null.
function effective(db, guildId, id) {
  const cands = [];
  const ok = db.prepare(`SELECT ${SHOWN} AS body FROM shared_records WHERE guild_id = ? AND id = ? AND ${HAS_SHOWN}`).get(guildId, id);
  if (ok) cands.push({ str: ok.body, pending: false, op: null });
  for (const o of db.prepare(`SELECT op, record FROM share_outbox WHERE guild_id = ? AND rec_id = ? AND state IN ('queued','waiting')
      AND record IS NOT NULL ORDER BY created_at, op`).all(guildId, id)) cands.push({ str: o.record, pending: true, op: o.op });
  let best = null;
  for (const c of cands) if (!best || S.compareRecords(c.str, best.str) > 0) best = c;
  if (!best) return null;
  const rec = S.decode(best.str);
  return rec ? { ...best, rec } : null;
}

// Effective records of every id starting with `prefix` → Map id → { str, rec, pending, op }.
function effectiveMany(db, guildId, prefix) {
  const out = new Map();
  const put = (id, str, pending, op) => {
    const cur = out.get(id);
    if (cur && S.compareRecords(str, cur.str) <= 0) return;
    const rec = S.decode(str);
    if (rec) out.set(id, { str, rec, pending, op });
  };
  for (const r of db.prepare(`SELECT id, ${SHOWN} AS body FROM shared_records WHERE guild_id = ? AND ${HAS_SHOWN} AND substr(id, 1, ?) = ?`)
    .all(guildId, prefix.length, prefix)) put(r.id, r.body, false, null);
  for (const o of db.prepare(`SELECT op, rec_id, record FROM share_outbox WHERE guild_id = ? AND state IN ('queued','waiting')
      AND record IS NOT NULL AND substr(rec_id, 1, ?) = ? ORDER BY created_at, op`).all(guildId, prefix.length, prefix)) put(o.rec_id, o.record, true, o.op);
  return out;
}

// Live (not deleted) effective record, decoded, or null.
function live(db, guildId, id) {
  const e = effective(db, guildId, id);
  return e && !e.rec.del && e.rec.fields ? e : null;
}

// lookup(id) for the codec's expiry rules: the stored record string the rows show.
const lookupFor = (db, guildId) => (id) => {
  const r = db.prepare(`SELECT ${SHOWN} AS body FROM shared_records WHERE guild_id = ? AND id = ? AND ${HAS_SHOWN}`).get(guildId, id);
  return r ? r.body : null;
};

// ---- players and characters ------------------------------------------------------------------
const anchorOf = (pid) => (typeof pid === 'string' && pid.includes('.') ? pid.slice(0, pid.lastIndexOf('.')) : null);

function ensureMembership(db, guildId, userId) {
  db.prepare("INSERT OR IGNORE INTO memberships (user_id, guild_id, role, role_source) VALUES (?,?, 'member', 'rank')").run(userId, guildId);
}

// The users row for a player id (bnet_id 'pid:<pid>'; my pid in the guild is me). create: make it when new.
// member: also make it a member of the guild (players whose records arrive; not players only named in old
// loot history).
function userForPid(db, guildId, pid, { create = true, member = true } = {}) {
  if (!pid || !S.pidOk(pid)) return null;
  if (pid === myPid(db, guildId)) return identity.meId(db);
  const row = db.prepare('SELECT id FROM users WHERE bnet_id = ?').get(`pid:${pid}`);
  if (row) {
    if (create && member && guildId) ensureMembership(db, guildId, row.id);
    return row.id;
  }
  if (!create) return null;
  const id = Number(db.prepare('INSERT INTO users (bnet_id, battletag) VALUES (?,?)').run(`pid:${pid}`, anchorOf(pid) || pid).lastInsertRowid);
  if (member && guildId) ensureMembership(db, guildId, id);
  return id;
}

// The player id of a users row: 'pid:<pid>' rows, me (my pid in the guild; default the current one), else null.
function pidOfUser(db, userId, guildId) {
  if (userId == null) return null;
  if (Number(userId) === identity.meId(db)) return myPid(db, guildId);
  const r = db.prepare('SELECT bnet_id FROM users WHERE id = ?').get(userId);
  return r && typeof r.bnet_id === 'string' && r.bnet_id.startsWith('pid:') ? r.bnet_id.slice(4) : null;
}

function characterRow(db, guildId, name, { create = false } = {}) {
  let row = db.prepare('SELECT * FROM characters WHERE guild_id = ? AND name = ?').get(guildId, name);
  if (!row && create) {
    db.prepare('INSERT INTO characters (guild_id, name) VALUES (?,?)').run(guildId, name);
    row = db.prepare('SELECT * FROM characters WHERE guild_id = ? AND name = ?').get(guildId, name);
  }
  return row || null;
}

// The users row behind a character: its linked player, else (create) a stand-in 'char:<name>' user with
// no membership, so rows that need a user (notices, calls to arms) can still show who wrote them.
function userForCharacter(db, guildId, name, { create = true } = {}) {
  if (!name) return null;
  const c = characterRow(db, guildId, name);
  if (c && c.user_id) return c.user_id;
  const row = db.prepare('SELECT id FROM users WHERE bnet_id = ?').get(`char:${name}`);
  if (row) return row.id;
  if (!create) return null;
  return Number(db.prepare('INSERT INTO users (bnet_id, battletag) VALUES (?,?)').run(`char:${name}`, String(name).slice(0, 40)).lastInsertRowid);
}

// §3: is character `name` linked to player `pid`? My pid: one of my characters. Others: the link the
// ch records made (characters.user_id).
function isLinked(db, guildId, name, pid) {
  if (!name || !pid) return false;
  if (pid === myPid(db, guildId)) return isMine(db, guildId, name);
  const uid = userForPid(db, guildId, pid, { create: false });
  if (!uid) return false;
  const c = characterRow(db, guildId, name);
  return Boolean(c && c.user_id === uid);
}

// ---- outbox ------------------------------------------------------------------------------------
function nextOp(db) {
  const n = (Number(get(db, 'share_op_seq')) || 0) + 1;
  set(db, 'share_op_seq', n);
  // A random tail keeps ids unique even if this database is ever rebuilt from scratch.
  return `o${S.toB36(n)}${S.randomKey().slice(0, 2)}`;
}

function outboxRow(db, op) {
  return db.prepare('SELECT * FROM share_outbox WHERE op = ?').get(op) || null;
}

function activeEntries(db, guildId, recId) {
  return db.prepare(`SELECT * FROM share_outbox WHERE guild_id = ? AND rec_id = ? AND state IN ('queued','waiting') ORDER BY created_at, op`)
    .all(guildId, recId);
}

// ---- partitions --------------------------------------------------------------------------------
// The addon keys each guild's data "<realm>/<guild>" (Share.lua openPartition): realm = GetRealmName() as
// the game gives it (the same text as WowGuildDB.characters[*].realm, so guilds.realm), guild = the name
// from GetGuildInfo("player"). The app keeps the exact key it last saw in the addon's data and builds the
// same rule before that. Matching an addon key to a guild ignores case, spaces and punctuation.
function defaultPartition(guild) {
  if (!guild) return null;
  return `${guild.realm || ''}/${guild.game_guild || guild.name}`;
}
function partitionOf(db, guild) {
  if (!guild) return null;
  return get(db, `share_g:${guild.id}`) || defaultPartition(guild);
}
function partitionMatches(key, guild) {
  if (typeof key !== 'string' || !guild) return false;
  const i = key.indexOf('/');
  if (i < 0) return false;
  const realm = key.slice(0, i);
  const name = key.slice(i + 1);
  if (identity.guildKey(name) !== identity.guildKey(guild.game_guild || guild.name || '')) return false;
  // An empty realm: the addon could not read it; the guild name decides.
  return !guild.realm || !realm || identity.realmKey(realm) === identity.realmKey(guild.realm);
}

module.exports = {
  ACTIVE, KIND_OF,
  setClock, localNow, serverNow, skew, iso, get, set, getJson, setJson,
  myPid, setMyPid, legacyPid, myCharacters, isMine, myAuthor, guildRow, inGameGuild, placeOf,
  bnetNames, confirmedAlts, confirmAlts, mayBeMine, pidCouldBeMine,
  sinceOf, startSharing, resetOf, noteSent, wasSent, prunedV, wasPruned,
  decodeRow, storedRow, effective, effectiveMany, live, lookupFor,
  anchorOf, ensureMembership, userForPid, pidOfUser, characterRow, userForCharacter, isLinked,
  nextOp, outboxRow, activeEntries,
  defaultPartition, partitionOf, partitionMatches,
};
