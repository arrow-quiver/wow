// iCalendar (.ics) feed of the guild's raids and events. Works with Google, Apple and Outlook calendars.
const crypto = require('crypto');

const icsDate = (iso) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
// RFC 5545: escape \ ; , and newlines, and fold lines longer than 75 octets.
const text = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
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
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//wow guild//raids//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
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

module.exports = { buildIcs, calendarToken };
