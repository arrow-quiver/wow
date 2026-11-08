'use strict';
// Backups of the local database (guildcamp.db): a consistent snapshot with VACUUM INTO, kept for `keep`
// copies in <dataDir>/backups. Ported from the old server (web/src/backup.js before that). The app shows
// them in Officer tools and can reveal one in the folder; nothing is downloaded from anywhere.
//
// Exports
//   backupDir(dbFile) → '<dir of guildcamp.db>/backups'
//   listBackups(dir) → [{ file: 'guildcamp-YYYYMMDD-HHMMSS.db', path, bytes, at: ISO }] newest first ([] when the folder is missing)
//   runBackup(db, dir, { keep = 14, now = new Date() }) → full path of the snapshot (existing one for the same second)
//   backupIfDue(db, dir, hours = 24) → path, or null when the newest snapshot is younger than `hours`
//   isBackupName(name) → true for file names listBackups would show
// Injected dependencies: none. Timers (cfg.timers only, never for an in-memory database): backupIfDue
// 30 s after start and then hourly.
const fs = require('fs');
const path = require('path');

const NAME = /^guildcamp-\d{8}-\d{6}\.db$/;
const isBackupName = (name) => typeof name === 'string' && NAME.test(name);

function backupDir(dbFile) {
  return path.join(path.dirname(dbFile), 'backups');
}

function listBackups(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => NAME.test(f)).sort().reverse()
    .map((f) => {
      const full = path.join(dir, f);
      const st = fs.statSync(full);
      return { file: f, path: full, bytes: st.size, at: st.mtime.toISOString() };
    });
}

function runBackup(db, dir, { keep = 14, now = new Date() } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const file = path.join(dir, `guildcamp-${stamp}.db`);
  if (fs.existsSync(file)) return file;
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  for (const old of listBackups(dir).slice(keep)) fs.unlinkSync(path.join(dir, old.file));
  return file;
}

// Back up if the newest snapshot is older than `hours`.
function backupIfDue(db, dir, hours = 24) {
  const newest = listBackups(dir)[0];
  if (newest && Date.now() - new Date(newest.at).getTime() < hours * 3600 * 1000) return null;
  return runBackup(db, dir);
}

module.exports = { backupDir, listBackups, runBackup, backupIfDue, isBackupName };
