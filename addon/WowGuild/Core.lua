-- wow guild: core, saved data and slash commands.
-- Everything here runs out of combat. Midnight-era rules (which WoW: Forever
-- uses) hide combat data from addons and block addon messages inside
-- instances, so we only gather what the game freely shows outside combat and
-- let the companion app carry it to the website.

local ADDON, ns = ...
ns.VERSION = 1

local function now() return time() end
ns.now = now

function ns.print(msg)
  DEFAULT_CHAT_FRAME:AddMessage("|cffe8a33dwow|r " .. tostring(msg))
end

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
  if handler then pcall(handler, "wow guild: " .. err) end
end

function ns.charKey()
  local name = UnitName("player")
  return name
end

function ns.addonVersion()
  local get = (C_AddOns and C_AddOns.GetAddOnMetadata) or GetAddOnMetadata
  return get and ns.try(get, ADDON, "Version") or "?"
end

-- "0.4.0" < "0.10.0"
function ns.versionLess(a, b)
  if type(a) ~= "string" or type(b) ~= "string" then return false end
  local pa, pb = {}, {}
  for n in string.gmatch(a, "%d+") do pa[#pa + 1] = tonumber(n) end
  for n in string.gmatch(b, "%d+") do pb[#pb + 1] = tonumber(n) end
  for i = 1, 3 do
    local x, y = pa[i] or 0, pb[i] or 0
    if x ~= y then return x < y end
  end
  return false
end

-- Options (Settings → AddOns → wow guild). Defaults are on.
ns.DEFAULTS = { blizzardStyle = false, tooltips = true, minimapButton = true, loginNews = true, autoGuide = true, trackerOnLogin = true, collectBank = true, updateNotice = true }
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
  db.ctaQueue = db.ctaQueue or {}
  db.roster = db.roster or { members = {} }
  -- Keep the call-to-arms queue short: the site ignores repeats anyway.
  local fresh = {}
  for _, q in ipairs(db.ctaQueue) do
    if q.at and now() - q.at < 86400 then fresh[#fresh + 1] = q end
  end
  db.ctaQueue = fresh
  ns.db = db
end

-- ---------- call to arms ----------
-- /wow cta Crossroads 5 Alliance hitting the flight master
-- /wow cta 5 need help here      (uses your current zone)
-- /wow cta                       (current zone, no details)
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
  ns.addCta(zone, needed, msg)
end

-- Used by the slash command and the Call to arms form.
function ns.addCta(zone, needed, msg)
  if not zone or zone == "" then zone = (GetZoneText and GetZoneText()) or "Unknown" end
  table.insert(ns.db.ctaQueue, { zone = zone, needed = needed, msg = msg or "", at = now(), character = UnitName("player") })
  ns.print(string.format("Call to arms queued for %s. It goes to Discord when you reload or log out.", zone))
  StaticPopup_Show("WOWGUILD_RELOAD_NOW")
end

StaticPopupDialogs["WOWGUILD_RELOAD_NOW"] = {
  text = "Send the call to arms now?\nThis reloads your interface (a few seconds).",
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
SlashCmdList["WOWGUILD"] = function(input)
  local cmd, rest = string.match(input or "", "^(%S*)%s*(.-)$")
  cmd = string.lower(cmd or "")
  if cmd == "cta" then
    ns.queueCta(rest)
  elseif cmd == "sync" then
    ns.collectAll("manual")
    ns.print("Data saved. Reload or log out and the companion will upload it.")
    StaticPopup_Show("WOWGUILD_RELOAD_NOW")
  elseif cmd == "status" then
    local c = ns.db.characters[ns.charKey()] or {}
    local profs = c.professions and #c.professions or 0
    local recipes = 0
    for _, list in pairs(c.recipes or {}) do recipes = recipes + #list end
    ns.print(string.format("%d professions and %d recipes saved for this character. Guild roster: %d members.",
      profs, recipes, #(ns.db.roster.members or {})))
    local inbox = WowGuildInbox
    ns.print(inbox and ("Last news from the site: " .. date("%d %b %H:%M", inbox.generatedAt or 0)) or "No news from the site yet. Is the companion running?")
  elseif cmd == "guide" then
    ns.prof.toggleGuide()
  elseif cmd == "list" then
    if rest == "clear" then ns.prof.clearList() else ns.prof.toggleTracker() end
  elseif cmd == "welcome" then
    ns.welcome.showWelcome()
  elseif cmd == "coach" then
    if rest == "" then ns.coachUI.toggle() else ns.coachUI.show(rest == "ask" and "ask" or rest == "build" and "build" or "steps") end
  elseif cmd == "options" or cmd == "config" then
    ns.ui.show("settings")
  elseif cmd == "debug" then
    ns.showReport()
  elseif cmd == "help" then
    ns.print("/wow  open the guild panel")
    ns.print("/wow cta [zone] [number] [message]  call guildies to a fight")
    ns.print("/wow sync  save everything now")
    ns.print("/wow status  what's been saved")
    ns.print("/wow guide  show or hide the skill-up guide (next to your profession window)")
    ns.print("/wow list  show or hide your shopping list;  /wow list clear  empties it")
    ns.print("/wow coach  your play style, build plan and next steps (/wow coach ask to ask a question)")
    ns.print("/wow options  addon settings")
    ns.print("/wow debug  problem report to copy and send")
  else
    ns.togglePanel()
  end
end

-- ---------- events ----------
local f = CreateFrame("Frame")
ns.events = f
f:RegisterEvent("ADDON_LOADED")
f:RegisterEvent("PLAYER_LOGIN")
f:RegisterEvent("PLAYER_LOGOUT")
f:SetScript("OnEvent", function(self, event, ...)
  if event == "ADDON_LOADED" then
    if ... == ADDON then initDB() end
  elseif event == "PLAYER_LOGIN" then
    ns.onLogin()
  elseif event == "PLAYER_LOGOUT" then
    -- Last chance to save. No combat checks needed: logout can't happen mid-fight.
    ns.collectCharacter()
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
