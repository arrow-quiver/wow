-- Warband Codex › Armory: the gear planner.
--   * Scores items with stat weights for your talent tree (Data/Classes.lua; pick another tree with the chips).
--   * Upgrades: every item the addon knows about that beats what you wear in its slot, with the gain in percent
--     and where it comes from. It knows items from your bags, your wishlist and the loot it has seen drop
--     (the Dungeons tab records that for all your characters).
--   * Wishlist: /codex wish <shift-clicked item>, or the star on any row.
--   * Item tooltips say how much of an upgrade the item is (option tooltipGain).
--   * Sets: how many pieces of your class's Classic sets you own.
-- Reads item stats only out of combat.
local ADDON, ns = ...
local U = ns.ui
local A = {}
ns.armory = A

ns.option{ key = "tooltipGain", label = "Upgrade line on item tooltips", desc = "Item tooltips show how much better or worse the item is than what you wear, for your talent tree.", group = "Armory", default = true }

A.SLOTS = { { 1, "Head" }, { 2, "Neck" }, { 3, "Shoulder" }, { 15, "Back" }, { 5, "Chest" }, { 9, "Wrist" }, { 10, "Hands" }, { 6, "Waist" },
  { 7, "Legs" }, { 8, "Feet" }, { 11, "Ring" }, { 12, "Ring" }, { 13, "Trinket" }, { 14, "Trinket" }, { 16, "Main hand" }, { 17, "Off hand" }, { 18, "Ranged" } }
local SLOT_NAME = {}
for _, s in ipairs(A.SLOTS) do SLOT_NAME[s[1]] = s[2] end
local LOC = { INVTYPE_HEAD = { 1 }, INVTYPE_NECK = { 2 }, INVTYPE_SHOULDER = { 3 }, INVTYPE_CHEST = { 5 }, INVTYPE_ROBE = { 5 },
  INVTYPE_WAIST = { 6 }, INVTYPE_LEGS = { 7 }, INVTYPE_FEET = { 8 }, INVTYPE_WRIST = { 9 }, INVTYPE_HAND = { 10 },
  INVTYPE_FINGER = { 11, 12 }, INVTYPE_TRINKET = { 13, 14 }, INVTYPE_CLOAK = { 15 }, INVTYPE_WEAPON = { 16, 17 },
  INVTYPE_2HWEAPON = { 16 }, INVTYPE_WEAPONMAINHAND = { 16 }, INVTYPE_WEAPONOFFHAND = { 17 }, INVTYPE_HOLDABLE = { 17 },
  INVTYPE_SHIELD = { 17 }, INVTYPE_RANGED = { 18 }, INVTYPE_RANGEDRIGHT = { 18 }, INVTYPE_THROWN = { 18 }, INVTYPE_RELIC = { 18 } }

-- One talent tree: name, points spent, icon (the return order differs between game versions).
function ns.talentTab(i)
  if not GetTalentTabInfo then return nil end
  local a, b, c, d, e = ns.try(GetTalentTabInfo, i)
  if type(a) == "number" then return b, tonumber(e) or 0, d end
  return a, tonumber(c) or 0, b
end

-- The tree to score for: the one picked on the page, else the one with most points, else the first.
function A.spec()
  local specs = ns.data.specs[ns.class()]
  if not specs then return nil end
  local pick = ns.char().spec
  if not pick then
    local best = 0
    for i = 1, 3 do
      local _, points = ns.talentTab(i)
      if (points or 0) > best then best, pick = points, i end
    end
  end
  pick = pick or 1
  local s = specs[pick] or specs[1]
  return { index = pick, label = s[1], weights = s[2] }
end

function A.stats(link)
  if not link or ns.inCombat() then return nil end
  local get = (C_Item and C_Item.GetItemStats) or GetItemStats
  local t = get and ns.try(get, link)
  return type(t) == "table" and t or nil
end
-- → score (a number), or nil when the item has no stats to read yet.
function A.score(link, weights)
  local stats = A.stats(link)
  if not stats then return nil end
  weights = weights or (A.spec() or {}).weights or {}
  local total = 0
  for key, value in pairs(stats) do
    local w = weights[key]
    if w and type(value) == "number" then total = total + w * value end
  end
  return total
end
function A.slotsFor(link)
  local instant = (C_Item and C_Item.GetItemInfoInstant) or GetItemInfoInstant
  if not instant or not link then return nil end
  local _, _, _, loc = ns.try(instant, link)
  return loc and LOC[loc] or nil
end

function A.equipped()
  local out = {}
  for _, s in ipairs(A.SLOTS) do
    local link = GetInventoryItemLink and ns.try(GetInventoryItemLink, "player", s[1])
    out[#out + 1] = { slot = s[1], slotName = s[2], link = link, name = link and ns.itemName(link) or nil, score = link and A.score(link) or 0 }
  end
  return out
end

-- ---------- wishlist ----------
function A.wishlist() return ns.ensure(ns.char(), "wish") end
function A.wish(link, on)
  local id = ns.itemId(link)
  if not id then return false end
  local w = A.wishlist()
  if on == nil then on = not w[id] end
  w[id] = on and (type(link) == "string" and link or ("item:" .. id)) or nil
  ns.shell.refresh("armory")
  return on
end
ns.slash.wish = function(rest)
  local id = ns.itemId(rest)
  if not id then ns.print("Shift-click an item into the chat box after /codex wish.") return end
  local on = A.wish(string.match(rest, "(|c.-|h|r)") or rest)
  ns.print((ns.itemName(rest) or "Item") .. (on and " is on your wishlist." or " is off your wishlist."))
end

-- ---------- what the addon knows about ----------
-- → { [itemId] = { link, source, wish } }
function A.known()
  local out = {}
  for id, e in pairs(ns.learned("items")) do
    if type(e) == "table" and e.link then out[id] = { link = e.link, source = e.src } end
  end
  ns.eachBagItem(function(_, _, info)
    local id = info.itemID or ns.itemId(info.hyperlink)
    if id and info.hyperlink then out[id] = { link = info.hyperlink, source = "In your bags" } end
  end)
  for id, link in pairs(A.wishlist()) do
    out[id] = out[id] or { link = link, source = "Wishlist" }
    out[id].wish = true
  end
  return out
end

-- How an item compares with what is worn: → { gain, pct, slot } against the weakest slot it can go in.
function A.compare(link, worn)
  local slots = A.slotsFor(link)
  local score = slots and A.score(link)
  if not score then return nil end
  worn = worn or A.equipped()
  local base, slot
  for _, e in ipairs(worn) do
    for _, s in ipairs(slots) do
      if e.slot == s and (base == nil or (e.score or 0) < base) then base, slot = e.score or 0, s end
    end
  end
  if base == nil then return nil end
  local pct = base > 0 and (score - base) / base * 100 or (score > 0 and 100 or 0)
  return { gain = score - base, pct = pct, slot = slot, slotName = SLOT_NAME[slot], score = score }
end

-- Every known item that beats the slot it goes in, biggest gain first.
function A.upgrades()
  local worn, out = A.equipped(), {}
  local wearing = {}
  for _, e in ipairs(worn) do local id = ns.itemId(e.link); if id then wearing[id] = true end end
  for id, k in pairs(A.known()) do
    if not wearing[id] then
      local c = A.compare(k.link, worn)
      if c and c.gain > 0.01 then
        out[#out + 1] = { id = id, link = k.link, name = ns.itemName(k.link) or ("Item " .. id), source = k.source, wish = k.wish,
          gain = c.gain, pct = c.pct, slotName = c.slotName }
      end
    end
  end
  table.sort(out, function(a, b) if a.pct ~= b.pct then return a.pct > b.pct end return a.name < b.name end)
  return out
end

-- ---------- sets ----------
-- → { { name, from, have, of } } for this class: pieces worn or in bags whose name carries the set's word.
function A.sets()
  local out = {}
  local names = {}
  for _, e in ipairs(A.equipped()) do if e.name then names[#names + 1] = e.name end end
  ns.eachBagItem(function(_, _, info) local n = ns.itemName(info.hyperlink); if n then names[#names + 1] = n end end)
  for _, set in ipairs(ns.data.sets[ns.class()] or {}) do
    local have, seen = 0, {}
    for _, n in ipairs(names) do
      if not seen[n] and string.find(n, set[3], 1, true) then seen[n] = true; have = have + 1 end
    end
    out[#out + 1] = { name = set[1], from = set[2], have = math.min(have, ns.data.setSize), of = ns.data.setSize }
  end
  return out
end

-- ---------- tooltip ----------
function A.tooltipLine(link)
  if not ns.opt("tooltipGain") or ns.inCombat() then return nil end
  local c = A.compare(link)
  local spec = A.spec()
  if not c or not spec then return nil end
  if math.abs(c.pct) < 0.5 then return string.format("Codex: about the same as your %s (%s)", string.lower(c.slotName), spec.label) end
  return string.format("Codex: %s%+.0f%%|r vs your %s (%s)", c.pct > 0 and "|cff73d17a" or "|cffeb5450", c.pct, string.lower(c.slotName), spec.label)
end
local function onTooltip(tip)
  if not tip then return end
  local link
  if TooltipUtil and TooltipUtil.GetDisplayedItem then local _, l = ns.try(TooltipUtil.GetDisplayedItem, tip); link = l
  elseif tip.GetItem then local _, l = ns.try(tip.GetItem, tip); link = l end
  local line = link and A.tooltipLine(link)
  if line and tip.AddLine then tip:AddLine(line, 0.85, 0.85, 0.85); if tip.Show then tip:Show() end end
end
ns.on("PLAYER_LOGIN", function()
  if TooltipDataProcessor and TooltipDataProcessor.AddTooltipPostCall and Enum and Enum.TooltipDataType then
    ns.try(TooltipDataProcessor.AddTooltipPostCall, Enum.TooltipDataType.Item, function(tip) if tip == GameTooltip then ns.safely(onTooltip, tip) end end)
  elseif GameTooltip and GameTooltip.HookScript then
    ns.try(GameTooltip.HookScript, GameTooltip, "OnTooltipSetItem", function(tip) ns.safely(onTooltip, tip) end)
  end
end)

-- ---------- page ----------
local M = ns.module{ id = "armory", title = "Armory", icon = "INV_Chest_Plate04",
  blurb = "Upgrades for your talent tree, your wishlist and your sets.", keywords = "gear planner upgrades wishlist sets items equipment" }

function M.steps()
  local ups = A.upgrades()
  if #ups == 0 then return {} end
  local inBags = 0
  for _, u in ipairs(ups) do if u.source == "In your bags" then inBags = inBags + 1 end end
  if inBags > 0 then return { { text = string.format("%d item%s in your bags would be an upgrade.", inBags, inBags == 1 and "" or "s"), icon = "INV_Chest_Plate04" } } end
  return {}
end
function M.badge() local n = #A.upgrades(); return n > 0 and n or nil end

function M.search(q)
  local out = {}
  for id, k in pairs(A.known()) do
    local name = ns.itemName(k.link)
    if name and ns.matches(name, q) then out[#out + 1] = { label = name, sub = k.source or "", icon = ns.itemIcon(id) } end
  end
  table.sort(out, function(a, b) return a.label < b.label end)
  return out
end

local VIEWS = { { "upgrades", "Upgrades" }, { "worn", "Wearing" }, { "wish", "Wishlist" }, { "sets", "Sets" } }

function M.build(body)
  body.view = "upgrades"
  body.views = U.chips(body, VIEWS, function(key) body.view = key; M.refresh(body) end)
  body.views:SetPoint("TOPLEFT")
  body.specLabel = U.text(body, "small", "Scoring for", "dim"); body.specLabel:SetPoint("TOPRIGHT", -300, -5)
  local specs = ns.data.specs[ns.class()] or {}
  local choices = {}
  for i, s in ipairs(specs) do choices[#choices + 1] = { i, s[1] } end
  body.specs = U.chips(body, choices, function(i) ns.char().spec = i; M.refresh(body) end)
  body.specs:SetPoint("TOPRIGHT", 0, 0)
  body.specLabel:ClearAllPoints(); body.specLabel:SetPoint("RIGHT", body.specs, "LEFT", -8, 0)

  body.note = U.empty(body, ""); body.note:SetPoint("TOPLEFT", 0, -36); body.note:SetPoint("TOPRIGHT", 0, -36)

  body.list = U.list(body, 34, function(list, i)
    local r = U.row(list, i, function(self, item, which)
      if item.link and IsShiftKeyDown and IsShiftKeyDown() and ChatEdit_InsertLink then ChatEdit_InsertLink(item.link) return end
      if item.id then A.wish(item.link or item.id) end
    end)
    r.icon = U.icon(r, 26); r.icon:SetPoint("LEFT", 6, 0)
    r.name = U.text(r, "body", "", "text"); r.name:SetPoint("TOPLEFT", 40, -4); r.name:SetPoint("RIGHT", -170, 0)
    r.sub = U.text(r, "small", "", "dim"); r.sub:SetPoint("TOPLEFT", 40, -19); r.sub:SetPoint("RIGHT", -170, 0)
    r.right = U.text(r, "num", "", "good"); r.right:SetPoint("RIGHT", -52, 0); r.right:SetJustifyH("RIGHT")
    r.star = U.text(r, "small", "", "accent"); r.star:SetPoint("RIGHT", -10, 0)
    r.bar = U.bar(r, 150, 8); r.bar:SetPoint("RIGHT", -10, -6); r.bar:Hide()
    return r
  end, function(r, item)
    r.tipLink = item.link
    r.icon.set(item.icon or ns.itemIcon(item.link))
    r.name:SetText(item.title or item.link or item.name or "")
    r.sub:SetText(item.sub or "")
    r.right:SetText(item.right or "")
    r.star:SetText(item.wish and "Wish" or "")
    r.star:SetTextColor(U.c("accent"))
    if item.frac then r.bar:Show(); r.bar.set(item.frac, item.barText) else r.bar:Hide() end
  end, 12)
  body.list:SetPoint("TOPLEFT", 0, -62); body.list:SetPoint("BOTTOMRIGHT", 0, 0)
end

function M.rows(view)
  local rows = {}
  if view == "upgrades" then
    for _, u in ipairs(A.upgrades()) do
      rows[#rows + 1] = { id = u.id, link = u.link, name = u.name, wish = u.wish, sub = u.slotName .. "  ·  " .. (u.source or "Seen"),
        right = string.format("+%.0f%%", u.pct) }
    end
  elseif view == "worn" then
    for _, e in ipairs(A.equipped()) do
      rows[#rows + 1] = { link = e.link, title = e.link or ("|cff777777Empty|r"), sub = e.slotName, icon = e.link and ns.itemIcon(e.link) or "Interface\\Icons\\INV_Misc_QuestionMark",
        right = e.link and string.format("%.0f", e.score or 0) or "" }
    end
  elseif view == "wish" then
    local worn = A.equipped()
    for id, link in pairs(A.wishlist()) do
      local c = A.compare(link, worn)
      local known = ns.learned("items")[id]
      rows[#rows + 1] = { id = id, link = link, name = ns.itemName(link) or ("Item " .. id), wish = true,
        sub = (c and c.slotName or "Item") .. "  ·  " .. ((known and known.src) or "Source not seen yet"),
        right = c and string.format("%+.0f%%", c.pct) or "" }
    end
    table.sort(rows, function(a, b) return a.name < b.name end)
  else
    for _, s in ipairs(A.sets()) do
      rows[#rows + 1] = { title = s.name, sub = s.from, icon = "Interface\\Icons\\INV_Chest_Plate04", frac = s.have / s.of, barText = s.have .. " / " .. s.of }
    end
  end
  return rows
end

local NOTES = {
  upgrades = "Items the Codex has seen that beat what you wear. Click a row to put it on your wishlist; shift-click to link it in chat.",
  worn = "What you're wearing, with its score for the chosen tree.",
  wish = "Your wishlist. Add items with /codex wish and a shift-clicked link, or the star on any item row.",
  sets = "Pieces you own (worn or in your bags) of your class's Classic sets, matched by name.",
}
local EMPTY = {
  upgrades = "No upgrades known yet. Run dungeons with the Codex on and it learns what drops; items in your bags count too.",
  wish = "Nothing on your wishlist yet.",
  sets = "No sets listed for your class.",
}
function M.refresh(body)
  local spec = A.spec()
  body.views.pick(body.view, true)
  if spec then body.specs.pick(spec.index, true) end
  local rows = M.rows(body.view)
  body.note:SetText(#rows == 0 and (EMPTY[body.view] or "") or NOTES[body.view])
  body.list.offset = 0
  body.list.set(rows)
end

ns.on("PLAYER_EQUIPMENT_CHANGED", function() ns.shell.refresh("armory") end)
