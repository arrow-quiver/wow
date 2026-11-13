-- Warband Codex: the look. Themes, motion and the small widget kit every tab is built from.
-- Flat dark panels, one accent colour, soft gradients and short eased animations. Everything is our own frame.
local ADDON, ns = ...
local U = {}
ns.ui = U

local WHITE = "Interface\\Buttons\\WHITE8x8"
U.FONT_TITLE = "Fonts\\MORPHEUS.TTF"
U.FONT_BODY = "Fonts\\FRIZQT__.TTF"
U.FONT_NUM = "Fonts\\ARIALN.TTF"

-- ---------- themes ----------
U.themes = {
  ember = { label = "Ember", bg = { 0.035, 0.04, 0.06 }, bg2 = { 0.09, 0.075, 0.09 }, panel = { 0.075, 0.08, 0.11 },
    line = { 0.91, 0.78, 0.52 }, accent = { 0.93, 0.62, 0.22 }, accent2 = { 0.78, 0.30, 0.16 },
    text = { 0.94, 0.90, 0.83 }, dim = { 0.58, 0.58, 0.63 }, good = { 0.45, 0.82, 0.48 }, bad = { 0.92, 0.33, 0.30 } },
  frost = { label = "Frost", bg = { 0.03, 0.045, 0.07 }, bg2 = { 0.06, 0.09, 0.13 }, panel = { 0.07, 0.09, 0.13 },
    line = { 0.72, 0.82, 0.92 }, accent = { 0.36, 0.72, 0.98 }, accent2 = { 0.24, 0.42, 0.86 },
    text = { 0.90, 0.94, 0.98 }, dim = { 0.55, 0.61, 0.69 }, good = { 0.45, 0.85, 0.62 }, bad = { 0.95, 0.40, 0.42 } },
  fel = { label = "Fel", bg = { 0.03, 0.05, 0.04 }, bg2 = { 0.06, 0.10, 0.06 }, panel = { 0.06, 0.09, 0.07 },
    line = { 0.66, 0.88, 0.50 }, accent = { 0.52, 0.92, 0.30 }, accent2 = { 0.20, 0.62, 0.30 },
    text = { 0.90, 0.95, 0.88 }, dim = { 0.55, 0.64, 0.56 }, good = { 0.50, 0.92, 0.40 }, bad = { 0.95, 0.42, 0.30 } },
  blood = { label = "Blood", bg = { 0.055, 0.03, 0.035 }, bg2 = { 0.12, 0.05, 0.05 }, panel = { 0.10, 0.06, 0.065 },
    line = { 0.90, 0.62, 0.52 }, accent = { 0.92, 0.26, 0.22 }, accent2 = { 0.60, 0.12, 0.14 },
    text = { 0.96, 0.90, 0.88 }, dim = { 0.66, 0.56, 0.56 }, good = { 0.55, 0.82, 0.45 }, bad = { 1.0, 0.45, 0.35 } },
  silver = { label = "Dark silver", bg = { 0.045, 0.045, 0.05 }, bg2 = { 0.09, 0.09, 0.10 }, panel = { 0.085, 0.085, 0.095 },
    line = { 0.78, 0.78, 0.82 }, accent = { 0.82, 0.84, 0.90 }, accent2 = { 0.48, 0.50, 0.58 },
    text = { 0.93, 0.93, 0.95 }, dim = { 0.58, 0.58, 0.62 }, good = { 0.50, 0.82, 0.55 }, bad = { 0.92, 0.38, 0.36 } },
}
U.themeOrder = { "ember", "frost", "fel", "blood", "silver" }

function U.theme()
  local key = ns.db and ns.db.opts.theme
  return U.themes[key] or U.themes.ember
end
-- U.c("accent") → r, g, b
function U.c(name, a)
  local col = U.theme()[name] or U.theme().text
  return col[1], col[2], col[3], a or 1
end
function U.hex(name)
  local r, g, b = U.c(name)
  return string.format("|cff%02x%02x%02x", math.floor(r * 255 + 0.5), math.floor(g * 255 + 0.5), math.floor(b * 255 + 0.5))
end

-- Painters re-run when the theme changes, so every themed texture follows.
local painters = {}
function U.themed(fn)
  painters[#painters + 1] = fn
  ns.safely(fn)
end
function U.repaint() for i = 1, #painters do ns.safely(painters[i]) end end
function U.setTheme(key)
  if not U.themes[key] then return end
  ns.setOpt("theme", key)
  U.repaint()
end

-- ---------- primitives ----------
function U.tex(parent, layer, r, g, b, a)
  local t = parent:CreateTexture(nil, layer or "BACKGROUND")
  if t.SetColorTexture then t:SetColorTexture(r or 1, g or 1, b or 1, a or 1) else t:SetTexture(r or 1, g or 1, b or 1, a or 1) end
  return t
end
function U.color(t, r, g, b, a)
  if t.SetColorTexture then t:SetColorTexture(r, g, b, a or 1) else t:SetTexture(r, g, b, a or 1) end
end
-- A texture that follows a theme colour: U.fill(parent, "panel", 0.9)
function U.fill(parent, name, alpha, layer)
  local t = U.tex(parent, layer or "BACKGROUND", 1, 1, 1, 1)
  U.themed(function() local r, g, b = U.c(name); U.color(t, r, g, b, alpha or 1) end)
  return t
end
function U.gradient(t, dir, r1, g1, b1, a1, r2, g2, b2, a2)
  if CreateColor and t.SetGradient then pcall(t.SetGradient, t, dir, CreateColor(r1, g1, b1, a1), CreateColor(r2, g2, b2, a2))
  elseif t.SetGradientAlpha then pcall(t.SetGradientAlpha, t, dir, r1, g1, b1, a1, r2, g2, b2, a2) end
end
function U.border(f, name, alpha)
  local edges = {}
  local function edge(p1, p2, horizontal)
    local t = U.tex(f, "BORDER", 1, 1, 1, 1)
    t:SetPoint(p1); t:SetPoint(p2)
    if horizontal then t:SetHeight(1) else t:SetWidth(1) end
    edges[#edges + 1] = t
  end
  edge("TOPLEFT", "TOPRIGHT", true); edge("BOTTOMLEFT", "BOTTOMRIGHT", true)
  edge("TOPLEFT", "BOTTOMLEFT", false); edge("TOPRIGHT", "BOTTOMRIGHT", false)
  U.themed(function() local r, g, b = U.c(name or "line"); for _, t in ipairs(edges) do U.color(t, r, g, b, alpha or 0.25) end end)
  return edges
end

-- Text: kind = "title" | "heading" | "body" | "small" | "num"; colour is a theme colour name.
local SIZES = { title = { U.FONT_TITLE, 24 }, heading = { U.FONT_TITLE, 16 }, sub = { U.FONT_BODY, 13 },
  body = { U.FONT_BODY, 12 }, small = { U.FONT_BODY, 10.5 }, num = { U.FONT_NUM, 14 }, big = { U.FONT_NUM, 22 } }
function U.text(parent, kind, str, colorName)
  local fs = parent:CreateFontString(nil, "OVERLAY", "GameFontHighlight")
  local s = SIZES[kind] or SIZES.body
  if fs.SetFont then pcall(fs.SetFont, fs, s[1], s[2], "") end
  fs:SetJustifyH("LEFT")
  if fs.SetWordWrap then fs:SetWordWrap(false) end
  U.themed(function() fs:SetTextColor(U.c(colorName or "text")) end)
  if str then fs:SetText(str) end
  return fs
end

function U.icon(parent, size, texture)
  local f = CreateFrame("Frame", nil, parent)
  f:SetSize(size, size)
  f.tex = f:CreateTexture(nil, "ARTWORK")
  f.tex:SetAllPoints()
  if f.tex.SetTexCoord then f.tex:SetTexCoord(0.07, 0.93, 0.07, 0.93) end
  f.tex:SetTexture(texture or "Interface\\Icons\\INV_Misc_QuestionMark")
  U.border(f, "line", 0.35)
  function f.set(tex) f.tex:SetTexture(tex or "Interface\\Icons\\INV_Misc_QuestionMark") end
  return f
end

-- A panel: slightly lighter than the window, hairline border.
function U.card(parent, w, h)
  local f = CreateFrame("Frame", nil, parent)
  if w then f:SetSize(w, h or 60) end
  f.bg = U.fill(f, "panel", 0.92); f.bg:SetAllPoints()
  U.border(f, "line", 0.14)
  return f
end

-- ---------- motion ----------
-- U.tween(owner, seconds, step(progress 0..1 eased)): one driver frame for all running tweens. A new tween on the
-- same owner + channel replaces the old one. With animations off (or no clock) the last step runs at once.
local driver = CreateFrame("Frame")
local running, count = {}, 0
local function ease(t) local u = 1 - t; return 1 - u * u * u end
driver:SetScript("OnUpdate", function(_, elapsed)
  if count == 0 then return end
  for key, tw in pairs(running) do
    tw.t = tw.t + (elapsed or 0)
    local p = tw.t / tw.dur
    if p >= 1 then
      running[key] = nil; count = count - 1
      ns.safely(tw.step, 1)
    else ns.safely(tw.step, ease(p)) end
  end
end)
function U.tween(owner, seconds, step, channel)
  local key = tostring(owner) .. (channel or "")
  if running[key] then running[key] = nil; count = count - 1 end
  if not ns.opt("animations") or ns.instantMotion or seconds <= 0 then ns.safely(step, 1) return end
  ns.safely(step, 0)
  running[key] = { t = 0, dur = seconds, step = step }
  count = count + 1
end
function U.fadeIn(f, seconds)
  U.tween(f, seconds or 0.2, function(p) if f.SetAlpha then f:SetAlpha(p) end end, "fade")
end

-- ---------- widgets ----------
-- A flat button with a hover glow. opts: { w, h, primary }
function U.button(parent, label, onClick, opts)
  opts = opts or {}
  local b = CreateFrame("Button", nil, parent)
  b:SetSize(opts.w or 96, opts.h or 24)
  b.bg = U.tex(b, "BACKGROUND", 1, 1, 1, 1); b.bg:SetAllPoints()
  b.glow = U.tex(b, "BORDER", 1, 1, 1, 0); b.glow:SetAllPoints()
  U.border(b, opts.primary and "accent" or "line", opts.primary and 0.7 or 0.3)
  b.label = U.text(b, "body", label, opts.primary and "text" or "text")
  b.label:SetPoint("CENTER", 0, 0); b.label:SetJustifyH("CENTER")
  U.themed(function()
    local r, g, b2 = U.c(opts.primary and "accent2" or "panel")
    U.color(b.bg, r, g, b2, opts.primary and 0.85 or 0.95)
    local ar, ag, ab = U.c("accent"); U.color(b.glow, ar, ag, ab, b.hover and 0.18 or 0)
  end)
  b:SetScript("OnEnter", function(self)
    self.hover = true
    U.tween(self, 0.12, function(p) local r, g, bb = U.c("accent"); U.color(self.glow, r, g, bb, 0.18 * p) end, "hover")
    if self.tip and GameTooltip and GameTooltip.SetOwner then
      GameTooltip:SetOwner(self, "ANCHOR_TOP"); GameTooltip:SetText(self.tip, 1, 1, 1, 1, true); GameTooltip:Show()
    end
  end)
  b:SetScript("OnLeave", function(self)
    self.hover = false
    U.tween(self, 0.18, function(p) local r, g, bb = U.c("accent"); U.color(self.glow, r, g, bb, 0.18 * (1 - p)) end, "hover")
    if self.tip and GameTooltip and GameTooltip.Hide then GameTooltip:Hide() end
  end)
  b:SetScript("OnClick", function(self, which)
    if PlaySound and SOUNDKIT and SOUNDKIT.U_CHAT_SCROLL_BUTTON then pcall(PlaySound, SOUNDKIT.U_CHAT_SCROLL_BUTTON) end
    if onClick then ns.safely(onClick, self, which) end
  end)
  function b.setText(t) b.label:SetText(t) end
  function b.setEnabled(on)
    b.off = not on
    if b.SetAlpha then b:SetAlpha(on and 1 or 0.4) end
    if b.EnableMouse then b:EnableMouse(on and true or false) end
  end
  return b
end

-- A switch: U.toggle(parent, get, set). Click flips it; the knob slides.
function U.toggle(parent, get, set)
  local b = CreateFrame("Button", nil, parent)
  b:SetSize(34, 16)
  b.track = U.tex(b, "BACKGROUND", 1, 1, 1, 1); b.track:SetAllPoints()
  b.knob = U.tex(b, "ARTWORK", 1, 1, 1, 1); b.knob:SetSize(12, 12)
  local function paint(p)
    local on = get() and true or false
    local r, g, bb = U.c(on and "accent" or "dim")
    U.color(b.track, r, g, bb, on and 0.55 or 0.25)
    local tr, tg, tb = U.c("text"); U.color(b.knob, tr, tg, tb, 1)
    local x = on and (2 + 18 * (p or 1)) or (20 - 18 * (p or 1))
    b.knob:ClearAllPoints(); b.knob:SetPoint("LEFT", x, 0)
  end
  U.themed(function() paint(1) end)
  b:SetScript("OnClick", function()
    set(not get())
    U.tween(b, 0.14, paint, "knob")
  end)
  b.refresh = function() paint(1) end
  return b
end

-- A progress bar that glides to its value: bar.set(fraction, text)
function U.bar(parent, w, h, colorName)
  local f = CreateFrame("Frame", nil, parent)
  f:SetSize(w or 200, h or 10)
  f.width = w or 200
  f.bg = U.fill(f, "bg", 0.9); f.bg:SetAllPoints()
  f.fill = U.tex(f, "ARTWORK", 1, 1, 1, 1)
  f.fill:SetPoint("TOPLEFT"); f.fill:SetPoint("BOTTOMLEFT"); f.fill:SetWidth(1)
  f.color = colorName or "accent"
  U.themed(function() local r, g, b = U.c(f.color); U.color(f.fill, r, g, b, 0.9) end)
  U.border(f, "line", 0.2)
  f.label = U.text(f, "small", "", "text"); f.label:SetPoint("CENTER"); f.label:SetJustifyH("CENTER")
  f.value = 0
  function f.set(frac, text, color)
    frac = math.max(0, math.min(1, tonumber(frac) or 0))
    if color and color ~= f.color then f.color = color; local r, g, b = U.c(color); U.color(f.fill, r, g, b, 0.9) end
    local from = f.value
    f.value = frac
    local full = (f.GetWidth and tonumber(f:GetWidth())) or f.width
    if not full or full <= 0 then full = f.width end
    U.tween(f, 0.35, function(p) f.fill:SetWidth(math.max(1, full * (from + (frac - from) * p))) end, "bar")
    f.label:SetText(text or "")
  end
  return f
end

-- A one-line text box with a ghost hint. onChange(text) on every edit, onEnter(text) on Enter.
function U.edit(parent, w, hint, onChange, onEnter)
  local e = CreateFrame("EditBox", nil, parent)
  e:SetSize(w or 180, 22)
  e:SetAutoFocus(false)
  if e.SetFont then pcall(e.SetFont, e, U.FONT_BODY, 12, "") end
  if e.SetTextInsets then e:SetTextInsets(8, 8, 0, 0) end
  e.bg = U.fill(e, "bg", 0.9); e.bg:SetAllPoints()
  U.border(e, "line", 0.3)
  U.themed(function() if e.SetTextColor then e:SetTextColor(U.c("text")) end end)
  e.hint = U.text(e, "body", hint or "", "dim"); e.hint:SetPoint("LEFT", 8, 0)
  local function value() return e:GetText() or "" end
  e.value = value
  e:SetScript("OnTextChanged", function()
    if value() == "" then e.hint:Show() else e.hint:Hide() end
    if onChange then ns.safely(onChange, value()) end
  end)
  e:SetScript("OnEscapePressed", function() e:SetText(""); e:ClearFocus() end)
  e:SetScript("OnEnterPressed", function() if onEnter then ns.safely(onEnter, value()) end e:ClearFocus() end)
  -- Tests and code set the text and run the same path as typing.
  function e.type(text) e:SetText(text); local s = e:GetScript("OnTextChanged"); if s then s(e) end end
  return e
end

-- A scrolling list of fixed-height rows. make(list, index) → row frame; fill(row, item, index).
-- list.set(items) shows them; the mouse wheel scrolls; only the rows that fit are ever created.
function U.list(parent, rowH, make, fill, fallbackRows)
  local L = CreateFrame("Frame", nil, parent)
  L.rows, L.items, L.offset, L.rowH = {}, {}, 0, rowH
  L.thumb = U.fill(L, "accent", 0.5, "OVERLAY"); L.thumb:SetWidth(3)
  function L.visible()
    local h = L.GetHeight and tonumber(L:GetHeight())
    if not h or h <= 0 then return fallbackRows or 10 end
    return math.max(1, math.floor(h / rowH))
  end
  function L.render()
    local n = L.visible()
    local max = math.max(0, #L.items - n)
    if L.offset > max then L.offset = max end
    if L.offset < 0 then L.offset = 0 end
    for i = 1, n do
      local row = L.rows[i]
      if not row then
        row = make(L, i)
        row:SetPoint("TOPLEFT", 0, -(i - 1) * rowH)
        row:SetPoint("TOPRIGHT", -8, -(i - 1) * rowH)
        row:SetHeight(rowH)
        L.rows[i] = row
      end
      local item = L.items[i + L.offset]
      if item ~= nil then row.item = item; fill(row, item, i + L.offset); row:Show() else row.item = nil; row:Hide() end
    end
    for i = n + 1, #L.rows do L.rows[i]:Hide() end
    if #L.items > n then
      local track = n * rowH
      local size = math.max(16, track * n / #L.items)
      L.thumb:SetHeight(size)
      L.thumb:ClearAllPoints()
      L.thumb:SetPoint("TOPRIGHT", 0, -((track - size) * (max > 0 and L.offset / max or 0)))
      L.thumb:Show()
    else L.thumb:Hide() end
  end
  function L.set(items) L.items = items or {}; L.render() end
  function L.scroll(by) L.offset = L.offset + by; L.render() end
  if L.EnableMouseWheel then L:EnableMouseWheel(true) end
  L:SetScript("OnMouseWheel", function(_, delta) L.scroll(-(delta or 0) * 3) end)
  L:SetScript("OnSizeChanged", function() ns.safely(L.render) end)
  return L
end

-- A plain list row: stripe, hover wash, optional click. Fields are added by the caller.
function U.row(list, index, onClick)
  local r = CreateFrame("Button", nil, list)
  r.stripe = U.tex(r, "BACKGROUND", 1, 1, 1, index % 2 == 0 and 0.025 or 0); r.stripe:SetAllPoints()
  r.wash = U.tex(r, "BORDER", 1, 1, 1, 0); r.wash:SetAllPoints()
  r:SetScript("OnEnter", function(self)
    local cr, cg, cb = U.c("accent"); U.color(self.wash, cr, cg, cb, 0.10)
    if self.tipLink and GameTooltip and GameTooltip.SetOwner then
      GameTooltip:SetOwner(self, "ANCHOR_RIGHT"); pcall(GameTooltip.SetHyperlink, GameTooltip, self.tipLink); GameTooltip:Show()
    elseif self.tip and GameTooltip and GameTooltip.SetOwner then
      GameTooltip:SetOwner(self, "ANCHOR_RIGHT"); GameTooltip:SetText(self.tip, 1, 1, 1, 1, true); GameTooltip:Show()
    end
  end)
  r:SetScript("OnLeave", function(self)
    U.color(self.wash, 1, 1, 1, 0)
    if GameTooltip and GameTooltip.Hide then GameTooltip:Hide() end
  end)
  r:SetScript("OnClick", function(self, which) if onClick and self.item ~= nil then ns.safely(onClick, self, self.item, which) end end)
  return r
end

-- Pill-shaped filter chips: U.chips(parent, { {key,label}, ... }, onPick) → frame with .pick(key), .value
function U.chips(parent, choices, onPick)
  local f = CreateFrame("Frame", nil, parent)
  f:SetSize(10, 22)
  f.buttons = {}
  local x = 0
  for _, ch in ipairs(choices) do
    local w = 18 + 7 * #ch[2]
    local b = U.button(f, ch[2], function() f.pick(ch[1]) end, { w = w, h = 22 })
    b:SetPoint("LEFT", x, 0)
    b.key = ch[1]
    f.buttons[#f.buttons + 1] = b
    x = x + w + 6
  end
  f:SetWidth(math.max(10, x))
  function f.pick(key, quiet)
    f.value = key
    for _, b in ipairs(f.buttons) do
      local on = b.key == key
      local r, g, bb = U.c(on and "accent2" or "panel")
      U.color(b.bg, r, g, bb, on and 0.9 or 0.95)
    end
    if not quiet and onPick then ns.safely(onPick, key) end
  end
  return f
end

-- ---------- toasts: small cards that slide in at the top of the screen (our own frames) ----------
local toasts = {}
function ns.toast(title, text, icon, seconds)
  if not ns.opt("toasts") then return nil end
  local t
  for _, f in ipairs(toasts) do if not f:IsShown() then t = f break end end
  if not t then
    if #toasts >= 4 then t = toasts[1] else
      t = CreateFrame("Frame", "WarbandCodexToast" .. (#toasts + 1), UIParent)
      t:SetSize(300, 54); t:SetFrameStrata("HIGH")
      t.bg = U.fill(t, "panel", 0.96); t.bg:SetAllPoints()
      U.border(t, "accent", 0.6)
      t.edge = U.fill(t, "accent", 1, "ARTWORK"); t.edge:SetPoint("TOPLEFT"); t.edge:SetPoint("BOTTOMLEFT"); t.edge:SetWidth(3)
      t.icon = U.icon(t, 34); t.icon:SetPoint("LEFT", 12, 0)
      t.title = U.text(t, "sub", "", "accent"); t.title:SetPoint("TOPLEFT", 56, -9); t.title:SetWidth(232)
      t.text = U.text(t, "body", "", "text"); t.text:SetPoint("TOPLEFT", 56, -27); t.text:SetWidth(232)
      t:SetScript("OnUpdate", function(self, elapsed)
        if not self.left then return end
        self.left = self.left - (elapsed or 0)
        if self.left <= 0 then self.left = nil; self:Hide() end
      end)
      t.index = #toasts + 1
      toasts[#toasts + 1] = t
    end
  end
  t.title:SetText(title or ""); t.text:SetText(text or ""); t.icon.set(icon)
  t.left = seconds or 6
  t:ClearAllPoints()
  local y = -90 - (t.index - 1) * 60
  t:SetPoint("TOP", UIParent, "TOP", 0, y)
  t:Show()
  U.tween(t, 0.25, function(p)
    if t.SetAlpha then t:SetAlpha(p) end
    t:ClearAllPoints(); t:SetPoint("TOP", UIParent, "TOP", 0, y + 14 * (1 - p))
  end, "toast")
  if ns.opt("toastSound") and PlaySound and SOUNDKIT and SOUNDKIT.UI_BNET_TOAST then pcall(PlaySound, SOUNDKIT.UI_BNET_TOAST) end
  ns.lastToast = { title = title, text = text }
  return t
end

ns.option{ key = "animations", label = "Animations", desc = "Windows fade and slide in, bars glide to their value. Turn off for instant changes.", group = "Window", default = true }
ns.option{ key = "toasts", label = "Pop-up cards", desc = "Short cards at the top of the screen for alerts (kill-on-sight players, pet skills, full bags).", group = "Window", default = true }
ns.option{ key = "toastSound", label = "Sound with pop-up cards", desc = "Play a soft sound when a card appears.", group = "Window", default = true }
