// Page and Card, the two building blocks of every screen.
//
// <Page title="Raids" actions=${html`<${Button} variant="primary" icon="plus">Schedule<//>`} lede="Sign up for what's coming.">
// The title and actions are shown in the window's top bar (the drag strip); the body scrolls below it.
// width: 'normal' (default, max 1180px) | 'wide' (full width) | 'narrow' (760px, for forms and settings).
import { html, cx, useEffect, useLayoutEffect, useRef } from '../lib/html.js';
import { createStore } from '../lib/store.js';

// What the top bar shows. Written by the mounted Page, read by the shell's TopBar.
export const pageStore = createStore({ owner: null, title: null, actions: null, back: undefined });

export function Page({ title, actions, lede, back, width = 'normal', children, class: cls }) {
  const token = useRef({});
  // Runs on every render so the top bar shows the current actions (their busy states, labels...).
  useLayoutEffect(() => {
    pageStore.set({ owner: token.current, title: title ?? null, actions: actions ?? null, back });
  });
  useLayoutEffect(() => () => {
    if (pageStore.get().owner === token.current) pageStore.set({ owner: null, title: null, actions: null, back: undefined });
  }, []);
  useEffect(() => {
    document.title = title ? `${title} · Guild Camp` : 'Guild Camp';
  }, [title]);

  return html`<div class=${cx('page', width !== 'normal' && `page--${width}`, cls)}>
    ${lede ? html`<p class="page-lede">${lede}</p>` : null}
    ${children}
  </div>`;
}

/**
 * <Card title="Upcoming" sub="next 2 weeks" actions=${...} footer=${...} flush tone="accent|alarm">body</Card>
 * `flush` removes the body padding (for tables and lists that run edge to edge).
 */
export function Card({ title, sub, actions, footer, flush = false, tone, children, class: cls, id }) {
  const hasHead = title || actions;
  return html`<section class=${cx('card', flush && 'card--flush', tone && `card--${tone}`, cls)} id=${id}>
    ${hasHead ? html`<header class="card-head">
      ${title ? html`<h2 class="card-title">${title}${sub ? html`<span class="card-sub">${sub}</span>` : null}</h2>` : html`<div class="spacer"></div>`}
      ${actions ? html`<div class="card-actions">${actions}</div>` : null}
    </header>` : null}
    <div class="card-body">${children}</div>
    ${footer ? html`<footer class="card-foot">${footer}</footer>` : null}
  </section>`;
}

// A labelled number for dashboards: <Stat label="Online" value="7" hint="of 42 members" />
export function Stat({ label, value, hint, class: cls }) {
  return html`<div class=${cx('stat', cls)}>
    <span class="stat-label">${label}</span>
    <span class="stat-value">${value}</span>
    ${hint ? html`<span class="stat-hint">${hint}</span>` : null}
  </div>`;
}
