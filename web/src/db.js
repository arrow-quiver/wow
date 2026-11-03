// SQLite storage. Every guild-owned row carries guild_id so the app can
// become a multi-guild platform later without a data migration.
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

function open(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
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
];

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

module.exports = { open };
