// wowsim: a tiny simulated WoW client for tests.
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
// API
//   new WowClient(options)
//     options.savedVariables  string|Buffer  contents of WTF/.../SavedVariables/WowGuild.lua from an earlier session
//     options.inboxFile       path           a WowGuild_Inbox/Inbox.lua written by the app (loaded before the addon)
//     options.inbox           object         the inbox as a JS object; becomes `WowGuildInbox = {...}` (toLua)
//     options.inboxLua        string         Lua source for the inbox, used as-is
//     options.addonVersion    string         what C_AddOns.GetAddOnMetadata("WowGuild", "Version") returns
//                                            (default: the ## Version: line of the real WowGuild.toc)
//     options.addonDir        path           addon folder to load (default: <repo>/addon/WowGuild)
//     options.mocks           string         extra Lua run after the built-in mocks but BEFORE the addon loads
//                                            (for APIs the addon reads at load time, e.g. Settings, LibStub)
//   wow.exec(code, name?)        run Lua. Throws an Error with the Lua message on failure.
//   wow.eval(expr)               evaluate a Lua expression → tostring() of the result as a JS string, or null for nil
//   wow.get(expr)                evaluate a Lua expression → a JS value (tables become arrays/objects, the same
//                                rules as the SavedVariables parser: keys exactly 1..n make an array, {} is {})
//   wow.fire(event, ...args)     fire a game event on every frame registered for it (args converted with toLua)
//   wow.slash(text)              run "/wow <text>"
//   wow.click(frameExpr, button?) click a frame (runs its OnClick script), e.g. wow.click('WowGuildMinimapButton')
//   wow.login() / wow.logout()   ADDON_LOADED + PLAYER_LOGIN, or PLAYER_LOGOUT
//   wow.saveVariables()          the SavedVariables file text the game would write (JS string)
//   wow.saveVariablesBuffer()    the same as raw bytes (Buffer), exactly what lands on disk
//   wow.db()                     WowGuildDB as a JS object
//   wow.printed()                every chat line the addon printed, joined with "\n"
//   wow.printedLines()           the same as an array
//   wow.texts()                  every string any frame was given with SetText (window text, buttons, tooltips)
//   wow.clearOutput()            forget printed lines and SetText history
//   wow.L                        the raw fengari lua_State, if you need it
//
// Lua-side helpers (usable in exec/eval): __ns (the addon namespace), __fire(event, ...),
// __click(frame, button), __printed, __texts, __popups (StaticPopup_Show count), __inCombat (set true to
// simulate combat), __bags (bag contents table), __tocFields (the parsed .toc fields).
//
// Module exports: { WowClient, toLua, readToc, ADDON_DIR }
//   toLua(value)    JS value → Lua table constructor source
//   readToc(dir?)   → { fields: { Interface, Title, Version, ... }, files: ['Core.lua', ...] }

const fs = require('fs');
const path = require('path');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');

const ADDON_DIR = path.join(__dirname, '..', '..', 'addon', 'WowGuild');

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
  const text = fs.readFileSync(path.join(dir, 'WowGuild.toc'), 'utf8');
  const fields = {};
  const files = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^##\s*([^:]+?)\s*:\s*(.*)$/.exec(line);
    if (m) fields[m[1]] = m[2];
    else if (!line.startsWith('#')) files.push(line.replace(/\\/g, '/'));
  }
  return { fields, files };
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
DEFAULT_CHAT_FRAME = { AddMessage = function(self, m) table.insert(__printed, m) end }
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
  function f:RegisterEvent(e) self.events[e] = true end
  function f:UnregisterEvent(e) self.events[e] = nil end
  function f:SetScript(n, fn) self.scripts[n] = fn end
  function f:GetScript(n) return self.scripts[n] end
  function f:Show() self.shown = true end
  function f:Hide() self.shown = false end
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
C_AddOns = { GetAddOnMetadata = function(name, field) if name == "WowGuild" then return __tocFields[field] end end }
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
function __saveVariables() return "\\nWowGuildDB = " .. ser(WowGuildDB, "") .. "\\n" end
`;

// ---------- fengari plumbing ----------
function load(L, code, name) {
  // Buffers go in byte for byte (like the game reading a file); JS strings are encoded as UTF-8.
  const bytes = Buffer.isBuffer(code) ? new Uint8Array(code) : to_luastring(code);
  if (lauxlib.luaL_loadbuffer(L, bytes, null, to_luastring(name)) !== lua.LUA_OK) {
    const msg = to_jsstring(lua.lua_tostring(L, -1), undefined, undefined, true);
    lua.lua_settop(L, 0);
    throw new Error(msg);
  }
}
function call(L, nargs, nres) {
  if (lua.lua_pcall(L, nargs, nres, 0) !== lua.LUA_OK) {
    const msg = lua.lua_isstring(L, -1) ? to_jsstring(lua.lua_tostring(L, -1), undefined, undefined, true) : 'Lua error (no message)';
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

class WowClient {
  constructor({ savedVariables, inboxFile, inbox, inboxLua, addonVersion, addonDir = ADDON_DIR, mocks } = {}) {
    const L = lauxlib.luaL_newstate();
    lualib.luaL_openlibs(L);
    this.L = L;
    this.addonDir = addonDir;
    this.exec(PRELUDE, 'prelude');
    const toc = readToc(addonDir);
    const fields = { ...toc.fields };
    if (addonVersion !== undefined) fields.Version = addonVersion;
    this.exec(`__tocFields = ${toLua(fields)}`, 'toc');
    if (mocks) this.exec(mocks, 'mocks');

    // WowGuild_Inbox is an optional dependency, so the game loads it before the addon.
    if (inbox !== undefined) this.exec(`WowGuildInbox = ${toLua(inbox)}\n`, 'WowGuild_Inbox/Inbox.lua');
    if (inboxLua) this.exec(inboxLua, 'WowGuild_Inbox/Inbox.lua');
    if (inboxFile) this.exec(fs.readFileSync(inboxFile), 'WowGuild_Inbox/Inbox.lua');

    // The addon's files in .toc order, each with (addonName, namespace) as varargs like the game does.
    this.exec('__ns = {}', 'ns');
    for (const f of toc.files) {
      load(L, fs.readFileSync(path.join(addonDir, f)), f);
      lua.lua_pushstring(L, to_luastring('WowGuild'));
      lua.lua_getglobal(L, to_luastring('__ns'));
      call(L, 2, 0);
    }
    // Then its SavedVariables, just before ADDON_LOADED would fire.
    if (savedVariables) this.exec(savedVariables, 'SavedVariables/WowGuild.lua');
  }

  exec(code, name = 'chunk') { load(this.L, code, name); call(this.L, 0, 0); }

  eval(expr) {
    load(this.L, `return ${expr}`, 'eval');
    call(this.L, 0, 1);
    const v = lua.lua_isnil(this.L, -1) ? null : to_jsstring(lauxlib.luaL_tolstring(this.L, -1), undefined, undefined, true);
    lua.lua_settop(this.L, 0);
    return v;
  }

  get(expr) {
    load(this.L, `return ${expr}`, 'get');
    call(this.L, 0, 1);
    const v = luaToJs(this.L, -1);
    lua.lua_settop(this.L, 0);
    return v;
  }

  fire(event, ...args) { this.exec(`__fire(${[event, ...args].map((a) => toLua(a)).join(', ')})`, 'fire'); }
  slash(text) { this.exec(`SlashCmdList.WOWGUILD(${toLua(String(text))})`, 'slash'); }
  click(frameExpr, button = 'LeftButton') { this.exec(`__click(${frameExpr}, ${toLua(button)})`, 'click'); }
  login() { this.fire('ADDON_LOADED', 'WowGuild'); this.fire('PLAYER_LOGIN'); return this; }
  logout() { this.fire('PLAYER_LOGOUT'); return this; }

  saveVariables() { return this.eval('__saveVariables()'); }
  saveVariablesBuffer() {
    load(this.L, 'return __saveVariables()', 'save');
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
}

module.exports = { WowClient, toLua, readToc, ADDON_DIR };
