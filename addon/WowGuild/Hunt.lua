-- Guild Camp: the hunt. The guild's kill-on-sight list ("ko" records) and officers' bounties ("BT"), shared through
-- the guild like everything else (docs/SHARING.md), so it works without the app.
--   * A kill-on-sight target or bounty target near you (nameplate, target, mouseover): a warning on screen and a
--     sound, at most every 2 minutes per player (option kosAlerts). Their tooltip says so too.
--   * Your honorable kill of one of them (or any kill in a bounty's zone): recorded for the guild ("kk"), worth
--     season points; the Guild Camp app posts it to Discord.
--   * Killed by a player: the call-for-help prompt offers "Kill on sight" for whoever did it.
--   /wow kos                     the list            /wow kos add <name> [reason]     /wow kos remove <name>
--   /wow bounties                open bounties
local ADDON, ns = ...
local HU = {}
ns.hunt = HU

HU.ALERT_EVERY = 120
HU.KOS_POINTS = 8
local RED, GOLD = "|cffff4040", "|cffe8a33d"

local function now() return (GetServerTime and ns.try(GetServerTime)) or time() end
local function S() local s = ns.Share; if type(s) == "table" and type(s.list) == "function" then return s end end
local function plain(s) return (string.gsub(tostring(s or ""), "|", "||")) end
local function short(n) return n and (string.match(n, "^([^%-%s]+)") or n) or nil end
-- "gankalot" → "Gankalot" (record keys are names as the game writes them).
local function proper(n)
  n = short(n)
  if type(n) ~= "string" or n == "" then return nil end
  local first, rest = string.match(n, "^([\1-\127\194-\244][\128-\191]*)(.*)$")
  if not first then return nil end
  return string.upper(first) .. string.lower(rest)
end
HU.proper = proper
-- Names the game hands out can be secret values (Midnight): compare inside pcall.
local function same(a, b)
  local ok, yes = pcall(function() return string.lower(a) == string.lower(b) end)
  return ok and yes
end

-- ---------- the lists ----------
-- Both lists are rebuilt at most every CACHE seconds: nameplates and mouseovers ask many times a second.
HU.CACHE = 5
local cache = {}
function HU.invalidate() cache = {} end
local function cached(name, build)
  local c = cache[name]
  local t = (GetTime and ns.try(GetTime)) or now()
  if c and t - c.at < HU.CACHE then return c.list end
  local list = build()
  cache[name] = { at = t, list = list }
  return list
end

function HU.kos() return cached("kos", HU.buildKos) end
function HU.bounties() return cached("bounties", HU.buildBounties) end

function HU.buildKos()
  local sh, out = S(), {}
  if not sh then return out end
  for _, r in ipairs(sh.list("ko")) do
    local f = r.fields or {}
    if f.state == "o" then out[#out + 1] = { name = r.key, reason = f.reason, t = r.t or 0, by = r.author } end
  end
  table.sort(out, function(a, b) return a.t > b.t end)
  return out
end

-- Open bounties, without the claimed ones: a player bounty pays its first kill, a zone bounty `cap` kills (the
-- guild's kk records naming it; the app checks each the same way before paying).
function HU.buildBounties()
  local sh, out, t = S(), {}, now()
  if not sh then return out end
  local claims = {}
  for _, k in ipairs(sh.list("kk")) do
    local b = k.fields and k.fields.bounty
    if b and b ~= "" then claims[b] = (claims[b] or 0) + 1 end
  end
  for _, r in ipairs(sh.list("BT")) do
    local f = r.fields or {}
    local cap = (f.target or "") ~= "" and 1 or math.max(1, f.cap or 1)
    if f.state == "o" and (f.points or 0) > 0 and (f.ends or 0) > t and ((f.target or "") ~= "" or (f.zone or "") ~= "") and (claims[r.key] or 0) < cap then
      out[#out + 1] = { key = r.key, target = f.target ~= "" and f.target or nil, zone = f.zone ~= "" and f.zone or nil,
        points = f.points, cap = f.cap or 1, ends = f.ends, note = f.note, t = r.t or 0 }
    end
  end
  table.sort(out, function(a, b) return a.points > b.points end)
  return out
end

-- → the kill-on-sight entry for a name, or nil.
function HU.onList(name)
  if not name then return nil end
  for _, k in ipairs(HU.kos()) do if same(k.name, name) then return k end end
end

-- → the open bounty for this player (by name), or nil.
function HU.bountyOn(name)
  if not name then return nil end
  for _, b in ipairs(HU.bounties()) do if b.target and same(b.target, name) then return b end end
end

-- → the open zone bounty for a zone, or nil.
function HU.zoneBounty(zone)
  if not zone or zone == "" then return nil end
  for _, b in ipairs(HU.bounties()) do if b.zone and same(b.zone, zone) then return b end end
end

-- ---------- spotting them ----------
local alerted = {}
function HU.resetAlerts() alerted = {} end

function HU.check(unit)
  if ns.opt("kosAlerts") == false or not unit or not UnitIsPlayer then return nil end
  if not ns.try(UnitIsPlayer, unit) then return nil end
  if UnitIsEnemy and not ns.try(UnitIsEnemy, "player", unit) then return nil end
  local okN, name = pcall(UnitName, unit)
  if not okN or type(name) ~= "string" then return nil end
  local okK, key = pcall(function() return string.lower(proper(name) or name) end)
  if not okK then return nil end
  if alerted[key] and now() - alerted[key] < HU.ALERT_EVERY then return nil end
  local k, b = HU.onList(name), HU.bountyOn(name)
  if not k and not b then return nil end
  alerted[key] = now()
  local lvl = UnitLevel and ns.try(UnitLevel, unit)
  local cls = UnitClass and ns.try(UnitClass, unit)
  local who = string.format("%s%s%s", plain(name), (lvl and lvl > 0) and (" " .. lvl) or "", cls and (" " .. cls) or "")
  local text = b and string.format("BOUNTY: %s is near! %d points.", who, b.points) or string.format("KILL ON SIGHT: %s is near!", who)
  if ns.notice then ns.notice(text, 8) end
  ns.print((b and GOLD or RED) .. text .. "|r" .. (k and k.reason and k.reason ~= "" and (" (" .. plain(k.reason) .. ")") or ""))
  if PlaySound and SOUNDKIT and SOUNDKIT.RAID_WARNING then ns.try(PlaySound, SOUNDKIT.RAID_WARNING, "Master") end
  return text
end

-- Tooltip lines for an enemy player.
function HU.tooltipLines(name)
  local out = {}
  local k, b = HU.onList(name), HU.bountyOn(name)
  if k then out[#out + 1] = RED .. "Kill on sight" .. (k.reason and k.reason ~= "" and (": " .. plain(k.reason)) or "") .. "|r" end
  if b then out[#out + 1] = GOLD .. string.format("Bounty: %d points", b.points) .. "|r" end
  return out
end

local function onUnitTooltip(tooltip)
  if not tooltip or not tooltip.GetUnit then return end
  local ok, _, unit = pcall(tooltip.GetUnit, tooltip)
  if not ok or not unit or not (UnitIsPlayer and ns.try(UnitIsPlayer, unit)) then return end
  local okN, name = pcall(UnitName, unit)
  if not okN or type(name) ~= "string" then return end
  local lines = HU.tooltipLines(name)
  for _, l in ipairs(lines) do tooltip:AddLine(l) end
  if #lines > 0 and tooltip.Show then tooltip:Show() end
end
HU.onUnitTooltip = onUnitTooltip

-- ---------- my kills ----------
-- The victim's name in the game's honor-kill line (COMBATLOG_HONORGAIN "%s dies, honorable kill Rank: %s ...").
local function victimPattern(fmt)
  if type(fmt) ~= "string" or fmt == "" then return nil end
  local p = string.gsub(fmt, "%%%d*%$?[sd]", "\001")
  p = string.gsub(p, "([%^%$%(%)%%%.%[%]%*%+%-%?])", "%%%1")
  p = string.gsub(p, "\001", "(.-)", 1)
  p = string.gsub(p, "\001", ".-")
  return "^" .. p .. "$"
end

function HU.victimOf(text)
  if type(text) ~= "string" then return nil end
  local known = false
  for _, fmt in ipairs({ COMBATLOG_HONORGAIN or false, COMBATLOG_HONORGAIN_NO_RANK or false }) do
    local p = victimPattern(fmt)
    if p then
      known = true
      local v = string.match(text, p)
      if v and v ~= "" then return proper(v) end
    end
  end
  if not known then return proper(string.match(text, "^(.-) dies")) end
end

-- Records the kill when it counts. → the kk fields, or nil.
function HU.killed(text)
  local victim = HU.victimOf(text)
  local sh = S()
  if not victim or not sh or type(sh.putLocal) ~= "function" then return nil end
  local zone = (GetRealZoneText and ns.try(GetRealZoneText)) or (GetZoneText and ns.try(GetZoneText)) or ""
  local k = HU.onList(victim)
  local b = HU.bountyOn(victim) or HU.zoneBounty(zone)
  if not k and not b then return nil end
  local pid = sh.myPid and ns.try(sh.myPid)
  if not pid then return nil end
  local f = { pid = pid, target = victim, zone = string.sub(zone or "", 1, 60), at = now(), kos = k and 1 or 0, bounty = b and b.key or "" }
  local called, res = pcall(sh.putLocal, "kk", ns.randomKey(), f)
  if not called or not res then return nil end
  HU.invalidate()
  local pts = (k and HU.KOS_POINTS or 0) + (b and b.points or 0)
  if ns.notice then ns.notice(string.format("%s slain! +%d season points%s", victim, pts, b and " (bounty)" or ""), 6) end
  ns.print(GOLD .. string.format("%s slain%s: +%d season points.", victim, b and (b.target and ", bounty claimed" or ", zone bounty") or " (kill on sight)", pts) .. "|r")
  return f
end

-- ---------- adding and removing ----------
function HU.add(name, reason)
  name = proper(name)
  local sh = S()
  local pid = sh and sh.myPid and ns.try(sh.myPid)
  if not name or not sh or not pid or type(sh.putLocal) ~= "function" then ns.print("Couldn't add that. Guild sharing starts a little after login: try again in a minute."); return false end
  local called, res = pcall(sh.putLocal, "ko", name, { pid = pid, reason = string.sub(reason or "", 1, 100), state = "o" })
  local ok = called and res ~= nil and res ~= false
  HU.invalidate()
  ns.print(ok and string.format("%s%s is now kill on sight for the guild.|r", RED, name) or "Couldn't add that name (letters only, no realm).")
  return ok
end

function HU.remove(name)
  name = proper(name)
  local k = HU.onList(name)
  local sh = S()
  local pid = sh and sh.myPid and ns.try(sh.myPid)
  if not k or not pid then ns.print((name or "That player") .. " isn't on the kill-on-sight list."); return false end
  local called, res = pcall(sh.putLocal, "ko", k.name, { pid = pid, reason = k.reason or "", state = "x" })
  local ok = called and res ~= nil and res ~= false
  HU.invalidate()
  ns.print(ok and (k.name .. " is off the list.") or "Couldn't change the list.")
  return ok
end

function HU.slash(rest)
  local cmd, args = string.match(rest or "", "^(%S*)%s*(.-)$")
  cmd = string.lower(cmd or "")
  if cmd == "add" then
    local name, reason = string.match(args or "", "^(%S+)%s*(.-)$")
    return HU.add(name, reason)
  elseif cmd == "remove" or cmd == "del" then
    return HU.remove(args)
  end
  local list = HU.kos()
  if #list == 0 then ns.print("Nobody is kill on sight. /wow kos add <name> [reason]"); return 0 end
  ns.print(RED .. "Kill on sight|r (" .. HU.KOS_POINTS .. " season points a kill):")
  for i, k in ipairs(list) do
    if i > 15 then ns.print(string.format("  … and %d more in the Guild Camp app.", #list - 15)); break end
    ns.print(string.format("  %s%s", k.name, k.reason and k.reason ~= "" and (" — " .. plain(k.reason)) or ""))
  end
  return #list
end

function HU.slashBounties()
  local list = HU.bounties()
  if #list == 0 then ns.print("No bounties up. Officers put them up in the Guild Camp app."); return 0 end
  ns.print(GOLD .. "Bounties:|r")
  for _, b in ipairs(list) do
    local left = math.max(0, math.floor(((b.ends or 0) - now()) / 3600))
    ns.print(string.format("  %d points: %s%s (%s left)%s", b.points, b.target and ("kill " .. b.target) or ("each kill in " .. b.zone),
      (not b.target and b.cap > 1) and (", up to " .. b.cap .. " kills") or "", left >= 48 and (math.floor(left / 24) .. " days") or (left .. "h"),
      b.note and b.note ~= "" and (" — " .. plain(b.note)) or ""))
  end
  return #list
end

local hooked = false
function HU.hook()
  if hooked then return end
  hooked = true
  if TooltipDataProcessor and TooltipDataProcessor.AddTooltipPostCall and Enum and Enum.TooltipDataType and Enum.TooltipDataType.Unit then
    TooltipDataProcessor.AddTooltipPostCall(Enum.TooltipDataType.Unit, function(tooltip) ns.safely(onUnitTooltip, tooltip) end)
  elseif GameTooltip and GameTooltip.HookScript then
    GameTooltip:HookScript("OnTooltipSetUnit", function(tooltip) ns.safely(onUnitTooltip, tooltip) end)
  end
end

ns.on("PLAYER_LOGIN", function() ns.safely(HU.hook) end)
ns.on("NAME_PLATE_UNIT_ADDED", function(unit) ns.safely(HU.check, unit) end)
ns.on("PLAYER_TARGET_CHANGED", function() ns.safely(HU.check, "target") end)
ns.on("UPDATE_MOUSEOVER_UNIT", function() ns.safely(HU.check, "mouseover") end)
ns.on("CHAT_MSG_COMBAT_HONOR_GAIN", function(text) ns.safely(HU.killed, text) end)
-- Guildmates' changes to the lists arrive through the sharing engine.
ns.on("ADDON_LOADED", function(name)
  if name ~= ADDON then return end
  local sh = ns.Share
  if type(sh) == "table" and type(sh.onRecord) == "function" then
    sh.onRecord(function(rec) if type(rec) == "table" and (rec.type == "ko" or rec.type == "BT" or rec.type == "kk") then HU.invalidate() end end)
  end
end)
