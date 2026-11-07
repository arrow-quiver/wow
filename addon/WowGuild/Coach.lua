-- Guild Camp: the Coach. Learns how you play (outside combat only), keeps your quiz answers,
-- reads talents and gear, and works out your next steps. The companion carries it to the
-- site, where Claude writes your build plan and answers questions; they come back in the inbox.
local ADDON, ns = ...
local C = {}
ns.coach = C

local function safe() return not (InCombatLockdown and InCombatLockdown()) end
local function secret(v) return issecretvalue and issecretvalue(v) end
local function clamp(v) v = math.floor((v or 0) + 0.5); if v < 0 then return 0 elseif v > 100 then return 100 end return v end

-- ---------- saved data ----------
function C.db()
  ns.db.coach = ns.db.coach or {}
  local c = ns.db.coach
  c.chars = c.chars or {}
  c.questions = c.questions or {}
  return c
end
function C.char()
  local key = ns.charKey()
  local chars = C.db().chars
  chars[key] = chars[key] or { name = key, obs = {} }
  local ch = chars[key]
  ch.obs = ch.obs or {}
  return ch
end

-- ---------- the quiz ----------
C.QUIZ = {
  { key = "aggression", q = "You spot an enemy player of your level. You...", low = "Avoid them", high = "Attack on sight" },
  { key = "risk", q = "When you pull mobs, you...", low = "Take one at a time", high = "Grab as many as I can" },
  { key = "social", q = "You'd rather play...", low = "Solo", high = "Always grouped" },
  { key = "pvp", q = "What's most fun for you?", low = "Questing and dungeons", high = "Fighting players" },
  { key = "pace", q = "How do you level?", low = "Slowly, exploring", high = "As fast as possible" },
}
C.ROLES = { "Damage", "Tank", "Healer", "Not sure" }
C.GOALS = { "Levelling", "World PvP", "Battlegrounds", "Dungeons", "Gold" }

function C.saveQuiz(answers)
  local ch = C.char()
  ch.quiz = answers
  ch.quizAt = ns.now()
  C.refresh()
end

-- ---------- what we watch ----------
-- Combat start/end and deaths are plain events. Everything else is sampled every 30 seconds,
-- and only while you're out of combat (WoW: Forever hides combat data from addons).
local fightStart
ns.on("PLAYER_REGEN_DISABLED", function()
  local o = C.char().obs
  o.pulls = (o.pulls or 0) + 1
  fightStart = GetTime and GetTime() or nil
end)
ns.on("PLAYER_REGEN_ENABLED", function()
  if fightStart and GetTime then
    local o = C.char().obs
    o.combatSec = (o.combatSec or 0) + math.min(600, GetTime() - fightStart)
  end
  fightStart = nil
end)
ns.on("PLAYER_DEAD", function()
  local o = C.char().obs
  o.deaths = (o.deaths or 0) + 1
  -- Check for hidden (secret) values before testing them: testing one is an error.
  local inPvp = UnitIsPVP and ns.try(UnitIsPVP, "player")
  if secret(inPvp) then inPvp = false end
  local _, kind = ns.try(IsInInstance)
  if secret(kind) then kind = nil end
  if inPvp or kind == "pvp" or kind == "arena" then o.pvpDeaths = (o.pvpDeaths or 0) + 1 end
end)
ns.on("QUEST_TURNED_IN", function() local o = C.char().obs; o.quests = (o.quests or 0) + 1 end)
ns.on("PLAYER_LEVEL_UP", function() local o = C.char().obs; o.levelUps = (o.levelUps or 0) + 1 end)
ns.on("TRAINER_SHOW", function() C.char().trainerLevel = UnitLevel("player") end)

-- Duels: "%1$s has defeated %2$s in a duel" (and the "fled" version).
local duelPatterns
local function toPattern(fmt)
  if type(fmt) ~= "string" then return nil end
  local p = fmt:gsub("%%%d?%$?s", "\001")
  p = p:gsub("([%(%)%.%%%+%-%*%?%[%]%^%$])", "%%%1")
  p = p:gsub("\001", "(.+)")
  return "^" .. p .. "$"
end
ns.on("CHAT_MSG_SYSTEM", function(msg)
  if type(msg) ~= "string" or secret(msg) then return end
  duelPatterns = duelPatterns or { toPattern(DUEL_WINNER_KNOCKOUT), toPattern(DUEL_WINNER_RETREAT) }
  local me = UnitName("player")
  for _, p in ipairs(duelPatterns) do
    local winner, loser = string.match(msg, p)
    if winner then
      local o = C.char().obs
      if winner == me then o.duelsWon = (o.duelsWon or 0) + 1 elseif loser == me then o.duelsLost = (o.duelsLost or 0) + 1 end
      return
    end
  end
end)

function C.sample()
  local o = C.char().obs
  o.minutes = (o.minutes or 0) + 0.5
  if not safe() then o.combatSamples = (o.combatSamples or 0) + 1; return end
  local function yes(fn, ...) local v = ns.try(fn, ...); if secret(v) then return false end return v and true or false end
  if yes(UnitIsPVP, "player") then o.flaggedMin = (o.flaggedMin or 0) + 0.5 end
  if yes(IsInGroup) or yes(IsInRaid) then o.groupMin = (o.groupMin or 0) + 0.5 end
  if yes(IsResting) then o.restMin = (o.restMin or 0) + 0.5 end
  local _, kind = ns.try(IsInInstance)
  if secret(kind) then kind = nil end
  if kind == "pvp" or kind == "arena" then o.bgMin = (o.bgMin or 0) + 0.5
  elseif kind == "party" or kind == "raid" then o.dungeonMin = (o.dungeonMin or 0) + 0.5 end
  if GetPVPLifetimeStats then
    local hk = ns.try(GetPVPLifetimeStats)
    if type(hk) == "number" and not secret(hk) then
      if not o.hkBase then o.hkBase = hk end
      o.hk = hk - o.hkBase
    end
  end
end

-- ---------- talents and gear ----------
local function firstString(...) for i = 1, select("#", ...) do local v = select(i, ...); if type(v) == "string" then return i, v end end end
function C.readTalents()
  local t = { trees = {}, picked = {} }
  if GetNumTalentTabs then
    for tab = 1, (ns.try(GetNumTalentTabs) or 0) do
      local r = { ns.try(GetTalentTabInfo, tab) }
      -- Classic layouts differ: (name, icon, points, ...) or (id, name, description, icon, points, ...).
      local i, name = firstString(unpack(r))
      local points = (i == 1) and r[3] or r[5]
      if name then t.trees[#t.trees + 1] = { name = name, points = tonumber(points) or 0 } end
      for n = 1, (ns.try(GetNumTalents, tab) or 0) do
        local x = { ns.try(GetTalentInfo, tab, n) }
        local j, tname = firstString(unpack(x))
        if tname then
          local rank, max = x[j + 4], x[j + 5]
          if tonumber(rank) and rank > 0 then t.picked[#t.picked + 1] = { name = tname, rank = rank, max = max, tree = name } end
        end
      end
    end
  end
  if #t.trees == 0 and GetSpecialization and GetSpecializationInfo then
    local spec = ns.try(GetSpecialization)
    if spec then local _, name = ns.try(GetSpecializationInfo, spec); if name then t.trees[1] = { name = name, points = 0 } end end
  end
  local unspent = (UnitCharacterPoints and ns.try(UnitCharacterPoints, "player")) or (GetUnspentTalentPoints and ns.try(GetUnspentTalentPoints))
  if type(unspent) == "number" and unspent > 0 then t.unspent = unspent end
  return t
end

C.SLOTS = { [1] = "Head", [2] = "Neck", [3] = "Shoulder", [5] = "Chest", [6] = "Waist", [7] = "Legs", [8] = "Feet", [9] = "Wrist",
  [10] = "Hands", [11] = "Finger", [12] = "Finger", [13] = "Trinket", [14] = "Trinket", [15] = "Back", [16] = "Main hand", [17] = "Off hand", [18] = "Ranged" }
function C.readGear()
  local g = { items = {} }
  local lowest
  for slot = 1, 18 do
    if C.SLOTS[slot] then
      local link = ns.try(GetInventoryItemLink, "player", slot)
      local id = link and tonumber(string.match(link, "item:(%d+)"))
      if id then
        local name, _, quality, ilvl = ns.try(GetItemInfo, link)
        g.items[#g.items + 1] = { slot = C.SLOTS[slot], id = id, name = name or string.match(link, "%[(.-)%]"), ilvl = ilvl, quality = quality }
      end
      local cur, max = ns.try(GetInventoryItemDurability, slot)
      if cur and max and max > 0 then local pct = cur / max * 100; if not lowest or pct < lowest then lowest = pct end end
    end
  end
  g.lowestDurability = lowest and math.floor(lowest) or nil
  local free = 0
  for bag = 0, 4 do
    local n = (C_Container and C_Container.GetContainerNumFreeSlots and ns.try(C_Container.GetContainerNumFreeSlots, bag))
      or (GetContainerNumFreeSlots and ns.try(GetContainerNumFreeSlots, bag))
    if type(n) == "number" then free = free + n end
  end
  g.freeSlots = free
  return g
end

-- ---------- play style ----------
C.ARCHETYPES = {
  { name = "Warmonger", blurb = "You go looking for fights and enjoy taking other players down.", test = function(s) return s.pvp >= 65 and s.aggression >= 65 end },
  { name = "Duelist", blurb = "You love PvP, but you pick your fights and win them on skill.", test = function(s) return s.pvp >= 65 end },
  { name = "Berserker", blurb = "Big pulls, fast kills, and the occasional run back from the spirit healer.", test = function(s) return s.aggression >= 65 and s.risk >= 60 end },
  { name = "Guardian", blurb = "Steady and safe: the player a group can rely on.", test = function(s) return s.risk <= 30 and s.social >= 60 end },
  { name = "Companion", blurb = "Better with friends: you spend most of your time in a group.", test = function(s) return s.social >= 65 end },
  { name = "Trailblazer", blurb = "Efficient and quick, always pushing on to the next level.", test = function(s) return s.pace >= 70 end },
  { name = "Lone Wanderer", blurb = "Calm, independent and thorough. You play at your own pace.", test = function(s) return s.aggression <= 35 and s.social <= 35 end },
  { name = "Adventurer", blurb = "A well-rounded player who enjoys a bit of everything.", test = function() return true end },
}

function C.profile(ch)
  ch = ch or C.char()
  local o, quiz = ch.obs or {}, ch.quiz
  local minutes = o.minutes or 0
  if minutes < 20 and not quiz then return nil end
  local hours = math.max(minutes, 15) / 60
  local per = function(n) return (n or 0) / hours end
  local share = function(n) return minutes > 0 and (n or 0) / minutes or 0 end
  local obs = {
    aggression = per(o.pulls) / 40 * 70 + (per(o.hk) + per((o.duelsWon or 0) + (o.duelsLost or 0))) * 6,
    risk = per(o.deaths) / 2 * 100,
    social = share(o.groupMin) * 100,
    pvp = share(o.flaggedMin) * 60 + share(o.bgMin) * 80 + per(o.hk) * 4 + per((o.duelsWon or 0) + (o.duelsLost or 0)) * 10,
    pace = share((o.combatSec or 0) / 60) * 150 + per(o.quests) * 4,
  }
  -- Your own answers count most at first; what you actually do takes over after a few hours.
  local w = quiz and math.min(0.75, minutes / 240) or 1
  local scores = {}
  for _, q in ipairs(C.QUIZ) do
    local stated = quiz and quiz[q.key] and (quiz[q.key] - 1) * 25
    scores[q.key] = clamp(stated and (w * obs[q.key] + (1 - w) * stated) or obs[q.key])
  end
  local arch
  for _, a in ipairs(C.ARCHETYPES) do if a.test(scores) then arch = a; break end end
  return { scores = scores, archetype = arch.name, blurb = arch.blurb, minutes = math.floor(minutes), quiz = quiz and true or false }
end

function C.stats(ch)
  local o = (ch or C.char()).obs or {}
  local hours = math.max(o.minutes or 0, 15) / 60
  return {
    minutes = o.minutes or 0, pullsPerHour = (o.pulls or 0) / hours, deathsPerHour = (o.deaths or 0) / hours,
    pvpDeaths = o.pvpDeaths or 0, honorKills = o.hk or 0, duelsWon = o.duelsWon or 0, duelsLost = o.duelsLost or 0,
    questsPerHour = (o.quests or 0) / hours, groupedShare = (o.groupMin or 0) / math.max(1, o.minutes or 1),
    flaggedShare = (o.flaggedMin or 0) / math.max(1, o.minutes or 1), battlegroundMinutes = o.bgMin or 0, dungeonMinutes = o.dungeonMin or 0,
  }
end

-- Refresh everything the site needs (called on login, every few minutes and at logout).
function C.refresh()
  if not ns.db or not safe() then return end
  local ch = C.char()
  local _, class = UnitClass("player")
  ch.name, ch.class, ch.level = UnitName("player"), class, UnitLevel("player")
  ch.realm = GetRealmName and ns.try(GetRealmName) or nil
  ch.talents = C.readTalents()
  ch.gear = C.readGear()
  ch.profile = C.profile(ch)
  ch.stats = C.stats(ch)
  -- Forget questions the site has answered.
  local answered = {}
  for _, a in ipairs(C.answers()) do if a.qid then answered[a.qid] = true end end
  local keep = {}
  for _, q in ipairs(C.db().questions) do if not answered[q.id] and ns.now() - (q.at or 0) < 3 * 86400 then keep[#keep + 1] = q end end
  C.db().questions = keep
end

ns.on("PLAYER_LOGIN", function()
  C.refresh()
  if C_Timer and C_Timer.NewTicker then
    C_Timer.NewTicker(30, function() local ok, err = pcall(C.sample); if not ok then ns.reportError(err) end end)
    C_Timer.NewTicker(300, function() pcall(C.refresh) end)
  end
end)
ns.on("PLAYER_LOGOUT", function() C.refresh() end)
ns.on("PLAYER_EQUIPMENT_CHANGED", function() if safe() then C.char().gear = C.readGear() end end)
ns.on("CHARACTER_POINTS_CHANGED", function() if safe() then C.char().talents = C.readTalents() end end)

-- ---------- from the site ----------
local function inbox() return (WowGuildInbox and WowGuildInbox.coach) or {} end
function C.plan() return (inbox().plans or {})[ns.charKey()] end
function C.answers() return inbox().answers or {} end
function C.aiEnabled() return inbox().enabled ~= false end

function C.requestPlan()
  C.char().planRequest = ns.now()
  ns.print("Asked the Coach for a fresh build plan. It's sent at your next /reload or logout (with the companion running).")
end

-- Ask a question: saved now, sent when the game next saves (reload or logout).
function C.ask(text)
  text = (text or ""):gsub("^%s+", ""):gsub("%s+$", "")
  if text == "" then return false end
  local q = C.db().questions
  if #q >= 5 then ns.print("You already have 5 questions waiting. Reload to send them first."); return false end
  q[#q + 1] = { id = tostring(ns.now()) .. "-" .. math.random(1000, 9999), char = ns.charKey(), text = string.sub(text, 1, 500), at = ns.now() }
  return true
end

-- Questions not answered yet, with where they are: "unsent" (needs a reload), "sent" (answer on the way).
function C.waiting()
  local out, generated = {}, (WowGuildInbox and WowGuildInbox.generatedAt) or 0
  for _, q in ipairs(C.db().questions) do
    out[#out + 1] = { text = q.text, at = q.at, state = (generated > (q.at or 0)) and "sent" or "unsent" }
  end
  return out
end

-- ---------- next steps ----------
function C.nextSteps()
  local ch, steps = C.char(), {}
  local function add(title, detail, kind) steps[#steps + 1] = { title = title, detail = detail, kind = kind or "do" } end
  local level = UnitLevel("player") or 1
  local t, g = ch.talents or {}, ch.gear or {}
  local plan = C.plan()
  if t.unspent then
    add(string.format("Spend %d talent point%s", t.unspent, t.unspent == 1 and "" or "s"),
      plan and plan.talents and plan.talents[1] and ("Your plan says: " .. plan.talents[1].name .. " (" .. (plan.talents[1].tree or "") .. ")") or "Open your talents (N).", "talent")
  end
  if g.lowestDurability and g.lowestDurability < 25 then add("Repair your gear", string.format("Something is down to %d%% durability.", g.lowestDurability), "repair") end
  if g.freeSlots and g.freeSlots < 4 then add("Make bag space", string.format("Only %d free bag slot%s. Vendor grey items or bank what you don't need.", g.freeSlots, g.freeSlots == 1 and "" or "s"), "bags") end
  if level >= 2 and level % 2 == 0 and (ch.trainerLevel or 0) < level then add("Visit your class trainer", "New spell ranks arrive every even level.", "trainer") end
  local rec = ns.db.characters and ns.db.characters[ns.charKey()]
  for _, p in ipairs(rec and rec.professions or {}) do
    local cap = math.min(level * 5, p.max or 300)
    if p.skill and p.max and p.max > 75 and p.skill < cap - 30 and p.name ~= "Fishing" and p.name ~= "Cooking" and p.name ~= "First Aid" then
      add(p.name .. " is behind your level", string.format("%d of about %d. The skill-up guide shows what to make.", p.skill, cap), "prof")
    end
  end
  if not ch.quiz then add("Tell the Coach how you play", "Five quick questions. Press 'Tune my style'.", "quiz") end
  for _, r in ipairs((WowGuildInbox and WowGuildInbox.raids) or {}) do
    if not r.signup and r.startsAt and r.startsAt > ns.now() then add("Sign up: " .. (r.title or "raid"), date("%a %d %b, %H:%M", r.startsAt) .. " on the website.", "raid"); break end
  end
  for _, s in ipairs(plan and plan.next_steps or {}) do add(s.title, s.detail, "plan") end
  return steps
end

-- Summary line for the main window.
function C.summary()
  local p = C.char().profile or C.profile()
  local plan = C.plan()
  local lines = {}
  if p then lines[#lines + 1] = "|cffe8a33d" .. p.archetype .. "|r  " .. p.blurb else lines[#lines + 1] = "Play a little, or answer the quiz, and the Coach learns your style." end
  if plan and plan.headline then lines[#lines + 1] = "Plan: " .. plan.headline end
  local steps = C.nextSteps()
  for i = 1, math.min(3, #steps) do lines[#lines + 1] = "- " .. steps[i].title end
  return table.concat(lines, "\n")
end
