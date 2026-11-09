-- Guild Camp: the shared look. Dark night-sky panels, gold rules and corner brackets,
-- the same style as the guild website and its loading screen.
local ADDON, ns = ...
local S = {}
ns.skin = S

S.GOLD = { 0.91, 0.78, 0.52 }
S.EMBER = { 0.91, 0.64, 0.24 }
S.GREY = { 0.62, 0.62, 0.66 }
S.PARCHMENT = { 0.93, 0.89, 0.82 }

function S.colorTex(parent, layer, r, g, b, a)
  local t = parent:CreateTexture(nil, layer or "BACKGROUND")
  if t.SetColorTexture then t:SetColorTexture(r, g, b, a or 1) else t:SetTexture(r, g, b, a or 1) end
  return t
end

function S.gradient(t, dir, r1, g1, b1, a1, r2, g2, b2, a2)
  if CreateColor and t.SetGradient then pcall(t.SetGradient, t, dir, CreateColor(r1, g1, b1, a1), CreateColor(r2, g2, b2, a2))
  elseif t.SetGradientAlpha then pcall(t.SetGradientAlpha, t, dir, r1, g1, b1, a1, r2, g2, b2, a2) end
end

function S.border(f, r, g, b, a, size)
  size = size or 1
  local function edge(p1, p2, w, h)
    local t = S.colorTex(f, "BORDER", r, g, b, a)
    t:SetPoint(p1); t:SetPoint(p2)
    if w then t:SetWidth(w) else t:SetHeight(h) end
  end
  edge("TOPLEFT", "TOPRIGHT", nil, size); edge("BOTTOMLEFT", "BOTTOMRIGHT", nil, size)
  edge("TOPLEFT", "BOTTOMLEFT", size, nil); edge("TOPRIGHT", "BOTTOMRIGHT", size, nil)
end

function S.corners(f, len, inset)
  len, inset = len or 22, inset or 4
  local G = S.GOLD
  for _, c in ipairs({ { "TOPLEFT", 1, -1 }, { "TOPRIGHT", -1, -1 }, { "BOTTOMLEFT", 1, 1 }, { "BOTTOMRIGHT", -1, 1 } }) do
    local h = S.colorTex(f, "ARTWORK", G[1], G[2], G[3], 0.9); h:SetSize(len, 1); h:SetPoint(c[1], f, c[1], c[2] * inset, c[3] * inset)
    local v = S.colorTex(f, "ARTWORK", G[1], G[2], G[3], 0.9); v:SetSize(1, len); v:SetPoint(c[1], f, c[1], c[2] * inset, c[3] * inset)
  end
end

-- Fonts: Morpheus (the game's own fantasy face) for titles, the normal UI font for text.
local fonts = {}
local function makeFont(key, path, size, fallback)
  if fonts[key] ~= nil then return fonts[key] end
  local f = _G[fallback] or fallback
  if CreateFont then
    local ok, obj = pcall(CreateFont, "WowGuildFont" .. key)
    if ok and obj and obj.SetFont then obj:SetFont(path, size, ""); obj:SetShadowOffset(1, -1); obj:SetShadowColor(0, 0, 0, 1); f = obj end
  end
  fonts[key] = f
  return f
end
function S.font(kind)
  if kind == "title" then return makeFont("Title", "Fonts\\MORPHEUS.TTF", 22, "GameFontNormalLarge") end
  if kind == "heading" then return makeFont("Heading", "Fonts\\MORPHEUS.TTF", 16, "GameFontNormalLarge") end
  if kind == "tab" then return makeFont("Tab", "Fonts\\MORPHEUS.TTF", 15, "GameFontNormal") end
  if kind == "small" then return _G.GameFontHighlightSmall or "GameFontHighlightSmall" end
  return _G.GameFontHighlight or "GameFontHighlight"
end
function S.text(parent, kind, str, color)
  local fs = parent:CreateFontString(nil, "OVERLAY", "GameFontHighlight")
  fs:SetFontObject(S.font(kind))
  fs:SetJustifyH("LEFT")
  if color then fs:SetTextColor(color[1], color[2], color[3], color[4] or 1) end
  if str then fs:SetText(str) end
  return fs
end

-- A big window: night-sky gradient, warm glow at the top, gold frame with corner brackets.
function S.window(f)
  local bg = S.colorTex(f, "BACKGROUND", 0.04, 0.05, 0.08, 0.97); bg:SetAllPoints()
  S.gradient(bg, "VERTICAL", 0.03, 0.04, 0.06, 0.98, 0.12, 0.10, 0.12, 0.98)
  local glow = S.colorTex(f, "BACKGROUND", 0.65, 0.29, 0.16, 0.1); glow:SetPoint("TOPLEFT"); glow:SetPoint("TOPRIGHT"); glow:SetHeight(90)
  S.gradient(glow, "VERTICAL", 0.65, 0.29, 0.16, 0, 0.65, 0.29, 0.16, 0.16)
  S.border(f, S.GOLD[1], S.GOLD[2], S.GOLD[3], 0.35)
  S.corners(f, 24)
  f.skinned = true
  return f
end

-- A small floating panel (skill-up guide, shopping list, problem report).
function S.panel(f)
  local bg = S.colorTex(f, "BACKGROUND", 0.05, 0.06, 0.09, 0.94); bg:SetAllPoints()
  S.gradient(bg, "VERTICAL", 0.04, 0.05, 0.07, 0.95, 0.10, 0.09, 0.11, 0.95)
  S.border(f, S.GOLD[1], S.GOLD[2], S.GOLD[3], 0.4)
  S.corners(f, 12, 3)
  f.skinned = true
  return f
end

-- A thin gold rule that fades out at both ends.
function S.rule(parent, y, inset)
  inset = inset or 16
  local G = S.GOLD
  local left = S.colorTex(parent, "ARTWORK", G[1], G[2], G[3], 0.6); left:SetHeight(1)
  left:SetPoint("TOPLEFT", inset, y); left:SetPoint("TOPRIGHT", parent, "TOP", 0, y)
  S.gradient(left, "HORIZONTAL", G[1], G[2], G[3], 0, G[1], G[2], G[3], 0.7)
  local right = S.colorTex(parent, "ARTWORK", G[1], G[2], G[3], 0.6); right:SetHeight(1)
  right:SetPoint("TOPLEFT", parent, "TOP", 0, y); right:SetPoint("TOPRIGHT", -inset, y)
  S.gradient(right, "HORIZONTAL", G[1], G[2], G[3], 0.7, G[1], G[2], G[3], 0)
end

-- Text tabs with an ember underline, like the Coach window.
function S.tab(parent, label, onClick)
  local b = CreateFrame("Button", nil, parent)
  b.label = S.text(b, "tab", label, S.GREY)
  b.label:SetPoint("CENTER", 0, 1)
  local w = (b.label.GetStringWidth and b.label:GetStringWidth()) or 80
  if type(w) ~= "number" or w <= 0 or w > 200 then w = 80 end
  b:SetSize(w + 22, 28)
  b.under = S.colorTex(b, "ARTWORK", S.EMBER[1], S.EMBER[2], S.EMBER[3], 1)
  b.under:SetHeight(2); b.under:SetPoint("BOTTOMLEFT", 6, 0); b.under:SetPoint("BOTTOMRIGHT", -6, 0)
  b.under:Hide()
  b:SetScript("OnClick", onClick)
  b:SetScript("OnEnter", function(self) if not self.on then self.label:SetTextColor(unpack(S.PARCHMENT)) end end)
  b:SetScript("OnLeave", function(self) if not self.on then self.label:SetTextColor(unpack(S.GREY)) end end)
  function b.select(on)
    b.on = on
    b.label:SetTextColor(unpack(on and S.GOLD or S.GREY))
    if on then b.under:Show() else b.under:Hide() end
  end
  return b
end

-- The guild style is on unless someone picks Blizzard's look in the options.
function S.enabled() return not ns.opt("blizzardStyle") end
