-- Warband Codex › PvP hub.
--   * Overview: honorable kills (session, lifetime), your rank and progress, kills by day.
--   * Battlegrounds: played, won and your win rate per battleground, and the last matches.
--   * Enemies: enemy players you've targeted, moused over or seen by nameplate: class, level, guild, where and
--     when, how often, and how many times you've killed them. No combat log is read (Forever blocks it).
--   * Kill on sight: your own list (/codex kos <name> [reason]) plus your guild's from Guild Camp. Seeing someone
--     on your own list shows a card and plays a sound, at most every two minutes per player (option kosAlerts).
--     Guild Camp raises its own alert for the guild's list, so the Codex doesn't double it.
local ADDON, ns = ...
local U = ns.ui
local P = {}
ns.pvp = P

ns.option{ key = "kosAlerts", label = "Kill-on-sight alerts", desc = "A card and a sound when a player on your own kill-on-sight list is near.", group = "PvP", default = true }
ns.option{ key = "enemyLog", label = "Enemy log", desc = "Remember enemy players you see: class, level, guild, where and when.", group = "PvP", default = true }

P.ALERT_EVERY = 120
P.MAX_ENEMIES = 400
P.MAX_RECENT = 30

local function store()
  local s = ns.ensure(ns.db, "pvp")
  ns.ensure(s, "enemies"); ns.ensure(s, "kos")
  return s
end
local function mine()
  local s = ns.ensure(ns.char(), "pvp")
  ns.ensure(s, "bgs"); ns.ensure(s, "recent"); ns.ensure(s, "days")
  return s
end
local function proper(n)
  n = ns.short(n)
  if type(n) ~= "string" or n == "" then return nil end
  local first, rest = string.match(n, "^([\1-\127\194-\244][\128-\191]*)(.*)$")
  if not first then return nil end
  return string.upper(first) .. string.lower(rest)
end

-- ---------- honor ----------
function P.honor()
  local h = { session = 0, lifetime = 0 }
  if GetPVPSessionStats then h.session = tonumber((ns.try(GetPVPSessionStats))) or 0 end
  if GetPVPLifetimeStats then h.lifetime = tonumber((ns.try(GetPVPLifetimeStats))) or 0 end
  local rank = UnitPVPRank and ns.n(ns.try(UnitPVPRank, "player")) or 0
  if rank and rank > 0 and GetPVPRankInfo then
    local name, number = ns.try(GetPVPRankInfo, rank)
    h.rank, h.rankNumber = name, tonumber(number)
  end
  if GetPVPRankProgress then h.progress = ns.n(ns.try(GetPVPRankProgress)) end
  local s = mine()
  h.today = (s.days[date("%Y-%m-%d")] or {}).kills or 0
  h.counted = s.kills or 0
  return h
end
-- "Gankalot dies, honorable kill Rank: Scout (Estimated Honor Points: 14)" → name, honor
function P.parseKill(text)
  local name = string.match(tostring(text or ""), "^(.-) dies, honorable kill")
  if not name or name == "" then return nil end
  return proper(name), tonumber(string.match(text, "Honor Points: (%d+)")) or 0
end
function P.noteKill(name, honor)
  local s, g = mine(), store()
  s.kills = (s.kills or 0) + 1
  local day = ns.ensure(s.days, date("%Y-%m-%d"))
  day.kills = (day.kills or 0) + 1; day.honor = (day.honor or 0) + (honor or 0)
  local e = g.enemies[name]
  if e then e.killed = (e.killed or 0) + 1 else g.enemies[name] = { killed = 1, seen = 1, last = ns.now(), zone = ns.zone() } end
  ns.shell.refresh("pvp")
end
ns.on("CHAT_MSG_COMBAT_HONOR_GAIN", function(text)
  if type(text) ~= "string" or ns.secret(text) then return end
  local name, honor = ns.try(P.parseKill, text)
  if name then P.noteKill(name, honor) end
end)

-- ---------- battlegrounds ----------
local recorded
function P.noteMatch(map, won, kills, deaths, honor)
  local s = mine()
  local b = ns.ensure(s.bgs, map)
  b.played = (b.played or 0) + 1
  if won then b.won = (b.won or 0) + 1 end
  table.insert(s.recent, 1, { map = map, won = won and true or false, at = ns.now(), kills = kills, deaths = deaths, honor = honor })
  while #s.recent > P.MAX_RECENT do table.remove(s.recent) end
  ns.shell.refresh("pvp")
end
local function checkMatch()
  if recorded or not GetBattlefieldWinner then return end
  local winner = ns.try(GetBattlefieldWinner)
  if winner == nil then return end
  local inside, kind = false, nil
  if IsInInstance then inside, kind = IsInInstance() end
  if not inside or kind ~= "pvp" then return end
  recorded = true
  local side = ns.faction() == "Horde" and 0 or 1
  local kills, deaths, honor
  if GetNumBattlefieldScores and GetBattlefieldScore then
    for i = 1, ns.n(ns.try(GetNumBattlefieldScores)) or 0 do
      local name, killingBlows, _, d, h = ns.try(GetBattlefieldScore, i)
      if name and ns.short(name) == ns.me() then kills, deaths, honor = killingBlows, d, h end
    end
  end
  P.noteMatch(ns.zone(), winner == side, kills, deaths, honor)
end
ns.on("UPDATE_BATTLEFIELD_SCORE", checkMatch)
ns.on("UPDATE_BATTLEFIELD_STATUS", checkMatch)
ns.on("PLAYER_ENTERING_WORLD", function() recorded = nil end)
-- → { { map, played, won, rate } } most played first
function P.battlegrounds()
  local out = {}
  for map, b in pairs(mine().bgs) do
    out[#out + 1] = { map = map, played = b.played or 0, won = b.won or 0, rate = (b.played or 0) > 0 and (b.won or 0) / b.played or 0 }
  end
  table.sort(out, function(a, b) if a.played ~= b.played then return a.played > b.played end return a.map < b.map end)
  return out
end

-- ---------- kill on sight ----------
-- → { reason, mine = true } or { reason, by, guild = true } or nil
function P.kos(name)
  name = proper(name)
  if not name then return nil end
  local own = store().kos[name]
  if own then return { name = name, reason = own.reason, mine = true } end
  local camp = ns.camp()
  for _, k in ipairs((camp and camp.kos and ns.try(camp.kos)) or {}) do
    if k.name == name then return { name = name, reason = k.reason, by = k.by, guild = true } end
  end
  return nil
end
function P.kosList()
  local out, seen = {}, {}
  for name, k in pairs(store().kos) do seen[name] = true; out[#out + 1] = { name = name, reason = k.reason, mine = true, at = k.at } end
  local camp = ns.camp()
  for _, k in ipairs((camp and camp.kos and ns.try(camp.kos)) or {}) do
    if not seen[k.name] then out[#out + 1] = { name = k.name, reason = k.reason, by = k.by, guild = true, at = k.t } end
  end
  table.sort(out, function(a, b) return a.name < b.name end)
  return out
end
function P.kosAdd(name, reason)
  name = proper(name)
  if not name then return false end
  store().kos[name] = { reason = string.sub(reason or "", 1, 100), at = ns.now() }
  ns.shell.refresh("pvp")
  return true
end
function P.kosRemove(name)
  name = proper(name)
  if not name or not store().kos[name] then return false end
  store().kos[name] = nil
  ns.shell.refresh("pvp")
  return true
end
ns.slash.kos = function(rest)
  local sub, arg = string.match(rest or "", "^(%S*)%s*(.-)$")
  if string.lower(sub or "") == "remove" then
    ns.print(P.kosRemove(arg) and (proper(arg) .. " is off your kill-on-sight list.") or "That player isn't on your list.")
  elseif sub and sub ~= "" then
    if string.lower(sub) == "add" then sub, arg = string.match(arg, "^(%S*)%s*(.-)$") end
    if P.kosAdd(sub, arg) then ns.print("|cffff4040" .. proper(sub) .. " is kill on sight.|r") else ns.print("Give a player name: /codex kos <name> [reason]") end
  else ns.shell.open("pvp"); if P.setView then P.setView("kos") end end
end

-- ---------- enemies seen ----------
local alertedAt = {}
local function trim(enemies)
  local n, oldest, oldestAt = 0, nil, nil
  for name, e in pairs(enemies) do
    n = n + 1
    if not oldestAt or (e.last or 0) < oldestAt then oldest, oldestAt = name, e.last or 0 end
  end
  if n > P.MAX_ENEMIES and oldest then enemies[oldest] = nil end
end
function P.see(unit)
  if not (UnitExists and UnitExists(unit) and UnitIsPlayer and UnitIsPlayer(unit)) then return end
  if not (UnitIsEnemy and UnitIsEnemy("player", unit)) then return end
  local raw = UnitName(unit)
  if ns.secret(raw) then return end
  local name = proper(raw)
  if not name then return end
  local now = ns.now()
  if ns.opt("enemyLog") then
    local enemies = store().enemies
    local e = enemies[name]
    if not e then e = { seen = 0 }; enemies[name] = e; trim(enemies) end
    if now - (e.last or 0) > 60 then e.seen = (e.seen or 0) + 1 end
    e.last, e.zone = now, ns.zone()
    local _, class = ns.try(UnitClass, unit)
    e.class = class or e.class
    local lvl = ns.n(ns.try(UnitLevel, unit))
    if lvl and lvl > 0 then e.level = lvl end
    e.guild = (GetGuildInfo and ns.try(GetGuildInfo, unit)) or e.guild
  end
  local k = store().kos[name]
  if k and ns.opt("kosAlerts") and now - (alertedAt[name] or -P.ALERT_EVERY) >= P.ALERT_EVERY then
    alertedAt[name] = now
    ns.toast("Kill on sight: " .. name, (k.reason and k.reason ~= "") and k.reason or ("Seen in " .. ns.zone()), "Interface\\Icons\\Ability_DualWield", 8)
    if PlaySound and SOUNDKIT and SOUNDKIT.RAID_WARNING then pcall(PlaySound, SOUNDKIT.RAID_WARNING) end
  end
end
ns.on("PLAYER_TARGET_CHANGED", function() ns.try(P.see, "target") end)
ns.on("UPDATE_MOUSEOVER_UNIT", function() ns.try(P.see, "mouseover") end)
ns.on("NAME_PLATE_UNIT_ADDED", function(unit) if unit then ns.try(P.see, unit) end end)
-- → enemies, most recently seen first
function P.enemies()
  local out = {}
  for name, e in pairs(store().enemies) do
    out[#out + 1] = { name = name, class = e.class, level = e.level, guild = e.guild, zone = e.zone, last = e.last or 0, seen = e.seen or 0, killed = e.killed or 0 }
  end
  table.sort(out, function(a, b) if a.last ~= b.last then return a.last > b.last end return a.name < b.name end)
  return out
end

local function ago(t)
  local s = ns.now() - (t or 0)
  if s < 90 then return "just now" end
  if s < 3600 then return math.floor(s / 60) .. " min ago" end
  if s < 86400 then return math.floor(s / 3600) .. " h ago" end
  return math.floor(s / 86400) .. " d ago"
end
P.ago = ago

-- ---------- page ----------
local M = ns.module{ id = "pvp", title = "PvP", icon = "Ability_DualWield",
  blurb = "Honor, battlegrounds, the enemies you've met and who is kill on sight.", keywords = "honor rank battleground kos kill on sight enemies world pvp" }

function M.search(q)
  local out = {}
  for _, e in ipairs(P.enemies()) do
    if ns.matches(e.name .. " " .. tostring(e.guild or ""), q) then
      out[#out + 1] = { label = e.name, sub = "Enemy" .. (e.level and (", level " .. e.level) or "") .. ", seen " .. ago(e.last), icon = "Interface\\Icons\\Ability_DualWield", go = function() P.setView("enemies") end }
    end
  end
  for _, k in ipairs(P.kosList()) do
    if ns.matches(k.name, q) then out[#out + 1] = { label = k.name, sub = "Kill on sight", icon = "Interface\\Icons\\Ability_Rogue_Eviscerate", go = function() P.setView("kos") end } end
  end
  return out
end

local body_
function P.setView(v) if body_ then body_.view = v; M.refresh(body_) end end

function M.build(body)
  body_ = body
  body.view = "overview"
  body.views = U.chips(body, { { "overview", "Overview" }, { "bgs", "Battlegrounds" }, { "enemies", "Enemies" }, { "kos", "Kill on sight" } }, function(k) body.view = k; M.refresh(body) end)
  body.views:SetPoint("TOPLEFT")

  body.cards = {}
  for i, label in ipairs({ "Kills today", "This session", "Lifetime", "Rank" }) do
    local c = U.card(body, 168, 64)
    c:SetPoint("TOPLEFT", (i - 1) * 178, -34)
    c.label = U.text(c, "small", label, "dim"); c.label:SetPoint("TOPLEFT", 12, -10)
    c.value = U.text(c, "big", "", "text"); c.value:SetPoint("TOPLEFT", 12, -26)
    body.cards[i] = c
  end
  body.rank = U.bar(body, 700, 12); body.rank:SetPoint("TOPLEFT", 0, -108); body.rank:SetPoint("TOPRIGHT", 0, -108)

  body.name = U.edit(body, 150, "Player name", nil, function() body.add:GetScript("OnClick")(body.add) end)
  body.name:SetPoint("TOPLEFT", 0, -34)
  body.reason = U.edit(body, 300, "Why (optional)")
  body.reason:SetPoint("LEFT", body.name, "RIGHT", 8, 0)
  body.add = U.button(body, "Add to my list", function()
    if P.kosAdd(body.name.value(), body.reason.value()) then body.name:SetText(""); body.reason:SetText("") end
  end, { w = 120, primary = true })
  body.add:SetPoint("LEFT", body.reason, "RIGHT", 8, 0)

  body.note = U.empty(body, ""); body.note:SetPoint("TOPLEFT", 0, -64); body.note:SetPoint("TOPRIGHT", 0, -64)
  body.list = U.list(body, 34, function(list, i)
    local r = U.row(list, i)
    r.name = U.text(r, "body", "", "text"); r.name:SetPoint("TOPLEFT", 10, -4); r.name:SetPoint("RIGHT", -210, 0)
    r.sub = U.text(r, "small", "", "dim"); r.sub:SetPoint("TOPLEFT", 10, -19); r.sub:SetPoint("RIGHT", -110, 0)
    r.right = U.text(r, "small", "", "accent"); r.right:SetPoint("TOPRIGHT", -100, -5); r.right:SetJustifyH("RIGHT")
    r.btn = U.button(r, "", function() if r.item and r.item.act then r.item.act() end end, { w = 84, h = 22 })
    r.btn:SetPoint("RIGHT", -8, 0)
    r.bar = U.bar(r, 180, 8); r.bar:SetPoint("RIGHT", -8, -8); r.bar:Hide()
    return r
  end, function(r, item)
    r.name:SetText(item.title or ""); r.sub:SetText(item.sub or ""); r.right:SetText(item.right or "")
    if item.actLabel then r.btn:Show(); r.btn.setText(item.actLabel) else r.btn:Hide() end
    if item.frac then r.bar:Show(); r.bar.set(item.frac, item.barText, item.frac >= 0.5 and "good" or "bad") else r.bar:Hide() end
  end, 10)
end

function M.refresh(body)
  body.views.pick(body.view, true)
  local v = body.view
  for _, c in ipairs(body.cards) do if v == "overview" then c:Show() else c:Hide() end end
  if v == "overview" then body.rank:Show() else body.rank:Hide() end
  for _, w in ipairs({ body.name, body.reason, body.add }) do if v == "kos" then w:Show() else w:Hide() end end
  local rows, note, top = {}, "", -64
  if v == "overview" then
    local h = P.honor()
    body.cards[1].value:SetText(tostring(h.today)); body.cards[2].value:SetText(tostring(h.session))
    body.cards[3].value:SetText(tostring(math.max(h.lifetime, h.counted))); body.cards[4].value:SetText(h.rank or "Unranked")
    body.rank.set(h.progress or 0, h.rank and string.format("%s  ·  %.0f%% to the next rank", h.rank, (h.progress or 0) * 100) or "No rank yet")
    local days = {}
    for day, d in pairs((ns.char().pvp or {}).days or {}) do days[#days + 1] = { title = day, right = (d.kills or 0) .. " kills", sub = (d.honor or 0) > 0 and ("About " .. d.honor .. " honor") or "" } end
    table.sort(days, function(a, b) return a.title > b.title end)
    rows, top = days, -134
    note = #rows == 0 and "Your kills by day appear here as you fight." or ""
    if note ~= "" then top = -154 end
  elseif v == "bgs" then
    for _, b in ipairs(P.battlegrounds()) do
      rows[#rows + 1] = { title = b.map, sub = string.format("%d played  ·  %d won", b.played, b.won), frac = b.rate, barText = string.format("%.0f%%", b.rate * 100) }
    end
    for _, m in ipairs(mine().recent) do
      rows[#rows + 1] = { title = (m.won and (U.hex("good") .. "Won|r  ") or (U.hex("bad") .. "Lost|r  ")) .. m.map, sub = ago(m.at) .. (m.kills and string.format("  ·  %d killing blows, %d deaths", m.kills, m.deaths or 0) or ""),
        right = m.honor and (m.honor .. " honor") or "" }
    end
    note = #rows == 0 and "Finish a battleground and it is counted here: played, won and your win rate." or "Your record per battleground, then the latest matches."
    top = -34
  elseif v == "enemies" then
    for _, e in ipairs(P.enemies()) do
      local hex = e.class and ns.data.classColors[e.class]
      local isKos = P.kos(e.name)
      rows[#rows + 1] = { title = (hex and ("|cff" .. hex) or "") .. e.name .. (hex and "|r" or "") .. (e.level and ("  |cff999999" .. e.level .. "|r") or "") .. (isKos and "  |cffff4040KOS|r" or ""),
        sub = (e.guild and ("<" .. ns.plain(e.guild) .. ">  ·  ") or "") .. tostring(e.zone or "") .. "  ·  " .. ago(e.last),
        right = string.format("seen %d  ·  killed %d", e.seen, e.killed),
        actLabel = (isKos and isKos.mine) and "Remove" or (not isKos and "Mark KOS" or nil),
        act = function() if isKos and isKos.mine then P.kosRemove(e.name) else P.kosAdd(e.name, "") end end }
    end
    note = #rows == 0 and "Enemy players you target, mouse over or see by nameplate are listed here." or "Most recently seen first."
    top = -34
  else
    for _, k in ipairs(P.kosList()) do
      local e = ns.db.pvp.enemies[k.name]
      rows[#rows + 1] = { title = "|cffff4040" .. k.name .. "|r", sub = ((k.reason and k.reason ~= "") and ns.plain(k.reason) or "No reason given") .. (e and e.last and e.last > 0 and ("  ·  last seen " .. ago(e.last) .. " in " .. tostring(e.zone)) or ""),
        right = k.guild and ("Guild list" .. (k.by and (", by " .. k.by) or "")) or "My list",
        actLabel = k.mine and "Remove" or nil, act = function() P.kosRemove(k.name) end }
    end
    note = #rows == 0 and "Nobody is kill on sight yet." or ""
    top = -64
    if note ~= "" then top = -84 end
  end
  local noteY = v == "overview" and -130 or (v == "kos" and -64 or -34)
  body.note:ClearAllPoints()
  body.note:SetPoint("TOPLEFT", 0, noteY); body.note:SetPoint("TOPRIGHT", 0, noteY)
  body.note:SetText(note)
  local listY = noteY - (note ~= "" and 24 or 0)
  body.list:ClearAllPoints()
  body.list:SetPoint("TOPLEFT", 0, listY); body.list:SetPoint("BOTTOMRIGHT")
  body.list.offset = 0
  body.list.set(rows)
end
