// CurseForge release: the zip, game versions and TOC checks done before an upload.
const test = require('node:test');
const assert = require('node:assert');
const { readToc, interfaceToVersion, pickVersion, buildZip } = require('../scripts/curseforge');
const { readEntries } = require('../src/zipkit');

test('interface numbers map to CurseForge game versions', () => {
  assert.deepStrictEqual(interfaceToVersion('16001'), { type: 'forever', name: '1.60.1' });
  assert.deepStrictEqual(interfaceToVersion('120105'), { type: 'retail', name: '12.1.5' });
  assert.deepStrictEqual(interfaceToVersion('11507'), { type: 'classic', name: '1.15.7' });
  assert.throws(() => interfaceToVersion('30403'), /game type/);
});

test('picks the exact game version, or the newest one below it', () => {
  const versions = [
    { id: 1, gameVersionTypeID: 517, name: '12.1.0' }, { id: 2, gameVersionTypeID: 517, name: '12.1.5' },
    { id: 3, gameVersionTypeID: 88568, name: '1.60.0' }, { id: 4, gameVersionTypeID: 88568, name: '1.61.0' },
    { id: 5, gameVersionTypeID: 67408, name: '1.60.1' },
  ];
  assert.deepStrictEqual(pickVersion(versions, { type: 'retail', name: '12.1.5' }), { version: versions[1] });
  const p = pickVersion(versions, { type: 'forever', name: '1.60.1' });
  assert.strictEqual(p.version.id, 3, 'never borrows a version from another game type');
  assert.match(p.warning, /no forever 1\.60\.1/);
  assert.throws(() => pickVersion([], { type: 'forever', name: '1.60.1' }), /no forever/);
});

test('the addon is ready to package: named, versioned, and nothing the companion writes', () => {
  const toc = readToc();
  assert.strictEqual(toc.title, 'Guild Camp');
  assert.match(toc.version, /^\d+\.\d+\.\d+$/);
  assert.deepStrictEqual(toc.interfaces.map((i) => interfaceToVersion(i).type), ['forever', 'retail']);
  const { zip, files } = buildZip();
  const names = readEntries(zip).map((e) => e.name);
  assert.deepStrictEqual(names, files);
  assert.ok(names.includes('WowGuild/WowGuild.toc'));
  assert.ok(names.every((n) => n.startsWith('WowGuild/')), 'one WowGuild folder at the top');
  assert.ok(!names.some((n) => /Inbox/i.test(n)), 'the news file lives in WowGuild_Inbox, outside the package');
});
