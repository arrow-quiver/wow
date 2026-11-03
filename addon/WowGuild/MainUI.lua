-- wow guild: the main window. Everything the slash commands do, as buttons.
-- Open it from the minimap campfire, the addon list (Retail), a key binding, or /wow.
local ADDON, ns = ...
local W = {}
ns.ui = W

local WIDTH, HEIGHT = 620, 480
local TABS = {
  { key = "camp", label = "Camp" },
  { key = "cta", label = "Call to arms" },
  { key = "prof", label = "Professions" },
  { key = "guild", label = "Guild" },
  { key = "settings", label = "Settings" },
}
local LIST_ROWS = 6

local function skin(f, alpha)
  if f.SetBackdrop then
    f:SetBackdrop({ bgFile = "Interface\\Buttons\\WHITE8x8", edgeFile = "Interface\\Buttons\\WHITE8x8", edgeSize = 2 })
    f:SetBackdropColor(0.12, 0.23, 0.2, alpha or 0.97)
    f:SetBackdropBorderColor(0.91, 0.64, 0.24, 1)
  end
end

local function button(parent, text, width)
  local b = CreateFrame("Button", nil, parent, "UIPanelButtonTemplate")
  b:SetSize(width or 120, 24)
  b:SetText(text)
  return b
end

local function label(parent, text, font)
  local fs = parent:CreateFontString(nil, "OVERLAY", font or "GameFontHighlight")
  fs:SetJustifyH("LEFT")
  if text then fs:SetText(text) end
  return fs
end

local function editbox(parent, width, numeric)
  local e = CreateFrame("EditBox", nil, parent, "InputBoxTemplate")
  e:SetSize(width, 24)
  e:SetAutoFocus(false)
  if numeric then e:SetNumeric(true); e:SetMaxLetters(2) else e:SetMaxLetters(200) end
  e:SetScript("OnEscapePressed", e.ClearFocus)
  e:SetScript("OnEnterPressed", e.ClearFocus)
  return e
end

-- A scrolling block of text inside a page.
local function scrollText(page, top, bottom)
  local scroll = CreateFrame("ScrollFrame", nil, page, "UIPanelScrollFrameTemplate")
  scroll:SetPoint("TOPLEFT", 0, top or 0)
  scroll:SetPoint("BOTTOMRIGHT", -26, bottom or 0)
  local content = CreateFrame("Frame", nil, scroll)
  content:SetSize(WIDTH - 70, 10)
  scroll:SetScrollChild(content)
  local text = label(content, nil, "GameFontHighlight")
  text:SetPoint("TOPLEFT")
  text:SetWidth(WIDTH - 70)
  text:SetSpacing(3)
  return {
    set = function(s)
      text:SetText(s)
      content:SetHeight((text:GetStringHeight() or 0) + 10)
    end,
    text = text,
  }
end

-- ---------- pages ----------
local pages = {}

-- Camp: raids, notices, sync status.
function pages.camp(page)
  local body = scrollText(page, 0, 36)
  local sync = button(page, "Sync now", 110)
  sync:SetPoint("BOTTOMLEFT", 0, 0)
  sync:SetScript("OnClick", function()
    ns.collectAll("button")
    StaticPopup_Show("WOWGUILD_RELOAD_NOW")
  end)
  local hint = label(page, "Saves everything and reloads so the companion uploads it.", "GameFontDisableSmall")
  hint:SetPoint("LEFT", sync, "RIGHT", 10, 0)
  page.sync = sync
  page.refresh = function()
    local inbox = WowGuildInbox
    local me = ns.db.characters[ns.charKey()] or {}
    local status = {}
    status[#status + 1] = "|cffe8a33d" .. ((inbox and inbox.guild) or "Guild") .. "|r"
    if inbox then
      status[#status + 1] = "|cff999999News from the guild site " .. ns.ago(inbox.generatedAt) .. ".|r"
    else
      status[#status + 1] = "|cffe8a33dNo news from the guild site yet.|r Install the companion from the site's downloads page and keep it running while you play."
    end
    local recipes, profs = 0, 0
    for _, list in pairs(me.recipes or {}) do recipes = recipes + #list end
    profs = me.professions and #me.professions or 0
    status[#status + 1] = string.format("|cff999999This character: %d professions, %d recipes saved. %d guild members on the last roster scan.|r",
      profs, recipes, #((ns.db.roster or {}).members or {}))
    body.set(table.concat(status, "\n") .. "\n\n" .. ns.textRaids() .. "\n\n" .. ns.textNotices())
  end
end

-- Call to arms: a form instead of /wow cta.
function pages.cta(page)
  local intro = label(page, "Call guildies to a fight. It posts to the guild's Discord as soon as you reload (the button below does that for you).", "GameFontHighlight")
  intro:SetPoint("TOPLEFT", 0, 0); intro:SetWidth(WIDTH - 40)

  local zl = label(page, "Where", "GameFontNormal"); zl:SetPoint("TOPLEFT", 0, -44)
  local zone = editbox(page, 260); zone:SetPoint("TOPLEFT", 6, -62)
  local here = button(page, "Use my zone", 110); here:SetPoint("LEFT", zone, "RIGHT", 10, 0)
  here:SetScript("OnClick", function() zone:SetText(GetZoneText and GetZoneText() or "") end)

  local nl = label(page, "How many do you need", "GameFontNormal"); nl:SetPoint("TOPLEFT", 0, -98)
  local needed = editbox(page, 50, true); needed:SetPoint("TOPLEFT", 6, -116)
  needed:SetText("5")

  local ml = label(page, "What's happening", "GameFontNormal"); ml:SetPoint("TOPLEFT", 0, -152)
  local msg = editbox(page, WIDTH - 60); msg:SetPoint("TOPLEFT", 6, -170)

  local send = button(page, "Sound the horn", 150); send:SetPoint("TOPLEFT", 0, -210)
  local sent = label(page, "", "GameFontHighlightSmall"); sent:SetPoint("TOPLEFT", 0, -244); sent:SetWidth(WIDTH - 40)
  send:SetScript("OnClick", function()
    ns.addCta(zone:GetText() or "", tonumber(needed:GetText() or ""), msg:GetText() or "")
    msg:SetText("")
    page.refresh()
  end)
  page.zone, page.needed, page.msg, page.send = zone, needed, msg, send
  page.refresh = function()
    if (zone:GetText() or "") == "" and GetZoneText then zone:SetText(GetZoneText() or "") end
    local q = ns.db.ctaQueue or {}
    if #q == 0 then sent:SetText("") return end
    local lines = { "|cffffd100Waiting to send|r (they go out on your next reload or logout):" }
    for i = #q, math.max(1, #q - 4), -1 do
      local c = q[i]
      lines[#lines + 1] = string.format("  %s%s %s |cff999999%s|r", c.zone, c.needed and (" (need " .. c.needed .. ")") or "", c.msg or "", ns.ago(c.at))
    end
    sent:SetText(table.concat(lines, "\n"))
  end
end

-- Professions: guide, tracker, shopping list with per-recipe controls.
function pages.prof(page)
  local P = ns.prof
  local summary = label(page, "", "GameFontHighlight"); summary:SetPoint("TOPLEFT", 0, 0); summary:SetWidth(WIDTH - 40)

  local guideBtn = button(page, "Skill-up guide", 140); guideBtn:SetPoint("TOPLEFT", 0, -46)
  guideBtn:SetScript("OnClick", function() P.toggleGuide(); page.refresh() end)
  local trackBtn = button(page, "Show shopping list", 160); trackBtn:SetPoint("LEFT", guideBtn, "RIGHT", 8, 0)
  trackBtn:SetScript("OnClick", function() P.toggleTracker(); page.refresh() end)
  local clearBtn = button(page, "Clear list", 100); clearBtn:SetPoint("LEFT", trackBtn, "RIGHT", 8, 0)
  clearBtn:SetScript("OnClick", function() StaticPopup_Show("WOWGUILD_CLEAR_LIST") end)

  local head = label(page, "Shopping list", "GameFontNormal"); head:SetPoint("TOPLEFT", 0, -84)
  page.rows = {}
  for i = 1, LIST_ROWS do
    local row = CreateFrame("Frame", nil, page)
    row:SetSize(WIDTH - 40, 24)
    row:SetPoint("TOPLEFT", 0, -102 - (i - 1) * 26)
    row.text = label(row, "", "GameFontHighlight"); row.text:SetPoint("LEFT", 0, 0); row.text:SetWidth(330)
    row.minus = button(row, "-1", 34); row.minus:SetPoint("RIGHT", -150, 0)
    row.plus = button(row, "+1", 34); row.plus:SetPoint("RIGHT", -110, 0)
    row.remove = button(row, "Remove", 90); row.remove:SetPoint("RIGHT", 0, 0)
    row.minus:SetScript("OnClick", function(self) P.removeFromList(self:GetParent().key, -1) end)
    row.plus:SetScript("OnClick", function(self) P.removeFromList(self:GetParent().key, 1) end)
    row.remove:SetScript("OnClick", function(self) P.removeFromList(self:GetParent().key) end)
    page.rows[i] = row
  end
  -- Mats needed: scrolls, so a long list never runs off the window.
  local mats = scrollText(page, -110 - LIST_ROWS * 26, 0)
  page.trackBtn, page.guideBtn = trackBtn, guideBtn

  page.refresh = function()
    local me = ns.db.characters[ns.charKey()] or {}
    local parts = {}
    for _, p in ipairs(me.professions or {}) do parts[#parts + 1] = string.format("%s %s/%s", p.name, tostring(p.skill or "?"), tostring(p.max or "?")) end
    summary:SetText(#parts > 0 and ("Your professions: " .. table.concat(parts, ",  ")) or "No professions saved yet. Open each profession window once.")
    trackBtn:SetText(P.trackerShown() and "Hide shopping list" or "Show shopping list")
    guideBtn:SetText(P.guideShown() and "Hide skill-up guide" or "Skill-up guide")
    local list = P.list()
    for i, row in ipairs(page.rows) do
      local e = list[i]
      if e then
        row.key = e.key
        row.text:SetText(string.format("%d × %s%s", e.qty, e.name, e.prof and ("  |cff999999" .. e.prof .. "|r") or ""))
        row:Show()
      else
        row.key = nil
        row:Hide()
      end
    end
    if #list == 0 then
      mats.set("|cff999999Empty. Open a profession window and click \"+5 list\" in the skill-up guide to add recipes.|r")
    else
      local more = #list > LIST_ROWS and string.format("|cff999999and %d more recipes|r\n", #list - LIST_ROWS) or ""
      mats.set(more .. P.trackerText())
    end
  end
end

-- Guild: crafting requests and leveling partners.
function pages.guild(page)
  local body = scrollText(page, 0, 0)
  page.refresh = function() body.set(ns.textGuild()) end
end

-- Settings: every option, the site address, versions.
function pages.settings(page)
  page.boxes = {}
  for i, o in ipairs(ns.OPTION_LIST or {}) do
    local cb = CreateFrame("CheckButton", nil, page, "UICheckButtonTemplate")
    cb:SetPoint("TOPLEFT", 0, -(i - 1) * 28)
    local l = label(cb, o.label, "GameFontHighlight"); l:SetPoint("LEFT", cb, "RIGHT", 4, 1)
    cb.key = o.key
    cb:SetScript("OnClick", function(self)
      ns.db.options = ns.db.options or {}
      ns.db.options[self.key] = self:GetChecked() and true or false
      ns.applyOptions()
    end)
    page.boxes[i] = cb
  end
  local y = -(#(ns.OPTION_LIST or {})) * 28 - 16
  local sl = label(page, "Guild site (click, then Ctrl+C to copy):", "GameFontNormal"); sl:SetPoint("TOPLEFT", 0, y)
  local site = editbox(page, WIDTH - 60); site:SetPoint("TOPLEFT", 6, y - 18)
  site:SetScript("OnEditFocusGained", function(self) self:HighlightText() end)
  site:SetScript("OnTextChanged", function(self, user) if user then self:SetText(self.value or "") ; self:HighlightText() end end)
  local ver = label(page, "", "GameFontDisableSmall"); ver:SetPoint("TOPLEFT", 0, y - 52)
  local blizz = button(page, "Key binding and more", 170); blizz:SetPoint("TOPLEFT", 0, y - 80)
  blizz:SetScript("OnClick", function() ns.openOptions() end)
  page.site = site
  page.refresh = function()
    for _, cb in ipairs(page.boxes) do cb:SetChecked(ns.opt(cb.key) and true or false) end
    local inbox = WowGuildInbox
    site.value = (inbox and inbox.site) and (inbox.site .. "/get") or "Not known yet: sync once with the companion."
    site:SetText(site.value)
    local latest = inbox and inbox.latestAddon
    ver:SetText("Addon version " .. ns.addonVersion() .. ((latest and ns.versionLess(ns.addonVersion(), latest)) and ("  |cffe8a33d(" .. latest .. " is available)|r") or ""))
  end
end

-- ---------- window ----------
local win

local function createWindow()
  local f = CreateFrame("Frame", "WowGuildWindow", UIParent, "BackdropTemplate")
  f:SetSize(WIDTH, HEIGHT)
  f:SetFrameStrata("DIALOG")
  f:SetMovable(true); f:EnableMouse(true); f:RegisterForDrag("LeftButton"); f:SetClampedToScreen(true)
  f:SetScript("OnDragStart", f.StartMoving)
  f:SetScript("OnDragStop", function(self)
    self:StopMovingOrSizing()
    local point, _, rel, x, y = self:GetPoint()
    ns.db.ui = ns.db.ui or {}
    ns.db.ui.windowPos = { point = point, rel = rel, x = x, y = y }
  end)
  skin(f)
  tinsert(UISpecialFrames, "WowGuildWindow") -- Escape closes it

  local title = label(f, "wow guild", "GameFontNormalLarge"); title:SetPoint("TOPLEFT", 16, -12)
  f.title = title
  local close = CreateFrame("Button", nil, f, "UIPanelCloseButton"); close:SetPoint("TOPRIGHT", -2, -2)

  f.tabs, f.pages = {}, {}
  local x = 14
  for i, t in ipairs(TABS) do
    local tab = button(f, t.label, 110)
    tab:SetPoint("TOPLEFT", x, -40)
    x = x + 116
    tab:SetScript("OnClick", function() W.show(t.key) end)
    f.tabs[t.key] = tab
    local page = CreateFrame("Frame", nil, f)
    page:SetPoint("TOPLEFT", 18, -78)
    page:SetPoint("BOTTOMRIGHT", -14, 14)
    pages[t.key](page)
    page:Hide()
    f.pages[t.key] = page
  end

  local pos = ns.db.ui and ns.db.ui.windowPos
  if pos then f:SetPoint(pos.point or "CENTER", UIParent, pos.rel or "CENTER", pos.x or 0, pos.y or 0) else f:SetPoint("CENTER") end
  f:Hide()
  return f
end

function W.window()
  win = win or createWindow()
  return win
end

function W.show(key)
  local f = W.window()
  key = key or W.current or "camp"
  W.current = key
  for k, page in pairs(f.pages) do
    if k == key then page:Show() else page:Hide() end
    local tab = f.tabs[k]
    if tab.LockHighlight then if k == key then tab:LockHighlight() else tab:UnlockHighlight() end end
  end
  f.title:SetText("wow guild  |cff999999" .. ((WowGuildInbox and WowGuildInbox.guild) or "") .. "|r")
  f:Show()
  f.pages[key].refresh()
end

function W.toggle()
  local f = W.window()
  if f:IsShown() then f:Hide() else W.show() end
end

function W.refreshIfShown()
  if win and win:IsShown() and W.current then win.pages[W.current].refresh() end
end

StaticPopupDialogs["WOWGUILD_CLEAR_LIST"] = {
  text = "Empty your shopping list?",
  button1 = "Empty it",
  button2 = "Keep it",
  OnAccept = function() ns.prof.clearList() end,
  timeout = 0, whileDead = true, hideOnEscape = true, preferredIndex = 3,
}

-- ---------- minimap button ----------
local mini
local function placeMini()
  local angle = math.rad((ns.db.ui and ns.db.ui.minimapAngle) or 200)
  local r = ((Minimap.GetWidth and Minimap:GetWidth() or 140) / 2) + 6
  mini:ClearAllPoints()
  mini:SetPoint("CENTER", Minimap, "CENTER", math.cos(angle) * r, math.sin(angle) * r)
end

local function createMini()
  local b = CreateFrame("Button", "WowGuildMinimapButton", Minimap)
  b:SetSize(31, 31)
  b:SetFrameStrata("MEDIUM")
  b:SetFrameLevel(8)
  b:RegisterForClicks("LeftButtonUp", "RightButtonUp")
  b:RegisterForDrag("LeftButton")
  local icon = b:CreateTexture(nil, "BACKGROUND")
  icon:SetTexture("Interface\\Icons\\Spell_Fire_Fire")
  icon:SetSize(20, 20)
  icon:SetPoint("CENTER", 0, 1)
  local border = b:CreateTexture(nil, "OVERLAY")
  border:SetTexture("Interface\\Minimap\\MiniMap-TrackingBorder")
  border:SetSize(53, 53)
  border:SetPoint("TOPLEFT")
  b:SetHighlightTexture("Interface\\Minimap\\UI-Minimap-ZoomButton-Highlight")
  b:SetScript("OnClick", function(_, which)
    if which == "RightButton" then W.show("settings") else W.toggle() end
  end)
  b:SetScript("OnDragStart", function(self)
    self:SetScript("OnUpdate", function()
      local mx, my = Minimap:GetCenter()
      local px, py = GetCursorPosition()
      local scale = Minimap:GetEffectiveScale()
      local atan2 = math.atan2 or math.atan
      ns.db.ui = ns.db.ui or {}
      ns.db.ui.minimapAngle = math.deg(atan2(py / scale - my, px / scale - mx))
      placeMini()
    end)
  end)
  b:SetScript("OnDragStop", function(self) self:SetScript("OnUpdate", nil) end)
  b:SetScript("OnEnter", function(self)
    if not GameTooltip then return end
    GameTooltip:SetOwner(self, "ANCHOR_LEFT")
    GameTooltip:AddLine("wow guild")
    GameTooltip:AddLine("Click: open the guild window", 1, 1, 1)
    GameTooltip:AddLine("Right-click: settings", 1, 1, 1)
    GameTooltip:AddLine("Drag: move this button", 0.6, 0.6, 0.6)
    GameTooltip:Show()
  end)
  b:SetScript("OnLeave", function() if GameTooltip then GameTooltip:Hide() end end)
  return b
end

function ns.applyOptions()
  if Minimap then
    if ns.opt("minimapButton") then
      mini = mini or createMini()
      placeMini()
      mini:Show()
    elseif mini then
      mini:Hide()
    end
  end
  W.refreshIfShown()
end
ns.minimapButton = function() return mini end

ns.on("PLAYER_LOGIN", function() ns.applyOptions() end)

-- Retail's addon drawer (AddonCompartmentFunc in the .toc) and the key binding (Bindings.xml).
function WowGuild_OnAddonCompartmentClick() W.toggle() end
function WowGuild_Toggle() W.toggle() end
BINDING_HEADER_WOWGUILD = "wow guild"
BINDING_NAME_WOWGUILD_TOGGLE = "Open or close the guild window"
