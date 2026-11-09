// The companion installs and updates the addon by itself.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path'); const http = require('http'); const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { ensureAddon, installedVersion, findInstalls } = require('../../companion/companion');

function addonZip(version) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-'));
  fs.mkdirSync(path.join(dir, 'WowGuild', 'Data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'WowGuild', 'WowGuild.toc'), `## Interface: 16001\n## Version: ${version}\nCore.lua\n`);
  fs.writeFileSync(path.join(dir, 'WowGuild', 'Core.lua'), `-- core ${version}\n`.repeat(50));
  fs.writeFileSync(path.join(dir, 'WowGuild', 'Data', 'Inbox.lua'), 'WowGuildInbox = nil\n');
  execFileSync('zip', ['-9', '-q', '-r', path.join(dir, 'WowGuild.zip'), 'WowGuild'], { cwd: dir });
  return fs.readFileSync(path.join(dir, 'WowGuild.zip'));
}

test('companion installs the addon into Forever, updates older copies, keeps guild news', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'World of Warcraft-'));
  fs.mkdirSync(path.join(root, '_forever_', 'WTF'), { recursive: true });
  fs.mkdirSync(path.join(root, '_classic_', 'WTF'), { recursive: true });
  const retailAddon = path.join(root, '_retail_', 'Interface', 'AddOns', 'WowGuild');
  fs.mkdirSync(path.join(retailAddon, 'Data'), { recursive: true });
  fs.writeFileSync(path.join(retailAddon, 'WowGuild.toc'), '## Version: 0.5.0\n');
  fs.writeFileSync(path.join(retailAddon, 'Data', 'Inbox.lua'), 'WowGuildInbox = { guild = "kept" }\n');

  let zip = addonZip('0.9.0'); let sha = crypto.createHash('sha256').update(zip).digest('hex');
  let downloads = 0;
  const srv = http.createServer((req, res) => {
    if (req.url === '/api/addon') return res.end(JSON.stringify({ version: '0.9.0', sha256: sha, url: '/downloads/WowGuild.zip' }));
    if (req.url === '/downloads/WowGuild.zip') { downloads += 1; return res.end(zip); }
    res.statusCode = 404; res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const cfg = { siteUrl: `http://127.0.0.1:${srv.address().port}`, wowFolder: root };
  try {
    assert.ok(findInstalls(cfg).some((g) => g.endsWith('_forever_')));
    const done = await ensureAddon(cfg);
    assert.deepStrictEqual(done.map((d) => [path.basename(d.game), d.from, d.to]).sort(), [['_forever_', null, '0.9.0'], ['_retail_', '0.5.0', '0.9.0']]);
    assert.strictEqual(installedVersion(path.join(root, '_forever_')), '0.9.0');
    assert.strictEqual(installedVersion(path.join(root, '_retail_')), '0.9.0');
    assert.strictEqual(installedVersion(path.join(root, '_classic_')), null, 'other game versions are left alone');
    assert.match(fs.readFileSync(path.join(retailAddon, 'Data', 'Inbox.lua'), 'utf8'), /kept/, 'guild news already there is kept');
    assert.match(fs.readFileSync(path.join(root, '_forever_', 'Interface', 'AddOns', 'WowGuild', 'Core.lua'), 'utf8'), /core 0\.9\.0/);
    assert.strictEqual(downloads, 1, 'one download for all folders');
    assert.deepStrictEqual(await ensureAddon(cfg), [], 'nothing to do when up to date');
    assert.deepStrictEqual(await ensureAddon({ ...cfg, autoUpdateAddon: false }), []);

    // A damaged download is refused and nothing is written.
    zip = addonZip('1.0.0'); sha = 'bad';
    srv.removeAllListeners('request');
    srv.on('request', (req, res) => {
      if (req.url === '/api/addon') return res.end(JSON.stringify({ version: '1.0.0', sha256: sha, url: '/downloads/WowGuild.zip' }));
      res.end(zip);
    });
    await assert.rejects(ensureAddon(cfg), /damaged/);
    assert.strictEqual(installedVersion(path.join(root, '_forever_')), '0.9.0');
  } finally { srv.close(); }
});
