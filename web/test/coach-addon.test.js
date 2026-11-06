// The Coach in game: learning play style, the quiz, the window, and the full trip
// through the companion to Claude and back.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const dbm = require('../src/db');
const { applyPayload, buildInbox, toLua } = require('../src/sync');
const C = require('../src/coach');
const { WowClient } = require('./wowsim');
const { parseSavedVariables } = require('../../companion/lua');

const GAME = `
DUEL_WINNER_KNOCKOUT = "%1$s has defeated %2$s in a duel"
DUEL_WINNER_RETREAT = "%2$s has fled from %1$s in a duel"
__t = 1000
function GetTime() return __t end
function GetRealmName() return "Forever" end
function UnitIsPVP() return __flagged == true end
function IsInGroup() return __grouped == true end
function GetPVPLifetimeStats() return __hk or 0, 0, 0 end
function GetNumTalentTabs() return 3 end
local tabs = { {"Elemental", 0}, {"Enhancement", 11}, {"Restoration", 0} }
function GetTalentTabInfo(i) return tabs[i][1], "icon", tabs[i][2], "bg" end
function GetNumTalents(tab) return tab == 2 and 2 or 0 end
function GetTalentInfo(tab, i) if i == 1 then return "Ancestral Knowledge", "icon", 1, 1, 5, 5 else return "Shield Specialization", "icon", 1, 2, 0, 5 end end
function UnitCharacterPoints() return 1 end
function GetInventoryItemLink(_, slot) if slot == 16 then return "|cff1eff00|Hitem:15223::|h[Big Stick]|h|r" end end
function GetItemInfo() return "Big Stick", nil, 2, 25 end
`;

function inboxFile(data) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-')), 'Inbox.lua');
  fs.writeFileSync(f, `WowGuildInbox = ${toLua(data)}\n`);
  return f;
}
function start(opts = {}) {
  const wow = new WowClient(opts);
  wow.exec(GAME);
  wow.fire('ADDON_LOADED', 'WowGuild');
  wow.fire('PLAYER_LOGIN');
  return wow;
}

test('the Coach learns play style, takes the quiz, and sends a question; Claude\'s answer and plan come back', async () => {
  const wow = start({ inboxFile: inboxFile({ guild: 'wow', generatedAt: 1, coach: { plans: {}, answers: [], pending: 0, enabled: true } }) });
  // Two hours of aggressive, flagged play with fights, a death, kills and a won duel.
  wow.exec('__flagged = true');
  for (let i = 0; i < 240; i++) {
    if (i % 4 === 0) wow.exec('__fire("PLAYER_REGEN_DISABLED"); __t = __t + 20; __fire("PLAYER_REGEN_ENABLED")');
    if (i === 100) wow.exec('__hk = 12');
    wow.exec('__ns.coach.sample()');
  }
  wow.exec('__hk = 30; __ns.coach.sample()');
  wow.fire('PLAYER_DEAD');
  wow.fire('CHAT_MSG_SYSTEM', 'Thrallia has defeated Grommash in a duel');
  wow.fire('CHAT_MSG_SYSTEM', 'Someone has defeated Thrallia in a duel');
  assert.strictEqual(wow.eval('__ns.coach.char().obs.duelsWon'), '1');
  assert.strictEqual(wow.eval('__ns.coach.char().obs.duelsLost'), '1');
  assert.strictEqual(wow.eval('__ns.coach.char().obs.pulls'), '60');

  // Open the window from the main panel's Coach tab.
  wow.exec('__ns.ui.show("coach"); __click(WowGuildWindow.pages.coach.open)');
  assert.strictEqual(wow.eval('tostring(WowGuildCoach:IsShown())'), 'true');
  assert.ok(wow.eval('table.concat(UISpecialFrames, ",")').includes('WowGuildCoach'));
  assert.match(wow.eval('WowGuildCoach.archetype:GetText()'), /The (Warmonger|Duelist)/);
  assert.match(wow.eval('WowGuildCoach.sub:GetText()'), /Level 23 Shaman  -  Elemental 0 \/ Enhancement 11 \/ Restoration 0/);

  // The quiz: click answers, save.
  wow.exec('__click(WowGuildCoach.tune)');
  assert.strictEqual(wow.eval('tostring(WowGuildCoach.quiz:IsShown())'), 'true');
  wow.exec(`local g = WowGuildCoach.quiz.groups
    __click(g[1].buttons[5]); __click(g[2].buttons[2]); __click(g[3].buttons[1]); __click(g[4].buttons[5]); __click(g[5].buttons[3])
    __click(g[6].buttons[1]); __click(g[7].buttons[2])`);
  const saveBtn = 'WowGuildCoach.quiz'; // Save is the first button after the choice rows; call the API the button calls
  wow.exec(`__ns.coach.saveQuiz(${saveBtn}.answers); ${saveBtn}:Hide()`);
  assert.strictEqual(wow.eval('__ns.coach.char().quiz.role'), 'Damage');
  assert.strictEqual(wow.eval('__ns.coach.char().quiz.goal'), 'World PvP');
  assert.strictEqual(wow.eval('__ns.coach.char().quiz.aggression'), '5');
  const prof = { aggression: Number(wow.eval('__ns.coach.char().profile.scores.aggression')), pvp: Number(wow.eval('__ns.coach.char().profile.scores.pvp')) };
  assert.ok(prof.aggression >= 65 && prof.pvp >= 65, JSON.stringify(prof));
  assert.strictEqual(wow.eval('__ns.coach.char().profile.archetype'), 'Warmonger');

  // Next steps: the unspent point, plus the quiz no longer nags.
  const steps = wow.eval('(function() local t = {} for _, s in ipairs(__ns.coach.nextSteps()) do t[#t+1] = s.title end return table.concat(t, "|") end)()');
  assert.match(steps, /Spend 1 talent point/);
  assert.doesNotMatch(steps, /Tell the Coach how you play/);

  // Ask a question in the Ask view.
  wow.exec('__ns.coachUI.view("ask"); WowGuildCoach.edit:SetText("Enhancement or Elemental for world PvP?"); __click(WowGuildCoach.action)');
  assert.strictEqual(wow.eval('#__ns.db.coach.questions'), '1');
  assert.strictEqual(wow.eval('__ns.coach.waiting()[1].state'), 'unsent');
  assert.strictEqual(wow.eval('WowGuildCoach.action2:GetText()'), 'Send now (reload)');
  wow.exec('__ns.coachUI.view("build"); __click(WowGuildCoach.action)');
  assert.ok(Number(wow.eval('__ns.coach.char().planRequest')) > 0);
  wow.fire('PLAYER_LOGOUT');
  assert.strictEqual(wow.eval('__ns.debugError'), null);

  // The companion uploads; the server stores the style and the question.
  const sv = parseSavedVariables(Buffer.from(wow.saveVariables())).WowGuildDB;
  const db = dbm.open(':memory:');
  const u = db.prepare("INSERT INTO users (bnet_id, battletag) VALUES ('a','J#1')").run().lastInsertRowid;
  const g = db.prepare("INSERT INTO guilds (name, invite_code) VALUES ('wow','i')").run().lastInsertRowid;
  applyPayload(db, g, u, sv);
  const row = db.prepare('SELECT * FROM coach_chars').get();
  assert.strictEqual(row.name, 'Thrallia'); assert.strictEqual(row.class, 'SHAMAN');
  assert.strictEqual(JSON.parse(row.profile).archetype, 'Warmonger');
  assert.strictEqual(JSON.parse(row.talents).picked[0].name, 'Ancestral Knowledge');
  assert.strictEqual(JSON.parse(row.gear).items[0].name, 'Big Stick');
  assert.match(C.charContext(row), /Talents: Elemental 0 \/ Enhancement 11 \/ Restoration 0, 1 unspent/);
  const qa = db.prepare('SELECT * FROM coach_qa').get();
  assert.strictEqual(qa.question, 'Enhancement or Elemental for world PvP?');

  // Claude answers (stand-in) and the plan is written; the companion writes the inbox.
  db.prepare("UPDATE coach_qa SET status = 'answered', answer = 'Enhancement: Stormstrike burst wins world fights.', answered_at = datetime('now')").run();
  db.prepare('UPDATE coach_chars SET plan = ?').run(JSON.stringify({ headline: 'Enhancement for world PvP', summary: 'Burst with Stormstrike.', spec: 'Enhancement', split: '0/31/20',
    talents: [{ name: 'Ancestral Knowledge', tree: 'Enhancement', points: 5, why: 'More mana' }, { name: 'Flurry', tree: 'Enhancement', points: 5, why: 'Big speed' }],
    stats: ['Strength', 'Agility'], tips: ['Open with Earth Shock interrupts'], next_steps: [{ title: 'Get a slow two-hander', detail: 'Windfury loves it' }], confidence: 'classic', level: 23, at: 1 }));
  const inbox = { ...buildInbox(db, g, u), generatedAt: Math.floor(Date.now() / 1000) + 10 };
  const wow2 = start({ savedVariables: wow.saveVariables(), inboxFile: inboxFile(inbox) });
  wow2.exec('__ns.coachUI.show("ask")');
  assert.strictEqual(wow2.eval('#__ns.db.coach.questions'), '0', 'answered question is cleared from the queue');
  assert.match(wow2.eval('__ns.coach.answers()[1].a'), /Stormstrike burst/);
  wow2.exec('__ns.coachUI.view("build")');
  assert.strictEqual(wow2.eval('__ns.coach.plan().spec'), 'Enhancement');
  const steps2 = wow2.eval('(function() local t = {} for _, s in ipairs(__ns.coach.nextSteps()) do t[#t+1] = s.title .. ": " .. s.detail end return table.concat(t, "|") end)()');
  assert.match(steps2, /Spend 1 talent point: Your plan says: Ancestral Knowledge/);
  assert.match(steps2, /Get a slow two-hander/);
  assert.strictEqual(wow2.eval('__ns.debugError'), null);
  wow2.slash('coach');
  assert.strictEqual(wow2.eval('tostring(WowGuildCoach:IsShown())'), 'false', '/wow coach toggles the window');
});
