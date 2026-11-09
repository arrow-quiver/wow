-- Guild Camp: guild information on item tooltips.
--   Guild crafters: who in the guild can make this item
--   Your characters: how many each of your other characters holds
--   Guild bank: how many the guild bank (or bank characters) holds
--   Guild price: latest guild auction scan (only when Auctionator isn't installed, as it shows its own)
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
