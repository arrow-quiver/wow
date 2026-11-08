// Preview sample data for the app pages (used only when the renderer runs in a plain browser without window.gc).
//
// The Addon & sync, Updates and Releases pages talk to the main process only (gc.addon.*, gc.sync.*, gc.wow.*,
// gc.updater.*, gc.publisher.*, gc.log.recent), never to the local core, so their sample data lives with the IPC
// mocks in ../mock.js: addonStatus(), syncStatus() and publisherStatus() there return the same shapes as
// src/main/addon.js, src/main/sync.js and src/main/publisher.js status() (addon releases come from GitHub).
// Keep them in step with those modules. Nothing extra is registered here.
import { addMockRoutes } from '../mock.js';

addMockRoutes({});
