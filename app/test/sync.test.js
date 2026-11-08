'use strict';
// The background sync engine (src/main/sync.js), run against fake game folders in temp dirs. It talks
// to the local core through api.js; no sign-in is needed for any of it.
// Default scanning is off (scanDefaults: false), so a real game install is never touched.
// Time is injected: `now` is a fake clock, `sleep` resolves at once (and records how long it was
// asked to wait), and the 4 s check timer is a fake the tests fire by hand.
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const { createSync, inboxToc, writeInboxFiles, uploadSummary, retryDelay, describeWait } = require('../src/main/sync');
// The real wow.js, except that the game counts as closed: tests never ask the real task list.
const wow = { ...require('../src/main/wow'), isWowRunning: async () => false };
const { createStore, sanitizeSettingsPatch } = require('../src/main/store');
const { createLog } = require('../src/main/log');
const { createApi, ApiError } = require('../src/main/api');
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
};

const SYNC_OK = { ok: true, guild: { id: 1, name: 'Camp Fire', faction: 'Horde', role: 'officer' }, characters: 1, roster: 3, recipes: 2, ctas: 1, inventory: 0, bank: 0, prices: 2, coachPending: 0, latest: { app: { version: '0.11.0' }, addon: { version: '0.11.1' } } };

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
      if (!handler) throw new ApiError(404, "Guild Camp couldn't find that.");
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
 * @param {boolean} [o.folders=true] settings.extraWowFolders points at the fake "World of Warcraft" folder
 */
function setup({ folders = true, routes = {}, game = {}, pids = false } = {}) {
  const root = path.join(tmp, 'World of Warcraft');
  const forever = makeGame(root, '_forever_', game);
  const store = createStore(path.join(tmp, 'user-data'));
  if (folders) store.set({ extraWowFolders: [root] });
  const log = createLog(path.join(tmp, 'logs'));
  const api = fakeApi({ 'POST /api/sync': () => SYNC_OK, 'GET /api/inbox': () => INBOX, ...routes });

  // gameRunning: what isWowRunning says. With pids, the game is asked for its process ids (gameIds) instead.
  const h = { root, forever, store, log, api, clock: CLOCK_START, sleeps: [], timers: [], lines: [], statuses: [], uploaded: [], onSleep: null, gameRunning: false, gameIds: [], gameChecks: 0 };
  h.createSync = () => createSync({
    api,
    store,
    log: log.scope('sync'),
    wow,
    appVersion: '0.11.0',
    scanDefaults: false,
    ...(pids
      ? { gameProcessIds: async () => { h.gameChecks += 1; return h.gameIds; } }
      : { isWowRunning: async () => { h.gameChecks += 1; return h.gameRunning; } }),
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
  /** A new sync engine on the same settings and folders, as after Guild Camp restarts. */
  h.restartApp = () => {
    h.sync.stop();
    h.timers.length = 0;
    h.sync = h.createSync();
    h.sync.on('log', (msg) => h.lines.push(msg));
    h.sync.on('status', (s) => h.statuses.push(s));
    return h.sync;
  };
  h.sync = h.createSync();
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
  test('off and no game folder are reported before anything else; no sign-in is needed', async () => {
    const h = setup({ folders: false });
    assert.equal(h.sync.status().state, 'no-game');
    assert.equal('noGuild' in h.sync.status(), false, 'there is no "waiting for the server to find your guild" state any more');
    assert.equal(h.sync.status().guildNote, null);
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
    assert.deepEqual(post.body, { ...DB, prices: PRICES, _source: { account: 'ACCOUNT1', install: h.forever.dir } });
    assert.equal(post.opts.timeout, 120000);
    assert.equal(h.api.inboxGets().length, 1);

    assert.equal(status.state, 'idle');
    assert.equal(status.running, true);
    assert.equal(status.lastSyncAt, new Date(CLOCK_START).toISOString());
    assert.deepEqual(status.lastResult, { characters: 1, roster: 3, recipes: 2, ctas: 1, inventory: 0, bank: 0, prices: 2, coachPending: 0, account: 'ACCOUNT1', label: 'WoW Forever', guild: { name: 'Camp Fire', role: 'officer' } });
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
    const down = () => { throw new ApiError(0, "Guild Camp couldn't reach its own data service (connection refused). Restart Guild Camp."); };
    h.api.routes['POST /api/sync'] = down;
    await h.sync.start();
    assert.equal(h.api.posts().length, 1);
    let s = h.sync.status();
    assert.equal(s.state, 'error');
    assert.match(s.lastError, /couldn't reach its own data service/);
    assert.equal(s.nextRetryAt, new Date(h.clock + 5000).toISOString());
    assert.equal(s.files[0].nextRetryAt, s.nextRetryAt);
    assert.match(s.files[0].lastError, /connection refused/);
    assert.equal(s.recent[0].ok, false);
    assert.match(h.lines.at(-2), /^Couldn't upload the saved data for ACCOUNT1: Guild Camp couldn't reach its own data service .* Trying again in 5 seconds\.$/);
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
    h.api.routes['POST /api/sync'] = () => { throw new ApiError(500, 'Guild Camp had a problem. Try again, and look in the log if it keeps happening.'); };
    await assert.rejects(h.sync.syncNow(), { message: 'Guild Camp had a problem. Try again, and look in the log if it keeps happening.' });
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
    h.store.set({ otherGameFolders: [retail.dir] });
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
    h.api.routes['GET /api/inbox'] = () => { throw new ApiError(500, 'Guild Camp had a problem. Try again, and look in the log if it keeps happening.'); };
    h.advance(5 * 60 * 1000);
    await h.sync.poll();
    await h.sync.poll();
    assert.equal(h.api.inboxGets().length, 3);
    assert.equal(h.sync.status().state, 'error');
    assert.match(h.text(), /Couldn't put together the guild news for the addon: Guild Camp had a problem./);
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
    assert.deepEqual([first.toc, first.lua, first.created], [true, true, true]);
    const again = writeInboxFiles(addonsDir, { guild: 'Ünïcode' }, '1.2.3');
    assert.deepEqual([again.toc, again.lua, again.created], [false, false, false]);
    assert.equal(parseSavedVariables(fs.readFileSync(path.join(first.dir, 'Inbox.lua'))).WowGuildInbox.guild, 'Ünïcode');
    // A folder without its .toc was never an addon the game knew: still a first creation.
    fs.rmSync(path.join(first.dir, 'WowGuild_Inbox.toc'));
    assert.equal(writeInboxFiles(addonsDir, { guild: 'x' }, '1.2.3').created, true);
  });

  test('the first WowGuild_Inbox made while the game runs says the news shows after a game restart, since a /reload does not load a new addon folder', async () => {
    const h = setup();
    h.gameRunning = true;
    await h.sync.start();
    assert.ok(fs.existsSync(path.join(h.forever.inboxDir, 'WowGuild_Inbox.toc')));
    assert.match(h.text(), /Guild news saved for the addon\. It shows after you restart World of Warcraft\. A \/reload isn't enough the first time\./);
    assert.doesNotMatch(h.text(), /It shows after your next \/reload/);
    // The folder is there now: once the game has closed (so its next start finds the folder), a save needs only a /reload.
    h.gameRunning = false;
    h.lines.length = 0;
    touch(h.forever.sv.ACCOUNT1);
    await h.sync.poll();
    assert.match(h.text(), /Guild news saved for the addon\. It shows after your next \/reload\./);
    assert.doesNotMatch(h.text(), /restart World of Warcraft/);
    h.sync.stop();

    // When Guild Camp can't tell whether the game runs, it says restart too.
    fs.rmSync(h.forever.inboxDir, { recursive: true });
    h.gameRunning = null;
    h.lines.length = 0;
    await h.sync.syncNow();
    assert.match(h.text(), /It shows after you restart World of Warcraft/);
  });

  test('a /reload later in the same game session, after the first WowGuild_Inbox was made while the game ran, still says restart (the running game never loads that folder) until Guild Camp sees the game closed', async () => {
    const h = setup();
    h.gameRunning = true;
    await h.sync.start();
    assert.match(h.text(), /It shows after you restart World of Warcraft/);
    // The player types /reload: the game saves, and its session still doesn't have the news folder.
    h.lines.length = 0;
    touch(h.forever.sv.ACCOUNT1);
    await h.sync.poll();
    assert.match(h.text(), /Guild news saved for the addon\. It shows after you restart World of Warcraft\. A \/reload isn't enough the first time\./);
    assert.doesNotMatch(h.text(), /It shows after your next \/reload/);
    // The 5-minute refresh while the game still runs adds no line.
    h.lines.length = 0;
    h.advance(5 * 60 * 1000);
    await h.sync.poll();
    assert.doesNotMatch(h.text(), /Guild news saved/);
    // The game closes (the next refresh sees it); after the next game start a /reload is enough again.
    h.gameRunning = false;
    h.advance(5 * 60 * 1000);
    await h.sync.poll();
    h.gameRunning = true;
    h.lines.length = 0;
    touch(h.forever.sv.ACCOUNT1);
    await h.sync.poll();
    assert.match(h.text(), /Guild news saved for the addon\. It shows after your next \/reload\./);
    assert.doesNotMatch(h.text(), /restart World of Warcraft/);
    h.sync.stop();
  });

  test('a WowGuild_Inbox made while the game runs: sync status says restartNeeded for that game folder, kept in settings across a Guild Camp restart, until Guild Camp sees the game closed', async () => {
    const h = setup();
    h.gameRunning = true;
    await h.sync.start();
    let s = h.sync.status();
    assert.equal(s.restartNeeded, true);
    assert.equal(s.restartFolders.length, 1);
    assert.equal(wow.pathKey(s.restartFolders[0].install), wow.pathKey(h.forever.dir));
    assert.equal(s.restartFolders[0].label, 'WoW Forever');
    assert.equal(s.restartFolders[0].since, new Date(CLOCK_START).toISOString());
    assert.equal(h.statuses.at(-1).restartNeeded, true, 'the status event carries it to the screens');
    // Saved in settings, as an internal key the screens can't change.
    assert.deepEqual(Object.keys(h.store.get().inboxRestart), [wow.pathKey(h.forever.dir)]);
    assert.deepEqual(sanitizeSettingsPatch({ inboxRestart: {}, theme: 'dark' }), { theme: 'dark' });

    // Guild Camp restarts (an app update, say) while the same game session runs: it still says restart, before any write.
    h.clock += 60 * 1000;
    h.restartApp();
    assert.equal(h.sync.status().restartNeeded, true);
    await h.sync.start();
    assert.equal(h.sync.status().restartNeeded, true);
    h.lines.length = 0;
    touch(h.forever.sv.ACCOUNT1); // a /reload in that session
    await h.sync.poll();
    assert.match(h.text(), /It shows after you restart World of Warcraft/);

    // The game closes: the next check sees it, and the folder no longer waits.
    h.gameRunning = false;
    h.clock += 31 * 1000;
    await h.sync.poll();
    s = h.sync.status();
    assert.equal(s.restartNeeded, false);
    assert.deepEqual(s.restartFolders, []);
    assert.deepEqual(h.store.get().inboxRestart, {});
    assert.equal(h.statuses.at(-1).restartNeeded, false);
    h.sync.stop();
  });

  test('a quick game restart Guild Camp never sees closed (other game process ids) ends the wait for a restart; the running game is looked at at most every 30 s', async () => {
    const h = setup({ pids: true });
    h.gameIds = [4242];
    await h.sync.start();
    assert.equal(h.sync.status().restartNeeded, true);
    assert.deepEqual(Object.values(h.store.get().inboxRestart)[0].pids, [4242]);
    const checks = h.gameChecks;
    // The same game keeps running: no new look within 30 s, and it still waits after one.
    h.clock += 10 * 1000;
    await h.sync.poll();
    assert.equal(h.gameChecks, checks, 'no check within 30 s');
    h.clock += 21 * 1000;
    await h.sync.poll();
    assert.equal(h.gameChecks, checks + 1);
    assert.equal(h.sync.status().restartNeeded, true);
    // Guild Camp can't tell for a moment: it keeps waiting.
    h.gameIds = null;
    h.clock += 31 * 1000;
    await h.sync.poll();
    assert.equal(h.sync.status().restartNeeded, true);
    // The player closed the game and started it again between two checks: the session that lacked the folder is gone.
    h.gameIds = [5150];
    h.clock += 31 * 1000;
    await h.sync.poll();
    assert.equal(h.sync.status().restartNeeded, false);
    assert.deepEqual(h.store.get().inboxRestart, {});
    h.lines.length = 0;
    touch(h.forever.sv.ACCOUNT1);
    await h.sync.poll();
    assert.match(h.text(), /Guild news saved for the addon\. It shows after your next \/reload\./);
    assert.doesNotMatch(h.text(), /restart World of Warcraft/);
    // A second game client started after the folder was made doesn't keep an old wait alive either.
    fs.rmSync(h.forever.inboxDir, { recursive: true });
    h.gameIds = [6000];
    await h.sync.syncNow();
    assert.equal(h.sync.status().restartNeeded, true);
    h.gameIds = [6000, 7000];
    h.clock += 31 * 1000;
    await h.sync.poll();
    assert.equal(h.sync.status().restartNeeded, true, 'the session from then still runs');
    h.gameIds = [7000];
    h.clock += 31 * 1000;
    await h.sync.poll();
    assert.equal(h.sync.status().restartNeeded, false, 'only a client that started with the folder is left');
    h.sync.stop();
  });

  test('Y8: uninstalling the addon from a game folder whose news folder waits for a game restart takes that folder off the Sync card notice at once, and out of the saved waits at the next check, while the game still runs', async () => {
    const h = setup();
    h.gameRunning = true;
    await h.sync.start();
    assert.equal(h.sync.status().restartNeeded, true);
    // Uninstall: WowGuild and WowGuild_Inbox go (main/addon.js uninstall).
    fs.rmSync(path.join(h.forever.addonsDir, 'WowGuild'), { recursive: true });
    fs.rmSync(h.forever.inboxDir, { recursive: true });
    const s = h.sync.status();
    assert.equal(s.restartNeeded, false);
    assert.deepEqual(s.restartFolders, []);
    h.clock += 31 * 1000;
    await h.sync.poll();
    assert.deepEqual(h.store.get().inboxRestart, {}, 'the wait is forgotten');
    assert.equal(h.sync.status().restartNeeded, false);
    h.sync.stop();
  });

  test('Y8: a wait for a game restart that Guild Camp can\'t follow (the game runs, but only whether it runs can be read) ends after 24 hours', async () => {
    // isWowRunning only (no process ids): it can't tell this session from a later one.
    const h = setup();
    h.gameRunning = true;
    await h.sync.start();
    assert.equal(Object.values(h.store.get().inboxRestart)[0].pids, null);
    h.clock += 23 * 3600 * 1000;
    await h.sync.poll();
    assert.equal(h.sync.status().restartNeeded, true, 'still within 24 hours');
    h.clock += 3600 * 1000;
    await h.sync.poll();
    assert.equal(h.sync.status().restartNeeded, false, 'after 24 hours');
    assert.deepEqual(h.store.get().inboxRestart, {});
    h.sync.stop();
  });

  test('Y8: a wait for a game restart made while the game\'s process ids can\'t be read at all ends after 24 hours', async () => {
    const k = setup({ pids: true });
    k.gameIds = null;
    await k.sync.start();
    assert.equal(k.sync.status().restartNeeded, true);
    k.clock += 24 * 3600 * 1000;
    await k.sync.poll();
    assert.equal(k.sync.status().restartNeeded, false);
    k.sync.stop();
  });

  test('Y8: a wait for a game restart Guild Camp follows by process ids stays past 24 hours while that game session still runs', async () => {
    const h = setup({ pids: true });
    h.gameIds = [4242];
    await h.sync.start();
    h.clock += 30 * 3600 * 1000;
    await h.sync.poll();
    assert.equal(h.sync.status().restartNeeded, true, 'the same game session still runs');
    h.gameIds = [5150];
    h.clock += 31 * 1000;
    await h.sync.poll();
    assert.equal(h.sync.status().restartNeeded, false);
    h.sync.stop();
  });

  test('the game is asked for its process ids through wow.gameProcessIds, but a wow whose isWowRunning was replaced (tests, tools) is asked through that only', async () => {
    const root = path.join(tmp, 'World of Warcraft');
    const game = makeGame(root, '_forever_');
    const store = createStore(path.join(tmp, 'user-data'));
    store.set({ extraWowFolders: [root] });
    const api = fakeApi({ 'POST /api/sync': () => SYNC_OK, 'GET /api/inbox': () => INBOX });
    const real = require('../src/main/wow');
    let idCalls = 0;
    const timerless = { setTimeout: () => ({}), clearTimeout: () => {} };
    // The app's own wow module: process ids.
    let sync = createSync({ api, store, wow: { ...real, gameProcessIds: async () => { idCalls += 1; return [31337]; } }, appVersion: '0.11.0', scanDefaults: false, ...timerless });
    await sync.start();
    assert.equal(idCalls, 1);
    assert.deepEqual(Object.values(store.get().inboxRestart)[0].pids, [31337]);
    sync.stop();
    // A replaced isWowRunning: the real process list is never asked.
    fs.rmSync(game.inboxDir, { recursive: true });
    store.set({ inboxRestart: {} });
    idCalls = 0;
    sync = createSync({ api, store, wow: { ...real, isWowRunning: async () => true, gameProcessIds: async () => { idCalls += 1; return []; } }, appVersion: '0.11.0', scanDefaults: false, ...timerless });
    await sync.start();
    assert.equal(idCalls, 0);
    assert.equal(sync.status().restartNeeded, true);
    assert.equal(Object.values(store.get().inboxRestart)[0].pids, null, 'no process ids known');
    sync.stop();
  });

  test('a Coach answer saved while the news folder waits for a game restart says to restart the game, not to /reload', async () => {
    const h = setup();
    h.gameRunning = true;
    h.api.routes['POST /api/sync'] = () => ({ ...SYNC_OK, coachPending: 1 });
    let gets = 0;
    h.api.routes['GET /api/inbox'] = () => {
      gets += 1;
      return gets <= 1 ? { ...INBOX, coach: { pending: 1 } } : { ...INBOX, coach: { pending: 0, answers: [{ q: 'Which talents first?', a: 'Take Improved Rend.' }] } };
    };
    await h.sync.start();
    await h.sync.whenIdle();
    assert.match(h.text(), /The Coach has answered\. Restart World of Warcraft to see it\. A \/reload isn't enough the first time\./);
    assert.doesNotMatch(h.text(), /The Coach has answered\. Type \/reload/);
    h.sync.stop();
  });

  test('a Coach answer still on its way after two minutes, while the news folder waits for a game restart, says it shows after a restart; with no wait, after a later /reload', async () => {
    const h = setup();
    h.gameRunning = true;
    h.api.routes['POST /api/sync'] = () => ({ ...SYNC_OK, coachPending: 1 });
    h.api.routes['GET /api/inbox'] = () => ({ ...INBOX, coach: { pending: 1 } });
    await h.sync.start();
    await h.sync.whenIdle();
    assert.match(h.text(), /The Coach is taking a while\. The answer will show after you restart World of Warcraft\. A \/reload isn't enough the first time\./);
    assert.doesNotMatch(h.text(), /after a later \/reload/);
    // The game closes; the next question's slow answer needs only a /reload.
    h.gameRunning = false;
    h.clock += 31 * 1000;
    await h.sync.poll();
    assert.equal(h.sync.status().restartNeeded, false);
    h.lines.length = 0;
    touch(h.forever.sv.ACCOUNT1);
    await h.sync.poll();
    await h.sync.whenIdle();
    assert.match(h.text(), /The Coach is taking a while\. The answer will show after a later \/reload\./);
    h.sync.stop();
  });

  test('a WowGuild_Inbox made while the game runs, with a settings file that cannot be written: the wait for a game restart is kept for this run, so sync status and the log still say restart, not /reload', async () => {
    const h = setup();
    h.gameRunning = true;
    const realSet = h.store.set;
    h.store.set = (patch) => {
      if (patch && 'inboxRestart' in patch) throw new Error('EPERM: operation not permitted, rename settings.json');
      return realSet(patch);
    };
    await h.sync.start();
    assert.deepEqual(h.store.get().inboxRestart, {}, 'nothing could be saved');
    assert.equal(h.sync.status().restartNeeded, true);
    assert.equal(h.statuses.at(-1).restartNeeded, true);
    assert.match(h.text(), /Guild news saved for the addon\. It shows after you restart World of Warcraft\./);
    assert.doesNotMatch(h.text(), /It shows after your next \/reload/);
    // The settings can be written again: the game is seen closed, the wait ends and is saved as ended.
    h.store.set = realSet;
    h.gameRunning = false;
    h.clock += 31 * 1000;
    await h.sync.poll();
    assert.equal(h.sync.status().restartNeeded, false);
    assert.deepEqual(h.store.get().inboxRestart, {});
    h.sync.stop();
  });
});

describe('sharing outbox', () => {
  test('a change queued in the app rewrites the inbox within 2 s, once for a burst, also with the game closed', async () => {
    const { EventEmitter } = require('events');
    const coreEvents = new EventEmitter();
    let outbox = [];
    const root = path.join(tmp, 'World of Warcraft');
    const game = makeGame(root, '_forever_');
    const store = createStore(path.join(tmp, 'user-data'));
    store.set({ extraWowFolders: [root] });
    const api = fakeApi({ 'POST /api/sync': () => SYNC_OK, 'GET /api/inbox': () => ({ ...INBOX, outbox }) });
    const timers = [];
    const sync = createSync({
      api, store, wow, appVersion: '0.11.0', scanDefaults: false, coreEvents,
      setTimeout: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
      clearTimeout: (t) => { const i = timers.indexOf(t); if (i !== -1) timers.splice(i, 1); },
    });
    // Never started (as when the game is closed and nothing was saved yet): the change still goes out.
    outbox = [{ op: 'o1ab', g: 'Forever/Camp Fire', id: 'AN:q2w8zz', t: 1794069000, need: 'o', base: '', body: 'Bring fire resist' }];
    coreEvents.emit('outbox');
    coreEvents.emit('outbox');
    coreEvents.emit('outbox');
    assert.equal(timers.length, 1, 'one rewrite for a burst of changes');
    assert.ok(timers[0].ms <= 2000, 'within 2 s');
    const t = timers.shift();
    await t.fn();
    assert.equal(api.inboxGets().length, 1);
    assert.deepEqual(readInbox(game).outbox, outbox);

    // A later change: another rewrite. Through the method too.
    outbox = [];
    sync.outboxChanged();
    await timers.shift().fn();
    assert.deepEqual(Object.values(readInbox(game).outbox || {}), [], 'nothing waiting any more');

    // Sync turned off: nothing is written; stop() drops a pending rewrite.
    sync.setEnabled(false);
    coreEvents.emit('outbox');
    await timers.shift().fn();
    assert.equal(api.inboxGets().length, 2);
    sync.setEnabled(true);
    coreEvents.emit('outbox');
    assert.equal(timers.length, 1);
    sync.stop();
    assert.equal(timers.length, 0);
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
    const era = makeGame(h.root, '_classic_era_', { auctionator: false });
    await h.sync.poll();
    assert.equal(h.api.posts().length, 1, 'not seen yet');
    h.advance(60 * 1000);
    await h.sync.poll();
    assert.equal(h.api.posts().length, 1, 'found, but another game stays out until the person turns it on');
    assert.equal(h.sync.status().installCount, 1);
    h.store.set({ otherGameFolders: [era.dir] });
    await h.sync.poll();
    assert.equal(h.api.posts().length, 2, 'turned on: looked for again at once and uploaded');
    assert.equal(h.sync.status().installCount, 2);
    h.sync.stop();
  });

  test('signing out of Battle.net changes nothing: checks keep uploading', async () => {
    const h = setup();
    await h.sync.start();
    h.store.setSecret('bnetToken', null);
    touch(h.forever.sv.ACCOUNT1);
    await h.sync.poll();
    assert.equal(h.api.posts().length, 2);
    assert.equal(h.sync.status().state, 'idle');
    h.sync.stop();
  });
});

describe('not in a guild yet', () => {
  const NOTE = 'None of your characters is in a guild yet. Guild Camp starts working as soon as you log in to a character in your guild.';
  const NO_GUILD = { ok: true, noGuild: true, message: NOTE, characters: 0, roster: 0, recipes: 0, ctas: 0, inventory: 0, bank: 0, prices: 0, coachPending: 0, latest: { app: null, addon: null } };
  const EMPTY_INBOX = { guild: '', generatedAt: 1730000000, coach: { pending: 0 }, latestAddon: '0.11.1' };

  test('a roster guild the core offers shows in the status until an upload has a guild', async () => {
    const offerNote = 'None of your characters has a guild saved, but your last guild roster scan was for Camp Fire.';
    let reply = { ...NO_GUILD, message: offerNote, rosterGuild: { name: 'Camp Fire', realm: 'Zul\'jin', extra: 1 } };
    const h = setup({ routes: { 'POST /api/sync': () => reply, 'GET /api/inbox': () => EMPTY_INBOX } });
    let s = await h.sync.start();
    assert.equal(s.guildNote, offerNote);
    assert.deepEqual(s.guildOffer, { name: 'Camp Fire', realm: 'Zul\'jin' });
    reply = NO_GUILD;
    touch(h.forever.sv.ACCOUNT1);
    await h.sync.poll();
    s = h.sync.status();
    assert.equal(s.guildOffer, null, 'no roster guild in the reply: no offer');
    assert.equal(s.guildNote, NOTE);
    h.sync.stop();
  });

  test('the core stores nothing and says why: logged once, not a failure, and the next save goes up as usual', async () => {
    const h = setup({ routes: { 'POST /api/sync': () => NO_GUILD, 'GET /api/inbox': () => EMPTY_INBOX } });
    let s = await h.sync.start();
    assert.equal(h.api.posts().length, 1);
    assert.equal(s.state, 'idle', 'waiting for a guild is not a problem');
    assert.equal(s.lastError, null);
    assert.equal(s.guildNote, NOTE);
    assert.equal(s.lastResult.guild, null);
    assert.equal(s.files[0].lastError, null);
    assert.equal(s.nextRetryAt, null, 'no retry: the game saving again is what counts');
    assert.ok(!/Uploaded:/.test(h.text()), 'no "Uploaded" line for an upload that stored nothing');
    assert.equal(h.lines.filter((l) => l === NOTE).length, 1);
    assert.equal(s.recent[0].kind, 'guild');
    assert.equal(readInbox(h.forever).guild, '', 'the (empty) news still reaches the addon, with the latest version');

    // The same answer again is not logged again.
    touch(h.forever.sv.ACCOUNT1);
    await h.sync.poll();
    assert.equal(h.api.posts().length, 2);
    assert.equal(h.lines.filter((l) => l === NOTE).length, 1);

    // Joining a guild in game: the next save is a normal upload.
    h.api.routes['POST /api/sync'] = () => ({ ...SYNC_OK, switched: { id: 1, name: 'Camp Fire', faction: 'Horde', created: true } });
    touch(h.forever.sv.ACCOUNT1);
    await h.sync.poll();
    s = h.sync.status();
    assert.equal(s.guildNote, null);
    assert.deepEqual(s.lastResult.guild, { name: 'Camp Fire', role: 'officer' });
    assert.match(h.text(), /Guild Camp set up Camp Fire./);
    assert.match(h.text(), /Uploaded: 1 character\(s\), 3 roster entries, 2 recipes/);
    h.sync.stop();
  });
});

describe('with the real API client', () => {
  test('uploads JSON with the launch token and app version to the local core, and writes the inbox from the reply', async () => {
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
      store.set({ extraWowFolders: [root] });
      const base = `http://127.0.0.1:${server.address().port}`;
      const api = createApi({ getBase: () => base, getToken: () => 'gcd_real_token', appVersion: '0.11.0' });
      const sync = createSync({ api, store, wow, appVersion: '0.11.0', scanDefaults: false });
      const s = await sync.syncNow();
      assert.equal(s.state, 'idle');
      const post = seen.find((r) => r.url === '/api/sync');
      assert.equal(post.method, 'POST');
      assert.equal(post.auth, 'Bearer gcd_real_token');
      assert.equal(post.version, '0.11.0');
      assert.equal(post.type, 'application/json');
      assert.deepEqual(JSON.parse(post.body), { ...DB, prices: extractPricesNow(), _source: { account: 'ACCOUNT1', install: game.dir } });
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
