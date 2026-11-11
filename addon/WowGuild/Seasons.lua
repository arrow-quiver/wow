-- Guild Camp: guild seasons in game. Guildies' season titles, ranks and badges on their player tooltips, and
-- /wow season for this month's board. The Guild Camp app works the season out from the guild's shared data and
-- writes it to the inbox (WowGuildInbox.seasons: { month, daysLeft, count, players = { [name] = { title, rank, score,
-- streak, badges, best } }, board = { { rank, name, class, score, streak, title, gold, kills, crafts, raids } },
-- leaders = { { title, name, value, unit } } }), so it changes after a /reload. The board is the Leaderboard page of
-- the guild window (MainUI.lua).
local ADDON, ns = ...
local SE = {}
ns.seasons = SE

local GOLD = "|cffe8a33d"

function SE.data()
  local s = WowGuildInbox and WowGuildInbox.seasons
  return type(s) == "table" and type(s.players) == "table" and s or nil
end

local function short(name) return type(name) == "string" and (string.match(name, "^([^%-%s]+)") or name) or nil end

-- → the season entry for a character name ("Grom" or "Grom-Realm"), or nil.
function SE.of(name)
  local s = SE.data()
  local n = short(name)
  if not s or not n then return nil end
  return s.players[n] or s.players[name]
end

-- The tooltip line: "Guild Camp: Quartermaster · #2 this season · 5 badges (best: Patron)", or nil.
function SE.line(name)
  local p = SE.of(name)
  if not p then return nil end
  local parts = {}
  if p.title and p.title ~= "" then parts[#parts + 1] = p.title end
  if (p.rank or 0) > 0 then parts[#parts + 1] = string.format("#%d this season", p.rank) end
  if (p.streak or 0) >= 2 then parts[#parts + 1] = string.format("%d-week streak", p.streak) end
  if (p.badges or 0) > 0 then
    parts[#parts + 1] = string.format("%d badge%s%s", p.badges, p.badges == 1 and "" or "s", p.best and p.best ~= "" and (" (best: " .. p.best .. ")") or "")
  end
  if #parts == 0 then return nil end
  return GOLD .. "Guild Camp:|r " .. table.concat(parts, " · ")
end

local function onUnitTooltip(tooltip)
  if ns.opt("seasonTooltips") == false or not tooltip or not tooltip.GetUnit then return end
  local ok, _, unit = pcall(tooltip.GetUnit, tooltip)
  if not ok or not unit then return end
  local isPlayer = UnitIsPlayer and ns.try(UnitIsPlayer, unit)
  if not isPlayer then return end
  local okName, name = pcall(UnitName, unit)
  if not okName or type(name) ~= "string" then return end
  local text
  local okLine = pcall(function() text = SE.line(name) end) -- the name can be a value the game keeps secret
  if okLine and text then tooltip:AddLine(text, 1, 1, 1, true); if tooltip.Show then tooltip:Show() end end
end
SE.onUnitTooltip = onUnitTooltip

local hooked = false
function SE.hook()
  if hooked then return end
  hooked = true
  if TooltipDataProcessor and TooltipDataProcessor.AddTooltipPostCall and Enum and Enum.TooltipDataType and Enum.TooltipDataType.Unit then
    TooltipDataProcessor.AddTooltipPostCall(Enum.TooltipDataType.Unit, function(tooltip) ns.safely(onUnitTooltip, tooltip) end)
  elseif GameTooltip and GameTooltip.HookScript then
    GameTooltip:HookScript("OnTooltipSetUnit", function(tooltip) ns.safely(onUnitTooltip, tooltip) end)
  end
end

-- The board, best first: { { rank, name, class, score, streak, title, gold, kills, crafts, raids, me } }.
-- From the app's `board`; with an older app, from the per-character entries (one row per rank, no class or counts).
function SE.board()
  local s = SE.data()
  if not s then return {} end
  local me = UnitName and ns.try(UnitName, "player")
  local mine = me and SE.of(me)
  local myRank = mine and (mine.rank or 0) > 0 and mine.rank or nil
  local rows = {}
  if type(s.board) == "table" and #s.board > 0 then
    for _, r in ipairs(s.board) do
      rows[#rows + 1] = { rank = r.rank or 0, name = r.name or "?", class = r.class, score = r.score or 0, streak = r.streak or 0, title = r.title or "",
        gold = r.gold or 0, kills = r.kills or 0, crafts = r.crafts or 0, raids = r.raids or 0, me = myRank ~= nil and r.rank == myRank }
    end
  else
    local seen = {}
    for name, p in pairs(s.players) do
      local rank = p.rank or 0
      -- A player's characters share a rank: my own character stands for me, otherwise the first name in the alphabet.
      if rank > 0 and (not seen[rank] or (name == me) or (seen[rank].name ~= me and name < seen[rank].name)) then
        seen[rank] = { rank = rank, name = name, score = p.score or 0, streak = p.streak or 0, title = p.title or "", me = rank == myRank }
      end
    end
    for _, r in pairs(seen) do rows[#rows + 1] = r end
  end
  table.sort(rows, function(a, b) if a.rank ~= b.rank then return a.rank < b.rank end return a.name < b.name end)
  return rows, s
end

-- /wow season: the top five and me.
function SE.slash()
  local s = SE.data()
  if not s or next(s.players) == nil then
    ns.print("No season standings yet. They come from the Guild Camp app: keep it running and /reload.")
    return
  end
  local rows = {}
  for name, p in pairs(s.players) do if (p.rank or 0) > 0 then rows[#rows + 1] = { name = name, p = p } end end
  table.sort(rows, function(a, b) return a.p.rank < b.p.rank end)
  local seenRank, shown, me = {}, 0, UnitName and UnitName("player")
  ns.print(string.format("Season %s:", s.month or ""))
  for _, r in ipairs(rows) do
    if not seenRank[r.p.rank] and shown < 5 then
      seenRank[r.p.rank] = true; shown = shown + 1
      ns.print(string.format("  #%d %s  %d points%s", r.p.rank, r.name, r.p.score or 0, r.p.title ~= "" and ("  " .. r.p.title) or ""))
    end
  end
  local mine = me and SE.of(me)
  if mine and (mine.rank or 0) > 0 then
    ns.print(string.format("You: #%d with %d points%s.", mine.rank, mine.score or 0, (mine.streak or 0) >= 2 and string.format(", a %d-week streak", mine.streak) or ""))
  else
    ns.print("You're not on the board yet: give to the guild bank, fill a crafting request, raid or fight in the open world.")
  end
end

ns.on("PLAYER_LOGIN", function() ns.safely(SE.hook) end)
