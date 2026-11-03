// A tiny simulated WoW client: runs the real addon Lua files (via fengari)
// against mocked game APIs, fires events, and writes a SavedVariables file
// the way the game does.
const fs = require('fs');
const path = require('path');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');

const ADDON_DIR = path.join(__dirname, '..', '..', 'addon', 'WowGuild');

const PRELUDE = `
time = os.time
date = os.date
strsplit = nil
tinsert = table.insert
UISpecialFrames = {}
__printed = {}
DEFAULT_CHAT_FRAME = { AddMessage = function(self, m) table.insert(__printed, m) end }
local frames = {}
local function newFrame()
  local f = { events = {}, scripts = {}, shown = false }
  local mt = { __index = function(t, k)
    return function(self, ...) return nil end
  end }
  setmetatable(f, mt)
  function f:RegisterEvent(e) self.events[e] = true end
  function f:SetScript(n, fn) self.scripts[n] = fn end
  function f:Show() self.shown = true end
  function f:Hide() self.shown = false end
  function f:IsShown() return self.shown end
  function f:CreateFontString() local s = newFrame(); function s:SetText(t) self.text = t end; function s:GetStringHeight() return 100 end; return s end
  frames[#frames + 1] = f
  return f
end
function CreateFrame() return newFrame() end
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
local roster = {
  {"Thrallia-Forever", "Guild Master", 0, 23, "Shaman", "The Barrens", "", "", true, 0, "SHAMAN"},
  {"Grommash Hellscream-Forever", "Officer", 1, 31, "Warrior", "Hillsbrad Foothills", "", "", true, 0, "WARRIOR"},
  {"Zuljinne", "Member", 2, 18, "Hunter", "Stonetalon Mountains", "", "", false, 0, "HUNTER"},
}
function GetNumGuildMembers() return #roster end
function GetGuildRosterInfo(i) return unpack(roster[i]) end
unpack = unpack or table.unpack
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
    if not (type(k) == "number" and k >= 1 and k <= n and k % 1 == 0) then
      local key = type(k) == "string" and string.format("[%q]", k) or ("[" .. tostring(k) .. "]")
      out[#out + 1] = indent .. "\\t" .. key .. " = " .. ser(val, indent .. "\\t") .. ",\\n"
    end
  end
  out[#out + 1] = indent .. "}"
  return table.concat(out)
end
function __saveVariables() return "\\nWowGuildDB = " .. ser(WowGuildDB, "") .. "\\n" end
`;

function run(L, code, name) {
  if (lauxlib.luaL_loadbuffer(L, to_luastring(code), null, to_luastring(name)) !== lua.LUA_OK) {
    throw new Error(to_jsstring(lua.lua_tostring(L, -1)));
  }
  return L;
}
function call(L, nargs, nres) {
  if (lua.lua_pcall(L, nargs, nres, 0) !== lua.LUA_OK) throw new Error(to_jsstring(lua.lua_tostring(L, -1)));
}

class WowClient {
  constructor({ savedVariables, inboxFile } = {}) {
    const L = lauxlib.luaL_newstate();
    lualib.luaL_openlibs(L);
    this.L = L;
    this.exec(PRELUDE, 'prelude');
    if (savedVariables) this.exec(savedVariables, 'SavedVariables');
    // Load addon files in .toc order, each with (addonName, namespace) as varargs like WoW does.
    this.exec('__ns = {}', 'ns');
    const toc = fs.readFileSync(path.join(ADDON_DIR, 'WowGuild.toc'), 'utf8');
    const files = toc.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#')).map((l) => l.trim().replace(/\\/g, '/'));
    for (const f of files) {
      const src = f === 'Data/Inbox.lua' && inboxFile ? fs.readFileSync(inboxFile, 'utf8') : fs.readFileSync(path.join(ADDON_DIR, f), 'utf8');
      run(L, src, f);
      lua.lua_pushstring(L, to_luastring('WowGuild'));
      lua.lua_getglobal(L, to_luastring('__ns'));
      call(L, 2, 0);
    }
  }
  exec(code, name = 'chunk') { run(this.L, code, name); call(this.L, 0, 0); }
  eval(expr) {
    run(this.L, `return ${expr}`, 'eval');
    call(this.L, 0, 1);
    const v = lua.lua_isnil(this.L, -1) ? null : to_jsstring(lauxlib.luaL_tolstring(this.L, -1));
    lua.lua_settop(this.L, 0);
    return v;
  }
  fire(event, ...args) { this.exec(`__fire(${[JSON.stringify(event), ...args.map((a) => JSON.stringify(a))].join(', ')})`, 'fire'); }
  slash(text) { this.exec(`SlashCmdList.WOWGUILD(${JSON.stringify(text)})`, 'slash'); }
  saveVariables() { return this.eval('__saveVariables()'); }
  printed() { return this.eval('table.concat(__printed, "\\n")'); }
}

module.exports = { WowClient };
