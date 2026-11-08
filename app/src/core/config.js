'use strict';
// The core's configuration. The old server read this once from environment variables; here the values
// that can change while the app runs (the player's Anthropic key, the Discord webhook, the Battle.net
// region) are getters, so the ported domain code reads cfg.anthropicKey etc. exactly as before and
// always sees the current setting.
//
//   createConfig({ dataDir, getSecret, getSettings, credentials, fetch, timers, coachWaitMs })
//     dataDir      folder for guildcamp.db and backups/ (':memory:' databases only in tests: dbFile)
//     getSecret    (name) → string|null   'anthropicKey' is the only one read here
//     getSettings  () → app settings: discordWebhook (string|null), bnetRegion ('eu'|'us'|'kr'|'tw')
//     credentials  { clientId, clientSecret } | null   the Battle.net app built into the installer
//     fetch        outside HTTP (Battle.net, Discord, Blizzard, Anthropic); tests pass a stand-in
//     timers       false: never start background jobs (tests)
const path = require('path');

const REGIONS = ['eu', 'us', 'kr', 'tw'];
const WEBHOOK_RE = /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\/[\w/-]+$/;

function createConfig({
  dataDir, dbFile, getSecret, getSettings, credentials, fetch: fetchImpl, timers = true, coachWaitMs,
  coachModel, coachFastModel,
} = {}) {
  const settings = () => {
    try { return (typeof getSettings === 'function' && getSettings()) || {}; } catch { return {}; }
  };
  const secret = (name) => {
    try { return (typeof getSecret === 'function' && getSecret(name)) || ''; } catch { return ''; }
  };
  const creds = credentials && typeof credentials === 'object' ? credentials : null;
  const file = dbFile || (dataDir ? path.join(dataDir, 'guildcamp.db') : ':memory:');
  const cfg = {
    dataDir: dataDir || null,
    dbFile: file,
    timers: timers !== false,
    coachModel: coachModel || 'claude-sonnet-5-5',
    coachFastModel: coachFastModel || 'claude-haiku-5-5',
    fetch: fetchImpl || ((...args) => globalThis.fetch(...args)),
    // The player's own Anthropic API key (Settings → Coach). Without it the Coach still tracks play style.
    get anthropicKey() { return String(secret('anthropicKey') || '').trim(); },
    // Blizzard game data (client credentials flow) with the Battle.net app built into the installer.
    get bnetClientId() { return (creds && creds.clientId) || ''; },
    get bnetClientSecret() { return (creds && creds.clientSecret) || ''; },
    get bnetRegion() {
      const r = String(settings().bnetRegion || 'eu').toLowerCase();
      return REGIONS.includes(r) ? r : 'eu';
    },
    // Each app posts only what its own player does, to the webhook set in Settings.
    get discordWebhook() {
      const url = String(settings().discordWebhook || '').trim();
      return WEBHOOK_RE.test(url) ? url : '';
    },
    // Raid times typed without an offset use this computer's time zone (getTimezoneOffset, minutes).
    get defaultTzOffset() { return new Date().getTimezoneOffset(); },
  };
  if (Number.isFinite(Number(coachWaitMs))) cfg.coachWaitMs = Number(coachWaitMs);
  return cfg;
}

module.exports = { createConfig, REGIONS, WEBHOOK_RE };
