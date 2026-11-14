-- Warband Codex › Guild. Who's online works on its own. With Guild Camp installed (the WowGuild addon), the tab also
-- shows the guild's events and dungeon groups (join, leave and start one from here) and hands a snapshot of this
-- character to Guild Camp, whose desktop app carries it to the guild site.
--   Events        raids from the app's news, with your answer
--   Groups        the guild's open dungeon groups: Tank / Healer / DPS joins, "Start group" makes one
--   Online        guildmates online, nearest in level first
--   Sync          what the Codex shares with Guild Camp, and a button to refresh it now
local ADDON, ns = ...
local U = ns.ui
local G = {}
ns.guild = G

ns.option{ key = "campSync", label = "Share my character with Guild Camp", desc = "Give Guild Camp a snapshot of this character (gear, talents, professions, PvP record, reputations) for the guild site. Needs the Guild Camp addon.", group = "Guild", default = true }

-- → guildmates online (not me): { { name, level, class, zone } }, nearest in level first
function G.online()
  local out = {}
  if not (GetNumGuildMembers and GetGuildRosterInfo) then return out end
  local me, lvl = ns.me(), ns.level()
  for i = 1, ns.n(ns.try(GetNumGuildMembers)) or 0 do
    local name, _, _, level, _, zone, _, _, online, _, class = ns.try(GetGuildRosterInfo, i)
    name = ns.short(name)
    if name and online and name ~= me then out[#out + 1] = { name = name, level = tonumber(level) or 0, class = class, zone = zone or "" } end
  end
  table.sort(out, function(a, b)
    local da, db = math.abs(a.level - lvl), math.abs(b.level - lvl)
    if da ~= db then return da < db end
    return a.name < b.name
  end)
  return out
end

function G.events()
  local camp = ns.camp()
  return (camp and camp.raids and ns.try(camp.raids)) or {}
end
function G.groups()
  local camp = ns.camp()
  return (camp and camp.groups and ns.try(camp.groups)) or {}
end

-- ---------- the snapshot for the guild site ----------
function ns.snapshot()
  local c = ns.char()
  local snap = { v = 1, name = c.name, class = c.class, level = c.level, faction = c.faction, at = ns.now(), zone = ns.zone() }
  local spec = ns.armory.spec()
  snap.spec = spec and spec.label or nil
  snap.gear = {}
  for _, e in ipairs(ns.armory.equipped()) do
    if e.name then snap.gear[#snap.gear + 1] = { slot = e.slotName, name = e.name, id = ns.itemId(e.link) } end
  end
  snap.wishlist = {}
  for id, link in pairs(ns.armory.wishlist()) do snap.wishlist[#snap.wishlist + 1] = { id = id, name = ns.itemName(link) } end
  snap.talents = ns.talents.tree() and ns.talents.code(c.class) or nil
  snap.professions = ns.professions.mine()
  local h = ns.pvp.honor()
  snap.pvp = { kills = math.max(h.lifetime, h.counted), rank = h.rank, battlegrounds = ns.pvp.battlegrounds() }
  snap.reputations = {}
  for _, f in ipairs(ns.reputation.standings()) do
    if f.standing ~= 4 or f.cur > 0 then snap.reputations[#snap.reputations + 1] = { name = f.name, standing = f.label } end
  end
  return snap
end
-- Hand the snapshot to Guild Camp. → true when it took it.
function G.sync()
  local camp = ns.camp()
  if not camp or not camp.publish or not ns.opt("campSync") or ns.inCombat() then return false end
  local ok = ns.try(camp.publish, "WarbandCodex", "character_" .. string.gsub(ns.me(), "[^%w]", "_"), ns.snapshot())
  if ok then G.syncedAt = ns.now() end
  return ok == true
end
ns.on("PLAYER_LOGOUT", function() G.sync() end)
ns.on("PLAYER_LOGIN", function() if C_Timer and C_Timer.After then C_Timer.After(8, function() ns.safely(G.sync) end) end end)

-- ---------- page ----------
local M = ns.module{ id = "guild", title = "Guild", icon = "INV_Shirt_GuildTabard_01",
  blurb = "Events, dungeon groups and who's online.", keywords = "guild events raids lfg group finder online roster sync guild camp" }

function M.steps()
  local out, open = {}, 0
  for _, e in ipairs(G.events()) do if e.signup == nil or e.signup == "" then open = open + 1 end end
  if open > 0 then out[#out + 1] = { text = open .. (open == 1 and " guild event" or " guild events") .. " you haven't answered.", icon = "INV_Misc_Note_06" } end
  local need = 0
  for _, g in ipairs(G.groups()) do if not g.mine and not g.joined and (g.need.t + g.need.h + g.need.d) > 0 then need = need + 1 end end
  if need > 0 then out[#out + 1] = { text = need .. (need == 1 and " guild dungeon group is" or " guild dungeon groups are") .. " looking for players.", icon = "INV_Misc_Key_03" } end
  return out
end
function M.badge()
  local n = 0
  for _, g in ipairs(G.groups()) do if not g.mine and not g.joined and (g.need.t + g.need.h + g.need.d) > 0 then n = n + 1 end end
  return n > 0 and n or nil
end
function M.search(q)
  local out = {}
  for _, p in ipairs(G.online()) do
    if ns.matches(p.name, q) then out[#out + 1] = { label = p.name, sub = string.format("Guildmate online, level %d, %s", p.level, p.zone), icon = "Interface\\Icons\\INV_Shirt_GuildTabard_01", go = function() G.setView("online") end } end
  end
  return out
end

local ROLE = { t = "tank", h = "healer", d = "dps" }
local function needText(n)
  local parts = {}
  if n.t > 0 then parts[#parts + 1] = n.t .. " tank" end
  if n.h > 0 then parts[#parts + 1] = n.h .. " healer" end
  if n.d > 0 then parts[#parts + 1] = n.d .. " dps" end
  return #parts == 0 and "full" or ("needs " .. table.concat(parts, ", "))
end
local function whenText(at)
  local d = (tonumber(at) or 0) - ns.now()
  if d <= 300 then return "now" end
  if d < 90 * 60 then return "in " .. math.floor(d / 60 + 0.5) .. " min" end
  return date("%a %H:%M", at)
end
local SIGNUP = { yes = "Going", no = "Not going", maybe = "Maybe", bench = "Bench", late = "Late" }

local body_
function G.setView(v) if body_ then body_.view = v; M.refresh(body_) end end

function M.build(body)
  body_ = body
  body.view = "events"
  body.views = U.chips(body, { { "events", "Events" }, { "groups", "Dungeon groups" }, { "online", "Online" }, { "sync", "Sync" } }, function(k) body.view = k; M.refresh(body) end)
  body.views:SetPoint("TOPLEFT")
  body.note = U.empty(body, ""); body.note:SetPoint("TOPLEFT", 0, -32); body.note:SetPoint("TOPRIGHT", 0, -32)

  -- Start a group.
  body.dungeon = U.edit(body, 220, "Dungeon, e.g. Wailing Caverns")
  body.dungeon:SetPoint("TOPLEFT", 0, -58)
  body.role = U.chips(body, { { "tank", "Tank" }, { "healer", "Healer" }, { "dps", "DPS" } }, function() end)
  body.role:SetPoint("LEFT", body.dungeon, "RIGHT", 8, 0)
  body.role.pick("dps", true)
  body.start = U.button(body, "Start group", function()
    local camp = ns.camp()
    local name = body.dungeon.value()
    if camp and #name >= 2 and camp.groupNew(body.role.value, name) then body.dungeon:SetText("") end
    M.refresh(body)
  end, { w = 110, primary = true })
  body.start:SetPoint("LEFT", body.role, "RIGHT", 8, 0)

  body.syncNow = U.button(body, "Sync now", function()
    body.syncMsg = G.sync() and "Shared with Guild Camp. It reaches the site after your next /reload or logout." or "Couldn't share: Guild Camp isn't installed, or sharing is off in Settings."
    M.refresh(body)
  end, { w = 110, primary = true })
  body.syncNow:SetPoint("TOPLEFT", 0, -120)

  body.list = U.list(body, 38, function(list, i)
    local r = U.row(list, i)
    r.name = U.text(r, "body", "", "text"); r.name:SetPoint("TOPLEFT", 10, -5); r.name:SetPoint("RIGHT", -250, 0)
    r.sub = U.text(r, "small", "", "dim"); r.sub:SetPoint("TOPLEFT", 10, -21); r.sub:SetPoint("RIGHT", -250, 0)
    r.right = U.text(r, "small", "", "accent"); r.right:SetPoint("RIGHT", -10, 0); r.right:SetJustifyH("RIGHT")
    r.btns = {}
    for j, role in ipairs({ "tank", "healer", "dps" }) do
      local b = U.button(r, role == "dps" and "DPS" or (role == "tank" and "Tank" or "Healer"), function()
        local camp = ns.camp()
        if camp and r.item then camp.groupJoin(r.item.n, role) end
        M.refresh(body)
      end, { w = 62, h = 22 })
      b:SetPoint("RIGHT", -10 - (3 - j) * 68, 0)
      r.btns[j] = b
    end
    r.leave = U.button(r, "Leave", function()
      local camp = ns.camp()
      if camp and r.item then camp.groupLeave(r.item.n) end
      M.refresh(body)
    end, { w = 62, h = 22 })
    r.leave:SetPoint("RIGHT", -10, 0)
    return r
  end, function(r, item)
    r.name:SetText(item.title or ""); r.sub:SetText(item.sub or ""); r.right:SetText(item.right or "")
    for j, b in ipairs(r.btns) do if item.canJoin and item.need[({ "t", "h", "d" })[j]] > 0 then b:Show() else b:Hide() end end
    if item.canLeave then r.leave:Show() else r.leave:Hide() end
  end, 10)
end

function M.refresh(body)
  body.views.pick(body.view, true)
  local v, camp = body.view, ns.camp()
  local rows, note, top = {}, "", -58
  for _, w in ipairs({ body.dungeon, body.role, body.start }) do if v == "groups" and camp then w:Show() else w:Hide() end end
  if v == "sync" then body.syncNow:Show() else body.syncNow:Hide() end
  local needCamp = "This part comes from Guild Camp. Install the Guild Camp app and addon and it appears here."
  if v == "events" then
    for _, e in ipairs(G.events()) do
      local answered = e.signup ~= nil and e.signup ~= ""
      rows[#rows + 1] = { title = ns.plain(e.title or "Raid"), sub = date("%a %d %b %H:%M", e.startsAt or 0) .. "  ·  " .. (e.coming or 0) .. " coming",
        right = answered and ((SIGNUP[e.signup] or e.signup) .. (e.role and (" as " .. ns.plain(e.role)) or "")) or "Not answered yet" }
    end
    note = not camp and needCamp or (#rows == 0 and "Nothing scheduled." or "Answer and reserve loot in the Guild Camp app.")
  elseif v == "groups" then
    for _, g in ipairs(G.groups()) do
      local names = {}
      for _, m in ipairs(g.members) do names[#names + 1] = ns.plain(m.name or "?") .. " (" .. (ROLE[m.role] or "dps") .. ")" end
      rows[#rows + 1] = { n = g.n, need = g.need, title = ns.plain(g.dungeon or "?") .. "  |cff999999" .. whenText(g.startsAt) .. "|r",
        sub = table.concat(names, ", ") .. "  ·  " .. needText(g.need),
        right = g.mine and "Yours" or (g.waiting and "You're waiting" or ""),
        canJoin = not g.mine and not g.joined, canLeave = g.joined and not g.mine }
      if g.joined and not g.mine then rows[#rows].right = "" end
    end
    note = not camp and needCamp or (#rows == 0 and "No open groups. Start one below: guildmates online hear about it." or "")
    top = camp and -90 or -58
  elseif v == "online" then
    for _, p in ipairs(G.online()) do
      local hex = p.class and ns.data.classColors[p.class]
      rows[#rows + 1] = { title = (hex and ("|cff" .. hex) or "") .. p.name .. (hex and "|r" or ""), sub = p.zone, right = "Level " .. p.level }
    end
    note = #rows == 0 and "No guildmates online right now." or (#rows .. " online, nearest to your level first.")
  else
    note = camp and "The Codex gives Guild Camp a snapshot of this character: gear, talents, professions, PvP record and reputations. The Guild Camp app carries it to your guild's site."
      or "Sync needs Guild Camp. Without it the Codex keeps everything on this computer."
    if body.syncMsg then rows[#rows + 1] = { title = body.syncMsg, sub = "" } end
    if G.syncedAt then rows[#rows + 1] = { title = "Last shared " .. ns.pvp.ago(G.syncedAt), sub = ns.opt("campSync") and "Sharing is on (Settings, Guild)." or "Sharing is off (Settings, Guild)." } end
    top = -152
  end
  body.note:SetText(note)
  body.list:ClearAllPoints()
  body.list:SetPoint("TOPLEFT", 0, top); body.list:SetPoint("BOTTOMRIGHT")
  body.list.offset = 0
  body.list.set(rows)
end
