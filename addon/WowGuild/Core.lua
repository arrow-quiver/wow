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

function ns.charKey()
  local name = UnitName("player")
  return name
end

local function initDB()
  WowGuildDB = WowGuildDB or {}
  local db = WowGuildDB
  db.version = ns.VERSION
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
  table.insert(ns.db.ctaQueue, { zone = zone, needed = needed, msg = msg, at = now(), character = UnitName("player") })
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
  elseif cmd == "help" then
    ns.print("/wow  open the guild panel")
    ns.print("/wow cta [zone] [number] [message]  call guildies to a fight")
    ns.print("/wow sync  save everything now")
    ns.print("/wow status  what's been saved")
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
  elseif ns.handlers and ns.handlers[event] then
    ns.handlers[event](...)
  end
end)

function ns.on(event, fn)
  ns.handlers = ns.handlers or {}
  ns.handlers[event] = fn
  ns.try(f.RegisterEvent, f, event)
end
