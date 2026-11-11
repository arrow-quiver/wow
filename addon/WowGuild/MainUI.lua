-- Guild Camp: the main window. One window for everything: sections down the left, each section's pages as tabs
-- along the top. Everything the slash commands do is a page or a button here.
-- Open it from the minimap campfire, the addon list (Retail), a key binding, or /wow.
local ADDON, ns = ...
local W = {}
ns.ui = W

local WIDTH, HEIGHT, RAIL = 806, 520, 172
-- The width the pages lay themselves out in (the window without the rail).
local PW = WIDTH - RAIL

-- Sections (the rail) and their pages (the tabs). A page key opens that page; a section id opens its first page.
-- `when` hides a page whose feature isn't loaded.
local SECTIONS = {
  { id = "camp", label = "Camp", icon = "Spell_Fire_Fire", pages = {
    { key = "camp", label = "Today" },
    { key = "board", label = "Bulletin board", when = function() return ns.board end },
    { key = "season", label = "Leaderboard", when = function() return ns.seasons end },
  } },
  { id = "coach", label = "Coach", icon = "INV_Misc_Book_09", pages = {
    { key = "coach", label = "Coach" },
  } },
  { id = "war", label = "War", icon = "Ability_Warrior_BattleShout", pages = {
    { key = "cta", label = "Call to arms" },
    { key = "hunt", label = "The hunt", when = function() return ns.hunt end },
    { key = "near", label = "Guildies nearby", when = function() return ns.helpers end },
  } },
  { id = "dungeons", label = "Raids & Dungeons", icon = "INV_Misc_Key_03", pages = {
    { key = "raids", label = "Raids" },
    { key = "groups", label = "Dungeon groups", when = function() return ns.lfg end },
    { key = "quests", label = "Dungeon quests", when = function() return ns.dungeonQuests end },
  } },
  { id = "prof", label = "Professions", icon = "Trade_BlackSmithing", pages = {
    { key = "prof", label = "Shopping list" },
    { key = "mats", label = "Guildies need", when = function() return ns.mats end },
  } },
  { id = "market", label = "Market", icon = "INV_Misc_Coin_01", pages = {
    { key = "deals", label = "Deal hunter", when = function() return ns.deals end },
    { key = "alerts", label = "Price alerts", when = function() return ns.priceAlerts end },
  } },
  { id = "guild", label = "Guild", icon = "INV_Shirt_GuildTabard_01", pages = {
    { key = "guild", label = "Requests & partners" },
    { key = "recruit", label = "Recruiting", when = function() return ns.recruit end },
  } },
  { id = "settings", label = "Settings", icon = "Trade_Engineering", foot = true, pages = {
    { key = "settings", label = "Settings" },
  } },
}
W.SECTIONS = SECTIONS
local LIST_ROWS = 6

local function skin(f, alpha)
  if ns.skin and ns.skin.enabled() then return ns.skin.window(f) end
  if f.SetBackdrop then
    f:SetBackdrop({ bgFile = "Interface\\Buttons\\WHITE8x8", edgeFile = "Interface\\Buttons\\WHITE8x8", edgeSize = 2 })
    f:SetBackdropColor(0.12, 0.23, 0.2, alpha or 0.97)
    f:SetBackdropBorderColor(0.91, 0.64, 0.24, 1)
  end
end

-- Try Blizzard templates first so the window looks like the rest of the game; fall back if a client lacks one.
local function tryFrame(kind, name, parent, ...)
  for _, template in ipairs({ ... }) do
    local ok, f = pcall(CreateFrame, kind, name, parent, template)
    if ok and f then return f, template end
  end
  return CreateFrame(kind, name, parent), nil
end

local function button(parent, text, width)
  local b = CreateFrame("Button", nil, parent, "UIPanelButtonTemplate")
  b:SetSize(width or 120, 24)
  b:SetText(text)
  return b
end

local function label(parent, text, font)
  local fs = parent:CreateFontString(nil, "OVERLAY", font or "GameFontHighlight")
  fs:SetJustifyH("LEFT")
  if text then fs:SetText(text) end
  return fs
end

local function editbox(parent, width, numeric)
  local e = CreateFrame("EditBox", nil, parent, "InputBoxTemplate")
  e:SetSize(width, 24)
  e:SetAutoFocus(false)
  if numeric then e:SetNumeric(true); e:SetMaxLetters(2) else e:SetMaxLetters(200) end
  e:SetScript("OnEscapePressed", e.ClearFocus)
  e:SetScript("OnEnterPressed", e.ClearFocus)
  return e
end

-- A scrolling block of text inside a page.
local function scrollText(page, top, bottom)
  local scroll = CreateFrame("ScrollFrame", nil, page, "UIPanelScrollFrameTemplate")
  scroll:SetPoint("TOPLEFT", 0, top or 0)
  scroll:SetPoint("BOTTOMRIGHT", -26, bottom or 0)
  local content = CreateFrame("Frame", nil, scroll)
  content:SetSize(PW - 70, 10)
  scroll:SetScrollChild(content)
  local text = label(content, nil, "GameFontHighlight")
  text:SetPoint("TOPLEFT")
  text:SetWidth(PW - 70)
  text:SetSpacing(3)
  return {
    set = function(s)
      text:SetText(s)
      content:SetHeight((text:GetStringHeight() or 0) + 10)
    end,
    text = text,
  }
end

-- A scrolling list of item rows: icon, quality-coloured name, a right-hand note.
-- Hover shows the real item tooltip; shift-click links the item in chat.
local function itemList(page, top, bottom)
  local scroll = CreateFrame("ScrollFrame", nil, page, "UIPanelScrollFrameTemplate")
  scroll:SetPoint("TOPLEFT", 0, top or 0)
  scroll:SetPoint("BOTTOMRIGHT", -26, bottom or 0)
  local content = CreateFrame("Frame", nil, scroll)
  content:SetSize(PW - 70, 10)
  scroll:SetScrollChild(content)
  local empty = label(content, "", "GameFontDisable"); empty:SetPoint("TOPLEFT", 4, -4); empty:SetWidth(PW - 80)
  local rows = {}
  local function row(i)
    if rows[i] then return rows[i] end
    local r = CreateFrame("Button", nil, content)
    r:SetSize(PW - 74, 22)
    r:SetPoint("TOPLEFT", 0, -(i - 1) * 23)
    r:SetHighlightTexture("Interface\\QuestFrame\\UI-QuestTitleHighlight", "ADD")
    r.icon = r:CreateTexture(nil, "ARTWORK"); r.icon:SetSize(18, 18); r.icon:SetPoint("LEFT", 2, 0)
    r.name = label(r, "", "GameFontHighlight"); r.name:SetPoint("LEFT", 26, 0); r.name:SetWidth(250)
    r.note = label(r, "", "GameFontHighlightSmall"); r.note:SetPoint("RIGHT", -4, 0); r.note:SetJustifyH("RIGHT"); r.note:SetWidth(PW - 360)
    r:SetScript("OnEnter", function(self) ns.items.showTooltip(self, self.itemId) end)
    r:SetScript("OnLeave", function() ns.items.hideTooltip() end)
    r:SetScript("OnClick", function(self) if ns.items.shiftDown() then ns.items.insertLink(self.itemId) end end)
    rows[i] = r
    return r
  end
  return {
    rows = rows,
    set = function(items, emptyText)
      for i, it in ipairs(items) do
        local r = row(i)
        r.itemId = it.id
        r.icon:SetTexture(ns.items.icon(it.id))
        r.name:SetText(it.done and ("|cff40bf40" .. (it.name or "") .. "|r") or ns.items.coloredName(it.id, it.name))
        r.note:SetText(it.note or "")
        r:Show()
      end
      for i = #items + 1, #rows do rows[i]:Hide() end
      empty:SetText(#items == 0 and (emptyText or "") or "")
      content:SetHeight(math.max(10, #items * 23))
    end,
  }
end

-- ---------- pages ----------
local pages = {}
-- The window itself. Declared up here so page buttons (like "Open the Coach") can hide it.
local win

-- Camp: raids, notices, sync status.
function pages.camp(page)
  local body = scrollText(page, 0, 36)
  local sync = button(page, "Sync now", 110)
  sync:SetPoint("BOTTOMLEFT", 0, 0)
  sync:SetScript("OnClick", function()
    ns.collectAll("button")
    ns.offerReload()
  end)
  local hint = label(page, "Saves everything and reloads so the Guild Camp app uploads it.", "GameFontDisableSmall")
  hint:SetPoint("LEFT", sync, "RIGHT", 10, 0)
  page.sync = sync
  page.refresh = function()
    local inbox = WowGuildInbox
    local me = ns.db.characters[ns.charKey()] or {}
    local status = {}
    status[#status + 1] = "|cffe8a33d" .. ((inbox and inbox.guild) or "Guild") .. "|r"
    if inbox then
      status[#status + 1] = "|cff999999Guild news from " .. ns.ago(inbox.generatedAt) .. ".|r"
    else
      status[#status + 1] = "|cffe8a33dNo guild news yet.|r Install the Guild Camp app on this computer, sign in, and keep it running while you play."
    end
    local latest = ns.updateAvailable()
    if latest then
      status[#status + 1] = "|cffe8a33dAddon version " .. latest .. " is out.|r " .. ns.UPDATE_HINT
    end
    local sharing = ns.Share and ns.try(ns.Share.statusLine)
    if type(sharing) == "string" and sharing ~= "" then status[#status + 1] = "|cff999999" .. sharing .. "|r" end
    local recipes, profs = 0, 0
    for _, list in pairs(me.recipes or {}) do recipes = recipes + #list end
    profs = me.professions and #me.professions or 0
    status[#status + 1] = string.format("|cff999999This character: %d professions, %d recipes saved. %d guild members on the last roster scan.|r",
      profs, recipes, #((ns.db.roster or {}).members or {}))
    body.set(table.concat(status, "\n") .. "\n\n" .. ns.textRaids() .. "\n\n" .. ns.textNotices())
  end
end

-- Call to arms: a form instead of /wow cta.
function pages.cta(page)
  local intro = label(page, "Call guildies to a fight. Guildmates online with Guild Camp see it in chat right away.", "GameFontHighlight")
  intro:SetPoint("TOPLEFT", 0, 0); intro:SetWidth(PW - 40)

  local zl = label(page, "Where", "GameFontNormal"); zl:SetPoint("TOPLEFT", 0, -44)
  local zone = editbox(page, 260); zone:SetPoint("TOPLEFT", 6, -62)
  local here = button(page, "Use my zone", 110); here:SetPoint("LEFT", zone, "RIGHT", 10, 0)
  here:SetScript("OnClick", function() zone:SetText(GetZoneText and GetZoneText() or "") end)

  local nl = label(page, "How many do you need", "GameFontNormal"); nl:SetPoint("TOPLEFT", 0, -98)
  local needed = editbox(page, 50, true); needed:SetPoint("TOPLEFT", 6, -116)
  needed:SetText("5")

  local ml = label(page, "What's happening", "GameFontNormal"); ml:SetPoint("TOPLEFT", 0, -152)
  local msg = editbox(page, PW - 60); msg:SetPoint("TOPLEFT", 6, -170)

  local send = button(page, "Sound the horn", 150); send:SetPoint("TOPLEFT", 0, -210)
  local sent = label(page, "", "GameFontHighlightSmall"); sent:SetPoint("TOPLEFT", 0, -244); sent:SetWidth(PW - 40)
  send:SetScript("OnClick", function()
    if ns.addCta(zone:GetText() or "", tonumber(needed:GetText() or ""), msg:GetText() or "") then msg:SetText("") end
    page.refresh()
  end)
  page.zone, page.needed, page.msg, page.send = zone, needed, msg, send
  page.refresh = function()
    if (zone:GetText() or "") == "" and GetZoneText then zone:SetText(GetZoneText() or "") end
    local q = ns.ctaRecent or {}
    if #q == 0 then sent:SetText("") return end
    local lines = { "|cffffd100Calls to arms since you logged in|r" }
    for i = #q, 1, -1 do
      local c = q[i]
      local need = c.needed and string.format(" (need %d)", c.needed) or ""
      local msgText = (c.message and c.message ~= "") and (" " .. c.message) or ""
      lines[#lines + 1] = string.format("  %s%s%s |cff999999%s, %s|r", c.zone or "", need, msgText,
        c.mine and "you" or tostring(c.character or "?"), ns.ago(c.at))
    end
    sent:SetText(table.concat(lines, "\n"))
  end
end

-- Professions: guide, tracker, shopping list with per-recipe controls.
function pages.prof(page)
  local P = ns.prof
  local summary = label(page, "", "GameFontHighlight"); summary:SetPoint("TOPLEFT", 0, 0); summary:SetWidth(PW - 40)

  local guideBtn = button(page, "Skill-up guide", 140); guideBtn:SetPoint("TOPLEFT", 0, -46)
  guideBtn:SetScript("OnClick", function() P.toggleGuide(); page.refresh() end)
  local trackBtn = button(page, "Show shopping list", 160); trackBtn:SetPoint("LEFT", guideBtn, "RIGHT", 8, 0)
  trackBtn:SetScript("OnClick", function() P.toggleTracker(); page.refresh() end)
  local clearBtn = button(page, "Clear list", 100); clearBtn:SetPoint("LEFT", trackBtn, "RIGHT", 8, 0)
  clearBtn:SetScript("OnClick", function() ns.confirm("Empty your shopping list?", "Empty it", "Keep it", function() ns.prof.clearList() end) end)

  local head = label(page, "Shopping list", "GameFontNormal"); head:SetPoint("TOPLEFT", 0, -84)
  page.rows = {}
  for i = 1, LIST_ROWS do
    local row = CreateFrame("Frame", nil, page)
    row:SetSize(PW - 40, 24)
    row:SetPoint("TOPLEFT", 0, -102 - (i - 1) * 26)
    row.text = label(row, "", "GameFontHighlight"); row.text:SetPoint("LEFT", 0, 0); row.text:SetWidth(330)
    row.minus = button(row, "-1", 34); row.minus:SetPoint("RIGHT", -150, 0)
    row.plus = button(row, "+1", 34); row.plus:SetPoint("RIGHT", -110, 0)
    row.remove = button(row, "Remove", 90); row.remove:SetPoint("RIGHT", 0, 0)
    row.minus:SetScript("OnClick", function(self) P.removeFromList(self:GetParent().key, -1) end)
    row.plus:SetScript("OnClick", function(self) P.removeFromList(self:GetParent().key, 1) end)
    row.remove:SetScript("OnClick", function(self) P.removeFromList(self:GetParent().key) end)
    page.rows[i] = row
  end
  -- Mats needed: icon rows with real item tooltips; scrolls so a long list never runs off the window.
  local matsHead = label(page, "Mats still needed", "GameFontNormal"); matsHead:SetPoint("TOPLEFT", 0, -108 - LIST_ROWS * 26)
  local ahBtn = button(page, "Search auction house", 170); ahBtn:SetPoint("TOPRIGHT", -150, -102 - LIST_ROWS * 26)
  ahBtn:SetScript("OnClick", function() P.searchAuctionHouse() end)
  local listBtn = button(page, "Auctionator list", 140); listBtn:SetPoint("TOPRIGHT", 0, -102 - LIST_ROWS * 26)
  listBtn:SetScript("OnClick", function() P.makeAuctionatorList() end)
  local mats = itemList(page, -130 - LIST_ROWS * 26, 0)
  page.mats, page.ahBtn, page.listBtn = mats, ahBtn, listBtn
  page.trackBtn, page.guideBtn = trackBtn, guideBtn

  page.refresh = function()
    local me = ns.db.characters[ns.charKey()] or {}
    local parts = {}
    for _, p in ipairs(me.professions or {}) do parts[#parts + 1] = string.format("%s %s/%s", p.name, tostring(p.skill or "?"), tostring(p.max or "?")) end
    summary:SetText(#parts > 0 and ("Your professions: " .. table.concat(parts, ",  ")) or "No professions saved yet. Open each profession window once.")
    trackBtn:SetText(P.trackerShown() and "Hide shopping list" or "Show shopping list")
    guideBtn:SetText(P.guideShown() and "Hide skill-up guide" or "Skill-up guide")
    local list = P.list()
    for i, row in ipairs(page.rows) do
      local e = list[i]
      if e then
        row.key = e.key
        row.text:SetText(string.format("%d × %s%s", e.qty, e.name, e.prof and ("  |cff999999" .. e.prof .. "|r") or ""))
        row:Show()
      else
        row.key = nil
        row:Hide()
      end
    end
    local items = {}
    for _, r in ipairs(P.remaining()) do
      local where = {}
      if not r.done and r.alts > 0 then where[#where + 1] = r.alts .. " on alts" end
      if not r.done and r.guildBank > 0 then where[#where + 1] = r.guildBank .. " in guild bank" end
      items[#items + 1] = { id = r.id, name = r.name, done = r.done,
        note = string.format("%s%d / %d|r%s", r.done and "|cff40bf40" or "|cffffffff", math.min(r.have, r.need), r.need,
          #where > 0 and ("  |cffe8a33d" .. table.concat(where, ", ") .. "|r") or "") }
    end
    mats.set(items, #list == 0 and "Empty. Open a profession window and click \"+5 list\" in the skill-up guide to add recipes." or nil)
    local showAH = P.hasAuctionator() and #items > 0
    if showAH then ahBtn:Show(); listBtn:Show() else ahBtn:Hide(); listBtn:Hide() end
  end
end

-- Guild: crafting requests and leveling partners.
-- Coach: a summary here; the full Coach has its own window.
function pages.coach(page)
  local body = scrollText(page, 0, 36)
  local open = button(page, "Open the Coach", 150)
  open:SetPoint("BOTTOMLEFT", 0, 0)
  open:SetScript("OnClick", function() if win then win:Hide() end; ns.coachUI.show() end)
  page.open = open
  local build = button(page, "Build plan", 110); build:SetPoint("LEFT", open, "RIGHT", 8, 0)
  build:SetScript("OnClick", function() if win then win:Hide() end; ns.coachUI.show("build") end)
  local ask = button(page, "Ask a question", 130); ask:SetPoint("LEFT", build, "RIGHT", 8, 0)
  ask:SetScript("OnClick", function() if win then win:Hide() end; ns.coachUI.show("ask") end)
  page.build, page.ask = build, ask
  page.refresh = function() ns.coach.refresh(); body.set(ns.coach.summary()) end
end

function pages.guild(page)
  local body = scrollText(page, 0, 0)
  page.refresh = function() body.set(ns.textGuild()) end
end

-- ---------- pages built from the slash commands ----------
-- What a command would print in chat, as text for a page: the same words in both places.
local function capture(fn, ...)
  if type(fn) ~= "function" then return "" end
  local lines, old = {}, ns.print
  ns.print = function(s) lines[#lines + 1] = tostring(s) end
  local ok, err = pcall(fn, ...)
  ns.print = old
  if not ok then error(err, 0) end
  return table.concat(lines, "\n")
end
W.capture = capture

-- A page of text with, optionally, one input line and buttons under it.
--   spec.text()                         the body
--   spec.input = { label, button, run }  a labelled box; run(text) on the button or Enter
--   spec.buttons = { { label, run, width } }
--   spec.hint                           a grey line at the very bottom
local function textPage(page, spec)
  local foot = (spec.input and 52 or 0) + (spec.buttons and 30 or 0) + (spec.hint and 18 or 0)
  local body = scrollText(page, 0, foot > 0 and foot + 6 or 0)
  local y = spec.hint and 18 or 0
  if spec.hint then
    local hint = label(page, spec.hint, "GameFontDisableSmall"); hint:SetPoint("BOTTOMLEFT", 0, 0); hint:SetWidth(PW - 40)
  end
  if spec.buttons then
    local prev
    page.buttons = {}
    for i, b in ipairs(spec.buttons) do
      local btn = button(page, b[1], b[3] or 150)
      if prev then btn:SetPoint("LEFT", prev, "RIGHT", 8, 0) else btn:SetPoint("BOTTOMLEFT", 0, y) end
      btn:SetScript("OnClick", function() ns.safely(b[2]); page.refresh() end)
      page.buttons[i] = btn
      prev = btn
    end
    y = y + 30
  end
  if spec.input then
    local box = editbox(page, PW - 220); box:SetPoint("BOTTOMLEFT", 6, y)
    local go = button(page, spec.input.button, 150); go:SetPoint("LEFT", box, "RIGHT", 10, 0)
    local l = label(page, spec.input.label, "GameFontNormalSmall"); l:SetPoint("BOTTOMLEFT", 0, y + 28); l:SetWidth(PW - 40)
    local function run()
      local t = box:GetText() or ""
      if t == "" and not spec.input.allowEmpty then return end
      ns.safely(spec.input.run, t)
      if not spec.input.keep then box:SetText("") end
      page.refresh()
    end
    go:SetScript("OnClick", run)
    box:SetScript("OnEnterPressed", function(self) run(); self:ClearFocus() end)
    page.input, page.go = box, go
  end
  page.body = body
  page.refresh = function() body.set(spec.text() or "") end
end

-- A page of rows, each a line of text with one button: rows() → { { text, button = { label, run } } }.
local ROW_COUNT = 12
local function rowsPage(page, spec)
  local intro = label(page, spec.intro or "", "GameFontHighlight"); intro:SetPoint("TOPLEFT", 0, 0); intro:SetWidth(PW - 40)
  local empty = label(page, "", "GameFontDisable"); empty:SetPoint("TOPLEFT", 0, -40); empty:SetWidth(PW - 40)
  page.rows = {}
  for i = 1, ROW_COUNT do
    local r = CreateFrame("Frame", nil, page)
    r:SetSize(PW - 40, 24); r:SetPoint("TOPLEFT", 0, -40 - (i - 1) * 26)
    r.text = label(r, "", "GameFontHighlight"); r.text:SetPoint("LEFT", 0, 0); r.text:SetWidth(PW - 180)
    r.btn = button(r, "", 120); r.btn:SetPoint("RIGHT", 0, 0)
    r:Hide()
    page.rows[i] = r
  end
  local more = label(page, "", "GameFontDisableSmall"); more:SetPoint("BOTTOMLEFT", 0, 0); more:SetWidth(PW - 40)
  page.refresh = function()
    local rows, title = spec.rows()
    rows = rows or {}
    if title then intro:SetText(title) end
    for i, r in ipairs(page.rows) do
      local x = rows[i]
      if x then
        r.text:SetText(x.text)
        if x.button then
          r.btn:SetText(x.button[1])
          r.btn:SetScript("OnClick", function() ns.safely(x.button[2]) end)
          r.btn:Show()
        else r.btn:Hide() end
        r:Show()
      else r:Hide() end
    end
    empty:SetText(#rows == 0 and (spec.empty or "") or "")
    more:SetText(#rows > ROW_COUNT and string.format("And %d more.", #rows - ROW_COUNT) or "")
  end
end

local function coins(c)
  c = math.floor(tonumber(c) or 0)
  local g, s = math.floor(c / 10000), math.floor((c % 10000) / 100)
  if g > 0 then return string.format("%dg %ds", g, s) end
  if s > 0 then return string.format("%ds %dc", s, c % 100) end
  return string.format("%dc", c)
end

-- Camp › Bulletin board: read it, and put a post up.
function pages.board(page)
  textPage(page, {
    text = function() return capture(ns.board.list) end,
    input = { label = "Put up a post: lfg, wts, wtb or help, then your text. A price at the end is optional (wts Mooncloth x4 12g).",
      button = "Post it", run = function(t) ns.board.slash(t) end },
    hint = "Take one of yours down with /wow board down <number>.",
  })
end

-- Camp › Leaderboard: this month's season. Rank, name (class colour), title, streak, what they did, points with a
-- bar against the leader. The top three are gold, silver and bronze; my row is lit. When I'm further down than the
-- rows that fit, the last row is mine.
local BOARD_ROWS = 12
local MEDAL = { { 1, 0.82, 0.2 }, { 0.78, 0.8, 0.85 }, { 0.8, 0.5, 0.25 } }
local MONTHS = { "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December" }
local function monthName(m)
  local y, mo = string.match(tostring(m or ""), "^(%d+)%-(%d+)$")
  return (mo and MONTHS[tonumber(mo)]) and (MONTHS[tonumber(mo)] .. " " .. y) or tostring(m or "")
end
local function classColour(token)
  local key = token and string.upper((string.gsub(tostring(token), "%s", "")))
  local c = key and RAID_CLASS_COLORS and RAID_CLASS_COLORS[key]
  if c then return c.r, c.g, c.b end
  return 1, 1, 1
end
-- "120g given · 14 kills · 2 crafts · 3 raids", leaving out the zeros.
local function deeds(r)
  local parts = {}
  if (r.gold or 0) > 0 then parts[#parts + 1] = r.gold .. "g given" end
  if (r.kills or 0) > 0 then parts[#parts + 1] = r.kills .. (r.kills == 1 and " kill" or " kills") end
  if (r.crafts or 0) > 0 then parts[#parts + 1] = r.crafts .. (r.crafts == 1 and " craft" or " crafts") end
  if (r.raids or 0) > 0 then parts[#parts + 1] = r.raids .. (r.raids == 1 and " raid" or " raids") end
  return table.concat(parts, " · ")
end

function pages.season(page)
  local S = ns.skin
  local head = label(page, "", "GameFontNormalLarge"); head:SetPoint("TOPLEFT", 0, 0)
  local left = label(page, "", "GameFontHighlightSmall"); left:SetPoint("TOPRIGHT", -4, -4)
  local W_ROW = PW - 40
  local cols = label(page, "", "GameFontDisableSmall"); cols:SetPoint("TOPLEFT", 6, -28)
  cols:SetText("#")
  local cn = label(page, "Player", "GameFontDisableSmall"); cn:SetPoint("TOPLEFT", 44, -28)
  local cd = label(page, "This month", "GameFontDisableSmall"); cd:SetPoint("TOPLEFT", 250, -28)
  local cp = label(page, "Points", "GameFontDisableSmall"); cp:SetPoint("TOPRIGHT", -8, -28)
  local empty = label(page, "", "GameFontDisable"); empty:SetPoint("TOPLEFT", 0, -56); empty:SetWidth(W_ROW)

  page.rows = {}
  for i = 1, BOARD_ROWS do
    local r = CreateFrame("Frame", nil, page)
    r:SetSize(W_ROW, 24); r:SetPoint("TOPLEFT", 0, -44 - (i - 1) * 26)
    r.stripe = S.colorTex(r, "BACKGROUND", 1, 1, 1, i % 2 == 0 and 0.04 or 0); r.stripe:SetAllPoints()
    r.mine = S.colorTex(r, "BACKGROUND", S.EMBER[1], S.EMBER[2], S.EMBER[3], 0.22); r.mine:SetAllPoints(); r.mine:Hide()
    -- The bar sits behind the points, as long as this player's share of the leader's score.
    r.bar = S.colorTex(r, "BORDER", S.GOLD[1], S.GOLD[2], S.GOLD[3], 0.18); r.bar:SetHeight(18); r.bar:SetPoint("RIGHT", -4, 0)
    r.rank = label(r, "", "GameFontNormalLarge"); r.rank:SetPoint("LEFT", 6, 0); r.rank:SetWidth(34)
    r.name = label(r, "", "GameFontHighlight"); r.name:SetPoint("LEFT", 44, 3); r.name:SetWidth(200)
    r.title = label(r, "", "GameFontDisableSmall"); r.title:SetPoint("LEFT", 44, -8); r.title:SetWidth(200)
    r.deeds = label(r, "", "GameFontHighlightSmall"); r.deeds:SetPoint("LEFT", 250, 0); r.deeds:SetWidth(W_ROW - 250 - 90)
    r.score = label(r, "", "GameFontNormal"); r.score:SetPoint("RIGHT", -8, 0); r.score:SetJustifyH("RIGHT")
    r:Hide()
    page.rows[i] = r
  end
  local leaders = label(page, "", "GameFontHighlightSmall"); leaders:SetPoint("BOTTOMLEFT", 0, 16); leaders:SetWidth(W_ROW)
  local foot = label(page, "", "GameFontDisableSmall"); foot:SetPoint("BOTTOMLEFT", 0, 0); foot:SetWidth(W_ROW)
  page.head, page.empty, page.leaders, page.foot = head, empty, leaders, foot

  page.refresh = function()
    local rows, s = ns.seasons.board()
    head:SetText(s and ("Season: " .. monthName(s.month)) or "Season")
    local days = s and tonumber(s.daysLeft)
    left:SetText(days and days > 0 and (days == 1 and "Last day" or (days .. " days left")) or "")
    -- Which rows show: the top ones, and mine in the last row when I'm below them.
    local show, mineAt = {}, nil
    for i, r in ipairs(rows) do if r.me then mineAt = i end end
    for i = 1, math.min(#rows, BOARD_ROWS) do show[i] = rows[i] end
    if mineAt and mineAt > BOARD_ROWS then show[BOARD_ROWS] = rows[mineAt] end
    local top = rows[1] and rows[1].score or 0
    for i, r in ipairs(page.rows) do
      local x = show[i]
      if x then
        local medal = MEDAL[x.rank]
        r.rank:SetText(tostring(x.rank))
        if medal then r.rank:SetTextColor(medal[1], medal[2], medal[3]) else r.rank:SetTextColor(0.6, 0.6, 0.6) end
        r.name:SetText(x.name .. ((x.streak or 0) >= 2 and string.format("  |cffe8a33d%d-week streak|r", x.streak) or ""))
        r.name:SetTextColor(classColour(x.class))
        r.title:SetText(x.title or "")
        r.deeds:SetText(deeds(x))
        r.score:SetText(tostring(x.score))
        r.bar:SetWidth(math.max(2, math.floor((top > 0 and x.score / top or 0) * 160)))
        if x.me then r.mine:Show() else r.mine:Hide() end
        r.me, r.shownRank = x.me and true or false, x.rank
        r:Show()
      else r:Hide() end
    end
    empty:SetText(#rows == 0 and "No standings yet. They come from the Guild Camp app: keep it running and /reload." or "")
    local parts = {}
    for _, l in ipairs((s and type(s.leaders) == "table" and s.leaders) or {}) do
      parts[#parts + 1] = string.format("|cffe8a33d%s|r %s", tostring(l.title), tostring(l.name))
    end
    leaders:SetText(table.concat(parts, "   "))
    local total = s and tonumber(s.count) or #rows
    local where = mineAt and string.format("You're #%d of %d.", rows[mineAt].rank, total)
      or (#rows > 0 and "You're not on the board yet: give to the guild bank, fill a crafting request, raid or fight in the open world." or "")
    foot:SetText(where .. (total > #show and #show > 0 and string.format("  The full board of %d is in the Guild Camp app.", total) or ""))
  end
end

-- War › The hunt: kill on sight and bounties.
function pages.hunt(page)
  textPage(page, {
    text = function() return capture(ns.hunt.slash, "") .. "\n\n" .. capture(ns.hunt.slashBounties) end,
    input = { label = "Add a player to the kill-on-sight list: name, then the reason.", button = "Add to the list",
      run = function(t) ns.hunt.slash("add " .. t) end },
    hint = "Remove a name with /wow kos remove <name>. Officers put bounties up in the Guild Camp app.",
  })
end

-- War › Guildies nearby: online in my zone, one whisper per click.
function pages.near(page)
  rowsPage(page, {
    rows = function()
      local rows, zone = ns.helpers.nearbyRows()
      return rows, string.format("Guildies online in %s, closest in level first.", (zone and zone ~= "") and zone or "this zone")
    end,
    empty = "Nobody from the guild is in this zone right now.",
  })
end

-- Raids & Dungeons › Raids: what's scheduled and whether I'm signed up.
function pages.raids(page)
  textPage(page, { text = function() return ns.textRaids() end, hint = "Sign up and reserve loot in the Guild Camp app." })
end

-- Raids & Dungeons › Dungeon groups: the guild's groups, start one, find players.
function pages.groups(page)
  textPage(page, {
    text = function() return capture(ns.lfg.list) end,
    input = { label = "Start a group: your role, then the dungeon (tank Deadmines).", button = "Start a group",
      run = function(t) ns.lfg.new(t) end },
    buttons = { { "Find players", function() if ns.finder then ns.finder.show() end end, 130 } },
    hint = "Join with /wow lfg join <number> <role>, leave with /wow lfg leave <number>.",
  })
end

-- Raids & Dungeons › Dungeon quests: the checklist for a dungeon (the one I'm in when the box is empty).
function pages.quests(page)
  local Q = ns.dungeonQuests
  local shown
  local function current()
    if shown and shown ~= "" then return shown end
    local inside = IsInInstance and ns.try(IsInInstance)
    if inside and GetInstanceInfo then return ns.try(GetInstanceInfo) or "" end
    return ""
  end
  textPage(page, {
    text = function()
      local name = current()
      local list, key = {}, nil
      if name ~= "" then list, key = Q.checklist(name) end
      if #list == 0 then
        local names = {}
        for k in pairs(Q.DATA or {}) do names[#names + 1] = k end
        table.sort(names)
        return (name ~= "" and ("No quests known for " .. name .. ".\n\n") or "") .. "|cffffd100Dungeons with a checklist|r\n  " .. table.concat(names, ", ")
      end
      local lines = { "|cffffd100Quests: " .. tostring(key) .. "|r", "|cff999999Bring these in. The grey ones you can still pick up.|r", "" }
      for _, q in ipairs(list) do
        lines[#lines + 1] = string.format("  %s  %s", q.title, q.done and "|cff40bf40ready to hand in|r" or q.have and "|cffe8a33din your log|r" or ("|cff999999" .. tostring(q.where) .. "|r"))
      end
      return table.concat(lines, "\n")
    end,
    input = { label = "Which dungeon? Leave it empty inside a dungeon to see that one.", button = "Show quests", allowEmpty = true, keep = true,
      run = function(t) shown = t end },
    buttons = { { "Ask my group who has them", function() local n = current(); if n ~= "" then Q.slash(n) end end, 200 } },
  })
end

-- Professions › Guildies need: mats I hold and crafts I can make for guildmates.
function pages.mats(page)
  rowsPage(page, {
    intro = "Guildies you can help, from what you hold and what you can make.",
    rows = function() return ns.mats.rows() end,
    empty = "No mats or crafts wanted that you can help with right now.",
  })
end

-- Market › Deal hunter: what to buy and sell again.
function pages.deals(page)
  textPage(page, {
    text = function()
      local list = ns.deals.list()
      if not list or #list == 0 then return "No deals yet. They come from the Guild Camp app's price history: keep it running and /reload." end
      local lines = { "|cffffd100Worth buying to sell again|r", "" }
      for i, d in ipairs(list) do
        if i > 20 then lines[#lines + 1] = string.format("  … and %d more in the Deal hunter.", #list - 20); break end
        local state = d.state == "gone" and "  |cff999999gone|r" or d.state == "changed" and "  |cffe8a33dprice changed|r" or ""
        lines[#lines + 1] = string.format("  %s  |cff999999buy under %s, worth %s|r  |cff40bf40+%s|r%s%s", d.name, coins(d.buy), coins(d.worth), coins(math.max(0, d.profit or 0)),
          d.vendor and "  |cff999999sells to a vendor|r" or "", state)
      end
      return table.concat(lines, "\n")
    end,
    buttons = { { "Open the Deal hunter", function() ns.deals.show() end, 180 } },
    hint = "At the auction house the Deal hunter checks today's prices and buys one item per click.",
  })
end

-- Market › Price alerts: what I'm watching, and my own targets.
function pages.alerts(page)
  textPage(page, {
    text = function() return "|cffffd100Watching at the auction house|r\n" .. capture(ns.priceAlerts.slash, "") end,
    input = { label = "Set your own target: the price, then the item (1g50s Wool Cloth).", button = "Set the alert",
      run = function(t) ns.priceAlerts.slash(t) end },
  })
end

-- Guild › Recruiting: the desk has its own window (the /who scan and one message per click).
function pages.recruit(page)
  textPage(page, {
    text = function()
      local R = ns.recruit
      local lines = { "|cffffd100The recruiting desk|r",
        "Scan /who for players without a guild, message them one at a time, and post the guild's ad.",
        "Every message and invite is your own click, and nobody is messaged twice.", "" }
      local ok, sent = pcall(R.sentToday)
      local okq, queue = pcall(R.queue)
      if ok and okq then lines[#lines + 1] = string.format("|cff999999%d of %d messages today, %d players in the queue.|r", sent or 0, R.DAILY or 0, #(queue or {})) end
      return table.concat(lines, "\n")
    end,
    buttons = { { "Open the recruiting desk", function() ns.recruit.show() end, 200 } },
  })
end

-- ---------- settings ----------
-- Where players get the Guild Camp app (its newest GitHub release).
W.APP_URL = "https://github.com/arrow-quiver/wow/releases/latest"
W.SCALE_MIN, W.SCALE_MAX = 0.8, 1.3

function W.scale() return math.min(W.SCALE_MAX, math.max(W.SCALE_MIN, tonumber(ns.db.ui and ns.db.ui.scale) or 1)) end
function W.setScale(v)
  ns.db.ui = ns.db.ui or {}
  ns.db.ui.scale = math.floor(math.min(W.SCALE_MAX, math.max(W.SCALE_MIN, v)) * 10 + 0.5) / 10
  if win and win.SetScale then win:SetScale(W.scale()) end
end

-- Settings: every option in its group with a line of explanation, a search box, the link to the app, versions.
local OPTION_ROW, GROUP_ROW = 44, 26
function pages.settings(page)
  local list = ns.OPTION_LIST or {}
  local sl = label(page, "Search", "GameFontNormal"); sl:SetPoint("TOPLEFT", 0, -6)
  local search = editbox(page, 240); search:SetPoint("TOPLEFT", 60, 0)
  local count = label(page, "", "GameFontDisableSmall"); count:SetPoint("LEFT", search, "RIGHT", 10, 0)

  local scroll = CreateFrame("ScrollFrame", nil, page, "UIPanelScrollFrameTemplate")
  scroll:SetPoint("TOPLEFT", 0, -32)
  scroll:SetPoint("BOTTOMRIGHT", -26, 96)
  local content = CreateFrame("Frame", nil, scroll)
  content:SetSize(PW - 70, 10)
  scroll:SetScrollChild(content)

  page.boxes, page.groups = {}, {}
  local order = {}
  for i, o in ipairs(list) do
    local g = o.group or "Other"
    if not page.groups[g] then
      page.groups[g] = label(content, g, "GameFontNormal")
      order[#order + 1] = g
    end
    local cb = CreateFrame("CheckButton", nil, content, "UICheckButtonTemplate")
    cb.title = label(cb, o.label, "GameFontHighlight"); cb.title:SetPoint("TOPLEFT", cb, "TOPRIGHT", 4, -3); cb.title:SetWidth(PW - 120)
    cb.desc = label(cb, o.desc or "", "GameFontDisableSmall"); cb.desc:SetPoint("TOPLEFT", cb.title, "BOTTOMLEFT", 0, -2); cb.desc:SetWidth(PW - 120)
    if cb.desc.SetWordWrap then cb.desc:SetWordWrap(false) end -- the label may take two lines; the explanation stays on one
    cb.key, cb.group = o.key, g
    cb.words = string.lower(o.label .. " " .. (o.desc or "") .. " " .. g)
    cb:SetScript("OnClick", function(self)
      ns.db.options = ns.db.options or {}
      ns.db.options[self.key] = self:GetChecked() and true or false
      ns.applyOptions()
    end)
    page.boxes[i] = cb
  end

  -- Lays the groups out top to bottom, leaving out what the search doesn't match. → how many options show.
  function page.layout(filter)
    filter = string.lower(filter or "")
    local y, shown = 0, 0
    for _, g in ipairs(order) do
      local head, any = page.groups[g], false
      for _, cb in ipairs(page.boxes) do
        if cb.group == g then
          if filter == "" or string.find(cb.words, filter, 1, true) then
            if not any then
              head:ClearAllPoints(); head:SetPoint("TOPLEFT", 0, y - 6); head:Show()
              y = y - GROUP_ROW; any = true
            end
            cb:ClearAllPoints(); cb:SetPoint("TOPLEFT", 0, y); cb:Show()
            y = y - OPTION_ROW; shown = shown + 1
          else cb:Hide() end
        end
      end
      if not any then head:Hide() end
    end
    content:SetHeight(math.max(10, -y))
    count:SetText(filter == "" and "" or (shown == 0 and "Nothing matches." or string.format("%d of %d", shown, #page.boxes)))
    page.matches = shown
    return shown
  end
  search:SetScript("OnTextChanged", function(self) page.layout(self:GetText() or "") end)
  page.search = search

  local al = label(page, "Get the Guild Camp app (click, then Ctrl+C to copy the link):", "GameFontNormal"); al:SetPoint("BOTTOMLEFT", 0, 72)
  local site = editbox(page, PW - 60); site:SetPoint("BOTTOMLEFT", 6, 46)
  site:SetScript("OnEditFocusGained", function(self) self:HighlightText() end)
  site:SetScript("OnTextChanged", function(self, user) if user then self:SetText(self.value or "") ; self:HighlightText() end end)
  local ver = label(page, "", "GameFontDisableSmall"); ver:SetPoint("BOTTOMLEFT", 0, 30); ver:SetWidth(PW - 40)
  local blizz = button(page, "Key binding and more", 150); blizz:SetPoint("BOTTOMLEFT", 0, 0)
  blizz:SetScript("OnClick", function() ns.openOptions() end)
  local report = button(page, "Problem report", 110); report:SetPoint("LEFT", blizz, "RIGHT", 8, 0)
  report:SetScript("OnClick", function() ns.showReport() end)
  local smaller = button(page, "Smaller", 80); smaller:SetPoint("LEFT", report, "RIGHT", 24, 0)
  local larger = button(page, "Larger", 80); larger:SetPoint("LEFT", smaller, "RIGHT", 6, 0)
  local size = label(page, "", "GameFontHighlightSmall"); size:SetPoint("LEFT", larger, "RIGHT", 8, 0)
  smaller:SetScript("OnClick", function() W.setScale(W.scale() - 0.1); page.refresh() end)
  larger:SetScript("OnClick", function() W.setScale(W.scale() + 0.1); page.refresh() end)
  page.report, page.site, page.smaller, page.larger = report, site, smaller, larger
  page.refresh = function()
    for _, cb in ipairs(page.boxes) do cb:SetChecked(ns.opt(cb.key) and true or false) end
    page.layout(search:GetText() or "")
    site.value = W.APP_URL
    site:SetText(site.value)
    size:SetText(string.format("Window size %d%%", math.floor(W.scale() * 100 + 0.5)))
    local latest = ns.updateAvailable()
    ver:SetText("Addon version " .. ns.addonVersion() .. (latest and (".  |cffe8a33d" .. latest .. " is available.|r " .. ns.UPDATE_HINT) or ""))
  end
end

-- ---------- window ----------
local function setTitle(f, text)
  if f.styled and f.title then f.title:SetText(text)
  elseif f.SetTitle then f:SetTitle(text)
  elseif f.TitleText then f.TitleText:SetText(text)
  elseif f.TitleContainer and f.TitleContainer.TitleText then f.TitleContainer.TitleText:SetText(text)
  elseif f.title then f.title:SetText(text) end
end
W.setTitle = setTitle

-- The pages of a section that are there (their feature loaded and a builder for them).
local function sectionPages(sec)
  local out = {}
  for _, p in ipairs(sec.pages) do
    if pages[p.key] and (not p.when or p.when()) then out[#out + 1] = p end
  end
  return out
end

-- A section's button on the rail: icon, name, an ember bar when it's the open one.
local function railButton(f, sec, onClick)
  local S = ns.skin
  local b = CreateFrame("Button", nil, f)
  b:SetSize(RAIL - 16, 36)
  b.bg = S.colorTex(b, "BACKGROUND", S.EMBER[1], S.EMBER[2], S.EMBER[3], 0.16); b.bg:SetAllPoints(); b.bg:Hide()
  b.bar = S.colorTex(b, "ARTWORK", S.EMBER[1], S.EMBER[2], S.EMBER[3], 1); b.bar:SetSize(3, 28); b.bar:SetPoint("LEFT", 0, 0); b.bar:Hide()
  b.icon = b:CreateTexture(nil, "ARTWORK"); b.icon:SetSize(24, 24); b.icon:SetPoint("LEFT", 10, 0)
  b.icon:SetTexture("Interface\\Icons\\" .. sec.icon)
  if b.icon.SetTexCoord then b.icon:SetTexCoord(0.08, 0.92, 0.08, 0.92) end
  b.label = S.text(b, "body", sec.label, S.GREY); b.label:SetPoint("LEFT", 42, 0); b.label:SetWidth(RAIL - 62)
  b:SetHighlightTexture("Interface\\QuestFrame\\UI-QuestTitleHighlight", "ADD")
  b:SetScript("OnClick", onClick)
  function b.select(on)
    b.on = on
    b.label:SetTextColor(unpack(on and S.GOLD or S.GREY))
    b.icon:SetAlpha(on and 1 or 0.7)
    if on then b.bg:Show(); b.bar:Show() else b.bg:Hide(); b.bar:Hide() end
  end
  return b
end

local function createWindow()
  local S = ns.skin
  local styled = S.enabled()
  local f, template
  if styled then f = CreateFrame("Frame", "WowGuildWindow", UIParent) else f, template = tryFrame("Frame", "WowGuildWindow", UIParent, "ButtonFrameTemplate", "BackdropTemplate") end
  f.native = template == "ButtonFrameTemplate"
  f.styled = styled
  f.bottomTabs = false
  f:SetSize(WIDTH, HEIGHT)
  f:SetFrameStrata("DIALOG")
  f:SetMovable(true); f:EnableMouse(true); f:RegisterForDrag("LeftButton"); f:SetClampedToScreen(true)
  f:SetScript("OnDragStart", f.StartMoving)
  f:SetScript("OnDragStop", function(self)
    self:StopMovingOrSizing()
    local point, _, rel, x, y = self:GetPoint()
    ns.db.ui = ns.db.ui or {}
    ns.db.ui.windowPos = { point = point, rel = rel, x = x, y = y }
  end)
  tinsert(UISpecialFrames, "WowGuildWindow") -- Escape closes it

  if f.native then
    if ButtonFrameTemplate_HidePortrait then ButtonFrameTemplate_HidePortrait(f) end
    if ButtonFrameTemplate_HideButtonBar then ButtonFrameTemplate_HideButtonBar(f) end
    -- The inner panel holds the pages, to the right of the rail and under the tabs.
    if f.Inset then
      f.Inset:ClearAllPoints()
      f.Inset:SetPoint("TOPLEFT", RAIL + 4, -74)
      f.Inset:SetPoint("BOTTOMRIGHT", -6, 4)
    end
  elseif styled then
    S.window(f)
    f.title = S.text(f, "title", "", S.GOLD); f.title:SetPoint("TOPLEFT", 18, -14)
    local close = CreateFrame("Button", nil, f, "UIPanelCloseButton"); close:SetPoint("TOPRIGHT", -4, -4)
  else
    skin(f)
    f.title = label(f, "", "GameFontNormalLarge"); f.title:SetPoint("TOPLEFT", 16, -12)
    local close = CreateFrame("Button", nil, f, "UIPanelCloseButton"); close:SetPoint("TOPRIGHT", -2, -2)
  end
  setTitle(f, "Guild Camp")

  -- The rail: a darker strip down the left with one button per section; Settings sits at the bottom.
  local rail = CreateFrame("Frame", nil, f)
  rail:SetPoint("TOPLEFT", 8, -46); rail:SetPoint("BOTTOMLEFT", 8, 8); rail:SetWidth(RAIL - 8)
  local shade = S.colorTex(rail, "BACKGROUND", 0, 0, 0, 0.28); shade:SetAllPoints()
  local edge = S.colorTex(rail, "BORDER", S.GOLD[1], S.GOLD[2], S.GOLD[3], 0.25); edge:SetWidth(1)
  edge:SetPoint("TOPRIGHT"); edge:SetPoint("BOTTOMRIGHT")
  f.railFrame = rail

  f.rail, f.tabs, f.pages, f.sectionOf, f.shownPages = {}, {}, {}, {}, {}
  local top = 0
  for _, sec in ipairs(SECTIONS) do
    local list = sectionPages(sec)
    f.shownPages[sec.id] = list
    if #list > 0 then
      local rb = railButton(rail, sec, function() W.show(sec.id) end)
      if sec.foot then rb:SetPoint("BOTTOMLEFT", 4, 6) else rb:SetPoint("TOPLEFT", 4, -6 - top * 38); top = top + 1 end
      f.rail[sec.id] = rb
      local prev
      for _, p in ipairs(list) do
        -- The tab strip: a section's pages, shown while that section is open.
        local tab = S.tab(f, p.label, function() W.show(p.key) end)
        if prev then tab:SetPoint("LEFT", prev, "RIGHT", 2, 0) else tab:SetPoint("TOPLEFT", f, "TOPLEFT", RAIL + 10, -44) end
        tab:Hide()
        f.tabs[p.key] = tab
        prev = tab
        local page = CreateFrame("Frame", nil, f)
        page:SetPoint("TOPLEFT", RAIL + 18, -86)
        page:SetPoint("BOTTOMRIGHT", -18, 16)
        pages[p.key](page)
        page:Hide()
        f.pages[p.key] = page
        f.sectionOf[p.key] = sec.id
      end
    end
  end
  if styled then
    -- A gold rule under the tabs, over the pages only.
    local G = S.GOLD
    local line = S.colorTex(f, "ARTWORK", G[1], G[2], G[3], 0.45); line:SetHeight(1)
    line:SetPoint("TOPLEFT", RAIL + 10, -74); line:SetPoint("TOPRIGHT", -14, -74)
    S.gradient(line, "HORIZONTAL", G[1], G[2], G[3], 0.7, G[1], G[2], G[3], 0)
  end

  if f.SetScale then f:SetScale(W.scale()) end
  local pos = ns.db.ui and ns.db.ui.windowPos
  if pos then f:SetPoint(pos.point or "CENTER", UIParent, pos.rel or "CENTER", pos.x or 0, pos.y or 0) else f:SetPoint("CENTER") end
  f:Hide()
  return f
end

function W.window()
  win = win or createWindow()
  return win
end

-- Is `key` a page or a section of the window? (/wow <key> opens it.)
function W.has(key)
  local f = W.window()
  return (f.pages[key] or f.rail[key]) and true or false
end

-- Opens a page (by its key) or a section (by its id: the page it showed last, or its first).
function W.show(key)
  local f = W.window()
  key = key or W.current or "camp"
  if not f.pages[key] then
    local list = f.rail[key] and f.shownPages[key]
    W.last = W.last or {}
    key = list and (W.last[key] or list[1].key) or "camp"
  end
  local section = f.sectionOf[key]
  W.current, W.section = key, section
  W.last = W.last or {}
  W.last[section] = key
  for id, rb in pairs(f.rail) do rb.select(id == section) end
  for _, sec in ipairs(SECTIONS) do
    local list = f.shownPages[sec.id]
    for _, p in ipairs(list) do
      local page, tab = f.pages[p.key], f.tabs[p.key]
      if p.key == key then page:Show() else page:Hide() end
      -- A section with one page needs no tab strip.
      if sec.id == section and #list > 1 then tab:Show() else tab:Hide() end
      tab.select(p.key == key)
    end
  end
  setTitle(f, "Guild Camp" .. ((WowGuildInbox and WowGuildInbox.guild) and ("  |cff999999" .. WowGuildInbox.guild .. "|r") or ""))
  f:Show()
  f.pages[key].refresh()
end

-- What the player is doing right now, as the page that helps with it (the "smartOpen" option).
function W.context()
  if not ns.opt("smartOpen") then return nil end
  if IsInInstance then
    local inside, kind = ns.try(IsInInstance)
    if inside and kind == "party" then return "quests" end
    if inside and kind == "raid" then return "raids" end
  end
  local ah = _G.AuctionHouseFrame or _G.AuctionFrame
  if ah and ah.IsShown and ah:IsShown() then return "deals" end
  local q = ns.ctaRecent
  local c = q and q[#q]
  if c and not c.mine and c.at and time() - c.at < 600 then return "cta" end
  return nil
end

-- Opening the window lands on the page for what you're doing, once per situation: after that it stays where you
-- left it, so it never pulls you off a page you chose.
function W.open()
  local ctx = W.context()
  if ctx and ctx ~= W.lastContext and W.window().pages[ctx] then
    W.lastContext = ctx
    return W.show(ctx)
  end
  if not ctx then W.lastContext = nil end
  W.show()
end

function W.toggle()
  local f = W.window()
  if f:IsShown() then f:Hide() else W.open() end
end

function W.refreshIfShown()
  if win and win:IsShown() and W.current then win.pages[W.current].refresh() end
end


-- ---------- minimap button ----------
local mini
local function placeMini()
  local angle = math.rad((ns.db.ui and ns.db.ui.minimapAngle) or 200)
  local r = ((Minimap.GetWidth and Minimap:GetWidth() or 140) / 2) + 6
  mini:ClearAllPoints()
  mini:SetPoint("CENTER", Minimap, "CENTER", math.cos(angle) * r, math.sin(angle) * r)
end

local function createMini()
  local b = CreateFrame("Button", "WowGuildMinimapButton", Minimap)
  b:SetSize(31, 31)
  b:SetFrameStrata("MEDIUM")
  b:SetFrameLevel(8)
  b:RegisterForClicks("LeftButtonUp", "RightButtonUp")
  b:RegisterForDrag("LeftButton")
  local icon = b:CreateTexture(nil, "BACKGROUND")
  icon:SetTexture("Interface\\Icons\\Spell_Fire_Fire")
  icon:SetSize(20, 20)
  icon:SetPoint("CENTER", 0, 1)
  local border = b:CreateTexture(nil, "OVERLAY")
  border:SetTexture("Interface\\Minimap\\MiniMap-TrackingBorder")
  border:SetSize(53, 53)
  border:SetPoint("TOPLEFT")
  b:SetHighlightTexture("Interface\\Minimap\\UI-Minimap-ZoomButton-Highlight")
  b:SetScript("OnClick", function(_, which)
    if which == "RightButton" then W.show("settings") else W.toggle() end
  end)
  b:SetScript("OnDragStart", function(self)
    self:SetScript("OnUpdate", function()
      local mx, my = Minimap:GetCenter()
      local px, py = GetCursorPosition()
      local scale = Minimap:GetEffectiveScale()
      local atan2 = math.atan2 or math.atan
      ns.db.ui = ns.db.ui or {}
      ns.db.ui.minimapAngle = math.deg(atan2(py / scale - my, px / scale - mx))
      placeMini()
    end)
  end)
  b:SetScript("OnDragStop", function(self) self:SetScript("OnUpdate", nil) end)
  b:SetScript("OnEnter", function(self)
    if not GameTooltip then return end
    GameTooltip:SetOwner(self, "ANCHOR_LEFT")
    GameTooltip:AddLine("Guild Camp")
    GameTooltip:AddLine("Click: open the guild window", 1, 1, 1)
    GameTooltip:AddLine("Right-click: settings", 1, 1, 1)
    GameTooltip:AddLine("Drag: move this button", 0.6, 0.6, 0.6)
    GameTooltip:Show()
  end)
  b:SetScript("OnLeave", function() if GameTooltip then GameTooltip:Hide() end end)
  return b
end

-- If another addon provides LibDataBroker / LibDBIcon (Titan Panel, ElvUI, Bazooka, minimap button bags…),
-- use them: the button then behaves like every other addon's and minimap addons can manage it.
local ldbObject, dbicon
local function setupBroker()
  if ldbObject or not LibStub then return end
  local ldb = LibStub("LibDataBroker-1.1", true)
  if not ldb then return end
  ldbObject = ldb:NewDataObject("Guild Camp", {
    type = "launcher", label = "Guild Camp", icon = "Interface\\Icons\\Spell_Fire_Fire",
    OnClick = function(_, which) if which == "RightButton" then W.show("settings") else W.toggle() end end,
    OnTooltipShow = function(tt)
      tt:AddLine("Guild Camp")
      tt:AddLine("Click: open the guild window", 1, 1, 1)
      tt:AddLine("Right-click: settings", 1, 1, 1)
    end,
  })
  dbicon = LibStub("LibDBIcon-1.0", true)
  if dbicon then
    ns.db.ui = ns.db.ui or {}
    ns.db.ui.dbicon = ns.db.ui.dbicon or {}
    dbicon:Register("Guild Camp", ldbObject, ns.db.ui.dbicon)
  end
end
ns.broker = function() return ldbObject, dbicon end

function ns.applyOptions()
  setupBroker()
  if dbicon then
    ns.db.ui.dbicon.hide = not ns.opt("minimapButton")
    if ns.opt("minimapButton") then dbicon:Show("Guild Camp") else dbicon:Hide("Guild Camp") end
    if mini then mini:Hide() end
  elseif Minimap then
    if ns.opt("minimapButton") then
      mini = mini or createMini()
      placeMini()
      mini:Show()
    elseif mini then
      mini:Hide()
    end
  end
  W.refreshIfShown()
end
ns.minimapButton = function() return mini end

ns.on("PLAYER_LOGIN", function() ns.applyOptions() end)

-- Retail's addon drawer (AddonCompartmentFunc in the .toc) and the key binding (Bindings.xml).
function WowGuild_OnAddonCompartmentClick() W.toggle() end
function WowGuild_Toggle() W.toggle() end
BINDING_HEADER_WOWGUILD = "Guild Camp"
BINDING_NAME_WOWGUILD_TOGGLE = "Open or close the guild window"
BINDING_NAME_WOWGUILD_COACH = "Open or close the Coach"
