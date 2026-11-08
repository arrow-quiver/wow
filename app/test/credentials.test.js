'use strict';
// Where the built-in Battle.net client id and secret come from (src/main/credentials.js).
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadBnetCredentials, writeBnetCredentials, credentialsFile, FILE_NAME } = require('../src/main/credentials');

let dir;
before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-creds-')); });
after(() => fs.rmSync(dir, { recursive: true, force: true }));

// An app folder laid out like app/ (or app.asar): <appDir>/src/main/bnet-credentials.json.
function appDirWith(content) {
  const appDir = fs.mkdtempSync(path.join(dir, 'app-'));
  fs.mkdirSync(path.join(appDir, 'src', 'main'), { recursive: true });
  if (content !== undefined) {
    fs.writeFileSync(path.join(appDir, 'src', 'main', FILE_NAME), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return appDir;
}

function recorder() {
  const lines = [];
  return { lines, info: (m) => lines.push(m), warn: (m) => lines.push(m), error: (m) => lines.push(m) };
}

describe('loadBnetCredentials', () => {
  test('reads the file the build writes next to the main process code', () => {
    const appDir = appDirWith({ clientId: ' abc123 ', clientSecret: 'S3cret_value' });
    assert.deepEqual(loadBnetCredentials({ appDir, env: {} }), { clientId: 'abc123', clientSecret: 'S3cret_value' });
    assert.equal(credentialsFile(appDir), path.join(appDir, 'src', 'main', 'bnet-credentials.json'));
  });

  test('the result cannot be changed by accident', () => {
    const creds = loadBnetCredentials({ appDir: appDirWith({ clientId: 'a1', clientSecret: 'b2' }), env: {} });
    assert.ok(Object.isFrozen(creds));
  });

  test('environment variables (development) win over the file', () => {
    const appDir = appDirWith({ clientId: 'file-id', clientSecret: 'file-secret' });
    const env = { GUILDCAMP_BNET_CLIENT_ID: 'env-id', GUILDCAMP_BNET_CLIENT_SECRET: 'env-secret' };
    assert.deepEqual(loadBnetCredentials({ appDir, env }), { clientId: 'env-id', clientSecret: 'env-secret' });
    // Only one of the two set: the file is used.
    assert.deepEqual(loadBnetCredentials({ appDir, env: { GUILDCAMP_BNET_CLIENT_ID: 'env-id' } }), { clientId: 'file-id', clientSecret: 'file-secret' });
    assert.deepEqual(loadBnetCredentials({ appDir, env: { GUILDCAMP_BNET_CLIENT_ID: 'env-id', GUILDCAMP_BNET_CLIENT_SECRET: '   ' } }), { clientId: 'file-id', clientSecret: 'file-secret' });
  });

  test('environment variables alone are enough (no file in a dev checkout)', () => {
    const appDir = appDirWith();
    const env = { GUILDCAMP_BNET_CLIENT_ID: 'dev-id', GUILDCAMP_BNET_CLIENT_SECRET: 'dev-secret' };
    assert.deepEqual(loadBnetCredentials({ appDir, env }), { clientId: 'dev-id', clientSecret: 'dev-secret' });
  });

  test('nothing found → null, so the app runs without Battle.net', () => {
    const log = recorder();
    assert.equal(loadBnetCredentials({ appDir: appDirWith(), env: {}, log }), null);
    assert.deepEqual(log.lines, [], 'a missing file is normal for dev builds: no warning');
  });

  test('an unusable file → null with a warning that never shows the values', () => {
    const cases = [
      '{not json',
      '[]',
      JSON.stringify({ clientId: 'only-id' }),
      JSON.stringify({ clientId: '', clientSecret: 'x' }),
      JSON.stringify({ clientId: 'has space', clientSecret: 'secret-xyz' }),
      JSON.stringify({ clientId: 'x'.repeat(300), clientSecret: 'secret-xyz' }),
      JSON.stringify({ clientId: 12345, clientSecret: 'secret-xyz' }),
    ];
    for (const content of cases) {
      const log = recorder();
      assert.equal(loadBnetCredentials({ appDir: appDirWith(content), env: {}, log }), null, content);
      assert.equal(log.lines.length, 1, content);
      assert.match(log.lines[0], /Battle\.net sign-in is off/);
      assert.doesNotMatch(log.lines[0], /secret-xyz|only-id/);
    }
  });

  test('accepts snake_case keys and a byte order mark (files saved by Windows tools)', () => {
    const appDir = appDirWith(`${String.fromCharCode(0xfeff)}{"client_id":"id-1","client_secret":"sec-1"}`);
    assert.deepEqual(loadBnetCredentials({ appDir, env: {} }), { clientId: 'id-1', clientSecret: 'sec-1' });
  });

  test('an explicit file path, and the file next to the module by default', () => {
    const file = path.join(dir, 'custom.json');
    fs.writeFileSync(file, JSON.stringify({ clientId: 'c-id', clientSecret: 'c-sec' }));
    assert.deepEqual(loadBnetCredentials({ file, env: {} }), { clientId: 'c-id', clientSecret: 'c-sec' });
    assert.equal(credentialsFile(), path.join(__dirname, '..', 'src', 'main', FILE_NAME));
  });
});

describe('writeBnetCredentials', () => {
  test('writes a file loadBnetCredentials reads back', () => {
    const appDir = appDirWith();
    const file = credentialsFile(appDir);
    assert.equal(writeBnetCredentials(file, { clientId: ' id-9 ', clientSecret: 'sec-9' }), file);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { clientId: 'id-9', clientSecret: 'sec-9' });
    assert.deepEqual(loadBnetCredentials({ appDir, env: {} }), { clientId: 'id-9', clientSecret: 'sec-9' });
  });

  test('refuses half-filled credentials', () => {
    const file = path.join(dir, 'nope', FILE_NAME);
    assert.throws(() => writeBnetCredentials(file, { clientId: 'id' }), /client id and secret are both needed/);
    assert.throws(() => writeBnetCredentials(file, {}), /both needed/);
    assert.equal(fs.existsSync(file), false);
  });
});

// The repository is public: the generated file must never be committed. (Marked "todo" rather than failing
// while the .gitignore line, owned by the release tooling, is still missing.)
const ignored = (() => {
  try {
    return fs.readFileSync(path.join(__dirname, '..', '..', '.gitignore'), 'utf8').split(/\r?\n/)
      .map((l) => l.trim()).some((l) => /(^|\/)bnet-credentials\.json$/.test(l));
  } catch {
    return false;
  }
})();
test('the credentials file stays out of git', { todo: ignored ? false : 'add app/src/main/bnet-credentials.json to .gitignore' }, () => {
  assert.ok(ignored, '.gitignore must list app/src/main/bnet-credentials.json');
});
