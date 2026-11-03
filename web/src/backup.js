// Database backups: a consistent snapshot with VACUUM INTO, kept for `keep` days.
const fs = require('fs');
const path = require('path');

function backupDir(dbFile) {
  return path.join(path.dirname(dbFile), 'backups');
}

function listBackups(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /^wow-\d{8}-\d{6}\.db$/.test(f)).sort().reverse()
    .map((f) => ({ file: f, bytes: fs.statSync(path.join(dir, f)).size, at: fs.statSync(path.join(dir, f)).mtime.toISOString() }));
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

module.exports = { backupDir, listBackups, runBackup, backupIfDue };
