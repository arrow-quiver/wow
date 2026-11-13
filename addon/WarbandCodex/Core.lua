-- Warband Codex: core. Saved data, events, options, the module registry and slash commands.
--
-- Rules this addon keeps (the same as Guild Camp, docs/CONTRIBUTING.md): everything runs out of combat, only our own
-- frames, no Blizzard popups, no COMBAT_LOG_EVENT_UNFILTERED, nothing sent for the player without a click.
-- WoW Forever is still changing, so the addon ships the Classic baseline and learns the rest while you play
-- (loot seen, trainers visited, talent trees, beasts met). Learned data is kept account-wide in WarbandCodexDB.
local ADDON, ns = ...
if type(ns) ~= "table" then ns = {} end

ns.NAME = "Warband Codex"
ns.PREFIX = "WBCodex"
ns.modules = {}       -- id → module
ns.moduleList = {}    -- in registration order
ns.options = {}       -- key → { key, label, desc, group, default }
ns.optionList = {}

-- ---------- safe calls ----------
local function passOk(ok, ...) if ok then return ... end end
-- An API missing in this game version must never break the addon.
function ns.try(fn, ...)
  if type(fn) ~= "function" then return end
  return passOk(pcall(fn, ...))
end

-- The game hides some values from addons in combat ("secret values"): using one is an error. Code that reads
-- units or chat lines runs through ns.try, so it stops quietly, and checks names with ns.secret first.
function ns.secret(v) return issecretvalue ~= nil and issecretvalue(v) == true end

ns.errors = {}
function ns.reportError(err)
  err = tostring(err)
  ns.debugError = err
  table.insert(ns.errors, 1, err)
  while #ns.errors > 5 do table.remove(ns.errors) end
  local handler = geterrorhandler and geterrorhandler()
  if handler then pcall(handler, "Warband Codex: " .. err) end
end
local function reportOk(ok, ...)
  if ok then return ... end
  ns.reportError((...))
end
-- Run from a click, timer or event: an error is reported, never thrown into the game.
function ns.safely(fn, ...)
  if type(fn) ~= "function" then return end
  return reportOk(pcall(fn, ...))
end

-- tonumber for a call that may return nothing at all: ns.n(ns.try(fn)) is nil then, where tonumber() would raise.
function ns.n(v) return tonumber(v) end

function ns.print(msg)
  if DEFAULT_CHAT_FRAME then DEFAULT_CHAT_FRAME:AddMessage("|cffe8c884Warband Codex|r " .. tostring(msg)) end
end

function ns.now() return (GetServerTime and ns.try(GetServerTime)) or time() end
function ns.short(n) return n and (string.match(n, "^([^%-%s]+)") or n) or nil end
function ns.plain(s) return (string.gsub(tostring(s or ""), "|", "||")) end
function ns.inCombat() return InCombatLockdown and InCombatLockdown() == true end

-- ---------- the player ----------
function ns.me() return (UnitName and UnitName("player")) or "?" end
function ns.class()
  local _, token = ns.try(UnitClass, "player")
  return token or "WARRIOR"
end
function ns.level() return ns.n(ns.try(UnitLevel, "player")) or 1 end
function ns.faction() return ns.try(UnitFactionGroup, "player") or "Horde" end
function ns.zone() return (GetRealZoneText and ns.try(GetRealZoneText)) or (GetZoneText and ns.try(GetZoneText)) or "" end
function ns.charKey()
  local realm = (GetRealmName and ns.try(GetRealmName)) or "Forever"
  return ns.me() .. "-" .. tostring(realm)
end

-- Where the player stands: map id and 0..1 coordinates, in the open world only.
function ns.where()
  if not (C_Map and C_Map.GetBestMapForUnit) then return nil end
  local map = ns.try(C_Map.GetBestMapForUnit, "player")
  if not map then return nil end
  local pos = C_Map.GetPlayerMapPosition and ns.try(C_Map.GetPlayerMapPosition, map, "player")
  if not pos then return { map = map } end
  local x, y
  if pos.GetXY then x, y = ns.try(pos.GetXY, pos) else x, y = pos.x, pos.y end
  if type(x) ~= "number" or type(y) ~= "number" then return { map = map } end
  return { map = map, x = math.floor(x * 1000 + 0.5) / 1000, y = math.floor(y * 1000 + 0.5) / 1000 }
end

-- Put the game's map pin at a learned spot, when this client has user waypoints.
function ns.showOnMap(spot)
  if type(spot) ~= "table" or not spot.map or not spot.x then return false end
  if C_Map and C_Map.SetUserWaypoint and UiMapPoint and UiMapPoint.CreateFromCoordinates then
    local point = ns.try(UiMapPoint.CreateFromCoordinates, spot.map, spot.x, spot.y)
    if point then
      ns.try(C_Map.SetUserWaypoint, point)
      if C_SuperTrack and C_SuperTrack.SetSuperTrackedUserWaypoint then ns.try(C_SuperTrack.SetSuperTrackedUserWaypoint, true) end
      return true
    end
  end
  return false
end

-- ---------- items ----------
function ns.itemInfo(item)
  local info = (C_Item and C_Item.GetItemInfo) or GetItemInfo
  if not info or not item then return nil end
  return ns.try(info, item)
end
function ns.itemId(link)
  if type(link) == "number" then return link end
  return tonumber(string.match(tostring(link or ""), "item:(%d+)"))
end
function ns.itemName(link)
  return string.match(tostring(link or ""), "%[(.-)%]") or (ns.itemInfo(link))
end
function ns.itemIcon(item)
  local id = ns.itemId(item)
  local icon
  if id and C_Item and C_Item.GetItemIconByID then icon = ns.try(C_Item.GetItemIconByID, id) end
  if not icon and id and GetItemIcon then icon = ns.try(GetItemIcon, id) end
  return icon or "Interface\\Icons\\INV_Misc_QuestionMark"
end

-- Bags: calls fn(bag, slot, info) for every filled slot; info = { itemID, stackCount, hyperlink, quality }.
function ns.eachBagItem(fn)
  for bag = 0, (NUM_BAG_SLOTS or 4) do
    local n = 0
    if C_Container and C_Container.GetContainerNumSlots then n = ns.try(C_Container.GetContainerNumSlots, bag) or 0
    elseif GetContainerNumSlots then n = ns.try(GetContainerNumSlots, bag) or 0 end
    for slot = 1, n do
      local info
      if C_Container and C_Container.GetContainerItemInfo then info = ns.try(C_Container.GetContainerItemInfo, bag, slot)
      elseif GetContainerItemInfo then
        local _, count, _, quality, _, _, link = ns.try(GetContainerItemInfo, bag, slot)
        if link then info = { stackCount = count, hyperlink = link, quality = quality, itemID = ns.itemId(link) } end
      end
      if type(info) == "table" then fn(bag, slot, info) end
    end
  end
end
function ns.bagSpace()
  local free, total = 0, 0
  for bag = 0, (NUM_BAG_SLOTS or 4) do
    local n, f = 0, 0
    if C_Container and C_Container.GetContainerNumSlots then
      n = ns.try(C_Container.GetContainerNumSlots, bag) or 0
      f = (C_Container.GetContainerNumFreeSlots and ns.try(C_Container.GetContainerNumFreeSlots, bag)) or 0
    elseif GetContainerNumSlots then
      n = ns.try(GetContainerNumSlots, bag) or 0
      f = (GetContainerNumFreeSlots and ns.try(GetContainerNumFreeSlots, bag)) or 0
    end
    free, total = free + (tonumber(f) or 0), total + (tonumber(n) or 0)
  end
  return free, total
end

function ns.money(copper)
  copper = math.floor(tonumber(copper) or 0)
  local g, s, c = math.floor(copper / 10000), math.floor(copper / 100) % 100, copper % 100
  if g > 0 then return string.format("%dg %ds", g, s) end
  if s > 0 then return string.format("%ds %dc", s, c) end
  return c .. "c"
end

-- ---------- saved data ----------
local function ensure(t, k) if type(t[k]) ~= "table" then t[k] = {} end return t[k] end
ns.ensure = ensure

function ns.initDB()
  if type(WarbandCodexDB) ~= "table" then WarbandCodexDB = {} end
  local db = WarbandCodexDB
  db.v = db.v or 1
  ensure(db, "opts"); ensure(db, "chars"); ensure(db, "learn")
  ns.db = db
  return db
end
-- This character's own data (gear snapshot, recipes, window layout ...).
function ns.char()
  if not ns.db then ns.initDB() end
  local c = ensure(ns.db.chars, ns.charKey())
  c.name, c.class, c.level, c.faction = ns.me(), ns.class(), ns.level(), ns.faction()
  return c
end
-- Account-wide things the addon has learned by playing.
function ns.learned(kind)
  if not ns.db then ns.initDB() end
  return ensure(ns.db.learn, kind)
end

-- ---------- options ----------
-- ns.option{ key, label, desc, group, default }: shown on the Settings page, searchable.
function ns.option(def)
  if ns.options[def.key] then return end
  ns.options[def.key] = def
  ns.optionList[#ns.optionList + 1] = def
end
function ns.opt(key)
  local v = ns.db and ns.db.opts[key]
  if v == nil then local d = ns.options[key]; return d and d.default or false end
  return v
end
function ns.setOpt(key, value)
  if not ns.db then ns.initDB() end
  ns.db.opts[key] = value
  local d = ns.options[key]
  if d and d.onChange then ns.safely(d.onChange, value) end
end

-- ---------- modules ----------
-- ns.module{ id, title, icon, blurb, build(page), refresh(page), search(query) → { { label, sub, icon, go } } }
function ns.module(def)
  ns.modules[def.id] = def
  ns.moduleList[#ns.moduleList + 1] = def
  return def
end

-- ---------- events ----------
local frame = CreateFrame("Frame")
local handlers = {}
function ns.on(event, fn)
  if not handlers[event] then
    handlers[event] = {}
    if event ~= "ADDON_LOADED" and event ~= "PLAYER_LOGIN" then ns.try(frame.RegisterEvent, frame, event) end
  end
  table.insert(handlers[event], fn)
end
local function dispatch(event, ...)
  local list = handlers[event]
  if not list then return end
  for i = 1, #list do ns.safely(list[i], ...) end
end
ns.dispatch = dispatch
frame:RegisterEvent("ADDON_LOADED")
frame:RegisterEvent("PLAYER_LOGIN")
frame:SetScript("OnEvent", function(_, event, ...)
  if event == "ADDON_LOADED" then
    if (...) ~= ADDON then return end
    ns.initDB()
  elseif event == "PLAYER_LOGIN" then
    if not ns.db then ns.initDB() end
    ns.char()
    ns.ready = true
  end
  dispatch(event, ...)
end)

-- ---------- talking to other copies of the addon (guild channel, a few bytes, only on a click) ----------
local msgHandlers = {}
function ns.onMessage(kind, fn) msgHandlers[kind] = fn end
function ns.send(kind, body, channel, target)
  local send = C_ChatInfo and C_ChatInfo.SendAddonMessage
  if not send then return false end
  local inInstance = IsInInstance and IsInInstance()
  if inInstance then return false end   -- the game blocks addon messages in instances
  if channel == "GUILD" and IsInGuild and not IsInGuild() then return false end
  local ok, res = pcall(send, ns.PREFIX, kind .. ":" .. tostring(body or ""), channel or "GUILD", target)
  return ok and res ~= false
end
ns.on("PLAYER_LOGIN", function()
  if C_ChatInfo and C_ChatInfo.RegisterAddonMessagePrefix then ns.try(C_ChatInfo.RegisterAddonMessagePrefix, ns.PREFIX) end
end)
ns.on("CHAT_MSG_ADDON", function(prefix, text, channel, sender)
  if prefix ~= ns.PREFIX or type(text) ~= "string" then return end
  local kind, body = string.match(text, "^(%w+):(.*)$")
  local h = kind and msgHandlers[kind]
  if h then h(body, ns.short(sender), channel) end
end)

-- ---------- Guild Camp (the WowGuild addon), when it is installed ----------
function ns.camp()
  local api = _G.GuildCampAPI
  if type(api) == "table" and type(api.version) == "number" then return api end
  return nil
end

-- ---------- slash commands ----------
-- /codex                 open or close the window
-- /codex <tab>           open a tab: home, armory, dungeons, professions, talents, pets, reputation, pvp, guild, qol, settings
-- /codex find <words>    search everything
-- /codex wish <item>     add an item (shift-click a link) to the gear wishlist
-- /codex kos <name>      add a player to my own kill-on-sight list (kos remove <name> takes them off)
ns.slash = {}
local function slash(msg)
  msg = tostring(msg or "")
  local cmd, rest = string.match(msg, "^%s*(%S*)%s*(.-)%s*$")
  cmd = string.lower(cmd or "")
  if cmd == "" then if ns.shell then ns.shell.toggle() end return end
  if ns.slash[cmd] then ns.safely(ns.slash[cmd], rest) return end
  if ns.modules[cmd] then ns.shell.open(cmd) return end
  for _, m in ipairs(ns.moduleList) do
    if string.find(string.lower(m.title), cmd, 1, true) == 1 then ns.shell.open(m.id) return end
  end
  ns.print("Commands: /codex, /codex <tab>, /codex find <words>, /codex wish <item>, /codex kos <name>")
end
SlashCmdList = SlashCmdList or {}
SlashCmdList["WARBANDCODEX"] = function(msg) ns.safely(slash, msg) end
SLASH_WARBANDCODEX1, SLASH_WARBANDCODEX2 = "/codex", "/wbc"
ns.slash.find = function(rest) if ns.shell then ns.shell.search(rest, true) end end

function WarbandCodex_OnAddonCompartmentClick() if ns.shell then ns.safely(ns.shell.toggle) end end

-- A small public API for other addons (Guild Camp reads the snapshot to sync it to the guild site).
WarbandCodexAPI = {
  version = 1,
  open = function(id) if ns.shell then ns.safely(ns.shell.open, id) end end,
  snapshot = function() return ns.snapshot and ns.safely(ns.snapshot) or nil end,
}
