// Officer tools over HTTP: sync health, audit log, backups, fresh start, Blizzard and game data,
// AI usage, background jobs, and calendar feeds. Ported from the old hardening, reset, freebies and
// gamedata tests (the parts that went through the web routes), now against the JSON API.
// The services themselves (backup, reset, blizzard, gamedata, calendar) are unit-tested in services.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startServer, seed, client, addUser, addLegacyKey } = require('./helpers');
const blizzard = require('../src/services/blizzard');
const { applyPayload } = require('../src/services/sync');

// A temp folder with a real database file, so backups have something to copy.
function tempDbFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-admin-'));
  return { dir, file: path.join(dir, 'wow.db'), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// A stand-in for Blizzard's API (ported from the old gamedata test). `state.realmUp` can be flipped.
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
const BNET = { bnetClientId: 'id', bnetClientSecret: 'sec', bnetRegion: 'eu' };

// ---------- access ----------

test('officer tools are for officers: members, strangers and signed-out callers are turned away', async () => {
  const srv = await startServer();
  try {
    const s = seed(srv.db);
    const stranger = addUser(srv.db, 'Stranger#4444');
    for (const p of ['/api/admin', '/api/admin/audit', '/api/admin/status']) {
      assert.equal((await client(srv.url).get(p)).status, 401, p);
      const m = await client(srv.url, s.member.token).get(p);
      assert.equal(m.status, 403, p);
      assert.equal(m.body.error, 'Officers only.');
      assert.equal((await client(srv.url, stranger.token).get(p)).status, 403, p);
    }
    for (const p of ['/api/admin/backups', '/api/admin/reset', '/api/admin/blizzard', '/api/admin/gamedata/refresh']) {
      assert.equal((await client(srv.url, s.member.token).post(p, {})).status, 403, p);
    }
    assert.equal((await client(srv.url, s.officer.token).get('/api/admin')).status, 200);
    // An old companion sync key is not accepted outside sync.
    const key = addLegacyKey(srv.db, s.owner.id, s.guildId);
    assert.equal((await client(srv.url, key).get('/api/admin')).status, 401);
  } finally { await srv.close(); }
});

// ---------- sync health ----------

test('sync health flags outdated versions against the latest releases, a week without syncing, and never', async () => {
  // No bundled addon, so only published releases count as the latest.
  const srv = await startServer({ bundledAddonDir: path.join(os.tmpdir(), 'gc-no-bundled-addon') });
  try {
    const s = seed(srv.db);
    const db = srv.db;
    db.prepare("INSERT INTO releases (kind, version, file) VALUES ('addon', '0.11.2', 'WowGuild-0.11.2.zip'), ('app', '0.12.0', 'Guild-Camp-Setup-0.12.0.exe')").run();
    const setUser = db.prepare('UPDATE users SET addon_version = ?, app_version = ?, companion_version = ?, last_sync_at = ? WHERE id = ?');
    setUser.run('0.11.2', '0.12.0', null, db.prepare("SELECT datetime('now', '-1 hour') AS t").get().t, s.owner.id);
    setUser.run('0.10.0', '0.11.0', null, db.prepare("SELECT datetime('now', '-9 days') AS t").get().t, s.officer.id);
    setUser.run('0.5.0', null, '0.4.0', db.prepare("SELECT datetime('now', '-2 days') AS t").get().t, s.member.id);
    const ghost = addUser(db, 'Ghost#5555', { guildId: s.guildId, device: false });
    db.prepare("INSERT INTO characters (guild_id, user_id, name, class, level) VALUES (?, ?, 'Bravo', 'ROGUE', 20)").run(s.guildId, s.member.id);

    const r = await client(srv.url, s.officer.token).get('/api/admin');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.latest, { app: '0.12.0', addon: '0.11.2' });
    assert.equal(r.body.isOwner, false);
    const by = Object.fromEntries(r.body.members.map((m) => [m.battletag, m]));
    assert.deepEqual(r.body.members.map((m) => m.battletag), ['Owner#1111', 'Member#3333', 'Officer#2222', 'Ghost#5555'], 'most recent sync first, never last');

    assert.equal(by['Owner#1111'].addonOutdated, false);
    assert.equal(by['Owner#1111'].appOutdated, false);
    assert.equal(by['Owner#1111'].stale, false);

    assert.equal(by['Officer#2222'].addonOutdated, true);
    assert.equal(by['Officer#2222'].appOutdated, true);
    assert.equal(by['Officer#2222'].stale, true, 'nine days without a sync');

    const mem = by['Member#3333'];
    assert.equal(mem.addon_version, '0.5.0');
    assert.equal(mem.companion_version, '0.4.0');
    assert.equal(mem.app_version, null);
    assert.equal(mem.appOutdated, false, 'no app version is "not yet", not outdated');
    assert.equal(mem.legacyCompanion, true);
    assert.equal(mem.characters, 1);
    assert.equal(mem.role, 'member');

    assert.equal(by['Ghost#5555'].id, ghost.id);
    assert.equal(by['Ghost#5555'].neverSynced, true);
    assert.equal(by['Ghost#5555'].stale, false);
    assert.equal(by['Ghost#5555'].devices, 0);
    assert.equal(by['Ghost#5555'].last_sync_at, null);

    // Without any release, nothing counts as outdated.
    db.prepare('DELETE FROM releases').run();
    const none = await client(srv.url, s.owner.token).get('/api/admin');
    assert.deepEqual(none.body.latest, { app: null, addon: null });
    assert.ok(none.body.members.every((m) => !m.addonOutdated && !m.appOutdated));
    assert.equal(none.body.isOwner, true);
  } finally { await srv.close(); }
});

// ---------- audit log ----------

test('the audit log records officer actions, newest first, and pages with ?before', async () => {
  const srv = await startServer();
  try {
    const s = seed(srv.db);
    const owner = client(srv.url, s.owner.token);
    const officer = client(srv.url, s.officer.token);
    await owner.post(`/api/members/${s.member.id}/promote`);
    await owner.post(`/api/members/${s.member.id}/demote`);
    await officer.post('/api/guild/invite/reset');
    await owner.post(`/api/members/${s.member.id}/remove`);

    const r = await officer.get('/api/admin');
    const actions = r.body.audit.entries.map((a) => a.action);
    assert.deepEqual(actions.slice(0, 4), ['removed from guild', 'invite link replaced', 'demoted to member', 'promoted to officer']);
    const first = r.body.audit.entries[0];
    assert.equal(first.battletag, 'Owner#1111');
    assert.equal(first.name, 'Owner');
    assert.equal(first.detail, 'Member#3333');
    assert.match(first.created_at, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
    assert.equal(r.body.audit.nextBefore, null);

    // 120 more rows: the first page has 50, then pages continue where the last ended.
    const ins = srv.db.prepare('INSERT INTO audit_log (guild_id, user_id, action, detail) VALUES (?,?,?,?)');
    for (let i = 0; i < 120; i++) ins.run(s.guildId, i % 2 ? s.owner.id : null, 'test action', `#${i}`);
    const page1 = (await officer.get('/api/admin')).body.audit;
    assert.equal(page1.entries.length, 50);
    assert.equal(page1.entries[0].detail, '#119');
    assert.equal(page1.entries[1].name, 'system', 'rows without a person show as system');
    const page2 = (await officer.get(`/api/admin/audit?before=${page1.nextBefore}`)).body;
    assert.equal(page2.entries.length, 50);
    assert.equal(page2.entries[0].id, page1.entries[49].id - 1);
    const rest = (await officer.get(`/api/admin/audit?before=${page2.nextBefore}&limit=200`)).body;
    assert.equal(rest.entries.length, 24);
    assert.equal(rest.nextBefore, null);
    assert.equal((await officer.get('/api/admin?before=nope')).status, 400);
    assert.equal((await officer.get('/api/admin/audit?before=x')).status, 400);
    // Other guilds' rows never show (only one guild per server, but every row keeps guild_id).
    const other = srv.db.prepare("INSERT INTO guilds (name, invite_code) VALUES ('other', 'OTHER')").run().lastInsertRowid;
    ins.run(other, null, 'secret', 'not yours');
    assert.ok(!(await officer.get('/api/admin')).body.audit.entries.some((a) => a.action === 'secret'));
  } finally { await srv.close(); }
});

// ---------- backups ----------

test('backups: officers make them, only the owner downloads, and names are checked', async () => {
  const tmp = tempDbFile();
  const srv = await startServer({ dbFile: tmp.file });
  try {
    const s = seed(srv.db);
    const owner = client(srv.url, s.owner.token);
    const officer = client(srv.url, s.officer.token);

    let r = await officer.get('/api/admin');
    assert.equal(r.body.backupsEnabled, true);
    assert.equal(r.body.canDownloadBackups, false);
    assert.deepEqual(r.body.backups, []);

    const made = await officer.post('/api/admin/backups');
    assert.equal(made.status, 200);
    assert.equal(made.body.message, 'Backup made.');
    const file = made.body.backup.file;
    assert.match(file, /^wow-\d{8}-\d{6}\.db$/);
    assert.ok(made.body.backup.size > 0);
    assert.ok(fs.existsSync(path.join(tmp.dir, 'backups', file)), 'next to the database, in backups/');
    r = await owner.get('/api/admin');
    assert.equal(r.body.canDownloadBackups, true);
    assert.deepEqual(r.body.backups.map((b) => b.file), [file]);
    assert.ok(!Number.isNaN(Date.parse(r.body.backups[0].created)));
    assert.ok(srv.db.prepare("SELECT 1 FROM audit_log WHERE action = 'backup made' AND detail = ?").get(file));

    const dl = await owner.raw('GET', `/api/admin/backups/${file}`);
    assert.equal(dl.status, 200);
    assert.match(dl.headers.get('content-disposition'), new RegExp(`^attachment; filename="?${file}"?$`));
    assert.equal(dl.headers.get('cache-control'), 'no-store');
    assert.ok(dl.body.startsWith('SQLite format 3'), 'the file is the database snapshot');
    assert.ok(srv.db.prepare("SELECT 1 FROM audit_log WHERE action = 'downloaded backup' AND detail = ?").get(file));

    const denied = await officer.get(`/api/admin/backups/${file}`);
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error, 'Only the guild owner can download backups.');
    assert.equal((await client(srv.url, s.member.token).get(`/api/admin/backups/${file}`)).status, 403);
    assert.equal((await owner.get('/api/admin/backups/..%2Fwow.db')).status, 404);
    assert.equal((await owner.get('/api/admin/backups/wow.db')).status, 404);
    assert.equal((await owner.get('/api/admin/backups/wow-20200101-000000.db')).status, 404);
    fs.writeFileSync(path.join(tmp.dir, 'backups', 'notes.txt'), 'x');
    assert.equal((await owner.get('/api/admin/backups/notes.txt')).status, 404);
  } finally { await srv.close(); tmp.cleanup(); }
});

test('backups need a database file: an in-memory server says so instead of writing somewhere odd', async () => {
  const srv = await startServer();
  try {
    const s = seed(srv.db);
    const owner = client(srv.url, s.owner.token);
    const r = await owner.get('/api/admin');
    assert.equal(r.body.backupsEnabled, false);
    assert.deepEqual(r.body.backups, []);
    const made = await owner.post('/api/admin/backups');
    assert.equal(made.status, 409);
    assert.match(made.body.error, /database file/);
  } finally { await srv.close(); }
});

// ---------- fresh start ----------

test('fresh start: owner only, needs the guild name, backs up first, wipes game data and keeps people', async () => {
  const tmp = tempDbFile();
  const srv = await startServer({ dbFile: tmp.file });
  try {
    const db = srv.db;
    const s = seed(db, { guildName: 'Camp Fire' });
    const owner = client(srv.url, s.owner.token);
    const key = addLegacyKey(db, s.member.id, s.guildId);
    const before = Math.floor(Date.now() / 1000) - 3600;
    const retail = {
      characters: { Testy: { name: 'Testy', class: 'MAGE', level: 80, realm: 'Ragnaros', guild: 'Test Guild', updated: before,
        inventory: { bags: [{ id: 2589, name: 'Linen Cloth', count: 5 }] }, professions: { Tailoring: { rank: 300, max: 300 } }, recipes: { Tailoring: [{ name: 'Linen Belt' }] } } },
      roster: { scannedAt: before, guild: 'Test Guild', members: [{ name: 'Testy', level: 80, class: 'MAGE', online: true }] },
      prices: { items: [[2589, 100, 2000]] },
      ctaQueue: [{ at: before, character: 'Testy', zone: 'Orgrimmar', msg: 'test', needed: 5 }],
    };
    applyPayload(db, s.guildId, s.owner.id, retail);
    db.prepare("INSERT INTO raids (guild_id, title, instance, starts_at, created_by) VALUES (?, 'Test raid', 'MC', '2026-11-10T19:00:00Z', ?)").run(s.guildId, s.owner.id);
    db.prepare("UPDATE guilds SET realm = 'Ragnaros', game_guild = 'Test Guild', discord_webhook = 'https://discord.com/api/webhooks/1/a' WHERE id = ?").run(s.guildId);
    assert.ok(db.prepare('SELECT COUNT(*) n FROM characters').get().n > 0);

    // Officers and members can't; the owner must type the guild name.
    const off = await client(srv.url, s.officer.token).post('/api/admin/reset', { confirm: 'Camp Fire' });
    assert.equal(off.status, 403);
    assert.match(off.body.error, /Only the guild owner/);
    assert.equal((await client(srv.url, s.member.token).post('/api/admin/reset', { confirm: 'Camp Fire' })).status, 403);
    for (const confirm of [undefined, '', 'WIPE', 'Camp', 42]) {
      const bad = await owner.post('/api/admin/reset', { confirm });
      assert.equal(bad.status, 400, String(confirm));
      assert.equal(bad.body.error, 'Nothing was wiped. Type the guild name (Camp Fire) to confirm.');
    }
    assert.ok(db.prepare('SELECT COUNT(*) n FROM characters').get().n > 0, 'nothing wiped yet');
    assert.equal(fs.existsSync(path.join(tmp.dir, 'backups')), false, 'no backup for a refused wipe');

    const r = await owner.post('/api/admin/reset', { confirm: '  camp fire ' });
    assert.equal(r.status, 200);
    assert.ok(r.body.rows > 0);
    assert.match(r.body.backup, /^wow-\d{8}-\d{6}\.db$/);
    assert.ok(fs.existsSync(path.join(tmp.dir, 'backups', r.body.backup)), 'backup written first');
    assert.match(r.body.message, /^Fresh start done: \d+ rows of game data removed \(backup wow-.+\.db kept\)\. Members, settings, devices and sync keys are untouched\.$/);
    assert.equal(r.body.removed.characters, 1);
    for (const t of ['characters', 'inventory', 'recipes', 'professions', 'raids', 'prices', 'ctas', 'activity']) {
      assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n, 0, t);
    }
    assert.equal(db.prepare('SELECT COUNT(*) n FROM memberships').get().n, 3);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM api_tokens').get().n, 1);
    const g = db.prepare('SELECT * FROM guilds WHERE id = ?').get(s.guildId);
    assert.equal(g.invite_code, s.inviteCode);
    assert.equal(g.discord_webhook, 'https://discord.com/api/webhooks/1/a', 'settings stay');
    assert.equal(g.realm, null);
    assert.ok(g.reset_at);
    const audit = db.prepare("SELECT detail FROM audit_log WHERE action = 'wiped guild data for a fresh start'").get();
    assert.match(audit.detail, /^\d+ rows, backup wow-/);
    // Devices still work, and the old sync key is still there for the member who has one.
    assert.equal((await owner.get('/api/me')).status, 200);
    assert.ok(db.prepare('SELECT 1 FROM api_tokens WHERE prefix = ?').get(key.slice(0, 10)));
    // The old SavedVariables uploading again brings nothing back.
    applyPayload(db, s.guildId, s.owner.id, retail);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM characters').get().n, 0);
    // The safety copy shows in the backup list.
    assert.deepEqual((await owner.get('/api/admin')).body.backups.map((b) => b.file), [r.body.backup]);
  } finally { await srv.close(); tmp.cleanup(); }
});

// ---------- Blizzard and game data ----------

test('Blizzard check: officers run it, the status is saved, and failures say what went wrong', async () => {
  const B = fakeBlizzard({ realmUp: true, ns: 'camelot' });
  const srv = await startServer({ ...BNET, fetch: B.fetchImpl });
  try {
    const s = seed(srv.db);
    const officer = client(srv.url, s.officer.token);
    let r = await officer.get('/api/admin');
    assert.deepEqual(r.body.blizzard, { configured: true, region: 'eu', status: null });

    r = await officer.post('/api/admin/blizzard');
    assert.equal(r.status, 200);
    assert.equal(r.body.message, 'Blizzard API checked.');
    assert.equal(r.body.blizzard.status.ok, true);
    assert.equal(r.body.blizzard.status.tokenGold, 250000);
    assert.equal(r.body.blizzard.status.forever, 'static-camelot-eu');
    assert.equal(blizzard.load(srv.db).foreverKey, 'camelot');
    // With a Forever namespace, game data switches to it.
    assert.equal(r.body.gameData.namespaces.label, 'WoW: Forever');
    assert.equal(r.body.gameData.liveData, true);

    B.state.fail = true;
    r = await officer.post('/api/admin/blizzard');
    assert.equal(r.status, 502);
    assert.match(r.body.error, /^Blizzard API check failed: /);
    assert.equal(blizzard.load(srv.db).forever, 'static-camelot-eu', 'a failed check keeps the last good status');
  } finally { await srv.close(); }
});

test('Blizzard check without a Battle.net app saves a "not configured" status', async () => {
  const srv = await startServer({ bnetClientId: '', bnetClientSecret: '', fetch: async () => { throw new Error('no outside calls'); } });
  try {
    const s = seed(srv.db);
    const r = await client(srv.url, s.owner.token).post('/api/admin/blizzard');
    assert.equal(r.status, 200);
    assert.equal(r.body.blizzard.configured, false);
    assert.equal(r.body.blizzard.status.ok, false);
    assert.deepEqual(r.body.blizzard.status.notes, ['No Battle.net app configured.']);
    const refresh = await client(srv.url, s.owner.token).post('/api/admin/gamedata/refresh');
    assert.equal(refresh.status, 200);
    assert.match(refresh.body.message, /No Battle\.net app/);
  } finally { await srv.close(); }
});

test('game data: officers set the realm, refresh realm status and the official roster; the realm coming back notifies', async () => {
  const B = fakeBlizzard({ realmUp: true, ns: 'forever' });
  const srv = await startServer({ ...BNET, fetch: B.fetchImpl });
  try {
    const db = srv.db;
    const s = seed(db);
    const officer = client(srv.url, s.officer.token);
    db.prepare("INSERT INTO characters (guild_id, user_id, name, class, level) VALUES (?, ?, 'Grommash', 'WARRIOR', 58)").run(s.guildId, s.owner.id);

    // No realm yet.
    let r = await officer.post('/api/admin/gamedata/refresh');
    assert.equal(r.body.message, 'Save the realm name first, then refresh.');
    assert.equal(B.calls.length, 0);

    assert.equal((await officer.put('/api/guild/settings', { realm: "Zul'jin", game_guild: 'wow' })).status, 200);
    // Forever isn't in the API yet: nothing realm-related is asked for.
    r = await officer.post('/api/admin/gamedata/refresh');
    assert.match(r.body.message, /doesn’t have WoW: Forever realms yet/);
    assert.equal(r.body.gameData.liveData, false);
    assert.match(r.body.gameData.namespaces.label, /Classic Era/);
    assert.ok(!B.calls.some((c) => c.includes('/realm/')));

    blizzard.save(db, { foreverKey: 'forever', forever: 'static-forever-eu', region: 'eu' });
    r = await officer.post('/api/admin/gamedata/refresh');
    assert.equal(r.status, 200);
    assert.match(r.body.message, /Official roster: 2 members/);
    const gd = r.body.gameData;
    assert.equal(gd.realm, "Zul'jin");
    assert.equal(gd.game_guild, 'wow');
    assert.equal(gd.realm_status.up, true);
    assert.equal(gd.realm_status.queue, true);
    assert.equal(gd.realm_status.slug, 'zuljin');
    assert.equal(gd.official_roster_note, '2 members');
    assert.equal(gd.officialRosterMembers, 2);
    const chars = Object.fromEntries(db.prepare('SELECT name, level, class, user_id FROM characters').all().map((c) => [c.name, c]));
    assert.equal(chars.Newbie.class, 'MAGE');
    assert.equal(chars.Grommash.level, 60, 'levels only go up');
    assert.equal(chars.Grommash.user_id, s.owner.id);

    // The same status reaches Guild settings.
    const st = (await officer.get('/api/admin/status')).body;
    assert.equal(st.gameData.realm_status.name, "Zul'jin");
    assert.equal(st.blizzard.configured, true);

    // The realm goes down, then comes back: everyone gets a 'notice' notification.
    B.state.realmUp = false;
    await srv.ctx.services.admin.gameRun({ only: 'realm' });
    assert.equal(db.prepare("SELECT COUNT(*) n FROM events WHERE kind = 'notice'").get().n, 0);
    B.state.realmUp = true;
    await srv.ctx.services.admin.gameRun({ only: 'realm' });
    const ev = db.prepare("SELECT * FROM events WHERE kind = 'notice'").get();
    assert.match(ev.title, /Zul'jin is back up/);
    assert.match(ev.body, /queue/);
    assert.equal(ev.route, '/');
    const seen = await client(srv.url, s.member.token).get('/api/events?after=0');
    assert.ok(seen.body.events.some((e) => /back up/.test(e.title)));

    // Blizzard failing mid-refresh is reported per part, not as a crash.
    B.state.fail = true;
    r = await officer.post('/api/admin/gamedata/refresh');
    assert.equal(r.status, 200);
    assert.match(r.body.message, /failed/);
  } finally { await srv.close(); }
});

// ---------- AI usage ----------

test('AI usage shows this month’s spend against the Coach budget', async () => {
  const srv = await startServer({ anthropicKey: 'sk-test' });
  try {
    const s = seed(srv.db);
    const ins = srv.db.prepare("INSERT INTO ai_usage (guild_id, user_id, kind, model, cost_usd, created_at) VALUES (?,?,?,?,?, datetime('now', ?))");
    ins.run(s.guildId, s.member.id, 'question', 'claude-haiku-5-5', 0.75, '0 seconds');
    ins.run(s.guildId, s.member.id, 'plan', 'claude-sonnet-5-5', 1.5, '0 seconds');
    ins.run(s.guildId, s.member.id, 'plan', 'claude-sonnet-5-5', 9, '-40 days');
    await client(srv.url, s.owner.token).put('/api/guild/settings', { coach_enabled: true, coach_budget_usd: 20 });
    const { ai } = (await client(srv.url, s.officer.token).get('/api/admin')).body;
    assert.equal(ai.hasKey, true);
    assert.equal(ai.coach_enabled, 1);
    assert.equal(ai.coach_budget_usd, 20);
    assert.equal(ai.spentUsd, 2.25);
    assert.match(ai.month, /^\d{4}-\d\d$/);
    assert.deepEqual(ai.limits, { questionsPerDay: 30, plansPerDay: 5 });
  } finally { await srv.close(); }
});

// ---------- background jobs ----------

test('background jobs start only when timers are on, and stop on close', async () => {
  const tmp = tempDbFile();
  const off = await startServer({ routes: ['admin'], dbFile: tmp.file });
  assert.equal(off.ctx.timers.length, 0);
  await off.close();
  const on = await startServer({ routes: ['admin'], timers: true, dbFile: tmp.file, fetch: async () => { throw new Error('offline'); } });
  try {
    // backups (start + hourly), Blizzard (start + daily), game data (start + hourly + realm every 5 min)
    assert.equal(on.ctx.timers.length, 7);
  } finally { await on.close(); tmp.cleanup(); }
  assert.equal(on.ctx.timers.length, 0);
  // No database file → no backup timers.
  const mem = await startServer({ routes: ['admin'], timers: true, fetch: async () => { throw new Error('offline'); } });
  try { assert.equal(mem.ctx.timers.length, 5); } finally { await mem.close(); }
});

// ---------- calendar ----------

test('calendar: a private feed link per member, public .ics with my sign-ups, and replacing it kills the old one', async () => {
  const srv = await startServer({ baseUrl: 'https://wow.example' });
  try {
    const db = srv.db;
    const s = seed(db);
    const member = client(srv.url, s.member.token);
    const anon = client(srv.url);

    assert.equal((await anon.get('/api/calendar')).status, 401);
    const stranger = addUser(db, 'Stranger#4444');
    assert.equal((await client(srv.url, stranger.token).get('/api/calendar')).status, 403);

    const a = await member.get('/api/calendar');
    assert.equal(a.status, 200);
    assert.match(a.body.url, /^https:\/\/wow\.example\/calendar\/[\w-]{24}\.ics$/);
    assert.equal(a.body.webcalUrl, a.body.url.replace('https:', 'webcal:'));
    assert.match(a.body.googleUrl, /^https:\/\/calendar\.google\.com\/calendar\/r\?cid=webcal%3A%2F%2Fwow\.example/);
    assert.equal((await member.get('/api/calendar')).body.url, a.body.url, 'the same link every time');
    assert.notEqual((await client(srv.url, s.owner.token).get('/api/calendar')).body.url, a.body.url, 'each member has their own');

    const soon = new Date(Date.now() + 3 * 86400000).toISOString();
    const raid = db.prepare("INSERT INTO raids (guild_id, title, instance, starts_at, created_by) VALUES (?, 'Hyjal week 1', 'Hyjal Summit', ?, ?)").run(s.guildId, soon, s.owner.id).lastInsertRowid;
    db.prepare("INSERT INTO raids (guild_id, title, instance, starts_at, created_by) VALUES (?, 'Ancient raid', 'MC', ?, ?)").run(s.guildId, new Date(Date.now() - 60 * 86400000).toISOString(), s.owner.id);
    db.prepare("INSERT INTO signups (raid_id, user_id, character, role, status) VALUES (?, ?, 'Bravo', 'dps', 'yes')").run(raid, s.member.id);

    const feedPath = new URL(a.body.url).pathname;
    const feed = await anon.get(feedPath);
    assert.equal(feed.status, 200);
    assert.match(feed.headers.get('content-type'), /^text\/calendar/);
    assert.equal(feed.headers.get('cache-control'), 'private, max-age=600');
    assert.match(feed.body, /^BEGIN:VCALENDAR\r\n/);
    assert.match(feed.body, /SUMMARY:Raid: Hyjal week 1/);
    assert.match(feed.body, /You’re coming\. 1 coming\./);
    assert.match(feed.body, /X-WR-CALNAME:wow raids/);
    assert.doesNotMatch(feed.body, /Ancient raid/, 'only the last 30 days on');

    for (const bad of ['/calendar/not-a-real-token-at-all-xx.ics', '/calendar/short.ics', '/calendar/..%2F..%2Fetc.ics']) {
      const r = await anon.get(bad);
      assert.equal(r.status, 404, bad);
      assert.match(r.body, /Calendar not found/);
    }

    const reset = await member.post('/api/calendar/reset');
    assert.equal(reset.status, 200);
    assert.notEqual(reset.body.url, a.body.url);
    assert.match(reset.body.message, /old link stopped working/);
    assert.equal((await anon.get(feedPath)).status, 404);
    assert.equal((await anon.get(new URL(reset.body.url).pathname)).status, 200);
    assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'calendar link replaced' AND user_id = ?").get(s.member.id));

    // Someone who leaves the guild loses the feed.
    await client(srv.url, s.owner.token).post(`/api/members/${s.member.id}/remove`);
    assert.equal((await anon.get(new URL(reset.body.url).pathname)).status, 404);
  } finally { await srv.close(); }
});
