'use strict';
// wowsim: a small simulated WoW client for tests.
//
// It runs the REAL addon Lua files from addon/WowGuild (via fengari, a Lua 5.3 VM in JS) against
// mocked game APIs, fires game events, and writes a SavedVariables file the way the game does.
// Nothing here talks to a real game install.
//
// Load order matches the game: the optional WowGuild_Inbox addon (the news the Guild Camp app writes)
// loads first, then the addon's files in .toc order (each called with (addonName, namespace) as
// varargs), then the addon's SavedVariables. Events only fire when a test fires them, so a typical
// session is:
//
//   const { WowClient } = require('./wowsim');
//   const wow = new WowClient({ inbox: { guild: 'wow', latestAddon: '0.12.0' } });
//   wow.login();                                   // ADDON_LOADED('WowGuild') + PLAYER_LOGIN
//   wow.slash('cta Crossroads 5 need help');       // runs "/wow cta Crossroads 5 need help"
//   wow.logout();                                  // PLAYER_LOGOUT
//   fs.writeFileSync(svFile, wow.saveVariablesBuffer());
//
// Two modes.
//   Immediate (the default, no `clock` option): exactly the behaviour existing tests rely on.
//     C_Timer.After runs the callback at once, tickers never fire, time() is the real clock, and an
//     error in an event handler is thrown straight back to the test. (One guard was added: a timer
//     that keeps rescheduling itself from inside its own callback stops after 20 levels instead of
//     overflowing the stack; wow.droppedTimers() counts those.)
//   Virtual (pass `clock: new VirtualClock()`): game time only moves when the test runs the clock.
//     GetTime, GetServerTime, time(), date(), C_Timer.After/NewTimer/NewTicker and OnUpdate scripts
//     all follow it. Event handlers, timers and OnUpdate scripts are called the way the game calls
//     them (one failing handler never stops the others); a Lua error that reaches the game, or one
//     handed to geterrorhandler(), makes clock.run() (or the WowClient method that caused it) throw.
//     The Lua environment looks like the game's: no os/io/package/require/dofile/loadfile, none of
//     the Lua 5.3-only functions (utf8, string.pack, math.type, table.move ...), and math.random is
//     seeded per client so runs repeat exactly (WoW helpers such as wipe, strtrim, strjoin, tremove,
//     format, floor and max exist; strsplit stays nil as before). Numbers the game returns for times
//     are Lua floats (doubles, like every number in Lua 5.1): arithmetic is exact to 2^53, but
//     tostring() prints 1794066000.0 under fengari, so never use tostring() for wire data. Beware:
//     fengari's own integers are 32-bit, so integer literals multiplied past 2^31 wrap here although
//     they would not in the game (write 5381.0 or add 0.0 to force a float). debugprofilestop() is
//     virtual too and does not advance while Lua runs, so a per-frame time budget never runs out.
//
// API
//   new WowClient(options)
//     options.savedVariables  string|Buffer  contents of WTF/.../SavedVariables/WowGuild.lua from an earlier session
//     options.savedVariablesPerCharacter  string|Buffer  the per-character file, if the .toc lists any
//     options.inboxFile       path           a WowGuild_Inbox/Inbox.lua written by the app (loaded before the addon)
//     options.inbox           object         the inbox as a JS object; becomes `WowGuildInbox = {...}` (toLua)
//     options.inboxLua        string         Lua source for the inbox, used as-is
//     options.addonVersion    string         what C_AddOns.GetAddOnMetadata("WowGuild", "Version") returns
//                                            (default: the ## Version: line of the real WowGuild.toc)
//     options.addonDir        path           addon folder to load (default: <repo>/addon/WowGuild). The addon's
//                                            name is the folder name; its .toc is <name>.toc (else WowGuild.toc).
//     options.mocks           string         extra Lua run after the built-in mocks but BEFORE the addon loads
//                                            (for APIs the addon reads at load time, e.g. Settings, LibStub)
//    Virtual mode and the game world (all optional):
//     options.clock           VirtualClock   turns on virtual mode (see above). Several clients can share one clock.
//     options.player          object         who is logged in: { name, realm, classToken ('SHAMAN'), raceToken ('Orc'),
//                                            level, faction, guild (null = not in a guild), rankIndex, rankName, zone }.
//                                            Without it UnitName() is "Thrallia" etc., as before.
//     options.roster          array|function the guild roster: members { name ('Name' or 'Name-Realm'), rankIndex,
//                                            rankName, level, classToken, zone, online, note, officerNote }, or a
//                                            function returning them (read on every call, so it can change).
//                                            In virtual mode C_GuildInfo.GuildRoster()/GuildRoster() answer with
//                                            GUILD_ROSTER_UPDATE after 0.3 s (at most once per 10 s, like the game),
//                                            and one more GUILD_ROSTER_UPDATE arrives 2 s after login.
//     options.interface       16001|120105   game version: GetBuildInfo(), WOW_PROJECT_ID, which item/spell APIs
//                                            exist, and how SendAddonMessage answers (below)
//     options.sendResult      'boolean'|'enum'  what C_ChatInfo.SendAddonMessage / RegisterAddonMessagePrefix return:
//                                            classic clients a boolean, retail ones Enum.SendAddonMessageResult /
//                                            Enum.RegisterAddonMessagePrefixResult. Default: 'enum' for interface
//                                            120105, else 'boolean'.
//     options.transport       { send(wow, msg) }  where SendAddonMessage goes (GuildNet passes one). Without it the
//                                            client keeps what it sends in wow.sentMessages and delivers nothing.
//     options.gameData        { items, spells, itemsCached, cache }  item and spell names: items { [id]: 'Name' or
//                                            { name, quality, level, classID, subclassID } }, spells { [id]: 'Name' }.
//                                            Turns on C_Item.GetItemNameByID / RequestLoadItemDataByID /
//                                            IsItemDataCachedByID, GetItemInfo (classic) or C_Item.GetItemInfo
//                                            (retail), GetSpellInfo (classic) or C_Spell.GetSpellName/GetSpellInfo
//                                            (retail; both sets without `interface`). In virtual mode an item that
//                                            is not cached returns nil and fires ITEM_DATA_LOAD_RESULT and
//                                            GET_ITEM_INFO_RECEIVED 50-400 ms later (cache: a Set kept between sessions).
//     options.seed            any            seeds math.random in virtual mode (with the player name)
//     options.clockSkew       seconds        how wrong this PC's clock is: time() = server time + skew (virtual mode)
//     options.utcOffset       hours          this PC's time zone for date() and time(tbl) in virtual mode (default 0:
//                                            UTC, so output is the same on every machine; "!" formats are always UTC)
//     options.strictErrors    boolean        default true: errors handed to geterrorhandler() fail the test too;
//                                            false: they are only collected in wow.errors (uncaught ones still throw)
//     options.onPrint(line), options.onSound(id, channel)   callbacks
//   wow.exec(code, name?)        run Lua. Throws an Error with the Lua message on failure.
//   wow.eval(expr)               evaluate a Lua expression → tostring() of the result as a JS string, or null for nil
//   wow.get(expr)                evaluate a Lua expression → a JS value (tables become arrays/objects, the same
//                                rules as the SavedVariables parser: keys exactly 1..n make an array, {} is {})
//   wow.lua(code)                run a chunk (or an expression) with `ns` = the addon namespace; → its first result
//   wow.fire(event, ...args)     fire a game event on every frame registered for it (args converted with toLua)
//   wow.slash(text)              run "/wow <text>"
//   wow.click(frameExpr, button?) click a frame (runs its OnClick script), e.g. wow.click('WowGuildMinimapButton')
//   wow.login() / wow.logout()   ADDON_LOADED + PLAYER_LOGIN, or PLAYER_LOGOUT. In virtual mode login also fires
//                                PLAYER_ENTERING_WORLD and LOADING_SCREEN_DISABLED (login({ reload: true }) for a
//                                /reload), and logout fires PLAYER_LEAVING_WORLD first.
//   wow.end()                    the session is over: its timers and deliveries stop (virtual mode)
//   wow.setInstance(on, { type = 'party', loading = 2 })  zone into or out of an instance: LOADING_SCREEN_ENABLED,
//                                `loading` seconds later IsInInstance() changes, then PLAYER_ENTERING_WORLD,
//                                ZONE_CHANGED_NEW_AREA, LOADING_SCREEN_DISABLED (at once without a clock or loading 0)
//   wow.setCombat(on)            PLAYER_REGEN_DISABLED then InCombatLockdown() true; or false then PLAYER_REGEN_ENABLED
//   wow.receive(prefix, text, channel, sender)  an addon message arrives (CHAT_MSG_ADDON) if the prefix is registered
//   wow.scheduleEvent(ms, event, ...args)        fire an event later on the virtual clock
//   wow.saveVariables()          the SavedVariables file text the game would write (JS string)
//   wow.saveVariablesBuffer()    the same as raw bytes (Buffer), exactly what lands on disk
//   wow.saveVariablesPerCharacterBuffer()  the per-character file, or null when the .toc lists none
//   wow.db()                     WowGuildDB as a JS object
//   wow.printed()                every chat line the addon printed, joined with "\n"
//   wow.printedLines()           the same as an array
//   wow.chatLog                  [{ t, text }] every chat line with the time it was printed
//   wow.texts()                  every string any frame was given with SetText (window text, buttons, tooltips)
//   wow.clearOutput()            forget printed lines and SetText history
//   wow.sentMessages             [{ t, prefix, text, bytes, channel, target }] (without a transport)
//   wow.prefixes                 Set of registered addon message prefixes
//   wow.sounds / wow.notices     [{ t, id, channel }] from PlaySound; [{ t, text }] from UIErrorsFrame/RaidNotice
//   wow.errors / wow.violations  [{ t, message, kind }] Lua errors (virtual mode); [{ t, message }] broken sends
//   wow.L                        the raw fengari lua_State, if you need it
//
// C_ChatInfo exists in both modes. A send THROWS (fails the test) when the prefix was never registered, the
// message is over 255 bytes or holds a NUL byte, or the chat type is unknown. Inside an instance or during a
// loading screen it is refused (AddOnMessageLockdown / false); outside a guild GUILD and OFFICER are refused
// (NotInGuild / false).
//
// Lua-side helpers (usable in exec/eval): __ns (the addon namespace), __fire(event, ...),
// __click(frame, button), __printed, __texts, __popups (StaticPopup_Show count), __inCombat (set true to
// simulate combat), __inInstance / __instanceType / __loading, __sounds, __bags (bag contents table),
// __tocFields (the parsed .toc fields).
//
// VirtualClock: new VirtualClock({ startTime = 1794066000 (server epoch seconds), frameMs = 50 })
//   clock.run(seconds)      run every timer, delivery and frame due in that time, in time order
//   clock.serverTime()      server time now (seconds, float); clock.ms = virtual milliseconds since the start
//   clock.schedule(ms, fn)  call fn after ms virtual milliseconds → handle (clock.cancel(handle))
//   A virtual frame lasts frameMs (default 50 ms, 20 fps): C_Timer.After(0, fn) runs next frame, OnUpdate
//   scripts get elapsed = 0.05. The game's loading screens do not stop timers here.
//
// Module exports: { WowClient, VirtualClock, toLua, readToc, luaToJs, ADDON_DIR, SEND_RESULT, REGISTER_RESULT,
//                   hashString, makeRng }
//   toLua(value)    JS value → Lua table constructor source
//   readToc(dir?)   → { name, fields: { Interface, Title, Version, ... }, files: ['Core.lua', ...] }

const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');

const ADDON_DIR = path.join(__dirname, '..', '..', '..', 'addon', 'WowGuild');

// ---------- JS → Lua ----------
const LUA_RESERVED = new Set(['and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function', 'goto', 'if', 'in',
  'local', 'nil', 'not', 'or', 'repeat', 'return', 'then', 'true', 'until', 'while']);

function luaString(s) {
  // JSON escapes are almost Lua escapes; fix the ones that aren't. Control characters become
  // three-digit decimal escapes so a following digit can't be read as part of the escape.
  return JSON.stringify(s).replace(/\\u([0-9a-fA-F]{4})/g, (m, h) => {
    const n = parseInt(h, 16);
    return n < 128 ? '\\' + String(n).padStart(3, '0') : `\\u{${h}}`;
  });
}

function toLua(value, indent = '') {
  if (value === null || value === undefined) return 'nil';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'nil';
  if (typeof value === 'string') return luaString(value);
  const next = indent + '  ';
  if (Array.isArray(value)) {
    if (!value.length) return '{}';
    return '{\n' + value.map((v) => next + toLua(v, next) + ',').join('\n') + '\n' + indent + '}';
  }
  const keys = Object.keys(value);
  if (!keys.length) return '{}';
  return '{\n' + keys.map((k) => {
    const key = /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && !LUA_RESERVED.has(k) ? k : `[${luaString(k)}]`;
    return `${next}${key} = ${toLua(value[k], next)},`;
  }).join('\n') + '\n' + indent + '}';
}

// ---------- the .toc ----------
function readToc(dir = ADDON_DIR) {
  const name = path.basename(dir);
  const own = path.join(dir, `${name}.toc`);
  const text = fs.readFileSync(fs.existsSync(own) ? own : path.join(dir, 'WowGuild.toc'), 'utf8');
  const fields = {};
  const files = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^##\s*([^:]+?)\s*:\s*(.*)$/.exec(line);
    if (m) fields[m[1]] = m[2];
    else if (!line.startsWith('#')) files.push(line.replace(/\\/g, '/'));
  }
  return { name, fields, files };
}

// ---------- small deterministic helpers ----------
// FNV-1a over the UTF-8 bytes: a stable 32-bit seed from any string.
function hashString(s) {
  let h = 0x811c9dc5;
  for (const b of Buffer.from(String(s), 'utf8')) { h ^= b; h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}
// mulberry32: small, fast, good enough for jitter, loss and latency; [0, 1).
function makeRng(seed) {
  let a = (typeof seed === 'number' ? seed : hashString(seed)) >>> 0;
  return function rng() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- the mocked game ----------
const PRELUDE = `
time = os.time
unpack = unpack or table.unpack
date = os.date
strsplit = nil
tinsert = table.insert
UISpecialFrames = {}
__printed = {}
__texts = {}
DEFAULT_CHAT_FRAME = { AddMessage = function(self, m) table.insert(__printed, m); if __hostPrint then __hostPrint(m) end end }
local frames = {}
local function newFrame()
  local f = { events = {}, scripts = {}, shown = false }
  -- Like real frames: method names resolve to (no-op) functions, anything else is nil.
  local mt = { __index = function(t, k)
    if type(k) == "string" and (string.match(k, "^%u%l+%u") or string.match(k, "^%u%l+$")) then
      return function(self, ...) return nil end
    end
    return nil
  end }
  setmetatable(f, mt)
  function f:RegisterEvent(e) self.events[e] = true; if __onRegister then __onRegister(self, e, true) end end
  function f:UnregisterEvent(e) self.events[e] = nil; if __onRegister then __onRegister(self, e, false) end end
  function f:SetScript(n, fn) self.scripts[n] = fn; if __onSetScript then __onSetScript(self, n, fn) end end
  function f:GetScript(n) return self.scripts[n] end
  function f:Show() self.shown = true; self.__hid = nil end
  function f:Hide() self.shown = false; self.__hid = true end
  function f:IsShown() return self.shown end
  function f:CreateFontString() local s = newFrame(); s.parent = self; function s:GetStringHeight() return 100 end; return s end
  function f:CreateTexture() local t = newFrame(); t.parent = self; return t end
  function f:SetText(t) rawset(self, "_text", t); if t ~= nil then table.insert(__texts, tostring(t)) end end
  function f:GetText() return rawget(self, "_text") end
  function f:SetChecked(v) self.checked = v and true or false end
  function f:GetChecked() return self.checked end
  function f:GetParent() return self.parent end
  function f:GetPoint() return "CENTER", nil, "CENTER", 0, 0 end
  frames[#frames + 1] = f
  return f
end
function CreateFrame(kind, name, parent, template)
  local f = newFrame()
  f.kind, f.parent, f.template = kind, parent, template
  if template == "ButtonFrameTemplate" then
    f.Inset = newFrame(); f.Inset.parent = f
    f.TitleText = newFrame()
    function f:SetTitle(t) self.TitleText:SetText(t) end
  end
  if name then _G[name] = f end
  return f
end
function PanelTemplates_SetNumTabs(f, n) f.numTabs = n end
function PanelTemplates_SetTab(f, i) f.selectedTab = i end
function PanelTemplates_TabResize() end
function ButtonFrameTemplate_HidePortrait() end
Minimap = newFrame()
function Minimap:GetCenter() return 100, 100 end
function Minimap:GetWidth() return 140 end
function Minimap:GetEffectiveScale() return 1 end
function GetCursorPosition() return 100, 200 end
function __click(f, which) if f.scripts.OnClick then f.scripts.OnClick(f, which or "LeftButton") end end
function __fire(event, ...)
  for _, f in ipairs(frames) do
    if f.events[event] and f.scripts.OnEvent then f.scripts.OnEvent(f, event, ...) end
  end
end
C_Timer = { After = function(_, fn) fn() end, NewTicker = function() return {} end }
StaticPopupDialogs = {}
SlashCmdList = {}
UIParent = {}
__popups = 0
function StaticPopup_Show() __popups = __popups + 1 end
function InCombatLockdown() return __inCombat == true end
function ReloadUI() end
-- Filled in from the real WowGuild.toc before the addon loads.
__tocFields = {}
C_AddOns = { GetAddOnMetadata = function(name, field) if name == (__addonName or "WowGuild") then return __tocFields[field] end end }
function UnitName() return "Thrallia" end
function UnitClass() return "Shaman", "SHAMAN" end
function UnitRace() return "Orc" end
function UnitLevel() return 23 end
function UnitFactionGroup() return "Horde" end
function GetRealZoneText() return "The Barrens" end
function GetZoneText() return "The Barrens" end
function GetMoney() return 123456 end
function GetGuildInfo() return "wow" end
function IsInGuild() return true end
function GetProfessions() return nil, 2, nil, 4, 5 end
local profs = { [2] = {"Blacksmithing", 120, 150}, [4] = {"Fishing", 40, 75}, [5] = {"Cooking", 80, 150} }
function GetProfessionInfo(i) local p = profs[i]; return p[1], "icon", p[2], p[3] end
C_GuildInfo = { GuildRoster = function() end }
function GetAverageItemLevel() return 61.4, 58.2 end
function GetInventoryItemDurability(slot) if slot == 5 then return 30, 100 elseif slot == 7 then return 70, 100 end end
NUM_BAG_SLOTS = 4
local bags = { [0] = { {itemID = 118, stackCount = 5, hyperlink = "|cffffffff|Hitem:118::|h[Minor Healing Potion]|h|r"}, {itemID = 2581, stackCount = 10, hyperlink = "|Hitem:2581|h[Heavy Linen Bandage]|h"}, {itemID = 9999, stackCount = 1, hyperlink = "|Hitem:9999|h[Old Sword]|h"} },
  [-1] = { {itemID = 14047, stackCount = 20, hyperlink = "|Hitem:14047|h[Runecloth]|h"}, {itemID = 14047, stackCount = 15, hyperlink = "|Hitem:14047|h[Runecloth]|h"} } }
__bags = bags
C_Container = {
  GetContainerNumSlots = function(bag) return bags[bag] and #bags[bag] or 0 end,
  GetContainerItemInfo = function(bag, slot) return bags[bag] and bags[bag][slot] end,
}
local itemClass = { [118] = {0, 1}, [2581] = {0, 7}, [9999] = {2, 0} }
C_Item = { GetItemInfoInstant = function(id) local c = itemClass[id]; if not c then return id end; return id, "t", "s", "", 0, c[1], c[2] end }
local roster = {
  {"Thrallia-Forever", "Guild Master", 0, 23, "Shaman", "The Barrens", "", "", true, 0, "SHAMAN"},
  {"Grommash Hellscream-Forever", "Officer", 1, 31, "Warrior", "Hillsbrad Foothills", "", "", true, 0, "WARRIOR"},
  {"Zuljinne", "Member", 2, 18, "Hunter", "Stonetalon Mountains", "", "", false, 0, "HUNTER"},
}
function GetNumGuildMembers() return #roster end
function GetGuildRosterInfo(i) return unpack(roster[i]) end
function Ambiguate(n) return (n:gsub("%-.*$", "")) end
C_TradeSkillUI = {
  IsTradeSkillLinked = function() return false end,
  IsTradeSkillGuild = function() return false end,
  GetBaseProfessionInfo = function() return { professionName = "Blacksmithing" } end,
  GetAllRecipeIDs = function() return { 101, 102, 103 } end,
  GetRecipeInfo = function(id)
    local r = { [101] = { name = "Rough Sharpening Stone", learned = true },
                [102] = { name = "Copper Chain Vest", learned = true },
                [103] = { name = "Unlearned Thing", learned = false } }
    return r[id]
  end,
}

-- Serialise like the game client writes SavedVariables.
local function ser(v, indent)
  local t = type(v)
  if t == "string" then return string.format("%q", v) end
  if t == "number" or t == "boolean" then return tostring(v) end
  if t ~= "table" then return "nil" end
  local out = { "{\\n" }
  local n = #v
  for i = 1, n do out[#out + 1] = indent .. "\\t" .. ser(v[i], indent .. "\\t") .. ", -- [" .. i .. "]\\n" end
  for k, val in pairs(v) do
    if not (type(k) == "number" and k >= 1 and k <= n and k % 1 == 0) and type(val) ~= "function" then
      local key = type(k) == "string" and string.format("[%q]", k) or ("[" .. tostring(k) .. "]")
      out[#out + 1] = indent .. "\\t" .. key .. " = " .. ser(val, indent .. "\\t") .. ",\\n"
    end
  end
  out[#out + 1] = indent .. "}"
  return table.concat(out)
end
-- names: the .toc's SavedVariables (default just WowGuildDB).
function __saveVariables(names)
  names = names or { "WowGuildDB" }
  local out = {}
  for i = 1, #names do out[#out + 1] = "\\n" .. names[i] .. " = " .. ser(_G[names[i]], "") .. "\\n" end
  return table.concat(out)
end
`;

// Present in every mode: the game always has these. Today's addon does not call them, so existing tests are
// unaffected; the sharing code will.
const COMMON = `
GetTime = __hostRealTime
GetServerTime = function() return os.time() end
debugprofilestop = __hostRealMs
__inInstance, __instanceType, __loading = false, "none", false
function IsInInstance() if __inInstance then return true, __instanceType end return false, "none" end
function UnitAffectingCombat(unit) return unit == "player" and __inCombat == true end
Enum = Enum or {}
Enum.SendAddonMessageResult = { Success = 0, InvalidPrefix = 1, InvalidMessage = 2, AddonMessageThrottle = 3,
  InvalidChatType = 4, NotInGroup = 5, TargetRequired = 6, InvalidChannel = 7, ChannelThrottle = 8, GeneralError = 9,
  NotInGuild = 10, AddOnMessageLockdown = 11, TargetOffline = 12 }
Enum.RegisterAddonMessagePrefixResult = { Success = 0, DuplicatePrefix = 1, InvalidPrefix = 2, MaxPrefixes = 3 }
C_ChatInfo = {
  RegisterAddonMessagePrefix = __hostRegister,
  IsAddonMessagePrefixRegistered = __hostIsRegistered,
  GetRegisteredAddonMessagePrefixes = __hostPrefixes,
  SendAddonMessage = __hostSend,
  SendAddonMessageLogged = __hostSend,
}
SOUNDKIT = { RAID_WARNING = 8959, READY_CHECK = 8960, TELL_MESSAGE = 3081, MAP_PING = 3175, IG_MAINMENU_OPEN = 850,
  IG_MAINMENU_CLOSE = 851, IG_CHARACTER_INFO_TAB = 841, UI_BNET_TOAST = 18019, ALARM_CLOCK_WARNING_3 = 12889,
  IG_PLAYER_INVITE = 880, U_CHAT_SCROLL_BUTTON = 1115 }
__sounds = {}
function PlaySound(id, channel) __sounds[#__sounds + 1] = id; __hostSound(id, channel); return true, #__sounds end
function PlaySoundFile(file, channel) __sounds[#__sounds + 1] = file; __hostSound(file, channel); return true, #__sounds end
local function notice(self, m) __hostNotice(m) end
UIErrorsFrame = { AddMessage = notice }
RaidWarningFrame = { AddMessage = notice }
function RaidNotice_AddMessage(frame, m) __hostNotice(m) end
-- Timers still run at once, as before. A callback that keeps rescheduling itself stops after 20 levels
-- (counted in __timerDrops) instead of overflowing the stack.
__timerDepth, __timerDrops = 0, 0
local function handle()
  local h = { _cancelled = false }
  function h:Cancel() self._cancelled = true end
  function h:IsCancelled() return self._cancelled end
  return h
end
local function runNow(fn, ...)
  if __timerDepth >= 20 then __timerDrops = __timerDrops + 1; return end
  __timerDepth = __timerDepth + 1
  local ok, err = pcall(fn, ...)
  __timerDepth = __timerDepth - 1
  if not ok then error(err, 0) end
end
C_Timer = {
  After = function(_, fn) runNow(fn) end,
  NewTimer = function(_, fn) local h = handle(); runNow(fn, h); return h end,
  NewTicker = function() return handle() end,
}
`;

// Who is logged in, when options.player is given.
const PLAYER = `
function UnitName(unit) if unit == "player" then return __player.name end end
function UnitFullName(unit) if unit == "player" then return __player.name, __player.realmNormalized end end
function UnitGUID(unit) if unit == "player" then return __player.guid end end
function UnitClass(unit) if unit == "player" then return __player.class, __player.classToken, __player.classId end end
function UnitRace(unit) if unit == "player" then return __player.race, __player.raceToken, __player.raceId end end
function UnitLevel(unit) if unit == "player" then return __player.level end return 0 end
function UnitFactionGroup(unit) if unit == "player" then return __player.faction, __player.faction end end
function UnitIsUnit(a, b) return a == b end
function GetRealZoneText() return __player.zone end
function GetZoneText() return __player.zone end
if __player.realm then
  function GetRealmName() return __player.realm end
  function GetNormalizedRealmName() return __player.realmNormalized end
end
function IsInGuild() return __player.guild ~= nil end
function GetGuildInfo(unit)
  if unit ~= "player" or __player.guild == nil then return nil end
  return __player.guild, __player.rankName, __player.rankIndex, nil
end
-- "Name-Realm" → "Name" when the realm is the player's own (or for "short"), like the game.
function Ambiguate(name, context)
  if type(name) ~= "string" then return name end
  local short, realm = string.match(name, "^([^%-]+)%-(.+)$")
  if not short then return name end
  if context == "short" or realm == __player.realmNormalized or __player.realmNormalized == nil then return short end
  return name
end
`;

// A roster backed by options.roster.
const ROSTER = `
function GetNumGuildMembers() return __hostRosterCount() end
function GetGuildRosterInfo(i) return __hostRosterInfo(i) end
function GuildControlGetNumRanks() return __hostRankCount() end
function GuildControlGetRankName(i) return __hostRankName(i) end
`;

const VIRTUAL = `
__virtual = true
do
  local traceback = debug.traceback
  local hostError, hostSchedule, hostFrame, hostGetTime = __hostError, __hostSchedule, __hostFrame, __hostGetTime
  -- This PC's clock and time zone (options.clockSkew, options.utcOffset), the same on every machine running the tests.
  time = function(t) if t ~= nil then return __hostMakeTime(t) end return __hostTime() end
  date = function(fmt, t) return __hostDate(fmt, t) end
  GetTime = hostGetTime
  GetServerTime = __hostServerTime
  debugprofilestop = function() return hostGetTime() * 1000 end

  -- Errors that reach the game go to the error handler, like the game's script error display.
  local handler = function(msg) hostError(tostring(msg), "reported") end
  function geterrorhandler() return handler end
  function seterrorhandler(fn) if type(fn) == "function" then handler = fn end end
  print = function(...)
    local parts = {}
    for i = 1, select("#", ...) do parts[i] = tostring((select(i, ...))) end
    DEFAULT_CHAT_FRAME:AddMessage(table.concat(parts, " "))
  end
  math.random = __hostRandom
  math.randomseed = function() end
  random = __hostRandom
  fastrandom = __hostRandom

  -- Events: frames in registration order; each handler protected on its own.
  local byEvent = {}
  function __onRegister(f, e, on)
    local list = byEvent[e]
    if on then
      if not list then list = {}; byEvent[e] = list end
      for i = 1, #list do if list[i] == f then return end end
      list[#list + 1] = f
    elseif list then
      for i = 1, #list do if list[i] == f then table.remove(list, i); break end end
    end
  end
  function __fire(event, ...)
    local list = byEvent[event]
    if not list then return end
    local n, snap = #list, {}
    for i = 1, n do snap[i] = list[i] end
    for i = 1, n do
      local f = snap[i]
      local fn = f.events[event] and f.scripts.OnEvent
      if fn then
        local ok, err = xpcall(fn, traceback, f, event, ...)
        if not ok then hostError(err, "uncaught") end
      end
    end
  end

  -- C_Timer on the virtual clock.
  local timers, nextId = {}, 0
  local function newHandle()
    local h = { _cancelled = false }
    function h:Cancel() self._cancelled = true end
    function h:IsCancelled() return self._cancelled end
    return h
  end
  local function add(t, delay)
    nextId = nextId + 1
    timers[nextId] = t
    hostSchedule(delay, nextId)
  end
  local function check(d, fn, name)
    if type(d) ~= "number" or type(fn) ~= "function" then error("Usage: C_Timer." .. name .. "(seconds, callback)", 3) end
  end
  function __runTimer(id)
    local t = timers[id]
    if not t then return end
    timers[id] = nil
    local h = t.handle
    if h and h._cancelled then return end
    if t.period then
      t.count = t.count + 1
      if not t.iterations or t.count < t.iterations then add(t, t.period) end
    end
    local ok, err
    if h then ok, err = xpcall(t.fn, traceback, h) else ok, err = xpcall(t.fn, traceback) end
    if not ok then hostError(err, "uncaught") end
  end
  C_Timer = {
    After = function(d, fn) check(d, fn, "After"); add({ fn = fn }, d) end,
    NewTimer = function(d, fn) check(d, fn, "NewTimer"); local h = newHandle(); add({ fn = fn, handle = h }, d); return h end,
    NewTicker = function(d, fn, n)
      check(d, fn, "NewTicker")
      local h = newHandle()
      add({ fn = fn, handle = h, period = d, iterations = n, count = 0 }, d)
      return h
    end,
  }

  -- OnUpdate: frames with an OnUpdate script that were not hidden get one call per virtual frame.
  local ouList, ticking, lastTick = {}, false, 0
  local function visible(f)
    while type(f) == "table" do
      if rawget(f, "__hid") then return false end
      f = rawget(f, "parent")
    end
    return true
  end
  function __onSetScript(f, name, fn)
    if name ~= "OnUpdate" then return end
    local at
    for i = 1, #ouList do if ouList[i] == f then at = i; break end end
    if fn and not at then ouList[#ouList + 1] = f elseif not fn and at then table.remove(ouList, at) end
    if #ouList > 0 and not ticking then ticking = true; lastTick = hostGetTime(); hostFrame() end
  end
  function __runFrame()
    local now = hostGetTime()
    local elapsed = now - lastTick
    lastTick = now
    local list = {}
    for i = 1, #ouList do list[i] = ouList[i] end
    for i = 1, #list do
      local f = list[i]
      local fn = f.scripts.OnUpdate
      if fn and visible(f) then
        local ok, err = xpcall(fn, traceback, f, elapsed)
        if not ok then hostError(err, "uncaught") end
      end
    end
    if #ouList > 0 then hostFrame() else ticking = false end
  end

  if __sandbox then
    -- What the game's Lua 5.1 has and fengari's 5.3 does not, and the reverse.
    loadstring = loadstring or function(s, name) return load(s, name) end
    math.pow = math.pow or function(a, b) return a ^ b end
    math.mod = math.mod or math.fmod
    math.log10 = math.log10 or function(x) return math.log(x, 10) end
    table.getn = table.getn or function(t) return #t end
    table.maxn = table.maxn or function(t) local n = 0; for k in pairs(t) do if type(k) == "number" and k > n then n = k end end return n end
    string.gfind = string.gfind or string.gmatch
    wipe = function(t) for k in pairs(t) do t[k] = nil end return t end
    tremove = table.remove
    strlen, strsub, strlower, strupper = string.len, string.sub, string.lower, string.upper
    strfind, strmatch, gsub, format = string.find, string.match, string.gsub, string.format
    strrep, strbyte, strchar = string.rep, string.byte, string.char
    floor, ceil, abs, max, min, sqrt, mod = math.floor, math.ceil, math.abs, math.max, math.min, math.sqrt, math.fmod
    strtrim = function(s, chars)
      chars = chars and ("[" .. chars:gsub("[%]%^%-%%]", "%%%0") .. "]") or "%s"
      return (s:gsub("^" .. chars .. "+", ""):gsub(chars .. "+$", ""))
    end
    strjoin = function(sep, ...) return table.concat({ ... }, sep) end
    os, io, package, require, dofile, loadfile, utf8 = nil, nil, nil, nil, nil, nil, nil
    string.pack, string.unpack, string.packsize = nil, nil, nil
    math.type, math.tointeger, math.ult = nil, nil, nil
    table.move, table.unpack, table.pack = nil, nil, nil
    coroutine.isyieldable = nil
  end
end
`;

// Item and spell names, when options.gameData is given. __gameIface: "classic", "retail" or "both".
const GAMEDATA = `
do
  local iface = __gameIface
  local hostName, hostInfo, hostLoad, hostCached, hostExists, hostByName, hostSpell =
    __hostItemName, __hostItemInfo, __hostItemLoad, __hostItemCached, __hostItemExists, __hostItemByName, __hostSpellName
  local function itemId(x)
    if type(x) == "number" then return x end
    if type(x) == "string" then
      local id = string.match(x, "item:(%d+)")
      if id then return tonumber(id) end
      if string.match(x, "^%d+$") then return tonumber(x) end
      return hostByName(x)
    end
  end
  C_Item = C_Item or {}
  C_Item.GetItemNameByID = function(x) local id = itemId(x); if id then return hostName(id) end end
  C_Item.RequestLoadItemDataByID = function(x) local id = itemId(x); if id then hostLoad(id) end end
  C_Item.IsItemDataCachedByID = function(x) local id = itemId(x); return id ~= nil and hostCached(id) end
  C_Item.DoesItemExistByID = function(x) local id = itemId(x); return id ~= nil and hostExists(id) end
  local function info(x) local id = itemId(x); if id then return hostInfo(id) end end
  if iface ~= "classic" then C_Item.GetItemInfo = info end
  if iface ~= "retail" then GetItemInfo = info end
  local function spellId(x) if type(x) == "number" then return x end if type(x) == "string" then return tonumber(x) end end
  if iface ~= "classic" then
    C_Spell = C_Spell or {}
    C_Spell.GetSpellName = function(x) local id = spellId(x); if id then return hostSpell(id) end end
    C_Spell.GetSpellInfo = function(x)
      local id = spellId(x)
      local n = id and hostSpell(id)
      if n then return { name = n, spellID = id, iconID = 136243, originalIconID = 136243, castTime = 0, minRange = 0, maxRange = 0 } end
    end
  end
  if iface ~= "retail" then
    GetSpellInfo = function(x)
      local id = spellId(x)
      local n = id and hostSpell(id)
      if n then return n, nil, 136243, 0, 0, 0, id end
    end
  end
end
`;

const BUILD = {
  16001: ['1.16.0', '64000', 'Oct 1 2026', 16001, 2],
  120105: ['12.0.5', '64000', 'Oct 1 2026', 120105, 1],
};

const CLASSES = {
  WARRIOR: ['Warrior', 1], PALADIN: ['Paladin', 2], HUNTER: ['Hunter', 3], ROGUE: ['Rogue', 4], PRIEST: ['Priest', 5],
  DEATHKNIGHT: ['Death Knight', 6], SHAMAN: ['Shaman', 7], MAGE: ['Mage', 8], WARLOCK: ['Warlock', 9], MONK: ['Monk', 10],
  DRUID: ['Druid', 11], DEMONHUNTER: ['Demon Hunter', 12], EVOKER: ['Evoker', 13],
};
const RACES = {
  Human: ['Human', 1], Orc: ['Orc', 2], Dwarf: ['Dwarf', 3], NightElf: ['Night Elf', 4], Scourge: ['Undead', 5],
  Tauren: ['Tauren', 6], Gnome: ['Gnome', 7], Troll: ['Troll', 8], Goblin: ['Goblin', 9], BloodElf: ['Blood Elf', 10],
  Draenei: ['Draenei', 11],
};
const DEFAULT_RANK_NAMES = ['Guild Master', 'Officer', 'Veteran', 'Member', 'Initiate', 'Alt', 'Recruit', 'Rank 8', 'Rank 9', 'Rank 10'];

const SEND_RESULT = Object.freeze({ Success: 0, InvalidPrefix: 1, InvalidMessage: 2, AddonMessageThrottle: 3, InvalidChatType: 4,
  NotInGroup: 5, TargetRequired: 6, InvalidChannel: 7, ChannelThrottle: 8, GeneralError: 9, NotInGuild: 10,
  AddOnMessageLockdown: 11, TargetOffline: 12 });
const REGISTER_RESULT = Object.freeze({ Success: 0, DuplicatePrefix: 1, InvalidPrefix: 2, MaxPrefixes: 3 });
// What a transport answers → the enum name the game returns.
const RESULT_NAME = { ok: 'Success', throttle: 'AddonMessageThrottle', lockdown: 'AddOnMessageLockdown', notInGuild: 'NotInGuild',
  error: 'GeneralError', invalidChatType: 'InvalidChatType', offline: 'TargetOffline' };
const CHAT_TYPES = new Set(['PARTY', 'RAID', 'GUILD', 'OFFICER', 'WHISPER', 'CHANNEL', 'INSTANCE_CHAT', 'SAY', 'YELL']);

function normalizeRealm(realm) { return realm == null ? null : String(realm).replace(/[\s-]/g, ''); }

// date() and time(tbl) for virtual mode: C-locale strftime on a fixed UTC offset, so every machine prints the same.
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function dateParts(seconds) {
  const d = new Date(seconds * 1000);
  const year = d.getUTCFullYear();
  const yday = Math.floor((Date.UTC(year, d.getUTCMonth(), d.getUTCDate()) - Date.UTC(year, 0, 1)) / 86400000) + 1;
  return { year, month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), min: d.getUTCMinutes(), sec: d.getUTCSeconds(),
    wday: d.getUTCDay() + 1, yday };
}
function strftime(fmt, seconds) {
  const p = dateParts(seconds);
  const two = (n) => String(n).padStart(2, '0');
  const week = (startMonday) => {
    const wd = startMonday ? (p.wday + 5) % 7 : p.wday - 1; // days since the week's first day
    return two(Math.floor((p.yday - 1 - wd + 7) / 7));
  };
  const codes = {
    a: () => DAYS[p.wday - 1].slice(0, 3), A: () => DAYS[p.wday - 1], b: () => MONTHS[p.month - 1].slice(0, 3),
    B: () => MONTHS[p.month - 1], c: () => `${codes.a()} ${codes.b()} ${String(p.day).padStart(2, ' ')} ${codes.X()} ${p.year}`,
    d: () => two(p.day), e: () => String(p.day).padStart(2, ' '), H: () => two(p.hour), I: () => two(((p.hour + 11) % 12) + 1),
    j: () => String(p.yday).padStart(3, '0'), m: () => two(p.month), M: () => two(p.min), p: () => (p.hour < 12 ? 'AM' : 'PM'),
    S: () => two(p.sec), U: () => week(false), W: () => week(true), w: () => String(p.wday - 1), x: () => `${two(p.month)}/${two(p.day)}/${two(p.year % 100)}`,
    X: () => `${two(p.hour)}:${two(p.min)}:${two(p.sec)}`, y: () => two(p.year % 100), Y: () => String(p.year), Z: () => 'UTC', '%': () => '%',
  };
  return fmt.replace(/%(.)/g, (m, c) => {
    if (!codes[c]) throw new Error(`bad argument #1 to 'date' (invalid conversion specifier '%${c}')`);
    return codes[c]();
  });
}

// options.player → the table the PLAYER chunk reads.
function normalizePlayer(p) {
  const classToken = String(p.classToken || p.class || 'SHAMAN').toUpperCase();
  const cls = CLASSES[classToken] || [classToken, 0];
  const raceToken = p.raceToken || p.race || 'Orc';
  const race = RACES[raceToken] || [raceToken, 0];
  const name = p.name || 'Thrallia';
  const realm = p.realm == null ? null : String(p.realm);
  const rankIndex = p.rankIndex ?? p.rank ?? 0;
  return {
    name, realm, realmNormalized: normalizeRealm(realm), class: cls[0], classToken, classId: cls[1],
    race: race[0], raceToken, raceId: race[1], level: p.level ?? 60, faction: p.faction || 'Horde',
    guild: p.guild === undefined ? 'wow' : p.guild, rankIndex, rankName: p.rankName || DEFAULT_RANK_NAMES[rankIndex] || `Rank ${rankIndex + 1}`,
    zone: p.zone || 'The Barrens',
    guid: p.guid || `Player-4000-${(hashString(`${name}-${realm}`) >>> 0).toString(16).toUpperCase().padStart(8, '0')}`,
  };
}

// A roster entry (tuple like the old mock, or an object) → { name, rankName, rankIndex, ... }.
function normalizeMember(m, realm) {
  if (Array.isArray(m)) {
    return { name: m[0], rankName: m[1], rankIndex: m[2], level: m[3], className: m[4], zone: m[5], note: m[6] || '',
      officerNote: m[7] || '', online: !!m[8], status: m[9] || 0, classToken: m[10], guid: null };
  }
  const classToken = String(m.classToken || m.class || 'WARRIOR').toUpperCase();
  const rankIndex = m.rankIndex ?? m.rank ?? 3;
  let name = String(m.name);
  const r = normalizeRealm(m.realm ?? realm);
  if (!name.includes('-') && r) name = `${name}-${r}`;
  return {
    name, rankName: m.rankName || DEFAULT_RANK_NAMES[rankIndex] || `Rank ${rankIndex + 1}`, rankIndex, level: m.level ?? 60,
    className: (CLASSES[classToken] || [classToken])[0], zone: m.zone || '', note: m.note || '', officerNote: m.officerNote || '',
    online: !!m.online, status: 0, classToken, guid: m.guid || null,
  };
}

// ---------- the virtual clock ----------
class VirtualClock {
  constructor({ startTime = 1794066000, frameMs = 50 } = {}) {
    this.startMs = Math.round(startTime * 1000);
    this.ms = 0;
    this.frameMs = frameMs;
    this.events = 0;
    this._heap = [];
    this._seq = 0;
    this._watchers = new Set();
    this.dirty = false;
  }
  serverTime() { return (this.startMs + this.ms) / 1000; }
  get elapsed() { return this.ms / 1000; }
  get pending() { return this._heap.length; }
  schedule(delayMs, fn) { return this.at(this.ms + Math.max(0, Math.round(delayMs)), fn); }
  at(ms, fn) {
    const e = { t: Math.max(this.ms, Math.round(ms)), seq: this._seq++, fn };
    const h = this._heap;
    h.push(e);
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (less(h[p], e)) break;
      h[i] = h[p]; i = p;
    }
    h[i] = e;
    return e;
  }
  cancel(e) { if (e) e.fn = null; }
  _pop() {
    const h = this._heap;
    const top = h[0];
    const last = h.pop();
    if (h.length) {
      let i = 0;
      const n = h.length;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const c = r < n && less(h[r], h[l]) ? r : l;
        if (less(last, h[c])) break;
        h[i] = h[c]; i = c;
      }
      h[i] = last;
    }
    return top;
  }
  // Run everything due in the next `seconds` (timers, deliveries, frames), in time order.
  run(seconds) { return this.runUntilMs(this.ms + Math.round(seconds * 1000)); }
  runUntilMs(end) {
    while (this._heap.length && this._heap[0].t <= end) {
      const e = this._pop();
      if (!e.fn) continue;
      this.ms = e.t;
      this.events++;
      const fn = e.fn;
      e.fn = null;
      fn();
      if (this.dirty) this.check();
    }
    if (end > this.ms) this.ms = end;
    if (this.dirty) this.check();
    return this;
  }
  watch(w) { this._watchers.add(w); }
  unwatch(w) { this._watchers.delete(w); }
  check() {
    this.dirty = false;
    for (const w of this._watchers) w.check();
  }
}
function less(a, b) { return a.t < b.t || (a.t === b.t && a.seq < b.seq); }

// ---------- fengari plumbing ----------
const LSTR = new Map();
function lstr(s) {
  let v = LSTR.get(s);
  if (!v) { v = to_luastring(s); LSTR.set(s, v); }
  return v;
}
function load(L, code, name) {
  // Buffers go in byte for byte (like the game reading a file); JS strings are encoded as UTF-8.
  const bytes = Buffer.isBuffer(code) ? new Uint8Array(code) : to_luastring(code);
  if (lauxlib.luaL_loadbuffer(L, bytes, null, to_luastring(name)) !== lua.LUA_OK) {
    const msg = to_jsstring(lua.lua_tostring(L, -1), undefined, undefined, true);
    lua.lua_settop(L, 0);
    throw new Error(msg);
  }
}
function errorText(L) {
  return lua.lua_isstring(L, -1) ? to_jsstring(lua.lua_tostring(L, -1), undefined, undefined, true) : 'Lua error (no message)';
}
function call(L, nargs, nres) {
  if (lua.lua_pcall(L, nargs, nres, 0) !== lua.LUA_OK) {
    const msg = errorText(L);
    lua.lua_settop(L, 0);
    throw new Error(msg);
  }
}
const str = (L, idx) => to_jsstring(lua.lua_tostring(L, idx), undefined, undefined, true);

// Convert the Lua value at idx into JS. Same array rule as the SavedVariables parser.
function luaToJs(L, idx, seen = new Set(), depth = 0) {
  idx = lua.lua_absindex(L, idx);
  switch (lua.lua_type(L, idx)) {
    case lua.LUA_TNIL: return null;
    case lua.LUA_TBOOLEAN: return lua.lua_toboolean(L, idx);
    case lua.LUA_TNUMBER: return lua.lua_tonumber(L, idx);
    case lua.LUA_TSTRING: return str(L, idx);
    case lua.LUA_TTABLE: {
      const ptr = lua.lua_topointer(L, idx);
      if (seen.has(ptr) || depth > 40) return '[cycle]';
      seen.add(ptr);
      const entries = [];
      lua.lua_pushnil(L);
      while (lua.lua_next(L, idx) !== 0) {
        const kt = lua.lua_type(L, -2);
        let key;
        if (kt === lua.LUA_TNUMBER) key = lua.lua_tonumber(L, -2);
        else if (kt === lua.LUA_TSTRING) key = str(L, -2);
        if (key !== undefined && lua.lua_type(L, -1) !== lua.LUA_TFUNCTION) entries.push([key, luaToJs(L, -1, seen, depth + 1)]);
        lua.lua_pop(L, 1);
      }
      seen.delete(ptr);
      const n = entries.length;
      if (n > 0 && entries.every(([k]) => Number.isInteger(k) && k >= 1 && k <= n)) {
        const arr = new Array(n);
        for (const [k, v] of entries) arr[k - 1] = v;
        return arr;
      }
      const obj = {};
      for (const [k, v] of entries) obj[String(k)] = v;
      return obj;
    }
    default: return `[${to_jsstring(lua.lua_typename(L, lua.lua_type(L, idx)))}]`;
  }
}

// JS → the Lua stack. Whole numbers inside fengari's 32-bit integer range become integers, everything else a float.
function pushJs(L, v) {
  if (v === null || v === undefined) lua.lua_pushnil(L);
  else if (typeof v === 'boolean') lua.lua_pushboolean(L, v);
  else if (typeof v === 'number') {
    if (Number.isInteger(v) && v >= -2147483648 && v <= 2147483647 && !Object.is(v, -0)) lua.lua_pushinteger(L, v);
    else lua.lua_pushnumber(L, v);
  } else if (typeof v === 'string') lua.lua_pushstring(L, to_luastring(v));
  else if (v instanceof Uint8Array) lua.lua_pushstring(L, v);
  else if (Array.isArray(v)) {
    lua.lua_createtable(L, v.length, 0);
    v.forEach((x, i) => { pushJs(L, x); lua.lua_rawseti(L, -2, i + 1); });
  } else if (typeof v === 'object') {
    lua.lua_createtable(L, 0, 0);
    for (const [k, x] of Object.entries(v)) { pushJs(L, x); lua.lua_setfield(L, -2, to_luastring(k)); }
  } else lua.lua_pushnil(L);
}
const argBytes = (L, i) => {
  const t = lua.lua_type(L, i);
  if (t !== lua.LUA_TSTRING && t !== lua.LUA_TNUMBER) return null;
  return Buffer.from(lua.lua_tolstring(L, i));
};
const argStr = (L, i) => {
  const b = argBytes(L, i);
  return b === null ? null : b.toString('utf8');
};
const argNum = (L, i) => (lua.lua_type(L, i) === lua.LUA_TNUMBER ? lua.lua_tonumber(L, i) : (lua.lua_type(L, i) === lua.LUA_TSTRING ? Number(argStr(L, i)) : NaN));

// Addon files are read once per process (re-read when they change on disk).
const FILES = new Map();
function readSource(file) {
  const st = fs.statSync(file);
  const hit = FILES.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.buf;
  const buf = fs.readFileSync(file);
  FILES.set(file, { mtimeMs: st.mtimeMs, size: st.size, buf });
  return buf;
}

class WowClient {
  constructor({
    savedVariables, savedVariablesPerCharacter, inboxFile, inbox, inboxLua, addonVersion, addonDir = ADDON_DIR, mocks,
    clock = null, transport = null, player = null, roster = null, interface: iface = null, sendResult = null, seed = 1,
    gameData = null, clockSkew = 0, utcOffset = 0, uptime = null, strictErrors = true, sandbox = true, onPrint = null, onSound = null,
    rankNames = DEFAULT_RANK_NAMES, rosterCooldown = 10, rosterLatencyMs = 300, rosterAtLogin = true, name = null,
  } = {}) {
    const L = lauxlib.luaL_newstate();
    lualib.luaL_openlibs(L);
    this.L = L;
    this.addonDir = addonDir;
    this.clock = clock;
    this.virtual = !!clock;
    this.transport = transport;
    this.player = player ? normalizePlayer(player) : null;
    this.name = name || (this.player && this.player.name) || 'Thrallia';
    this.interface = iface;
    this.sendResult = sendResult || (iface && iface >= 100000 ? 'enum' : 'boolean');
    this.strictErrors = strictErrors;
    this.onPrint = onPrint;
    this.onSound = onSound;
    this.rankNames = rankNames;
    this.alive = true;
    this.prefixes = new Set();
    this.sentMessages = [];
    this.errors = [];
    this.violations = [];
    this.sounds = [];
    this.notices = [];
    this.chatLog = [];
    this._checked = { errors: 0, violations: 0 };
    this._roster = roster;
    this._rosterCache = { src: null, list: null };
    this._rosterCooldownMs = rosterCooldown * 1000;
    this._rosterLatencyMs = rosterLatencyMs;
    this._rosterAtLogin = rosterAtLogin;
    this._lastRosterServed = -Infinity;
    this._skew = clockSkew;
    this._utcOffset = utcOffset;
    this._uptimeMs = uptime != null ? Math.round(uptime * 1000) : (20000 + (hashString(`uptime:${this.name}`) % 200000)) * 1000;
    this._rng = typeof seed === 'function' ? seed : makeRng(`${seed}:${this.name}:lua`);
    this._gameRng = makeRng(`${typeof seed === 'function' ? 0 : seed}:${this.name}:game`);
    this._game = null;
    if (gameData) {
      const items = new Map();
      for (const [id, v] of Object.entries(gameData.items || {})) items.set(Number(id), typeof v === 'string' ? { name: v } : { ...v });
      const spells = new Map();
      for (const [id, v] of Object.entries(gameData.spells || {})) spells.set(Number(id), typeof v === 'string' ? v : v.name);
      const byName = new Map();
      for (const [id, v] of items) byName.set(String(v.name).toLowerCase(), id);
      this._game = { items, spells, byName, cache: gameData.cache || new Set(), allCached: !!gameData.itemsCached || !clock, pending: new Set() };
    }

    this._defineHostFunctions();
    this.exec(PRELUDE, 'prelude');
    this.exec(COMMON, 'common');
    if (BUILD[iface]) {
      const b = BUILD[iface];
      this.exec(`function GetBuildInfo() return ${toLua(b[0])}, ${toLua(b[1])}, ${toLua(b[2])}, ${b[3]} end\n` +
        `WOW_PROJECT_ID = ${b[4]}; WOW_PROJECT_MAINLINE = 1; WOW_PROJECT_CLASSIC = 2`, 'build');
    }
    if (this.player) this.exec(`__player = ${toLua(this.player)}\n${PLAYER}`, 'player');
    if (roster) this.exec(ROSTER, 'roster');
    if (clock) {
      this.exec(`__sandbox = ${sandbox ? 'true' : 'false'}\n${VIRTUAL}`, 'virtual');
      if (roster) this.exec('C_GuildInfo.GuildRoster = __hostRosterRequest; GuildRoster = __hostRosterRequest', 'roster');
      clock.watch(this);
    }
    if (this._game) {
      const style = iface === 120105 ? 'retail' : iface === 16001 ? 'classic' : 'both';
      this.exec(`__gameIface = ${toLua(style)}\n${GAMEDATA}`, 'gamedata');
    }

    const toc = readToc(addonDir);
    this.addonName = toc.name;
    const fields = { ...toc.fields };
    if (addonVersion !== undefined) fields.Version = addonVersion;
    const listOf = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
    this.svNames = listOf(fields.SavedVariables);
    if (!this.svNames.length) this.svNames = ['WowGuildDB'];
    this.svCharNames = listOf(fields.SavedVariablesPerCharacter);
    this.exec(`__tocFields = ${toLua(fields)}\n__addonName = ${toLua(toc.name)}\n__svNames = ${toLua(this.svNames)}\n` +
      `__svCharNames = ${toLua(this.svCharNames)}`, 'toc');
    if (mocks) this.exec(mocks, 'mocks');

    // WowGuild_Inbox is an optional dependency, so the game loads it before the addon.
    if (inbox !== undefined) this.exec(`WowGuildInbox = ${toLua(inbox)}\n`, 'WowGuild_Inbox/Inbox.lua');
    if (inboxLua) this.exec(inboxLua, 'WowGuild_Inbox/Inbox.lua');
    if (inboxFile) this.exec(fs.readFileSync(inboxFile), 'WowGuild_Inbox/Inbox.lua');

    // The addon's files in .toc order, each with (addonName, namespace) as varargs like the game does.
    this.exec('__ns = {}', 'ns');
    for (const f of toc.files) {
      load(L, readSource(path.join(addonDir, f)), f);
      lua.lua_pushstring(L, to_luastring(toc.name));
      lua.lua_getglobal(L, to_luastring('__ns'));
      call(L, 2, 0);
    }
    // Then its SavedVariables, just before ADDON_LOADED would fire.
    if (savedVariables) this.exec(savedVariables, 'SavedVariables/WowGuild.lua');
    if (savedVariablesPerCharacter) this.exec(savedVariablesPerCharacter, 'SavedVariables/WowGuild.lua (character)');
    this._after();
  }

  // ---------- running Lua ----------
  exec(code, name = 'chunk') { this._guard(() => { load(this.L, code, name); call(this.L, 0, 0); }); }

  eval(expr) {
    return this._guard(() => {
      load(this.L, `return ${expr}`, 'eval');
      call(this.L, 0, 1);
      const v = lua.lua_isnil(this.L, -1) ? null : to_jsstring(lauxlib.luaL_tolstring(this.L, -1), undefined, undefined, true);
      lua.lua_settop(this.L, 0);
      return v;
    });
  }

  get(expr) {
    return this._guard(() => {
      load(this.L, `return ${expr}`, 'get');
      call(this.L, 0, 1);
      const v = luaToJs(this.L, -1);
      lua.lua_settop(this.L, 0);
      return v;
    });
  }

  // A chunk, or an expression, with `ns` bound to the addon namespace. → its first result as JS.
  lua(code) {
    const L = this.L;
    return this._guard(() => {
      const prefix = 'local ns = __ns; ';
      const ok = lauxlib.luaL_loadbuffer(L, to_luastring(`${prefix}return ${code}`), null, to_luastring('lua')) === lua.LUA_OK;
      if (!ok) { lua.lua_settop(L, 0); load(L, prefix + code, 'lua'); }
      call(L, 0, 1);
      const v = luaToJs(L, -1);
      lua.lua_settop(L, 0);
      return v;
    });
  }

  // Run fn; then report new problems (a broken send wins over the Lua error it caused), else rethrow fn's error.
  _guard(fn) {
    let out;
    let err = null;
    try { out = fn(); } catch (e) { err = e; }
    this._after();
    if (err) throw err;
    return out;
  }

  fire(event, ...args) { this.exec(`__fire(${[event, ...args].map((a) => toLua(a)).join(', ')})`, 'fire'); }
  slash(text) { this.exec(`SlashCmdList.WOWGUILD(${toLua(String(text))})`, 'slash'); }
  click(frameExpr, button = 'LeftButton') { this.exec(`__click(${frameExpr}, ${toLua(button)})`, 'click'); }

  login({ reload = false } = {}) {
    if (!this.virtual) { this.fire('ADDON_LOADED', this.addonName); this.fire('PLAYER_LOGIN'); return this; }
    this._call('__fire', ['ADDON_LOADED', this.addonName]);
    this._call('__fire', ['PLAYER_LOGIN']);
    this._call('__fire', ['PLAYER_ENTERING_WORLD', !reload, reload]);
    this._call('__fire', ['LOADING_SCREEN_DISABLED']);
    if (this._roster && this._rosterAtLogin && this._inGuild()) this.scheduleEvent(2000, 'GUILD_ROSTER_UPDATE', false);
    this._after();
    return this;
  }
  logout() {
    if (!this.virtual) { this.fire('PLAYER_LOGOUT'); return this; }
    this._call('__fire', ['PLAYER_LEAVING_WORLD']);
    this._call('__fire', ['PLAYER_LOGOUT']);
    this._after();
    return this;
  }
  // The session is over (logout, reload or crash): pending timers, frames and deliveries are dropped.
  end() {
    this.alive = false;
    if (this.clock) this.clock.unwatch(this);
  }

  setInstance(on, { type = 'party', loading = 2 } = {}) {
    on = !!on;
    const finish = () => {
      if (!this.alive) return;
      this._setGlobal('__loading', false);
      this._setGlobal('__inInstance', on);
      this._setGlobal('__instanceType', on ? type : 'none');
      this._fireNow('PLAYER_ENTERING_WORLD', false, false);
      this._fireNow('ZONE_CHANGED_NEW_AREA');
      this._fireNow('LOADING_SCREEN_DISABLED');
      this._after();
    };
    this._setGlobal('__loading', true);
    this._fireNow('LOADING_SCREEN_ENABLED');
    if (this.virtual && loading > 0) this.clock.schedule(loading * 1000, finish);
    else finish();
    this._after();
    return this;
  }
  setCombat(on) {
    if (on) { this._fireNow('PLAYER_REGEN_DISABLED'); this._setGlobal('__inCombat', true); }
    else { this._setGlobal('__inCombat', false); this._fireNow('PLAYER_REGEN_ENABLED'); }
    this._after();
    return this;
  }
  inInstance() { return this._globalBool('__inInstance'); }
  inCombat() { return this._globalBool('__inCombat'); }
  loading() { return this._globalBool('__loading'); }

  // An addon message arrives. Only prefixes this client registered reach its addons (like the game).
  receive(prefix, text, channel = 'GUILD', sender = 'Grommash', target = '') {
    if (!this.prefixes.has(prefix)) return false;
    const bytes = Buffer.isBuffer(text) ? text : Buffer.from(String(text), 'utf8');
    this._fireNow('CHAT_MSG_ADDON', prefix, bytes, channel, sender, target, 0, 0, '', 0);
    this._after();
    return true;
  }
  scheduleEvent(ms, event, ...args) {
    if (!this.clock) { this._fireNow(event, ...args); this._after(); return null; }
    return this.clock.schedule(ms, () => { if (this.alive) this._call('__fire', [event, ...args]); });
  }

  // ---------- SavedVariables and output ----------
  saveVariables() { return this.eval('__saveVariables(__svNames)'); }
  saveVariablesBuffer() {
    load(this.L, 'return __saveVariables(__svNames)', 'save');
    call(this.L, 0, 1);
    const bytes = Buffer.from(lua.lua_tolstring(this.L, -1));
    lua.lua_settop(this.L, 0);
    return bytes;
  }
  saveVariablesPerCharacterBuffer() {
    if (!this.svCharNames.length) return null;
    load(this.L, 'return __saveVariables(__svCharNames)', 'save');
    call(this.L, 0, 1);
    const bytes = Buffer.from(lua.lua_tolstring(this.L, -1));
    lua.lua_settop(this.L, 0);
    return bytes;
  }
  db() { return this.get('WowGuildDB'); }

  printedLines() { const p = this.get('__printed'); return Array.isArray(p) ? p : []; }
  printed() { return this.eval('table.concat(__printed, "\\n")'); }
  texts() { const t = this.get('__texts'); return Array.isArray(t) ? t : []; }
  clearOutput() { this.exec('__printed = {}; __texts = {}', 'clear'); }
  droppedTimers() { return Number(this.eval('__timerDrops')) || 0; }

  now() { return this.clock ? this.clock.serverTime() : Date.now() / 1000; }

  // Throws for problems not reported yet: a broken send always; Lua errors in virtual mode (all of them with
  // strictErrors, else only those that reached the game).
  check() {
    const v = this.violations.slice(this._checked.violations);
    const e = this.errors.slice(this._checked.errors).filter((x) => this.strictErrors || x.kind === 'uncaught');
    this._checked.violations = this.violations.length;
    this._checked.errors = this.errors.length;
    if (v.length) throw new Error(`wowsim: ${this.name}: broken addon message: ${v[0].message}`);
    if (e.length) {
      const what = e[0].kind === 'uncaught' ? 'a Lua error reached the game' : 'the addon reported a Lua error';
      throw new Error(`wowsim: ${this.name}: ${what}: ${e[0].message}${e.length > 1 ? ` (and ${e.length - 1} more)` : ''}`);
    }
  }
  _after() {
    if (this.violations.length > this._checked.violations || this.errors.length > this._checked.errors) this.check();
  }

  // ---------- internals ----------
  _call(fname, args) {
    const L = this.L;
    lua.lua_getglobal(L, lstr(fname));
    for (const a of args) pushJs(L, a);
    if (lua.lua_pcall(L, args.length, 0, 0) !== lua.LUA_OK) {
      const msg = errorText(L);
      lua.lua_settop(L, 0);
      if (this.virtual) this._error(msg, 'uncaught');
      else throw new Error(msg);
    }
  }
  _fireNow(event, ...args) { this._call('__fire', [event, ...args]); }
  _setGlobal(name, value) { pushJs(this.L, value); lua.lua_setglobal(this.L, lstr(name)); }
  _globalBool(name) {
    lua.lua_getglobal(this.L, lstr(name));
    const v = lua.lua_toboolean(this.L, -1);
    lua.lua_pop(this.L, 1);
    return v;
  }
  _inGuild() { return this.player ? this.player.guild != null : true; }
  _error(message, kind) {
    this.errors.push({ t: this.now(), message, kind });
    if (this.clock) this.clock.dirty = true;
  }
  _violation(message) {
    this.violations.push({ t: this.now(), message });
    if (this.clock) this.clock.dirty = true;
    throw new Error(message);
  }
  _rosterList() {
    const src = typeof this._roster === 'function' ? this._roster() : this._roster;
    if (this._rosterCache.src !== src) {
      const realm = this.player && this.player.realm;
      this._rosterCache = { src, list: (src || []).map((m) => normalizeMember(m, realm)) };
    }
    return this._rosterCache.list;
  }
  _sendResult(name) {
    if (this.sendResult === 'enum') return SEND_RESULT[RESULT_NAME[name] || 'GeneralError'];
    return name === 'ok';
  }
  _localSend(m) {
    if (m.inInstance || m.loading) return { result: 'lockdown' };
    if ((m.channel === 'GUILD' || m.channel === 'OFFICER') && !this._inGuild()) return { result: 'notInGuild' };
    this.sentMessages.push({ t: this.now(), prefix: m.prefix, text: m.bytes.toString('utf8'), bytes: m.bytes, channel: m.channel, target: m.target });
    return { result: 'ok' };
  }
  _itemLoad(id) {
    const g = this._game;
    if (!this.clock || g.pending.has(id)) return;
    g.pending.add(id);
    const known = g.items.has(id);
    const delay = g.allCached || g.cache.has(id) ? this.clock.frameMs : 50 + Math.floor(this._gameRng() * 350);
    this.clock.schedule(delay, () => {
      g.pending.delete(id);
      if (!this.alive) return;
      if (known) g.cache.add(id);
      this._call('__fire', ['ITEM_DATA_LOAD_RESULT', id, known]);
      this._call('__fire', ['GET_ITEM_INFO_RECEIVED', id, known]);
    });
  }
  _itemCached(id) { const g = this._game; return g.items.has(id) && (g.allCached || g.cache.has(id)); }

  _defineHostFunctions() {
    const L = this.L;
    const def = (name, fn) => {
      lua.lua_pushcfunction(L, (L) => {
        let n;
        let err;
        try { n = fn(L); } catch (e) { err = e; }
        if (err !== undefined) {
          lauxlib.luaL_where(L, 1);
          lua.lua_pushstring(L, to_luastring(String((err && err.message) || err)));
          lua.lua_concat(L, 2);
          return lua.lua_error(L);
        }
        return n || 0;
      });
      lua.lua_setglobal(L, lstr(name));
    };
    const flt = (n) => { lua.lua_pushnumber(L, n); return 1; };
    const now = () => this.now();

    // every mode
    def('__hostRealTime', () => flt(Math.round(performance.now()) / 1000 + 10000));
    def('__hostRealMs', () => flt(performance.now()));
    def('__hostPrint', (L) => {
      const text = lua.lua_isnoneornil(L, 1) ? '' : (argStr(L, 1) ?? to_jsstring(lauxlib.luaL_tolstring(L, 1), undefined, undefined, true));
      const e = { t: now(), text };
      this.chatLog.push(e);
      if (this.onPrint) this.onPrint(text, e.t);
    });
    def('__hostSound', (L) => {
      const id = lua.lua_type(L, 1) === lua.LUA_TNUMBER ? lua.lua_tonumber(L, 1) : argStr(L, 1);
      const e = { t: now(), id, channel: argStr(L, 2) };
      this.sounds.push(e);
      if (this.onSound) this.onSound(e.id, e.channel);
    });
    def('__hostNotice', (L) => { this.notices.push({ t: now(), text: argStr(L, 1) ?? '' }); });
    def('__hostRegister', (L) => {
      const p = lua.lua_type(L, 1) === lua.LUA_TSTRING ? argStr(L, 1) : null;
      let code;
      if (!p || Buffer.byteLength(p) > 16) code = 'InvalidPrefix';
      else if (this.prefixes.has(p)) code = 'DuplicatePrefix';
      else if (this.prefixes.size >= 64) code = 'MaxPrefixes';
      else { this.prefixes.add(p); code = 'Success'; }
      if (this.sendResult === 'enum') lua.lua_pushinteger(L, REGISTER_RESULT[code]);
      else lua.lua_pushboolean(L, code === 'Success');
      return 1;
    });
    def('__hostIsRegistered', (L) => { lua.lua_pushboolean(L, this.prefixes.has(argStr(L, 1))); return 1; });
    def('__hostPrefixes', (L) => { pushJs(L, [...this.prefixes]); return 1; });
    def('__hostSend', (L) => {
      const prefix = lua.lua_type(L, 1) === lua.LUA_TSTRING ? argStr(L, 1) : null;
      const bytes = argBytes(L, 2);
      const channel = argStr(L, 3);
      const target = argStr(L, 4);
      if (prefix === null) this._violation('SendAddonMessage needs a prefix string');
      if (!this.prefixes.has(prefix)) this._violation(`SendAddonMessage on prefix "${prefix}", which this client never registered`);
      if (bytes === null) this._violation('SendAddonMessage needs a message string');
      if (bytes.length > 255) this._violation(`the message is ${bytes.length} bytes; the game's limit is 255 (${JSON.stringify(bytes.toString('utf8', 0, 40))}...)`);
      if (bytes.includes(0)) this._violation(`the message holds a NUL byte (${JSON.stringify(bytes.toString('utf8', 0, 40))})`);
      if (!CHAT_TYPES.has(channel)) this._violation(`unknown chat type ${JSON.stringify(channel)}`);
      if ((channel === 'WHISPER' || channel === 'CHANNEL') && !target) this._violation(`${channel} needs a target`);
      const m = { prefix, bytes, channel, target, inCombat: this._globalBool('__inCombat'), inInstance: this._globalBool('__inInstance'),
        loading: this._globalBool('__loading') };
      const res = this.transport ? this.transport.send(this, m) : this._localSend(m);
      if (res && res.violation) this._violation(res.violation);
      const out = this._sendResult(res ? res.result : 'error');
      if (typeof out === 'boolean') lua.lua_pushboolean(L, out); else lua.lua_pushinteger(L, out);
      return 1;
    });

    // virtual mode
    def('__hostGetTime', () => flt((this._uptimeMs + this.clock.ms) / 1000));
    def('__hostServerTime', () => flt(Math.floor(this.clock.serverTime())));
    def('__hostTime', () => flt(Math.floor(this.clock.serverTime() + this._skew)));
    def('__hostDate', (L) => {
      let fmt = lua.lua_isnoneornil(L, 1) ? '%c' : argStr(L, 1);
      const t = lua.lua_isnoneornil(L, 2) ? Math.floor(this.clock.serverTime() + this._skew) : Math.floor(argNum(L, 2));
      if (fmt === null || !Number.isFinite(t)) throw new Error("bad argument to 'date'");
      let offset = this._utcOffset * 3600;
      if (fmt.startsWith('!')) { fmt = fmt.slice(1); offset = 0; }
      if (fmt.startsWith('*t')) {
        pushJs(L, { ...dateParts(t + offset), isdst: false });
        return 1;
      }
      pushJs(L, strftime(fmt, t + offset));
      return 1;
    });
    def('__hostMakeTime', (L) => {
      if (!lua.lua_istable(L, 1)) throw new Error("bad argument #1 to 'time' (table expected)");
      const field = (k, dflt) => {
        lua.lua_getfield(L, 1, to_luastring(k));
        const v = lua.lua_isnil(L, -1) ? dflt : lua.lua_tonumber(L, -1);
        lua.lua_pop(L, 1);
        if (v === undefined) throw new Error(`field '${k}' missing in date table`);
        return Math.floor(v);
      };
      const ms = Date.UTC(field('year'), field('month') - 1, field('day'), field('hour', 12), field('min', 0), field('sec', 0));
      return flt(ms / 1000 - this._utcOffset * 3600);
    });
    def('__hostSchedule', (L) => {
      const d = lua.lua_tonumber(L, 1);
      const id = lua.lua_tointeger(L, 2);
      const ms = Math.max(this.clock.frameMs, Number.isFinite(d) ? Math.round(d * 1000) : 0);
      this.clock.schedule(ms, () => { if (this.alive) this._call('__runTimer', [id]); });
    });
    def('__hostFrame', () => {
      this.clock.schedule(this.clock.frameMs, () => { if (this.alive) this._call('__runFrame', []); });
    });
    def('__hostError', (L) => { this._error(argStr(L, 1) ?? 'Lua error (no message)', argStr(L, 2) || 'uncaught'); });
    def('__hostRandom', (L) => {
      const n = lua.lua_gettop(L);
      const r = this._rng();
      if (n === 0) return flt(r);
      let lo = 1;
      let hi;
      if (n === 1) hi = Math.floor(lua.lua_tonumber(L, 1));
      else { lo = Math.floor(lua.lua_tonumber(L, 1)); hi = Math.floor(lua.lua_tonumber(L, 2)); }
      if (!(lo <= hi)) throw new Error(`bad argument #${n} to 'random' (interval is empty)`);
      pushJs(L, lo + Math.floor(r * (hi - lo + 1)));
      return 1;
    });
    def('__hostRosterRequest', () => {
      if (!this.clock || !this._roster) return 0;
      if (this.clock.ms - this._lastRosterServed < this._rosterCooldownMs) return 0;
      this._lastRosterServed = this.clock.ms;
      this.scheduleEvent(this._rosterLatencyMs, 'GUILD_ROSTER_UPDATE', false);
      return 0;
    });

    // roster
    def('__hostRosterCount', (L) => {
      if (!this._inGuild()) { pushJs(L, 0); pushJs(L, 0); pushJs(L, 0); return 3; }
      const list = this._rosterList();
      const online = list.filter((m) => m.online).length;
      pushJs(L, list.length); pushJs(L, online); pushJs(L, online);
      return 3;
    });
    def('__hostRosterInfo', (L) => {
      const m = this._inGuild() ? this._rosterList()[argNum(L, 1) - 1] : null;
      if (!m) return 0;
      for (const v of [m.name, m.rankName, m.rankIndex, m.level, m.className, m.zone, m.note, m.officerNote, m.online, m.status,
        m.classToken, 0, 0, false, false, 4, m.guid]) pushJs(L, v);
      return 17;
    });
    def('__hostRankCount', (L) => { pushJs(L, this.rankNames.length); return 1; });
    def('__hostRankName', (L) => { pushJs(L, this.rankNames[argNum(L, 1) - 1] ?? null); return 1; });

    // game data
    def('__hostItemName', (L) => {
      const id = argNum(L, 1);
      if (this._itemCached(id)) { pushJs(L, this._game.items.get(id).name); return 1; }
      this._itemLoad(id);
      return 0;
    });
    def('__hostItemInfo', (L) => {
      const id = argNum(L, 1);
      if (!this._itemCached(id)) { this._itemLoad(id); return 0; }
      const it = this._game.items.get(id);
      const q = it.quality ?? 1;
      const color = ['ff9d9d9d', 'ffffffff', 'ff1eff00', 'ff0070dd', 'ffa335ee', 'ffff8000'][q] || 'ffffffff';
      const link = `|c${color}|Hitem:${id}::::::::60:::::|h[${it.name}]|h|r`;
      for (const v of [it.name, link, q, it.level ?? 1, it.minLevel ?? 0, it.type ?? 'Miscellaneous', it.subType ?? 'Junk',
        it.stack ?? 1, it.equipLoc ?? '', it.texture ?? 134400, it.sellPrice ?? 0, it.classID ?? 15, it.subclassID ?? 0]) pushJs(L, v);
      return 13;
    });
    def('__hostItemLoad', (L) => { this._itemLoad(argNum(L, 1)); });
    def('__hostItemCached', (L) => { lua.lua_pushboolean(L, this._itemCached(argNum(L, 1))); return 1; });
    def('__hostItemExists', (L) => { lua.lua_pushboolean(L, this._game.items.has(argNum(L, 1))); return 1; });
    def('__hostItemByName', (L) => {
      const id = this._game.byName.get(String(argStr(L, 1)).toLowerCase());
      if (id === undefined || !this._itemCached(id)) return 0;
      pushJs(L, id);
      return 1;
    });
    def('__hostSpellName', (L) => { pushJs(L, this._game.spells.get(argNum(L, 1)) ?? null); return 1; });
  }
}

module.exports = {
  WowClient, VirtualClock, toLua, readToc, luaToJs, ADDON_DIR, SEND_RESULT, REGISTER_RESULT, DEFAULT_RANK_NAMES,
  hashString, makeRng, normalizeRealm,
};
