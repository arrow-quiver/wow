-- Guild Camp: the dungeon quest checklist. Entering a dungeon (or /wow quests <dungeon>) shows the Horde quests
-- worth taking into it: the ones in your quest log, the ones you could still pick up (and where), and which of
-- your party have each one (their addons tell each other over the party's addon channel, a few bytes, on entering
-- or when asked). Any quest in your log that mentions the dungeon counts too, so a quest missing from the list
-- below still shows. Option dungeonQuests.
local ADDON, ns = ...
local Q = {}
ns.dungeonQuests = Q

Q.PREFIX = "WowGuildQ"
local GOLD, GREY, GREEN = "|cffe8a33d", "|cff9e9ea8", "|cff7fd17f"

-- Horde quests by dungeon: { title, where } (class quests and long chains' middle steps left out).
Q.DATA = {
  ["Ragefire Chasm"] = {
    { "Testing an Enemy's Strength", "Rahauro, Thunder Bluff (Elder Rise)" },
    { "Searching for the Lost Satchel", "Rahauro, Thunder Bluff (Elder Rise)" },
    { "The Power to Destroy...", "Varimathras, Undercity" },
    { "Hidden Enemies", "Thrall, Orgrimmar" },
    { "Slaying the Beast", "Neeru Fireblade, Orgrimmar (Cleft of Shadow)" },
  },
  ["Wailing Caverns"] = {
    { "Serpentbloom", "Apothecary Zamah, Thunder Bluff (Spirit Rise)" },
    { "Leaders of the Fang", "Nara Wildmane, Thunder Bluff (Elder Rise)" },
    { "Deviate Hides", "Nalpak, in the cave above the entrance" },
    { "Smart Drinks", "Mebok Mizzyrix, Ratchet" },
    { "Trouble at the Docks", "Crane Operator Bigglefuzz, Ratchet" },
  },
  ["Shadowfang Keep"] = {
    { "Deathstalkers in Shadowfang", "High Executor Hadrec, The Sepulcher" },
    { "The Book of Ur", "Keeper Bel'dugur, Undercity (Apothecarium)" },
    { "Arugal Must Die", "Dalar Dawnweaver, The Sepulcher" },
  },
  ["Blackfathom Deeps"] = {
    { "The Essence of Aku'Mai", "Je'neu Sancrea, Zoram'gar Outpost (Ashenvale)" },
    { "Amongst the Ruins", "Je'neu Sancrea, Zoram'gar Outpost (Ashenvale)" },
    { "Allegiance to the Old Gods", "a Damp Note dropped inside" },
    { "Blackfathom Villainy", "Bashana Runetotem, Thunder Bluff (Elder Rise)" },
  },
  ["Razorfen Kraul"] = {
    { "Going, Going, Guano!", "Master Apothecary Faranell, Undercity" },
    { "A Vengeful Fate", "Auld Stonespire, Thunder Bluff" },
    { "Willix the Importer", "Willix, inside (escort)" },
  },
  ["Gnomeregan"] = {
    { "Gnogaine", "Nogg, Orgrimmar (Valley of Honor)" },
    { "The Sparklematic 5200!", "inside, at the Sparklematic" },
  },
  ["Scarlet Monastery"] = {
    { "Into The Scarlet Monastery", "Varimathras, Undercity" },
    { "Hearts of Zeal", "Master Apothecary Faranell, Undercity" },
    { "Compendium of the Fallen", "Sage Truthseeker, Thunder Bluff" },
    { "Test of Lore", "Parqual Fintallas, Undercity" },
  },
  ["Razorfen Downs"] = {
    { "Bring the End", "Andrew Brownell, Undercity" },
    { "Scourge of the Downs", "Belnistrasz, inside" },
    { "A Host of Evil", "Myriam Moonsinger, near the entrance" },
  },
  ["Zul'Farrak"] = {
    { "Divino-matic Rod", "Chief Engineer Bilgewhizzle, Gadgetzan" },
    { "Scarab Shells", "Tran'rek, Gadgetzan" },
    { "Troll Temper", "Trenton Lighthammer, Gadgetzan" },
    { "Gahz'rilla", "Wizzle Brassbolts, Shimmering Flats" },
    { "Tiara of the Deep", "Tabetha, Dustwallow Marsh" },
    { "The Prophecy of Mosh'aru", "Yeh'kinya, Steamwheedle Port (Tanaris)" },
  },
  ["Maraudon"] = {
    { "Corruption of Earth and Seed", "Selendra, Desolace (near the entrance)" },
    { "Legends of Maraudon", "Cavindra, inside the orange entrance" },
    { "Vyletongue Corruption", "Vark Battlescar, Shadowprey Village" },
    { "Shadowshard Fragments", "Uthel'nay, Orgrimmar (Valley of Spirits)" },
  },
}

local function dungeonNamed(name)
  if not name then return nil end
  local want = string.lower(name):gsub("^the ", "")
  for k in pairs(Q.DATA) do if string.lower(k):gsub("^the ", "") == want then return k end end
  local d = ns.finder and ns.finder.dungeon and ns.finder.dungeon(name)
  if type(d) == "table" and d.name then for k in pairs(Q.DATA) do if string.lower(k) == string.lower(d.name) then return k end end end
end
Q.dungeonNamed = dungeonNamed

-- My quest log: { [lower title] = { title, done } } and the text of each quest (for "mentions the dungeon").
function Q.myLog()
  local out = {}
  local n = (C_QuestLog and C_QuestLog.GetNumQuestLogEntries and ns.try(C_QuestLog.GetNumQuestLogEntries)) or (GetNumQuestLogEntries and ns.try(GetNumQuestLogEntries)) or 0
  for i = 1, math.min(n or 0, 50) do
    local title, isHeader, done, text
    if C_QuestLog and C_QuestLog.GetInfo then
      local info = ns.try(C_QuestLog.GetInfo, i)
      if type(info) == "table" then title, isHeader = info.title, info.isHeader; done = info.isComplete == 1 or info.isComplete == true end
    elseif GetQuestLogTitle then
      local t, _, _, hdr, _, complete = ns.try(GetQuestLogTitle, i)
      title, isHeader, done = t, hdr, complete == 1
    end
    if type(title) == "string" and not isHeader then
      if GetQuestLogQuestText and SelectQuestLogEntry then
        -- Reading a quest's text needs it selected: put the selection back afterwards.
        local prev = GetQuestLogSelection and ns.try(GetQuestLogSelection)
        ns.try(SelectQuestLogEntry, i)
        local desc, obj = ns.try(GetQuestLogQuestText)
        text = string.lower((desc or "") .. " " .. (obj or ""))
        if prev then ns.try(SelectQuestLogEntry, prev) end
      end
      out[string.lower(title)] = { title = title, done = done, text = text or "" }
    end
  end
  return out
end

-- The checklist for a dungeon: { { title, where, have, done, extra } }, quests in the log first.
function Q.checklist(dungeon)
  local key = dungeonNamed(dungeon)
  local log = Q.myLog()
  local out, listed = {}, {}
  for _, q in ipairs((key and Q.DATA[key]) or {}) do
    local mine = log[string.lower(q[1])]
    listed[string.lower(q[1])] = true
    out[#out + 1] = { title = q[1], where = q[2], have = mine ~= nil, done = mine and mine.done or false }
  end
  -- Quests in my log that mention the dungeon by name but aren't on the list.
  local needle = string.lower((key or dungeon or "")):gsub("^the ", "")
  if needle ~= "" then
    for lt, q in pairs(log) do
      if not listed[lt] and string.find(q.text, needle, 1, true) then out[#out + 1] = { title = q.title, where = "in your quest log", have = true, done = q.done, extra = true } end
    end
  end
  table.sort(out, function(a, b) if a.have ~= b.have then return a.have end return a.title < b.title end)
  return out, key or dungeon
end

-- ---------- the party ----------
-- Others' quests: { [player] = { [lower title] = true } }, for the dungeon we're looking at.
Q.party = {}
local function partyChannel()
  if IsInRaid and ns.try(IsInRaid) then return "RAID" end
  if IsInGroup and ns.try(IsInGroup) then return "PARTY" end
  return nil
end

-- "D<n>:<bits>" where bit i says I have the list's quest i. Only the list's quests: no free text goes out.
function Q.encode(key)
  local list = Q.DATA[key]
  if not list then return nil end
  local log, bits = Q.myLog(), {}
  for i, q in ipairs(list) do bits[i] = log[string.lower(q[1])] and "1" or "0" end
  local names = {}
  for k in pairs(Q.DATA) do names[#names + 1] = k end
  table.sort(names)
  for i, k in ipairs(names) do if k == key then return "D" .. i .. ":" .. table.concat(bits) end end
end

function Q.decode(msg)
  local i, bits = string.match(msg or "", "^D(%d+):([01]+)$")
  if not i then return nil end
  local names = {}
  for k in pairs(Q.DATA) do names[#names + 1] = k end
  table.sort(names)
  local key = names[tonumber(i)]
  if not key then return nil end
  local have = {}
  for j = 1, #bits do if string.sub(bits, j, j) == "1" and Q.DATA[key][j] then have[string.lower(Q.DATA[key][j][1])] = true end end
  return key, have
end

local registered = false
function Q.tell(key, ask)
  local chan = partyChannel()
  local msg = Q.encode(key)
  if not chan or not msg then return false end
  if not registered and C_ChatInfo and C_ChatInfo.RegisterAddonMessagePrefix then registered = true; ns.try(C_ChatInfo.RegisterAddonMessagePrefix, Q.PREFIX) end
  local send = C_ChatInfo and C_ChatInfo.SendAddonMessage
  if not send then return false end
  return pcall(send, Q.PREFIX, (ask and "?" or "") .. msg, chan) and true or false
end

function Q.heard(prefix, msg, chan, sender)
  if prefix ~= Q.PREFIX or type(msg) ~= "string" then return nil end
  local who = sender and (string.match(sender, "^([^%-%s]+)") or sender)
  if who == (UnitName and UnitName("player")) then return nil end
  local ask = string.sub(msg, 1, 1) == "?"
  local key, have = Q.decode(ask and string.sub(msg, 2) or msg)
  if not key then return nil end
  Q.party[key] = Q.party[key] or {}
  Q.party[key][who] = have
  if ask then Q.tell(key, false) end
  if Q.shown == key then Q.show(key) end
  return key
end

-- ---------- the panel (our own frame) ----------
local ROWS = 10
local panel
local function makePanel()
  local S = ns.skin
  local f = CreateFrame("Frame", "WowGuildQuestPanel", UIParent)
  f:SetSize(380, 74 + ROWS * 34); f:SetPoint("RIGHT", -60, 40); f:SetFrameStrata("HIGH")
  S.panel(f)
  f.title = S.text(f, "heading", "", S.GOLD); f.title:SetPoint("TOPLEFT", 12, -10)
  f.sub = S.text(f, "small", "", S.GREY); f.sub:SetPoint("TOPLEFT", 12, -30); f.sub:SetWidth(356)
  f.rows = {}
  for i = 1, ROWS do
    local r = CreateFrame("Frame", nil, f)
    r:SetSize(356, 32); r:SetPoint("TOPLEFT", 12, -48 - (i - 1) * 34)
    r.name = S.text(r, "body", ""); r.name:SetPoint("TOPLEFT", 0, 0); r.name:SetWidth(356)
    r.state = S.text(r, "small", ""); r.state:SetPoint("TOPLEFT", 0, -16); r.state:SetWidth(356)
    f.rows[i] = r
  end
  f.ask = CreateFrame("Button", nil, f, "UIPanelButtonTemplate"); f.ask:SetSize(150, 22); f.ask:SetPoint("BOTTOMLEFT", 12, 8)
  f.ask:SetText("Ask my group")
  f.close = CreateFrame("Button", nil, f, "UIPanelButtonTemplate"); f.close:SetSize(70, 22); f.close:SetPoint("BOTTOMRIGHT", -12, 8)
  f.close:SetText("Close"); f.close:SetScript("OnClick", function() f:Hide(); Q.shown = nil end)
  f:Hide()
  return f
end

function Q.show(dungeon)
  local list, key = Q.checklist(dungeon)
  if #list == 0 then ns.print(string.format("No quests known for %s. Ask the Coach in the Guild Camp app for tips.", tostring(dungeon))); return 0 end
  Q.shown = key
  panel = panel or makePanel()
  panel.title:SetText("Quests: " .. key)
  panel.sub:SetText("Bring these in. The grey ones you can still pick up.")
  for i, r in ipairs(panel.rows) do
    local q = list[i]
    if q then
      local others = {}
      for who, have in pairs((Q.party[key]) or {}) do if have[string.lower(q.title)] then others[#others + 1] = who end end
      table.sort(others)
      r.name:SetText(q.title)
      r.state:SetText((q.done and (GREEN .. "ready to hand in|r") or q.have and (GOLD .. "in your log|r") or (GREY .. q.where .. "|r"))
        .. (#others > 0 and (GREY .. " · also: " .. table.concat(others, ", ") .. "|r") or ""))
      r:Show()
    else r:Hide() end
  end
  panel.ask:SetScript("OnClick", function() Q.tell(key, true) end)
  panel:Show()
  return #list
end

-- Entering a dungeon from the list: a chat line, and the party learns what I have.
function Q.entered()
  if ns.opt("dungeonQuests") == false or not IsInInstance or not GetInstanceInfo then return nil end
  local inside, kind = ns.try(IsInInstance)
  if not inside or kind ~= "party" then return nil end
  local key = dungeonNamed(ns.try(GetInstanceInfo))
  if not key then return nil end
  Q.tell(key, true)
  local list = Q.checklist(key)
  local have, left = 0, 0
  for _, q in ipairs(list) do if q.have then have = have + 1 elseif not q.extra then left = left + 1 end end
  local line = string.format("%sQuests for %s:|r %d in your log, %d you haven't picked up. /wow quests to see them.", GOLD, key, have, left)
  ns.print(line)
  return line
end

function Q.slash(rest)
  local name = rest and rest:gsub("^%s+", ""):gsub("%s+$", "") or ""
  if name == "" then
    local inside = IsInInstance and ns.try(IsInInstance)
    if inside and GetInstanceInfo then name = ns.try(GetInstanceInfo) or "" end
  end
  local key = dungeonNamed(name)
  if not key then
    local names = {}
    for k in pairs(Q.DATA) do names[#names + 1] = k end
    table.sort(names)
    ns.print("/wow quests <dungeon>: " .. table.concat(names, ", "))
    return nil
  end
  Q.tell(key, true)
  return Q.show(key)
end

ns.on("CHAT_MSG_ADDON", function(...) ns.safely(Q.heard, ...) end)
ns.on("PLAYER_ENTERING_WORLD", function() ns.safely(Q.entered) end)
