'use strict';
// The app:// protocol that serves the renderer, and the main window.
//
//   registerScheme()                       // before app 'ready'
//   registerAppProtocol(rendererDir, log)  // after 'ready'
//   const win = createMainWindow({ store, log, preload, iconPath, startHidden, isQuitting, canHideToTray })
//   showWindow(win)
//
// Electron is required lazily so the path helpers can be tested in plain Node.

const fs = require('fs');
const path = require('path');

const SCHEME = 'app';
const HOST = 'guildcamp';
const APP_ORIGIN = `${SCHEME}://${HOST}`;
const START_URL = `${APP_ORIGIN}/index.html`;
const FRAME_COLOR = '#18222e';
const SYMBOL_COLOR = '#efe8d8';
const TITLE_BAR_HEIGHT = 38;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

const electron = () => require('electron');

/**
 * Maps an app://guildcamp/... URL to a file under root.
 * Returns { file, mime } or { status, message } (400 bad request, 404 not found).
 * Paths without an extension fall back to index.html (the renderer uses a hash router, but this
 * keeps reloads on odd URLs working). Anything that resolves outside root is refused.
 */
function resolveAppPath(root, requestUrl) {
  let u;
  try { u = new URL(requestUrl); } catch { return { status: 400, message: 'Bad URL' }; }
  if (u.protocol !== `${SCHEME}:` || u.host !== HOST) return { status: 404, message: 'Not found' };
  let rel;
  try { rel = decodeURIComponent(u.pathname); } catch { return { status: 400, message: 'Bad URL' }; }
  if (rel.includes('\0')) return { status: 400, message: 'Bad URL' };
  const base = path.resolve(root);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.resolve(base, `.${path.posix.normalize(rel.replace(/\\/g, '/'))}`);
  if (file !== base && !file.startsWith(base + path.sep)) return { status: 404, message: 'Not found' };
  const ext = path.extname(file).toLowerCase();
  if (!ext) return { file: path.join(base, 'index.html'), mime: MIME['.html'] };
  return { file, mime: MIME[ext] || 'application/octet-stream' };
}

function isAppUrl(url) {
  return typeof url === 'string' && (url === APP_ORIGIN || url.startsWith(`${APP_ORIGIN}/`));
}

function isExternalUrl(url) {
  return typeof url === 'string' && /^https?:\/\/[^\s]+$/i.test(url);
}

/** Must run before the app is ready. */
function registerScheme() {
  electron().protocol.registerSchemesAsPrivileged([{
    scheme: SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true },
  }]);
}

/** Serves src/renderer at app://guildcamp/. Call once after 'ready'. */
function registerAppProtocol(rendererDir, log) {
  const { protocol } = electron();
  protocol.handle(SCHEME, async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405 });
    }
    const hit = resolveAppPath(rendererDir, request.url);
    if (!hit.file) return new Response(hit.message, { status: hit.status, headers: { 'Content-Type': 'text/plain' } });
    try {
      const data = await fs.promises.readFile(hit.file);
      return new Response(request.method === 'HEAD' ? null : data, {
        status: 200,
        headers: {
          'Content-Type': hit.mime,
          'Content-Length': String(data.length),
          'Cache-Control': 'no-cache',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'EISDIR' && log) log.warn(`app:// could not read ${hit.file}: ${err.message}`);
      return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
    }
  });
}

/** First icon file that exists: build/icon.png (dev), resources/icon.png (packaged), renderer asset. */
function findIcon() {
  const candidates = [
    path.join(__dirname, '..', '..', 'build', 'icon.png'),
    process.resourcesPath ? path.join(process.resourcesPath, 'icon.png') : null,
    process.resourcesPath ? path.join(process.resourcesPath, 'build', 'icon.png') : null,
    path.join(__dirname, '..', 'renderer', 'assets', 'icon-192.png'),
  ].filter(Boolean);
  return candidates.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
}

// Saved bounds are only reused when they still overlap a connected display.
function usableBounds(saved) {
  if (!saved || typeof saved !== 'object') return null;
  const { x, y, width, height } = saved;
  if (![x, y, width, height].every(Number.isFinite) || width < 400 || height < 300) return null;
  try {
    const { screen } = electron();
    const visible = screen.getAllDisplays().some(({ workArea: a }) => (
      x + width - 100 > a.x && x + 100 < a.x + a.width && y + 40 > a.y && y < a.y + a.height - 40));
    return visible ? { x, y, width, height } : null;
  } catch {
    return null;
  }
}

// Windows last closed maximised are maximised when they are first shown, not when they are created:
// maximize() also shows a window, which would pop up a window started hidden in the tray (--hidden).
const maximizeOnShow = new WeakSet();

function showWindow(win) {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) {
    if (maximizeOnShow.has(win)) {
      maximizeOnShow.delete(win);
      win.maximize(); // shows it too
    } else {
      win.show();
    }
  }
  win.focus();
}

/**
 * @param {object} deps
 * @param {object} deps.store
 * @param {object} deps.log
 * @param {string} deps.preload           absolute path to preload.js
 * @param {string|null} [deps.iconPath]
 * @param {boolean} [deps.startHidden]    --hidden: stay in the tray
 * @param {() => boolean} deps.isQuitting
 * @param {() => boolean} [deps.canHideToTray] false when no tray icon exists
 * @param {boolean} [deps.allowReloadKeys] Ctrl+R / F5 reload (dev runs)
 */
function createMainWindow({ store, log, preload, iconPath, startHidden, isQuitting, canHideToTray = () => true, allowReloadKeys = false, startQuery = '' }) {
  const { BrowserWindow, shell } = electron();
  const settings = store.get();
  const saved = settings.windowBounds || null;
  const bounds = usableBounds(saved);
  const isMac = process.platform === 'darwin';

  const win = new BrowserWindow({
    width: bounds ? bounds.width : 1280,
    height: bounds ? bounds.height : 820,
    ...(bounds ? { x: bounds.x, y: bounds.y } : {}),
    minWidth: 1000,
    minHeight: 680,
    show: false,
    title: 'Guild Camp',
    backgroundColor: FRAME_COLOR,
    icon: iconPath || undefined,
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    ...(isMac ? {} : { titleBarOverlay: { color: FRAME_COLOR, symbolColor: SYMBOL_COLOR, height: TITLE_BAR_HEIGHT } }),
    webPreferences: {
      preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
      navigateOnDragDrop: false,
    },
  });
  // With a hidden title bar on a scaled display (125 %, 150 %), Windows makes the window a pixel
  // or two bigger than asked. Measure that once and take it off again when saving, otherwise the
  // window would grow a little on every start.
  const requested = { x: bounds ? bounds.x : null, y: bounds ? bounds.y : null, width: bounds ? bounds.width : 1280, height: bounds ? bounds.height : 820 };
  let offset = { dx: 0, dy: 0, dw: 0, dh: 0 };
  try {
    const actual = win.getNormalBounds();
    const d = {
      dx: requested.x === null ? 0 : actual.x - requested.x,
      dy: requested.y === null ? 0 : actual.y - requested.y,
      dw: actual.width - requested.width,
      dh: actual.height - requested.height,
    };
    if (Object.values(d).every((v) => Math.abs(v) <= 16)) offset = d;
  } catch { /* keep no offset */ }

  if (saved && saved.maximized) maximizeOnShow.add(win);

  win.once('ready-to-show', () => {
    if (!startHidden) showWindow(win);
  });

  // Remember size and position (debounced; maximised windows keep their normal bounds).
  let saveTimer = null;
  const saveBounds = () => {
    if (win.isDestroyed() || win.isMinimized()) return;
    const b = win.getNormalBounds();
    try {
      store.set({
        windowBounds: {
          x: b.x - offset.dx,
          y: b.y - offset.dy,
          width: b.width - offset.dw,
          height: b.height - offset.dh,
          // Never shown yet (started hidden): keep the saved choice.
          maximized: win.isMaximized() || maximizeOnShow.has(win),
        },
      });
    } catch (err) {
      log.warn(`Couldn't remember the window position: ${err.message}`);
    }
  };
  const scheduleSave = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveBounds, 500);
  };
  for (const ev of ['resize', 'move', 'maximize', 'unmaximize']) win.on(ev, scheduleSave);

  win.on('close', (e) => {
    clearTimeout(saveTimer);
    saveBounds();
    if (!isQuitting() && store.get().closeToTray && canHideToTray()) {
      e.preventDefault();
      win.hide();
    }
  });

  const wc = win.webContents;

  // Links to websites open in the normal browser; nothing else may open a window.
  wc.setWindowOpenHandler(({ url }) => {
    if (isExternalUrl(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  const guard = (e, legacyUrl) => {
    const url = (e && e.url) || legacyUrl;
    if (isAppUrl(url)) return;
    e.preventDefault();
    if (isExternalUrl(url)) shell.openExternal(url).catch(() => {});
  };
  wc.on('will-navigate', guard);
  wc.on('will-redirect', guard);
  wc.on('will-attach-webview', (e) => e.preventDefault());

  // Keyboard: F12 / Ctrl+Shift+I open developer tools (handy for support), zoom keys work,
  // and reload keys only in dev runs.
  wc.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    const mod = input.control || input.meta;
    const key = String(input.key || '').toLowerCase();
    if (key === 'f12' || (mod && input.shift && key === 'i')) {
      wc.toggleDevTools();
      e.preventDefault();
    } else if (allowReloadKeys && (key === 'f5' || (mod && key === 'r'))) {
      wc.reload();
      e.preventDefault();
    } else if (mod && (key === '=' || key === '+')) {
      wc.setZoomLevel(Math.min(wc.getZoomLevel() + 0.5, 4));
      e.preventDefault();
    } else if (mod && key === '-') {
      wc.setZoomLevel(Math.max(wc.getZoomLevel() - 0.5, -3));
      e.preventDefault();
    } else if (mod && key === '0') {
      wc.setZoomLevel(0);
      e.preventDefault();
    }
  });

  wc.on('preload-error', (_e, file, error) => log.error(`Preload failed (${file}): ${error.message}`));

  win.loadURL(startQuery ? `${START_URL}?${startQuery}` : START_URL).catch((err) => log.error(`Couldn't load the app window: ${err.message}`));
  return win;
}

module.exports = {
  registerScheme,
  registerAppProtocol,
  createMainWindow,
  showWindow,
  findIcon,
  resolveAppPath,
  isAppUrl,
  isExternalUrl,
  APP_ORIGIN,
  START_URL,
  FRAME_COLOR,
  TITLE_BAR_HEIGHT,
  MIME,
};
