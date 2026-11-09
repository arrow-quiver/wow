-- Guild Camp: the Coach window. Your play style, your build plan, next steps, and questions for the Coach.
local ADDON, ns = ...
local UI = {}
ns.coachUI = UI

local W, H = 780, 540
local LEFT_W = 250
local GOLD = { 0.91, 0.78, 0.52 }
local EMBER = { 0.91, 0.64, 0.24 }
local GREY = { 0.62, 0.62, 0.66 }
local CLASS = { WARRIOR = { 0.78, 0.61, 0.43 }, PALADIN = { 0.96, 0.55, 0.73 }, HUNTER = { 0.67, 0.83, 0.45 }, ROGUE = { 1, 0.96, 0.41 },
  PRIEST = { 1, 1, 1 }, SHAMAN = { 0, 0.44, 0.87 }, MAGE = { 0.25, 0.78, 0.92 }, WARLOCK = { 0.53, 0.53, 0.93 }, DRUID = { 1, 0.49, 0.04 } }
local ICONS = {
  talent = "Interface\\Icons\\Ability_Marksmanship", repair = "Interface\\Icons\\Trade_BlackSmithing", bags = "Interface\\Icons\\INV_Misc_Bag_08",
  trainer = "Interface\\Icons\\INV_Misc_Book_09", prof = "Interface\\Icons\\INV_Misc_Note_01", quiz = "Interface\\Icons\\INV_Misc_QuestionMark",
  raid = "Interface\\Icons\\Ability_Warrior_BattleShout", plan = "Interface\\Icons\\INV_Misc_Map_01",
}
local DIMS = {
  { key = "aggression", label = "Aggression", hint = "How readily you start fights" },
  { key = "risk", label = "Risk taking", hint = "How often fights go wrong" },
  { key = "social", label = "Social", hint = "Time spent grouped" },
  { key = "pvp", label = "PvP focus", hint = "Flagged, battlegrounds, kills, duels" },
  { key = "pace", label = "Pace", hint = "Fighting and questing per hour" },
}

-- ---------- drawing helpers ----------
local fonts = {}
local function font(key, path, size, flags, fallback)
  if fonts[key] ~= nil then return fonts[key] end
  local f = fallback
  if CreateFont then
    local ok, obj = pcall(CreateFont, "WowGuildCoach" .. key)
    if ok and obj and obj.SetFont then obj:SetFont(path, size, flags or ""); obj:SetShadowOffset(1, -1); obj:SetShadowColor(0, 0, 0, 1); f = obj end
  end
  fonts[key] = f
  return f
end
local function fontFor(kind)
  local map = {
    title = font("Title", "Fonts\\MORPHEUS.TTF", 26, nil, "GameFontNormalHuge"),
    heading = font("Heading", "Fonts\\MORPHEUS.TTF", 17, nil, "GameFontNormalLarge"),
    big = font("Big", "Fonts\\MORPHEUS.TTF", 21, nil, "GameFontNormalLarge"),
    body = "GameFontHighlight", small = "GameFontHighlightSmall", caps = "GameFontNormalSmall",
  }
  local obj = map[kind or "body"] or "GameFontHighlight"
  if type(obj) == "string" then return _G[obj] or obj end
  return obj
end
local function text(parent, kind, str, color, width)
  local fs = parent:CreateFontString(nil, "OVERLAY", "GameFontHighlight")
  fs:SetFontObject(fontFor(kind))
  fs:SetJustifyH("LEFT")
  if fs.SetWordWrap then fs:SetWordWrap(true) end
  if width then fs:SetWidth(width) end
  if color then fs:SetTextColor(color[1], color[2], color[3], color[4] or 1) end
  if str then fs:SetText(str) end
  return fs
end
local function colorTex(parent, layer, r, g, b, a)
  local t = parent:CreateTexture(nil, layer or "BACKGROUND")
  if t.SetColorTexture then t:SetColorTexture(r, g, b, a or 1) else t:SetTexture(r, g, b, a or 1) end
  return t
end
local function gradient(t, dir, r1, g1, b1, a1, r2, g2, b2, a2)
  if CreateColor and t.SetGradient then pcall(t.SetGradient, t, dir, CreateColor(r1, g1, b1, a1), CreateColor(r2, g2, b2, a2))
  elseif t.SetGradientAlpha then pcall(t.SetGradientAlpha, t, dir, r1, g1, b1, a1, r2, g2, b2, a2) end
end
local function border(f, r, g, b, a, size)
  size = size or 1
  local function edge(p1, p2, w, h)
    local t = colorTex(f, "BORDER", r, g, b, a)
    t:SetPoint(p1); t:SetPoint(p2)
    if w then t:SetWidth(w) else t:SetHeight(h) end
  end
  edge("TOPLEFT", "TOPRIGHT", nil, size); edge("BOTTOMLEFT", "BOTTOMRIGHT", nil, size)
  edge("TOPLEFT", "BOTTOMLEFT", size, nil); edge("TOPRIGHT", "BOTTOMRIGHT", size, nil)
end
-- Gold corner brackets, like the guild's loading screen.
local function corners(f, len)
  len = len or 22
  for _, c in ipairs({ { "TOPLEFT", 1, -1 }, { "TOPRIGHT", -1, -1 }, { "BOTTOMLEFT", 1, 1 }, { "BOTTOMRIGHT", -1, 1 } }) do
    local h = colorTex(f, "ARTWORK", GOLD[1], GOLD[2], GOLD[3], 0.9); h:SetSize(len, 1); h:SetPoint(c[1], f, c[1], c[2] * 4, c[3] * 4)
    local v = colorTex(f, "ARTWORK", GOLD[1], GOLD[2], GOLD[3], 0.9); v:SetSize(1, len); v:SetPoint(c[1], f, c[1], c[2] * 4, c[3] * 4)
  end
end
local function button(parent, label, width)
  local b = CreateFrame("Button", nil, parent, "UIPanelButtonTemplate")
  b:SetSize(width or 130, 24)
  b:SetText(label)
  return b
end

-- A scrolling area whose rows are rebuilt on every refresh, reusing regions.
local function canvas(parent)
  local scroll = CreateFrame("ScrollFrame", nil, parent, "UIPanelScrollFrameTemplate")
  scroll:SetPoint("TOPLEFT", 12, -44)
  scroll:SetPoint("BOTTOMRIGHT", -30, 58)
  local content = CreateFrame("Frame", nil, scroll)
  local width = W - LEFT_W - 40 - 42 - 24
  content:SetSize(width, 10)
  scroll:SetScrollChild(content)
  local pools = { fs = {}, tex = {}, btn = {} }
  local used = {}
  local y = 0
  local c = { width = width, frame = content, scroll = scroll }
  function c.top(y0)
    scroll:ClearAllPoints()
    scroll:SetPoint("TOPLEFT", 12, y0)
    scroll:SetPoint("BOTTOMRIGHT", -30, 58)
  end
  function c.reset()
    for _, r in ipairs(used) do r.obj:Hide(); table.insert(pools[r.kind], r.obj) end
    used = {}; y = 0
  end
  local function take(kind, make)
    local obj = table.remove(pools[kind]) or make()
    used[#used + 1] = { kind = kind, obj = obj }
    obj:ClearAllPoints(); obj:Show()
    return obj
  end
  function c.text(kind, str, color, indent, gap)
    local fs = take("fs", function() return text(content, "body") end)
    fs:SetFontObject(fontFor(kind))
    fs:SetTextColor(unpack(color or { 1, 1, 1 }))
    fs:SetWidth(width - (indent or 0))
    fs:SetText(str or "")
    fs:SetPoint("TOPLEFT", indent or 0, -y)
    y = y + (fs:GetStringHeight() or 14) + (gap or 4)
    return fs
  end
  function c.icon(path, size, indent, dy)
    local t = take("tex", function() return content:CreateTexture(nil, "ARTWORK") end)
    t:SetTexture(path); t:SetSize(size, size)
    if t.SetTexCoord then t:SetTexCoord(0.08, 0.92, 0.08, 0.92) end
    t:SetPoint("TOPLEFT", indent or 0, -(y + (dy or 0)))
    return t
  end
  function c.line(alpha)
    local t = take("tex", function() return content:CreateTexture(nil, "ARTWORK") end)
    if t.SetColorTexture then t:SetColorTexture(GOLD[1], GOLD[2], GOLD[3], alpha or 0.25) end
    t:SetSize(width, 1); t:SetPoint("TOPLEFT", 0, -(y + 4))
    y = y + 10
  end
  function c.space(n) y = y + n end
  function c.y() return y end
  function c.setY(v) y = v end
  function c.done() content:SetHeight(math.max(10, y + 6)); if scroll.SetVerticalScroll then scroll:SetVerticalScroll(0) end end
  return c
end

-- ---------- window ----------
local win

local function header(f)
  local portrait = f:CreateTexture(nil, "ARTWORK")
  portrait:SetSize(58, 58); portrait:SetPoint("TOPLEFT", 22, -20)
  f.portrait = portrait
  local ring = CreateFrame("Frame", nil, f)
  ring:SetPoint("TOPLEFT", portrait, -2, 2); ring:SetPoint("BOTTOMRIGHT", portrait, 2, -2)
  border(ring, GOLD[1], GOLD[2], GOLD[3], 0.9, 2)
  f.name = text(f, "title"); f.name:SetPoint("TOPLEFT", 94, -22)
  f.sub = text(f, "small", nil, GREY); f.sub:SetPoint("TOPLEFT", 95, -56); f.sub:SetWidth(330)
  f.styleCaps = text(f, "caps", "PLAY STYLE", GOLD); f.styleCaps:SetPoint("TOPRIGHT", -48, -20); f.styleCaps:SetJustifyH("RIGHT")
  f.archetype = text(f, "big", nil, EMBER); f.archetype:SetPoint("TOPRIGHT", -48, -34); f.archetype:SetJustifyH("RIGHT")
  f.blurb = text(f, "small", nil, { 0.85, 0.82, 0.76 }, 300); f.blurb:SetPoint("TOPRIGHT", -48, -60); f.blurb:SetJustifyH("RIGHT")
  local rule = colorTex(f, "ARTWORK", GOLD[1], GOLD[2], GOLD[3], 0.6)
  rule:SetHeight(1); rule:SetPoint("TOPLEFT", 20, -96); rule:SetPoint("TOPRIGHT", -20, -96)
  gradient(rule, "HORIZONTAL", GOLD[1], GOLD[2], GOLD[3], 0, GOLD[1], GOLD[2], GOLD[3], 0.8)
end

local function styleColumn(f)
  local col = CreateFrame("Frame", nil, f)
  col:SetPoint("TOPLEFT", 22, -110); col:SetSize(LEFT_W, H - 130)
  f.col = col
  text(col, "heading", "Your style", GOLD):SetPoint("TOPLEFT", 0, 0)
  f.bars = {}
  local barW = LEFT_W - 10
  for i, d in ipairs(DIMS) do
    local top = -30 - (i - 1) * 58
    local l = text(col, "body", d.label); l:SetPoint("TOPLEFT", 0, top)
    local v = text(col, "body", "-", GOLD); v:SetPoint("TOPRIGHT", col, "TOPLEFT", barW, top); v:SetJustifyH("RIGHT")
    local bg = colorTex(col, "ARTWORK", 0.16, 0.16, 0.2, 1); bg:SetSize(barW, 8); bg:SetPoint("TOPLEFT", 0, top - 18)
    local fill = colorTex(col, "OVERLAY", EMBER[1], EMBER[2], EMBER[3], 1); fill:SetSize(1, 8); fill:SetPoint("TOPLEFT", bg, "TOPLEFT")
    gradient(fill, "HORIZONTAL", 0.39, 0.15, 0.12, 1, 0.96, 0.83, 0.61, 1)
    local hint = text(col, "small", d.hint, GREY); hint:SetPoint("TOPLEFT", 0, top - 30)
    f.bars[d.key] = { value = v, fill = fill, width = barW }
  end
  f.observed = text(col, "small", nil, GREY, LEFT_W - 10); f.observed:SetPoint("TOPLEFT", 0, -324)
  f.tune = button(col, "Tune my style", 140); f.tune:SetPoint("TOPLEFT", 0, -360)
  f.tune:SetScript("OnClick", function() UI.showQuiz() end)
end

local VIEWS = { { key = "steps", label = "Next steps" }, { key = "build", label = "Build" }, { key = "ask", label = "Ask the Coach" } }

local function rightPanel(f)
  local p = CreateFrame("Frame", nil, f)
  p:SetPoint("TOPLEFT", LEFT_W + 40, -110); p:SetPoint("BOTTOMRIGHT", -20, 20)
  local bg = colorTex(p, "BACKGROUND", 0.07, 0.08, 0.11, 0.92); bg:SetAllPoints()
  border(p, GOLD[1], GOLD[2], GOLD[3], 0.25)
  f.panel = p
  f.tabs = {}
  local x = 14
  for _, v in ipairs(VIEWS) do
    local b = CreateFrame("Button", nil, p)
    b:SetSize(v.key == "ask" and 128 or 100, 28); b:SetPoint("TOPLEFT", x, -8)
    x = x + (v.key == "ask" and 128 or 100) + 6
    b.label = text(b, "heading", v.label, GREY); b.label:SetPoint("CENTER")
    b.under = colorTex(b, "ARTWORK", EMBER[1], EMBER[2], EMBER[3], 1); b.under:SetHeight(2); b.under:SetPoint("BOTTOMLEFT", 6, 0); b.under:SetPoint("BOTTOMRIGHT", -6, 0)
    b:SetScript("OnClick", function() UI.view(v.key) end)
    f.tabs[v.key] = b
  end
  f.canvas = canvas(p)
  -- Footer: actions for the current view.
  f.action = button(p, "", 170); f.action:SetPoint("BOTTOMLEFT", 12, 10)
  f.action2 = button(p, "", 170); f.action2:SetPoint("LEFT", f.action, "RIGHT", 8, 0)
  f.foot = text(p, "small", nil, GREY, W - LEFT_W - 90); f.foot:SetPoint("BOTTOMLEFT", 14, 40)

  -- Ask box (only shown on the Ask view).
  local box = CreateFrame("Frame", nil, p)
  box:SetPoint("TOPLEFT", 12, -44); box:SetPoint("TOPRIGHT", -14, -44); box:SetHeight(58)
  local boxBg = colorTex(box, "BACKGROUND", 0, 0, 0, 0.45); boxBg:SetAllPoints()
  border(box, GOLD[1], GOLD[2], GOLD[3], 0.4)
  local edit = CreateFrame("EditBox", nil, box)
  edit:SetPoint("TOPLEFT", 8, -6); edit:SetPoint("BOTTOMRIGHT", -8, 6)
  edit:SetMultiLine(true); edit:SetAutoFocus(false); edit:SetMaxLetters(500)
  edit:SetFontObject(ChatFontNormal or GameFontHighlight)
  edit:SetScript("OnEscapePressed", edit.ClearFocus)
  edit:SetScript("OnEnterPressed", function() UI.submit() end)
  local placeholder = text(box, "body", "Ask anything: talents, gear, where to level, how to beat a class...", GREY, 400)
  placeholder:SetPoint("TOPLEFT", 10, -8)
  edit:SetScript("OnTextChanged", function(self) if (self:GetText() or "") == "" then placeholder:Show() else placeholder:Hide() end end)
  box:EnableMouse(true); box:SetScript("OnMouseDown", function() edit:SetFocus() end)
  f.askBox, f.edit, f.placeholder = box, edit, placeholder
end

-- The quiz sits over the right panel.
local function quizPanel(f)
  local q = CreateFrame("Frame", nil, f)
  q:SetAllPoints(f.panel); q:SetFrameLevel((f.panel:GetFrameLevel() or 1) + 10)
  local bg = colorTex(q, "BACKGROUND", 0.06, 0.07, 0.1, 0.98); bg:SetAllPoints()
  border(q, EMBER[1], EMBER[2], EMBER[3], 0.6)
  q:EnableMouse(true)
  text(q, "heading", "How do you like to play?", GOLD):SetPoint("TOPLEFT", 14, -12)
  q.answers, q.groups = {}, {}
  local function choiceRow(top, key, labels, width, low, high)
    local row = { key = key, buttons = {} }
    for i, lab in ipairs(labels) do
      local b = CreateFrame("Button", nil, q, "UIPanelButtonTemplate")
      b:SetSize(width, 20); b:SetPoint("TOPLEFT", 14 + (i - 1) * (width + 4), top)
      b:SetText(lab)
      b:SetScript("OnClick", function() q.answers[key] = low and i or lab; UI.paintQuiz() end)
      row.buttons[i] = b
    end
    if low then
      local l = text(q, "small", low, GREY); l:SetPoint("TOPLEFT", 14, top - 22)
      local h = text(q, "small", high, GREY); h:SetPoint("TOPLEFT", 14 + 4 * (width + 4), top - 22)
    end
    q.groups[#q.groups + 1] = row
  end
  for i, item in ipairs(ns.coach.QUIZ) do
    local top = -40 - (i - 1) * 50
    local l = text(q, "body", item.q); l:SetPoint("TOPLEFT", 14, top)
    choiceRow(top - 16, item.key, { "1", "2", "3", "4", "5" }, 40, item.low, item.high)
  end
  local roleTop = -40 - 5 * 50
  text(q, "body", "Your role"):SetPoint("TOPLEFT", 14, roleTop)
  q.roleRow = #q.groups + 1
  choiceRow(roleTop - 16, "role", ns.coach.ROLES, 84)
  text(q, "body", "What you're mostly after"):SetPoint("TOPLEFT", 14, roleTop - 44)
  choiceRow(roleTop - 60, "goal", ns.coach.GOALS, 84)
  local save = button(q, "Save", 100); save:SetPoint("BOTTOMLEFT", 14, 10)
  save:SetScript("OnClick", function() ns.coach.saveQuiz(q.answers); q:Hide(); UI.refresh() end)
  local cancel = button(q, "Cancel", 100); cancel:SetPoint("LEFT", save, "RIGHT", 8, 0)
  cancel:SetScript("OnClick", function() q:Hide() end)
  q:Hide()
  f.quiz = q
end

local function create()
  local f = CreateFrame("Frame", "WowGuildCoach", UIParent)
  f:SetSize(W, H); f:SetPoint("CENTER", 0, 20); f:SetFrameStrata("DIALOG")
  f:SetMovable(true); f:EnableMouse(true); f:RegisterForDrag("LeftButton"); f:SetClampedToScreen(true)
  f:SetScript("OnDragStart", f.StartMoving); f:SetScript("OnDragStop", f.StopMovingOrSizing)
  tinsert(UISpecialFrames, "WowGuildCoach")
  local bg = colorTex(f, "BACKGROUND", 0.04, 0.05, 0.08, 0.97); bg:SetAllPoints()
  gradient(bg, "VERTICAL", 0.03, 0.04, 0.06, 0.98, 0.12, 0.10, 0.12, 0.98)
  local glow = colorTex(f, "BACKGROUND", 0.65, 0.29, 0.16, 0.10); glow:SetPoint("TOPLEFT"); glow:SetPoint("TOPRIGHT"); glow:SetHeight(100)
  gradient(glow, "VERTICAL", 0.65, 0.29, 0.16, 0, 0.65, 0.29, 0.16, 0.18)
  border(f, GOLD[1], GOLD[2], GOLD[3], 0.35)
  corners(f, 26)
  local close = CreateFrame("Button", nil, f, "UIPanelCloseButton"); close:SetPoint("TOPRIGHT", -4, -4)
  header(f); styleColumn(f); rightPanel(f); quizPanel(f)
  f:Hide()
  return f
end

function UI.window() win = win or create(); return win end

-- ---------- painting ----------
local function paintHeader(f)
  local ch = ns.coach.char()
  local _, class = UnitClass("player")
  local c = CLASS[class] or GOLD
  if SetPortraitTexture then pcall(SetPortraitTexture, f.portrait, "player") end
  f.name:SetText(UnitName("player") or "")
  f.name:SetTextColor(c[1], c[2], c[3])
  local trees = {}
  for _, t in ipairs((ch.talents and ch.talents.trees) or {}) do trees[#trees + 1] = t.name .. " " .. (t.points or 0) end
  local className = UnitClass("player") or ""
  f.sub:SetText(string.format("Level %d %s%s", UnitLevel("player") or 0, className, #trees > 0 and ("  -  " .. table.concat(trees, " / ")) or ""))
  local p = ch.profile or ns.coach.profile(ch)
  f.archetype:SetText(p and ("The " .. p.archetype) or "Still learning")
  f.blurb:SetText(p and p.blurb or "Play a little, or press 'Tune my style', and the Coach works out how you like to play.")
  for _, d in ipairs(DIMS) do
    local bar, v = f.bars[d.key], p and p.scores and p.scores[d.key]
    bar.value:SetText(v and tostring(v) or "-")
    bar.fill:SetWidth(math.max(1, bar.width * (v or 0) / 100))
  end
  local mins = math.floor((ch.obs and ch.obs.minutes) or 0)
  f.observed:SetText(string.format("Watched for %dh %02dm of play%s. Only outside combat.", math.floor(mins / 60), mins % 60, ch.quiz and ", plus your quiz" or ""))
end

local function stepsView(f, c)
  local steps = ns.coach.nextSteps()
  if #steps == 0 then c.text("body", "You're all set. Nothing urgent: go have fun.", GREY) end
  for i, s in ipairs(steps) do
    local top = c.y()
    c.icon(ICONS[s.kind] or ICONS.quiz, 30, 0, 2)
    c.setY(top)
    c.text("heading", s.title, GOLD, 42, 2)
    c.text("small", s.detail or "", { 0.85, 0.85, 0.85 }, 42, 4)
    if c.y() < top + 36 then c.setY(top + 36) end
    if i < #steps then c.line(0.12) end
  end
  f.action:SetText("Tell me how I play"); f.action:SetScript("OnClick", function() UI.showQuiz() end); f.action:Show()
  f.action2:Hide()
  f.foot:SetText("Checked now from your character, plus your build plan.")
end

local function buildView(f, c)
  local plan = ns.coach.plan()
  local ch = ns.coach.char()
  if not plan or plan.error then
    c.text("big", "No build plan yet", GOLD, 0, 8)
    if not ns.coach.aiEnabled() then
      c.text("body", "Your guild has switched the Coach AI off.", GREY)
    elseif plan and plan.error then
      c.text("body", "The last attempt didn't work: " .. tostring(plan.error), { 1, 0.5, 0.4 })
    else
      c.text("body", "The Coach writes your plan from your class, level, talents, gear and play style. "
        .. "With the Guild Camp app running, it arrives a minute or so after your next /reload or logout.", { 0.85, 0.85, 0.85 })
    end
  else
    c.text("big", plan.headline or "Your build", GOLD, 0, 6)
    c.text("body", plan.summary or "", { 0.9, 0.9, 0.9 }, 0, 6)
    local meta = {}
    if plan.spec and plan.spec ~= "" then meta[#meta + 1] = "|cffe8a33dFocus:|r " .. plan.spec end
    if plan.split and plan.split ~= "" then meta[#meta + 1] = plan.split end
    meta[#meta + 1] = plan.confidence == "forever" and "checked for WoW: Forever" or "based on Classic Era, Forever may differ"
    c.text("small", table.concat(meta, "   -   "), GREY, 0, 8)
    c.line()
    c.text("heading", "Talents, in order", GOLD, 0, 6)
    local taken = {}
    for _, t in ipairs((ch.talents and ch.talents.picked) or {}) do taken[string.lower(t.name)] = (t.rank or 0) >= (t.max or 99) end
    for i, t in ipairs(plan.talents or {}) do
      local top = c.y()
      local done = taken[string.lower(t.name or "")]
      if done then c.icon("Interface\\RaidFrame\\ReadyCheck-Ready", 16, 0, 1) else
        local n = c.text("heading", tostring(i), EMBER, 0, 0); n:SetWidth(24); c.setY(top) end
      c.text("body", (done and "|cff7f7f7f" or "") .. (t.name or "") .. (done and "|r" or "") .. "  |cff9e9ea8" .. (t.tree or "") .. ", " .. (t.points or 1) .. " pt" .. ((t.points or 1) == 1 and "" or "s") .. "|r", { 1, 1, 1 }, 26, 1)
      if t.why and t.why ~= "" then c.text("small", t.why, GREY, 26, 6) end
    end
    if plan.stats and #plan.stats > 0 then
      c.line()
      c.text("heading", "Stats that matter most", GOLD, 0, 4)
      local parts = {}
      for i, s in ipairs(plan.stats) do parts[#parts + 1] = "|cffe8a33d" .. i .. ".|r " .. s end
      c.text("body", table.concat(parts, "     "), { 1, 1, 1 }, 0, 6)
    end
    if plan.gear and #plan.gear > 0 then
      c.line()
      c.text("heading", "Gear", GOLD, 0, 4)
      for _, g in ipairs(plan.gear) do c.text("small", "|cffe8a33d" .. (g.slot or "") .. ":|r " .. (g.advice or ""), { 0.9, 0.9, 0.9 }, 0, 4) end
    end
    if plan.tips and #plan.tips > 0 then
      c.line()
      c.text("heading", "For how you play", GOLD, 0, 4)
      for _, t in ipairs(plan.tips) do c.text("small", "- " .. t, { 0.9, 0.9, 0.9 }, 0, 4) end
    end
  end
  f.action:SetText("Ask for a fresh plan"); f.action:SetScript("OnClick", function() ns.coach.requestPlan(); UI.refresh() end); f.action:Show()
  f.action2:Hide()
  -- Footer: where a requested plan is (waiting for a reload, or sent and on its way), else when the plan was made.
  local req, planAt = ch.planRequest, plan and plan.at
  local generated = (WowGuildInbox and WowGuildInbox.generatedAt) or 0
  local foot = ""
  if req and (not planAt or req > planAt) then
    foot = generated > req and "Fresh plan asked for. It arrives a minute or so after the Guild Camp app sends it: reload to check."
      or "Fresh plan asked for. Reload and the Guild Camp app sends it."
  elseif planAt then
    foot = "Made at level " .. (plan.level or "?") .. ", " .. date("%d %b", planAt)
  end
  f.foot:SetText(foot)
end

local function askView(f, c)
  local waiting = ns.coach.waiting()
  local unsent = 0
  for _, w in ipairs(waiting) do
    if w.state == "unsent" then unsent = unsent + 1 end
    c.text("body", w.text, GOLD, 0, 2)
    c.text("small", w.state == "unsent" and "Waiting to send: press 'Send now'. It reloads your UI so the Guild Camp app can send it."
      or "Sent. The Guild Camp app brings the answer back in a minute: press 'Check for answers'.", EMBER, 0, 8)
    c.line(0.12)
  end
  for _, a in ipairs(ns.coach.answers()) do
    if a.status ~= "pending" then
      c.text("body", a.q or "", GOLD, 0, 3)
      c.text("small", a.a or "", a.status == "failed" and { 1, 0.5, 0.4 } or { 0.92, 0.92, 0.92 }, 0, 3)
      c.text("small", (a.char and (a.char .. ", ") or "") .. (a.at and date("%d %b %H:%M", a.at) or ""), GREY, 0, 8)
      c.line(0.12)
    end
  end
  if #waiting == 0 and #ns.coach.answers() == 0 then
    c.text("small", "Questions go to your guild's Coach, which answers using your character and play style. "
      .. "The Guild Camp app sends them and brings the answers back: they show after a reload, and the app tells you when one arrives. "
      .. "For instant answers, use the Coach page in the Guild Camp app.", GREY)
  end
  f.action:SetText("Ask"); f.action:SetScript("OnClick", function() UI.submit() end); f.action:Show()
  f.action2:SetText(unsent > 0 and "Send now (reload)" or "Check for answers")
  f.action2:SetScript("OnClick", function() ReloadUI() end); f.action2:Show()
  f.foot:SetText(not ns.coach.aiEnabled() and "Your guild has switched the Coach AI off." or "")
end

function UI.view(key)
  local f = UI.window()
  UI.current = key or UI.current or "steps"
  for k, b in pairs(f.tabs) do
    local on = k == UI.current
    b.label:SetTextColor(unpack(on and GOLD or GREY))
    if on then b.under:Show() else b.under:Hide() end
  end
  local c = f.canvas
  if UI.current == "ask" then f.askBox:Show(); c.top(-110) else f.askBox:Hide(); c.top(-44) end
  c.reset()
  if UI.current == "steps" then stepsView(f, c) elseif UI.current == "build" then buildView(f, c) else askView(f, c) end
  c.done()
end

function UI.refresh()
  if not win or not win:IsShown() then return end
  paintHeader(win)
  UI.view()
end

function UI.submit()
  local f = UI.window()
  local t = f.edit:GetText()
  if ns.coach.ask(t) then
    f.edit:SetText(""); f.edit:ClearFocus()
    if f.placeholder then f.placeholder:Show() end
    ns.print("Question saved for the Coach. Press 'Send now' (or reload) and the Guild Camp app sends it.")
  end
  UI.view("ask")
end

function UI.paintQuiz()
  local q = UI.window().quiz
  for _, row in ipairs(q.groups) do
    for i, b in ipairs(row.buttons) do
      local v = q.answers[row.key]
      local on = (v == i) or (v == b:GetText())
      if on then b:LockHighlight() else b:UnlockHighlight() end
      local fs = b.GetFontString and b:GetFontString()
      if fs then fs:SetTextColor(unpack(on and GOLD or { 1, 1, 1 })) end
    end
  end
end

function UI.showQuiz()
  local f = UI.window()
  local saved = ns.coach.char().quiz or {}
  f.quiz.answers = {}
  for k, v in pairs(saved) do f.quiz.answers[k] = v end
  UI.paintQuiz()
  f.quiz:Show()
end

function UI.show(view)
  local f = UI.window()
  ns.coach.refresh()
  f:Show()
  paintHeader(f)
  UI.view(view)
end
function UI.toggle()
  local f = UI.window()
  if f:IsShown() then f:Hide() else UI.show() end
end
function WowGuild_ToggleCoach() UI.toggle() end
