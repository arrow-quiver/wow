// Preview sample data for the Settings page (used only when the renderer runs in a plain browser without window.gc).
// Shapes match docs/api/core.md (devices, sync keys), docs/api/discord.md and the admin domain's calendar feed.
// Later registrations win, so these replace the guessed device samples in ../mock.js.
import { addMockRoutes } from '../mock.js';

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const sqlTime = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString().replace('T', ' ').slice(0, 19);
const httpError = (status, message) => Object.assign(new Error(message), { status });
const randomHex = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('').toUpperCase();

// Settings-only state, kept beside the shared mock state.
function local(state) {
  if (!state.settingsMock) {
    state.settingsMock = {
      devices: [
        { id: 11, name: 'CALVIN-PC', platform: 'win32', prefix: 'gcd_Ab3dE5fG', app_version: '0.11.0', addon_version: '0.11.0',
          created_at: sqlTime(20 * DAY), last_used_at: sqlTime(1 * MIN), current: true },
        { id: 12, name: 'LAPTOP', platform: 'win32', prefix: 'gcd_Zz9yX8wV', app_version: '0.10.0', addon_version: null,
          created_at: sqlTime(60 * DAY), last_used_at: sqlTime(8 * DAY), current: false },
      ],
      syncKeys: [{ id: 2, prefix: 'wowg_Q1w2E', created_at: sqlTime(70 * DAY), last_used_at: sqlTime(3 * DAY) }],
      discord: { configured: true, appId: '1234567890', botConfigured: true, linked: false, serverLinked: true },
      calendarToken: null,
    };
  }
  return state.settingsMock;
}

function needSignedIn(state) { if (!state.signedIn) throw httpError(401, 'Sign in first.'); }
function role(state) { return state.members.find((m) => m.id === state.userId)?.role || null; }
function needGuild(state) { needSignedIn(state); if (!state.inGuild || !state.serverGuild) throw httpError(403, 'Join a guild first.'); }
function needOfficer(state) { needGuild(state); if (!['owner', 'officer'].includes(role(state))) throw httpError(403, 'Officers only.'); }

// The calendar feed address in the forms calendar apps want (same as the server's).
function calendarLinks(state, token) {
  const url = `${state.settings.serverUrl}/calendar/${token}.ics`;
  const webcalUrl = url.replace(/^https?:/, 'webcal:');
  return { url, webcalUrl, googleUrl: `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcalUrl)}` };
}

const COMMANDS = ['online', 'raids', 'cta', 'craft', 'price', 'signup', 'link'];

addMockRoutes({
  // ---- devices (core) ----
  'GET /api/devices': ({ state }) => {
    needSignedIn(state);
    const s = local(state);
    return { devices: s.devices, syncKeys: s.syncKeys };
  },
  'DELETE /api/devices/:id': ({ params, state }) => {
    needSignedIn(state);
    const s = local(state);
    const d = s.devices.find((x) => String(x.id) === params.id);
    if (!d) throw httpError(404, 'Device not found.');
    s.devices = s.devices.filter((x) => x !== d);
    return { ok: true, current: !!d.current };
  },
  'DELETE /api/sync-keys/:id': ({ params, state }) => {
    needSignedIn(state);
    const s = local(state);
    if (!s.syncKeys.some((k) => String(k.id) === params.id)) throw httpError(404, 'Sync key not found.');
    s.syncKeys = s.syncKeys.filter((k) => String(k.id) !== params.id);
    return { ok: true };
  },

  // ---- discord ----
  'GET /api/discord': ({ state }) => {
    needSignedIn(state);
    const d = local(state).discord;
    return {
      configured: d.configured,
      app_id: d.configured ? d.appId : null,
      invite_url: d.configured ? `https://discord.com/oauth2/authorize?client_id=${d.appId}&scope=bot%20applications.commands&permissions=8589934592` : null,
      bot_configured: d.botConfigured,
      linked: d.linked,
      server_linked: d.serverLinked && !!state.inGuild,
      commands: COMMANDS,
    };
  },
  'POST /api/discord/link': ({ state }) => {
    needGuild(state);
    const d = local(state).discord;
    if (!d.configured) throw httpError(400, "Discord isn't set up on this server yet. Ask the server owner to add the Discord app details.");
    const code = randomHex(8);
    return {
      code,
      expires_at: new Date(Date.now() + 15 * MIN).toISOString(),
      command: `/link ${code}`,
      linked: d.linked,
      message: `Your link code is ${code}. In your Discord server, type /link ${code} within 15 minutes.`,
    };
  },
  'POST /api/discord/unlink': ({ state }) => {
    needSignedIn(state);
    local(state).discord.linked = false;
    return { ok: true, message: 'Discord unlinked.' };
  },
  'POST /api/discord/register': ({ state }) => {
    needOfficer(state);
    if (!local(state).discord.botConfigured) throw httpError(400, 'The Discord app details aren’t set on the server yet.');
    return { ok: true, registered: COMMANDS.length, message: `${COMMANDS.length} slash commands registered with Discord.` };
  },

  // ---- calendar feed (admin domain) ----
  'GET /api/calendar': ({ state }) => {
    needGuild(state);
    const s = local(state);
    if (!s.calendarToken) s.calendarToken = randomHex(24).toLowerCase();
    return calendarLinks(state, s.calendarToken);
  },
  'POST /api/calendar/reset': ({ state }) => {
    needGuild(state);
    const s = local(state);
    s.calendarToken = randomHex(24).toLowerCase();
    return { ...calendarLinks(state, s.calendarToken), message: 'New calendar link made. Add it to your calendar again; the old link stopped working.' };
  },
});
