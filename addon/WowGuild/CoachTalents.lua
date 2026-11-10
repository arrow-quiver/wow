-- Guild Camp: the Coach beside the talent window. Shows the next talent your build plan wants, the plan's order
-- with the ones you've taken ticked, and (where the game's talent buttons can be found) a glow on that talent.
local ADDON, ns = ...
local S = ns.skin
local T = {}
ns.coachTalents = T

local ROWS = 15

-- Where you are in the plan: the first talent with fewer points than the plan wants.
-- → { next = { name, tree, points, why, have }, rows = { { name, tree, points, why, have, done } }, unspent }
function T.progress()
  local plan = ns.coach and ns.coach.plan()
  if not plan or type(plan.talents) ~= "table" or #plan.talents == 0 then return nil end
  local t = ns.coach.readTalents()
  local have = {}
  for _, x in ipairs(t.picked or {}) do have[string.lower(x.name)] = x.rank or 0 end
  local out = { rows = {}, unspent = t.unspent, plan = plan }
  for _, p in ipairs(plan.talents) do
    local h = have[string.lower(p.name or "")] or 0
    local row = { name = p.name, tree = p.tree, points = p.points or 1, why = p.why, have = h, done = h >= (p.points or 1) }
    out.rows[#out.rows + 1] = row
    if not row.done and not out.next then out.next = row end
  end
  return out
end

-- ---------- panel ----------
local panel
local function create(parent)
  local f = CreateFrame("Frame", "WowGuildCoachTalents", parent or UIParent)
  f:SetSize(260, 120 + ROWS * 22); f:SetFrameStrata("HIGH")
  S.panel(f)
  f.title = S.text(f, "heading", "Coach", S.GOLD); f.title:SetPoint("TOPLEFT", 12, -10)
  f.sub = S.text(f, "small", "", { 0.62, 0.62, 0.66 }); f.sub:SetPoint("TOPLEFT", 12, -30); f.sub:SetWidth(236)
  f.next = S.text(f, "body", "", S.EMBER); f.next:SetPoint("TOPLEFT", 12, -52); f.next:SetWidth(236)
  f.why = S.text(f, "small", "", { 0.85, 0.85, 0.85 }); f.why:SetPoint("TOPLEFT", 12, -70); f.why:SetWidth(236)
  if f.why.SetWordWrap then f.why:SetWordWrap(true) end
  S.rule(f, -98, 8)
  f.rows = {}
  for i = 1, ROWS do
    local r = CreateFrame("Frame", nil, f)
    r:SetSize(236, 20); r:SetPoint("TOPLEFT", 12, -104 - (i - 1) * 22)
    r.mark = S.text(r, "small", ""); r.mark:SetPoint("LEFT", 0, 0); r.mark:SetWidth(18)
    r.name = S.text(r, "small", ""); r.name:SetPoint("LEFT", 20, 0); r.name:SetWidth(160)
    if r.name.SetWordWrap then r.name:SetWordWrap(false) end
    r.pts = S.text(r, "small", "", { 0.62, 0.62, 0.66 }); r.pts:SetPoint("RIGHT", 0, 0); r.pts:SetJustifyH("RIGHT")
    f.rows[i] = r
  end
  f.open = CreateFrame("Button", nil, f, "UIPanelButtonTemplate"); f.open:SetSize(130, 22); f.open:SetPoint("BOTTOMLEFT", 12, 10)
  f.open:SetText("Open the Coach"); f.open:SetScript("OnClick", function() ns.coachUI.show("build") end)
  f:Hide()
  return f
end
function T.panel(parent) panel = panel or create(parent); return panel end

function T.refresh()
  local f = T.panel()
  local p = T.progress()
  for _, r in ipairs(f.rows) do r:Hide() end
  if not p then
    f.sub:SetText("No build plan yet.")
    f.next:SetText("Ask for one in the Coach (/wow coach).")
    f.why:SetText("Your plan arrives after a /reload with the Guild Camp app running.")
    return p
  end
  f.sub:SetText((p.plan.spec and p.plan.spec ~= "" and (p.plan.spec .. "  ") or "") .. (p.plan.split or "")
    .. (p.unspent and string.format("  -  %d to spend", p.unspent) or ""))
  if p.next then
    f.next:SetText(string.format("Next: %s  (%d/%d)", p.next.name, p.next.have, p.next.points))
    f.why:SetText(p.next.why or "")
  else
    f.next:SetText("Every talent in your plan is taken.")
    f.why:SetText("Ask the Coach for a fresh plan when you level up.")
  end
  for i, row in ipairs(p.rows) do
    if i > ROWS then break end
    local r = f.rows[i]
    if row.done then
      r.mark:SetText("|cff73c088+|r"); r.name:SetText("|cff8a8a8a" .. row.name .. "|r")
    elseif row == p.next then
      r.mark:SetText("|cffe8a33d>|r"); r.name:SetText("|cffffffff" .. row.name .. "|r")
    else
      r.mark:SetText(tostring(i)); r.name:SetText("|cffd0d0d0" .. row.name .. "|r")
    end
    r.pts:SetText(string.format("%d/%d", math.min(row.have, row.points), row.points))
    r:Show()
  end
  T.glow(p.next)
  return p
end

-- ---------- glow on the next talent (best effort; the talent window differs between game versions) ----------
local glowTex
local function talentFrame() return _G.PlayerTalentFrame or _G.TalentFrame end

local function selectedTab(frame)
  if PanelTemplates_GetSelectedTab then local t = ns.try(PanelTemplates_GetSelectedTab, frame); if t then return t end end
  return frame.selectedTab or frame.talentTab or 1
end

function T.glow(nextRow)
  if glowTex then glowTex:Hide() end
  local frame = talentFrame()
  if not nextRow or not frame or not frame.IsShown or not frame:IsShown() or not GetTalentInfo then return end
  local tab = selectedTab(frame)
  local function scan(parent, depth)
    if depth > 4 or not parent.GetChildren then return nil end
    for _, child in ipairs({ parent:GetChildren() }) do
      if child.GetID and child.IsShown and child:IsShown() then
        local id = child:GetID()
        if type(id) == "number" and id > 0 then
          local r = { ns.try(GetTalentInfo, tab, id) }
          local name = type(r[1]) == "string" and r[1] or r[2]
          if name == nextRow.name then return child end
        end
      end
      local found = scan(child, depth + 1)
      if found then return found end
    end
  end
  local button = scan(frame, 1)
  if not button then return end
  -- The glow is a frame of ours laid over the button, never something added to Blizzard's talent button: writing to
  -- a Blizzard frame taints it, and the game then blocks learning talents and blames this addon.
  glowTex = glowTex or CreateFrame("Frame", "WowGuildCoachGlow", UIParent)
  if glowTex.SetFrameStrata and frame.GetFrameStrata then glowTex:SetFrameStrata(frame:GetFrameStrata() or "HIGH") end
  if glowTex.SetFrameLevel and button.GetFrameLevel then glowTex:SetFrameLevel((button:GetFrameLevel() or 1) + 5) end
  if glowTex.EnableMouse then glowTex:EnableMouse(false) end
  glowTex.tex = glowTex.tex or glowTex:CreateTexture(nil, "OVERLAY")
  glowTex.tex:SetAllPoints()
  glowTex.tex:SetTexture("Interface\\Buttons\\CheckButtonHilight")
  if glowTex.tex.SetBlendMode then glowTex.tex:SetBlendMode("ADD") end
  glowTex:ClearAllPoints(); glowTex:SetPoint("TOPLEFT", button, -6, 6); glowTex:SetPoint("BOTTOMRIGHT", button, 6, -6)
  glowTex:Show()
  T.glowing = nextRow.name
end

-- ---------- hooks ----------
local hooked = {}
local function attach()
  local frame = talentFrame()
  if not frame or hooked[frame] then return end
  hooked[frame] = true
  frame:HookScript("OnShow", function()
    if ns.opt("coachTalents") == false then return end
    local f = T.panel()
    f:ClearAllPoints(); f:SetPoint("TOPLEFT", frame, "TOPRIGHT", 4, 0)
    T.refresh(); f:Show()
  end)
  frame:HookScript("OnHide", function() if panel then panel:Hide() end; if glowTex then glowTex:Hide() end end)
  -- Switching talent tabs redraws the buttons: move the glow with them.
  if hooksecurefunc and _G.PlayerTalentFrame_Update then
    hooksecurefunc("PlayerTalentFrame_Update", function() if panel and panel:IsShown() then local p = T.progress(); T.glow(p and p.next) end end)
  end
end
T.attach = attach

ns.on("ADDON_LOADED", function(name)
  if name == "Blizzard_TalentUI" or name == "Blizzard_ClassTalentUI" then attach() end
end)
ns.on("PLAYER_LOGIN", function() attach() end)
local function changed() if panel and panel:IsShown() then T.refresh() end end
ns.on("CHARACTER_POINTS_CHANGED", changed)
ns.on("PLAYER_TALENT_UPDATE", changed)
