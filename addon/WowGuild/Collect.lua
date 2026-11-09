-- Guild Camp: data collectors. All out of combat.
--
-- Two jobs:
--   1. Fill WowGuildDB (characters, roster, guildBank ...) for the Guild Camp app, as before.
--   2. Build this character's shared records for guildmates (docs/SHARING.md §4.3, Appendix A):
--      ns.Collect.sharedRecords() -> { { type, key, fields }, ... } with ch, rc, bk and sh, which
--      the sharing engine (Share.lua) calls when it becomes ready; and gb, offered per guild bank
--      tab (ns.Share.offer) when the guild bank window closes.
-- Every call into ns.Share is guarded, so everything here works when Share.lua is missing.
local ADDON, ns = ...

local Collect = {}
ns.Collect = Collect

local function safeCombat() return not (InCombatLockdown and InCombatLockdown()) end

local function charRecord()
  local key = ns.charKey()
  local rec = ns.db.characters[key] or {}
  ns.db.characters[key] = rec
  return rec
end

-- A whole number (0 or more), else nil.
local function whole(x)
  x = tonumber(x)
  if not x or x ~= x or x < 0 or x >= 1e15 then return nil end
  return math.floor(x)
end
local function round(x)
  x = tonumber(x)
  if not x or x ~= x or x < 0 or x >= 1e15 then return nil end
  return math.floor(x + 0.5)
end

-- The id in a link such as "|Henchant:2660|h" (kind "enchant") or "|Hitem:7026::|h" (kind "item").
local function idFromLink(link, kind)
  if type(link) ~= "string" then return nil end
  local n = whole(string.match(link, kind .. ":(%d+)"))
  if n and n > 0 then return n end
end

-- ns.Share.<name> when the sharing engine loaded and has it.
local function shareFn(name)
  local S = ns.Share
  if type(S) == "table" and type(S[name]) == "function" then return S[name] end
end

local function serverNow()
  local t = GetServerTime and ns.try(GetServerTime)
  if type(t) ~= "number" then t = ns.now() end
  return math.floor(t)
end

-- ---------- skill lines ----------
-- Records name a profession by its skill-line id (164 Blacksmithing ...). Recipe windows and the
-- skill list give names: English names map through this table (the codec's), other languages
-- through the game's own name for each profession's spell.
local SKILLS = {
  [129] = "First Aid", [164] = "Blacksmithing", [165] = "Leatherworking", [171] = "Alchemy", [182] = "Herbalism",
  [185] = "Cooking", [186] = "Mining", [197] = "Tailoring", [202] = "Engineering", [333] = "Enchanting", [356] = "Fishing",
  [393] = "Skinning", [755] = "Jewelcrafting", [773] = "Inscription",
}
local SKILL_SPELL = {
  [129] = 3273, [164] = 2018, [165] = 2108, [171] = 2259, [185] = 2550, [186] = 2575, [197] = 3908,
  [202] = 4036, [333] = 7411, [356] = 7620, [393] = 8613, [755] = 25229, [773] = 45357,
}
local skillByName
local function skillNames()
  if skillByName then return skillByName end
  local t = {}
  for id, name in pairs(SKILLS) do t[string.lower(name)] = id end
  local spellName = (C_Spell and C_Spell.GetSpellName) or GetSpellInfo
  local found = false
  if spellName then
    for id, spell in pairs(SKILL_SPELL) do
      local name = ns.try(spellName, spell)
      if type(name) == "string" and name ~= "" then
        found = true
        local k = string.lower(name)
        if not t[k] then t[k] = id end
      end
    end
  end
  if found then skillByName = t end
  return t
end

-- Skill-line id for a profession name (any client language the game names it in), else nil.
function Collect.skillId(name)
  if type(name) ~= "string" or name == "" then return nil end
  return skillNames()[string.lower(name)]
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
  if Collect.changed then Collect.changed() end
end

-- Shared records hold at most their type's size (sharing.js TYPES "max"). Text fields are cut by the
-- codec; lists are not, so a list that would make the record too big is shortened from its end.
-- listNames are tried in order; onCut(fields, n) runs after a list is cut to n items.
local function slice(list, n)
  local out = {}
  for i = 1, n do out[i] = list[i] end
  return out
end
local function fits(t, key, fields, author)
  local codec = ns.ShareCodec
  if type(codec) ~= "table" or type(codec.encode) ~= "function" or type(codec.maxFor) ~= "function" then return true end
  local str = codec.encode({ type = t, key = key, v = "00000000", author = author, fields = fields })
  return #str <= codec.maxFor(t, fields)
end
local function fit(t, key, fields, author, listNames, onCut)
  if fits(t, key, fields, author) then return end
  for _, name in ipairs(listNames) do
    local full = fields[name]
    if type(full) == "table" and #full > 0 then
      local function try(n)
        fields[name] = slice(full, n)
        if onCut then onCut(fields, n) end
        return fits(t, key, fields, author)
      end
      if try(0) then
        local lo, hi = 0, #full -- lo fits, hi does not
        while hi - lo > 1 do
          local mid = math.floor((lo + hi) / 2)
          if try(mid) then lo = mid else hi = mid end
        end
        try(lo)
        return
      end
    end
  end
end
Collect.fit = fit

-- { id, count } pairs, stacks of one item added together, sorted by id (so the record only
-- changes when the stock does, not when items move between slots).
local function stockList(list, max)
  local byId, ids = {}, {}
  for _, it in ipairs(type(list) == "table" and list or {}) do
    local id, count = whole(type(it) == "table" and it.id), whole(type(it) == "table" and it.count)
    if id and id > 0 and count and count > 0 then
      if not byId[id] then byId[id] = 0; ids[#ids + 1] = id end
      byId[id] = byId[id] + count
    end
  end
  table.sort(ids)
  local out = {}
  for i = 1, math.min(#ids, max) do out[i] = { id = ids[i], count = byId[ids[i]] } end
  return out
end

local TAB_KEY = { [0] = "0", "1", "2", "3", "4", "5", "6", "7", "8" }

-- The guild bank as gb records: tab 0 holds money, tab names and the newest 25 log lines;
-- tabs 1-8 hold their items. Offered to the sharing engine, which decides what to publish (§11).
local function offerGuildBank(scan)
  local offer = shareFn("offer")
  if not offer then return end
  local me = ns.charKey()
  local server = serverNow()
  local hour = server - server % 3600 -- log times are whole hours, so a rescan in the same hour matches
  local names = {}
  for tab = 1, math.min(scan.numTabs, 8) do
    local n = scan.tabNames[tab]
    if type(n) ~= "string" or n == "" then n = "Tab " .. tab end
    names[tab] = n
  end
  local log = {}
  for _, l in ipairs(scan.log) do
    log[#log + 1] = { at = hour - l.age, kind = l.kind, who = l.who, item = l.item, count = whole(l.count), amount = whole(l.amount) }
  end
  local function str(x) return type(x) == "string" and x or "" end
  table.sort(log, function(a, b)
    if a.at ~= b.at then return a.at > b.at end
    if str(a.kind) ~= str(b.kind) then return str(a.kind) < str(b.kind) end
    if str(a.who) ~= str(b.who) then return str(a.who) < str(b.who) end
    if (a.item or 0) ~= (b.item or 0) then return (a.item or 0) < (b.item or 0) end
    if (a.count or 0) ~= (b.count or 0) then return (a.count or 0) < (b.count or 0) end
    return (a.amount or 0) < (b.amount or 0)
  end)
  while #log > 25 do table.remove(log) end
  local offers = {}
  local head = { scannedAt = server, money = whole(scan.money), tabs = names, log = log }
  fit("gb", "0", head, me, { "log", "tabs" })
  offers[1] = { "0", head }
  for i, t in ipairs(scan.tabs) do
    local tab = scan.tabIndex[i]
    if TAB_KEY[tab] and tab >= 1 then
      local fields = { items = stockList(t.items, 98) }
      fit("gb", TAB_KEY[tab], fields, me, { "items" })
      offers[#offers + 1] = { TAB_KEY[tab], fields }
    end
  end
  for _, o in ipairs(offers) do
    local ok, err = pcall(offer, "gb", o[1], o[2])
    if not ok then ns.reportError(err) end
  end
end

-- Guild bank: readable only while it's open. The game's log says "x hours ago",
-- so we turn that into an approximate time. The last scan, when the window closes (final),
-- is offered to the guild: by then every tab the game was asked for has arrived.
local guildBankOpen = false
function ns.collectGuildBank(final)
  if not safeCombat() or not guildBankOpen or not GetNumGuildBankTabs or not ns.opt("collectBank") then return end
  local tabs, tabIndex, tabNames = {}, {}, {}
  local slotsPerTab = MAX_GUILDBANK_SLOTS_PER_TAB or 98
  local numTabs = ns.try(GetNumGuildBankTabs) or 0
  for tab = 1, numTabs do
    local name, _, isViewable = ns.try(GetGuildBankTabInfo, tab)
    tabNames[tab] = name
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
      tabIndex[#tabs] = tab
    end
  end
  local now = ns.now()
  local function age(y, mo, d, h) return (((y or 0) * 365 + (mo or 0) * 30 + (d or 0)) * 24 + (h or 0)) * 3600 end
  local log, shared = {}, {}
  if GetNumGuildBankTransactions and GetGuildBankTransaction then
    for tab = 1, #tabs do
      for i = 1, (ns.try(GetNumGuildBankTransactions, tab) or 0) do
        local kind, who, link, count, _, _, y, mo, d, h = ns.try(GetGuildBankTransaction, tab, i)
        if kind then
          local secs = age(y, mo, d, h)
          local id = link and tonumber(string.match(link, "item:(%d+)"))
          log[#log + 1] = { kind = kind, who = who, id = id, name = nameFromLink(link), count = count, at = now - secs }
          shared[#shared + 1] = { kind = kind, who = who, item = whole(id), count = count, age = secs }
        end
      end
    end
  end
  if GetNumGuildBankMoneyTransactions and GetGuildBankMoneyTransaction then
    for i = 1, (ns.try(GetNumGuildBankMoneyTransactions) or 0) do
      local kind, who, amount, y, mo, d, h = ns.try(GetGuildBankMoneyTransaction, i)
      if kind then
        local secs = age(y, mo, d, h)
        log[#log + 1] = { kind = kind, who = who, amount = amount, at = now - secs }
        shared[#shared + 1] = { kind = kind, who = who, amount = amount, age = secs }
      end
    end
  end
  local money = ns.try(GetGuildBankMoney)
  ns.db.guildBank = { scannedAt = now, guild = GetGuildInfo("player"), money = money, tabs = tabs, log = log }
  if final then
    offerGuildBank({ numTabs = numTabs, tabNames = tabNames, tabs = tabs, tabIndex = tabIndex, money = money, log = shared })
  end
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
  C_Timer.After(1, function() gbPending = false; ns.safely(ns.collectGuildBank) end)
end

local function openGuildBank()
  guildBankOpen = true
  queryGuildBank()
  scheduleGuildBank()
end
local function closeGuildBank()
  if guildBankOpen then ns.collectGuildBank(true) end
  guildBankOpen = false
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
-- we can't be sure which one a given game version exposes. The modern API also gives the
-- skill-line id (saved as `id`), which works in every client language.
function ns.collectProfessions(rec)
  rec = rec or charRecord()
  local out = {}
  if GetProfessions and GetProfessionInfo then
    local list = { ns.try(GetProfessions) }
    for i = 1, 5 do
      local idx = list[i]
      if idx then
        local name, _, skill, max, _, _, skillLine = ns.try(GetProfessionInfo, idx)
        if name then
          local id = whole(skillLine)
          out[#out + 1] = { name = name, skill = skill, max = max, id = (id and id > 0) and id or nil }
        end
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
-- capture them whenever the player opens one. Each recipe keeps the ids the game gives:
-- `id` = the recipe's spell id, `item` = the item it makes (older clients, from the links).
local function professionInfo()
  if C_TradeSkillUI and C_TradeSkillUI.GetBaseProfessionInfo then
    local info = ns.try(C_TradeSkillUI.GetBaseProfessionInfo)
    if info and info.professionName and info.professionName ~= "" then
      local id = whole(info.professionID)
      return info.professionName, (id and id > 0) and id or nil
    end
  end
  if GetTradeSkillLine then
    local name = ns.try(GetTradeSkillLine)
    if name and name ~= "UNKNOWN" then return name end
  end
end

local function saveRecipes(prof, skill, list)
  local rec = charRecord()
  rec.recipes = rec.recipes or {}
  local before = rec.recipes[prof] and #rec.recipes[prof] or 0
  rec.recipes[prof] = list
  skill = skill or Collect.skillId(prof)
  if skill then
    rec.recipeSkills = rec.recipeSkills or {}
    rec.recipeSkills[prof] = skill
  end
  Collect.changed()
  return before
end

function ns.collectRecipes()
  if not safeCombat() then return end
  -- Skip guildies' and NPCs' linked profession windows.
  if C_TradeSkillUI and C_TradeSkillUI.IsTradeSkillLinked and ns.try(C_TradeSkillUI.IsTradeSkillLinked) then return end
  if C_TradeSkillUI and C_TradeSkillUI.IsTradeSkillGuild and ns.try(C_TradeSkillUI.IsTradeSkillGuild) then return end
  local prof, skill = professionInfo()
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
      if name and kind ~= "header" and kind ~= "subheader" then
        list[#list + 1] = { name = name,
          id = GetTradeSkillRecipeLink and idFromLink(ns.try(GetTradeSkillRecipeLink, i), "enchant") or nil,
          item = GetTradeSkillItemLink and idFromLink(ns.try(GetTradeSkillItemLink, i), "item") or nil }
      end
    end
  end
  if #list > 0 then
    local before = saveRecipes(prof, skill, list)
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
    if name and kind ~= "header" then
      list[#list + 1] = { name = name,
        id = GetCraftRecipeLink and idFromLink(ns.try(GetCraftRecipeLink, i), "enchant") or nil,
        item = GetCraftItemLink and idFromLink(ns.try(GetCraftItemLink, i), "item") or nil }
    end
  end
  if #list > 0 then saveRecipes(prof, nil, list) end
end

-- ---------- guild roster ----------
-- One member's scan updates everyone's online status for the whole guild.
function ns.collectRoster()
  if not safeCombat() or not IsInGuild or not IsInGuild() then return end
  local n = ns.try(GetNumGuildMembers) or 0
  if n == 0 then return end
  local members = {}
  for i = 1, n do
    -- rankIndex: 0 is the Guild Master. Guild Camp gives officer roles from it (owner/officer scans only).
    local name, rank, rankIndex, level, _, zone, _, _, online, _, classToken = ns.try(GetGuildRosterInfo, i)
    if name then
      if Ambiguate then name = Ambiguate(name, "guild") end
      members[#members + 1] = {
        name = name, rank = rank, rankIndex = rankIndex, level = level, zone = zone,
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

-- ---------- shared records (docs/SHARING.md §4.3, Appendix A) ----------
local B36 = "0123456789abcdefghijklmnopqrstuvwxyz"
local function toB36(n)
  n = whole(n)
  if not n then return "" end
  if n == 0 then return "0" end
  local out = ""
  while n > 0 do
    local d = n % 36
    out = string.sub(B36, d + 1, d + 1) .. out
    n = (n - d) / 36
  end
  return out
end

-- My player id (pid), from the sharing engine.
local function myPid()
  local f = shareFn("myPid")
  if not f then return nil end
  local ok, pid = pcall(f)
  if ok and type(pid) == "string" and pid ~= "" then return pid end
end
Collect.myPid = myPid

-- The anchor of a pid ("Thrallia.p4m7" -> "Thrallia"): the character the pid was made on.
local function anchorOf(pid)
  if type(pid) ~= "string" then return nil end
  return string.match(pid, "^([^%.]+)%.[0-9a-z][0-9a-z][0-9a-z][0-9a-z]$")
end
Collect.anchorOf = anchorOf

-- What the app says about me in the guild I am in: { pid, bt, main, alts }. Player ids are per guild, so
-- the sharing engine picks the entry of the open guild (inbox me.byG); without it, the inbox's me.
local function inboxMe()
  local f = shareFn("meInfo")
  if f then
    local ok, m = pcall(f)
    if ok and type(m) == "table" then return m end
    return nil
  end
  local inbox = WowGuildInbox
  if type(inbox) == "table" and type(inbox.me) == "table" then return inbox.me end
end

-- The characters the anchor lists as its own. The app's list when it gave one; else this
-- account's characters in the anchor's guild and realm (they are all the same player's).
local function altsOf(anchor, me)
  local out, seen = {}, {}
  local function add(n)
    if type(n) == "string" and n ~= "" and not seen[n] then seen[n] = true; out[#out + 1] = n end
  end
  if me and type(me.alts) == "table" then
    for _, n in ipairs(me.alts) do add(n) end
    return out
  end
  add(anchor)
  local here = ns.db.characters[anchor] or {}
  local names = {}
  for key, c in pairs(ns.db.characters) do
    if type(key) == "string" and key ~= anchor and type(c) == "table" and c.guild ~= nil
      and c.guild == here.guild and c.realm == here.realm then
      names[#names + 1] = key
    end
  end
  table.sort(names)
  for _, n in ipairs(names) do add(n) end
  return out
end

-- This character's saved data, collected again first when it's more than 5 minutes old.
local function myRecord()
  local name = ns.charKey()
  if type(name) ~= "string" or name == "" or not ns.db then return nil end
  local rec = ns.db.characters[name]
  if (type(rec) ~= "table" or not rec.updated or ns.now() - rec.updated > 300) and safeCombat() then
    ns.safely(ns.collectCharacter)
    rec = ns.db.characters[name]
  end
  if type(rec) ~= "table" then rec = {} end
  return rec, name
end

-- ch: who this character is, for the guild's roster, crafters and raid sign-ups.
function Collect.ch()
  local rec, name = myRecord()
  if not rec then return nil end
  local pid = myPid()
  local anchor = anchorOf(pid)
  local me = inboxMe()
  local main
  if me and type(me.main) == "string" and me.main ~= "" then main = me.main == name else main = anchor == name end
  local r = type(rec.readiness) == "table" and rec.readiness or nil
  local consumables
  if r then
    local c = type(r.consumables) == "table" and r.consumables or {}
    consumables = { flask = whole(c.flask) or 0, elixir = whole(c.elixir) or 0, potion = whole(c.potion) or 0,
      food = whole(c.food) or 0, bandage = whole(c.bandage) or 0 }
  end
  local profs = {}
  for _, p in ipairs(type(rec.professions) == "table" and rec.professions or {}) do
    local skill = type(p) == "table" and (whole(p.id) or Collect.skillId(p.name))
    if skill and skill > 0 and #profs < 12 then profs[#profs + 1] = { skill = skill, rank = whole(p.skill), max = whole(p.max) } end
  end
  local pvp = type(rec.pvp) == "table" and rec.pvp or {}
  local alts
  if anchor and anchor == name then
    alts = altsOf(anchor, me)
    while #alts > 20 do table.remove(alts) end
  end
  local fields = {
    pid = pid, battletag = me and type(me.bt) == "string" and me.bt or nil, main = main, alts = alts,
    class = rec.class, race = rec.race, level = whole(rec.level), faction = rec.faction,
    ilvl = r and round(r.ilvl), repair = r and round(r.durability), consumables = consumables,
    professions = profs, pvp = { rank = whole(pvp.rank), hk = whole(pvp.hk) }, addon = ns.addonVersion(),
  }
  fit("ch", name, fields, name, { "alts" })
  return { type = "ch", key = name, fields = fields }
end

local function uniqueSorted(list)
  table.sort(list)
  local out = {}
  for _, x in ipairs(list) do if x ~= out[#out] then out[#out + 1] = x end end
  return out
end

-- The rc fields for one profession's saved recipes: spell ids when every recipe has one, else
-- the ids of the items they make, else names (§12 "Recipe window without ids").
local function recipeFields(list)
  if type(list) ~= "table" then return nil end
  local spells, items, names = {}, {}, {}
  local allSpell, allItem, n = true, true, 0
  for _, r in ipairs(list) do
    if type(r) == "table" then
      n = n + 1
      local s, i = whole(r.id), whole(r.item)
      if s and s > 0 then spells[#spells + 1] = s else allSpell = false end
      if i and i > 0 then items[#items + 1] = i else allItem = false end
      if type(r.name) == "string" and r.name ~= "" then names[#names + 1] = r.name end
    end
  end
  if n == 0 then return nil end
  local kind, ids, max
  if allSpell then kind, ids, max = "s", uniqueSorted(spells), 2000
  elseif allItem then kind, ids, max = "i", uniqueSorted(items), 2000
  else kind, ids, max = "n", uniqueSorted(names), 500 end
  while #ids > max do table.remove(ids) end
  if #ids == 0 then return nil end
  return { kind = kind, count = #ids, list = ids }
end
Collect.recipeFields = recipeFields

-- rc: one record per profession this character has, keyed name:skill.
function Collect.rc()
  local rec, name = myRecord()
  if not rec or type(rec.recipes) ~= "table" then return {} end
  local have, known = {}, false
  for _, p in ipairs(type(rec.professions) == "table" and rec.professions or {}) do
    local skill = type(p) == "table" and (whole(p.id) or Collect.skillId(p.name))
    if skill then have[skill] = true; known = true end
  end
  local skills = type(rec.recipeSkills) == "table" and rec.recipeSkills or {}
  local profNames = {}
  for prof in pairs(rec.recipes) do if type(prof) == "string" then profNames[#profNames + 1] = prof end end
  table.sort(profNames)
  local out, byKey = {}, {}
  for _, prof in ipairs(profNames) do
    local skill = whole(skills[prof]) or Collect.skillId(prof)
    -- A profession the character dropped is no longer shared (when we know its professions).
    if skill and skill > 0 and (not known or have[skill]) then
      local fields = recipeFields(rec.recipes[prof])
      if fields then
        local key = name .. ":" .. toB36(skill)
        local before = byKey[key]
        if not before or before.fields.count < fields.count then
          fit("rc", key, fields, name, { "list" }, function(f, n) f.count = n end)
          local r = { type = "rc", key = key, fields = fields }
          if before then
            for i, x in ipairs(out) do if x == before then out[i] = r end end
          else
            out[#out + 1] = r
          end
          byKey[key] = r
        end
      end
    end
  end
  return out
end

-- The names in the officers' bank characters record (BC:1), or nil when there is none.
local function bankCharacters()
  local get = shareFn("get")
  if not get then return nil end
  local ok, r = pcall(get, "BC:1")
  if not ok or r == nil then return nil end
  if type(r) == "string" then
    local codec = ns.ShareCodec
    r = codec and type(codec.decode) == "function" and codec.decode(r) or nil
  end
  if type(r) ~= "table" or r.del then return nil end
  local fields = type(r.fields) == "table" and r.fields or r
  return type(fields.names) == "table" and fields.names or nil
end

-- bk: a bank character's bags and bank, only while the officers list it in BC.
function Collect.bk()
  if not ns.opt("collectBank") then return nil end
  local names = bankCharacters()
  if not names then return nil end
  local name = ns.charKey()
  local listed = false
  for _, n in ipairs(names) do
    if type(n) == "string" and type(name) == "string" and string.lower(n) == string.lower(name) then listed = true end
  end
  if not listed then return nil end
  local rec = myRecord()
  local inv = rec and type(rec.inventory) == "table" and rec.inventory or nil
  if not inv then return nil end
  local fields = { bags = stockList(inv.bags, 200), bank = stockList(inv.bank, 300) }
  fit("bk", name, fields, name, { "bank", "bags" })
  return { type = "bk", key = name, fields = fields }
end

-- sh: my shopping list (recipe, how many, profession), at most 20. Nothing when it's empty.
function Collect.sh()
  local pid = myPid()
  if not pid or not ns.db then return nil end
  local items = {}
  for _, e in ipairs(type(ns.db.shopping) == "table" and ns.db.shopping or {}) do
    if #items >= 20 then break end
    if type(e) == "table" and type(e.name) == "string" and e.name ~= "" then
      local qty = whole(e.qty)
      items[#items + 1] = { name = e.name, qty = (qty and qty > 0) and qty or 1, skill = whole(e.skill) or Collect.skillId(e.prof) }
    end
  end
  if #items == 0 then return nil end
  local fields = { items = items }
  fit("sh", pid, fields, ns.charKey(), { "items" })
  return { type = "sh", key = pid, fields = fields }
end

-- Everything this character shares about itself: ch, rc (one per profession), bk and sh.
-- The sharing engine calls this when it becomes ready and decides what to publish.
-- A record type that has nothing to share is left out.
function Collect.sharedRecords()
  local out = {}
  local function add(r) if type(r) == "table" and r.type then out[#out + 1] = r end end
  add(ns.safely(Collect.ch))
  for _, r in ipairs(ns.safely(Collect.rc) or {}) do add(r) end
  add(ns.safely(Collect.bk))
  add(ns.safely(Collect.sh))
  if ns.war and ns.war.record then add(ns.safely(ns.war.record, myPid())) end
  return out
end

-- Offer every shared record again (while the engine is ready); its policy decides what goes out.
function Collect.offerAll()
  local offer = shareFn("offer")
  if not offer then return end
  local ready = shareFn("ready")
  if ready and not ready() then return end
  for _, r in ipairs(Collect.sharedRecords()) do
    local ok, err = pcall(offer, r.type, r.key, r.fields)
    if not ok then ns.reportError(err) end
  end
end

-- Something shared changed between two readies (recipes saved, a bank scan, a level, the shopping
-- list): offer again a little later, so a burst of changes costs one offer round.
Collect.OFFER_DELAY = 30
local offerPending = false
function Collect.changed()
  if offerPending or not shareFn("offer") then return end
  offerPending = true
  C_Timer.After(Collect.OFFER_DELAY, function()
    offerPending = false
    ns.safely(Collect.offerAll)
  end)
end

-- ---------- wiring ----------
local lastRoster = 0
function ns.onLogin()
  ns.safely(ns.collectCharacter)
  ns.safely(requestRoster)
  ns.safely(ns.showLoginNews)
  -- Refresh the roster every 5 minutes while out of combat.
  C_Timer.NewTicker(300, function()
    if safeCombat() then ns.safely(requestRoster) end
  end)
end

ns.on("GUILD_ROSTER_UPDATE", function()
  if ns.now() - lastRoster < 20 then return end
  lastRoster = ns.now()
  ns.collectRoster()
end)
ns.on("PLAYER_LEVEL_UP", function()
  ns.after(1, function() ns.collectCharacter(); Collect.changed() end)
end)
ns.on("SKILL_LINES_CHANGED", function() if safeCombat() then ns.collectProfessions() end end)
ns.on("TRADE_SKILL_SHOW", function() ns.after(0.5, ns.collectRecipes) end)
ns.on("TRADE_SKILL_LIST_UPDATE", function() ns.after(0.5, ns.collectRecipes) end)
ns.on("TRADE_SKILL_DATA_SOURCE_CHANGED", function() ns.after(0.5, ns.collectRecipes) end)
ns.on("NEW_RECIPE_LEARNED", function() ns.after(0.5, ns.collectRecipes) end)
ns.on("CRAFT_SHOW", function() ns.after(0.5, ns.collectCrafts) end)
ns.on("CRAFT_UPDATE", function() ns.after(0.5, ns.collectCrafts) end)
ns.on("PLAYER_REGEN_ENABLED", function() ns.collectCharacter() end)
-- Reputation and currency events fire often (every loot); refresh at most every few seconds.
local extrasPending = false
local function refreshExtras()
  if extrasPending then return end
  extrasPending = true
  C_Timer.After(3, function() extrasPending = false; if safeCombat() then ns.safely(ns.collectExtras) end end)
end
ns.on("UPDATE_FACTION", refreshExtras)
ns.on("CURRENCY_DISPLAY_UPDATE", refreshExtras)
ns.on("BANKFRAME_OPENED", function() ns.after(0.5, ns.collectBank) end)
ns.on("PLAYERBANKSLOTS_CHANGED", function() ns.after(0.5, ns.collectBank) end)
ns.on("BANKFRAME_CLOSED", function() ns.collectBank() end)
ns.on("GUILDBANKFRAME_OPENED", openGuildBank)
ns.on("GUILDBANKBAGSLOTS_CHANGED", scheduleGuildBank)
ns.on("GUILDBANKLOG_UPDATE", scheduleGuildBank)
ns.on("GUILDBANK_UPDATE_MONEY", scheduleGuildBank)
ns.on("GUILDBANKFRAME_CLOSED", closeGuildBank)
-- Newer clients report bank and guild bank windows through one event pair.
ns.on("PLAYER_INTERACTION_MANAGER_FRAME_SHOW", function(kind)
  local T = Enum and Enum.PlayerInteractionType
  if not T then return end
  if kind == T.Banker then ns.after(0.5, ns.collectBank)
  elseif kind == T.GuildBanker then openGuildBank() end
end)
ns.on("PLAYER_INTERACTION_MANAGER_FRAME_HIDE", function(kind)
  local T = Enum and Enum.PlayerInteractionType
  if T and kind == T.GuildBanker then closeGuildBank() end
end)
