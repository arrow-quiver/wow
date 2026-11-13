-- Warband Codex › Home: this character at a glance, and what to do next. Every other tab can add lines to
-- "Next steps" (m.steps() → { { text, tab, icon } }), so the list is the one place that says what needs attention.
local ADDON, ns = ...
local U = ns.ui
local M = ns.module{ id = "home", title = "Home", icon = "INV_Misc_Book_09", pinned = true,
  blurb = "Your character at a glance, and what needs attention.", keywords = "dashboard overview start" }

function M.durability()
  local low, sum, n = 1, 0, 0
  if not GetInventoryItemDurability then return nil end
  for slot = 1, 18 do
    local cur, max = ns.try(GetInventoryItemDurability, slot)
    if cur and max and max > 0 then
      local f = cur / max
      sum, n = sum + f, n + 1
      if f < low then low = f end
    end
  end
  if n == 0 then return nil end
  return sum / n, low
end

function M.xp()
  local cur, max = ns.n(ns.try(UnitXP, "player")), ns.n(ns.try(UnitXPMax, "player"))
  if not cur or not max or max <= 0 then return nil end
  return cur, max, tonumber(GetXPExhaustion and ns.try(GetXPExhaustion)) or 0
end

-- Everything that needs attention, most pressing first.
function M.steps()
  local out = {}
  local avg, low = M.durability()
  if low and low < 0.25 then out[#out + 1] = { text = string.format("Repair your gear: the worst piece is at %d%%.", math.floor(low * 100)), icon = "Trade_BlackSmithing" } end
  local free, total = ns.bagSpace()
  if total > 0 and free <= 3 then out[#out + 1] = { text = string.format("Bags nearly full: %d of %d slots free.", free, total), icon = "INV_Misc_Bag_08" } end
  for _, m in ipairs(ns.moduleList) do
    if m ~= M and m.steps and (not m.available or m.available()) then
      local ok, list = pcall(m.steps)
      if ok and type(list) == "table" then
        for _, s in ipairs(list) do s.tab = s.tab or m.id; out[#out + 1] = s end
      elseif not ok then ns.reportError(list) end
    end
  end
  return out
end

local function stat(parent, label)
  local c = U.card(parent, 150, 64)
  c.label = U.text(c, "small", label, "dim"); c.label:SetPoint("TOPLEFT", 12, -10)
  c.value = U.text(c, "big", "", "text"); c.value:SetPoint("TOPLEFT", 12, -26)
  c.note = U.text(c, "small", "", "dim"); c.note:SetPoint("BOTTOMRIGHT", -10, 8); c.note:SetJustifyH("RIGHT")
  return c
end

function M.build(body, page)
  -- Character banner.
  local hero = U.card(body)
  hero:SetPoint("TOPLEFT"); hero:SetPoint("TOPRIGHT"); hero:SetHeight(84)
  hero.stripe = U.tex(hero, "ARTWORK", 1, 1, 1, 1); hero.stripe:SetPoint("TOPLEFT"); hero.stripe:SetPoint("BOTTOMLEFT"); hero.stripe:SetWidth(4)
  hero.name = U.text(hero, "title", "", "text"); hero.name:SetPoint("TOPLEFT", 18, -12)
  hero.line = U.text(hero, "body", "", "dim"); hero.line:SetPoint("TOPLEFT", 20, -42)
  hero.xp = U.bar(hero, 400, 12); hero.xp:SetPoint("BOTTOMLEFT", 20, 12); hero.xp:SetPoint("BOTTOMRIGHT", -20, 12)
  body.hero = hero

  body.stats = {}
  for i, label in ipairs({ "Gold", "Bags", "Durability", "Guild" }) do
    local c = stat(body, label)
    c:SetPoint("TOPLEFT", (i - 1) * 160, -96)
    body.stats[i] = c
  end

  local sec = U.section(body, "Next steps")
  sec:SetPoint("TOPLEFT", 0, -176); sec:SetPoint("TOPRIGHT", 0, -176)
  body.empty = U.empty(body, "Nothing needs attention. Go play.")
  body.empty:SetPoint("TOPLEFT", 0, -208)
  body.list = U.list(body, 32, function(list, i)
    local r = U.row(list, i, function(_, item) if item.go then ns.safely(item.go) elseif item.tab then ns.shell.open(item.tab) end end)
    r.icon = U.icon(r, 22); r.icon:SetPoint("LEFT", 6, 0)
    r.text = U.text(r, "body", "", "text"); r.text:SetPoint("LEFT", 38, 0); r.text:SetPoint("RIGHT", -90, 0)
    r.where = U.text(r, "small", "", "accent"); r.where:SetPoint("RIGHT", -8, 0); r.where:SetJustifyH("RIGHT")
    return r
  end, function(r, item)
    r.icon.set("Interface\\Icons\\" .. (item.icon or "INV_Misc_Note_01"))
    r.text:SetText(item.text or "")
    local m = item.tab and ns.modules[item.tab]
    r.where:SetText(m and (m.title .. " >") or "")
  end, 10)
  body.list:SetPoint("TOPLEFT", 0, -204); body.list:SetPoint("BOTTOMRIGHT", 0, 0)
end

function M.refresh(body)
  local class = ns.class()
  local hex = ns.data.classColors[class] or "ffffff"
  body.hero.name:SetText("|cff" .. hex .. ns.plain(ns.me()) .. "|r")
  local r, g, b = tonumber(string.sub(hex, 1, 2), 16) / 255, tonumber(string.sub(hex, 3, 4), 16) / 255, tonumber(string.sub(hex, 5, 6), 16) / 255
  U.color(body.hero.stripe, r, g, b, 1)
  local spec = ns.armory and ns.armory.spec and ns.armory.spec()
  body.hero.line:SetText(string.format("Level %d %s%s  ·  %s", ns.level(), spec and (spec.label .. " ") or "", ns.data.classNames[class] or class, ns.zone()))
  local cur, max, rested = M.xp()
  if cur then
    body.hero.xp.set(cur / max, string.format("%d / %d XP%s", cur, max, rested > 0 and string.format("  (+%d rested)", rested) or ""))
  else body.hero.xp.set(1, "Top level") end

  local s = body.stats
  s[1].value:SetText(ns.money(GetMoney and ns.try(GetMoney) or 0)); s[1].note:SetText("")
  local free, total = ns.bagSpace()
  s[2].value:SetText(free .. " free"); s[2].note:SetText("of " .. total)
  local avg, low = M.durability()
  s[3].value:SetText(avg and (math.floor(avg * 100) .. "%") or "-"); s[3].note:SetText(low and ("worst " .. math.floor(low * 100) .. "%") or "")
  local guild = GetGuildInfo and ns.try(GetGuildInfo, "player")
  s[4].value:SetText(guild and ns.plain(guild) or "No guild"); s[4].note:SetText(ns.camp() and "Guild Camp linked" or "")

  local steps = M.steps()
  body.list.set(steps)
  if #steps == 0 then body.empty:Show() else body.empty:Hide() end
end

ns.on("BAG_UPDATE_DELAYED", function() ns.shell.refresh("home") end)
ns.on("PLAYER_MONEY", function() ns.shell.refresh("home") end)
ns.on("PLAYER_XP_UPDATE", function() ns.shell.refresh("home") end)
