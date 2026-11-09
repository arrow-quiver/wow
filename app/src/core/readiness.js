// Raid readiness extras from newer addons: talent points per tree, resistances and unenchanted gear.
// Used for my own uploads (services/sync.js) and guildmates' ch records (share/project.js), and by the raid routes.
//
// Exports
//   raidGear(r, whole) → { talents?, resists?, unenchanted? }   only the keys with data (unenchanted only beside one of the others)
//       r: { talents: { a, b, c, unspent }, resists: { fire, nature, frost, shadow, arcane }, unenchanted: [slot id] }
//       whole(v) → whole number or null
//   ENCHANT_SLOTS   { slotId: 'Chest', … }  the slots the Enchanting profession covers (addon Collect.ENCHANT_SLOTS)
//   resistFor(instance) → 'fire' | 'nature' | 'frost' | null   the resistance a raid instance calls for
// Injected dependencies: none.

const ENCHANT_SLOTS = Object.freeze({ 5: 'Chest', 8: 'Feet', 9: 'Wrist', 10: 'Hands', 15: 'Back', 16: 'Main hand' });
const SCHOOLS = ['fire', 'nature', 'frost', 'shadow', 'arcane'];

function raidGear(r, whole) {
  const out = {};
  const t = r && r.talents;
  if (t && typeof t === 'object' && ['a', 'b', 'c'].some((k) => whole(t[k]) != null)) {
    out.talents = { a: whole(t.a) || 0, b: whole(t.b) || 0, c: whole(t.c) || 0, unspent: whole(t.unspent) || 0 };
  }
  const s = r && r.resists;
  if (s && typeof s === 'object' && SCHOOLS.some((k) => whole(s[k]) != null)) {
    const res = {};
    for (const k of SCHOOLS) res[k] = whole(s[k]) || 0;
    out.resists = res;
  }
  // An empty list from an older addon (no resists either) means "not checked", not "all enchanted".
  if (r && Array.isArray(r.unenchanted) && (out.resists || out.talents)) {
    out.unenchanted = [...new Set(r.unenchanted.map(whole).filter((x) => x != null && ENCHANT_SLOTS[x]))].sort((a, b) => a - b);
  }
  return out;
}

// Molten Core and Onyxia: fire. Ahn'Qiraj (the 40-player temple): nature. Naxxramas: frost.
const RESIST_BY_INSTANCE = [
  [/molten core|onyxia/i, 'fire'],
  [/temple of ahn|ahn'?qiraj temple|\baq ?40\b/i, 'nature'],
  [/naxxramas/i, 'frost'],
];
function resistFor(instance) {
  const name = String(instance || '');
  for (const [re, school] of RESIST_BY_INSTANCE) if (re.test(name)) return school;
  return null;
}

module.exports = { raidGear, resistFor, ENCHANT_SLOTS };
