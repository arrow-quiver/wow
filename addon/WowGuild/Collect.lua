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
  rec.realm = GetRealmName and GetRealmName() or nil
  rec.updated = ns.now()
  ns.collectProfessions(rec)
  ns.collectReadiness(rec)
  ns.collectExtras(rec)
end

-- ---------- PvP, reputations, currencies ----------
-- Read whichever API this game version has; anything missing is simply skipped.
function ns.collectExtras(rec)
  if not safeCombat() then return end
  rec = rec or charRecord()
  local pvp = {}
  if UnitPVPRank and GetPVPRankInfo then
    local rank = ns.try(UnitPVPRank, "player")
    if rank and rank > 0 then
      local name, number = ns.try(GetPVPRankInfo, rank)
      pvp.rankName, pvp.rank = name, number or rank
    end
  end
  if GetPVPLifetimeStats then
    local hk, _, highest = ns.try(GetPVPLifetimeStats)
    pvp.hk = hk
    if highest and highest > 0 and GetPVPRankInfo then pvp.highestRank = (select(2, ns.try(GetPVPRankInfo, highest))) or highest end
  end
  if GetPVPThisWeekStats then pvp.weekHk, pvp.weekContribution = ns.try(GetPVPThisWeekStats) end
  if GetPVPLastWeekStats then
    local hk, _, contribution, rank = ns.try(GetPVPLastWeekStats)
    pvp.lastWeekHk, pvp.lastWeekContribution, pvp.lastWeekRank = hk, contribution, rank
  end
  if UnitHonorLevel then pvp.honorLevel = ns.try(UnitHonorLevel, "player") end
  if C_CurrencyInfo and C_CurrencyInfo.GetCurrencyInfo then
    local honor = ns.try(C_CurrencyInfo.GetCurrencyInfo, Constants and Constants.CurrencyConsts and Constants.CurrencyConsts.HONOR_CURRENCY_ID or 1792)
    if honor and honor.quantity then pvp.honor = honor.quantity end
  end
  if not pvp.honor and GetHonorCurrency then pvp.honor = ns.try(GetHonorCurrency) end
  rec.pvp = pvp

  local reps, header = {}, nil
  if C_Reputation and C_Reputation.GetNumFactions and C_Reputation.GetFactionDataByIndex then
    for i = 1, math.min(ns.try(C_Reputation.GetNumFactions) or 0, 200) do
      local f = ns.try(C_Reputation.GetFactionDataByIndex, i)
      if f and f.isHeader and not f.isHeaderWithRep then header = f.name
      elseif f and f.name then
        reps[#reps + 1] = { name = f.name, header = header, standing = f.reaction,
          value = (f.currentStanding or 0) - (f.currentReactionThreshold or 0),
          max = (f.nextReactionThreshold or 0) - (f.currentReactionThreshold or 0) }
      end
    end
  elseif GetNumFactions and GetFactionInfo then
    for i = 1, math.min(ns.try(GetNumFactions) or 0, 200) do
      local name, _, standing, barMin, barMax, barValue, _, _, isHeader, _, hasRep = ns.try(GetFactionInfo, i)
      if isHeader and not hasRep then header = name
      elseif name then
        reps[#reps + 1] = { name = name, header = header, standing = standing,
          value = (barValue or 0) - (barMin or 0), max = (barMax or 0) - (barMin or 0) }
      end
    end
  end
  if #reps > 0 then rec.reputations = reps end

  local cur = {}
  if C_CurrencyInfo and C_CurrencyInfo.GetCurrencyListSize and C_CurrencyInfo.GetCurrencyListInfo then
    for i = 1, math.min(ns.try(C_CurrencyInfo.GetCurrencyListSize) or 0, 150) do
      local x = ns.try(C_CurrencyInfo.GetCurrencyListInfo, i)
      if x and not x.isHeader and x.name and (x.quantity or 0) > 0 then
        cur[#cur + 1] = { name = x.name, qty = x.quantity, max = (x.maxQuantity or 0) > 0 and x.maxQuantity or nil,
          id = x.currencyID }
      end
    end
  end
  if #cur > 0 then rec.currencies = cur end
end

-- ---------- bags, bank and guild bank ----------
-- Item name comes from the item link, so it's always in the player's own language.
local function nameFromLink(link)
  return link and string.match(link, "%[(.-)%]")
end

function ns.bagIDs()
  local ids = {}
  local last = NUM_TOTAL_EQUIPPED_BAG_SLOTS or NUM_BAG_SLOTS or 4
  for bag = 0, last do ids[#ids + 1] = bag end
  return ids
end

function ns.bankIDs()
  local ids, seen = {}, {}
  local function add(id) if id and not seen[id] then seen[id] = true; ids[#ids + 1] = id end end
  add(BANK_CONTAINER or -1)
  local first = (NUM_TOTAL_EQUIPPED_BAG_SLOTS or NUM_BAG_SLOTS or 4) + 1
  for bag = first, first + (NUM_BANKBAGSLOTS or 7) - 1 do add(bag) end
  if Enum and Enum.BagIndex then
    for key, id in pairs(Enum.BagIndex) do
      if type(key) == "string" and string.find(key, "^CharacterBankTab") then add(id) end
    end
  end
  return ids
end

-- Returns a list of { id, name, count } with stacks added together.
function ns.scanContainers(bagIDs)
  local numSlots = (C_Container and C_Container.GetContainerNumSlots) or GetContainerNumSlots
  local slotInfo = C_Container and C_Container.GetContainerItemInfo
  local byId, out = {}, {}
  if not numSlots or not slotInfo then return out end
  for _, bag in ipairs(bagIDs) do
    for slot = 1, (ns.try(numSlots, bag) or 0) do
      local info = ns.try(slotInfo, bag, slot)
      if info and info.itemID then
        local e = byId[info.itemID]
        if not e then
          e = { id = info.itemID, name = nameFromLink(info.hyperlink), count = 0 }
          byId[info.itemID] = e
          out[#out + 1] = e
        end
        e.count = e.count + (info.stackCount or 1)
      end
    end
  end
  return out
end

function ns.collectBank()
  if not safeCombat() or not ns.opt("collectBank") then return end
  local rec = charRecord()
  rec.inventory = rec.inventory or {}
  rec.inventory.bank = ns.scanContainers(ns.bankIDs())
  rec.inventory.bankAt = ns.now()
end

-- Guild bank: readable only while it's open. The game's log says "x hours ago",
-- so we turn that into an approximate time.
local guildBankOpen = false
function ns.collectGuildBank()
  if not safeCombat() or not guildBankOpen or not GetNumGuildBankTabs or not ns.opt("collectBank") then return end
  local tabs = {}
  local slotsPerTab = MAX_GUILDBANK_SLOTS_PER_TAB or 98
  for tab = 1, (ns.try(GetNumGuildBankTabs) or 0) do
    local name, _, isViewable = ns.try(GetGuildBankTabInfo, tab)
    if isViewable ~= false then
      local byId, items = {}, {}
      for slot = 1, slotsPerTab do
        local link = ns.try(GetGuildBankItemLink, tab, slot)
        if link then
          local _, count = ns.try(GetGuildBankItemInfo, tab, slot)
          local id = tonumber(string.match(link, "item:(%d+)"))
          if id then
            local e = byId[id]
            if not e then e = { id = id, name = nameFromLink(link), count = 0 }; byId[id] = e; items[#items + 1] = e end
            e.count = e.count + (count or 1)
          end
        end
      end
      tabs[#tabs + 1] = { name = name or ("Tab " .. tab), items = items }
    end
  end
  local now = ns.now()
  local function ago(y, mo, d, h) return now - ((((y or 0) * 365 + (mo or 0) * 30 + (d or 0)) * 24 + (h or 0)) * 3600) end
  local log = {}
  if GetNumGuildBankTransactions and GetGuildBankTransaction then
    for tab = 1, #tabs do
      for i = 1, (ns.try(GetNumGuildBankTransactions, tab) or 0) do
        local kind, who, link, count, _, _, y, mo, d, h = ns.try(GetGuildBankTransaction, tab, i)
        if kind then
          log[#log + 1] = { kind = kind, who = who, id = link and tonumber(string.match(link, "item:(%d+)")),
            name = nameFromLink(link), count = count, at = ago(y, mo, d, h) }
        end
      end
    end
  end
  if GetNumGuildBankMoneyTransactions and GetGuildBankMoneyTransaction then
    for i = 1, (ns.try(GetNumGuildBankMoneyTransactions) or 0) do
      local kind, who, amount, y, mo, d, h = ns.try(GetGuildBankMoneyTransaction, i)
      if kind then log[#log + 1] = { kind = kind, who = who, amount = amount, at = ago(y, mo, d, h) } end
    end
  end
  ns.db.guildBank = { scannedAt = now, guild = GetGuildInfo("player"), money = ns.try(GetGuildBankMoney), tabs = tabs, log = log }
end

local function queryGuildBank()
  if not GetNumGuildBankTabs then return end
  for tab = 1, (ns.try(GetNumGuildBankTabs) or 0) do
    ns.try(QueryGuildBankTab, tab)
    ns.try(QueryGuildBankLog, tab)
  end
  ns.try(QueryGuildBankLog, (MAX_GUILDBANK_TABS or 8) + 1)
end

local gbPending = false
local function scheduleGuildBank()
  if gbPending then return end
  gbPending = true
  C_Timer.After(1, function() gbPending = false; ns.collectGuildBank() end)
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
  local instant = (C_Item and C_Item.GetItemInfoInstant) or GetItemInfoInstant
  local bags = ns.scanContainers(ns.bagIDs())
  for _, it in ipairs(bags) do
    local _, _, _, _, _, classID, subclassID = ns.try(instant, it.id)
    if classID == 0 then
      local kind = CONSUMABLE_KIND[subclassID] or "other"
      r.consumables[kind] = (r.consumables[kind] or 0) + it.count
    end
  end
  rec.inventory = rec.inventory or {}
  rec.inventory.bags = bags
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
-- Reputation and currency events fire often (every loot); refresh at most every few seconds.
local extrasPending = false
local function refreshExtras()
  if extrasPending then return end
  extrasPending = true
  C_Timer.After(3, function() extrasPending = false; if safeCombat() then ns.collectExtras() end end)
end
ns.on("UPDATE_FACTION", refreshExtras)
ns.on("CURRENCY_DISPLAY_UPDATE", refreshExtras)
ns.on("BANKFRAME_OPENED", function() C_Timer.After(0.5, ns.collectBank) end)
ns.on("PLAYERBANKSLOTS_CHANGED", function() C_Timer.After(0.5, ns.collectBank) end)
ns.on("BANKFRAME_CLOSED", function() ns.collectBank() end)
ns.on("GUILDBANKFRAME_OPENED", function() guildBankOpen = true; queryGuildBank(); scheduleGuildBank() end)
ns.on("GUILDBANKBAGSLOTS_CHANGED", scheduleGuildBank)
ns.on("GUILDBANKLOG_UPDATE", scheduleGuildBank)
ns.on("GUILDBANK_UPDATE_MONEY", scheduleGuildBank)
ns.on("GUILDBANKFRAME_CLOSED", function() ns.collectGuildBank(); guildBankOpen = false end)
-- Newer clients report bank and guild bank windows through one event pair.
ns.on("PLAYER_INTERACTION_MANAGER_FRAME_SHOW", function(kind)
  local T = Enum and Enum.PlayerInteractionType
  if not T then return end
  if kind == T.Banker then C_Timer.After(0.5, ns.collectBank)
  elseif kind == T.GuildBanker then guildBankOpen = true; queryGuildBank(); scheduleGuildBank() end
end)
ns.on("PLAYER_INTERACTION_MANAGER_FRAME_HIDE", function(kind)
  local T = Enum and Enum.PlayerInteractionType
  if T and kind == T.GuildBanker then ns.collectGuildBank(); guildBankOpen = false end
end)
