'use strict';
// Shared setup for the sharing engine tests (test/core/sharing-*.test.js).
//
//   const h = await setupShare(t, { role: 'officer' });   // core + guild "wow" on Forever, me = Thrallia
//   h.imp([records...], { via, sent, pid, clock, names, file })  → importShared result (in a transaction)
//   h.rec('RD', 'k3f9a2', t, 'Grommash', { ... }, { final, del })  → record string
//   h.chFor('Grommash', 'Grommash.aaaa', { alts })                  → a ch record linking a character
//   h.row(sql, ...args) / h.rows(sql, ...args)
//
// The guild roster (rank indexes): Grommash 0 (Guild Master), Varok 1 (officer), Zuljinne 3, Zulalt 3,
// Jaina 3, Relayer 2, Bankalt 4. My character Thrallia gets the rank of `role` (owner 0, officer 1,
// member 4). The computer clock is fixed at NOW (sharing.setClock) and restored after the test.
const S = require('../../src/shared/sharing');
const sharing = require('../../src/core/sharing');
const { startCore, seedGuild } = require('./helpers');

const NOW = 1794067200;
const D = 86400;
const G = 'Forever/wow';
const ROSTER = [['Grommash', 0], ['Varok', 1], ['Relayer', 2], ['Zuljinne', 3], ['Zulalt', 3], ['Jaina', 3], ['Bankalt', 4]];
const PIDS = { Grommash: 'Grommash.g000', Varok: 'Varok.v000', Zuljinne: 'Zuljinne.z000', Jaina: 'Jaina.j000', Relayer: 'Relayer.r000', Bankalt: 'Bankalt.b000' };
const ME_PID = 'Thrallia.t000';

const rec = (type, key, t, author, fields, opts = {}) => S.encode({ type, key, v: S.makeVersion(t, author, !!opts.final), author, del: !!opts.del, fields });

// Set `down = true` for a webhook that answers HTTP 500; `delayMs` makes every post take that long.
function fakeDiscord() {
  const calls = [];
  const d = { calls, down: false, delayMs: 0 };
  d.fetch = async (url, init = {}) => {
    calls.push({ url, body: init.body ? JSON.parse(init.body) : null });
    if (d.delayMs) await new Promise((r) => setTimeout(r, d.delayMs));
    if (d.down) return { ok: false, status: 500, json: async () => ({}), text: async () => '' };
    return { ok: true, status: 204, json: async () => ({}), text: async () => '' };
  };
  return d;
}

async function setupShare(t, { role = 'member', character = 'Thrallia', pid = ME_PID, now = NOW, webhook = null, roster = ROSTER } = {}) {
  let clock = now * 1000;
  sharing.setClock(() => clock);
  const discord = fakeDiscord();
  const settings = webhook ? { discordWebhook: webhook } : {};
  const srv = await startCore({ fetch: discord.fetch, settings });
  t.after(async () => { sharing.setClock(); await srv.close(); });
  const { db, ctx } = srv;
  const g = seedGuild(db, { name: 'wow', realm: 'Forever', role, character });
  const ins = db.prepare(`INSERT INTO characters (guild_id, name, class, level, rank, rank_index) VALUES (?,?, 'WARRIOR', 60, 'r', ?)
    ON CONFLICT (guild_id, name) DO UPDATE SET rank_index = excluded.rank_index`);
  for (const [name, rank] of roster) ins.run(g.guildId, name, rank);
  if (pid) db.prepare("INSERT INTO app_settings (key, value) VALUES ('me_pid', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(pid);
  const outboxEvents = [];
  srv.core.emitter.on('outbox', () => outboxEvents.push(1));

  const h = {
    srv, db, ctx, gid: g.guildId, me: g.me, discord, events: srv.events, outboxEvents, settings, NOW, D, G,
    get clock() { return Math.floor(clock / 1000); },
    setNow(sec) { clock = sec * 1000; },
    rec,
    chFor(name, p, { alts, t = NOW - 600, main, battletag, level = 60, cls = 'WARRIOR', extra = {} } = {}) {
      return rec('ch', name, t, name, { pid: p, battletag, main, alts, class: cls, level, ...extra });
    },
    payload(records, { via = {}, sent = {}, pid: sharedPid, clock: clk, names, g: part = G, stats } = {}) {
      const recs = {};
      const v = {};
      for (const r of records) {
        const p = S.parse(r) || { id: String(r).split('^')[0], author: String(r).split('^')[2] || 'Someone' }; // broken records too
        recs[p.id] = r;
        if (via[p.id] !== null) v[p.id] = via[p.id] || `${p.author},${NOW},d`;
      }
      const out = { v: 1, guilds: { [part]: { recs, via: v, sent, names: names || {}, stats: stats || { peers: 3, lastHello: NOW - 60, lastExchange: NOW - 30 } } } };
      if (sharedPid) out.pid = sharedPid;
      if (clk) out.clock = clk;
      return out;
    },
    imp(records, opts = {}) {
      const p = h.payload(records, opts);
      const r = db.transaction(() => sharing.importShared(db, ctx, p, { file: opts.file || { account: 'ACC', install: 'C:/WoW' } }))();
      sharing.afterImport(ctx, r);
      return r;
    },
    impRaw(p, opts = {}) {
      const r = db.transaction(() => sharing.importShared(db, ctx, p, opts))();
      sharing.afterImport(ctx, r);
      return r;
    },
    row: (sql, ...a) => db.prepare(sql).get(...a),
    rows: (sql, ...a) => db.prepare(sql).all(...a),
    stored: (id) => db.prepare('SELECT * FROM shared_records WHERE guild_id = ? AND id = ?').get(g.guildId, id),
    outbox: () => db.prepare('SELECT * FROM share_outbox ORDER BY created_at, op').all(),
    queue: (args) => db.transaction(() => sharing.queue(db, ctx, args))(),
    userOf: (p) => db.prepare('SELECT id FROM users WHERE bnet_id = ?').get(`pid:${p}`),
    // Links every roster guildmate to their player (their anchor ch).
    linkAll() {
      return h.imp(Object.entries(PIDS).map(([n, p]) => h.chFor(n, p, { alts: [n] })));
    },
  };
  return h;
}

// A bare database (no HTTP server) with the same guild, roster and pid: fast enough to replay hundreds of
// arrival orders. imp(records, opts) imports one upload; ctx is a stand-in that only records events.
function lightDb({ role = 'member', character = 'Thrallia', pid = ME_PID } = {}) {
  const { open } = require('../../src/core/db');
  // The clock is fixed at NOW, as in setupShare, so records made near NOW don't expire by the real date.
  sharing.setClock(() => NOW * 1000);
  const db = open(':memory:');
  const g = seedGuild(db, { name: 'wow', realm: 'Forever', role, character });
  const ins = db.prepare("INSERT INTO characters (guild_id, name, class, level, rank, rank_index) VALUES (?,?, 'WARRIOR', 60, 'r', ?) ON CONFLICT (guild_id, name) DO UPDATE SET rank_index = excluded.rank_index");
  for (const [name, rank] of ROSTER) ins.run(g.guildId, name, rank);
  if (pid) db.prepare("INSERT INTO app_settings (key, value) VALUES ('me_pid', ?)").run(pid);
  const events = [];
  const ctx = { db, emit: (gid, kind, o) => events.push({ kind, ...o }), cfg: { discordWebhook: '' }, log: { warn() {}, info() {}, error() {} }, outboxChanged() {} };
  const imp = (records, { via = {} } = {}) => {
    const recs = {};
    const v = {};
    for (const r of records) {
      const x = S.parse(r);
      recs[x.id] = r;
      v[x.id] = via[x.id] || `${x.author},${NOW},d`;
    }
    return db.transaction(() => sharing.importShared(db, ctx, { guilds: { [G]: { recs, via: v, sent: {} } } }))();
  };
  return { db, ctx, gid: g.guildId, me: g.me, imp, events, close: () => { sharing.setClock(); db.close(); } };
}

// Every order of a list (n ≤ 6).
function permutations(list) {
  if (list.length <= 1) return [list.slice()];
  const out = [];
  list.forEach((x, i) => {
    for (const rest of permutations([...list.slice(0, i), ...list.slice(i + 1)])) out.push([x, ...rest]);
  });
  return out;
}

module.exports = { fakeDiscord, setupShare, lightDb, rec, permutations, NOW, D, G, PIDS, ME_PID, ROSTER };
