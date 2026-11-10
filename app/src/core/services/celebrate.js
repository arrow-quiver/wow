// Celebrations on the guild's Discord and in the addon.
//
//   discordText({ what, from }) → the Discord post for a "[Guild Camp] <what> — from <name>" line the addon said
//       in guild chat (a level milestone, the huge Horde one at 60, an epic loot, a profession step, riding, a PvP
//       rank, a welcome). The app reads its own lines from the chat log (main/live.js) and POSTs /api/celebrate.
//   anniversaries(db, guildId, now) → today's anniversaries in the guild: time in the guild (memberships.joined_at:
//       1, 3 and 6 months, then every year) and character birthdays (characters.first_seen, every year).
//       → [{ userId, name, kind: 'guild'|'character', months, text }]
//   inboxPart(db, guildId, now) → the addon's `today` field: { date, lines: [text] } (a toast at login)
const MONTH_STEPS = [1, 3, 6];

const clean = (s) => String(s || '').replace(/[*_~`|>@]/g, '').trim();
const linkName = (s) => String(s).replace(/\|c[0-9a-fA-F]{8}\|H[^|]*\|h\[([^\]]+)\]\|h\|r/g, '$1');

function discordText({ what, from }) {
  const w = linkName(String(what || '').trim());
  let m = /^(\S+) reached level (\d+)!$/.exec(w);
  if (m) {
    const [, name, lvl] = m;
    if (Number(lvl) >= 60) {
      return `🔥 **LOK'TAR OGAR!** 🔥\n**${clean(name)}** has reached **level ${lvl}**! The Horde grows stronger. Blood and thunder! ⚔️🩸`;
    }
    return `🎉 **${clean(name)}** reached **level ${lvl}**! Grats!`;
  }
  if ((m = /^(\S+) looted (.+)!$/.exec(w))) return `💜 **${clean(m[1])}** looted **${clean(m[2])}**!`;
  if ((m = /^(\S+) reached (\d+) in (.+)!$/.exec(w))) return `🔨 **${clean(m[1])}** reached **${m[2]} ${clean(m[3])}**!`;
  if ((m = /^(\S+) learned to ride!$/.exec(w))) return `🐺 **${clean(m[1])}** learned to ride! Time to see the world.`;
  if ((m = /^(\S+) reached PvP rank (.+)!$/.exec(w))) return `🎖️ **${clean(m[1])}** reached PvP rank **${clean(m[2])}**!`;
  if ((m = /^Welcome to the guild, ([^!]+)!(?: Your buddy is ([^.]+)\.)?$/.exec(w))) {
    return `👋 Welcome to the guild, **${clean(m[1])}**!${m[2] ? ` Your guild buddy: **${clean(m[2])}**.` : ''}${from ? ` (from ${clean(from)})` : ''}`;
  }
  return null; // not a celebration (a call to arms has its own post)
}

function monthsBetween(from, to) {
  return (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth());
}
const sameDay = (a, b) => a.getUTCDate() === b.getUTCDate()
  || (b.getUTCDate() === new Date(Date.UTC(b.getUTCFullYear(), b.getUTCMonth() + 1, 0)).getUTCDate() && a.getUTCDate() > b.getUTCDate());
const parse = (s) => new Date(/[zZ]$/.test(String(s)) ? s : `${String(s).replace(' ', 'T')}Z`);
const span = (months) => (months % 12 === 0 ? `${months / 12} year${months === 12 ? '' : 's'}` : `${months} month${months === 1 ? '' : 's'}`);

function anniversaries(db, guildId, now = Date.now()) {
  const today = new Date(now);
  const out = [];
  const main = db.prepare(`SELECT name FROM characters WHERE guild_id = ? AND user_id = ? AND is_bank = 0 ORDER BY is_main DESC, level DESC LIMIT 1`);
  for (const m of db.prepare('SELECT user_id, joined_at FROM memberships WHERE guild_id = ?').all(guildId)) {
    const from = parse(m.joined_at);
    const months = monthsBetween(from, today);
    if (months < 1 || !sameDay(from, today)) continue;
    if (!MONTH_STEPS.includes(months) && months % 12 !== 0) continue;
    const c = main.get(guildId, m.user_id);
    if (!c) continue;
    out.push({ userId: m.user_id, name: c.name, kind: 'guild', months, text: `${c.name} has been in the guild for ${span(months)}!` });
  }
  for (const c of db.prepare('SELECT user_id, name, first_seen FROM characters WHERE guild_id = ? AND user_id IS NOT NULL AND is_bank = 0 AND first_seen IS NOT NULL').all(guildId)) {
    const from = parse(c.first_seen);
    const months = monthsBetween(from, today);
    if (months < 12 || months % 12 !== 0 || !sameDay(from, today)) continue;
    out.push({ userId: c.user_id, name: c.name, kind: 'character', months, text: `Happy birthday, ${c.name}: ${span(months)} with the guild!` });
  }
  return out;
}

function anniversaryDiscord(a) {
  return a.kind === 'guild' ? `🎂 **${clean(a.name)}** has been in the guild for **${span(a.months)}**! Thanks for being part of it.`
    : `🎈 Happy birthday, **${clean(a.name)}**: **${span(a.months)}** with the guild!`;
}

function inboxPart(db, guildId, now = Date.now()) {
  return { date: new Date(now).toISOString().slice(0, 10), lines: anniversaries(db, guildId, now).map((a) => a.text) };
}

module.exports = { discordText, anniversaries, anniversaryDiscord, inboxPart, linkName };
