-- wow guild: the main window. Everything the slash commands do, as buttons.
-- Open it from the minimap campfire, the addon list (Retail), a key binding, or /wow.
local ADDON, ns = ...
local W = {}
ns.ui = W

local WIDTH, HEIGHT = 620, 480
local TABS = {
  { key = "camp", label = "Camp" },
  { key = "coach", label = "Coach" },
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

-- Try Blizzard templates first so the window looks like the rest of the game; fall back if a client lacks one.
local function tryFrame(kind, name, parent, ...)
  for _, template in ipairs({ ... }) do
    local ok, f = pcall(CreateFrame, kind, name, parent, template)
    if ok and f then return f, template end
  end
  return CreateFrame(kind, name, parent), nil
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

-- A scrolling list of item rows: icon, quality-coloured name, a right-hand note.
-- Hover shows the real item tooltip; shift-click links the item in chat.
local function itemList(page, top, bottom)
  local scroll = CreateFrame("ScrollFrame", nil, page, "UIPanelScrollFrameTemplate")
  scroll:SetPoint("TOPLEFT", 0, top or 0)
  scroll:SetPoint("BOTTOMRIGHT", -26, bottom or 0)
  local content = CreateFrame("Frame", nil, scroll)
  content:SetSize(WIDTH - 70, 10)
  scroll:SetScrollChild(content)
  local empty = label(content, "", "GameFontDisable"); empty:SetPoint("TOPLEFT", 4, -4); empty:SetWidth(WIDTH - 80)
  local rows = {}
  local function row(i)
    if rows[i] then return rows[i] end
    local r = CreateFrame("Button", nil, content)
    r:SetSize(WIDTH - 74, 22)
    r:SetPoint("TOPLEFT", 0, -(i - 1) * 23)
    r:SetHighlightTexture("Interface\\QuestFrame\\UI-QuestTitleHighlight", "ADD")
    r.icon = r:CreateTexture(nil, "ARTWORK"); r.icon:SetSize(18, 18); r.icon:SetPoint("LEFT", 2, 0)
    r.name = label(r, "", "GameFontHighlight"); r.name:SetPoint("LEFT", 26, 0); r.name:SetWidth(250)
    r.note = label(r, "", "GameFontHighlightSmall"); r.note:SetPoint("RIGHT", -4, 0); r.note:SetJustifyH("RIGHT"); r.note:SetWidth(WIDTH - 360)
    r:SetScript("OnEnter", function(self) ns.items.showTooltip(self, self.itemId) end)
    r:SetScript("OnLeave", function() ns.items.hideTooltip() end)
    r:SetScript("OnClick", function(self) if ns.items.shiftDown() then ns.items.insertLink(self.itemId) end end)
    rows[i] = r
    return r
  end
  return {
    rows = rows,
    set = function(items, emptyText)
      for i, it in ipairs(items) do
        local r = row(i)
        r.itemId = it.id
        r.icon:SetTexture(ns.items.icon(it.id))
        r.name:SetText(it.done and ("|cff40bf40" .. (it.name or "") .. "|r") or ns.items.coloredName(it.id, it.name))
        r.note:SetText(it.note or "")
        r:Show()
      end
      for i = #items + 1, #rows do rows[i]:Hide() end
      empty:SetText(#items == 0 and (emptyText or "") or "")
      content:SetHeight(math.max(10, #items * 23))
    end,
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
  -- Mats needed: icon rows with real item tooltips; scrolls so a long list never runs off the window.
  local matsHead = label(page, "Mats still needed", "GameFontNormal"); matsHead:SetPoint("TOPLEFT", 0, -108 - LIST_ROWS * 26)
  local ahBtn = button(page, "Search auction house", 170); ahBtn:SetPoint("TOPRIGHT", -150, -102 - LIST_ROWS * 26)
  ahBtn:SetScript("OnClick", function() P.searchAuctionHouse() end)
  local listBtn = button(page, "Auctionator list", 140); listBtn:SetPoint("TOPRIGHT", 0, -102 - LIST_ROWS * 26)
  listBtn:SetScript("OnClick", function() P.makeAuctionatorList() end)
  local mats = itemList(page, -130 - LIST_ROWS * 26, 0)
  page.mats, page.ahBtn, page.listBtn = mats, ahBtn, listBtn
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
    local items = {}
    for _, r in ipairs(P.remaining()) do
      local where = {}
      if not r.done and r.alts > 0 then where[#where + 1] = r.alts .. " on alts" end
      if not r.done and r.guildBank > 0 then where[#where + 1] = r.guildBank .. " in guild bank" end
      items[#items + 1] = { id = r.id, name = r.name, done = r.done,
        note = string.format("%s%d / %d|r%s", r.done and "|cff40bf40" or "|cffffffff", math.min(r.have, r.need), r.need,
          #where > 0 and ("  |cffe8a33d" .. table.concat(where, ", ") .. "|r") or "") }
    end
    mats.set(items, #list == 0 and "Empty. Open a profession window and click \"+5 list\" in the skill-up guide to add recipes." or nil)
    local showAH = P.hasAuctionator() and #items > 0
    if showAH then ahBtn:Show(); listBtn:Show() else ahBtn:Hide(); listBtn:Hide() end
  end
end

-- Guild: crafting requests and leveling partners.
-- Coach: a summary here; the full Coach has its own window.
function pages.coach(page)
  local body = scrollText(page, 0, 36)
  local open = button(page, "Open the Coach", 150)
  open:SetPoint("BOTTOMLEFT", 0, 0)
  open:SetScript("OnClick", function() if win then win:Hide() end; ns.coachUI.show() end)
  page.open = open
  page.refresh = function() ns.coach.refresh(); body.set(ns.coach.summary()) end
end

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
  local report = button(page, "Problem report", 150); report:SetPoint("LEFT", blizz, "RIGHT", 10, 0)
  report:SetScript("OnClick", function() ns.showReport() end)
  page.report = report
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

local function setTitle(f, text)
  if f.SetTitle then f:SetTitle(text)
  elseif f.TitleText then f.TitleText:SetText(text)
  elseif f.TitleContainer and f.TitleContainer.TitleText then f.TitleContainer.TitleText:SetText(text)
  elseif f.title then f.title:SetText(text) end
end
W.setTitle = setTitle

local function createWindow()
  local f, template = tryFrame("Frame", "WowGuildWindow", UIParent, "ButtonFrameTemplate", "BackdropTemplate")
  f.native = template == "ButtonFrameTemplate"
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
  tinsert(UISpecialFrames, "WowGuildWindow") -- Escape closes it

  if f.native then
    if ButtonFrameTemplate_HidePortrait then ButtonFrameTemplate_HidePortrait(f) end
    if ButtonFrameTemplate_HideButtonBar then ButtonFrameTemplate_HideButtonBar(f) end
    -- Without a portrait the inner panel can start right under the title bar.
    if f.Inset then
      f.Inset:ClearAllPoints()
      f.Inset:SetPoint("TOPLEFT", 4, -26)
      f.Inset:SetPoint("BOTTOMRIGHT", -6, 4)
    end
  else
    skin(f)
    f.title = label(f, "", "GameFontNormalLarge"); f.title:SetPoint("TOPLEFT", 16, -12)
    local close = CreateFrame("Button", nil, f, "UIPanelCloseButton"); close:SetPoint("TOPRIGHT", -2, -2)
  end
  setTitle(f, "wow guild")

  -- Tabs along the bottom edge, like the character and guild windows.
  f.tabs, f.pages = {}, {}
  local prev
  for i, t in ipairs(TABS) do
    local tab, tabTemplate = tryFrame("Button", "WowGuildWindowTab" .. i, f, "PanelTabButtonTemplate", "CharacterFrameTabButtonTemplate", "UIPanelButtonTemplate")
    tab:SetID(i)
    tab:SetText(t.label)
    if tabTemplate == "UIPanelButtonTemplate" then
      tab:SetSize(110, 24)
      tab:SetPoint("TOPLEFT", f, "TOPLEFT", 14 + (i - 1) * 116, -40)
    else
      if PanelTemplates_TabResize then PanelTemplates_TabResize(tab, 0) end
      if prev then tab:SetPoint("LEFT", prev, "RIGHT", 3, 0) else tab:SetPoint("TOPLEFT", f, "BOTTOMLEFT", 11, 2) end
    end
    f.bottomTabs = tabTemplate ~= "UIPanelButtonTemplate"
    tab:SetScript("OnClick", function() W.show(t.key) end)
    f.tabs[t.key] = tab
    prev = tab
    local page = CreateFrame("Frame", nil, f)
    if f.native and f.Inset then
      page:SetPoint("TOPLEFT", f.Inset, "TOPLEFT", 12, -10)
      page:SetPoint("BOTTOMRIGHT", f.Inset, "BOTTOMRIGHT", -8, 8)
    else
      page:SetPoint("TOPLEFT", 18, f.bottomTabs and -34 or -78)
      page:SetPoint("BOTTOMRIGHT", -14, f.bottomTabs and 12 or 14)
    end
    pages[t.key](page)
    page:Hide()
    f.pages[t.key] = page
  end
  if PanelTemplates_SetNumTabs then PanelTemplates_SetNumTabs(f, #TABS) end

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
  for i, t in ipairs(TABS) do
    local page, tab = f.pages[t.key], f.tabs[t.key]
    if t.key == key then page:Show() else page:Hide() end
    if t.key == key and PanelTemplates_SetTab and f.bottomTabs then PanelTemplates_SetTab(f, i) end
    if not f.bottomTabs and tab.LockHighlight then if t.key == key then tab:LockHighlight() else tab:UnlockHighlight() end end
  end
  setTitle(f, "wow guild" .. ((WowGuildInbox and WowGuildInbox.guild) and ("  |cff999999" .. WowGuildInbox.guild .. "|r") or ""))
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

-- If another addon provides LibDataBroker / LibDBIcon (Titan Panel, ElvUI, Bazooka, minimap button bags…),
-- use them: the button then behaves like every other addon's and minimap addons can manage it.
local ldbObject, dbicon
local function setupBroker()
  if ldbObject or not LibStub then return end
  local ldb = LibStub("LibDataBroker-1.1", true)
  if not ldb then return end
  ldbObject = ldb:NewDataObject("wow guild", {
    type = "launcher", label = "wow guild", icon = "Interface\\Icons\\Spell_Fire_Fire",
    OnClick = function(_, which) if which == "RightButton" then W.show("settings") else W.toggle() end end,
    OnTooltipShow = function(tt)
      tt:AddLine("wow guild")
      tt:AddLine("Click: open the guild window", 1, 1, 1)
      tt:AddLine("Right-click: settings", 1, 1, 1)
    end,
  })
  dbicon = LibStub("LibDBIcon-1.0", true)
  if dbicon then
    ns.db.ui = ns.db.ui or {}
    ns.db.ui.dbicon = ns.db.ui.dbicon or {}
    dbicon:Register("wow guild", ldbObject, ns.db.ui.dbicon)
  end
end
ns.broker = function() return ldbObject, dbicon end

function ns.applyOptions()
  setupBroker()
  if dbicon then
    ns.db.ui.dbicon.hide = not ns.opt("minimapButton")
    if ns.opt("minimapButton") then dbicon:Show("wow guild") else dbicon:Hide("wow guild") end
    if mini then mini:Hide() end
  elseif Minimap then
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
BINDING_NAME_WOWGUILD_COACH = "Open or close the Coach"
