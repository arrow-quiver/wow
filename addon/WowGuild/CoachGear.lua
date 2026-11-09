-- Guild Camp: the Coach on item tooltips. Scores gear with your build plan's stat priorities (the plan's "stats",
-- most important first) and says whether an item beats what you're wearing in that slot.
-- Reads item stats only out of combat. Shows nothing without a plan.
local ADDON, ns = ...
local G = {}
ns.coachGear = G

-- Plan stat words → the game's stat keys. Checked in order, so "attack power" wins over "power".
local STAT_WORDS = {
  { "attack power", { "ITEM_MOD_ATTACK_POWER_SHORT", "ITEM_MOD_RANGED_ATTACK_POWER_SHORT" } },
  { "spell power", { "ITEM_MOD_SPELL_POWER_SHORT", "ITEM_MOD_SPELL_DAMAGE_DONE_SHORT" } },
  { "spell damage", { "ITEM_MOD_SPELL_POWER_SHORT", "ITEM_MOD_SPELL_DAMAGE_DONE_SHORT" } },
  { "healing", { "ITEM_MOD_SPELL_HEALING_DONE_SHORT", "ITEM_MOD_SPELL_POWER_SHORT" } },
  { "strength", { "ITEM_MOD_STRENGTH_SHORT" } },
  { "agility", { "ITEM_MOD_AGILITY_SHORT" } },
  { "stamina", { "ITEM_MOD_STAMINA_SHORT" } },
  { "intellect", { "ITEM_MOD_INTELLECT_SHORT" } },
  { "spirit", { "ITEM_MOD_SPIRIT_SHORT" } },
  { "crit", { "ITEM_MOD_CRIT_RATING_SHORT", "ITEM_MOD_CRIT_MELEE_RATING_SHORT", "ITEM_MOD_CRIT_SPELL_RATING_SHORT", "ITEM_MOD_CRIT_RANGED_RATING_SHORT" } },
  { "hit", { "ITEM_MOD_HIT_RATING_SHORT", "ITEM_MOD_HIT_MELEE_RATING_SHORT", "ITEM_MOD_HIT_SPELL_RATING_SHORT", "ITEM_MOD_HIT_RANGED_RATING_SHORT" } },
  { "haste", { "ITEM_MOD_HASTE_RATING_SHORT" } },
  { "mp5", { "ITEM_MOD_MANA_REGENERATION_SHORT", "ITEM_MOD_POWER_REGEN0_SHORT" } },
  { "mana per", { "ITEM_MOD_MANA_REGENERATION_SHORT", "ITEM_MOD_POWER_REGEN0_SHORT" } },
  { "defense", { "ITEM_MOD_DEFENSE_SKILL_RATING_SHORT" } },
  { "dodge", { "ITEM_MOD_DODGE_RATING_SHORT" } },
  { "parry", { "ITEM_MOD_PARRY_RATING_SHORT" } },
  { "block", { "ITEM_MOD_BLOCK_RATING_SHORT", "ITEM_MOD_BLOCK_VALUE_SHORT" } },
  { "armor", { "RESISTANCE0_NAME" } },
  { "dps", { "ITEM_MOD_DAMAGE_PER_SECOND_SHORT" } },
}
local WEIGHTS = { 1, 0.8, 0.62, 0.48, 0.37, 0.28 }
-- Stats that come in big numbers (armor, attack power) count less per point than primary stats.
local SCALE = { RESISTANCE0_NAME = 0.05, ITEM_MOD_ATTACK_POWER_SHORT = 0.5, ITEM_MOD_RANGED_ATTACK_POWER_SHORT = 0.5,
  ITEM_MOD_DAMAGE_PER_SECOND_SHORT = 2, ITEM_MOD_HIT_RATING_SHORT = 8, ITEM_MOD_HIT_MELEE_RATING_SHORT = 8, ITEM_MOD_HIT_SPELL_RATING_SHORT = 8,
  ITEM_MOD_CRIT_RATING_SHORT = 8, ITEM_MOD_CRIT_MELEE_RATING_SHORT = 8, ITEM_MOD_CRIT_SPELL_RATING_SHORT = 8 }

local function hasWord(s, w) return string.find(" " .. s .. " ", "[^%a]" .. w .. "[^%a]") ~= nil end

-- { [statKey] = weight } from the plan's stat list.
function G.weights(plan)
  if not plan or type(plan.stats) ~= "table" then return nil end
  local w, any = {}, false
  for i, label in ipairs(plan.stats) do
    local s = string.lower(tostring(label))
    for _, pair in ipairs(STAT_WORDS) do
      if hasWord(s, pair[1]) then
        for _, key in ipairs(pair[2]) do if not w[key] then w[key] = (WEIGHTS[i] or 0.2) * (SCALE[key] or 1); any = true end end
        break
      end
    end
  end
  return any and w or nil
end

local function stats(link)
  local get = (C_Item and C_Item.GetItemStats) or GetItemStats
  if not get or not link then return nil end
  local t = ns.try(get, link)
  return type(t) == "table" and t or nil
end

function G.score(link, w)
  local t = stats(link)
  if not t then return nil end
  local total = 0
  for key, v in pairs(t) do if w[key] and type(v) == "number" then total = total + w[key] * v end end
  return total
end

local SLOTS = {
  INVTYPE_HEAD = { 1 }, INVTYPE_NECK = { 2 }, INVTYPE_SHOULDER = { 3 }, INVTYPE_CHEST = { 5 }, INVTYPE_ROBE = { 5 },
  INVTYPE_WAIST = { 6 }, INVTYPE_LEGS = { 7 }, INVTYPE_FEET = { 8 }, INVTYPE_WRIST = { 9 }, INVTYPE_HAND = { 10 },
  INVTYPE_FINGER = { 11, 12 }, INVTYPE_TRINKET = { 13, 14 }, INVTYPE_CLOAK = { 15 },
  INVTYPE_WEAPON = { 16, 17 }, INVTYPE_2HWEAPON = { 16 }, INVTYPE_WEAPONMAINHAND = { 16 }, INVTYPE_WEAPONOFFHAND = { 17 },
  INVTYPE_HOLDABLE = { 17 }, INVTYPE_SHIELD = { 17 }, INVTYPE_RANGED = { 18 }, INVTYPE_RANGEDRIGHT = { 18 },
  INVTYPE_THROWN = { 18 }, INVTYPE_RELIC = { 18 },
}

local function equipLoc(link)
  if C_Item and C_Item.GetItemInfoInstant then
    local _, _, _, loc = ns.try(C_Item.GetItemInfoInstant, link)
    if loc then return loc end
  end
  if GetItemInfoInstant then local _, _, _, loc = ns.try(GetItemInfoInstant, link); if loc then return loc end end
  local info = (C_Item and C_Item.GetItemInfo) or GetItemInfo
  if info then local r = { ns.try(info, link) }; return r[9] end
end

-- → { text, r, g, b } for the tooltip, or nil.
function G.verdict(link)
  if not link or (InCombatLockdown and InCombatLockdown()) then return nil end
  local w = ns.coach and G.weights(ns.coach.plan())
  if not w then return nil end
  local slots = SLOTS[equipLoc(link) or ""]
  if not slots then return nil end
  local new = G.score(link, w)
  if not new then return nil end
  -- Compare with the weaker of the items in the slots it can go in (an empty slot is 0).
  local old, same
  local myId = tonumber(string.match(link, "item:(%d+)"))
  for _, slot in ipairs(slots) do
    local worn = GetInventoryItemLink and ns.try(GetInventoryItemLink, "player", slot)
    if worn and myId and tonumber(string.match(worn, "item:(%d+)")) == myId then same = true end
    local s = worn and (G.score(worn, w) or 0) or 0
    if old == nil or s < old then old = s end
  end
  if same then return { "You're wearing this", 0.62, 0.62, 0.66 } end
  old = old or 0
  local diff = new - old
  if new <= 0 and old <= 0 then return nil end -- none of the stats your build wants, on either
  if old <= 0 then return { "Upgrade for your build (empty slot)", 0.45, 0.85, 0.5 } end
  if new <= 0 then return { "Worse for your build (none of your stats)", 0.9, 0.4, 0.35 } end
  local pct = math.floor(diff / old * 100 + 0.5)
  if pct >= 3 then return { string.format("Upgrade for your build (+%d%%)", pct), 0.45, 0.85, 0.5 } end
  if pct <= -3 then return { string.format("Worse for your build (%d%%)", pct), 0.9, 0.4, 0.35 } end
  return { "About the same for your build", 0.85, 0.85, 0.85 }
end
