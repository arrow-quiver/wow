-- Guild Camp: the group finder. Finds players from outside the guild for a dungeon group, like the game's own
-- looking-for-group tools: who is posting LFG / LFM in the chat channels for that dungeon, and a /who for its
-- level range. Each player can be whispered (the chat box opens with a message to send yourself), invited to your
-- party, or added to your guild dungeon group as a guest (Dungeons.lua), so guildmates see them in the line-up.
--
-- /wow lfg find [dungeon]   opens it (default: the dungeon of the group you lead)
--
-- Only what the game shows the player: chat lines they could read and /who results. Nothing is sent for them:
-- whispers wait in the chat box for Enter, and invites and /who need a click or a typed command.
local ADDON, ns = ...
local S = ns.skin
local F = {}
ns.finder = F

local SEEN_MAX = 60
local SEEN_FOR = 20 * 60      -- a chat line counts this long
local ROWS = 10

-- Dungeons with their usual levels and the short names players use in chat.
F.DUNGEONS = {
  { name = "Ragefire Chasm", min = 13, max = 18, alias = { "rfc", "ragefire" } },
  { name = "Wailing Caverns", min = 17, max = 24, alias = { "wc", "wailing" } },
  { name = "The Deadmines", min = 17, max = 26, alias = { "vc", "deadmines", "deadmine" } },
  { name = "Shadowfang Keep", min = 22, max = 30, alias = { "sfk", "shadowfang" } },
  { name = "Blackfathom Deeps", min = 24, max = 32, alias = { "bfd", "blackfathom" } },
  { name = "The Stockade", min = 24, max = 32, alias = { "stocks", "stockade", "stockades" } },
  { name = "Gnomeregan", min = 29, max = 38, alias = { "gnomer", "gnomeregan" } },
  { name = "Razorfen Kraul", min = 29, max = 38, alias = { "rfk", "kraul" } },
  { name = "Scarlet Monastery", min = 34, max = 45, alias = { "sm", "smgy", "smlib", "smarm", "smcath", "scarlet", "armory", "cath", "cathedral", "lib", "library", "gy" } },
  { name = "Razorfen Downs", min = 37, max = 46, alias = { "rfd", "downs" } },
  { name = "Uldaman", min = 41, max = 51, alias = { "ulda", "uld", "uldaman" } },
  { name = "Zul'Farrak", min = 44, max = 54, alias = { "zf", "zulfarrak", "farrak" } },
  { name = "Maraudon", min = 46, max = 55, alias = { "mara", "maraudon" } },
  { name = "Sunken Temple", min = 50, max = 60, alias = { "st", "temple", "sunken" } },
  { name = "Blackrock Depths", min = 52, max = 60, alias = { "brd", "emp", "arena" } },
  { name = "Lower Blackrock Spire", min = 55, max = 60, alias = { "lbrs" } },
  { name = "Upper Blackrock Spire", min = 58, max = 60, alias = { "ubrs" } },
  { name = "Dire Maul", min = 56, max = 60, alias = { "diremaul", "dme", "dmw", "dmn", "tribute" } },
  { name = "Scholomance", min = 58, max = 60, alias = { "scholo", "scholomance", "scholo" } },
  { name = "Stratholme", min = 58, max = 60, alias = { "strat", "stratholme", "ud", "live", "baron" } },
}
local BY_ALIAS = {}
for _, d in ipairs(F.DUNGEONS) do
  BY_ALIAS[string.lower(d.name)] = d
  for _, a in ipairs(d.alias) do BY_ALIAS[a] = d end
end

-- A dungeon by its name or a short name ("dm" is the Deadmines unless "dm east/west/north/tribute").
function F.dungeon(text)
  if type(text) ~= "string" or text == "" then return nil end
  local low = string.lower(text)
  local exact = BY_ALIAS[(string.gsub(low, "^%s*(.-)%s*$", "%1"))]
  if exact then return exact end
  for _, d in ipairs(F.DUNGEONS) do
    if string.find(low, string.lower(d.name), 1, true) then return d end
  end
  local words = {}
  for w in string.gmatch(low, "[%a']+") do words[#words + 1] = (string.gsub(w, "'", "")) end
  for i, w in ipairs(words) do
    if w == "dm" then
      local nxt = words[i + 1]
      if nxt == "east" or nxt == "west" or nxt == "north" or nxt == "e" or nxt == "w" or nxt == "n" or nxt == "tribute" then return BY_ALIAS.diremaul end
      return BY_ALIAS.deadmines
    end
    local d = BY_ALIAS[w]
    -- Very short words only count when they stand for nothing else here.
    if d and (#w > 2 or w == "wc" or w == "zf" or w == "st" or w == "sm" or w == "ud") then return d end
  end
  return nil
end

local ROLE_WORDS = {
  t = { "tank", "tanks", "tanking", "prot", "warr", "warrior" },
  h = { "heal", "heals", "healer", "healers", "priest", "shaman", "druid", "resto" },
  d = { "dps", "dd", "damage", "mage", "rogue", "hunter", "lock", "warlock" },
}

-- What a chat line means: { kind = "lfg" (a player looking for a group) | "lfm" (a group looking for people),
-- role = t/h/d (the role they play for lfg, the role they need for lfm) or nil, dungeon } or nil.
function F.parse(text)
  if type(text) ~= "string" or text == "" or #text > 255 then return nil end
  local low = " " .. string.lower(text) .. " "
  local kind
  if string.find(low, "[^%a]lf%d?m[^%a]") or string.find(low, "looking for more") or string.find(low, "[^%a]need[^%a]") then
    kind = "lfm"
  elseif string.find(low, "[^%a]lfg[^%a]") or string.find(low, "looking for group") or string.find(low, "[^%a]lf [%a]") then
    kind = "lfg"
  end
  if not kind then return nil end
  local d = F.dungeon(text)
  if not d then return nil end
  local role
  for code, words in pairs(ROLE_WORDS) do
    for _, w in ipairs(words) do
      if string.find(low, "[^%a]" .. w .. "[^%a]") then role = role or code end
    end
  end
  return { kind = kind, role = role, dungeon = d.name }
end

-- ---------- what was seen ----------
F.seen = {}   -- name → { name, text, kind, role, dungeon, at, source = "chat" | "who", level, class, area }

local function now() return (GetTime and GetTime()) or (time and time()) or 0 end

local function guildmate(name)
  local short = string.match(name or "", "^([^%-]+)") or name
  local members = ns.db and ns.db.roster and ns.db.roster.members
  if type(members) ~= "table" then return false end
  for _, m in ipairs(members) do
    if type(m) == "table" and (m.name == name or m.name == short) then return true end
  end
  return false
end

local function remember(e)
  local myName = UnitName and UnitName("player")
  local short = string.match(e.name or "", "^([^%-]+)")
  if not e.name or e.name == myName or short == myName or guildmate(e.name) then return end
  local old = F.seen[e.name]
  if old then for k, v in pairs(old) do if e[k] == nil then e[k] = v end end end
  F.seen[e.name] = e
  local n, oldest, oldestAt = 0, nil, nil
  for k, v in pairs(F.seen) do
    n = n + 1
    if not oldestAt or v.at < oldestAt then oldest, oldestAt = k, v.at end
  end
  if n > SEEN_MAX and oldest then F.seen[oldest] = nil end
end

-- A chat channel line (General, Trade, LookingForGroup, World ...).
function F.onChat(text, author)
  if type(text) ~= "string" or type(author) ~= "string" or author == "" then return end
  local p = F.parse(text)
  if not p then return end
  remember({ name = author, text = text, kind = p.kind, role = p.role, dungeon = p.dungeon, at = now(), source = "chat" })
  if F.frame and F.frame:IsShown() then F.refresh() end
end

-- Players to show for a dungeon, newest first: chat lines about it, then /who results.
function F.results(dungeon)
  local out = {}
  local t = now()
  for name, e in pairs(F.seen) do
    if t - (e.at or 0) > SEEN_FOR then
      F.seen[name] = nil
    elseif not dungeon or e.dungeon == dungeon or e.source == "who" then
      out[#out + 1] = e
    end
  end
  table.sort(out, function(a, b)
    if (a.source == "chat") ~= (b.source == "chat") then return a.source == "chat" end
    if a.at ~= b.at then return a.at > b.at end
    return a.name < b.name
  end)
  return out
end

-- ---------- /who ----------
local whoPending = false
local function who()
  return C_FriendList and C_FriendList.SendWho and C_FriendList or nil
end

-- A /who for the dungeon's level range. Needs a click or a typed command (the game asks for it).
function F.searchWho(d)
  d = d or F.current
  if not d then ns.print("Pick a dungeon first.") return false end
  local q = string.format("%d-%d", d.min, d.max)
  local api = who()
  whoPending = true
  if api then
    if api.SetWhoToUi then ns.try(api.SetWhoToUi, true) end
    if FriendsFrame and FriendsFrame.UnregisterEvent then ns.try(FriendsFrame.UnregisterEvent, FriendsFrame, "WHO_LIST_UPDATE") end
    local ok, err = pcall(api.SendWho, q)
    if not ok then whoPending = false; ns.reportError(err) return false end
  elseif SendWho then
    if SetWhoToUI then ns.try(SetWhoToUI, 1) end
    local ok = pcall(SendWho, q)
    if not ok then whoPending = false return false end
  else
    whoPending = false
    return false
  end
  if F.frame then F.frame.sub:SetText("Asking who is around, levels " .. q .. "…") end
  return true
end

local function whoInfo(i)
  local api = who()
  if api and api.GetWhoInfo then
    local info = ns.try(api.GetWhoInfo, i)
    if type(info) == "table" then
      return info.fullName, info.fullGuildName, info.level, info.classStr, info.filename, info.area
    end
    return nil
  end
  if GetWhoInfo then
    local name, guild, level, _, class, zone, file = GetWhoInfo(i)
    return name, guild, level, class, file, zone
  end
  return nil
end

function F.onWho()
  if not whoPending then return end
  whoPending = false
  if FriendsFrame and FriendsFrame.RegisterEvent then ns.try(FriendsFrame.RegisterEvent, FriendsFrame, "WHO_LIST_UPDATE") end
  local api = who()
  local n = (api and api.GetNumWhoResults and ns.try(api.GetNumWhoResults)) or (GetNumWhoResults and GetNumWhoResults()) or 0
  local myGuild = GetGuildInfo and ns.try(GetGuildInfo, "player")
  local added = 0
  for i = 1, math.min(tonumber(n) or 0, 50) do
    local name, guild, level, class, file, area = whoInfo(i)
    if type(name) == "string" and name ~= "" and (not myGuild or guild ~= myGuild) then
      remember({ name = name, level = level, class = file or class, className = class, area = area, at = now(), source = "who",
        guild = guild ~= "" and guild or nil })
      added = added + 1
    end
  end
  if F.frame and F.frame:IsShown() then F.refresh(added) end
end

-- ---------- suggested whispers ----------
function F.whisperText(e)
  local mine = ns.lfg and ns.lfg.myGroup and ns.lfg.myGroup()
  local d = (mine and mine.rec.fields.dungeon) or (F.current and F.current.name) or e.dungeon or "a dungeon"
  local R = ns.lfg and ns.lfg.ROLE_NAME or {}
  if e.kind == "lfm" and not mine then
    local _, class = nil, nil
    if UnitClass then class = UnitClass("player") end
    local level = UnitLevel and ns.try(UnitLevel, "player")
    return string.format("Hi! Level %s %s here, can I join your %s group?", tostring(level or "?"), tostring(class or ""), d)
  end
  if mine then
    local need = string.gsub(ns.lfg.needText(mine.g.open), "^needs ", "")
    local role = e.role and R[e.role]
    return string.format("Hi! Want to join our %s group%s? We need %s. I'll invite you.", d, role and (" as " .. role) or "", need)
  end
  return string.format("Hi! Want to group for %s?", d)
end

-- ---------- the window ----------
local GREY = { 0.62, 0.62, 0.66 }
local function classColor(token)
  local c = token and RAID_CLASS_COLORS and RAID_CLASS_COLORS[string.upper(tostring(token))]
  if c then return c.r, c.g, c.b end
  return 1, 1, 1
end

local function button(parent, label, w, onClick)
  local b = CreateFrame("Button", nil, parent, "UIPanelButtonTemplate")
  b:SetSize(w, 20); b:SetText(label); b:SetScript("OnClick", onClick)
  return b
end

local function create()
  local f = CreateFrame("Frame", "WowGuildFinder", UIParent)
  f:SetSize(430, 440); f:SetPoint("CENTER", 0, 40); f:SetFrameStrata("HIGH")
  f:SetMovable(true); f:EnableMouse(true); f:RegisterForDrag("LeftButton"); f:SetClampedToScreen(true)
  f:SetScript("OnDragStart", f.StartMoving); f:SetScript("OnDragStop", f.StopMovingOrSizing)
  S.panel(f)
  local close = CreateFrame("Button", nil, f, "UIPanelCloseButton"); close:SetPoint("TOPRIGHT", -2, -2)
  close:SetScript("OnClick", function() f:Hide() end)
  f.title = S.text(f, "heading", "Group finder", S.GOLD); f.title:SetPoint("TOPLEFT", 12, -10)
  f.sub = S.text(f, "small", "", GREY); f.sub:SetPoint("TOPLEFT", 12, -30); f.sub:SetWidth(400)
  if f.sub.SetWordWrap then f.sub:SetWordWrap(true) end
  f.who = button(f, "Who's around", 110, function() F.searchWho() end); f.who:SetPoint("TOPLEFT", 12, -50)
  f.inv = button(f, "Invite my group", 120, function() if ns.lfg then ns.lfg.inviteGroup() end end)
  f.inv:SetPoint("LEFT", f.who, "RIGHT", 8, 0)
  S.rule(f, -76, 8)
  f.rows = {}
  for i = 1, ROWS do
    local r = CreateFrame("Frame", nil, f)
    r:SetSize(406, 32); r:SetPoint("TOPLEFT", 12, -82 - (i - 1) * 33)
    r.name = S.text(r, "body", ""); r.name:SetPoint("TOPLEFT", 0, -1); r.name:SetWidth(200)
    r.meta = S.text(r, "small", "", GREY); r.meta:SetPoint("TOPLEFT", 0, -16); r.meta:SetWidth(232)
    if r.meta.SetWordWrap then r.meta:SetWordWrap(false) end
    r.add = button(r, "Add", 44, function(self) local e = self:GetParent().entry; if e then F.add(e) end end)
    r.add:SetPoint("RIGHT", 0, 0)
    r.invite = button(r, "Invite", 56, function(self) local e = self:GetParent().entry; if e and ns.lfg then ns.lfg.invite(e.name) end end)
    r.invite:SetPoint("RIGHT", r.add, "LEFT", -4, 0)
    r.whisper = button(r, "Whisper", 64, function(self) local e = self:GetParent().entry; if e and ns.lfg then ns.lfg.whisper(e.name, F.whisperText(e)) end end)
    r.whisper:SetPoint("RIGHT", r.invite, "LEFT", -4, 0)
    f.rows[i] = r
  end
  f.empty = S.text(f, "body", "", GREY); f.empty:SetPoint("TOPLEFT", 12, -90); f.empty:SetWidth(400)
  if f.empty.SetWordWrap then f.empty:SetWordWrap(true) end
  f:Hide()
  return f
end

function F.panel() F.frame = F.frame or create(); return F.frame end

-- Add a player as a guest of the group I lead, with the role they play (asked when the chat line didn't say).
function F.add(e)
  local role = e.kind == "lfg" and e.role or nil
  if not role then
    local token = string.upper(tostring(e.class or ""))
    if token == "MAGE" or token == "ROGUE" or token == "HUNTER" or token == "WARLOCK" then role = "d" end
  end
  if not role then
    ns.print(string.format("Which role does %s play? Type /wow lfg add %s <tank|healer|dps>", ns.lfg.plain(e.name), ns.lfg.plain(e.name)))
    return false
  end
  local ok = ns.lfg.addGuest(e.name, role, e.class, tonumber(e.level))
  if ok then F.refresh() end
  return ok
end

function F.refresh(whoCount)
  local f = F.panel()
  local mine = ns.lfg and ns.lfg.myGroup and ns.lfg.myGroup()
  local d = F.current
  local list = F.results(d and d.name or nil)
  local head = d and string.format("%s (levels %d-%d)", d.name, d.min, d.max) or "Any dungeon"
  if mine then head = head .. ". Your group " .. ns.lfg.needText(mine.g.open) .. "."
  else head = head .. ". Start a guild group with /wow lfg new to add players to it." end
  if whoCount then head = head .. string.format(" /who found %d.", whoCount) end
  f.sub:SetText(head)
  for _, r in ipairs(f.rows) do r:Hide(); r.entry = nil end
  if #list == 0 then
    f.empty:SetText("Nobody yet. Players posting LFG or LFM for this dungeon in the chat channels show up here as they post. "
      .. "Or click Who's around to look for players of the right level.")
    f.empty:Show()
  else
    f.empty:Hide()
  end
  local R = ns.lfg and ns.lfg.ROLE_NAME or {}
  for i = 1, math.min(#list, ROWS) do
    local e, r = list[i], f.rows[i]
    r.entry = e
    r.name:SetText(e.name .. (e.level and ("  |cff9e9ea8" .. tostring(e.level) .. "|r") or ""))
    r.name:SetTextColor(classColor(e.class))
    local meta
    if e.source == "chat" then
      meta = (e.kind == "lfm" and "LFM" or "LFG") .. (e.role and (" " .. (R[e.role] or "")) or "") .. ": " .. e.text
    else
      meta = "/who" .. (e.className and (", " .. e.className) or "") .. (e.area and (", " .. e.area) or "") .. (e.guild and (", <" .. e.guild .. ">") or "")
    end
    r.meta:SetText((string.gsub(meta, "|", "||")))
    r.add:SetShown(mine ~= nil)
    r:Show()
  end
  f.inv:SetShown(mine ~= nil)
end

function F.show(dungeonText)
  local mine = ns.lfg and ns.lfg.myGroup and ns.lfg.myGroup()
  F.current = F.dungeon(dungeonText or "") or (mine and F.dungeon(mine.rec.fields.dungeon)) or F.current
  if dungeonText and dungeonText ~= "" and not F.dungeon(dungeonText) then
    ns.print("Unknown dungeon \"" .. ns.lfg.plain(dungeonText) .. "\". Showing every dungeon.")
  end
  local f = F.panel()
  F.refresh()
  f:Show()
  return f
end

if ns.on then
  ns.on("CHAT_MSG_CHANNEL", function(text, author) ns.safely(F.onChat, text, author) end)
  ns.on("WHO_LIST_UPDATE", function() ns.safely(F.onWho) end)
end
