-- Guild Camp: problem report. Settings tab → "Problem report" (or /wow debug) shows a box
-- of text to copy (Ctrl+A, Ctrl+C) and send to an officer.
local ADDON, ns = ...

function ns.diagnostics()
  local lines = {}
  local function add(k, v) lines[#lines + 1] = k .. ": " .. tostring(v) end
  local _, build, _, interface = (GetBuildInfo and GetBuildInfo()) or nil
  add("addon", ns.addonVersion())
  add("game build", tostring(build) .. " interface " .. tostring(interface) .. " project " .. tostring(WOW_PROJECT_ID))
  add("character", tostring(UnitName and UnitName("player")) .. " level " .. tostring(UnitLevel and UnitLevel("player")))
  add("profession API", (C_TradeSkillUI and C_TradeSkillUI.GetAllRecipeIDs) and "modern" or (GetNumTradeSkills and "classic" or "missing"))
  add("profession window open", ns.prof and ns.prof.professionOpen and ns.prof.professionOpen())
  local s = ns.prof and ns.prof.lastScan
  if s then
    add("last scan", s.error and ("ERROR " .. s.error) or (tostring(s.prof) .. ", " .. tostring(s.recipes) .. " recipes, " .. tostring(s.method)))
  else
    add("last scan", "never")
  end
  add("shopping list", #((ns.db and ns.db.shopping) or {}) .. " recipes")
  add("Auctionator", (Auctionator and Auctionator.API) and "yes" or "no")
  local inbox = WowGuildInbox
  add("guild news", inbox and (tostring(inbox.guild) .. ", generated " .. date("%Y-%m-%d %H:%M", inbox.generatedAt or 0)) or "none (companion not synced yet)")
  add("roster scan", #(((ns.db or {}).roster or {}).members or {}) .. " members")
  add("calls to arms waiting", #((ns.db and ns.db.ctaQueue) or {}))
  if #ns.errors > 0 then
    lines[#lines + 1] = "recent errors:"
    for _, e in ipairs(ns.errors) do lines[#lines + 1] = "  " .. e end
  else
    add("recent errors", "none")
  end
  return table.concat(lines, "\n")
end

local box
local function createBox()
  local f = CreateFrame("Frame", "WowGuildReport", UIParent, "BackdropTemplate")
  f:SetSize(520, 340)
  f:SetPoint("CENTER")
  f:SetFrameStrata("FULLSCREEN_DIALOG")
  f:EnableMouse(true); f:SetMovable(true); f:RegisterForDrag("LeftButton")
  f:SetScript("OnDragStart", f.StartMoving); f:SetScript("OnDragStop", f.StopMovingOrSizing)
  if f.SetBackdrop then
    f:SetBackdrop({ bgFile = "Interface\\Buttons\\WHITE8x8", edgeFile = "Interface\\Buttons\\WHITE8x8", edgeSize = 2 })
    f:SetBackdropColor(0.08, 0.12, 0.11, 0.98)
    f:SetBackdropBorderColor(0.91, 0.64, 0.24, 1)
  end
  tinsert(UISpecialFrames, "WowGuildReport")
  local title = f:CreateFontString(nil, "OVERLAY", "GameFontNormal")
  title:SetPoint("TOPLEFT", 12, -10)
  title:SetText("Problem report: press Ctrl+A, then Ctrl+C, and paste it to your officer")
  local close = CreateFrame("Button", nil, f, "UIPanelCloseButton"); close:SetPoint("TOPRIGHT", -2, -2)
  local scroll = CreateFrame("ScrollFrame", nil, f, "UIPanelScrollFrameTemplate")
  scroll:SetPoint("TOPLEFT", 12, -34); scroll:SetPoint("BOTTOMRIGHT", -32, 12)
  local edit = CreateFrame("EditBox", nil, scroll)
  edit:SetMultiLine(true)
  edit:SetAutoFocus(false)
  edit:SetFontObject(ChatFontNormal or GameFontHighlightSmall)
  edit:SetWidth(470)
  edit:SetScript("OnEscapePressed", function() f:Hide() end)
  -- Read-only: typing puts the report back.
  edit:SetScript("OnTextChanged", function(self, user) if user then self:SetText(f.report or ""); self:HighlightText() end end)
  scroll:SetScrollChild(edit)
  f.edit = edit
  f:Hide()
  return f
end

function ns.showReport()
  box = box or createBox()
  box.report = ns.diagnostics()
  box.edit:SetText(box.report)
  box:Show()
  box.edit:SetFocus()
  box.edit:HighlightText()
  return box
end
