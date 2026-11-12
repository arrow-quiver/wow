-- Guild Camp: mats for crafts. Two nudges, both from what the guild already shares:
--   * You hold mats a guildie is short of: each addon shares what its shopping list still lacks ("mw" record:
--     item ids and counts, docs/SHARING.md). If your bags hold some, you hear about it once a day.
--   * A guildie wants something you can craft: an open crafting request or guild bank request for an item one of
--     your characters has the recipe for.
-- /wow mats lists both with a Whisper button each (sent on your click). Option matsNudges.
local ADDON, ns = ...
local MM = {}
ns.mats = MM

MM.MAX = 15
MM.CHECK_EVERY = 600
local GOLD = "|cffe8a33d"

local function S() local s = ns.Share; if type(s) == "table" and type(s.list) == "function" then return s end end
local function me() return UnitName and UnitName("player") or "?" end
local function now() return (GetServerTime and ns.try(GetServerTime)) or time() end
local function short(n) return n and (string.match(n, "^([^%-%s]+)") or n) or nil end
local function itemName(id) return (C_Item and C_Item.GetItemNameByID and ns.try(C_Item.GetItemNameByID, id)) or (GetItemInfo and ns.try(GetItemInfo, id)) or ("item " .. id) end

-- ---------- my side: what my shopping list is short of ----------
function MM.wanted()
  local out = {}
  for _, r in ipairs((ns.prof and ns.prof.remaining and ns.try(ns.prof.remaining)) or {}) do
    local short = (r.need or 0) - (r.have or 0) - (r.alts or 0)
    if short > 0 and #out < MM.MAX then out[#out + 1] = { id = r.id, qty = short } end
  end
  return out
end

-- The "mw" record (Collect.sharedRecords). Once a list has been shared, an empty one goes out too (to clear it).
function MM.record(pid)
  if not pid or not ns.db then return nil end
  local items = MM.wanted()
  if #items == 0 and not ns.db.matsShared then return nil end
  ns.db.matsShared = #items > 0 or nil
  return { type = "mw", key = pid, fields = { items = items } }
end

-- ---------- their side ----------
-- My characters' names (this one and the alts the addon has seen).
local function myNames()
  local out = { [string.lower(me())] = true }
  for key in pairs((ns.db and ns.db.characters) or {}) do local n = short(key); if n then out[string.lower(n)] = true end end
  return out
end

local function iCanCraft(item)
  local who = item and ns.tooltip and ns.tooltip.craftersFor and ns.tooltip.craftersFor(item)
  if not who then return nil end
  local mine = myNames()
  for n in string.gmatch(who, "[^,]+") do if mine[string.lower(n)] then return n end end
end
MM.iCanCraft = iCanCraft

-- → { have = { { who, id, name, qty, mine } }, craft = { { who, item, count, kind, as } } }
function MM.matches()
  local sh = S()
  local out = { have = {}, craft = {} }
  if not sh then return out end
  local mine = myNames()
  for _, r in ipairs(sh.list("mw")) do
    if r.author and not mine[string.lower(r.author)] then
      for _, it in ipairs((r.fields and r.fields.items) or {}) do
        local have = ns.prof and ns.prof.owned and ns.prof.owned(it.id) or 0
        if have > 0 then out.have[#out.have + 1] = { who = r.author, id = it.id, name = itemName(it.id), qty = it.qty, mine = have } end
      end
    end
  end
  for _, ty in ipairs({ "cr", "bq" }) do
    for _, r in ipairs(sh.list(ty)) do
      local f = r.fields or {}
      if f.state == "o" and r.author and not mine[string.lower(r.author)] then
        local as = iCanCraft(f.item)
        if as then out.craft[#out.craft + 1] = { who = r.author, item = f.item, count = f.count or 1, kind = ty, as = as } end
      end
    end
  end
  return out
end

-- Once a day for each (who, item): a chat line. → how many lines.
function MM.nudge()
  if ns.opt("matsNudges") == false then return 0 end
  ns.db.nudged = ns.db.nudged or {}
  local day = math.floor(now() / 86400)
  for k, d in pairs(ns.db.nudged) do if d < day - 7 then ns.db.nudged[k] = nil end end
  local m, n = MM.matches(), 0
  local function once(key, line)
    if ns.db.nudged[key] == day then return end
    ns.db.nudged[key] = day
    ns.print(GOLD .. line .. "|r /wow mats")
    n = n + 1
  end
  for _, h in ipairs(m.have) do
    once("h:" .. h.who .. ":" .. h.id, string.format("%s is short of %d × %s for crafting. You have %d.", h.who, h.qty, h.name, h.mine))
  end
  for _, c in ipairs(m.craft) do
    once("c:" .. c.who .. ":" .. c.item, string.format("%s wants %s%s (%s). %s can make it.", c.who, c.count > 1 and (c.count .. " × ") or "", c.item,
      c.kind == "bq" and "a guild bank request" or "a crafting request", c.as == me() and "You" or c.as))
  end
  return n
end

local function plain(s) return (string.gsub(tostring(s or ""), "|", "||")) end

local function whisper(text, to)
  local send = (C_ChatInfo and C_ChatInfo.SendChatMessage) or SendChatMessage
  return send and pcall(send, text, "WHISPER", nil, to) or false
end

-- Rows for a list: { text, button = { "Whisper", fn } }. One whisper per click.
function MM.rows()
  local m = MM.matches()
  local rows = {}
  for _, h in ipairs(m.have) do
    rows[#rows + 1] = { text = string.format("%s needs %d × %s |cff9e9ea8(you have %d)|r", h.who, h.qty, h.name, h.mine), button = { "Whisper", function()
      whisper(string.format("Hi %s! I have %d %s for your crafting. Want them?", h.who, math.min(h.qty, h.mine), h.name), h.who)
    end } }
  end
  for _, c in ipairs(m.craft) do
    -- The item and names come from guildmates' records: "|" is doubled so they show as written.
    rows[#rows + 1] = { text = string.format("%s wants %s%s |cff9e9ea8(%s)|r", plain(c.who), c.count > 1 and (c.count .. " × ") or "", plain(c.item), plain(c.as)), button = { "Whisper", function()
      whisper(string.format("Hi %s! I can make %s for you. Send me the mats or tell me what you've got.", c.who, c.item), c.who)
    end } }
  end
  return rows
end

function MM.show()
  local rows = MM.rows()
  if #rows == 0 then ns.print("No mats or crafts wanted that you can help with right now."); return 0 end
  if ns.helpers and ns.helpers.show then ns.helpers.show("Mats and crafts wanted", "Guildies you can help, from what you hold and can make", rows) end
  return #rows
end

local last = 0
local function maybeNudge()
  if now() - last < MM.CHECK_EVERY then return end
  last = now()
  MM.nudge()
end

ns.on("PLAYER_LOGIN", function()
  if C_Timer and C_Timer.After then C_Timer.After(60, function() ns.safely(maybeNudge) end) end
end)
ns.on("BAG_UPDATE_DELAYED", function() ns.safely(maybeNudge) end)
