'use strict';
// Native desktop notifications. Clicking one brings Guild Camp to the front and opens the
// page the event points at.
//
//   const notify = createNotify({ showWindow, broadcast, iconPath, log });
//   notify.show({ title, body, route })   → true when shown
//   notify.test()                         → shows a sample (Settings → "Send a test notification")

const { Notification } = require('electron');

const clip = (text, max) => {
  const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

// Only in-app routes ("/raids/12") are followed from a notification.
const safeRoute = (route) => (typeof route === 'string' && /^\/(?!\/)[^\s]*$/.test(route) && route.length < 300 ? route : null);

/**
 * @param {object} deps
 * @param {() => void} deps.showWindow   show + focus the main window (recreating it if needed)
 * @param {(channel: string, payload: any) => void} deps.broadcast
 * @param {string|null} [deps.iconPath]
 * @param {object} deps.log
 */
function createNotify({ showWindow, broadcast, iconPath, log } = {}) {
  // Windows drops click handlers of notifications that were garbage collected, so keep a
  // reference to recent ones.
  const live = new Set();
  const MAX_LIVE = 50;

  function supported() {
    try { return Notification.isSupported(); } catch { return false; }
  }

  function show(ev = {}) {
    if (!supported()) return false;
    const n = new Notification({
      title: clip(ev.title || 'Guild Camp', 100),
      body: clip(ev.body || '', 280),
      icon: iconPath || undefined,
      silent: false,
    });
    const route = safeRoute(ev.route);
    const forget = () => live.delete(n);
    n.on('click', () => {
      try { showWindow(); } catch { /* window may be gone during quit */ }
      if (route) broadcast('navigate', route);
      forget();
    });
    n.on('close', forget);
    n.on('failed', (_e, error) => {
      log.warn(`A notification couldn't be shown: ${error}`);
      forget();
    });
    live.add(n);
    if (live.size > MAX_LIVE) live.delete(live.values().next().value);
    n.show();
    return true;
  }

  function test() {
    if (!supported()) throw new Error("This computer doesn't support desktop notifications, or they are turned off for Guild Camp.");
    show({
      kind: 'test',
      title: 'Guild Camp',
      body: 'Notifications are working. Raids, calls to arms and requests will show up like this.',
      route: '/settings',
    });
    return { shown: true };
  }

  return { show, test, supported };
}

module.exports = { createNotify, safeRoute };
