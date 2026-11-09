'use strict';
// Rotating log file + in-memory ring buffer for the main process.
//
//   const log = createLog(path.join(userData, 'logs'));
//   log.info('Started'); log.warn('Hmm'); log.error('Broke', err);
//   const syncLog = log.scope('sync');   // lines tagged [sync]
//   log.recent()                         // last 500 lines: [{ t, level, scope, msg }]
//   log.on('line', (line) => ...)        // every new line (the app forwards these to the renderer)
//
// Plain Node (no Electron). Logging must never take the app down, so nothing in here throws.

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const LEVELS = ['info', 'warn', 'error'];

// Device tokens and sign-in tokens must never end up in a log file people share for support.
function redact(text) {
  return String(text)
    .replace(/gcd_[A-Za-z0-9_-]+/g, 'gcd_[hidden]')
    .replace(/(Bearer\s+)[^\s"']+/gi, '$1[hidden]')
    .replace(/([?#&](?:token|access_token|code)=)[^&\s"']+/gi, '$1[hidden]');
}

function formatPart(part) {
  if (part instanceof Error) return part.message || String(part);
  if (typeof part === 'string') return part;
  if (part === undefined) return 'undefined';
  try { return JSON.stringify(part); } catch { return String(part); }
}

/**
 * @param {string} dir folder for the log files (created when missing)
 * @param {object} [opts]
 * @param {number} [opts.maxBytes=1048576] rotate when the current file would grow past this
 * @param {number} [opts.keep=3] files kept in total: guildcamp.log, guildcamp.1.log, guildcamp.2.log
 * @param {number} [opts.ringSize=500] lines kept in memory for log.recent()
 * @param {boolean} [opts.echo=false] also print lines to stdout/stderr (dev runs)
 * @param {string} [opts.name='guildcamp'] base file name
 */
function createLog(dir, opts = {}) {
  const maxBytes = opts.maxBytes || 1024 * 1024;
  const keep = Math.max(1, opts.keep || 3);
  const ringSize = opts.ringSize || 500;
  const echo = Boolean(opts.echo);
  const name = opts.name || 'guildcamp';
  const file = path.join(dir, `${name}.log`);
  const rotated = (n) => path.join(dir, `${name}.${n}.log`);

  const emitter = new EventEmitter();
  emitter.setMaxListeners(50);
  const ring = [];
  let size = 0;
  let fileOk = true;

  try {
    fs.mkdirSync(dir, { recursive: true });
    size = fs.existsSync(file) ? fs.statSync(file).size : 0;
  } catch {
    fileOk = false; // read-only or missing folder: keep logging to memory only
  }

  function rotate() {
    try {
      // guildcamp.(keep-1).log falls off the end; everything else moves up one.
      for (let n = keep - 1; n >= 1; n--) {
        const from = n === 1 ? file : rotated(n - 1);
        const to = rotated(n);
        if (n === keep - 1 && fs.existsSync(to)) fs.rmSync(to, { force: true });
        if (fs.existsSync(from)) fs.renameSync(from, to);
      }
      if (keep === 1) fs.rmSync(file, { force: true });
    } catch {
      // A locked file (antivirus, an open editor) must not stop logging: truncate instead.
      try { fs.writeFileSync(file, ''); } catch { /* give up on the file for this line */ }
    }
    size = 0;
  }

  function writeLine(text) {
    if (!fileOk) return;
    try {
      const bytes = Buffer.byteLength(text);
      if (size > 0 && size + bytes > maxBytes) rotate();
      fs.appendFileSync(file, text);
      size += bytes;
    } catch {
      // Disk full or file locked: drop the line from the file, it is still in memory.
    }
  }

  function write(level, scope, parts) {
    try {
      const lvl = LEVELS.includes(level) ? level : 'info';
      const msg = redact(parts.map(formatPart).join(' '));
      const line = { t: new Date().toISOString(), level: lvl, scope: scope || 'app', msg };
      ring.push(line);
      if (ring.length > ringSize) ring.splice(0, ring.length - ringSize);

      // Errors keep their stack in the file (useful for support) but not in the UI ring.
      let extra = '';
      if (lvl === 'error') {
        const err = parts.find((p) => p instanceof Error && p.stack);
        const frames = err ? redact(err.stack).split('\n').slice(1).map((l) => l.trim()).filter(Boolean) : [];
        if (frames.length) extra = `\n    ${frames.join('\n    ')}`;
      }
      const text = `${line.t} ${lvl.toUpperCase().padEnd(5)} [${line.scope}] ${msg}${extra}\n`;
      writeLine(text);
      if (echo) (lvl === 'info' ? process.stdout : process.stderr).write(text);
      emitter.emit('line', { ...line });
    } catch {
      // never throw from logging
    }
  }

  function makeLogger(scope) {
    return {
      info: (...parts) => write('info', scope, parts),
      warn: (...parts) => write('warn', scope, parts),
      error: (...parts) => write('error', scope, parts),
      scope: (child) => makeLogger(scope && scope !== 'app' ? `${scope}:${child}` : String(child)),
    };
  }

  const root = makeLogger('app');
  return Object.assign(emitter, root, {
    file,
    dir,
    recent: () => ring.map((l) => ({ ...l })),
  });
}

module.exports = { createLog, redact };
