// Database backups: a consistent snapshot with VACUUM INTO, kept for `keep` copies.
// Ported from the old web/src/backup.js.
//
// Exports
//   backupDir(dbFile) → '<dir of DB_FILE>/backups'   (/data/backups in Docker)
//   listBackups(dir) → [{ file: 'wow-YYYYMMDD-HHMMSS.db', bytes, at: ISO }] newest first ([] when the folder is missing)
//   runBackup(db, dir, { keep = 14, now = new Date() }) → full path of the snapshot (existing one for the same second)
//   backupIfDue(db, dir, hours = 24) → path, or null when the newest snapshot is younger than `hours`
//   isBackupName(name) → true for file names listBackups would show (use it before serving a download)
// Injected dependencies: none. Timers (cfg.timers only, never for DB_FILE ':memory:'): backupIfDue
// 30 s after start and then hourly, as the old server did.
const fs = require('fs');
const path = require('path');

const NAME = /^wow-\d{8}-\d{6}\.db$/;
const isBackupName = (name) => typeof name === 'string' && NAME.test(name);

function backupDir(dbFile) {
  return path.join(path.dirname(dbFile), 'backups');
}

function listBackups(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => NAME.test(f)).sort().reverse()
    .map((f) => { const st = fs.statSync(path.join(dir, f)); return { file: f, bytes: st.size, at: st.mtime.toISOString() }; });
}

function runBackup(db, dir, { keep = 14, now = new Date() } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const file = path.join(dir, `wow-${stamp}.db`);
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
