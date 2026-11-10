'use strict';
// Officer tools: what this computer knows about members' syncs and versions, the audit log, local
// backups, fresh start, Blizzard and game data with the built-in Battle.net app, AI usage, background
// jobs, and the calendar export. The services themselves are unit-tested in services.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startCore, seedGuild, addPlayer, asRole, tmpDir } = require('./helpers');
const { shareKit } = require('./share-kit');
const S = require('../../src/shared/sharing');
const sharing = require('../../src/core/sharing');
const blizzard = require('../../src/core/services/blizzard');
const { applyPayload } = require('../../src/core/services/sync');

// A stand-in for Blizzard's API. `state.realmUp` can be flipped.
function fakeBlizzard(state = { realmUp: true, ns: 'forever', fail: false }) {
  const calls = [];
  const json = (o) => ({ ok: true, status: 200, json: async () => o });
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (state.fail) throw new Error('getaddrinfo ENOTFOUND oauth.battle.net');
    if (String(url).includes('oauth.battle.net')) return json({ access_token: 't' });
    const u = new URL(url);
    const ns = u.searchParams.get('namespace') || '';
    const p = u.pathname;
    if (p === '/data/wow/token/index') return json({ price: 2500000000 });
    if (p === '/data/wow/item-class/index') return ns.includes(state.ns) ? json({}) : { ok: false, status: 404 };
    if (!ns.includes(state.ns)) return { ok: false, status: 404 };
    if (p === '/data/wow/realm/index') return json({ realms: [{ name: 'Living Flame', slug: 'living-flame' }, { name: "Zul'jin", slug: 'zuljin' }] });
    if (p === '/data/wow/realm/zuljin') return json({ connected_realm: { href: `https://eu.api.blizzard.com/data/wow/connected-realm/42?namespace=${ns}` } });
    if (p === '/data/wow/connected-realm/42') return json({ status: { type: state.realmUp ? 'UP' : 'DOWN' }, has_queue: state.realmUp, population: { name: 'Full' } });
    if (p === '/data/wow/guild/zuljin/wow/roster') {
      return json({ members: [
        { character: { name: 'Grommash', level: 60, playable_class: { id: 1 } }, rank: 0 },
        { character: { name: 'Newbie', level: 12, playable_class: { id: 8 } }, rank: 4 },
      ] });
    }
    return { ok: false, status: 404 };
  };
  return { calls, fetchImpl, state };
}
const BNET = { clientId: 'id', clientSecret: 'sec' };

// ---------- access ----------

test('officer tools are for officers; without a guild there is nothing to show', async () => {
  const c = await startCore();
  try {
    assert.equal((await c.api.get('/api/admin')).status, 403);
    seedGuild(c.db, { role: 'member' });
    for (const p of ['/api/admin', '/api/admin/audit', '/api/admin/status']) {
      const m = await c.api.get(p);
      assert.equal(m.status, 403, p);
      assert.match(m.body.error, /^Only officers can do that\./);
    }
    for (const p of ['/api/admin/backups', '/api/admin/reset', '/api/admin/blizzard', '/api/admin/gamedata/refresh']) {
      assert.equal((await c.api.post(p, {})).status, 403, p);
    }
    asRole(c.db, 'officer');
    assert.equal((await c.api.get('/api/admin')).status, 200);
  } finally { await c.close(); }
});

// ---------- sync health ----------

test('sync health: what this computer knows, flagged against the newest versions, a week without syncing, and never', async () => {
  const latest = { app: '0.12.0', addon: { version: '0.11.2' } };
  const c = await startCore({ latest });
  try {
    const db = c.db;
    const g = seedGuild(db, { role: 'officer', character: 'Velanne' });
    const thrall = addPlayer(db, g.guildId, 'Thrall#1111', { role: 'owner', character: 'Thrallia' });
    const grom = addPlayer(db, g.guildId, 'Grom#3333', { role: 'member', character: 'Bravo' });
    const ghost = addPlayer(db, g.guildId, 'Ghost#5555', { role: 'member', character: 'Ghosty' });
    const setUser = db.prepare('UPDATE users SET addon_version = ?, app_version = ?, last_sync_at = ? WHERE id = ?');
    setUser.run('0.11.2', '0.12.0', db.prepare("SELECT datetime('now', '-1 hour') AS t").get().t, thrall.id);
    setUser.run('0.10.0', '0.11.0', db.prepare("SELECT datetime('now', '-9 days') AS t").get().t, g.me);
    setUser.run('0.5.0', null, db.prepare("SELECT datetime('now', '-2 days') AS t").get().t, grom.id);
    db.prepare("UPDATE characters SET extras = ?, last_seen = ?, online = 1, rank = 'Member' WHERE name = 'Bravo'").run(JSON.stringify({ addonVersion: '0.10.1' }), new Date().toISOString());

    const r = await c.api.get('/api/admin');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.latest, { app: '0.12.0', addon: '0.11.2' });
    assert.equal(r.body.isOwner, false);
    assert.equal(r.body.knownLocally, true);
    const by = Object.fromEntries(r.body.members.map((m) => [m.battletag, m]));
    assert.deepEqual(r.body.members.map((m) => m.battletag), ['Thrall#1111', 'Grom#3333', 'Velanne', 'Ghost#5555'], 'most recent sync first, never last');

    assert.deepEqual([by['Thrall#1111'].addonOutdated, by['Thrall#1111'].appOutdated, by['Thrall#1111'].stale], [false, false, false]);
    assert.deepEqual([by.Velanne.addonOutdated, by.Velanne.appOutdated, by.Velanne.stale, by.Velanne.isMe], [true, true, true, true]);
    const mem = by['Grom#3333'];
    assert.deepEqual([mem.addon_version, mem.app_version, mem.appOutdated, mem.characters, mem.role], ['0.5.0', null, false, 1, 'member']);
    assert.deepEqual([by['Ghost#5555'].id, by['Ghost#5555'].neverSynced, by['Ghost#5555'].stale, by['Ghost#5555'].last_sync_at], [ghost.id, true, false, null]);
    for (const gone of ['devices', 'sync_keys', 'companion_version', 'legacyCompanion', 'discord_linked']) assert.ok(!(gone in mem), gone);

    // The roster as last seen here, with the addon version a character reported.
    const bravo = r.body.roster.find((x) => x.name === 'Bravo');
    assert.deepEqual([bravo.online, bravo.addon_version, bravo.addonOutdated, bravo.mine], [1, '0.10.1', true, false]);
    assert.equal(r.body.roster.find((x) => x.name === 'Velanne').mine, true);

    // Without any known release, nothing counts as outdated.
    latest.app = null; latest.addon = null;
    const none = await c.api.get('/api/admin');
    assert.deepEqual(none.body.latest, { app: null, addon: null });
    assert.ok(none.body.members.every((m) => !m.addonOutdated && !m.appOutdated));
  } finally { await c.close(); }
});

// ---------- audit log ----------

test('the audit log records officer actions, newest first, and pages with ?before', async () => {
  const c = await startCore();
  try {
    const g = seedGuild(c.db, { role: 'owner', character: 'Thrallia' });
    await c.api.put('/api/guild/settings', { wowhead_game: 'classic' });
    await c.api.put('/api/guild/settings', { officer_rank_max: 2 });
    await c.api.post('/api/announcements', { body: 'Hello' });

    const r = await c.api.get('/api/admin');
    const actions = r.body.audit.entries.map((a) => a.action);
    assert.deepEqual(actions.slice(0, 3), ['notice posted', 'officer ranks set', 'Wowhead tooltips set']);
    const first = r.body.audit.entries[0];
    assert.equal(first.battletag, 'Thrallia');
    assert.equal(first.name, 'Thrallia');
    assert.equal(first.detail, 'Hello');
    assert.match(first.created_at, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
    assert.equal(r.body.audit.nextBefore, null);

    // 120 more rows: the first page has 50, then pages continue where the last ended.
    const ins = c.db.prepare('INSERT INTO audit_log (guild_id, user_id, action, detail) VALUES (?,?,?,?)');
    for (let i = 0; i < 120; i++) ins.run(g.guildId, i % 2 ? g.me : null, 'test action', `#${i}`);
    const page1 = (await c.api.get('/api/admin')).body.audit;
    assert.equal(page1.entries.length, 50);
    assert.equal(page1.entries[0].detail, '#119');
    assert.equal(page1.entries[1].name, 'Guild Camp', 'rows without a person show as Guild Camp');
    const page2 = (await c.api.get(`/api/admin/audit?before=${page1.nextBefore}`)).body;
    assert.equal(page2.entries.length, 50);
    assert.equal(page2.entries[0].id, page1.entries[49].id - 1);
    const rest = (await c.api.get(`/api/admin/audit?before=${page2.nextBefore}&limit=200`)).body;
    assert.equal(rest.entries.length, 23);
    assert.equal(rest.nextBefore, null);
    assert.equal((await c.api.get('/api/admin?before=nope')).status, 400);
    assert.equal((await c.api.get('/api/admin/audit?before=x')).status, 400);
    // Another guild's rows never show.
    const other = c.db.prepare("INSERT INTO guilds (name, invite_code) VALUES ('other', 'OTHER')").run().lastInsertRowid;
    ins.run(other, null, 'secret', 'not yours');
    assert.ok(!(await c.api.get('/api/admin')).body.audit.entries.some((a) => a.action === 'secret'));
  } finally { await c.close(); }
});

// ---------- guild settings shared with the guild ----------

test('officer ranks and who passes on officer changes: one CFG record from the Guild Master; roles follow at once; a refused change rolls back', async () => {
  const c = await startCore();
  const kit = shareKit(c);
  try {
    const g = seedGuild(c.db, { role: 'officer', character: 'Thrallia' });
    const varok = kit.mate('Varok', { rank: 2, battletag: 'Varok#2' });
    const role = (uid) => c.db.prepare('SELECT role FROM memberships WHERE user_id = ? AND guild_id = ?').get(uid, g.guildId).role;
    assert.equal(role(varok.id), 'member');

    // Only the Guild Master, and nothing is saved when part of a change is refused.
    let r = await c.api.put('/api/guild/settings', { wowhead_game: 'classic', relay_rank_max: 2 });
    assert.deepEqual([r.status, r.body.error], [403, 'Only the Guild Master can choose who passes on officer changes.']);
    assert.equal(c.db.prepare('SELECT wowhead_game FROM guilds WHERE id = ?').get(g.guildId).wowhead_game, 'forever');
    assert.deepEqual(kit.queued(), []);
    asRole(c.db, 'owner');
    for (const bad of ['x', 10, -1, 1.5]) {
      r = await c.api.put('/api/guild/settings', { relay_rank_max: bad });
      assert.deepEqual([r.status, r.body.error], [400, 'Pick Nobody, or an in-game rank from 0 to 9, for who passes on officer changes.'], String(bad));
    }

    r = await c.api.put('/api/guild/settings', { officer_rank_max: 2, relay_rank_max: 3 });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.messages, ['Officers now follow in-game ranks: Guild Master + 2 ranks below.', 'Officer changes are also passed on by the Guild Master and the 3 ranks below.']);
    assert.deepEqual([r.body.guild.officer_rank_max, r.body.guild.relay_rank_max, r.body.guild.role], [2, 3, 'owner']);
    const cfg = kit.last('CFG');
    assert.deepEqual([cfg.key, cfg.need, cfg.base, cfg.chan, cfg.fields], ['1', 'g', '', null, { officerRankMax: 2, relayRankMax: 3 }]);
    assert.equal(role(varok.id), 'officer', 'roles follow the new ranks at once');
    const audit = () => c.db.prepare('SELECT action, detail FROM audit_log ORDER BY id').all();
    assert.deepEqual(audit().slice(-3), [
      { action: 'officer ranks set', detail: 'Guild Master + 2 ranks below' },
      { action: 'relay ranks set', detail: 'Guild Master + 3 ranks below' },
      { action: 'rank promote', detail: 'Varok#2: officer (rank 2)' },
    ]);

    // One record carries both: changing one keeps the other.
    r = await c.api.put('/api/guild/settings', { relay_rank_max: null });
    assert.deepEqual(r.body.messages, ['Only officers pass on officer changes now.']);
    assert.deepEqual(kit.queued('CFG').map((e) => [e.fields, e.base]), [[{ officerRankMax: 2, relayRankMax: null }, '']], 'replaced while it waits');
    assert.equal((await c.api.get('/api/guild')).body.guild.relay_rank_max, null);
    // "Off" for officers is the Guild Master alone.
    r = await c.api.put('/api/guild/settings', { officer_rank_max: null });
    assert.deepEqual(r.body.messages, ['In-game ranks no longer make anyone an officer here.']);
    assert.deepEqual(kit.last('CFG').fields, { officerRankMax: 0, relayRankMax: null });
    assert.equal(role(varok.id), 'member');
    assert.deepEqual(audit().at(-1), { action: 'rank demote', detail: 'Varok#2: member (rank 2)' });

    // Sent: the next change is an edit of what the guild has.
    kit.ack(kit.last('CFG'));
    r = await c.api.put('/api/guild/settings', { officer_rank_max: 2 });
    const edit = kit.last('CFG');
    assert.equal(edit.base, sharing.baseOf(c.db, g.guildId, 'CFG:1'));
    assert.notEqual(edit.base, '');
    assert.equal(role(varok.id), 'officer');
    // Someone else's change got there first: the game refuses mine and the ranks go back to the guild's.
    kit.ack(edit, 'no,stale');
    assert.deepEqual(kit.entry(edit.op).note, 'Someone changed this in the meantime. Check it and try again.');
    assert.deepEqual({ ...c.db.prepare('SELECT officer_rank_max, relay_rank_max FROM guilds WHERE id = ?').get(g.guildId) }, { officer_rank_max: 0, relay_rank_max: null });
    assert.equal(role(varok.id), 'member');
  } finally { kit.restore(); await c.close(); }
});

test('officer ranks: a first-ever CFG cancelled from the outbox or refused by the game goes back to the defaults (officers up to rank 1, officer changes passed on by officers), and roles follow', async () => {
  const c = await startCore();
  const kit = shareKit(c);
  try {
    const g = seedGuild(c.db, { role: 'owner', character: 'Thrallia' });
    const varok = kit.mate('Varok', { rank: 2, battletag: 'Varok#2' });
    const ranks = () => ({ ...c.db.prepare('SELECT officer_rank_max, relay_rank_max FROM guilds WHERE id = ?').get(g.guildId) });
    const role = (uid) => c.db.prepare('SELECT role FROM memberships WHERE user_id = ? AND guild_id = ?').get(uid, g.guildId).role;
    assert.deepEqual([ranks(), role(varok.id)], [{ officer_rank_max: 1, relay_rank_max: null }, 'member']);

    await c.api.put('/api/guild/settings', { officer_rank_max: 2, relay_rank_max: 3 });
    assert.deepEqual([ranks(), role(varok.id)], [{ officer_rank_max: 2, relay_rank_max: 3 }, 'officer'], 'shown at once');
    const first = kit.last('CFG');
    assert.equal(first.base, '', 'no settings record yet');
    assert.equal((await c.api.post(`/api/share/outbox/${first.op}/cancel`)).status, 200);
    assert.deepEqual([ranks(), role(varok.id)], [{ officer_rank_max: 1, relay_rank_max: null }, 'member'], 'dropped: back to the defaults');
    assert.equal((await c.api.get('/api/guild')).body.guild.officer_rank_max, 1);

    await c.api.put('/api/guild/settings', { officer_rank_max: 3 });
    assert.equal(role(varok.id), 'officer');
    kit.ack(kit.last('CFG'), 'no,expired');
    assert.deepEqual([ranks(), role(varok.id)], [{ officer_rank_max: 1, relay_rank_max: null }, 'member'], 'refused: back to the defaults');
  } finally { kit.restore(); await c.close(); }
});

// ---------- backups ----------

test('backups: local copies of guildcamp.db, with the full path for "show in folder"', async () => {
  const dir = tmpDir('gc-admin-');
  const c = await startCore({ dataDir: dir });
  try {
    seedGuild(c.db, { role: 'officer' });
    let r = await c.api.get('/api/admin');
    assert.equal(r.body.backupsEnabled, true);
    assert.equal(r.body.backupDir, path.join(dir, 'backups'));
    assert.deepEqual(r.body.backups, []);

    const made = await c.api.post('/api/admin/backups');
    assert.equal(made.status, 200);
    assert.equal(made.body.message, 'Backup made.');
    const file = made.body.backup.file;
    assert.match(file, /^guildcamp-\d{8}-\d{6}\.db$/);
    assert.ok(made.body.backup.size > 0);
    assert.equal(made.body.backup.path, path.join(dir, 'backups', file));
    assert.ok(fs.readFileSync(made.body.backup.path).subarray(0, 15).toString() === 'SQLite format 3', 'the file is the database snapshot');
    r = await c.api.get('/api/admin');
    assert.deepEqual(r.body.backups.map((b) => b.file), [file]);
    assert.ok(!Number.isNaN(Date.parse(r.body.backups[0].created)));
    assert.ok(c.db.prepare("SELECT 1 FROM audit_log WHERE action = 'backup made' AND detail = ?").get(file));
    // Nothing is downloaded from the core any more.
    assert.equal((await c.api.get(`/api/admin/backups/${file}`)).status, 404);
  } finally { await c.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('backups need a database file: an in-memory core says so instead of writing somewhere odd', async () => {
  const c = await startCore();
  try {
    seedGuild(c.db, { role: 'owner' });
    const r = await c.api.get('/api/admin');
    assert.equal(r.body.backupsEnabled, false);
    assert.deepEqual(r.body.backups, []);
    const made = await c.api.post('/api/admin/backups');
    assert.equal(made.status, 409);
    assert.match(made.body.error, /database file/);
  } finally { await c.close(); }
});

// ---------- fresh start ----------

test('fresh start: Guild Master only, needs the guild name, backs up first, wipes game data and keeps people', async () => {
  const dir = tmpDir('gc-admin-');
  const c = await startCore({ dataDir: dir, settings: { discordWebhook: 'https://discord.com/api/webhooks/1/a' } });
  try {
    const db = c.db;
    const g = seedGuild(db, { name: 'Camp Fire', realm: null, role: 'officer', character: 'Thrallia' });
    addPlayer(db, g.guildId, 'Grom#3333', { role: 'member' });
    const before = Math.floor(Date.now() / 1000) - 3600;
    const retail = {
      characters: { Testy: { name: 'Testy', class: 'MAGE', level: 80, realm: 'Ragnaros', guild: 'Test Guild', updated: before,
        inventory: { bags: [{ id: 2589, name: 'Linen Cloth', count: 5 }] }, professions: { Tailoring: { rank: 300, max: 300 } }, recipes: { Tailoring: [{ name: 'Linen Belt' }] } } },
      roster: { scannedAt: before, guild: 'Test Guild', members: [{ name: 'Testy', level: 80, class: 'MAGE', online: true }] },
      prices: { items: [[2589, 100, 2000]] },
      ctaQueue: [{ at: before, character: 'Testy', zone: 'Orgrimmar', msg: 'test', needed: 5 }],
    };
    applyPayload(db, g.guildId, g.me, retail);
    db.prepare("INSERT INTO raids (guild_id, title, instance, starts_at, created_by) VALUES (?, 'Test raid', 'MC', '2026-11-10T19:00:00Z', ?)").run(g.guildId, g.me);
    db.prepare("UPDATE guilds SET realm = 'Ragnaros', game_guild = 'Test Guild', wowhead_game = 'classic' WHERE id = ?").run(g.guildId);
    assert.ok(db.prepare('SELECT COUNT(*) n FROM characters').get().n > 0);

    // Officers can't; the Guild Master must type the guild name.
    const off = await c.api.post('/api/admin/reset', { confirm: 'Camp Fire' });
    assert.equal(off.status, 403);
    assert.match(off.body.error, /Only the Guild Master/);
    db.prepare("UPDATE characters SET rank_index = 0 WHERE name = 'Thrallia'").run();
    require('../../src/core/identity').syncRanks(db, g.guildId);
    for (const confirm of [undefined, '', 'WIPE', 'Camp', 42]) {
      const bad = await c.api.post('/api/admin/reset', { confirm });
      assert.equal(bad.status, 400, String(confirm));
      assert.equal(bad.body.error, 'Nothing was wiped. Type the guild name (Camp Fire) to confirm.');
    }
    assert.ok(db.prepare('SELECT COUNT(*) n FROM characters').get().n > 0, 'nothing wiped yet');
    assert.equal(fs.existsSync(path.join(dir, 'backups')), false, 'no backup for a refused wipe');

    const r = await c.api.post('/api/admin/reset', { confirm: '  camp fire ' });
    assert.equal(r.status, 200);
    assert.ok(r.body.rows > 0);
    assert.match(r.body.backup, /^guildcamp-\d{8}-\d{6}\.db$/);
    assert.ok(fs.existsSync(path.join(dir, 'backups', r.body.backup)), 'backup written first');
    assert.match(r.body.message, /^Fresh start done: \d+ rows of game data removed from this PC \(backup guildcamp-.+\.db kept\)\. People, settings and your unsent changes stay\. Guild data shared in game comes back after you log out or type \/reload\.$/);
    for (const t of ['characters', 'inventory', 'recipes', 'professions', 'raids', 'prices', 'ctas', 'activity']) {
      assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n, 0, t);
    }
    assert.equal(db.prepare('SELECT COUNT(*) n FROM memberships').get().n, 2);
    const row = db.prepare('SELECT * FROM guilds WHERE id = ?').get(g.guildId);
    assert.equal(row.wowhead_game, 'classic', 'settings stay');
    assert.equal(row.realm, null);
    assert.ok(row.reset_at);
    const audit = db.prepare("SELECT detail FROM audit_log WHERE action = 'wiped guild data for a fresh start'").get();
    assert.match(audit.detail, /^\d+ rows, backup guildcamp-/);
    // The old SavedVariables uploading again brings nothing back.
    applyPayload(db, g.guildId, g.me, retail);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM characters').get().n, 0);
    // The safety copy shows in the backup list.
    assert.deepEqual((await c.api.get('/api/admin')).body.backups.map((b) => b.file), [r.body.backup]);
  } finally { await c.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('fresh start rebuilds this computer\'s copy of the guild\'s shared data: records, answered author checks, sharing stats and outbox history go, unsent changes and unanswered author checks stay, and the next upload brings it all back evenly', async () => {
  const c = await startCore();
  const kit = shareKit(c);
  try {
    const db = c.db;
    const g = seedGuild(db, { name: 'Camp Fire', role: 'owner', character: 'Thrallia' });
    const gid = g.guildId;
    const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE guild_id = ?`).get(gid).n;
    const requests = () => db.prepare('SELECT item, status FROM bank_requests WHERE guild_id = ? ORDER BY item').all(gid).map((x) => [x.item, x.status]);
    const outbox = () => db.prepare('SELECT op, state FROM share_outbox ORDER BY op').all().map((x) => [x.op, x.state]);
    const checks = () => db.prepare('SELECT rec_id, state FROM share_author_checks WHERE guild_id = ? ORDER BY rec_id').all(gid).map((x) => [x.rec_id, x.state]);
    const mokra = kit.mate('Mokra', { battletag: 'Mokra#2' });
    kit.mate('Grommash', { role: 'officer', battletag: 'Grom#1' });
    kit.imp([
      kit.rec('RD', 'k3f9a2', { kind: 'r', title: 'MC Thursday', instance: 'Molten Core', startsAt: kit.now() + 2 * 86400, minutes: 180, size: 40, srLimit: 2, notes: '' }, { author: 'Grommash' }),
      kit.rec('AN', 'n1n1n1', { body: 'Raid at eight.' }, { author: 'Grommash' }),
      kit.rec('bq', 'b1b1b1', { pid: mokra.pid, item: 'Thorium Bar', count: 5, note: '', state: 'o' }, { author: 'Mokra' }),
    ]);
    // My changes: one the game sent, one it refused, one still to send.
    kit.tick(5);
    await c.api.post('/api/bank/requests', { item: 'Runecloth', count: 20 });
    const sent = kit.last('bq');
    kit.ack(sent);
    await c.api.post('/api/bank/requests', { item: 'Silk', count: 2 });
    kit.ack(kit.last('bq'), 'no,expired');
    await c.api.post('/api/bank/requests', { item: 'Wool', count: 1 });
    const unsent = kit.last('bq');
    // Changes in my name this computer didn't make: one I answered ("It was me"), one I haven't.
    kit.tick(10);
    kit.imp([
      kit.rec('AN', 'f0f0f0', { body: 'Free gold!' }, { author: 'Thrallia', t: kit.now() }),
      kit.rec('AN', 'e1e1e1', { body: 'Bring flasks.' }, { author: 'Thrallia', t: kit.now() }),
    ]);
    const answered = db.prepare("SELECT id FROM share_author_checks WHERE rec_id = 'AN:e1e1e1'").get().id;
    assert.equal((await c.api.post(`/api/share/author-checks/${answered}`, { action: 'mine' })).status, 200);
    assert.deepEqual(checks(), [['AN:e1e1e1', 'mine'], ['AN:f0f0f0', 'open']]);
    assert.equal(outbox().length, 3);
    assert.equal(sharing.status(db).enabled, true);
    // What the addon's store holds for the guild (and gives back at the next upload).
    const store = db.prepare('SELECT id, body FROM shared_records WHERE guild_id = ? ORDER BY id').all(gid);
    const part = sharing.partitionOf(db, db.prepare('SELECT * FROM guilds WHERE id = ?').get(gid));
    assert.deepEqual(requests(), [['Runecloth', 'open'], ['Thorium Bar', 'open'], ['Wool', 'open']]);

    const r = await c.api.post('/api/admin/reset', { confirm: 'Camp Fire' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.match(r.body.message, /removed from this PC\. People, settings and your unsent changes stay\. Guild data shared in game comes back after you log out or type \/reload\.$/);
    assert.doesNotMatch(r.body.message, /guildmates|everyone/i, 'nothing in guildmates\' games is deleted');
    assert.equal(r.body.removed.shared_records, store.length);
    assert.equal(count('shared_records'), 0);
    assert.deepEqual(checks(), [['AN:f0f0f0', 'open']], 'the answered check goes; the one I haven\'t answered stays');
    assert.deepEqual(outbox(), [[unsent.op, 'queued']], 'sent, refused and dropped history goes; the unsent change stays');
    assert.equal(sharing.status(db).enabled, false, 'what this computer saw of the guild\'s sharing goes too');
    assert.deepEqual(requests(), [['Wool', 'open']], 'my unsent request still shows');
    assert.equal(count('raids') + count('announcements'), 0);
    assert.equal(db.prepare('SELECT role FROM memberships WHERE user_id = ? AND guild_id = ?').get(g.me, gid).role, 'owner', 'roles stay');

    // The next upload, with characters played after the fresh start and the addon's store as it is.
    const later = Math.floor(Date.now() / 1000) + 5;
    const recs = Object.fromEntries(store.map((s) => [s.id, s.body]));
    const via = Object.fromEntries(store.map((s) => [s.id, `${S.parse(s.body).author},${kit.now()},d`]));
    const up = await c.api.post('/api/sync', {
      characters: { Thrallia: { name: 'Thrallia', class: 'WARRIOR', level: 60, realm: 'Forever', guild: 'Camp Fire', updated: later } },
      roster: { scannedAt: later, guild: 'Camp Fire', members: [
        { name: 'Thrallia', rankIndex: 0, online: true }, { name: 'Grommash', rankIndex: 1 }, { name: 'Mokra', rankIndex: 4 },
      ] },
      shared: { v: 1, clock: { server: kit.now(), here: kit.now() }, guilds: { [part]: {
        recs, via, sent: { [sent.op]: `ok,${sent.v},${sent.author}` }, names: {}, stats: { peers: 2, lastHello: kit.now() - 60, lastExchange: kit.now() - 30 },
      } } },
    });
    assert.equal(up.status, 200, JSON.stringify(up.body));
    assert.equal(count('shared_records'), store.length, 'every record came back from the store, whatever its age');
    assert.deepEqual(db.prepare('SELECT title, instance FROM raids WHERE guild_id = ?').all(gid).map((x) => [x.title, x.instance]), [['MC Thursday', 'Molten Core']]);
    assert.deepEqual(db.prepare('SELECT body FROM announcements WHERE guild_id = ? ORDER BY body').all(gid).map((x) => x.body), ['Bring flasks.', 'Free gold!', 'Raid at eight.']);
    assert.deepEqual(requests(), [['Runecloth', 'open'], ['Thorium Bar', 'open'], ['Wool', 'open']]);
    assert.deepEqual(checks(), [['AN:f0f0f0', 'open']], 'my own records from before the fresh start are not flagged as changes I didn\'t make, and the open check is not asked twice');
    assert.deepEqual(outbox(), [[unsent.op, 'queued']], 'a late "ok" for history that is gone changes nothing');
    assert.deepEqual((await c.api.get('/api/inbox')).body.outbox.map((e) => e.op), [unsent.op], 'the unsent change still goes to the game');
    assert.equal(sharing.status(db).enabled, true);
    assert.equal(db.prepare('SELECT role FROM memberships WHERE user_id = ? AND guild_id = ?').get(g.me, gid).role, 'owner');
  } finally { kit.restore(); await c.close(); }
});

test('fresh start: a forged notice in my name I haven\'t answered yet is still asked about after the next upload brings it back, and "Undo it" removes it', async () => {
  const c = await startCore();
  const kit = shareKit(c);
  try {
    const db = c.db;
    const g = seedGuild(db, { name: 'Camp Fire', role: 'owner', character: 'Thrallia' });
    kit.imp([kit.rec('AN', 'n1n1n1', { body: 'Raid at eight.' }, { author: 'Thrallia', t: kit.now() - 600 })]);
    kit.tick(10);
    const forged = kit.rec('AN', 'f0f0f0', { body: 'Free gold!' }, { author: 'Thrallia', t: kit.now() });
    kit.imp([forged]);
    const open = async () => (await c.api.get('/api/share/status')).body.authorChecks.map((x) => x.summary);
    const asked = await open();
    assert.equal(asked.length, 1);

    assert.equal((await c.api.post('/api/admin/reset', { confirm: 'Camp Fire' })).status, 200);
    assert.deepEqual(await open(), asked, 'still asked right after the fresh start');
    const part = sharing.partitionOf(db, db.prepare('SELECT * FROM guilds WHERE id = ?').get(g.guildId));
    const later = Math.floor(Date.now() / 1000) + 5;
    const up = await c.api.post('/api/sync', {
      characters: { Thrallia: { name: 'Thrallia', class: 'WARRIOR', level: 60, realm: 'Forever', guild: 'Camp Fire', updated: later } },
      roster: { scannedAt: later, guild: 'Camp Fire', members: [{ name: 'Thrallia', rankIndex: 0, online: true }] },
      shared: { v: 1, clock: { server: kit.now(), here: kit.now() }, guilds: { [part]: {
        recs: { 'AN:f0f0f0': forged }, via: { 'AN:f0f0f0': `Thrallia,${kit.now()},d` }, sent: {}, names: {}, stats: {},
      } } },
    });
    assert.equal(up.status, 200, JSON.stringify(up.body));
    assert.ok(db.prepare("SELECT 1 FROM announcements WHERE share_id = 'f0f0f0'").get(), 'the forged notice came back with the store');
    assert.deepEqual(await open(), asked, 'and I am still asked about it, once');

    const id = db.prepare("SELECT id FROM share_author_checks WHERE rec_id = 'AN:f0f0f0'").get().id;
    const undo = await c.api.post(`/api/share/author-checks/${id}`, { action: 'undo' });
    assert.equal(undo.status, 200, JSON.stringify(undo.body));
    assert.equal(kit.last('AN').del, true, 'a removal goes to the guild');
    assert.equal(db.prepare("SELECT 1 FROM announcements WHERE share_id = 'f0f0f0'").get(), undefined);
    assert.deepEqual(await open(), []);
  } finally { kit.restore(); await c.close(); }
});

test('fresh start: a call to arms I sent in game in the last hour is not posted to Discord again when the next upload brings it back; one sent after the fresh start is', async () => {
  const posts = [];
  const fetch = async (url, init) => {
    posts.push(JSON.parse(init.body).content);
    return { ok: true, status: 204, json: async () => ({}), text: async () => '' };
  };
  const c = await startCore({ fetch, settings: { discordWebhook: 'https://discord.com/api/webhooks/1/a' } });
  const kit = shareKit(c);
  try {
    const db = c.db;
    const g = seedGuild(db, { name: 'Camp Fire', role: 'owner', character: 'Thrallia' });
    const part = sharing.partitionOf(db, db.prepare('SELECT * FROM guilds WHERE id = ?').get(g.guildId));
    const recs = {};
    const cta = (key, zone) => { recs[`ca:${key}`] = kit.rec('ca', key, { character: 'Thrallia', zone, needed: 5, message: '' }, { author: 'Thrallia', t: kit.now() }); };
    // An upload from the game: my character, the roster, and the addon's store as it is.
    const upload = async (played) => {
      const via = Object.fromEntries(Object.keys(recs).map((id) => [id, `Thrallia,${kit.now()},d`]));
      const r = await c.api.post('/api/sync', {
        characters: { Thrallia: { name: 'Thrallia', class: 'WARRIOR', level: 60, realm: 'Forever', guild: 'Camp Fire', updated: played } },
        roster: { scannedAt: played, guild: 'Camp Fire', members: [{ name: 'Thrallia', rankIndex: 0, online: true }] },
        shared: { v: 1, clock: { server: kit.now(), here: kit.now() }, guilds: { [part]: { recs, via, sent: {}, names: {}, stats: {} } } },
      });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      await kit.settle();
      return r.body.ctas;
    };
    cta('ca0001', 'Crossroads');
    assert.equal(await upload(Math.floor(Date.now() / 1000)), 1);
    assert.deepEqual(posts, ['⚔️ **Call to arms: Crossroads** (need 5)\n— Thrallia (from in game)']);

    kit.tick(600);
    const r = await c.api.post('/api/admin/reset', { confirm: 'Camp Fire' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    kit.tick(60);
    // Ten minutes later I log in again: the call is still in the store, and comes back as a new record.
    const later = Math.floor(Date.now() / 1000) + 5;
    assert.equal(await upload(later), 0, 'the call from before the fresh start was posted already');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ctas WHERE share_id = 'ca0001'").get().n, 1, 'it still shows in Guild Camp');
    assert.equal(posts.length, 1);
    kit.tick(5);
    cta('ca0002', 'Tarren Mill');
    assert.equal(await upload(later + 1), 1);
    assert.deepEqual(posts.slice(1), ['⚔️ **Call to arms: Tarren Mill** (need 5)\n— Thrallia (from in game)']);
  } finally { kit.restore(); await c.close(); }
});

// ---------- Blizzard and game data ----------

test('Blizzard check with the built-in Battle.net app: the status is saved, and failures say what went wrong', async () => {
  const B = fakeBlizzard({ realmUp: true, ns: 'camelot' });
  const c = await startCore({ credentials: BNET, fetch: B.fetchImpl, settings: { bnetRegion: 'eu' } });
  try {
    seedGuild(c.db, { role: 'officer' });
    let r = await c.api.get('/api/admin');
    assert.deepEqual(r.body.blizzard, { configured: true, region: 'eu', note: null, status: null });

    r = await c.api.post('/api/admin/blizzard');
    assert.equal(r.status, 200);
    assert.equal(r.body.message, 'Blizzard API checked.');
    assert.equal(r.body.blizzard.status.ok, true);
    assert.equal(r.body.blizzard.status.tokenGold, 250000);
    assert.equal(r.body.blizzard.status.forever, 'static-camelot-eu');
    assert.equal(blizzard.load(c.db).foreverKey, 'camelot');
    assert.equal(r.body.gameData.namespaces.label, 'WoW: Forever');
    assert.equal(r.body.gameData.liveData, true);
    assert.ok(B.calls.every((u) => !u.includes('us.api')), 'the region from Settings');

    B.state.fail = true;
    r = await c.api.post('/api/admin/blizzard');
    assert.equal(r.status, 502);
    assert.match(r.body.error, /^The Blizzard API check didn't work: /);
    assert.equal(blizzard.load(c.db).forever, 'static-camelot-eu', 'a failed check keeps the last good status');
  } finally { await c.close(); }
});

test('without a built-in Battle.net app, Blizzard game data stays off and says so', async () => {
  const c = await startCore({ fetch: async () => { throw new Error('no outside calls'); } });
  try {
    seedGuild(c.db, { role: 'owner' });
    let r = await c.api.get('/api/admin');
    assert.equal(r.body.blizzard.configured, false);
    assert.match(r.body.blizzard.note, /no Battle\.net app built in/);
    r = await c.api.post('/api/admin/blizzard');
    assert.equal(r.status, 200);
    assert.equal(r.body.blizzard.status.ok, false);
    assert.deepEqual(r.body.blizzard.status.notes, ['Blizzard game data is off: this copy of Guild Camp has no Battle.net app built in.']);
    const refresh = await c.api.post('/api/admin/gamedata/refresh');
    assert.equal(refresh.status, 200);
    assert.match(refresh.body.message, /no Battle\.net app built in\. There is nothing to refresh\./);
  } finally { await c.close(); }
});

test('game data: officers set the realm, refresh realm status and the official roster; ranks follow; the realm coming back notifies', async () => {
  const B = fakeBlizzard({ realmUp: true, ns: 'forever' });
  const c = await startCore({ credentials: BNET, fetch: B.fetchImpl });
  try {
    const db = c.db;
    const g = seedGuild(db, { role: 'officer', character: 'Grommash', level: 58 });

    // No realm yet.
    db.prepare('UPDATE guilds SET realm = NULL').run();
    let r = await c.api.post('/api/admin/gamedata/refresh');
    assert.equal(r.body.message, 'Save the realm name first, then refresh.');
    assert.equal(B.calls.length, 0);

    assert.equal((await c.api.put('/api/guild/settings', { realm: "Zul'jin", game_guild: 'wow' })).status, 200);
    // Forever isn't in the API yet: nothing realm-related is asked for.
    r = await c.api.post('/api/admin/gamedata/refresh');
    assert.match(r.body.message, /doesn’t have WoW: Forever realms yet/);
    assert.equal(r.body.gameData.liveData, false);
    assert.match(r.body.gameData.namespaces.label, /Classic Era/);
    assert.ok(!B.calls.some((x) => x.includes('/realm/')));

    blizzard.save(db, { foreverKey: 'forever', forever: 'static-forever-eu', region: 'eu' });
    r = await c.api.post('/api/admin/gamedata/refresh');
    assert.equal(r.status, 200);
    assert.match(r.body.message, /Official roster: 2 members/);
    const gd = r.body.gameData;
    assert.deepEqual([gd.realm, gd.game_guild, gd.realm_status.up, gd.realm_status.queue, gd.realm_status.slug], ["Zul'jin", 'wow', true, true, 'zuljin']);
    assert.equal(gd.official_roster_note, '2 members');
    assert.equal(gd.officialRosterMembers, 2);
    const chars = Object.fromEntries(db.prepare('SELECT name, level, class, user_id FROM characters').all().map((x) => [x.name, x]));
    assert.equal(chars.Newbie.class, 'MAGE');
    assert.equal(chars.Grommash.level, 60, 'levels only go up');
    assert.equal(chars.Grommash.user_id, g.me);
    // Blizzard's roster says Grommash is rank 0: I am the Guild Master here now.
    assert.equal((await c.api.get('/api/me')).body.role, 'owner');

    const st = (await c.api.get('/api/admin/status')).body;
    assert.equal(st.gameData.realm_status.name, "Zul'jin");
    assert.equal(st.blizzard.configured, true);

    // The realm goes down, then comes back: a 'notice' notification.
    B.state.realmUp = false;
    await c.ctx.services.admin.gameRun({ only: 'realm' });
    assert.equal(c.events.filter((e) => e.kind === 'notice').length, 0);
    B.state.realmUp = true;
    await c.ctx.services.admin.gameRun({ only: 'realm' });
    const ev = c.events.find((e) => e.kind === 'notice');
    assert.match(ev.title, /Zul'jin is back up/);
    assert.match(ev.body, /queue/);
    assert.equal(ev.route, '/');

    // Blizzard failing mid-refresh is reported per part, not as a crash.
    B.state.fail = true;
    r = await c.api.post('/api/admin/gamedata/refresh');
    assert.equal(r.status, 200);
    assert.match(r.body.message, /failed/);
  } finally { await c.close(); }
});

// ---------- AI usage ----------

test('AI usage shows this month’s spend against the Coach budget', async () => {
  const c = await startCore({ secrets: { anthropicKey: 'sk-test' } });
  try {
    const g = seedGuild(c.db, { role: 'officer' });
    const ins = c.db.prepare("INSERT INTO ai_usage (guild_id, user_id, kind, model, cost_usd, created_at) VALUES (?,?,?,?,?, datetime('now', ?))");
    ins.run(g.guildId, g.me, 'question', 'claude-haiku-5-5', 0.75, '0 seconds');
    ins.run(g.guildId, g.me, 'plan', 'claude-sonnet-5-5', 1.5, '0 seconds');
    ins.run(g.guildId, g.me, 'plan', 'claude-sonnet-5-5', 9, '-40 days');
    await c.api.put('/api/guild/settings', { coach_enabled: true, coach_budget_usd: 20 });
    const { ai } = (await c.api.get('/api/admin')).body;
    assert.equal(ai.hasKey, true);
    assert.equal(ai.coach_enabled, 1);
    assert.equal(ai.coach_budget_usd, 20);
    assert.equal(ai.spentUsd, 2.25);
    assert.match(ai.month, /^\d{4}-\d\d$/);
    assert.deepEqual(ai.limits, { questionsPerDay: 30, plansPerDay: 5 });
    c.secrets.anthropicKey = null;
    assert.equal((await c.api.get('/api/admin')).body.ai.hasKey, false, 'read live from the app\'s secrets');
  } finally { await c.close(); }
});

// ---------- background jobs ----------

test('background jobs start only when timers are on, and stop on close', async () => {
  const offline = async () => { throw new Error('offline'); };
  const dir = tmpDir('gc-admin-');
  try {
    const off = await startCore({ dataDir: dir });
    assert.equal(off.ctx.timers.length, 0);
    await off.close();
    // backups (start + hourly), Blizzard (start + daily), game data (start + hourly + realm every 5 min),
    // raid reminders and the Coach (every minute), and season shout-outs (every 5 minutes).
    const on = await startCore({ dataDir: dir, timers: true, credentials: BNET, fetch: offline });
    assert.equal(on.ctx.timers.length, 13);
    await on.close();
    assert.equal(on.ctx.timers.length, 0);
    // No built-in Battle.net app → no Blizzard or game data timers; no database file → no backups.
    const mem = await startCore({ timers: true, fetch: offline });
    try { assert.equal(mem.ctx.timers.length, 6); } finally { await mem.close(); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------- calendar ----------

test('calendar export: the .ics text with my sign-ups, for the app to save as a file', async () => {
  const c = await startCore();
  try {
    const db = c.db;
    const g = seedGuild(db, { role: 'member', character: 'Bravo' });
    const other = addPlayer(db, g.guildId, 'Thrall#1111', { role: 'owner' });
    const soon = new Date(Date.now() + 3 * 86400000).toISOString();
    const raid = db.prepare("INSERT INTO raids (guild_id, title, instance, starts_at, created_by) VALUES (?, 'Hyjal week 1', 'Hyjal Summit', ?, ?)").run(g.guildId, soon, other.id).lastInsertRowid;
    db.prepare("INSERT INTO raids (guild_id, title, instance, starts_at, created_by) VALUES (?, 'Ancient raid', 'MC', ?, ?)").run(g.guildId, new Date(Date.now() - 60 * 86400000).toISOString(), other.id);
    db.prepare("INSERT INTO signups (raid_id, user_id, character, role, status) VALUES (?, ?, 'Bravo', 'dps', 'yes')").run(raid, g.me);

    const feed = await c.api.get('/api/calendar.ics');
    assert.equal(feed.status, 200);
    assert.match(feed.headers.get('content-type'), /^text\/calendar/);
    assert.equal(feed.headers.get('cache-control'), 'no-store');
    assert.match(feed.body, /^BEGIN:VCALENDAR\r\n/);
    assert.match(feed.body, /SUMMARY:Raid: Hyjal week 1/);
    assert.match(feed.body, /You’re coming\. 1 coming\./);
    assert.match(feed.body, /X-WR-CALNAME:wow raids/);
    assert.doesNotMatch(feed.body, /Ancient raid/, 'only the last 30 days on');
    // The feed-address endpoints are gone.
    for (const p of ['/api/calendar', '/api/calendar/reset']) assert.equal((await c.api.get(p)).status, 404, p);
  } finally { await c.close(); }
});
