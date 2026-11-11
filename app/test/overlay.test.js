// The Coach overlay (src/main/overlay.js): on the desktop by default, inside the game once Overwolf's
// overlay package is attached and the game has let it in. Electron and the Overwolf API are fakes.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createOverlay, WOW_GAME_IDS } = require('../src/main/overlay');

const tick = () => new Promise((resolve) => setImmediate(resolve));

function setup(settings = {}) {
  const made = [];
  class FakeWindow extends EventEmitter {
    constructor(opts) {
      super();
      this.opts = opts;
      this.visible = false;
      this.destroyed = false;
      this.url = null;
      this.webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler() {}, isLoading: () => false });
      made.push(this);
    }
    setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces() {}
    setOpacity(v) { this.opacity = v; }
    loadURL(url) { this.url = url; return Promise.resolve(); }
    show() { this.visible = true; }
    hide() { this.visible = false; }
    focus() {}
    isVisible() { return this.visible; }
    isDestroyed() { return this.destroyed; }
    getBounds() { return { x: 0, y: 0, width: 380, height: 600 }; }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  const shortcuts = new Map();
  const electron = {
    BrowserWindow: FakeWindow,
    globalShortcut: { register: (key, fn) => { shortcuts.set(key, fn); return true; }, unregister: (key) => shortcuts.delete(key) },
    screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }) },
  };
  const state = { overlayEnabled: true, overlayHotkey: 'CommandOrControl+Shift+G', overlayOpacity: 0.9, overlayBounds: null, ...settings };
  const store = Object.assign(new EventEmitter(), { get: () => state, set: (patch) => Object.assign(state, patch) });
  const logged = [];
  const log = { info: (m) => logged.push(m), warn: (m) => logged.push(m), error: (m) => logged.push(m) };

  // Overwolf's overlay API: records what it was asked, and makes "in-game" windows.
  const api = Object.assign(new EventEmitter(), {
    registered: null,
    gameWindows: [],
    failCreate: false,
    registerGames(filter) { api.registered = filter; },
    getActiveGameInfo: () => ({ gameWindowInfo: { size: { width: 2560, height: 1440 } } }),
    async createWindow(options) {
      if (api.failCreate) throw new Error('no device');
      const window = new FakeWindow(options);
      api.gameWindows.push(window);
      return { window, name: options.name };
    },
  });

  const overlay = createOverlay({ store, log, preload: 'preload.js', startUrl: 'app://guildcamp/index.html', electron });
  return { overlay, api, made, store, state, shortcuts, logged };
}

const WOW = { id: 7651, classId: 765, name: 'World of Warcraft', supported: true, type: 'Game' };

test('without Overwolf the overlay is an always-on-top desktop window', async () => {
  const { overlay, made } = setup();
  assert.equal(overlay.show(), true);
  await tick();
  assert.equal(made.length, 1);
  assert.equal(overlay.mode(), 'desktop');
  assert.equal(made[0].opts.alwaysOnTop, true);
  assert.equal(made[0].opts.x, 1920 - 480 - 24, 'top-right of the screen');
  assert.match(made[0].url, /#\/overlay$/);
  assert.equal(made[0].visible, true);
  overlay.toggle();
  assert.equal(made[0].visible, false);
});

test('attachGame watches for WoW and lets the overlay in when it starts', () => {
  const { overlay, api } = setup();
  assert.equal(overlay.attachGame(api), true);
  assert.deepEqual(api.registered, { gamesIds: WOW_GAME_IDS });
  assert.deepEqual(WOW_GAME_IDS, [765, 21630]);
  assert.equal(overlay.attachGame(api), false, 'only once');

  const calls = [];
  const event = { inject: () => calls.push('inject'), dismiss: () => calls.push('dismiss') };
  api.emit('game-launched', event, WOW);
  api.emit('game-launched', event, { ...WOW, type: 'Launcher' });
  assert.deepEqual(calls, ['inject', 'dismiss'], 'the game, never its launcher');
});

test('with the overlay switched off the game is left alone', () => {
  const { overlay, api } = setup({ overlayEnabled: false });
  overlay.attachGame(api);
  const calls = [];
  api.emit('game-launched', { inject: () => calls.push('inject'), dismiss: () => calls.push('dismiss') }, WOW);
  assert.deepEqual(calls, ['dismiss']);
});

test('once the game has let it in, the overlay is drawn inside the game', async () => {
  const { overlay, api, made } = setup();
  overlay.show();
  await tick();
  const desktop = made[0];
  overlay.attachGame(api);
  api.emit('game-injected', WOW);
  assert.equal(desktop.destroyed, true, 'the desktop window is dropped');
  assert.equal(overlay.window(), null);

  overlay.show();
  await tick();
  assert.equal(api.gameWindows.length, 1);
  assert.equal(overlay.mode(), 'game');
  const opts = api.gameWindows[0].opts;
  assert.equal(opts.name, 'guild-camp-war-table');
  assert.equal(opts.passthrough, 'noPassThrough');
  assert.equal(opts.x, 2560 - 480 - 24, "top-right of the game's window");
  assert.equal(opts.webPreferences.sandbox, true);
  assert.equal(api.gameWindows[0].visible, true);

  // The game closes: back to the desktop on the next show.
  api.emit('game-exit', WOW, true);
  assert.equal(api.gameWindows[0].destroyed, true);
  overlay.show();
  await tick();
  assert.equal(overlay.mode(), 'desktop');
});

test('two quick presses make one window', async () => {
  const { overlay, api } = setup();
  overlay.attachGame(api);
  api.emit('game-injected', WOW);
  overlay.show();
  overlay.show();
  await tick();
  assert.equal(api.gameWindows.length, 1);
});

test('a game that refuses the overlay, or a window that cannot be made, falls back to the desktop', async () => {
  const refused = setup();
  refused.overlay.attachGame(refused.api);
  refused.api.emit('game-injection-error', WOW, 'blocked');
  refused.overlay.show();
  await tick();
  assert.equal(refused.overlay.mode(), 'desktop');
  assert.ok(refused.logged.some((m) => /didn't let the Coach overlay in \(blocked\)/.test(m)));

  const broken = setup();
  broken.overlay.attachGame(broken.api);
  broken.api.emit('game-injected', WOW);
  broken.api.failCreate = true;
  broken.overlay.show();
  await tick();
  await tick();
  assert.equal(broken.overlay.mode(), 'desktop');
  assert.ok(broken.logged.some((m) => /Couldn't open the Coach inside the game \(no device\)/.test(m)));
});

test('the hotkey toggles the overlay and dispose cleans up', async () => {
  const { overlay, shortcuts, made } = setup();
  assert.deepEqual(overlay.registerHotkey(), { ok: true, hotkey: 'CommandOrControl+Shift+G' });
  shortcuts.get('CommandOrControl+Shift+G')();
  await tick();
  assert.equal(made[0].visible, true);
  overlay.dispose();
  assert.equal(shortcuts.size, 0);
  assert.equal(made[0].destroyed, true);
});
