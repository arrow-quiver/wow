// The route table. Each page module: `export default function XPage({ params, query })`.
// Fields: path (with :params), load (lazy import), title (top bar + window title), nav (sidebar section),
// icon (components/Icon.js name), officer / owner (hidden and blocked for others; roles come from in-game ranks),
// publisher (only in the sidebar on a PC that can publish releases: publisher.status().canPublish),
// public + bare (shown before the guild is known, without the app frame).
// Order matters: the first matching route wins.

export const NAV_SECTIONS = ['Play', 'Guild', 'Officers', 'App'];

export const routes = [
  // Play
  { path: '/', load: () => import('./camp.js'), title: 'Camp', nav: 'Play', icon: 'camp' },
  { path: '/coach', load: () => import('./coach.js'), title: 'Coach', nav: 'Play', icon: 'coach' },
  { path: '/raids', load: () => import('./raids.js'), title: 'Raids', nav: 'Play', icon: 'raids' },
  { path: '/crafters', load: () => import('./crafters.js'), title: 'Crafters', nav: 'Play', icon: 'crafters' },
  { path: '/requests', load: () => import('./requests.js'), title: 'Requests', nav: 'Play', icon: 'requests' },
  { path: '/partners', load: () => import('./partners.js'), title: 'Partners', nav: 'Play', icon: 'partners' },
  // Guild
  { path: '/roster', load: () => import('./roster.js'), title: 'Roster', nav: 'Guild', icon: 'roster' },
  { path: '/bank', load: () => import('./bank.js'), title: 'Bank', nav: 'Guild', icon: 'bank' },
  { path: '/prices', load: () => import('./prices.js'), title: 'Prices', nav: 'Guild', icon: 'prices' },
  { path: '/deals', load: () => import('./deals.js'), title: 'Deal hunter', nav: 'Guild', icon: 'deals' },
  { path: '/drives', load: () => import('./drives.js'), title: 'Drives', nav: 'Guild', icon: 'drives' },
  { path: '/loot', load: () => import('./loot.js'), title: 'Loot', nav: 'Guild', icon: 'loot' },
  // Everyone: officer ranks (the Guild Master changes them), item tooltips, Coach AI, realm and members.
  { path: '/guild-settings', load: () => import('./guild-settings.js'), title: 'Guild settings', nav: 'Guild', icon: 'banner' },
  // Officers
  { path: '/admin', load: () => import('./admin.js'), title: 'Officer tools', nav: 'Officers', icon: 'admin', officer: true },
  // App
  { path: '/addon', load: () => import('./addon.js'), title: 'Addon & sync', nav: 'App', icon: 'addon' },
  { path: '/settings', load: () => import('./settings.js'), title: 'Settings', nav: 'App', icon: 'settings' },
  { path: '/updates', load: () => import('./updates.js'), title: 'Updates', nav: 'App', icon: 'updates' },
  { path: '/releases', load: () => import('./releases.js'), title: 'Releases', nav: 'App', icon: 'releases', publisher: true },
  // Not in the sidebar
  { path: '/raids/:id', load: () => import('./raid.js'), title: 'Raid', icon: 'raids' },
  { path: '/raids/:id/loot', load: () => import('./raid-loot.js'), title: 'Loot screen', icon: 'loot' },
  { path: '/characters/:name', load: () => import('./character.js'), title: 'Character', icon: 'character' },
  { path: '/welcome', load: () => import('./welcome.js'), title: 'Welcome', public: true, bare: true },
  // The Coach overlay window (main/overlay.js) shows only this page.
  { path: '/overlay', load: () => import('./overlay.js'), title: 'Coach overlay', bare: true, overlay: true },
];

// Static paths (no :params), e.g. for the smoke test that opens every page.
export const staticPaths = routes.filter((r) => !r.path.includes(':')).map((r) => r.path);

export default routes;
