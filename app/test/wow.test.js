'use strict';
// Game folder detection (src/main/wow.js). Everything happens in temp folders: default scanning is
// always off (scanDefaults: false, or GUILDCAMP_NO_SCAN), so a real game install is never touched.
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const wow = require('../src/main/wow');

const { findInstalls, savedVariablesFiles, accountName, flavorLabel, defaultRoots, normaliseRoot, isWowRunning } = wow;

let tmp;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-wow-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

function mk(...parts) {
  const dir = path.join(...parts);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function write(file, text = '') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

/** root/<flavor>/Interface/AddOns/WowGuild + WTF/Account/<acc>/SavedVariables/WowGuild.lua */
function gameFolder(root, flavor, { addon = true, accounts = ['ACCOUNT1'], wtf = true, iface = true } = {}) {
  const dir = flavor ? path.join(root, flavor) : root;
  if (iface) mk(dir, 'Interface', 'AddOns');
  if (addon) write(path.join(dir, 'Interface', 'AddOns', 'WowGuild', 'WowGuild.toc'), '## Interface: 11507\n## Version: 0.11.0\n');
  if (wtf) {
    mk(dir, 'WTF', 'Account');
    for (const acc of accounts) write(path.join(dir, 'WTF', 'Account', acc, 'SavedVariables', 'WowGuild.lua'), 'WowGuildDB = {}\n');
  }
  return dir;
}

describe('findInstalls', () => {
  test('finds flavor folders with their AddOns, WTF and saved data files', () => {
    const root = mk(tmp, 'World of Warcraft');
    const forever = gameFolder(root, '_forever_', { accounts: ['ACCOUNT1', '12345#2'] });
    const list = findInstalls({ extraRoots: [root], scanDefaults: false });
    assert.equal(list.length, 1);
    const [i] = list;
    assert.equal(i.dir, forever);
    assert.equal(i.root, root);
    assert.equal(i.flavor, '_forever_');
    assert.equal(i.label, 'WoW Forever');
    assert.equal(i.addonsDir, path.join(forever, 'Interface', 'AddOns'));
    assert.equal(i.wtfDir, path.join(forever, 'WTF'));
    assert.equal(i.addonInstalled, true);
    assert.deepEqual(i.accounts.map(accountName).sort(), ['12345#2', 'ACCOUNT1']);
    for (const f of i.accounts) assert.ok(f.endsWith(path.join('SavedVariables', 'WowGuild.lua')));
  });

  test('an install counts even when the addon is not installed yet', () => {
    const root = mk(tmp, 'WoW');
    gameFolder(root, '_retail_', { addon: false, accounts: [] });
    const [i] = findInstalls({ extraRoots: [root], scanDefaults: false });
    assert.equal(i.label, 'Retail');
    assert.equal(i.addonInstalled, false);
    assert.deepEqual(i.accounts, []);
  });

  test('flavor folders need an Interface or a WTF folder; other folders are ignored', () => {
    const root = mk(tmp, 'WoW');
    gameFolder(root, '_forever_', { iface: false }); // WTF only
    gameFolder(root, '_classic_era_', { wtf: false }); // Interface only
    mk(root, '_ptr_', 'Data'); // never launched: neither
    gameFolder(root, 'Backup'); // not a flavor folder name
    fs.writeFileSync(path.join(root, '_beta_'), 'a file, not a folder');
    const list = findInstalls({ extraRoots: [root], scanDefaults: false });
    assert.deepEqual(list.map((i) => i.flavor), ['_forever_', '_classic_era_']);
    assert.deepEqual(list.map((i) => i.label), ['WoW Forever', 'Classic Era']);
  });

  test('lists WoW Forever first, then the other known flavors, then the rest', () => {
    const root = mk(tmp, 'WoW');
    for (const f of ['_xptr_', '_retail_', '_classic_', '_forever_', '_anniversary_']) gameFolder(root, f, { accounts: [] });
    const list = findInstalls({ extraRoots: [root], scanDefaults: false });
    assert.deepEqual(list.map((i) => i.flavor), ['_forever_', '_retail_', '_classic_', '_anniversary_', '_xptr_']);
  });

  test('a root that itself has Interface and WTF is an install', () => {
    const game = gameFolder(mk(tmp, 'WoW Forever'), null);
    const list = findInstalls({ extraRoots: [game], scanDefaults: false });
    assert.equal(list.length, 1);
    assert.equal(list[0].dir, game);
    assert.equal(list[0].flavor, null);
    assert.equal(list[0].label, 'WoW Forever', 'named after its folder');
    assert.equal(list[0].accounts.length, 1);

    // ...but not with just one of them.
    const half = mk(tmp, 'Half');
    mk(half, 'WTF');
    assert.deepEqual(findInstalls({ extraRoots: [half], scanDefaults: false }), []);
  });

  test('picking the flavor folder itself works, as does a folder inside the game folder', () => {
    const forever = gameFolder(mk(tmp, 'World of Warcraft'), '_forever_');
    for (const picked of [forever, path.join(forever, 'Interface'), path.join(forever, 'Interface', 'AddOns'),
      path.join(forever, 'Interface', 'AddOns', 'WowGuild'), path.join(forever, 'WTF')]) {
      const list = findInstalls({ extraRoots: [picked], scanDefaults: false });
      assert.equal(list.length, 1, picked);
      assert.equal(list[0].dir, forever, picked);
      assert.equal(list[0].label, 'WoW Forever', picked);
    }
  });

  test('the same folder reached twice is listed once', () => {
    const root = mk(tmp, 'World of Warcraft');
    gameFolder(root, '_forever_');
    const roots = [root, `${root}${path.sep}`, path.join(root, '_forever_'), path.join(root, '.', '_forever_', '..')];
    if (process.platform === 'win32') roots.push(root.toUpperCase(), root.toLowerCase());
    const list = findInstalls({ extraRoots: roots, scanDefaults: false });
    assert.equal(list.length, 1);
  });

  test('never throws on missing, odd or unreadable folders', () => {
    const file = write(path.join(tmp, 'not-a-folder.txt'), 'x');
    const list = findInstalls({ extraRoots: [path.join(tmp, 'missing'), file, '', '   ', null, 42, 'relative\\path', 'bad\0path'], scanDefaults: false });
    assert.deepEqual(list, []);
    assert.deepEqual(findInstalls({ scanDefaults: false }), [], 'no extra roots is fine');
    assert.deepEqual(findInstalls({ extraRoots: 'C:\\not-a-list', scanDefaults: false }), []);
  });

  test('GUILDCAMP_NO_SCAN keeps the usual install places out', () => {
    const before = process.env.GUILDCAMP_NO_SCAN;
    process.env.GUILDCAMP_NO_SCAN = '1';
    try {
      const root = mk(tmp, 'WoW');
      gameFolder(root, '_forever_');
      const list = findInstalls({ extraRoots: [root], scanDefaults: true });
      assert.deepEqual(list.map((i) => i.root), [root]);
    } finally {
      if (before === undefined) delete process.env.GUILDCAMP_NO_SCAN;
      else process.env.GUILDCAMP_NO_SCAN = before;
    }
  });
});

describe('detectGuild', () => {
  const { toLua } = require('../src/shared/lua');
  const sv = (characters, extra = {}) => `\nWowGuildDB = ${toLua({ addonVersion: '0.11.0', characters, ...extra })}\n`;
  const char = (name, o = {}) => ({ name, realm: 'Forever', class: 'WARRIOR', race: 'Orc', level: 20, faction: 'Horde', money: 100, zone: 'Durotar', ...o });

  /** Two game folders: WoW Forever with accounts ALICE + BOB, Retail with account ALICE. */
  function tree() {
    const root = mk(tmp, 'World of Warcraft');
    const forever = gameFolder(root, '_forever_', { accounts: [] });
    const retail = gameFolder(root, '_retail_', { accounts: [], addon: false });
    const file = (dir, acc) => path.join(dir, 'WTF', 'Account', acc, 'SavedVariables', 'WowGuild.lua');
    const files = {
      foreverAlice: write(file(forever, 'ALICE'), sv({
        Thrallia: char('Thrallia', { guild: 'Just Now WoW', level: 31, updated: 1794000000, recipes: { Tailoring: [{ id: 1, name: 'Linen Bolt' }] } }),
        Altie: char('Altie', { level: 5, updated: 1794100000 }), // newest, but in no guild
      }, { roster: { members: [{ name: 'Grom' }] } })),
      foreverBob: write(file(forever, 'BOB'), sv({
        Grommash: char('Grommash', { guild: 'Old Guild', class: 'SHAMAN', level: 60, updated: 1793000000 }),
      })),
      retailAlice: write(file(retail, 'ALICE'), sv({
        Velanne: char('Velanne', { realm: 'Silvermoon', guild: 'Retail Raiders', faction: 'Alliance', class: 'PRIEST', level: 80, updated: 1794050000 }),
      })),
    };
    return { root, forever, retail, files };
  }

  test('reads every saved character from every install, newest first, and picks the newest guild', () => {
    const { root, forever, retail } = tree();
    const found = wow.detectGuild({ extraRoots: [root], scanDefaults: false });
    assert.deepEqual(found.characters.map((c) => c.name), ['Altie', 'Velanne', 'Thrallia', 'Grommash']);
    assert.deepEqual(found.guild, { name: 'Retail Raiders', realm: 'Silvermoon', faction: 'Alliance' },
      'the most recently updated character that has a guild');
    const thrallia = found.characters.find((c) => c.name === 'Thrallia');
    assert.deepEqual(thrallia, {
      name: 'Thrallia', realm: 'Forever', guild: 'Just Now WoW', faction: 'Horde', level: 31, class: 'WARRIOR',
      updated: 1794000000, install: forever, account: 'ALICE',
    }, 'only the fields the server needs, plus where it was found');
    const velanne = found.characters.find((c) => c.name === 'Velanne');
    assert.equal(velanne.install, retail);
    assert.equal(velanne.account, 'ALICE');
    assert.equal(found.characters.find((c) => c.name === 'Grommash').account, 'BOB');
    assert.equal(found.characters.find((c) => c.name === 'Altie').guild, null);
  });

  test('never changes the saved data files', () => {
    const { root, files } = tree();
    const before = Object.values(files).map((f) => ({ f, text: fs.readFileSync(f, 'utf8'), mtime: fs.statSync(f).mtimeMs }));
    const dirsBefore = fs.readdirSync(path.dirname(files.foreverAlice)).sort();
    wow.detectGuild({ extraRoots: [root], scanDefaults: false });
    wow.detectGuild({ extraRoots: [root], scanDefaults: false });
    for (const b of before) {
      assert.equal(fs.readFileSync(b.f, 'utf8'), b.text, b.f);
      assert.equal(fs.statSync(b.f).mtimeMs, b.mtime, b.f);
    }
    assert.deepEqual(fs.readdirSync(path.dirname(files.foreverAlice)).sort(), dirsBefore, 'no temp or backup files');
  });

  test('a newer save is read again; the same character in two places counts once (newest wins)', () => {
    const { root, files, forever } = tree();
    assert.equal(wow.detectGuild({ extraRoots: [root], scanDefaults: false }).guild.name, 'Retail Raiders');
    // Thrallia logs in again: now she is the newest character with a guild.
    write(files.foreverAlice, sv({ Thrallia: char('Thrallia', { guild: 'Just Now WoW', level: 32, updated: 1794200000 }) }));
    const t = new Date(Date.UTC(2031, 0, 1));
    fs.utimesSync(files.foreverAlice, t, t);
    // A copy of the same character with an older record in another account.
    write(path.join(forever, 'WTF', 'Account', 'COPY', 'SavedVariables', 'WowGuild.lua'),
      sv({ Thrallia: char('Thrallia', { guild: 'Old Guild', level: 10, updated: 1700000000 }) }));
    const found = wow.detectGuild({ extraRoots: [root], scanDefaults: false });
    assert.deepEqual(found.guild, { name: 'Just Now WoW', realm: 'Forever', faction: 'Horde' });
    const thrallias = found.characters.filter((c) => c.name === 'Thrallia');
    assert.equal(thrallias.length, 1);
    assert.equal(thrallias[0].level, 32);
    assert.equal(thrallias[0].account, 'ALICE');
  });

  test('broken, empty or odd saved data is skipped, never thrown', () => {
    const root = mk(tmp, 'WoW');
    const dir = gameFolder(root, '_forever_', { accounts: [] });
    const file = (acc) => path.join(dir, 'WTF', 'Account', acc, 'SavedVariables', 'WowGuild.lua');
    write(file('HALF'), 'WowGuildDB = { ["characters"] = { ["Thr');
    write(file('EMPTY'), 'WowGuildDB = {}\n');
    write(file('NONE'), '');
    write(file('ODD'), sv({ '': { level: 3 }, Weird: 'not a table', NoName: { level: 'x', guild: '  ', updated: 'soon' } }));
    const found = wow.detectGuild({ extraRoots: [root], scanDefaults: false });
    assert.deepEqual(found.characters.map((c) => [c.name, c.level, c.guild, c.updated]), [['NoName', null, null, null]], 'the table key names a character');
    assert.equal(found.guild, null);
    assert.deepEqual(wow.detectGuild({ extraRoots: [path.join(tmp, 'missing')], scanDefaults: false }), { characters: [], guild: null });
    assert.deepEqual(wow.detectGuild({ installs: [], scanDefaults: false }), { characters: [], guild: null });
  });

  test('readCharacters accepts a list as well as a name table', () => {
    assert.deepEqual(wow.readCharacters({ characters: [{ name: 'A', level: 7.9 }] }).map((c) => [c.name, c.level]), [['A', 7]]);
    assert.deepEqual(wow.readCharacters(null), []);
    assert.deepEqual(wow.readCharacters({ characters: 'x' }), []);
  });
});

describe('helpers', () => {
  test('flavor labels', () => {
    assert.equal(flavorLabel('_forever_'), 'WoW Forever');
    assert.equal(flavorLabel('_retail_'), 'Retail');
    assert.equal(flavorLabel('_classic_era_'), 'Classic Era');
    assert.equal(flavorLabel('_classic_'), 'Classic');
    assert.equal(flavorLabel('_ptr_'), 'PTR');
    assert.equal(flavorLabel('_beta_'), 'Beta');
    assert.equal(flavorLabel('_FOREVER_'), 'WoW Forever', 'case does not matter');
    assert.equal(flavorLabel('_classic_ptr_'), 'Classic PTR');
    assert.equal(flavorLabel('_classic_era_ptr_'), 'Classic Era PTR');
    assert.equal(flavorLabel('_anniversary_'), 'Anniversary');
    assert.equal(flavorLabel(null), 'World of Warcraft');
    assert.equal(flavorLabel('__'), 'World of Warcraft');
    assert.deepEqual(wow.FLAVOR_LABELS._forever_, 'WoW Forever');
  });

  test('savedVariablesFiles only lists WowGuild.lua account files', () => {
    const game = gameFolder(mk(tmp, 'g'), null, { accounts: ['B', 'A'] });
    mk(game, 'WTF', 'Account', 'EMPTY', 'SavedVariables'); // account without our file
    write(path.join(game, 'WTF', 'Account', 'A', 'SavedVariables', 'Auctionator.lua'), 'x');
    write(path.join(game, 'WTF', 'Account', 'A', 'SavedVariables', 'WowGuild.lua.bak'), 'x');
    write(path.join(game, 'WTF', 'Account', 'SavedVariables', 'WowGuild.lua'), 'x'); // not an account
    write(path.join(game, 'WTF', 'Account', 'A', 'Realm', 'Char', 'SavedVariables', 'WowGuild.lua'), 'x'); // per character
    const files = savedVariablesFiles(game);
    assert.deepEqual(files.map(accountName), ['A', 'B']);
    assert.deepEqual(savedVariablesFiles(path.join(tmp, 'nope')), []);
    assert.deepEqual(savedVariablesFiles(null), []);
  });

  test('normaliseRoot walks up from folders inside the game folder', () => {
    const g = path.resolve(tmp, '_forever_');
    assert.equal(normaliseRoot(path.join(g, 'Interface', 'AddOns', 'WowGuild')), g);
    assert.equal(normaliseRoot(path.join(g, 'Interface', 'AddOns')), g);
    assert.equal(normaliseRoot(path.join(g, 'interface')), g);
    assert.equal(normaliseRoot(path.join(g, 'WTF')), g);
    assert.equal(normaliseRoot(g), g);
    assert.equal(normaliseRoot(path.join(tmp, 'AddOns')), path.resolve(tmp, 'AddOns'), 'AddOns alone is left alone');
  });

  test('default roots cover the old companion list and drives C: to H: that exist', () => {
    const drives = new Set(['C:\\', 'D:\\', 'G:\\']);
    const roots = defaultRoots({ platform: 'win32', exists: (d) => drives.has(d) });
    for (const old of ['C:\\Program Files (x86)\\World of Warcraft', 'C:\\Program Files\\World of Warcraft',
      'D:\\World of Warcraft', 'D:\\Games\\World of Warcraft']) assert.ok(roots.includes(old), old);
    for (const extra of ['G:\\Battle.net\\World of Warcraft', 'C:\\World of Warcraft', 'D:\\Program Files (x86)\\World of Warcraft']) {
      assert.ok(roots.includes(extra), extra);
    }
    assert.ok(!roots.some((r) => r.startsWith('E:') || r.startsWith('F:') || r.startsWith('H:')), 'missing drives are skipped');
    assert.equal(roots.length, 15);

    assert.ok(defaultRoots({ platform: 'darwin', home: '/Users/me' }).includes('/Applications/World of Warcraft'));
    const linux = defaultRoots({ platform: 'linux', home: '/home/me' });
    assert.ok(linux.some((r) => r.includes('drive_c')), 'Wine prefixes on Linux');
  });

  test('isWowRunning reads the process list and never throws', async () => {
    const tasklist = async (cmd, args) => {
      assert.equal(cmd, 'tasklist');
      assert.deepEqual(args, ['/FO', 'CSV', '/NH']);
      return '"explorer.exe","1","Console","1","90,000 K"\r\n"WowClassic.exe","2","Console","1","2,000,000 K"\r\n';
    };
    assert.equal(await isWowRunning({ platform: 'win32', exec: tasklist }), true);
    // Addon managers with "Wow" in their name are not the game.
    const managers = async () => '"WowUp.exe","3","Console","1","1 K"\r\n"Guild Camp.exe","4","Console","1","1 K"\r\n';
    assert.equal(await isWowRunning({ platform: 'win32', exec: managers }), false);
    assert.equal(await isWowRunning({ platform: 'darwin', exec: async () => '/sbin/launchd\n/Applications/World of Warcraft/_retail_/World of Warcraft\n' }), true);
    assert.equal(await isWowRunning({ platform: 'linux', exec: async () => 'bash\nWow.exe\n' }), true);
    assert.equal(await isWowRunning({ platform: 'linux', exec: async () => 'bash\nnode\n' }), false);
    assert.equal(await isWowRunning({ platform: 'win32', exec: async () => { throw new Error('no tasklist'); } }), null);
  });
});
