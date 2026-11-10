-- Guild Camp: profession helper.
--   Skill-up guide: ranks the recipes you know by cost per expected skill point.
--   Shopping list: recipes × quantity → the mats you still need, ticking off as you loot.
-- Everything here reads profession and bag data out of combat; nothing touches combat.

local ADDON, ns = ...
local P = {}
ns.prof = P

-- Expected skill points per craft by difficulty colour (0 orange, 1 yellow, 2 green, 3 grey).
P.EXPECT = { [0] = 1, [1] = 0.75, [2] = 0.25, [3] = 0 }
P.COLOR = { [0] = "ff8040", [1] = "ffff00", [2] = "40bf40", [3] = "808080" }
local DIFF_BY_NAME = { optimal = 0, medium = 1, easy = 2, trivial = 3 }

local function safeCombat() return not (InCombatLockdown and InCombatLockdown()) end

local function itemName(id)
  if C_Item and C_Item.GetItemNameByID then
    local n = ns.try(C_Item.GetItemNameByID, id)
    if n then return n end
  end
  if GetItemInfo then return (ns.try(GetItemInfo, id)) end
end

-- How many of an item you have in bags (and bank, which the game remembers once you've opened it).
function P.owned(id)
  if C_Item and C_Item.GetItemCount then return ns.try(C_Item.GetItemCount, id, true) or 0 end
  if GetItemCount then return ns.try(GetItemCount, id, true) or 0 end
  return 0
end

-- ---------- prices ----------
-- Auctionator's live data first (if installed), then the guild price index (from the inbox).
local inboxPrices
local function guildPrice(id)
  if not inboxPrices then
    inboxPrices = {}
    local inbox = WowGuildInbox
    for _, p in ipairs(inbox and inbox.prices or {}) do inboxPrices[p.id] = p.price end
  end
  return inboxPrices[id]
end
function P.price(id)
  if Auctionator and Auctionator.API and Auctionator.API.v1 and Auctionator.API.v1.GetAuctionPriceByItemID then
    local p = ns.try(Auctionator.API.v1.GetAuctionPriceByItemID, "WowGuild", id)
    if p and p > 0 then return p, "auctionator" end
  end
  local g = guildPrice(id)
  if g then return g, "guild" end
end

-- ---------- reading the open profession ----------
-- The profession's name and, when the game gives it, its skill-line id (164 Blacksmithing ...).
local function professionName()
  if C_TradeSkillUI and C_TradeSkillUI.GetBaseProfessionInfo then
    local info = ns.try(C_TradeSkillUI.GetBaseProfessionInfo)
    if info and info.professionName and info.professionName ~= "" then
      local id = type(info.professionID) == "number" and info.professionID > 0 and info.professionID or nil
      return info.professionName, id
    end
  end
  if GetTradeSkillLine then
    local n = ns.try(GetTradeSkillLine)
    if n and n ~= "UNKNOWN" then return n end
  end
end

local function skillOf(name, id)
  if id then return id end
  return ns.Collect and ns.Collect.skillId and ns.Collect.skillId(name) or nil
end

local function modernReagents(recipeID)
  local out = {}
  local schematic = ns.try(C_TradeSkillUI.GetRecipeSchematic, recipeID, false)
  out.outputId = schematic and schematic.outputItemID
  local basic = Enum and Enum.CraftingReagentType and Enum.CraftingReagentType.Basic or 1
  for _, slot in ipairs(schematic and schematic.reagentSlotSchematics or {}) do
    if (slot.reagentType == nil or slot.reagentType == basic) and slot.reagents and slot.reagents[1] then
      local id = slot.reagents[1].itemID
      if id then out[#out + 1] = { id = id, name = itemName(id), qty = slot.quantityRequired or 1 } end
    end
  end
  return out
end

-- Returns { name = profession, recipes = { {key, id, name, diff, skillUps, reagents, canMake} } }
function P.scan()
  if not safeCombat() then return end
  local prof, skill = professionName()
  if not prof then return end
  local recipes = {}
  if C_TradeSkillUI and C_TradeSkillUI.GetAllRecipeIDs and C_TradeSkillUI.GetRecipeInfo then
    if C_TradeSkillUI.IsTradeSkillLinked and ns.try(C_TradeSkillUI.IsTradeSkillLinked) then return end
    for _, id in ipairs(ns.try(C_TradeSkillUI.GetAllRecipeIDs) or {}) do
      local info = ns.try(C_TradeSkillUI.GetRecipeInfo, id)
      if info and info.learned and info.name then
        local diff = info.relativeDifficulty
        if diff == nil and info.difficulty then diff = DIFF_BY_NAME[info.difficulty] end
        local reagents = modernReagents(id)
        local outputId = reagents.outputId; reagents.outputId = nil
        recipes[#recipes + 1] = { key = id, id = id, name = info.name, diff = diff or 3, icon = info.icon, outputId = outputId,
          skillUps = info.numSkillUps or 1, reagents = reagents, canMake = info.numAvailable or 0 }
      end
    end
  end
  if #recipes == 0 and GetNumTradeSkills and GetTradeSkillInfo then
    for i = 1, (ns.try(GetNumTradeSkills) or 0) do
      local name, kind, numAvailable = ns.try(GetTradeSkillInfo, i)
      if name and DIFF_BY_NAME[kind] then
        local reagents = {}
        for r = 1, (ns.try(GetTradeSkillNumReagents, i) or 0) do
          local rname, _, count = ns.try(GetTradeSkillReagentInfo, i, r)
          local link = GetTradeSkillReagentItemLink and ns.try(GetTradeSkillReagentItemLink, i, r)
          local id = link and tonumber(string.match(link, "item:(%d+)"))
          if id then reagents[#reagents + 1] = { id = id, name = rname, qty = count or 1 } end
        end
        local outLink = GetTradeSkillItemLink and ns.try(GetTradeSkillItemLink, i)
        recipes[#recipes + 1] = { key = name, index = i, name = name, diff = DIFF_BY_NAME[kind], skillUps = 1, reagents = reagents, canMake = numAvailable or 0,
          icon = GetTradeSkillIcon and ns.try(GetTradeSkillIcon, i), outputId = outLink and tonumber(string.match(outLink, "item:(%d+)")) }
      end
    end
  end
  P.current = { name = prof, skill = skillOf(prof, skill), recipes = recipes, at = ns.now() }
  P.lastScan = { at = ns.now(), prof = prof, recipes = #recipes,
    method = (C_TradeSkillUI and C_TradeSkillUI.GetAllRecipeIDs) and "modern" or (GetNumTradeSkills and "classic" or "none") }
  -- Remember which reagents we care about so the Guild Camp app can show their guild prices and stock.
  ns.db.reagentIds = ns.db.reagentIds or {}
  local seen = {}
  for _, id in ipairs(ns.db.reagentIds) do seen[id] = true end
  for _, r in ipairs(recipes) do
    for _, g in ipairs(r.reagents) do
      if not seen[g.id] then seen[g.id] = true; table.insert(ns.db.reagentIds, g.id) end
    end
  end
  while #ns.db.reagentIds > 1500 do table.remove(ns.db.reagentIds, 1) end
  return P.current
end

-- ---------- acting on a recipe (from a button click) ----------
-- Show the recipe in the open profession window.
function P.select(recipe)
  if not recipe then return false end
  if recipe.id and C_TradeSkillUI and C_TradeSkillUI.OpenRecipe then ns.try(C_TradeSkillUI.OpenRecipe, recipe.id); return true end
  if recipe.index and SelectTradeSkill then
    ns.try(SelectTradeSkill, recipe.index)
    if TradeSkillFrame_SetSelection then ns.try(TradeSkillFrame_SetSelection, recipe.index) end
    if TradeSkillFrame_Update then ns.try(TradeSkillFrame_Update) end
    return true
  end
  return false
end

-- Craft (needs a real click, which the Make button provides).
function P.craft(recipe, count)
  if not recipe or not safeCombat() then return false end
  count = count or 1
  if recipe.id and C_TradeSkillUI and C_TradeSkillUI.CraftRecipe then ns.try(C_TradeSkillUI.CraftRecipe, recipe.id, count); return true end
  if recipe.index and DoTradeSkill then ns.try(DoTradeSkill, recipe.index, count); return true end
  return false
end

-- Auction house: search for the mats still missing. Uses Auctionator when it's installed.
function P.missingNames()
  local names = {}
  for _, r in ipairs(P.remaining()) do if not r.done and r.name then names[#names + 1] = r.name end end
  return names
end
function P.hasAuctionator()
  return Auctionator and Auctionator.API and Auctionator.API.v1 and true or false
end
function P.searchAuctionHouse()
  local names = P.missingNames()
  if #names == 0 then ns.print("Nothing left to buy on your shopping list."); return false end
  local api = P.hasAuctionator() and Auctionator.API.v1
  if api and api.MultiSearchExact then
    local ok = pcall(api.MultiSearchExact, "WowGuild", names)
    if ok then return true end
    ns.print("Open the auction house first, then search again.")
    return false
  end
  ns.print("Install Auctionator to search the auction house from your shopping list.")
  return false
end
function P.makeAuctionatorList()
  local names = P.missingNames()
  local api = P.hasAuctionator() and Auctionator.API.v1
  if #names == 0 or not api or not api.CreateShoppingList then return false end
  local ok = pcall(api.CreateShoppingList, "WowGuild", "Guild Camp shopping list", names)
  if ok then ns.print("Made an Auctionator shopping list called \"Guild Camp shopping list\".") end
  return ok
end

-- ---------- skill-up ranking ----------
-- Cost of one craft = sum of reagent prices. Mats you already own count as free,
-- since you'd use them anyway. Unknown prices are treated as missing (shown, ranked last).
function P.craftCost(recipe)
  local total, unknown = 0, false
  for _, g in ipairs(recipe.reagents) do
    local p = P.price(g.id)
    if p then total = total + p * g.qty else unknown = true end
  end
  return total, unknown
end

function P.rank(recipes, limit)
  local out = {}
  for _, r in ipairs(recipes or {}) do
    local points = (P.EXPECT[r.diff] or 0) * (r.skillUps or 1)
    if points > 0 then
      local cost, unknown = P.craftCost(r)
      -- Mats on hand make the first few crafts free.
      local fromBags = r.canMake or 0
      out[#out + 1] = { recipe = r, points = points, cost = cost, unknown = unknown,
        perPoint = cost / points, fromBags = fromBags }
    end
  end
  table.sort(out, function(a, b)
    if (a.fromBags > 0) ~= (b.fromBags > 0) then return a.fromBags > 0 end
    if a.unknown ~= b.unknown then return not a.unknown end
    if a.perPoint ~= b.perPoint then return a.perPoint < b.perPoint end
    return a.points > b.points
  end)
  if limit then while #out > limit do table.remove(out) end end
  return out
end

-- ---------- the leveling plan ----------
-- The cheapest way to the next PLAN_POINTS skill points with the recipes you know, step by step. Mats count as
-- free from your bags first, then your alts, then the guild bank (ask for them), and are bought for the rest.
-- Orange and yellow recipes only, and at most PER_RECIPE points from one (it turns easier as you level, so the
-- plan is for the next few points: open the profession again to plan the next ones).
P.PLAN_POINTS = 10
P.PER_RECIPE = 5

-- → rank, max of the open profession (classic GetTradeSkillLine), or nil.
function P.skillRank()
  if GetTradeSkillLine then
    local _, rank, max = ns.try(GetTradeSkillLine)
    if type(rank) == "number" and type(max) == "number" then return rank, max end
  end
end

local function pools(recipes, stockOf)
  local pool = {}
  for _, r in ipairs(recipes) do
    for _, g in ipairs(r.reagents or {}) do
      if not pool[g.id] then
        local s = stockOf(g.id)
        pool[g.id] = { bags = P.owned(g.id), alts = s and s.alts or 0, bank = s and s.guildBank or 0 }
      end
    end
  end
  return pool
end

-- One craft's cost with what's left in the pool (nothing taken). → copper to buy, unknown?
local function oneCost(r, pool)
  local cost, unknown = 0, false
  for _, g in ipairs(r.reagents or {}) do
    local p = pool[g.id]
    local free = p and (p.bags + p.alts + p.bank) or 0
    local buy = math.max(0, g.qty - free)
    if buy > 0 then
      local price = P.price(g.id)
      if price then cost = cost + price * buy else unknown = true end
    end
  end
  return cost, unknown
end

local function take(r, pool, out)
  for _, g in ipairs(r.reagents or {}) do
    local p = pool[g.id] or { bags = 0, alts = 0, bank = 0 }
    local left = g.qty
    for _, src in ipairs({ "bags", "alts", "bank" }) do
      local n = math.min(left, p[src]); p[src] = p[src] - n; left = left - n
      if n > 0 and src ~= "bags" then out[src][g.id] = (out[src][g.id] or 0) + n end
    end
    if left > 0 then
      out.buy[g.id] = (out.buy[g.id] or 0) + left
      local price = P.price(g.id)
      if price then out.cost = out.cost + price * left else out.unknown = true end
    end
    out.names[g.id] = out.names[g.id] or g.name
  end
end

-- → { goal, points, cost, unknown, steps = { { recipe, crafts, points } }, buy, alts, bank, names }
function P.plan(recipes, goal)
  local rank, max = P.skillRank()
  goal = goal or P.PLAN_POINTS
  if rank and max then goal = math.max(0, math.min(goal, max - rank)) end
  local cands = {}
  for _, r in ipairs(recipes or {}) do
    local pts = (P.EXPECT[r.diff] or 0) * (r.skillUps or 1)
    if pts > 0 and (r.diff or 3) <= 1 then cands[#cands + 1] = { recipe = r, per = pts, got = 0, crafts = 0 } end
  end
  local out = { goal = goal, points = 0, cost = 0, unknown = false, steps = {}, buy = {}, alts = {}, bank = {}, names = {} }
  local pool = pools(recipes or {}, function(id) return P.stockElsewhere and P.stockElsewhere(id) end)
  local guard = 0
  while out.points < goal - 1e-9 and guard < 200 do
    guard = guard + 1
    local best, bestCost, bestUnknown
    for _, c in ipairs(cands) do
      if c.got < P.PER_RECIPE then
        local cost, unknown = oneCost(c.recipe, pool)
        local per = cost / c.per
        if not best or (unknown ~= bestUnknown and not unknown) or (unknown == bestUnknown and per < bestCost) then
          best, bestCost, bestUnknown = c, per, unknown
        end
      end
    end
    if not best then break end
    take(best.recipe, pool, out)
    best.crafts = best.crafts + 1
    best.got = best.got + best.per
    out.points = out.points + best.per
    if best.crafts == 1 then out.steps[#out.steps + 1] = best end
  end
  for i, c in ipairs(out.steps) do out.steps[i] = { recipe = c.recipe, crafts = c.crafts, points = c.got } end
  out.points = math.floor(out.points * 10 + 0.5) / 10
  return out
end

-- Every step of a plan onto the shopping list.
function P.planToList(plan)
  for _, s in ipairs((plan and plan.steps) or {}) do P.addToList(s.recipe, s.crafts) end
end

-- ---------- shopping list ----------
function P.list()
  ns.db.shopping = ns.db.shopping or {}
  return ns.db.shopping
end

-- The list changed: redraw the tracker and let the guild know (the shared "sh" record).
local function listChanged()
  P.refreshTracker()
  if ns.Collect and ns.Collect.changed then ns.Collect.changed() end
end

function P.addToList(recipe, qty)
  local list = P.list()
  for _, e in ipairs(list) do
    if e.key == recipe.key then e.qty = e.qty + qty; listChanged(); return e end
  end
  local reagents = {}
  for _, g in ipairs(recipe.reagents) do reagents[#reagents + 1] = { id = g.id, name = g.name, qty = g.qty } end
  local e = { key = recipe.key, name = recipe.name, qty = qty, prof = P.current and P.current.name,
    skill = P.current and P.current.skill, reagents = reagents }
  table.insert(list, e)
  ns.print(string.format("Added %d × %s to your shopping list. /wow list shows it.", qty, recipe.name))
  listChanged()
  return e
end

function P.removeFromList(key, delta)
  local list = P.list()
  for i, e in ipairs(list) do
    if e.key == key then
      if delta then e.qty = e.qty + delta end
      if not delta or e.qty <= 0 then table.remove(list, i) end
      break
    end
  end
  listChanged()
end

function P.clearList()
  ns.db.shopping = {}
  P.done = {}
  listChanged()
  ns.print("Shopping list cleared.")
end

-- Other places the guild knows you have the item: your alts, and the guild bank.
local inboxStock
local function stockElsewhere(id)
  if not inboxStock then
    inboxStock = {}
    local inbox = WowGuildInbox
    local me = UnitName("player")
    -- Shopping-list stock first, then general holdings (covers items added since the last sync).
    local sources = {}
    for _, s in ipairs(inbox and inbox.holdings or {}) do sources[#sources + 1] = s end
    for _, s in ipairs(inbox and inbox.stock or {}) do sources[#sources + 1] = s end
    for _, s in ipairs(sources) do
      local alts = 0
      for _, c in ipairs(s.chars or {}) do
        if c.name ~= me then alts = alts + (c.count or 0) end
      end
      inboxStock[s.id] = { alts = alts, guildBank = s.guildBank or 0 }
    end
  end
  return inboxStock[id]
end

P.stockElsewhere = stockElsewhere

-- { {id, name, need, have, alts, guildBank, done} } sorted with unfinished first.
function P.remaining()
  local need, names = {}, {}
  for _, e in ipairs(P.list()) do
    for _, g in ipairs(e.reagents) do
      need[g.id] = (need[g.id] or 0) + g.qty * e.qty
      names[g.id] = names[g.id] or g.name or itemName(g.id)
    end
  end
  local out = {}
  for id, n in pairs(need) do
    local s = stockElsewhere(id)
    local have = P.owned(id)
    out[#out + 1] = { id = id, name = names[id] or ("Item " .. id), need = n, have = have,
      alts = s and s.alts or 0, guildBank = s and s.guildBank or 0, done = have >= n }
  end
  table.sort(out, function(a, b)
    if a.done ~= b.done then return not a.done end
    return a.name < b.name
  end)
  return out
end

-- Announce once when everything on the list is gathered.
P.done = {}
function P.checkComplete()
  local rem = P.remaining()
  if #rem == 0 then return end
  local all = true
  for _, r in ipairs(rem) do
    if r.done and not P.done[r.id] then
      P.done[r.id] = true
      ns.print(string.format("|cff40bf40Got all %d %s.|r", r.need, r.name))
    elseif not r.done then
      P.done[r.id] = nil
      all = false
    end
  end
  if all and not P.allDone then
    P.allDone = true
    ns.print("|cff40bf40Everything on your shopping list is ready. Time to craft!|r")
  elseif not all then
    P.allDone = false
  end
end

-- ---------- events ----------
local pending = false
local function onBags()
  if pending then return end
  pending = true
  ns.after(0.5, function()
    pending = false
    if #P.list() > 0 then P.checkComplete(); P.refreshTracker() end
  end)
end
ns.on("BAG_UPDATE_DELAYED", onBags)
ns.on("BANKFRAME_OPENED", onBags)

-- Is a profession window open right now?
function P.professionOpen()
  local f = ProfessionsFrame or TradeSkillFrame
  return f and f.IsShown and f:IsShown() or false
end

function P.safeScan()
  local ok, res = pcall(P.scan)
  if not ok then ns.reportError(res); P.lastScan = { at = ns.now(), error = tostring(res) }; return nil end
  if not res then P.lastScan = P.lastScan or { at = ns.now(), prof = "none found" } end
  return res
end

local function onTradeSkill()
  ns.after(0.6, function()
    if P.safeScan() then P.refreshGuide() end
  end)
end
ns.on("TRADE_SKILL_SHOW", function() onTradeSkill(); P.showGuideIfWanted() end)
ns.on("TRADE_SKILL_LIST_UPDATE", onTradeSkill)
ns.on("TRADE_SKILL_DATA_SOURCE_CHANGED", onTradeSkill)
ns.on("TRADE_SKILL_CLOSE", function() P.hideGuide() end)
ns.on("PLAYER_LOGIN", function() if ns.opt("trackerOnLogin") and #P.list() > 0 and not (ns.db.ui and ns.db.ui.trackerHidden) then P.showTracker() end end)
