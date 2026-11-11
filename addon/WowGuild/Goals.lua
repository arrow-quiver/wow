-- Guild Camp: the guild's goals in game. Two kinds, both set by officers in the Guild Camp app and shared through
-- the guild like everything else (docs/SHARING.md):
--   * supply drives ("DR" records): "200 Runecloth for the bank". Members say what they gave ("dc" records, one
--     per gift, their own); the bar is the sum.
--   * zone bounties ("BT" with a zone): "10 kills in Hillsbrad". Progress is the guild's kills recorded for it
--     ("kk" records naming the bounty; Hunt.lua records them).
-- This file reads both and adds a gift to a drive. The page is in MainUI.lua (Camp › Guild goals).
local ADDON, ns = ...
local G = {}
ns.goals = G

G.MAX_GIFT = 100000

local function now() return (GetServerTime and ns.try(GetServerTime)) or time() end
local function S() local s = ns.Share; if type(s) == "table" and type(s.list) == "function" then return s end end
local function plain(s) return (string.gsub(tostring(s or ""), "|", "||")) end

-- Open drives, the newest first:
-- { { key, title, unit, goal, notes, total, mine, givers = { { name, amount } } (most first), done } }.
function G.drives()
  local sh, out = S(), {}
  if not sh then return out end
  local pid = sh.myPid and ns.try(sh.myPid)
  local gifts = {}
  for _, c in ipairs(sh.list("dc")) do
    local f = c.fields
    if type(f) == "table" and type(f.drive) == "string" and (tonumber(f.amount) or 0) > 0 then
      gifts[f.drive] = gifts[f.drive] or {}
      table.insert(gifts[f.drive], { who = (type(f.character) == "string" and f.character ~= "" and f.character) or c.author or "?", amount = math.floor(tonumber(f.amount)), mine = pid ~= nil and f.pid == pid })
    end
  end
  for _, r in ipairs(sh.list("DR")) do
    local f = r.fields
    if type(f) == "table" and f.state == "o" then
      local total, mine, by = 0, 0, {}
      for _, g in ipairs(gifts[r.key] or {}) do
        total = total + g.amount
        if g.mine then mine = mine + g.amount end
        by[g.who] = (by[g.who] or 0) + g.amount
      end
      local givers = {}
      for name, amount in pairs(by) do givers[#givers + 1] = { name = name, amount = amount } end
      table.sort(givers, function(a, b) if a.amount ~= b.amount then return a.amount > b.amount end return a.name < b.name end)
      local goal = math.max(0, math.floor(tonumber(f.goal) or 0))
      out[#out + 1] = { key = r.key, title = plain(f.title ~= "" and f.title or "Drive"), unit = plain(f.unit or ""), goal = goal, notes = plain(f.notes or ""),
        total = total, mine = mine, givers = givers, done = goal > 0 and total >= goal, t = r.t or 0 }
    end
  end
  table.sort(out, function(a, b) if a.t ~= b.t then return a.t > b.t end return a.key < b.key end)
  return out
end

-- "I gave <amount>" to a drive. → true when it went to the guild.
function G.give(key, amount, note)
  local n = tonumber(amount)
  n = n and math.floor(n)
  if not n or n < 1 or n > G.MAX_GIFT then ns.print("Write how many you gave, as a number."); return false end
  local sh = S()
  local pid = sh and sh.myPid and ns.try(sh.myPid)
  if not sh or not pid or type(sh.putLocal) ~= "function" then ns.print("Couldn't record that. Guild sharing starts a little after login: try again in a minute."); return false end
  local drive
  for _, d in ipairs(G.drives()) do if d.key == key then drive = d end end
  if not drive then ns.print("That drive has ended."); return false end
  local ok, res = pcall(sh.putLocal, "dc", ns.randomKey(), { pid = pid, drive = key, character = (UnitName and UnitName("player")) or "?", amount = n, note = string.sub(note or "", 1, 120) })
  if not ok or not res then ns.print("Couldn't send that to your guild. Try again in a moment."); return false end
  ns.print(string.format("Recorded: %d %s for %s. Thank you!", n, drive.unit ~= "" and drive.unit or "given", drive.title))
  return true
end

-- Open zone bounties with how far the guild is: { { key, zone, points, cap, done, ends, note } }, soonest to end first.
function G.hunts()
  local sh, out, t = S(), {}, now()
  if not sh then return out end
  local claims = {}
  for _, k in ipairs(sh.list("kk")) do
    local b = type(k.fields) == "table" and k.fields.bounty
    if type(b) == "string" and b ~= "" then claims[b] = (claims[b] or 0) + 1 end
  end
  for _, r in ipairs(sh.list("BT")) do
    local f = r.fields
    if type(f) == "table" and f.state == "o" and (f.points or 0) > 0 and (f.ends or 0) > t and type(f.zone) == "string" and f.zone ~= "" and (f.target or "") == "" then
      local cap = math.max(1, math.floor(tonumber(f.cap) or 1))
      out[#out + 1] = { key = r.key, zone = plain(f.zone), points = f.points, cap = cap, done = math.min(cap, claims[r.key] or 0), ends = f.ends, note = plain(f.note or "") }
    end
  end
  table.sort(out, function(a, b) if a.ends ~= b.ends then return a.ends < b.ends end return a.key < b.key end)
  return out
end

-- One line for the login news: "2 guild goals open: Runecloth for the bank 120/200 · Hillsbrad 3/10 kills", or nil.
function G.line()
  local parts = {}
  for _, d in ipairs(G.drives()) do
    if not d.done then parts[#parts + 1] = string.format("%s %d/%d", d.title, d.total, d.goal) end
  end
  for _, h in ipairs(G.hunts()) do
    if h.done < h.cap then parts[#parts + 1] = string.format("%s %d/%d kills", h.zone, h.done, h.cap) end
  end
  if #parts == 0 then return nil end
  return string.format("%d guild %s open: %s", #parts, #parts == 1 and "goal" or "goals", table.concat(parts, " · "))
end
