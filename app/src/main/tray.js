'use strict';
// Tray icon: keeps Guild Camp running in the background while the window is closed.
//
//   const tray = createTray({ iconPath, onOpen, onSyncNow, onCheckUpdates, onQuit, log });
//   tray.setSyncStatus(syncStatus)   // updates the tooltip
//   tray.destroy()

const { Tray, Menu, nativeImage } = require('electron');

function syncLine(status) {
  if (!status || typeof status !== 'object') return 'Starting…';
  switch (status.state) {
    case 'off': return 'Sync is off';
    case 'syncing': return 'Syncing…';
    case 'signed-out': return 'Not signed in';
    case 'no-game': return 'Game folder not found';
    case 'error': return `Sync problem: ${String(status.lastError || 'unknown').slice(0, 70)}`;
    case 'idle': {
      if (!status.lastSyncAt) return 'Waiting for the game to save';
      const t = Date.parse(status.lastSyncAt);
      if (!Number.isFinite(t)) return 'Synced';
      const mins = Math.round((Date.now() - t) / 60000);
      if (mins < 1) return 'Synced just now';
      if (mins < 60) return `Synced ${mins} min ago`;
      const hours = Math.round(mins / 60);
      return hours < 48 ? `Synced ${hours} h ago` : `Synced ${Math.round(hours / 24)} days ago`;
    }
    default: return 'Running';
  }
}

// A crisp tray image: 16 px plus a 32 px version for high-DPI screens.
function trayImage(iconPath) {
  const source = iconPath ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  if (source.isEmpty()) return source;
  if (process.platform === 'darwin') return source.resize({ width: 16, height: 16, quality: 'best' });
  const image = nativeImage.createEmpty();
  for (const [scaleFactor, size] of [[1, 16], [2, 32]]) {
    const scaled = source.resize({ width: size, height: size, quality: 'best' });
    image.addRepresentation({ scaleFactor, width: size, height: size, buffer: scaled.toPNG() });
  }
  return image;
}

/**
 * @param {object} deps
 * @param {string|null} deps.iconPath
 * @param {() => void} deps.onOpen
 * @param {() => void} deps.onSyncNow
 * @param {() => void} deps.onCheckUpdates
 * @param {() => void} deps.onQuit
 * @param {object} deps.log
 */
function createTray({ iconPath, onOpen, onSyncNow, onCheckUpdates, onQuit, log }) {
  let tray;
  try {
    tray = new Tray(trayImage(iconPath));
  } catch (err) {
    log.warn(`No tray icon on this system (${err.message}). Closing the window will quit Guild Camp.`);
    return { setSyncStatus() {}, destroy() {}, exists: () => false };
  }

  const safe = (fn) => () => {
    try {
      const r = fn();
      if (r && typeof r.catch === 'function') r.catch((err) => log.warn(err.message));
    } catch (err) {
      log.warn(err.message);
    }
  };

  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Guild Camp', click: safe(onOpen) },
    { label: 'Sync now', click: safe(onSyncNow) },
    { label: 'Check for updates', click: safe(onCheckUpdates) },
    { type: 'separator' },
    { label: 'Quit', click: safe(onQuit) },
  ]));
  tray.setToolTip('Guild Camp');
  tray.on('double-click', safe(onOpen));
  // On Windows a single click on the tray icon is the usual way to bring an app back.
  if (process.platform === 'win32') tray.on('click', safe(onOpen));

  return {
    setSyncStatus(status) {
      if (tray.isDestroyed()) return;
      // Windows tooltips are cut off at 127 characters.
      tray.setToolTip(`Guild Camp\n${syncLine(status)}`.slice(0, 127));
    },
    destroy() {
      if (!tray.isDestroyed()) tray.destroy();
    },
    exists: () => !tray.isDestroyed(),
  };
}

module.exports = { createTray, syncLine };
