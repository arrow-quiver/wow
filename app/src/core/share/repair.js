'use strict';
// A one-time repair of who I am (docs/SHARING.md §3), for databases an older version could mislead: one that let a
// guildmate's ch make a character mine, or adopted a player id made on a guildmate's character.
//
//   repairIdentity(db, ctx?) → { unlinked: [{ guildId, names }], asked: number }
//       Runs once (app_settings 'share_repair'); the core calls it at start, after Battle.net characters are known.
//       Per guild:
//       1. A character linked to me that this computer never uploaded (no gold, game guild or bags from an upload),
//          that isn't one of my Battle.net characters and that I never confirmed, is unlinked: the current rules
//          (store.mayBeMine) would not make it mine. Records it wrote in my player id's name go back to 'ignored'
//          (reason 'link'), so they are kept and used again the moment I say it is mine. An author check asks:
//          "Jaina was linked to you as your character" ("It was me" links it again; "Undo it" leaves it out).
//       2. When my player id (per guild, or the one from before ids were per guild) is made on a character that
//          is on the guild's roster and isn't mine, an author check asks rather than changing my id:
//          "Your player id is made on Jaina, who isn't one of your characters" ("It was me": Jaina is mine, the id
//          stays; "Undo it": a new id made on my own character, see sharing.js authorCheck).
//       Nothing is deleted: my own records stay, whatever is answered.
const S = require('../../shared/sharing');
const identity = require('../identity');
const st = require('./store');
const project = require('./project');
const { importRule, namesText, PID_OF } = require('./import');

const FLAG = 'share_repair';

// Did an upload of this computer bring this character (its gold, its game guild or its bags)? Bags count only when
// they can't have come from a shared bk record: a guild bank character's bags are projected from one
// (share/project.js projectBk), whoever plays it.
function uploadedHere(db, row) {
  if (row.money != null || (row.game_guild != null && row.game_guild !== '') || Number(row.no_guild) > 0) return true;
  if (row.is_bank) return false;
  const bk = `bk:${row.name}`;
  if (db.prepare('SELECT 1 FROM shared_records WHERE guild_id = ? AND id = ? UNION ALL SELECT 1 FROM share_pruned WHERE guild_id = ? AND id = ?')
    .get(row.guild_id, bk, row.guild_id, bk)) return false;
  return Boolean(db.prepare('SELECT 1 FROM inventory WHERE character_id = ? LIMIT 1').get(row.id));
}

// Records in my player id's name written by these characters, that the current rules would not use.
function recheck(db, gid, names) {
  const tasks = [];
  const authors = new Set(names);
  for (const row of db.prepare("SELECT * FROM shared_records WHERE guild_id = ? AND state = 'ok'").all(gid)) {
    if (!authors.has(row.author)) continue;
    const type = row.id.slice(0, row.id.indexOf(':'));
    if (!PID_OF[type]) continue;
    const rec = S.decode(row.body);
    if (!rec) continue;
    const reason = importRule(db, gid, rec, row.how || 'm', null);
    if (!reason) continue;
    db.prepare("UPDATE shared_records SET state = 'ignored', reason = ?, kept = NULL WHERE guild_id = ? AND id = ?").run(reason, gid, row.id);
    tasks.push(...project.tasksFor(rec, null));
  }
  return tasks;
}

function ask(db, gid, { recId, v, summary, kind, names }) {
  const r = db.prepare(`INSERT OR IGNORE INTO share_author_checks (guild_id, rec_id, v, prev, via, summary, names, kind)
    VALUES (?,?,?,NULL,NULL,?,?,?)`).run(gid, recId, v, summary, names ? JSON.stringify(names) : null, kind);
  return r.changes;
}

function repairGuild(db, g) {
  const me = identity.meId(db);
  const out = { names: [], asked: 0 };
  // The one id from before ids were per guild is the id an older version used in each guild its anchor is in: it
  // stays in use until I answer (2.), so rows are made again below with it.
  let pid = st.myPid(db, g.id);
  if (!pid) {
    pid = st.legacyPid(db, g);
    if (pid) st.setMyPid(db, g.id, pid);
  }
  const anchor = pid ? st.anchorOf(pid) : null;
  // 1. Characters linked to me only through sharing.
  const suspects = db.prepare('SELECT id, guild_id, name, money, game_guild, no_guild, is_bank FROM characters WHERE guild_id = ? AND user_id = ?').all(g.id, me)
    .filter((row) => !uploadedHere(db, row) && !st.mayBeMine(db, g.id, row.name));
  if (suspects.length) {
    const names = suspects.map((r) => r.name);
    for (const r of suspects) db.prepare('UPDATE characters SET user_id = NULL WHERE id = ?').run(r.id);
    // Linked again as their own ch says (to their player, never to me), then their records checked again.
    project.run(db, g.id, names.map((n) => `ch:${n}`));
    project.run(db, g.id, recheck(db, g.id, names));
    out.names = names;
  }
  // 2. My player id, made on a character of the guild's roster that isn't mine.
  const row = anchor ? st.characterRow(db, g.id, anchor) : null;
  const onRoster = row && (row.rank != null || row.rank_index != null || (row.user_id != null && row.user_id !== me));
  const pidAsked = Boolean(row && onRoster && row.user_id !== me && !st.mayBeMine(db, g.id, anchor));
  if (pidAsked) {
    out.asked += ask(db, g.id, {
      recId: `pid:${pid}`, v: pid, kind: 'pid', names: [anchor],
      summary: `Your player id is made on ${anchor}, who isn't one of your characters`,
    });
  }
  // The unlinked characters, asked about (the anchor of my player id only once, in that question).
  const listed = out.names.filter((n) => !(pidAsked && n === anchor));
  for (let i = 0; i < listed.length; i += 20) {
    const part = listed.slice(i, i + 20);
    out.asked += ask(db, g.id, {
      recId: `ch:${part[0]}`, v: 'repair', kind: 'repair', names: part,
      summary: `${namesText(part)} ${part.length > 1 ? 'were' : 'was'} linked to you as your character${part.length > 1 ? 's' : ''}`,
    });
  }
  return out;
}

function repairIdentity(db) {
  const result = { unlinked: [], asked: 0 };
  if (st.get(db, FLAG)) return result;
  db.transaction(() => {
    for (const g of db.prepare('SELECT * FROM guilds ORDER BY id').all()) {
      const r = repairGuild(db, g);
      if (r.names.length) result.unlinked.push({ guildId: g.id, names: r.names });
      result.asked += r.asked;
      if (r.names.length) identity.syncRanks(db, g.id);
    }
    st.set(db, FLAG, '1');
  })();
  return result;
}

module.exports = { repairIdentity, uploadedHere };
