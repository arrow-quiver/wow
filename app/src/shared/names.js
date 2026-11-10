'use strict';
// Character names as the game hands them out. Some realms (WoW Forever) show a surname after the name
// ("Gorm Tshabalala"), and cross-realm names carry "-Realm". The character itself is the first word: what
// UnitName, whispers and shared records use. baseName gives that.
function baseName(n) {
  if (n == null) return n;
  const s = String(n).trim();
  return s.split('-')[0].split(/\s+/)[0] || s;
}

module.exports = { baseName };
