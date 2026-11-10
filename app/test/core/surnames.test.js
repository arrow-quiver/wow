'use strict';
// Surnames (WoW Forever shows "Gorm Tshabalala" for Gorm): migration 32 merges the roster's copies into the real
// characters; roster uploads and bank log lines use the first word from then on.
const test = require('node:test');
const assert = require('node:assert');
const { baseName } = require('../../src/shared/names');

test('baseName: the first word, without a realm', () => {
  assert.strictEqual(baseName('Gorm Tshabalala'), 'Gorm');
  assert.strictEqual(baseName('Gorm-CAMWOW EU5'), 'Gorm');
  assert.strictEqual(baseName('  Janna Örn '), 'Janna');
  assert.strictEqual(baseName('Thrall'), 'Thrall');
  assert.strictEqual(baseName(null), null);
});

test('migration 32: the copy with a surname merges into the real character; a lone one is renamed', () => {
  const { Database, MIGRATIONS, migrate } = require('../../src/core/db');
  const db = new Database(':memory:');
  db.exec('CREATE TABLE schema_version (v INTEGER NOT NULL); INSERT INTO schema_version (v) VALUES (31);');
  for (let i = 0; i < 31; i++) db.exec(MIGRATIONS[i]);
  const gid = Number(db.prepare("INSERT INTO guilds (name, faction, invite_code) VALUES ('wow', 'Horde', 'x')").run().lastInsertRowid);
  const uid = Number(db.prepare("INSERT INTO users (bnet_id, battletag) VALUES ('1', 'J#1')").run().lastInsertRowid);
  const ch = db.prepare('INSERT INTO characters (guild_id, user_id, name, level, rank, online, first_seen) VALUES (?,?,?,?,?,?,?)');
  ch.run(gid, uid, 'Gorm', 20, null, 0, '2026-11-10 10:00:00');
  ch.run(gid, null, 'Gorm Tshabalala', 21, 'Officer', 1, '2026-11-09 10:00:00');
  ch.run(gid, null, 'Pig House', 14, 'Member', 0, '2026-11-09 10:00:00');
  db.prepare("INSERT INTO bank_log (guild_id, kind, who, amount, at, dedupe) VALUES (?, 'deposit', 'Gorm Tshabalala', 100, '2026-11-10', 'd1')").run(gid);
  migrate(db);
  const rows = db.prepare('SELECT name, user_id, level, rank, online, first_seen FROM characters ORDER BY name').all();
  assert.deepStrictEqual(rows.map((r) => r.name), ['Gorm', 'Pig']);
  const gorm = rows[0];
  assert.strictEqual(gorm.user_id, uid);
  assert.strictEqual(gorm.level, 21);
  assert.strictEqual(gorm.rank, 'Officer');
  assert.strictEqual(gorm.online, 1);
  assert.strictEqual(gorm.first_seen, '2026-11-09 10:00:00');
  assert.strictEqual(db.prepare('SELECT who FROM bank_log').get().who, 'Gorm');
  db.close();
});

test('roster uploads and bank log lines use the first word', async (t) => {
  const { setupShare } = require('./sharing-helpers');
  const h = await setupShare(t);
  const sync = require('../../src/core/services/sync');
  const { recordBankLog } = require('../../src/core/services/economy');
  sync.applyPayload(h.db, h.gid, h.me, { characters: [], roster: { scannedAt: Math.floor(Date.now() / 1000), members: [{ name: 'Erin Neri', level: 18, online: true }] } }, { trustedRanks: false });
  assert.ok(h.row("SELECT 1 AS x FROM characters WHERE name = 'Erin'"));
  assert.strictEqual(h.row("SELECT COUNT(*) AS n FROM characters WHERE name = 'Erin Neri'").n, 0);
  recordBankLog(h.db, h.gid, [{ at: 1794000000, kind: 'deposit', who: 'Erin Neri', amount: 500 }]);
  assert.strictEqual(h.row("SELECT who FROM bank_log WHERE amount = 500").who, 'Erin');
});
