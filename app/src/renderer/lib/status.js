// Live statuses pushed by the main process: sync engine, app updater and addon manager.
// Each hook loads the current status once and then follows the event channel.
//   const sync = useSyncStatus();      // gc.sync.status() shape, or null while loading
//   const upd = useUpdaterStatus();    // gc.updater.status() shape
//   const addon = useAddonStatus();    // gc.addon.status() shape
import { gc } from './gc.js';
import { useEffect } from './html.js';
import { createStore, useStore } from './store.js';

function liveStatus(channel, fetchStatus, looksComplete) {
  const store = createStore(null);
  let started = false;
  const refresh = () => fetchStatus().then((s) => { if (s) store.set(s); return s; }, () => store.get());
  function start() {
    if (started) return;
    started = true;
    gc.on(channel, (payload) => {
      // Events normally carry the whole status; anything else is a hint to ask again.
      if (payload && typeof payload === 'object' && looksComplete(payload)) store.set(payload);
      else refresh();
    });
    refresh();
  }
  function use() {
    useEffect(start, []);
    return useStore(store);
  }
  return { store, start, refresh, use, get: () => store.get() };
}

export const syncStatus = liveStatus('sync', () => gc.sync.status(), (p) => 'state' in p);
export const updaterStatus = liveStatus('updater', () => gc.updater.status(), (p) => 'state' in p);
export const addonStatus = liveStatus('addon', () => gc.addon.status(), (p) => Array.isArray(p.installs));

export const useSyncStatus = () => syncStatus.use();
export const useUpdaterStatus = () => updaterStatus.use();
export const useAddonStatus = () => addonStatus.use();

// Plain-English summary of a sync status for badges: { kind: 'ok'|'warn'|'alarm'|'info'|'muted', label }.
export function describeSync(s) {
  if (!s) return { kind: 'muted', label: 'Checking sync…' };
  switch (s.state) {
    case 'syncing': return { kind: 'info', label: 'Syncing…' };
    case 'error': return { kind: 'alarm', label: 'Sync problem' };
    case 'no-game': return { kind: 'warn', label: 'Game not found' };
    case 'no-guild': return { kind: 'warn', label: 'Waiting to match your guild' };
    case 'signed-out': return { kind: 'muted', label: 'Signed out' };
    case 'off': return { kind: 'muted', label: 'Sync is off' };
    default: return s.lastSyncAt ? { kind: 'ok', label: 'Synced', at: s.lastSyncAt } : { kind: 'ok', label: 'Waiting for the game' };
  }
}

// What the sidebar badge should say about updates, or null when there is nothing to do.
export function describeUpdates(updater, addon) {
  if (updater) {
    if (updater.state === 'downloaded') return { route: '/updates', label: 'Restart to update', kind: 'accent' };
    if (updater.state === 'downloading') {
      const pct = updater.progress && updater.progress.percent != null ? ` ${Math.round(updater.progress.percent)}%` : '';
      return { route: '/updates', label: `Downloading update${pct}`, kind: 'info' };
    }
    if (updater.state === 'available') return { route: '/updates', label: `App update ${updater.available?.version || ''}`.trim(), kind: 'accent' };
  }
  if (addon && Array.isArray(addon.installs)) {
    const outdated = addon.installs.filter((i) => i.state === 'outdated').length;
    if (outdated) return { route: '/addon', label: outdated === 1 ? 'Addon update' : `${outdated} addon updates`, kind: 'accent' };
  }
  return null;
}
