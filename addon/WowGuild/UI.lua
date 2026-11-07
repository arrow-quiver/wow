-- Guild Camp: guild news text and the login message.
-- The news comes from the Guild Camp app, which writes it into the WowGuild_Inbox addon
-- (the global WowGuildInbox) on every sync. It's as fresh as your last /reload.
local ADDON, ns = ...


local function ago(t)
  if not t then return "" end
  local s = time() - t
  if s < 3600 then return math.max(1, math.floor(s / 60)) .. " min ago" end
  if s < 86400 then return math.floor(s / 3600) .. " h ago" end
  return math.floor(s / 86400) .. " d ago"
end

-- Text sections shown in the main window (MainUI.lua).
function ns.ago(t) return ago(t) end

-- Battle tags arrive as "Name#1234"; players only need the name.
local function who(s) return (tostring(s or ""):gsub("#%d+", "")) end

function ns.textRaids()
  local inbox = WowGuildInbox
  local lines = {}
  local function add(s) lines[#lines + 1] = s end
  add("|cffffd100Raids and events|r")
  if inbox and inbox.raids and #inbox.raids > 0 then
    for _, r in ipairs(inbox.raids) do
      local me
      if r.signup == "yes" then me = "|cff3fbf5ayou're coming|r" .. (r.role and (" as " .. r.role) or "")
      elseif r.signup == "tentative" then me = "|cffe8a33dyou're a maybe|r"
      elseif r.signup == "bench" then me = "|cff999999you're on the bench|r" .. (r.role and (" as " .. r.role) or "")
      elseif r.signup == "no" then me = "|cff999999you can't make it|r"
      elseif r.signup == nil or r.signup == "" then me = "|cffe8a33dnot signed up yet: sign up in the Guild Camp app|r"
      else me = "|cff999999signed up: " .. tostring(r.signup) .. "|r" end
      add("  " .. tostring(r.title or "Raid") .. "  |cff999999" .. date("%a %d %b %H:%M", r.startsAt or 0) .. ", " .. (r.coming or 0) .. " coming|r")
      add("    " .. me)
      if r.reserves and #r.reserves > 0 then
        local parts = {}
        for _, x in ipairs(r.reserves) do parts[#parts + 1] = tostring(x.name or "?") .. ((x.bonus or 0) > 0 and (" (+" .. x.bonus .. ")") or "") end
        add("    |cff999999reserved:|r " .. table.concat(parts, ", "))
      end
    end
  else add("  |cff999999Nothing scheduled|r") end
  return table.concat(lines, "\n")
end

function ns.textNotices()
  local inbox = WowGuildInbox
  local lines = { "|cffffd100Notices|r" }
  if inbox and inbox.announcements and #inbox.announcements > 0 then
    for _, a in ipairs(inbox.announcements) do lines[#lines + 1] = "  " .. tostring(a.body or "") .. "  |cff999999" .. who(a.by) .. "|r" end
  else lines[#lines + 1] = "  |cff999999None|r" end
  return table.concat(lines, "\n")
end

function ns.textGuild()
  local inbox = WowGuildInbox
  if not inbox then return "No guild news yet.\n\nMake sure the Guild Camp app is running and signed in, then click Sync now on the Camp tab." end
  local lines = {}
  local function add(s) lines[#lines + 1] = s end
  add("|cffffd100Requests you can craft|r")
  if inbox.canCraft and #inbox.canCraft > 0 then
    for _, r in ipairs(inbox.canCraft) do
      add("  " .. tostring(r.item or "?") .. "  |cff999999for " .. who(r.requester) .. "|r" .. (r.notes and r.notes ~= "" and ("  " .. r.notes) or ""))
    end
    add("  |cff999999Claim them in the Guild Camp app so nobody doubles up.|r")
  else add("  |cff999999None right now|r") end
  add("")
  add("|cffffd100Your requests|r")
  if inbox.myRequests and #inbox.myRequests > 0 then
    for _, r in ipairs(inbox.myRequests) do
      add("  " .. tostring(r.item or "?") .. "  |cff999999" .. (r.status == "claimed" and ("being made by " .. who(r.crafter)) or "waiting for a crafter") .. "|r")
    end
  else add("  |cff999999None|r") end
  add("")
  add("|cffffd100Looking for leveling partners|r")
  if inbox.buddies and #inbox.buddies > 0 then
    for _, b in ipairs(inbox.buddies) do
      add(string.format("  %s (%s)%s%s", tostring(b.character or "?"), tostring(b.level or "?"),
        (b.zone and b.zone ~= "") and (" in " .. b.zone) or "", (b.whenText and b.whenText ~= "") and (", " .. b.whenText) or ""))
      if b.note and b.note ~= "" then add("    |cff999999" .. b.note .. "|r") end
    end
  else add("  |cff999999Nobody posted|r") end
  return table.concat(lines, "\n")
end

-- Kept for /wow: opens the main window.
function ns.togglePanel() ns.ui.toggle() end

-- The update notice shows at most once per session, however often login news runs.
function ns.showUpdateNotice()
  if ns.updateNoticeShown or not ns.opt("updateNotice") then return false end
  local latest = ns.updateAvailable()
  if not latest then return false end
  ns.updateNoticeShown = true
  ns.print(string.format("|cffe8a33dA newer version of this addon (%s) is out.|r %s", latest, ns.UPDATE_HINT))
  return true
end

function ns.showLoginNews()
  local inbox = WowGuildInbox
  ns.showUpdateNotice()
  if not ns.opt("loginNews") then return end
  if not inbox then
    ns.print("Click the campfire on your minimap for the guild window. No guild news yet: is the Guild Camp app running?")
    return
  end
  local craft = inbox.canCraft and #inbox.canCraft or 0
  local notices = inbox.announcements and #inbox.announcements or 0
  local parts = {}
  if craft > 0 then parts[#parts + 1] = craft .. (craft == 1 and " crafting request you can make" or " crafting requests you can make") end
  local nextRaid = inbox.raids and inbox.raids[1]
  if nextRaid and not nextRaid.signup then
    parts[#parts + 1] = tostring(nextRaid.title or "The next raid") .. " on " .. date("%a %H:%M", nextRaid.startsAt or 0) .. ": you're not signed up yet"
  end
  if notices > 0 and inbox.announcements[1].body then parts[#parts + 1] = "latest notice: " .. inbox.announcements[1].body end
  if #parts > 0 then ns.print(table.concat(parts, ". ") .. ". Click the campfire on your minimap for more.")
  else ns.print("Click the campfire on your minimap for the guild window.") end
end
