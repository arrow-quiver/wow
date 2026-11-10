'use strict';
// Shared records → domain rows (docs/SHARING.md §10 mapping). One projector per entity; each one reads the
// effective records (store.effective) of its entity and rewrites that entity's rows, so the result never
// depends on the order records arrived in. Rows keep stable integer ids: they are found by share_id
// (the record key) and updated in place. Tombstones remove rows. Derived state (raid status, request
// states, drive totals, SR+ loyalty) comes from app/src/shared/sharing.js.
//
//   tasksFor(rec, prevRec) → ['raid:k3f9a2', 'loyalty:2dv8n1', ...]   what a stored record touches
//   run(db, guildId, tasks, { ctx }) → { ranks: bool }               runs the tasks once each, in dependency order
//
// Records written by one of MY characters about my own data (ch, rc, bk, sh, pr) never overwrite rows that
// my own uploads write: the uploads are newer and richer.
const S = require('../../shared/sharing');
const identity = require('../identity');
const st = require('./store');
const { raidGear } = require('../readiness');
const War = require('../services/war');
const Economy = require('../services/economy');

const AWARD_KIND = { s: 'sr', m: 'ms', o: 'os', f: 'free' };
const ROLE = { t: 'tank', h: 'healer', d: 'dps' };
const SIGN = { y: 'yes', t: 'tentative', n: 'no', b: 'bench' };
const SCAN_DAY_0 = Date.UTC(2020, 0, 1);
const dayToDate = (d) => new Date(SCAN_DAY_0 + d * 86400000).toISOString().slice(0, 10);
const skillName = (id) => S.SKILLS[id] || `Skill ${id}`;

// Dependency order: links first (users), then settings, loot lists before raids and awards, loyalty last.
const ORDER = ['ch', 'cfg', 'bc', 'bk', 'rc', 'll', 'raid', 'la', 'loyalty', 'cr', 'lp', 'ek', 'rk', 'ko', 'kk', 'bb', 'ca', 'an', 'bt', 'ra', 'drive', 'dc', 'bq', 'gb', 'sh', 'pr', 'wm', 'st'];

function tasksFor(rec, prevRec) {
  if (!rec) return [];
  const out = [];
  const segs = String(rec.key).split(':');
  const f = (rec.fields && typeof rec.fields === 'object') ? rec.fields : {};
  const pf = (prevRec && prevRec.fields && typeof prevRec.fields === 'object') ? prevRec.fields : {};
  const both = (name) => [...new Set([f[name], pf[name]].filter((x) => typeof x === 'string' && x))];
  switch (rec.type) {
    case 'ch': out.push(`ch:${rec.key}`); break;
    case 'rc': out.push(`rc:${rec.key}`); break;
    case 'su': out.push(`raid:${segs[0]}`); break;
    case 'RD': out.push(`raid:${rec.key}`); break;
    case 'RT': out.push(`raid:${rec.key}`); for (const ik of both('instance')) out.push(`loyalty:${ik}`); break;
    case 'LL': out.push(`ll:${rec.key}`); break;
    case 'LA':
      out.push(`la:${rec.key}`);
      for (const k of both('raid')) out.push(`raid:${k}`);
      for (const ik of both('instance')) out.push(`loyalty:${ik}`);
      break;
    case 'LY': out.push(`loyalty:${rec.key}`); break;
    case 'cr': out.push(`cr:${rec.key}`); break;
    case 'cl': out.push(`cr:${segs[0]}`); break;
    case 'lp': out.push(`lp:${rec.key}`); break;
    case 'bb': out.push(`bb:${rec.key}`); break;
    case 'ek': out.push(`ek:${rec.key}`); break;
    case 'rk': out.push(`rk:${rec.key}`); break;
    case 'RA': out.push('ra:1'); break;
    case 'ko': out.push(`ko:${rec.key}`); break;
    case 'kk': out.push(`kk:${rec.key}`); break;
    case 'BT': out.push(`bt:${rec.key}`); break;
    case 'ca': out.push(`ca:${rec.key}`); break;
    case 'AN': out.push(`an:${rec.key}`); break;
    case 'DR': out.push(`drive:${rec.key}`); break;
    case 'dc': out.push(`dc:${rec.key}`); for (const k of both('drive')) out.push(`drive:${k}`); break;
    case 'bq': case 'BH': out.push(`bq:${rec.key}`); break;
    case 'gb': out.push('gb'); break;
    case 'BC': out.push('bc'); break;
    case 'bk': out.push(`bk:${rec.key}`); break;
    case 'sh': out.push(`sh:${rec.key}`); break;
    case 'pr': out.push(`pr:${rec.key}`); break;
    case 'wm': out.push(`wm:${rec.key}`); break;
    case 'ST': out.push('st:1'); break;
    case 'CFG': out.push('cfg'); break;
    default: break;
  }
  return out;
}

const liveRec = (e) => (e && !e.rec.del && e.rec.fields ? e.rec : null);
const meId = (db) => identity.meId(db);
// No record left because this computer dropped it once every addon had expired it (share/prune.js), not because it
// was removed or my change was refused: the rows it made stay as history.
const dropped = (db, gid, id) => st.wasPruned(db, gid, id);

// ---------------------------------------------------------------------------------------------
// ch: characters, players (users 'pid:<pid>'), links (§3)

function applyChFields(db, gid, name, rec) {
  const f = rec.fields;
  const row = st.characterRow(db, gid, name, { create: true });
  if (row.user_id === meId(db) || f.pid === st.myPid(db, gid)) return; // my own uploads are richer
  const c = f.consumables || {};
  const consumables = {};
  for (const k of ['flask', 'elixir', 'potion', 'food', 'bandage']) if (c[k]) consumables[k] = c[k];
  const whole = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
  const readiness = JSON.stringify({ ilvl: f.ilvl ?? null, durability: f.repair ?? null, consumables, at: rec.t, ...raidGear(f, whole) });
  const extras = {};
  const pvp = {};
  if (f.pvp && f.pvp.rank != null) pvp.rank = f.pvp.rank;
  if (f.pvp && f.pvp.hk != null) pvp.hk = f.pvp.hk;
  if (Object.keys(pvp).length) extras.pvp = pvp;
  if (f.addon) extras.addonVersion = f.addon;
  db.prepare(`UPDATE characters SET class = COALESCE(?, class), race = COALESCE(?, race), level = COALESCE(?, level),
      faction = COALESCE(?, faction), readiness = ?, extras = COALESCE(?, extras), is_main = ?, updated_at = ? WHERE id = ?`)
    .run(f.class || null, f.race || null, f.level ?? null, f.faction || null, readiness,
      Object.keys(extras).length ? JSON.stringify(extras) : null, f.main ? 1 : 0, st.iso(rec.t), row.id);
  if (Array.isArray(f.professions) && f.professions.length) {
    db.prepare('DELETE FROM professions WHERE character_id = ?').run(row.id);
    const ins = db.prepare('INSERT OR REPLACE INTO professions (character_id, name, skill, max_skill) VALUES (?,?,?,?)');
    for (const p of f.professions) if (p && p.skill) ins.run(row.id, skillName(p.skill), p.rank ?? null, p.max ?? null);
  }
}

// Rows that point at a stand-in 'char:<name>' user move to the player once the character is linked.
function adoptCharUser(db, name, uid) {
  const cu = db.prepare('SELECT id FROM users WHERE bnet_id = ?').get(`char:${name}`);
  if (!cu || cu.id === uid) return;
  db.prepare('UPDATE announcements SET user_id = ? WHERE user_id = ?').run(uid, cu.id);
  db.prepare('UPDATE ctas SET user_id = ? WHERE user_id = ?').run(uid, cu.id);
  db.prepare('UPDATE raids SET created_by = ? WHERE created_by = ?').run(uid, cu.id);
  db.prepare('UPDATE drives SET created_by = ? WHERE created_by = ?').run(uid, cu.id);
  db.prepare('UPDATE loot_log SET user_id = ? WHERE user_id = ?').run(uid, cu.id);
  db.prepare('UPDATE bank_requests SET handled_by = ? WHERE handled_by = ?').run(uid, cu.id);
}

// §3 linking: character C belongs to player P only if C's own ch names P and C is P's anchor or the
// anchor's ch lists C in alts. Without the anchor's ch, the last valid links stay.
// My own player id is different: anyone can relay a ch in my anchor's name, so shared records alone never
// make a character mine. Only my uploads do (services/sync.js), or a character I confirmed with "It was me"
// or one of my Battle.net characters (store.mayBeMine).
function relinkPid(db, gid, pid) {
  if (!S.pidOk(pid)) return;
  const anchor = st.anchorOf(pid);
  const me = meId(db);
  const uid = st.userForPid(db, gid, pid);
  const named = new Map();
  for (const [, e] of st.effectiveMany(db, gid, 'ch:')) {
    const r = liveRec(e);
    if (r && r.fields.pid === pid) named.set(r.key, r);
  }
  const anchorRec = named.get(anchor) || null;
  const valid = new Set();
  const kept = new Set();
  for (const name of named.keys()) {
    if (name === anchor || (anchorRec && (anchorRec.fields.alts || []).includes(name))) valid.add(name);
    else if (!anchorRec) kept.add(name);
  }
  for (const name of valid) {
    const row = st.characterRow(db, gid, name, { create: true });
    if (row.user_id === uid) continue;
    if (row.user_id === me && uid !== me) continue; // nobody takes my characters
    if (uid === me && !st.mayBeMine(db, gid, name)) continue; // and a shared ch gives me nobody's
    db.prepare('UPDATE characters SET user_id = ? WHERE id = ?').run(uid, row.id);
    adoptCharUser(db, name, uid);
  }
  if (uid !== me) {
    for (const row of db.prepare('SELECT id, name FROM characters WHERE guild_id = ? AND user_id = ?').all(gid, uid)) {
      if (valid.has(row.name) || kept.has(row.name)) continue;
      const own = liveRec(st.effective(db, gid, `ch:${row.name}`));
      if (!own) continue; // its ch is gone: keep the last valid link
      if (own.fields.pid !== pid || anchorRec) db.prepare('UPDATE characters SET user_id = NULL WHERE id = ?').run(row.id);
    }
    // Every character of this player id now names another one (two accounts of one player merged): it is
    // no longer listed as a guildmate of its own. Its records still show under it.
    if (!named.size && !db.prepare('SELECT 1 FROM characters WHERE guild_id = ? AND user_id = ? LIMIT 1').get(gid, uid)) {
      db.prepare('DELETE FROM memberships WHERE guild_id = ? AND user_id = ?').run(gid, uid);
      return;
    }
    // Display name: the BattleTag from the anchor's ch, else the main's name, else the anchor. When the anchor's ch
    // was dropped once every addon had expired it (share/prune.js), the name it gave stays.
    let main = null;
    for (const name of valid) if (named.get(name).fields.main) { main = name; break; }
    const bt = anchorRec && anchorRec.fields.battletag ? anchorRec.fields.battletag : null;
    const addon = (anchorRec && anchorRec.fields.addon) || [...valid].map((n) => named.get(n).fields.addon).find(Boolean) || null;
    if (!anchorRec && dropped(db, gid, `ch:${anchor}`)) {
      db.prepare('UPDATE users SET addon_version = COALESCE(?, addon_version) WHERE id = ?').run(addon, uid);
    } else {
      db.prepare('UPDATE users SET battletag = ?, addon_version = COALESCE(?, addon_version) WHERE id = ?')
        .run(String(bt || main || anchor || pid).slice(0, 40), addon, uid);
    }
  }
}

function projectCh(db, gid, name) {
  const e = st.effective(db, gid, `ch:${name}`);
  const r = liveRec(e);
  const pids = new Set();
  if (r && S.pidOk(r.fields.pid)) pids.add(r.fields.pid);
  const row = st.characterRow(db, gid, name);
  if (row && row.user_id) {
    const p = st.pidOfUser(db, row.user_id, gid);
    if (p) pids.add(p);
  }
  if (r) applyChFields(db, gid, name, r);
  for (const pid of pids) relinkPid(db, gid, pid);
}

// ---------------------------------------------------------------------------------------------
// rc: recipes, replaced per character and profession

function projectRc(db, gid, key) {
  const [name, skill36] = String(key).split(':');
  const skill = S.fromB36(skill36 || '');
  if (!name || skill === null) return;
  const row = st.characterRow(db, gid, name, { create: true });
  if (row.user_id === meId(db)) return;
  const prof = skillName(skill);
  const e = st.effective(db, gid, `rc:${key}`);
  if (!e && dropped(db, gid, `rc:${key}`)) return;
  const r = liveRec(e);
  db.prepare('DELETE FROM recipes WHERE character_id = ? AND profession = ?').run(row.id, prof);
  if (!r) return;
  const ins = db.prepare('INSERT OR IGNORE INTO recipes (character_id, profession, recipe_id, name) VALUES (?,?,?,?)');
  const list = Array.isArray(r.fields.list) ? r.fields.list : [];
  if (r.fields.kind === 'n') {
    for (const n of list) if (typeof n === 'string' && n) ins.run(row.id, prof, null, n.slice(0, 100));
    return;
  }
  const spell = db.prepare('SELECT name FROM spell_names WHERE spell_id = ?');
  const item = db.prepare('SELECT name FROM item_names WHERE item_id = ?');
  for (const id of list) {
    if (typeof id !== 'number') continue;
    const first = r.fields.kind === 's' ? spell.get(id) : item.get(id);
    const other = first ? null : (r.fields.kind === 's' ? item.get(id) : spell.get(id));
    ins.run(row.id, prof, id, ((first || other || {}).name || `Recipe ${id}`).slice(0, 100));
  }
}

// ---------------------------------------------------------------------------------------------
// LL: loot_items replaced per instance

function instanceNames(db, gid, ik) {
  const names = new Set();
  for (const r of db.prepare('SELECT DISTINCT instance FROM loot_items WHERE guild_id = ? UNION SELECT DISTINCT instance FROM raids WHERE guild_id = ?').all(gid, gid)) {
    if (r.instance && S.instanceKey(r.instance) === ik) names.add(r.instance);
  }
  return [...names];
}

function raidsOfInstance(db, gid, ik) {
  return db.prepare('SELECT share_id, instance FROM raids WHERE guild_id = ? AND share_id IS NOT NULL').all(gid)
    .filter((r) => S.instanceKey(r.instance) === ik).map((r) => r.share_id);
}

// The loot awards to make again once rows they point at changed (a raid or a list made, or made again).
function awardsWhere(db, gid, test) {
  const out = [];
  for (const [id, e] of st.effectiveMany(db, gid, 'LA:')) {
    const la = liveRec(e);
    if (la && test(la.fields)) out.push(`la:${id.slice(3)}`);
  }
  return out;
}

// After the list rows of an instance changed: its raids (reserves), awards (item ids) and loyalty again.
function listChanged(db, gid, ik, add) {
  for (const k of raidsOfInstance(db, gid, ik)) add(`raid:${k}`);
  for (const t of awardsWhere(db, gid, (f) => f.instance === ik)) add(t);
  add(`loyalty:${ik}`);
}

function projectLL(db, gid, ik, add) {
  const e = st.effective(db, gid, `LL:${ik}`);
  if (!e && dropped(db, gid, `LL:${ik}`)) return;
  if (!e) {
    // No shared list: none yet, or my first one was cancelled or refused. The items a shared list made (they
    // carry a key) go with it; a list typed before sharing (no keys) stays as it is.
    const names = instanceNames(db, gid, ik);
    let gone = 0;
    for (const row of db.prepare('SELECT id, instance FROM loot_items WHERE guild_id = ? AND item_key IS NOT NULL').all(gid)) {
      if (names.includes(row.instance)) gone += db.prepare('DELETE FROM loot_items WHERE id = ?').run(row.id).changes;
    }
    if (gone) listChanged(db, gid, ik, add);
    return;
  }
  const r = liveRec(e);
  const names = instanceNames(db, gid, ik);
  const target = (r && r.fields.name) || names[0];
  if (!target) return;
  const keep = new Set();
  if (r) {
    const bosses = Array.isArray(r.fields.bosses) ? r.fields.bosses : [];
    const byKey = db.prepare('SELECT id FROM loot_items WHERE guild_id = ? AND instance = ? AND item_key = ?');
    const byName = db.prepare('SELECT id, item_key FROM loot_items WHERE guild_id = ? AND instance = ? AND lower(name) = lower(?)');
    for (const it of Array.isArray(r.fields.items) ? r.fields.items : []) {
      const key = it && it.item;
      if (!key) continue;
      const name = String(it.name || `Item ${key}`).slice(0, 100);
      const boss = it.boss ? (bosses[it.boss - 1] || null) : null;
      const itemId = key[0] === 'h' ? null : S.fromB36(key);
      let row = byKey.get(gid, target, key);
      if (row && keep.has(row.id)) continue; // the same item twice in one list
      let typed = false;
      if (!row) {
        // A row typed before sharing (no key yet) with the same name becomes this item.
        const legacy = byName.get(gid, target, name);
        if (legacy && !legacy.item_key) { row = { id: legacy.id }; typed = true; }
      }
      const clash = byName.get(gid, target, name);
      if (clash && (!row || clash.id !== row.id)) {
        if (keep.has(clash.id)) continue; // two items with one name: the first one stays
        db.prepare('DELETE FROM loot_items WHERE id = ?').run(clash.id);
      }
      if (row) {
        // A typed row gets its key once the guild has the list, so it stays if my first list is dropped.
        db.prepare('UPDATE loot_items SET name = ?, boss = ?, item_id = COALESCE(?, item_id), item_key = ? WHERE id = ?')
          .run(name, boss, itemId, typed && e.pending ? null : key, row.id);
        keep.add(row.id);
      } else {
        keep.add(Number(db.prepare('INSERT INTO loot_items (guild_id, instance, boss, name, item_id, item_key) VALUES (?,?,?,?,?,?)')
          .run(gid, target, boss, name, itemId, key).lastInsertRowid));
      }
    }
  }
  const all = new Set([target, ...names]);
  for (const row of db.prepare('SELECT id, instance FROM loot_items WHERE guild_id = ?').all(gid)) {
    if (all.has(row.instance) && !keep.has(row.id)) db.prepare('DELETE FROM loot_items WHERE id = ?').run(row.id);
  }
  listChanged(db, gid, ik, add);
}

// Item keys of an instance → loot_items ids (the list rows for that instance's names).
function itemMap(db, gid, instanceName) {
  const ik = S.instanceKey(instanceName);
  const names = new Set([instanceName, ...instanceNames(db, gid, ik)]);
  const out = new Map();
  for (const row of db.prepare('SELECT id, instance, item_key, item_id, name FROM loot_items WHERE guild_id = ?').all(gid)) {
    if (!names.has(row.instance)) continue;
    const key = row.item_key || (row.item_id ? S.itemKey(row.item_id) : S.itemKey(row.name));
    if (key && !out.has(key)) out.set(key, row.id);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// RD + RT + su: raids, signups, reserves, attendance

// Attendance from the raid's close (RT, status done): every attendee whose player is known.
function closeAttendance(db, gid, raidId, rt) {
  db.prepare('DELETE FROM attendance WHERE raid_id = ?').run(raidId);
  if (!rt || rt.fields.status !== 'd') return;
  const ins = db.prepare('INSERT OR IGNORE INTO attendance (raid_id, user_id) VALUES (?,?)');
  for (const a of rt.fields.attendees || []) {
    const uid = a && a.pid ? st.userForPid(db, gid, a.pid, { member: false }) : null;
    if (uid) ins.run(raidId, uid);
  }
}

function projectRaid(db, gid, k, add) {
  const rd = liveRec(st.effective(db, gid, `RD:${k}`));
  const row = db.prepare('SELECT id, instance FROM raids WHERE guild_id = ? AND share_id = ?').get(gid, k);
  const rtE = st.effective(db, gid, `RT:${k}`);
  if (!rd) {
    if (!row) return;
    if (!dropped(db, gid, `RD:${k}`)) {
      db.prepare('DELETE FROM raids WHERE id = ?').run(row.id);
      return;
    }
    // The raid's RD was dropped once every addon had expired it: its row stays as history. A close that arrives
    // after that (or is still here) sets its status and attendance as it would have with the RD still here.
    const rt = liveRec(rtE);
    if (rt) {
      const late = S.raidStatus(rtE.str);
      db.prepare('UPDATE raids SET status = ?, locked_at = ? WHERE id = ?').run(late.status, late.status === 'open' ? null : late.lockedAt, row.id);
      closeAttendance(db, gid, row.id, rt);
    }
    return;
  }
  const status = S.raidStatus(rtE ? rtE.str : null);
  if (status.status === 'open') status.lockedAt = null; // reopened: reserves count again
  const f = rd.fields;
  const kind = st.KIND_OF[f.kind] || 'raid';
  const startsAt = st.iso(f.startsAt != null ? f.startsAt : rd.t);
  const createdBy = st.userForCharacter(db, gid, rd.author, { create: false });
  let raidId;
  if (row) {
    raidId = row.id;
    db.prepare(`UPDATE raids SET title = ?, instance = ?, starts_at = ?, duration_min = ?, size = ?, sr_limit = ?, notes = ?, kind = ?,
        status = ?, locked_at = ?, created_by = COALESCE(created_by, ?) WHERE id = ?`)
      .run(f.title || 'Raid', f.instance || '', startsAt, f.minutes || 180, f.size ?? null, f.srLimit ?? (kind === 'raid' ? 2 : 0),
        f.notes || null, kind, status.status, status.lockedAt, createdBy, raidId);
  } else {
    // A raid whose one-hour reminder went out before a fresh start (services/reset.js) isn't reminded again.
    const reminded = st.getJson(db, `raids_reminded:${gid}`, []);
    raidId = Number(db.prepare(`INSERT INTO raids (guild_id, title, instance, starts_at, duration_min, size, sr_limit, notes, created_by, kind, status, locked_at, share_id, created_at, reminded)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(gid, f.title || 'Raid', f.instance || '', startsAt, f.minutes || 180, f.size ?? null, f.srLimit ?? (kind === 'raid' ? 2 : 0),
        f.notes || null, createdBy, kind, status.status, status.lockedAt, k, st.iso(rd.t).replace('T', ' ').slice(0, 19),
        Array.isArray(reminded) && reminded.some((x) => (Array.isArray(x) ? x[0] : x) === k) ? 1 : 0).lastInsertRowid);
  }
  if (row && row.instance !== f.instance) add(`loyalty:${S.instanceKey(row.instance)}`);

  // Sign-ups: one per player.
  const items = itemMap(db, gid, f.instance || '');
  const won = new Set();
  for (const [id, e] of st.effectiveMany(db, gid, 'LA:')) {
    const la = liveRec(e);
    if (!la || la.fields.raid !== k) continue;
    add(`la:${id.slice(3)}`); // an award that arrived before its raid finds it now
    if (la.fields.pid && la.fields.item) won.add(`${la.fields.pid} ${la.fields.item}`);
  }
  const keepUsers = new Set();
  const upsert = db.prepare(`INSERT INTO signups (raid_id, user_id, character, role, status, note, updated_at, reserves_at) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT (raid_id, user_id) DO UPDATE SET character = excluded.character, role = excluded.role, status = excluded.status,
    note = excluded.note, updated_at = excluded.updated_at, reserves_at = excluded.reserves_at`);
  const reserves = [];
  for (const [id, e] of st.effectiveMany(db, gid, `su:${k}:`)) {
    const su = liveRec(e);
    if (!su) continue;
    const pid = id.split(':')[2];
    const uid = st.userForPid(db, gid, pid);
    if (!uid) continue;
    keepUsers.add(uid);
    upsert.run(raidId, uid, su.fields.character || st.anchorOf(pid) || '?', ROLE[su.fields.role] || 'dps', SIGN[su.fields.status] || 'yes',
      su.fields.note || null, st.iso(su.t).replace('T', ' ').slice(0, 19), su.fields.reservesAt ?? su.t);
    for (const key of S.countingReserves(e.str, status.lockedAt)) {
      if (won.has(`${pid} ${key}`)) continue;
      const itemId = items.get(key);
      if (itemId) reserves.push([uid, itemId, su.fields.reservesAt ?? su.t]);
    }
  }
  for (const s of db.prepare('SELECT user_id FROM signups WHERE raid_id = ?').all(raidId)) {
    if (!keepUsers.has(s.user_id)) db.prepare('DELETE FROM signups WHERE raid_id = ? AND user_id = ?').run(raidId, s.user_id);
  }
  db.prepare('DELETE FROM reserves WHERE raid_id = ?').run(raidId);
  const insRes = db.prepare('INSERT OR IGNORE INTO reserves (raid_id, user_id, item_id, created_at) VALUES (?,?,?,?)');
  for (const [uid, itemId, at] of reserves) insRes.run(raidId, uid, itemId, st.iso(at).replace('T', ' ').slice(0, 19));

  // Attendance from the close.
  closeAttendance(db, gid, raidId, liveRec(rtE));
}

// ---------------------------------------------------------------------------------------------
// LA: loot_log

function instanceNameOf(db, gid, ik, raidKey) {
  if (raidKey) {
    const r = db.prepare('SELECT instance FROM raids WHERE guild_id = ? AND share_id = ?').get(gid, raidKey);
    if (r && S.instanceKey(r.instance) === ik) return r.instance;
  }
  const ll = liveRec(st.effective(db, gid, `LL:${ik}`));
  if (ll && ll.fields.name) return ll.fields.name;
  return instanceNames(db, gid, ik)[0] || null;
}

function projectLA(db, gid, k) {
  const la = liveRec(st.effective(db, gid, `LA:${k}`));
  const row = db.prepare('SELECT id FROM loot_log WHERE guild_id = ? AND share_id = ?').get(gid, k);
  if (!la) {
    if (row && !dropped(db, gid, `LA:${k}`)) db.prepare('DELETE FROM loot_log WHERE id = ?').run(row.id);
    return;
  }
  const f = la.fields;
  const raid = f.raid ? db.prepare('SELECT id FROM raids WHERE guild_id = ? AND share_id = ?').get(gid, f.raid) : null;
  const inst = f.instance ? instanceNameOf(db, gid, f.instance, f.raid) : null;
  const itemId = inst && f.item ? (itemMap(db, gid, inst).get(f.item) || null) : null;
  const userId = f.pid ? st.userForPid(db, gid, f.pid, { member: false }) : st.userForCharacter(db, gid, f.character, { create: false });
  const vals = [raid ? raid.id : null, itemId, f.itemName || 'Loot', userId, f.character || null, AWARD_KIND[f.kind] || 'ms', f.roll ?? null, f.bonus || 0];
  if (row) {
    db.prepare('UPDATE loot_log SET raid_id = ?, item_id = ?, item_name = ?, user_id = ?, character = ?, kind = ?, roll = ?, bonus = ? WHERE id = ?').run(...vals, row.id);
  } else {
    db.prepare('INSERT INTO loot_log (raid_id, item_id, item_name, user_id, character, kind, roll, bonus, guild_id, share_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(...vals, gid, k, st.iso(la.t).replace('T', ' ').slice(0, 19));
  }
}

// ---------------------------------------------------------------------------------------------
// LY + raid closes + LA: loyalty, rebuilt per instance by the fold

// Every effective LY, raid close and award of an instance, as record strings.
function foldRecords(db, gid, ik) {
  const out = [];
  const ly = st.effective(db, gid, `LY:${ik}`);
  if (ly) out.push(ly.str);
  for (const prefix of ['RT:', 'LA:']) {
    for (const [, e] of st.effectiveMany(db, gid, prefix)) {
      const r = liveRec(e);
      if (r && r.fields.instance === ik && S.isFoldable(r)) out.push(e.str);
    }
  }
  return out;
}

function projectLoyalty(db, gid, ik) {
  if (!ik) return;
  const fold = S.loyaltyFold(ik, foldRecords(db, gid, ik));
  const names = instanceNames(db, gid, ik);
  const ll = liveRec(st.effective(db, gid, `LL:${ik}`));
  if (ll && ll.fields.name && !names.includes(ll.fields.name)) names.push(ll.fields.name);
  if (!names.length) return;
  const items = itemMap(db, gid, names[0]);
  const ids = [...new Set(items.values())];
  const del = db.prepare('DELETE FROM loyalty WHERE guild_id = ? AND item_id = ?');
  for (const id of ids) del.run(gid, id);
  const ins = db.prepare('INSERT OR REPLACE INTO loyalty (guild_id, user_id, item_id, bonus) VALUES (?,?,?,?)');
  for (const [pid, byItem] of Object.entries(fold.bonuses)) {
    const uid = st.userForPid(db, gid, pid, { member: false });
    if (!uid) continue;
    for (const [key, bonus] of Object.entries(byItem)) {
      const itemId = items.get(key);
      if (itemId && bonus > 0) ins.run(gid, uid, itemId, bonus);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// cr + cl: craft_requests

function projectCr(db, gid, k) {
  const e = st.effective(db, gid, `cr:${k}`);
  const cr = liveRec(e);
  const row = db.prepare('SELECT id FROM craft_requests WHERE guild_id = ? AND share_id = ?').get(gid, k);
  if (!cr) {
    if (row && !dropped(db, gid, `cr:${k}`)) db.prepare('DELETE FROM craft_requests WHERE id = ?').run(row.id);
    return;
  }
  const claims = [...st.effectiveMany(db, gid, `cl:${k}:`).values()].map((c) => c.str);
  const state = S.craftRequestState(e.str, claims);
  const requester = st.userForPid(db, gid, cr.fields.pid);
  if (!requester) return;
  const crafter = state.claimer ? st.userForPid(db, gid, state.claimer) : null;
  const now = st.iso(st.serverNow(db)).replace('T', ' ').slice(0, 19);
  if (row) {
    db.prepare('UPDATE craft_requests SET requester_id = ?, item = ?, notes = ?, status = ?, crafter_id = ?, updated_at = ? WHERE id = ?')
      .run(requester, cr.fields.item || '?', cr.fields.notes || null, state.state, crafter, now, row.id);
  } else {
    db.prepare(`INSERT INTO craft_requests (guild_id, requester_id, item, notes, status, crafter_id, share_id, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(gid, requester, cr.fields.item || '?', cr.fields.notes || null, state.state, crafter, k,
      st.iso(cr.t).replace('T', ' ').slice(0, 19), now);
  }
}

// ---------------------------------------------------------------------------------------------
// lp, ca, AN: buddy_posts, ctas, announcements

function projectLp(db, gid, key) {
  const lp = liveRec(st.effective(db, gid, `lp:${key}`));
  const row = db.prepare('SELECT id FROM buddy_posts WHERE guild_id = ? AND share_id = ?').get(gid, key);
  const [pid, name] = String(key).split(':');
  if (!lp) {
    if (row && !dropped(db, gid, `lp:${key}`)) db.prepare('UPDATE buddy_posts SET active = 0 WHERE id = ?').run(row.id);
    return;
  }
  const uid = st.userForPid(db, gid, pid);
  if (!uid) return;
  const f = lp.fields;
  const vals = [uid, f.character || name, f.level ?? null, f.zone || null, f.when || null, f.note || null];
  // A post lasts 3 days from its newest version (a new post for the same character starts the 3 days again).
  if (row) db.prepare('UPDATE buddy_posts SET user_id = ?, character = ?, level = ?, zone = ?, when_text = ?, note = ?, active = 1, created_at = ? WHERE id = ?').run(...vals, st.iso(lp.t).replace('T', ' ').slice(0, 19), row.id);
  else {
    db.prepare('INSERT INTO buddy_posts (user_id, character, level, zone, when_text, note, guild_id, share_id, active, created_at) VALUES (?,?,?,?,?,?,?,?,1,?)')
      .run(...vals, gid, key, st.iso(lp.t).replace('T', ' ').slice(0, 19));
  }
}

// bb: bulletin_posts (taken down 'x' or expired: gone)
function projectBb(db, gid, k) {
  const r = liveRec(st.effective(db, gid, `bb:${k}`));
  const row = db.prepare('SELECT id FROM bulletin_posts WHERE guild_id = ? AND share_id = ?').get(gid, k);
  const f = r ? r.fields : {};
  if (!r || f.state === 'x' || !f.text) {
    if (row && (!r ? !dropped(db, gid, `bb:${k}`) : true)) db.prepare('DELETE FROM bulletin_posts WHERE id = ?').run(row.id);
    return;
  }
  const uid = st.userForPid(db, gid, f.pid);
  if (!uid) return;
  const kind = { l: 'lfg', s: 'wts', w: 'wtb', h: 'help' }[f.kind] || 'lfg';
  const vals = [uid, f.character || r.author || '?', kind, String(f.text).slice(0, 200), Number.isInteger(f.price) && f.price > 0 ? f.price : null];
  const t = st.iso(r.t).replace('T', ' ').slice(0, 19);
  if (row) db.prepare('UPDATE bulletin_posts SET user_id = ?, character = ?, kind = ?, text = ?, price = ?, created_at = ? WHERE id = ?').run(...vals, t, row.id);
  else db.prepare('INSERT INTO bulletin_posts (user_id, character, kind, text, price, created_at, guild_id, share_id) VALUES (?,?,?,?,?,?,?,?)').run(...vals, t, gid, k);
}

// ek: boss_kills (expired: gone, unless the store dropped it)
function projectEk(db, gid, k) {
  const e = st.effective(db, gid, `ek:${k}`);
  if (!e && dropped(db, gid, `ek:${k}`)) return;
  const r = liveRec(e);
  const f = r ? r.fields : {};
  if (!r || !f.boss) { db.prepare('DELETE FROM boss_kills WHERE guild_id = ? AND share_id = ?').run(gid, k); return; }
  const names = (Array.isArray(f.names) ? f.names : []).filter((n) => typeof n === 'string' && n).slice(0, 40);
  db.prepare('INSERT OR REPLACE INTO boss_kills (guild_id, share_id, encounter, boss, instance, at, size, names) VALUES (?,?,?,?,?,?,?,?)')
    .run(gid, k, Number.isInteger(f.enc) ? f.enc : null, f.boss, f.instance || null, Number.isInteger(f.at) ? f.at : r.t, Number.isInteger(f.size) ? f.size : null, JSON.stringify(names));
}

// rk: recruits. The recruiter is whoever found them first, and only when they wrote it themselves (kept as others
// move the state on). contacted_at and joined_at are this app's clock when it first saw each, never the writer's.
// Expired or dropped: gone, unless they joined (past seasons keep the points).
function projectRk(db, gid, k) {
  const e = st.effective(db, gid, `rk:${k}`);
  const row = db.prepare('SELECT * FROM recruits WHERE guild_id = ? AND name = ?').get(gid, k);
  if (!e && dropped(db, gid, `rk:${k}`)) return;
  const r = liveRec(e);
  const f = r ? r.fields : {};
  if (!r || !'cinj'.includes(f.state || '-')) {
    if (row && row.state !== 'j') db.prepare('DELETE FROM recruits WHERE guild_id = ? AND name = ?').run(gid, k);
    return;
  }
  const seen = Math.floor(Date.now() / 1000);
  const by = f.pid && st.isLinked(db, gid, r.author, f.pid) ? st.userForPid(db, gid, f.pid) : null;
  const at = Number.isInteger(f.at) ? f.at : r.t;
  const joinedAt = f.state === 'j' ? (row && row.joined_at) || seen : (row ? row.joined_at : null);
  db.prepare(`INSERT INTO recruits (guild_id, name, recruiter, level, class, zone, state, at, contacted_at, joined_at) VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT (guild_id, name) DO UPDATE SET recruiter = COALESCE(recruits.recruiter, excluded.recruiter), level = excluded.level,
      class = excluded.class, zone = excluded.zone, state = excluded.state, at = excluded.at, joined_at = excluded.joined_at`)
    .run(gid, k, row && row.recruiter ? row.recruiter : by, Number.isInteger(f.level) ? f.level : null, f.class || null, f.zone || null, f.state, at,
      row ? row.contacted_at : seen, joinedAt);
}

// RA: recruit_settings, replaced as a whole
function projectRa(db, gid) {
  const r = liveRec(st.effective(db, gid, 'RA:1'));
  if (!r) { db.prepare('DELETE FROM recruit_settings WHERE guild_id = ?').run(gid); return; }
  const f = r.fields;
  db.prepare('INSERT OR REPLACE INTO recruit_settings (guild_id, ad, msg, classes, min_level, max_level) VALUES (?,?,?,?,?,?)')
    .run(gid, f.ad || null, f.msg || null, f.classes || null, Number.isInteger(f.minLevel) ? f.minLevel : null, Number.isInteger(f.maxLevel) ? f.maxLevel : null);
}

// ko: kos (taken off 'x' or expired: gone)
function projectKo(db, gid, k) {
  const r = liveRec(st.effective(db, gid, `ko:${k}`));
  if (!r || r.fields.state === 'x') { db.prepare('DELETE FROM kos WHERE guild_id = ? AND name = ?').run(gid, k); return; }
  const by = r.fields.pid ? st.userForPid(db, gid, r.fields.pid) : null;
  db.prepare(`INSERT INTO kos (guild_id, name, reason, added_by, added_at) VALUES (?,?,?,?,?)
    ON CONFLICT (guild_id, name) DO UPDATE SET reason = excluded.reason, added_by = excluded.added_by, added_at = excluded.added_at`)
    .run(gid, k, r.fields.reason || null, by, st.iso(r.t));
}

// kk: hunt_kills (expired: gone)
function projectKk(db, gid, k) {
  const e = st.effective(db, gid, `kk:${k}`);
  if (!e && dropped(db, gid, `kk:${k}`)) return;
  const r = liveRec(e);
  const f = r ? r.fields : {};
  if (!r || !f.target) { db.prepare('DELETE FROM hunt_kills WHERE guild_id = ? AND share_id = ?').run(gid, k); return; }
  const uid = st.userForPid(db, gid, f.pid);
  db.prepare('INSERT OR REPLACE INTO hunt_kills (guild_id, share_id, user_id, target, zone, at, kos, bounty) VALUES (?,?,?,?,?,?,?,?)')
    .run(gid, k, uid || null, f.target, f.zone || null, Number.isInteger(f.at) ? f.at : r.t, f.kos ? 1 : 0, f.bounty || null);
}

// BT: bounties (expired: gone; closed: state x)
function projectBt(db, gid, k) {
  const r = liveRec(st.effective(db, gid, `BT:${k}`));
  const f = r ? r.fields : {};
  if (!r || (!f.target && !f.zone) || !(f.points > 0)) { db.prepare('DELETE FROM bounties WHERE guild_id = ? AND share_id = ?').run(gid, k); return; }
  const vals = [f.target || null, f.zone || null, f.points, Math.max(1, f.cap || 1), f.ends || 0, f.note || null, f.state === 'x' ? 'x' : 'o'];
  const row = db.prepare('SELECT id FROM bounties WHERE guild_id = ? AND share_id = ?').get(gid, k);
  if (row) db.prepare('UPDATE bounties SET target = ?, zone = ?, points = ?, cap = ?, until = ?, note = ?, state = ? WHERE id = ?').run(...vals, row.id);
  else db.prepare('INSERT INTO bounties (target, zone, points, cap, until, note, state, guild_id, share_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(...vals, gid, k, st.iso(r.t));
}

function projectCa(db, gid, k) {
  const ca = liveRec(st.effective(db, gid, `ca:${k}`));
  const row = db.prepare('SELECT id FROM ctas WHERE guild_id = ? AND share_id = ?').get(gid, k);
  if (!ca) {
    if (row && !dropped(db, gid, `ca:${k}`)) db.prepare('DELETE FROM ctas WHERE id = ?').run(row.id);
    return;
  }
  const f = ca.fields;
  const uid = st.userForCharacter(db, gid, ca.author);
  const vals = [uid, f.character || ca.author, f.zone || '?', f.message || null, f.needed ?? null];
  if (row) db.prepare('UPDATE ctas SET user_id = ?, character = ?, zone = ?, message = ?, needed = ? WHERE id = ?').run(...vals, row.id);
  else {
    // Same player and key from another source (an old upload): adopt that row.
    const old = db.prepare('SELECT id FROM ctas WHERE user_id = ? AND client_ref = ?').get(uid, k);
    if (old) db.prepare('UPDATE ctas SET share_id = ?, guild_id = ? WHERE id = ?').run(k, gid, old.id);
    else {
      // Made in this app (it is in this computer's outbox), else sounded in game.
      const fromApp = db.prepare('SELECT 1 FROM share_outbox WHERE guild_id = ? AND rec_id = ? LIMIT 1').get(gid, `ca:${k}`);
      db.prepare('INSERT INTO ctas (user_id, character, zone, message, needed, guild_id, share_id, client_ref, source, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(...vals, gid, k, k, fromApp ? 'app' : 'addon', st.iso(ca.t).replace('T', ' ').slice(0, 19));
    }
  }
}

function projectAn(db, gid, k) {
  const an = liveRec(st.effective(db, gid, `AN:${k}`));
  const row = db.prepare('SELECT id FROM announcements WHERE guild_id = ? AND share_id = ?').get(gid, k);
  if (!an) {
    if (row && !dropped(db, gid, `AN:${k}`)) db.prepare('DELETE FROM announcements WHERE id = ?').run(row.id);
    return;
  }
  const uid = st.userForCharacter(db, gid, an.author);
  if (row) db.prepare('UPDATE announcements SET user_id = ?, body = ? WHERE id = ?').run(uid, an.fields.body || '', row.id);
  else {
    db.prepare('INSERT INTO announcements (guild_id, user_id, body, share_id, created_at) VALUES (?,?,?,?,?)')
      .run(gid, uid, an.fields.body || '', k, st.iso(an.t).replace('T', ' ').slice(0, 19));
  }
}

// ---------------------------------------------------------------------------------------------
// DR + dc: drives, drive_contribs

function contribsOf(db, gid, k) {
  const out = [];
  for (const [id, e] of st.effectiveMany(db, gid, 'dc:')) {
    const r = liveRec(e);
    if (r && r.fields.drive === k) out.push({ id, key: id.slice(3), e, r });
  }
  return out;
}

function driveStateOf(db, gid, k) {
  const dr = st.effective(db, gid, `DR:${k}`);
  return dr ? S.driveState(dr.str, contribsOf(db, gid, k).map((c) => c.e.str)) : null;
}

function projectDrive(db, gid, k) {
  const e = st.effective(db, gid, `DR:${k}`);
  const dr = liveRec(e);
  const row = db.prepare('SELECT id FROM drives WHERE guild_id = ? AND share_id = ?').get(gid, k);
  if (!dr) {
    if (row && !dropped(db, gid, `DR:${k}`)) db.prepare('DELETE FROM drives WHERE id = ?').run(row.id);
    return;
  }
  const contribs = contribsOf(db, gid, k);
  const state = S.driveState(e.str, contribs.map((c) => c.e.str));
  const f = dr.fields;
  const createdBy = st.userForCharacter(db, gid, dr.author, { create: false });
  let driveId;
  if (row) {
    driveId = row.id;
    db.prepare('UPDATE drives SET title = ?, unit = ?, goal = ?, notes = ?, status = ?, created_by = COALESCE(created_by, ?) WHERE id = ?')
      .run(f.title || 'Drive', f.unit || '', f.goal || 0, f.notes || null, state.status, createdBy, driveId);
  } else {
    driveId = Number(db.prepare('INSERT INTO drives (guild_id, title, unit, goal, notes, status, created_by, share_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(gid, f.title || 'Drive', f.unit || '', f.goal || 0, f.notes || null, state.status, createdBy, k, st.iso(dr.t).replace('T', ' ').slice(0, 19)).lastInsertRowid);
  }
  const keep = new Set();
  for (const c of contribs) {
    const uid = st.userForPid(db, gid, c.r.fields.pid);
    if (!uid) continue;
    keep.add(c.key);
    const vals = [driveId, uid, c.r.fields.character || null, c.r.fields.amount || 0, c.r.fields.note || null];
    const old = db.prepare('SELECT dc.id FROM drive_contribs dc JOIN drives d ON d.id = dc.drive_id WHERE d.guild_id = ? AND dc.share_id = ?').get(gid, c.key);
    if (old) db.prepare('UPDATE drive_contribs SET drive_id = ?, user_id = ?, character = ?, amount = ?, note = ? WHERE id = ?').run(...vals, old.id);
    else db.prepare('INSERT INTO drive_contribs (drive_id, user_id, character, amount, note, share_id, created_at) VALUES (?,?,?,?,?,?,?)').run(...vals, c.key, st.iso(c.r.t).replace('T', ' ').slice(0, 19));
  }
  for (const r of db.prepare('SELECT id, share_id FROM drive_contribs WHERE drive_id = ? AND share_id IS NOT NULL').all(driveId)) {
    if (!keep.has(r.share_id)) db.prepare('DELETE FROM drive_contribs WHERE id = ?').run(r.id);
  }
}

// A hand-in that is gone (or moved to a drive this computer doesn't know) leaves its old drive.
function projectDc(db, gid, k) {
  const e = st.effective(db, gid, `dc:${k}`);
  if (!e && dropped(db, gid, `dc:${k}`)) return;
  const r = liveRec(e);
  const row = db.prepare('SELECT dc.id, d.share_id AS drive FROM drive_contribs dc JOIN drives d ON d.id = dc.drive_id WHERE d.guild_id = ? AND dc.share_id = ?').get(gid, k);
  if (row && (!r || r.fields.drive !== row.drive)) db.prepare('DELETE FROM drive_contribs WHERE id = ?').run(row.id);
}

// ---------------------------------------------------------------------------------------------
// bq + BH: bank_requests

function projectBq(db, gid, k) {
  const e = st.effective(db, gid, `bq:${k}`);
  const row = db.prepare('SELECT id FROM bank_requests WHERE guild_id = ? AND share_id = ?').get(gid, k);
  if (!e) {
    // No record at all: my new request was cancelled or refused before the guild had it.
    if (row && !dropped(db, gid, `bq:${k}`)) db.prepare('DELETE FROM bank_requests WHERE id = ?').run(row.id);
    return;
  }
  const bh = st.effective(db, gid, `BH:${k}`);
  const state = S.bankRequestState(e.str, bh ? bh.str : null);
  const handledBy = (state.state === 'sent' || state.state === 'declined') && state.by ? st.userForCharacter(db, gid, state.by, { create: false }) : null;
  const now = st.iso(st.serverNow(db)).replace('T', ' ').slice(0, 19);
  const bq = liveRec(e);
  if (!bq) {
    if (row) db.prepare("UPDATE bank_requests SET status = 'cancelled', updated_at = ? WHERE id = ?").run(now, row.id);
    return;
  }
  const requester = st.userForPid(db, gid, bq.fields.pid);
  if (!requester) return;
  const vals = [requester, bq.fields.item || '?', bq.fields.count || 1, bq.fields.note || null, state.state, handledBy, now];
  if (row) db.prepare('UPDATE bank_requests SET requester_id = ?, item = ?, count = ?, note = ?, status = ?, handled_by = ?, updated_at = ? WHERE id = ?').run(...vals, row.id);
  else {
    db.prepare('INSERT INTO bank_requests (requester_id, item, count, note, status, handled_by, updated_at, guild_id, share_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(...vals, gid, k, st.iso(bq.t).replace('T', ' ').slice(0, 19));
  }
}

// ---------------------------------------------------------------------------------------------
// gb: guild bank (newest scan wins, as with uploads)

function projectGb(db, gid) {
  const all = st.effectiveMany(db, gid, 'gb:');
  const g0 = liveRec(all.get('gb:0'));
  if (!g0) return;
  const f0 = g0.fields;
  const scanned = st.iso(f0.scannedAt != null ? f0.scannedAt : g0.t);
  const last = db.prepare('SELECT bank_scanned_at AS t FROM guilds WHERE id = ?').get(gid);
  if (last && last.t && scanned < last.t) return; // my own newer scan stays
  db.prepare('UPDATE guilds SET bank_money = ?, bank_scanned_at = ? WHERE id = ?').run(f0.money ?? null, scanned, gid);
  db.prepare('DELETE FROM guild_bank WHERE guild_id = ?').run(gid);
  const ins = db.prepare(`INSERT INTO guild_bank (guild_id, tab, item_id, count) VALUES (?,?,?,?)
    ON CONFLICT (guild_id, tab, item_id) DO UPDATE SET count = count + excluded.count`);
  const tabs = Array.isArray(f0.tabs) ? f0.tabs : [];
  for (let n = 1; n <= 8; n++) {
    const r = liveRec(all.get(`gb:${n}`));
    if (!r) continue;
    const name = String(tabs[n - 1] || `Tab ${n}`).slice(0, 40);
    for (const it of r.fields.items || []) if (it && it.id && it.count > 0) ins.run(gid, name, it.id, it.count);
  }
  Economy.recordBankLog(db, gid, (f0.log || []).filter(Boolean)
    .map((e) => ({ at: e.at, kind: e.kind, who: e.who, item: e.item, count: e.count, amount: e.amount })));
}

// ---------------------------------------------------------------------------------------------
// BC + bk: bank characters and their stock

// No record (my first list was cancelled or refused): no bank characters from sharing, as before it.
function projectBc(db, gid, add) {
  const r = liveRec(st.effective(db, gid, 'BC:1'));
  const names = new Set(r ? (r.fields.names || []).filter(Boolean) : []);
  for (const row of db.prepare('SELECT id, name, is_bank FROM characters WHERE guild_id = ?').all(gid)) {
    const want = names.has(row.name) ? 1 : 0;
    if (want !== row.is_bank) db.prepare('UPDATE characters SET is_bank = ? WHERE id = ?').run(want, row.id);
  }
  for (const n of names) {
    const row = st.characterRow(db, gid, n, { create: true });
    if (!row.is_bank) db.prepare('UPDATE characters SET is_bank = 1 WHERE id = ?').run(row.id);
  }
  for (const id of st.effectiveMany(db, gid, 'bk:').keys()) add(`bk:${id.slice(3)}`);
}

function projectBk(db, gid, name) {
  const row = st.characterRow(db, gid, name);
  if (!row || row.user_id === meId(db) || !row.is_bank) return;
  const r = liveRec(st.effective(db, gid, `bk:${name}`));
  if (!r) return;
  const ins = db.prepare('INSERT OR REPLACE INTO inventory (character_id, location, item_id, count) VALUES (?,?,?,?)');
  for (const loc of ['bags', 'bank']) {
    db.prepare('DELETE FROM inventory WHERE character_id = ? AND location = ?').run(row.id, loc);
    for (const it of r.fields[loc] || []) if (it && it.id && it.count > 0) ins.run(row.id, loc, it.id, it.count);
  }
}

// ---------------------------------------------------------------------------------------------
// sh, pr: shopping lists and prices

function projectSh(db, gid, pid) {
  if (!S.pidOk(pid) || pid === st.myPid(db)) return;
  const e = st.effective(db, gid, `sh:${pid}`);
  if (!e) return;
  const uid = st.userForPid(db, gid, pid);
  const r = liveRec(e);
  if (!r) {
    db.prepare('DELETE FROM shopping_lists WHERE user_id = ?').run(uid);
    return;
  }
  const items = (r.fields.items || []).filter((x) => x && x.name).map((x) => ({
    name: x.name, qty: x.qty || 1, prof: x.skill ? skillName(x.skill) : null, reagents: [],
  }));
  db.prepare(`INSERT INTO shopping_lists (user_id, items, updated_at) VALUES (?,?,?)
    ON CONFLICT (user_id) DO UPDATE SET items = excluded.items, updated_at = excluded.updated_at`)
    .run(uid, JSON.stringify(items), st.iso(r.t).replace('T', ' ').slice(0, 19));
}

// ST: the guild bank store's items (officers set them), replaced as a whole
function projectSt(db, gid) {
  const e = st.effective(db, gid, 'ST:1');
  const r = e ? liveRec(e) : null;
  db.prepare('DELETE FROM store_items WHERE guild_id = ?').run(gid);
  const put = db.prepare('INSERT OR IGNORE INTO store_items (guild_id, key, item, item_id, cost, stock, pos) VALUES (?,?,?,?,?,?,?)');
  (r && Array.isArray(r.fields.items) ? r.fields.items : []).forEach((x, i) => {
    if (x && /^[0-9a-z]{6}$/.test(String(x.key || '')) && x.item && Number.isInteger(x.cost) && x.cost > 0) {
      put.run(gid, x.key, String(x.item).slice(0, 60), Number.isInteger(x.id) && x.id > 0 ? x.id : null, x.cost, Number.isInteger(x.stock) ? Math.max(0, x.stock) : 0, i);
    }
  });
}

// wm: the guild's open-world deaths and kills, one list per player account (mine included: the War page shows all)
function projectWm(db, gid, pid) {
  if (!S.pidOk(pid)) return;
  const e = st.effective(db, gid, `wm:${pid}`);
  if (!e) return;
  const r = liveRec(e);
  War.applyMarks(db, gid, pid, st.userForPid(db, gid, pid), r ? r.fields : null);
}

function projectPr(db, gid, pid) {
  if (!S.pidOk(pid) || pid === st.myPid(db)) return;
  const r = liveRec(st.effective(db, gid, `pr:${pid}`));
  if (!r || r.fields.day == null) return;
  const day = dayToDate(r.fields.day);
  const up = db.prepare(`INSERT INTO prices (guild_id, item_id, day, price) VALUES (?,?,?,?)
    ON CONFLICT (guild_id, item_id, day) DO UPDATE SET price = MIN(price, excluded.price)`);
  for (const p of r.fields.prices || []) if (p && p.id > 0 && p.copper > 0) up.run(gid, p.id, day, p.copper);
}

// ---------------------------------------------------------------------------------------------
// CFG: officer and relay ranks

// No record (my first change was cancelled or refused, or undone): the defaults, officers up to rank 1 and
// officer changes passed on by officers only.
function projectCfg(db, gid, out) {
  const r = liveRec(st.effective(db, gid, 'CFG:1'));
  const f = r ? r.fields : {};
  const officer = f.officerRankMax == null ? 1 : f.officerRankMax;
  const relay = f.relayRankMax == null ? null : f.relayRankMax;
  db.prepare('UPDATE guilds SET officer_rank_max = ?, relay_rank_max = ? WHERE id = ?').run(officer, relay, gid);
  out.ranks = true;
}

// ---------------------------------------------------------------------------------------------

function run(db, gid, tasks, { out = {} } = {}) {
  const pending = new Set(tasks);
  const done = new Set();
  const add = (t) => { if (!done.has(t)) pending.add(t); };
  let guard = 0;
  while (pending.size && guard++ < 100000) {
    let next = null;
    let rank = Infinity;
    for (const t of pending) {
      const r = ORDER.indexOf(t.split(':')[0]);
      if (r >= 0 && r < rank) { rank = r; next = t; }
    }
    if (next === null) break;
    pending.delete(next);
    done.add(next);
    const i = next.indexOf(':');
    const kind = i < 0 ? next : next.slice(0, i);
    const arg = i < 0 ? '' : next.slice(i + 1);
    switch (kind) {
      case 'ch': projectCh(db, gid, arg); out.ranks = true; break;
      case 'cfg': projectCfg(db, gid, out); break;
      case 'bc': projectBc(db, gid, add); break;
      case 'bk': projectBk(db, gid, arg); break;
      case 'rc': projectRc(db, gid, arg); break;
      case 'll': projectLL(db, gid, arg, add); break;
      case 'raid': projectRaid(db, gid, arg, add); break;
      case 'la': projectLA(db, gid, arg); break;
      case 'loyalty': projectLoyalty(db, gid, arg); break;
      case 'cr': projectCr(db, gid, arg); break;
      case 'lp': projectLp(db, gid, arg); break;
      case 'bb': projectBb(db, gid, arg); break;
      case 'ek': projectEk(db, gid, arg); break;
      case 'rk': projectRk(db, gid, arg); break;
      case 'ra': projectRa(db, gid); break;
      case 'ko': projectKo(db, gid, arg); break;
      case 'kk': projectKk(db, gid, arg); break;
      case 'bt': projectBt(db, gid, arg); break;
      case 'ca': projectCa(db, gid, arg); break;
      case 'an': projectAn(db, gid, arg); break;
      case 'drive': projectDrive(db, gid, arg); break;
      case 'dc': projectDc(db, gid, arg); break;
      case 'bq': projectBq(db, gid, arg); break;
      case 'gb': projectGb(db, gid); break;
      case 'sh': projectSh(db, gid, arg); break;
      case 'pr': projectPr(db, gid, arg); break;
      case 'wm': projectWm(db, gid, arg); break;
      case 'st': projectSt(db, gid); break;
      default: break;
    }
  }
  return out;
}

module.exports = { tasksFor, run, relinkPid, driveStateOf, foldRecords, itemMap, instanceNames, ORDER, dayToDate };
