'use strict';
// Small, dependency-free zip reader and writer (node:zlib only).
//
// Writing: deflate each file, or store it when deflate doesn't make it smaller.
// Reading: walks the central directory (the zip's table of contents at the end), so files
// written with data descriptors (sizes after the data) read fine. Supports "store" and
// "deflate", which is what every common tool (Explorer, PowerShell, 7-Zip, Info-ZIP, CurseForge)
// writes. Password-protected, ZIP64 and multi-part zips are refused with a clear message.
// Extracting is zip-slip safe: names that would land outside the target folder are refused
// before anything is written.
// Zero dependencies: shared by the app, the server and the release scripts.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const FLAG_ENCRYPTED = 0x0001;
const FLAG_STRONG_ENCRYPTION = 0x0040;
const FLAG_UTF8 = 0x0800;
const DEFAULT_MAX_TOTAL = 1024 * 1024 * 1024; // refuse to unpack more than 1 GiB

// Files the OS leaves behind that never belong in a package.
const JUNK = new Set(['.ds_store', 'thumbs.db', 'desktop.ini']);

// zlib.crc32 exists from Node 20.15 / 22.2. Keep a table version for anything older.
let crcTable = null;
function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

// Code page 437, the default encoding for names in zips without the UTF-8 flag (bytes 128-255).
const CP437 = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';

function decodeName(bytes, utf8) {
  if (utf8) return bytes.toString('utf8');
  let ascii = true;
  for (const b of bytes) if (b > 127) { ascii = false; break; }
  if (ascii) return bytes.toString('latin1');
  // Many tools write UTF-8 without setting the flag. Use it when the bytes are valid UTF-8.
  const asUtf8 = bytes.toString('utf8');
  if (!asUtf8.includes('�')) return asUtf8;
  let out = '';
  for (const b of bytes) out += b < 128 ? String.fromCharCode(b) : CP437[b - 128];
  return out;
}

function zipError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// MS-DOS date and time, local time, two-second resolution. Years before 1980 can't be stored.
function dosDateTime(date) {
  let d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  if (d.getFullYear() < 1980) d = new Date(1980, 0, 1);
  if (d.getFullYear() > 2107) d = new Date(2107, 11, 31, 23, 59, 58);
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

function fromDos(date, time) {
  const day = date & 0x1f; const month = (date >> 5) & 0x0f; const year = ((date >> 9) & 0x7f) + 1980;
  if (!day || !month) return null;
  return new Date(year, month - 1, day, (time >> 11) & 0x1f, (time >> 5) & 0x3f, (time & 0x1f) * 2);
}

function toBuffer(data) {
  if (data === undefined || data === null) return Buffer.alloc(0);
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(String(data), 'utf8');
}

// entries: [{ name, data: Buffer|string, mtime?: Date, isDir? }] → Buffer.
// Names use "/" (backslashes are converted). A name ending in "/" (or isDir) is a folder.
function createZip(entries) {
  if (!Array.isArray(entries)) throw new TypeError('createZip needs a list of entries.');
  if (entries.length > 0xffff) throw zipError('Too many files for a standard zip (the limit is 65,535).', 'ZIP_TOO_BIG');
  const parts = []; const central = []; let offset = 0;
  for (const e of entries) {
    let name = String(e && e.name || '').replace(/\\/g, '/');
    if (!name) throw new TypeError('Every zip entry needs a name.');
    const isDir = Boolean(e.isDir) || name.endsWith('/');
    if (isDir && !name.endsWith('/')) name += '/';
    const nameBuf = Buffer.from(name, 'utf8');
    if (nameBuf.length > 0xffff) throw zipError(`The name "${name.slice(0, 60)}…" is too long for a zip.`, 'ZIP_TOO_BIG');
    const data = isDir ? Buffer.alloc(0) : toBuffer(e.data);
    const crc = crc32(data);
    let method = 0; let stored = data;
    if (data.length > 0) {
      const deflated = zlib.deflateRawSync(data, { level: 9 });
      if (deflated.length < data.length) { method = 8; stored = deflated; }
    }
    if (data.length > 0xfffffffe || offset + 30 + nameBuf.length + stored.length > 0xfffffffe) {
      throw zipError('These files are too big for a standard zip (the limit is 4 GB).', 'ZIP_TOO_BIG');
    }
    const { time, date } = dosDateTime(e.mtime);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4); // version needed: 2.0 (deflate, folders)
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(SIG_CENTRAL, 0);
    cen.writeUInt16LE(20, 4); // made by: MS-DOS host, spec 2.0 (low byte of the attributes is DOS-style)
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(FLAG_UTF8, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt16LE(time, 12);
    cen.writeUInt16LE(date, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(stored.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    // 30 extra length, 32 comment length, 34 disk, 36 internal attributes: all 0
    cen.writeUInt32LE(isDir ? 0x10 : 0x20, 38); // DOS attributes: directory / archive
    cen.writeUInt32LE(offset, 42);
    parts.push(local, nameBuf, stored);
    central.push(cen, nameBuf);
    offset += 30 + nameBuf.length + stored.length;
  }
  const cenBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(SIG_END, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cenBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cenBuf, end]);
}

// Finds the end-of-central-directory record: the last 22+ bytes, possibly followed by a comment.
function findEnd(buf) {
  if (!Buffer.isBuffer(buf)) throw new TypeError('readZip needs a Buffer.');
  if (buf.length < 22) throw zipError("This file isn't a zip (it's too small).", 'ZIP_INVALID');
  const stop = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= stop; i--) {
    if (buf.readUInt32LE(i) === SIG_END) return i;
  }
  throw zipError("This file isn't a zip, or it's damaged.", 'ZIP_INVALID');
}

// → [{ name, data: Buffer, isDir, size, mtime }]. Names always use "/"; folders end in "/".
// opts.maxTotalSize caps the unpacked size (default 1 GiB) so a hostile zip can't fill memory.
function readZip(buf, opts = {}) {
  const maxTotal = opts.maxTotalSize || DEFAULT_MAX_TOTAL;
  const end = findEnd(buf);
  const zip64 = () => zipError('This zip uses the ZIP64 format (for very large zips), which isn\'t supported. Make a standard zip instead.', 'ZIP_UNSUPPORTED');
  if (buf.readUInt16LE(end + 4) !== 0 || buf.readUInt16LE(end + 6) !== 0) {
    throw zipError('This zip is split into several parts, which isn\'t supported. Make a single zip file instead.', 'ZIP_UNSUPPORTED');
  }
  const count = buf.readUInt16LE(end + 10);
  const cdSize = buf.readUInt32LE(end + 12);
  const cdOffset = buf.readUInt32LE(end + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff
    || (end >= 20 && buf.readUInt32LE(end - 20) === SIG_ZIP64_LOCATOR)) throw zip64();
  if (cdOffset + cdSize > end) throw zipError("This zip is damaged (its table of contents is cut off).", 'ZIP_INVALID');

  const out = [];
  let total = 0;
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CENTRAL) throw zipError('This zip is damaged (bad table of contents).', 'ZIP_INVALID');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const mtime = fromDos(buf.readUInt16LE(p + 14), buf.readUInt16LE(p + 12));
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const external = buf.readUInt32LE(p + 38);
    const localOffset = buf.readUInt32LE(p + 42);
    if (p + 46 + nameLen > buf.length) throw zipError('This zip is damaged (bad table of contents).', 'ZIP_INVALID');
    // Windows PowerShell 5's Compress-Archive writes "\" between folders; treat it as "/".
    const name = decodeName(buf.subarray(p + 46, p + 46 + nameLen), (flags & FLAG_UTF8) !== 0).replace(/\\/g, '/');
    p += 46 + nameLen + extraLen + commentLen;

    if (csize === 0xffffffff || usize === 0xffffffff || localOffset === 0xffffffff) throw zip64();
    if (flags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION)) {
      throw zipError(`"${name}" in this zip is password-protected. Use a zip without a password.`, 'ZIP_ENCRYPTED');
    }
    const isDir = name.endsWith('/')
      || (usize === 0 && ((external & 0x10) !== 0 || ((external >>> 16) & 0o170000) === 0o040000));
    if (isDir) {
      out.push({ name: name.endsWith('/') ? name : `${name}/`, data: Buffer.alloc(0), isDir: true, size: 0, mtime });
      continue;
    }
    if (method !== 0 && method !== 8) {
      const what = method === 9 ? 'Deflate64' : method === 12 ? 'BZip2' : method === 14 ? 'LZMA' : `method ${method}`;
      throw zipError(`"${name}" in this zip uses ${what} compression, which isn't supported. Re-zip it with normal settings.`, 'ZIP_UNSUPPORTED');
    }
    total += usize;
    if (total > maxTotal) throw zipError('This zip unpacks to more than the size allowed.', 'ZIP_TOO_BIG');

    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== SIG_LOCAL) {
      throw zipError(`This zip is damaged ("${name}" can't be found).`, 'ZIP_INVALID');
    }
    const start = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    if (start + csize > buf.length) throw zipError(`This zip is damaged ("${name}" is cut off).`, 'ZIP_INVALID');
    const raw = buf.subarray(start, start + csize);
    let data;
    if (method === 0) {
      if (csize !== usize) throw zipError(`This zip is damaged ("${name}" has the wrong size).`, 'ZIP_INVALID');
      data = Buffer.from(raw); // a copy, so the caller can drop the zip buffer
    } else {
      try {
        // Never let a file inflate past the size the zip claims for it.
        data = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(usize, 1) });
      } catch {
        throw zipError(`This zip is damaged ("${name}" can't be unpacked).`, 'ZIP_INVALID');
      }
      if (data.length !== usize) throw zipError(`This zip is damaged ("${name}" has the wrong size).`, 'ZIP_INVALID');
    }
    if (crc32(data) !== crc) throw zipError(`This zip is damaged ("${name}" failed its checksum).`, 'ZIP_INVALID');
    out.push({ name, data, isDir: false, size: data.length, mtime });
  }
  return out;
}

const DEVICE_NAMES = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(\..*)?$/i;

// Turns a zip entry name into safe path segments, or throws. Refuses anything that could land
// outside the target folder: absolute paths, drive letters (and any ":"), ".." in any spelling
// Windows accepts (".. ", "..."), backslash variants of all of these, and Windows device names.
function safeSegments(name) {
  const n = String(name).replace(/\\/g, '/');
  const unsafe = (why) => zipError(`The zip contains an unsafe file name ("${String(name).slice(0, 120)}": ${why}). Nothing was extracted.`, 'ZIP_UNSAFE_PATH');
  if (!n || n.includes('\0')) throw unsafe('empty or invalid');
  if (n.startsWith('/')) throw unsafe('absolute path');
  if (/^[A-Za-z]:/.test(n)) throw unsafe('drive letter');
  if (n.includes(':')) throw unsafe('contains ":"');
  const segs = n.split('/').filter((s) => s !== '' && s !== '.');
  for (const s of segs) {
    if (/^[. ]+$/.test(s)) throw unsafe('parent folder');
    if (/[\x00-\x1f]/.test(s)) throw unsafe('control characters');
    if (DEVICE_NAMES.test(s.trim())) throw unsafe('reserved Windows name');
  }
  return segs;
}

// Extracts every entry under destDir (created if needed). Every name is checked before
// anything is written, so a hostile zip writes nothing at all.
// → [{ name, path, isDir }] for what was written.
function extractZip(buf, destDir, opts = {}) {
  const root = path.resolve(destDir);
  const planned = [];
  for (const e of readZip(buf, opts)) {
    const segs = safeSegments(e.name);
    if (!segs.length) continue; // "./" is the target folder itself
    const target = path.resolve(root, ...segs);
    const rel = path.relative(root, target);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
      throw zipError(`The zip contains an unsafe file name ("${e.name}"). Nothing was extracted.`, 'ZIP_UNSAFE_PATH');
    }
    planned.push({ name: e.name, path: target, isDir: e.isDir, data: e.data });
  }
  fs.mkdirSync(root, { recursive: true });
  for (const e of planned) {
    if (e.isDir) fs.mkdirSync(e.path, { recursive: true });
    else {
      fs.mkdirSync(path.dirname(e.path), { recursive: true });
      fs.writeFileSync(e.path, e.data);
    }
  }
  return planned.map(({ name, path: p, isDir }) => ({ name, path: p, isDir }));
}

// Lists a folder as createZip entries. Names use "/", sorted so the same folder always gives
// the same order. opts.prefix puts everything under one top folder ("WowGuild/Core.lua").
// opts.filter(relPath, isDir) → false skips a file or folder. OS junk (.DS_Store, Thumbs.db,
// desktop.ini) is always skipped. Empty folders are kept as folder entries.
function directoryEntries(dir, opts = {}) {
  const root = path.resolve(dir);
  let st;
  try { st = fs.statSync(root); } catch { throw zipError(`Folder not found: ${root}`, 'ENOENT'); }
  if (!st.isDirectory()) throw zipError(`Not a folder: ${root}`, 'ENOTDIR');
  const prefix = String(opts.prefix || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const filter = typeof opts.filter === 'function' ? opts.filter : () => true;
  const entries = [];
  const seen = new Set();
  const walk = (abs, rel) => {
    const real = fs.realpathSync(abs);
    if (seen.has(real)) return; // a folder link pointing back up: don't loop forever
    seen.add(real);
    const names = fs.readdirSync(abs).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const name of names) {
      if (JUNK.has(name.toLowerCase())) continue;
      const childAbs = path.join(abs, name);
      const childRel = rel ? `${rel}/${name}` : name;
      let cst;
      try { cst = fs.statSync(childAbs); } catch { continue; } // broken link
      const isDir = cst.isDirectory();
      if (!isDir && !cst.isFile()) continue;
      if (filter(childRel, isDir) === false) continue;
      const zipName = prefix ? `${prefix}/${childRel}` : childRel;
      if (isDir) {
        const before = entries.length;
        walk(childAbs, childRel);
        if (entries.length === before) entries.push({ name: `${zipName}/`, isDir: true, mtime: cst.mtime });
      } else {
        entries.push({ name: zipName, data: fs.readFileSync(childAbs), mtime: cst.mtime });
      }
    }
  };
  walk(root, '');
  return entries;
}

function zipDirectory(dir, opts = {}) {
  return createZip(directoryEntries(dir, opts));
}

module.exports = { createZip, readZip, extractZip, zipDirectory, directoryEntries, safeSegments, crc32 };
