-- Warband Codex › Talents: a talent calculator in the game, and what your trainer teaches next.
--   * The trees come from the game itself, so they are always Forever's real talents: logging in on a character
--     records its class's trees for the whole account. A class none of your characters has played shows a note.
--   * Plan a build with left-click (add) and right-click (remove); the game's rules are enforced (five points per
--     tier, prerequisites, your point budget). Three saved builds per class, and a build code to share.
--   * "Next" marks the first planned talent you haven't taken yet.
--   * Trainer: visiting your class trainer records the spells you can learn and their cost; Home reminds you.
local ADDON, ns = ...
local U = ns.ui
local T = {}
ns.talents = T

T.MAX_LEVEL = 60
T.BUILDS = 3

-- ---------- reading the game ----------
-- Record this class's trees: learned("talents")[CLASS] = { { name, icon, talents = { { name, icon, tier, col, max, req } } } }
function T.capture()
  if not (GetNumTalentTabs and GetNumTalents and GetTalentInfo) then return nil end
  local tabs = {}
  for tab = 1, ns.n(ns.try(GetNumTalentTabs)) or 0 do
    local name, _, icon = ns.talentTab(tab)
    local t = { name = name or ("Tree " .. tab), icon = icon, talents = {} }
    for i = 1, ns.n(ns.try(GetNumTalents, tab)) or 0 do
      local tname, ticon, tier, col, _, max = ns.try(GetTalentInfo, tab, i)
      if tname then
        local reqTier, reqCol = nil, nil
        if GetTalentPrereqs then reqTier, reqCol = ns.try(GetTalentPrereqs, tab, i) end
        t.talents[i] = { name = tname, icon = ticon, tier = tonumber(tier) or 1, col = tonumber(col) or 1, max = tonumber(max) or 1,
          reqTier = tonumber(reqTier), reqCol = tonumber(reqCol) }
      end
    end
    tabs[#tabs + 1] = t
  end
  if #tabs == 0 then return nil end
  -- Prerequisites as an index into the same tree.
  for _, t in ipairs(tabs) do
    for _, tal in ipairs(t.talents) do
      if tal.reqTier and tal.reqCol then
        for j, other in ipairs(t.talents) do
          if other.tier == tal.reqTier and other.col == tal.reqCol then tal.req = j end
        end
      end
      tal.reqTier, tal.reqCol = nil, nil
    end
  end
  ns.learned("talents")[ns.class()] = tabs
  return tabs
end
function T.tree(class) return ns.learned("talents")[class or ns.class()] end
-- Points I have really spent: → { ["tab.index"] = rank }
function T.spent()
  local out = {}
  if not GetTalentInfo then return out end
  local tree = T.tree() or {}
  for tab, t in ipairs(tree) do
    for i in ipairs(t.talents) do
      local _, _, _, _, rank = ns.try(GetTalentInfo, tab, i)
      if (tonumber(rank) or 0) > 0 then out[tab .. "." .. i] = tonumber(rank) end
    end
  end
  return out
end
function T.unspent()
  if UnitCharacterPoints then return tonumber((ns.try(UnitCharacterPoints, "player"))) or 0 end
  if GetUnspentTalentPoints then return ns.n(ns.try(GetUnspentTalentPoints)) or 0 end
  return 0
end

-- ---------- builds ----------
local function plans(class)
  local all = ns.ensure(ns.db, "plans")
  local p = ns.ensure(all, class)
  ns.ensure(p, "builds")
  p.active = p.active or 1
  return p
end
function T.build(class, n)
  local p = plans(class)
  n = n or p.active
  local b = ns.ensure(p.builds, n)
  ns.ensure(b, "pts")
  return b
end
function T.setActive(class, n) plans(class).active = math.max(1, math.min(T.BUILDS, n)) end
function T.active(class) return plans(class).active end

local function pointsIn(tree, pts, tab, belowTier)
  local sum = 0
  for i, tal in ipairs(tree[tab].talents) do
    if not belowTier or tal.tier < belowTier then sum = sum + (pts[tab .. "." .. i] or 0) end
  end
  return sum
end
function T.total(tree, pts)
  local sum, per = 0, {}
  for tab in ipairs(tree) do per[tab] = pointsIn(tree, pts, tab); sum = sum + per[tab] end
  return sum, per
end
function T.budget() return math.max(0, T.MAX_LEVEL - 9) end
-- The level a build needs: the first talent point comes at level 10.
function T.levelFor(points) return points > 0 and points + 9 or 0 end

-- Can one more point go into this talent? → true, or false and why.
function T.canAdd(tree, pts, tab, i)
  local tal = tree[tab] and tree[tab].talents[i]
  if not tal then return false, "No such talent." end
  local key = tab .. "." .. i
  if (pts[key] or 0) >= tal.max then return false, "Already at its top rank." end
  if T.total(tree, pts) >= T.budget() then return false, "No points left at level " .. T.MAX_LEVEL .. "." end
  local need = (tal.tier - 1) * 5
  if pointsIn(tree, pts, tab, tal.tier) < need then return false, string.format("Needs %d points in %s first.", need, tree[tab].name) end
  if tal.req then
    local r = tree[tab].talents[tal.req]
    if r and (pts[tab .. "." .. tal.req] or 0) < r.max then return false, "Needs " .. r.name .. " at its top rank first." end
  end
  return true
end
-- Can a point come out? Not if a deeper tier or a dependent talent still rests on it.
function T.canRemove(tree, pts, tab, i)
  local key = tab .. "." .. i
  if (pts[key] or 0) <= 0 then return false, "No points in it." end
  local tal = tree[tab].talents[i]
  for j, other in ipairs(tree[tab].talents) do
    if other.req == i and (pts[tab .. "." .. j] or 0) > 0 then return false, other.name .. " depends on it." end
  end
  pts[key] = pts[key] - 1
  local ok = true
  for j, other in ipairs(tree[tab].talents) do
    if (pts[tab .. "." .. j] or 0) > 0 and other.tier > tal.tier and pointsIn(tree, pts, tab, other.tier) < (other.tier - 1) * 5 then ok = false end
  end
  pts[key] = pts[key] + 1
  if not ok then return false, "Talents further down the tree need these points." end
  return true
end
function T.add(class, tab, i)
  local tree, b = T.tree(class), T.build(class)
  if not tree then return false, "Tree not recorded." end
  local ok, why = T.canAdd(tree, b.pts, tab, i)
  if ok then b.pts[tab .. "." .. i] = (b.pts[tab .. "." .. i] or 0) + 1 end
  return ok, why
end
function T.remove(class, tab, i)
  local tree, b = T.tree(class), T.build(class)
  if not tree then return false, "Tree not recorded." end
  local ok, why = T.canRemove(tree, b.pts, tab, i)
  if ok then
    local key = tab .. "." .. i
    b.pts[key] = b.pts[key] - 1
    if b.pts[key] == 0 then b.pts[key] = nil end
  end
  return ok, why
end
function T.reset(class) T.build(class).pts = {} end

-- A build as text: CLASS:digits-digits-digits (one digit per talent, in the game's order).
function T.code(class)
  local tree, b = T.tree(class), T.build(class)
  if not tree then return "" end
  local parts = {}
  for tab, t in ipairs(tree) do
    local s = {}
    for i in ipairs(t.talents) do s[#s + 1] = tostring(b.pts[tab .. "." .. i] or 0) end
    parts[#parts + 1] = (string.gsub(table.concat(s), "0+$", ""))
  end
  return class .. ":" .. table.concat(parts, "-")
end
-- Load a build code into the active build; every point is checked against the rules. → true or false, why
function T.load(code)
  local class, rest = string.match(tostring(code or ""), "^%s*(%u+):([%d%-]*)%s*$")
  local tree = class and T.tree(class)
  if not tree then return false, "That isn't a build code for a class the Codex has recorded." end
  local want, tab = {}, 1
  for part in string.gmatch(rest .. "-", "(%d*)%-") do
    for i = 1, #part do want[tab .. "." .. i] = tonumber(string.sub(part, i, i)) end
    tab = tab + 1
  end
  local pts = {}
  local progress = true
  while progress do
    progress = false
    for t, tr in ipairs(tree) do
      for i in ipairs(tr.talents) do
        local key = t .. "." .. i
        if (pts[key] or 0) < (want[key] or 0) and T.canAdd(tree, pts, t, i) then pts[key] = (pts[key] or 0) + 1; progress = true end
      end
    end
  end
  for key, n in pairs(want) do if (pts[key] or 0) ~= n then return false, "That build breaks the talent rules." end end
  T.build(class).pts = pts
  return true, class
end

-- The first planned talent (top of the tree first) I haven't fully taken: → { tab, index, name, have, want }
function T.nextPoint()
  local class = ns.class()
  local tree = T.tree(class)
  if not tree then return nil end
  local pts, spent = T.build(class).pts, T.spent()
  local best
  for tab, t in ipairs(tree) do
    for i, tal in ipairs(t.talents) do
      local key = tab .. "." .. i
      if (pts[key] or 0) > (spent[key] or 0) and T.canAdd(tree, spent, tab, i) then
        if not best or tal.tier < best.tier then best = { tab = tab, index = i, name = tal.name, have = spent[key] or 0, want = pts[key], tier = tal.tier } end
      end
    end
  end
  return best
end

-- ---------- the class trainer ----------
local STATES = { available = true, unavailable = true, used = true }
ns.on("TRAINER_SHOW", function()
  if IsTradeskillTrainer and ns.try(IsTradeskillTrainer) then return end
  if not (GetNumTrainerServices and GetTrainerServiceInfo) then return end
  local list = {}
  for i = 1, ns.n(ns.try(GetNumTrainerServices)) or 0 do
    local a, b, c = ns.try(GetTrainerServiceInfo, i)
    local state = (STATES[b] and b) or (STATES[c] and c) or nil
    if a and state and state ~= "used" then
      list[#list + 1] = { name = a, sub = (not STATES[b] and type(b) == "string") and b or "", state = state,
        cost = tonumber(GetTrainerServiceCost and ns.try(GetTrainerServiceCost, i)) or 0,
        level = tonumber(GetTrainerServiceLevelReq and ns.try(GetTrainerServiceLevelReq, i)) or 0 }
    end
  end
  ns.char().trainer = { at = ns.now(), list = list }
  ns.shell.refresh("talents")
end)
-- Spells my trainer has for me: → ready (can learn now), later (higher level), total cost of ready
function T.trainer()
  local saved = ns.char().trainer
  local ready, later, cost = {}, {}, 0
  if type(saved) ~= "table" then return ready, later, cost, nil end
  local lvl = ns.level()
  for _, s in ipairs(saved.list or {}) do
    if s.state == "available" or (s.level > 0 and s.level <= lvl) then ready[#ready + 1] = s; cost = cost + s.cost
    else later[#later + 1] = s end
  end
  table.sort(later, function(a, b) if a.level ~= b.level then return a.level < b.level end return a.name < b.name end)
  return ready, later, cost, saved.at
end

ns.on("PLAYER_LOGIN", function() T.capture() end)
ns.on("CHARACTER_POINTS_CHANGED", function() T.capture(); ns.shell.refresh("talents") end)

-- ---------- page ----------
local M = ns.module{ id = "talents", title = "Talents", icon = "Ability_Marksmanship",
  blurb = "Plan builds for any class you've played, and see what your trainer teaches next.", keywords = "talent calculator build spec trainer spells" }

function M.steps()
  local out = {}
  local un = T.unspent()
  if un > 0 then
    local nx = T.nextPoint()
    out[#out + 1] = { text = un .. (un == 1 and " talent point" or " talent points") .. " to spend" .. (nx and (": your build says " .. nx.name .. ".") or "."), icon = "Ability_Marksmanship" }
  end
  local ready, _, cost = T.trainer()
  if #ready > 0 then out[#out + 1] = { text = string.format("Your trainer has %d spell%s for you (%s).", #ready, #ready == 1 and "" or "s", ns.money(cost)), icon = "INV_Misc_Book_08" } end
  return out
end
function M.badge() local un = T.unspent(); return un > 0 and un or nil end
function M.search(q)
  local out = {}
  for class, tree in pairs(ns.learned("talents")) do
    for tab, t in ipairs(tree) do
      for _, tal in ipairs(t.talents) do
        if ns.matches(tal.name, q) then
          out[#out + 1] = { label = tal.name, sub = (ns.data.classNames[class] or class) .. ", " .. t.name, icon = tal.icon, go = function() M.pickClass(class) end }
        end
      end
    end
  end
  return out
end

local CELL, GAP = 34, 6
local body_
function M.pickClass(class) if body_ then body_.class = class; body_.view = "calc"; M.refresh(body_) end end

local function talentButton(parent)
  local b = CreateFrame("Button", nil, parent)
  b:SetSize(CELL, CELL)
  b.icon = U.icon(b, CELL); b.icon:SetPoint("CENTER")
  b.ring = U.tex(b, "OVERLAY", 1, 1, 1, 0); b.ring:SetPoint("TOPLEFT", -2, 2); b.ring:SetPoint("BOTTOMRIGHT", 2, -2)
  if b.ring.SetDrawLayer then b.ring:SetDrawLayer("BACKGROUND") end
  b.count = U.text(b, "small", "", "text"); b.count:SetPoint("BOTTOMRIGHT", 2, -3)
  if b.RegisterForClicks then b:RegisterForClicks("LeftButtonUp", "RightButtonUp") end
  b:SetScript("OnClick", function(self, which)
    local body = body_
    local ok, why
    if which == "RightButton" then ok, why = T.remove(body.class, self.tab, self.index)
    else ok, why = T.add(body.class, self.tab, self.index) end
    body.msg = ok and "" or why
    M.refresh(body)
  end)
  b:SetScript("OnEnter", function(self)
    if not (GameTooltip and GameTooltip.SetOwner and self.tal) then return end
    GameTooltip:SetOwner(self, "ANCHOR_RIGHT")
    GameTooltip:SetText(self.tal.name, 1, 1, 1)
    if GameTooltip.AddLine then
      GameTooltip:AddLine(string.format("Planned %d of %d", self.points or 0, self.tal.max), 0.9, 0.8, 0.5)
      GameTooltip:AddLine("Left-click adds a point, right-click removes one.", 0.6, 0.6, 0.6)
    end
    GameTooltip:Show()
  end)
  b:SetScript("OnLeave", function() if GameTooltip and GameTooltip.Hide then GameTooltip:Hide() end end)
  return b
end

function M.build(body)
  body_ = body
  body.class, body.view, body.msg = ns.class(), "calc", ""
  body.views = U.chips(body, { { "calc", "Calculator" }, { "trainer", "Trainer" } }, function(k) body.view = k; M.refresh(body) end)
  body.views:SetPoint("TOPLEFT")

  local calc = CreateFrame("Frame", nil, body)
  calc:SetPoint("TOPLEFT", 0, -30); calc:SetPoint("BOTTOMRIGHT")
  body.calc = calc
  local classes = {}
  for _, c in ipairs({ "WARRIOR", "PALADIN", "HUNTER", "ROGUE", "PRIEST", "SHAMAN", "MAGE", "WARLOCK", "DRUID" }) do classes[#classes + 1] = { c, ns.data.classNames[c] } end
  calc.classes = U.chips(calc, classes, function(c) body.class = c; body.msg = ""; M.refresh(body) end)
  calc.classes:SetPoint("TOPLEFT")
  local builds = {}
  for i = 1, T.BUILDS do builds[i] = { i, "Build " .. i } end
  calc.builds = U.chips(calc, builds, function(n) T.setActive(body.class, n); body.msg = ""; M.refresh(body) end)
  calc.builds:SetPoint("TOPLEFT", 0, -30)
  calc.reset = U.button(calc, "Clear", function() T.reset(body.class); body.msg = ""; M.refresh(body) end, { w = 60, h = 22 })
  calc.reset:SetPoint("LEFT", calc.builds, "RIGHT", 8, 0)
  calc.summary = U.text(calc, "sub", "", "text"); calc.summary:SetPoint("LEFT", calc.reset, "RIGHT", 14, 0)
  calc.code = U.edit(calc, 250, "Paste a build code and press Enter", nil, function(text)
    local ok, why = T.load(text)
    if ok then body.class = why; body.msg = "Build loaded." else body.msg = why end
    M.refresh(body)
  end)
  calc.code:SetPoint("TOPRIGHT", 0, -30)
  calc.msg = U.text(calc, "small", "", "accent"); calc.msg:SetPoint("TOPLEFT", 0, -58); calc.msg:SetPoint("TOPRIGHT", 0, -58)
  calc.none = U.empty(calc, ""); calc.none:SetPoint("TOPLEFT", 0, -90); calc.none:SetPoint("TOPRIGHT", 0, -90)

  calc.trees = {}
  for tab = 1, 3 do
    local col = U.card(calc)
    col:SetPoint("TOPLEFT", (tab - 1) * 240, -78); col:SetSize(230, 330)
    col.name = U.text(col, "heading", "", "line"); col.name:SetPoint("TOPLEFT", 10, -8)
    col.pts = U.text(col, "num", "", "accent"); col.pts:SetPoint("TOPRIGHT", -10, -9); col.pts:SetJustifyH("RIGHT")
    col.buttons = {}
    calc.trees[tab] = col
  end

  local tr = CreateFrame("Frame", nil, body)
  tr:SetPoint("TOPLEFT", 0, -30); tr:SetPoint("BOTTOMRIGHT")
  body.trainer = tr
  tr.note = U.empty(tr, ""); tr.note:SetPoint("TOPLEFT"); tr.note:SetPoint("TOPRIGHT")
  tr.list = U.list(tr, 28, function(list, i)
    local r = U.row(list, i)
    r.name = U.text(r, "body", "", "text"); r.name:SetPoint("LEFT", 10, 0); r.name:SetPoint("RIGHT", -170, 0)
    r.when = U.text(r, "small", "", "dim"); r.when:SetPoint("RIGHT", -90, 0); r.when:SetJustifyH("RIGHT")
    r.cost = U.text(r, "small", "", "accent"); r.cost:SetPoint("RIGHT", -8, 0); r.cost:SetJustifyH("RIGHT")
    return r
  end, function(r, s)
    r.name:SetText(s.name .. ((s.sub and s.sub ~= "") and ("  |cff999999" .. s.sub .. "|r") or ""))
    r.name:SetTextColor(U.c(s.ready and "good" or "text"))
    r.when:SetText(s.ready and "Learn now" or (s.level > 0 and ("Level " .. s.level) or "Later"))
    r.cost:SetText(ns.money(s.cost))
  end, 14)
  tr.list:SetPoint("TOPLEFT", 0, -26); tr.list:SetPoint("BOTTOMRIGHT")
end

function M.refresh(body)
  body.views.pick(body.view, true)
  if body.view == "trainer" then
    body.calc:Hide(); body.trainer:Show()
    local ready, later, cost, at = T.trainer()
    local rows = {}
    for _, s in ipairs(ready) do rows[#rows + 1] = { name = s.name, sub = s.sub, cost = s.cost, level = s.level, ready = true } end
    for _, s in ipairs(later) do rows[#rows + 1] = s end
    body.trainer.note:SetText(not at and "Visit your class trainer once: the Codex records what they teach and what it costs."
      or (#ready > 0 and string.format("%d to learn now for %s. Recorded at your last trainer visit.", #ready, ns.money(cost)) or "Nothing to learn right now. Recorded at your last trainer visit."))
    body.trainer.list.set(rows)
    return
  end
  body.trainer:Hide(); body.calc:Show()
  local calc, class = body.calc, body.class
  calc.classes.pick(class, true)
  calc.builds.pick(T.active(class), true)
  local tree = T.tree(class)
  calc.msg:SetText(body.msg or "")
  if not tree then
    for _, col in ipairs(calc.trees) do col:Hide() end
    calc.summary:SetText("")
    calc.none:SetText("The Codex hasn't seen the " .. (ns.data.classNames[class] or class) .. " talents yet. Log in on one once (any level) and its trees are recorded for all your characters.")
    calc.none:Show()
    return
  end
  calc.none:Hide()
  local pts = T.build(class).pts
  local total, per = T.total(tree, pts)
  calc.summary:SetText(string.format("%d / %d points   ·   needs level %d", total, T.budget(), T.levelFor(total)))
  if not (calc.code.HasFocus and calc.code:HasFocus()) then calc.code:SetText(total > 0 and T.code(class) or "") end
  local nx = class == ns.class() and T.nextPoint() or nil
  for tab = 1, 3 do
    local col, t = calc.trees[tab], tree[tab]
    if t then
      col:Show()
      col.name:SetText(t.name); col.pts:SetText(tostring(per[tab] or 0))
      local rows = 1
      for i, tal in ipairs(t.talents) do
        local b = col.buttons[i] or talentButton(col)
        col.buttons[i] = b
        b.tab, b.index, b.tal = tab, i, tal
        b.points = pts[tab .. "." .. i] or 0
        b:ClearAllPoints()
        b:SetPoint("TOPLEFT", 20 + (tal.col - 1) * (CELL + GAP + 12), -36 - (tal.tier - 1) * (CELL + GAP))
        b.icon.set(tal.icon)
        b.count:SetText(b.points .. "/" .. tal.max)
        local can = T.canAdd(tree, pts, tab, i)
        local r, g, bl = U.c(b.points >= tal.max and "accent" or (b.points > 0 and "good" or "dim"))
        U.color(b.ring, r, g, bl, (b.points > 0 or can) and 0.9 or 0)
        if b.icon.tex.SetDesaturated then b.icon.tex:SetDesaturated(b.points == 0 and not can) end
        if b.SetAlpha then b:SetAlpha((b.points > 0 or can) and 1 or 0.45) end
        if nx and nx.tab == tab and nx.index == i then local ar, ag, ab = U.c("bad"); U.color(b.ring, ar, ag, ab, 1) end
        b:Show()
        if tal.tier > rows then rows = tal.tier end
      end
      for i = #t.talents + 1, #col.buttons do col.buttons[i]:Hide() end
      col:SetHeight(48 + rows * (CELL + GAP))
    else col:Hide() end
  end
  if nx and (body.msg or "") == "" then calc.msg:SetText("Next point for your build: " .. nx.name .. " (outlined).") end
end
