-- wow guild: data collectors. All out of combat.
local ADDON, ns = ...

local function safeCombat() return not (InCombatLockdown and InCombatLockdown()) end

local function charRecord()
  local key = ns.charKey()
  local rec = ns.db.characters[key] or {}
  ns.db.characters[key] = rec
  return rec
end

-- ---------- this character ----------
function ns.collectCharacter()
  local rec = charRecord()
  rec.name = UnitName("player")
  local _, classToken = UnitClass("player")
  rec.class = classToken
  rec.race = UnitRace("player")
  rec.level = UnitLevel("player")
  rec.faction = UnitFactionGroup("player")
  rec.zone = GetRealZoneText and GetRealZoneText() or GetZoneText()
  rec.money = GetMoney and GetMoney() or nil
  rec.guild = GetGuildInfo and GetGuildInfo("player") or nil
  rec.updated = ns.now()
  ns.collectProfessions(rec)
  ns.collectReadiness(rec)
end

-- ---------- raid readiness (out of combat) ----------
-- Item level, repair state and consumables in bags, shown next to raid sign-ups.
local CONSUMABLE_KIND = { [1] = "potion", [2] = "elixir", [3] = "flask", [5] = "food", [7] = "bandage" }

function ns.collectReadiness(rec)
  if not safeCombat() then return end
  rec = rec or charRecord()
  local r = { at = ns.now(), consumables = {} }
  if GetAverageItemLevel then
    local overall, equipped = ns.try(GetAverageItemLevel)
    r.ilvl = equipped or overall
  end
  if GetInventoryItemDurability then
    local cur, max = 0, 0
    for slot = 1, 19 do
      local c, m = ns.try(GetInventoryItemDurability, slot)
      if c and m and m > 0 then cur, max = cur + c, max + m end
    end
    if max > 0 then r.durability = math.floor(cur / max * 100 + 0.5) end
  end
  local numSlots = (C_Container and C_Container.GetContainerNumSlots) or GetContainerNumSlots
  local slotInfo = C_Container and C_Container.GetContainerItemInfo
  local instant = (C_Item and C_Item.GetItemInfoInstant) or GetItemInfoInstant
  if numSlots and slotInfo and instant then
    for bag = 0, (NUM_BAG_SLOTS or 4) do
      for slot = 1, (ns.try(numSlots, bag) or 0) do
        local info = ns.try(slotInfo, bag, slot)
        if info and info.itemID then
          local _, _, _, _, _, classID, subclassID = ns.try(instant, info.itemID)
          if classID == 0 then
            local kind = CONSUMABLE_KIND[subclassID] or "other"
            r.consumables[kind] = (r.consumables[kind] or 0) + (info.stackCount or 1)
          end
        end
      end
    end
  end
  rec.readiness = r
end

-- Professions: modern API first, older skill-line API as a fallback, since
-- we can't be sure which one a given game version exposes.
function ns.collectProfessions(rec)
  rec = rec or charRecord()
  local out = {}
  if GetProfessions and GetProfessionInfo then
    local list = { ns.try(GetProfessions) }
    for i = 1, 5 do
      local idx = list[i]
      if idx then
        local name, _, skill, max = ns.try(GetProfessionInfo, idx)
        if name then out[#out + 1] = { name = name, skill = skill, max = max } end
      end
    end
  end
  if #out == 0 and GetNumSkillLines and GetSkillLineInfo then
    local inProf = false
    for i = 1, (ns.try(GetNumSkillLines) or 0) do
      local name, isHeader, _, rank, _, _, max = ns.try(GetSkillLineInfo, i)
      if isHeader then
        inProf = (name == TRADE_SKILLS or name == "Professions" or name == "Secondary Skills" or name == SECONDARY_SKILLS)
      elseif inProf and name then
        out[#out + 1] = { name = name, skill = rank, max = max }
      end
    end
  end
  if #out > 0 then rec.professions = out end
end

-- Recipes are only readable while a profession window is open, so we
-- capture them whenever the player opens one.
local function professionName()
  if C_TradeSkillUI and C_TradeSkillUI.GetBaseProfessionInfo then
    local info = ns.try(C_TradeSkillUI.GetBaseProfessionInfo)
    if info and info.professionName and info.professionName ~= "" then return info.professionName end
  end
  if GetTradeSkillLine then
    local name = ns.try(GetTradeSkillLine)
    if name and name ~= "UNKNOWN" then return name end
  end
end

function ns.collectRecipes()
  if not safeCombat() then return end
  -- Skip guildies' and NPCs' linked profession windows.
  if C_TradeSkillUI and C_TradeSkillUI.IsTradeSkillLinked and ns.try(C_TradeSkillUI.IsTradeSkillLinked) then return end
  if C_TradeSkillUI and C_TradeSkillUI.IsTradeSkillGuild and ns.try(C_TradeSkillUI.IsTradeSkillGuild) then return end
  local prof = professionName()
  if not prof then return end
  local list = {}
  if C_TradeSkillUI and C_TradeSkillUI.GetAllRecipeIDs then
    for _, id in ipairs(ns.try(C_TradeSkillUI.GetAllRecipeIDs) or {}) do
      local info = ns.try(C_TradeSkillUI.GetRecipeInfo, id)
      if info and info.learned and info.name then list[#list + 1] = { id = id, name = info.name } end
    end
  end
  if #list == 0 and GetNumTradeSkills and GetTradeSkillInfo then
    for i = 1, (ns.try(GetNumTradeSkills) or 0) do
      local name, kind = ns.try(GetTradeSkillInfo, i)
      if name and kind ~= "header" and kind ~= "subheader" then list[#list + 1] = { name = name } end
    end
  end
  if #list > 0 then
    local rec = charRecord()
    rec.recipes = rec.recipes or {}
    local before = rec.recipes[prof] and #rec.recipes[prof] or 0
    rec.recipes[prof] = list
    if #list ~= before then ns.print(string.format("Saved %d %s recipes for the guild crafter list.", #list, prof)) end
  end
end

-- Older clients use a separate Craft window (e.g. Enchanting).
function ns.collectCrafts()
  if not safeCombat() or not GetNumCrafts or not GetCraftInfo then return end
  local prof = GetCraftDisplaySkillLine and ns.try(GetCraftDisplaySkillLine)
  if not prof then return end
  local list = {}
  for i = 1, (ns.try(GetNumCrafts) or 0) do
    local name, _, kind = ns.try(GetCraftInfo, i)
    if name and kind ~= "header" then list[#list + 1] = { name = name } end
  end
  if #list > 0 then
    local rec = charRecord()
    rec.recipes = rec.recipes or {}
    rec.recipes[prof] = list
  end
end

-- ---------- guild roster ----------
-- One member's scan updates everyone's online status on the site.
function ns.collectRoster()
  if not safeCombat() or not IsInGuild or not IsInGuild() then return end
  local n = ns.try(GetNumGuildMembers) or 0
  if n == 0 then return end
  local members = {}
  for i = 1, n do
    local name, rank, _, level, _, zone, _, _, online, _, classToken = ns.try(GetGuildRosterInfo, i)
    if name then
      if Ambiguate then name = Ambiguate(name, "guild") end
      members[#members + 1] = {
        name = name, rank = rank, level = level, zone = zone,
        online = online and true or false, class = classToken,
      }
    end
  end
  ns.db.roster = { scannedAt = ns.now(), guild = GetGuildInfo("player"), members = members }
end

local function requestRoster()
  if C_GuildInfo and C_GuildInfo.GuildRoster then ns.try(C_GuildInfo.GuildRoster)
  elseif GuildRoster then ns.try(GuildRoster) end
end

function ns.collectAll(reason)
  if not safeCombat() then return end
  ns.collectCharacter()
  ns.collectRoster()
end

-- ---------- wiring ----------
local lastRoster = 0
function ns.onLogin()
  ns.collectCharacter()
  requestRoster()
  ns.showLoginNews()
  -- Refresh the roster every 5 minutes while out of combat.
  C_Timer.NewTicker(300, function()
    if safeCombat() then requestRoster() end
  end)
end

ns.on("GUILD_ROSTER_UPDATE", function()
  if ns.now() - lastRoster < 20 then return end
  lastRoster = ns.now()
  ns.collectRoster()
end)
ns.on("PLAYER_LEVEL_UP", function() C_Timer.After(1, ns.collectCharacter) end)
ns.on("SKILL_LINES_CHANGED", function() if safeCombat() then ns.collectProfessions() end end)
ns.on("TRADE_SKILL_SHOW", function() C_Timer.After(0.5, ns.collectRecipes) end)
ns.on("TRADE_SKILL_LIST_UPDATE", function() C_Timer.After(0.5, ns.collectRecipes) end)
ns.on("TRADE_SKILL_DATA_SOURCE_CHANGED", function() C_Timer.After(0.5, ns.collectRecipes) end)
ns.on("NEW_RECIPE_LEARNED", function() C_Timer.After(0.5, ns.collectRecipes) end)
ns.on("CRAFT_SHOW", function() C_Timer.After(0.5, ns.collectCrafts) end)
ns.on("CRAFT_UPDATE", function() C_Timer.After(0.5, ns.collectCrafts) end)
ns.on("PLAYER_REGEN_ENABLED", function() ns.collectCharacter() end)
