// Status and feedback: Spinner, Loading, Empty, ErrorBox, Notice, Pill, Progress, Async.
import { html, cx } from '../lib/html.js';
import { Icon } from './Icon.js';
import { Button } from './Button.js';

// size: 'xs' | 'sm' | 'md' | 'lg'. `label` is read by screen readers ('' to stay silent, e.g. inside a busy button).
export function Spinner({ size = 'md', label = 'Loading', class: cls }) {
  return html`<span class=${cx('spinner', size !== 'md' && `spinner--${size}`, cls)} role=${label ? 'status' : undefined}>
    ${label ? html`<span class="sr">${label}</span>` : null}
  </span>`;
}

// A centred spinner with a caption, for whole cards or pages.
export function Loading({ label = 'Loading…', class: cls }) {
  return html`<div class=${cx('loading', cls)} role="status" aria-live="polite"><${Spinner} label="" /><span>${label}</span></div>`;
}

// Empty state. `title` is the main line; children add detail; `action` is a button or link.
//   html`<${Empty} title="No raids yet." action=${html`<${Button}>Schedule one<//>`}>Officers schedule raids here.<//>`
export function Empty({ title = 'Nothing here yet.', icon = 'camp', children, action, compact = false, class: cls }) {
  return html`<div class=${cx('empty', compact && 'empty--compact', cls)}>
    ${icon ? html`<${Icon} name=${icon} class="empty-icon" />` : null}
    <p class="empty-title">${title}</p>
    ${children ? html`<p class="empty-body">${children}</p>` : null}
    ${action || null}
  </div>`;
}

// Shows an error (Error, { message }, or a string) with an optional Retry button.
export function ErrorBox({ error, title, onRetry, retryLabel = 'Try again', children, class: cls }) {
  const message = typeof error === 'string' ? error : error && error.message ? error.message : '';
  const heading = title || (error && error.status === 401 ? 'You are signed out.' : 'Something went wrong.');
  return html`<div class=${cx('errorbox', cls)} role="alert">
    <${Icon} name="alert" />
    <div class="errorbox-body">
      <div><strong class="errorbox-title">${heading}</strong>${message && message !== heading ? html`<p>${message}</p>` : null}</div>
      ${children || null}
      ${onRetry ? html`<${Button} size="sm" icon="refresh" onClick=${onRetry}>${retryLabel}<//>` : null}
    </div>
  </div>`;
}

// An inline message box. kind: 'info' | 'ok' | 'warn' | 'alarm'.
export function Notice({ kind = 'info', title, children, icon, class: cls }) {
  const name = icon || (kind === 'ok' ? 'ok' : kind === 'info' ? 'info' : 'alert');
  return html`<div class=${cx('notice', `notice--${kind}`, cls)} role=${kind === 'alarm' ? 'alert' : undefined}>
    <${Icon} name=${name} />
    <div class="notice-body">${title ? html`<strong>${title}</strong> ` : null}${children}</div>
  </div>`;
}

// kind: 'ok' | 'warn' | 'alarm' | 'info' | 'muted' | 'accent'. `dot` adds a small leading dot.
export function Pill({ kind = 'muted', dot = false, title, children, class: cls }) {
  return html`<span class=${cx('pill', `pill--${kind}`, cls)} title=${title}>${dot ? html`<span class="pill-dot" aria-hidden="true"></span>` : null}${children}</span>`;
}

// Progress bar. Omit `value` for an indeterminate bar. `label` names it for screen readers and shows above it
// together with the value when `showValue` is set (or a custom `valueText`).
export function Progress({ value, max = 100, label, showValue = false, valueText, kind, size, class: cls }) {
  const known = value !== undefined && value !== null && !Number.isNaN(Number(value));
  const pct = known && max > 0 ? Math.max(0, Math.min(100, (Number(value) / max) * 100)) : 0;
  const text = valueText ?? (known ? `${Math.round(pct)}%` : '');
  const bar = html`<div class=${cx('progress', kind && `progress--${kind}`, size && `progress--${size}`, !known && 'is-indeterminate', !label && !showValue && cls)}
      role="progressbar" aria-label=${label || 'Progress'} aria-valuemin="0" aria-valuemax=${max}
      aria-valuenow=${known ? Number(value) : undefined} aria-valuetext=${text || undefined}>
    <span class="progress-bar" style=${`width:${pct}%`}></span>
  </div>`;
  if (!label && !showValue) return bar;
  return html`<div class=${cx('progress-wrap', cls)}>
    <div class="progress-meta"><span>${label || ''}</span>${showValue || valueText ? html`<span class="num">${text}</span>` : null}</div>
    ${bar}
  </div>`;
}

// Renders the three states of a useApi() result: spinner, error with retry, or children(data).
//   html`<${Async} q=${raids}>${(data) => html`...`}<//>`
export function Async({ q, children, loadingLabel, errorTitle }) {
  if (!q) return null;
  if (q.error && q.data === undefined) return html`<${ErrorBox} error=${q.error} title=${errorTitle} onRetry=${q.reload} />`;
  if (q.loading && q.data === undefined) return html`<${Loading} label=${loadingLabel} />`;
  const render = Array.isArray(children) ? children[0] : children;
  return typeof render === 'function' ? render(q.data) : render || null;
}
