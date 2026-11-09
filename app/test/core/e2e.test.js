'use strict';
// End to end: simulated game → SavedVariables on disk → the app's REAL sync engine → the local core →
// guild news (WowGuild_Inbox/Inbox.lua) → back into the simulated game.
//
// The app side is the real code from app/src/main (sync.js, wow.js, api.js, store.js, log.js: plain Node,
// no Electron) pointed at a temp WoW folder and at a real local core (src/core) with its launch token.
// The game side is the real addon Lua running in wowsim. Discord is a stand-in on the core's fetch; the
// Coach service is a stand-in that answers questions after a short delay.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startCore, seedGuild, addPlayer } = require('./helpers');
const { WowClient } = require('./wowsim');
const { createSync } = require('../../src/main/sync');
const wow = require('../../src/main/wow');
const { createApi } = require('../../src/main/api');
const { createStore } = require('../../src/main/store');
const { createLog } = require('../../src/main/log');
const { parseSavedVariables } = require('../../src/shared/lua');
const { tocField } = require('../../src/shared/toc');

const WEBHOOK = 'https://discord.com/api/webhooks/42/e2e';
const REPO_ADDON = path.join(__dirname, '..', '..', '..', 'addon', 'WowGuild');
const APP_VERSION = '0.11.0';
const TODAY = () => Math.floor((Date.now() - Date.UTC(2020, 0, 1)) / 86400000);
const noError = (game) => assert.strictEqual(game.eval('__ns.debugError'), null, 'no addon errors');

const COACH_GAME = `
__t = 1000
function GetTime() return __t end
function GetRealmName() return "Forever" end
function GetNumTalentTabs() return 3 end
local tabs = { {"Elemental", 0}, {"Enhancement", 11}, {"Restoration", 0} }
function GetTalentTabInfo(i) return tabs[i][1], "icon", tabs[i][2], "bg" end
function GetNumTalents(tab) return 0 end
function UnitCharacterPoints() return 0 end
`;

// A WoW folder laid out like the real one: <root>/_forever_/{Interface/AddOns/WowGuild, WTF/Account/ACC/SavedVariables}.
function makeGame(root) {
  const dir = path.join(root, '_forever_');
  const addonsDir = path.join(dir, 'Interface', 'AddOns');
  const addonDir = path.join(addonsDir, 'WowGuild');
  fs.mkdirSync(addonDir, { recursive: true });
  fs.copyFileSync(path.join(REPO_ADDON, 'WowGuild.toc'), path.join(addonDir, 'WowGuild.toc'));
  const svDir = path.join(dir, 'WTF', 'Account', 'ACC', 'SavedVariables');
  fs.mkdirSync(svDir, { recursive: true });
  const inboxDir = path.join(addonsDir, 'WowGuild_Inbox');
  return {
    dir, addonDir, svDir, inboxDir,
    svFile: path.join(svDir, 'WowGuild.lua'),
    inboxFile: path.join(inboxDir, 'Inbox.lua'),
    // What WoW does on logout or /reload: write the file. Each save gets a later timestamp, as in game.
    save(game) {
      fs.writeFileSync(this.svFile, game.saveVariablesBuffer());
      this.saves = (this.saves || 0) + 1;
      const t = new Date(Date.now() + this.saves * 2000);
      fs.utimesSync(this.svFile, t, t);
    },
    inbox() { return parseSavedVariables(fs.readFileSync(this.inboxFile)).WowGuildInbox; },
  };
}

// Auctionator's SavedVariables, the way the game writes them.
const auctionatorLua = (today) => `
AUCTIONATOR_PRICE_DATABASE = {
["__dbversion"] = 6,
["Forever Horde"] = {
["2589"] = {
["m"] = 120,
["h"] = {
[${today}] = 120,
},
},
},
}
`;

async function setup(t, syncOptions = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-e2e-'));
  const discord = [];
  // What the app's updater and addon manager know about the newest releases.
  const latest = { app: null, addon: { version: '0.11.0', source: 'bundled' } };
  const srv = await startCore({
    settings: { discordWebhook: WEBHOOK },
    latest,
    fetch: async (url, init = {}) => {
      discord.push({ url, content: JSON.parse(init.body).content });
      return { ok: true, status: 204, json: async () => ({}), text: async () => '' };
    },
  });

  // The guild as the player's first sync made it (Thrallia is its Guild Master), and a guildmate's
  // records as the sharing wave will store them.
  const g = seedGuild(srv.db, { name: 'wow', realm: null, role: 'owner', character: 'Thrallia', cls: 'SHAMAN', level: 23 });
  const guildId = g.guildId;
  const thrall = { id: g.me };
  const grom = addPlayer(srv.db, guildId, 'Grom#2222', { role: 'member', character: 'Grommy' });

  // Grom wants something only Thrallia can make, there's a notice, and a raid next week.
  const db = srv.db;
  db.prepare("INSERT INTO craft_requests (guild_id, requester_id, item, notes) VALUES (?,?,'Copper Chain Vest','mats in mail')").run(guildId, grom.id);
  db.prepare("INSERT INTO announcements (guild_id, user_id, body) VALUES (?,?,'Raid sign-ups Sunday')").run(guildId, thrall.id);
  db.prepare("INSERT INTO raids (guild_id, title, instance, starts_at, created_by) VALUES (?, 'Molten Core', 'Molten Core', ?, ?)")
    .run(guildId, new Date(Date.now() + 6 * 86400000).toISOString(), thrall.id);

  // The app on this computer: settings in its user-data folder, the WoW folder added by hand, and the
  // API client pointed at the local core with its launch token.
  const root = path.join(tmp, 'World of Warcraft');
  const game = makeGame(root);
  const store = createStore(path.join(tmp, 'userData'));
  store.set({ extraWowFolders: [root] });
  const log = createLog(path.join(tmp, 'userData', 'logs'));
  const api = createApi({ getBase: () => srv.url, getToken: () => srv.token, appVersion: APP_VERSION, log: log.scope('api') });
  const sync = createSync({ api, store, log: log.scope('sync'), wow, appVersion: APP_VERSION, scanDefaults: false, ...syncOptions });

  t.after(async () => {
    sync.stop();
    await sync.whenIdle();
    await srv.close();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* Windows may hold the log open a moment */ }
  });
  return { srv, db, guildId, thrall, grom, game, store, log, sync, discord, latest };
}

// One play session in the simulated game. `before` runs right after login, `during` before logout.
function play({ savedVariables, inboxFile, mocks, during } = {}) {
  const game = new WowClient({ savedVariables, inboxFile: inboxFile && fs.existsSync(inboxFile) ? inboxFile : undefined, mocks });
  game.login();
  if (during) during(game);
  game.logout();
  return game;
}

test('a game session reaches the local core through the app, and the guild news comes back into the game', async (t) => {
  const { srv, db, guildId, thrall, game, sync, discord, log } = await setup(t);

  // 1. Play: log in, the roster updates, open the trade skill window, sound a call to arms, log out.
  const first = play({ during: (g) => {
    g.fire('GUILD_ROSTER_UPDATE');
    g.fire('TRADE_SKILL_SHOW');
    g.slash('cta Crossroads 8 Alliance at the flight master');
  } });
  game.save(first);
  fs.writeFileSync(path.join(game.svDir, 'Auctionator.lua'), auctionatorLua(TODAY()));

  // 2. The app syncs (what "Sync now" does).
  const status = await sync.syncNow();
  assert.strictEqual(status.state, 'idle', status.lastError || '');
  assert.strictEqual(status.lastError, null);
  assert.deepStrictEqual(status.lastResult, {
    characters: 1, roster: 3, recipes: 2, ctas: 1, inventory: 3, bank: 0, prices: 1, coachPending: 0, account: 'ACC', label: 'WoW Forever',
    guild: { name: 'wow', role: 'owner' },
  });
  assert.strictEqual(status.guildNote, null);
  assert.strictEqual(status.files.length, 1);
  assert.ok(status.files[0].lastUploadAt);
  assert.ok(log.recent().some((l) => /Uploaded: 1 character\(s\), 3 roster entries, 2 recipes, 1 call\(s\) to arms, 1 auction prices/.test(l.msg)));

  // 3. The local core has the data.
  const chars = db.prepare('SELECT name, user_id, online FROM characters WHERE guild_id = ? ORDER BY name').all(guildId);
  assert.deepStrictEqual(chars.map((c) => c.name), ['Grommash Hellscream', 'Grommy', 'Thrallia', 'Zuljinne'], 'Grommy is a guildmate\'s shared character');
  assert.strictEqual(chars.find((c) => c.name === 'Thrallia').user_id, thrall.id, 'own character is linked to me');
  assert.strictEqual(chars.find((c) => c.name === 'Grommash Hellscream').user_id, null, 'roster entries are not claimed');
  assert.strictEqual(chars.filter((c) => c.online).length, 2);
  assert.deepStrictEqual(db.prepare('SELECT name FROM recipes ORDER BY name').all().map((r) => r.name), ['Copper Chain Vest', 'Rough Sharpening Stone']);
  assert.deepStrictEqual(db.prepare('SELECT item_id, price FROM prices').all().map((p) => [p.item_id, p.price]), [[2589, 120]]);
  const cta = db.prepare('SELECT zone, needed, message, character, source FROM ctas').all();
  assert.deepStrictEqual(cta.map((c) => ({ ...c })), [{ zone: 'Crossroads', needed: 8, message: 'Alliance at the flight master', character: 'Thrallia', source: 'addon' }]);
  assert.deepStrictEqual(discord, [{ url: WEBHOOK, content: '⚔️ **Call to arms: Crossroads** (need 8)\nAlliance at the flight master\n— Thrallia (from in game)' }]);
  assert.deepStrictEqual(srv.events, [], 'I sounded the call: no notification for me');
  const user = db.prepare('SELECT addon_version, app_version, last_sync_at FROM users WHERE id = ?').get(thrall.id);
  assert.deepStrictEqual([user.addon_version, user.app_version, Boolean(user.last_sync_at)], [tocField(fs.readFileSync(path.join(REPO_ADDON, 'WowGuild.toc'), 'utf8'), 'Version'), APP_VERSION, true]);

  // 4. The news is in its own little addon, and the addon's folder is left exactly as installed.
  assert.ok(fs.existsSync(game.inboxFile));
  assert.deepStrictEqual(fs.readdirSync(game.addonDir), ['WowGuild.toc'], 'nothing written into the addon folder');
  const iface = (dir, name) => tocField(fs.readFileSync(path.join(dir, name), 'utf8'), 'Interface');
  assert.strictEqual(iface(game.inboxDir, 'WowGuild_Inbox.toc'), iface(game.addonDir, 'WowGuild.toc'), 'the news addon matches the addon\'s game versions');
  const inbox = game.inbox();
  assert.strictEqual(inbox.guild, 'wow');
  assert.strictEqual(inbox.canCraft[0].item, 'Copper Chain Vest');
  assert.strictEqual(inbox.canCraft[0].requester, 'Grom#2222');
  assert.strictEqual(inbox.raids[0].title, 'Molten Core');
  assert.strictEqual(inbox.announcements[0].body, 'Raid sign-ups Sunday');

  // 5. The next login shows the news.
  const next = new WowClient({ savedVariables: fs.readFileSync(game.svFile), inboxFile: game.inboxFile }).login();
  assert.strictEqual(next.eval('WowGuildInbox.canCraft[1].item'), 'Copper Chain Vest');
  assert.match(next.printed(), /1 crafting request you can make\. Molten Core on \w{3} \d\d:\d\d: you're not signed up yet\. latest notice: Raid sign-ups Sunday\./);
  assert.match(next.eval('__ns.textRaids()'), /Molten Core[\s\S]*not signed up yet: sign up in the Guild Camp app/);
  next.slash(''); // open the window: must not error
  next.exec('__ns.ui.show("guild")');
  noError(next);
  assert.doesNotMatch(next.printed(), /newer version/, 'the addon is current');

  // 6. Syncing the same file again doesn't repeat the call to arms anywhere.
  await sync.syncNow();
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM ctas').get().n, 1);
  assert.strictEqual(discord.length, 1);
});

test('in the background: a logout is noticed and uploaded on its own, and a newer addon release reaches the game', async (t) => {
  const { db, thrall, game, sync, discord, latest } = await setup(t, { pollMs: 25, settleMs: 10, inboxRefreshMs: 60 * 60 * 1000 });
  const first = play({ during: (g) => g.fire('GUILD_ROSTER_UPDATE') });
  game.save(first);
  await sync.start(); // resolves after the first full sync
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM characters WHERE user_id = ?').get(thrall.id).n, 1);
  assert.strictEqual(game.inbox().latestAddon, '0.11.0', 'the addon bundled with the app');

  // The app's addon manager finds addon 0.12.0 on GitHub.
  latest.addon = { version: '0.12.0', source: 'remote' };

  // Play again: another call to arms, then log out. Nobody presses anything in the app.
  const uploaded = new Promise((resolve) => sync.once('uploaded', resolve));
  const second = play({ savedVariables: fs.readFileSync(game.svFile), inboxFile: game.inboxFile, during: (g) => g.slash('cta Tarren Mill 5 they are back') });
  game.save(second);
  const result = await uploaded;
  await sync.whenIdle();
  assert.strictEqual(result.ctas, 1);
  assert.strictEqual(result.latest.addon.version, '0.12.0', 'the sync reply names the newest addon');
  assert.deepStrictEqual(db.prepare('SELECT zone FROM ctas ORDER BY id').all().map((c) => c.zone), ['Tarren Mill']);
  assert.strictEqual(discord.at(-1).content, '⚔️ **Call to arms: Tarren Mill** (need 5)\nthey are back\n— Thrallia (from in game)');

  // The news written after that upload tells the game about 0.12.0.
  assert.strictEqual(game.inbox().latestAddon, '0.12.0');
  const third = new WowClient({ savedVariables: fs.readFileSync(game.svFile), inboxFile: game.inboxFile, addonVersion: '0.11.0' }).login();
  assert.match(third.printed(), /\|cffe8a33dA newer version of this addon \(0\.12\.0\) is out\.\|r Update it from the Guild Camp app \(Addon & sync page\)\./);
  assert.doesNotMatch(third.printed(), /CurseForge|\/get/);
  noError(third);
  const s = sync.status();
  assert.strictEqual(s.state, 'idle');
  assert.strictEqual(s.running, true);
});

test('the Coach: a question asked in game goes up with the next save, and the app brings the answer back', async (t) => {
  const { srv, db, game, sync } = await setup(t, { coachEveryMs: 30, coachTimeoutMs: 10000 });
  // Stand-in for the Coach: answers every waiting question a moment after it is started.
  const kicks = [];
  srv.ctx.services.coach = {
    kick() {
      kicks.push(Date.now());
      setTimeout(() => {
        db.prepare("UPDATE coach_qa SET status = 'answered', answer = 'Enhancement: **Stormstrike** burst wins world fights.', answered_at = datetime('now') WHERE status = 'pending'").run();
      }, 150);
    },
    run: async () => ({}),
  };

  const asked = play({ mocks: COACH_GAME, during: (g) => g.exec('__ns.coach.ask("Enhancement or Elemental for world PvP?")') });
  game.save(asked);
  const status = await sync.syncNow();
  assert.strictEqual(status.lastResult.coachPending, 1, 'the core says an answer is on its way');
  assert.strictEqual(kicks.length, 1, 'the Coach was started');
  const qa = db.prepare('SELECT question, char_name, source FROM coach_qa').get();
  assert.deepStrictEqual({ ...qa }, { question: 'Enhancement or Elemental for world PvP?', char_name: 'Thrallia', source: 'game' });

  // The app keeps checking until the answer is there, then saves the news again.
  await sync.whenIdle();
  const coach = game.inbox().coach;
  assert.strictEqual(coach.pending, 0);
  assert.strictEqual(coach.answers[0].a, 'Enhancement: Stormstrike burst wins world fights.');
  assert.ok(sync.status().recent.some((r) => r.kind === 'coach' && r.ok));

  // After a /reload the answer is in the Coach window and the question has left the queue.
  const after = new WowClient({ mocks: COACH_GAME, savedVariables: fs.readFileSync(game.svFile), inboxFile: game.inboxFile }).login();
  after.exec('__ns.coachUI.show("ask")');
  assert.strictEqual(after.eval('#__ns.db.coach.questions'), '0');
  assert.match(after.eval('__ns.coach.answers()[1].a'), /Stormstrike burst/);
  noError(after);
});
