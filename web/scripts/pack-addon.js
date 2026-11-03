// Packs addon/WowGuild into web/public/downloads/WowGuild.zip, which the site serves at
// /downloads/WowGuild.zip. Run `npm run pack-addon` after changing the addon.
// The zip is byte-for-byte reproducible (sorted files, fixed timestamps), so a test can
// check the committed copy is up to date.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ADDON_DIR = path.join(__dirname, '..', '..', 'addon', 'WowGuild');
const OUT_FILE = path.join(__dirname, '..', 'public', 'downloads', 'WowGuild.zip');

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function listFiles(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => {
      const full = path.join(dir, e.name);
      return e.isDirectory() ? listFiles(full, base) : [path.relative(base, full).split(path.sep).join('/')];
    })
    .sort();
}

// Minimal zip writer: deflate, no extra fields. DOS date 1980-01-01 00:00.
function buildZip(addonDir = ADDON_DIR) {
  const DOS_TIME = 0, DOS_DATE = (0 << 9) | (1 << 5) | 1;
  const locals = [], centrals = [];
  let offset = 0;
  for (const rel of listFiles(addonDir)) {
    const name = Buffer.from(`WowGuild/${rel}`, 'utf8');
    const data = fs.readFileSync(path.join(addonDir, rel));
    const packed = zlib.deflateRawSync(data, { level: 9 });
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0x0800, 6);      // UTF-8 names
    local.writeUInt16LE(8, 8);           // deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, packed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);        // version made by
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);   // other fields stay 0
    centrals.push(central, name);

    offset += local.length + name.length + packed.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(centrals.length / 2, 8);
  end.writeUInt16LE(centrals.length / 2, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

function addonVersion(addonDir = ADDON_DIR) {
  const toc = fs.readFileSync(path.join(addonDir, 'WowGuild.toc'), 'utf8');
  return (toc.match(/^## Version:\s*(\S+)/m) || [])[1] || '';
}

if (require.main === module) {
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  const zip = buildZip();
  fs.writeFileSync(OUT_FILE, zip);
  console.log(`Wrote ${path.relative(process.cwd(), OUT_FILE)} (WowGuild ${addonVersion()}, ${zip.length} bytes)`);
}

module.exports = { buildZip, addonVersion, OUT_FILE };
