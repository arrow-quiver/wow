// The app frame: left sidebar (brand, one link per section, sync + update status, who you are), the sub-tabs of
// the current section, and the top bar
// (window drag strip with the page title and actions). main.js composes them with the content area.
import { html, cx } from '../lib/html.js';
import { Link, back as goBack, isActivePath } from '../lib/router.js';
import { useStore } from '../lib/store.js';
import { useSession } from '../lib/session.js';
import {
  useSyncStatus, useUpdaterStatus, useAddonStatus, usePublisherStatus, describeSync, describeUpdates, ROLE_NAMES,
} from '../lib/status.js';
import { Icon } from './Icon.js';
import { Button } from './Button.js';
import { TimeAgo } from './wow.js';
import { pageStore } from './Page.js';

// Which routes the sidebar shows. officer / owner follow the role from in-game ranks; publisher routes (Releases)
// only show on a PC that can publish (publisher.status().canPublish: a source checkout and the GitHub CLI).
export function visibleNav(routes, session, { canPublish = false, overlay = false } = {}) {
  return routes.filter((r) => r.nav && (!r.officer || session.isOfficer) && (!r.owner || session.isOwner)
    && (!r.publisher || canPublish) && (!r.overlayOnly || overlay));
}

// The section a route belongs to: its own (`nav`), or the one a detail page hangs under (`hub`).
export const hubOf = (route) => (route && (route.nav || route.hub)) || null;

// The sidebar's sections: [{ ...hub, tabs: visible routes, href: the first of them }], without empty ones.
export function navHubs(routes, hubs, session, opts) {
  const items = visibleNav(routes, session, opts);
  return hubs.map((h) => {
    const tabs = items.filter((r) => r.nav === h.id);
    return { ...h, tabs, href: tabs.length ? tabs[0].path : null };
  }).filter((h) => h.tabs.length);
}

function useNav(routes, hubs, overlay) {
  const session = useSession();
  const sync = useSyncStatus();
  const updater = useUpdaterStatus();
  const addon = useAddonStatus();
  const publisher = usePublisherStatus();
  const list = navHubs(routes, hubs, session, { canPublish: Boolean(publisher && publisher.canPublish), overlay });
  const outdated = addon && Array.isArray(addon.installs) ? addon.installs.filter((i) => i.state === 'outdated' && i.inUse !== false).length : 0;
  const badges = {
    '/updates': updater && ['available', 'downloaded'].includes(updater.state) ? '1' : null,
    '/addon': sync && sync.state === 'error' ? '!' : outdated ? String(outdated) : null,
  };
  return { session, sync, updater, addon, list, badges };
}

const badgeLabel = (b) => (b === '!' ? 'needs attention' : `${b} waiting`);
// A section shows the most urgent badge of its pages: "!" first, then the count.
export function hubBadge(hub, badges) {
  const found = hub.tabs.map((r) => badges[r.path]).filter(Boolean);
  if (!found.length) return null;
  if (found.includes('!')) return '!';
  return String(found.reduce((n, b) => n + (Number(b) || 0), 0));
}

export function Sidebar({ routes, hubs, route, overlay = false }) {
  const { session, sync, updater, addon, list, badges } = useNav(routes, hubs, overlay);
  const { guild, user, role } = session;
  const syncInfo = describeSync(sync);
  const updates = describeUpdates(updater, addon);
  const current = hubOf(route);

  const link = (h) => {
    const active = h.id === current;
    const badge = hubBadge(h, badges);
    return html`<li key=${h.id}>
      <${Link} href=${h.href} class=${cx('nav-link', active && 'is-active')} activeClass="" aria-current=${active ? 'page' : undefined} title=${overlay ? h.title : undefined}>
        <${Icon} name=${h.icon} />
        <span class="nav-label">${h.title}</span>
        ${badge ? html`<span class="nav-badge" aria-label=${badgeLabel(badge)}>${badge}</span>` : null}
      <//>
    </li>`;
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
      <ul class="nav-list">${list.filter((h) => !h.foot).map(link)}</ul>
      <ul class="nav-list nav-list--foot">${list.filter((h) => h.foot).map(link)}</ul>
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
        ${role ? html`<span class="who-role">${ROLE_NAMES[role] || role}</span>` : null}
      <//>` : null}
    </div>
  </aside>`;
}

// The sub-tabs of the current section, along the top of the content. Hidden when the section has one page.
// A detail page (a raid, a character) keeps its parent's tab lit: '/raids/12' lights "Raids".
export function HubTabs({ routes, hubs, route, path, overlay = false }) {
  const { list, badges } = useNav(routes, hubs, overlay);
  const hub = list.find((h) => h.id === hubOf(route));
  if (!hub || hub.tabs.length < 2) return null;
  return html`<nav class="hub-tabs" aria-label=${`${hub.title} pages`}>
    <span class="hub-tabs-name"><${Icon} name=${hub.icon} />${hub.title}</span>
    <ul>
      ${hub.tabs.map((r) => {
        const active = isActivePath(path, r.path, r.path === '/');
        return html`<li key=${r.path}>
          <${Link} href=${r.path} class=${cx('hub-tab', active && 'is-active')} activeClass="" aria-current=${active ? 'page' : undefined}>
            ${r.tab || r.title}
            ${badges[r.path] ? html`<span class="nav-badge" aria-label=${badgeLabel(badges[r.path])}>${badges[r.path]}</span>` : null}
          <//>
        </li>`;
      })}
    </ul>
  </nav>`;
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
