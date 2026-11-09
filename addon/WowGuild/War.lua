-- Guild Camp: war alerts and the war map.
--   * When you die in the open world, the spot goes on your account's war list (and the guild's, through a "wm"
--     record, docs/SHARING.md). In PvP areas a popup offers to call the guild for help (a call to arms, at once).
--   * An honorable kill puts a kill mark on the list too.
--   * The world map shows the guild's deaths (red) and kills (green) of the last week, on the map you're looking at.
-- Positions come from C_Map, which works in the open world only: dungeons and battlegrounds are skipped.
local ADDON, ns = ...
local W = {}
ns.war = W

W.MAX_MARKS = 30
W.KEEP_DAYS = 14
W.SHOW_DAYS = 7
W.MAX_PINS = 80

local function now() return (GetServerTime and ns.try(GetServerTime)) or time() end

local function list()
  ns.db.war = ns.db.war or {}
  local w = ns.db.war
  w.marks = w.marks or {}
  w.maps = w.maps or {}
  return w
end

local function inInstance()
  if not IsInInstance then return false end
  return ns.try(IsInInstance) and true or false
end

-- → mapID, x, y (thousandths) of the player, or nil.
function W.where()
  if not C_Map or not C_Map.GetBestMapForUnit or inInstance() then return nil end
  local map = ns.try(C_Map.GetBestMapForUnit, "player")
  if type(map) ~= "number" then return nil end
  local pos = C_Map.GetPlayerMapPosition and ns.try(C_Map.GetPlayerMapPosition, map, "player")
  if not pos then return nil end
  local x, y
  if pos.GetXY then x, y = pos:GetXY() else x, y = pos.x, pos.y end
  if type(x) ~= "number" or type(y) ~= "number" or (x == 0 and y == 0) then return nil end
  return map, math.floor(x * 1000 + 0.5), math.floor(y * 1000 + 0.5)
end

local function mapName(map)
  if not C_Map or not C_Map.GetMapInfo then return nil end
  local info = ns.try(C_Map.GetMapInfo, map)
  return type(info) == "table" and type(info.name) == "string" and info.name or nil
end

-- Drop marks older than KEEP_DAYS and keep the newest MAX_MARKS.
local function trim(w, t)
  local keep = {}
  for _, m in ipairs(w.marks) do if type(m) == "table" and t - (m.at or 0) <= W.KEEP_DAYS * 86400 then keep[#keep + 1] = m end end
  table.sort(keep, function(a, b) return (a.at or 0) > (b.at or 0) end)
  while #keep > W.MAX_MARKS do table.remove(keep) end
  w.marks = keep
end

-- Adds a mark where the player stands. kind "d" (died) or "k" (killed). → the mark, or nil outside the open world.
function W.mark(kind)
  local map, x, y = W.where()
  if not map then return nil end
  local w = list()
  local t = now()
  local m = { map = map, x = x, y = y, at = t, kind = kind }
  table.insert(w.marks, 1, m)
  local name = mapName(map)
  if name then w.maps[map] = name end
  trim(w, t)
  if ns.Collect and ns.Collect.changed then ns.safely(ns.Collect.changed) end
  if W.refreshPins then ns.safely(W.refreshPins) end
  return m
end

-- The "wm" record for this account (Collect.sharedRecords), or nil when there's nothing to share.
function W.record(pid)
  if not pid or not ns.db or not ns.db.war then return nil end
  local w = list()
  trim(w, now())
  if #w.marks == 0 then return nil end
  local marks, maps, seen = {}, {}, {}
  for _, m in ipairs(w.marks) do
    marks[#marks + 1] = { map = m.map, x = m.x, y = m.y, at = m.at, kind = m.kind, n = m.n }
    if not seen[m.map] and w.maps[m.map] and #maps < 12 then
      seen[m.map] = true
      maps[#maps + 1] = { id = m.map, name = string.sub(w.maps[m.map], 1, 40) }
    end
  end
  return { type = "wm", key = pid, fields = { marks = marks, maps = maps } }
end

-- ---------- dying: the mark, and a call for help in PvP areas ----------
local function pvpArea()
  if UnitIsPVP and ns.try(UnitIsPVP, "player") then return true end
  local get = (C_PvP and C_PvP.GetZonePVPInfo) or GetZonePVPInfo
  local kind = get and ns.try(get)
  return kind == "contested" or kind == "hostile" or kind == "combat"
end

StaticPopupDialogs["WOWGUILD_CALL_HELP"] = {
  text = "You died in %s.\nCall your guild for help?",
  button1 = "Call the guild",
  button2 = "No",
  OnAccept = function(_, data)
    ns.addCta(data and data.zone, nil, "Died to players here. Help!")
  end,
  timeout = 30,
  whileDead = true,
  hideOnEscape = true,
  preferredIndex = 3,
}

function W.died()
  local m = W.mark("d")
  if not m or ns.opt("warHelp") == false or not pvpArea() then return m end
  local zone = (GetZoneText and ns.try(GetZoneText)) or mapName(m.map) or "the open world"
  if StaticPopup_Show then ns.try(StaticPopup_Show, "WOWGUILD_CALL_HELP", zone, nil, { zone = zone }) end
  return m
end

ns.on("PLAYER_DEAD", function() ns.safely(W.died) end)
-- "Grom dies, honorable kill Rank: Scout (Estimated Honor Points: 12)". The text itself isn't read.
ns.on("CHAT_MSG_COMBAT_HONOR_GAIN", function(text)
  if type(text) == "string" and string.find(string.lower(text), "honorable kill", 1, true) then ns.safely(W.mark, "k") end
end)

-- ---------- the guild's marks on the world map ----------
-- Every "wm" record in the guild's store, mine included (ns.Share.list), for one map and the last SHOW_DAYS.
function W.marksFor(map)
  local out = {}
  local t = now()
  local recs = (ns.Share and ns.Share.list and ns.try(ns.Share.list, "wm")) or {}
  for _, rec in ipairs(recs) do
    local f = rec.fields
    for _, m in ipairs((type(f) == "table" and f.marks) or {}) do
      if type(m) == "table" and m.map == map and type(m.at) == "number" and t - m.at <= W.SHOW_DAYS * 86400 then
        out[#out + 1] = { x = m.x or 0, y = m.y or 0, at = m.at, kind = m.kind, who = rec.author }
      end
    end
  end
  table.sort(out, function(a, b) return a.at > b.at end)
  while #out > W.MAX_PINS do table.remove(out) end
  return out
end

local layer, pins = nil, {}
local function ago(t)
  local s = math.max(0, now() - t)
  if s < 3600 then return string.format("%d min ago", math.floor(s / 60)) end
  if s < 86400 then return string.format("%d h ago", math.floor(s / 3600)) end
  return string.format("%d days ago", math.floor(s / 86400))
end

local function pin(i)
  if pins[i] then return pins[i] end
  local p = CreateFrame("Button", nil, layer)
  p:SetSize(12, 12)
  p.dot = p:CreateTexture(nil, "OVERLAY")
  p.dot:SetAllPoints()
  p:SetScript("OnEnter", function(self)
    if not GameTooltip or not self.mark then return end
    GameTooltip:SetOwner(self, "ANCHOR_RIGHT")
    local m = self.mark
    GameTooltip:AddLine(string.format("%s %s here", m.who or "A guildmate", m.kind == "k" and "got a kill" or "died"),
      m.kind == "k" and 0.45 or 0.9, m.kind == "k" and 0.85 or 0.4, m.kind == "k" and 0.5 or 0.35)
    GameTooltip:AddLine(ago(m.at), 0.7, 0.7, 0.7)
    GameTooltip:Show()
  end)
  p:SetScript("OnLeave", function() if GameTooltip then GameTooltip:Hide() end end)
  pins[i] = p
  return p
end

function W.refreshPins()
  local map = WorldMapFrame
  if not layer or not map or not map.IsShown or not map:IsShown() then return 0 end
  for _, p in ipairs(pins) do p:Hide() end
  if ns.opt("warMap") == false then return 0 end
  local id = map.GetMapID and ns.try(map.GetMapID, map)
  if type(id) ~= "number" then return 0 end
  local w, h = layer:GetWidth(), layer:GetHeight()
  if not w or w <= 0 or not h or h <= 0 then return 0 end
  local shown = 0
  for i, m in ipairs(W.marksFor(id)) do
    local p = pin(i)
    p.mark = m
    p.dot:SetColorTexture(m.kind == "k" and 0.35 or 0.95, m.kind == "k" and 0.85 or 0.25, m.kind == "k" and 0.4 or 0.2, 0.9)
    p:ClearAllPoints()
    p:SetPoint("CENTER", layer, "TOPLEFT", w * m.x / 1000, -h * m.y / 1000)
    p:Show()
    shown = shown + 1
  end
  return shown
end

function W.attach()
  local map = WorldMapFrame
  if layer or not map then return end
  local canvas = (map.GetCanvas and ns.try(map.GetCanvas, map)) or (map.ScrollContainer and map.ScrollContainer.Child)
  if not canvas then return end
  layer = CreateFrame("Frame", "WowGuildWarPins", canvas)
  layer:SetAllPoints(canvas)
  if layer.SetFrameLevel and canvas.GetFrameLevel then layer:SetFrameLevel((canvas:GetFrameLevel() or 1) + 20) end
  map:HookScript("OnShow", function() ns.safely(W.refreshPins) end)
  if hooksecurefunc and map.OnMapChanged then
    hooksecurefunc(map, "OnMapChanged", function() ns.safely(W.refreshPins) end)
  end
end

function W.slash(rest)
  rest = string.lower(rest or "")
  ns.db.options = ns.db.options or {}
  if rest == "on" or rest == "off" then
    ns.db.options.warMap = rest == "on"
    ns.print(rest == "on" and "War map on: the guild's deaths and kills show on your world map." or "War map off.")
    ns.safely(W.refreshPins)
    return
  end
  local w = list()
  local d, k = 0, 0
  for _, m in ipairs(w.marks) do if m.kind == "k" then k = k + 1 else d = d + 1 end end
  ns.print(string.format("War map: you have %d deaths and %d kills marked in the last %d days. /wow war off hides the map pins.", d, k, W.KEEP_DAYS))
end

ns.on("PLAYER_LOGIN", function() ns.safely(W.attach) end)
