// Discord: the slash-command endpoint Discord calls (POST /discord/interactions), plus the app's
// Settings → Discord calls (status, link codes, unlink) and command registration for officers.
// Ported from the old web/src/routes/phase3.js (mountDiscord + /settings/discord/*).
// Command behaviour lives in services/discord.js. Shapes are documented in docs/api/discord.md.
const D = require('../services/discord');
const { HttpError, needUser, needGuild, needOfficer } = require('../http');

// The bot needs only "Manage Events" (1 << 33) so it can put raids in the server's Events list.
const INVITE_PERMISSIONS = '8589934592';

function inviteUrl(appId) {
  return `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(appId)}&scope=bot%20applications.commands&permissions=${INVITE_PERMISSIONS}`;
}

// What Discord shows when something breaks while answering. Ephemeral: only the caller sees it.
const FAILED_REPLY = { type: 4, data: { content: 'Something went wrong in Guild Camp. Try again in a moment.', flags: 64 } };

function register(app, ctx) {
  const { db, cfg, log } = ctx;
  const q = {
    expiry: db.prepare('SELECT expires_at FROM link_codes WHERE code = ?'),
    unlink: db.prepare('UPDATE users SET discord_id = NULL WHERE id = ?'),
  };
  // Slash commands work once the app's id and public key are set (DISCORD_APP_ID, DISCORD_PUBLIC_KEY).
  const configured = () => Boolean(cfg.discordPublicKey && cfg.discordAppId);
  // Registering commands also needs the bot token (DISCORD_BOT_TOKEN).
  const canRegister = () => Boolean(cfg.discordAppId && cfg.discordBotToken);

  // ---- Discord calls this for every slash command (no bearer token: Discord signs the body) ----
  // app.js keeps /discord bodies raw (a Buffer), rate limits /discord to 120/min and never parses them as JSON.
  app.post('/discord/interactions', (req, res) => {
    if (!cfg.discordPublicKey) return res.status(404).json({ error: 'Not found.' });
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const ok = D.verify(cfg.discordPublicKey, req.get('X-Signature-Ed25519') || '', req.get('X-Signature-Timestamp') || '', raw);
    // Discord sends deliberately bad signatures to check that we refuse them.
    if (!ok) return res.status(401).json({ error: 'Invalid request signature.' });
    let interaction;
    try { interaction = JSON.parse(raw.toString('utf8')); } catch { return res.status(400).json({ error: 'That request was not valid JSON.' }); }
    try {
      res.json(D.handle(db, cfg, interaction, {
        // A call to arms made in Discord is already visible there (the reply is public), so nothing is
        // posted to the webhook. The camp feed and the app's notifications still hear about it.
        onCta: (guild, zone) => {
          ctx.activity(guild.id, 'cta', `Call to arms in ${zone} (from Discord)`);
          ctx.emit(guild.id, 'cta', { title: `⚔️ Call to arms: ${zone}`, body: 'Called from Discord.', route: '/' });
        },
      }));
    } catch (e) {
      log.error('Discord interaction failed:', e && e.stack ? e.stack : e);
      res.json(FAILED_REPLY);
    }
  });

  // ---- Settings → Discord ----
  app.get('/api/discord', needUser, (req, res) => {
    const on = configured();
    res.json({
      configured: on,
      app_id: on ? cfg.discordAppId : null,
      invite_url: on ? inviteUrl(cfg.discordAppId) : null,
      bot_configured: canRegister(),
      linked: Boolean(req.user.discord_id),
      server_linked: Boolean(req.guild && req.guild.discord_server_id),
      commands: D.COMMANDS.map((c) => c.name),
    });
  });

  // A one-time code the member types as /link CODE in the guild's Discord server (valid 15 minutes).
  app.post('/api/discord/link', needGuild, (req, res) => {
    if (!configured()) throw new HttpError(400, "Discord isn't set up on this server yet. Ask the server owner to add the Discord app details.");
    const code = D.newLinkCode(db, req.user.id, req.guild.id);
    const row = q.expiry.get(code);
    res.json({
      code,
      expires_at: row ? row.expires_at : null,
      command: `/link ${code}`,
      linked: Boolean(req.user.discord_id),
      message: `Your link code is ${code}. In your Discord server, type /link ${code} within 15 minutes.`,
    });
  });

  app.post('/api/discord/unlink', needUser, (req, res) => {
    q.unlink.run(req.user.id);
    res.json({ ok: true, message: 'Discord unlinked.' });
  });

  // Sends the slash command list to Discord (needed once, and after commands change).
  app.post('/api/discord/register', needOfficer, async (req, res) => {
    if (!canRegister()) throw new HttpError(400, 'The Discord app details aren’t set on the server yet.');
    let n;
    try {
      n = await D.registerCommands(cfg);
    } catch (e) {
      // HttpError 502 carries Discord's own answer ("Discord said 401: ..."). Anything else means
      // Discord couldn't be reached at all (network down, timeout).
      if (e instanceof HttpError) throw e;
      log.warn('Discord command registration failed:', e && e.message);
      throw new HttpError(502, "Couldn't reach Discord. Try again in a minute.");
    }
    ctx.audit(req, 'Discord commands registered', String(n));
    res.json({ ok: true, registered: n, message: `${n} slash commands registered with Discord.` });
  });
}

module.exports = { register, inviteUrl };
