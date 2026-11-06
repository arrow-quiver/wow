const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Class colours as players know them from the game, tuned slightly for contrast on light paper.
const CLASS = {
  WARRIOR: ['Warrior', '#9a6b3f'], PALADIN: ['Paladin', '#c0558a'], HUNTER: ['Hunter', '#5f8a2e'],
  ROGUE: ['Rogue', '#a88a12'], PRIEST: ['Priest', '#6b7280'], SHAMAN: ['Shaman', '#0b6fb8'],
  MAGE: ['Mage', '#2b8fb3'], WARLOCK: ['Warlock', '#6d5bb5'], DRUID: ['Druid', '#c4620e'],
};
const classInfo = (c) => CLASS[String(c || '').toUpperCase()] || [c || 'Unknown', '#6b7280'];

function ago(iso) {
  if (!iso) return 'never';
  const t = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z').getTime();
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

const NAV = [
  ['/', 'Camp', 'home'],
  ['/raids', 'Raids &amp; events', 'raids'],
  ['/loot', 'Loot', 'loot'],
  ['/coach', 'Coach', 'coach'],
  ['/roster', 'Roster', 'roster'],
  ['/crafters', 'Crafters', 'crafters'],
  ['/requests', 'Crafting requests', 'requests'],
  ['/buddies', 'Leveling partners', 'buddies'],
  ['/bank', 'Bank', 'bank'],
  ['/prices', 'Prices', 'prices'],
  ['/drives', 'Supply drives', 'drives'],
  ['/settings', 'Settings', 'settings'],
  ['/admin', 'Officer tools', 'admin', 'officer'],
];

function layout({ title, active, user, guild, body, csrf, flash }) {
  const nav = guild
    ? NAV.filter((n) => n[3] !== 'officer' || ['owner', 'officer'].includes(guild.role)).map(([href, label, key]) => `<a href="${href}" class="nav-link${key === active ? ' is-active' : ''}"${key === active ? ' aria-current="page"' : ''}>${label}</a>`).join('')
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title ? `${title} – wow` : 'wow')}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Alegreya:wght@500;700;800&family=Alegreya+Sans:wght@400;500;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/style.css">
<link rel="stylesheet" href="/intro.css">
<script src="/intro.js"></script>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="#1f3a33">
<link rel="apple-touch-icon" href="/icon-192.png">
<script src="/app.js" defer></script>
<script src="/wowhead-config.js" defer></script>
<script src="https://wow.zamimg.com/js/tooltips.js" defer></script>
</head>
<body>
<div class="shell${guild ? '' : ' shell--bare'}">
  ${guild ? `<header class="side">
    <a href="/" class="brand"><img src="/favicon.svg" alt="" width="28" height="28"><span>${esc(guild.name)}</span></a>
    <nav class="nav" aria-label="Main">${nav}</nav>
    <div class="side-foot">
      <span class="who">${esc(user.battletag)}</span>
      <form method="post" action="/logout"><input type="hidden" name="_csrf" value="${esc(csrf)}"><button class="link-btn">Sign out</button></form>
    </div>
  </header>` : ''}
  <main class="main" id="main">
    ${flash ? `<p class="flash" role="status">${esc(flash)}</p>` : ''}
    ${body}
  </main>
</div>
</body>
</html>`;
}

// Times are stored in UTC; app.js rewrites <time data-local> into the viewer's own time zone.
function when(iso, style = 'full') {
  const d = new Date(iso);
  const fallback = d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  return `<time datetime="${esc(d.toISOString())}" data-local="${style}">${esc(fallback)}</time>`;
}

module.exports = { layout, esc, classInfo, ago, when };
