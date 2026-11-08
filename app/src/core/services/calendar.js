'use strict';
// iCalendar (.ics) export of the guild's raids and events. Works with Google, Apple and Outlook calendars.
// Ported from the old server's calendar feed: there is no server to subscribe to any more, so the app
// saves this as a file ("Export to calendar") that the player imports into their calendar.
//
// Exports
//   buildIcs({ guildName, raids, now = new Date() }) → text/calendar body (CRLF, lines folded at 75 octets)
//       raids: rows with id, guild_id, title, instance, starts_at, duration_min, kind, status, notes, plus
//       signup (this member's status or null) and coming (count of 'yes').
//   feedRaids(db, guildId, userId, now = Date.now()) → those rows: every raid from the last 30 days on, oldest first
// Injected dependencies: none. Served by GET /api/calendar.ics (routes/calendar.js) for calendar.export.

const UID_HOST = 'guildcamp.app';

const icsDate = (iso) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
// RFC 5545: escape \ ; , and newlines, and fold lines longer than 75 octets.
const text = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
function fold(line) {
  const out = []; let cur = '';
  for (const ch of line) {
    if (Buffer.byteLength(cur + ch) > 74) { out.push(cur); cur = ' ' + ch; } else cur += ch;
  }
  out.push(cur);
  return out.join('\r\n');
}
// A UID that stays the same when the player exports again, so calendars update the event instead of
// adding a second one. The guild's name and the raid's start keep two guilds' raid #3 apart.
const uidOf = (guildName, r) => {
  const slug = String(guildName || 'guild').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'guild';
  return `raid-${r.id}-${slug}-${icsDate(r.created_at ? `${String(r.created_at).replace(' ', 'T')}Z` : r.starts_at)}@${UID_HOST}`;
};

function buildIcs({ guildName, raids, now = new Date() }) {
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Guild Camp//raids//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${text(`${guildName} raids`)}`,
  ];
  for (const r of raids) {
    const start = new Date(r.starts_at);
    const end = new Date(start.getTime() + (r.duration_min || 180) * 60000);
    const kind = { pvp: 'PvP', event: 'Event' }[r.kind] || 'Raid';
    const me = { yes: 'You’re coming', tentative: 'You’re a maybe', no: 'You can’t make it', bench: 'You’re on the bench' }[r.signup] || 'You haven’t signed up yet';
    lines.push('BEGIN:VEVENT',
      `UID:${uidOf(guildName, r)}`, `DTSTAMP:${icsDate(now)}`, `DTSTART:${icsDate(start)}`, `DTEND:${icsDate(end)}`,
      `SUMMARY:${text(`${kind}: ${r.title}`)}`, `LOCATION:${text(r.instance)}`,
      `DESCRIPTION:${text(`${me}. ${r.coming || 0} coming.${r.notes ? `\n${r.notes}` : ''}\nSign up in Guild Camp.`)}`,
      `STATUS:${r.status === 'cancelled' ? 'CANCELLED' : 'CONFIRMED'}`,
      'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${text(r.title)}`, 'TRIGGER:-PT30M', 'END:VALARM',
      'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

// The raids the export shows, with my own sign-up and the head count.
function feedRaids(db, guildId, userId, now = Date.now()) {
  return db.prepare(`SELECT r.*, s.status AS signup, (SELECT COUNT(*) FROM signups x WHERE x.raid_id = r.id AND x.status = 'yes') AS coming
    FROM raids r LEFT JOIN signups s ON s.raid_id = r.id AND s.user_id = ? WHERE r.guild_id = ? AND r.starts_at > ? ORDER BY r.starts_at`)
    .all(userId, guildId, new Date(now - 30 * 86400000).toISOString());
}

module.exports = { buildIcs, feedRaids };
