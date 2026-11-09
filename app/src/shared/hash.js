'use strict';
// Checksums for releases: sha256 (addon zips) and sha512 in base64 (electron-updater's format).
// Zero dependencies: shared by the app, the server and the release scripts.
const crypto = require('crypto');
const fs = require('fs');

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function sha512Base64(buf) {
  return crypto.createHash('sha512').update(buf).digest('base64');
}

// Streams the file, so a 100 MB installer never sits in memory.
function hashFile(file, algorithm, encoding) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(algorithm);
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest(encoding)));
  });
}

function sha256File(file) { return hashFile(file, 'sha256', 'hex'); }
function sha512File(file) { return hashFile(file, 'sha512', 'base64'); }

module.exports = { sha256, sha512Base64, sha256File, sha512File };
