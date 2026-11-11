-- Guild Camp: getting started. A short list of first things to do in the guild, ticked off as they happen, for a
-- new member's first week (and anyone who hasn't done them). Kept per account in WowGuildDB.trail. Nothing here is
-- shared; "Tell the guild" at the end is one guild chat line the player sends with a click.
-- The page is in MainUI.lua (Camp › Getting started).
local ADDON, ns = ...
local T = {}
ns.trail = T

local function book()
  ns.db.trail = ns.db.trail or {}
  return ns.db.trail
end

-- Each step: id, what to do, why, the page of the guild window that does it, and how it's known to be done
-- (`check` looks at what's there now; otherwise it's ticked when the action happens, see the hooks below).
T.STEPS = {
  { id = "app", title = "Get the Guild Camp app running", why = "It brings the guild's news, raids and prices into the game.", page = "camp",
    check = function() return type(WowGuildInbox) == "table" end },
  { id = "prof", title = "Open your profession windows once", why = "So guildies can find you when they need something crafted.", page = "prof",
    check = function()
      local me = ns.db.characters and ns.charKey and ns.db.characters[ns.charKey()]
      return type(me) == "table" and type(me.professions) == "table" and #me.professions > 0
    end },
  { id = "group", title = "Join or start a guild group", why = "A dungeon run or a PvP premade with guildies.", page = "groups" },
  { id = "social", title = "Post on the board or answer a call to arms", why = "Sell something, ask for help, or ride to a fight.", page = "board" },
  { id = "give", title = "Give something to a guild goal", why = "Every gift counts for the season leaderboard.", page = "goals" },
}

function T.done(id)
  local b = book()
  if not b[id] then
    b[id] = time()
    if ns.ui and ns.ui.refreshIfShown then ns.safely(ns.ui.refreshIfShown) end
  end
end

-- → { { id, title, why, page, done } }, how many are done, and whether all are.
function T.state()
  local b, out, n = book(), {}, 0
  for _, s in ipairs(T.STEPS) do
    local done = b[s.id] ~= nil
    if not done and s.check then
      local ok, yes = pcall(s.check)
      if ok and yes then b[s.id] = time(); done = true end
    end
    if done then n = n + 1 end
    out[#out + 1] = { id = s.id, title = s.title, why = s.why, page = s.page, done = done }
  end
  return out, n, n == #T.STEPS
end

-- One line for the Today page while there's something left: "Getting started: 3 of 5 done.", or nil.
function T.line()
  if book().hidden then return nil end
  local _, n, all = T.state()
  if all then return nil end
  return string.format("Getting started: %d of %d done.", n, #T.STEPS)
end

-- "I'm done": one line in guild chat, once. → the line, or nil.
function T.announce()
  local _, _, all = T.state()
  if not all or book().told then return nil end
  local send = (C_ChatInfo and C_ChatInfo.SendChatMessage) or SendChatMessage
  if not send or (IsInGuild and not ns.try(IsInGuild)) then return nil end
  local text = "[Guild Camp] I've finished getting started: app running, professions listed, grouped up, posted and given to a guild goal."
  if not pcall(send, text, "GUILD") then return nil end
  book().told = time()
  return text
end

function T.hide(on) book().hidden = on and true or nil end

-- Tick a step when its action succeeds. The pages call these through the module tables, so wrapping the field is
-- enough; each wrapper passes everything through unchanged.
local function hook(tbl, name, id)
  if type(tbl) ~= "table" or type(tbl[name]) ~= "function" then return end
  local orig = tbl[name]
  tbl[name] = function(...)
    local a, b, c = orig(...)
    if a then ns.safely(T.done, id) end
    return a, b, c
  end
end

ns.on("PLAYER_LOGIN", function()
  hook(ns.lfg, "new", "group"); hook(ns.lfg, "join", "group")
  hook(ns.board, "post", "social"); hook(ns.presence, "answer", "social"); hook(ns, "addCta", "social")
  hook(ns.goals, "give", "give")
end)
