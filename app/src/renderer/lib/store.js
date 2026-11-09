// A tiny global store with a Preact hook. Used for the session, toasts, router, top bar and live statuses.
import { useEffect, useReducer, useRef } from './html.js';

export function createStore(initial) {
  let state = initial;
  const subs = new Set();
  return {
    get: () => state,
    // set(value) or set(prev => next). Subscribers run only when the value actually changes.
    set(next) {
      const value = typeof next === 'function' ? next(state) : next;
      if (Object.is(value, state)) return;
      state = value;
      for (const fn of [...subs]) {
        try { fn(state); } catch (err) { console.error(err); }
      }
    },
    // Shallow merge for object state.
    update(patch) { this.set({ ...state, ...patch }); },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
  };
}

// Re-renders the component when the selected slice of the store changes.
export function useStore(store, select) {
  const [, force] = useReducer((n) => n + 1, 0);
  const pick = select || identity;
  const selRef = useRef(pick);
  selRef.current = pick;
  const value = pick(store.get());
  const valRef = useRef(value);
  valRef.current = value;
  useEffect(() => {
    const check = (s) => { if (!Object.is(selRef.current(s), valRef.current)) force(); };
    const off = store.subscribe(check);
    check(store.get()); // catch changes made between render and subscribe
    return off;
  }, [store]);
  return value;
}

const identity = (s) => s;
