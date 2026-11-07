// The app frame: left sidebar (brand, navigation, sync + update status, who is signed in) and the top bar
// (window drag strip with the page title and actions). main.js composes them with the content area.
import { html, cx } from '../lib/html.js';
import { Link, back as goBack } from '../lib/router.js';
import { useStore } from '../lib/store.js';
import { useSession } from '../lib/session.js';
import { useSyncStatus, useUpdaterStatus, useAddonStatus, describeSync, describeUpdates } from '../lib/status.js';
import { Icon } from './Icon.js';
import { Button } from './Button.js';
import { TimeAgo } from './wow.js';
import { pageStore } from './Page.js';

const ROLE_LABEL = { owner: 'Owner', officer: 'Officer', member: 'Member' };

// Which routes the signed-in person may see in the sidebar.
export function visibleNav(routes, session) {
  return routes.filter((r) => r.nav && (!r.officer || session.isOfficer) && (!r.owner || session.isOwner));
}

export function Sidebar({ routes, sections }) {
  const session = useSession();
  const sync = useSyncStatus();
  const updater = useUpdaterStatus();
  const addon = useAddonStatus();
  const { guild, user, role } = session;

  const items = visibleNav(routes, session);
  const groups = sections.map((s) => [s, items.filter((r) => r.nav === s)]).filter(([, list]) => list.length);
  const syncInfo = describeSync(sync);
  const updates = describeUpdates(updater, addon);
  const outdated = addon && Array.isArray(addon.installs) ? addon.installs.filter((i) => i.state === 'outdated').length : 0;
  const badges = {
    '/updates': updater && ['available', 'downloaded'].includes(updater.state) ? '1' : null,
    '/addon': sync && sync.state === 'error' ? '!' : outdated ? String(outdated) : null,
  };

  return html`<aside class="sidebar">
    <div class="sidebar-brand">
      <${Link} href="/" exact activeClass="" aria-current=${undefined} title="Camp">
        <img class="brand-logo" src="./assets/logo.svg" alt="" width="30" height="35" />
        <span class="brand-text">
          <span class="brand-name">${guild?.name || 'Guild Camp'}</span>
          <span class="brand-sub">${guild?.faction ? `${guild.faction} · Guild Camp` : 'Guild Camp'}</span>
        </span>
      <//>
    </div>

    <nav class="nav" aria-label="Main">
      ${groups.map(([section, list]) => html`<div class="nav-section" key=${section}>
        <h2 class="nav-heading">${section}</h2>
        <ul class="nav-list">
          ${list.map((r) => html`<li key=${r.path}>
            <${Link} href=${r.path} class="nav-link" exact=${r.path === '/'}>
              <${Icon} name=${r.icon} />
              <span class="nav-label">${r.title}</span>
              ${badges[r.path] ? html`<span class="nav-badge" aria-label=${r.path === '/addon' && badges[r.path] === '!' ? 'needs attention' : `${badges[r.path]} waiting`}>${badges[r.path]}</span>` : null}
            <//>
          </li>`)}
        </ul>
      </div>`)}
    </nav>

    <div class="sidebar-foot">
      ${updates ? html`<${Link} href=${updates.route} class="foot-link update-badge" activeClass="">
        <${Icon} name="download" /><span class="ellipsis">${updates.label}</span>
      <//>` : null}
      <${Link} href="/addon" class="foot-link" activeClass="" title=${sync?.lastError || 'Addon & sync'}>
        <span class=${`status-dot status-dot--${syncInfo.kind}`} aria-hidden="true"></span>
        <span class="ellipsis">${syncInfo.label}${syncInfo.at ? html` <${TimeAgo} t=${syncInfo.at} />` : null}</span>
      <//>
      ${user ? html`<${Link} href="/settings" class="foot-link" activeClass="" title="Settings">
        <${Icon} name="character" />
        <span class="who ellipsis">${user.battletag}</span>
        ${role ? html`<span class="who-role">${ROLE_LABEL[role] || role}</span>` : null}
      <//>` : null}
    </div>
  </aside>`;
}

// The route a "Back" button falls back to when there is no history: '/raids/12/loot' → '/raids/12', '/raids/12' → '/raids'.
export function parentPath(path) {
  const parts = String(path || '/').split('/').filter(Boolean);
  parts.pop();
  return `/${parts.join('/')}`;
}

export function TopBar({ route, path }) {
  const page = useStore(pageStore);
  const title = page.title ?? route?.title ?? '';
  // Detail pages (routes with :params) get a Back button unless the page says otherwise.
  const showBack = page.back !== undefined ? !!page.back : !!(route && !route.nav && route.path.includes(':'));
  const fallback = typeof page.back === 'string' ? page.back : parentPath(path);
  return html`<header class="topbar">
    <div class="topbar-title">
      ${showBack ? html`<${Button} variant="ghost" size="sm" icon="back" label="Back" class="topbar-back" onClick=${() => goBack(fallback)} />` : null}
      <h1>${title}</h1>
    </div>
    <div class=${cx('topbar-actions')}>${page.actions}</div>
  </header>`;
}
