'use strict';
// Exposes window.gc to the renderer. Runs sandboxed: only require('electron') is available here,
// so the method and channel lists are written out below (a unit test checks they match
// METHOD_NAMES / EVENT_CHANNELS in src/main/ipc.js).
//
//   await gc.invoke('sync.now')        same as   await gc.sync.now()
//   const off = gc.on('sync', (status) => ...); off();
//
// Every call returns a Promise. Failures reject with a plain object { message, status? }.

const { contextBridge, ipcRenderer } = require('electron');

const METHODS = [
  'app.info', 'app.openExternal', 'app.openPath', 'app.showItemInFolder', 'app.pickFolder',
  'app.quit', 'app.relaunch', 'app.rendererReady',
  'log.recent',
  'settings.get', 'settings.set',
  'auth.state', 'auth.signIn', 'auth.devSignIn', 'auth.signOut',
  'api.request', 'api.download',
  'wow.installs', 'wow.addFolder', 'wow.removeFolder', 'wow.detectGuild',
  'guild.autoJoin', 'membership.status',
  'sync.status', 'sync.now', 'sync.setEnabled',
  'addon.status', 'addon.check', 'addon.install', 'addon.update', 'addon.updateAll', 'addon.repair', 'addon.uninstall', 'addon.openFolder',
  'updater.status', 'updater.check', 'updater.download', 'updater.install',
  'publisher.status', 'publisher.publishAddon', 'publisher.publishApp', 'publisher.setRepoDir', 'publisher.cancel',
  'notify.test',
];

const CHANNELS = ['auth', 'sync', 'addon', 'updater', 'publisher:log', 'server-event', 'navigate', 'log', 'settings', 'membership'];

async function invoke(method, ...args) {
  if (typeof method !== 'string' || !METHODS.includes(method)) {
    throw { message: `Guild Camp doesn't know how to "${String(method).slice(0, 60)}".`, status: 404 };
  }
  let res;
  try {
    res = await ipcRenderer.invoke('gc:invoke', method, ...args);
  } catch (err) {
    // Arguments that can't be sent (functions, DOM nodes) or the main process going away.
    throw { message: (err && err.message) || 'Guild Camp could not complete that.' };
  }
  if (res && res.ok) return res.value;
  const error = (res && res.error) || {};
  const out = { message: typeof error.message === 'string' && error.message ? error.message : 'Something went wrong.' };
  if (Number.isInteger(error.status)) out.status = error.status;
  if (typeof error.code === 'string') out.code = error.code;
  throw out;
}

// One IPC listener fans out to every subscriber of a channel.
const listeners = new Map(CHANNELS.map((c) => [c, new Set()]));

ipcRenderer.on('gc:event', (_event, channel, payload) => {
  const set = listeners.get(channel);
  if (!set) return;
  for (const cb of [...set]) {
    try {
      cb(payload);
    } catch (err) {
      console.error(`gc.on('${channel}') listener failed:`, err);
    }
  }
});

function on(channel, cb) {
  if (!listeners.has(channel)) throw new Error(`Unknown event channel "${String(channel).slice(0, 40)}".`);
  if (typeof cb !== 'function') throw new Error('gc.on needs a callback function.');
  listeners.get(channel).add(cb);
  return () => { listeners.get(channel).delete(cb); };
}

// gc.sync.now(...) → invoke('sync.now', ...), and so on for every method.
const api = { invoke, on, platform: process.platform, methods: METHODS.slice(), channels: CHANNELS.slice() };
for (const name of METHODS) {
  const [ns, fn] = name.split('.');
  if (!api[ns]) api[ns] = {};
  api[ns][fn] = (...args) => invoke(name, ...args);
}

contextBridge.exposeInMainWorld('gc', api);
