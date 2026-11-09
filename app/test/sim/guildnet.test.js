'use strict';
// The test harness itself: wowsim's virtual clock and game mocks, and GuildNet (a guild of simulated clients
// trading hidden addon messages). Most checks use a tiny echo addon written to a temp folder; the last ones load
// the real addon (addon/WowGuild) to prove it runs under the harness, and how fast.

const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WowClient, VirtualClock, SEND_RESULT, REGISTER_RESULT } = require('./wowsim');
const { createGuildNet } = require('./guildnet');

const HEAVY = process.env.GUILDCAMP_SIM_HEAVY === '1';

// ---------- the echo addon ----------
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'guildnet-test-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const ECHO = path.join(TMP, 'Echo');
fs.mkdirSync(ECHO);
fs.writeFileSync(path.join(ECHO, 'Echo.toc'), [
  '## Interface: 16001, 120105',
  '## Title: Echo',
  '## Version: 1.0.0',
  '## SavedVariables: EchoDB',
  '## SavedVariablesPerCharacter: EchoChar',
  'Echo.lua',
  '',
].join('\n'));
fs.writeFileSync(path.join(ECHO, 'Echo.lua'), `
local ADDON, ns = ...
local PREFIX = "GuildCamp"
ns.got, ns.events = {}, {}
local f = CreateFrame("Frame")
for _, e in ipairs({ "ADDON_LOADED", "PLAYER_LOGIN", "PLAYER_LOGOUT", "PLAYER_LEAVING_WORLD", "PLAYER_ENTERING_WORLD",
  "CHAT_MSG_ADDON", "CHAT_MSG_SYSTEM", "GUILD_ROSTER_UPDATE", "LOADING_SCREEN_ENABLED", "LOADING_SCREEN_DISABLED",
  "ZONE_CHANGED_NEW_AREA", "PLAYER_REGEN_DISABLED", "PLAYER_REGEN_ENABLED", "ITEM_DATA_LOAD_RESULT" }) do
  f:RegisterEvent(e)
end
f:SetScript("OnEvent", function(self, event, ...)
  local a, b = ...
  ns.events[#ns.events + 1] = { event = event, a = a, b = b, lockdown = InCombatLockdown(), inInstance = (IsInInstance()), t = GetTime() }
  if event == "ADDON_LOADED" and a == ADDON then
    EchoDB = EchoDB or { logins = 0, seen = {} }
    EchoChar = EchoChar or { logins = 0 }
  elseif event == "PLAYER_LOGIN" then
    EchoDB.logins = EchoDB.logins + 1
    EchoChar.logins = EchoChar.logins + 1
    ns.registered = C_ChatInfo.RegisterAddonMessagePrefix(PREFIX)
    ns.inbox = WowGuildInbox and WowGuildInbox.note
  elseif event == "CHAT_MSG_ADDON" then
    local prefix, text, channel, sender = ...
    if prefix ~= PREFIX then return end
    ns.got[#ns.got + 1] = { text = text, channel = channel, sender = sender, short = Ambiguate(sender, "guild"), t = GetTime() }
    EchoDB.seen[text] = true
  end
end)
function ns.send(text, channel) return C_ChatInfo.SendAddonMessage(PREFIX, text, channel or "GUILD") end
function ns.count(event) local n = 0; for _, e in ipairs(ns.events) do if e.event == event then n = n + 1 end end; return n end
function ns.texts() local out = {}; for i, g in ipairs(ns.got) do out[i] = g.text end; return out end
ns.Share = {}
function ns.Share.digests()
  local keys = {}
  for k in pairs(EchoDB.seen) do keys[#keys + 1] = k end
  table.sort(keys)
  return table.concat(keys, ",")
end
`);

const texts = (c) => c.lua('ns.texts()') || [];
const asList = (v) => (Array.isArray(v) ? v : []);
const events = (c) => asList(c.lua('ns.events')).map((e) => e.event);

// ---------- wowsim ----------

test('the old path re-exports the moved wowsim', () => {
  assert.strictEqual(require('../core/wowsim'), require('./wowsim'));
});

test('immediate mode (no clock) keeps the old behaviour and adds the messaging APIs', () => {
  const wow = new WowClient({ addonDir: ECHO }).login();
  assert.strictEqual(wow.lua('UnitName("player")'), 'Thrallia');
  wow.exec('__n = 0; C_Timer.After(5, function() __n = __n + 1 end); C_Timer.NewTicker(1, function() __n = __n + 100 end)');
  assert.strictEqual(wow.lua('__n'), 1, 'After runs at once, a ticker never fires');
  wow.exec('local function again() __n = __n + 1; C_Timer.After(0, again) end; again()');
  assert.strictEqual(wow.droppedTimers(), 1, 'endless rescheduling stops instead of overflowing the stack');
  assert.ok(typeof wow.lua('GetTime()') === 'number' && typeof wow.lua('GetServerTime()') === 'number');
  assert.deepStrictEqual(wow.lua('{ IsInInstance() }'), [false, 'none']);
  assert.strictEqual(wow.lua('ns.registered'), true);
  assert.strictEqual(wow.lua('ns.send("hi")'), true);
  assert.deepStrictEqual(wow.sentMessages.map((m) => [m.prefix, m.text, m.channel]), [['GuildCamp', 'hi', 'GUILD']]);
  assert.throws(() => wow.lua('ns.send(string.rep("x", 256))'), /256 bytes/);
  assert.strictEqual(wow.lua('ns.send(string.rep("x", 255))'), true, '255 bytes is fine');
  assert.throws(() => wow.lua('pcall(ns.send, "a\\0b")'), /NUL byte/, 'fails the test even inside a pcall');
  assert.throws(() => wow.lua('C_ChatInfo.SendAddonMessage("Nope", "x", "GUILD")'), /never registered/);
  assert.throws(() => wow.lua('C_ChatInfo.SendAddonMessage("GuildCamp", "x", "SHOUT")'), /unknown chat type/);
  assert.strictEqual(wow.receive('GuildCamp', '1Hhello', 'GUILD', 'Grommash-Forever'), true);
  assert.deepStrictEqual(texts(wow), ['1Hhello']);
  assert.strictEqual(wow.receive('Other', 'x'), false, 'unregistered prefixes never reach the addon');
});

test('virtual clock: timers, tickers, GetTime, GetServerTime, time and date follow it', () => {
  const clock = new VirtualClock({ startTime: 1794066000 });
  const wow = new WowClient({ addonDir: ECHO, clock, clockSkew: -7, utcOffset: 2, uptime: 1000 });
  wow.exec(`
    __log = {}
    local function mark(s) __log[#__log + 1] = s .. "@" .. string.format("%.2f", GetTime()) end
    C_Timer.After(1.5, function() mark("after") end)
    C_Timer.After(0, function() mark("next frame") end)
    local t = C_Timer.NewTimer(2, function(self) mark("timer") end)
    C_Timer.NewTimer(3, function() mark("cancelled") end):Cancel()
    C_Timer.NewTicker(1, function(self) mark("tick3") end, 3)
    C_Timer.NewTicker(0.5, function(self) mark("tick"); if GetTime() >= 1002 then self:Cancel() end end)
  `);
  assert.deepStrictEqual(wow.get('__log'), {}, 'nothing runs until the clock moves');
  assert.strictEqual(wow.lua('GetTime()'), 1000);
  clock.run(10);
  // Same moment: whatever was scheduled first runs first (the 2 s timer before the ticker's second round).
  assert.deepStrictEqual(wow.get('__log'), ['next frame@1000.05', 'tick@1000.50', 'tick3@1001.00', 'tick@1001.00',
    'after@1001.50', 'tick@1001.50', 'timer@1002.00', 'tick3@1002.00', 'tick@1002.00', 'tick3@1003.00']);
  assert.strictEqual(wow.lua('GetTime()'), 1010);
  assert.strictEqual(wow.lua('GetServerTime()'), 1794066010);
  assert.strictEqual(wow.lua('time()'), 1794066003, 'time() is this PC clock: server time plus its skew');
  assert.strictEqual(wow.lua('date("!%Y-%m-%d %H:%M:%S", GetServerTime())'), '2026-11-07 15:40:10', '! is UTC');
  assert.strictEqual(wow.lua('date("%a %d %b %H:%M", GetServerTime())'), 'Sat 07 Nov 17:40', 'local time is the PC time zone');
  assert.strictEqual(wow.lua('date("*t", GetServerTime()).hour'), 17);
  assert.strictEqual(wow.lua('time({ year = 2026, month = 11, day = 7, hour = 17, min = 40, sec = 10 })'), 1794066010);
  assert.strictEqual(wow.lua('date("%H:%M:%S")'), '17:40:03', 'no time: this PC clock (skew -7 s)');
  assert.strictEqual(wow.lua('math.type'), null, 'game-like Lua: no 5.3-only functions');
  assert.strictEqual(wow.lua('os'), null);
  assert.strictEqual(wow.lua('GetServerTime() * 64'), 1794066010 * 64, 'times are floats: no 32-bit overflow under fengari');
});

test('virtual clock: OnUpdate scripts run every frame while shown', () => {
  const clock = new VirtualClock({ frameMs: 50 });
  const wow = new WowClient({ addonDir: ECHO, clock });
  wow.exec(`
    __n, __el = 0, 0
    __f = CreateFrame("Frame")
    __f:SetScript("OnUpdate", function(self, elapsed) __n = __n + 1; __el = __el + elapsed end)
  `);
  clock.run(1);
  assert.strictEqual(wow.lua('__n'), 20);
  assert.ok(Math.abs(wow.lua('__el') - 1) < 1e-9);
  wow.exec('__f:Hide()');
  clock.run(1);
  assert.strictEqual(wow.lua('__n'), 20, 'a hidden frame gets no OnUpdate');
  wow.exec('__f:Show()');
  clock.run(0.5);
  assert.strictEqual(wow.lua('__n'), 30);
  wow.exec('__f:SetScript("OnUpdate", nil)');
  clock.run(1);
  assert.strictEqual(wow.lua('__n'), 30);
  assert.strictEqual(clock.pending, 0, 'no frames are scheduled once nothing listens');
});

test('virtual clock: a Lua error that reaches the game fails the test; one handler failing never stops the others', () => {
  const clock = new VirtualClock();
  const wow = new WowClient({ addonDir: ECHO, clock });
  wow.exec('C_Timer.After(1, function() error("boom in a timer") end)');
  assert.throws(() => clock.run(2), /a Lua error reached the game: .*boom in a timer/);
  wow.exec(`
    local a, b = CreateFrame("Frame"), CreateFrame("Frame")
    a:RegisterEvent("PLAYER_DEAD"); b:RegisterEvent("PLAYER_DEAD")
    a:SetScript("OnEvent", function() error("first handler") end)
    b:SetScript("OnEvent", function() __second = true end)
  `);
  assert.throws(() => wow.fire('PLAYER_DEAD'), /first handler/);
  assert.strictEqual(wow.lua('__second'), true);
  const lax = new WowClient({ addonDir: ECHO, clock, strictErrors: false });
  lax.exec('geterrorhandler()("caught and reported")');
  assert.deepStrictEqual(lax.errors.map((e) => [e.kind, e.message]), [['reported', 'caught and reported']]);
});

test('virtual clock: math.random repeats exactly for the same seed and differs per player', () => {
  const roll = (seed, name) => new WowClient({ addonDir: ECHO, clock: new VirtualClock(), seed, player: { name } })
    .lua('{ math.random(), math.random(10), math.random(5, 7), random(100) }');
  const a = roll(1, 'Thrallia');
  assert.deepStrictEqual(roll(1, 'Thrallia'), a);
  assert.notDeepStrictEqual(roll(2, 'Thrallia'), a);
  assert.notDeepStrictEqual(roll(1, 'Zuljin'), a);
  assert.ok(a[1] >= 1 && a[1] <= 10 && a[2] >= 5 && a[2] <= 7 && Number.isInteger(a[1]));
});

test('player, realm, guild and roster mocks; GuildRoster() answers like the game', () => {
  const clock = new VirtualClock();
  const roster = [
    { name: 'Thrallia', rankIndex: 0, classToken: 'SHAMAN', online: true },
    { name: 'Grommash', rankIndex: 1, classToken: 'WARRIOR', online: false, realm: 'Other Realm' },
  ];
  const wow = new WowClient({ addonDir: ECHO, clock, player: { name: 'Thrallia', realm: 'Zul\'jin Forever', classToken: 'SHAMAN', rankIndex: 0 }, roster });
  assert.deepStrictEqual(wow.lua('{ UnitName("player") }'), ['Thrallia']);
  assert.deepStrictEqual(wow.lua('{ UnitFullName("player") }'), ['Thrallia', 'Zul\'jinForever']);
  assert.deepStrictEqual(wow.lua('{ UnitClass("player") }'), ['Shaman', 'SHAMAN', 7]);
  assert.strictEqual(wow.lua('GetRealmName()'), 'Zul\'jin Forever');
  assert.deepStrictEqual(wow.lua('{ GetGuildInfo("player") }'), ['wow', 'Guild Master', 0]);
  assert.deepStrictEqual(wow.lua('{ GetNumGuildMembers() }'), [2, 1, 1]);
  assert.deepStrictEqual(wow.lua('{ GetGuildRosterInfo(2) }').slice(0, 11),
    ['Grommash-OtherRealm', 'Officer', 1, 60, 'Warrior', '', '', '', false, 0, 'WARRIOR']);
  assert.strictEqual(wow.lua('Ambiguate("Thrallia-Zul\'jinForever", "guild")'), 'Thrallia');
  assert.strictEqual(wow.lua('Ambiguate("Grommash-OtherRealm", "guild")'), 'Grommash-OtherRealm');
  assert.strictEqual(wow.lua('Ambiguate("Grommash-OtherRealm", "short")'), 'Grommash');
  wow.login();
  clock.run(3);
  assert.strictEqual(wow.lua('ns.count("GUILD_ROSTER_UPDATE")'), 1, 'one roster update shortly after login');
  wow.lua('C_GuildInfo.GuildRoster()');
  clock.run(0.2);
  assert.strictEqual(wow.lua('ns.count("GUILD_ROSTER_UPDATE")'), 1);
  clock.run(0.2);
  assert.strictEqual(wow.lua('ns.count("GUILD_ROSTER_UPDATE")'), 2, 'the answer comes 0.3 s later');
  wow.lua('GuildRoster()');
  clock.run(5);
  assert.strictEqual(wow.lua('ns.count("GUILD_ROSTER_UPDATE")'), 2, 'asking again within 10 s does nothing');
  clock.run(5);
  roster[1].online = true;
  wow.lua('GuildRoster()');
  clock.run(1);
  assert.strictEqual(wow.lua('ns.count("GUILD_ROSTER_UPDATE")'), 3);
  assert.deepStrictEqual(wow.lua('{ GetNumGuildMembers() }'), [2, 1, 1], 'the same array is cached until it changes');
  wow._roster = roster.map((m) => ({ ...m }));
  assert.deepStrictEqual(wow.lua('{ GetNumGuildMembers() }'), [2, 2, 2]);
  const loner = new WowClient({ addonDir: ECHO, clock, player: { name: 'Loner', guild: null }, roster: [] }).login();
  assert.deepStrictEqual(loner.lua('{ IsInGuild(), GetGuildInfo("player") }'), [false]);
  assert.strictEqual(loner.lua('ns.send("x")'), false, 'GUILD messages need a guild');
});

test('combat and instances: event order, InCombatLockdown, IsInInstance and the loading screen', () => {
  const clock = new VirtualClock();
  const wow = new WowClient({ addonDir: ECHO, clock, interface: 120105 }).login();
  wow.lua('ns.events = {}');
  wow.setCombat(true);
  wow.setCombat(false);
  assert.deepStrictEqual(asList(wow.lua('ns.events')).map((e) => [e.event, e.lockdown]),
    [['PLAYER_REGEN_DISABLED', false], ['PLAYER_REGEN_ENABLED', false]], 'lockdown starts after DISABLED and ends before ENABLED');
  wow.setCombat(true);
  assert.strictEqual(wow.lua('InCombatLockdown()'), true);
  assert.strictEqual(wow.lua('UnitAffectingCombat("player")'), true);
  wow.setCombat(false);

  wow.lua('ns.events = {}');
  wow.setInstance(true, { type: 'raid', loading: 3 });
  assert.deepStrictEqual(wow.lua('{ IsInInstance() }'), [false, 'none'], 'still the old zone during the loading screen');
  assert.strictEqual(wow.lua('ns.send("x")'), SEND_RESULT.AddOnMessageLockdown, 'nothing goes out during a loading screen');
  clock.run(3);
  assert.deepStrictEqual(wow.lua('{ IsInInstance() }'), [true, 'raid']);
  assert.deepStrictEqual(asList(wow.lua('ns.events')).map((e) => [e.event, e.inInstance]), [['LOADING_SCREEN_ENABLED', false],
    ['PLAYER_ENTERING_WORLD', true], ['ZONE_CHANGED_NEW_AREA', true], ['LOADING_SCREEN_DISABLED', true]]);
  assert.strictEqual(wow.lua('ns.send("x")'), SEND_RESULT.AddOnMessageLockdown);
  wow.setInstance(false, { loading: 0 });
  assert.deepStrictEqual(wow.lua('{ IsInInstance() }'), [false, 'none']);
  assert.strictEqual(wow.lua('ns.send("x")'), SEND_RESULT.Success);
});

test('send and register results: a boolean on classic (16001), the enum on retail (120105)', () => {
  const classic = new WowClient({ addonDir: ECHO, interface: 16001 }).login();
  const retail = new WowClient({ addonDir: ECHO, interface: 120105 }).login();
  assert.strictEqual(classic.lua('ns.registered'), true);
  assert.strictEqual(retail.lua('ns.registered'), REGISTER_RESULT.Success);
  assert.strictEqual(retail.lua('C_ChatInfo.RegisterAddonMessagePrefix("GuildCamp")'), REGISTER_RESULT.DuplicatePrefix);
  assert.strictEqual(classic.lua('C_ChatInfo.IsAddonMessagePrefixRegistered("GuildCamp")'), true);
  assert.deepStrictEqual(classic.lua('C_ChatInfo.GetRegisteredAddonMessagePrefixes()'), ['GuildCamp']);
  assert.strictEqual(classic.lua('ns.send("x")'), true);
  assert.strictEqual(retail.lua('ns.send("x")'), 0);
  assert.strictEqual(retail.lua('Enum.SendAddonMessageResult.AddonMessageThrottle'), SEND_RESULT.AddonMessageThrottle);
  assert.deepStrictEqual(classic.lua('{ GetBuildInfo() }').slice(3), [16001]);
  assert.deepStrictEqual(retail.lua('{ GetBuildInfo() }').slice(3), [120105]);
});

test('item and spell names: classic and retail APIs, ITEM_DATA_LOAD_RESULT for items not cached yet', () => {
  const gameData = { items: { 17102: { name: 'Cloak of the Shrouded Mists', quality: 4 } }, spells: { 2660: 'Rough Sharpening Stone' } };
  const clock = new VirtualClock();
  const retail = new WowClient({ addonDir: ECHO, clock, interface: 120105, gameData }).login();
  assert.strictEqual(retail.lua('GetItemInfo'), null, 'retail 12 has no global GetItemInfo');
  assert.strictEqual(retail.lua('GetSpellInfo'), null);
  assert.strictEqual(retail.lua('C_Spell.GetSpellName(2660)'), 'Rough Sharpening Stone', 'spells are instant');
  assert.strictEqual(retail.lua('C_Spell.GetSpellInfo(2660).name'), 'Rough Sharpening Stone');
  assert.strictEqual(retail.lua('C_Item.GetItemNameByID(17102)'), null, 'not cached yet');
  assert.strictEqual(retail.lua('C_Item.GetItemNameByID(99999)'), null);
  clock.run(0.5);
  assert.deepStrictEqual(asList(retail.lua('ns.events')).filter((e) => e.event === 'ITEM_DATA_LOAD_RESULT').map((e) => [e.a, e.b])
    .sort((x, y) => x[0] - y[0]), [[17102, true], [99999, false]]);
  assert.strictEqual(retail.lua('C_Item.GetItemNameByID(17102)'), 'Cloak of the Shrouded Mists');
  assert.strictEqual(retail.lua('select(3, C_Item.GetItemInfo("item:17102::"))'), 4);
  assert.strictEqual(retail.lua('C_Item.IsItemDataCachedByID(17102)'), true);

  const classic = new WowClient({ addonDir: ECHO, clock, interface: 16001, gameData: { ...gameData, itemsCached: true } });
  assert.strictEqual(classic.lua('C_Spell'), null);
  assert.strictEqual(classic.lua('GetSpellInfo(2660)'), 'Rough Sharpening Stone');
  assert.strictEqual(classic.lua('GetItemInfo(17102)'), 'Cloak of the Shrouded Mists', 'itemsCached: every known item is ready');
});

test('PlaySound, print and chat output are captured with their time', () => {
  const clock = new VirtualClock({ startTime: 1794066000 });
  const wow = new WowClient({ addonDir: ECHO, clock });
  clock.run(5);
  wow.exec('PlaySound(SOUNDKIT.RAID_WARNING); print("Call to arms:", 5); DEFAULT_CHAT_FRAME:AddMessage("plain"); UIErrorsFrame:AddMessage("busy")');
  assert.deepStrictEqual(wow.sounds.map((s) => [s.t, s.id]), [[1794066005, 8959]]);
  assert.deepStrictEqual(wow.chatLog, [{ t: 1794066005, text: 'Call to arms: 5' }, { t: 1794066005, text: 'plain' }]);
  assert.deepStrictEqual(wow.printedLines(), ['Call to arms: 5', 'plain']);
  assert.deepStrictEqual(wow.notices.map((n) => n.text), ['busy']);
});

// ---------- GuildNet ----------

function guild(opts = {}) {
  const net = createGuildNet({ addonDir: ECHO, seed: 11, ...opts });
  const gm = net.client('Thrallia', { rank: 0 });
  const officer = net.client('Grommash', { rank: 1, interface: 120105 });
  const member = net.client('Zuljin', { rank: 3 });
  return { net, gm, officer, member };
}

test('GUILD reaches every online guildmate including the sender; OFFICER only officer ranks', () => {
  const { net, gm, officer, member } = guild({ latencyMs: [100, 300] });
  const sleepy = net.client('Sleepy', { rank: 3 });
  const stranger = net.client('Stranger', { guild: 'Other Guild' });
  for (const c of [gm, officer, member, stranger]) c.login();
  net.run(1);
  const sentAt = Object.fromEntries([gm, officer, member].map((c) => [c.name, c.lua('GetTime()')]));
  assert.strictEqual(gm.lua('ns.send("hello")'), true);
  assert.strictEqual(member.lua('#ns.got'), 0, 'not before the latency');
  net.run(0.5);
  for (const c of [gm, officer, member]) {
    const got = asList(c.lua('ns.got'));
    assert.deepStrictEqual(got.map((g) => [g.text, g.channel, g.sender, g.short]), [['hello', 'GUILD', 'Thrallia-Forever', 'Thrallia']], c.name);
    const delay = got[0].t - sentAt[c.name];
    assert.ok(delay >= 0.1 - 1e-9 && delay <= 0.3 + 1e-9, `${c.name} latency ${delay}`);
  }
  assert.strictEqual(stranger.lua('#ns.got'), 0, 'another guild hears nothing');
  assert.strictEqual(sleepy.online, false);

  officer.lua('ns.send("officers only", "OFFICER")');
  member.lua('ns.send("not an officer", "OFFICER")');
  net.run(1);
  assert.deepStrictEqual(texts(gm), ['hello', 'officers only']);
  assert.deepStrictEqual(texts(officer), ['hello', 'officers only']);
  assert.deepStrictEqual(texts(member), ['hello']);
  const s = net.stats();
  assert.strictEqual(s.dropped.officer, 1, 'a member cannot speak in officer chat');
  assert.strictEqual(s.sent, 3);
  assert.strictEqual(s.delivered, 5);
});

test('seeded latency, loss and reordering: the same seed gives the same run', () => {
  const run = (seed, opts) => {
    const { net, gm, officer, member } = guild({ seed, latencyMs: [50, 400], throttle: { burst: 100 }, ...opts });
    for (const c of [gm, officer, member]) c.login();
    for (let i = 1; i <= 30; i++) gm.lua(`ns.send("m${i}")`);
    net.run(5);
    return { net, member, officer, order: texts(member), times: asList(member.lua('ns.got')).map((g) => g.t) };
  };
  const fifo = run(1);
  assert.deepStrictEqual(fifo.order, Array.from({ length: 30 }, (_, i) => `m${i + 1}`), 'one sender arrives in order');
  assert.deepStrictEqual(run(1).times, fifo.times);
  assert.notDeepStrictEqual(run(2).times, fifo.times);

  const shuffled = run(3, { reorder: 0.5 });
  assert.notDeepStrictEqual(shuffled.order, fifo.order, 'reorder lets messages overtake each other');
  assert.deepStrictEqual([...shuffled.order].sort(), [...fifo.order].sort());

  const lossy = run(4, { loss: 0.3 });
  const s = lossy.net.stats();
  assert.strictEqual(s.delivered + s.dropped.loss, 90, 'loss is per delivery (30 messages × 3 listeners)');
  assert.ok(s.dropped.loss > 10 && s.dropped.loss < 45, `lost ${s.dropped.loss}`);
  assert.notDeepStrictEqual(texts(lossy.member), texts(lossy.officer), 'each listener loses different messages');
});

test('the game throttle: burst 10, then 1 a second per sender and prefix; dropped or refused', () => {
  const { net, gm, officer, member } = guild();
  for (const c of [gm, officer, member]) c.login();
  const results = [];
  for (let i = 0; i < 15; i++) results.push(gm.lua(`ns.send("x${i}")`));
  assert.deepStrictEqual(results, Array(15).fill(true), "'drop' mode: the send says success");
  net.run(0.5);
  assert.strictEqual(member.lua('#ns.got'), 10);
  assert.strictEqual(net.stats().dropped.throttle, 5);
  assert.strictEqual(net.stats().perSender.Thrallia.throttled, 5);
  gm.lua('ns.send("a"); ns.send("b")');
  assert.strictEqual(net.stats().dropped.throttle, 7, 'half a second later half a token is not enough');
  net.run(2);
  gm.lua('ns.send("c"); ns.send("d"); ns.send("e")');
  net.run(1);
  assert.strictEqual(member.lua('#ns.got'), 12, 'two and a half seconds refill two whole tokens');
  assert.strictEqual(net.stats().dropped.throttle, 8);
  assert.strictEqual(officer.lua('ns.send("own bucket")'), 0, 'every sender has its own bucket');

  const strict = guild({ throttle: { mode: 'result', burst: 2, perSecond: 1 } });
  strict.gm.login();
  strict.officer.login();
  assert.deepStrictEqual([1, 2, 3].map(() => strict.gm.lua('ns.send("x")')), [true, true, false], "'result' mode, classic: false");
  assert.deepStrictEqual([1, 2, 3].map(() => strict.officer.lua('ns.send("x")')), [0, 0, SEND_RESULT.AddonMessageThrottle]);
  const st = strict.net.stats();
  assert.deepStrictEqual([st.dropped.throttle, st.refused.throttle, st.sent], [2, 2, 4]);
});

test('broken messages fail the test: over 255 bytes, a NUL byte, an unregistered prefix, a channel GuildNet does not carry', () => {
  const { net, gm, member } = guild();
  gm.login();
  member.login();
  assert.throws(() => gm.lua('ns.send(string.rep("x", 256))'), /256 bytes/);
  assert.throws(() => gm.lua('pcall(ns.send, "a\\0b")'), /NUL byte/);
  assert.throws(() => gm.lua('C_ChatInfo.SendAddonMessage("Nope", "x", "GUILD")'), /never registered/);
  assert.throws(() => gm.lua('C_ChatInfo.SendAddonMessage("GuildCamp", "x", "WHISPER", "Zuljin")'), /only GUILD and OFFICER/);
  gm.lua('C_Timer.After(1, function() pcall(ns.send, string.rep("y", 300)) end)');
  assert.throws(() => net.run(2), /Thrallia: broken addon message: the message is 300 bytes/);
  assert.strictEqual(gm.lua('ns.send(string.rep("z", 255))'), true);
});

test('instances and combat: sends inside an instance are refused, messages still arrive, everything is logged', () => {
  const { net, gm, officer, member } = guild();
  for (const c of [gm, officer, member]) c.login();
  member.setInstance(true, { loading: 0 });
  officer.setInstance(true, { loading: 0 });
  assert.strictEqual(member.lua('ns.send("from the dungeon")'), false);
  assert.strictEqual(officer.lua('ns.send("from the dungeon")'), SEND_RESULT.AddOnMessageLockdown);
  gm.setCombat(true);
  assert.strictEqual(gm.lua('ns.send("mid fight")'), true, 'combat outside instances does not block messages');
  net.run(1);
  assert.deepStrictEqual(texts(member), ['mid fight'], 'a client inside an instance still receives');
  const s = net.stats();
  assert.strictEqual(s.refused.instance, 2);
  assert.deepStrictEqual(net.log.map((e) => [e.from, e.status, e.inCombat, e.inInstance]), [
    ['Zuljin', 'refused:instance', false, true], ['Grommash', 'refused:instance', false, true], ['Thrallia', 'sent', true, false]]);
});

test('accounts share one SavedVariables file; crash writes nothing; reload stays online and reads the inbox again', () => {
  const net = createGuildNet({ addonDir: ECHO });
  const main = net.client('Thrallia', { account: 'ACC1', inbox: { note: 'first news' } });
  const alt = net.client('Zuljinne', { account: 'ACC1' });
  const watcher = net.client('Grommash').login();
  main.login();
  assert.throws(() => alt.login(), /already online on account ACC1/);
  assert.strictEqual(main.lua('ns.inbox'), 'first news');
  main.logout();
  assert.strictEqual(main.sv().logins, 1);
  assert.deepStrictEqual(Object.keys(main.svAll()), ['EchoDB']);
  assert.match(main.svText(), /^\nEchoDB = \{/, 'written by the game serializer');
  alt.login();
  assert.strictEqual(alt.lua('EchoDB.logins'), 2, 'the alt reads the same account file');
  assert.strictEqual(alt.lua('EchoChar.logins'), 1, 'per-character data is its own');
  assert.strictEqual(alt.lua('ns.inbox'), 'first news', 'same PC, same inbox');
  alt.logout();

  main.login();
  assert.strictEqual(main.lua('EchoDB.logins'), 3);
  main.crash();
  assert.strictEqual(main.online, false);
  assert.strictEqual(main.sv().logins, 2, 'a crash loses the session');

  main.login();
  main.setInbox({ note: 'fresh news' });
  assert.strictEqual(main.lua('ns.inbox'), 'first news', 'the inbox is read at login, not live');
  net.run(1);
  watcher.lua('ns.events = {}');
  main.reload();
  assert.strictEqual(main.online, true);
  assert.strictEqual(main.lua('ns.inbox'), 'fresh news');
  assert.strictEqual(main.sv().logins, 3, '/reload writes the SavedVariables');
  assert.strictEqual(main.lua('EchoChar.logins'), 3);
  assert.deepStrictEqual(asList(main.lua('ns.events')).slice(0, 4).map((e) => [e.event, e.a ?? null, e.b ?? null]),
    [['ADDON_LOADED', 'Echo', null], ['PLAYER_LOGIN', null, null], ['PLAYER_ENTERING_WORLD', false, true], ['LOADING_SCREEN_DISABLED', null, null]]);
  net.run(1);
  assert.strictEqual(watcher.lua('ns.count("CHAT_MSG_SYSTEM")'), 0, 'a reload is not a logout');
  main.setInbox(null);
  main.reload();
  assert.strictEqual(main.lua('ns.inbox'), null);

  const seeded = net.client('Seeded', { savedVariables: { logins: 41, seen: {} } });
  seeded.login();
  assert.strictEqual(seeded.lua('WowGuildDB.logins'), 41, 'an object becomes the account WowGuildDB');
});

test('the roster: online state from logins, rank changes, members without the addon', () => {
  const { net, gm, member } = guild();
  net.member('Lurker', { rank: 4, online: true, classToken: 'ROGUE' });
  gm.login();
  assert.deepStrictEqual(gm.lua('{ GetNumGuildMembers() }'), [4, 2, 2]);
  const names = () => {
    const out = [];
    const n = gm.lua('GetNumGuildMembers()');
    for (let i = 1; i <= n; i++) out.push(gm.lua(`{ GetGuildRosterInfo(${i}) }`).slice(0, 3).concat(gm.lua(`select(9, GetGuildRosterInfo(${i}))`)));
    return out;
  };
  assert.deepStrictEqual(names(), [['Thrallia-Forever', 'Guild Master', 0, true], ['Grommash-Forever', 'Officer', 1, false],
    ['Zuljin-Forever', 'Member', 3, false], ['Lurker-Forever', 'Initiate', 4, true]]);
  net.run(5);
  gm.lua('ns.events = {}');
  member.login();
  net.run(1);
  assert.deepStrictEqual(asList(gm.lua('ns.events')).map((e) => [e.event, e.a]),
    [['CHAT_MSG_SYSTEM', '|Hplayer:Zuljin|h[Zuljin]|h has come online.'], ['GUILD_ROSTER_UPDATE', true]]);
  assert.strictEqual(net.roster.find((m) => m.name === 'Zuljin').online, true);
  member.setRank(1);
  net.run(1);
  assert.deepStrictEqual(member.lua('{ GetGuildInfo("player") }'), ['wow', 'Officer', 1]);
  assert.strictEqual(gm.lua('select(3, GetGuildRosterInfo(3))'), 1);
  assert.ok(gm.lua('ns.count("GUILD_ROSTER_UPDATE")') >= 2);
  member.logout();
  net.setOnline('Lurker', false);
  net.run(1);
  assert.strictEqual(gm.lua('select(9, GetGuildRosterInfo(3))'), false);
  assert.strictEqual(gm.lua('select(9, GetGuildRosterInfo(4))'), false);
  assert.deepStrictEqual(gm.chat, [], 'system lines are events here, not addon chat output');
  assert.deepStrictEqual(net.roster.map((m) => [m.name, m.rankIndex, m.online, m.client]), [['Thrallia', 0, true, true],
    ['Grommash', 1, false, true], ['Zuljin', 1, false, true], ['Lurker', 4, false, false]]);
});

test('stats, digests and convergence', () => {
  const { net, gm, officer, member } = guild({ latencyMs: [0, 0] });
  for (const c of [gm, officer, member]) c.login();
  assert.strictEqual(net.converged(), true, 'three empty stores agree');
  member.logout();
  gm.lua('ns.send("1Hxyz")');
  officer.lua('ns.send("1Rrecord", "OFFICER")');
  net.run(1);
  member.login();
  assert.deepStrictEqual(net.digests(), { Thrallia: '1Hxyz,1Rrecord', Grommash: '1Hxyz,1Rrecord', Zuljin: '' });
  assert.strictEqual(net.converged(), false);
  gm.lua('ns.send("1Hxyz")');
  officer.lua('ns.send("1Rrecord", "GUILD")');
  net.run(1);
  assert.strictEqual(net.converged(), true);
  const s = net.stats();
  assert.strictEqual(s.attempts, 4);
  assert.strictEqual(s.sent, 4);
  assert.strictEqual(s.bytes, 5 + 8 + 5 + 8);
  assert.strictEqual(s.delivered, 2 + 2 + 3 + 3);
  assert.deepStrictEqual(s.perType, { '1H': { sent: 2, bytes: 10 }, '1R': { sent: 2, bytes: 16 } });
  assert.deepStrictEqual(s.perSender.Thrallia, { attempts: 2, sent: 2, bytes: 10, throttled: 0, refused: 0, delivered: 5 });
  net.resetStats();
  assert.strictEqual(net.stats().sent, 0);
  const none = createGuildNet({ addonDir: ECHO });
  assert.strictEqual(none.converged(), false, 'nobody online: nothing to compare');
});

// ---------- the real addon ----------

test('the real addon runs under GuildNet: classic and retail clients, roster scans, SavedVariables the app can read', () => {
  const net = createGuildNet({ seed: 5, items: { 17102: 'Cloak of the Shrouded Mists' }, spells: { 2660: 'Rough Sharpening Stone' } });
  const gm = net.client('Thrallia', { rank: 0, classToken: 'SHAMAN', inbox: { guild: 'wow', generatedAt: 1794000000 } });
  const officer = net.client('Grommash', { rank: 1, interface: 120105 });
  const member = net.client('Zuljin', { rank: 3 });
  for (const c of [gm, officer, member]) c.login();
  net.run(600);
  member.setCombat(true);
  net.run(30);
  member.setCombat(false);
  officer.setInstance(true);
  net.run(60);
  officer.setInstance(false);
  officer.reload();
  net.run(60);
  const roster = member.db().roster;
  assert.deepStrictEqual(roster.members.map((m) => [m.name, m.rankIndex, m.online]),
    [['Thrallia', 0, true], ['Grommash', 1, true], ['Zuljin', 3, true]], 'the addon scanned the game roster');
  for (const c of [gm, officer, member]) c.logout();
  const sv = gm.sv();
  assert.strictEqual(sv.characters.Thrallia.guild, 'wow');
  assert.strictEqual(sv.characters.Thrallia.realm, 'Forever');
  assert.strictEqual(sv.characters.Thrallia.class, 'SHAMAN');
  assert.strictEqual(officer.sv().characters.Grommash.realm, 'Forever');
  for (const c of [gm, officer, member]) assert.deepStrictEqual(c.errors, [], `${c.name} had no Lua errors`);
});

test(`speed: 25 clients of the real addon for one virtual hour${HEAVY ? ', then a busy virtual day' : ''}`, (t) => {
  const net = createGuildNet({ seed: 25 });
  const started = Date.now();
  for (let i = 0; i < 25; i++) {
    net.client(`Member${String.fromCharCode(97 + i)}`, { rank: i === 0 ? 0 : i < 4 ? 1 : 3, interface: i % 3 ? 16001 : 120105 }).login();
  }
  const loggedIn = Date.now();
  net.run(3600);
  const ran = Date.now();
  for (const c of net.clients) c.logout();
  const done = Date.now();
  t.diagnostic(`25 logins ${loggedIn - started} ms, one virtual hour ${ran - loggedIn} ms (${net.clock.events} events), ` +
    `25 logouts ${done - ran} ms; total ${done - started} ms`);
  assert.ok(done - started < 30000, `took ${done - started} ms`);
  for (const c of net.clients) assert.ok(c.sv().characters[c.name], `${c.name} saved its character`);

  if (!HEAVY) return;
  // A virtual day: people log in and out, reload, zone into dungeons and fight, on two game versions.
  const rng = require('./wowsim').makeRng('busy day');
  const dayStart = Date.now();
  for (let minute = 0; minute < 24 * 60; minute++) {
    for (const c of net.clients) {
      const r = rng();
      if (!c.online) { if (r < 0.01) c.login(); continue; }
      if (r < 0.004) c.logout();
      else if (r < 0.006) c.crash();
      else if (r < 0.008) c.reload();
      else if (r < 0.012) c.setInstance(!c.wow.inInstance());
      else if (r < 0.03) c.setCombat(!c.wow.inCombat());
    }
    net.run(60);
  }
  t.diagnostic(`busy virtual day: ${Date.now() - dayStart} ms, ${net.clock.events} events`);
  for (const c of net.clients) assert.deepStrictEqual(c.errors, [], `${c.name} had no Lua errors`);
});
