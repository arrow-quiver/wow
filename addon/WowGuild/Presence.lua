-- Guild Camp: what the guild is doing right now. Short messages on the guild's hidden addon channel, on a prefix
-- of their own so they never take from the sharing engine's budget (docs/SHARING.md §7). Nothing here is stored
-- in the guild's shared records: it is for the guildies online at the moment.
--
--   P|<map>|<x>|<y>|<zone>   where I am (option shareLocation, off until I turn it on): at most every MOVE_EVERY
--                            seconds while I move, every STILL_EVERY while I stand. P|0 when I stop sharing.
--   R|<caller>               I'm on my way to <caller>'s call to arms.
--   D|<killer>               a player killed me (from the death recap, when the game names them).
--   K|<victim>               I killed a player (the game's honor line).
--
-- Only the open world: nothing is sent inside an instance, during a loading screen or outside a guild (the game
-- refuses it there anyway). Every message is the result of something I did (moved with sharing on, clicked "On
-- my way", died, killed), never of a message I received, so two clients can't set each other off.
local ADDON, ns = ...
local P = {}
ns.presence = P

P.PREFIX = "GuildCampNow"
P.MOVE_EVERY = 20      -- seconds between positions while moving
P.STILL_EVERY = 120    -- seconds between positions while standing
P.MOVED = 8            -- thousandths of the map that count as having moved
P.STALE = 300          -- a guildie not heard from for this long is off the map
P.MIN_GAP = 2          -- seconds between any two of my messages
P.FLOOD = 40           -- a sender above this many messages a minute is ignored for the rest of it
P.NEMESIS_KEEP = 60 * 86400

local function now() return (GetServerTime and ns.try(GetServerTime)) or time() end
local function short(n) return type(n) == "string" and (string.match(n, "^([^%-%s]+)") or n) or nil end
local function me() return UnitName and short(ns.try(UnitName, "player")) or nil end
-- Names travel in messages and into SavedVariables: letters only, the length the game allows.
local function cleanName(n)
  n = short(n)
  if type(n) ~= "string" or #n < 2 or #n > 48 or string.find(n, "[%s%p%d%c|]") then return nil end
  return n
end
P.cleanName = cleanName

-- ---------- sending ----------
local registered, lastSent = false, 0
-- `urgent` (an answer, a death, a kill) skips the gap that spaces positions out.
function P.send(text, urgent)
  if type(text) ~= "string" or #text > 200 then return false end
  if IsInGuild and not ns.try(IsInGuild) then return false end
  if IsInInstance and ns.try(IsInInstance) then return false end
  local api = C_ChatInfo and C_ChatInfo.SendAddonMessage
  if not api then return false end
  if not registered then
    local reg = C_ChatInfo.RegisterAddonMessagePrefix
    if reg then pcall(reg, P.PREFIX) end
    registered = true
  end
  local t = (GetTime and ns.try(GetTime)) or now()
  if not urgent and t - lastSent < P.MIN_GAP then return false end
  local ok, res = pcall(api, P.PREFIX, text, "GUILD")
  if not ok or res == false then return false end
  local E = Enum and Enum.SendAddonMessageResult
  if E and type(res) == "number" and res ~= E.Success then return false end
  lastSent = t
  return true
end
function P.register()
  if registered then return end
  local reg = C_ChatInfo and C_ChatInfo.RegisterAddonMessagePrefix
  if reg then pcall(reg, P.PREFIX); registered = true end
end

-- ---------- where everyone is ----------
P.where = {}   -- [name] = { map, x, y, zone, at }
local lastPos

function P.sharing() return ns.opt("shareLocation") == true end

-- Sends my position when it's due. → true when a message went out.
function P.tick()
  if not P.sharing() or not ns.war or not ns.war.where then return false end
  local map, x, y = ns.war.where()
  if not map then return false end
  local t = now()
  local moved = not lastPos or lastPos.map ~= map or math.abs(lastPos.x - x) >= P.MOVED or math.abs(lastPos.y - y) >= P.MOVED
  local due = not lastPos or t - lastPos.at >= (moved and P.MOVE_EVERY or P.STILL_EVERY)
  if not due then return false end
  local zone = (GetZoneText and ns.try(GetZoneText)) or ""
  zone = string.sub(string.gsub(tostring(zone), "[|%c]", ""), 1, 40)
  if not P.send(string.format("P|%d|%d|%d|%s", map, x, y, zone)) then return false end
  lastPos = { map = map, x = x, y = y, at = t }
  local name = me()
  if name then P.where[name] = { map = map, x = x, y = y, zone = zone, at = t } end
  return true
end

-- Turns sharing on or off. Off tells the guild at once so my dot goes.
function P.share(on)
  ns.db.options = ns.db.options or {}
  ns.db.options.shareLocation = on and true or false
  if on then lastPos = nil; P.tick()
  else
    lastPos = nil
    local name = me()
    if name then P.where[name] = nil end
    P.send("P|0", true)
  end
  if P.refreshPins then ns.safely(P.refreshPins) end
  return P.sharing()
end

-- Guildies heard from lately, the newest first: { { name, map, x, y, zone, at, me } }.
function P.list()
  local t, out, mine = now(), {}, me()
  for name, w in pairs(P.where) do
    if t - w.at <= P.STALE then out[#out + 1] = { name = name, map = w.map, x = w.x, y = w.y, zone = w.zone, at = w.at, me = name == mine }
    else P.where[name] = nil end
  end
  table.sort(out, function(a, b) if a.at ~= b.at then return a.at > b.at end return a.name < b.name end)
  return out
end

-- → { { zone, names = {…} } }, the fullest zone first.
function P.byZone()
  local zones, order = {}, {}
  for _, w in ipairs(P.list()) do
    local z = (w.zone and w.zone ~= "") and w.zone or "Somewhere"
    if not zones[z] then zones[z] = { zone = z, names = {} }; order[#order + 1] = zones[z] end
    table.insert(zones[z].names, w.name)
  end
  for _, z in ipairs(order) do table.sort(z.names) end
  table.sort(order, function(a, b) if #a.names ~= #b.names then return #a.names > #b.names end return a.zone < b.zone end)
  return order
end

-- ---------- rallies: who answered a call to arms ----------
P.answers = {}  -- [caller] = { [name] = at }

-- "On my way" to a caller's call. → true when it went out.
function P.answer(caller)
  caller = cleanName(caller)
  if not caller then return false end
  local sent = P.send("R|" .. caller, true)
  local name = me()
  if sent and name then
    P.answers[caller] = P.answers[caller] or {}
    P.answers[caller][name] = now()
  end
  return sent
end

-- Who answered `caller` since `since` (a call's time), in the order they answered: { names }.
function P.coming(caller, since)
  local list = {}
  for name, at in pairs(P.answers[short(caller) or ""] or {}) do
    if at >= (since or 0) - 5 then list[#list + 1] = { name = name, at = at } end
  end
  table.sort(list, function(a, b) if a.at ~= b.at then return a.at < b.at end return a.name < b.name end)
  local names = {}
  for i, x in ipairs(list) do names[i] = x.name end
  return names
end

-- ---------- nemeses: who keeps killing guildies ----------
-- ns.db.nemesis[name] = { deaths = n, kills = n, last = t, by = { [guildie] = n } }. Counted from what the guildies
-- online at the time tell each other, so it is this account's own tally, not the whole guild's history.
local function book()
  ns.db.nemesis = ns.db.nemesis or {}
  return ns.db.nemesis
end

function P.note(kind, enemy, guildie, at)
  enemy, guildie = cleanName(enemy), cleanName(guildie)
  if not enemy or not guildie then return nil end
  local b = book()
  local e = b[enemy] or { deaths = 0, kills = 0, last = 0, by = {} }
  b[enemy] = e
  if kind == "D" then
    e.deaths = e.deaths + 1
    e.by[guildie] = (e.by[guildie] or 0) + 1
  else
    e.kills = e.kills + 1
  end
  e.last = at or now()
  return e
end

-- The list, the deadliest first: { { name, deaths, kills, last, worst = guildie killed most, mine = my deaths } }.
function P.nemeses()
  local t, out, mine = now(), {}, me()
  for name, e in pairs(book()) do
    if t - (e.last or 0) > P.NEMESIS_KEEP then book()[name] = nil
    elseif (e.deaths or 0) > 0 then
      local worst, n = nil, 0
      for who, c in pairs(e.by or {}) do if c > n or (c == n and worst and who < worst) then worst, n = who, c end end
      out[#out + 1] = { name = name, deaths = e.deaths, kills = e.kills or 0, last = e.last or 0, worst = worst, mine = (mine and e.by and e.by[mine]) or 0 }
    end
  end
  table.sort(out, function(a, b)
    if a.deaths ~= b.deaths then return a.deaths > b.deaths end
    if a.last ~= b.last then return a.last > b.last end
    return a.name < b.name
  end)
  return out
end

-- A player killed me: count it and tell the guild.
function P.died(killer)
  killer = cleanName(killer)
  local name = me()
  if not killer or not name then return nil end
  P.send("D|" .. killer, true)
  return P.note("D", killer, name)
end

-- I killed a player: count it, tell the guild, and say so when it was revenge.
function P.killed(victim)
  victim = cleanName(victim)
  local name = me()
  if not victim or not name then return nil end
  local before = book()[victim]
  local owed = before and before.by and before.by[name] or 0
  P.send("K|" .. victim, true)
  local e = P.note("K", victim, name)
  if owed > 0 then
    local line = string.format("Revenge! %s killed you %d %s. That's one back.", victim, owed, owed == 1 and "time" or "times")
    if ns.notice then ns.notice(line, 6) end
    ns.print("|cffe8a33d" .. line .. "|r")
    return e, line
  end
  return e
end

-- ---------- receiving ----------
local flood = {}
function P.heard(prefix, msg, chan, sender)
  if prefix ~= P.PREFIX or type(msg) ~= "string" or chan ~= "GUILD" then return nil end
  local who = cleanName(sender)
  if not who or who == me() then return nil end
  local t = now()
  local f = flood[who]
  if not f or t - f.at >= 60 then f = { at = t, n = 0 }; flood[who] = f end
  f.n = f.n + 1
  if f.n > P.FLOOD then return nil end
  local kind, rest = string.match(msg, "^(%u)|(.*)$")
  -- A name in a message is one word: anything with a space in it isn't a name.
  if (kind == "R" or kind == "D" or kind == "K") and string.find(rest, "%s") then return nil end
  if kind == "P" then
    if rest == "0" then P.where[who] = nil
    else
      local map, x, y, zone = string.match(rest, "^(%d+)|(%d+)|(%d+)|(.*)$")
      map, x, y = tonumber(map), tonumber(x), tonumber(y)
      if not map or map <= 0 or not x or not y or x > 1000 or y > 1000 then return nil end
      P.where[who] = { map = map, x = x, y = y, zone = string.sub(string.gsub(zone or "", "[|%c]", ""), 1, 40), at = t }
    end
    if P.refreshPins then ns.safely(P.refreshPins) end
  elseif kind == "R" then
    local caller = cleanName(rest)
    if not caller then return nil end
    P.answers[caller] = P.answers[caller] or {}
    P.answers[caller][who] = t
    if caller == me() then ns.print(string.format("|cffe8a33d%s is on the way to your call to arms.|r", who)) end
  elseif kind == "D" or kind == "K" then
    if not P.note(kind, rest, who, t) then return nil end
  else
    return nil
  end
  if ns.ui and ns.ui.refreshIfShown then ns.safely(ns.ui.refreshIfShown) end
  return kind
end

-- ---------- guildies on the world map ----------
local layer, pins = nil, {}
local function pin(i)
  if pins[i] then return pins[i] end
  local p = CreateFrame("Button", nil, layer)
  p:SetSize(14, 14)
  p.dot = p:CreateTexture(nil, "OVERLAY")
  p.dot:SetAllPoints()
  p.dot:SetTexture("Interface\\MINIMAP\\PartyRaidBlips")
  if p.dot.SetTexCoord then p.dot:SetTexCoord(0.5, 0.625, 0, 0.25) end
  if p.dot.SetVertexColor then p.dot:SetVertexColor(0.3, 0.75, 1) end
  p:SetScript("OnEnter", function(self)
    if not GameTooltip or not self.who then return end
    GameTooltip:SetOwner(self, "ANCHOR_RIGHT")
    GameTooltip:AddLine(self.who.name, 0.3, 0.75, 1)
    GameTooltip:AddLine("Guildmate, " .. (ns.ago and ns.ago(self.who.at) or ""), 0.7, 0.7, 0.7)
    GameTooltip:Show()
  end)
  p:SetScript("OnLeave", function() if GameTooltip then GameTooltip:Hide() end end)
  pins[i] = p
  return p
end

-- Draws the guildies on the map on screen. → how many.
function P.refreshPins()
  local map = WorldMapFrame
  if not layer or not map or not map.IsShown or not map:IsShown() then return 0 end
  for _, p in ipairs(pins) do p:Hide() end
  local id = map.GetMapID and ns.try(map.GetMapID, map)
  if type(id) ~= "number" then return 0 end
  local w, h = layer.canvas:GetWidth(), layer.canvas:GetHeight()
  if not w or w <= 0 or not h or h <= 0 then return 0 end
  local shown = 0
  for _, g in ipairs(P.list()) do
    if g.map == id and not g.me then
      shown = shown + 1
      local p = pin(shown)
      p.who = g
      p:ClearAllPoints()
      p:SetPoint("CENTER", layer.canvas, "TOPLEFT", w * g.x / 1000, -h * g.y / 1000)
      p:Show()
    end
  end
  return shown
end

function P.attach()
  local map = WorldMapFrame
  if layer or not map or not map.GetCanvas then return end
  local canvas = ns.try(map.GetCanvas, map)
  if not canvas then return end
  layer = CreateFrame("Frame", nil, canvas)
  layer.canvas = canvas
  layer:SetAllPoints(canvas)
  if layer.EnableMouse then layer:EnableMouse(false) end
  if layer.SetFrameStrata and map.GetFrameStrata then layer:SetFrameStrata(map:GetFrameStrata() or "HIGH") end
  if layer.SetFrameLevel and map.GetFrameLevel then layer:SetFrameLevel((map:GetFrameLevel() or 1) + 60) end
  map:HookScript("OnShow", function() ns.safely(P.refreshPins) end)
  if hooksecurefunc and map.OnMapChanged then
    hooksecurefunc(map, "OnMapChanged", function() ns.safely(P.refreshPins) end)
  end
end

-- ---------- wiring ----------
ns.on("CHAT_MSG_ADDON", function(...) ns.safely(P.heard, ...) end)
ns.on("PLAYER_LOGIN", function()
  ns.safely(P.register)
  ns.safely(P.attach)
  if C_Timer and C_Timer.NewTicker then C_Timer.NewTicker(5, function() ns.safely(P.tick) end) end
end)
-- A death to a player the game names, and my honorable kills.
ns.on("PLAYER_DEAD", function()
  if not ns.war or not ns.war.killedByPlayers or not ns.war.killerName then return end
  if not ns.safely(ns.war.killedByPlayers) then return end
  local killer = ns.war.killerName()
  if killer then ns.safely(P.died, killer) end
end)
ns.on("CHAT_MSG_COMBAT_HONOR_GAIN", function(text)
  local victim = ns.hunt and ns.hunt.victimOf and ns.hunt.victimOf(text)
  if victim then ns.safely(P.killed, victim) end
end)
