'use strict';
// The Battle.net client id and secret Guild Camp signs in with (auth.js) and reads Blizzard game data with.
//
//   loadBnetCredentials({ appDir, env }) → { clientId, clientSecret } | null
//   writeBnetCredentials(file, { clientId, clientSecret })   (for the build: scripts/release.js, CI)
//
// Where they come from, first match wins:
//   1. The environment variables GUILDCAMP_BNET_CLIENT_ID and GUILDCAMP_BNET_CLIENT_SECRET (development).
//   2. src/main/bnet-credentials.json, written just before electron-builder runs and packed into app.asar:
//      { "clientId": "…", "clientSecret": "…" }. The file is gitignored: the repository is public and must
//      never contain the secret.
//   Neither → null: Guild Camp works without Battle.net (no BattleTag, no character list, no game data).
//
// appDir is app.getAppPath() (the app/ folder in development, resources/app.asar when installed). Without it
// the file next to this module is read, which is the same file.
// Plain Node, no Electron.

const fs = require('fs');
const path = require('path');

const FILE_NAME = 'bnet-credentials.json';
const ENV_ID = 'GUILDCAMP_BNET_CLIENT_ID';
const ENV_SECRET = 'GUILDCAMP_BNET_CLIENT_SECRET';

/** Where the build puts the credentials file. */
function credentialsFile(appDir) {
  return appDir ? path.join(appDir, 'src', 'main', FILE_NAME) : path.join(__dirname, FILE_NAME);
}

// A usable id or secret: text without spaces or control characters, at most 256 characters.
function clean(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  return s && s.length <= 256 && !/[\s\x00-\x1f\x7f]/.test(s) ? s : null;
}

function pair(id, secret) {
  const clientId = clean(id);
  const clientSecret = clean(secret);
  return clientId && clientSecret ? Object.freeze({ clientId, clientSecret }) : null;
}

/**
 * @param {object} [opts]
 * @param {string} [opts.appDir]  app.getAppPath()
 * @param {object} [opts.env]     process.env (default)
 * @param {string} [opts.file]    read this file instead (tests)
 * @param {object} [opts.log]     warns when the file is there but unusable (never logs the values)
 * @returns {{clientId: string, clientSecret: string} | null}
 */
function loadBnetCredentials({ appDir, env = process.env, file, log } = {}) {
  const e = env && typeof env === 'object' ? env : {};
  const fromEnv = pair(e[ENV_ID], e[ENV_SECRET]);
  if (fromEnv) return fromEnv;

  const target = file || credentialsFile(appDir);
  let raw;
  try {
    raw = fs.readFileSync(target, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT' && log) log.warn(`Couldn't read the Battle.net settings file (${err.code || err.message}). Battle.net sign-in is off.`);
    return null;
  }
  let data;
  try {
    data = JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch {
    if (log) log.warn('The Battle.net settings file is not valid JSON. Battle.net sign-in is off.');
    return null;
  }
  const found = data && typeof data === 'object' && !Array.isArray(data)
    ? pair(data.clientId ?? data.client_id, data.clientSecret ?? data.client_secret)
    : null;
  if (!found && log) log.warn('The Battle.net settings file has no usable client id and secret. Battle.net sign-in is off.');
  return found;
}

/**
 * Writes the credentials file for a build. Throws a plain Error when either value is missing or unusable.
 * The caller must make sure the file stays out of git (it is listed in .gitignore).
 */
function writeBnetCredentials(file, { clientId, clientSecret } = {}) {
  const found = pair(clientId, clientSecret);
  if (!found) throw new Error('The Battle.net client id and secret are both needed, without spaces.');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ clientId: found.clientId, clientSecret: found.clientSecret }, null, 2)}\n`, { mode: 0o600 });
  return file;
}

module.exports = { loadBnetCredentials, writeBnetCredentials, credentialsFile, FILE_NAME, ENV_ID, ENV_SECRET };
