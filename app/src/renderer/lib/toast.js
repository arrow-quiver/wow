// Global toast queue. Render <Toasts/> once (the app shell does); call toast() from anywhere.
//   toast('Saved.', 'ok');   toast(err.message, 'alarm');
// Kinds: 'info' (default), 'ok', 'warn', 'alarm'.
import { createStore } from './store.js';

export const toastStore = createStore([]);
let nextId = 1;
const timers = new Map();

export function toast(message, kind = 'info', { timeout } = {}) {
  if (!message) return 0;
  const id = nextId++;
  const ms = timeout ?? (kind === 'alarm' ? 8000 : kind === 'warn' ? 6000 : 4000);
  // Keep the newest five; a sixth pushes the oldest out.
  toastStore.set((list) => [...list.slice(-4), { id, message: String(message), kind }]);
  if (ms > 0) timers.set(id, setTimeout(() => dismiss(id), ms));
  return id;
}

export function dismiss(id) {
  clearTimeout(timers.get(id));
  timers.delete(id);
  toastStore.set((list) => list.filter((t) => t.id !== id));
}

// Pause auto-dismiss while the pointer is over a toast, so it can be read.
export function hold(id) {
  clearTimeout(timers.get(id));
  timers.delete(id);
}
export function release(id, ms = 2500) {
  if (!toastStore.get().some((t) => t.id === id)) return;
  timers.set(id, setTimeout(() => dismiss(id), ms));
}
