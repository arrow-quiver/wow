'use strict';
// The war table: an always-on-top window that sits over the game (WoW runs in a window or "windowed fullscreen", so
// an always-on-top window shows above it). A global hotkey (Ctrl+Shift+G) shows and hides it. It loads the whole
// app with ?overlay=1 (renderer lib/overlay.js): every page in the war-table layout, quick actions, live and spoken
// alerts, starting on /overlay (Now: the live link, next steps, the Coach and the guild feed).
//
//   const overlay = createOverlay({ store, log, preload, startUrl, electron })
//   overlay.toggle(); overlay.show(); overlay.hide(); overlay.window(); overlay.registerHotkey(); overlay.dispose()

const DEFAULT_SIZE = { width: 480, height: 740 };

function createOverlay({ store, log, preload, startUrl, electron = require('electron') }) {
  const { BrowserWindow, globalShortcut, screen } = electron;
  let win = null;
  let hotkey = null;

  function bounds() {
    const saved = store.get().overlayBounds;
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) return { ...DEFAULT_SIZE, ...saved };
    // Top-right of the main screen, out of the way of the game's own UI.
    try {
      const { workArea } = screen.getPrimaryDisplay();
      return { ...DEFAULT_SIZE, x: workArea.x + workArea.width - DEFAULT_SIZE.width - 24, y: workArea.y + 80 };
    } catch { return { ...DEFAULT_SIZE }; }
  }

  function create() {
    const b = bounds();
    win = new BrowserWindow({
      ...b, minWidth: 360, minHeight: 420, show: false, frame: false, resizable: true, skipTaskbar: true,
      alwaysOnTop: true, fullscreenable: false, maximizable: false, minimizable: false, backgroundColor: '#140f0b',
      title: 'Guild Camp war table',
      webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: true },
    });
    // Above games in windowed fullscreen too.
    try { win.setAlwaysOnTop(true, 'screen-saver'); } catch { /* older Electron */ }
    try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch { /* not on Windows */ }
    win.setOpacity(store.get().overlayOpacity || 0.94);
    let saveTimer = null;
    const save = () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        if (!win || win.isDestroyed()) return;
        try { const { x, y, width, height } = win.getBounds(); store.set({ overlayBounds: { x, y, width, height } }); } catch (err) { log.warn(`Couldn't remember the overlay position: ${err.message}`); }
      }, 400);
    };
    win.on('move', save); win.on('resize', save);
    win.on('closed', () => { win = null; });
    const wc = win.webContents;
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-navigate', (e) => e.preventDefault());
    wc.on('before-input-event', (e, input) => { if (input.type === 'keyDown' && input.key === 'Escape') { e.preventDefault(); hide(); } });
    win.loadURL(`${startUrl}?splash=0&overlay=1#/overlay`).catch((err) => log.error(`Couldn't load the overlay: ${err.message}`));
    return win;
  }

  function show() {
    if (!store.get().overlayEnabled) return false;
    if (!win || win.isDestroyed()) create();
    const w = win;
    const reveal = () => { w.show(); w.focus(); };
    if (w.webContents.isLoading()) w.once('ready-to-show', reveal); else reveal();
    return true;
  }
  function hide() { if (win && !win.isDestroyed()) win.hide(); return true; }
  function toggle() { return win && !win.isDestroyed() && win.isVisible() ? hide() : show(); }

  function registerHotkey() {
    const want = store.get().overlayEnabled ? store.get().overlayHotkey : null;
    if (hotkey === want) return { ok: true, hotkey };
    if (hotkey) { try { globalShortcut.unregister(hotkey); } catch { /* gone already */ } hotkey = null; }
    if (!want) return { ok: true, hotkey: null };
    let ok = false;
    try { ok = globalShortcut.register(want, toggle); } catch (err) { log.warn(`Couldn't use ${want} for the Coach overlay: ${err.message}`); }
    if (ok) { hotkey = want; log.info(`Coach overlay: press ${want.replace('CommandOrControl', 'Ctrl')} to show or hide it.`); } else log.warn(`${want} is already taken by another program. Pick another hotkey for the Coach overlay in Settings.`);
    return { ok, hotkey };
  }

  store.on('change', (s, keys) => {
    if (keys.includes('overlayHotkey') || keys.includes('overlayEnabled')) registerHotkey();
    if (keys.includes('overlayEnabled') && !s.overlayEnabled) hide();
    if (keys.includes('overlayOpacity') && win && !win.isDestroyed()) win.setOpacity(s.overlayOpacity);
  });

  return {
    show, hide, toggle, registerHotkey,
    window: () => (win && !win.isDestroyed() ? win : null),
    hotkey: () => hotkey,
    dispose() { if (hotkey) { try { globalShortcut.unregister(hotkey); } catch { /* quitting */ } } if (win && !win.isDestroyed()) win.destroy(); },
  };
}

module.exports = { createOverlay, DEFAULT_SIZE };
