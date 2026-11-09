'use strict';
// "Start Guild Camp when I sign in to Windows". Starts hidden in the tray (--hidden).
//
//   const startup = createStartup();
//   startup.get()        → true | false
//   startup.set(true)    → the new state (throws a plain message where unsupported)

const { app } = require('electron');

/**
 * @param {object} [opts] overridable for tests
 * @param {object} [opts.app]
 * @param {boolean} [opts.isPackaged]
 * @param {string} [opts.execPath]
 * @param {string} [opts.appPath]   app folder passed to electron.exe in dev runs
 * @param {string} [opts.platform]
 */
function createStartup(opts = {}) {
  const electronApp = opts.app || app;
  const isPackaged = opts.isPackaged !== undefined ? opts.isPackaged : electronApp.isPackaged;
  const execPath = opts.execPath || process.execPath;
  const appPath = opts.appPath || electronApp.getAppPath();
  const platform = opts.platform || process.platform;
  const supported = platform === 'win32' || platform === 'darwin';

  // Windows looks the entry up by path + args, so get() must pass the same ones as set().
  // In a dev run the "app" is electron.exe plus the app folder.
  const target = () => (isPackaged
    ? { args: ['--hidden'] }
    : { path: execPath, args: [appPath, '--hidden'] });

  function get() {
    if (!supported) return false;
    try {
      const s = electronApp.getLoginItemSettings(target());
      return Boolean(s.openAtLogin);
    } catch {
      return false;
    }
  }

  function set(enabled) {
    if (!supported) throw new Error("Starting with your computer isn't supported on this system yet.");
    electronApp.setLoginItemSettings({ openAtLogin: Boolean(enabled), ...target() });
    return get();
  }

  return { get, set, supported };
}

module.exports = { createStartup };
