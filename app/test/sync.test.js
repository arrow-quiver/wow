'use strict';
// The background sync engine (src/main/sync.js), run against fake game folders in temp dirs.
// Default scanning is off (scanDefaults: false), so a real game install is never touched.
// Time is injected: `now` is a fake clock, `sleep` resolves at once (and records how long it was
// asked to wait), and the 4 s check timer is a fake the tests fire by hand.
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const { createSync, inboxToc, writeInboxFiles, uploadSummary, retryDelay, describeWait, noGuildReply } = require('../src/main/sync');
const wow = require('../src/main/wow');
const { createStore } = require('../src/main/store');
const { createLog } = require('../src/main/log');
const { createApi, ApiError, errorFromBody } = require('../src/main/api');
const { parseSavedVariables, toLua } = require('../src/shared/lua');

const CLOCK_START = Date.UTC(2026, 10, 7, 12, 0, 0);
const TODAY = Math.floor((CLOCK_START - Date.UTC(2020, 0, 1)) / 86400000); // Auctionator's day number

// What the addon saves (trimmed, but shaped like the real thing).
const DB = {
  addonVersion: '0.11.0',
  characters: {
    Thrallia: {
      name: 'Thrallia', realm: 'Forever', class: 'SHAMAN', race: 'Orc', level: 23, faction: 'Horde',
      professions: [{ name: 'Blacksmithing', rank: 75, max: 150 }, { name: 'Fishing', rank: 40, max: 75 }],
      recipes: { Blacksmithing: [{ name: 'Rough Sharpening Stone', id: 2862 }, { name: 'Copper Chain Vest', id: 3319 }] },
      updated: 1730000000,
    },
  },
  roster: {
    scannedAt: 1730000000,
    members: [
      { name: 'Thrallia', level: 23, class: 'SHAMAN', online: true, rank: 'Officer' },
      { name: 'Grommash Hellscream', level: 60, class: 'WARRIOR', online: true, rank: 'Member' },
      { name: 'Zuljinné', level: 41, class: 'HUNTER', online: false, rank: 'Member' },
    ],
  },
  ctaQueue: [{ zone: 'Crossroads', needed: 8, msg: 'Alliance at the flight master', t: 1730000000 }],
};

// Auctionator.lua the way the game writes it.
const AUCTIONATOR = `
AUCTIONATOR_PRICE_DATABASE = {
["__dbversion"] = 6,
["Forever Horde"] = {
["2589"] = {
["m"] = 120,
["h"] = {
[${TODAY}] = 120,
},
},
["g:2592:0:0"] = {
["m"] = 300,
["h"] = {
[${TODAY - 2}] = 300,
},
},
["2770"] = {
["m"] = 50,
["h"] = {
[${TODAY - 30}] = 50,
},
},
},
}
`;
const PRICES = { items: [[2589, 120, TODAY], [2592, 300, TODAY - 2]] };

// GET /api/inbox (no empty lists or nulls: Lua can't tell {} from [] or keep a nil).
const INBOX = {
  guild: 'Camp Fire',
  generatedAt: 1730000000,
  prices: [{ id: 2589, price: 120 }],
  stock: [{ id: 2589, chars: [{ name: 'Thrallia', count: 4 }], guildBank: 20 }],
  holdings: [{ id: 2589, chars: [{ name: 'Zuljinné', count: 4 }], guildBank: 20 }],
  crafters: [{ name: 'Copper Chain Vest', who: 'Thrallia' }],
  raids: [{ id: 3, title: 'Molten Core', instance: 'MC', status: 'open', signup: 'yes', role: 'healer', character: 'Thrallia', coming: 12, startsAt: 1730100000, reserves: [{ name: 'Onslaught Girdle', bonus: 10 }] }],
  announcements: [{ body: 'Raid on Friday at "20:00" — bring fire resistance.\nSecond line\\with a backslash.', at: '2026-11-07 10:00:00', by: 'Calvin#1234' }],
  canCraft: [{ id: 1, item: 'Copper Chain Vest', notes: 'size M', requester: 'Mokra#1' }],
  myRequests: [{ item: 'Major Healing Potion', status: 'open', crafter: 'Velanne#2210' }],
  buddies: [{ character: 'Mokra', level: 22, zone: 'The Barrens', whenText: 'evenings', note: 'questing' }],
  coach: { pending: 0 },
  latestAddon: '0.11.1',
  site: 'https://guild.example.com',
};

const SYNC_OK = { ok: true, characters: 1, roster: 3, recipes: 2, ctas: 1, inventory: 0, bank: 0, prices: 2, coachPending: 0, latest: { app: { version: '0.11.0' }, addon: { version: '0.11.1' } } };

let tmp;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-sync-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

function write(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  return file;
}

const svText = (db) => `\nWowGuildDB = ${toLua(db)}\n`;

let bump = 0;
/** Gives a file a new, distinct modification time (as when WoW saves it again). */
function touch(file) {
  bump += 1;
  const t = new Date(Date.UTC(2030, 0, 1) + bump * 60000);
  fs.utimesSync(file, t, t);
}

/** <root>/<flavor>/Interface/AddOns/WowGuild/WowGuild.toc + WTF/Account/<acc>/SavedVariables/{WowGuild,Auctionator}.lua */
function makeGame(root, flavor, { addon = true, accounts = ['ACCOUNT1'], db = DB, auctionator = true, iface = '11507' } = {}) {
  const dir = path.join(root, flavor);
  const addonsDir = path.join(dir, 'Interface', 'AddOns');
  fs.mkdirSync(addonsDir, { recursive: true });
  if (addon) write(path.join(addonsDir, 'WowGuild', 'WowGuild.toc'), `## Interface: ${iface}\r\n## Title: Guild Camp\r\n## Version: 0.11.0\r\n\r\nCore.lua\r\n`);
  const sv = {};
  const auc = {};
  for (const acc of accounts) {
    const svDir = path.join(dir, 'WTF', 'Account', acc, 'SavedVariables');
    sv[acc] = write(path.join(svDir, 'WowGuild.lua'), svText(db));
    if (auctionator) auc[acc] = write(path.join(svDir, 'Auctionator.lua'), AUCTIONATOR);
  }
  return { dir, addonsDir, sv, auc, inboxDir: path.join(addonsDir, 'WowGuild_Inbox') };
}

function fakeApi(routes) {
  const calls = [];
  let active = 0;
  const api = {
    calls,
    routes,
    maxActive: 0,
    posts: () => calls.filter((c) => c.method === 'POST' && c.path === '/api/sync'),
    inboxGets: () => calls.filter((c) => c.method === 'GET' && c.path === '/api/inbox'),
    async request(method, p, body, opts) {
      calls.push({ method, path: p, body: body === undefined || body === null ? body : structuredClone(body), opts });
      const handler = routes[`${method} ${p}`];
      if (!handler) throw new ApiError(404, "The server couldn't find that.");
      active += 1;
      api.maxActive = Math.max(api.maxActive, active);
      try {
        return structuredClone(await handler(body));
      } finally {
        active -= 1;
      }
    },
  };
  return api;
}

/**
 * A sync engine wired to a fake game folder, a fake API, a real store and log in temp dirs.
 * @param {object} [o]
 * @param {boolean} [o.token=true] signed in
 * @param {boolean} [o.folders=true] settings.extraWowFolders points at the fake "World of Warcraft" folder
 */
function setup({ token = true, folders = true, routes = {}, game = {} } = {}) {
  const root = path.join(tmp, 'World of Warcraft');
  const forever = makeGame(root, '_forever_', game);
  const store = createStore(path.join(tmp, 'user-data'));
  if (token) store.setSecret('deviceToken', 'gcd_test_token');
  if (folders) store.set({ extraWowFolders: [root] });
  const log = createLog(path.join(tmp, 'logs'));
  const api = fakeApi({ 'POST /api/sync': () => SYNC_OK, 'GET /api/inbox': () => INBOX, ...routes });

  const h = { root, forever, store, log, api, clock: CLOCK_START, sleeps: [], timers: [], lines: [], statuses: [], uploaded: [], onSleep: null };
  h.sync = createSync({
    api,
    store,
    log: log.scope('sync'),
    wow,
    appVersion: '0.11.0',
    scanDefaults: false,
    now: () => h.clock,
    sleep: async (ms) => {
      h.sleeps.push(ms);
      if (h.onSleep) await h.onSleep(ms);
    },
    setTimeout: (fn, ms) => {
      const t = { fn, ms };
      h.timers.push(t);
      return t;
    },
    clearTimeout: (t) => {
      const i = h.timers.indexOf(t);
      if (i !== -1) h.timers.splice(i, 1);
    },
  });
  h.sync.on('log', (msg) => h.lines.push(msg));
  h.sync.on('status', (s) => h.statuses.push(s));
  h.sync.on('uploaded', (result, where) => h.uploaded.push({ result, where }));
  h.advance = (ms) => { h.clock += ms; };
  h.text = () => h.lines.join('\n');
  /** Fires the pending 4 s check timer, as if it ran out. */
  h.fireTimer = async () => {
    const t = h.timers.shift();
    assert.ok(t, 'a check timer is scheduled');
    await t.fn();
  };
  return h;
}

const readInbox = (g) => parseSavedVariables(fs.readFileSync(path.join(g.inboxDir, 'Inbox.lua'))).WowGuildInbox;

describe('states', () => {
  test('signed out, off and no game folder are reported before anything else', async () => {
    const h = setup({ token: false, folders: false });
    assert.equal(h.sync.status().state, 'signed-out');
    await assert.rejects(h.sync.syncNow(), /Sign in to sync/);

    h.store.setSecret('deviceToken', 'gcd_x');
    assert.equal(h.sync.status().state, 'no-game');
    await assert.rejects(h.sync.syncNow(), /can't find your World of Warcraft folder/);

    h.sync.setEnabled(false);
    assert.equal(h.sync.status().state, 'off');
    assert.equal(h.sync.status().enabled, false);
    assert.equal(h.store.get().syncEnabled, false, 'saved as a setting');
    assert.equal(h.api.calls.length, 0);

    // Turning it back on through settings (the Settings page) reaches the engine too.
    h.store.set({ syncEnabled: true, extraWowFolders: [h.root] });
    const s = h.sync.status();
    assert.equal(s.enabled, true);
    assert.equal(s.state, 'idle');
    assert.equal(s.installCount, 1);
    assert.equal(s.files.length, 1);
    assert.equal(s.files[0].account, 'ACCOUNT1');
    assert.equal(s.files[0].install, h.forever.dir);
    assert.equal(s.files[0].label, 'WoW Forever');
    assert.equal(s.files[0].lastUploadAt, null);
    assert.equal(h.statuses.at(-1).state, 'idle', 'status events follow the changes');
  });
});

describe('uploads', () => {
  test('start uploads every saved data file with Auctionator prices and writes the inbox', async () => {
    const h = setup();
    const status = await h.sync.start();

    const [post] = h.api.posts();
    assert.equal(h.api.posts().length, 1);
    assert.deepEqual(post.body, { ...DB, prices: PRICES });
    assert.equal(post.opts.timeout, 120000);
    assert.equal(h.api.inboxGets().length, 1);

    assert.equal(status.state, 'idle');
    assert.equal(status.running, true);
    assert.equal(status.lastSyncAt, new Date(CLOCK_START).toISOString());
    assert.deepEqual(status.lastResult, { characters: 1, roster: 3, recipes: 2, ctas: 1, inventory: 0, bank: 0, prices: 2, coachPending: 0, account: 'ACCOUNT1', label: 'WoW Forever' });
    assert.equal(status.lastError, null);
    assert.equal(status.files[0].lastUploadAt, status.lastSyncAt);
    assert.equal(status.recent.length, 1);
    assert.equal(status.recent[0].ok, true);
    assert.equal(status.recent[0].kind, 'upload');

    assert.match(h.text(), /Uploaded: 1 character\(s\), 3 roster entries, 2 recipes, 1 call\(s\) to arms, 2 auction prices\./);
    assert.match(h.text(), /Guild news saved for the addon\. It shows after your next \/reload\./);
    assert.equal(h.uploaded.length, 1);
    assert.equal(h.uploaded[0].result.characters, 1);
    assert.deepEqual(h.uploaded[0].where, { file: h.forever.sv.ACCOUNT1, account: 'ACCOUNT1', install: h.forever.dir, label: 'WoW Forever' });
    assert.ok(h.statuses.some((s) => s.state === 'syncing'), 'shows syncing while it works');

    // The news addon: toc with the installed addon's Interface line, and Inbox.lua.
    const toc = fs.readFileSync(path.join(h.forever.inboxDir, 'WowGuild_Inbox.toc'), 'utf8');
    assert.equal(toc, [
      '## Interface: 11507',
      '## Title: Guild Camp news',
      '## Notes: News from your guild for the Guild Camp addon. The Guild Camp app rewrites this on every sync.',
      '## Version: 0.11.0',
      '',
      'Inbox.lua',
      '',
    ].join('\r\n'));
    const lua = fs.readFileSync(path.join(h.forever.inboxDir, 'Inbox.lua'), 'utf8');
    assert.match(lua, /^-- Written by the Guild Camp app\. Do not edit\.\nWowGuildInbox = \{/);
    assert.ok(lua.includes('Zuljinné'), 'written as UTF-8');
    assert.deepEqual(readInbox(h.forever), INBOX, 'Inbox.lua reads back to the same object');

    // Nothing else is touched: the addon folder stays exactly as released, no temp files are left.
    assert.deepEqual(fs.readdirSync(path.join(h.forever.addonsDir, 'WowGuild')), ['WowGuild.toc']);
    assert.deepEqual(fs.readdirSync(h.forever.inboxDir).sort(), ['Inbox.lua', 'WowGuild_Inbox.toc']);
    assert.ok(!fs.existsSync(path.join(h.forever.addonsDir, 'WowGuild', 'Data')), 'no legacy Data/Inbox.lua');

    // The 4 s check is scheduled.
    assert.equal(h.timers.length, 1);
    assert.equal(h.timers[0].ms, 4000);
    h.sync.stop();
  });

  test('uploads again only when the file changes, after waiting for it to settle', async () => {
    const h = setup();
    await h.sync.start();
    h.sleeps.length = 0;

    await h.sync.poll();
    await h.sync.poll();
    assert.equal(h.api.posts().length, 1, 'unchanged file: no upload');
    assert.deepEqual(h.sleeps, [], 'and no waiting');

    touch(h.forever.sv.ACCOUNT1);
    h.advance(4000);
    await h.sync.poll();
    assert.equal(h.api.posts().length, 2);
    assert.deepEqual(h.sleeps, [1500], 'waited 1.5 s before reading');
    assert.equal(h.api.posts()[1].body.prices, undefined, 'Auctionator unchanged: no prices');
    assert.equal(h.api.inboxGets().length, 2, 'inbox rewritten after the upload');
    assert.equal(h.sync.status().lastSyncAt, new Date(CLOCK_START + 4000).toISOString());

    // Auctionator changed: its prices go with the next upload, once.
    touch(h.forever.auc.ACCOUNT1);
    touch(h.forever.sv.ACCOUNT1);
    await h.sync.poll();
    assert.deepEqual(h.api.posts()[2].body.prices, PRICES);
    touch(h.forever.sv.ACCOUNT1);
    await h.sync.poll();
    assert.equal(h.api.posts()[3].body.prices, undefined);
    h.sync.stop();
  });

  test('a file that is still being written waits for the next check', async () => {
    const h = setup();
    await h.sync.start();
    touch(h.forever.sv.ACCOUNT1);
    h.onSleep = async () => touch(h.forever.sv.ACCOUNT1); // WoW writes again during the wait
    await h.sync.poll();
    assert.equal(h.api.posts().length, 1, 'not uploaded while changing');
    h.onSleep = null;
    await h.sync.poll();
    assert.equal(h.api.posts().length, 2, 'uploaded once it settled');
    h.sync.stop();
  });

  test('failed uploads are retried with backoff from 5 s up to 5 min', async () => {
    const h = setup();
    const down = () => { throw new ApiError(0, "Can't reach the guild server (guild.example.com: connection refused). Check your internet connection and the server address in Settings."); };
    h.api.routes['POST /api/sync'] = down;
    await h.sync.start();
    assert.equal(h.api.posts().length, 1);
    let s = h.sync.status();
    assert.equal(s.state, 'error');
    assert.match(s.lastError, /Can't reach the guild server/);
    assert.equal(s.nextRetryAt, new Date(h.clock + 5000).toISOString());
    assert.equal(s.files[0].nextRetryAt, s.nextRetryAt);
    assert.match(s.files[0].lastError, /connection refused/);
    assert.equal(s.recent[0].ok, false);
    assert.match(h.lines.at(-2), /^Couldn't upload the saved data for ACCOUNT1: Can't reach the guild server .* Trying again in 5 seconds\.$/);
    assert.ok(fs.existsSync(path.join(h.forever.inboxDir, 'Inbox.lua')), 'the news is still saved on a full sync');

    const waits = [5, 10, 20, 40, 80, 160, 300, 300];
    for (let i = 1; i < waits.length; i++) {
      const before = h.api.posts().length;
      h.advance(waits[i - 1] * 1000 - 1);
      await h.sync.poll();
      assert.equal(h.api.posts().length, before, `no retry before ${waits[i - 1]} s`);
      h.advance(1);
      await h.sync.poll();
      assert.equal(h.api.posts().length, before + 1, `retried after ${waits[i - 1]} s`);
      assert.equal(h.sync.status().nextRetryAt, new Date(h.clock + waits[i] * 1000).toISOString());
      const expected = { 10: '10 seconds', 20: '20 seconds', 40: '40 seconds', 80: '1 minute', 160: '3 minutes', 300: '5 minutes' }[waits[i]];
      assert.ok(h.lines.some((l) => l.endsWith(`Trying again in ${expected}.`)), expected);
    }

    // The server is back: the next retry works and the problem clears.
    h.api.routes['POST /api/sync'] = () => SYNC_OK;
    h.advance(300 * 1000);
    await h.sync.poll();
    s = h.sync.status();
    assert.equal(s.state, 'idle');
    assert.equal(s.lastError, null);
    assert.equal(s.nextRetryAt, null);
    assert.equal(s.files[0].lastError, null);
    assert.equal(s.recent[0].ok, true);
    assert.deepEqual(h.api.posts().at(-1).body.prices, PRICES, 'prices were never delivered, so they are still sent');
    h.sync.stop();
  });

  test('files without addon data yet are skipped', async () => {
    const h = setup({ game: { db: {} } });
    await h.sync.start();
    assert.equal(h.api.posts().length, 0);
    assert.match(h.text(), /No Guild Camp data for ACCOUNT1 yet/);
    assert.equal(h.sync.status().state, 'idle');
    await h.sync.poll();
    assert.equal(h.api.posts().length, 0, 'not retried until the file changes');
    write(h.forever.sv.ACCOUNT1, svText(DB));
    touch(h.forever.sv.ACCOUNT1);
    await h.sync.poll();
    assert.equal(h.api.posts().length, 1);
    h.sync.stop();
  });

  test('a corrupt saved data file is reported and retried, not fatal', async () => {
    const h = setup();
    write(h.forever.sv.ACCOUNT1, 'WowGuildDB = { ["half written');
    await h.sync.start();
    const s = h.sync.status();
    assert.equal(s.state, 'error');
    assert.match(s.lastError, /couldn't be read/);
    assert.equal(h.api.posts().length, 0);
    h.sync.stop();
  });

  test('uploads never overlap', async () => {
    const h = setup();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let n = 0;
    h.api.routes['POST /api/sync'] = async () => {
      n += 1;
      if (n === 1) await gate;
      return SYNC_OK;
    };
    const started = h.sync.start();
    assert.equal(h.api.posts().length, 1, 'the first upload is on its way');
    touch(h.forever.sv.ACCOUNT1);
    await h.sync.poll(); // the 4 s check while the upload is slow: skipped
    assert.equal(h.api.posts().length, 1);
    const manual = h.sync.syncNow(); // waits its turn
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.api.posts().length, 1);
    release();
    await started;
    const s = await manual;
    assert.equal(h.api.posts().length, 2);
    assert.equal(h.api.maxActive, 1);
    assert.equal(s.state, 'idle');
    h.sync.stop();
  });

  test('syncNow uploads everything and says plainly when an upload failed', async () => {
    const h = setup();
    const s = await h.sync.syncNow(); // works without start(), like the old --once
    assert.equal(s.state, 'idle');
    assert.equal(h.api.posts().length, 1);
    await h.sync.syncNow();
    assert.equal(h.api.posts().length, 2, 'forced: uploads even though nothing changed');
    assert.deepEqual(h.sleeps, [], 'no settle wait for a forced sync');
    h.api.routes['POST /api/sync'] = () => { throw new ApiError(500, 'The guild server had a problem. Try again in a moment.'); };
    await assert.rejects(h.sync.syncNow(), { message: 'The guild server had a problem. Try again in a moment.' });
    assert.equal(h.sync.status().state, 'error');
  });
});

describe('inbox', () => {
  test('the toc is only rewritten when it changes; its Interface line follows the addon', async () => {
    const h = setup();
    await h.sync.syncNow();
    const tocFile = path.join(h.forever.inboxDir, 'WowGuild_Inbox.toc');
    const luaFile = path.join(h.forever.inboxDir, 'Inbox.lua');
    const old = new Date(Date.UTC(2001, 0, 1));
    fs.utimesSync(tocFile, old, old);
    fs.utimesSync(luaFile, old, old);

    await h.sync.syncNow(); // same news
    assert.equal(fs.statSync(tocFile).mtimeMs, old.getTime(), 'toc left alone');
    assert.equal(fs.statSync(luaFile).mtimeMs, old.getTime(), 'unchanged news left alone');

    h.api.routes['GET /api/inbox'] = () => ({ ...INBOX, generatedAt: 1730000099 });
    await h.sync.syncNow();
    assert.equal(fs.statSync(tocFile).mtimeMs, old.getTime(), 'toc still left alone');
    assert.notEqual(fs.statSync(luaFile).mtimeMs, old.getTime(), 'new news written');
    assert.equal(readInbox(h.forever).generatedAt, 1730000099);

    // The addon was updated for a new game version: the news addon follows.
    write(path.join(h.forever.addonsDir, 'WowGuild', 'WowGuild.toc'), '## Interface: 16001, 120105\n## Version: 0.12.0\n');
    await h.sync.syncNow();
    assert.match(fs.readFileSync(tocFile, 'utf8'), /^## Interface: 16001, 120105\r\n/);
  });

  test('game folders without the addon get no inbox, but their data still uploads', async () => {
    const h = setup();
    const retail = makeGame(h.root, '_retail_', { addon: false, auctionator: false });
    await h.sync.start();
    assert.equal(h.api.posts().length, 2);
    assert.ok(fs.existsSync(path.join(h.forever.inboxDir, 'Inbox.lua')));
    assert.ok(!fs.existsSync(retail.inboxDir), 'nothing written where the addon is missing');
    assert.match(h.text(), /Uploaded: .* \(ACCOUNT1, WoW Forever\)\./, 'with several files, lines say which one');
    assert.match(h.text(), /Uploaded: .* \(ACCOUNT1, Retail\)\./);
    assert.match(h.text(), /addon not installed yet/);
    assert.deepEqual(h.sync.status().files.map((f) => f.label), ['WoW Forever', 'Retail']);
    h.sync.stop();
  });

  test('the news is refreshed every 5 minutes', async () => {
    const h = setup();
    await h.sync.start();
    assert.equal(h.api.inboxGets().length, 1);
    h.advance(5 * 60 * 1000 - 1);
    await h.sync.poll();
    assert.equal(h.api.inboxGets().length, 1);
    h.advance(1);
    h.api.routes['GET /api/inbox'] = () => ({ ...INBOX, guild: 'Camp Fire Reborn' });
    await h.sync.poll();
    assert.equal(h.api.inboxGets().length, 2);
    assert.equal(h.api.posts().length, 1, 'no upload needed for that');
    assert.equal(readInbox(h.forever).guild, 'Camp Fire Reborn');

    // A failed refresh is not retried on every 4 s check.
    h.api.routes['GET /api/inbox'] = () => { throw new ApiError(503, 'The guild server is busy or restarting. Try again in a moment.'); };
    h.advance(5 * 60 * 1000);
    await h.sync.poll();
    await h.sync.poll();
    assert.equal(h.api.inboxGets().length, 3);
    assert.equal(h.sync.status().state, 'error');
    assert.match(h.text(), /Couldn't get the guild news from the server: The guild server is busy/);
    h.api.routes['GET /api/inbox'] = () => INBOX;
    h.advance(5 * 60 * 1000);
    await h.sync.poll();
    assert.equal(h.sync.status().state, 'idle', 'problem clears when the news arrives');
    h.sync.stop();
  });

  test('writeInboxFiles and inboxToc work on their own', () => {
    const addonsDir = path.join(tmp, 'AddOns');
    fs.mkdirSync(addonsDir, { recursive: true });
    assert.match(inboxToc(addonsDir, '1.2.3'), /^## Interface: 16001, 120105\r\n.*## Version: 1\.2\.3\r\n\r\nInbox\.lua\r\n$/s, 'default Interface without the addon toc');
    const first = writeInboxFiles(addonsDir, { guild: 'Ünïcode' }, '1.2.3');
    assert.deepEqual([first.toc, first.lua], [true, true]);
    const again = writeInboxFiles(addonsDir, { guild: 'Ünïcode' }, '1.2.3');
    assert.deepEqual([again.toc, again.lua], [false, false]);
    assert.equal(parseSavedVariables(fs.readFileSync(path.join(first.dir, 'Inbox.lua'))).WowGuildInbox.guild, 'Ünïcode');
  });
});

describe('Coach', () => {
  test('a pending Coach answer is followed every 6 s and saved when it arrives', async () => {
    const h = setup();
    h.api.routes['POST /api/sync'] = () => ({ ...SYNC_OK, coachPending: 1 });
    let gets = 0;
    h.api.routes['GET /api/inbox'] = () => {
      gets += 1;
      if (gets <= 3) return { ...INBOX, coach: { pending: 1 } };
      return { ...INBOX, coach: { pending: 0, answers: [{ q: 'Which talents first?', a: 'Take Improved Rend.' }] } };
    };
    await h.sync.start();
    assert.equal(h.sync.status().coachWaiting, true);
    await h.sync.whenIdle();

    assert.equal(gets, 4, 'one inbox for the sync, then three checks');
    assert.deepEqual(h.sleeps.filter((ms) => ms === 6000).length, 3);
    assert.equal(readInbox(h.forever).coach.answers[0].a, 'Take Improved Rend.');
    assert.match(h.text(), /The Coach is working on your question or build plan/);
    assert.match(h.text(), /The Coach has answered\. Type \/reload in game/);
    const s = h.sync.status();
    assert.equal(s.coachWaiting, false);
    assert.equal(s.recent[0].kind, 'coach');
    h.sync.stop();
  });

  test('stops checking on the Coach after 2 minutes', async () => {
    const h = setup();
    h.api.routes['POST /api/sync'] = () => ({ ...SYNC_OK, coachPending: 2 });
    h.api.routes['GET /api/inbox'] = () => ({ ...INBOX, coach: { pending: 1 } });
    await h.sync.start();
    await h.sync.whenIdle();
    assert.equal(h.api.inboxGets().length, 1 + 20, '20 checks, 6 s apart');
    assert.match(h.text(), /The Coach is taking a while\. The answer will show after a later \/reload\./);
    assert.equal(h.sync.status().coachWaiting, false);
    h.sync.stop();
  });

  test('stop() ends the Coach follow-up', async () => {
    const h = setup();
    h.api.routes['POST /api/sync'] = () => ({ ...SYNC_OK, coachPending: 1 });
    h.api.routes['GET /api/inbox'] = () => ({ ...INBOX, coach: { pending: 1 } });
    h.onSleep = async (ms) => { if (ms === 6000) h.sync.stop(); };
    await h.sync.start();
    await h.sync.whenIdle();
    assert.equal(h.api.inboxGets().length, 1, 'no checks after stopping');
    assert.ok(!/taking a while/.test(h.text()));
  });
});

describe('lifecycle', () => {
  test('setEnabled(false) pauses uploads and is saved; setEnabled(true) resumes', async () => {
    const h = setup();
    await h.sync.start();
    const s = h.sync.setEnabled(false);
    assert.equal(s.state, 'off');
    assert.equal(h.store.get().syncEnabled, false);
    assert.match(h.text(), /Sync is off\./);
    touch(h.forever.sv.ACCOUNT1);
    await h.sync.poll();
    assert.equal(h.api.posts().length, 1, 'nothing uploaded while off');
    assert.equal(h.sync.setEnabled(false).state, 'off', 'idempotent');

    h.sync.setEnabled(true);
    assert.equal(h.store.get().syncEnabled, true);
    await h.sync.poll();
    assert.equal(h.api.posts().length, 2, 'the change made while off goes up now');
    h.sync.stop();
  });

  test('the 4 s timer keeps checking until stop()', async () => {
    const h = setup();
    await h.sync.start();
    assert.equal(h.timers.length, 1);
    touch(h.forever.sv.ACCOUNT1);
    await h.fireTimer();
    assert.equal(h.api.posts().length, 2, 'the timer ran a check');
    assert.equal(h.timers.length, 1, 'and scheduled the next one');

    const s = h.sync.stop();
    assert.equal(h.timers.length, 0, 'timer cleared');
    assert.equal(s.running, false);
    assert.equal(h.statuses.at(-1).running, false);
    h.sync.stop(); // twice is fine
    assert.equal(await h.sync.start().then((x) => x && x.running), true, 'can start again');
    h.sync.stop();
  });

  test('new game folders are picked up when the folder list changes', async () => {
    const h = setup({ folders: false });
    await h.sync.start();
    assert.equal(h.sync.status().state, 'no-game');
    assert.equal(h.api.posts().length, 0);
    assert.match(h.text(), /No World of Warcraft folder found yet/);

    h.store.set({ extraWowFolders: [h.root] }); // Addon & sync → Add folder
    assert.equal(h.statuses.at(-1).state, 'idle', 'status updates at once');
    assert.equal(h.statuses.at(-1).files.length, 1);
    await h.sync.poll();
    assert.equal(h.api.posts().length, 1, 'its saved data is uploaded');
    assert.deepEqual(h.sleeps, [1500]);
    h.sync.stop();
  });

  test('game folders are looked for again every minute', async () => {
    const h = setup();
    await h.sync.start();
    makeGame(h.root, '_classic_era_', { auctionator: false });
    await h.sync.poll();
    assert.equal(h.api.posts().length, 1, 'not seen yet');
    h.advance(60 * 1000);
    await h.sync.poll();
    assert.equal(h.api.posts().length, 2, 'found and uploaded');
    assert.equal(h.sync.status().installCount, 2);
    h.sync.stop();
  });

  test('signing out stops checks from uploading', async () => {
    const h = setup();
    await h.sync.start();
    h.store.setSecret('deviceToken', null);
    touch(h.forever.sv.ACCOUNT1);
    await h.sync.poll();
    assert.equal(h.api.posts().length, 1);
    assert.equal(h.sync.status().state, 'signed-out');
    h.sync.stop();
  });
});

describe('not in a guild yet', () => {
  const REASON = "None of your characters are in Just Now WoW's roster yet. Ask someone in the guild to open the guild roster in game, or use an invite link.";
  const AUTO_JOIN = { status: 'no-match', guild: { id: 1, name: 'Just Now WoW', faction: 'Horde' }, role: null, via: null, character: null, reason: REASON, detected: { guild: 'Just Now WoW', realm: 'Forever', faction: 'Horde' } };
  const JOINED = { guild: { id: 1, name: 'Just Now WoW', faction: 'Horde' }, role: 'member', via: 'roster', character: 'Thrallia' };
  // What api.js throws for 409 { error, code: 'NO_GUILD_MATCH', autoJoin }: status + sentence (code and
  // autoJoin only when the client passes them on, so both shapes are tested).
  const noMatch = (full = false) => () => {
    throw Object.assign(new ApiError(409, REASON), full ? { code: 'NO_GUILD_MATCH', autoJoin: AUTO_JOIN } : {});
  };
  // GET /api/inbox for someone without a guild, as the real server answers it.
  const refused = () => { throw new ApiError(403, 'Join a guild first.'); };

  function watch(h) {
    h.noGuild = [];
    h.joined = [];
    h.sync.on('no-guild', (info) => h.noGuild.push(info));
    h.sync.on('joined', (joined, where) => h.joined.push({ joined, where }));
    return h;
  }

  test('a 409 is waiting, not failing: state no-guild, the reason as lastError, no backoff, no news', async () => {
    const h = watch(setup({ routes: { 'POST /api/sync': noMatch(true), 'GET /api/inbox': refused } }));
    const s = await h.sync.start();
    assert.equal(h.api.posts().length, 1);
    assert.equal(s.state, 'no-guild');
    assert.equal(s.lastError, REASON);
    assert.deepEqual(s.noGuild, { reason: REASON, since: new Date(CLOCK_START).toISOString() });
    assert.equal(s.nextRetryAt, new Date(CLOCK_START + 60000).toISOString(), 'tried again in a minute');
    assert.equal(s.files[0].lastError, REASON);
    assert.equal(s.lastSyncAt, null, 'nothing was stored');
    assert.equal(h.api.inboxGets().length, 0, 'no guild, no news to fetch');
    assert.ok(!fs.existsSync(h.forever.inboxDir));
    assert.equal(h.noGuild.length, 1);
    assert.deepEqual(h.noGuild[0].autoJoin, AUTO_JOIN, 'the server\'s match result is passed on when the client has it');
    assert.equal(h.noGuild[0].reason, REASON);
    assert.equal(h.noGuild[0].account, 'ACCOUNT1');
    assert.ok(!/Couldn't upload/.test(h.text()), 'not reported as a failed upload');
    assert.equal(h.lines.filter((l) => l.startsWith('Waiting to match you to a guild')).length, 1);
    assert.equal(s.recent[0].kind, 'guild');
    h.sync.stop();
  });

  test('the same file is tried again after 60 s without spam; a new save goes up at once', async () => {
    const h = watch(setup({ routes: { 'POST /api/sync': noMatch(), 'GET /api/inbox': refused } }));
    await h.sync.start();
    h.sleeps.length = 0;
    // Checks every 4 s for just under a minute: nothing is sent, nothing waits.
    for (let t = 4000; t < 60000; t += 4000) {
      h.advance(4000);
      await h.sync.poll();
    }
    assert.equal(h.api.posts().length, 1, 'no retry before a minute has passed');
    assert.deepEqual(h.sleeps, []);
    h.advance(60000 - 56000);
    await h.sync.poll();
    assert.equal(h.api.posts().length, 2, 'retried after 60 s');
    assert.deepEqual(h.sleeps, [], 'an unchanged file needs no settle wait');
    assert.equal(h.sync.status().state, 'no-guild');
    assert.equal(h.noGuild.length, 2, 'every answer is passed on');
    assert.equal(h.noGuild[1].autoJoin, null, 'a bare 409 carries no match result');
    assert.equal(h.lines.filter((l) => l.startsWith('Waiting to match you to a guild')).length, 1, 'logged once per reason');
    assert.equal(h.sync.status().nextRetryAt, new Date(h.clock + 60000).toISOString(), 'and the next try is a minute later (no backoff)');

    // The game saves again (the player logged in to another character): uploaded at the next check.
    touch(h.forever.sv.ACCOUNT1);
    h.advance(4000);
    await h.sync.poll();
    assert.equal(h.api.posts().length, 3);
    assert.deepEqual(h.sleeps, [1500], 'a changed file settles first, as usual');
    h.sync.stop();
  });

  test('a reply with joined emits joined, counts as a normal upload and ends the wait', async () => {
    const h = watch(setup({ routes: { 'POST /api/sync': noMatch(), 'GET /api/inbox': refused } }));
    const statuses = [];
    h.sync.on('status', (s) => statuses.push(s.state));
    await h.sync.start();
    assert.equal(h.sync.status().state, 'no-guild');

    h.api.routes['POST /api/sync'] = () => ({ ...SYNC_OK, joined: JOINED });
    h.api.routes['GET /api/inbox'] = () => INBOX;
    touch(h.forever.sv.ACCOUNT1);
    await h.sync.poll();
    assert.equal(h.joined.length, 1);
    assert.deepEqual(h.joined[0].joined, JOINED);
    assert.equal(h.joined[0].where.account, 'ACCOUNT1');
    assert.equal(h.uploaded.length, 1, 'uploaded as usual');
    const s = h.sync.status();
    assert.equal(s.state, 'idle');
    assert.equal(s.lastError, null);
    assert.equal(s.noGuild, null);
    assert.equal(s.nextRetryAt, null);
    assert.equal(s.files[0].lastError, null);
    assert.ok(s.lastSyncAt);
    assert.equal(h.api.inboxGets().length, 1, 'the guild news is saved right after');
    assert.ok(fs.existsSync(path.join(h.forever.inboxDir, 'Inbox.lua')));
    assert.match(h.text(), /You're in Just Now WoW \(matched Thrallia\)\. Guild Camp joined you automatically\./);
    assert.ok(statuses.includes('no-guild') && statuses.at(-1) === 'idle');
    h.sync.stop();
  });

  test('joined on the very first upload: the upload is processed and the event fires once', async () => {
    const h = watch(setup({ routes: { 'POST /api/sync': () => ({ ...SYNC_OK, joined: JOINED }) } }));
    const s = await h.sync.start();
    assert.equal(s.state, 'idle');
    assert.equal(h.joined.length, 1);
    assert.equal(h.noGuild.length, 0);
    assert.equal(s.lastResult.characters, 1);
    await h.sync.poll();
    assert.equal(h.joined.length, 1, 'not repeated');
    h.sync.stop();
  });

  test('once in a guild another way, clearNoGuild lets waiting files go up at the next check', async () => {
    const h = watch(setup({ routes: { 'POST /api/sync': noMatch(), 'GET /api/inbox': refused } }));
    await h.sync.start();
    h.api.routes['POST /api/sync'] = () => SYNC_OK;
    h.api.routes['GET /api/inbox'] = () => INBOX;
    await h.sync.poll();
    assert.equal(h.api.posts().length, 1, 'still waiting');
    assert.equal(h.api.inboxGets().length, 0, 'and the news is not asked for on every check');
    const s = h.sync.clearNoGuild();
    assert.equal(s.state, 'idle');
    assert.equal(s.lastError, null);
    await h.sync.poll();
    assert.equal(h.api.posts().length, 2, 'uploaded straight away');
    assert.equal(h.sync.status().lastSyncAt, new Date(h.clock).toISOString());
    assert.equal(h.api.inboxGets().length, 1);
    assert.match(h.text(), /You're in a guild now\. Uploading your saved data\./);
    assert.equal(h.sync.clearNoGuild().state, 'idle', 'twice is fine');
    h.sync.stop();
  });

  test('an older server\'s 403 "Join a guild first." waits the same way', async () => {
    const h = watch(setup({ routes: { 'POST /api/sync': () => { throw new ApiError(403, 'Join a guild first.'); } } }));
    const s = await h.sync.start();
    assert.equal(s.state, 'no-guild');
    assert.equal(s.lastError, 'Join a guild first.');
    assert.equal(h.noGuild[0].autoJoin, null);
    h.sync.stop();
  });

  test('without saved data yet, the news being refused (403) is not a sync problem', async () => {
    const h = watch(setup({ game: { db: {} }, routes: { 'GET /api/inbox': () => { throw new ApiError(403, 'Join a guild first.'); } } }));
    const s = await h.sync.start();
    assert.equal(h.api.posts().length, 0);
    assert.equal(h.api.inboxGets().length, 1);
    assert.equal(s.state, 'no-guild');
    assert.equal(s.lastError, 'Join a guild first.');
    assert.equal(h.noGuild.length, 1);
    // The news is asked for again every 5 minutes; once it comes, the wait is over.
    h.api.routes['GET /api/inbox'] = () => INBOX;
    h.advance(5 * 60 * 1000);
    await h.sync.poll();
    assert.equal(h.sync.status().state, 'idle');
    assert.equal(h.sync.status().lastError, null);
    assert.ok(fs.existsSync(path.join(h.forever.inboxDir, 'Inbox.lua')));
    h.sync.stop();
  });

  test('the server\'s reason is kept when the news is refused in the same pass', async () => {
    const h = watch(setup({ routes: { 'POST /api/sync': noMatch(), 'GET /api/inbox': () => { throw new ApiError(403, 'Join a guild first.'); } } }));
    await h.sync.start();
    h.advance(5 * 60 * 1000);
    await h.sync.poll(); // retries the upload (409) and refreshes the news (403)
    assert.equal(h.sync.status().lastError, REASON);
    assert.equal(h.sync.status().state, 'no-guild');
    h.sync.stop();
  });

  test('syncNow says plainly why nothing went up', async () => {
    const h = watch(setup({ routes: { 'POST /api/sync': noMatch(), 'GET /api/inbox': refused } }));
    await assert.rejects(h.sync.syncNow(), (err) => err.message === REASON && err.status === 409 && err.code === 'no-guild');
    assert.equal(h.sync.status().state, 'no-guild');
  });

  test('stop() and turning sync off forget the wait', async () => {
    const h = watch(setup({ routes: { 'POST /api/sync': noMatch(), 'GET /api/inbox': refused } }));
    await h.sync.start();
    let s = h.sync.stop();
    assert.equal(s.noGuild, null);
    assert.equal(s.lastError, null);
    assert.notEqual(s.state, 'no-guild');
    await h.sync.start();
    assert.equal(h.sync.status().state, 'no-guild');
    s = h.sync.setEnabled(false);
    assert.equal(s.state, 'off');
    assert.equal(s.noGuild, null);
    h.sync.stop();
  });

  test('noGuildReply recognises the answers that mean "not in a guild"', () => {
    assert.deepEqual(noGuildReply(new ApiError(409, 'No match')), { reason: 'No match.', autoJoin: null });
    assert.deepEqual(noGuildReply(Object.assign(new ApiError(409, 'No match.'), { body: { code: 'NO_GUILD_MATCH', autoJoin: AUTO_JOIN } })), { reason: 'No match.', autoJoin: AUTO_JOIN });
    assert.deepEqual(noGuildReply(Object.assign(new Error('x'), { code: 'NO_GUILD_MATCH' })), { reason: 'x.', autoJoin: null });
    // What api.js really throws for the server's 409: the match result comes along, so main.js records it
    // instead of asking POST /api/guild/auto-join again.
    const fromServer = errorFromBody(409, JSON.stringify({ error: 'No match.', code: 'NO_GUILD_MATCH', autoJoin: AUTO_JOIN }));
    assert.deepEqual(noGuildReply(fromServer), { reason: 'No match.', autoJoin: AUTO_JOIN });
    assert.deepEqual(noGuildReply(errorFromBody(403, JSON.stringify({ error: 'Join a guild first.' }))), { reason: 'Join a guild first.', autoJoin: null });
    assert.equal(noGuildReply(new ApiError(403, 'Join a guild first.')).reason, 'Join a guild first.');
    assert.equal(noGuildReply(new ApiError(500, 'Boom.')), null);
    assert.equal(noGuildReply(new ApiError(0, 'Offline.')), null);
    assert.equal(noGuildReply(null), null);
  });
});

describe('with the real API client', () => {
  test('uploads JSON with the device token and app version, and writes the inbox from the reply', async () => {
    const seen = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, version: req.headers['x-app-version'], type: req.headers['content-type'], body });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (req.url === '/api/sync') res.end(JSON.stringify(SYNC_OK));
        else if (req.url === '/api/inbox') res.end(JSON.stringify(INBOX));
        else { res.writeHead(404); res.end('{}'); }
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const root = path.join(tmp, 'WoW');
      const game = makeGame(root, '_forever_');
      const store = createStore(path.join(tmp, 'ud'));
      store.setSecret('deviceToken', 'gcd_real_token');
      store.set({ extraWowFolders: [root], serverUrl: `http://127.0.0.1:${server.address().port}` });
      const api = createApi({ getServer: () => store.get().serverUrl, getToken: () => store.getSecret('deviceToken'), appVersion: '0.11.0' });
      const sync = createSync({ api, store, wow, appVersion: '0.11.0', scanDefaults: false });
      const s = await sync.syncNow();
      assert.equal(s.state, 'idle');
      const post = seen.find((r) => r.url === '/api/sync');
      assert.equal(post.method, 'POST');
      assert.equal(post.auth, 'Bearer gcd_real_token');
      assert.equal(post.version, '0.11.0');
      assert.equal(post.type, 'application/json');
      assert.deepEqual(JSON.parse(post.body), { ...DB, prices: extractPricesNow() });
      assert.ok(seen.some((r) => r.url === '/api/inbox' && r.method === 'GET'));
      assert.deepEqual(parseSavedVariables(fs.readFileSync(path.join(game.inboxDir, 'Inbox.lua'))).WowGuildInbox, INBOX);
    } finally {
      server.close();
    }
  });
});

describe('with real timers', () => {
  test('the check loop notices a save on its own, and stop() ends every wait at once', async () => {
    const root = path.join(tmp, 'WoW');
    const game = makeGame(root, '_forever_', { auctionator: false });
    const store = createStore(path.join(tmp, 'ud'));
    store.setSecret('deviceToken', 'gcd_x');
    store.set({ extraWowFolders: [root] });
    const api = fakeApi({ 'POST /api/sync': () => ({ ...SYNC_OK, coachPending: 1 }), 'GET /api/inbox': () => ({ ...INBOX, coach: { pending: 1 } }) });
    const sync = createSync({ api, store, wow, appVersion: '0.11.0', scanDefaults: false, pollMs: 20, settleMs: 10, coachEveryMs: 60 * 1000 });
    try {
      await sync.start();
      assert.equal(api.posts().length, 1);
      const second = new Promise((resolve) => sync.once('uploaded', resolve));
      touch(game.sv.ACCOUNT1);
      await second;
      assert.equal(api.posts().length, 2, 'uploaded by the timer, no poll() call needed');
      assert.equal(sync.status().coachWaiting, true, 'waiting a minute for the Coach');
    } finally {
      const t0 = Date.now();
      sync.stop();
      await sync.whenIdle();
      assert.ok(Date.now() - t0 < 2000, 'stop() did not wait for the Coach timer');
    }
    assert.equal(sync.status().coachWaiting, false);
  });
});

// The real clock is used in the tests above, so compute prices the same way.
function extractPricesNow() {
  const { extractPrices } = require('../src/shared/auctionator');
  return extractPrices(parseSavedVariables(Buffer.from(AUCTIONATOR)).AUCTIONATOR_PRICE_DATABASE, Date.now());
}

describe('helpers', () => {
  test('retry schedule, wording and the upload line', () => {
    assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 20].map((n) => retryDelay(n) / 1000), [5, 10, 20, 40, 80, 160, 300, 300, 300]);
    assert.equal(describeWait(5000), '5 seconds');
    assert.equal(describeWait(1000), '1 second');
    assert.equal(describeWait(60000), '1 minute');
    assert.equal(describeWait(300000), '5 minutes');
    assert.equal(uploadSummary({ characters: 2, roster: 41, recipes: 312 }), 'Uploaded: 2 character(s), 41 roster entries, 312 recipes');
    assert.equal(uploadSummary({ characters: 1, roster: 3, recipes: 2, ctas: 1, prices: 812, bank: 40 }),
      'Uploaded: 1 character(s), 3 roster entries, 2 recipes, 1 call(s) to arms, 812 auction prices, 40 guild bank items');
    assert.equal(uploadSummary(null), 'Uploaded: 0 character(s), 0 roster entries, 0 recipes');
  });
});
