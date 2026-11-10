-- Guild Camp: core, saved data and slash commands.
-- Everything here runs out of combat. Midnight-era rules (which WoW: Forever
-- uses) hide combat data from addons and block addon messages inside
-- instances, so we only gather what the game freely shows outside combat.
-- Guild data travels to guildmates over the hidden addon channel (Share.lua,
-- docs/SHARING.md); the Guild Camp desktop app reads what we saved and writes
-- the news back in the WowGuild_Inbox folder next to this addon.

local ADDON, ns = ...
ns.VERSION = 1

local function now() return time() end
ns.now = now

function ns.print(msg)
  DEFAULT_CHAT_FRAME:AddMessage("|cffe8a33dGuild Camp|r " .. tostring(msg))
end

-- Sharing (ShareCodec.lua, Share.lua, ShareSync.lua) missing means the game is still using the addon's old file
-- list: an update added those files, and the game reads an addon's file list only when it starts.
ns.restartHint = "Restart World of Warcraft to finish the addon update. A /reload isn't enough."

-- Run a function safely: an API that doesn't exist in this game version
-- must never break the addon.
local function passOk(ok, ...)
  if ok then return ... end
end
function ns.try(fn, ...)
  if type(fn) ~= "function" then return end
  return passOk(pcall(fn, ...))
end

-- Errors: remember the last few and hand them to the game's error handler, so they show
-- with /console scriptErrors 1 (or in BugSack) instead of disappearing.
ns.errors = {}
function ns.reportError(err)
  err = tostring(err)
  ns.debugError = err
  table.insert(ns.errors, 1, date("%H:%M:%S") .. " " .. err)
  while #ns.errors > 5 do table.remove(ns.errors) end
  local handler = geterrorhandler and geterrorhandler()
  if handler then pcall(handler, "Guild Camp: " .. err) end
end

-- Run a function from a timer or a click: an error is reported, never thrown into the game.
local function reportOk(ok, ...)
  if ok then return ... end
  ns.reportError((...))
end
function ns.safely(fn, ...)
  if type(fn) ~= "function" then return end
  return reportOk(pcall(fn, ...))
end

-- C_Timer.After with the callback run safely.
function ns.after(seconds, fn)
  C_Timer.After(seconds, function() ns.safely(fn) end)
end

function ns.charKey()
  local name = UnitName("player")
  return name
end

function ns.addonVersion()
  local get = (C_AddOns and C_AddOns.GetAddOnMetadata) or GetAddOnMetadata
  return get and ns.try(get, ADDON, "Version") or "?"
end

-- Versions are MAJOR.MINOR.PATCH with an optional "-beta.N" style pre-release.
-- Returns { major, minor, patch, pre = "beta.1" | nil }, or nil when there are no numbers at all.
function ns.parseVersion(v)
  if type(v) ~= "string" then return nil end
  local main, pre = string.match(v, "^([^%-]*)%-?(.*)$")
  local parts = {}
  for n in string.gmatch(main or "", "%d+") do parts[#parts + 1] = tonumber(n) end
  if #parts == 0 then return nil end
  return { parts[1] or 0, parts[2] or 0, parts[3] or 0, pre = (pre and pre ~= "") and pre or nil }
end

-- Pre-release labels compare piece by piece: numbers as numbers ("beta.2" < "beta.10"),
-- words alphabetically ("alpha" < "beta"), and a shorter label first when the rest match.
local function preLess(x, y)
  local xs, ys = {}, {}
  for p in string.gmatch(x, "[^%.]+") do xs[#xs + 1] = p end
  for p in string.gmatch(y, "[^%.]+") do ys[#ys + 1] = p end
  for i = 1, math.max(#xs, #ys) do
    local p, q = xs[i], ys[i]
    if p == nil then return true end
    if q == nil then return false end
    if p ~= q then
      local np, nq = tonumber(p), tonumber(q)
      if np and nq then return np < nq end
      if np then return true end
      if nq then return false end
      return p < q
    end
  end
  return false
end

-- "0.4.0" < "0.10.0", and "0.11.0-beta.1" < "0.11.0". An unreadable version is never "older",
-- so a broken version string can't make the addon nag about updates.
function ns.versionLess(a, b)
  local pa, pb = ns.parseVersion(a), ns.parseVersion(b)
  if not pa or not pb then return false end
  for i = 1, 3 do
    if pa[i] ~= pb[i] then return pa[i] < pb[i] end
  end
  if pa.pre == pb.pre or not pa.pre then return false end
  if not pb.pre then return true end
  return preLess(pa.pre, pb.pre)
end

-- The Guild Camp app installs and updates this addon, so that's where players go for a new version.
ns.UPDATE_HINT = "Update it from the Guild Camp app (Addon & sync page)."

-- The newer addon version the guild knows about, or nil when this one is current.
-- The Guild Camp app puts it in the news it writes (WowGuildInbox.latestAddon).
function ns.updateAvailable()
  local inbox = WowGuildInbox
  local latest = inbox and inbox.latestAddon
  if type(latest) == "string" and ns.versionLess(ns.addonVersion(), latest) then return latest end
end

-- Options (Settings → AddOns → Guild Camp). Defaults are on.
ns.DEFAULTS = { blizzardStyle = false, ahTab = true, dealsPanel = true, coachTalents = true, liveLink = false, warMap = true, warHelp = true, seasonTooltips = true, ctaChat = true, celebrate = true, radar = true, instanceHelper = true, reminders = true, craftLookup = true, tooltips = true, minimapButton = true, loginNews = true, autoGuide = true, trackerOnLogin = true, collectBank = true, updateNotice = true }
function ns.opt(key)
  local o = ns.db and ns.db.options
  if o and o[key] ~= nil then return o[key] end
  return ns.DEFAULTS[key]
end

local function initDB()
  WowGuildDB = WowGuildDB or {}
  local db = WowGuildDB
  db.version = ns.VERSION
  db.addonVersion = ns.addonVersion()
  db.options = db.options or {}
  db.characters = db.characters or {}
  db.roster = db.roster or { members = {} }
  -- Addon 0.11 and older queued calls to arms here for the app to post. They now go to the
  -- guild at once (a "ca" record), so an old queue is dropped.
  db.ctaQueue = nil
  ns.db = db
end

-- ---------- call to arms ----------
-- /wow cta Crossroads 5 Alliance hitting the flight master
-- /wow cta 5 need help here      (uses your current zone)
-- /wow cta                       (current zone, no details)
-- The call goes to the guild at once as a "ca" record (docs/SHARING.md): guildmates online
-- with Guild Camp get a chat line and a sound.
function ns.parseCta(text)
  local tokens = {}
  for t in string.gmatch(text or "", "%S+") do tokens[#tokens + 1] = t end
  local numAt
  for i, t in ipairs(tokens) do
    if tonumber(t) then numAt = i; break end
  end
  local zone, needed, msg
  if numAt then
    zone = table.concat(tokens, " ", 1, numAt - 1)
    needed = tonumber(tokens[numAt])
    msg = table.concat(tokens, " ", numAt + 1)
  else
    zone = ""
    msg = table.concat(tokens, " ")
  end
  if zone == "" then zone = (GetZoneText and GetZoneText()) or "Unknown" end
  return zone, needed, msg
end

function ns.queueCta(text)
  local zone, needed, msg = ns.parseCta(text)
  return ns.addCta(zone, needed, msg)
end

-- A random record key: 6 base36 characters (the codec's when it loaded).
local B36 = "0123456789abcdefghijklmnopqrstuvwxyz"
function ns.randomKey()
  local codec = ns.ShareCodec
  if codec and type(codec.randomKey) == "function" then
    local key = ns.try(codec.randomKey)
    if type(key) == "string" and #key == 6 then return key end
  end
  local out = {}
  for i = 1, 6 do
    local d = math.random(1, 36)
    out[i] = string.sub(B36, d, d)
  end
  return table.concat(out)
end

-- Calls to arms seen this session (sent and received), newest last, for the Call to arms tab.
ns.ctaRecent = {}
local function rememberCta(c)
  table.insert(ns.ctaRecent, c)
  while #ns.ctaRecent > 5 do table.remove(ns.ctaRecent, 1) end
end

local function inInstance()
  if not IsInInstance then return false end
  local inside = ns.try(IsInInstance)
  return inside and true or false
end

-- Used by the slash command and the Call to arms form. Returns true when the call went to the
-- sharing engine (it sends at once, or as soon as you leave the dungeon or the fight).
function ns.addCta(zone, needed, msg)
  if not zone or zone == "" then zone = (GetZoneText and GetZoneText()) or "Unknown" end
  needed = tonumber(needed)
  if needed then
    needed = math.floor(needed)
    if needed < 1 or needed > 999 then needed = nil end
  end
  msg = msg or ""
  if IsInGuild and not IsInGuild() then
    ns.print("You're not in a guild, so there's nobody to call.")
    return false
  end
  local put = type(ns.Share) == "table" and ns.Share.putLocal
  if type(put) ~= "function" then
    ns.print("Calls to arms can't be sent right now. " .. ns.restartHint)
    return false
  end
  local character = UnitName("player")
  -- putLocal returns the stored record, or nil (or false) and a reason.
  local ok, res = pcall(put, "ca", ns.randomKey(), { character = character, zone = zone, needed = needed, message = msg })
  if not ok then ns.reportError(res) end
  if not ok or not res then
    ns.print("Couldn't send the call to arms. Try again in a moment.")
    return false
  end
  rememberCta({ character = character, zone = zone, needed = needed, message = msg, at = now(), mine = true })
  if not inInstance() and ns.opt("ctaChat") ~= false then ns.safely(ns.ctaChat, zone, needed, msg, character) end
  if inInstance() then
    ns.print(string.format("Call to arms for %s saved. Waiting until you leave the dungeon.", zone))
  elseif InCombatLockdown and InCombatLockdown() then
    ns.print(string.format("Call to arms for %s saved. It goes out when the fight ends.", zone))
  else
    ns.print(string.format("Call to arms sent to your guild: %s.", zone))
  end
  if ns.ui and ns.ui.refreshIfShown then ns.ui.refreshIfShown() end
  return true
end

-- The call to arms in guild chat too, for guildmates without the addon. The Guild Camp app reads its own line
-- from the chat log (Logs/WoWChatLog.txt, while chat logging is on: /wow live on) and posts it to the guild's
-- Discord at once; keep the "[Guild Camp] Call to arms: … — from <name>" shape, the app looks for it.
-- → the line sent, or nil.
function ns.ctaText(zone, needed, msg, character)
  local text = "[Guild Camp] Call to arms: " .. (zone or "?")
  if needed then text = text .. string.format(" (%d needed)", needed) end
  if msg and msg ~= "" then text = text .. ": " .. msg end
  local tail = " — from " .. (character or "?")
  if #text + #tail > 255 then text = string.sub(text, 1, 255 - #tail - 3) .. "..." end
  return text .. tail
end

function ns.ctaChat(zone, needed, msg, character)
  local send = (C_ChatInfo and C_ChatInfo.SendChatMessage) or SendChatMessage
  if not send or (IsInGuild and not IsInGuild()) then return nil end
  local text = ns.ctaText(zone, needed, msg, character)
  local ok = pcall(send, text, "GUILD")
  return ok and text or nil
end

-- A record the sharing engine stored (ns.Share.onRecord). A fresh call to arms from a guildmate
-- is listed on the Call to arms tab; the engine itself prints the chat line and plays the sound.
local CTA_FRESH = 900
local ctaSeen = {}
function ns.ctaArrived(rec, how, from)
  if type(rec) ~= "table" or rec.type ~= "ca" or rec.del or how == "s" or type(rec.fields) ~= "table" then return end
  local me = UnitName("player")
  if rec.author == me or from == me or ctaSeen[rec.id or ""] then return end
  local server = (GetServerTime and ns.try(GetServerTime)) or now()
  if type(rec.t) ~= "number" or server - rec.t > CTA_FRESH then return end
  ctaSeen[rec.id or ""] = true
  local f = rec.fields
  local needed = tonumber(f.needed)
  if needed then
    needed = math.floor(needed)
    if needed < 1 or needed > 999 then needed = nil end
  end
  rememberCta({
    character = (type(f.character) == "string" and f.character ~= "" and f.character) or rec.author,
    zone = (type(f.zone) == "string" and f.zone ~= "") and f.zone or "somewhere",
    needed = needed, message = type(f.message) == "string" and f.message or "", at = now(),
  })
  if ns.ui and ns.ui.refreshIfShown then ns.ui.refreshIfShown() end
end

StaticPopupDialogs["WOWGUILD_RELOAD_NOW"] = {
  text = "Reload now so the Guild Camp app gets your latest data?\nIt takes a few seconds.",
  button1 = "Reload now",
  button2 = "Later",
  OnAccept = function() if not InCombatLockdown() then ReloadUI() end end,
  timeout = 20,
  whileDead = true,
  hideOnEscape = true,
  preferredIndex = 3,
}

-- ---------- slash commands ----------
SLASH_WOWGUILD1 = "/wow"
SLASH_WOWGUILD2 = "/wowguild"
SLASH_WOWGUILD3 = "/guildcamp"
local function slash(input)
  local cmd, rest = string.match(input or "", "^(%S*)%s*(.-)$")
  cmd = string.lower(cmd or "")
  if cmd == "cta" then
    ns.queueCta(rest)
  elseif cmd == "lfg" or cmd == "group" then
    if ns.lfg then ns.lfg.slash(rest) else ns.print("Dungeon groups aren't running. " .. ns.restartHint) end
  elseif cmd == "share" then
    local S = ns.Share
    if type(S) == "table" and type(S.slash) == "function" then
      S.slash(rest)
    else
      ns.print("Sharing with your guild isn't running. " .. ns.restartHint)
    end
  elseif cmd == "sync" then
    ns.collectAll("manual")
    ns.print("Data saved. Reload or log out and the Guild Camp app will upload it.")
    StaticPopup_Show("WOWGUILD_RELOAD_NOW")
  elseif cmd == "status" then
    local c = ns.db.characters[ns.charKey()] or {}
    local profs = c.professions and #c.professions or 0
    local recipes = 0
    for _, list in pairs(c.recipes or {}) do recipes = recipes + #list end
    ns.print(string.format("%d professions and %d recipes saved for this character. Guild roster: %d members.",
      profs, recipes, #((ns.db.roster or {}).members or {})))
    local inbox = WowGuildInbox
    ns.print(inbox and ("Last guild news: " .. date("%d %b %H:%M", inbox.generatedAt or 0)) or "No guild news yet. Is the Guild Camp app running and signed in?")
    local latest = ns.updateAvailable()
    if latest then ns.print(string.format("Addon version %s. Version %s is out. %s", ns.addonVersion(), latest, ns.UPDATE_HINT)) end
  elseif cmd == "guide" then
    ns.prof.toggleGuide()
  elseif cmd == "list" then
    if rest == "clear" then ns.prof.clearList() else ns.prof.toggleTracker() end
  elseif cmd == "season" then
    ns.seasons.slash()
  elseif cmd == "war" then
    ns.war.slash(rest)
  elseif cmd == "live" then
    ns.live.slash(rest)
  elseif cmd == "welcome" then
    ns.welcome.showWelcome()
  elseif cmd == "deals" then
    ns.deals.toggle()
  elseif cmd == "near" then
    ns.helpers.showNearby()
  elseif cmd == "remind" then
    ns.helpers.resetReminders(); if #ns.helpers.check() == 0 then ns.print("Nothing to remind you of right now.") end
  elseif cmd == "coach" then
    if rest == "" then ns.coachUI.toggle() else ns.coachUI.show(rest == "ask" and "ask" or rest == "build" and "build" or "steps") end
  elseif cmd == "options" or cmd == "config" then
    ns.ui.show("settings")
  elseif cmd == "debug" then
    ns.showReport()
  elseif cmd == "help" then
    ns.print("/wow  open the guild panel")
    ns.print("/wow cta [zone] [number] [message]  call guildies to a fight")
    ns.print("/wow lfg  guild dungeon groups: list, new, join, leave")
    ns.print("/wow share  how sharing with your guild is going")
    ns.print("/wow sync  save everything now")
    ns.print("/wow status  what's been saved")
    ns.print("/wow guide  show or hide the skill-up guide (next to your profession window)")
    ns.print("/wow list  show or hide your shopping list;  /wow list clear  empties it")
    ns.print("/wow coach  your play style, build plan and next steps (/wow coach ask to ask a question)")
    ns.print("/wow deals  the Deal hunter: what to buy on the auction house and sell again")
    ns.print("/wow near  guildies online in your zone, to group up with")
    ns.print("/wow remind  check repairs, bags, talents and raids now (Alt-click an item link: who can craft it)")
    ns.print("/wow season  this month's guild season: the top five and you")
    ns.print("/wow war  your war map marks (/wow war off hides the guild's deaths and kills on the world map)")
    ns.print("/wow live on  turn on combat logging at every login, for the Guild Camp app's live link and Coach overlay")
    ns.print("/wow options  addon settings")
    ns.print("/wow debug  problem report to copy and send")
  else
    ns.togglePanel()
  end
end
SlashCmdList["WOWGUILD"] = function(input) ns.safely(slash, input) end

-- ---------- events ----------
local f = CreateFrame("Frame")
ns.events = f
f:RegisterEvent("ADDON_LOADED")
f:RegisterEvent("PLAYER_LOGIN")
f:RegisterEvent("PLAYER_LOGOUT")
f:SetScript("OnEvent", function(self, event, ...)
  if event == "ADDON_LOADED" then
    if ... == ADDON then ns.safely(initDB) end
  elseif event == "PLAYER_LOGIN" then
    ns.safely(ns.onLogin)
  elseif event == "PLAYER_LOGOUT" then
    -- Last chance to save. No combat checks needed: logout can't happen mid-fight.
    ns.safely(ns.collectCharacter)
  end
  if ns.handlers and ns.handlers[event] then
    for _, fn in ipairs(ns.handlers[event]) do
      local ok, err = pcall(fn, ...)
      if not ok then ns.reportError(err) end
    end
  end
end)

-- Several modules can listen to the same event; one failing never stops the others.
function ns.on(event, fn)
  ns.handlers = ns.handlers or {}
  if not ns.handlers[event] then
    ns.handlers[event] = {}
    ns.try(f.RegisterEvent, f, event)
  end
  table.insert(ns.handlers[event], fn)
end

-- Once every file has loaded: hear about records the sharing engine stores (calls to arms).
ns.on("ADDON_LOADED", function(name)
  if name ~= ADDON then return end
  local S = ns.Share
  if type(S) == "table" and type(S.onRecord) == "function" then S.onRecord(ns.ctaArrived) end
end)
