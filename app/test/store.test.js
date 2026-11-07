'use strict';
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createStore, sanitizeSettingsPatch, normaliseServerUrl, writeFileAtomic, DEFAULTS } = require('../src/main/store');

// Stand-in for safeStorage: reversible, but clearly not plain text on disk.
const fakeCrypto = {
  encrypt: (text) => Buffer.from(`ENC:${Buffer.from(text, 'utf8').toString('hex')}`),
  decrypt: (buf) => {
    const s = buf.toString();
    if (!s.startsWith('ENC:')) throw new Error('bad ciphertext');
    return Buffer.from(s.slice(4), 'hex').toString('utf8');
  },
};

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-store-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('settings', () => {
  test('starts from the documented defaults', () => {
    const store = createStore(dir);
    assert.deepEqual(store.get(), { ...DEFAULTS, extraWowFolders: [] });
    assert.equal(store.get().serverUrl, 'https://wow.cjplumbing.co.za');
    assert.equal(store.get().syncEnabled, true);
    assert.equal(store.get().repoDir, null);
    assert.equal(fs.existsSync(path.join(dir, 'settings.json')), false, 'nothing written until something changes');
  });

  test('automatic setup defaults: addon installs on, start with Windows off until the first sign-in', () => {
    const store = createStore(dir);
    assert.equal(store.get().addonAutoInstall, true);
    assert.equal(store.get().startWithWindows, false, 'main.js turns it on once, on the first sign-in of an installed app');
    assert.equal(store.get().startupDefaulted, false);
    assert.deepEqual(store.get().addonOptOut, []);
    // Settings files from before these keys existed get the defaults.
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ startWithWindows: true, addonAutoUpdate: false }));
    const old = createStore(dir);
    assert.equal(old.get().addonAutoInstall, true);
    assert.equal(old.get().startupDefaulted, false);
    assert.equal(old.get().startWithWindows, true);
  });

  test('set() merges shallowly, persists and emits change with the changed keys', () => {
    const store = createStore(dir);
    const seen = [];
    store.on('change', (settings, keys) => seen.push({ settings, keys }));
    const out = store.set({ theme: 'dark', notifications: false });
    assert.equal(out.theme, 'dark');
    assert.equal(out.notifications, false);
    assert.equal(out.syncEnabled, true, 'other keys keep their values');
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0].keys.sort(), ['notifications', 'theme']);

    const again = createStore(dir);
    assert.equal(again.get().theme, 'dark');
    assert.equal(again.get().notifications, false);
  });

  test('set() with nothing new does not write or emit', () => {
    const store = createStore(dir);
    let count = 0;
    store.on('change', () => count++);
    store.set({ theme: 'system', closeToTray: true, junk: undefined });
    assert.equal(count, 0);
    assert.equal(fs.existsSync(path.join(dir, 'settings.json')), false);
  });

  test('get() returns a copy that callers cannot use to change the store', () => {
    const store = createStore(dir);
    const s = store.get();
    s.extraWowFolders.push('X:\\nope');
    s.theme = 'dark';
    assert.deepEqual(store.get().extraWowFolders, []);
    assert.equal(store.get().theme, 'system');
  });

  test('writes atomically: no temp files are left behind and the file is valid JSON', () => {
    const store = createStore(dir);
    for (let i = 0; i < 20; i++) store.set({ lastEventId: i + 1 });
    const files = fs.readdirSync(dir);
    assert.deepEqual(files, ['settings.json']);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).lastEventId, 20);
  });

  test('writeFileAtomic replaces an existing file in one step', () => {
    const file = path.join(dir, 'x.json');
    fs.writeFileSync(file, 'old');
    writeFileAtomic(file, 'new');
    assert.equal(fs.readFileSync(file, 'utf8'), 'new');
    assert.deepEqual(fs.readdirSync(dir), ['x.json']);
  });

  test('a corrupted settings file is backed up and defaults are used', () => {
    fs.writeFileSync(path.join(dir, 'settings.json'), '{ "theme": "dark", oops');
    const store = createStore(dir);
    assert.equal(store.get().theme, 'system');
    assert.equal(store.problems.length, 1);
    assert.match(store.problems[0], /unreadable/);
    const backups = fs.readdirSync(dir).filter((f) => f.startsWith('settings.json.corrupt-'));
    assert.equal(backups.length, 1);
    assert.equal(fs.readFileSync(path.join(dir, backups[0]), 'utf8'), '{ "theme": "dark", oops');
    store.set({ theme: 'light' });
    assert.equal(createStore(dir).get().theme, 'light');
  });

  test('a settings file that is JSON but not an object is treated as corrupt', () => {
    fs.writeFileSync(path.join(dir, 'settings.json'), '[1,2,3]');
    const store = createStore(dir);
    assert.equal(store.get().theme, 'system');
    assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('settings.json.corrupt-')));
  });

  test('unknown keys in the file are dropped and missing keys get defaults', () => {
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ theme: 'dark', bogus: 1 }));
    const store = createStore(dir);
    assert.equal(store.get().theme, 'dark');
    assert.equal(store.get().bogus, undefined);
    assert.equal(store.get().closeToTray, true);
  });

  test('a UTF-8 BOM (Notepad) does not break the file', () => {
    fs.writeFileSync(path.join(dir, 'settings.json'), `\uFEFF${JSON.stringify({ theme: 'light' })}`);
    assert.equal(createStore(dir).get().theme, 'light');
  });
});

describe('secrets', () => {
  test('are encrypted on disk with the injected functions and read back', () => {
    const store = createStore(dir, fakeCrypto);
    assert.equal(store.getSecret('deviceToken'), null);
    store.setSecret('deviceToken', 'gcd_abcdefghijklmnop');
    assert.equal(store.getSecret('deviceToken'), 'gcd_abcdefghijklmnop');
    const raw = fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8');
    assert.ok(!raw.includes('gcd_abcdefghijklmnop'), 'token must not be stored in plain text');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.deviceToken.e, 1);
    assert.equal(Buffer.from(parsed.deviceToken.v, 'base64').toString().slice(0, 4), 'ENC:');
    assert.equal(store.secretsEncrypted(), true);
    assert.equal(store.secretWarning, null);

    const again = createStore(dir, fakeCrypto);
    assert.equal(again.getSecret('deviceToken'), 'gcd_abcdefghijklmnop');
  });

  test('setSecret(name, null) removes it', () => {
    const store = createStore(dir, fakeCrypto);
    store.setSecret('deviceToken', 'gcd_abcdefghijklmnop');
    store.setSecret('deviceToken', null);
    assert.equal(store.getSecret('deviceToken'), null);
    assert.equal(createStore(dir, fakeCrypto).getSecret('deviceToken'), null);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8')), {});
  });

  test('falls back to plain text with a warning when encryption is unavailable', () => {
    const store = createStore(dir, { ...fakeCrypto, isEncryptionAvailable: () => false });
    store.setSecret('deviceToken', 'gcd_plainplainplain');
    assert.equal(store.getSecret('deviceToken'), 'gcd_plainplainplain');
    assert.match(store.secretWarning, /without encryption/);
    assert.equal(store.secretsEncrypted(), false);
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8'));
    assert.deepEqual(parsed.deviceToken, { e: 0, v: 'gcd_plainplainplain' });
    assert.equal(createStore(dir).getSecret('deviceToken'), 'gcd_plainplainplain');
  });

  test('falls back to plain text when encrypt() throws', () => {
    const store = createStore(dir, { encrypt: () => { throw new Error('no keyring'); }, decrypt: fakeCrypto.decrypt });
    store.setSecret('deviceToken', 'gcd_throwsthrows');
    assert.equal(store.getSecret('deviceToken'), 'gcd_throwsthrows');
    assert.ok(store.secretWarning);
  });

  test('a secret that cannot be decrypted reads as missing and is reported', () => {
    createStore(dir, fakeCrypto).setSecret('deviceToken', 'gcd_abcdefghijklmnop');
    const other = createStore(dir, { encrypt: fakeCrypto.encrypt, decrypt: () => { throw new Error('wrong user'); } });
    assert.equal(other.getSecret('deviceToken'), null);
    assert.ok(other.problems.some((p) => /could not be decrypted/.test(p)));
  });

  test('a corrupted secrets file means signed out, not a crash', () => {
    fs.writeFileSync(path.join(dir, 'secrets.json'), 'garbage');
    const store = createStore(dir, fakeCrypto);
    assert.equal(store.getSecret('deviceToken'), null);
    assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('secrets.json.corrupt-')));
    store.setSecret('deviceToken', 'gcd_abcdefghijklmnop');
    assert.equal(createStore(dir, fakeCrypto).getSecret('deviceToken'), 'gcd_abcdefghijklmnop');
  });

  test('several secrets live side by side', () => {
    const store = createStore(dir, fakeCrypto);
    store.setSecret('deviceToken', 'gcd_abcdefghijklmnop');
    store.setSecret('me', JSON.stringify({ user: { battletag: 'A#1' } }));
    const again = createStore(dir, fakeCrypto);
    assert.equal(again.getSecret('deviceToken'), 'gcd_abcdefghijklmnop');
    assert.equal(JSON.parse(again.getSecret('me')).user.battletag, 'A#1');
  });
});

describe('sanitizeSettingsPatch (settings from the renderer)', () => {
  test('accepts valid values and normalises the server address', () => {
    const out = sanitizeSettingsPatch({ serverUrl: ' https://Guild.Example.com/ ', theme: 'dark', syncEnabled: false, repoDir: null });
    assert.deepEqual(out, { serverUrl: 'https://guild.example.com', theme: 'dark', syncEnabled: false, repoDir: null });
  });

  test('drops internal keys silently', () => {
    assert.deepEqual(sanitizeSettingsPatch({ lastEventId: 99, windowBounds: { x: 1 }, onboarded: true }), { onboarded: true });
    assert.deepEqual(sanitizeSettingsPatch({ startupDefaulted: true, addonOptOut: ['C:\\WoW'], addonAutoInstall: false }), { addonAutoInstall: false });
    assert.throws(() => sanitizeSettingsPatch({ addonAutoInstall: 1 }), /on or off/);
  });

  test('rejects unknown keys and wrong types with plain messages', () => {
    assert.throws(() => sanitizeSettingsPatch({ nope: 1 }), /not a setting/);
    assert.throws(() => sanitizeSettingsPatch({ syncEnabled: 'yes' }), /on or off/);
    assert.throws(() => sanitizeSettingsPatch({ theme: 'neon' }), /system, light or dark/);
    assert.throws(() => sanitizeSettingsPatch({ repoDir: 'relative/path' }), /full folder path/);
    assert.throws(() => sanitizeSettingsPatch(null), /object/);
    assert.throws(() => sanitizeSettingsPatch([1]), /object/);
  });

  test('server address rules', () => {
    assert.equal(normaliseServerUrl('guild.example.com'), 'https://guild.example.com');
    assert.equal(normaliseServerUrl('http://localhost:3000/'), 'http://localhost:3000');
    assert.equal(normaliseServerUrl('http://192.168.1.20:3000'), 'http://192.168.1.20:3000');
    assert.equal(normaliseServerUrl('https://example.com/guild/'), 'https://example.com/guild');
    assert.throws(() => normaliseServerUrl('http://guild.example.com'), /https/);
    assert.throws(() => normaliseServerUrl('ftp://x.com'), /https/);
    assert.throws(() => normaliseServerUrl('https://user:pw@x.com'), /user name/);
    assert.throws(() => normaliseServerUrl(''), /Enter the guild server/);
  });

  test('cleans the extra game folder list', () => {
    const abs = path.resolve(os.tmpdir(), 'Games', 'World of Warcraft');
    const out = sanitizeSettingsPatch({ extraWowFolders: [abs, abs, '  ', 42] });
    assert.deepEqual(out.extraWowFolders, [abs]);
    assert.throws(() => sanitizeSettingsPatch({ extraWowFolders: ['relative'] }), /full folder path/);
    assert.throws(() => sanitizeSettingsPatch({ extraWowFolders: 'C:\\x' }), /list/);
  });
});
