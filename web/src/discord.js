// Discord slash commands, delivered by Discord to POST /discord/interactions.
// No gateway connection or extra process: Discord calls the site, the site answers.
const crypto = require('crypto');
const { searchPrices, money } = require('./economy');

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

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
  { name: 'link', description: 'Link your Discord to your guild site account', options: [
    { type: STRING, name: 'code', description: 'Code from the site’s Settings page', required: true, max_length: 20 }] },
];

async function registerCommands(cfg) {
  const res = await fetch(`https://discord.com/api/v10/applications/${cfg.discordAppId}/commands`, {
    method: 'PUT',
    headers: { Authorization: `Bot ${cfg.discordBotToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(COMMANDS),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Discord said ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).length;
}

const reply = (content, { ephemeral = false } = {}) => ({
  type: 4, data: { content: content.slice(0, 1990), allowed_mentions: { parse: [] }, ...(ephemeral ? { flags: 64 } : {}) },
});
const opt = (i, name) => {
  const o = (i.data.options || []).find((x) => x.name === name);
  return o ? o.value : undefined;
};
const unix = (iso) => Math.floor(new Date(iso).getTime() / 1000);

function handle(db, cfg, i, { onCta } = {}) {
  if (i.type === 1) return { type: 1 }; // PING
  const discordUser = (i.member && i.member.user) || i.user || {};
  const serverId = i.guild_id || null;
  const user = discordUser.id ? db.prepare('SELECT * FROM users WHERE discord_id = ?').get(discordUser.id) : null;
  let guild = serverId ? db.prepare('SELECT * FROM guilds WHERE discord_server_id = ?').get(serverId) : null;
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
  if (i.type !== 2) return reply('Unsupported interaction.', { ephemeral: true });
  const name = i.data.name;

  if (name === 'link') {
    const code = String(opt(i, 'code') || '').trim().toUpperCase();
    const row = db.prepare('SELECT * FROM link_codes WHERE code = ? AND expires_at > ?').get(code, new Date().toISOString());
    if (!row) return reply('That code didn’t work. Get a fresh one from Settings on the guild site (codes last 15 minutes).', { ephemeral: true });
    const taken = db.prepare('SELECT id FROM users WHERE discord_id = ? AND id != ?').get(discordUser.id, row.user_id);
    if (taken) db.prepare('UPDATE users SET discord_id = NULL WHERE id = ?').run(taken.id);
    db.prepare('UPDATE users SET discord_id = ? WHERE id = ?').run(discordUser.id, row.user_id);
    db.prepare('DELETE FROM link_codes WHERE code = ?').run(code);
    if (serverId) db.prepare('UPDATE guilds SET discord_server_id = ? WHERE id = ? AND discord_server_id IS NULL').run(serverId, row.guild_id);
    const u = db.prepare('SELECT battletag FROM users WHERE id = ?').get(row.user_id);
    return reply(`Linked to ${u.battletag.split('#')[0]} on the guild site. You can now use /signup and /cta.`, { ephemeral: true });
  }

  if (!guild) return reply(`This server isn’t connected to the guild site yet. Open Settings on ${cfg.baseUrl}, get a link code and run /link.`, { ephemeral: true });

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

  if (!user) return reply('Link your Discord first: Settings on the guild site → “Link Discord”, then run /link with the code.', { ephemeral: true });

  if (name === 'cta') {
    const zone = String(opt(i, 'zone')).slice(0, 60);
    const needed = Number(opt(i, 'needed')) || null;
    const message = String(opt(i, 'message') || '').slice(0, 200);
    const main = db.prepare('SELECT name FROM characters WHERE guild_id = ? AND user_id = ? ORDER BY is_main DESC, level DESC LIMIT 1').get(guild.id, user.id);
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
      const main = db.prepare('SELECT name FROM characters WHERE guild_id = ? AND user_id = ? ORDER BY is_main DESC, level DESC LIMIT 1').get(guild.id, user.id);
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

module.exports = { verify, handle, registerCommands, COMMANDS, newLinkCode };
