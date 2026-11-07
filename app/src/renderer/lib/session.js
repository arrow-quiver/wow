// Who is signed in, to which guild, with which role. Comes from gc.auth.state() and refreshes on 'auth' events.
//   const { user, guild, role, isOfficer, isOwner, signedIn, refresh } = useSession();
import { gc } from './gc.js';
import { createStore, useStore } from './store.js';

const EMPTY = { loaded: false, signedIn: false, server: null, user: null, guild: null, role: null };
export const sessionStore = createStore(EMPTY);

export function setSession(state) {
  const s = state && typeof state === 'object' ? state : {};
  sessionStore.set({
    loaded: true,
    signedIn: !!s.signedIn,
    server: s.server ?? null,
    user: s.signedIn ? s.user ?? null : null,
    guild: s.signedIn ? s.guild ?? null : null,
    role: s.signedIn ? s.role ?? null : null,
  });
  return sessionStore.get();
}

// refreshSession() reads the main process's cached state; refreshSession({ fromServer: true }) has it reload the
// profile (GET /api/me) first, so a role changed by an officer elsewhere shows up (the nav, officer pages).
const inflight = { cached: null, server: null };
export function refreshSession({ fromServer = false } = {}) {
  const key = fromServer ? 'server' : 'cached';
  if (!inflight[key]) {
    inflight[key] = (fromServer ? gc.auth.state({ refresh: true }) : gc.auth.state())
      .then((s) => setSession(s))
      .finally(() => { inflight[key] = null; });
  }
  return inflight[key];
}

export function getSession() { return withRoles(sessionStore.get()); }

function withRoles(s) {
  return {
    ...s,
    isOwner: s.role === 'owner',
    isOfficer: s.role === 'owner' || s.role === 'officer',
    refresh: () => refreshSession(),
  };
}

// The 'auth' event usually carries the new state; if it does not, ask for it.
gc.on('auth', (payload) => {
  if (payload && typeof payload === 'object' && 'signedIn' in payload) setSession(payload);
  else refreshSession().catch(() => {});
});

export function useSession() {
  return withRoles(useStore(sessionStore));
}
