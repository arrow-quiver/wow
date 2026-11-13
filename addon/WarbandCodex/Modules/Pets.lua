-- Warband Codex › Hunter Pets (hunters only).
--   * Families: what each eats and which skills it can learn (Data/Pets.lua), with your own pets marked.
--   * Skill ranks: tick the rank of Bite, Claw, Dash and Dive you already know (click the skill). When you target
--     or mouse over a tameable beast whose level teaches a higher rank, a card says so (option petAlerts).
--   * Beasts met: every tameable beast you've seen, with its family, levels and zone, for all your hunters.
local ADDON, ns = ...
local U = ns.ui
local P = {}
ns.pets = P

ns.option{ key = "petAlerts", label = "Pet skill alerts", desc = "Hunters: a card when a nearby tameable beast would teach a higher rank of a skill than you know.", group = "Hunter pets", default = true }

local function isHunter() return ns.class() == "HUNTER" end

function P.family(name)
  for _, f in ipairs(ns.data.petFamilies) do if f.name == name then return f end end
  return nil
end
-- The rank of a skill a beast (or pet) of this level has: the number of rank levels at or below it.
function P.rankAt(skill, level)
  local n = 0
  for _, need in ipairs(ns.data.petRanks[skill] or {}) do if level >= need then n = n + 1 end end
  return n
end
function P.known() return ns.ensure(ns.char(), "petKnown") end
function P.setKnown(skill, rank)
  local max = #(ns.data.petRanks[skill] or {})
  if max == 0 then return end
  if rank > max then rank = 0 end
  P.known()[skill] = rank
  ns.shell.refresh("pets")
end

-- My pets: the one out, and the stabled ones. → { { name, family, level, active } }
function P.mine()
  local out = {}
  if UnitExists and UnitExists("pet") then
    out[#out + 1] = { name = UnitName("pet"), family = UnitCreatureFamily and ns.try(UnitCreatureFamily, "pet") or "?", level = ns.n(ns.try(UnitLevel, "pet")) or 0, active = true }
  end
  if GetStablePetInfo then
    for i = 1, 4 do
      local _, name, level, family = ns.try(GetStablePetInfo, i)
      if name then out[#out + 1] = { name = name, family = family or "?", level = tonumber(level) or 0 } end
    end
  end
  return out
end

-- ---------- beasts met ----------
local alerted = {}
-- What a beast would teach beyond what I know: → { "Bite 4", ... }
function P.teaches(familyName, level)
  local f, out = P.family(familyName), {}
  if not f then return out end
  local known = P.known()
  for _, skill in ipairs(f.skills) do
    local rank = P.rankAt(skill, level)
    if rank > 0 and rank > (known[skill] or 0) then out[#out + 1] = skill .. " " .. rank end
  end
  return out
end
function P.see(unit)
  if not isHunter() or ns.inCombat() then return end
  if not (UnitExists and UnitExists(unit)) or (UnitIsPlayer and UnitIsPlayer(unit)) then return end
  if UnitPlayerControlled and UnitPlayerControlled(unit) then return end
  if UnitCreatureType and ns.try(UnitCreatureType, unit) ~= "Beast" then return end
  local family = UnitCreatureFamily and ns.try(UnitCreatureFamily, unit)
  local name = UnitName(unit)
  if ns.secret(name) or ns.secret(family) then return end
  local level = ns.n(ns.try(UnitLevel, unit)) or 0
  if not family or not name or level <= 0 then return end
  local b = ns.ensure(ns.learned("beasts"), name)
  b.family, b.zone = family, ns.zone()
  b.min = math.min(b.min or level, level); b.max = math.max(b.max or level, level)
  if ns.opt("petAlerts") and not alerted[name .. level] and level <= ns.level() then
    local t = P.teaches(family, level)
    if #t > 0 then
      alerted[name .. level] = true
      ns.toast(name .. " (" .. family .. ", level " .. level .. ")", "Teaches " .. table.concat(t, ", ") .. ". Tame it and use the skill to learn it.", "Interface\\Icons\\Ability_Hunter_BeastTaming", 8)
    end
  end
end
ns.on("PLAYER_TARGET_CHANGED", function() ns.try(P.see, "target") end)
ns.on("UPDATE_MOUSEOVER_UNIT", function() ns.try(P.see, "mouseover") end)

-- ---------- page ----------
local M = ns.module{ id = "pets", title = "Hunter Pets", icon = "Ability_Hunter_BeastTaming", available = isHunter,
  blurb = "Pet families, the skill ranks you know, and the beasts you've met.", keywords = "hunter pet family diet bite claw tame beasts" }

function M.search(q)
  local out = {}
  for _, f in ipairs(ns.data.petFamilies) do
    if ns.matches(f.name .. " " .. table.concat(f.skills, " "), q) then
      out[#out + 1] = { label = f.name, sub = "Pet family: " .. table.concat(f.skills, ", "), icon = "Interface\\Icons\\Ability_Hunter_BeastTaming" }
    end
  end
  for name, b in pairs(ns.learned("beasts")) do
    if ns.matches(name .. " " .. tostring(b.family), q) then
      out[#out + 1] = { label = name, sub = string.format("%s, level %d-%d, %s", tostring(b.family), b.min or 0, b.max or 0, tostring(b.zone)), icon = "Interface\\Icons\\Ability_Hunter_BeastTaming" }
    end
  end
  return out
end

function M.build(body)
  body.view = "families"
  body.views = U.chips(body, { { "families", "Families" }, { "ranks", "Skill ranks" }, { "beasts", "Beasts met" } }, function(k) body.view = k; M.refresh(body) end)
  body.views:SetPoint("TOPLEFT")
  body.note = U.empty(body, ""); body.note:SetPoint("TOPLEFT", 0, -32); body.note:SetPoint("TOPRIGHT", 0, -32)
  body.list = U.list(body, 34, function(list, i)
    local r = U.row(list, i, function(_, item) if item.skill then P.setKnown(item.skill, (P.known()[item.skill] or 0) + 1) end end)
    r.name = U.text(r, "body", "", "text"); r.name:SetPoint("TOPLEFT", 10, -4); r.name:SetPoint("RIGHT", -200, 0)
    r.sub = U.text(r, "small", "", "dim"); r.sub:SetPoint("TOPLEFT", 10, -19); r.sub:SetPoint("RIGHT", -10, 0)
    r.right = U.text(r, "small", "", "accent"); r.right:SetPoint("TOPRIGHT", -10, -5); r.right:SetJustifyH("RIGHT")
    return r
  end, function(r, item)
    r.name:SetText(item.title); r.sub:SetText(item.sub or ""); r.right:SetText(item.right or "")
  end, 12)
  body.list:SetPoint("TOPLEFT", 0, -58); body.list:SetPoint("BOTTOMRIGHT")
end

function M.refresh(body)
  body.views.pick(body.view, true)
  local rows, note = {}, ""
  if body.view == "families" then
    local mine = {}
    for _, p in ipairs(P.mine()) do mine[p.family] = (mine[p.family] and (mine[p.family] .. ", ") or "") .. p.name .. " (" .. p.level .. (p.active and ", out" or ", stabled") .. ")" end
    for _, f in ipairs(ns.data.petFamilies) do
      rows[#rows + 1] = { title = f.name, sub = "Learns " .. table.concat(f.skills, ", ") .. "   ·   Eats " .. f.diet, right = mine[f.name] or "" }
    end
    note = "Every family also learns Growl and Cower from the pet trainer. The Classic list: Forever may add families."
  elseif body.view == "ranks" then
    local known = P.known()
    for skill, levels in pairs(ns.data.petRanks) do
      local k = known[skill] or 0
      local nextAt = levels[k + 1]
      rows[#rows + 1] = { skill = skill, title = skill, sub = "Ranks at pet level " .. table.concat(levels, ", "),
        right = (k == 0 and "None known" or ("Rank " .. k .. " known")) .. (nextAt and ("   ·   next from a level " .. nextAt .. "+ beast") or "   ·   top rank") }
    end
    table.sort(rows, function(a, b) return a.title < b.title end)
    note = "Click a skill to set the highest rank you know. The Codex then tells you when a beast nearby teaches a better one."
  else
    for name, b in pairs(ns.learned("beasts")) do
      local t = P.teaches(b.family, b.max or 0)
      rows[#rows + 1] = { title = name, sub = string.format("%s   ·   level %s   ·   %s", tostring(b.family), (b.min == b.max) and tostring(b.min) or (b.min .. "-" .. b.max), tostring(b.zone)),
        right = #t > 0 and ("Teaches " .. table.concat(t, ", ")) or "" }
    end
    table.sort(rows, function(a, b) return a.title < b.title end)
    note = #rows == 0 and "No beasts yet. Target or mouse over tameable beasts and they are listed here." or "Tameable beasts you've seen, on any of your hunters."
  end
  body.note:SetText(note)
  body.list.offset = 0
  body.list.set(rows)
end
