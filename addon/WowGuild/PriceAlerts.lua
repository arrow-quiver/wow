-- Guild Camp: price alerts at the auction house. While you browse (Blizzard's search, Auctionator, a scan), any
-- auction of something on your buy list (your shopping list's missing mats, and what guildies asked the guild bank
-- for) at or under its target lights up: a line on screen and in chat, once per item per visit. The Guild Camp tab
-- then buys it (on your clicks, after its confirm). Target: your own (/wow alert <price> <item>), else 85% of the
-- usual price (Auctionator's, else the guild's). Reading auction results only; nothing is bought here.
-- Option priceAlerts.
local ADDON, ns = ...
local PA = {}
ns.priceAlerts = PA

PA.SHARE = 0.85
PA.CHECK_EVERY = 20

local GOLD = "|cffe8a33d"
local function money(c) return ns.deals and ns.deals.money and ns.deals.money(c) or tostring(c) end
local function targets() ns.db.priceTargets = ns.db.priceTargets or {}; return ns.db.priceTargets end

-- The buy list as { [id] = { id, name, kind, who, target, usual } }.
function PA.watch()
  local out = {}
  local lines = (ns.ahTab and ns.ahTab.lines and ns.try(ns.ahTab.lines)) or {}
  for _, l in ipairs(lines) do
    if l.id and not out[l.id] then
      local usual = ns.prof and ns.prof.price and ns.prof.price(l.id)
      local own = targets()[l.id]
      local target = own or (usual and math.floor(usual * PA.SHARE))
      if target and target > 0 then out[l.id] = { id = l.id, name = l.name, kind = l.kind, who = l.who, target = target, usual = usual, own = own ~= nil } end
    end
  end
  -- Targets set by hand for items not on the list.
  for id, t in pairs(targets()) do
    if not out[id] then out[id] = { id = id, name = (C_Item and C_Item.GetItemNameByID and ns.try(C_Item.GetItemNameByID, id)) or ("item " .. id), kind = "alert", target = t, own = true } end
  end
  return out
end

local told = {}
function PA.reset() told = {} end

-- A price seen for an item (copper each). → the alert line, or nil.
function PA.seen(id, unit, count, list)
  if ns.opt("priceAlerts") == false or not id or not unit or unit <= 0 then return nil end
  local w = (list or PA.watch())[id]
  if not w or unit > w.target or told[id] then return nil end
  told[id] = unit
  local why = w.kind == "guild" and ("a guild bank request" .. (w.who and (" from " .. w.who) or "")) or w.kind == "list" and "your shopping list" or "your price alert"
  local line = string.format("Deal: %s at %s each%s (%s %s), on %s.", w.name or ("item " .. id), money(unit),
    count and count > 1 and (", " .. count .. " up") or "", w.own and "your target" or "usual", money(w.own and w.target or w.usual or w.target), why)
  if ns.notice then ns.notice(line, 8) end
  ns.print(GOLD .. line .. "|r Guild Camp tab → Buy.")
  if PlaySound and SOUNDKIT and SOUNDKIT.AUCTION_WINDOW_OPEN then ns.try(PlaySound, SOUNDKIT.AUCTION_WINDOW_OPEN) end
  return line
end

-- ---------- what the auction house shows ----------
local function classicList()
  if not GetNumAuctionItems or not GetAuctionItemInfo then return 0 end
  local list, n = PA.watch(), 0
  local batch = ns.try(GetNumAuctionItems, "list") or 0
  for i = 1, math.min(batch, 50) do
    local _, _, count, _, _, _, _, _, _, buyout, _, _, _, _, _, _, id = ns.try(GetAuctionItemInfo, "list", i)
    if id and buyout and buyout > 0 and count and count > 0 then
      if PA.seen(id, math.floor(buyout / count), count, list) then n = n + 1 end
    end
  end
  return n
end
PA.classicList = classicList

local function commodity(itemID)
  local get = C_AuctionHouse and C_AuctionHouse.GetCommoditySearchResultInfo
  local r = get and ns.try(get, itemID, 1)
  if type(r) == "table" and r.unitPrice then return PA.seen(itemID, r.unitPrice, r.quantity) end
end

local function item(itemKey)
  local get = C_AuctionHouse and C_AuctionHouse.GetItemSearchResultInfo
  local r = type(itemKey) == "table" and get and ns.try(get, itemKey, 1)
  if type(r) == "table" and r.buyoutAmount then return PA.seen(itemKey.itemID, r.buyoutAmount, r.quantity) end
end

-- Auctionator's prices from this visit (after a scan or searches): every watched item at once.
function PA.checkAuctionator()
  local api = Auctionator and Auctionator.API and Auctionator.API.v1
  if not (api and api.GetAuctionPriceByItemID) then return 0 end
  local list, n = PA.watch(), 0
  for id in pairs(list) do
    local p = ns.try(api.GetAuctionPriceByItemID, "WowGuild", id)
    if p and PA.seen(id, p, nil, list) then n = n + 1 end
  end
  return n
end

-- /wow alert <gold> <item link or name>   ·   /wow alert off <item>   ·   /wow alerts
local function idOf(text)
  local id = tonumber(string.match(text or "", "item:(%d+)"))
  if id then return id end
  local get = (C_Item and C_Item.GetItemInfoInstant) or GetItemInfoInstant
  local n = get and ns.try(get, (text or ""):gsub("^%s+", ""):gsub("%s+$", ""))
  return type(n) == "number" and n or nil
end

-- "1g 50s", "1.5g", "75s", "3" (gold) → copper, or nil.
function PA.parseMoney(s)
  s = string.lower(s or "")
  local g, sv, c = tonumber(string.match(s, "([%d%.]+)g")), tonumber(string.match(s, "(%d+)s")), tonumber(string.match(s, "(%d+)c"))
  if not g and not sv and not c then g = tonumber(s) end
  if not g and not sv and not c then return nil end
  return math.floor((g or 0) * 10000 + (sv or 0) * 100 + (c or 0) + 0.5)
end

function PA.slash(rest)
  rest = rest or ""
  local off = string.match(rest, "^off%s+(.+)$")
  if off then
    local id = idOf(off)
    if id and targets()[id] then targets()[id] = nil; ns.print("Price alert removed."); return true end
    ns.print("No price alert for that item."); return false
  end
  local price, what = string.match(rest, "^(%S+)%s+(.+)$")
  local copper, id = PA.parseMoney(price), idOf(what)
  if rest == "" or not copper or not id then
    local list, n = PA.watch(), 0
    for _, w in pairs(list) do n = n + 1; ns.print(string.format("  %s: under %s%s", w.name or w.id, money(w.target), w.own and " (yours)" or "")) end
    if n == 0 then ns.print("Nothing to watch: add mats to your shopping list, or /wow alert 1g50s [item].") end
    ns.print("/wow alert <price> <item> sets your own target, /wow alert off <item> removes it.")
    return n
  end
  targets()[id] = copper
  ns.print(string.format("Price alert: %s under %s.", what, money(copper)))
  return copper
end

local ticker
ns.on("AUCTION_HOUSE_SHOW", function()
  PA.reset()
  ns.safely(PA.checkAuctionator)
  if C_Timer and C_Timer.NewTicker and not ticker then ticker = C_Timer.NewTicker(PA.CHECK_EVERY, function() ns.safely(PA.checkAuctionator) end) end
end)
ns.on("AUCTION_HOUSE_CLOSED", function() if ticker then ticker:Cancel(); ticker = nil end end)
ns.on("AUCTION_ITEM_LIST_UPDATE", function() ns.safely(classicList) end)
ns.on("COMMODITY_SEARCH_RESULTS_UPDATED", function(id) ns.safely(commodity, id) end)
ns.on("ITEM_SEARCH_RESULTS_UPDATED", function(key) ns.safely(item, key) end)
