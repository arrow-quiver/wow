-- Guild Camp: a short welcome the first time you log in, and "what's new" after an update.
local ADDON, ns = ...
local S = ns.skin
local WEL = {}
ns.welcome = WEL

-- Shown once after updating to a version listed here.
WEL.NEWS = {
  ["0.10.0"] = {
    "A new dark-and-gold look for every window. Prefer Blizzard's style? It's in the options.",
    "The Coach: your play style, a build plan from Claude, next steps, and questions (/wow coach).",
    "The Guild Camp app can install and update this addon for you.",
  },
  ["0.21.0"] = {
    "One window for everything: sections down the left, their pages along the top. /wow opens it.",
    "War: a live guild map (turn on Share my position), who's coming to a call to arms, and a nemesis list.",
    "Camp: the season leaderboard, guild goals with \"I gave\", and a getting-started list for new members.",
    "Raids & Dungeons: join dungeon groups by role, and PvP premades for 10 or 15 with a win tally.",
    "Item tooltips now say when the guild is short of something you're holding.",
  },
}

local function ago(t)
  if not t then return "never" end
  local d = (ns.now() - t)
  if d < 3600 then return math.max(1, math.floor(d / 60)) .. " min ago" end
  if d < 86400 then return math.floor(d / 3600) .. " h ago" end
  return math.floor(d / 86400) .. " days ago"
end

local win
local function create()
  local f = CreateFrame("Frame", "WowGuildWelcome", UIParent)
  f:SetSize(470, 360); f:SetPoint("CENTER", 0, 60); f:SetFrameStrata("DIALOG")
  f:SetMovable(true); f:EnableMouse(true); f:RegisterForDrag("LeftButton"); f:SetClampedToScreen(true)
  f:SetScript("OnDragStart", f.StartMoving); f:SetScript("OnDragStop", f.StopMovingOrSizing)
  tinsert(UISpecialFrames, "WowGuildWelcome")
  S.window(f)
  local close = CreateFrame("Button", nil, f, "UIPanelCloseButton"); close:SetPoint("TOPRIGHT", -4, -4)
  f.caps = S.text(f, "small", "", S.GOLD); f.caps:SetPoint("TOP", 0, -18)
  f.title = S.text(f, "title", "", { 0.91, 0.83, 0.67 }); f.title:SetPoint("TOP", 0, -32)
  S.rule(f, -64, 40)
  f.rows = {}
  for i = 1, 3 do
    local r = CreateFrame("Frame", nil, f)
    r:SetPoint("TOPLEFT", 22, -78 - (i - 1) * 80); r:SetSize(426, 74)
    r.icon = r:CreateTexture(nil, "ARTWORK"); r.icon:SetSize(34, 34); r.icon:SetPoint("TOPLEFT", 0, -2)
    if r.icon.SetTexCoord then r.icon:SetTexCoord(0.08, 0.92, 0.08, 0.92) end
    r.head = S.text(r, "heading", "", S.GOLD); r.head:SetPoint("TOPLEFT", 46, 0)
    r.body = S.text(r, "small", "", { 0.86, 0.84, 0.8 }); r.body:SetPoint("TOPLEFT", 46, -20); r.body:SetWidth(270)
    if r.body.SetWordWrap then r.body:SetWordWrap(true) end
    r.btn = CreateFrame("Button", nil, r, "UIPanelButtonTemplate"); r.btn:SetSize(104, 22); r.btn:SetPoint("TOPRIGHT", 0, -6)
    f.rows[i] = r
  end
  f.news = S.text(f, "body", "", { 0.9, 0.88, 0.84 }); f.news:SetPoint("TOPLEFT", 26, -80); f.news:SetWidth(418)
  if f.news.SetWordWrap then f.news:SetWordWrap(true) end
  f.done = CreateFrame("Button", nil, f, "UIPanelButtonTemplate"); f.done:SetSize(140, 26); f.done:SetPoint("BOTTOM", 0, 16)
  f.done:SetText("Got it"); f.done:SetScript("OnClick", function() f:Hide() end)
  f:Hide()
  return f
end

function WEL.window() win = win or create(); return win end

local function row(r, icon, head, body, btnText, onClick)
  r.icon:SetTexture(icon); r.head:SetText(head); r.body:SetText(body)
  if btnText then r.btn:SetText(btnText); r.btn:SetScript("OnClick", onClick); r.btn:Show() else r.btn:Hide() end
  r:Show()
end

function WEL.showWelcome()
  local f = WEL.window()
  f.caps:SetText("WELCOME TO")
  f.title:SetText((WowGuildInbox and WowGuildInbox.guild) or "the guild")
  f.news:Hide()
  row(f.rows[1], "Interface\\Icons\\INV_Misc_Bag_10_Green", "Your guild window",
    "Who's online, calls to arms, professions and guild news. Minimap button or /wow.", "Open", function() f:Hide(); ns.ui.show("camp") end)
  row(f.rows[2], "Interface\\Icons\\INV_Misc_Book_11", "Meet the Coach",
    "Tell it how you play. It plans your talents and gear and tells you what to do next.", "Take the quiz", function() f:Hide(); ns.coachUI.show(); ns.coachUI.showQuiz() end)
  local inbox = WowGuildInbox
  if inbox and inbox.generatedAt then
    row(f.rows[3], "Interface\\RaidFrame\\ReadyCheck-Ready", "Connected to Guild Camp",
      "Your guild sees your characters, and the Coach can answer you. Last update " .. ago(inbox.generatedAt) .. ".")
  else
    row(f.rows[3], "Interface\\Icons\\INV_Misc_Note_02", "Get the Guild Camp app",
      "The desktop app syncs your progress with the guild and brings back guild news.", "How?", function() f:Hide(); ns.ui.show("settings") end)
  end
  f.done:SetText("Let's go")
  f:Show()
end

function WEL.showNews(version, lines)
  local f = WEL.window()
  f.caps:SetText("WHAT'S NEW")
  f.title:SetText("Guild Camp " .. version)
  for _, r in ipairs(f.rows) do r:Hide() end
  local t = {}
  for _, l in ipairs(lines) do t[#t + 1] = "|cffe8a33d-|r  " .. l end
  f.news:SetText(table.concat(t, "\n\n")); f.news:Show()
  f.done:SetText("Got it")
  f:Show()
end

-- First login: welcome. After an update with news: what's new. Never both, never twice.
function WEL.check()
  local db = ns.db
  if not db then return end
  local v = ns.addonVersion()
  if not db.welcomeSeen then
    db.welcomeSeen = v; db.newsSeen = v
    WEL.showWelcome()
    return
  end
  if db.newsSeen ~= v and WEL.NEWS[v] then
    db.newsSeen = v
    WEL.showNews(v, WEL.NEWS[v])
  end
  db.newsSeen = v
end

ns.on("PLAYER_LOGIN", function()
  if C_Timer and C_Timer.After then C_Timer.After(4, function() pcall(WEL.check) end) else WEL.check() end
end)
