// The route table. Each page module: `export default function XPage({ params, query })`.
// Fields: path (with :params), load (lazy import), title (top bar + window title), nav (sidebar section, see HUBS),
// icon (components/Icon.js name), officer / owner (hidden and blocked for others; roles come from in-game ranks),
// publisher (only in the sidebar on a PC that can publish releases: publisher.status().canPublish),
// public + bare (shown before the guild is known, without the app frame).
// Order matters: the first matching route wins.

// The sidebar: one link per section. Each section's pages are its sub-tabs (HubTabs in components/Shell.js).
// A section opens on its first page the player can see. `foot` sections sit at the bottom of the sidebar.
export const HUBS = [
  { id: 'Camp', title: 'Camp', icon: 'camp' },
  { id: 'Coach', title: 'Coach', icon: 'coach' },
  { id: 'War', title: 'War', icon: 'war' },
  { id: 'Raids', title: 'Raids & Dungeons', icon: 'dungeons' },
  { id: 'Professions', title: 'Professions', icon: 'crafters' },
  { id: 'Bank', title: 'Bank & Market', icon: 'bank' },
  { id: 'Guild', title: 'Guild', icon: 'banner' },
  { id: 'App', title: 'Settings', icon: 'settings', foot: true },
];
export const NAV_SECTIONS = HUBS.map((h) => h.id);

// `nav` is the section a page is a sub-tab of; `tab` is its label on the tab strip (the title when left out).
// Detail pages (with :params) carry `hub` instead, so their section stays lit in the sidebar.
export const routes = [
  // Camp
  { path: '/overlay', load: () => import('./overlay.js'), title: 'Now', nav: 'Camp', icon: 'coach', overlayOnly: true },
  { path: '/', load: () => import('./camp.js'), title: 'Camp', tab: 'Today', nav: 'Camp', icon: 'camp' },
  { path: '/board', load: () => import('./board.js'), title: 'Bulletin board', nav: 'Camp', icon: 'board' },
  { path: '/digest', load: () => import('./digest.js'), title: 'Weekly digest', nav: 'Camp', icon: 'digest' },
  { path: '/seasons', load: () => import('./seasons.js'), title: 'Seasons', nav: 'Camp', icon: 'trophy' },
  // Coach
  { path: '/coach', load: () => import('./coach.js'), title: 'Coach', nav: 'Coach', icon: 'coach' },
  // War
  { path: '/war', load: () => import('./war.js'), title: 'War', tab: 'War map', nav: 'War', icon: 'war' },
  { path: '/hunt', load: () => import('./hunt.js'), title: 'The hunt', nav: 'War', icon: 'target' },
  // Raids & Dungeons
  { path: '/raids', load: () => import('./raids.js'), title: 'Raids', nav: 'Raids', icon: 'raids' },
  { path: '/dungeons', load: () => import('./dungeons.js'), title: 'Dungeons', nav: 'Raids', icon: 'dungeons' },
  { path: '/loot', load: () => import('./loot.js'), title: 'Loot', nav: 'Raids', icon: 'loot' },
  // Professions
  { path: '/crafters', load: () => import('./crafters.js'), title: 'Crafters', nav: 'Professions', icon: 'crafters' },
  { path: '/requests', load: () => import('./requests.js'), title: 'Requests', nav: 'Professions', icon: 'requests' },
  // Bank & Market
  { path: '/bank', load: () => import('./bank.js'), title: 'Bank', nav: 'Bank', icon: 'bank' },
  { path: '/store', load: () => import('./store.js'), title: 'Guild bank store', tab: 'Store', nav: 'Bank', icon: 'store' },
  { path: '/donate', load: () => import('./donate.js'), title: 'Donate', nav: 'Bank', icon: 'gift' },
  { path: '/drives', load: () => import('./drives.js'), title: 'Drives', nav: 'Bank', icon: 'drives' },
  { path: '/prices', load: () => import('./prices.js'), title: 'Prices', nav: 'Bank', icon: 'prices' },
  { path: '/deals', load: () => import('./deals.js'), title: 'Deal hunter', nav: 'Bank', icon: 'deals' },
  // Guild. Guild settings is for everyone: officer ranks (the Guild Master changes them), item tooltips, Coach AI, realm and members.
  { path: '/roster', load: () => import('./roster.js'), title: 'Roster', nav: 'Guild', icon: 'roster' },
  { path: '/partners', load: () => import('./partners.js'), title: 'Partners', tab: 'Leveling partners', nav: 'Guild', icon: 'partners' },
  { path: '/recruiting', load: () => import('./recruiting.js'), title: 'Recruiting', nav: 'Guild', icon: 'partners' },
  { path: '/guild-settings', load: () => import('./guild-settings.js'), title: 'Guild settings', nav: 'Guild', icon: 'banner' },
  { path: '/admin', load: () => import('./admin.js'), title: 'Officer tools', nav: 'Guild', icon: 'admin', officer: true },
  // Settings (the gear at the bottom of the sidebar)
  { path: '/settings', load: () => import('./settings.js'), title: 'Settings', nav: 'App', icon: 'settings' },
  { path: '/addon', load: () => import('./addon.js'), title: 'Addon & sync', nav: 'App', icon: 'addon' },
  { path: '/updates', load: () => import('./updates.js'), title: 'Updates', nav: 'App', icon: 'updates' },
  { path: '/releases', load: () => import('./releases.js'), title: 'Releases', nav: 'App', icon: 'releases', publisher: true },
  // Not on a tab strip of their own
  { path: '/raids/:id', load: () => import('./raid.js'), title: 'Raid', icon: 'raids', hub: 'Raids' },
  { path: '/raids/:id/loot', load: () => import('./raid-loot.js'), title: 'Loot screen', icon: 'loot', hub: 'Raids' },
  { path: '/characters/:name', load: () => import('./character.js'), title: 'Character', icon: 'character', hub: 'Guild' },
  { path: '/welcome', load: () => import('./welcome.js'), title: 'Welcome', public: true, bare: true },
];

// Static paths (no :params), e.g. for the smoke test that opens every page.
export const staticPaths = routes.filter((r) => !r.path.includes(':')).map((r) => r.path);

export default routes;
