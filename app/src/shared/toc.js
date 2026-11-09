'use strict';
// WoW addon .toc files: "## Field: value" header lines, then the files the game loads.
// Zero dependencies: shared by the app, the server and the release scripts.

const FIELD = /^##\s*([^:\r\n]+?)\s*:[ \t]*(.*?)\s*$/;

function stripBom(text) {
  return String(text).replace(/^﻿/, '');
}

// → { fields: { Interface, Title, Version, ... }, files: ['Core.lua', ...] }
// Field names keep the spelling used in the file; when a field repeats, the first one wins
// (that is what the game does). Lines starting with a single "#" are comments.
function readToc(text) {
  const fields = {};
  const files = [];
  for (const raw of stripBom(text).split(/\r?\n|\r/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('##')) {
      const m = FIELD.exec(line);
      if (m && !Object.keys(fields).some((k) => k.toLowerCase() === m[1].toLowerCase())) fields[m[1]] = m[2];
      continue;
    }
    if (line.startsWith('#')) continue;
    files.push(line);
  }
  return { fields, files };
}

// Field lookup that ignores case ("## version:" works too). → string or null.
function tocField(text, name) {
  const { fields } = readToc(text);
  const key = Object.keys(fields).find((k) => k.toLowerCase() === String(name).toLowerCase());
  return key === undefined ? null : fields[key];
}

function tocVersion(text) {
  const v = tocField(text, 'Version');
  return v ? v : null;
}

// Set one header field and return the new text. The rest of the file, including its line
// endings and a leading BOM, stays exactly as it was. A missing field is added after the last
// "##" line (or at the top when there are none).
function setTocField(text, field, value) {
  const src = String(text);
  const name = String(field).trim();
  if (!name || /[:\r\n]/.test(name)) throw new Error(`"${field}" isn't a valid .toc field name.`);
  const val = String(value).replace(/[\r\n]+/g, ' ').trim();
  const eol = /\r\n/.test(src) ? '\r\n' : /\r/.test(src) ? '\r' : '\n';
  // Split but keep each line's own ending, so a file with mixed endings survives untouched.
  const lines = src.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) || [];
  let lastHeader = -1;
  for (let i = 0; i < lines.length; i++) {
    const body = lines[i].replace(/(?:\r\n|\r|\n)$/, '');
    const ending = lines[i].slice(body.length);
    const m = FIELD.exec(stripBom(body).trim());
    if (!m) continue;
    lastHeader = i;
    if (m[1].toLowerCase() === name.toLowerCase()) {
      const bom = body.startsWith('﻿') ? '﻿' : '';
      lines[i] = `${bom}## ${m[1]}: ${val}${ending}`;
      return lines.join('');
    }
  }
  const added = `## ${name}: ${val}${eol}`;
  if (lastHeader < 0) {
    const bom = src.startsWith('﻿') ? '﻿' : '';
    return bom + added + src.slice(bom.length);
  }
  if (!/(?:\r\n|\r|\n)$/.test(lines[lastHeader])) lines[lastHeader] += eol;
  lines.splice(lastHeader + 1, 0, added);
  return lines.join('');
}

module.exports = { readToc, tocField, tocVersion, setTocField };
