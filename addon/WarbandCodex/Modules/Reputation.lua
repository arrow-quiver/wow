-- Warband Codex › Reputation: every faction you've met with a bar to the next standing, and for the factions with
-- rewards (Data/Factions.lua): how to earn it, who sells the rewards and what each standing opens. A reward
-- vendor's spot is remembered when you open their window, and "Map" pins it.
local ADDON, ns = ...
local U = ns.ui
local R = {}
ns.reputation = R

-- → { { name, standing (1..8), label, cur, max, header } } in the game's order
function R.standings()
  local out = {}
  if C_Reputation and C_Reputation.GetNumFactions and C_Reputation.GetFactionDataByIndex then
    for i = 1, ns.n(ns.try(C_Reputation.GetNumFactions)) or 0 do
      local f = ns.try(C_Reputation.GetFactionDataByIndex, i)
      if type(f) == "table" and f.name and not f.isHeader then
        local lo, hi = tonumber(f.currentReactionThreshold) or 0, tonumber(f.nextReactionThreshold) or 0
        out[#out + 1] = { name = f.name, standing = tonumber(f.reaction) or 4, cur = (tonumber(f.currentStanding) or 0) - lo, max = math.max(0, hi - lo) }
      end
    end
  elseif GetNumFactions and GetFactionInfo then
    for i = 1, ns.n(ns.try(GetNumFactions)) or 0 do
      local name, _, standing, lo, hi, value, _, _, isHeader, _, hasRep = ns.try(GetFactionInfo, i)
      if name and (not isHeader or hasRep) then
        out[#out + 1] = { name = name, standing = tonumber(standing) or 4, cur = (tonumber(value) or 0) - (tonumber(lo) or 0), max = math.max(0, (tonumber(hi) or 0) - (tonumber(lo) or 0)) }
      end
    end
  end
  for _, f in ipairs(out) do f.label = ns.data.standings[f.standing] or "?" end
  return out
end
function R.info(name)
  for _, f in ipairs(ns.data.factions) do if f.name == name then return f end end
  return nil
end
local function rankOf(label)
  for i, s in ipairs(ns.data.standings) do if s == label then return i end end
  return 0
end
-- The page's rows: factions I have standing with, then reward factions I haven't met (my side only).
function R.rows()
  local rows, seen = {}, {}
  for _, f in ipairs(R.standings()) do
    seen[f.name] = true
    f.info = R.info(f.name)
    rows[#rows + 1] = f
  end
  for _, info in ipairs(ns.data.factions) do
    if not seen[info.name] and (not info.side or info.side == ns.faction()) then
      rows[#rows + 1] = { name = info.name, info = info, unmet = true, standing = 4, label = "Not met yet", cur = 0, max = 0 }
    end
  end
  table.sort(rows, function(a, b)
    local ai, bi = a.info and 1 or 0, b.info and 1 or 0
    if ai ~= bi then return ai > bi end
    if (a.unmet or false) ~= (b.unmet or false) then return not a.unmet end
    return a.name < b.name
  end)
  return rows
end
-- The next reward standing still ahead of me: → "Revered", what
function R.nextReward(f)
  if not f.info then return nil end
  for _, rw in ipairs(f.info.rewards) do
    if rankOf(rw[1]) > f.standing then return rw[1], rw[2] end
  end
  return nil
end

ns.on("MERCHANT_SHOW", function()
  local name = UnitName and UnitName("npc")
  if not name then return end
  for _, f in ipairs(ns.data.factions) do
    if f.vendor == name then
      local spot = ns.where()
      if spot and spot.x then ns.learned("vendors")[name] = { map = spot.map, x = spot.x, y = spot.y, zone = ns.zone() } end
    end
  end
end)
ns.on("UPDATE_FACTION", function() ns.shell.refresh("reputation") end)

-- ---------- page ----------
local M = ns.module{ id = "reputation", title = "Reputation", icon = "Achievement_Reputation_01",
  blurb = "Your standings, how to raise them, and what each one opens.", keywords = "faction standing rewards quartermaster vendor exalted" }

function M.search(q)
  local out = {}
  for _, f in ipairs(R.rows()) do
    local info = f.info
    if ns.matches(f.name .. " " .. (info and (info.vendor .. " " .. info.where) or ""), q) then
      out[#out + 1] = { label = f.name, sub = f.label .. (info and ("  ·  " .. info.vendor) or ""), icon = "Interface\\Icons\\Achievement_Reputation_01", go = function() M.pick(f.name) end }
    end
  end
  return out
end

local body_
function M.pick(name) if body_ then body_.picked = name; M.refresh(body_) end end

local BAR_COLOR = { "bad", "bad", "bad", "dim", "good", "good", "accent", "accent" }

function M.build(body)
  body_ = body
  body.list = U.list(body, 40, function(list, i)
    local r = U.row(list, i, function(_, item) M.pick(item.name) end)
    r.name = U.text(r, "body", "", "text"); r.name:SetPoint("TOPLEFT", 10, -5); r.name:SetPoint("RIGHT", -90, 0)
    r.label = U.text(r, "small", "", "dim"); r.label:SetPoint("TOPRIGHT", -8, -6); r.label:SetJustifyH("RIGHT")
    r.bar = U.bar(r, 290, 9); r.bar:SetPoint("BOTTOMLEFT", 10, 6); r.bar:SetPoint("BOTTOMRIGHT", -8, 6)
    r.sel = U.fill(r, "accent", 1, "OVERLAY"); r.sel:SetPoint("TOPLEFT"); r.sel:SetPoint("BOTTOMLEFT"); r.sel:SetWidth(2)
    return r
  end, function(r, f)
    r.name:SetText(f.name .. (f.info and ("  " .. U.hex("accent") .. "rewards|r") or ""))
    r.label:SetText(f.label)
    local frac = f.max > 0 and f.cur / f.max or (f.standing >= 8 and 1 or 0)
    r.bar.set(frac, f.max > 0 and (f.cur .. " / " .. f.max) or "", BAR_COLOR[f.standing] or "accent")
    if body.picked == f.name then r.sel:Show() else r.sel:Hide() end
  end, 11)
  body.list:SetPoint("TOPLEFT"); body.list:SetPoint("BOTTOMLEFT"); body.list:SetWidth(320)

  local d = U.card(body)
  d:SetPoint("TOPLEFT", 336, 0); d:SetPoint("BOTTOMRIGHT")
  body.detail = d
  d.name = U.text(d, "heading", "", "line"); d.name:SetPoint("TOPLEFT", 14, -12)
  d.standing = U.text(d, "sub", "", "text"); d.standing:SetPoint("TOPLEFT", 14, -36)
  d.how = U.empty(d, ""); d.how:SetPoint("TOPLEFT", 14, -62); d.how:SetPoint("TOPRIGHT", -14, -62)
  d.vendor = U.empty(d, ""); d.vendor:SetPoint("TOPLEFT", 14, -118); d.vendor:SetPoint("TOPRIGHT", -90, -118)
  d.map = U.button(d, "Map", function()
    local spot = d.spot
    if not spot or not ns.showOnMap(spot) then ns.print("Open this vendor's window once and the Codex remembers the spot.") end
  end, { w = 60, h = 22 })
  d.map:SetPoint("TOPRIGHT", -14, -116)
  d.rewards = {}
  for i = 1, 5 do
    local t = U.empty(d, ""); t:SetPoint("TOPLEFT", 14, -150 - (i - 1) * 34); t:SetPoint("TOPRIGHT", -14, -150 - (i - 1) * 34)
    d.rewards[i] = t
  end
end

function M.refresh(body)
  local rows = R.rows()
  if not body.picked and rows[1] then body.picked = rows[1].name end
  body.list.set(rows)
  local f
  for _, x in ipairs(rows) do if x.name == body.picked then f = x end end
  local d = body.detail
  if not f then d.name:SetText("No factions yet"); return end
  d.name:SetText(f.name)
  local nextAt, what = R.nextReward(f)
  d.standing:SetText(f.label .. (f.max > 0 and string.format("   ·   %d to the next standing", f.max - f.cur) or "") .. (nextAt and ("   ·   next reward at " .. nextAt) or ""))
  local info = f.info
  if not info then
    d.how:SetText("No reward notes for this faction in the Codex.")
    d.vendor:SetText(""); d.map:Hide()
    for _, t in ipairs(d.rewards) do t:SetText("") end
    return
  end
  d.how:SetText(U.hex("dim") .. "How:|r " .. info.how)
  d.spot = ns.learned("vendors")[info.vendor]
  d.vendor:SetText(U.hex("dim") .. "Rewards from:|r " .. info.vendor .. ", " .. info.where .. (d.spot and "" or "  (spot not seen yet)"))
  if d.spot then d.map:Show() else d.map:Hide() end
  for i, t in ipairs(d.rewards) do
    local rw = info.rewards[i]
    if rw then
      local have = not f.unmet and f.standing >= rankOf(rw[1])
      t:SetText((have and (U.hex("good") .. "Open:  ") or (U.hex("dim") .. "Later:  ")) .. rw[1] .. "|r   " .. rw[2])
    else t:SetText("") end
  end
end
