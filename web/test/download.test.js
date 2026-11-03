// The addon download served by the site.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const dbm = require('../src/db');
const { createApp, config } = require('../src/server');
const { buildZip, OUT_FILE } = require('../scripts/pack-addon');

test('committed addon zip matches addon/WowGuild (run `npm run pack-addon` if this fails)', () => {
  assert.ok(fs.existsSync(OUT_FILE), 'web/public/downloads/WowGuild.zip is missing');
  assert.ok(buildZip().equals(fs.readFileSync(OUT_FILE)), 'WowGuild.zip is out of date');
});

test('site serves the addon zip without signing in', async () => {
  const app = createApp({ ...config({}), baseUrl: 'http://127.0.0.1' }, dbm.open(':memory:'));
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${srv.address().port}/downloads/WowGuild.zip`);
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type'), /zip/);
    const body = Buffer.from(await res.arrayBuffer());
    assert.strictEqual(body.readUInt32LE(0), 0x04034b50);
    assert.ok(body.includes('WowGuild/WowGuild.toc'));
  } finally { srv.close(); }
});
