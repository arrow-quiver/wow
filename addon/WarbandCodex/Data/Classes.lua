-- Warband Codex: per-class starting points. Stat weights per talent tree (how much one point of a stat is worth
-- next to the others, for scoring gear) and the Classic armour sets. The weights are sensible defaults, not
-- simulation results: good enough to tell an upgrade from a side-grade. The Armory shows which set it is using.
local ADDON, ns = ...
ns.data = ns.data or {}

-- Keys are the game's own stat names from GetItemStats.
local STR, AGI, STA, INT, SPI = "ITEM_MOD_STRENGTH_SHORT", "ITEM_MOD_AGILITY_SHORT", "ITEM_MOD_STAMINA_SHORT", "ITEM_MOD_INTELLECT_SHORT", "ITEM_MOD_SPIRIT_SHORT"
local AP, RAP, SP, HEAL = "ITEM_MOD_ATTACK_POWER_SHORT", "ITEM_MOD_RANGED_ATTACK_POWER_SHORT", "ITEM_MOD_SPELL_POWER_SHORT", "ITEM_MOD_SPELL_HEALING_DONE_SHORT"
local CRIT, HIT, MP5, DEF, DODGE = "ITEM_MOD_CRIT_RATING_SHORT", "ITEM_MOD_HIT_RATING_SHORT", "ITEM_MOD_POWER_REGEN0_SHORT", "ITEM_MOD_DEFENSE_SKILL_RATING_SHORT", "ITEM_MOD_DODGE_RATING_SHORT"
local ARMOR, DPS = "RESISTANCE0_NAME", "ITEM_MOD_DAMAGE_PER_SECOND_SHORT"
ns.data.statNames = {
  [STR] = "Strength", [AGI] = "Agility", [STA] = "Stamina", [INT] = "Intellect", [SPI] = "Spirit", [AP] = "Attack power",
  [RAP] = "Ranged attack power", [SP] = "Spell power", [HEAL] = "Healing", [CRIT] = "Crit", [HIT] = "Hit", [MP5] = "Mana per 5",
  [DEF] = "Defense", [DODGE] = "Dodge", [ARMOR] = "Armor", [DPS] = "Weapon damage",
}

local melee = { [STR] = 1, [AGI] = 0.8, [AP] = 0.5, [CRIT] = 14, [HIT] = 12, [STA] = 0.4, [DPS] = 6 }
local tank = { [STA] = 1.2, [DEF] = 1.5, [DODGE] = 12, [ARMOR] = 0.08, [STR] = 0.6, [AGI] = 0.6, [HIT] = 8, [DPS] = 3 }
local caster = { [SP] = 1, [INT] = 0.5, [CRIT] = 8, [HIT] = 10, [STA] = 0.3, [SPI] = 0.15, [MP5] = 1.2 }
local healer = { [HEAL] = 1, [SP] = 0.9, [INT] = 0.7, [MP5] = 2.2, [SPI] = 0.5, [CRIT] = 5, [STA] = 0.3 }
local agi = { [AGI] = 1, [AP] = 0.5, [RAP] = 0.5, [CRIT] = 14, [HIT] = 14, [STR] = 0.5, [STA] = 0.4, [DPS] = 6 }

-- class → { tree 1, tree 2, tree 3 } as { label, weights } in the talent window's order.
ns.data.specs = {
  WARRIOR = { { "Arms", melee }, { "Fury", melee }, { "Protection", tank } },
  PALADIN = { { "Holy", healer }, { "Protection", tank }, { "Retribution", melee } },
  HUNTER = { { "Beast Mastery", agi }, { "Marksmanship", agi }, { "Survival", agi } },
  ROGUE = { { "Assassination", agi }, { "Combat", agi }, { "Subtlety", agi } },
  PRIEST = { { "Discipline", healer }, { "Holy", healer }, { "Shadow", caster } },
  SHAMAN = { { "Elemental", caster }, { "Enhancement", melee }, { "Restoration", healer } },
  MAGE = { { "Arcane", caster }, { "Fire", caster }, { "Frost", caster } },
  WARLOCK = { { "Affliction", caster }, { "Demonology", caster }, { "Destruction", caster } },
  DRUID = { { "Balance", caster }, { "Feral Combat", agi }, { "Restoration", healer } },
}

-- Classic sets by class: { set name, where it comes from, the word its pieces share }.
ns.data.sets = {
  WARRIOR = { { "Battlegear of Valor", "Dungeon set 1", "Valor" }, { "Battlegear of Might", "Molten Core", "Might" }, { "Battlegear of Wrath", "Blackwing Lair", "Wrath" } },
  PALADIN = { { "Lightforge Armor", "Dungeon set 1", "Lightforge" }, { "Lawbringer Armor", "Molten Core", "Lawbringer" }, { "Judgement Armor", "Blackwing Lair", "Judgement" } },
  HUNTER = { { "Beaststalker Armor", "Dungeon set 1", "Beaststalker's" }, { "Giantstalker Armor", "Molten Core", "Giantstalker's" }, { "Dragonstalker Armor", "Blackwing Lair", "Dragonstalker's" } },
  ROGUE = { { "Shadowcraft Armor", "Dungeon set 1", "Shadowcraft" }, { "Nightslayer Armor", "Molten Core", "Nightslayer" }, { "Bloodfang Armor", "Blackwing Lair", "Bloodfang" } },
  PRIEST = { { "Vestments of the Devout", "Dungeon set 1", "Devout" }, { "Vestments of Prophecy", "Molten Core", "Prophecy" }, { "Vestments of Transcendence", "Blackwing Lair", "Transcendence" } },
  SHAMAN = { { "The Elements", "Dungeon set 1", "Elements" }, { "The Earthfury", "Molten Core", "Earthfury" }, { "The Ten Storms", "Blackwing Lair", "Ten Storms" } },
  MAGE = { { "Magister's Regalia", "Dungeon set 1", "Magister's" }, { "Arcanist Regalia", "Molten Core", "Arcanist" }, { "Netherwind Regalia", "Blackwing Lair", "Netherwind" } },
  WARLOCK = { { "Dreadmist Raiment", "Dungeon set 1", "Dreadmist" }, { "Felheart Raiment", "Molten Core", "Felheart" }, { "Nemesis Raiment", "Blackwing Lair", "Nemesis" } },
  DRUID = { { "Wildheart Raiment", "Dungeon set 1", "Wildheart" }, { "Cenarion Raiment", "Molten Core", "Cenarion" }, { "Stormrage Raiment", "Blackwing Lair", "Stormrage" } },
}
ns.data.setSize = 8

ns.data.classNames = { WARRIOR = "Warrior", PALADIN = "Paladin", HUNTER = "Hunter", ROGUE = "Rogue", PRIEST = "Priest",
  SHAMAN = "Shaman", MAGE = "Mage", WARLOCK = "Warlock", DRUID = "Druid" }
ns.data.classColors = { WARRIOR = "c79c6e", PALADIN = "f58cba", HUNTER = "abd473", ROGUE = "fff569", PRIEST = "ffffff",
  SHAMAN = "0070de", MAGE = "69ccf0", WARLOCK = "9482c9", DRUID = "ff7d0a" }
