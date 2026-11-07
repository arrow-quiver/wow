// Server configuration, read once from the environment.
// Every option is documented in server/.env.example.
const path = require('path');

function config(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const dbFile = env.DB_FILE || path.join(__dirname, '..', 'data', 'wow.db');
  return {
    env: env.NODE_ENV || 'development',
    port: Number(env.PORT || 3000),
    // Public address, no trailing slash. Battle.net redirects back to <baseUrl>/auth/bnet/callback.
    baseUrl: (env.BASE_URL || 'http://localhost:3000').replace(/\/+$/, ''),
    // Signs the Battle.net sign-in state. Required in production (createApp refuses to start without it).
    sessionSecret: env.SESSION_SECRET || (production ? null : 'dev-secret-change-me'),
    dbFile,
    bnetClientId: env.BNET_CLIENT_ID || '',
    bnetClientSecret: env.BNET_CLIENT_SECRET || '',
    bnetRegion: (env.BNET_REGION || 'eu').toLowerCase(),
    // DEV_LOGIN=1 lets anyone sign in by typing a BattleTag. Local testing only.
    devLogin: env.DEV_LOGIN === '1',
    // Used only when a client doesn't send its own offset. -120 = South Africa (UTC+2).
    defaultTzOffset: Number(env.DEFAULT_TZ_OFFSET ?? -120),
    // Background jobs (reminders, game data, backups, coach). Never started in tests.
    timers: env.NODE_ENV !== 'test',
    // Discord app (slash commands). From discord.com/developers/applications.
    discordAppId: env.DISCORD_APP_ID || '',
    discordPublicKey: env.DISCORD_PUBLIC_KEY || '',
    discordBotToken: env.DISCORD_BOT_TOKEN || '',
    // Coach (Claude API). Without a key the Coach still tracks play style; AI features are off.
    anthropicKey: env.ANTHROPIC_API_KEY || '',
    coachModel: env.COACH_MODEL || 'claude-sonnet-5-5',
    coachFastModel: env.COACH_FAST_MODEL || 'claude-haiku-5-5',
    // Lets release tooling (scripts/release.js, CI) publish without an owner's device token.
    publishToken: env.PUBLISH_TOKEN || '',
    // Published app installers and addon zips. /data/updates in Docker.
    updatesDir: env.UPDATES_DIR || path.join(path.dirname(path.resolve(dbFile === ':memory:' ? 'memory.db' : dbFile)), 'updates'),
    // The addon shipped with the server, offered until the first addon release is published.
    // Repo layout: server/src → ../../addon/WowGuild. Docker: /srv/server/src → /srv/addon/WowGuild.
    bundledAddonDir: env.BUNDLED_ADDON_DIR || path.resolve(__dirname, '..', '..', 'addon', 'WowGuild'),
    // Outside HTTP (Battle.net, Discord, Blizzard, Anthropic). Tests pass a stand-in.
    fetch: (...args) => globalThis.fetch(...args),
  };
}

module.exports = { config };
