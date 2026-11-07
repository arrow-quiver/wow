'use strict';
// App settings (settings.json) and secrets (secrets.json) in the user data folder.
//
//   const store = createStore(userData, { encrypt, decrypt });
//   store.get()                      → copy of the settings (defaults filled in)
//   store.set({ theme: 'dark' })     → shallow merge, atomic write, emits 'change' (settings, changedKeys)
//   store.getSecret('deviceToken')   → string | null
//   store.setSecret('deviceToken', v | null)
//   store.secretsEncrypted()         → false when secrets had to be saved as plain text
//
// Secrets are encrypted with Electron's safeStorage, injected as encrypt(string) → Buffer and
// decrypt(Buffer) → string so this module stays plain Node. When encryption is unavailable
// (some Linux desktops) the value is kept as plain text and store.secretWarning says so.

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const DEFAULTS = Object.freeze({
  serverUrl: 'https://wow.cjplumbing.co.za',
  extraWowFolders: [],
  syncEnabled: true,
  closeToTray: true,
  startWithWindows: false,
  addonAutoUpdate: true,
  addonAutoInstall: true, // put the addon into game folders that don't have it yet (supported game versions only)
  appAutoUpdate: true,
  notifications: true,
  theme: 'system',
  repoDir: null,
  lastEventId: 0,
  windowBounds: null,
  onboarded: false,
  // Set once "start with Windows" has had its default (on the first sign-in of an installed app) or
  // the person chose for themselves, so their choice is never overridden.
  startupDefaulted: false,
  // Game folders where the person removed the addon: automatic installs leave them alone until the
  // addon is installed there again by hand.
  addonOptOut: [],
});

// Keys the app manages itself. The renderer may send them back (e.g. a spread of settings),
// but they are ignored there rather than trusted.
const INTERNAL_KEYS = ['lastEventId', 'windowBounds', 'startupDefaulted', 'addonOptOut'];

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Write to a temp file in the same folder, then rename over the target, so a crash mid-write
// never leaves a half-written settings file. Windows can briefly lock the target (antivirus,
// indexer); retry the rename a few times before falling back to a direct write.
function writeFileAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, text);
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      if (attempt < 5 && (err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES')) {
        sleepSync(20 * (attempt + 1));
        continue;
      }
      try {
        fs.writeFileSync(file, text);
        fs.rmSync(tmp, { force: true });
        return;
      } catch {
        fs.rmSync(tmp, { force: true });
        throw err;
      }
    }
  }
}

// Read a JSON object file. Missing → null. Unreadable or not an object → the file is moved
// aside to "<name>.corrupt-<timestamp>" (so nothing is lost) and null is returned.
function readJsonFile(file, onCorrupt) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    onCorrupt(err);
    return null;
  }
  try {
    const value = JSON.parse(text.replace(/^﻿/, ''));
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    throw new Error('not a JSON object');
  } catch (err) {
    try {
      fs.renameSync(file, `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    } catch { /* leave it; it gets overwritten on the next save */ }
    onCorrupt(err);
    return null;
  }
}

/**
 * @param {string} dir folder for settings.json and secrets.json (created when missing)
 * @param {object} [crypto]
 * @param {(text: string) => Buffer} [crypto.encrypt]
 * @param {(buf: Buffer) => string} [crypto.decrypt]
 * @param {() => boolean} [crypto.isEncryptionAvailable]
 */
function createStore(dir, { encrypt, decrypt, isEncryptionAvailable } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const settingsFile = path.join(dir, 'settings.json');
  const secretsFile = path.join(dir, 'secrets.json');
  const emitter = new EventEmitter();
  emitter.setMaxListeners(50);

  // Problems found while loading, for the caller to log (the store has no logger of its own).
  const problems = [];

  const loaded = readJsonFile(settingsFile, (err) => problems.push(`Settings file was unreadable (${err.message}). Started from defaults; the old file was kept as settings.json.corrupt-*.`));
  let settings = { ...clone(DEFAULTS) };
  if (loaded) {
    for (const key of Object.keys(DEFAULTS)) {
      if (loaded[key] !== undefined) settings[key] = loaded[key];
    }
  }

  let secrets = null; // name → { e: 1, v: base64 } | { e: 0, v: plain }   (loaded lazily)
  const secretCache = new Map(); // decrypted values, so state() calls don't hit safeStorage every time
  const store = emitter;
  store.secretWarning = null;
  store.problems = problems;
  store.file = settingsFile;

  function loadSecrets() {
    if (secrets) return secrets;
    secrets = readJsonFile(secretsFile, (err) => problems.push(`Secrets file was unreadable (${err.message}). You may need to sign in again.`)) || {};
    return secrets;
  }

  function canEncrypt() {
    if (typeof encrypt !== 'function' || typeof decrypt !== 'function') return false;
    if (typeof isEncryptionAvailable === 'function') {
      try { return Boolean(isEncryptionAvailable()); } catch { return false; }
    }
    return true;
  }

  store.get = () => clone(settings);

  store.set = (patch) => {
    if (!patch || typeof patch !== 'object') return store.get();
    const next = { ...settings };
    const changed = [];
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      if (!same(next[key], value)) {
        next[key] = clone(value);
        changed.push(key);
      }
    }
    if (!changed.length) return store.get();
    writeFileAtomic(settingsFile, `${JSON.stringify(next, null, 2)}\n`);
    settings = next;
    emitter.emit('change', store.get(), changed);
    return store.get();
  };

  store.getSecret = (name) => {
    if (secretCache.has(name)) return secretCache.get(name);
    const entry = loadSecrets()[name];
    let value = null;
    if (entry && typeof entry === 'object' && typeof entry.v === 'string') {
      if (entry.e) {
        try {
          value = canEncrypt() ? decrypt(Buffer.from(entry.v, 'base64')) : null;
        } catch {
          value = null; // encrypted on another machine/user, or the OS keyring changed
        }
        if (value === null) problems.push(`The saved "${name}" could not be decrypted on this computer. You may need to sign in again.`);
      } else {
        value = entry.v;
      }
    }
    if (typeof value !== 'string' || !value) value = null;
    secretCache.set(name, value);
    return value;
  };

  store.setSecret = (name, value) => {
    const all = { ...loadSecrets() };
    if (value === null || value === undefined || value === '') {
      delete all[name];
      secretCache.set(name, null);
    } else {
      const text = String(value);
      let entry = null;
      if (canEncrypt()) {
        try {
          entry = { e: 1, v: Buffer.from(encrypt(text)).toString('base64') };
        } catch {
          entry = null;
        }
      }
      if (!entry) {
        entry = { e: 0, v: text };
        store.secretWarning = 'Your sign-in is saved without encryption because this computer has no secure storage available.';
      }
      all[name] = entry;
      secretCache.set(name, text);
    }
    writeFileAtomic(secretsFile, `${JSON.stringify(all, null, 2)}\n`);
    secrets = all;
  };

  store.secretsEncrypted = () => {
    const all = loadSecrets();
    return Object.values(all).every((e) => e && e.e) && !store.secretWarning;
  };

  return store;
}

// ---------------------------------------------------------------------------------------------
// Validation for settings coming from the renderer (settings.set). Throws an Error with a plain
// sentence when a value is not acceptable. Internal keys are dropped silently.

const PRIVATE_HOST = /^(localhost|127(?:\.\d{1,3}){3}|\[?::1\]?|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|[\w-]+(?:\.[\w-]+)*\.(?:local|lan|home|internal|test|localhost))$/i;

function normaliseServerUrl(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text) throw new Error('Enter the guild server address, like https://guild.example.com.');
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    throw new Error("That server address doesn't look right. It should look like https://guild.example.com.");
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('The server address must start with https://.');
  }
  if (url.username || url.password) throw new Error("The server address can't contain a user name or password.");
  if (url.protocol === 'http:' && !PRIVATE_HOST.test(url.hostname)) {
    throw new Error('Use an https:// address. Plain http:// only works for a server on this computer or your home network.');
  }
  const pathname = url.pathname.replace(/\/+$/, '');
  return `${url.protocol}//${url.host}${pathname}`;
}

function cleanFolderList(value) {
  if (!Array.isArray(value)) throw new Error('The game folder list must be a list of folders.');
  const out = [];
  const seen = new Set();
  for (const item of value.slice(0, 20)) {
    if (typeof item !== 'string') continue;
    const dir = item.trim();
    if (!dir || dir.length > 1024) continue;
    if (!path.isAbsolute(dir)) throw new Error(`"${dir}" is not a full folder path.`);
    const resolved = path.resolve(dir);
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(resolved);
  }
  return out;
}

const BOOLEAN_KEYS = ['syncEnabled', 'closeToTray', 'startWithWindows', 'addonAutoUpdate', 'addonAutoInstall', 'appAutoUpdate', 'notifications', 'onboarded'];

function sanitizeSettingsPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Settings must be sent as an object.');
  const out = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || INTERNAL_KEYS.includes(key)) continue;
    if (!Object.prototype.hasOwnProperty.call(DEFAULTS, key)) throw new Error(`"${key}" is not a setting Guild Camp knows about.`);
    if (BOOLEAN_KEYS.includes(key)) {
      if (typeof value !== 'boolean') throw new Error(`"${key}" must be on or off.`);
      out[key] = value;
    } else if (key === 'serverUrl') {
      out.serverUrl = normaliseServerUrl(value);
    } else if (key === 'extraWowFolders') {
      out.extraWowFolders = cleanFolderList(value);
    } else if (key === 'theme') {
      if (!['system', 'light', 'dark'].includes(value)) throw new Error('Theme must be system, light or dark.');
      out.theme = value;
    } else if (key === 'repoDir') {
      if (value === null || value === '') out.repoDir = null;
      else if (typeof value === 'string' && path.isAbsolute(value.trim()) && value.length <= 1024) out.repoDir = path.resolve(value.trim());
      else throw new Error('The source folder must be a full folder path.');
    }
  }
  return out;
}

module.exports = { createStore, sanitizeSettingsPatch, normaliseServerUrl, writeFileAtomic, DEFAULTS, INTERNAL_KEYS };
