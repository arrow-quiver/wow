-- Guild Camp: profession helper panels.
--   Guide: sits beside the profession window, lists the cheapest skill-ups.
--   Tracker: small movable list of mats still needed for your shopping list.
local ADDON, ns = ...
local P = ns.prof

local ROWS = 10

local function ui()
  ns.db.ui = ns.db.ui or {}
  return ns.db.ui
end

local function money(c)
  if not c then return "?" end
  c = math.floor(c + 0.5)
  local g, s, cc = math.floor(c / 10000), math.floor((c % 10000) / 100), c % 100
  if g > 0 then return string.format("%dg %ds", g, s) end
  if s > 0 then return string.format("%ds %dc", s, cc) end
  return cc .. "c"
end
P.money = money

local function skin(f)
  if f.SetBackdrop then
    f:SetBackdrop({ bgFile = "Interface\\Buttons\\WHITE8x8", edgeFile = "Interface\\Buttons\\WHITE8x8", edgeSize = 2 })
    f:SetBackdropColor(0.12, 0.23, 0.2, 0.96)
    f:SetBackdropBorderColor(0.91, 0.64, 0.24, 1)
  end
end

local function savePos(f, key)
  local point, _, rel, x, y = f:GetPoint()
  ui()[key] = { point = point, rel = rel, x = x, y = y }
end

-- ---------- guide ----------
local guide

local function createGuide()
  local f = CreateFrame("Frame", "WowGuildSkillGuide", UIParent, "BackdropTemplate")
  f:SetSize(354, 60 + ROWS * 34)
  f:SetFrameStrata("HIGH")
  f:SetMovable(true); f:EnableMouse(true); f:RegisterForDrag("LeftButton"); f:SetClampedToScreen(true)
  f:SetScript("OnDragStart", f.StartMoving)
  f:SetScript("OnDragStop", function(self) self:StopMovingOrSizing(); savePos(self, "guidePos") end)
  skin(f)

  f.title = f:CreateFontString(nil, "OVERLAY", "GameFontNormal")
  f.title:SetPoint("TOPLEFT", 12, -10)
  f.title:SetText("Skill-up guide")
  f.sub = f:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
  f.sub:SetPoint("TOPLEFT", 12, -28)
  f.sub:SetWidth(300); f.sub:SetJustifyH("LEFT")
  local close = CreateFrame("Button", nil, f, "UIPanelCloseButton")
  close:SetPoint("TOPRIGHT", -2, -2)
  close:SetScript("OnClick", function() ui().guideHidden = true; f:Hide() end)

  f.rows = {}
  for i = 1, ROWS do
    -- The whole row is a button: hover for the item tooltip, click to open the recipe, shift-click to link it.
    local row = CreateFrame("Button", nil, f)
    row:SetSize(330, 32)
    row:SetPoint("TOPLEFT", 10, -48 - (i - 1) * 34)
    row:SetHighlightTexture("Interface\\QuestFrame\\UI-QuestTitleHighlight", "ADD")
    row.icon = row:CreateTexture(nil, "ARTWORK")
    row.icon:SetSize(26, 26); row.icon:SetPoint("LEFT", 2, 0)
    row.name = row:CreateFontString(nil, "OVERLAY", "GameFontHighlight")
    row.name:SetPoint("TOPLEFT", 34, -1); row.name:SetWidth(186); row.name:SetJustifyH("LEFT")
    row.info = row:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
    row.info:SetPoint("TOPLEFT", 34, -17); row.info:SetWidth(186); row.info:SetJustifyH("LEFT")
    row.add = CreateFrame("Button", nil, row, "UIPanelButtonTemplate")
    row.add:SetSize(52, 22); row.add:SetPoint("RIGHT", 0, 0)
    row.add:SetText("+5 list")
    row.add:SetScript("OnClick", function(self) if self.recipe then P.addToList(self.recipe, 5) end end)
    row.make = CreateFrame("Button", nil, row, "UIPanelButtonTemplate")
    row.make:SetSize(48, 22); row.make:SetPoint("RIGHT", row.add, "LEFT", -4, 0)
    row.make:SetText("Make")
    row.make:SetScript("OnClick", function(self) if self.recipe then P.craft(self.recipe, 1) end end)
    row:SetScript("OnEnter", function(self)
      local r = self.recipe
      if r and r.outputId then ns.items.showTooltip(self, r.outputId)
      elseif r and GameTooltip then
        GameTooltip:SetOwner(self, "ANCHOR_RIGHT"); GameTooltip:AddLine(r.name)
        for _, g in ipairs(r.reagents or {}) do GameTooltip:AddLine(string.format("%d × %s", g.qty, g.name or "?"), 1, 1, 1) end
        GameTooltip:Show()
      end
    end)
    row:SetScript("OnLeave", function() ns.items.hideTooltip() end)
    row:SetScript("OnClick", function(self)
      local r = self.recipe
      if not r then return end
      if ns.items.shiftDown() and r.outputId then ns.items.insertLink(r.outputId) else P.select(r) end
    end)
    row:Hide() -- rows only show once there's a recipe to put in them
    f.rows[i] = row
  end
  f:Hide()
  return f
end

local function placeGuide()
  local pos = ui().guidePos
  guide:ClearAllPoints()
  if pos then guide:SetPoint(pos.point or "CENTER", UIParent, pos.rel or "CENTER", pos.x or 0, pos.y or 0); return end
  local parent = ProfessionsFrame or TradeSkillFrame
  if parent and parent.IsShown and parent:IsShown() then guide:SetPoint("TOPLEFT", parent, "TOPRIGHT", 6, 0)
  else guide:SetPoint("CENTER", UIParent, "CENTER", 300, 0) end
end

local function hideRows() for _, row in ipairs(guide.rows) do row:Hide() end end

function P.refreshGuide()
  if not guide or not guide:IsShown() then return end
  if not P.current then
    guide.title:SetText("Skill-up guide")
    guide.sub:SetText("Open a profession window and this list fills in with the cheapest skill-ups.")
    hideRows()
    return
  end
  local ok, ranked = pcall(P.rank, P.current.recipes, ROWS)
  if not ok then
    ns.reportError(ranked)
    guide.title:SetText(P.current.name .. " skill-ups")
    guide.sub:SetText("|cffff6040Couldn't rank these recipes.|r Settings tab → Problem report, and send it to your officer.")
    hideRows()
    return
  end
  guide.title:SetText(P.current.name .. " skill-ups")
  local hasAuctionator = Auctionator and Auctionator.API and Auctionator.API.v1
  guide.sub:SetText(#ranked == 0 and "Nothing gives skill points right now. Train new recipes."
    or (hasAuctionator and "Cheapest first. Prices from Auctionator." or "Cheapest first. Prices from guild scans."))
  for i, row in ipairs(guide.rows) do
    local r = ranked[i]
    if r then
      row.name:SetText(string.format("|cff%s%s|r", P.COLOR[r.recipe.diff] or "ffffff", r.recipe.name))
      local bits = {}
      if r.fromBags > 0 then bits[#bits + 1] = "|cff40bf40can make " .. r.fromBags .. " now|r" end
      bits[#bits + 1] = r.unknown and "some prices unknown" or (money(r.perPoint) .. " per point")
      if r.points < 1 then bits[#bits + 1] = string.format("%d%% chance", math.floor(r.points * 100 / (r.recipe.skillUps or 1) + 0.5)) end
      row.info:SetText(table.concat(bits, "  ·  "))
      row.add.recipe = r.recipe
      row.make.recipe = r.recipe
      row.recipe = r.recipe
      row.icon:SetTexture(r.recipe.icon or (r.recipe.outputId and ns.items.icon(r.recipe.outputId)) or "Interface\\Icons\\INV_Misc_QuestionMark")
      if r.fromBags > 0 then row.make:Show() else row.make:Hide() end
      row:Show()
    else
      row:Hide()
    end
  end
end

function P.showGuideIfWanted()
  if ui().guideHidden or not ns.opt("autoGuide") then return end
  guide = guide or createGuide()
  if P.professionOpen() then P.safeScan() end
  placeGuide()
  guide:Show()
  P.refreshGuide()
end
function P.hideGuide() if guide then guide:Hide() end end
function P.toggleGuide()
  guide = guide or createGuide()
  if guide:IsShown() then ui().guideHidden = true; guide:Hide()
  else
    ui().guideHidden = false
    if P.professionOpen() then P.safeScan() end
    if not P.current then ns.print("Open a profession window and the guide fills in.") end
    placeGuide(); guide:Show(); P.refreshGuide()
  end
end

-- ---------- tracker ----------
local tracker
local MAX_LINES = 14

local function createTracker()
  local f = CreateFrame("Frame", "WowGuildShoppingList", UIParent, "BackdropTemplate")
  f:SetSize(290, 60)
  f:SetFrameStrata("MEDIUM")
  f:SetMovable(true); f:EnableMouse(true); f:RegisterForDrag("LeftButton"); f:SetClampedToScreen(true)
  f:SetScript("OnDragStart", f.StartMoving)
  f:SetScript("OnDragStop", function(self) self:StopMovingOrSizing(); savePos(self, "trackerPos") end)
  skin(f)
  f.title = f:CreateFontString(nil, "OVERLAY", "GameFontNormal")
  f.title:SetPoint("TOPLEFT", 10, -8)
  f.title:SetText("Shopping list")
  local close = CreateFrame("Button", nil, f, "UIPanelCloseButton")
  close:SetPoint("TOPRIGHT", 0, 0)
  close:SetScript("OnClick", function() ui().trackerHidden = true; f:Hide() end)
  f.text = f:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
  f.text:SetPoint("TOPLEFT", 10, -28)
  f.text:SetWidth(270); f.text:SetJustifyH("LEFT"); f.text:SetSpacing(2)
  local pos = ui().trackerPos
  if pos then f:SetPoint(pos.point or "RIGHT", UIParent, pos.rel or "RIGHT", pos.x or -40, pos.y or 0)
  else f:SetPoint("RIGHT", UIParent, "RIGHT", -40, 120) end
  f:Hide()
  return f
end

function P.trackerText()
  local list, rem = P.list(), P.remaining()
  if #list == 0 then return "Empty. Add recipes from the skill-up guide\n(open a profession window)." end
  local lines = {}
  local names = {}
  for _, e in ipairs(list) do names[#names + 1] = e.qty .. " × " .. e.name end
  lines[#lines + 1] = "|cff999999For: " .. table.concat(names, ", ") .. "|r"
  for i, r in ipairs(rem) do
    if i > MAX_LINES then lines[#lines + 1] = "|cff999999and " .. (#rem - MAX_LINES) .. " more|r"; break end
    local where = {}
    if not r.done and r.alts > 0 then where[#where + 1] = r.alts .. " on alts" end
    if not r.done and r.guildBank > 0 then where[#where + 1] = r.guildBank .. " in guild bank" end
    lines[#lines + 1] = string.format("%s%s|r  %d / %d%s", r.done and "|cff40bf40" or "|cffffffff", r.name,
      math.min(r.have, r.need), r.need, #where > 0 and ("  |cffe8a33d(" .. table.concat(where, ", ") .. ")|r") or "")
  end
  return table.concat(lines, "\n")
end

function P.refreshTracker()
  if ns.ui and ns.ui.refreshIfShown then ns.ui.refreshIfShown() end
  if not tracker or not tracker:IsShown() then return end
  tracker.text:SetText(P.trackerText())
  tracker:SetHeight(40 + (tracker.text:GetStringHeight() or 40))
end

function P.showTracker()
  tracker = tracker or createTracker()
  ui().trackerHidden = false
  tracker:Show()
  P.refreshTracker()
end
function P.trackerShown() return tracker and tracker:IsShown() or false end
function P.guideShown() return guide and guide:IsShown() or false end

function P.toggleTracker()
  tracker = tracker or createTracker()
  if tracker:IsShown() then ui().trackerHidden = true; tracker:Hide() else P.showTracker() end
end
