// iCalendar (.ics) feed of the guild's raids and events. Works with Google, Apple and Outlook calendars.
// Ported from the old web/src/calendar.js, plus the feed query from the old routes/freebies.js.
//
// Exports
//   buildIcs({ guildName, baseUrl, raids, now = new Date() }) → text/calendar body (CRLF, lines folded at 75 octets)
//       raids: rows with id, title, instance, starts_at, duration_min, kind, status, notes, plus
//       signup (this member's status or null) and coming (count of 'yes').
//   feedRaids(db, guildId, userId, now = Date.now()) → those rows: every raid from the last 30 days on, oldest first
//   calendarToken() → a fresh secret for users.calendar_token (24 url-safe characters)
// Injected dependencies: none. The public route is GET /calendar/<token>.ics (token from users.calendar_token).
const crypto = require('crypto');

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

function calendarToken() { return crypto.randomBytes(18).toString('base64url'); }

function buildIcs({ guildName, baseUrl, raids, now = new Date() }) {
  const host = new URL(baseUrl).host;
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Guild Camp//raids//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${text(`${guildName} raids`)}`, 'X-PUBLISHED-TTL:PT1H', 'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
  ];
  for (const r of raids) {
    const start = new Date(r.starts_at);
    const end = new Date(start.getTime() + (r.duration_min || 180) * 60000);
    const kind = { pvp: 'PvP', event: 'Event' }[r.kind] || 'Raid';
    const me = { yes: 'You’re coming', tentative: 'You’re a maybe', no: 'You can’t make it', bench: 'You’re on the bench' }[r.signup] || 'You haven’t signed up yet';
    lines.push('BEGIN:VEVENT',
      `UID:raid-${r.id}@${host}`, `DTSTAMP:${icsDate(now)}`, `DTSTART:${icsDate(start)}`, `DTEND:${icsDate(end)}`,
      `SUMMARY:${text(`${kind}: ${r.title}`)}`, `LOCATION:${text(r.instance)}`,
      `DESCRIPTION:${text(`${me}. ${r.coming || 0} coming.${r.notes ? `\n${r.notes}` : ''}\n${baseUrl}/raids/${r.id}`)}`,
      `URL:${baseUrl}/raids/${r.id}`,
      `STATUS:${r.status === 'cancelled' ? 'CANCELLED' : 'CONFIRMED'}`,
      'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${text(r.title)}`, 'TRIGGER:-PT30M', 'END:VALARM',
      'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

// The raids a member's feed shows, with their own sign-up and the head count.
function feedRaids(db, guildId, userId, now = Date.now()) {
  return db.prepare(`SELECT r.*, s.status AS signup, (SELECT COUNT(*) FROM signups x WHERE x.raid_id = r.id AND x.status = 'yes') AS coming
    FROM raids r LEFT JOIN signups s ON s.raid_id = r.id AND s.user_id = ? WHERE r.guild_id = ? AND r.starts_at > ? ORDER BY r.starts_at`)
    .all(userId, guildId, new Date(now - 30 * 86400000).toISOString());
}

module.exports = { buildIcs, calendarToken, feedRaids };
