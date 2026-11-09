'use strict';
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createStore, sanitizeSettingsPatch, cleanWebhook, writeFileAtomic, DEFAULTS } = require('../src/main/store');

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
    assert.equal('serverUrl' in store.get(), false, 'there is no server');
    assert.equal('lastEventId' in store.get(), false);
    assert.equal(store.get().discordWebhook, null);
    assert.equal(store.get().bnetRegion, 'eu');
    assert.equal(store.get().syncEnabled, true);
    assert.equal(store.get().repoDir, null);
    assert.equal(fs.existsSync(path.join(dir, 'settings.json')), false, 'nothing written until something changes');
  });

  test('automatic setup defaults: addon installs on, start with Windows off until the first launch of an installed app', () => {
    const store = createStore(dir);
    assert.equal(store.get().addonAutoInstall, true);
    assert.equal(store.get().startWithWindows, false, 'main.js turns it on once, at the first launch of an installed app');
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
    for (let i = 0; i < 20; i++) store.set({ windowBounds: { x: i + 1 } });
    const files = fs.readdirSync(dir);
    assert.deepEqual(files, ['settings.json']);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).windowBounds.x, 20);
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

  test("a smoke run's switches (no sync, updates or notifications) are overrides for that run, never saved: the next normal run of the profile keeps them on", () => {
    const { SMOKE_SETTINGS } = require('../src/main/main');
    createStore(dir).set({ theme: 'dark' }); // the profile as the person left it
    const before = fs.readFileSync(path.join(dir, 'settings.json'), 'utf8');

    const smoke = createStore(dir, { overrides: SMOKE_SETTINGS });
    for (const [key, value] of Object.entries(SMOKE_SETTINGS)) assert.equal(smoke.get()[key], value, key);
    assert.equal(smoke.get().theme, 'dark', 'everything else comes from the file');
    assert.equal(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'), before, 'reading does not write');

    // A change to an overridden setting holds for this run only; other changes are saved as usual.
    const seen = [];
    smoke.on('change', (s, keys) => seen.push(keys));
    assert.equal(smoke.set({ syncEnabled: true }).syncEnabled, true);
    assert.deepEqual(seen, [['syncEnabled']]);
    assert.equal(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'), before, 'the overridden setting is not written');
    smoke.set({ theme: 'light', notifications: true });
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
    assert.equal(saved.theme, 'light');

    // The next normal run of this profile.
    const next = createStore(dir).get();
    assert.equal(next.theme, 'light');
    for (const key of Object.keys(SMOKE_SETTINGS)) assert.equal(next[key], true, `${key} is still on`);
  });
});

describe('secrets', () => {
  test('are encrypted on disk with the injected functions and read back', () => {
    const store = createStore(dir, fakeCrypto);
    assert.equal(store.getSecret('bnetToken'), null);
    store.setSecret('bnetToken', 'gcd_abcdefghijklmnop');
    assert.equal(store.getSecret('bnetToken'), 'gcd_abcdefghijklmnop');
    const raw = fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8');
    assert.ok(!raw.includes('gcd_abcdefghijklmnop'), 'token must not be stored in plain text');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.bnetToken.e, 1);
    assert.equal(Buffer.from(parsed.bnetToken.v, 'base64').toString().slice(0, 4), 'ENC:');
    assert.equal(store.secretsEncrypted(), true);
    assert.equal(store.secretWarning, null);

    const again = createStore(dir, fakeCrypto);
    assert.equal(again.getSecret('bnetToken'), 'gcd_abcdefghijklmnop');
  });

  test('setSecret(name, null) removes it', () => {
    const store = createStore(dir, fakeCrypto);
    store.setSecret('bnetToken', 'gcd_abcdefghijklmnop');
    store.setSecret('bnetToken', null);
    assert.equal(store.getSecret('bnetToken'), null);
    assert.equal(createStore(dir, fakeCrypto).getSecret('bnetToken'), null);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8')), {});
  });

  test('falls back to plain text with a warning when encryption is unavailable', () => {
    const store = createStore(dir, { ...fakeCrypto, isEncryptionAvailable: () => false });
    store.setSecret('bnetToken', 'gcd_plainplainplain');
    assert.equal(store.getSecret('bnetToken'), 'gcd_plainplainplain');
    assert.match(store.secretWarning, /without encryption/);
    assert.equal(store.secretsEncrypted(), false);
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8'));
    assert.deepEqual(parsed.bnetToken, { e: 0, v: 'gcd_plainplainplain' });
    assert.equal(createStore(dir).getSecret('bnetToken'), 'gcd_plainplainplain');
  });

  test('falls back to plain text when encrypt() throws', () => {
    const store = createStore(dir, { encrypt: () => { throw new Error('no keyring'); }, decrypt: fakeCrypto.decrypt });
    store.setSecret('bnetToken', 'gcd_throwsthrows');
    assert.equal(store.getSecret('bnetToken'), 'gcd_throwsthrows');
    assert.ok(store.secretWarning);
  });

  test('a secret that cannot be decrypted reads as missing and is reported', () => {
    createStore(dir, fakeCrypto).setSecret('bnetToken', 'gcd_abcdefghijklmnop');
    const other = createStore(dir, { encrypt: fakeCrypto.encrypt, decrypt: () => { throw new Error('wrong user'); } });
    assert.equal(other.getSecret('bnetToken'), null);
    assert.ok(other.problems.some((p) => /could not be decrypted/.test(p)));
  });

  test('a corrupted secrets file means signed out, not a crash', () => {
    fs.writeFileSync(path.join(dir, 'secrets.json'), 'garbage');
    const store = createStore(dir, fakeCrypto);
    assert.equal(store.getSecret('bnetToken'), null);
    assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('secrets.json.corrupt-')));
    store.setSecret('bnetToken', 'gcd_abcdefghijklmnop');
    assert.equal(createStore(dir, fakeCrypto).getSecret('bnetToken'), 'gcd_abcdefghijklmnop');
  });

  test('several secrets live side by side', () => {
    const store = createStore(dir, fakeCrypto);
    store.setSecret('bnetToken', 'gcd_abcdefghijklmnop');
    store.setSecret('me', JSON.stringify({ user: { battletag: 'A#1' } }));
    const again = createStore(dir, fakeCrypto);
    assert.equal(again.getSecret('bnetToken'), 'gcd_abcdefghijklmnop');
    assert.equal(JSON.parse(again.getSecret('me')).user.battletag, 'A#1');
  });
});

describe('sanitizeSettingsPatch (settings from the renderer)', () => {
  test('accepts valid values: theme, sync, the Discord webhook and the Battle.net region', () => {
    const out = sanitizeSettingsPatch({ theme: 'dark', syncEnabled: false, repoDir: null, discordWebhook: ' https://discord.com/api/webhooks/1/abc ', bnetRegion: 'US' });
    assert.deepEqual(out, { theme: 'dark', syncEnabled: false, repoDir: null, discordWebhook: 'https://discord.com/api/webhooks/1/abc', bnetRegion: 'us' });
    assert.deepEqual(sanitizeSettingsPatch({ discordWebhook: '' }), { discordWebhook: null }, 'empty removes it');
    assert.deepEqual(sanitizeSettingsPatch({ discordWebhook: null }), { discordWebhook: null });
  });

  test('the server address is gone: an old page sending it gets a plain error', () => {
    assert.throws(() => sanitizeSettingsPatch({ serverUrl: 'https://guild.example.com' }), /"serverUrl" is not a setting Guild Camp knows about/);
    assert.throws(() => sanitizeSettingsPatch({ lastEventId: 3 }), /not a setting/);
  });

  test('drops internal keys silently', () => {
    assert.deepEqual(sanitizeSettingsPatch({ windowBounds: { x: 1 }, onboarded: true }), { onboarded: true });
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

  test('Discord webhook and region rules', () => {
    assert.equal(cleanWebhook('https://discordapp.com/api/webhooks/123/x-y_z'), 'https://discordapp.com/api/webhooks/123/x-y_z');
    for (const bad of ['http://discord.com/api/webhooks/1/a', 'https://example.com/api/webhooks/1/a', 'https://discord.com/channels/1', 'https://discord.com/api/webhooks/' + 'a'.repeat(300)]) {
      assert.throws(() => cleanWebhook(bad), /isn't a Discord webhook address/, bad);
    }
    assert.throws(() => cleanWebhook(42), /web address/);
    assert.throws(() => sanitizeSettingsPatch({ bnetRegion: 'cn' }), /Battle\.net region/);
    assert.throws(() => sanitizeSettingsPatch({ bnetRegion: 1 }), /Battle\.net region/);
  });

  test('overlay and live link settings', () => {
    assert.deepEqual(sanitizeSettingsPatch({ overlayEnabled: false, liveLink: true, overlayOpacity: 0.8, overlayHotkey: 'CommandOrControl+Shift+G' }),
      { overlayEnabled: false, liveLink: true, overlayOpacity: 0.8, overlayHotkey: 'CommandOrControl+Shift+G' });
    assert.deepEqual(sanitizeSettingsPatch({ overlayBounds: { x: 1 } }), {}, 'bounds are internal');
    assert.throws(() => sanitizeSettingsPatch({ overlayOpacity: 0.1 }));
    assert.throws(() => sanitizeSettingsPatch({ overlayHotkey: 'rm -rf' }));
    assert.throws(() => sanitizeSettingsPatch({ liveLink: 'yes' }), /on or off/);
  });

  test('cleans the extra game folder list', () => {
    const abs = path.resolve(os.tmpdir(), 'Games', 'World of Warcraft');
    const out = sanitizeSettingsPatch({ extraWowFolders: [abs, abs, '  ', 42] });
    assert.deepEqual(out.extraWowFolders, [abs]);
    assert.throws(() => sanitizeSettingsPatch({ extraWowFolders: ['relative'] }), /full folder path/);
    assert.throws(() => sanitizeSettingsPatch({ extraWowFolders: 'C:\\x' }), /list/);
  });
});
