-- Guild Camp: celebrations. Your big moments go to guild chat, guildmates' addons cheer, and your Guild Camp app
-- posts them to the guild's Discord (it reads your own line from the chat log, like calls to arms).
--   * Levels 20, 30, 40 and 50, and a huge Horde celebration at 60 (a banner across the screen for everyone).
--   * Big moments: an epic or legendary item looted, a profession reaching 150 / 225 / 300, learning to ride,
--     a new PvP rank.
--   * Welcome wagon: when someone joins the guild, everyone gets a "Say welcome" button; officers also get
--     "Welcome kit", which whispers them the guide and picks a guild buddy close to their level.
-- Every line said looks like "[Guild Camp] <what happened> — from <name>"; the app looks for that shape.
local ADDON, ns = ...
local S = ns.skin
local C = {}
ns.celebrate = C

C.LEVELS = { [20] = true, [30] = true, [40] = true, [50] = true, [60] = true }
C.MAX_LEVEL = 60
C.PROF_STEPS = { 150, 225, 300 }
C.TAG = "[Guild Camp] "

local function me() return UnitName and UnitName("player") or "?" end

local PROFESSIONS = { alchemy = true, blacksmithing = true, enchanting = true, engineering = true, herbalism = true,
  leatherworking = true, mining = true, skinning = true, tailoring = true, jewelcrafting = true, inscription = true,
  cooking = true, ["first aid"] = true, fishing = true }
function C.isProfession(name) return PROFESSIONS[string.lower(name or "")] == true end

-- Officers (who can invite or edit officer notes) get the welcome kit.
function C.isOfficer()
  if C_GuildInfo and C_GuildInfo.CanEditOfficerNote and ns.try(C_GuildInfo.CanEditOfficerNote) then return true end
  if CanGuildInvite and ns.try(CanGuildInvite) then return true end
  return false
end
local function inInstance() return IsInInstance and ns.try(IsInInstance) and true or false end

-- The line for guild chat, kept under chat's 255 characters with the sender on the end.
function C.text(what, from)
  local tail = " — from " .. (from or me())
  local text = C.TAG .. what
  if #text + #tail > 255 then text = string.sub(text, 1, 255 - #tail - 3) .. "..." end
  return text .. tail
end

-- Says it in guild chat (not with the option off). In a dungeon or battleground it waits, and goes out when you
-- leave (C.flush), so a moment reached inside isn't lost. → the line, or nil (not said, or not yet).
C.MAX_PENDING = 5
function C.say(what)
  if ns.opt("celebrate") == false then return nil end
  if IsInGuild and not IsInGuild() then return nil end
  if inInstance() then
    ns.db.celebratePending = ns.db.celebratePending or {}
    if #ns.db.celebratePending < C.MAX_PENDING then table.insert(ns.db.celebratePending, what) end
    return nil
  end
  local send = (C_ChatInfo and C_ChatInfo.SendChatMessage) or SendChatMessage
  if not send then return nil end
  local line = C.text(what)
  if pcall(send, line, "GUILD") then return line end
end

-- Out of the instance: what waited goes out now.
function C.flush()
  local q = ns.db and ns.db.celebratePending
  if not q or #q == 0 or inInstance() then return 0 end
  ns.db.celebratePending = nil
  local n = 0
  for _, what in ipairs(q) do if C.say(what) then n = n + 1 end end
  return n
end

-- Once per character: remembers what was already celebrated (so a /reload never repeats it).
local function once(key)
  ns.db.celebrated = ns.db.celebrated or {}
  local who = me()
  ns.db.celebrated[who] = ns.db.celebrated[who] or {}
  if ns.db.celebrated[who][key] then return false end
  ns.db.celebrated[who][key] = time and time() or true
  return true
end
C.once = once

-- ---------- the banner (level 60) and toasts ----------
local banner
local function makeBanner()
  local f = CreateFrame("Frame", "WowGuildCelebration", UIParent)
  f:SetSize(760, 170); f:SetPoint("TOP", 0, -140); f:SetFrameStrata("FULLSCREEN_DIALOG")
  if f.EnableMouse then f:EnableMouse(false) end
  f.bg = S.colorTex(f, "BACKGROUND", 0.25, 0.02, 0.02, 0.82)
  S.gradient(f.bg, "HORIZONTAL", 0.12, 0, 0, 0.2, 0.45, 0.04, 0.02, 0.92)
  S.border(f, 0.9, 0.18, 0.1, 0.9, 2)
  f.title = S.text(f, "heading", "", { 1, 0.27, 0.12 }); f.title:SetPoint("TOP", 0, -22)
  if f.title.SetFont and STANDARD_TEXT_FONT then f.title:SetFont(STANDARD_TEXT_FONT, 40, "THICKOUTLINE") end
  f.sub = S.text(f, "heading", "", S.GOLD); f.sub:SetPoint("TOP", f.title, "BOTTOM", 0, -12)
  f.small = S.text(f, "body", "", S.PARCHMENT); f.small:SetPoint("TOP", f.sub, "BOTTOM", 0, -10)
  f:SetScript("OnUpdate", function(self, el)
    self.left = (self.left or 0) - (el or 0)
    if self.left <= 1 and self.SetAlpha then self:SetAlpha(math.max(0, self.left)) end
    if self.left <= 0 then self:Hide() end
  end)
  f:Hide()
  return f
end

-- The huge Horde celebration for a level 60.
function C.banner(name, mine)
  banner = banner or makeBanner()
  banner.title:SetText("LOK'TAR OGAR!")
  banner.sub:SetText(string.format("%s has reached level %d!", name, C.MAX_LEVEL))
  banner.small:SetText(mine and "The Horde grows stronger. Blood and thunder!" or "Blood and thunder! Give them a cheer in guild chat.")
  banner.left = 9
  if banner.SetAlpha then banner:SetAlpha(1) end
  banner:Show()
  if PlaySound then ns.try(PlaySound, (SOUNDKIT and SOUNDKIT.RAID_WARNING) or 8959) end
  return banner
end

local toast
local function makeToast()
  local f = CreateFrame("Frame", "WowGuildToast", UIParent)
  f:SetSize(340, 74); f:SetPoint("TOP", 0, -96); f:SetFrameStrata("DIALOG")
  S.panel(f)
  f.text = S.text(f, "body", ""); f.text:SetPoint("TOPLEFT", 12, -12); f.text:SetWidth(316)
  if f.text.SetWordWrap then f.text:SetWordWrap(true) end
  f.btn = CreateFrame("Button", nil, f, "UIPanelButtonTemplate"); f.btn:SetSize(130, 22); f.btn:SetPoint("BOTTOMLEFT", 12, 8)
  f.btn2 = CreateFrame("Button", nil, f, "UIPanelButtonTemplate"); f.btn2:SetSize(130, 22); f.btn2:SetPoint("LEFT", f.btn, "RIGHT", 8, 0)
  f.close = CreateFrame("Button", nil, f, "UIPanelButtonTemplate"); f.close:SetSize(22, 22); f.close:SetPoint("BOTTOMRIGHT", -8, 8)
  f.close:SetText("x"); f.close:SetScript("OnClick", function() f:Hide() end)
  f:SetScript("OnUpdate", function(self, el) self.left = (self.left or 0) - (el or 0); if self.left <= 0 then self:Hide() end end)
  f:Hide()
  return f
end

-- A small toast: text, and up to two buttons { label, onClick }.
function C.toast(text, b1, b2, seconds)
  toast = toast or makeToast()
  toast.text:SetText(text)
  for i, b in ipairs({ { toast.btn, b1 }, { toast.btn2, b2 } }) do
    local btn, spec = b[1], b[2]
    if spec then
      btn:SetText(spec[1]); btn:SetScript("OnClick", function() toast:Hide(); ns.safely(spec[2]) end); btn:Show()
    else btn:Hide() end
    local _ = i
  end
  toast.left = seconds or 20
  toast:Show()
  return toast
end

-- ---------- my moments ----------
function C.leveled(level)
  level = tonumber(level)
  if not level or not C.LEVELS[level] or not once("level" .. level) then return nil end
  local line = C.say(string.format("%s reached level %d!", me(), level))
  if level == C.MAX_LEVEL then C.banner(me(), true) end
  return line
end

local EPIC = { "|cffa335ee", "|cffff8000" } -- epic, legendary
function C.looted(msg)
  if type(msg) ~= "string" then return nil end
  -- The game's own (translated) "You receive loot: %s." lines; only loot, not quest rewards or crafts.
  local ok, mine = pcall(function()
    for _, fmt in ipairs({ LOOT_ITEM_SELF or false, LOOT_ITEM_SELF_MULTIPLE or false }) do
      if type(fmt) == "string" then
        local p = string.gsub(fmt, "([%(%)%.%-%+%[%]%?%^%$%*])", "%%%1")
        p = string.gsub(p, "%%s", "(.+)")
        p = string.gsub(p, "%%d", "%%d+")
        if string.find(msg, "^" .. p .. "$") then return true end
      end
    end
    return not LOOT_ITEM_SELF and string.find(msg, "^You receive loot:") ~= nil
  end)
  if not ok or not mine then return nil end
  local link = string.match(msg, "(|c%x+|Hitem:.-|h%[.-%]|h|r)")
  if not link then return nil end
  local epic = false
  for _, c in ipairs(EPIC) do if string.find(link, c, 1, true) == 1 then epic = true end end
  local id = string.match(link, "item:(%d+)")
  if not epic or not id or not once("loot" .. id) then return nil end
  return C.say(string.format("%s looted %s!", me(), link))
end

-- Profession steps and riding, from the skill list (Classic: GetSkillLineInfo).
function C.skills()
  if not GetNumSkillLines or not GetSkillLineInfo then return 0 end
  local said = 0
  for i = 1, (ns.try(GetNumSkillLines) or 0) do
    local name, header, _, rank = ns.try(GetSkillLineInfo, i)
    if name and not header and type(rank) == "number" then
      if string.find(string.lower(name), "riding", 1, true) and once("riding") then
        if C.say(string.format("%s learned to ride!", me())) then said = said + 1 end
      end
      for _, step in ipairs(C.PROF_STEPS) do
        if rank >= step and C.isProfession(name) and once("prof" .. name .. step) then
          if rank < step + 25 and C.say(string.format("%s reached %d in %s!", me(), step, name)) then said = said + 1 end
        end
      end
    end
  end
  return said
end

function C.pvpRank()
  local get = UnitPVPRank
  if not get then return nil end
  local rank = ns.try(get, "player")
  if type(rank) ~= "number" or rank < 5 then return nil end -- ranks start at 5 (Private/Scout)
  local name = GetPVPRankInfo and ns.try(GetPVPRankInfo, rank) or ("rank " .. (rank - 4))
  if not once("pvprank" .. rank) then return nil end
  return C.say(string.format("%s reached PvP rank %s!", me(), name))
end

-- ---------- guildmates' moments, from guild chat ----------
-- → { what, from } for a Guild Camp line, or nil.
function C.parse(text)
  if type(text) ~= "string" then return nil end
  local ok, what, from = pcall(string.match, text, "^%[Guild Camp%] (.-) — from (%S+)%s*$")
  if not ok or not what then return nil end
  return { what = what, from = from }
end

function C.heard(text, sender)
  local p = C.parse(text)
  if not p or ns.opt("celebrate") == false then return nil end
  local who, lvl = string.match(p.what, "^(%S+) reached level (%d+)!$")
  lvl = tonumber(lvl)
  if who and lvl then
    if who == me() then return "mine" end
    if lvl == C.MAX_LEVEL then C.banner(who, false) else C.toast(string.format("%s reached level %d!", who, lvl), nil, nil, 10) end
    return "level"
  end
  return "other"
end

-- ---------- welcome wagon ----------
-- A guild buddy for a newcomer: the online guildmate closest in level (not me, not them).
-- A guildmate's level from the roster, or nil (a newcomer may not be in it yet).
function C.levelOf(name)
  if not GetNumGuildMembers or not GetGuildRosterInfo then return nil end
  for i = 1, (ns.try(GetNumGuildMembers) or 0) do
    local n, _, _, lvl = ns.try(GetGuildRosterInfo, i)
    if n and (string.match(n, "^([^%-]+)") or n) == name and type(lvl) == "number" then return lvl end
  end
end

function C.buddy(newcomer, level)
  if not GetNumGuildMembers or not GetGuildRosterInfo then return nil end
  local best, bestGap
  for i = 1, (ns.try(GetNumGuildMembers) or 0) do
    local name, _, _, lvl, _, _, _, _, online = ns.try(GetGuildRosterInfo, i)
    name = name and string.match(name, "^([^%-]+)") or name
    if name and online and name ~= newcomer and name ~= me() and type(lvl) == "number" then
      local gap = math.abs(lvl - (level or lvl))
      if not bestGap or gap < bestGap then best, bestGap = name, gap end
    end
  end
  return best
end

function C.welcomeKit(newcomer)
  local whisper = (C_ChatInfo and C_ChatInfo.SendChatMessage) or SendChatMessage
  local buddy = C.buddy(newcomer, C.levelOf(newcomer))
  local lines = {
    string.format("Welcome to the guild, %s! Type /wow for the guild window: calls to arms, raids, crafters and more.", newcomer),
    "Ask an officer if you'd like a hand finding your feet. Good to have you!",
  }
  if buddy then lines[#lines + 1] = string.format("Your guild buddy this week is %s: ask them anything.", buddy) end
  if whisper then for _, l in ipairs(lines) do pcall(whisper, l, "WHISPER", nil, newcomer) end end
  return C.say(string.format("Welcome to the guild, %s!%s", newcomer, buddy and (" Your buddy is " .. buddy .. ".") or "")), buddy
end

function C.joined(name)
  if not name or name == me() or ns.opt("celebrate") == false then return nil end
  local officer = C.isOfficer()
  C.toast(string.format("%s joined the guild!", name),
    { "Say welcome", function()
      local send = (C_ChatInfo and C_ChatInfo.SendChatMessage) or SendChatMessage
      if send then pcall(send, string.format("Welcome to the guild, %s!", name), "GUILD") end
    end },
    officer and { "Welcome kit", function() C.welcomeKit(name) end } or nil, 60)
  return officer and "officer" or "member"
end

-- "Grom has joined the guild." (ERR_GUILD_JOIN_S)
function C.system(msg)
  if type(msg) ~= "string" then return nil end
  local pattern = ERR_GUILD_JOIN_S and string.gsub(ERR_GUILD_JOIN_S, "%%s", "(.+)") or "(.+) has joined the guild%."
  local ok, name = pcall(string.match, msg, "^" .. pattern .. "$")
  if ok and name then return C.joined(name) end
end

ns.on("PLAYER_LEVEL_UP", function(level) ns.safely(C.leveled, level) end)
ns.on("CHAT_MSG_LOOT", function(msg) ns.safely(C.looted, msg) end)
ns.on("SKILL_LINES_CHANGED", function() ns.safely(C.skills) end)
ns.on("PLAYER_PVP_RANK_CHANGED", function() ns.safely(C.pvpRank) end)
ns.on("CHAT_MSG_GUILD", function(text, sender) ns.safely(C.heard, text, sender) end)
ns.on("CHAT_MSG_SYSTEM", function(msg) ns.safely(C.system, msg) end)
-- Already celebrated skills shouldn't fire on the first look after installing: remember them quietly.
ns.on("PLAYER_LOGIN", function()
  ns.db.celebrated = ns.db.celebrated or {}
  if not ns.db.celebrated[me()] then
    ns.db.celebrated[me()] = { _quiet = true }
    local say = C.say
    C.say = function() return nil end
    ns.safely(C.skills); ns.safely(C.pvpRank)
    C.say = say
  end
end)

-- Today's anniversaries in the guild (the app's inbox: WowGuildInbox.today), once at login.
function C.today()
  local t = WowGuildInbox and WowGuildInbox.today
  if type(t) ~= "table" or type(t.lines) ~= "table" or #t.lines == 0 or ns.opt("celebrate") == false then return nil end
  local date = (date and ns.try(date, "!%Y-%m-%d")) or t.date
  if t.date ~= date then return nil end
  ns.db.todaySeen = ns.db.todaySeen or {}
  if ns.db.todaySeen[t.date] then return nil end
  ns.db.todaySeen[t.date] = true
  C.toast("Today in the guild:\n" .. table.concat(t.lines, "\n"), nil, nil, 25)
  for _, l in ipairs(t.lines) do ns.print(l) end
  return #t.lines
end
ns.on("PLAYER_ENTERING_WORLD", function() ns.safely(C.today); ns.safely(C.flush) end)
