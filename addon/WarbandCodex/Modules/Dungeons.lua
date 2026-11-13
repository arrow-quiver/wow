-- Warband Codex › Dungeons & Raids.
--   * Every dungeon and raid with its level range, entrance zone and bosses in order (Data/Dungeons.lua).
--   * Loot the addon has SEEN: when you loot a corpse in an instance it notes what dropped, per boss, for all your
--     characters, and shows the drop rate from your own kills. Nothing is shipped: Forever's loot is still changing.
--     Bosses the baseline doesn't know (new in Forever) appear under "Also seen here".
--   * Quests worth taking in (Horde list) and whether each is in your log.
--   * Keys and attunements, step by step.
--   * Opens on the dungeon you're in; a card says what's inside when you enter (option dungeonCard).
local ADDON, ns = ...
local U = ns.ui
local D = {}
ns.dungeons = D

ns.option{ key = "dungeonCard", label = "Card when entering a dungeon", desc = "Entering a dungeon or raid shows a card with its bosses and quests.", group = "Dungeons", default = true }
ns.option{ key = "lootLearn", label = "Learn loot as you play", desc = "Remember what each boss drops when you loot it, to build drop lists and gear upgrades.", group = "Dungeons", default = true }

local OTHER = "Trash and chests"

function D.byName(name)
  if not name or name == "" then return nil end
  local low = string.lower(name)
  for _, d in ipairs(ns.data.dungeons) do
    if string.lower(d.name) == low then return d end
  end
  for _, d in ipairs(ns.data.dungeons) do
    if string.find(low, string.lower(d.name), 1, true) or string.find(string.lower(d.name), low, 1, true) then return d end
    for _, a in ipairs(d.alias or {}) do if a == low then return d end end
  end
  return nil
end
-- All bosses of a dungeon in order: { { name, wing } }
function D.bosses(d)
  local out = {}
  for _, b in ipairs(d.bosses or {}) do out[#out + 1] = { name = b } end
  for _, w in ipairs(d.wings or {}) do
    for _, b in ipairs(w.bosses) do out[#out + 1] = { name = b, wing = w.name } end
  end
  return out
end
-- The instance the player is in: the baseline entry, or a stand-in for one the baseline doesn't have.
function D.current()
  local inside, kind = false, nil
  if IsInInstance then inside, kind = IsInInstance() end
  if not inside or (kind ~= "party" and kind ~= "raid") then return nil end
  local name = GetInstanceInfo and ns.try(GetInstanceInfo)
  if not name or name == "" then name = ns.zone() end
  return D.byName(name) or { name = name, min = 0, max = 0, zone = "", bosses = {}, unknown = true, kind = kind == "raid" and "raid" or nil }
end

-- ---------- loot learning ----------
local function lootDB() return ns.learned("loot") end
local lastSource, lastAt, seenGuid = nil, 0, {}

-- Record one looted corpse: source (boss or trash) and the item links of uncommon quality and better.
function D.recordLoot(dungeon, source, links, guid)
  if not dungeon or #links == 0 and source == OTHER then return false end
  local now = ns.now()
  if guid then
    if seenGuid[guid] then return false end
    seenGuid[guid] = true
  elseif lastSource == source and now - lastAt < 4 then return false end
  lastSource, lastAt = source, now
  local dd = ns.ensure(lootDB(), dungeon)
  local s = ns.ensure(dd, source)
  s.kills = (s.kills or 0) + 1
  local items = ns.ensure(s, "items")
  for _, link in ipairs(links) do
    local id = ns.itemId(link)
    if id then
      local e = ns.ensure(items, id)
      e.n = (e.n or 0) + 1
      e.link = link
      ns.learned("items")[id] = { link = link, src = (source == OTHER and dungeon or (source .. ", " .. dungeon)) }
    end
  end
  ns.shell.refresh("dungeons")
  return true
end

local function onLoot()
  if not ns.opt("lootLearn") then return end
  local d = D.current()
  if not d or not GetNumLootItems then return end
  local source = OTHER
  if UnitExists and UnitExists("target") and UnitIsDead and UnitIsDead("target") and not (UnitIsPlayer and UnitIsPlayer("target")) then
    source = (UnitName and UnitName("target")) or OTHER
    if ns.secret(source) or type(source) ~= "string" then source = OTHER end
  end
  local links, guid = {}, nil
  for i = 1, ns.n(ns.try(GetNumLootItems)) or 0 do
    local link = GetLootSlotLink and ns.try(GetLootSlotLink, i)
    local _, _, _, _, quality = ns.try(GetLootSlotInfo, i)
    if link and (tonumber(quality) or 0) >= 2 then links[#links + 1] = link end
    if not guid and GetLootSourceInfo then guid = ns.try(GetLootSourceInfo, i) end
  end
  D.recordLoot(d.name, source, links, guid)
end
ns.on("LOOT_OPENED", function() ns.try(onLoot) end)

-- What has been seen from one source: → kills, { { link, id, n, rate } } most often first.
function D.lootOf(dungeon, source)
  local s = (lootDB()[dungeon] or {})[source]
  if type(s) ~= "table" then return 0, {} end
  local out = {}
  for id, e in pairs(s.items or {}) do
    out[#out + 1] = { id = id, link = e.link, n = e.n or 0, rate = (s.kills or 0) > 0 and (e.n or 0) / s.kills or 0 }
  end
  table.sort(out, function(a, b) if a.n ~= b.n then return a.n > b.n end return a.id < b.id end)
  return s.kills or 0, out
end
-- Sources seen in a dungeon that the baseline boss list doesn't name.
function D.extraSources(d)
  local known, out = {}, {}
  for _, b in ipairs(D.bosses(d)) do known[b.name] = true end
  for source in pairs(lootDB()[d.name] or {}) do
    if not known[source] and source ~= OTHER then out[#out + 1] = source end
  end
  table.sort(out)
  if (lootDB()[d.name] or {})[OTHER] then out[#out + 1] = OTHER end
  return out
end

-- ---------- quests ----------
local function questLogTitles()
  local titles = {}
  if C_QuestLog and C_QuestLog.GetNumQuestLogEntries and C_QuestLog.GetInfo then
    for i = 1, ns.n(ns.try(C_QuestLog.GetNumQuestLogEntries)) or 0 do
      local info = ns.try(C_QuestLog.GetInfo, i)
      if type(info) == "table" and info.title and not info.isHeader then titles[string.lower(info.title)] = true end
    end
  elseif GetNumQuestLogEntries and GetQuestLogTitle then
    for i = 1, ns.n(ns.try(GetNumQuestLogEntries)) or 0 do
      local title, _, _, isHeader = ns.try(GetQuestLogTitle, i)
      if title and not isHeader then titles[string.lower(title)] = true end
    end
  end
  return titles
end
-- → { { title, where, active } } (the Horde list; empty for Alliance for now)
function D.quests(d)
  local out = {}
  if ns.faction() ~= "Horde" then return out end
  local log = questLogTitles()
  for _, q in ipairs(ns.data.dungeonQuests[d.name] or {}) do
    out[#out + 1] = { title = q[1], where = q[2], active = log[string.lower(q[1])] == true }
  end
  return out
end
function D.keys(d)
  local out = {}
  for _, k in ipairs(ns.data.keys) do if k.dungeon == d.name then out[#out + 1] = k end end
  return out
end

-- How a dungeon's levels sit against the player: "low", "fit", "high".
function D.fit(d)
  local lvl = ns.level()
  if (d.max or 0) == 0 then return "fit" end
  if lvl < d.min - 2 then return "high" end
  if lvl > d.max + 3 then return "low" end
  return "fit"
end

ns.on("PLAYER_ENTERING_WORLD", function()
  local d = D.current()
  if not d then D.announced = nil return end
  if D.announced == d.name then return end
  D.announced = d.name
  if ns.opt("dungeonCard") then
    local quests, active = D.quests(d), 0
    for _, q in ipairs(quests) do if q.active then active = active + 1 end end
    ns.toast(d.name, string.format("%d bosses  ·  %d of %d quests in your log  ·  /codex dungeons", #D.bosses(d), active, #quests), "Interface\\Icons\\INV_Misc_Key_03", 8)
  end
end)

-- ---------- page ----------
local M = ns.module{ id = "dungeons", title = "Dungeons & Raids", icon = "INV_Misc_Key_03",
  blurb = "Bosses, the loot you've seen drop, quests to bring, keys and attunements.", keywords = "instances bosses loot drops attunement keys quests raids" }

function M.search(q)
  local out = {}
  for _, d in ipairs(ns.data.dungeons) do
    if ns.matches(d.name .. " " .. table.concat(d.alias or {}, " "), q) then
      out[#out + 1] = { label = d.name, sub = (d.kind == "raid" and "Raid" or string.format("Levels %d-%d", d.min, d.max)), icon = "Interface\\Icons\\INV_Misc_Key_03", go = function() M.select(d.name) end }
    end
    for _, b in ipairs(D.bosses(d)) do
      if ns.matches(b.name, q) then
        out[#out + 1] = { label = b.name, sub = "Boss in " .. d.name, icon = "Interface\\Icons\\Ability_Creature_Cursed_02", go = function() M.select(d.name, "bosses", b.name) end }
      end
    end
  end
  for dungeon, sources in pairs(lootDB()) do
    for source, s in pairs(sources) do
      for id, e in pairs(type(s) == "table" and s.items or {}) do
        local name = ns.itemName(e.link)
        if name and ns.matches(name, q) then
          out[#out + 1] = { label = name, sub = "Drops from " .. source .. ", " .. dungeon, icon = ns.itemIcon(id), go = function() M.select(dungeon, "bosses", source) end }
        end
      end
    end
  end
  return out
end

local body_
function M.select(name, view, boss)
  if not body_ then return end
  local d = D.byName(name)
  if not d then return end
  body_.picked = d
  if view then body_.view = view end
  body_.open = {}
  if boss then body_.open[boss] = true end
  M.refresh(body_)
end

function M.build(body)
  body_ = body
  body.view, body.open, body.filter = "bosses", {}, "all"
  body.filters = U.chips(body, { { "all", "All" }, { "fit", "My level" }, { "raid", "Raids" } }, function(k) body.filter = k; M.refresh(body) end)
  body.filters:SetPoint("TOPLEFT")

  body.left = U.list(body, 30, function(list, i)
    local r = U.row(list, i, function(_, item) M.select(item.name) end)
    r.name = U.text(r, "body", "", "text"); r.name:SetPoint("LEFT", 10, 0); r.name:SetPoint("RIGHT", -52, 0)
    r.lvl = U.text(r, "small", "", "dim"); r.lvl:SetPoint("RIGHT", -8, 0); r.lvl:SetJustifyH("RIGHT")
    r.sel = U.fill(r, "accent", 1, "OVERLAY"); r.sel:SetPoint("TOPLEFT"); r.sel:SetPoint("BOTTOMLEFT"); r.sel:SetWidth(2)
    return r
  end, function(r, d)
    local fit = D.fit(d)
    r.name:SetText(d.name)
    r.name:SetTextColor(U.c(fit == "fit" and "text" or "dim"))
    r.lvl:SetText(d.kind == "raid" and "Raid" or (d.min .. "-" .. d.max))
    if body.picked == d then r.sel:Show() else r.sel:Hide() end
  end, 14)
  body.left:SetPoint("TOPLEFT", 0, -32); body.left:SetPoint("BOTTOMLEFT", 0, 0); body.left:SetWidth(232)

  local right = CreateFrame("Frame", nil, body)
  right:SetPoint("TOPLEFT", 248, 0); right:SetPoint("BOTTOMRIGHT", 0, 0)
  body.right = right
  right.name = U.text(right, "heading", "", "line"); right.name:SetPoint("TOPLEFT", 0, -2)
  right.info = U.text(right, "small", "", "dim"); right.info:SetPoint("TOPLEFT", 0, -24)
  body.views = U.chips(right, { { "bosses", "Bosses & loot" }, { "quests", "Quests" }, { "keys", "Keys" } }, function(k) body.view = k; M.refresh(body) end)
  body.views:SetPoint("TOPLEFT", 0, -44)
  right.note = U.empty(right, ""); right.note:SetPoint("TOPLEFT", 0, -76); right.note:SetPoint("TOPRIGHT", 0, -76)

  body.detail = U.list(right, 28, function(list, i)
    local r = U.row(list, i, function(_, item)
      if item.boss then body.open[item.boss] = not body.open[item.boss]; M.refresh(body)
      elseif item.link and IsShiftKeyDown and IsShiftKeyDown() and ChatEdit_InsertLink then ChatEdit_InsertLink(item.link)
      elseif item.link then ns.armory.wish(item.link) end
    end)
    r.icon = U.icon(r, 20); r.icon:SetPoint("LEFT", 6, 0)
    r.text = U.text(r, "body", "", "text"); r.text:SetPoint("LEFT", 34, 0); r.text:SetPoint("RIGHT", -150, 0)
    r.right = U.text(r, "small", "", "dim"); r.right:SetPoint("RIGHT", -8, 0); r.right:SetJustifyH("RIGHT")
    return r
  end, function(r, item)
    r.tipLink = item.link
    r.tip = item.tip
    if item.icon then r.icon:Show(); r.icon.set(item.icon) else r.icon:Hide() end
    r.text:ClearAllPoints(); r.text:SetPoint("LEFT", item.indent or (item.icon and 34 or 8), 0); r.text:SetPoint("RIGHT", -150, 0)
    r.text:SetText(item.text or "")
    r.text:SetTextColor(U.c(item.color or "text"))
    r.right:SetText(item.right or "")
  end, 14)
  body.detail:SetPoint("TOPLEFT", 0, -98); body.detail:SetPoint("BOTTOMRIGHT", 0, 0)
end

local function bossRows(body, d)
  local rows = {}
  local function add(source, wing)
    local kills, loot = D.lootOf(d.name, source)
    rows[#rows + 1] = { boss = source, text = (body.open[source] and "-  " or "+  ") .. source, icon = false,
      right = kills > 0 and string.format("%d looted  ·  %d items seen", kills, #loot) or (wing or ""), color = kills > 0 and "text" or "dim" }
    if body.open[source] then
      if #loot == 0 then rows[#rows + 1] = { text = "No loot seen yet. Loot this boss with the Codex on and it appears here.", indent = 34, color = "dim" } end
      for _, it in ipairs(loot) do
        rows[#rows + 1] = { link = it.link, text = it.link or ("Item " .. it.id), icon = ns.itemIcon(it.id), indent = 34,
          right = string.format("%d of %d  ·  %.0f%%", it.n, kills, it.rate * 100) }
      end
    end
  end
  for _, b in ipairs(D.bosses(d)) do add(b.name, b.wing) end
  local extra = D.extraSources(d)
  if #extra > 0 then
    rows[#rows + 1] = { text = "Also seen here", color = "accent" }
    for _, s in ipairs(extra) do add(s) end
  end
  return rows
end

function M.refresh(body)
  local list = {}
  for _, d in ipairs(ns.data.dungeons) do
    local ok = body.filter == "all" or (body.filter == "raid" and d.kind == "raid") or (body.filter == "fit" and d.kind ~= "raid" and D.fit(d) == "fit")
    if ok then list[#list + 1] = d end
  end
  local here = D.current()
  if here and (not body.picked or body.followed ~= here.name) then body.picked = here; body.followed = here.name end
  if not body.picked then
    for _, d in ipairs(ns.data.dungeons) do if d.kind ~= "raid" and D.fit(d) == "fit" then body.picked = d break end end
    body.picked = body.picked or ns.data.dungeons[1]
  end
  body.filters.pick(body.filter, true)
  body.views.pick(body.view, true)
  body.left.set(list)

  local d, right = body.picked, body.right
  right.name:SetText(d.name)
  right.info:SetText(d.unknown and "New to the Codex: it will learn this place as you play." or
    string.format("%s  ·  %s  ·  %s", d.kind == "raid" and "Raid" or ("Levels " .. d.min .. "-" .. d.max), d.zone, #D.bosses(d) .. " bosses"))
  local rows, note = {}, ""
  if body.view == "bosses" then
    rows = bossRows(body, d)
    note = "Click a boss for the loot you've seen it drop, with your own drop rate. Click an item to wishlist it."
  elseif body.view == "quests" then
    for _, q in ipairs(D.quests(d)) do
      rows[#rows + 1] = { text = q.title, right = q.active and "In your log" or "", color = q.active and "good" or "text", tip = "Pick up: " .. q.where,
        icon = "Interface\\Icons\\INV_Misc_Note_01" }
      rows[#rows + 1] = { text = q.where, indent = 34, color = "dim" }
    end
    note = #rows == 0 and (ns.faction() == "Horde" and "No quests listed for this one yet." or "The quest list is Horde-only for now.") or "Quests worth bringing, and where each starts."
  else
    for _, k in ipairs(D.keys(d)) do
      rows[#rows + 1] = { text = k.name, color = "accent", icon = "Interface\\Icons\\INV_Misc_Key_03" }
      for i, step in ipairs(k.steps) do rows[#rows + 1] = { text = i .. ".  " .. step, indent = 34, tip = step } end
    end
    note = #rows == 0 and "No key or attunement needed." or "The Classic steps. Forever may have changed details."
  end
  right.note:SetText(note)
  body.detail.offset = math.min(body.detail.offset, math.max(0, #rows - 1))
  body.detail.set(rows)
end
