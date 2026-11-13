-- Warband Codex: the window. A header with one search box for everything, a sidebar of tabs you can reorder and
-- hide per character, and a content area where each module draws its page. Opens with /codex, the minimap button,
-- the addon drawer or a key binding. Movable, resizable, scalable; Escape closes it.
local ADDON, ns = ...
local U = ns.ui
local S = {}
ns.shell = S

local W, H, SIDE, HEAD = 960, 640, 196, 58
local MIN_W, MIN_H = 820, 520
local win

ns.option{ key = "minimap", label = "Minimap button", desc = "A button on the minimap that opens the Codex. Drag it around the edge.", group = "Window", default = true,
  onChange = function() if S.minimapButton then if ns.opt("minimap") then S.minimapButton:Show() else S.minimapButton:Hide() end end end }
ns.option{ key = "openHome", label = "Always open on Home", desc = "Open on the Home tab instead of the tab you last used.", group = "Window", default = false }

-- ---------- which tabs, in which order (per character) ----------
local function layout()
  local c = ns.char()
  local ui = ns.ensure(c, "ui")
  ns.ensure(ui, "hidden")
  if type(ui.order) ~= "table" then ui.order = {} end
  return ui
end
-- Every module in this character's order; new modules go to the end.
function S.allTabs()
  local ui = layout()
  local seen, out = {}, {}
  for _, id in ipairs(ui.order) do
    if ns.modules[id] and not seen[id] then seen[id] = true; out[#out + 1] = ns.modules[id] end
  end
  for _, m in ipairs(ns.moduleList) do if not seen[m.id] then out[#out + 1] = m end end
  return out
end
function S.tabs()
  local ui, out = layout(), {}
  for _, m in ipairs(S.allTabs()) do
    local usable = not m.available or m.available()
    if usable and (m.pinned or not ui.hidden[m.id]) then out[#out + 1] = m end
  end
  return out
end
function S.moveTab(id, by)
  local ui, ids = layout(), {}
  for _, m in ipairs(S.allTabs()) do ids[#ids + 1] = m.id end
  for i, x in ipairs(ids) do
    if x == id then
      local j = math.max(1, math.min(#ids, i + by))
      table.remove(ids, i)
      table.insert(ids, j, id)
      break
    end
  end
  ui.order = ids
  S.rebuildSidebar()
end
function S.setHidden(id, hidden)
  local m = ns.modules[id]
  if not m or m.pinned then return end
  layout().hidden[id] = hidden and true or nil
  S.rebuildSidebar()
end

-- ---------- building the window ----------
local function buildSidebarButton(parent)
  local b = CreateFrame("Button", nil, parent)
  b:SetSize(SIDE - 16, 34)
  b.wash = U.tex(b, "BACKGROUND", 1, 1, 1, 0); b.wash:SetAllPoints()
  b.icon = U.icon(b, 22); b.icon:SetPoint("LEFT", 10, 0)
  b.label = U.text(b, "sub", "", "dim"); b.label:SetPoint("LEFT", 42, 0)
  b.badge = U.text(b, "small", "", "accent"); b.badge:SetPoint("RIGHT", -8, 0); b.badge:SetJustifyH("RIGHT")
  b:SetScript("OnEnter", function(self)
    if self.id ~= S.current then local r, g, bl = U.c("accent"); U.color(self.wash, r, g, bl, 0.08) end
  end)
  b:SetScript("OnLeave", function(self) if self.id ~= S.current then U.color(self.wash, 1, 1, 1, 0) end end)
  b:SetScript("OnClick", function(self) ns.safely(S.open, self.id) end)
  return b
end

local function create()
  local f = CreateFrame("Frame", "WarbandCodexWindow", UIParent)
  win = f
  f:SetSize(W, H)
  f:SetPoint("CENTER", 0, 20)
  f:SetFrameStrata("HIGH")
  f:SetMovable(true); f:EnableMouse(true); f:SetClampedToScreen(true)
  f:RegisterForDrag("LeftButton")
  f:SetScript("OnDragStart", f.StartMoving)
  f:SetScript("OnDragStop", function(self) self:StopMovingOrSizing(); S.savePlace() end)
  if f.SetResizable then f:SetResizable(true) end
  if f.SetResizeBounds then pcall(f.SetResizeBounds, f, MIN_W, MIN_H, 1500, 1000)
  elseif f.SetMinResize then pcall(f.SetMinResize, f, MIN_W, MIN_H) end
  if type(UISpecialFrames) == "table" then table.insert(UISpecialFrames, "WarbandCodexWindow") end

  -- Backdrop: a vertical gradient, a soft accent glow behind the header, hairline frame.
  f.bg = U.tex(f, "BACKGROUND", 1, 1, 1, 1); f.bg:SetAllPoints()
  f.glow = U.tex(f, "BACKGROUND", 1, 1, 1, 1); f.glow:SetPoint("TOPLEFT"); f.glow:SetPoint("TOPRIGHT"); f.glow:SetHeight(140)
  U.themed(function()
    local r1, g1, b1 = U.c("bg"); local r2, g2, b2 = U.c("bg2")
    U.color(f.bg, 1, 1, 1, 1); U.gradient(f.bg, "VERTICAL", r1, g1, b1, 0.985, r2, g2, b2, 0.985)
    local ar, ag, ab = U.c("accent2")
    U.color(f.glow, 1, 1, 1, 1); U.gradient(f.glow, "VERTICAL", ar, ag, ab, 0, ar, ag, ab, 0.22)
  end)
  U.border(f, "line", 0.4)

  -- Header.
  local head = CreateFrame("Frame", nil, f)
  head:SetPoint("TOPLEFT"); head:SetPoint("TOPRIGHT"); head:SetHeight(HEAD)
  f.head = head
  f.logo = U.icon(head, 30, "Interface\\Icons\\INV_Misc_Book_09"); f.logo:SetPoint("LEFT", 16, 0)
  f.title = U.text(head, "title", ns.NAME, "line"); f.title:SetPoint("LEFT", 56, 1)
  f.rule = U.fill(head, "line", 0.25, "ARTWORK"); f.rule:SetPoint("BOTTOMLEFT", 0, 0); f.rule:SetPoint("BOTTOMRIGHT", 0, 0); f.rule:SetHeight(1)
  -- A highlight that drifts along the header rule.
  f.shine = U.tex(head, "OVERLAY", 1, 1, 1, 1); f.shine:SetSize(160, 1); f.shine:SetPoint("BOTTOMLEFT", 0, 0)
  U.themed(function() local r, g, b = U.c("accent"); U.color(f.shine, 1, 1, 1, 1); U.gradient(f.shine, "HORIZONTAL", r, g, b, 0, r, g, b, 0.9) end)
  local drift = 0
  head:SetScript("OnUpdate", function(_, elapsed)
    if not ns.opt("animations") then return end
    drift = (drift + (elapsed or 0) * 90) % ((tonumber(f:GetWidth()) or W) + 160)
    f.shine:ClearAllPoints(); f.shine:SetPoint("BOTTOMLEFT", drift - 160, 0)
  end)

  f.close = U.button(head, "×", function() S.hide() end, { w = 26, h = 26 })
  f.close:SetPoint("RIGHT", -14, 0)
  f.close.tip = "Close (Escape)"

  f.search = U.edit(head, 300, "Search items, bosses, recipes, players, settings ...", function(text) S.search(text) end, function() S.pickResult(1) end)
  f.search:SetPoint("RIGHT", -52, 0)
  f.search:SetHeight(26)

  -- Sidebar.
  local side = CreateFrame("Frame", nil, f)
  side:SetPoint("TOPLEFT", 0, -HEAD); side:SetPoint("BOTTOMLEFT", 0, 0); side:SetWidth(SIDE)
  side.bg = U.fill(side, "bg", 0.55); side.bg:SetAllPoints()
  side.edge = U.fill(side, "line", 0.12, "ARTWORK"); side.edge:SetPoint("TOPRIGHT"); side.edge:SetPoint("BOTTOMRIGHT"); side.edge:SetWidth(1)
  side.marker = U.fill(side, "accent", 1, "OVERLAY"); side.marker:SetSize(3, 26); side.marker:SetPoint("TOPLEFT", 0, -12)
  side.buttons = {}
  f.side = side
  f.who = U.text(side, "small", "", "dim"); f.who:SetPoint("BOTTOMLEFT", 14, 12); f.who:SetWidth(SIDE - 24)

  -- Content.
  local host = CreateFrame("Frame", nil, f)
  host:SetPoint("TOPLEFT", SIDE, -HEAD); host:SetPoint("BOTTOMRIGHT", 0, 0)
  f.host = host
  f.pages = {}

  -- Search results, over the content.
  local res = CreateFrame("Frame", nil, f)
  res:SetFrameStrata("DIALOG")
  res:SetPoint("TOPRIGHT", f.search, "BOTTOMRIGHT", 0, -4); res:SetSize(380, 12 * 30 + 34)
  res.bg = U.fill(res, "panel", 0.985); res.bg:SetAllPoints()
  U.border(res, "accent", 0.5)
  res.head = U.text(res, "small", "", "dim"); res.head:SetPoint("TOPLEFT", 10, -8)
  res.list = U.list(res, 30, function(list, i)
    local r = U.row(list, i, function(_, item) S.go(item) end)
    r.icon = U.icon(r, 22); r.icon:SetPoint("LEFT", 8, 0)
    r.label = U.text(r, "body", "", "text"); r.label:SetPoint("TOPLEFT", 38, -3); r.label:SetWidth(320)
    r.sub = U.text(r, "small", "", "dim"); r.sub:SetPoint("TOPLEFT", 38, -16); r.sub:SetWidth(320)
    return r
  end, function(r, item)
    r.icon.set(item.icon); r.label:SetText(item.label or ""); r.sub:SetText(item.sub or "")
  end, 12)
  res.list:SetPoint("TOPLEFT", 4, -26); res.list:SetPoint("BOTTOMRIGHT", -4, 4)
  res:Hide()
  f.results = res

  -- Resize grip.
  local grip = CreateFrame("Button", nil, f)
  grip:SetSize(16, 16); grip:SetPoint("BOTTOMRIGHT", -2, 2)
  grip.a = U.fill(grip, "line", 0.5, "OVERLAY"); grip.a:SetSize(12, 1); grip.a:SetPoint("BOTTOMRIGHT", 0, 3)
  grip.b = U.fill(grip, "line", 0.5, "OVERLAY"); grip.b:SetSize(1, 12); grip.b:SetPoint("BOTTOMRIGHT", -3, 0)
  grip:SetScript("OnMouseDown", function() if f.StartSizing then f:StartSizing("BOTTOMRIGHT") end end)
  grip:SetScript("OnMouseUp", function() f:StopMovingOrSizing(); S.savePlace() end)
  f.grip = grip

  f:Hide()
  S.restorePlace()
  S.rebuildSidebar()
  return f
end

function S.window() return win or create() end

-- ---------- place, size and scale ----------
function S.savePlace()
  if not win then return end
  local ui = layout()
  local w, h = tonumber(win:GetWidth()), tonumber(win:GetHeight())
  if w and h then ui.w, ui.h = math.floor(w), math.floor(h) end
  local point, _, rel, x, y = win:GetPoint()
  if point and x then ui.point, ui.rel, ui.x, ui.y = point, rel or point, math.floor(x), math.floor(y) end
end
function S.restorePlace()
  if not win then return end
  local ui = layout()
  if ui.w and ui.h then win:SetSize(math.max(MIN_W, ui.w), math.max(MIN_H, ui.h)) end
  if ui.point and ui.x then win:ClearAllPoints(); win:SetPoint(ui.point, UIParent, ui.rel or ui.point, ui.x, ui.y) end
  S.applyScale()
end
function S.applyScale()
  if not win or not win.SetScale then return end
  local s = tonumber(ns.db and ns.db.opts.scale) or 1
  win:SetScale(math.max(0.7, math.min(1.4, s)))
end
function S.resetPlace()
  local ui = layout()
  ui.w, ui.h, ui.point, ui.rel, ui.x, ui.y = nil, nil, nil, nil, nil, nil
  ns.db.opts.scale = 1
  if win then win:SetSize(W, H); win:ClearAllPoints(); win:SetPoint("CENTER", 0, 20); S.applyScale() end
end

-- ---------- sidebar ----------
function S.rebuildSidebar()
  if not win then return end
  local side, tabs = win.side, S.tabs()
  for i, m in ipairs(tabs) do
    local b = side.buttons[i] or buildSidebarButton(side)
    side.buttons[i] = b
    b.id = m.id
    b.icon.set("Interface\\Icons\\" .. (m.icon or "INV_Misc_QuestionMark"))
    b.label:SetText(m.title)
    b:ClearAllPoints(); b:SetPoint("TOPLEFT", 8, -8 - (i - 1) * 36)
    b:Show()
  end
  for i = #tabs + 1, #side.buttons do side.buttons[i]:Hide() end
  win.who:SetText(string.format("%s  ·  level %d", ns.me(), ns.level()))
  S.mark(false)
end
-- Highlight the current tab; the marker glides to it.
function S.mark(animate)
  if not win then return end
  local side = win.side
  local target
  for i, b in ipairs(side.buttons) do
    local on = b:IsShown() and b.id == S.current
    local r, g, bl = U.c("accent")
    U.color(b.wash, r, g, bl, on and 0.14 or 0)
    b.label:SetTextColor(U.c(on and "text" or "dim"))
    if on then target = i end
    local m = ns.modules[b.id]
    local badge = m and m.badge and ns.safely(m.badge)
    b.badge:SetText(badge and tostring(badge) or "")
  end
  if not target then side.marker:Hide() return end
  side.marker:Show()
  local to = -12 - (target - 1) * 36
  local from = side.markerY or to
  side.markerY = to
  U.tween(side, animate and 0.22 or 0, function(p)
    side.marker:ClearAllPoints(); side.marker:SetPoint("TOPLEFT", 0, from + (to - from) * p)
  end, "marker")
end
function S.refreshBadges() if win and win:IsShown() then S.mark(false) end end

-- ---------- pages ----------
local function buildPage(m)
  local page = CreateFrame("Frame", nil, win.host)
  page:SetAllPoints()
  page.title = U.text(page, "title", m.title, "text"); page.title:SetPoint("TOPLEFT", 24, -18)
  page.sub = U.text(page, "body", m.blurb or "", "dim"); page.sub:SetPoint("TOPLEFT", 26, -48)
  page.body = CreateFrame("Frame", nil, page)
  page.body:SetPoint("TOPLEFT", 24, -74); page.body:SetPoint("BOTTOMRIGHT", -24, 20)
  page.module = m
  if m.build then
    local ok, err = pcall(m.build, page.body, page)
    if not ok then
      ns.reportError(err)
      local t = U.text(page.body, "body", "This tab hit an error and couldn't be drawn. /codex still works for the others.", "bad")
      t:SetPoint("TOPLEFT")
    end
  end
  page:Hide()
  return page
end

function S.open(id)
  local m = ns.modules[id]
  if not m or (m.available and not m.available()) then m = ns.modules.home or ns.moduleList[1] end
  if not m then return end
  S.window()
  local first = not win:IsShown()
  local page = win.pages[m.id]
  if not page then page = buildPage(m); win.pages[m.id] = page end
  for pid, p in pairs(win.pages) do if pid ~= m.id then p:Hide() end end
  S.current = m.id
  layout().last = m.id
  win.results:Hide()
  page:Show()
  if m.refresh then ns.safely(m.refresh, page.body, page) end
  if first then
    win:Show()
    if PlaySound and SOUNDKIT and SOUNDKIT.IG_MAINMENU_OPEN then pcall(PlaySound, SOUNDKIT.IG_MAINMENU_OPEN) end
    U.tween(win, 0.24, function(p) if win.SetAlpha then win:SetAlpha(p) end end, "open")
  end
  -- The page slides up a little as it fades in.
  U.tween(page, 0.2, function(p)
    if page.SetAlpha then page:SetAlpha(p) end
    page.body:ClearAllPoints()
    page.body:SetPoint("TOPLEFT", 24, -74 - 10 * (1 - p)); page.body:SetPoint("BOTTOMRIGHT", -24, 20 - 10 * (1 - p))
  end, "page")
  S.mark(not first)
  return page
end
-- Redraw the page that is showing (after an event changed its data).
function S.refresh(id)
  if not win or not win:IsShown() then return end
  if id and id ~= S.current then return end
  local page = win.pages[S.current]
  local m = page and page.module
  if m and m.refresh then ns.safely(m.refresh, page.body, page) end
  S.mark(false)
end
function S.hide()
  if not win or not win:IsShown() then return end
  win:Hide()
  if PlaySound and SOUNDKIT and SOUNDKIT.IG_MAINMENU_CLOSE then pcall(PlaySound, SOUNDKIT.IG_MAINMENU_CLOSE) end
end
function S.toggle()
  if win and win:IsShown() then S.hide() return end
  local last = layout().last
  S.open((not ns.opt("openHome") and last and ns.modules[last]) and last or "home")
end
function S.isOpen() return win ~= nil and win:IsShown() end

-- ---------- search across every module ----------
-- Words must all appear (any order, any case) in the text.
function ns.matches(text, query)
  text = string.lower(tostring(text or ""))
  for word in string.gmatch(string.lower(query or ""), "%S+") do
    if not string.find(text, word, 1, true) then return false end
  end
  return true
end
function S.find(query)
  local out = {}
  query = tostring(query or "")
  if #(string.gsub(query, "%s", "")) < 2 then return out end
  for _, m in ipairs(ns.moduleList) do
    if (not m.available or m.available()) then
      if ns.matches(m.title .. " " .. (m.keywords or ""), query) then
        out[#out + 1] = { label = m.title, sub = "Tab", icon = "Interface\\Icons\\" .. (m.icon or "INV_Misc_QuestionMark"), tab = m.id }
      end
      if m.search then
        local ok, found = pcall(m.search, query)
        if ok and type(found) == "table" then
          for i = 1, math.min(#found, 8) do
            local x = found[i]
            x.tab = x.tab or m.id
            x.sub = (x.sub and x.sub ~= "") and (m.title .. "  ·  " .. x.sub) or m.title
            out[#out + 1] = x
          end
        elseif not ok then ns.reportError(found) end
      end
    end
  end
  for _, o in ipairs(ns.optionList) do
    if ns.matches(o.label .. " " .. (o.desc or "") .. " " .. (o.group or ""), query) then
      out[#out + 1] = { label = o.label, sub = "Setting  ·  " .. (o.group or ""), icon = "Interface\\Icons\\Trade_Engineering", tab = "settings", option = o.key }
    end
  end
  return out
end
function S.search(query, open)
  S.window()
  if open then
    if not win:IsShown() then S.toggle() end
    if win.search.value() ~= query then win.search:SetText(query or "") end
  end
  local found = S.find(query)
  S.found = found
  local res = win.results
  if #(string.gsub(tostring(query or ""), "%s", "")) < 2 then res:Hide() return found end
  res.head:SetText(#found == 0 and "Nothing found. Try fewer or shorter words." or (#found .. (#found == 1 and " result" or " results") .. "  ·  Enter opens the first"))
  res.list.offset = 0
  res.list.set(found)
  res:Show()
  return found
end
function S.go(item)
  if type(item) ~= "table" then return end
  win.results:Hide()
  win.search:SetText(""); if win.search.ClearFocus then win.search:ClearFocus() end
  S.open(item.tab or "home")
  if item.go then ns.safely(item.go, item) end
  if item.option and ns.modules.settings and ns.modules.settings.focus then ns.safely(ns.modules.settings.focus, item.option) end
end
function S.pickResult(i) if S.found and S.found[i] then S.go(S.found[i]) end end

-- ---------- minimap button ----------
local function placeMinimap(b)
  local angle = math.rad(tonumber(ns.db.opts.minimapAngle) or 215)
  local radius = ((Minimap.GetWidth and tonumber(Minimap:GetWidth())) or 140) / 2 + 6
  b:ClearAllPoints()
  b:SetPoint("CENTER", Minimap, "CENTER", math.cos(angle) * radius, math.sin(angle) * radius)
end
local function createMinimap()
  if not Minimap then return end
  local b = CreateFrame("Button", "WarbandCodexMinimapButton", Minimap)
  b:SetSize(30, 30); b:SetFrameStrata("MEDIUM")
  if b.SetFrameLevel then b:SetFrameLevel(8) end
  b.icon = b:CreateTexture(nil, "ARTWORK"); b.icon:SetSize(20, 20); b.icon:SetPoint("CENTER")
  b.icon:SetTexture("Interface\\Icons\\INV_Misc_Book_09")
  if b.icon.SetTexCoord then b.icon:SetTexCoord(0.08, 0.92, 0.08, 0.92) end
  b.ring = b:CreateTexture(nil, "OVERLAY"); b.ring:SetSize(52, 52); b.ring:SetPoint("TOPLEFT")
  b.ring:SetTexture("Interface\\Minimap\\MiniMap-TrackingBorder")
  if b.RegisterForClicks then b:RegisterForClicks("LeftButtonUp", "RightButtonUp") end
  if b.RegisterForDrag then b:RegisterForDrag("LeftButton") end
  b:SetScript("OnClick", function(_, which)
    if which == "RightButton" then ns.safely(S.open, "settings") else ns.safely(S.toggle) end
  end)
  b:SetScript("OnDragStart", function(self)
    self:SetScript("OnUpdate", function()
      local mx, my = Minimap:GetCenter()
      local px, py = GetCursorPosition()
      local scale = (Minimap.GetEffectiveScale and Minimap:GetEffectiveScale()) or 1
      if not mx or not px then return end
      ns.db.opts.minimapAngle = math.deg(math.atan2(py / scale - my, px / scale - mx))
      placeMinimap(self)
    end)
  end)
  b:SetScript("OnDragStop", function(self) self:SetScript("OnUpdate", nil) end)
  b:SetScript("OnEnter", function(self)
    if GameTooltip and GameTooltip.SetOwner then
      GameTooltip:SetOwner(self, "ANCHOR_LEFT")
      GameTooltip:SetText(ns.NAME, 1, 1, 1)
      if GameTooltip.AddLine then
        GameTooltip:AddLine("Click to open. Right-click for settings. Drag to move.", 0.7, 0.7, 0.7)
      end
      GameTooltip:Show()
    end
  end)
  b:SetScript("OnLeave", function() if GameTooltip and GameTooltip.Hide then GameTooltip:Hide() end end)
  placeMinimap(b)
  S.minimapButton = b
  if ns.opt("minimap") then b:Show() else b:Hide() end
end

ns.on("PLAYER_LOGIN", function()
  createMinimap()
  ns.print("ready. Type |cffffffff/codex|r or click the minimap book.")
end)
ns.on("PLAYER_LEVEL_UP", function() if win then S.rebuildSidebar() end end)

-- ---------- shared page pieces ----------
-- A heading with a thin rule under it, used for sections inside pages.
function U.section(parent, label)
  local f = CreateFrame("Frame", nil, parent)
  f:SetHeight(22)
  f.label = U.text(f, "heading", label, "line"); f.label:SetPoint("LEFT", 0, 0)
  f.rule = U.fill(f, "line", 0.18, "ARTWORK"); f.rule:SetHeight(1)
  f.rule:SetPoint("BOTTOMLEFT", 0, 0); f.rule:SetPoint("BOTTOMRIGHT", 0, 0)
  function f.set(t) f.label:SetText(t) end
  return f
end
-- A message for an empty page or list.
function U.empty(parent, text)
  local t = U.text(parent, "body", text, "dim")
  if t.SetWordWrap then t:SetWordWrap(true) end
  t:SetJustifyH("LEFT")
  return t
end
