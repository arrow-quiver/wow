'use strict';
// The local database: node:sqlite (built into Electron's Node) behind a small adapter that behaves
// like better-sqlite3, so the domain code ported from the old server keeps working unchanged.
//
//   const db = open('<dataDir>/guildcamp.db');     // WAL, foreign keys on, migrations applied
//   db.prepare(sql).run(...) → { changes, lastInsertRowid }   .get(...) → row|undefined   .all(...) → rows
//   db.prepare(sql).iterate(...)   .pluck()   db.transaction(fn)(...args)   db.pragma('x = y')   db.exec(sql)
//   db.close()
//
// Differences from node:sqlite that the adapter smooths over:
//   - rows are plain objects (node:sqlite gives null-prototype objects), blobs are Buffers
//   - named parameters may be given with extra keys (ignored, as better-sqlite3 does)
//   - transaction(fn) returns a function; nested calls use SAVEPOINTs; an error rolls back and rethrows
//   - pragma('name', { simple: true }) returns the first column of the first row
//   - SQL has guild_key(name): guild names compared without case, exactly as guildKey(name) does in JS
//
// MIGRATIONS is append-only and keeps the old server's order (entries 0..13; 14+ are the local core's), so the ported domain
// code finds every table and column it expects. Each player has their own fresh database.
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const plainRow = (row) => {
  if (!row || typeof row !== 'object') return row;
  const out = {};
  for (const k of Object.keys(row)) {
    const v = row[k];
    out[k] = v instanceof Uint8Array && !Buffer.isBuffer(v) ? Buffer.from(v.buffer, v.byteOffset, v.byteLength) : v;
  }
  return out;
};

// A Buffer or typed array is a value, not a named-parameter object.
const isNamed = (v) => v !== null && typeof v === 'object' && !ArrayBuffer.isView(v) && !(v instanceof ArrayBuffer) && !Array.isArray(v);

function bindArgs(args) {
  // better-sqlite3 also accepts an array of anonymous values as the only argument.
  if (args.length === 1 && Array.isArray(args[0])) return args[0];
  return args;
}

class Statement {
  constructor(db, sql) {
    this.source = sql;
    this.stmt = db.prepare(sql);
    if (typeof this.stmt.setAllowUnknownNamedParameters === 'function') this.stmt.setAllowUnknownNamedParameters(true);
    this.plucked = false;
  }

  pluck(on = true) {
    this.plucked = Boolean(on);
    return this;
  }

  call(method, args) {
    const list = bindArgs(args);
    if (list.length && isNamed(list[0])) return this.stmt[method](list[0], ...list.slice(1));
    return this.stmt[method](...list);
  }

  shape(row) {
    if (row === undefined || row === null) return undefined;
    if (this.plucked) {
      const keys = Object.keys(row);
      return keys.length ? plainRow({ v: row[keys[0]] }).v : undefined;
    }
    return plainRow(row);
  }

  run(...args) {
    const r = this.call('run', args);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  get(...args) {
    return this.shape(this.call('get', args));
  }

  all(...args) {
    return this.call('all', args).map((row) => this.shape(row));
  }

  * iterate(...args) {
    for (const row of this.call('iterate', args)) yield this.shape(row);
  }
}

// Guild names compare without case, the same way in SQL (guild_key(x)) and in JS (guildKey(x)): Unicode lower case
// after NFC. SQLite's own lower() folds ASCII letters only, so "Ölwyn" and "ölwyn" would differ there.
const guildKey = (v) => (v == null ? '' : String(v)).normalize('NFC').toLocaleLowerCase('en');

class Database {
  constructor(file) {
    this.name = file;
    this.raw = new DatabaseSync(file);
    this.depth = 0;
    this.open = true;
    this.raw.function('guild_key', { deterministic: true }, (v) => (v == null ? null : guildKey(v)));
  }

  prepare(sql) {
    return new Statement(this.raw, sql);
  }

  exec(sql) {
    this.raw.exec(sql);
    return this;
  }

  pragma(text, { simple = false } = {}) {
    const rows = this.raw.prepare(`PRAGMA ${text}`).all().map(plainRow);
    if (!simple) return rows;
    const first = rows[0];
    return first ? first[Object.keys(first)[0]] : undefined;
  }

  get inTransaction() {
    return this.depth > 0;
  }

  // Wraps fn in a transaction. Calling the result inside another transaction uses a SAVEPOINT, so an
  // inner failure that the caller catches only undoes the inner work.
  transaction(fn) {
    const db = this;
    return function transaction(...args) {
      const nested = db.depth > 0;
      const name = `gc_sp_${db.depth}`;
      db.raw.exec(nested ? `SAVEPOINT ${name}` : 'BEGIN');
      db.depth += 1;
      let result;
      try {
        result = fn.apply(this, args);
      } catch (err) {
        db.depth -= 1;
        try {
          db.raw.exec(nested ? `ROLLBACK TO ${name}; RELEASE ${name}` : 'ROLLBACK');
        } catch { /* the original error matters more */ }
        throw err;
      }
      db.depth -= 1;
      db.raw.exec(nested ? `RELEASE ${name}` : 'COMMIT');
      return result;
    };
  }

  close() {
    if (!this.open) return;
    this.open = false;
    this.raw.close();
  }
}

function open(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  // A second Guild Camp (or a backup running) may hold the file for a moment.
  db.pragma('busy_timeout = 5000');
  if (file !== ':memory:') db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

const MIGRATIONS = [
  `CREATE TABLE guilds (
     id INTEGER PRIMARY KEY,
     name TEXT NOT NULL,
     faction TEXT,
     ruleset TEXT DEFAULT 'PvP',
     invite_code TEXT NOT NULL UNIQUE,
     discord_webhook TEXT,
     roster_scanned_at TEXT,
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE TABLE users (
     id INTEGER PRIMARY KEY,
     bnet_id TEXT NOT NULL UNIQUE,
     battletag TEXT NOT NULL,
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE TABLE memberships (
     user_id INTEGER NOT NULL REFERENCES users(id),
     guild_id INTEGER NOT NULL REFERENCES guilds(id),
     role TEXT NOT NULL CHECK (role IN ('owner','officer','member')),
     joined_at TEXT NOT NULL DEFAULT (datetime('now')),
     PRIMARY KEY (user_id, guild_id)
   );
   CREATE TABLE api_tokens (
     id INTEGER PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id),
     guild_id INTEGER NOT NULL REFERENCES guilds(id),
     token_hash TEXT NOT NULL UNIQUE,
     prefix TEXT NOT NULL,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     last_used_at TEXT
   );
   CREATE TABLE characters (
     id INTEGER PRIMARY KEY,
     guild_id INTEGER NOT NULL REFERENCES guilds(id),
     user_id INTEGER REFERENCES users(id),
     name TEXT NOT NULL,
     class TEXT, race TEXT, level INTEGER, faction TEXT,
     rank TEXT, zone TEXT, money INTEGER,
     online INTEGER NOT NULL DEFAULT 0,
     last_seen TEXT,
     is_main INTEGER NOT NULL DEFAULT 0,
     updated_at TEXT NOT NULL DEFAULT (datetime('now')),
     UNIQUE (guild_id, name)
   );
   CREATE TABLE professions (
     character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
     name TEXT NOT NULL, skill INTEGER, max_skill INTEGER,
     PRIMARY KEY (character_id, name)
   );
   CREATE TABLE recipes (
     character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
     profession TEXT NOT NULL,
     recipe_id INTEGER,
     name TEXT NOT NULL,
     PRIMARY KEY (character_id, profession, name)
   );
   CREATE INDEX recipes_name ON recipes(name);
   CREATE TABLE craft_requests (
     id INTEGER PRIMARY KEY,
     guild_id INTEGER NOT NULL REFERENCES guilds(id),
     requester_id INTEGER NOT NULL REFERENCES users(id),
     item TEXT NOT NULL,
     notes TEXT,
     status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','claimed','done','cancelled')),
     crafter_id INTEGER REFERENCES users(id),
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE TABLE buddy_posts (
     id INTEGER PRIMARY KEY,
     guild_id INTEGER NOT NULL REFERENCES guilds(id),
     user_id INTEGER NOT NULL REFERENCES users(id),
     character TEXT NOT NULL,
     level INTEGER,
     zone TEXT,
     when_text TEXT,
     note TEXT,
     active INTEGER NOT NULL DEFAULT 1,
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE TABLE ctas (
     id INTEGER PRIMARY KEY,
     guild_id INTEGER NOT NULL REFERENCES guilds(id),
     user_id INTEGER NOT NULL REFERENCES users(id),
     character TEXT,
     zone TEXT NOT NULL,
     message TEXT,
     needed INTEGER,
     source TEXT NOT NULL DEFAULT 'web',
     client_ref TEXT,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     UNIQUE (user_id, client_ref)
   );
   CREATE TABLE announcements (
     id INTEGER PRIMARY KEY,
     guild_id INTEGER NOT NULL REFERENCES guilds(id),
     user_id INTEGER NOT NULL REFERENCES users(id),
     body TEXT NOT NULL,
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE TABLE activity (
     id INTEGER PRIMARY KEY,
     guild_id INTEGER NOT NULL REFERENCES guilds(id),
     kind TEXT NOT NULL,
     text TEXT NOT NULL,
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE TABLE sync_log (
     id INTEGER PRIMARY KEY,
     guild_id INTEGER NOT NULL,
     user_id INTEGER NOT NULL,
     bytes INTEGER,
     received_at TEXT NOT NULL DEFAULT (datetime('now'))
   );`,

  // Phase 2: raids, sign-ups, soft-reserve loot with loyalty bonus, readiness
  `ALTER TABLE characters ADD COLUMN readiness TEXT;
   CREATE TABLE raids (
     id INTEGER PRIMARY KEY,
     guild_id INTEGER NOT NULL REFERENCES guilds(id),
     title TEXT NOT NULL,
     instance TEXT NOT NULL,
     starts_at TEXT NOT NULL,              -- ISO 8601 UTC
     size INTEGER,
     sr_limit INTEGER NOT NULL DEFAULT 2,
     notes TEXT,
     status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','locked','done','cancelled')),
     reminded INTEGER NOT NULL DEFAULT 0,
     created_by INTEGER REFERENCES users(id),
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE INDEX raids_guild_time ON raids(guild_id, starts_at);
   CREATE TABLE signups (
     raid_id INTEGER NOT NULL REFERENCES raids(id) ON DELETE CASCADE,
     user_id INTEGER NOT NULL REFERENCES users(id),
     character TEXT NOT NULL,
     role TEXT NOT NULL CHECK (role IN ('tank','healer','dps')),
     status TEXT NOT NULL CHECK (status IN ('yes','tentative','no','bench')),
     note TEXT,
     updated_at TEXT NOT NULL DEFAULT (datetime('now')),
     PRIMARY KEY (raid_id, user_id)
   );
   CREATE TABLE loot_items (
     id INTEGER PRIMARY KEY,
     guild_id INTEGER NOT NULL REFERENCES guilds(id),
     instance TEXT NOT NULL,
     boss TEXT,
     name TEXT NOT NULL,
     UNIQUE (guild_id, instance, name)
   );
   CREATE TABLE reserves (
     raid_id INTEGER NOT NULL REFERENCES raids(id) ON DELETE CASCADE,
     user_id INTEGER NOT NULL REFERENCES users(id),
     item_id INTEGER NOT NULL REFERENCES loot_items(id) ON DELETE CASCADE,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     PRIMARY KEY (raid_id, user_id, item_id)
   );
   -- SR+ loyalty: +10 per raid a player attends with the same item reserved and doesn't win it.
   CREATE TABLE loyalty (
     guild_id INTEGER NOT NULL REFERENCES guilds(id),
     user_id INTEGER NOT NULL REFERENCES users(id),
     item_id INTEGER NOT NULL REFERENCES loot_items(id) ON DELETE CASCADE,
     bonus INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (guild_id, user_id, item_id)
   );
   CREATE TABLE attendance (
     raid_id INTEGER NOT NULL REFERENCES raids(id) ON DELETE CASCADE,
     user_id INTEGER NOT NULL REFERENCES users(id),
     PRIMARY KEY (raid_id, user_id)
   );
   CREATE TABLE loot_log (
     id INTEGER PRIMARY KEY,
     guild_id INTEGER NOT NULL REFERENCES guilds(id),
     raid_id INTEGER REFERENCES raids(id) ON DELETE SET NULL,
     item_id INTEGER REFERENCES loot_items(id) ON DELETE SET NULL,
     item_name TEXT NOT NULL,
     user_id INTEGER REFERENCES users(id),
     character TEXT,
     kind TEXT NOT NULL CHECK (kind IN ('sr','ms','os','free')),
     roll INTEGER,
     bonus INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE TABLE loot_rolls (
     raid_id INTEGER NOT NULL REFERENCES raids(id) ON DELETE CASCADE,
     item_id INTEGER NOT NULL REFERENCES loot_items(id) ON DELETE CASCADE,
     user_id INTEGER NOT NULL REFERENCES users(id),
     roll INTEGER NOT NULL,
     bonus INTEGER NOT NULL,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     PRIMARY KEY (raid_id, item_id, user_id)
   );`,

  // Phase 3: Discord bot, price index, inventory & guild bank, supply drives, event kinds
  `ALTER TABLE guilds ADD COLUMN discord_server_id TEXT;
   ALTER TABLE guilds ADD COLUMN bank_money INTEGER;
   ALTER TABLE guilds ADD COLUMN bank_scanned_at TEXT;
   ALTER TABLE users ADD COLUMN discord_id TEXT;
   CREATE UNIQUE INDEX users_discord ON users(discord_id) WHERE discord_id IS NOT NULL;
   ALTER TABLE raids ADD COLUMN kind TEXT NOT NULL DEFAULT 'raid';
   ALTER TABLE characters ADD COLUMN is_bank INTEGER NOT NULL DEFAULT 0;
   CREATE TABLE link_codes (
     code TEXT PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id),
     guild_id INTEGER NOT NULL REFERENCES guilds(id),
     expires_at TEXT NOT NULL
   );
   CREATE TABLE item_names (
     item_id INTEGER PRIMARY KEY,
     name TEXT NOT NULL,
     updated_at TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE INDEX item_names_name ON item_names(name);
   CREATE TABLE prices (
     guild_id INTEGER NOT NULL REFERENCES guilds(id),
     item_id INTEGER NOT NULL,
     day TEXT NOT NULL,                     -- YYYY-MM-DD of the scan
     price INTEGER NOT NULL,                -- copper
     PRIMARY KEY (guild_id, item_id, day)
   );
   CREATE TABLE inventory (
     character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
     location TEXT NOT NULL CHECK (location IN ('bags','bank')),
     item_id INTEGER NOT NULL,
     count INTEGER NOT NULL,
     PRIMARY KEY (character_id, location, item_id)
   );
   CREATE TABLE guild_bank (
     guild_id INTEGER NOT NULL REFERENCES guilds(id),
     tab TEXT NOT NULL,
     item_id INTEGER NOT NULL,
     count INTEGER NOT NULL,
     PRIMARY KEY (guild_id, tab, item_id)
   );
   CREATE TABLE bank_log (
     id INTEGER PRIMARY KEY,
     guild_id INTEGER NOT NULL REFERENCES guilds(id),
     kind TEXT NOT NULL,
     who TEXT,
     item_id INTEGER,
     count INTEGER,
     amount INTEGER,
     at TEXT NOT NULL,
     dedupe TEXT NOT NULL,
     UNIQUE (guild_id, dedupe)
   );
   CREATE TABLE bank_requests (
     id INTEGER PRIMARY KEY,
     guild_id INTEGER NOT NULL REFERENCES guilds(id),
     requester_id INTEGER NOT NULL REFERENCES users(id),
     item TEXT NOT NULL,
     count INTEGER NOT NULL DEFAULT 1,
     note TEXT,
     status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','sent','declined','cancelled')),
     handled_by INTEGER REFERENCES users(id),
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE TABLE drives (
     id INTEGER PRIMARY KEY,
     guild_id INTEGER NOT NULL REFERENCES guilds(id),
     title TEXT NOT NULL,
     unit TEXT NOT NULL,
     goal INTEGER NOT NULL,
     notes TEXT,
     status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','closed')),
     created_by INTEGER REFERENCES users(id),
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE TABLE drive_contribs (
     id INTEGER PRIMARY KEY,
     drive_id INTEGER NOT NULL REFERENCES drives(id) ON DELETE CASCADE,
     user_id INTEGER NOT NULL REFERENCES users(id),
     character TEXT,
     amount INTEGER NOT NULL,
     note TEXT,
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   );`,

  // Profession helper: which reagents a player cares about, and their shopping list.
  `CREATE TABLE wanted_items (
     user_id INTEGER NOT NULL REFERENCES users(id),
     item_id INTEGER NOT NULL,
     PRIMARY KEY (user_id, item_id)
   );
   CREATE TABLE shopping_lists (
     user_id INTEGER PRIMARY KEY REFERENCES users(id),
     items TEXT NOT NULL,
     updated_at TEXT NOT NULL DEFAULT (datetime('now'))
   );`,

  // Hardening: versions and last sync per member, audit trail, extra character data (PvP, reps, currencies).
  `ALTER TABLE users ADD COLUMN addon_version TEXT;
   ALTER TABLE users ADD COLUMN companion_version TEXT;
   ALTER TABLE users ADD COLUMN last_sync_at TEXT;
   ALTER TABLE characters ADD COLUMN extras TEXT;
   CREATE TABLE audit_log (
     id INTEGER PRIMARY KEY,
     guild_id INTEGER NOT NULL REFERENCES guilds(id),
     user_id INTEGER REFERENCES users(id),
     action TEXT NOT NULL,
     detail TEXT,
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE INDEX audit_guild ON audit_log(guild_id, id);`,

  // Wowhead tooltips: which game's database the guild uses, and item ids on loot lists.
  `ALTER TABLE guilds ADD COLUMN wowhead_game TEXT NOT NULL DEFAULT 'forever';
   ALTER TABLE loot_items ADD COLUMN item_id INTEGER;`,

  // Free services: calendar feeds, web push, Discord events, Blizzard API status.
  `ALTER TABLE users ADD COLUMN calendar_token TEXT;
   CREATE UNIQUE INDEX users_calendar ON users(calendar_token) WHERE calendar_token IS NOT NULL;
   ALTER TABLE raids ADD COLUMN duration_min INTEGER NOT NULL DEFAULT 180;
   ALTER TABLE raids ADD COLUMN discord_event_id TEXT;
   CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE push_subs (
     id INTEGER PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id),
     guild_id INTEGER NOT NULL REFERENCES guilds(id),
     endpoint TEXT NOT NULL UNIQUE,
     p256dh TEXT NOT NULL,
     auth TEXT NOT NULL,
     prefs TEXT NOT NULL DEFAULT '{"cta":true,"raids":true,"notices":true,"requests":true}',
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   );`,

  // Official Blizzard game data: realm, realm status, item details, official roster.
  `ALTER TABLE guilds ADD COLUMN realm TEXT;
   ALTER TABLE guilds ADD COLUMN game_guild TEXT;
   ALTER TABLE guilds ADD COLUMN realm_status TEXT;
   ALTER TABLE guilds ADD COLUMN official_roster_at TEXT;
   ALTER TABLE guilds ADD COLUMN official_roster_note TEXT;
   ALTER TABLE characters ADD COLUMN in_official_roster INTEGER;
   CREATE TABLE item_info (
     item_id INTEGER PRIMARY KEY,
     name TEXT, quality TEXT, ilvl INTEGER, req_level INTEGER,
     item_class TEXT, item_subclass TEXT, slot TEXT,
     namespace TEXT, found INTEGER NOT NULL DEFAULT 1,
     fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
   );`,

  // Fresh start before launch: game data older than this is ignored.
  `ALTER TABLE guilds ADD COLUMN reset_at TEXT;`,

  // Coach: play style per character, AI build plans, and questions to Claude.
  `CREATE TABLE coach_chars (
     id INTEGER PRIMARY KEY,
     guild_id INTEGER NOT NULL REFERENCES guilds(id),
     user_id INTEGER NOT NULL REFERENCES users(id),
     name TEXT NOT NULL,
     class TEXT, level INTEGER, realm TEXT,
     profile TEXT, stats TEXT, quiz TEXT, talents TEXT, gear TEXT,
     plan TEXT, plan_level INTEGER, plan_at TEXT, plan_requested_at INTEGER,
     updated_at TEXT NOT NULL DEFAULT (datetime('now')),
     UNIQUE (guild_id, name)
   );
   CREATE TABLE coach_qa (
     id INTEGER PRIMARY KEY,
     guild_id INTEGER NOT NULL REFERENCES guilds(id),
     user_id INTEGER NOT NULL REFERENCES users(id),
     char_name TEXT,
     qid TEXT,
     source TEXT NOT NULL DEFAULT 'web',
     question TEXT NOT NULL,
     answer TEXT,
     sources TEXT,
     status TEXT NOT NULL DEFAULT 'pending',
     error TEXT,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     answered_at TEXT,
     UNIQUE (user_id, qid)
   );
   CREATE TABLE ai_usage (
     id INTEGER PRIMARY KEY,
     guild_id INTEGER NOT NULL,
     user_id INTEGER,
     kind TEXT NOT NULL,
     model TEXT,
     input_tokens INTEGER, output_tokens INTEGER, searches INTEGER,
     cost_usd REAL NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE INDEX ai_usage_guild ON ai_usage (guild_id, created_at);
   ALTER TABLE guilds ADD COLUMN coach_enabled INTEGER NOT NULL DEFAULT 1;
   ALTER TABLE guilds ADD COLUMN coach_budget_usd REAL NOT NULL DEFAULT 15;`,

  // ---- Guild Camp (0.11.0) ----

  // 10: Device tokens for the desktop app (one per signed-in app, replaces sync keys),
  // and each member's notification choices ({cta, raids, notices, requests, bank, coach, drives}).
  `CREATE TABLE devices (
     id INTEGER PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id),
     guild_id INTEGER REFERENCES guilds(id),
     token_hash TEXT NOT NULL UNIQUE,
     prefix TEXT NOT NULL,
     name TEXT,
     platform TEXT,
     app_version TEXT,
     addon_version TEXT,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     last_used_at TEXT
   );
   CREATE INDEX devices_user ON devices(user_id);
   ALTER TABLE users ADD COLUMN notify_prefs TEXT;`,

  // 11: Notifications the app polls for (GET /api/events). A short-lived log, pruned after
  // 14 days, so it has no foreign keys. user_id / except_user_id / officers_only / recipe
  // narrow who sees each row.
  `CREATE TABLE events (
     id INTEGER PRIMARY KEY,
     guild_id INTEGER NOT NULL,
     kind TEXT NOT NULL,
     title TEXT NOT NULL,
     body TEXT,
     route TEXT,
     user_id INTEGER,
     except_user_id INTEGER,
     officers_only INTEGER NOT NULL DEFAULT 0,
     recipe TEXT,
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE INDEX events_guild ON events(guild_id, id);`,

  // 12: Published app and addon releases (files live in UPDATES_DIR), and the app version per member.
  `CREATE TABLE releases (
     id INTEGER PRIMARY KEY,
     kind TEXT NOT NULL CHECK (kind IN ('app','addon')),
     version TEXT NOT NULL,
     notes TEXT,
     file TEXT,
     size INTEGER,
     sha256 TEXT,
     sha512 TEXT,
     published_by INTEGER REFERENCES users(id),
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE INDEX releases_kind ON releases(kind, id);
   ALTER TABLE users ADD COLUMN app_version TEXT;`,

  // 13: Joining by itself. Battle.net sign-in reads the player's WoW characters (bnet_characters);
  // a member whose character is in the guild roster joins without an invite (guilds.auto_join:
  // 'roster' | 'verified' | 'off'). In-game rank index (0 = Guild Master) from trusted roster scans
  // sets officer roles for memberships that follow ranks (role_source 'rank'; 'manual' = set by a person).
  `ALTER TABLE guilds ADD COLUMN auto_join TEXT NOT NULL DEFAULT 'roster';
   ALTER TABLE guilds ADD COLUMN officer_rank_max INTEGER DEFAULT 1;
   ALTER TABLE characters ADD COLUMN rank_index INTEGER;
   ALTER TABLE memberships ADD COLUMN role_source TEXT NOT NULL DEFAULT 'manual';
   ALTER TABLE users ADD COLUMN bnet_profile_at TEXT;
   ALTER TABLE users ADD COLUMN bnet_profile_note TEXT;
   CREATE TABLE bnet_characters (
     user_id INTEGER NOT NULL REFERENCES users(id),
     namespace TEXT NOT NULL,
     name TEXT NOT NULL,
     realm TEXT,
     realm_slug TEXT NOT NULL,
     level INTEGER,
     class TEXT,
     faction TEXT,
     guild TEXT,
     fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
     PRIMARY KEY (user_id, namespace, realm_slug, name)
   );`,

  // ---- Local core (no server) ----

  // 14: When the player last played a character in each guild (unix seconds, from the addon's
  // characters[*].updated). The current guild only changes to one played more recently, so uploads
  // from several game folders (Retail and Forever, say) don't flip it back and forth.
  `ALTER TABLE guilds ADD COLUMN last_played_at INTEGER;`,

  // 15: Sharing through the addon (docs/SHARING.md §10). Domain rows made from shared records carry the
  // record key in share_id (unique per guild), so a record coming back from the game updates the same row.
  // shared_records holds every record the addon stores ('ok', or 'ignored' with a reason; kept = the last
  // 'ok' version, which the rows keep showing). share_outbox holds the changes this computer made until the
  // game says they went out (record = the provisional record the rows show meanwhile; 'dropped' = replaced
  // or cancelled here, kept a while so a late acknowledgement is still recognised). share_author_checks:
  // changes in my name this computer didn't make (§5). Times in locked_at / reserves_at are server seconds.
  `ALTER TABLE raids ADD COLUMN share_id TEXT;
   ALTER TABLE loot_log ADD COLUMN share_id TEXT;
   ALTER TABLE craft_requests ADD COLUMN share_id TEXT;
   ALTER TABLE buddy_posts ADD COLUMN share_id TEXT;
   ALTER TABLE ctas ADD COLUMN share_id TEXT;
   ALTER TABLE announcements ADD COLUMN share_id TEXT;
   ALTER TABLE drives ADD COLUMN share_id TEXT;
   ALTER TABLE drive_contribs ADD COLUMN share_id TEXT;
   ALTER TABLE bank_requests ADD COLUMN share_id TEXT;
   CREATE UNIQUE INDEX raids_share ON raids(guild_id, share_id) WHERE share_id IS NOT NULL;
   CREATE UNIQUE INDEX loot_log_share ON loot_log(guild_id, share_id) WHERE share_id IS NOT NULL;
   CREATE UNIQUE INDEX craft_requests_share ON craft_requests(guild_id, share_id) WHERE share_id IS NOT NULL;
   CREATE UNIQUE INDEX buddy_posts_share ON buddy_posts(guild_id, share_id) WHERE share_id IS NOT NULL;
   CREATE UNIQUE INDEX ctas_share ON ctas(guild_id, share_id) WHERE share_id IS NOT NULL;
   CREATE UNIQUE INDEX announcements_share ON announcements(guild_id, share_id) WHERE share_id IS NOT NULL;
   CREATE UNIQUE INDEX drives_share ON drives(guild_id, share_id) WHERE share_id IS NOT NULL;
   CREATE UNIQUE INDEX bank_requests_share ON bank_requests(guild_id, share_id) WHERE share_id IS NOT NULL;
   CREATE INDEX drive_contribs_share ON drive_contribs(share_id) WHERE share_id IS NOT NULL;
   ALTER TABLE raids ADD COLUMN locked_at INTEGER;
   ALTER TABLE signups ADD COLUMN reserves_at INTEGER;
   ALTER TABLE loot_items ADD COLUMN item_key TEXT;
   CREATE INDEX loot_items_key ON loot_items(guild_id, item_key);
   ALTER TABLE guilds ADD COLUMN relay_rank_max INTEGER;
   CREATE TABLE shared_records (
     guild_id INTEGER NOT NULL,
     id TEXT NOT NULL,
     v TEXT NOT NULL,
     author TEXT NOT NULL,
     via TEXT,
     how TEXT,
     body TEXT NOT NULL,
     state TEXT NOT NULL DEFAULT 'ok' CHECK (state IN ('ok','ignored')),
     reason TEXT,
     kept TEXT,
     first_seen TEXT NOT NULL DEFAULT (datetime('now')),
     PRIMARY KEY (guild_id, id)
   );
   CREATE TABLE share_outbox (
     op TEXT PRIMARY KEY,
     guild_id INTEGER NOT NULL,
     rec_id TEXT NOT NULL,
     t INTEGER NOT NULL,
     base TEXT NOT NULL DEFAULT '',
     need TEXT,
     chan TEXT,
     del INTEGER NOT NULL DEFAULT 0,
     body TEXT NOT NULL DEFAULT '',
     record TEXT,
     state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','sent','waiting','refused','dropped')),
     note TEXT,
     sent_v TEXT,
     sent_author TEXT,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     sent_at TEXT
   );
   CREATE INDEX share_outbox_rec ON share_outbox(guild_id, rec_id);
   CREATE TABLE spell_names (spell_id INTEGER PRIMARY KEY, name TEXT NOT NULL);
   CREATE TABLE share_author_checks (
     id INTEGER PRIMARY KEY,
     guild_id INTEGER NOT NULL,
     rec_id TEXT NOT NULL,
     v TEXT NOT NULL,
     prev TEXT,
     via TEXT,
     summary TEXT NOT NULL,
     state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','mine','undone')),
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     UNIQUE (guild_id, rec_id, v)
   );`,

  // 16: Who I am, per guild (docs/SHARING.md §3). characters.game_guild = the in-game guild an upload of this
  // computer says the character is in (NULL = not known: a guildmate, or uploaded before this column), so only
  // characters of the guild count as mine there. share_author_checks.names = for a ch of mine that lists
  // characters this computer doesn't know, those names (JSON), so "It was me" can confirm them. The player id
  // moves from app_settings 'me_pid' to 'me_pid:<guild id>' on first use (share/store.js myPid).
  `ALTER TABLE characters ADD COLUMN game_guild TEXT;
   ALTER TABLE share_author_checks ADD COLUMN names TEXT;`,

  // 17: Author checks and pruning (docs/SHARING.md §5, §11).
  // share_sent: the record versions this computer sent (their "ok" arrived) or that I said were mine ("It was
  // me"), kept through a fresh start, so my own records coming back never ask. share_since moves from one
  // value for every guild to 'share_since:<guild id>' (when this computer first shared in that guild), copied
  // to every guild that has shared records. share_author_checks: kind ('unknown' = several records of a type
  // this version doesn't know, from one sender, in one check; 'pid' = my player id is made on a character
  // that isn't mine; 'repair' = a character an older version linked to me), n (how many records), recs (JSON
  // [[id, v], ...] of a grouped check). share_pruned: records dropped once the addon would have expired them
  // (id and last version), so the rows they made stay as history and an expired copy is never taken back.
  `CREATE TABLE share_sent (
     guild_id INTEGER NOT NULL,
     rec_id TEXT NOT NULL,
     v TEXT NOT NULL,
     at TEXT NOT NULL DEFAULT (datetime('now')),
     PRIMARY KEY (guild_id, rec_id, v)
   );
   INSERT OR IGNORE INTO share_sent (guild_id, rec_id, v)
     SELECT guild_id, rec_id, sent_v FROM share_outbox WHERE sent_v IS NOT NULL AND sent_v != '';
   INSERT OR IGNORE INTO share_sent (guild_id, rec_id, v)
     SELECT guild_id, rec_id, v FROM share_author_checks WHERE state = 'mine' AND names IS NULL;
   INSERT OR IGNORE INTO app_settings (key, value)
     SELECT 'share_since:' || g.id, s.value FROM guilds g JOIN app_settings s ON s.key = 'share_since'
     WHERE EXISTS (SELECT 1 FROM shared_records r WHERE r.guild_id = g.id);
   DELETE FROM app_settings WHERE key = 'share_since';
   ALTER TABLE share_author_checks ADD COLUMN kind TEXT;
   ALTER TABLE share_author_checks ADD COLUMN n INTEGER NOT NULL DEFAULT 1;
   ALTER TABLE share_author_checks ADD COLUMN recs TEXT;
   CREATE TABLE share_pruned (
     guild_id INTEGER NOT NULL,
     id TEXT NOT NULL,
     v TEXT NOT NULL,
     at TEXT NOT NULL DEFAULT (datetime('now')),
     PRIMARY KEY (guild_id, id)
   );`,

  // 18: characters.no_guild = how many of this computer's uploads in a row saw the character in no guild (each new
  // save of the character counts once: no_guild_at is the save time, WowGuildDB.characters[*].updated, of the last
  // save applied, with a guild or without; an older save changes nothing). Two or more: it is in no guild, so it is on
  // no guild's lists (identity.notElsewhere). An upload that sees it in a guild sets it back to 0. share_pruned.until = when a late copy of a dropped record (or of a record
  // that expires with it) can no longer be taken anyway (server seconds); after that the entry goes
  // (share/prune.js). NULL: kept.
  `ALTER TABLE characters ADD COLUMN no_guild INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE characters ADD COLUMN no_guild_at INTEGER;
   ALTER TABLE share_pruned ADD COLUMN until INTEGER;`,

  // 19: Deal hunter. My own Auctionator scans per realm ("<realm> <faction>", as Auctionator names them): each item's
  // current lowest buyout (current, on current_day) and its daily prices (ah_days: Auctionator day numbers, days since
  // 1 Jan 2020; qty = how many were listed that day, when Auctionator says). Replaced realm by realm on each upload.
  // item_info.sell_price = what a vendor pays (copper), from Blizzard's item data, for vendor flips.
  `CREATE TABLE ah_realms (realm TEXT PRIMARY KEY, newest INTEGER NOT NULL, items INTEGER NOT NULL, uploaded_at TEXT NOT NULL);
   CREATE TABLE ah_items (realm TEXT NOT NULL, item_id INTEGER NOT NULL, current INTEGER NOT NULL, current_day INTEGER NOT NULL,
     PRIMARY KEY (realm, item_id));
   CREATE TABLE ah_days (realm TEXT NOT NULL, item_id INTEGER NOT NULL, day INTEGER NOT NULL, price INTEGER NOT NULL, qty INTEGER,
     PRIMARY KEY (realm, item_id, day));
   ALTER TABLE item_info ADD COLUMN sell_price INTEGER;`,

  // 20: War alerts. pvp_deaths = my own deaths from the app's live link (the combat log): who killed me, where,
  // and whether Discord was told (at = ms). war_marks = the guild's deaths and kills in the open world with their map
  // position (x, y in thousandths), from every member's "wm" record; war_maps = the game's map names they give.
  `CREATE TABLE pvp_deaths (
     id INTEGER PRIMARY KEY,
     guild_id INTEGER REFERENCES guilds(id),
     user_id INTEGER NOT NULL REFERENCES users(id),
     character TEXT NOT NULL,
     at INTEGER NOT NULL,
     pvp INTEGER NOT NULL DEFAULT 0,
     killer TEXT, enemies TEXT, zone TEXT, zone_id INTEGER, spell TEXT, amount INTEGER,
     seconds REAL, damage_taken INTEGER, healed INTEGER,
     posted INTEGER NOT NULL DEFAULT 0,
     UNIQUE (user_id, character, at)
   );
   CREATE INDEX pvp_deaths_user ON pvp_deaths(user_id, at);
   CREATE TABLE war_marks (
     guild_id INTEGER NOT NULL REFERENCES guilds(id),
     pid TEXT NOT NULL,
     user_id INTEGER REFERENCES users(id),
     map_id INTEGER NOT NULL,
     x INTEGER NOT NULL, y INTEGER NOT NULL,
     at INTEGER NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('d','k')),
     n INTEGER,
     PRIMARY KEY (guild_id, pid, map_id, at, kind)
   );
   CREATE INDEX war_marks_at ON war_marks(guild_id, at);
   CREATE TABLE war_maps (map_id INTEGER PRIMARY KEY, name TEXT NOT NULL);`,

  // 21: Donations. Each gold or item deposit in the guild bank log (bank_log, from whoever scanned the bank), valued
  // once at the price of its day: the guild's Auctionator price index on or before that day, else what a vendor
  // pays. value NULL = no price known yet (tried again later). user_id = the player of the character `who`.
  `CREATE TABLE donations (
     id INTEGER PRIMARY KEY,
     guild_id INTEGER NOT NULL REFERENCES guilds(id),
     log_id INTEGER NOT NULL REFERENCES bank_log(id) ON DELETE CASCADE,
     who TEXT NOT NULL,
     user_id INTEGER REFERENCES users(id),
     kind TEXT NOT NULL CHECK (kind IN ('gold','item')),
     item_id INTEGER, count INTEGER,
     value INTEGER,
     priced_from TEXT CHECK (priced_from IN ('gold','auction','vendor')),
     price_day TEXT,
     at TEXT NOT NULL,
     UNIQUE (log_id)
   );
   CREATE INDEX donations_at ON donations(guild_id, at);`,

  // 22: Blizzard's auction house (services/gamedata.js auctions): the lowest buyout per unit for each item in the newest
  // snapshot of the guild's connected realm and faction. Each fetch replaces the guild's rows.
  `CREATE TABLE ah_prices (
     guild_id INTEGER NOT NULL REFERENCES guilds(id),
     item_id INTEGER NOT NULL,
     price INTEGER NOT NULL,             -- copper per unit
     quantity INTEGER NOT NULL,          -- units listed
     fetched_at TEXT NOT NULL,
     PRIMARY KEY (guild_id, item_id)
   );`,

  // 23: Seasons (services/seasons.js). Shout-outs this app posted to Discord, so each goes out once: a donation
  // (donations.shouted) or a badge (my_badges); and the months whose winners this app announced (season_posts).
  `ALTER TABLE donations ADD COLUMN shouted INTEGER NOT NULL DEFAULT 0;
   CREATE TABLE my_badges (
     guild_id INTEGER NOT NULL REFERENCES guilds(id),
     user_id INTEGER NOT NULL REFERENCES users(id),
     badge TEXT NOT NULL,
     seen_at TEXT NOT NULL DEFAULT (datetime('now')),
     PRIMARY KEY (guild_id, user_id, badge)
   );
   CREATE TABLE season_posts (
     guild_id INTEGER NOT NULL REFERENCES guilds(id),
     month TEXT NOT NULL,
     posted_at TEXT NOT NULL DEFAULT (datetime('now')),
     PRIMARY KEY (guild_id, month)
   );`,

  // 24: The guild bank store (services/store.js): items officers put up for season points, from the "ST" record.
  // An order is a bank request (bank_requests) whose note starts "[store:<key>:<cost>]".
  `CREATE TABLE store_items (
     guild_id INTEGER NOT NULL REFERENCES guilds(id),
     key TEXT NOT NULL,
     item TEXT NOT NULL,
     item_id INTEGER,
     cost INTEGER NOT NULL,
     stock INTEGER NOT NULL DEFAULT 0,
     pos INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (guild_id, key)
   );`,

  // 25: How I actually play (services/playstyle.js): each play session the app's live link followed in the combat
  // log, one row per character and start (times in ms), updated while the session runs. Only this computer has them.
  `CREATE TABLE play_sessions (
     id INTEGER PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id),
     character TEXT NOT NULL,
     started_at INTEGER NOT NULL,
     last_at INTEGER NOT NULL,
     minutes INTEGER NOT NULL DEFAULT 0,
     kills INTEGER NOT NULL DEFAULT 0, pvp_kills INTEGER NOT NULL DEFAULT 0,
     deaths INTEGER NOT NULL DEFAULT 0, pvp_deaths INTEGER NOT NULL DEFAULT 0,
     damage_done INTEGER NOT NULL DEFAULT 0, damage_taken INTEGER NOT NULL DEFAULT 0, healing_taken INTEGER NOT NULL DEFAULT 0,
     fights INTEGER NOT NULL DEFAULT 0, fight_share REAL NOT NULL DEFAULT 0,
     UNIQUE (user_id, character, started_at)
   );
   CREATE INDEX play_sessions_user ON play_sessions(user_id, last_at);`,

  // 26: Calls to arms on Discord (services/ctaDiscord.js): what this app posted, by character, zone and message,
  // so one call goes out once whichever way it arrives (the app, the chat log, or the next upload).
  `CREATE TABLE cta_discord (
     guild_id INTEGER NOT NULL REFERENCES guilds(id),
     fp TEXT NOT NULL,
     at INTEGER NOT NULL,
     PRIMARY KEY (guild_id, fp)
   );
   ALTER TABLE ctas ADD COLUMN discord_posted INTEGER NOT NULL DEFAULT 0;`,

  // 27: Guild life (services/guildlife.js). bulletin_posts: the guild bulletin board, from "bb" records.
  // seen_hours: how often each guildmate was online at each hour of the week (slot = weekday * 24 + hour, local
  // time), from roster scans, for leveling matches. digest_posts: weekly digests this app posted to Discord.
  `CREATE TABLE bulletin_posts (
     id INTEGER PRIMARY KEY,
     guild_id INTEGER NOT NULL REFERENCES guilds(id),
     user_id INTEGER NOT NULL REFERENCES users(id),
     character TEXT NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('lfg','wts','wtb','help')),
     text TEXT NOT NULL,
     price INTEGER,
     share_id TEXT,
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE UNIQUE INDEX bulletin_share ON bulletin_posts(guild_id, share_id);
   CREATE TABLE seen_hours (
     guild_id INTEGER NOT NULL REFERENCES guilds(id),
     name TEXT NOT NULL,
     slot INTEGER NOT NULL CHECK (slot BETWEEN 0 AND 167),
     n INTEGER NOT NULL DEFAULT 0,
     last_scan TEXT,
     PRIMARY KEY (guild_id, name, slot)
   );
   CREATE TABLE digest_posts (
     guild_id INTEGER NOT NULL REFERENCES guilds(id),
     week TEXT NOT NULL,
     posted_at TEXT NOT NULL DEFAULT (datetime('now')),
     PRIMARY KEY (guild_id, week)
   );`,
];

// Runs every migration the database hasn't had yet, each in its own transaction.
function migrate(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (v INTEGER NOT NULL)');
  const row = db.prepare('SELECT v FROM schema_version').get();
  let v = row ? row.v : 0;
  if (!row) db.prepare('INSERT INTO schema_version (v) VALUES (0)').run();
  while (v < MIGRATIONS.length) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      v += 1;
      db.prepare('UPDATE schema_version SET v = ?').run(v);
    })();
  }
}

module.exports = { open, migrate, MIGRATIONS, Database, guildKey };
