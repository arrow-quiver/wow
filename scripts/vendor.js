#!/usr/bin/env node
// Copies the renderer's third-party files out of app/node_modules into app/src/renderer/vendor.
// The renderer has no bundler, so these files are loaded as-is through the import map in index.html.
// The output is committed: run this again (npm --prefix app run vendor) after upgrading preact, htm or the fonts.
//
// It also refreshes the sha256 of the inline import map in index.html's Content-Security-Policy,
// because the CSP blocks inline scripts that are not listed by hash.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const appDir = path.join(__dirname, '..', 'app');
const modules = path.join(appDir, 'node_modules');
const rendererDir = path.join(appDir, 'src', 'renderer');
const vendorDir = path.join(rendererDir, 'vendor');
const fontDir = path.join(vendorDir, 'fonts');

const SCRIPTS = [
  // [source inside node_modules, file name in vendor/]
  ['preact/dist/preact.module.js', 'preact.module.js'],
  ['preact/hooks/dist/hooks.module.js', 'hooks.module.js'],
  ['htm/dist/htm.module.js', 'htm.module.js'],
];

const FONTS = [
  ['@fontsource/alegreya', 'alegreya', [500, 700, 800]],
  ['@fontsource/alegreya-sans', 'alegreya-sans', [400, 500, 700]],
];

function packageVersion(name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(modules, name, 'package.json'), 'utf8')).version;
  } catch {
    return 'unknown';
  }
}

function copyScripts() {
  for (const [from, to] of SCRIPTS) {
    const src = path.join(modules, from);
    if (!fs.existsSync(src)) throw new Error(`Missing ${from}. Run "npm install" in app/ first.`);
    let code = fs.readFileSync(src, 'utf8');
    // The hooks build imports the bare specifier "preact". Point it at the sibling file so it resolves
    // to the same module URL as the import map entry (one Preact instance) and works without the map too.
    if (to === 'hooks.module.js') {
      code = code.replace(/from\s*(["'])preact\1/g, 'from"./preact.module.js"');
      if (/from\s*["']preact["']/.test(code)) throw new Error('Could not rewrite the "preact" import in hooks.module.js.');
    }
    // Drop the source map comment: the .map files are not vendored and DevTools would warn about them.
    code = code.replace(/\n?\/\/# sourceMappingURL=.*$/m, '');
    const pkg = from.split('/')[0];
    const header = `/* ${pkg} ${packageVersion(pkg)}, copied by scripts/vendor.js. MIT licence. */\n`;
    fs.writeFileSync(path.join(vendorDir, to), header + code.trimEnd() + '\n');
    console.log(`vendor/${to}`);
  }
}

function copyFonts() {
  fs.mkdirSync(fontDir, { recursive: true });
  for (const [pkg, family, weights] of FONTS) {
    for (const weight of weights) {
      const name = `${family}-latin-${weight}-normal.woff2`;
      const src = path.join(modules, pkg, 'files', name);
      if (!fs.existsSync(src)) throw new Error(`Missing font ${pkg}/files/${name}.`);
      fs.copyFileSync(src, path.join(fontDir, name));
      console.log(`vendor/fonts/${name}`);
    }
  }
  // The fonts are under the SIL Open Font License; ship the licence text next to them.
  for (const [pkg, family] of FONTS) {
    const lic = path.join(modules, pkg, 'LICENSE');
    if (fs.existsSync(lic)) fs.copyFileSync(lic, path.join(fontDir, `${family}-LICENSE.txt`));
  }
}

// Recomputes the CSP hash for the inline <script type="importmap"> in index.html.
function refreshImportMapHash() {
  const file = path.join(rendererDir, 'index.html');
  if (!fs.existsSync(file)) return;
  const htmlText = fs.readFileSync(file, 'utf8');
  const m = htmlText.match(/<script type="importmap">([\s\S]*?)<\/script>/);
  if (!m) return;
  const hash = `'sha256-${crypto.createHash('sha256').update(m[1], 'utf8').digest('base64')}'`;
  const next = htmlText.replace(/'sha256-[^']*'/, hash);
  if (next !== htmlText) {
    fs.writeFileSync(file, next);
    console.log(`index.html: import map hash is now ${hash}`);
  } else if (!htmlText.includes(hash)) {
    console.warn('index.html: add the import map hash to script-src by hand:', hash);
  }
}

function main() {
  fs.mkdirSync(vendorDir, { recursive: true });
  copyScripts();
  copyFonts();
  refreshImportMapHash();
  console.log('Done.');
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = { main, refreshImportMapHash };
