-- Guild Camp: guild information on item tooltips.
--   Guild crafters: who in the guild can make this item
--   Your characters: how many each of your other characters holds
--   Guild bank: how many the guild bank (or bank characters) holds
--   Guild price: latest guild auction scan (only when Auctionator isn't installed, as it shows its own)
--   Guild goal / Guild request: an open supply drive still short of this item, and who asked the guild bank for it
--     (from the guild's shared records, so these are as fresh as the last exchange with a guildmate)
-- Data comes from the guild through the Guild Camp app (the WowGuild_Inbox folder it writes), so it's as fresh as your last reload.
local ADDON, ns = ...
local T = {}
ns.tooltip = T

local holdings, crafters, prices
local function build()
  if holdings then return end
  holdings, crafters, prices = {}, {}, {}
  local inbox = WowGuildInbox
  if not inbox then return end
  for _, h in ipairs(inbox.holdings or {}) do holdings[h.id] = h end
  for _, c in ipairs(inbox.crafters or {}) do if c.name then crafters[string.lower(c.name)] = c.who end end
  for _, p in ipairs(inbox.prices or {}) do prices[p.id] = p.price end
end
function T.reset() holdings = nil end
-- "Name1,Name2" of guild crafters for an item name, or nil.
function T.craftersFor(name) build(); return name and crafters[string.lower(name)] or nil end

-- What the guild is short of, by item name (lower case): { drive = { title, left }, asks = { { who, count } } }.
-- Rebuilt at most every WANT_CACHE seconds: tooltips ask many times a second.
T.WANT_CACHE = 10
local wants, wantsAt
function T.resetWants() wants = nil end
function T.wants()
  local t = (GetTime and ns.try(GetTime)) or time()
  if wants and wantsAt and t - wantsAt < T.WANT_CACHE then return wants end
  wants, wantsAt = {}, t
  local function entry(name)
    local k = string.lower(name)
    wants[k] = wants[k] or { asks = {} }
    return wants[k]
  end
  -- A drive counts for the item its unit names ("Runecloth"), while it's short.
  for _, d in ipairs((ns.goals and ns.goals.drives and ns.try(ns.goals.drives)) or {}) do
    if d.unit ~= "" and d.goal > d.total then
      local e = entry(d.unit)
      if not e.drive then e.drive = { title = d.title, left = d.goal - d.total } end
    end
  end
  -- Requests to the guild bank that nobody has handled yet.
  local list = ns.Share and ns.Share.list
  if type(list) == "function" then
    local handled = {}
    for _, h in ipairs(ns.try(list, "BH") or {}) do handled[h.key or ""] = true end
    for _, rec in ipairs(ns.try(list, "bq") or {}) do
      local f = rec.fields
      if type(f) == "table" and f.state ~= "x" and not handled[rec.key or ""] and type(f.item) == "string" and f.item ~= "" then
        local e = entry(f.item)
        if #e.asks < 3 then e.asks[#e.asks + 1] = { who = tostring(rec.author or "?"), count = math.max(1, math.floor(tonumber(f.count) or 1)) } end
      end
    end
  end
  return wants
end

-- Lines to add for an item, as { left, right } pairs. Kept separate from the hook so it can be tested.
function T.linesFor(id, name)
  build()
  local out = {}
  if not id then return out end
  local me = UnitName("player")
  if name then
    local who = crafters[string.lower(name)]
    if who then
      local list = {}
      for n in string.gmatch(who, "[^,]+") do list[#list + 1] = n end
      local shown = table.concat(list, ", ", 1, math.min(#list, 4))
      if #list > 4 then shown = shown .. " +" .. (#list - 4) end
      out[#out + 1] = { "Guild crafters", shown }
    end
  end
  local h = holdings[id]
  if h then
    local parts, total = {}, 0
    for _, c in ipairs(h.chars or {}) do
      if c.name ~= me and (c.count or 0) > 0 then parts[#parts + 1] = c.name .. " " .. c.count; total = total + c.count end
    end
    if #parts > 0 then out[#out + 1] = { "Your other characters", table.concat(parts, ", ", 1, math.min(#parts, 3)) .. (#parts > 3 and " …" or "") } end
    if (h.guildBank or 0) > 0 then out[#out + 1] = { "Guild bank", tostring(h.guildBank) } end
  end
  -- What the guild is short of: a drive that still wants this item, and who asked the bank for it.
  local w = name and T.wants()[string.lower(name)]
  if w then
    if w.drive then out[#out + 1] = { "Guild goal", string.format("|cffe8a33d%d more wanted|r (%s)", w.drive.left, w.drive.title) } end
    if #w.asks > 0 then
      local parts = {}
      for _, a in ipairs(w.asks) do parts[#parts + 1] = string.format("%s wants %d", a.who, a.count) end
      out[#out + 1] = { "Guild request", table.concat(parts, ", ") }
    end
  end
  -- The Coach: is this an upgrade for my build plan? (CoachGear.lua)
  local v = ns.coachGear and ns.coachGear.verdict("item:" .. id)
  if v then out[#out + 1] = { "Coach", string.format("|cff%02x%02x%02x%s|r", math.floor(v[2] * 255), math.floor(v[3] * 255), math.floor(v[4] * 255), v[1]) } end
  local hasAuctionator = Auctionator and Auctionator.API
  if prices[id] and not hasAuctionator and ns.prof and ns.prof.money then out[#out + 1] = { "Guild price", ns.prof.money(prices[id]) } end
  return out
end

local function addLines(tooltip, id, name)
  if not ns.opt("tooltips") or not tooltip or not tooltip.AddDoubleLine then return end
  local lines = T.linesFor(id, name)
  if #lines == 0 then return end
  for i, l in ipairs(lines) do
    tooltip:AddDoubleLine((i == 1 and "|cffe8a33dwow|r " or "") .. l[1], l[2], 0.9, 0.9, 0.9, 1, 1, 1)
  end
  if tooltip.Show then tooltip:Show() end
end

local function idFromLink(link) return link and tonumber(string.match(link, "item:(%d+)")) end

local function nameFor(id)
  local info = (C_Item and C_Item.GetItemInfo) or GetItemInfo
  if info then return (ns.try(info, id)) end
end

-- Modern clients: tooltip data processor. Older ones: OnTooltipSetItem.
local hooked = false
function T.install()
  if hooked then return end
  if TooltipDataProcessor and TooltipDataProcessor.AddTooltipPostCall and Enum and Enum.TooltipDataType and Enum.TooltipDataType.Item then
    TooltipDataProcessor.AddTooltipPostCall(Enum.TooltipDataType.Item, function(tooltip, data)
      local id = data and data.id
      if id then addLines(tooltip, id, nameFor(id)) end
    end)
    hooked = true
  elseif GameTooltip and GameTooltip.HookScript then
    local function onItem(tooltip)
      local name, link = tooltip:GetItem()
      local id = idFromLink(link)
      if id then addLines(tooltip, id, name) end
    end
    GameTooltip:HookScript("OnTooltipSetItem", onItem)
    if ItemRefTooltip and ItemRefTooltip.HookScript then ItemRefTooltip:HookScript("OnTooltipSetItem", onItem) end
    hooked = true
  end
end

ns.on("PLAYER_LOGIN", function() T.install() end)
