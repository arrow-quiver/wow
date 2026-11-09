-- Guild Camp: the Deal hunter at the auction house. The Guild Camp app works out what to buy and sell again
-- from your Auctionator history (GET /api/deals) and puts the best ones in the inbox. This panel shows them
-- beside the auction house, checks each against Auctionator's live price from this session, and searches
-- for them with one click.
local ADDON, ns = ...
local S = ns.skin
local DH = {}
ns.deals = DH

local ROWS = 12
local GREEN, GREY = { 0.45, 0.85, 0.5 }, { 0.62, 0.62, 0.66 }
local SURE = { certain = "|cff73c088certain|r", high = "|cff73c088likely|r", medium = "|cffe8a33dfair|r", low = "|cff9e9ea8risky|r" }

local function money(c)
  if not c then return "?" end
  c = math.floor(c + 0.5)
  local g, s, cc = math.floor(c / 10000), math.floor((c % 10000) / 100), c % 100
  if g > 0 then return string.format("%dg %ds", g, s) end
  if s > 0 then return string.format("%ds %dc", s, cc) end
  return cc .. "c"
end
DH.money = money

local function auctionator() return Auctionator and Auctionator.API and Auctionator.API.v1 end

-- Auctionator's price from this session's scans, if it has one.
function DH.livePrice(id)
  local api = auctionator()
  if not (api and api.GetAuctionPriceByItemID) then return nil end
  local p = ns.try(api.GetAuctionPriceByItemID, "WowGuild", id)
  return type(p) == "number" and p > 0 and p or nil
end

-- The inbox's deals, each checked against the live price: still there (buy ≤ live), gone (live is higher
-- than the deal allows), or unknown (no live price this session).
function DH.list()
  local d = WowGuildInbox and WowGuildInbox.deals
  if type(d) ~= "table" then return nil end
  local out = {}
  local function add(x, vendor)
    if type(x) ~= "table" or not x.id then return end
    local live = DH.livePrice(x.id)
    local state = "unknown"
    local profit = x.profit
    if live then
      local resale = vendor and (x.worth or 0) or math.floor((x.worth or 0) * 0.95)
      profit = resale - live
      state = (profit > 0 and live <= (x.buy or live) * 1.1) and "still" or (profit > 0 and "changed" or "gone")
    end
    out[#out + 1] = { id = x.id, name = x.name or ("Item " .. x.id), buy = x.buy, worth = x.worth, profit = profit,
      sure = vendor and "certain" or x.sure, vendor = vendor, live = live, state = state }
  end
  for _, x in ipairs(d.vendor or {}) do add(x, true) end
  for _, x in ipairs(d.items or {}) do add(x, false) end
  return out, d
end

function DH.search(names)
  local api = auctionator()
  if api and api.MultiSearchExact then
    if pcall(api.MultiSearchExact, "WowGuild", names) then return true end
  end
  ns.print("Install Auctionator (and open the auction house) to search for deals with one click.")
  return false
end

function DH.makeList()
  local list = DH.list()
  local api = auctionator()
  if not list or #list == 0 or not (api and api.CreateShoppingList) then return false end
  local names = {}
  for _, x in ipairs(list) do if x.state ~= "gone" then names[#names + 1] = x.name end end
  local ok = pcall(api.CreateShoppingList, "WowGuild", "Guild Camp deals", names)
  if ok then ns.print("Made an Auctionator shopping list called \"Guild Camp deals\".") end
  return ok
end

-- ---------- panel ----------
local panel
local function create()
  local f = CreateFrame("Frame", "WowGuildDeals", UIParent)
  f:SetSize(300, 470); f:SetFrameStrata("HIGH")
  f:SetMovable(true); f:EnableMouse(true); f:RegisterForDrag("LeftButton"); f:SetClampedToScreen(true)
  f:SetScript("OnDragStart", f.StartMoving); f:SetScript("OnDragStop", f.StopMovingOrSizing)
  S.panel(f)
  local close = CreateFrame("Button", nil, f, "UIPanelCloseButton"); close:SetPoint("TOPRIGHT", -2, -2)
  close:SetScript("OnClick", function() f:Hide(); f.closedByHand = true end)
  f.title = S.text(f, "heading", "Deal hunter", S.GOLD); f.title:SetPoint("TOPLEFT", 12, -10)
  f.sub = S.text(f, "small", "", GREY); f.sub:SetPoint("TOPLEFT", 12, -30); f.sub:SetWidth(270)
  if f.sub.SetWordWrap then f.sub:SetWordWrap(true) end
  S.rule(f, -58, 8)
  f.rows = {}
  for i = 1, ROWS do
    local b = CreateFrame("Button", nil, f)
    b:SetSize(276, 30); b:SetPoint("TOPLEFT", 12, -64 - (i - 1) * 31)
    b.hl = S.colorTex(b, "HIGHLIGHT", 1, 1, 1, 0.06); b.hl:SetAllPoints()
    b.name = S.text(b, "body", ""); b.name:SetPoint("TOPLEFT", 0, -1); b.name:SetWidth(190)
    if b.name.SetWordWrap then b.name:SetWordWrap(false) end
    b.meta = S.text(b, "small", "", GREY); b.meta:SetPoint("TOPLEFT", 0, -16); b.meta:SetWidth(200)
    b.profit = S.text(b, "body", "", GREEN); b.profit:SetPoint("TOPRIGHT", 0, -1); b.profit:SetJustifyH("RIGHT")
    b.sure = S.text(b, "small", ""); b.sure:SetPoint("TOPRIGHT", 0, -16); b.sure:SetJustifyH("RIGHT")
    b:SetScript("OnClick", function(self) if self.deal then DH.search({ self.deal.name }) end end)
    b:SetScript("OnEnter", function(self)
      if not self.deal or not GameTooltip then return end
      GameTooltip:SetOwner(self, "ANCHOR_RIGHT")
      if GameTooltip.SetItemByID then pcall(GameTooltip.SetItemByID, GameTooltip, self.deal.id) else GameTooltip:SetText(self.deal.name) end
      GameTooltip:AddLine(" ")
      GameTooltip:AddLine("Click to search for it.", 0.9, 0.8, 0.5)
      GameTooltip:Show()
    end)
    b:SetScript("OnLeave", function() if GameTooltip then GameTooltip:Hide() end end)
    f.rows[i] = b
  end
  f.empty = S.text(f, "body", "", GREY); f.empty:SetPoint("TOPLEFT", 12, -70); f.empty:SetWidth(270)
  if f.empty.SetWordWrap then f.empty:SetWordWrap(true) end
  f.all = CreateFrame("Button", nil, f, "UIPanelButtonTemplate"); f.all:SetSize(128, 22); f.all:SetPoint("BOTTOMLEFT", 12, 10)
  f.all:SetText("Search all"); f.all:SetScript("OnClick", function()
    local names = {}
    for _, x in ipairs(DH.list() or {}) do if x.state ~= "gone" then names[#names + 1] = x.name end end
    if #names > 0 then DH.search(names) end
  end)
  f.mk = CreateFrame("Button", nil, f, "UIPanelButtonTemplate"); f.mk:SetSize(140, 22); f.mk:SetPoint("LEFT", f.all, "RIGHT", 8, 0)
  f.mk:SetText("Shopping list"); f.mk:SetScript("OnClick", DH.makeList)
  f:Hide()
  return f
end

function DH.panel() panel = panel or create(); return panel end

function DH.refresh()
  local f = DH.panel()
  local list, d = DH.list()
  for _, b in ipairs(f.rows) do b:Hide(); b.deal = nil end
  if not list then
    f.sub:SetText("Nothing yet.")
    f.empty:SetText("Scan the auction house with Auctionator, then /reload with the Guild Camp app running. "
      .. "The app finds items listed well below their usual price and they show up here.")
    f.empty:Show(); f.all:Hide(); f.mk:Hide()
    return
  end
  f.sub:SetText(string.format("%s, from your scan of %s. Click one to search.", d.realm or "", d.day or "?"))
  if #list == 0 then
    f.empty:SetText("No deals in your last scan. Scan again later: prices move all day."); f.empty:Show()
  else f.empty:Hide() end
  local shown = 0
  for _, x in ipairs(list) do
    if shown >= ROWS then break end
    shown = shown + 1
    local b = f.rows[shown]
    b.deal = x
    b.name:SetText(x.name)
    if x.state == "gone" then
      b.name:SetTextColor(0.5, 0.5, 0.5)
      b.meta:SetText("Gone: now " .. money(x.live))
      b.profit:SetText(""); b.sure:SetText("")
    else
      b.name:SetTextColor(1, 1, 1)
      local buy = x.live or x.buy
      b.meta:SetText((x.vendor and "buy %s, vendor pays %s" or "buy %s, usually %s"):format(money(buy), money(x.worth))
        .. (x.state == "changed" and " (price changed)" or ""))
      b.profit:SetText("+" .. money(x.profit))
      b.sure:SetText(SURE[x.sure] or "")
    end
    b:Show()
  end
  f.all:SetShown(shown > 0); f.mk:SetShown(shown > 0 and auctionator() and auctionator().CreateShoppingList and true or false)
end

local function ahFrame() return _G.AuctionHouseFrame or _G.AuctionFrame end

function DH.show()
  local f = DH.panel()
  local ah = ahFrame()
  f:ClearAllPoints()
  if ah and ah.IsShown and ah:IsShown() then f:SetPoint("TOPLEFT", ah, "TOPRIGHT", 6, 0) else f:SetPoint("CENTER", 300, 0) end
  DH.refresh()
  f:Show()
end
function DH.toggle() local f = DH.panel(); if f:IsShown() then f:Hide() else DH.show() end end

ns.on("AUCTION_HOUSE_SHOW", function()
  if ns.opt("dealsPanel") == false then return end
  local f = DH.panel()
  if f.closedByHand then return end
  DH.show()
end)
ns.on("AUCTION_HOUSE_CLOSED", function() if panel then panel:Hide(); panel.closedByHand = nil end end)
-- A fresh Auctionator scan in this session: re-check the live prices.
ns.on("AUCTION_ITEM_LIST_UPDATE", function() if panel and panel:IsShown() then DH.refresh() end end)
