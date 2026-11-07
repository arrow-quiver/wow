// Thin wrapper over window.gc (the preload bridge). Every call returns a Promise and rejects with an Error
// whose `message` is a plain sentence and whose `status` is the HTTP status for server errors.
//
//   import { gc, useGcEvent } from '../lib/gc.js';
//   await gc.sync.now();                 // same as gc.invoke('sync.now')
//   const off = gc.on('sync', (status) => ...);
//
// When window.gc is missing (the renderer opened in a plain browser for previews), a dev mock with sample data
// is loaded instead. It is never loaded inside the app.
import { useEffect, useRef } from './html.js';

// The IPC surface from docs/ARCHITECTURE.md ("IPC surface"), plus app.rendererReady (used by the smoke test).
export const METHODS = [
  'app.info', 'app.openExternal', 'app.openPath', 'app.showItemInFolder', 'app.pickFolder', 'app.quit', 'app.relaunch',
  'app.rendererReady',
  'log.recent',
  'settings.get', 'settings.set',
  'auth.state', 'auth.signIn', 'auth.devSignIn', 'auth.signOut',
  'api.request', 'api.download',
  'wow.installs', 'wow.addFolder', 'wow.removeFolder', 'wow.detectGuild',
  'guild.autoJoin', 'membership.status',
  'sync.status', 'sync.now', 'sync.setEnabled',
  'addon.status', 'addon.check', 'addon.install', 'addon.update', 'addon.updateAll', 'addon.repair', 'addon.uninstall',
  'addon.openFolder',
  'updater.status', 'updater.check', 'updater.download', 'updater.install',
  'publisher.status', 'publisher.publishAddon', 'publisher.publishApp', 'publisher.setRepoDir', 'publisher.cancel',
  'notify.test',
];

export const CHANNELS = ['auth', 'sync', 'addon', 'updater', 'publisher:log', 'server-event', 'navigate', 'log', 'settings', 'membership'];

const bridge = (typeof window !== 'undefined' && window.gc) || await (async () => {
  const m = await import('./mock.js');
  await import('./mocks/index.js'); // domain sample data registers itself
  return m.createMock();
})();
export const isMock = !(typeof window !== 'undefined' && window.gc);

// Electron prefixes errors thrown in the main process ("Error invoking remote method 'gc:invoke': Error: ...").
// People should only ever see the sentence itself.
export function toError(err) {
  if (err instanceof Error && err.__gc) return err;
  let message = typeof err === 'string' ? err : err && err.message ? String(err.message) : '';
  let status = err && typeof err === 'object' && err.status != null ? Number(err.status) : undefined;
  message = message.replace(/^Error invoking remote method '[^']*':\s*/, '').replace(/^(?:[A-Za-z]*Error):\s*/, '');
  // Some bridges encode the status as a "[404] message" prefix.
  const tagged = message.match(/^\[(\d{3})\]\s*(.*)$/s);
  if (tagged) { status = status ?? Number(tagged[1]); message = tagged[2]; }
  if (!message) message = 'Something went wrong. Please try again.';
  const out = new Error(message);
  out.__gc = true;
  if (status != null && !Number.isNaN(status)) out.status = status;
  if (err && typeof err === 'object' && err.code) out.code = err.code;
  return out;
}

export function invoke(method, ...args) {
  return new Promise((resolve, reject) => {
    try {
      Promise.resolve(bridge.invoke(method, ...args)).then(resolve, (e) => reject(toError(e)));
    } catch (e) {
      reject(toError(e));
    }
  });
}

// Subscribe to a main-process event channel. Returns an unsubscribe function.
export function on(channel, cb) {
  const off = bridge.on(channel, cb);
  return typeof off === 'function' ? off : () => {};
}

export const gc = { invoke, on, isMock };
for (const name of METHODS) {
  const [ns, fn] = name.split('.');
  (gc[ns] ||= {})[fn] = (...args) => invoke(name, ...args);
}

// Hook: run cb for every event on a channel while the component is mounted. cb may change between renders.
export function useGcEvent(channel, cb) {
  const ref = useRef(cb);
  ref.current = cb;
  useEffect(() => on(channel, (payload) => ref.current && ref.current(payload)), [channel]);
}

export default gc;
