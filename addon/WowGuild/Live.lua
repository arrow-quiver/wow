-- Guild Camp: the live link. The Guild Camp app follows the game's combat log file while you play (kills, deaths,
-- "Why did I die?" in its Coach overlay). The game only writes that file while combat logging is on; with this
-- option the addon turns it on at every login. Addons can't talk to the app directly while you play: this file is
-- the game's own, written by the game.
local ADDON, ns = ...
local L = {}
ns.live = L

local function logging() return LoggingCombat and ns.try(LoggingCombat) end

function L.enable(quiet)
  if not LoggingCombat then if not quiet then ns.print("This game version can't write a combat log.") end return false end
  if not logging() then ns.try(LoggingCombat, true) end
  -- The chat log too: the app reads your calls to arms from it and posts them to Discord at once.
  if LoggingChat and not ns.try(LoggingChat) then ns.try(LoggingChat, true) end
  local on = logging() and true or false
  if not quiet then
    ns.print(on and "Combat logging is on. The Guild Camp app's live link can follow your fights."
      or "Couldn't turn on combat logging. Type /combatlog instead.")
  end
  return on
end

function L.slash(rest)
  rest = string.lower(rest or "")
  ns.db.options = ns.db.options or {}
  if rest == "on" then
    ns.db.options.liveLink = true
    L.enable(false)
    ns.print("It turns on again every time you log in. /wow live off stops that.")
  elseif rest == "off" then
    ns.db.options.liveLink = false
    if LoggingCombat and logging() then ns.try(LoggingCombat, false) end
    if LoggingChat and ns.try(LoggingChat) then ns.try(LoggingChat, false) end
    ns.print("Combat logging is off, and won't turn on when you log in.")
  else
    ns.print("Live link: " .. (logging() and "combat logging is on." or "combat logging is off.")
      .. (ns.opt("liveLink") and " It turns on at every login." or " /wow live on turns it on at every login."))
  end
end

ns.on("PLAYER_LOGIN", function() if ns.opt("liveLink") then L.enable(true) end end)
