// Preview sample data for the app pages (used only when the renderer runs in a plain browser without window.gc).
//
// The Addon & sync page talks to the main process only (gc.addon.*, gc.sync.*, gc.wow.*, gc.log.recent), never to
// server endpoints, so its sample data lives with the IPC mocks in ../mock.js: addonStatus() and syncStatus() there
// return the same shapes as src/main/addon.js status() and src/main/sync.js status() (installs with root, damaged,
// busy, action and error; files with label and lastError; recent sync events). Keep them in step with those modules.
//
// The one server call behind the addon status is the public release list, already sampled in ../mock.js
// ('GET /api/releases'). Nothing extra is registered here.
import { addMockRoutes } from '../mock.js';

addMockRoutes({});
