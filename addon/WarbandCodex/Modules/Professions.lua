-- Warband Codex › Professions.
--   * Recipes: every recipe your characters know (open each profession window once to record it).
--   * Who knows this? Your own characters, your guild's crafters from Guild Camp when it's installed, and
--     guildmates running the Codex: "Ask the guild" sends one short hidden addon message and their Codex answers
--     (option recipeShare decides whether yours answers).
--   * Trainers: the profession trainers you've visited, with the spot, nearest first; "Map" pins one.
local ADDON, ns = ...
local U = ns.ui
local P = {}
ns.professions = P

ns.option{ key = "recipeShare", label = "Answer recipe questions", desc = "When a guildmate's Codex asks who can make something, yours answers if one of your characters knows the recipe.", group = "Professions", default = true }

-- ---------- recording ----------
local function store(prof, names)
  if not prof or prof == "" or #names == 0 then return end
  table.sort(names)
  ns.ensure(ns.char(), "recipes")[prof] = names
  ns.shell.refresh("professions")
end
function P.scanTradeSkill()
  if ns.inCombat() then return end
  local names, prof = {}, nil
  if C_TradeSkillUI and C_TradeSkillUI.GetAllRecipeIDs then
    if C_TradeSkillUI.IsTradeSkillLinked and ns.try(C_TradeSkillUI.IsTradeSkillLinked) then return end
    if C_TradeSkillUI.IsTradeSkillGuild and ns.try(C_TradeSkillUI.IsTradeSkillGuild) then return end
    local info = C_TradeSkillUI.GetBaseProfessionInfo and ns.try(C_TradeSkillUI.GetBaseProfessionInfo)
    prof = type(info) == "table" and info.professionName or nil
    for _, id in ipairs(ns.try(C_TradeSkillUI.GetAllRecipeIDs) or {}) do
      local r = ns.try(C_TradeSkillUI.GetRecipeInfo, id)
      if type(r) == "table" and r.learned and r.name then names[#names + 1] = r.name end
    end
  end
  if #names == 0 and GetNumTradeSkills and GetTradeSkillInfo then
    if IsTradeSkillLinked and ns.try(IsTradeSkillLinked) then return end
    prof = GetTradeSkillLine and ns.try(GetTradeSkillLine) or prof
    for i = 1, ns.n(ns.try(GetNumTradeSkills)) or 0 do
      local name, kind = ns.try(GetTradeSkillInfo, i)
      if name and kind ~= "header" then names[#names + 1] = name end
    end
  end
  store(prof, names)
end
function P.scanCraft()
  if ns.inCombat() or not (GetNumCrafts and GetCraftInfo) then return end
  local prof = GetCraftDisplaySkillLine and ns.try(GetCraftDisplaySkillLine)
  local names = {}
  for i = 1, ns.n(ns.try(GetNumCrafts)) or 0 do
    local name, _, kind = ns.try(GetCraftInfo, i)
    if name and kind ~= "header" then names[#names + 1] = name end
  end
  store(prof, names)
end
ns.on("TRADE_SKILL_SHOW", P.scanTradeSkill)
ns.on("TRADE_SKILL_LIST_UPDATE", P.scanTradeSkill)
ns.on("CRAFT_SHOW", P.scanCraft)

-- ---------- who knows ----------
-- Every recipe any of my characters knows: → { { name, prof, who = { "Char", ... } } } by name.
function P.all()
  local by = {}
  for _, c in pairs(ns.db.chars) do
    for prof, names in pairs(type(c.recipes) == "table" and c.recipes or {}) do
      for _, n in ipairs(names) do
        local e = by[n]
        if not e then e = { name = n, prof = prof, who = {} }; by[n] = e end
        e.who[#e.who + 1] = c.name or "?"
      end
    end
  end
  local out = {}
  for _, e in pairs(by) do table.sort(e.who); out[#out + 1] = e end
  table.sort(out, function(a, b) return a.name < b.name end)
  return out
end
P.answers = {}   -- recipe (lower case) → { sender = true }, this session; only for recipes I asked about
P.asked = {}     -- recipe (lower case) → when I asked the guild, this session
P.ASK_WINDOW = 120   -- seconds an answer to my question is accepted
P.MAX_ANSWERS = 40   -- guildmates kept per recipe
-- → { mine = { chars }, guild = { names from Guild Camp }, codex = { guildmates who answered } }
function P.who(recipe)
  local low = string.lower(recipe or "")
  local res = { mine = {}, guild = {}, codex = {} }
  for _, e in ipairs(P.all()) do
    if string.lower(e.name) == low then for _, w in ipairs(e.who) do res.mine[#res.mine + 1] = w end end
  end
  local camp = ns.camp()
  local got = camp and camp.crafters and ns.try(camp.crafters, recipe)
  if type(got) == "string" then for n in string.gmatch(got, "[^,]+") do res.guild[#res.guild + 1] = n end end
  for sender in pairs(P.answers[low] or {}) do res.codex[#res.codex + 1] = sender end
  table.sort(res.codex)
  return res
end
function P.ask(recipe)
  recipe = string.sub(tostring(recipe or ""), 1, 80)
  if #recipe < 3 then return false end
  local ok = ns.send("RQ", recipe, "GUILD")
  if ok then P.asked[string.lower(recipe)] = ns.now() end
  return ok
end
-- Is this player in my guild's roster? (Answers come by whisper, so the channel alone doesn't say.)
function P.isGuildmate(name)
  if not (name and GetNumGuildMembers and GetGuildRosterInfo) then return false end
  for i = 1, ns.n(ns.try(GetNumGuildMembers)) or 0 do
    if ns.short(ns.try(GetGuildRosterInfo, i)) == name then return true end
  end
  return false
end
-- Only questions asked on the guild channel get an answer, never a whisper from anyone else.
ns.onMessage("RQ", function(body, sender, channel)
  if channel ~= "GUILD" or not sender or not ns.opt("recipeShare") or sender == ns.me() then return end
  local low = string.lower(body or "")
  for _, e in ipairs(P.all()) do
    if string.lower(e.name) == low then ns.send("RA", e.name, "WHISPER", sender) return end
  end
end)
-- Answers are kept only for a recipe I asked about in the last couple of minutes, from a guildmate, a few per recipe.
ns.onMessage("RA", function(body, sender, channel)
  if channel ~= "WHISPER" or not sender or sender == ns.me() then return end
  local low = string.lower(body or "")
  local at = P.asked[low]
  if not at or ns.now() - at > P.ASK_WINDOW then return end
  local got = P.answers[low] or {}
  if got[sender] then return end
  local n = 0
  for _ in pairs(got) do n = n + 1 end
  if n >= P.MAX_ANSWERS or not P.isGuildmate(sender) then return end
  got[sender] = true
  P.answers[low] = got
  ns.shell.refresh("professions")
end)

-- ---------- trainers ----------
ns.on("TRAINER_SHOW", function()
  if not (IsTradeskillTrainer and ns.try(IsTradeskillTrainer)) then return end
  local name = UnitName and UnitName("npc")
  if not name then return end
  local prof = GetTrainerServiceSkillLine and ns.try(GetTrainerServiceSkillLine, 1)
  local spot = ns.where() or {}
  ns.learned("trainers")[name] = { prof = prof or "Profession", zone = ns.zone(), map = spot.map, x = spot.x, y = spot.y, faction = ns.faction() }
  ns.shell.refresh("professions")
end)
-- Trainers I can use, the ones in my zone first, then by profession.
function P.trainers()
  local out, zone = {}, ns.zone()
  for name, t in pairs(ns.learned("trainers")) do
    if t.faction == nil or t.faction == ns.faction() then
      out[#out + 1] = { name = name, prof = t.prof, zone = t.zone, map = t.map, x = t.x, y = t.y, here = t.zone == zone }
    end
  end
  table.sort(out, function(a, b)
    if a.here ~= b.here then return a.here end
    if a.prof ~= b.prof then return tostring(a.prof) < tostring(b.prof) end
    return a.name < b.name
  end)
  return out
end

-- My professions with their skill: → { { name, rank, max } }
function P.mine()
  local out = {}
  if GetProfessions and GetProfessionInfo then
    for _, idx in ipairs({ ns.try(GetProfessions) }) do
      if idx then
        local name, _, rank, max = ns.try(GetProfessionInfo, idx)
        if name then out[#out + 1] = { name = name, rank = rank or 0, max = max or 0 } end
      end
    end
  end
  return out
end

-- ---------- page ----------
local M = ns.module{ id = "professions", title = "Professions", icon = "Trade_BlackSmithing",
  blurb = "Your recipes across characters, who can craft what, and trainers you've found.", keywords = "recipes crafting crafters trainers tradeskill" }

function M.search(q)
  local out = {}
  for _, e in ipairs(P.all()) do
    if ns.matches(e.name, q) then
      out[#out + 1] = { label = e.name, sub = e.prof .. "  ·  " .. table.concat(e.who, ", "), icon = "Interface\\Icons\\INV_Scroll_03", go = function() M.show(e.name) end }
    end
  end
  for _, t in ipairs(P.trainers()) do
    if ns.matches(t.name .. " " .. tostring(t.prof) .. " trainer", q) then
      out[#out + 1] = { label = t.name, sub = tostring(t.prof) .. " trainer, " .. tostring(t.zone), icon = "Interface\\Icons\\INV_Misc_Book_11", go = function() M.view("trainers") end }
    end
  end
  return out
end

local body_
function M.view(v) if body_ then body_.view = v; M.refresh(body_) end end
function M.show(recipe) if body_ then body_.view = "recipes"; body_.filter.type(recipe) end end

function M.build(body)
  body_ = body
  body.view = "recipes"
  body.views = U.chips(body, { { "recipes", "Recipes & who knows" }, { "trainers", "Trainers" } }, function(k) body.view = k; M.refresh(body) end)
  body.views:SetPoint("TOPLEFT")
  body.filter = U.edit(body, 240, "Recipe name ...", function() M.refresh(body) end)
  body.filter:SetPoint("TOPRIGHT", -130, 0)
  body.ask = U.button(body, "Ask the guild", function()
    local text = body.filter.value()
    if P.ask(text) then body.status:SetText("Asked the guild who can make \"" .. ns.plain(text) .. "\". Answers appear below.")
    else body.status:SetText("Type at least three letters of the recipe, and be in a guild and outside instances.") end
  end, { w = 120 })
  body.ask:SetPoint("TOPRIGHT")
  body.ask.tip = "Sends one hidden addon message to guildmates running the Codex."
  body.profs = U.text(body, "small", "", "dim"); body.profs:SetPoint("TOPLEFT", 0, -32)
  body.status = U.empty(body, ""); body.status:SetPoint("TOPLEFT", 0, -50); body.status:SetPoint("TOPRIGHT", 0, -50)

  body.list = U.list(body, 34, function(list, i)
    local r = U.row(list, i, function(_, item) if item.recipe then body.filter.type(item.recipe) end end)
    r.icon = U.icon(r, 24); r.icon:SetPoint("LEFT", 6, 0)
    r.name = U.text(r, "body", "", "text"); r.name:SetPoint("TOPLEFT", 40, -4); r.name:SetPoint("RIGHT", -90, 0)
    r.sub = U.text(r, "small", "", "dim"); r.sub:SetPoint("TOPLEFT", 40, -19); r.sub:SetPoint("RIGHT", -90, 0)
    r.btn = U.button(r, "Map", function() if r.item and not ns.showOnMap(r.item) then ns.print("This game version has no map pins for addons. " .. r.item.name .. " is in " .. tostring(r.item.zone) .. ".") end end, { w = 60, h = 22 })
    r.btn:SetPoint("RIGHT", -8, 0)
    return r
  end, function(r, item)
    r.icon.set(item.icon)
    r.name:SetText(item.title or ""); r.sub:SetText(item.sub or "")
    if item.map and item.x then r.btn:Show() else r.btn:Hide() end
  end, 12)
  body.list:SetPoint("TOPLEFT", 0, -72); body.list:SetPoint("BOTTOMRIGHT", 0, 0)
end

function M.refresh(body)
  body.views.pick(body.view, true)
  local parts = {}
  for _, p in ipairs(P.mine()) do parts[#parts + 1] = string.format("%s %d/%d", p.name, p.rank, p.max) end
  body.profs:SetText(#parts > 0 and table.concat(parts, "   ·   ") or "")
  local rows = {}
  if body.view == "recipes" then
    body.filter:Show(); body.ask:Show()
    local q = body.filter.value()
    for _, e in ipairs(P.all()) do
      if q == "" or ns.matches(e.name, q) then
        local who = P.who(e.name)
        local sub = e.prof .. "  ·  " .. table.concat(who.mine, ", ")
        if #who.guild > 0 then sub = sub .. "  ·  guild: " .. table.concat(who.guild, ", ") end
        if #who.codex > 0 then sub = sub .. "  ·  answered: " .. table.concat(who.codex, ", ") end
        rows[#rows + 1] = { recipe = e.name, title = e.name, sub = sub, icon = "Interface\\Icons\\INV_Scroll_03" }
      end
    end
    -- A recipe none of my characters has: still show who in the guild can make it.
    if q ~= "" and #rows == 0 then
      local who = P.who(q)
      local names = {}
      for _, n in ipairs(who.guild) do names[#names + 1] = n end
      for _, n in ipairs(who.codex) do names[#names + 1] = n end
      if #names > 0 then rows[#rows + 1] = { title = q, sub = "Can make it: " .. table.concat(names, ", "), icon = "Interface\\Icons\\INV_Scroll_03" } end
    end
    local asked = string.find(body.status:GetText() or "", "^Asked") ~= nil
    if #rows == 0 and not asked then
      body.status:SetText(q == "" and "No recipes recorded yet. Open each profession window once." or "None of your characters knows that. Try \"Ask the guild\".")
    elseif #rows > 0 and not asked then body.status:SetText("") end
  else
    body.filter:Hide(); body.ask:Hide()
    for _, t in ipairs(P.trainers()) do
      rows[#rows + 1] = { name = t.name, zone = t.zone, map = t.map, x = t.x, y = t.y, title = t.name .. "  |cff999999" .. tostring(t.prof) .. "|r",
        sub = tostring(t.zone) .. (t.x and string.format("  (%.0f, %.0f)", t.x * 100, t.y * 100) or "") .. (t.here and "  ·  in your zone" or ""), icon = "Interface\\Icons\\INV_Misc_Book_11" }
    end
    body.status:SetText(#rows == 0 and "No trainers found yet. The Codex remembers each profession trainer you talk to, for all your characters." or "")
  end
  body.list.offset = 0
  body.list.set(rows)
end
