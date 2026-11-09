'use strict';
// What the app writes into the inbox for the addon (docs/SHARING.md §9): the outbox, who I am, and the
// seed for a store that is far behind.
const S = require('../../shared/sharing');
const identity = require('../identity');
const st = require('./store');
const { ensurePid } = require('./queue');

const SEED_MAX_RECORDS = 3000;
const SEED_MAX_BYTES = 400 * 1024;
const DAY = 86400;

// Entries the game still has to send (not yet 'ok' or 'no'), for every guild: an entry for another guild
// waits in the addon until a character of that guild logs in.
function exportOutbox(db) {
  const rows = db.prepare(`SELECT o.*, g.name, g.realm, g.game_guild, g.id AS gid FROM share_outbox o JOIN guilds g ON g.id = o.guild_id
    WHERE o.state IN ('queued','waiting') ORDER BY o.created_at, o.op`).all();
  return rows.map((r) => {
    const e = { op: r.op, g: st.partitionOf(db, { id: r.gid, name: r.name, realm: r.realm, game_guild: r.game_guild }), id: r.rec_id, t: r.t };
    if (r.need) e.need = r.need;
    e.base = r.base || '';
    if (r.del) e.del = true;
    if (r.chan) e.chan = r.chan;
    if (!r.del) e.body = r.body || '';
    return e;
  });
}

// The addon keeps at most 3 guilds (Share.lua GUILDS_MAX).
const ME_GUILDS_MAX = 3;

// { pid, bt, main, alts } in one guild, or null before a character of mine in it is known. Only my own
// characters of that guild: a character in another guild is never named in this guild's ch.
function meOf(db, g) {
  const pid = ensurePid(db, g.id);
  if (!pid) return null;
  const out = { pid };
  const bt = st.get(db, 'me_battletag');
  if (bt) out.bt = String(bt).slice(0, 32);
  const names = st.myCharacters(db, g.id).filter((n) => S.authorOk(n)).slice(0, 20);
  const mains = new Set(db.prepare('SELECT name FROM characters WHERE guild_id = ? AND user_id = ? AND is_main = 1').all(g.id, identity.meId(db)).map((r) => r.name));
  const anchor = st.anchorOf(pid);
  out.main = names.filter((n) => mains.has(n)).sort()[0] || names[0] || anchor;
  // The anchor lists every character of the player (itself included), so guildmates link them (§3).
  out.alts = [...new Set([anchor, ...names])].filter(Boolean).slice(0, 20);
  return out;
}

// Who I am, for the addon's ch records: the current guild's { pid, bt, main, alts } (also at the top, for older
// readers), g = that guild's partition key, and byG = { [partition]: { pid, bt, main, alts } } for each guild of
// mine the app knows (player ids are per guild; the addon uses the entry of the guild it is in). null before
// any character of mine in the current guild is known.
function exportMe(db) {
  const g = identity.currentGuild(db);
  if (!g) return null;
  const cur = meOf(db, g);
  if (!cur) return null;
  const key = st.partitionOf(db, g);
  const out = { ...cur, g: key, byG: { [key]: cur } };
  for (const row of db.prepare('SELECT * FROM guilds WHERE id != ? ORDER BY COALESCE(last_played_at, 0) DESC, id DESC').all(g.id)) {
    if (Object.keys(out.byG).length >= ME_GUILDS_MAX) break;
    const k = st.partitionOf(db, row);
    if (!k || out.byG[k]) continue;
    const m = meOf(db, row);
    if (m) out.byG[k] = m;
  }
  return out;
}

// §9 seed: when a store this app has seen holds under half the app's records for the guild, the inbox
// carries them (at most 3,000 records or 400 KB, newest first). Officer-space records only when they
// were accepted first-hand or from a trusted relay (or are my own).
function exportSeed(db, guildId) {
  if (!guildId) return [];
  const now = st.serverNow(db);
  const hour = S.hourStart(now);
  const lookup = st.lookupFor(db, guildId);
  const rows = db.prepare("SELECT id, body, how FROM shared_records WHERE guild_id = ? AND state = 'ok'").all(guildId);
  const usable = [];
  for (const r of rows) {
    const type = r.id.slice(0, r.id.indexOf(':'));
    if (type === 'WH') continue; // OFFICER channel only, never in a store's digests
    if (S.spaceOf(type) === 'officer' && !['d', 't', 'o'].includes(r.how)) continue;
    if (S.isExpired(r.body, hour, lookup)) continue;
    usable.push(r);
  }
  const total = rows.filter((r) => !S.isExpired(r.body, hour, lookup)).length;
  if (!total) return [];
  const stores = st.getJson(db, `share_stores:${guildId}`, {}) || {};
  const behind = Object.values(stores).some((s) => s && s.at >= now - 30 * DAY && s.count < total / 2);
  if (!behind) return [];
  const tOf = (r) => S.tOfVersion(r.body.split('^', 2)[1]) || 0;
  usable.sort((a, b) => (tOf(b) - tOf(a)) || (a.id < b.id ? -1 : 1));
  const out = [];
  let bytes = 0;
  for (const r of usable) {
    const n = S.byteLength(r.body);
    if (out.length >= SEED_MAX_RECORDS || bytes + n > SEED_MAX_BYTES) break;
    out.push(r.body);
    bytes += n;
  }
  return out;
}

module.exports = { exportOutbox, exportMe, exportSeed, SEED_MAX_RECORDS, SEED_MAX_BYTES };
