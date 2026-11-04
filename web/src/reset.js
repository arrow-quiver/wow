// "Fresh start" for a guild: keeps people, settings and sync keys; wipes all game data.
// A backup is written first. Game data from before the reset is ignored if an old
// SavedVariables file (e.g. from Retail testing) uploads it again (see sync.js).
const backup = require('./backup');

function resetGuild(db, guildId, backupDir) {
  const file = backupDir ? backup.runBackup(db, backupDir, { keep: 30 }) : null;
  const g = guildId;
  const steps = [
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
  ];
  const removed = {};
  db.transaction(() => {
    for (const [table, where] of steps) removed[table] = db.prepare(`DELETE FROM ${table} WHERE ${where}`).run(g).changes;
    db.prepare(`UPDATE guilds SET roster_scanned_at = NULL, bank_money = NULL, bank_scanned_at = NULL, realm = NULL, game_guild = NULL,
      realm_status = NULL, official_roster_at = NULL, official_roster_note = NULL, reset_at = ? WHERE id = ?`).run(new Date().toISOString(), g);
    db.prepare('UPDATE users SET last_sync_at = NULL WHERE id IN (SELECT user_id FROM memberships WHERE guild_id = ?)').run(g);
  })();
  return { backup: file, removed };
}

module.exports = { resetGuild };
