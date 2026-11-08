'use strict';
// Helpers for the domain route tests (raids, community, economy, admin) now that guild data is shared through
// the addon (docs/SHARING.md §10): read what a route queued, bring in guildmates' records the way an upload
// does, and answer outbox entries the way the addon does.
//
//   const kit = shareKit(c);                 // c from helpers.startCore(), after seedGuild()
//   kit.queued(type?)        → active outbox entries (queued or waiting), oldest first, decoded:
//                              [{ op, id, type, key, need, base, del, chan, state, note, t, v, author, final, fields }]
//   kit.last(type)           → the newest active entry of that type, or null
//   kit.entry(op)            → any outbox entry by op (also sent, refused, dropped)
//   kit.mate(name, { role, rank, battletag, alts, cls, level }) → { id, pid, name }
//                              a guildmate on the roster (rank index from role: owner 0, officer 1, member 4; or
//                              `rank`) whose ch record links them to a player
//   kit.rec(type, key, fields, { author, t, del }) → a record string (t defaults to a minute ago)
//   kit.imp(records, { sent, via }) → importShared result: one upload, in a transaction, Discord posts sent after
//   kit.ack(entryOrOp, 'ok' | 'no,stale' | 'wait,officer' ...) → imports that acknowledgement
//                              ('ok' becomes ok,<v>,<author> of the change as this computer made it)
//   kit.signup(raidKey, mate, { character, role, status, note, reserves, reservesAt, t }) → imports their su
//   kit.now() / kit.tick(seconds) → the sharing clock (server seconds); it starts at the real time and only
//                              moves with tick(), so the order of actions is the order of their versions
//   kit.restore()            → puts the real clock back (call it when the test ends)
//   kit.settle()             → waits for the Discord posts sent after an import
const S = require('../../src/shared/sharing');
const sharing = require('../../src/core/sharing');
const identity = require('../../src/core/identity');

const RANK_FOR = { owner: 0, officer: 1, member: 4 };
const ROLE_CODE = { tank: 't', healer: 'h', dps: 'd' };
const STATUS_CODE = { yes: 'y', tentative: 't', no: 'n', bench: 'b' };

function shareKit(c) {
  const { db, ctx } = c;
  let clockMs = Date.now();
  sharing.setClock(() => clockMs);
  const now = () => sharing.serverNow(db);
  const gid = () => identity.currentGuild(db).id;
  const part = () => sharing.partitionOf(db, identity.currentGuild(db));

  function decodeRow(r) {
    if (!r) return null;
    const rec = r.record ? S.decode(r.record) : null;
    const i = r.rec_id.indexOf(':');
    return {
      op: r.op, id: r.rec_id, type: r.rec_id.slice(0, i), key: r.rec_id.slice(i + 1), need: r.need || null, base: r.base || '',
      del: Boolean(r.del), chan: r.chan || null, state: r.state, note: r.note || null, t: r.t,
      v: rec ? rec.v : null, author: rec ? rec.author : null, final: rec ? S.isFinalV(rec.v) : false,
      fields: rec && !rec.del ? rec.fields : null, record: r.record,
    };
  }

  const kit = {
    db,
    now,
    tick(seconds = 1) { clockMs += seconds * 1000; return now(); },
    restore() { sharing.setClock(); },
    settle: () => new Promise((r) => setTimeout(r, 20)),
    queued(type) {
      const rows = db.prepare("SELECT * FROM share_outbox WHERE state IN ('queued','waiting') ORDER BY created_at, rowid").all().map(decodeRow);
      return type ? rows.filter((e) => e.type === type) : rows;
    },
    last(type) {
      const list = kit.queued(type);
      return list.length ? list[list.length - 1] : null;
    },
    entry(op) { return decodeRow(db.prepare('SELECT * FROM share_outbox WHERE op = ?').get(op)); },
    rec(type, key, fields, { author, t, del = false } = {}) {
      const tt = t == null ? now() - 60 : t;
      return S.encode({ type, key, v: S.makeVersion(tt, author, !del && S.isFinal({ type, del: false, fields })), author, del, fields: del ? null : fields });
    },
    imp(records = [], { sent = {}, via = {} } = {}) {
      const recs = {};
      const v = {};
      for (const r of records) {
        const p = S.parse(r);
        recs[p.id] = r;
        v[p.id] = via[p.id] || `${p.author},${now()},d`;
      }
      const payload = { v: 1, clock: { server: now(), here: now() }, guilds: { [part()]: { recs, via: v, sent, names: {}, stats: { peers: 3, lastHello: now() - 60, lastExchange: now() - 30 } } } };
      const out = db.transaction(() => sharing.importShared(db, ctx, payload, { file: { account: 'ACC', install: 'C:/WoW' } }))();
      sharing.afterImport(ctx, out);
      return out;
    },
    ack(entry, value = 'ok') {
      const e = typeof entry === 'string' ? kit.entry(entry) : entry;
      const answer = value === 'ok' ? `ok,${e.v},${e.author}` : value;
      return kit.imp([], { sent: { [e.op]: answer } });
    },
    mate(name, { role = 'member', rank, battletag, alts = [], cls = 'MAGE', level = 60 } = {}) {
      const pid = `${name}.${S.toB36(S.djb2(name) % 1679616).padStart(4, '0')}`;
      const roster = db.prepare(`INSERT INTO characters (guild_id, name, class, level, rank, rank_index) VALUES (?,?,?,?,?,?)
        ON CONFLICT (guild_id, name) DO UPDATE SET rank_index = excluded.rank_index`);
      roster.run(gid(), name, cls, level, role, rank == null ? RANK_FOR[role] : rank);
      for (const alt of alts) roster.run(gid(), alt, cls, 10, role, null);
      const t = now() - 300;
      kit.imp([
        kit.rec('ch', name, { pid, battletag, main: true, alts: [name, ...alts], class: cls, level }, { author: name, t }),
        ...alts.map((alt) => kit.rec('ch', alt, { pid, class: cls, level: 10 }, { author: alt, t })),
      ]);
      const u = db.prepare('SELECT id FROM users WHERE bnet_id = ?').get(`pid:${pid}`);
      return { id: u.id, pid, name };
    },
    signup(raidKey, mate, { character = mate.name, role = 'dps', status = 'yes', note, reserves = [], reservesAt, t } = {}) {
      const tt = t == null ? now() - 60 : t;
      return kit.imp([kit.rec('su', `${raidKey}:${mate.pid}`, {
        character, role: ROLE_CODE[role] || role, status: STATUS_CODE[status] || status, note,
        reserves, reservesAt: reserves.length ? (reservesAt == null ? tt : reservesAt) : null,
      }, { author: character, t: tt })]);
    },
  };
  return kit;
}

module.exports = { shareKit, RANK_FOR };
