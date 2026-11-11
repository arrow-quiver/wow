-- Guild Camp: options panel (Settings → AddOns → Guild Camp, or /wow options).
local ADDON, ns = ...

-- `group` and `desc` are for the Settings page of the main window (MainUI.lua): options sit under their group with
-- a line of explanation, and the search box looks through all three.
ns.OPTION_LIST = {
  { key = "minimapButton", group = "Window", label = "Show the campfire button on the minimap", desc = "Click it for the guild window, right-click for these settings. /wow always works too." },
  { key = "tooltips", group = "Tooltips and links", label = "Show guild crafters, alts and guild bank on item tooltips", desc = "Who can make it, which of your characters has it, and how many the guild bank holds." },
  { key = "loginNews", group = "Window", label = "Show guild news in chat when I log in", desc = "One line: requests you can craft, the next raid, the latest notice." },
  { key = "updateNotice", group = "Window", label = "Tell me when a newer version of this addon is out", desc = "Once per session. The Guild Camp app installs it for you." },
  { key = "autoGuide", group = "Professions and auction house", label = "Open the skill-up guide with my profession window", desc = "The cheapest way to your next skill points, beside the window." },
  { key = "trackerOnLogin", group = "Professions and auction house", label = "Show my shopping list on login when it has items", desc = "The small list of mats you still need." },
  { key = "collectBank", group = "Professions and auction house", label = "Share my bank and the guild bank with the guild", desc = "So guildies see what's in stock. Turn it off to keep your own bank private." },
  { key = "ahTab", group = "Professions and auction house", label = "Show the Guild Camp list (shopping list and guild requests) at the auction house", desc = "Search for what you and your guildies need without typing names." },
  { key = "dealsPanel", group = "Professions and auction house", label = "Show the Deal hunter next to the auction house", desc = "What's cheap enough to buy and sell again. One purchase per click." },
  { key = "coachTalents", group = "Coach", label = "Show the Coach's talent guide next to the talent window", desc = "Your build plan's next points, where you spend them." },
  { key = "celebrate", group = "Guild life", label = "Celebrate milestones: say mine in guild chat, cheer for guildmates' (and the welcome wagon)", desc = "Level ups, first kills and new members. One line each, never in instances." },
  { key = "ctaChat", group = "War", label = "Also post my calls to arms in guild chat (and, with the app, on Discord)", desc = "Guildies without the addon see the call too." },
  { key = "kosAlerts", group = "War", label = "Warn me when a kill-on-sight or bounty target is near", desc = "When you target or mouse over them." },
  { key = "dungeonQuests", group = "Guild life", label = "Entering a dungeon, tell me which of its quests I have (/wow quests)", desc = "And lets your group see who has which." },
  { key = "priceAlerts", group = "Professions and auction house", label = "At the auction house, tell me when something on my buy list is cheap", desc = "Mats on your shopping list and the targets you set yourself." },
  { key = "matsNudges", group = "Professions and auction house", label = "Tell me when I hold mats a guildie needs, or can craft what they want", desc = "A chat line, at most once a day for each guildie and item." },
  { key = "radar", group = "Guild life", label = "Tell me which guildies are in the zone when I arrive (/wow near to group up)", desc = "One chat line on arriving in a zone." },
  { key = "instanceHelper", group = "Guild life", label = "In a dungeon, show guildies online the right level for it", desc = "For filling an empty spot with a guildmate." },
  { key = "reminders", group = "Guild life", label = "Remind me to repair, empty bags, spend talents and get ready for raids", desc = "In town and before a raid you signed up for." },
  { key = "craftLookup", group = "Tooltips and links", label = "Alt-click an item link to see who in the guild can craft it", desc = "And ask them for it with one click." },
  { key = "seasonTooltips", group = "Tooltips and links", label = "Show guildies' season titles and badges on their tooltips", desc = "This month's standings, on the player tooltip." },
  { key = "warMap", group = "War", label = "Show the guild's deaths and kills of the last week on the world map", desc = "Where the fighting is. /wow war off hides the marks for now." },
  { key = "warHelp", group = "War", label = "When I die to players, offer to call the guild for help", desc = "A small prompt. Nothing is sent unless you click." },
  { key = "liveLink", group = "Coach", label = "Turn on combat logging when I log in (the Guild Camp app's live link reads it)", desc = "For the Coach overlay and \"Why did I die?\"." },
  { key = "blizzardStyle", group = "Window", label = "Use Blizzard's window style instead of the guild's dark-and-gold look (reload to apply)", desc = "The same window in the game's own frame." },
  { key = "shareLocation", group = "War", label = "Share my position with the guild (open world only)", desc = "Guildies see you on their world map. Off until you turn it on; never in instances." },
  { key = "smartOpen", group = "Window", label = "Open the window on what I'm doing", desc = "Dungeon quests in a dungeon, deals at the auction house, a fresh call to arms." },
}
local OPTIONS = ns.OPTION_LIST

local panel = CreateFrame("Frame")
panel.name = "Guild Camp"

local title = panel:CreateFontString(nil, "ARTWORK", "GameFontNormalLarge")
title:SetPoint("TOPLEFT", 16, -16)
title:SetText("Guild Camp")
local sub = panel:CreateFontString(nil, "ARTWORK", "GameFontHighlightSmall")
sub:SetPoint("TOPLEFT", title, "BOTTOMLEFT", 0, -8)
sub:SetWidth(560); sub:SetJustifyH("LEFT")
sub:SetText("The addon reads information only outside combat. It shares guild data with guildmates in game. The Guild Camp app shows it after you log out or type /reload.")

panel.boxes = {}
for i, o in ipairs(OPTIONS) do
  local cb = CreateFrame("CheckButton", nil, panel, "UICheckButtonTemplate")
  cb:SetPoint("TOPLEFT", 12, -60 - (i - 1) * 32)
  local label = cb:CreateFontString(nil, "ARTWORK", "GameFontHighlight")
  label:SetPoint("LEFT", cb, "RIGHT", 4, 1)
  label:SetText(o.label)
  cb:SetScript("OnClick", function(self)
    ns.db.options = ns.db.options or {}
    ns.db.options[o.key] = self:GetChecked() and true or false
    if ns.applyOptions then ns.applyOptions() end
  end)
  cb.key = o.key
  panel.boxes[i] = cb
end

local version = panel:CreateFontString(nil, "ARTWORK", "GameFontDisableSmall")
version:SetPoint("TOPLEFT", 16, -60 - #OPTIONS * 32 - 16)

panel:SetScript("OnShow", function()
  for _, cb in ipairs(panel.boxes) do cb:SetChecked(ns.opt(cb.key) and true or false) end
  local latest = ns.updateAvailable()
  version:SetText("Version " .. ns.addonVersion() .. (latest and ("\n" .. latest .. " is available. " .. ns.UPDATE_HINT) or ""))
end)

local category
if Settings and Settings.RegisterCanvasLayoutCategory and Settings.RegisterAddOnCategory then
  category = Settings.RegisterCanvasLayoutCategory(panel, panel.name)
  Settings.RegisterAddOnCategory(category)
elseif InterfaceOptions_AddCategory then
  InterfaceOptions_AddCategory(panel)
end

function ns.openOptions()
  if category and Settings and Settings.OpenToCategory then
    Settings.OpenToCategory(category.GetID and category:GetID() or category.ID)
  elseif InterfaceOptionsFrame_OpenToCategory then
    InterfaceOptionsFrame_OpenToCategory(panel)
    InterfaceOptionsFrame_OpenToCategory(panel) -- the old frame needs two calls to land on the page
  else
    ns.print("Options: use /wow help for commands.")
  end
end
ns.optionsPanel = panel
