// "Fresh start" for a guild: keeps people and settings; wipes all game data in the local database.
// A backup is written first. Game data from before the reset is ignored if an old
// SavedVariables file (e.g. from Retail testing) uploads it again (see sync.js freshOnly), and only a
// character played after the reset can make another guild the current one (identity.selectGuild).
// Ported from the old web/src/reset.js.
//
// Guild data shared in game (docs/SHARING.md) is rebuilt, not lost: this computer's copy of the shared
// records goes, and the next upload brings it all back from the addon's store (§12 "App database lost").
// freshOnly leaves the upload's shared records alone, whatever their age. Nothing in guildmates' games
// changes. The outbox keeps my unsent changes (queued, waiting) and their rows are made again at once;
// its history (sent, refused, dropped) goes. Author checks I haven't answered stay; answered ones go, except a closed
// group of records of a type this version doesn't know. Raids still to come whose one-hour reminder went out are
// remembered (app_settings raids_reminded:<guild>), so they aren't reminded again when they come back.
//
// Exports
//   resetGuild(db, guildId, backupDir|null) → { backup: path|null, removed: { table: rowsDeleted } }
//       Pass null for backupDir with an in-memory database (tests: no backup is possible then).
//   RESET_TABLES  [table, where] pairs, in delete order (children before parents)
//   SHARE_TABLES  [table, where] pairs: this computer's sharing state for the guild
// Injected dependencies: none. The route audits the reset (ctx.audit) and reports `removed`.
const backup = require('./backup');
const st = require('../share/store');
const project = require('../share/project');

// Children before parents so foreign keys hold at every step. Every WHERE takes the guild id once.
const RESET_TABLES = [
  ['signups', 'raid_id IN (SELECT id FROM raids WHERE guild_id = ?)'],
  ['reserves', 'raid_id IN (SELECT id FROM raids WHERE guild_id = ?)'],
  ['attendance', 'raid_id IN (SELECT id FROM raids WHERE guild_id = ?)'],
  ['loot_rolls', 'raid_id IN (SELECT id FROM raids WHERE guild_id = ?)'],
  ['loot_log', 'guild_id = ?'],
  ['loyalty', 'guild_id = ?'],
  ['loot_items', 'guild_id = ?'],
  ['raids', 'guild_id = ?'],
  ['drive_contribs', 'drive_id IN (SELECT id FROM drives WHERE guild_id = ?)'],
  ['drives', 'guild_id = ?'],
  ['professions', 'character_id IN (SELECT id FROM characters WHERE guild_id = ?)'],
  ['recipes', 'character_id IN (SELECT id FROM characters WHERE guild_id = ?)'],
  ['inventory', 'character_id IN (SELECT id FROM characters WHERE guild_id = ?)'],
  ['characters', 'guild_id = ?'],
  ['wanted_items', 'user_id IN (SELECT user_id FROM memberships WHERE guild_id = ?)'],
  ['shopping_lists', 'user_id IN (SELECT user_id FROM memberships WHERE guild_id = ?)'],
  ['craft_requests', 'guild_id = ?'], ['buddy_posts', 'guild_id = ?'], ['ctas', 'guild_id = ?'],
  ['announcements', 'guild_id = ?'], ['activity', 'guild_id = ?'], ['sync_log', 'guild_id = ?'],
  ['prices', 'guild_id = ?'], ['guild_bank', 'guild_id = ?'], ['bank_log', 'guild_id = ?'],
  ['bank_requests', 'guild_id = ?'], ['link_codes', 'guild_id = ?'],
  ['coach_chars', 'guild_id = ?'], ['coach_qa', 'guild_id = ?'],
];

// An author check I haven't answered stays: its record comes back with the store, and is not asked about twice.
// A closed group of records of a type this version doesn't know stays too: nothing was sent to undo them, so they
// come back with the store until every addon drops them (14 days), and are not asked about again (share/import.js
// unknownCheck; share/prune.js drops the group after that). share_since:<guild> (when this computer started sharing
// there) and the log of my own versions (share_sent) stay, so a forged record in my name from before the fresh
// start is still asked about when it comes back.
const SHARE_TABLES = [
  ['shared_records', 'guild_id = ?'],
  ['share_author_checks', "guild_id = ? AND state != 'open' AND NOT (COALESCE(kind, '') = 'unknown' AND state = 'undone')"],
  ['share_outbox', "guild_id = ? AND state NOT IN ('queued','waiting')"],
];
// What this computer saw of the guild's sharing: the last exchange (status page) and each store's size (seed rule).
const shareSettings = (g) => [`share_stats:${g}`, `share_stores:${g}`];

// The 'ok' records in my name this computer holds, into the log of my own versions (share/store.js noteSent).
function keepMine(db, g) {
  const asked = new Set();
  for (const c of db.prepare("SELECT rec_id, v, recs FROM share_author_checks WHERE guild_id = ? AND state != 'mine'").all(g)) {
    asked.add(`${c.rec_id} ${c.v}`);
    let recs = [];
    try { recs = JSON.parse(c.recs || '[]'); } catch { recs = []; }
    for (const x of Array.isArray(recs) ? recs : []) if (Array.isArray(x)) asked.add(`${x[0]} ${x[1]}`);
  }
  const mine = new Set(st.myCharacters(db, g, { loose: true }));
  for (const r of db.prepare("SELECT id, v, author FROM shared_records WHERE guild_id = ? AND state = 'ok'").all(g)) {
    if (mine.has(r.author) && !asked.has(`${r.id} ${r.v}`)) st.noteSent(db, g, r.id, r.v);
  }
}

function resetGuild(db, guildId, backupDir) {
  const file = backupDir ? backup.runBackup(db, backupDir, { keep: 30 }) : null;
  const g = guildId;
  const removed = {};
  db.transaction(() => {
    // Raids still to come whose "starts in an hour" reminder (and my Discord post) already went out: their rows come
    // back with the store, and are not reminded twice (share/project.js projectRaid). Kept as [share_id, starts_at]
    // pairs: one an earlier fresh start remembered, whose raid the store hasn't brought back yet (two fresh starts
    // before the next upload), stays until its start.
    const now = new Date().toISOString();
    const remindedKey = `raids_reminded:${g}`;
    const hasRow = db.prepare('SELECT 1 FROM raids WHERE guild_id = ? AND share_id = ?');
    const reminded = new Map();
    const earlier = st.getJson(db, remindedKey, []);
    for (const x of Array.isArray(earlier) ? earlier : []) {
      if (Array.isArray(x) && typeof x[0] === 'string' && typeof x[1] === 'string' && x[1] > now && !hasRow.get(g, x[0])) reminded.set(x[0], x[1]);
    }
    for (const r of db.prepare("SELECT share_id, starts_at FROM raids WHERE guild_id = ? AND reminded = 1 AND share_id IS NOT NULL AND starts_at > ?").all(g, now)) {
      reminded.set(r.share_id, r.starts_at);
    }
    st.setJson(db, remindedKey, reminded.size ? [...reminded] : null);
    // My own records come back from the store too; without the outbox history they would look like changes in
    // my name that this computer never made (§5). The versions this computer holds as mine (sent from here,
    // older than this install, or answered "It was me") go into the log first; one with a question still open
    // or undone does not.
    keepMine(db, g);
    for (const [table, where] of [...RESET_TABLES, ...SHARE_TABLES]) removed[table] = db.prepare(`DELETE FROM ${table} WHERE ${where}`).run(g).changes;
    for (const key of shareSettings(g)) st.set(db, key, null);
    // When this guild's fresh start was, in sharing time: a call to arms from before it that comes back is not
    // posted to Discord again, and records from before it don't notify again (share/import.js).
    st.set(db, `share_reset:${g}`, st.serverNow(db));
    db.prepare(`UPDATE guilds SET roster_scanned_at = NULL, bank_money = NULL, bank_scanned_at = NULL, realm = NULL, game_guild = NULL,
      realm_status = NULL, official_roster_at = NULL, official_roster_note = NULL, reset_at = ?,
      last_played_at = MAX(COALESCE(last_played_at, 0), ?) WHERE id = ?`).run(new Date().toISOString(), Math.floor(Date.now() / 1000), g);
    db.prepare('UPDATE users SET last_sync_at = NULL WHERE id IN (SELECT user_id FROM memberships WHERE guild_id = ?)').run(g);
    // My unsent changes show again at once. Roles stay as they are (no rank sync until the roster comes back).
    const tasks = [];
    for (const { rec_id: id } of db.prepare("SELECT DISTINCT rec_id FROM share_outbox WHERE guild_id = ? AND state IN ('queued','waiting')").all(g)) {
      const e = st.effective(db, g, id);
      if (e) tasks.push(...project.tasksFor(e.rec, null));
    }
    project.run(db, g, tasks);
  })();
  return { backup: file, removed };
}

module.exports = { resetGuild, RESET_TABLES, SHARE_TABLES };
