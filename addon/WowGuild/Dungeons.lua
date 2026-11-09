-- Guild Camp: dungeon groups in game (docs/SHARING.md §4.3, dg and dj records).
--
-- /wow lfg                         open guild groups, numbered
-- /wow lfg new <role> <dungeon>    start a group now (1 tank, 1 healer, 3 dps, you included)
-- /wow lfg join <n> <role>         join group n as tank, healer or dps
-- /wow lfg leave <n>               leave group n
-- /wow lfg done <n> | cancel <n>   as the leader: the run is over, or call it off
--
-- The line-up follows the same rule as the app (sharing.js dungeonGroupState): the leader fills a slot of their
-- own role, then joins count in the order they were made; a join past its role's free slots waits.
-- Guildmates online hear about a new group, and the leader hears who joined (with the name to /invite).

local ADDON, ns = ...
if type(ns) ~= "table" then ns = {} end

local L = {}
ns.lfg = L

local ROLE_OF = { t = "t", tank = "t", h = "h", heal = "h", healer = "h", d = "d", dps = "d", damage = "d", dd = "d" }
local ROLE_NAME = { t = "tank", h = "healer", d = "dps" }
local SHOW_AFTER_START = 3 * 3600
local FRESH = 900

local function serverNow()
  local t = GetServerTime and ns.try(GetServerTime)
  if type(t) == "number" then return t end
  return time and time() or 0
end

local function share()
  local S = ns.Share
  if type(S) ~= "table" or type(S.list) ~= "function" or type(S.putLocal) ~= "function" then return nil end
  return S
end

local function plain(s) return (string.gsub(tostring(s or ""), "|", "||")) end

local function slots(f)
  local function n(v, d)
    if type(v) ~= "number" or v < 0 then return d end
    v = math.floor(v)
    if v > 10 then v = 10 end
    return v
  end
  return { t = n(f.tank, 1), h = n(f.heal, 1), d = n(f.dps, 3) }
end

-- dg record + all dj records → { state, open, members, waiting } (the app's dungeonGroupState).
function L.state(dg, joins)
  local f = dg.fields or {}
  local open = slots(f)
  if f.role and (open[f.role] or 0) > 0 then open[f.role] = open[f.role] - 1 end
  local list = {}
  for _, j in ipairs(joins or {}) do
    if type(j) == "table" and j.type == "dj" and type(j.key) == "string" and type(j.fields) == "table" then
      local k, pid = string.match(j.key, "^([^:]+):(.+)$")
      local jf = j.fields
      if k == dg.key and pid ~= f.pid and jf.status == "y" and open[jf.role] then
        list[#list + 1] = { pid = pid, character = jf.character or "?", role = jf.role,
          at = type(jf.joinedAt) == "number" and jf.joinedAt or (j.t or 0) }
      end
    end
  end
  table.sort(list, function(a, b)
    if a.at ~= b.at then return a.at < b.at end
    return a.pid < b.pid
  end)
  local members, waiting = {}, {}
  for _, m in ipairs(list) do
    if open[m.role] > 0 then
      open[m.role] = open[m.role] - 1
      members[#members + 1] = m
    else
      waiting[#waiting + 1] = m
    end
  end
  local state = (open.t + open.h + open.d == 0) and "full" or "open"
  if f.state == "x" then state = "cancelled" elseif f.state == "d" then state = "done" end
  return { state = state, open = open, members = members, waiting = waiting }
end

-- Open groups, soonest first: { { rec, g, mine, joined } }.
function L.groups()
  local S = share()
  if not S then return {} end
  local now = serverNow()
  local pid = S.myPid and ns.try(S.myPid) or nil
  local joins = S.list("dj")
  local out = {}
  for _, dg in ipairs(S.list("dg")) do
    local f = dg.fields
    if type(f) == "table" and f.state == "o" and (tonumber(f.startsAt) or 0) >= now - SHOW_AFTER_START then
      local g = L.state(dg, joins)
      local joined
      for _, m in ipairs(g.members) do if m.pid == pid then joined = m end end
      for _, m in ipairs(g.waiting) do if m.pid == pid then joined = m; joined.waiting = true end end
      out[#out + 1] = { rec = dg, g = g, mine = pid ~= nil and f.pid == pid, joined = joined }
    end
  end
  table.sort(out, function(a, b)
    local sa, sb = tonumber(a.rec.fields.startsAt) or 0, tonumber(b.rec.fields.startsAt) or 0
    if sa ~= sb then return sa < sb end
    return a.rec.key < b.rec.key
  end)
  return out
end

local function needText(open)
  local parts = {}
  if open.t > 0 then parts[#parts + 1] = string.format("%d tank", open.t) end
  if open.h > 0 then parts[#parts + 1] = string.format("%d healer", open.h) end
  if open.d > 0 then parts[#parts + 1] = string.format("%d dps", open.d) end
  if #parts == 0 then return "full" end
  return "needs " .. table.concat(parts, ", ")
end

local function whenText(startsAt)
  local d = (tonumber(startsAt) or 0) - serverNow()
  if d <= 300 then return "now" end
  if d < 90 * 60 then return string.format("in %d min", math.floor(d / 60 + 0.5)) end
  return date and date("%a %H:%M", tonumber(startsAt)) or "later"
end

function L.list()
  local groups = L.groups()
  L.last = groups
  if #groups == 0 then
    ns.print("No guild dungeon groups right now. Start one: /wow lfg new <tank|healer|dps> <dungeon>")
    return
  end
  for i, e in ipairs(groups) do
    local f = e.rec.fields
    local line = string.format("%d. %s, %s: %s (%s), %s.", i, plain(f.dungeon), whenText(f.startsAt),
      plain(f.character), ROLE_NAME[f.role] or "dps", needText(e.g.open))
    if e.mine then line = line .. " Yours."
    elseif e.joined then line = line .. (e.joined.waiting and " You're waiting." or " You're in.") end
    if f.note and f.note ~= "" then line = line .. " " .. plain(f.note) end
    ns.print(line)
  end
  ns.print("/wow lfg join <n> <tank|healer|dps>  ·  /wow lfg leave <n>")
end

local function pick(n)
  local groups = L.last or L.groups()
  n = tonumber(n)
  local e = n and groups[math.floor(n)]
  if not e then
    ns.print("No group with that number. Type /wow lfg to see them.")
    return nil
  end
  -- The record may have changed since the list was shown.
  local S = share()
  local fresh = S and S.get and ns.try(S.get, "dg:" .. e.rec.key)
  if type(fresh) == "table" and not fresh.del and type(fresh.fields) == "table" then e.rec = fresh end
  return e
end

local function put(ty, key, fields)
  local S = share()
  if not S then
    ns.print("Dungeon groups can't be shared right now. " .. (ns.restartHint or ""))
    return false
  end
  local ok, res = pcall(S.putLocal, ty, key, fields)
  if not ok then ns.reportError(res) end
  if not ok or not res then
    ns.print("Couldn't send that to your guild. Try again in a moment.")
    return false
  end
  return true
end

local function me()
  local name = UnitName and UnitName("player") or "?"
  local level = UnitLevel and ns.try(UnitLevel, "player") or nil
  local _, class = nil, nil
  if UnitClass then _, class = UnitClass("player") end
  return name, type(level) == "number" and level or nil, type(class) == "string" and class or ""
end

function L.new(rest)
  local roleWord, dungeon = string.match(rest or "", "^(%S+)%s+(.+)$")
  local role = roleWord and ROLE_OF[string.lower(roleWord)]
  if not role or not dungeon then
    ns.print("Usage: /wow lfg new <tank|healer|dps> <dungeon>")
    return false
  end
  if IsInGuild and not IsInGuild() then
    ns.print("You're not in a guild, so there's nobody to group with.")
    return false
  end
  local S = share()
  local pid = S and S.myPid and ns.try(S.myPid)
  if not pid then
    ns.print("Guild Camp doesn't know you yet in this guild. Wait a moment after login and try again.")
    return false
  end
  local name, level = me()
  dungeon = string.sub(dungeon, 1, 60)
  local fields = { pid = pid, character = name, dungeon = dungeon, startsAt = serverNow(), role = role, level = level,
    tank = 1, heal = 1, dps = 3, note = "", state = "o" }
  if not put("dg", ns.randomKey(), fields) then return false end
  ns.print(string.format("Group for %s posted to your guild. Guildmates join with /wow lfg.", plain(dungeon)))
  L.last = nil
  return true
end

function L.join(n, roleWord)
  local e = pick(n)
  if not e then return false end
  local role = roleWord and ROLE_OF[string.lower(roleWord)]
  if not role then
    ns.print("Pick a role: /wow lfg join " .. tostring(n) .. " <tank|healer|dps>")
    return false
  end
  if e.mine then ns.print("You lead that group.") return false end
  if e.joined then ns.print("You're already in that group.") return false end
  local S = share()
  local pid = S and S.myPid and ns.try(S.myPid)
  if not pid then return false end
  local name, level, class = me()
  if not put("dj", e.rec.key .. ":" .. pid, { character = name, role = role, status = "y", class = class, level = level, joinedAt = serverNow() }) then
    return false
  end
  local f = e.rec.fields
  if (e.g.open[role] or 0) > 0 then
    ns.print(string.format("You joined %s's %s group as %s. Wait for the invite.", plain(f.character), plain(f.dungeon), ROLE_NAME[role]))
  else
    ns.print(string.format("The %s spots in %s's group are taken. You're on the waiting list.", ROLE_NAME[role], plain(f.character)))
  end
  L.last = nil
  return true
end

function L.leave(n)
  local e = pick(n)
  if not e then return false end
  if not e.joined then ns.print("You're not in that group.") return false end
  local S = share()
  local pid = S and S.myPid and ns.try(S.myPid)
  local cur = S and S.get and ns.try(S.get, "dj:" .. e.rec.key .. ":" .. tostring(pid))
  local f = (type(cur) == "table" and type(cur.fields) == "table") and cur.fields or {}
  local name, level, class = me()
  local fields = { character = f.character or name, role = f.role or e.joined.role, status = "w", class = f.class or class,
    level = f.level or level, joinedAt = f.joinedAt }
  if not put("dj", e.rec.key .. ":" .. tostring(pid), fields) then return false end
  ns.print("You left the group.")
  L.last = nil
  return true
end

function L.finish(n, state)
  local e = pick(n)
  if not e then return false end
  if not e.mine then ns.print("Only the leader can do that.") return false end
  local fields = {}
  for k, v in pairs(e.rec.fields) do fields[k] = v end
  fields.state = state
  if not put("dg", e.rec.key, fields) then return false end
  ns.print(state == "x" and "Group called off." or "Marked as done. Good run!")
  L.last = nil
  return true
end

function L.slash(rest)
  local cmd, args = string.match(rest or "", "^(%S*)%s*(.-)$")
  cmd = string.lower(cmd or "")
  if cmd == "" or cmd == "list" then
    L.list()
  elseif cmd == "new" or cmd == "start" then
    L.new(args)
  elseif cmd == "join" then
    local n, role = string.match(args, "^(%S+)%s*(%S*)")
    L.join(n, role ~= "" and role or nil)
  elseif cmd == "leave" then
    L.leave(args)
  elseif cmd == "done" then
    L.finish(args, "d")
  elseif cmd == "cancel" then
    L.finish(args, "x")
  else
    ns.print("/wow lfg  guild dungeon groups;  /wow lfg new <tank|healer|dps> <dungeon>  start one")
    ns.print("/wow lfg join <n> <role>  ·  /wow lfg leave <n>  ·  /wow lfg done <n>  ·  /wow lfg cancel <n>")
  end
end

-- A record the sharing engine stored: a guildmate's fresh group gets a chat line; a join on my group tells me
-- whom to invite.
local seen = {}
function L.arrived(rec, how, from)
  if type(rec) ~= "table" or rec.del or how == "s" or type(rec.fields) ~= "table" then return end
  if rec.type ~= "dg" and rec.type ~= "dj" then return end
  local S = share()
  local pid = S and S.myPid and ns.try(S.myPid)
  local myName = UnitName and UnitName("player")
  if rec.author == myName or from == myName then return end
  if type(rec.t) ~= "number" or serverNow() - rec.t > FRESH then return end
  local mark = (rec.id or "") .. "|" .. tostring(rec.v)
  if seen[mark] then return end
  seen[mark] = true
  local f = rec.fields
  if rec.type == "dg" then
    if f.state ~= "o" or f.pid == pid then return end
    if seen["dg:" .. tostring(rec.key)] then return end
    seen["dg:" .. tostring(rec.key)] = true
    ns.print(string.format("%s is grouping for %s (%s, %s). /wow lfg to join.", plain(f.character or rec.author),
      plain(f.dungeon), whenText(f.startsAt), needText(slots(f))))
    L.last = nil
    return
  end
  local key, who = string.match(rec.key or "", "^([^:]+):(.+)$")
  if not key or who == pid then return end
  local dg = S and S.get and ns.try(S.get, "dg:" .. key)
  if type(dg) ~= "table" or dg.del or type(dg.fields) ~= "table" or dg.fields.pid ~= pid or dg.fields.state ~= "o" then return end
  if f.status == "y" then
    ns.print(string.format("%s joined your %s group as %s. /invite %s", plain(f.character), plain(dg.fields.dungeon),
      ROLE_NAME[f.role] or "dps", plain(f.character)))
    local sound = (SOUNDKIT and SOUNDKIT.READY_CHECK) or 8960
    if PlaySound then pcall(PlaySound, sound, "Master") end
  else
    ns.print(string.format("%s left your %s group.", plain(f.character), plain(dg.fields.dungeon)))
  end
  L.last = nil
end

if ns.on then
  ns.on("ADDON_LOADED", function(name)
    if name ~= ADDON then return end
    local S = ns.Share
    if type(S) == "table" and type(S.onRecord) == "function" then S.onRecord(L.arrived) end
  end)
end
