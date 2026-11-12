-- Guild Camp: the recruiting desk (/wow recruit). Within Blizzard's rules: every /who search, message and channel
-- post is one click or key press of yours (the game requires one for /who and channel posts, and unrequested
-- whispers in bulk get reported as spam), so nothing here runs on its own.
--   * One key does the next thing (R.next, the "Recruit: next step" key binding): show who wants in, else message
--     the best player in the queue, else run the next /who. Press it again for the one after.
--   * WoW Forever doesn't let addons send guild invites. There, "wants in" is a line in chat with the player's
--     name as a link: right-click it and choose Invite to guild (Blizzard's own menu). Elsewhere the Invite button
--     asks the game directly, and falls back to the link if the game refuses.
--   * Scan: each click runs the next /who search (a level bracket in the officers' range) and keeps players with no
--     guild that nobody in the guild has been in touch with ("rk" records, shared: the do-not-contact list).
--   * The queue: classes the guild wants first, then by level. "Message" opens your chat box with the officers'
--     message filled in; you press Enter. At most DAILY a day.
--   * Their answer: a "yes" whisper marks them interested and tells online officers, who invite with one click;
--     a "no" marks them no thanks. Joining marks them joined, and the recruiter's season points follow a week later.
--   * Post ad: the officers' ad to the LookingForGroup channel (else General), at most every 15 minutes.
local ADDON, ns = ...
local R = {}
ns.recruit = R

R.DAILY = 30
R.WHO_GAP = 8        -- seconds between /who searches (the server ignores faster ones)
R.MSG_GAP = 3        -- seconds between messages
R.SHOW_AGAIN = 120   -- seconds before "wants in" is shown again for the same player
R.WHO_CAP = 50       -- /who returns at most this many: a full list is searched again class by class
R.CLASSES = { "Warrior", "Paladin", "Hunter", "Rogue", "Priest", "Shaman", "Mage", "Warlock", "Druid" }
R.AD_EVERY = 15 * 60
R.KEEP = 3 * 86400
R.MAX_QUEUE = 100
R.ROWS = 8
R.DEFAULTS = {
  ad = "wow is recruiting! A friendly Horde PvP guild: war parties, raids and a guild bank. All levels welcome. /w me",
  msg = "Hey {name}! I saw you're not in a guild. We're a friendly Horde PvP guild with raids, war parties and a guild bank. Want an invite?",
  classes = "", minLevel = 10, maxLevel = 60,
}
local YES = { "yes", "yeah", "yea", "yep", "sure", "ok", "okay", "keen", "please", "pls", "inv", "invite", "y", "ye", "why not", "sounds good", "im in", "i m in", "down", "go on" }
-- Someone we never messaged asking to join (they saw the ad): "guild" with one of these, e.g. "can I join your guild?".
local ASK = { "join", "inv", "invite", "ginvite", "recruiting", "apply", "spot", "room" }
local NO = { "no", "nah", "nope", "no thanks", "not interested", "no ty", "pass" }
local GOLD, GREY = "|cffe8a33d", "|cff9e9ea8"

local function now() return (GetServerTime and ns.try(GetServerTime)) or time() end
local function me() return UnitName and UnitName("player") or "?" end
local function short(n) return type(n) == "string" and (string.match(n, "^([^%-%s]+)") or n) or nil end
local function sh() local s = ns.Share; if type(s) == "table" and type(s.list) == "function" then return s end end
local function store()
  ns.db.recruit = ns.db.recruit or {}
  local d = ns.db.recruit
  d.queue = d.queue or {}; d.skip = d.skip or {}; d.sent = d.sent or {}; d.bracket = d.bracket or 0
  return d
end
local function today() return math.floor(now() / 86400) end

function R.isOfficer()
  if C_GuildInfo and C_GuildInfo.CanEditOfficerNote and ns.try(C_GuildInfo.CanEditOfficerNote) then return true end
  if CanGuildInvite and ns.try(CanGuildInvite) then return true end
  return false
end

-- The officers' settings ("RA"), or the defaults.
function R.settings()
  local s = sh()
  local rec = s and type(s.get) == "function" and s.get("RA:1")
  local f = type(rec) == "table" and rec.fields or {}
  local out = {}
  for k, v in pairs(R.DEFAULTS) do out[k] = (f[k] ~= nil and f[k] ~= "") and f[k] or v end
  out.wanted = {}
  for c in string.gmatch(out.classes or "", "[^,]+") do out.wanted[string.upper(c)] = true end
  return out
end

-- Recruits the guild knows: { [lower name] = { name, state, pid, fields } }.
function R.known()
  local s, out = sh(), {}
  if not s then return out end
  for _, r in ipairs(s.list("rk")) do
    if r.key then out[string.lower(r.key)] = { name = r.key, state = r.fields and r.fields.state, pid = r.fields and r.fields.pid, fields = r.fields or {}, author = r.author } end
  end
  return out
end

-- ---------- scanning ----------
function R.brackets()
  local s = R.settings()
  local lo, hi = math.max(1, s.minLevel or 10), math.min(60, s.maxLevel or 60)
  local out = {}
  local a = lo
  while a <= hi do out[#out + 1] = { a, math.min(hi, a + 4) }; a = a + 5 end
  return out
end

-- The next /who search: a level bracket, or one class of a bracket whose last search came back full.
-- → query, bracket index, class index (nil for a whole bracket).
function R.nextQuery()
  local b = R.brackets()
  if #b == 0 then return nil end
  local d = store()
  local sp = d.split
  if type(sp) == "table" and b[sp.bracket] and R.CLASSES[sp.class] then
    return string.format('%d-%d c-"%s"', b[sp.bracket][1], b[sp.bracket][2], R.CLASSES[sp.class]), sp.bracket, sp.class
  end
  local i = (d.bracket % #b) + 1
  return string.format("%d-%d", b[i][1], b[i][2]), i
end

R.pending = false
function R.whoWait()
  local d = store()
  return math.max(0, R.WHO_GAP - (now() - (d.whoAt or 0)))
end
function R.scan()
  local q, i, class = R.nextQuery()
  if not q then return nil end
  local send = (C_FriendList and C_FriendList.SendWho) or SendWho
  if not send then ns.print("/who isn't available here."); return nil end
  local d = store()
  R.pending = true
  d.whoAt = now()
  if class then
    -- One class of a full bracket; after the last class, on to the next bracket.
    d.split.class = class + 1
    if not R.CLASSES[d.split.class] then d.split = nil end
  else
    d.bracket = i
    R.lastBracket = i
  end
  ns.try(send, q)
  ns.print(string.format("%sRecruiting:|r searching /who %s…", GOLD, q))
  return q
end

local function whoInfo(i)
  if C_FriendList and C_FriendList.GetWhoInfo then
    local w = ns.try(C_FriendList.GetWhoInfo, i)
    if type(w) == "table" then return w.fullName, w.fullGuildName, w.level, w.classStr, w.area, w.filename end
  end
  if GetWhoInfo then
    local name, guild, level, _, class, zone, file = ns.try(GetWhoInfo, i)
    return name, guild, level, class, zone, file
  end
end

-- After our search: unguilded players we haven't been in touch with go in the queue. → how many new.
function R.results()
  if not R.pending then return nil end
  R.pending = false
  local n = (C_FriendList and C_FriendList.GetNumWhoResults and ns.try(C_FriendList.GetNumWhoResults)) or (GetNumWhoResults and ns.try(GetNumWhoResults)) or 0
  local d, known, added = store(), R.known(), 0
  for i = 1, math.min(n or 0, 50) do
    local name, guild, level, class, zone, file = whoInfo(i)
    name = short(name)
    if name and name ~= me() and (guild == nil or guild == "") and not known[string.lower(name)] and not d.skip[string.lower(name)] then
      if not d.queue[name] then added = added + 1 end
      d.queue[name] = { name = name, level = level or 0, class = class, file = file and string.upper(file) or nil, zone = zone, seen = now() }
    end
  end
  -- A full list means there were more than /who shows: search that bracket again one class at a time.
  if (n or 0) >= R.WHO_CAP and not d.split and R.lastBracket then d.split = { bracket = R.lastBracket, class = 1 } end
  R.lastBracket = nil
  R.prune()
  ns.print(string.format("%sRecruiting:|r %d new player%s without a guild.%s", GOLD, added, added == 1 and "" or "s",
    d.split and d.split.class == 1 and " That level range is busy: the next searches go class by class." or ""))
  if R.panel and R.panel:IsShown() then R.refresh() end
  return added
end

function R.prune()
  local d, known, list = store(), R.known(), {}
  for name, p in pairs(d.queue) do
    -- Names saved with a surname (0.18.0) aren't whisperable: the first word is the character.
    if now() - (p.seen or 0) > R.KEEP or known[string.lower(name)] or string.find(name, "%s") then d.queue[name] = nil else list[#list + 1] = p end
  end
  if #list > R.MAX_QUEUE then
    table.sort(list, function(a, b) return (a.seen or 0) > (b.seen or 0) end)
    for i = R.MAX_QUEUE + 1, #list do d.queue[list[i].name] = nil end
  end
  for k, t in pairs(d.sent) do if k < today() - 7 then d.sent[k] = nil end end
end

-- The queue, best first: classes the guild wants, in the level range, then by level.
function R.queue()
  local s, list = R.settings(), {}
  for _, p in pairs(store().queue) do
    local score = 0
    if p.file and s.wanted[p.file] then score = score + 2 end
    if (p.level or 0) >= (s.minLevel or 1) and (p.level or 0) <= (s.maxLevel or 60) then score = score + 1 end
    p.score = score
    list[#list + 1] = p
  end
  table.sort(list, function(a, b)
    if a.score ~= b.score then return a.score > b.score end
    if (a.level or 0) ~= (b.level or 0) then return (a.level or 0) > (b.level or 0) end
    return a.name < b.name
  end)
  return list
end

-- ---------- getting in touch ----------
function R.sentToday() return store().sent[today()] or 0 end

function R.messageFor(p)
  local m = R.settings().msg or R.DEFAULTS.msg
  return (string.gsub(m, "{name}", p.name))
end

local function put(name, fields)
  local s = sh()
  if not s or type(s.putLocal) ~= "function" then return false end
  local called, res = pcall(s.putLocal, "rk", name, fields)
  return called and res ~= nil and res ~= false
end

-- Sends the message (one whisper, on your click or key press) and tells the guild you're in touch. When the game
-- won't take the whisper, the chat box opens with it filled in instead.
function R.message(name)
  local d = store()
  local p = d.queue[name]
  if not p then return false end
  if R.sentToday() >= R.DAILY then ns.print(string.format("That's %d messages today: more gets reported as spam. Try again tomorrow.", R.DAILY)); return false end
  local s = sh()
  local pid = s and s.myPid and ns.try(s.myPid)
  if not pid then ns.print("Guild sharing isn't ready yet: try again in a minute."); return false end
  if not put(p.name, { pid = pid, level = p.level or 0, class = p.file or "", zone = string.sub(p.zone or "", 1, 60), state = "c", at = now() }) then
    ns.print("Couldn't note that for the guild. Try again in a minute."); return false
  end
  d.sent[today()] = R.sentToday() + 1
  d.queue[p.name] = nil
  d.msgAt = now()
  local text = R.messageFor(p)
  local send = (C_ChatInfo and C_ChatInfo.SendChatMessage) or SendChatMessage
  if send and pcall(send, text, "WHISPER", nil, p.name) then
    ns.print(string.format("%sRecruiting:|r messaged %s (%d of %d today).", GOLD, p.name, R.sentToday(), R.DAILY))
  elseif ChatFrame_OpenChat then ns.try(ChatFrame_OpenChat, "/w " .. p.name .. " " .. text)
  else ns.print("/w " .. p.name .. " " .. text) end
  if R.panel and R.panel:IsShown() then R.refresh() end
  return true
end

function R.skip(name)
  local d = store()
  d.skip[string.lower(name)] = true
  d.queue[name] = nil
  if R.panel and R.panel:IsShown() then R.refresh() end
end

local function said(text, words)
  local t = " " .. string.lower(string.gsub(text or "", "[%p]", " ")) .. " "
  for _, w in ipairs(words) do if string.find(t, " " .. w .. " ", 1, true) then return true end end
  return false
end

-- Their whisper back. → "i" (interested), "n" (no thanks) or nil.
function R.whisper(text, sender)
  local name = short(sender)
  local k = name and R.known()[string.lower(name)]
  if name and not k then return R.asked(text, name) end
  if not k or k.state ~= "c" then return nil end
  local state = said(text, NO) and "n" or said(text, YES) and "i" or nil
  if not state then return nil end
  local f = {}
  for key, v in pairs(k.fields) do f[key] = v end
  f.state = state; f.at = now()
  if not put(k.name, f) then return nil end
  if state == "i" then R.wantsIn(k.name) end
  return state
end

-- "<name> wants in": for someone who can invite, the line with the name to right-click; otherwise a heads-up.
function R.wantsIn(name)
  if R.isOfficer() then R.inviteLine(name)
  else ns.print(string.format("%s%s wants in!|r Your officers can invite them now (/wow recruit).", GOLD, name)) end
  if ns.notice then ns.notice(name .. " wants to join the guild!", 6) end
end

-- Is this name in my guild already? (The roster the game has; a miss just means we treat them as a stranger.)
local function inGuild(name)
  local n = (GetNumGuildMembers and ns.try(GetNumGuildMembers)) or 0
  for i = 1, math.min(n or 0, 1000) do
    local full = GetGuildRosterInfo and ns.try(GetGuildRosterInfo, i)
    if short(full) == name then return true end
  end
  return false
end

-- A whisper from someone we never messaged, asking to join (they saw the ad or heard of us): "guild" plus a word
-- like join or invite. They go on the guild's list as interested. → "i" or nil.
R.ASKS_AN_HOUR = 5   -- how many strangers' asks one client records in an hour (the records are shared with the guild)
function R.asked(text, name)
  if type(name) ~= "string" or string.find(name, "[%s|]") or name == me() then return nil end
  local d = store()
  d.asks = d.asks or {}
  for i = #d.asks, 1, -1 do if now() - d.asks[i] >= 3600 then table.remove(d.asks, i) end end
  if #d.asks >= R.ASKS_AN_HOUR then return nil end
  local t = " " .. string.lower(string.gsub(text or "", "[%p]", " ")) .. " "
  if not string.find(t, " guild ", 1, true) or not said(text, ASK) or said(text, NO) then return nil end
  if inGuild(name) then return nil end
  local s = sh()
  local pid = s and s.myPid and ns.try(s.myPid)
  if not pid or not put(name, { pid = pid, level = 0, class = "", zone = "", state = "i", at = now() }) then return nil end
  d.queue[name] = nil
  d.asks[#d.asks + 1] = now()
  R.wantsIn(name)
  if R.panel and R.panel:IsShown() then R.refresh() end
  return "i"
end

-- Interested recruits, for officers to invite.
function R.interested()
  local out = {}
  for _, k in pairs(R.known()) do if k.state == "i" then out[#out + 1] = k end end
  table.sort(out, function(a, b) return (a.fields.at or 0) > (b.fields.at or 0) end)
  return out
end

-- WoW Forever doesn't let addons send guild invites; the player has to use the game's own menu.
function R.onForever()
  local forever = WOW_PROJECT_CAMELOT or 18
  return WOW_PROJECT_ID == forever
end
function R.canInviteByAddon() return not R.onForever() and not store().inviteBlocked end

-- The line an officer invites from: the name is a player link, so right-click → Invite to guild works on it.
function R.inviteLine(name)
  local line = string.format("%s|Hplayer:%s|h[%s]|h wants to join the guild.|r Right-click the name and choose Invite to guild.", GOLD, name, name)
  ns.print(line)
  store().shown = store().shown or {}
  store().shown[name] = now()
  return line
end

-- → "asked" (the game took the request), "link" (the line to invite from is in chat), or false.
function R.invite(name)
  if not R.isOfficer() then ns.print("Only officers (or anyone with invite rights) can invite."); return false end
  -- Noted on every path, so the one-key flow moves on to the next player while this one makes up their mind.
  store().shown = store().shown or {}
  store().shown[name] = now()
  local inv = (C_GuildInfo and C_GuildInfo.Invite) or GuildInvite
  if not inv or not R.canInviteByAddon() then R.inviteLine(name); return "link" end
  R.inviting = name
  if not pcall(inv, name) then store().inviteBlocked = true; R.inviting = nil; R.inviteLine(name); return "link" end
  ns.print(string.format("Asked the game to invite %s. You'll see them join in guild chat.", name))
  return "asked"
end

-- The game refused an invite from the addon: remember that, and give the link instead.
function R.blocked(addon, what)
  if addon ~= ADDON or not R.inviting then return nil end
  if type(what) == "string" and not string.find(what, "Invite") then return nil end
  local name = R.inviting
  R.inviting = nil
  store().inviteBlocked = true
  ns.print("The game doesn't let addons send guild invites here. From now on you'll get the name to right-click.")
  return R.inviteLine(name)
end

-- ---------- one key: the next step ----------
-- What the next press will do: { step = "invite" | "message" | "scan" | "wait" | "done", name, query, wait, text }.
function R.peek()
  local d = store()
  d.shown = d.shown or {}
  if R.isOfficer() then
    for _, k in ipairs(R.interested()) do
      if now() - (d.shown[k.name] or 0) >= R.SHOW_AGAIN then return { step = "invite", name = k.name, text = "Show " .. k.name .. " (wants in)" } end
    end
  end
  local q = R.queue()
  if #q > 0 and R.sentToday() < R.DAILY then
    local wait = R.MSG_GAP - (now() - (d.msgAt or 0))
    if wait > 0 then return { step = "wait", wait = math.ceil(wait), text = string.format("Wait %ds", math.ceil(wait)) } end
    return { step = "message", name = q[1].name, text = string.format("Message %s (%d %s)", q[1].name, q[1].level or 0, q[1].class or "") }
  end
  local query = R.nextQuery()
  if not query then return { step = "done", text = "Nothing to do" } end
  local wait = R.whoWait()
  if wait > 0 then return { step = "wait", wait = math.ceil(wait), text = string.format("Wait %ds for /who", math.ceil(wait)) } end
  return { step = "scan", query = query, text = "Search /who " .. query }
end

-- Does the next step: one action for one click or key press. → the step that ran.
function R.next()
  local p = R.peek()
  if p.step == "invite" then R.invite(p.name)
  elseif p.step == "message" then if not R.message(p.name) then p.step = "failed" end
  elseif p.step == "scan" then R.scan()
  elseif p.step == "wait" then ns.print(string.format("%sRecruiting:|r wait %d more second%s, then press again.", GOLD, p.wait, p.wait == 1 and "" or "s"))
  else ns.print(R.sentToday() >= R.DAILY and string.format("That's %d messages today. More tomorrow.", R.DAILY) or "Nothing to do right now.") end
  if R.panel and R.panel:IsShown() then R.refresh() end
  return p.step, p
end
function WowGuild_RecruitNext() ns.safely(R.next) end

-- "Grom has joined the guild.": a recruit of ours. Only officers' addons write it, to keep the traffic down.
function R.joinedLine(msg)
  if type(msg) ~= "string" or not R.isOfficer() then return nil end
  local pattern = ERR_GUILD_JOIN_S and string.gsub(ERR_GUILD_JOIN_S, "%%s", "(.+)") or "(.+) has joined the guild%."
  local ok, name = pcall(string.match, msg, "^" .. pattern .. "$")
  name = ok and short(name)
  local k = name and R.known()[string.lower(name)]
  if not k or k.state == "j" then return nil end
  local f = {}
  for key, v in pairs(k.fields) do f[key] = v end
  f.state = "j"; f.at = now()
  return put(k.name, f) and k.name or nil
end

-- ---------- the channel ad ----------
function R.channel()
  for _, name in ipairs({ "LookingForGroup", "General" }) do
    local id = GetChannelName and ns.try(GetChannelName, name)
    if type(id) == "number" and id > 0 then return id, name end
  end
end

function R.postAd()
  local d = store()
  local wait = R.AD_EVERY - (now() - (d.adAt or 0))
  if wait > 0 then ns.print(string.format("The ad went out recently: wait %d more minute%s.", math.ceil(wait / 60), math.ceil(wait / 60) == 1 and "" or "s")); return false end
  local id, name = R.channel()
  if not id then ns.print("Join the LookingForGroup or General channel first (/join LookingForGroup)."); return false end
  local send = (C_ChatInfo and C_ChatInfo.SendChatMessage) or SendChatMessage
  if not send or not pcall(send, R.settings().ad, "CHANNEL", nil, id) then return false end
  d.adAt = now()
  ns.print(string.format("%sRecruiting ad posted in %s.|r", GOLD, name))
  return true
end

-- ---------- the panel (our own frame) ----------
local function makePanel()
  local S = ns.skin
  local f = CreateFrame("Frame", "WowGuildRecruit", UIParent)
  f:SetSize(420, 180 + R.ROWS * 26); f:SetPoint("CENTER", 0, 40); f:SetFrameStrata("HIGH")
  f:SetMovable(true); f:EnableMouse(true); f:RegisterForDrag("LeftButton")
  f:SetScript("OnDragStart", f.StartMoving); f:SetScript("OnDragStop", f.StopMovingOrSizing)
  S.panel(f)
  f.title = S.text(f, "heading", "Recruiting", S.GOLD); f.title:SetPoint("TOPLEFT", 12, -10)
  f.sub = S.text(f, "small", "", S.GREY); f.sub:SetPoint("TOPLEFT", 12, -30); f.sub:SetWidth(396)
  f.next = CreateFrame("Button", nil, f, "UIPanelButtonTemplate"); f.next:SetSize(396, 26); f.next:SetPoint("TOPLEFT", 12, -50)
  f.next:SetScript("OnClick", function() R.next() end)
  f.scan = CreateFrame("Button", nil, f, "UIPanelButtonTemplate"); f.scan:SetSize(170, 22); f.scan:SetPoint("TOPLEFT", 12, -80)
  f.scan:SetScript("OnClick", function() if R.whoWait() > 0 then R.next() else R.scan(); R.refresh() end end)
  f.ad = CreateFrame("Button", nil, f, "UIPanelButtonTemplate"); f.ad:SetSize(110, 22); f.ad:SetPoint("LEFT", f.scan, "RIGHT", 8, 0)
  f.ad:SetText("Post ad"); f.ad:SetScript("OnClick", function() R.postAd() end)
  f.rows = {}
  for i = 1, R.ROWS do
    local r = CreateFrame("Frame", nil, f)
    r:SetSize(396, 24); r:SetPoint("TOPLEFT", 12, -112 - (i - 1) * 26)
    r.name = S.text(r, "small", ""); r.name:SetPoint("LEFT", 0, 0); r.name:SetWidth(230)
    r.go = CreateFrame("Button", nil, r, "UIPanelButtonTemplate"); r.go:SetSize(80, 20); r.go:SetPoint("RIGHT", -60, 0)
    r.skip = CreateFrame("Button", nil, r, "UIPanelButtonTemplate"); r.skip:SetSize(56, 20); r.skip:SetPoint("RIGHT", 0, 0)
    r.skip:SetText("Skip")
    f.rows[i] = r
  end
  f.close = CreateFrame("Button", nil, f, "UIPanelButtonTemplate"); f.close:SetSize(70, 22); f.close:SetPoint("BOTTOMRIGHT", -12, 10)
  f.close:SetText("Close"); f.close:SetScript("OnClick", function() f:Hide() end)
  f.foot = S.text(f, "small", "", S.GREY); f.foot:SetPoint("BOTTOMLEFT", 12, 14); f.foot:SetWidth(320)
  f:Hide()
  return f
end

function R.refresh()
  local f = R.panel
  if not f then return end
  local q = R.nextQuery()
  f.scan:SetText(q and ("Scan " .. q .. " (/who)") or "Scan (/who)")
  f.next:SetText("Next step: " .. R.peek().text)
  local rows = {}
  if R.isOfficer() then
    for _, k in ipairs(R.interested()) do
      rows[#rows + 1] = { text = string.format("%s%s|r wants in %s(found by %s)|r", GOLD, k.name, GREY, short(k.author) or "?"), go = { R.canInviteByAddon() and "Invite" or "Show name", function() R.invite(k.name) end } }
    end
  end
  for _, p in ipairs(R.queue()) do
    rows[#rows + 1] = { text = string.format("%s %s%d %s · %s|r", p.name, GREY, p.level or 0, p.class or "", p.zone or ""), go = { "Message", function() R.message(p.name) end }, skip = p.name }
  end
  f.sub:SetText("One press, one step. Bind a key to \"Recruit: next step\" (Esc, Options, Keybindings, Guild Camp) and keep pressing.")
  for i, r in ipairs(f.rows) do
    local x = rows[i]
    if x then
      r.name:SetText(x.text)
      r.go:SetText(x.go[1]); r.go:SetScript("OnClick", function() ns.safely(x.go[2]) end); r.go:Show()
      if x.skip then r.skip:SetScript("OnClick", function() R.skip(x.skip) end); r.skip:Show() else r.skip:Hide() end
      r:Show()
    else r:Hide() end
  end
  f.foot:SetText(string.format("%d of %d messages today · %d in the queue", R.sentToday(), R.DAILY, #R.queue()))
end

function R.show()
  R.panel = R.panel or makePanel()
  R.prune()
  R.refresh()
  R.panel:Show()
  return R.panel
end

function R.slash(rest)
  local cmd = string.lower(string.match(rest or "", "^(%S*)") or "")
  if cmd == "scan" then return R.scan() elseif cmd == "ad" then return R.postAd() elseif cmd == "next" then return R.next() end
  return R.show()
end

-- An interested recruit arrives from someone else's addon: officers hear about it.
local told = {}
function R.arrived(rec, how)
  if type(rec) ~= "table" or rec.type ~= "rk" or how == "s" or type(rec.fields) ~= "table" then return nil end
  if rec.fields.state ~= "i" or told[rec.key] or not R.isOfficer() or rec.author == me() then return nil end
  told[rec.key] = true
  local line = R.inviteLine(rec.key)
  ns.print(string.format("%s(found by %s)|r", GREY, short(rec.author) or "?"))
  return line
end

ns.on("WHO_LIST_UPDATE", function() ns.safely(R.results) end)
ns.on("CHAT_MSG_WHISPER", function(text, sender) ns.safely(R.whisper, text, sender) end)
ns.on("CHAT_MSG_SYSTEM", function(msg) ns.safely(R.joinedLine, msg) end)
ns.on("ADDON_ACTION_FORBIDDEN", function(addon, what) ns.safely(R.blocked, addon, what) end)
ns.on("ADDON_ACTION_BLOCKED", function(addon, what) ns.safely(R.blocked, addon, what) end)
ns.on("ADDON_LOADED", function(name)
  if name ~= ADDON then return end
  local s = ns.Share
  if type(s) == "table" and type(s.onRecord) == "function" then s.onRecord(R.arrived) end
end)
