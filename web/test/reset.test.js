// Fresh start: wipe game data, keep people; old SavedVariables can't bring it back.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const dbm = require('../src/db');
const { applyPayload } = require('../src/sync');
const { resetGuild } = require('../src/reset');

test('fresh start wipes game data, keeps people, and ignores stale or off-realm uploads', () => {
  const db = dbm.open(':memory:');
  const u = db.prepare("INSERT INTO users (bnet_id, battletag) VALUES ('a','J#1')").run().lastInsertRowid;
  const g = db.prepare("INSERT INTO guilds (name, invite_code) VALUES ('wow','inv')").run().lastInsertRowid;
  db.prepare("INSERT INTO memberships (user_id, guild_id, role) VALUES (?,?,'owner')").run(u, g);
  db.prepare("INSERT INTO api_tokens (user_id, guild_id, token_hash, prefix) VALUES (?,?,'h','wowg_x')").run(u, g);
  const before = Math.floor(Date.now() / 1000) - 3600;
  const retail = {
    characters: { Testy: { name: 'Testy', class: 'MAGE', level: 80, realm: 'Ragnaros', guild: 'Test Guild', updated: before,
      inventory: { bags: [{ id: 2589, name: 'Linen Cloth', count: 5 }] }, professions: { Tailoring: { rank: 300, max: 300 } }, recipes: { Tailoring: [{ name: 'Linen Belt' }] } } },
    roster: { scannedAt: before, guild: 'Test Guild', members: [{ name: 'Testy', level: 80, class: 'MAGE', online: true }] },
    guildBank: { scannedAt: before, guild: 'Test Guild', money: 100, tabs: [{ name: 'T', items: [{ id: 2589, name: 'Linen Cloth', count: 1 }] }] },
    prices: { items: [[2589, 100, 2000]] },
    ctaQueue: [{ at: before, character: 'Testy', zone: 'Orgrimmar', msg: 'test', needed: 5 }],
  };
  applyPayload(db, g, u, retail);
  db.prepare("INSERT INTO raids (guild_id, title, instance, starts_at, created_by) VALUES (?, 'Test raid', 'MC', '2026-11-10T19:00:00Z', ?)").run(g, u);
  assert.ok(db.prepare('SELECT COUNT(*) n FROM characters').get().n > 0);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-'));
  const r = resetGuild(db, g, dir);
  assert.ok(fs.existsSync(r.backup), 'backup written first');
  for (const t of ['characters', 'inventory', 'recipes', 'professions', 'raids', 'guild_bank', 'prices', 'ctas', 'activity', 'sync_log'])
    assert.strictEqual(db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n, 0, t);
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM memberships').get().n, 1);
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM api_tokens').get().n, 1);
  assert.strictEqual(db.prepare('SELECT invite_code FROM guilds').get().invite_code, 'inv');
  assert.strictEqual(db.prepare('PRAGMA foreign_key_check').all().length, 0);

  // The old Retail file uploads again: none of it comes back.
  applyPayload(db, g, u, retail);
  for (const t of ['characters', 'guild_bank', 'prices', 'ctas']) assert.strictEqual(db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n, 0, `stale ${t}`);

  // First Forever login after the wipe: accepted, and it sets the realm.
  const now = Math.floor(Date.now() / 1000) + 5;
  const today = Math.floor((Date.now() - Date.UTC(2020, 0, 1)) / 86400000);
  applyPayload(db, g, u, {
    characters: { Grom: { name: 'Grom', class: 'WARRIOR', level: 1, realm: 'Forever Realm', guild: 'wow', updated: now } },
    roster: { scannedAt: now, guild: 'wow', members: [{ name: 'Grom', level: 1, class: 'WARRIOR', online: true }] },
    prices: { items: [[2589, 120, today]] },
  });
  assert.deepStrictEqual(db.prepare('SELECT name FROM characters').all().map((c) => c.name), ['Grom']);
  assert.strictEqual(db.prepare('SELECT realm FROM guilds').get().realm, 'Forever Realm');
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM prices').get().n, 1);

  // Retail played after launch: characters, roster and prices from that upload are kept out.
  applyPayload(db, g, u, { ...retail, characters: { Testy: { ...retail.characters.Testy, updated: now } }, roster: { ...retail.roster, scannedAt: now }, prices: { items: [[999, 5, today]] } });
  assert.deepStrictEqual(db.prepare('SELECT name FROM characters').all().map((c) => c.name), ['Grom']);
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM prices WHERE item_id = 999').get().n, 0);
});
