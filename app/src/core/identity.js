'use strict';
// Who "me" is, which guild is the current one, and roles from in-game ranks. No accounts, no invites.
//
//   - Me: one local users row (bnet_id 'local:me'). Its battletag is the Battle.net BattleTag when the
//     player signed in to Battle.net in the app, otherwise the name of their main (or most recently
//     played) character, otherwise "You".
//   - The guild: the in-game guild of the most recently played character that has one, taken from each
//     sync upload (WowGuildDB.characters[*].guild / realm / faction). It is created locally the first
//     time it is seen. One guild at a time: app_settings 'guild_id' points at the current one. Data of an
//     earlier guild stays in the database and comes back if the player returns to it.
//   - Roles come only from in-game rank indexes (0 = Guild Master) on the roster rows: rank 0 → owner,
//     rank ≤ guilds.officer_rank_max → officer, anything else (or unknown) → member. syncRanks applies
//     that to every membership of the guild (me now; guildmates once the sharing wave adds them).
//
// Exports
//   ensureMe(db) → users row          meId(db) → id
//   applyIdentity(db, identity) → users row   identity = { battletag|null, characters: [Battle.net characters] }
//   refreshMyName(db) → users row     (keeps a BattleTag; otherwise the main / most recent character name)
//   currentGuild(db) → guilds row | null
//   guildFromPayload(payload) → { name, realm, faction, updated } | null
//   selectGuild(db, { name, realm, faction, updated }) → { guild, created, switched }
//   roleFromRank(bestRankIndex, officerRankMax) → 'owner' | 'officer' | 'member'
//   syncRanks(db, guildId, { audit }) → { changed: [{ userId, battletag, from, to, rank }] }
//   myMembership(db) → { guild row + role } | null      (what req.guild is)
//   bnetSummary(db, userId) → { characters, profile_at, note }
//   guildKey(name) → the form guild names compare in (SQL: guild_key(name)), from db.js
//   notElsewhere(alias) / looseLast(alias) → SQL on a characters row (see below)
const { guildKey } = require('./db');

const ME_KEY = 'local:me';
const GUILD_KEY = 'guild_id';
const DEFAULT_NAME = 'You';

const s = (v, max) => (typeof v === 'string' || typeof v === 'number' ? String(v).trim().slice(0, max) || null : null);
const lower = (v) => String(v || '').toLocaleLowerCase('en');
// Realm names compare without case, spaces, accents or punctuation ("Mirage Raceway" = "mirage-raceway").
const realmKey = (v) => String(v || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLocaleLowerCase('en').replace(/[^\p{L}\p{N}]/gu, '');
const faction = (v) => {
  const x = lower(v && typeof v === 'object' ? v.type || v.name : v);
  return x === 'horde' ? 'Horde' : x === 'alliance' ? 'Alliance' : null;
};
const list = (v) => (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : []);

function getSetting(db, key) {
  const r = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
  return r ? r.value : null;
}

function setSetting(db, key, value) {
  if (value == null) db.prepare('DELETE FROM app_settings WHERE key = ?').run(key);
  else db.prepare('INSERT INTO app_settings (key, value) VALUES (?,?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

function ensureMe(db) {
  let me = db.prepare('SELECT * FROM users WHERE bnet_id = ?').get(ME_KEY);
  if (!me) {
    db.prepare('INSERT INTO users (bnet_id, battletag) VALUES (?,?)').run(ME_KEY, DEFAULT_NAME);
    me = db.prepare('SELECT * FROM users WHERE bnet_id = ?').get(ME_KEY);
  }
  return me;
}

const meId = (db) => ensureMe(db).id;

// How many of this computer's uploads in a row must see a character in no guild before it counts as in no guild
// (characters.no_guild). One isn't enough: the game may not have said the guild yet when it saved the character.
const GUILDLESS_AFTER = 2;

// SQL condition on a characters row (by its table name or alias): it isn't known to be in another in-game guild than
// its guild's, nor in no guild at all. An upload of this computer says which game guild each of my characters is in
// (for its rows in every guild), and every character of the upload is stored in the current guild; one of another
// guild, or one seen in no guild in GUILDLESS_AFTER uploads in a row, stays off this guild's roster, counts, crafters
// and pickers. One whose guild isn't known yet stays on them, and so does a guild bank character (is_bank: an officer
// said it is the guild's, in a guild or not). (Names compare with guild_key, as share/store.js placeOf does with
// guildKey.)
function notElsewhere(c = 'characters') {
  return `((COALESCE(${c}.no_guild, 0) < ${GUILDLESS_AFTER} OR ${c}.is_bank = 1) AND (${c}.game_guild IS NULL OR ${c}.game_guild = ''
    OR guild_key(${c}.game_guild) = (SELECT guild_key(COALESCE(gx.game_guild, gx.name)) FROM guilds gx WHERE gx.id = ${c}.guild_id)))`;
}

// SQL sort key (ascending) for picking a main: 0 for a characters row known to be in its guild (its game guild from an
// upload, or the guild's roster), 1 for one whose guild isn't known (an upload with no guild). A guildless character
// is never the main of a guild while one known to be in it exists (share/store.js placeOf, myAuthor).
function looseLast(c = 'characters') {
  return `(CASE WHEN (${c}.game_guild IS NOT NULL AND ${c}.game_guild != '') OR ${c}.rank IS NOT NULL OR ${c}.rank_index IS NOT NULL THEN 0 ELSE 1 END)`;
}

// The name of my main character in the current guild, else my most recently seen character.
function myCharacterName(db) {
  const me = ensureMe(db);
  const g = currentGuild(db);
  if (!g) return null;
  const c = db.prepare(`SELECT name FROM characters WHERE guild_id = ? AND user_id = ? AND ${notElsewhere()}
    ORDER BY ${looseLast()}, is_main DESC, last_seen IS NULL, last_seen DESC, level DESC, name LIMIT 1`).get(g.id, me.id);
  return c ? c.name : null;
}

// The BattleTag stays once known (from Battle.net); otherwise the character name; otherwise "You".
function refreshMyName(db, { battletag = null } = {}) {
  const me = ensureMe(db);
  const known = getSetting(db, 'me_battletag');
  const tag = s(battletag, 40) || known;
  const name = tag || myCharacterName(db) || DEFAULT_NAME;
  if (name !== me.battletag) db.prepare('UPDATE users SET battletag = ? WHERE id = ?').run(name, me.id);
  return { ...me, battletag: name };
}

// Applies what Battle.net says (or that the player signed out of Battle.net).
function applyIdentity(db, identity) {
  const id = identity && typeof identity === 'object' ? identity : {};
  const me = ensureMe(db);
  const tag = s(id.battletag, 40);
  const chars = list(id.characters).slice(0, 200);
  db.transaction(() => {
    setSetting(db, 'me_battletag', tag);
    if (tag || chars.length) {
      db.prepare('DELETE FROM bnet_characters WHERE user_id = ?').run(me.id);
      const ins = db.prepare(`INSERT OR REPLACE INTO bnet_characters (user_id, namespace, name, realm, realm_slug, level, class, faction, guild, fetched_at)
        VALUES (?,?,?,?,?,?,?,?,?, datetime('now'))`);
      for (const c of chars) {
        if (!c || typeof c !== 'object') continue;
        const name = s(c.name, 40);
        const slug = s(c.realm_slug, 60) || (s(c.realm, 60) ? lower(c.realm).replace(/['’]/g, '').replace(/\s+/g, '-') : null);
        if (!name || !slug) continue;
        const level = Number.isFinite(Number(c.level)) ? Math.trunc(Number(c.level)) : null;
        ins.run(me.id, s(c.namespace, 60) || 'unknown', name, s(c.realm, 60), slug, level, s(c.class, 20), faction(c.faction), s(c.guild, 60));
      }
      const note = chars.length ? `Read ${chars.length} character${chars.length === 1 ? '' : 's'} from Battle.net.` : 'Battle.net shows no World of Warcraft characters on this account yet.';
      db.prepare("UPDATE users SET bnet_profile_at = COALESCE(?, datetime('now')), bnet_profile_note = ? WHERE id = ?")
        .run(s(id.profileAt, 40), note, me.id);
    } else {
      // Signed out of Battle.net (or never signed in): nothing from it is kept.
      db.prepare('DELETE FROM bnet_characters WHERE user_id = ?').run(me.id);
      db.prepare('UPDATE users SET bnet_profile_at = NULL, bnet_profile_note = NULL WHERE id = ?').run(me.id);
    }
  })();
  return refreshMyName(db, { battletag: tag });
}

function currentGuild(db) {
  const id = Number(getSetting(db, GUILD_KEY));
  if (Number.isInteger(id) && id > 0) {
    const g = db.prepare('SELECT * FROM guilds WHERE id = ?').get(id);
    if (g) return g;
  }
  return null;
}

// The guild of the most recently played character that has one.
function guildFromPayload(payload) {
  const chars = list(payload && payload.characters)
    .filter((c) => c && typeof c === 'object' && s(c.guild, 60))
    .sort((a, b) => (Number(b.updated) || 0) - (Number(a.updated) || 0));
  if (!chars.length) return null;
  const c = chars[0];
  const updated = Number(c.updated);
  return { name: s(c.guild, 60), realm: s(c.realm, 60), faction: faction(c.faction), updated: Number.isFinite(updated) && updated > 0 ? Math.trunc(updated) : 0 };
}

// When no character carries a guild (the old addon could save a character before the game knew its guild),
// the guild named by the upload's roster scan, with the realm and faction of the most recently played character.
// Only offered to the player (routes/sync.js): it is never picked without them saying yes.
function rosterGuildFromPayload(payload) {
  const roster = payload && payload.roster;
  const name = roster && typeof roster === 'object' ? s(roster.guild, 60) : null;
  if (!name) return null;
  const chars = list(payload.characters)
    .filter((c) => c && typeof c === 'object')
    .sort((a, b) => (Number(b.updated) || 0) - (Number(a.updated) || 0));
  const c = chars[0] || {};
  const scanned = Number(roster.scannedAt);
  return { name, realm: s(c.realm, 60), faction: faction(c.faction), updated: Number.isFinite(scanned) && scanned > 0 ? Math.trunc(scanned) : 0 };
}

// Picks (and the first time, creates) the guild of an upload's most recently played guild character.
// It only replaces the current guild when that character was played more recently than any character
// in the current guild, so uploads from another game folder don't flip it back and forth.
function selectGuild(db, { name, realm = null, faction: fac = null, updated = 0 } = {}) {
  const gameName = s(name, 60);
  const before = currentGuild(db);
  if (!gameName) return { guild: before, created: false, switched: false };
  const me = ensureMe(db);
  const played = Number.isFinite(Number(updated)) && Number(updated) > 0 ? Math.trunc(Number(updated)) : 0;
  let created = false;
  const guild = db.transaction(() => {
    const candidates = db.prepare('SELECT * FROM guilds WHERE guild_key(COALESCE(game_guild, name)) = ? ORDER BY id').all(guildKey(gameName));
    let g = candidates.find((x) => !realm || !x.realm || realmKey(x.realm) === realmKey(realm)) || null;
    if (before && (!g || g.id !== before.id) && !(played > (before.last_played_at || 0))) {
      // Played less recently than the current guild: keep it (and don't create anything).
      return before;
    }
    if (!g) {
      // invite_code is a NOT NULL UNIQUE leftover from the server; locally it is just a unique tag.
      const id = Number(db.prepare('INSERT INTO guilds (name, faction, invite_code, realm, game_guild, last_played_at) VALUES (?,?,?,?,?,?)')
        .run(gameName, fac || 'Horde', `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, s(realm, 60), gameName, played || null).lastInsertRowid);
      db.prepare('INSERT INTO activity (guild_id, kind, text) VALUES (?,?,?)').run(id, 'guild', `Guild Camp set up ${gameName}`);
      g = db.prepare('SELECT * FROM guilds WHERE id = ?').get(id);
      created = true;
    } else {
      const sets = [];
      const args = [];
      if (!g.realm && realm) { sets.push('realm = ?'); args.push(s(realm, 60)); }
      if (!g.game_guild) { sets.push('game_guild = ?'); args.push(gameName); }
      if (fac && fac !== g.faction) { sets.push('faction = ?'); args.push(fac); }
      if (played > (g.last_played_at || 0)) { sets.push('last_played_at = ?'); args.push(played); }
      if (sets.length) {
        db.prepare(`UPDATE guilds SET ${sets.join(', ')} WHERE id = ?`).run(...args, g.id);
        g = db.prepare('SELECT * FROM guilds WHERE id = ?').get(g.id);
      }
    }
    db.prepare("INSERT OR IGNORE INTO memberships (user_id, guild_id, role, role_source) VALUES (?,?, 'member', 'rank')").run(me.id, g.id);
    setSetting(db, GUILD_KEY, g.id);
    return g;
  })();
  return { guild, created, switched: Boolean(before && before.id !== guild.id) };
}

function roleFromRank(best, max) {
  if (best === 0) return 'owner';
  if (best != null && max != null && best <= max) return 'officer';
  return 'member';
}

// Every membership of the guild follows the best (lowest) rank index among that player's characters.
function syncRanks(db, guildId, { audit } = {}) {
  const out = { changed: [] };
  const g = db.prepare('SELECT id, officer_rank_max FROM guilds WHERE id = ?').get(guildId);
  if (!g) return out;
  db.transaction(() => {
    const rows = db.prepare(`SELECT m.user_id, m.role, u.battletag,
        (SELECT MIN(c.rank_index) FROM characters c WHERE c.guild_id = m.guild_id AND c.user_id = m.user_id) AS best
      FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.guild_id = ?`).all(guildId);
    const set = db.prepare("UPDATE memberships SET role = ?, role_source = 'rank' WHERE user_id = ? AND guild_id = ?");
    for (const r of rows) {
      const want = roleFromRank(r.best, g.officer_rank_max);
      if (want === r.role) continue;
      set.run(want, r.user_id, guildId);
      out.changed.push({ userId: r.user_id, battletag: r.battletag, from: r.role, to: want, rank: r.best });
    }
  })();
  if (typeof audit === 'function') {
    for (const c of out.changed) audit(c.to === 'member' ? 'rank demote' : 'rank promote', `${c.battletag}: ${c.to}${c.rank == null ? '' : ` (rank ${c.rank})`}`);
  }
  return out;
}

// The current guild with my role, as req.guild.
function myMembership(db) {
  const g = currentGuild(db);
  if (!g) return null;
  const me = ensureMe(db);
  const m = db.prepare('SELECT role FROM memberships WHERE user_id = ? AND guild_id = ?').get(me.id, g.id);
  if (!m) {
    db.prepare("INSERT OR IGNORE INTO memberships (user_id, guild_id, role, role_source) VALUES (?,?, 'member', 'rank')").run(me.id, g.id);
    syncRanks(db, g.id);
    return myMembership(db);
  }
  return { ...g, role: m.role };
}

function bnetSummary(db, userId) {
  const u = db.prepare('SELECT bnet_profile_at, bnet_profile_note FROM users WHERE id = ?').get(userId) || {};
  const count = db.prepare('SELECT COUNT(*) AS n FROM bnet_characters WHERE user_id = ?').get(userId).n;
  return { characters: count, profile_at: u.bnet_profile_at ?? null, note: u.bnet_profile_note ?? null };
}

module.exports = {
  ME_KEY,
  ensureMe, meId, applyIdentity, refreshMyName, currentGuild, guildFromPayload, rosterGuildFromPayload, selectGuild,
  roleFromRank, syncRanks, myMembership, bnetSummary, getSetting, setSetting, realmKey, notElsewhere, looseLast,
  guildKey, GUILDLESS_AFTER,
};
