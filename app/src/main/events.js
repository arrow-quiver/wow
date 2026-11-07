'use strict';
// Polls the server's event feed (GET /api/events?after=<id>) while signed in, forwards each
// event to the renderer ('server-event') and shows a desktop notification for it.
//
//   const events = createEvents({ api, store, notify, broadcast, log });
//   events.start(); events.stop(); await events.poll();
//   events.on('event', (ev) => ...)   // main.js uses this to react to 'release' events
//
// Plain Node (no Electron): notify and broadcast are injected.
//
// The very first poll for a server has no "after": it only records where the feed is (latestId),
// so a new install does not replay two weeks of old news. lastEventId is kept in settings so
// events that happened while the app was closed still arrive on the next start.
// stop() (sign-out) and a new server address forget what this session learned about the feed, so the
// next poll with a cursor of 0 (ipc.js clears it when the server changes) is a first look again
// instead of a replay of the new server's last two weeks.

const { EventEmitter } = require('events');

const POLL_MS = 20000;
const MAX_POPUPS = 3; // a burst of events shows at most this many popups plus one summary
const STALE_MS = 6 * 60 * 60 * 1000; // older events still reach the app, but without a popup
const PAGE_SIZE = 100; // the server returns at most this many per call

function eventTime(ev) {
  const raw = ev.createdAt || ev.created_at || ev.at || null;
  if (!raw) return null;
  // SQLite "YYYY-MM-DD HH:MM:SS" strings are UTC.
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw) ? `${raw.replace(' ', 'T')}Z` : raw;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

function readFeed(data) {
  const list = Array.isArray(data) ? data : (data && Array.isArray(data.events) ? data.events : []);
  const events = list
    .filter((e) => e && typeof e === 'object' && Number.isFinite(Number(e.id)))
    .map((e) => ({ ...e, id: Number(e.id) }))
    .sort((a, b) => a.id - b.id);
  const maxId = events.reduce((m, e) => Math.max(m, e.id), 0);
  const latestId = data && !Array.isArray(data) && Number.isFinite(Number(data.latestId)) ? Number(data.latestId) : null;
  return { events, maxId, latestId };
}

/**
 * @param {object} deps
 * @param {object} deps.api
 * @param {object} deps.store
 * @param {{ show(ev): any }} deps.notify
 * @param {(channel: string, payload: any) => void} deps.broadcast
 * @param {object} deps.log
 * @param {number} [deps.intervalMs=20000]
 * @param {() => number} [deps.now]
 */
function createEvents({ api, store, notify, broadcast, log, intervalMs = POLL_MS, now = Date.now } = {}) {
  const emitter = new EventEmitter();
  let timer = null;
  let busy = null;
  let primed = false; // this session already learned where the feed is
  let failing = false;

  const serverOf = () => (store.get() || {}).serverUrl || '';
  if (store && typeof store.on === 'function') {
    store.on('change', (_settings, keys) => {
      if (Array.isArray(keys) && keys.includes('serverUrl')) primed = false;
    });
  }

  function deliver(fresh) {
    for (const ev of fresh) {
      try { broadcast('server-event', ev); } catch { /* renderer not ready */ }
      emitter.emit('event', ev);
    }
    if (!store.get().notifications || !notify) return;
    const recent = fresh.filter((ev) => {
      const t = eventTime(ev);
      return t === null || now() - t < STALE_MS;
    });
    recent.slice(0, MAX_POPUPS).forEach((ev) => {
      try { notify.show(ev); } catch (err) { log.warn(`Couldn't show a notification: ${err.message}`); }
    });
    const extra = recent.length - MAX_POPUPS;
    if (extra > 0) {
      try {
        notify.show({ kind: 'summary', title: 'Guild Camp', body: `${extra} more update${extra === 1 ? '' : 's'} from your guild.`, route: '/' });
      } catch { /* ignore */ }
    }
  }

  // Server rules (docs/api/core.md): always send back the latestId from the previous answer (it
  // also moves past events meant for other members); a latestId below ours means the database was
  // replaced, so adopt it; a full page (100) means more are waiting.
  async function pollOnce() {
    let cursor = Number(store.get().lastEventId) || 0;
    const server = serverOf();
    const fresh = [];
    try {
      for (let page = 0; page < 5; page++) {
        const firstLook = !cursor && !primed;
        const data = await api.request('GET', firstLook ? '/api/events' : `/api/events?after=${cursor}`);
        // The server address changed while we waited: this answer belongs to the old server.
        if (serverOf() !== server) break;
        const { events, maxId, latestId } = readFeed(data);
        const next = latestId !== null ? latestId : Math.max(cursor, maxId);

        if (!next) {
          // Not in a guild yet (or an empty feed): look again from scratch next time, so joining
          // a guild does not replay its last two weeks.
          primed = false;
          if (cursor) store.set({ lastEventId: 0 });
          break;
        }
        primed = true;
        if (next !== cursor) store.set({ lastEventId: next });
        if (firstLook) break; // only learn where the feed is

        fresh.push(...events.filter((e) => e.id > cursor));
        cursor = next;
        if (events.length < PAGE_SIZE) break;
      }
    } finally {
      // Delivered once per poll (so a burst is summarised), even if a later page failed.
      if (fresh.length) deliver(fresh);
    }
    return fresh;
  }

  /** Runs one poll (never two at once). Resolves with the new events. */
  function poll() {
    if (busy) return busy;
    busy = pollOnce()
      .then((fresh) => {
        if (failing) log.info('Guild updates are coming through again.');
        failing = false;
        return fresh;
      })
      .catch((err) => {
        // One line per outage, not one every 20 seconds.
        if (!failing && err.status !== 401) log.warn(`Couldn't check for guild updates: ${err.message}`);
        failing = true;
        return [];
      })
      .finally(() => { busy = null; });
    return busy;
  }

  function start() {
    if (timer) return;
    timer = setInterval(poll, intervalMs);
    if (timer.unref) timer.unref();
    poll();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    // Next start learns the feed again. A stored cursor still resumes straight away (polls with
    // ?after=); only a cursor of 0 (new server, or no guild yet) gets a fresh first look.
    primed = false;
  }

  /** Forget the feed position (the server address changed). */
  function reset() {
    primed = false;
    store.set({ lastEventId: 0 });
  }

  return Object.assign(emitter, { start, stop, poll, reset, running: () => Boolean(timer) });
}

module.exports = { createEvents, readFeed, eventTime };
