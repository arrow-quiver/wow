// Raid consumables the Prices page tracks (Classic item ids; WoW: Forever uses the same ids).
// kind: flask | elixir | potion | food | weapon | other. Names are a fallback; item_names wins when known.
//
// Exports
//   RAID_CONSUMABLES   [{ id, name, kind }] in display order
//   KIND_LABEL         { flask: 'Flasks', … }

const RAID_CONSUMABLES = Object.freeze([
  { id: 13510, name: 'Flask of the Titans', kind: 'flask' },
  { id: 13511, name: 'Flask of Distilled Wisdom', kind: 'flask' },
  { id: 13512, name: 'Flask of Supreme Power', kind: 'flask' },
  { id: 13513, name: 'Flask of Chromatic Resistance', kind: 'flask' },
  { id: 13452, name: 'Elixir of the Mongoose', kind: 'elixir' },
  { id: 9206, name: 'Elixir of Giants', kind: 'elixir' },
  { id: 13454, name: 'Greater Arcane Elixir', kind: 'elixir' },
  { id: 21546, name: 'Elixir of Greater Firepower', kind: 'elixir' },
  { id: 9264, name: 'Elixir of Shadow Power', kind: 'elixir' },
  { id: 13445, name: 'Elixir of Superior Defense', kind: 'elixir' },
  { id: 3825, name: 'Elixir of Fortitude', kind: 'elixir' },
  { id: 20007, name: 'Mageblood Potion', kind: 'elixir' },
  { id: 13446, name: 'Major Healing Potion', kind: 'potion' },
  { id: 13444, name: 'Major Mana Potion', kind: 'potion' },
  { id: 18253, name: 'Major Rejuvenation Potion', kind: 'potion' },
  { id: 13457, name: 'Greater Fire Protection Potion', kind: 'potion' },
  { id: 13458, name: 'Greater Nature Protection Potion', kind: 'potion' },
  { id: 13456, name: 'Greater Frost Protection Potion', kind: 'potion' },
  { id: 13459, name: 'Greater Shadow Protection Potion', kind: 'potion' },
  { id: 13461, name: 'Greater Arcane Protection Potion', kind: 'potion' },
  { id: 5634, name: 'Free Action Potion', kind: 'potion' },
  { id: 3387, name: 'Limited Invulnerability Potion', kind: 'potion' },
  { id: 20452, name: 'Smoked Desert Dumplings', kind: 'food' },
  { id: 13928, name: 'Grilled Squid', kind: 'food' },
  { id: 13931, name: 'Nightfin Soup', kind: 'food' },
  { id: 18254, name: 'Runn Tum Tuber Surprise', kind: 'food' },
  { id: 21023, name: 'Dirge’s Kickin’ Chimaerok Chops', kind: 'food' },
  { id: 12451, name: 'Juju Power', kind: 'other' },
  { id: 12460, name: 'Juju Might', kind: 'other' },
  { id: 12820, name: 'Winterfall Firewater', kind: 'other' },
  { id: 20520, name: 'Dark Rune', kind: 'other' },
  { id: 12662, name: 'Demonic Rune', kind: 'other' },
  { id: 12404, name: 'Dense Sharpening Stone', kind: 'weapon' },
  { id: 12643, name: 'Dense Weightstone', kind: 'weapon' },
  { id: 18262, name: 'Elemental Sharpening Stone', kind: 'weapon' },
  { id: 20749, name: 'Brilliant Wizard Oil', kind: 'weapon' },
  { id: 20748, name: 'Brilliant Mana Oil', kind: 'weapon' },
]);

const KIND_LABEL = Object.freeze({ flask: 'Flasks', elixir: 'Elixirs', potion: 'Potions', food: 'Food', weapon: 'Weapon buffs', other: 'Other' });

module.exports = { RAID_CONSUMABLES, KIND_LABEL };
