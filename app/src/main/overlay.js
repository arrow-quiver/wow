'use strict';
// The war table: a window over the game. A global hotkey (Ctrl+Shift+G) shows and hides it. It loads the whole
// app with ?overlay=1 (renderer lib/overlay.js): every page in the war-table layout, quick actions, live and spoken
// alerts, starting on /overlay (Now: the live link, next steps, the Coach and the guild feed).
//
// Two ways to draw it:
//   - In the game (the Overwolf build, on ow-electron). Once Overwolf's overlay package is ready
//     (attachGame) and the game has let the overlay in, the window is made with the package's
//     createWindow and is drawn inside the game, in real fullscreen too.
//   - On the desktop. An always-on-top window, above a game that runs in a window or "windowed
//     fullscreen". Used when no game is running, when the game didn't let the overlay in, and on plain
//     Electron (no Overwolf).
// A window is made for one of the two; when the game starts or stops it is dropped and the next show
// makes the right kind.
//
//   const overlay = createOverlay({ store, log, preload, startUrl, electron })
//   overlay.toggle(); overlay.show(); overlay.hide(); overlay.window(); overlay.registerHotkey(); overlay.dispose()
//   overlay.attachGame(app.overwolf.packages.overlay)   once, when the package reports 'ready'
//   overlay.mode() → 'game' | 'desktop' | null (no window)

const DEFAULT_SIZE = { width: 480, height: 740 };
const MARGIN = { right: 24, top: 80 };
// Overwolf's game ids (game-list.d.ts in @overwolf/ow-electron-packages-types): WoW and WoW Classic.
const WOW_GAME_IDS = [765, 21630];
const GAME_WINDOW_NAME = 'guild-camp-war-table';

function createOverlay({ store, log, preload, startUrl, electron = require('electron') }) {
  const { BrowserWindow, globalShortcut, screen } = electron;
  let win = null;
  let winMode = null; // 'game' | 'desktop'
  let creating = null; // the window being made, so two quick presses don't make two
  let hotkey = null;
  let game = null; // Overwolf's overlay API, once its package is ready
  let inGame = false; // the game is running and has let the overlay in

  const windowOptions = () => ({
    minWidth: 360, minHeight: 420, show: false, frame: false, resizable: true, skipTaskbar: true,
    fullscreenable: false, maximizable: false, minimizable: false, backgroundColor: '#140f0b',
    title: 'Guild Camp war table',
    webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: true },
  });

  function desktopBounds() {
    const saved = store.get().overlayBounds;
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) return { ...DEFAULT_SIZE, ...saved };
    // Top-right of the main screen, out of the way of the game's own UI.
    try {
      const { workArea } = screen.getPrimaryDisplay();
      return { ...DEFAULT_SIZE, x: workArea.x + workArea.width - DEFAULT_SIZE.width - MARGIN.right, y: workArea.y + MARGIN.top };
    } catch { return { ...DEFAULT_SIZE }; }
  }

  // Inside the game the position is relative to the game's window: top-right again. Not remembered,
  // so a spot chosen on the desktop is never applied to a game of another size (or the other way round).
  function gameBounds() {
    let width = 0;
    try {
      const active = game.getActiveGameInfo();
      width = (active && active.gameWindowInfo && active.gameWindowInfo.size && active.gameWindowInfo.size.width) || 0;
    } catch { /* the game hasn't reported its window yet */ }
    const x = width > DEFAULT_SIZE.width + MARGIN.right ? width - DEFAULT_SIZE.width - MARGIN.right : MARGIN.right;
    return { ...DEFAULT_SIZE, x, y: MARGIN.top };
  }

  // What both kinds of window share: no new windows, no navigation, Escape hides, then load the page.
  function wire(w, mode) {
    win = w;
    winMode = mode;
    w.on('closed', () => { if (win === w) { win = null; winMode = null; } });
    const wc = w.webContents;
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-navigate', (e) => e.preventDefault());
    wc.on('before-input-event', (e, input) => { if (input.type === 'keyDown' && input.key === 'Escape') { e.preventDefault(); hide(); } });
    w.loadURL(`${startUrl}?splash=0&overlay=1#/overlay`).catch((err) => log.error(`Couldn't load the overlay: ${err.message}`));
    return w;
  }

  function createDesktop() {
    const w = new BrowserWindow({ ...windowOptions(), ...desktopBounds(), alwaysOnTop: true });
    // Above games in windowed fullscreen too.
    try { w.setAlwaysOnTop(true, 'screen-saver'); } catch { /* older Electron */ }
    try { w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch { /* not on Windows */ }
    w.setOpacity(store.get().overlayOpacity || 0.94);
    let saveTimer = null;
    const save = () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        if (w.isDestroyed()) return;
        try { const { x, y, width, height } = w.getBounds(); store.set({ overlayBounds: { x, y, width, height } }); } catch (err) { log.warn(`Couldn't remember the overlay position: ${err.message}`); }
      }, 400);
    };
    w.on('move', save); w.on('resize', save);
    return wire(w, 'desktop');
  }

  async function createInGame() {
    // The window takes mouse and keyboard while it is shown (the Ask box needs typing) and sits above
    // the app's other in-game windows.
    const made = await game.createWindow({ ...windowOptions(), ...gameBounds(), name: GAME_WINDOW_NAME, passthrough: 'noPassThrough', zOrder: 'topMost' });
    if (!made || !made.window) throw new Error('the game overlay gave no window');
    return wire(made.window, 'game');
  }

  /** The overlay window, made if needed: inside the game when it let the overlay in, else on the desktop. */
  function ensure() {
    if (win && !win.isDestroyed()) return Promise.resolve(win);
    if (creating) return creating;
    const make = inGame && game
      ? createInGame().catch((err) => {
        log.warn(`Couldn't open the Coach inside the game (${err.message}). Showing it on the desktop instead.`);
        return createDesktop();
      })
      : Promise.resolve().then(createDesktop);
    creating = make.finally(() => { creating = null; });
    return creating;
  }

  /** Closes the window, so the next show makes one for where the game is now. */
  function drop() {
    const w = win;
    win = null;
    winMode = null;
    if (w && !w.isDestroyed()) { try { w.destroy(); } catch { /* the game closed it already */ } }
  }

  function show() {
    if (!store.get().overlayEnabled) return false;
    ensure().then((w) => {
      if (!w || w.isDestroyed()) return;
      const reveal = () => { if (!w.isDestroyed()) { w.show(); w.focus(); } };
      if (w.webContents.isLoading()) w.webContents.once('did-finish-load', reveal); else reveal();
    }).catch((err) => log.error(`Couldn't open the Coach overlay: ${err.message}`));
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

  /**
   * Overwolf's overlay package is ready: ask to be told when WoW starts, and let the overlay into it.
   * With the overlay switched off in Settings the game is left alone.
   */
  function attachGame(api) {
    if (!api || game) return false;
    game = api;
    const name = (info) => (info && info.name) || 'The game';
    api.on('game-launched', (event, info) => {
      if (store.get().overlayEnabled && (!info || info.type !== 'Launcher')) event.inject();
      else event.dismiss();
    });
    api.on('game-injected', (info) => {
      inGame = true;
      drop(); // a desktop window from before the game started
      log.info(`${name(info)} is running: the Coach overlay shows inside the game.`);
    });
    api.on('game-injection-error', (info, error) => {
      inGame = false;
      log.warn(`${name(info)} didn't let the Coach overlay in (${error}). It shows on the desktop instead, so run the game in a window or windowed fullscreen.`);
    });
    api.on('game-exit', () => {
      if (!inGame) return;
      inGame = false;
      drop();
    });
    api.on('error', (err) => log.warn(`The game overlay reported a problem: ${(err && err.message) || err}`));
    try {
      api.registerGames({ gamesIds: WOW_GAME_IDS });
    } catch (err) {
      log.warn(`Couldn't watch for the game starting: ${err.message}`);
    }
    return true;
  }

  store.on('change', (s, keys) => {
    if (keys.includes('overlayHotkey') || keys.includes('overlayEnabled')) registerHotkey();
    if (keys.includes('overlayEnabled') && !s.overlayEnabled) hide();
    if (keys.includes('overlayOpacity') && win && !win.isDestroyed() && winMode === 'desktop') win.setOpacity(s.overlayOpacity);
  });

  return {
    show, hide, toggle, registerHotkey, attachGame,
    window: () => (win && !win.isDestroyed() ? win : null),
    mode: () => (win && !win.isDestroyed() ? winMode : null),
    hotkey: () => hotkey,
    dispose() { if (hotkey) { try { globalShortcut.unregister(hotkey); } catch { /* quitting */ } } drop(); },
  };
}

module.exports = { createOverlay, DEFAULT_SIZE, WOW_GAME_IDS };
