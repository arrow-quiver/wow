// Calls to arms on the guild's Discord. Like every Guild Camp post, an app only posts its own player's calls, so
// each call goes out once. A call can reach this app three ways, and the first one posts it:
//   - made in the app (POST /api/ctas): at once;
//   - made in game: the addon says it in guild chat and the app reads it from the chat log (POST /api/ctas/discord);
//   - made in game with chat logging off: the next upload brings it (ctas row of mine), posted by sweep().
//
//   post(db, ctx, guildId, { character, zone, needed, message }) → true (posted) | false (no webhook, too old or done)
//   sweep(db, ctx, guildId, userId) → how many of my recent calls were posted
const SAME_MS = 15 * 60 * 1000;   // the same character, zone and message within 15 minutes is the same call
const RECENT_SQL = "datetime('now', '-15 minutes')";

const clean = (s) => String(s || '').replace(/[*_~`|>@]/g, '').trim();
const fp = (c) => [c.character, c.zone, c.message].map((x) => String(x || '').trim().toLowerCase()).join('|');

function text(c) {
  const need = c.needed ? `, ${c.needed} needed` : '';
  return `📣 **Call to arms** from **${clean(c.character) || 'a guildmate'}**: **${clean(c.zone)}**${need}${c.message ? `. "${clean(c.message).slice(0, 200)}"` : ''}`;
}

// Claims a call for posting: true if nobody posted the same call in the last 15 minutes (it is now taken), false
// if it was. The sharing engine's own post (when the addon actually sends the record) claims it too.
function claim(db, guildId, c) {
  const key = fp(c);
  const now = Date.now();
  const prev = db.prepare('SELECT at FROM cta_discord WHERE guild_id = ? AND fp = ?').get(guildId, key);
  if (prev && now - prev.at < SAME_MS) return false;
  db.prepare('INSERT INTO cta_discord (guild_id, fp, at) VALUES (?, ?, ?) ON CONFLICT(guild_id, fp) DO UPDATE SET at = excluded.at').run(guildId, key, now);
  return now;
}

async function post(db, ctx, guildId, c) {
  if (!ctx.cfg.discordWebhook || !c || !c.zone) return false;
  const at = claim(db, guildId, c);
  if (!at) return false;
  const ok = await ctx.discord(null, text(c));
  if (!ok) db.prepare('DELETE FROM cta_discord WHERE guild_id = ? AND fp = ? AND at = ?').run(guildId, fp(c), at);
  return Boolean(ok);
}

async function sweep(db, ctx, guildId, userId) {
  if (!ctx.cfg.discordWebhook) return 0;
  const rows = db.prepare(`SELECT * FROM ctas WHERE guild_id = ? AND user_id = ? AND discord_posted = 0 AND created_at > ${RECENT_SQL}`).all(guildId, userId);
  let n = 0;
  for (const r of rows) {
    if (await post(db, ctx, guildId, r)) n += 1;
    db.prepare('UPDATE ctas SET discord_posted = 1 WHERE id = ?').run(r.id);
  }
  // Older ones (from before this, or while offline) never go out.
  db.prepare(`UPDATE ctas SET discord_posted = 1 WHERE guild_id = ? AND user_id = ? AND discord_posted = 0 AND created_at <= ${RECENT_SQL}`).run(guildId, userId);
  return n;
}

module.exports = { post, sweep, claim, text, fp, SAME_MS };
