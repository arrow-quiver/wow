-- Guild Camp: raid boss kills. When a raid boss dies, the guild's raiders on record ("ek" record, docs/SHARING.md),
-- for attendance and season points in the Guild Camp app, and a cheer on Discord. Every raider's addon makes the
-- same key (boss, day, raid leader) and only writes it when nobody has yet, so a kill is one record.
-- ENCOUNTER_END is an ordinary event (not the combat log). The roster is read a few seconds later, out of combat.
local ADDON, ns = ...
local BK = {}
ns.bossKills = BK

BK.DELAY = 3

local function now() return (GetServerTime and ns.try(GetServerTime)) or time() end
local function short(n) return type(n) == "string" and (string.match(n, "^([^%-%s]+)") or n) or nil end

-- Names of the guild's members (online now; raiders are online).
local function guildNames()
  local out = {}
  if not GetNumGuildMembers or not GetGuildRosterInfo then return out end
  for i = 1, (ns.try(GetNumGuildMembers) or 0) do
    local name, _, _, _, _, _, _, _, online = ns.try(GetGuildRosterInfo, i)
    name = short(name)
    if name and online then out[string.lower(name)] = name end
  end
  return out
end

-- → names of guild members in the raid (me included), and the raid leader's name.
function BK.raiders()
  local inGuild = guildNames()
  local me = UnitName and UnitName("player")
  if me then inGuild[string.lower(me)] = me end
  local names, leader, seen = {}, nil, {}
  for i = 1, math.min(40, (GetNumGroupMembers and ns.try(GetNumGroupMembers)) or 0) do
    local ok, name, rank = pcall(GetRaidRosterInfo, i)
    if ok then
      local okS, s = pcall(function() return short(name) end) -- the name can be a secret value in some contexts
      if okS and s then
        if rank == 2 then leader = s end
        local g = inGuild[string.lower(s)]
        if g and not seen[g] and #names < 40 then seen[g] = true; names[#names + 1] = g end
      end
    end
  end
  return names, leader or me or "?"
end

function BK.keyFor(enc, leader, t)
  local codec = ns.ShareCodec
  local day = date("!%Y-%m-%d", t or now())
  return codec and codec.instanceKey and codec.instanceKey(string.format("%s:%s:%s", tostring(enc), day, string.lower(leader or "?"))) or nil
end

-- Records the kill unless someone already did. → the fields written, or nil.
function BK.record(enc, boss)
  local sh = ns.Share
  if type(sh) ~= "table" or type(sh.putLocal) ~= "function" then return nil end
  local names, leader = BK.raiders()
  if #names == 0 then return nil end
  local key = BK.keyFor(enc, leader)
  if not key or #key ~= 6 then return nil end
  if type(sh.get) == "function" and sh.get("ek:" .. key) then return nil end
  local instance = GetInstanceInfo and ns.try(GetInstanceInfo) or ""
  local size = (GetNumGroupMembers and ns.try(GetNumGroupMembers)) or #names
  local f = { enc = tonumber(enc) or 0, boss = string.sub(tostring(boss or "A boss"), 1, 60), instance = string.sub(instance or "", 1, 60),
    at = now(), size = size, names = names }
  local ok = pcall(sh.putLocal, "ek", key, f)
  if not ok then return nil end
  ns.print(string.format("|cffe8a33d%s is down!|r Recorded for %d guildie%s' raid attendance.", f.boss, #names, #names == 1 and "" or "s"))
  return f
end

function BK.encounterEnd(enc, boss, _, _, success)
  if success ~= 1 and success ~= true then return nil end
  if not IsInInstance then return nil end
  local inside, kind = ns.try(IsInInstance)
  if not inside or kind ~= "raid" then return nil end
  if C_Timer and C_Timer.After then
    C_Timer.After(BK.DELAY, function() ns.safely(BK.record, enc, boss) end)
  else
    ns.safely(BK.record, enc, boss)
  end
  return true
end

ns.on("ENCOUNTER_END", function(...) ns.safely(BK.encounterEnd, ...) end)
