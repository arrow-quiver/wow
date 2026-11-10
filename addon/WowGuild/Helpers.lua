-- Guild Camp: helpers while you play.
--   * Nearby (option radar, /wow near): guildies online in your zone, closest in level first, with "Group up?"
--     whispers. Entering a zone with guildies in it says who's there.
--   * Instance helper (option instanceHelper): entering a dungeon shows which guildies online are the right level
--     for it (with Invite), and an "Ask the Coach for tips" button.
--   * Smart reminders (option reminders): a raid you signed up for starting soon (and bring your consumables),
--     gear about to break, bags nearly full, unspent talent points. Each one at most every 30 minutes.
--   * Who can craft this (Alt-click an item link): the guild's crafters for it, and a crafting request in one click
--     (shared like the guild window's, and the crafter gets a whisper).
local ADDON, ns = ...
local S = ns.skin
local H = {}
ns.helpers = H

H.REMIND_EVERY = 30 * 60
H.RAID_SOON = 60 * 60         -- a raid within the hour
local ROWS = 8

local function me() return UnitName and UnitName("player") or "?" end
local function short(n) return n and (string.match(n, "^([^%-]+)") or n) or nil end
local function now() return (GetServerTime and ns.try(GetServerTime)) or time() end
local function whisper(text, to)
  local send = (C_ChatInfo and C_ChatInfo.SendChatMessage) or SendChatMessage
  return send and pcall(send, text, "WHISPER", nil, to) or false
end

-- ---------- the guild roster ----------
-- → { { name, level, class, zone, online } } of guildmates online (not me).
function H.online()
  local out = {}
  if not GetNumGuildMembers or not GetGuildRosterInfo then return out end
  for i = 1, (ns.try(GetNumGuildMembers) or 0) do
    local name, _, _, level, class, zone, _, _, online = ns.try(GetGuildRosterInfo, i)
    name = short(name)
    if name and online and name ~= me() then out[#out + 1] = { name = name, level = level or 0, class = class, zone = zone } end
  end
  return out
end

local function myLevel() return (UnitLevel and ns.try(UnitLevel, "player")) or 0 end
local function myZone() return (GetRealZoneText and ns.try(GetRealZoneText)) or (GetZoneText and ns.try(GetZoneText)) or "" end

-- Guildmates in my zone, closest in level first.
function H.nearby()
  local zone, lvl, out = myZone(), myLevel(), {}
  for _, g in ipairs(H.online()) do if g.zone and g.zone == zone then out[#out + 1] = g end end
  table.sort(out, function(a, b) return math.abs(a.level - lvl) < math.abs(b.level - lvl) end)
  return out, zone
end

-- ---------- a small list panel (Nearby and the instance helper share it) ----------
local panel
local function makePanel()
  local f = CreateFrame("Frame", "WowGuildHelperPanel", UIParent)
  f:SetSize(300, 70 + ROWS * 24); f:SetPoint("LEFT", 24, 60); f:SetFrameStrata("HIGH")
  S.panel(f)
  f.title = S.text(f, "heading", "", S.GOLD); f.title:SetPoint("TOPLEFT", 12, -10)
  f.sub = S.text(f, "small", "", S.GREY); f.sub:SetPoint("TOPLEFT", 12, -30); f.sub:SetWidth(276)
  f.rows = {}
  for i = 1, ROWS do
    local r = CreateFrame("Frame", nil, f)
    r:SetSize(276, 22); r:SetPoint("TOPLEFT", 12, -50 - (i - 1) * 24)
    r.name = S.text(r, "small", ""); r.name:SetPoint("LEFT", 0, 0); r.name:SetWidth(170)
    r.btn = CreateFrame("Button", nil, r, "UIPanelButtonTemplate"); r.btn:SetSize(96, 20); r.btn:SetPoint("RIGHT", 0, 0)
    f.rows[i] = r
  end
  f.extra = CreateFrame("Button", nil, f, "UIPanelButtonTemplate"); f.extra:SetSize(180, 22); f.extra:SetPoint("BOTTOMLEFT", 12, 8)
  f.close = CreateFrame("Button", nil, f, "UIPanelButtonTemplate"); f.close:SetSize(70, 22); f.close:SetPoint("BOTTOMRIGHT", -12, 8)
  f.close:SetText("Close"); f.close:SetScript("OnClick", function() f:Hide() end)
  f:Hide()
  return f
end

-- Fills the panel: rows = { { text, button = { label, onClick } } }, extra = { label, onClick } or nil.
function H.show(title, sub, rows, extra)
  panel = panel or makePanel()
  panel.title:SetText(title); panel.sub:SetText(sub or "")
  for i, r in ipairs(panel.rows) do
    local x = rows[i]
    if x then
      r.name:SetText(x.text)
      if x.button then r.btn:SetText(x.button[1]); r.btn:SetScript("OnClick", function() ns.safely(x.button[2]) end); r.btn:Show() else r.btn:Hide() end
      r:Show()
    else r:Hide() end
  end
  if extra then panel.extra:SetText(extra[1]); panel.extra:SetScript("OnClick", function() ns.safely(extra[2]) end); panel.extra:Show() else panel.extra:Hide() end
  panel:Show()
  return panel
end

-- ---------- Nearby ----------
function H.groupUp(g, zone)
  return whisper(string.format("Hey %s! I'm in %s too (level %d). Want to group up?", g.name, zone ~= "" and zone or "the same zone", myLevel()), g.name)
end

function H.showNearby()
  local list, zone = H.nearby()
  local rows = {}
  for _, g in ipairs(list) do
    rows[#rows + 1] = { text = string.format("%s |cff9e9ea8%d|r", g.name, g.level), button = { "Group up?", function() H.groupUp(g, zone) end } }
  end
  if #rows == 0 then
    ns.print(string.format("No guildies online in %s right now.", zone ~= "" and zone or "this zone"))
    return 0
  end
  H.show("Guildies nearby", string.format("Online in %s, closest in level first", zone), rows)
  return #rows
end

H.lastZoneNote = {}
function H.zoneChanged()
  if ns.opt("radar") == false then return nil end
  -- Ask the server for a fresh roster at most once a minute (the game throttles it too).
  if not H.rosterAt or now() - H.rosterAt >= 60 then
    H.rosterAt = now()
    if C_GuildInfo and C_GuildInfo.GuildRoster then ns.try(C_GuildInfo.GuildRoster) elseif GuildRoster then ns.try(GuildRoster) end
  end
  local list, zone = H.nearby()
  if #list == 0 or (H.lastZoneNote[zone] and now() - H.lastZoneNote[zone] < 600) then return nil end
  H.lastZoneNote[zone] = now()
  local names = {}
  for i, g in ipairs(list) do if i <= 4 then names[#names + 1] = string.format("%s (%d)", g.name, g.level) end end
  local line = string.format("Guildies in %s: %s%s. /wow near to group up.", zone, table.concat(names, ", "), #list > 4 and (" +" .. (#list - 4)) or "")
  ns.print(line)
  return line
end

-- ---------- instance helper ----------
local function dungeonFor(name)
  local list = ns.finder and ns.finder.DUNGEONS
  if not name or not list then return nil end
  local n = string.lower(name):gsub("^the ", "")
  for _, d in ipairs(list) do if string.lower(d.name):gsub("^the ", "") == n then return d end end
end
H.dungeonFor = dungeonFor

local function inMyGroup(name)
  if UnitInParty and ns.try(UnitInParty, name) then return true end
  if UnitInRaid and ns.try(UnitInRaid, name) then return true end
  return false
end

function H.enteredInstance()
  if ns.opt("instanceHelper") == false or not IsInInstance or not GetInstanceInfo then return nil end
  local inside, kind = ns.try(IsInInstance)
  if not inside or (kind ~= "party" and kind ~= "raid") then return nil end
  local name = ns.try(GetInstanceInfo)
  local d = dungeonFor(name)
  if not d then return nil end
  local rows = {}
  for _, g in ipairs(H.online()) do
    if g.level >= d.min and g.level <= d.max + 2 and not inMyGroup(g.name) then
      rows[#rows + 1] = { text = string.format("%s |cff9e9ea8%d %s|r", g.name, g.level, g.zone or ""), button = { "Invite", function()
        local invite = (C_PartyInfo and C_PartyInfo.InviteUnit) or InviteUnit
        if invite then ns.try(invite, g.name) end
      end } }
    end
  end
  local sub = #rows > 0 and string.format("Guildies online the right level (%d-%d) for it:", d.min, d.max)
    or string.format("No guildies online at level %d-%d right now.", d.min, d.max)
  H.show(d.name, sub, rows, { "Ask the Coach for tips", function()
    if not (ns.coach and ns.coach.ask) then ns.print("Ask the Coach in the Guild Camp app: " .. d.name .. " tips."); return end
    -- ns.coach.ask says itself when the question can't be queued.
    if ns.coach.ask(string.format("Tips for %s at my level: which bosses and pulls to watch, what to bring?", d.name)) then
      ns.print("Asked the Coach about " .. d.name .. ". The answer comes after your next /reload (with the Guild Camp app running): /wow coach ask.")
    end
  end })
  return #rows
end

-- ---------- smart reminders ----------
local reminded = {}
local function remind(key, text)
  if ns.opt("reminders") == false then return false end
  if reminded[key] and now() - reminded[key] < H.REMIND_EVERY then return false end
  reminded[key] = now()
  ns.print("|cffe8a33dReminder:|r " .. text)
  if ns.notice then ns.notice(text) end
  return true
end
H.remind = remind
function H.resetReminders() reminded = {} end

function H.lowestDurability()
  if not GetInventoryItemDurability then return nil end
  local low
  for slot = 1, 18 do
    local cur, max = ns.try(GetInventoryItemDurability, slot)
    if cur and max and max > 0 then local p = cur / max; if not low or p < low then low = p end end
  end
  return low
end

function H.freeSlots()
  local free = 0
  local num = (C_Container and C_Container.GetContainerNumFreeSlots) or GetContainerNumFreeSlots
  if not num then return nil end
  for bag = 0, 4 do local n = ns.try(num, bag); if type(n) == "number" then free = free + n end end
  return free
end

function H.check()
  local said = {}
  local t = now()
  for _, r in ipairs((WowGuildInbox and WowGuildInbox.raids) or {}) do
    if r.signup == "yes" and r.startsAt and r.startsAt > t and r.startsAt - t <= H.RAID_SOON then
      local mins = math.floor((r.startsAt - t) / 60 + 0.5)
      if remind("raid" .. (r.id or ""), string.format("%s starts in %d minutes. Repair, and bring food, potions and reagents.", r.title or r.instance or "Your raid", mins)) then said[#said + 1] = "raid" end
    end
  end
  local d = H.lowestDurability()
  if d and d < 0.2 and remind("repair", string.format("Your gear is at %d%%: repair before it breaks.", math.floor(d * 100))) then said[#said + 1] = "repair" end
  local free = H.freeSlots()
  if free and free <= 2 and remind("bags", free == 0 and "Your bags are full." or string.format("Only %d bag slot%s left.", free, free == 1 and "" or "s")) then said[#said + 1] = "bags" end
  local pts = (GetUnspentTalentPoints and ns.try(GetUnspentTalentPoints)) or (UnitCharacterPoints and ns.try(UnitCharacterPoints, "player"))
  if type(pts) == "number" and pts > 0 and remind("talents", string.format("You have %d talent point%s to spend%s.", pts, pts == 1 and "" or "s",
    ns.coachTalents and " (the Coach shows the next one beside your talents)" or "")) then said[#said + 1] = "talents" end
  return said
end

-- ---------- who can craft this ----------
function H.crafters(name)
  local who = name and ns.tooltip and ns.tooltip.craftersFor and ns.tooltip.craftersFor(name)
  local list = {}
  if who then for n in string.gmatch(who, "[^,]+") do list[#list + 1] = n end end
  return list
end

function H.requestCraft(name, crafter)
  local S2 = ns.Share
  local pid = S2 and S2.myPid and ns.try(S2.myPid)
  local ok = false
  if S2 and S2.putLocal and pid then
    -- putLocal returns the stored record, or nil and a reason (sharing not open yet, …).
    local called, res = pcall(S2.putLocal, "cr", ns.randomKey(), { pid = pid, item = name, notes = crafter and ("for " .. crafter) or "", state = "o" })
    ok = called and res ~= nil and res ~= false
  end
  if ok and crafter then whisper(string.format("Hi %s! Could you craft %s for me? I've put in a guild crafting request. I can bring the mats.", crafter, name), crafter) end
  ns.print(ok and string.format("Crafting request for %s sent to the guild%s.", name, crafter and (", and " .. crafter .. " knows") or "")
    or string.format("Couldn't add the request. Whisper %s or use the guild window.", crafter or "a crafter"))
  return ok
end

function H.showCrafters(link)
  local name = link and string.match(link, "|h%[(.-)%]|h")
  if not name then return nil end
  local list = H.crafters(name)
  if #list == 0 then ns.print(string.format("Nobody in the guild has the recipe for %s (that Guild Camp knows of).", name)); return 0 end
  local rows = {}
  for _, c in ipairs(list) do rows[#rows + 1] = { text = c, button = { "Ask to craft", function() H.requestCraft(name, c) end } } end
  H.show("Who can craft this?", name, rows, { "Request from the guild", function() H.requestCraft(name, nil) end })
  return #rows
end

-- Alt-click an item link (chat, bags, loot) to see who can craft it.
local hooked = false
function H.hookLinks()
  if hooked or not hooksecurefunc then return end
  hooked = true
  if HandleModifiedItemClick then
    hooksecurefunc("HandleModifiedItemClick", function(link)
      if ns.opt("craftLookup") ~= false and IsAltKeyDown and IsAltKeyDown() and not (IsShiftKeyDown and IsShiftKeyDown()) and not (IsControlKeyDown and IsControlKeyDown()) then
        ns.safely(H.showCrafters, link)
      end
    end)
  end
end

ns.on("PLAYER_LOGIN", function()
  ns.safely(H.hookLinks)
  if C_Timer and C_Timer.NewTicker then C_Timer.NewTicker(60, function() ns.safely(H.check) end) end
end)
ns.on("ZONE_CHANGED_NEW_AREA", function() ns.safely(H.zoneChanged) end)
ns.on("PLAYER_ENTERING_WORLD", function() ns.safely(H.enteredInstance); ns.safely(H.check) end)
ns.on("UPDATE_INVENTORY_DURABILITY", function() ns.safely(H.check) end)
ns.on("BAG_UPDATE_DELAYED", function() ns.safely(H.check) end)
