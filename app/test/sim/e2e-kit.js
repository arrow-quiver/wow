'use strict';
// Scenario 13 kit (docs/SHARING.md §13): the REAL pieces end to end, on one virtual clock.
//
//   GuildNet clients running the real addon  ⇄  each account's SavedVariables file on disk  →  the app's REAL
//   sync engine (src/main/sync.js, built by main.js's createAppSync, so the core's 'outbox' event is wired as
//   in the app)  →  that player's local core (createCore in a temp folder)  →  Inbox.lua on disk  →  the addon
//   at its next login or /reload.
//
//   const kit = await createE2E(t, { seed: 13, net: { startTime } });   // every core's clock is the net's clock
//   const grom = await kit.player('Grom', {                 // one person: one PC, one app, one game folder
//     accounts: { GROM: [['Grommash', { rank: 1 }], ['Grommalt', { rank: 3 }]] },
//     settings: { discordWebhook },                          // the app's settings (optional)
//   });
//   grom.login('Grommash'); kit.net.run(30);                // the PC's Inbox.lua goes in, the character logs in
//   await grom.logout('Grommash');                          // logout, SavedVariables to disk, the app syncs,
//                                                           // Inbox.lua back into the game folder
//   await grom.reload('Grommash');                          // /reload: the same, and the game loads again
//   await grom.api('POST', '/api/raids', {...});            // the app's own HTTP client (main/api.js)
//   await grom.flush();                                     // the 'outbox' event's inbox rewrite has happened
//   grom.inbox() / grom.tables() / grom.discord / grom.wipeAccount('GROM')
//   await kit.assertSame([players...])                      // §13: equal digests, equal domain tables
//
// Safety: every folder is under the OS temp folder (fs.mkdtemp) and removed afterwards; the sync engine runs
// with scanDefaults: false, so a real game install is never looked at. No network: the cores get a fetch
// stand-in that records Discord posts and refuses everything else.
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createGuildNet, canonical, ADDON_DIR } = require('./guildnet');
const { createCore } = require('../../src/core');
const sharing = require('../../src/core/sharing');
const { createAppSync } = require('../../src/main/main'); // main.js's own wiring of sync.js to the core
const wow = require('../../src/main/wow');
const { createApi } = require('../../src/main/api');
const { createStore } = require('../../src/main/store');
const { parseSavedVariables } = require('../../src/shared/lua');
const S = require('../../src/shared/sharing');

const APP_VERSION = '0.12.0';
const quiet = { info() {}, warn() {}, error() {}, debug() {}, scope() { return quiet; } };

// A WoW folder laid out like the real one: <root>/_forever_/{Interface/AddOns/WowGuild, WTF/Account/<ACC>/SavedVariables}.
function makeGameFolder(root) {
  const dir = path.join(root, '_forever_');
  const addonsDir = path.join(dir, 'Interface', 'AddOns');
  fs.mkdirSync(path.join(addonsDir, 'WowGuild'), { recursive: true });
  fs.copyFileSync(path.join(ADDON_DIR, 'WowGuild.toc'), path.join(addonsDir, 'WowGuild', 'WowGuild.toc'));
  return {
    root,
    dir,
    svFile: (account) => path.join(dir, 'WTF', 'Account', account, 'SavedVariables', 'WowGuild.lua'),
    inboxFile: path.join(addonsDir, 'WowGuild_Inbox', 'Inbox.lua'),
  };
}

/**
 * The domain tables two apps must agree on after the same records (§13). Rows are keyed by share_id or by
 * character name, never by local integer ids, and people are named by pid (or character), so two databases
 * built in different orders compare equal.
 */
function domainTables(db) {
  const g = db.prepare('SELECT * FROM guilds ORDER BY id LIMIT 1').get();
  if (!g) return null;
  const gid = g.id;
  const pidOf = (uid) => {
    if (uid == null) return null;
    const p = sharing.pidOf(db, uid);
    if (p) return p;
    const u = db.prepare('SELECT bnet_id FROM users WHERE id = ?').get(uid);
    return u ? u.bnet_id : null;
  };
  const rows = (sql, ...args) => db.prepare(sql).all(...args);
  const raidKey = new Map(rows('SELECT id, share_id FROM raids WHERE guild_id = ?', gid).map((r) => [r.id, r.share_id]));
  const lootKey = new Map(rows('SELECT id, item_key, name FROM loot_items WHERE guild_id = ?', gid).map((r) => [r.id, r.item_key || r.name]));
  const driveKey = new Map(rows('SELECT id, share_id FROM drives WHERE guild_id = ?', gid).map((r) => [r.id, r.share_id]));
  const sortBy = (list) => list.sort((a, b) => (canonical(a) < canonical(b) ? -1 : 1));
  return {
    guild: { officer_rank_max: g.officer_rank_max, relay_rank_max: g.relay_rank_max },
    raids: sortBy(rows('SELECT * FROM raids WHERE guild_id = ?', gid).map((r) => ({
      key: r.share_id, title: r.title, instance: r.instance, starts_at: r.starts_at, status: r.status, locked_at: r.locked_at, kind: r.kind, size: r.size,
      sr_limit: r.sr_limit, minutes: r.duration_min, notes: r.notes || null,
    }))),
    signups: sortBy(rows('SELECT s.* FROM signups s JOIN raids r ON r.id = s.raid_id WHERE r.guild_id = ?', gid).map((s) => ({
      raid: raidKey.get(s.raid_id), who: pidOf(s.user_id), status: s.status, role: s.role, note: s.note || null, reserves_at: s.reserves_at,
    }))),
    reserves: sortBy(rows('SELECT rs.* FROM reserves rs JOIN raids r ON r.id = rs.raid_id WHERE r.guild_id = ?', gid).map((x) => ({
      raid: raidKey.get(x.raid_id), who: pidOf(x.user_id), item: lootKey.get(x.item_id),
    }))),
    attendance: sortBy(rows('SELECT a.* FROM attendance a JOIN raids r ON r.id = a.raid_id WHERE r.guild_id = ?', gid).map((a) => ({
      raid: raidKey.get(a.raid_id), who: pidOf(a.user_id),
    }))),
    loot_items: sortBy(rows('SELECT * FROM loot_items WHERE guild_id = ?', gid).map((l) => ({ instance: l.instance, key: l.item_key, name: l.name, boss: l.boss || null }))),
    loot_log: sortBy(rows('SELECT * FROM loot_log WHERE guild_id = ?', gid).map((l) => ({ key: l.share_id, raid: raidKey.get(l.raid_id), item: l.item_name, who: pidOf(l.user_id), kind: l.kind, bonus: l.bonus }))),
    loyalty: sortBy(rows('SELECT * FROM loyalty WHERE guild_id = ?', gid).map((l) => ({ who: pidOf(l.user_id), item: lootKey.get(l.item_id), bonus: l.bonus }))
      .filter((l) => l.bonus)),
    craft_requests: sortBy(rows('SELECT * FROM craft_requests WHERE guild_id = ?', gid).map((r) => ({
      key: r.share_id, item: r.item, status: r.status, requester: pidOf(r.requester_id), crafter: pidOf(r.crafter_id),
    }))),
    announcements: sortBy(rows('SELECT * FROM announcements WHERE guild_id = ?', gid).map((a) => ({ key: a.share_id, body: a.body }))),
    ctas: sortBy(rows('SELECT * FROM ctas WHERE guild_id = ?', gid).map((c) => ({ key: c.client_ref, zone: c.zone, message: c.message, needed: c.needed }))),
    drives: sortBy(rows('SELECT * FROM drives WHERE guild_id = ?', gid).map((d) => ({ key: d.share_id, title: d.title, goal: d.goal, status: d.status }))),
    drive_contribs: sortBy(rows('SELECT * FROM drive_contribs WHERE drive_id IN (SELECT id FROM drives WHERE guild_id = ?)', gid).map((d) => ({
      key: d.share_id, drive: driveKey.get(d.drive_id), amount: d.amount,
    }))),
    bank_requests: sortBy(rows('SELECT * FROM bank_requests WHERE guild_id = ?', gid).map((b) => ({ key: b.share_id, item: b.item, status: b.status }))),
    // People: every player id seen, with the characters linked to it.
    players: sortBy(rows("SELECT c.name, c.user_id FROM characters c WHERE c.guild_id = ? AND c.user_id IS NOT NULL", gid)
      .map((c) => ({ character: c.name, who: pidOf(c.user_id) })).filter((c) => c.who && !String(c.who).startsWith('char:'))),
  };
}

async function createE2E(t, { seed = 13, net: netOptions = {} } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-e2e-share-'));
  const net = createGuildNet({ seed, ...netOptions, startTime: netOptions.startTime ?? Math.floor(Date.now() / 1000) });
  // Every core's clock is the game server's clock, so versions, expiry and "t ≤ now" agree with the addon.
  sharing.setClock(() => Math.round(net.clock.serverTime() * 1000));
  const players = [];

  t.after(async () => {
    for (const p of players) await p.close();
    sharing.setClock();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* Windows may hold a file a moment */ }
  });

  async function player(name, { accounts, interface: iface, settings = {} } = {}) {
    const home = path.join(tmp, name);
    const game = makeGameFolder(path.join(home, 'World of Warcraft'));
    const discord = [];
    const core = await createCore({
      dataDir: path.join(home, 'userData'),
      log: quiet,
      getIdentity: () => null,
      getSecret: () => null,
      getSettings: () => settings,
      credentials: null,
      getLatest: () => ({ app: null, addon: null }),
      timers: false,
      fetch: async (url, init = {}) => {
        if (!String(url).startsWith('https://discord.com/api/webhooks/')) throw new Error(`No network in tests (${url}).`);
        discord.push(JSON.parse(init.body).content);
        return { ok: true, status: 204, json: async () => ({}), text: async () => '' };
      },
    });
    const store = createStore(path.join(home, 'userData'));
    store.set({ extraWowFolders: [game.root] });
    const api = createApi({ getBase: () => core.url, getToken: () => core.token, appVersion: APP_VERSION, log: quiet });
    const sync = createAppSync({ api, store, log: quiet, wow, appVersion: APP_VERSION, core, scanDefaults: false, outboxDelayMs: 5 });
    let inboxWrites = 0;
    sync.on('log', (m) => { if (/Guild news saved/.test(m)) inboxWrites++; });

    const clients = new Map();
    const accountOf = new Map();
    for (const [account, chars] of Object.entries(accounts || { [name.toUpperCase()]: [[name, {}]] })) {
      for (const [cname, opts] of chars) {
        const c = net.client(cname, { interface: iface, ...opts, account, pc: name });
        clients.set(cname, c);
        accountOf.set(cname, account);
      }
    }

    let saves = 0;
    const p = {
      name, core, db: core.db, sync, store, discord, game, net,
      c: (cname) => clients.get(cname),
      clients: () => [...clients.values()],
      // The app's own HTTP client, as the renderer's pages use it through IPC: resolves the JSON body.
      api: (method, url, body) => api.request(method, url, body),
      // What WoW does at logout or /reload: write the account's file (each save a later mtime, as in game).
      writeSv(cname) {
        const c = clients.get(cname);
        const text = c.svText();
        if (text == null) return false;
        const file = game.svFile(accountOf.get(cname));
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, text);
        saves++;
        const when = new Date(Date.now() + saves * 2000);
        fs.utimesSync(file, when, when);
        return true;
      },
      // The app notices the new file, uploads it, and writes Inbox.lua; the game reads it at the next load.
      async syncNow() {
        await sync.syncNow();
        p.feedInbox();
      },
      // Inbox.lua on disk → the GuildNet PC's inbox (what the addon reads at its next login or /reload).
      feedInbox() {
        if (!fs.existsSync(game.inboxFile)) return;
        const text = fs.readFileSync(game.inboxFile, 'utf8');
        const any = clients.values().next().value;
        any.setInbox(text);
      },
      inbox() { return fs.existsSync(game.inboxFile) ? parseSavedVariables(fs.readFileSync(game.inboxFile)).WowGuildInbox : null; },
      async logout(cname) { clients.get(cname).logout(); p.writeSv(cname); await p.syncNow(); },
      async reload(cname) {
        // /reload: SavedVariables written, the app syncs between the write and the load only if it is quick;
        // the game reads the Inbox.lua that is on disk at that moment.
        p.feedInbox();
        clients.get(cname).reload();
        p.writeSv(cname);
        await p.syncNow();
      },
      login(cname) { p.feedInbox(); clients.get(cname).login(); return clients.get(cname); },
      // The account's WTF folder is wiped (a reinstall): no SavedVariables in the game or on disk.
      wipeAccount(account) {
        net._account(account).sv = null;
        for (const [cname, acc] of accountOf) if (acc === account) clients.get(cname).svChar = null;
        fs.rmSync(path.dirname(game.svFile(account)), { recursive: true, force: true });
      },
      // The inbox rewrite the core's 'outbox' event starts (outboxDelayMs later) has finished.
      async flush() {
        await new Promise((r) => setTimeout(r, 30));
        await sync.whenIdle();
        p.feedInbox();
      },
      get inboxWrites() { return inboxWrites; },
      tables: () => domainTables(core.db),
      async close() {
        sync.stop();
        await sync.whenIdle();
        await core.close();
      },
    };
    players.push(p);
    return p;
  }

  // The real core run on one SavedVariables file: a fresh app (in memory) that uploads it through POST /api/sync.
  async function tablesOfSv(wowGuildDb, label) {
    const core = await createCore({
      dbFile: ':memory:', log: quiet, getIdentity: () => null, getSecret: () => null, getSettings: () => ({}), credentials: null,
      getLatest: () => ({ app: null, addon: null }), timers: false,
      fetch: async (url) => { throw new Error(`No network in tests (${url}).`); },
    });
    try {
      const api = createApi({ getBase: () => core.url, getToken: () => core.token, appVersion: APP_VERSION, log: quiet });
      await api.request('POST', '/api/sync', { ...wowGuildDb, _source: { account: label, install: 'C:/sim' } });
      return domainTables(core.db);
    } finally {
      await core.close();
    }
  }

  /**
   * §13: every scenario ends by asserting equal digests on all clients and, by running the real core on each
   * client's SavedVariables, equal domain tables. Online clients log out first (their players' apps sync), then
   * every account's file goes through a fresh core; the players' own apps are compared too.
   * → the domain tables (all equal).
   */
  async function assertSame(list = [], { label = '' } = {}) {
    assert.ok(net.converged(), `${label}digests differ: ${JSON.stringify(net.digests())}`);
    const online = net.online();
    for (const c of online) {
      const p = players.find((x) => x.c(c.name) === c);
      if (p) await p.logout(c.name); else c.logout();
    }
    const tables = [];
    const accounts = new Set();
    for (const c of online) {
      if (accounts.has(c.account)) continue;
      accounts.add(c.account);
      const db = c.sv();
      if (db && db.shared) tables.push([`the core on ${c.account}'s SavedVariables`, await tablesOfSv(db, c.account)]);
    }
    for (const p of list) tables.push([`${p.name}'s app`, p.tables()]);
    const [firstName, first] = tables[0];
    for (const [n, tbl] of tables.slice(1)) {
      for (const k of Object.keys(first)) {
        if (k === 'players') continue; // each app also links its own characters from its own uploads
        assert.deepStrictEqual(tbl[k], first[k], `${label}${k}: ${n} differs from ${firstName}`);
      }
    }
    return first;
  }

  return { net, tmp, player, assertSame, tablesOfSv, S };
}

module.exports = { createE2E, domainTables, makeGameFolder };
