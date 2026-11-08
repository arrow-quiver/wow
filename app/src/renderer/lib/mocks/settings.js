// Preview sample data for the Settings page (used only when the renderer runs in a plain browser without window.gc).
//
// Settings talks to the main process (settings.get/set with discordWebhook and bnetRegion, secrets.set/has for the
// Anthropic API key, calendar.export, auth.* for Battle.net) and to the local core's GET /api/me and
// PUT /api/me/notifications. All of those are sampled in ../mock.js, so nothing extra is registered here.
// (Devices, sync keys, Discord link codes and the calendar feed address are gone with the server.)
import { addMockRoutes } from '../mock.js';

addMockRoutes({});
