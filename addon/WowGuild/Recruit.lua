-- Guild Camp: the recruiting desk (/wow recruit). Within Blizzard's rules: every /who search, message, invite and
-- channel post is one click of yours (the game requires a click for /who, invites and channel posts, and
-- unrequested whispers in bulk get reported as spam), so nothing here runs on its own.
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
R.AD_EVERY = 15 * 60
R.KEEP = 3 * 86400
R.MAX_QUEUE = 100
R.ROWS = 8
R.DEFAULTS = {
  ad = "wow is recruiting! A friendly Horde PvP guild: war parties, raids, a guild bank and a desktop app that helps you level. All levels welcome. /w me",
  msg = "Hey {name}! I saw you're not in a guild. We're a friendly Horde PvP guild with raids, war parties and a guild bank. Want an invite?",
  classes = "", minLevel = 10, maxLevel = 60,
}
local YES = { "yes", "yeah", "yea", "yep", "sure", "ok", "okay", "keen", "please", "pls", "inv", "invite", "y", "ye", "why not" }
local NO = { "no", "nah", "nope", "no thanks", "not interested", "no ty", "pass" }
local GOLD, GREY = "|cffe8a33d", "|cff9e9ea8"

local function now() return (GetServerTime and ns.try(GetServerTime)) or time() end
local function me() return UnitName and UnitName("player") or "?" end
local function short(n) return type(n) == "string" and (string.match(n, "^([^%-]+)") or n) or nil end
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

function R.nextQuery()
  local b = R.brackets()
  if #b == 0 then return nil end
  local d = store()
  local i = (d.bracket % #b) + 1
  return string.format("%d-%d", b[i][1], b[i][2]), i
end

R.pending = false
function R.scan()
  local q, i = R.nextQuery()
  if not q then return nil end
  local send = (C_FriendList and C_FriendList.SendWho) or SendWho
  if not send then ns.print("/who isn't available here."); return nil end
  R.pending = true
  store().bracket = i
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
  R.prune()
  ns.print(string.format("%sRecruiting:|r %d new player%s without a guild. /wow recruit", GOLD, added, added == 1 and "" or "s"))
  if R.panel and R.panel:IsShown() then R.refresh() end
  return added
end

function R.prune()
  local d, known, list = store(), R.known(), {}
  for name, p in pairs(d.queue) do
    if now() - (p.seen or 0) > R.KEEP or known[string.lower(name)] then d.queue[name] = nil else list[#list + 1] = p end
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

-- Opens the chat box with the message (you press Enter), and tells the guild you're in touch.
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
  local text = R.messageFor(p)
  if ChatFrame_OpenChat then ns.try(ChatFrame_OpenChat, "/w " .. p.name .. " " .. text) else ns.print("/w " .. p.name .. " " .. text) end
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
  if not k or k.state ~= "c" then return nil end
  local state = said(text, NO) and "n" or said(text, YES) and "i" or nil
  if not state then return nil end
  local f = {}
  for key, v in pairs(k.fields) do f[key] = v end
  f.state = state; f.at = now()
  if not put(k.name, f) then return nil end
  if state == "i" then
    ns.print(string.format("%s%s wants in!|r %s", GOLD, k.name, R.isOfficer() and "/wow recruit → Invite." or "Your officers can invite them now (/wow recruit)."))
    if ns.notice then ns.notice(k.name .. " wants to join the guild!", 6) end
  end
  return state
end

-- Interested recruits, for officers to invite.
function R.interested()
  local out = {}
  for _, k in pairs(R.known()) do if k.state == "i" then out[#out + 1] = k end end
  table.sort(out, function(a, b) return (a.fields.at or 0) > (b.fields.at or 0) end)
  return out
end

function R.invite(name)
  local inv = (C_GuildInfo and C_GuildInfo.Invite) or GuildInvite
  if not inv or not R.isOfficer() then ns.print("Only officers (or anyone with invite rights) can invite."); return false end
  ns.try(inv, name)
  ns.print("Guild invite sent to " .. name .. ".")
  return true
end

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
  f:SetSize(420, 150 + R.ROWS * 26); f:SetPoint("CENTER", 0, 40); f:SetFrameStrata("HIGH")
  f:SetMovable(true); f:EnableMouse(true); f:RegisterForDrag("LeftButton")
  f:SetScript("OnDragStart", f.StartMoving); f:SetScript("OnDragStop", f.StopMovingOrSizing)
  S.panel(f)
  f.title = S.text(f, "heading", "Recruiting", S.GOLD); f.title:SetPoint("TOPLEFT", 12, -10)
  f.sub = S.text(f, "small", "", S.GREY); f.sub:SetPoint("TOPLEFT", 12, -30); f.sub:SetWidth(396)
  f.scan = CreateFrame("Button", nil, f, "UIPanelButtonTemplate"); f.scan:SetSize(170, 22); f.scan:SetPoint("TOPLEFT", 12, -50)
  f.scan:SetScript("OnClick", function() R.scan() end)
  f.ad = CreateFrame("Button", nil, f, "UIPanelButtonTemplate"); f.ad:SetSize(110, 22); f.ad:SetPoint("LEFT", f.scan, "RIGHT", 8, 0)
  f.ad:SetText("Post ad"); f.ad:SetScript("OnClick", function() R.postAd() end)
  f.rows = {}
  for i = 1, R.ROWS do
    local r = CreateFrame("Frame", nil, f)
    r:SetSize(396, 24); r:SetPoint("TOPLEFT", 12, -82 - (i - 1) * 26)
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
  f.scan:SetText(q and ("Scan levels " .. q .. " (/who)") or "Scan (/who)")
  local rows = {}
  if R.isOfficer() then
    for _, k in ipairs(R.interested()) do
      rows[#rows + 1] = { text = string.format("%s%s|r wants in %s(found by %s)|r", GOLD, k.name, GREY, short(k.author) or "?"), go = { "Invite", function() R.invite(k.name) end } }
    end
  end
  for _, p in ipairs(R.queue()) do
    rows[#rows + 1] = { text = string.format("%s %s%d %s · %s|r", p.name, GREY, p.level or 0, p.class or "", p.zone or ""), go = { "Message", function() R.message(p.name) end }, skip = p.name }
  end
  f.sub:SetText(#rows > 0 and "Players without a guild nobody here has been in touch with. You press Enter to send." or "Scan to find players without a guild.")
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
  if cmd == "scan" then return R.scan() elseif cmd == "ad" then return R.postAd() end
  return R.show()
end

-- An interested recruit arrives from someone else's addon: officers hear about it.
local told = {}
function R.arrived(rec, how)
  if type(rec) ~= "table" or rec.type ~= "rk" or how == "s" or type(rec.fields) ~= "table" then return nil end
  if rec.fields.state ~= "i" or told[rec.key] or not R.isOfficer() or rec.author == me() then return nil end
  told[rec.key] = true
  local line = string.format("%s%s wants to join the guild|r (found by %s). /wow recruit → Invite.", GOLD, rec.key, short(rec.author) or "?")
  ns.print(line)
  return line
end

ns.on("WHO_LIST_UPDATE", function() ns.safely(R.results) end)
ns.on("CHAT_MSG_WHISPER", function(text, sender) ns.safely(R.whisper, text, sender) end)
ns.on("CHAT_MSG_SYSTEM", function(msg) ns.safely(R.joinedLine, msg) end)
ns.on("ADDON_LOADED", function(name)
  if name ~= ADDON then return end
  local s = ns.Share
  if type(s) == "table" and type(s.onRecord) == "function" then s.onRecord(R.arrived) end
end)
