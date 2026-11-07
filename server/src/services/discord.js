// Discord slash commands, delivered by Discord to POST /discord/interactions, plus account link
// codes and native Discord scheduled events for raids. Ported from the old web/src/discord.js.
// No gateway connection or extra process: Discord calls the server, the server answers.
//
// Exports
//   verify(publicKeyHex, signatureHex, timestamp, rawBody: Buffer) → boolean   Ed25519 check of an interaction
//   handle(db, cfg, interaction, { onCta }) → interaction response object (send as JSON)
//       PING → { type: 1 }; autocomplete (/signup raid) → { type: 8, data: { choices } }; commands → { type: 4, data }.
//       Answers /online /raids /craft /price for anyone in a connected server; /cta and /signup need a linked
//       account; /link <code> links one. Never throws for bad input (the route still wraps it in try/catch).
//   registerCommands(cfg, fetchImpl?) → number of commands Discord accepted   throws HttpError 502 when Discord refuses
//   COMMANDS                       the slash command definitions
//   newLinkCode(db, userId, guildId) → 8-character code, valid 15 minutes (replaces the user's older codes)
//   createEvent(cfg, serverId, raid, url, fetchImpl?) → Discord event id   throws HttpError 502 when Discord refuses
//   deleteEvent(cfg, serverId, eventId, fetchImpl?)   best effort
//
// Injected dependencies
//   cfg: baseUrl, discordAppId, discordBotToken, fetch (outside HTTP; fetchImpl wins, then cfg.fetch, then global fetch).
//   handle's onCta(guild, zone) is called after /cta stores a call to arms (the reply already shows it in Discord).
//     Routes use it for the activity line and the app notification:
//       ctx.activity(guild.id, 'cta', `Call to arms in ${zone} (from Discord)`)
//       ctx.emit(guild.id, 'cta', { title: `⚔️ Call to arms: ${zone}`, body: 'Called from Discord.', route: '/' })
const crypto = require('crypto');
const { searchPrices, money } = require('./economy');
const { HttpError } = require('../http');

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const API = 'https://discord.com/api/v10';
const fetcher = (cfg, fetchImpl) => fetchImpl || (cfg && cfg.fetch) || globalThis.fetch;

function verify(publicKeyHex, signatureHex, timestamp, rawBody) {
  try {
    const key = crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKeyHex, 'hex')]), format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.concat([Buffer.from(String(timestamp)), rawBody]), key, Buffer.from(String(signatureHex), 'hex'));
  } catch { return false; }
}

const STRING = 3; const INTEGER = 4;
const COMMANDS = [
  { name: 'online', description: 'Who from the guild is online right now' },
  { name: 'raids', description: 'Upcoming raids and events' },
  { name: 'cta', description: 'Call guildies to a fight', options: [
    { type: STRING, name: 'zone', description: 'Where', required: true, max_length: 60 },
    { type: INTEGER, name: 'needed', description: 'How many you need', min_value: 1, max_value: 40 },
    { type: STRING, name: 'message', description: 'What’s happening', max_length: 200 }] },
  { name: 'craft', description: 'Who in the guild can craft something', options: [
    { type: STRING, name: 'item', description: 'Recipe name or part of it', required: true, max_length: 60 }] },
  { name: 'price', description: 'Latest auction price from guild scans', options: [
    { type: STRING, name: 'item', description: 'Item name', required: true, max_length: 60 }] },
  { name: 'signup', description: 'Sign up for a raid or event', options: [
    { type: STRING, name: 'raid', description: 'Which one', required: true, autocomplete: true },
    { type: STRING, name: 'role', description: 'Your role', required: true, choices: [
      { name: 'Tank', value: 'tank' }, { name: 'Healer', value: 'healer' }, { name: 'Damage', value: 'dps' }] },
    { type: STRING, name: 'status', description: 'Coming?', choices: [
      { name: 'Coming', value: 'yes' }, { name: 'Maybe', value: 'tentative' }, { name: 'Can’t make it', value: 'no' }] },
    { type: STRING, name: 'character', description: 'Character (defaults to your main)', max_length: 40 }] },
  { name: 'link', description: 'Link your Discord to your Guild Camp account', options: [
    { type: STRING, name: 'code', description: 'Code from Settings in the Guild Camp app', required: true, max_length: 20 }] },
];

async function registerCommands(cfg, fetchImpl) {
  const res = await fetcher(cfg, fetchImpl)(`${API}/applications/${cfg.discordAppId}/commands`, {
    method: 'PUT',
    headers: { Authorization: `Bot ${cfg.discordBotToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(COMMANDS),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new HttpError(502, `Discord said ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).length;
}

const reply = (content, { ephemeral = false } = {}) => ({
  type: 4, data: { content: content.slice(0, 1990), allowed_mentions: { parse: [] }, ...(ephemeral ? { flags: 64 } : {}) },
});
const opt = (i, name) => {
  const o = ((i.data && i.data.options) || []).find((x) => x.name === name);
  return o ? o.value : undefined;
};
const unix = (iso) => Math.floor(new Date(iso).getTime() / 1000);
const MAIN = 'SELECT name FROM characters WHERE guild_id = ? AND user_id = ? ORDER BY is_main DESC, level DESC LIMIT 1';

function handle(db, cfg, i, { onCta } = {}) {
  if (!i || typeof i !== 'object') return reply('Unsupported interaction.', { ephemeral: true });
  if (i.type === 1) return { type: 1 }; // PING
  const discordUser = (i.member && i.member.user) || i.user || {};
  const serverId = i.guild_id || null;
  const user = discordUser.id ? db.prepare('SELECT * FROM users WHERE discord_id = ?').get(String(discordUser.id)) : null;
  let guild = serverId ? db.prepare('SELECT * FROM guilds WHERE discord_server_id = ?').get(String(serverId)) : null;
  if (!guild && user) guild = db.prepare('SELECT g.* FROM guilds g JOIN memberships m ON m.guild_id = g.id WHERE m.user_id = ? LIMIT 1').get(user.id);

  // Autocomplete for /signup raid
  if (i.type === 4) {
    if (!guild) return { type: 8, data: { choices: [] } };
    const q = String(opt(i, 'raid') || '').toLowerCase();
    const raids = db.prepare(`SELECT id, title, starts_at FROM raids WHERE guild_id = ? AND status IN ('open','locked') AND starts_at > ? ORDER BY starts_at LIMIT 25`)
      .all(guild.id, new Date(Date.now() - 3 * 3600000).toISOString());
    return { type: 8, data: { choices: raids.filter((r) => r.title.toLowerCase().includes(q)).slice(0, 25)
      .map((r) => ({ name: `${r.title} (${new Date(r.starts_at).toUTCString().slice(0, 22)} UTC)`.slice(0, 100), value: String(r.id) })) } };
  }
  if (i.type !== 2 || !i.data) return reply('Unsupported interaction.', { ephemeral: true });
  const name = i.data.name;

  if (name === 'link') {
    const code = String(opt(i, 'code') || '').trim().toUpperCase();
    const row = db.prepare('SELECT * FROM link_codes WHERE code = ? AND expires_at > ?').get(code, new Date().toISOString());
    if (!row || !discordUser.id) return reply('That code didn’t work. Get a fresh one from Settings in the Guild Camp app (codes last 15 minutes).', { ephemeral: true });
    const discordId = String(discordUser.id);
    const taken = db.prepare('SELECT id FROM users WHERE discord_id = ? AND id != ?').get(discordId, row.user_id);
    if (taken) db.prepare('UPDATE users SET discord_id = NULL WHERE id = ?').run(taken.id);
    db.prepare('UPDATE users SET discord_id = ? WHERE id = ?').run(discordId, row.user_id);
    db.prepare('DELETE FROM link_codes WHERE code = ?').run(code);
    if (serverId) db.prepare('UPDATE guilds SET discord_server_id = ? WHERE id = ? AND discord_server_id IS NULL').run(String(serverId), row.guild_id);
    const u = db.prepare('SELECT battletag FROM users WHERE id = ?').get(row.user_id);
    return reply(`Linked to ${u.battletag.split('#')[0]} in Guild Camp. You can now use /signup and /cta.`, { ephemeral: true });
  }

  if (!guild) return reply(`This server isn’t connected to Guild Camp yet. Open Settings in the Guild Camp app (get it at ${cfg.baseUrl}/get), get a link code and run /link.`, { ephemeral: true });

  if (name === 'online') {
    const rows = db.prepare('SELECT name, level, zone FROM characters WHERE guild_id = ? AND online = 1 ORDER BY level DESC, name').all(guild.id);
    const asOf = guild.roster_scanned_at ? ` (as of <t:${unix(guild.roster_scanned_at)}:R>)` : '';
    return reply(rows.length ? `🔥 **${rows.length} around the fire**${asOf}\n${rows.map((r) => `${r.name} (${r.level ?? '?'})${r.zone ? `, ${r.zone}` : ''}`).join('\n')}`
      : `Nobody online${asOf}.`);
  }

  if (name === 'raids') {
    const rows = db.prepare(`SELECT r.*, (SELECT COUNT(*) FROM signups s WHERE s.raid_id = r.id AND s.status = 'yes') AS coming
      FROM raids r WHERE r.guild_id = ? AND r.status IN ('open','locked') AND r.starts_at > ? ORDER BY r.starts_at LIMIT 8`)
      .all(guild.id, new Date(Date.now() - 3 * 3600000).toISOString());
    return reply(rows.length ? rows.map((r) => `**${r.title}** <t:${unix(r.starts_at)}:F> (<t:${unix(r.starts_at)}:R>), ${r.coming} coming\n${cfg.baseUrl}/raids/${r.id}`).join('\n')
      : 'Nothing scheduled.');
  }

  if (name === 'craft') {
    const q = String(opt(i, 'item') || '').trim();
    const rows = db.prepare(`SELECT r.name AS recipe, group_concat(DISTINCT c.name || CASE WHEN c.online = 1 THEN ' 🟢' ELSE '' END) AS who
      FROM recipes r JOIN characters c ON c.id = r.character_id WHERE c.guild_id = ? AND r.name LIKE ? ESCAPE '\\'
      GROUP BY r.name ORDER BY r.name LIMIT 10`).all(guild.id, `%${q.replace(/[\\%_]/g, (m) => '\\' + m)}%`);
    return reply(rows.length ? rows.map((r) => `**${r.recipe}**: ${r.who.split(',').join(', ')}`).join('\n') : `Nobody has a recipe matching “${q}” synced yet.`);
  }

  if (name === 'price') {
    const rows = searchPrices(db, guild.id, opt(i, 'item'), 8).filter((r) => r.latest);
    return reply(rows.length ? rows.map((r) => `**${r.name || `Item ${r.item_id}`}**: ${money(r.latest.price)} (scanned ${r.latest.day})`).join('\n')
      : 'No recent auction scans for that. Prices come from members running Auctionator scans.');
  }

  if (!user) return reply('Link your Discord first: in the Guild Camp app open Settings → “Link Discord”, then run /link with the code.', { ephemeral: true });
  // /cta and /signup act for the member: a linked Discord account whose user was removed from the guild can't use them.
  const membership = db.prepare('SELECT role FROM memberships WHERE user_id = ? AND guild_id = ?').get(user.id, guild.id);
  if (!membership) return reply('You aren’t in this guild in Guild Camp any more. Ask an officer for an invite, then link your Discord again.', { ephemeral: true });

  if (name === 'cta') {
    const zone = String(opt(i, 'zone') || '').trim().slice(0, 60);
    if (!zone) return reply('Say where: /cta zone:<place>.', { ephemeral: true });
    const needed = Number(opt(i, 'needed')) || null;
    const message = String(opt(i, 'message') || '').slice(0, 200);
    const main = db.prepare(MAIN).get(guild.id, user.id);
    db.prepare("INSERT INTO ctas (guild_id, user_id, character, zone, message, needed, source) VALUES (?,?,?,?,?,?, 'discord')")
      .run(guild.id, user.id, main ? main.name : null, zone, message, needed);
    if (onCta) onCta(guild, zone);
    return reply(`⚔️ **Call to arms: ${zone}**${needed ? ` (need ${needed})` : ''}\n${message}\n— ${main ? main.name : user.battletag.split('#')[0]}`);
  }

  if (name === 'signup') {
    const raid = db.prepare("SELECT * FROM raids WHERE id = ? AND guild_id = ? AND status IN ('open','locked')").get(Number(opt(i, 'raid')), guild.id);
    if (!raid) return reply('Pick a raid from the list. Start typing its name.', { ephemeral: true });
    const role = ['tank', 'healer', 'dps'].includes(opt(i, 'role')) ? opt(i, 'role') : 'dps';
    const status = ['yes', 'tentative', 'no'].includes(opt(i, 'status')) ? opt(i, 'status') : 'yes';
    let character = String(opt(i, 'character') || '').trim().slice(0, 40);
    if (!character) {
      const main = db.prepare(MAIN).get(guild.id, user.id);
      character = main ? main.name : user.battletag.split('#')[0];
    }
    db.prepare(`INSERT INTO signups (raid_id, user_id, character, role, status, updated_at) VALUES (?,?,?,?,?, datetime('now'))
      ON CONFLICT (raid_id, user_id) DO UPDATE SET character = excluded.character, role = excluded.role, status = excluded.status, updated_at = excluded.updated_at`)
      .run(raid.id, user.id, character, role, status);
    const label = { yes: 'coming', tentative: 'a maybe', no: 'not coming' }[status];
    return reply(`${character} is ${label} for **${raid.title}**${status === 'no' ? '' : ` as ${role === 'dps' ? 'damage' : role}`}. Reserves: ${cfg.baseUrl}/raids/${raid.id}`, { ephemeral: true });
  }

  return reply('Unknown command.', { ephemeral: true });
}

function newLinkCode(db, userId, guildId) {
  const code = crypto.randomBytes(4).toString('hex').toUpperCase();
  db.prepare('DELETE FROM link_codes WHERE user_id = ? OR expires_at < ?').run(userId, new Date().toISOString());
  db.prepare('INSERT INTO link_codes (code, user_id, guild_id, expires_at) VALUES (?,?,?,?)').run(code, userId, guildId, new Date(Date.now() + 15 * 60000).toISOString());
  return code;
}

// Native Discord scheduled events for raids (needs the bot in the server with Manage Events).
async function createEvent(cfg, serverId, raid, url, fetchImpl) {
  const start = new Date(raid.starts_at);
  const end = new Date(start.getTime() + (raid.duration_min || 180) * 60000);
  const res = await fetcher(cfg, fetchImpl)(`${API}/guilds/${serverId}/scheduled-events`, {
    method: 'POST',
    headers: { Authorization: `Bot ${cfg.discordBotToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: raid.title.slice(0, 100), privacy_level: 2, entity_type: 3,
      scheduled_start_time: start.toISOString(), scheduled_end_time: end.toISOString(),
      entity_metadata: { location: `${raid.instance} · ${url}`.slice(0, 100) },
      description: `${raid.notes ? `${raid.notes}\n\n` : ''}Sign up${raid.kind === 'raid' ? ' and reserve loot' : ''}: ${url}`.slice(0, 1000),
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new HttpError(502, `Discord event: ${res.status} ${(await res.text()).slice(0, 150)}`);
  return (await res.json()).id;
}
async function deleteEvent(cfg, serverId, eventId, fetchImpl) {
  await fetcher(cfg, fetchImpl)(`${API}/guilds/${serverId}/scheduled-events/${eventId}`, {
    method: 'DELETE', headers: { Authorization: `Bot ${cfg.discordBotToken}` }, signal: AbortSignal.timeout(10000),
  });
}

module.exports = { verify, handle, registerCommands, COMMANDS, newLinkCode, createEvent, deleteEvent };
