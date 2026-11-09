-- Guild Camp at the auction house: one list of what to buy, the shopping list's missing mats and what guildies
-- asked the guild bank for (to donate), with the price of each and the total. "Buy selected…" asks once with the
-- total, then the big button buys one thing per click (the game needs a click for every purchase; no addon can
-- buy several things from one click).
--
-- Safety: nothing is bought without the confirm prompt; a price more than PRICE_GUARD over its estimate is skipped
-- (said in chat); the spend never goes over the confirmed total plus PRICE_GUARD; Stop ends it at once.
--
-- Two auction houses: the modern one (C_AuctionHouse: search, then Buy and Confirm, as Blizzard's own buttons do)
-- and the classic one (QueryAuctionItems + PlaceAuctionBid, cheapest buyout first, one auction per click).
local ADDON, ns = ...
local S = ns.skin
local A = {}
ns.ahTab = A

A.PRICE_GUARD = 1.2
local ROWS = 14

local function money(c)
  if ns.deals and ns.deals.money then return ns.deals.money(c) end
  return tostring(c)
end

local function itemId(name)
  local get = (C_Item and C_Item.GetItemInfoInstant) or GetItemInfoInstant
  if not get or not name then return nil end
  local id = ns.try(get, name)
  return type(id) == "number" and id or nil
end

local function unitPrice(id)
  if not id then return nil end
  if ns.prof and ns.prof.price then return (ns.prof.price(id)) end
  if ns.deals and ns.deals.livePrice then return ns.deals.livePrice(id) end
end

-- ---------- what to buy ----------
-- → { { key, id, name, qty, kind = "list"|"guild", who, note, unit, est, on } }
function A.lines()
  local out = {}
  if ns.prof and ns.prof.remaining then
    for _, r in ipairs(ns.safely(ns.prof.remaining) or {}) do
      local qty = (r.need or 0) - (r.have or 0)
      if not r.done and qty > 0 then
        out[#out + 1] = { key = "l" .. r.id, id = r.id, name = r.name, qty = qty, kind = "list" }
      end
    end
  end
  local handled = {}
  local list = ns.Share and ns.Share.list
  if list then
    for _, h in ipairs(ns.try(list, "BH") or {}) do handled[h.key or ""] = true end
    for _, rec in ipairs(ns.try(list, "bq") or {}) do
      local f = rec.fields or {}
      if f.state ~= "x" and not handled[rec.key or ""] and type(f.item) == "string" and f.item ~= "" then
        out[#out + 1] = { key = "g" .. (rec.key or f.item), id = itemId(f.item), name = f.item, qty = math.max(1, tonumber(f.count) or 1),
          kind = "guild", who = rec.author, note = f.note }
      end
    end
  end
  for _, l in ipairs(out) do
    l.unit = unitPrice(l.id)
    l.est = l.unit and l.unit * l.qty or nil
    if A.picked[l.key] == nil then A.picked[l.key] = l.kind == "list" end
    l.on = A.picked[l.key]
  end
  return out
end
A.picked = {}

function A.totals(lines)
  local t = { count = 0, est = 0, unpriced = 0 }
  for _, l in ipairs(lines) do
    if l.on then
      t.count = t.count + 1
      if l.est then t.est = t.est + l.est else t.unpriced = t.unpriced + 1 end
    end
  end
  return t
end

-- ---------- the auction house ----------
local function modern() return C_AuctionHouse and C_AuctionHouse.SendSearchQuery and true or false end
A.modern = modern

-- The run: the confirmed lines, the one being bought, what was spent.
A.run = nil

local function say(msg) ns.print(msg) end

local function finish(why)
  local r = A.run
  if not r then return end
  A.run = nil
  say(string.format("%s Spent %s on %d purchase%s.", why or "Done buying.", money(r.spent), r.bought, r.bought == 1 and "" or "s"))
  if A.refresh then ns.safely(A.refresh) end
end
A.finish = finish

-- Moves to the next line (or ends). Searches for it (no click needed); the button then shows its price.
local function nextLine()
  local r = A.run
  if not r then return end
  r.i = r.i + 1
  r.step, r.offer = "search", nil
  local l = r.lines[r.i]
  if not l then return finish("Done buying.") end
  r.left = l.qty
  A.search(l)
  if A.refresh then ns.safely(A.refresh) end
end
A.nextLine = nextLine

local function skip(l, why)
  say(string.format("Skipped %s: %s", l.name, why))
  nextLine()
end

-- Would paying `total` for `qty` of line l break a rule? → reason or nil.
function A.guard(l, qty, total)
  local r = A.run
  if l.unit and total > l.unit * qty * A.PRICE_GUARD then
    return string.format("it costs %s, more than %d%% over the expected %s.", money(total), math.floor((A.PRICE_GUARD - 1) * 100 + 0.5), money(l.unit * qty))
  end
  if r.cap and r.spent + total > r.cap then return "that would go over the total you agreed to." end
end

function A.search(l)
  if modern() then
    if not l.id then return skip(l, "the game doesn't know this item's id yet (see it once, or search for it).") end
    local key = C_AuctionHouse.MakeItemKey and ns.try(C_AuctionHouse.MakeItemKey, l.id) or { itemID = l.id }
    ns.try(C_AuctionHouse.SendSearchQuery, key, {}, true)
  elseif QueryAuctionItems then
    if CanSendAuctionQuery and not ns.try(CanSendAuctionQuery) then
      A.run.step = "wait"
      if C_Timer then C_Timer.After(1, function() if A.run and A.run.step == "wait" then A.run.step = "search"; A.search(l) end end) end
      return
    end
    ns.try(QueryAuctionItems, l.name, nil, nil, 0, false, -1, false, true)
  else
    finish("This auction house can't be used by addons.")
  end
end

-- Search results → the offer the button shows.
local function onCommodityResults(itemID)
  local r = A.run
  local l = r and r.lines[r.i]
  if not l or l.id ~= itemID or r.step ~= "search" then return end
  r.step = "buy"
  r.commodity = true
  r.offer = { qty = l.qty }
  if A.refresh then ns.safely(A.refresh) end
end

local function onItemResults(itemKey)
  local r = A.run
  local l = r and r.lines[r.i]
  if not l or (itemKey and itemKey.itemID and itemKey.itemID ~= l.id) or r.step ~= "search" then return end
  local n = ns.try(C_AuctionHouse.GetNumItemSearchResults, itemKey) or 0
  local best
  for i = 1, n do
    local x = ns.try(C_AuctionHouse.GetItemSearchResultInfo, itemKey, i)
    if type(x) == "table" and x.buyoutAmount and x.buyoutAmount > 0 and (x.quantity or 1) <= r.left then
      local each = x.buyoutAmount / (x.quantity or 1)
      if not best or each < best.each then best = { id = x.auctionID, total = x.buyoutAmount, qty = x.quantity or 1, each = each } end
    end
  end
  if not best then return skip(l, "nothing listed with a buyout for the amount still needed.") end
  r.step, r.commodity, r.offer = "buy", false, best
  if A.refresh then ns.safely(A.refresh) end
end

local function onClassicList()
  local r = A.run
  local l = r and r.lines[r.i]
  if not l or r.step ~= "search" or not GetNumAuctionItems then return end
  local n = ns.try(GetNumAuctionItems, "list") or 0
  local best
  for i = 1, n do
    local name, _, count, _, _, _, _, _, _, buyout, _, _, _, owner, _, _, id = ns.try(GetAuctionItemInfo, "list", i)
    count = count or 1
    if name == l.name and (not l.id or not id or id == l.id) and buyout and buyout > 0 and count <= r.left
      and owner ~= (UnitName and UnitName("player")) then
      local each = buyout / count
      if not best or each < best.each then best = { index = i, total = buyout, qty = count, each = each } end
    end
  end
  if not best then return skip(l, "nothing listed with a buyout for the amount still needed.") end
  r.step, r.commodity, r.offer = "buy", false, best
  if A.refresh then ns.safely(A.refresh) end
end

-- The big button: one purchase step per click.
function A.click()
  local r = A.run
  if not r then return end
  local l = r.lines[r.i]
  if not l or not r.offer then return end
  if r.step == "buy" and r.commodity then
    r.step = "pricing"
    ns.try(C_AuctionHouse.StartCommoditiesPurchase, l.id, r.offer.qty)
    return
  end
  if r.step == "confirm" and r.commodity then
    r.step = "paying"
    ns.try(C_AuctionHouse.ConfirmCommoditiesPurchase, l.id, r.offer.qty)
    return
  end
  if r.step == "buy" then
    local why = A.guard(l, r.offer.qty, r.offer.total)
    if why then return skip(l, why) end
    r.step = "paying"
    if r.offer.index then
      ns.try(PlaceAuctionBid, "list", r.offer.index, r.offer.total)
      A.paid(r.offer.total, r.offer.qty)
    else
      ns.try(C_AuctionHouse.PlaceBid, r.offer.id, r.offer.total)
    end
  end
end

-- A purchase went through: count it, then buy more of the same or move on.
function A.paid(total, qty)
  local r = A.run
  if not r then return end
  local l = r.lines[r.i]
  r.spent = r.spent + (total or 0)
  r.bought = r.bought + 1
  r.left = r.left - (qty or 0)
  A.picked[l.key] = nil
  if r.left > 0 and not r.commodity then
    r.step, r.offer = "search", nil
    A.search(l)
    if A.refresh then ns.safely(A.refresh) end
  else
    nextLine()
  end
end

ns.on("COMMODITY_SEARCH_RESULTS_UPDATED", function(itemID) ns.safely(onCommodityResults, itemID) end)
ns.on("ITEM_SEARCH_RESULTS_UPDATED", function(itemKey) ns.safely(onItemResults, itemKey) end)
ns.on("AUCTION_ITEM_LIST_UPDATE", function() ns.safely(onClassicList) end)
ns.on("COMMODITY_PRICE_UPDATED", function(unit, total)
  local r = A.run
  if not r or r.step ~= "pricing" then return end
  local l = r.lines[r.i]
  local why = A.guard(l, r.offer.qty, total or 0)
  if why then
    if C_AuctionHouse.CancelCommoditiesPurchase then ns.try(C_AuctionHouse.CancelCommoditiesPurchase) end
    return skip(l, why)
  end
  r.offer.total, r.step = total, "confirm"
  if A.refresh then ns.safely(A.refresh) end
end)
ns.on("COMMODITY_PURCHASE_SUCCEEDED", function() local r = A.run; if r and r.step == "paying" then A.paid(r.offer.total, r.offer.qty) end end)
ns.on("COMMODITY_PURCHASE_FAILED", function() local r = A.run; if r and r.step == "paying" then skip(r.lines[r.i], "the purchase failed (someone may have bought it first).") end end)
ns.on("AUCTION_HOUSE_PURCHASE_COMPLETED", function() local r = A.run; if r and r.step == "paying" and not r.commodity then A.paid(r.offer.total, r.offer.qty) end end)
ns.on("AUCTION_HOUSE_CLOSED", function()
  if A.run then finish("The auction house closed, so buying stopped.") end
  if A.frame then A.frame:Hide() end
end)

-- ---------- start: the confirm prompt ----------
StaticPopupDialogs["WOWGUILD_AH_BUY"] = {
  text = "Buy %s?\n\nYou'll click once for each purchase. Guild Camp skips anything more than 20%% over its expected price, and stops before going over this total.",
  button1 = "Start buying",
  button2 = "Cancel",
  OnAccept = function(_, data) if data then A.start(data.lines, data.cap) end end,
  timeout = 0,
  whileDead = false,
  hideOnEscape = true,
  preferredIndex = 3,
}

function A.confirm()
  local lines, t = {}, nil
  for _, l in ipairs(A.lines()) do if l.on then lines[#lines + 1] = l end end
  t = A.totals(lines)
  if t.count == 0 then say("Tick what you want to buy first."); return false end
  local what = string.format("%d item%s for about %s", t.count, t.count == 1 and "" or "s", money(t.est))
  if t.unpriced > 0 then what = what .. string.format(" (+%d without a price: you'll see it before you pay)", t.unpriced) end
  local cap = t.unpriced == 0 and math.floor(t.est * A.PRICE_GUARD) or nil
  if StaticPopup_Show then ns.try(StaticPopup_Show, "WOWGUILD_AH_BUY", what, nil, { lines = lines, cap = cap }) end
  return true, t
end

function A.start(lines, cap)
  if A.run then return end
  A.run = { lines = lines, i = 0, spent = 0, bought = 0, cap = cap }
  nextLine()
end

-- ---------- the panel ----------
local function create()
  local f = CreateFrame("Frame", "WowGuildAuctionTab", UIParent)
  f:SetSize(330, 150 + ROWS * 22); f:SetFrameStrata("HIGH")
  S.panel(f)
  f.title = S.text(f, "heading", "Guild Camp", S.GOLD); f.title:SetPoint("TOPLEFT", 12, -10)
  f.sub = S.text(f, "small", "Your shopping list and what the guild bank needs", { 0.62, 0.62, 0.66 }); f.sub:SetPoint("TOPLEFT", 12, -30)
  S.rule(f, -48, 8)
  f.rows = {}
  for i = 1, ROWS do
    local r = CreateFrame("Frame", nil, f)
    r:SetSize(306, 20); r:SetPoint("TOPLEFT", 12, -54 - (i - 1) * 22)
    r.check = CreateFrame("CheckButton", nil, r, "UICheckButtonTemplate")
    r.check:SetSize(20, 20); r.check:SetPoint("LEFT", 0, 0)
    r.check:SetScript("OnClick", function(self) if r.line then A.picked[r.line.key] = self:GetChecked() and true or false; A.refresh() end end)
    r.name = S.text(r, "small", ""); r.name:SetPoint("LEFT", 24, 0); r.name:SetWidth(190)
    if r.name.SetWordWrap then r.name:SetWordWrap(false) end
    r.cost = S.text(r, "small", "", { 0.85, 0.85, 0.85 }); r.cost:SetPoint("RIGHT", 0, 0); r.cost:SetJustifyH("RIGHT")
    f.rows[i] = r
  end
  f.total = S.text(f, "body", "", S.EMBER); f.total:SetPoint("BOTTOMLEFT", 12, 64); f.total:SetWidth(306)
  f.go = CreateFrame("Button", nil, f, "UIPanelButtonTemplate"); f.go:SetSize(306, 26); f.go:SetPoint("BOTTOMLEFT", 12, 34)
  f.go:SetScript("OnClick", function() if A.run then A.click() else A.confirm() end end)
  f.stop = CreateFrame("Button", nil, f, "UIPanelButtonTemplate"); f.stop:SetSize(100, 22); f.stop:SetPoint("BOTTOMLEFT", 12, 8)
  f.stop:SetText("Stop"); f.stop:SetScript("OnClick", function() finish("Stopped.") end)
  f.close = CreateFrame("Button", nil, f, "UIPanelButtonTemplate"); f.close:SetSize(100, 22); f.close:SetPoint("BOTTOMRIGHT", -12, 8)
  f.close:SetText("Hide"); f.close:SetScript("OnClick", function() f:Hide() end)
  f:Hide()
  return f
end
function A.panel() A.frame = A.frame or create(); return A.frame end

function A.buttonText()
  local r = A.run
  if not r then return "Buy selected…" end
  local l = r.lines[r.i]
  if not l then return "Done" end
  if r.step == "search" or r.step == "wait" then return "Finding " .. l.name .. "…" end
  if r.step == "pricing" then return "Getting the price…" end
  if r.step == "paying" then return "Buying…" end
  if r.step == "confirm" then return string.format("Confirm: pay %s for %d × %s", money(r.offer.total), r.offer.qty, l.name) end
  if r.commodity then return string.format("Buy %d × %s (%d of %d)", r.offer.qty, l.name, r.i, #r.lines) end
  return string.format("Buy %d × %s for %s", r.offer.qty, l.name, money(r.offer.total))
end

function A.refresh()
  local f = A.panel()
  local lines = A.lines()
  for _, r in ipairs(f.rows) do r:Hide() end
  for i, l in ipairs(lines) do
    if i > ROWS then break end
    local r = f.rows[i]
    r.line = l
    r.check:SetChecked(l.on)
    r.name:SetText(string.format("%s%d × %s%s", l.kind == "guild" and "|cffe8a33d" or "|cffffffff", l.qty, l.name,
      l.kind == "guild" and ("|r |cff9e9ea8for " .. (l.who or "the bank") .. "|r") or "|r"))
    r.cost:SetText(l.est and money(l.est) or "|cff9e9ea8no price|r")
    r:Show()
  end
  local t = A.totals(lines)
  if #lines == 0 then
    f.total:SetText("Nothing to buy: your shopping list is done and nobody asked the bank for anything.")
  elseif A.run then
    f.total:SetText(string.format("Spent %s so far. Click the button for each purchase.", money(A.run.spent)))
  else
    f.total:SetText(string.format("Total: about %s for %d item%s%s", money(t.est), t.count, t.count == 1 and "" or "s",
      t.unpriced > 0 and string.format(" (+%d without a price)", t.unpriced) or ""))
  end
  f.go:SetText(A.buttonText())
  f.go:SetEnabled(A.run and A.run.offer ~= nil and (A.run.step == "buy" or A.run.step == "confirm") or (not A.run and t.count > 0))
  f.stop:SetShown(A.run ~= nil)
  return lines, t
end

local function ahFrame() return _G.AuctionHouseFrame or _G.AuctionFrame end

function A.show()
  local f = A.panel()
  local ah = ahFrame()
  f:ClearAllPoints()
  if ah and ah.IsShown and ah:IsShown() then f:SetPoint("TOPLEFT", ah, "TOPRIGHT", 6, 0) else f:SetPoint("CENTER", -200, 0) end
  A.refresh()
  f:Show()
  -- The Deal hunter goes to the right of this panel.
  local dp = _G.WowGuildDeals
  if dp and dp:IsShown() and ns.deals and ns.deals.show then ns.safely(ns.deals.show) end
end
function A.toggle() local f = A.panel(); if f:IsShown() then f:Hide() else A.show() end end

-- A "Guild Camp" tab under the auction house window opens and closes the panel.
local tabButton
local function attachTab()
  local ah = ahFrame()
  if tabButton or not ah then return end
  tabButton = CreateFrame("Button", "WowGuildAuctionTabButton", ah, "UIPanelButtonTemplate")
  tabButton:SetSize(110, 24); tabButton:SetPoint("TOPRIGHT", ah, "BOTTOMRIGHT", -8, 2)
  tabButton:SetText("Guild Camp")
  tabButton:SetScript("OnClick", function() A.toggle() end)
end

ns.on("AUCTION_HOUSE_SHOW", function()
  ns.safely(attachTab)
  if ns.opt("ahTab") == false then return end
  ns.safely(A.show)
end)
