-- Guild Camp: a small public API for other addons (the Warband Codex uses it). Everything here is a thin wrapper
-- around what the addon already does, so the same rules apply: the guild's records travel through Share.lua,
-- nothing happens without the player's click, and callers get plain copies, never the addon's own tables.
--
--   GuildCampAPI.version                         1
--   GuildCampAPI.guild()                         the guild's name from the app's news, or nil
--   GuildCampAPI.kos()                           { { name, reason, by, t } }, the guild's kill-on-sight list
--   GuildCampAPI.kosAdd(name, reason) / kosRemove(name)
--   GuildCampAPI.groups()                        open dungeon groups: { { n, dungeon, leader, role, startsAt, note,
--                                                need = { t, h, d }, members = { { name, role } }, mine, joined, waiting } }
--   GuildCampAPI.groupNew(role, dungeon) / groupJoin(n, role) / groupLeave(n)     n as in groups()
--   GuildCampAPI.raids()                         { { title, startsAt, coming, signup, role } } from the app's news
--   GuildCampAPI.crafters(itemName)              "Name1,Name2" of guild crafters, or nil
--   GuildCampAPI.publish(addon, key, value)      keep a table in WowGuildDB.ext[addon][key] (saved with the addon's
--                                                data, where the Guild Camp app can read it)
--   GuildCampAPI.open(page)                      open the guild window on a page
local ADDON, ns = ...
if type(ns) ~= "table" then ns = {} end

local api = { version = 1 }

function api.guild()
  local inbox = WowGuildInbox
  return type(inbox) == "table" and inbox.guild or nil
end

function api.kos()
  local out = {}
  if not (ns.hunt and ns.hunt.kos) then return out end
  for _, k in ipairs(ns.try(ns.hunt.kos) or {}) do out[#out + 1] = { name = k.name, reason = k.reason, by = k.by, t = k.t } end
  return out
end
function api.kosAdd(name, reason) return ns.hunt and ns.hunt.add and ns.safely(ns.hunt.add, name, reason) or false end
function api.kosRemove(name) return ns.hunt and ns.hunt.remove and ns.safely(ns.hunt.remove, name) or false end

function api.groups()
  local out = {}
  local L = ns.lfg
  if not (L and L.groups) then return out end
  local groups = ns.try(L.groups) or {}
  L.last = groups   -- so groupJoin(n) and groupLeave(n) mean the same group as /wow lfg join n
  for i, e in ipairs(groups) do
    local f = e.rec.fields or {}
    local members = { { name = f.character, role = f.role } }
    for _, m in ipairs(e.g.members) do members[#members + 1] = { name = m.character, role = m.role } end
    out[#out + 1] = { n = i, dungeon = f.dungeon, leader = f.character, role = f.role, startsAt = tonumber(f.startsAt) or 0, note = f.note,
      need = { t = e.g.open.t, h = e.g.open.h, d = e.g.open.d }, members = members,
      mine = e.mine and true or false, joined = e.joined ~= nil, waiting = (e.joined and e.joined.waiting) and true or false }
  end
  return out
end
function api.groupNew(role, dungeon)
  return ns.lfg and ns.lfg.new and ns.safely(ns.lfg.new, tostring(role or "") .. " " .. tostring(dungeon or "")) or false
end
function api.groupJoin(n, role) return ns.lfg and ns.lfg.join and ns.safely(ns.lfg.join, n, role) or false end
function api.groupLeave(n) return ns.lfg and ns.lfg.leave and ns.safely(ns.lfg.leave, n) or false end

function api.raids()
  local out = {}
  local inbox = WowGuildInbox
  for _, x in ipairs(type(inbox) == "table" and type(inbox.raids) == "table" and inbox.raids or {}) do
    out[#out + 1] = { title = x.title, startsAt = x.startsAt, coming = x.coming, signup = x.signup, role = x.role }
  end
  return out
end

function api.crafters(itemName)
  return ns.tooltip and ns.tooltip.craftersFor and ns.try(ns.tooltip.craftersFor, itemName) or nil
end

-- One table per addon and key, at most 32 KB when the game writes it: a snapshot, not a log.
function api.publish(addon, key, value)
  if type(addon) ~= "string" or type(key) ~= "string" or type(value) ~= "table" or not ns.db then return false end
  if not string.match(addon, "^[%w_]+$") or not string.match(key, "^[%w_]+$") then return false end
  ns.db.ext = type(ns.db.ext) == "table" and ns.db.ext or {}
  ns.db.ext[addon] = type(ns.db.ext[addon]) == "table" and ns.db.ext[addon] or {}
  ns.db.ext[addon][key] = { at = (GetServerTime and ns.try(GetServerTime)) or time(), data = value }
  return true
end

function api.open(page)
  if ns.ui and ns.ui.show then ns.safely(ns.ui.show, page) return true end
  return false
end

GuildCampAPI = api
