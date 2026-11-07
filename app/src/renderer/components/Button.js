// Button, ConfirmButton and CopyButton.
import { html, cx, useState, useEffect, useRef } from '../lib/html.js';
import { Link } from '../lib/router.js';
import { toast } from '../lib/toast.js';
import { Icon } from './Icon.js';

/**
 * <Button variant="primary|secondary|danger|ghost" size="sm|md|lg" busy icon="plus" onClick=...>Label</Button>
 * - `href` renders a link styled as a button (app routes like "/raids", or https:// links for the browser).
 * - `busy` shows a spinner and blocks clicks. `label` sets aria-label/title (required for icon-only buttons).
 * - `elRef` receives the DOM element (function components cannot take `ref` without preact/compat).
 */
export function Button({
  variant = 'secondary', size, busy = false, disabled = false, type = 'button', icon, iconRight, href,
  label, block = false, children, class: cls, elRef, ...rest
}) {
  const iconOnly = icon && (children === undefined || children === null || children === false);
  const classes = cx('btn', `btn--${variant}`, size && size !== 'md' && `btn--${size}`, block && 'btn--block', iconOnly && 'btn--icon', busy && 'is-busy', cls);
  const content = html`
    ${busy ? html`<span class=${cx('spinner', size === 'lg' ? 'spinner--sm' : 'spinner--xs')} aria-hidden="true"></span>` : icon ? html`<${Icon} name=${icon} />` : null}
    ${iconOnly ? null : html`<span class="btn-label">${children}</span>`}
    ${iconRight && !busy ? html`<${Icon} name=${iconRight} />` : null}`;
  if (href && !disabled) {
    return html`<${Link} href=${href} class=${classes} aria-label=${label} title=${label} ...${rest}>${content}<//>`;
  }
  return html`<button type=${type} class=${classes} disabled=${disabled || busy} aria-busy=${busy ? 'true' : undefined}
    aria-label=${label} title=${label} ref=${elRef} ...${rest}>${content}</button>`;
}

/**
 * A button that asks inline before doing something that cannot be undone:
 *   <ConfirmButton onConfirm=${() => api.del(...)} question="Remove Mokra?">Remove</ConfirmButton>
 * The first click swaps the button for "Sure? [Yes] [No]". Escape or No cancels; it also cancels itself after 6 s.
 * `onConfirm` may return a Promise; the Yes button shows a spinner until it settles.
 */
export function ConfirmButton({
  onConfirm, question = 'Sure?', yes = 'Yes', no = 'No', variant = 'secondary', confirmVariant = 'danger',
  size = 'sm', icon, disabled, busy, children, class: cls, ...rest
}) {
  const [asking, setAsking] = useState(false);
  const [working, setWorking] = useState(false);
  const yesRef = useRef(null);
  const triggerRef = useRef(null);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  useEffect(() => {
    if (!asking || working) return undefined;
    yesRef.current?.focus();
    const t = setTimeout(() => setAsking(false), 6000);
    return () => clearTimeout(t);
  }, [asking, working]);

  const cancel = () => {
    setAsking(false);
    setTimeout(() => triggerRef.current?.focus(), 0);
  };
  const confirm = async () => {
    setWorking(true);
    try {
      await onConfirm?.();
    } catch (err) {
      toast(err?.message || 'That did not work. Please try again.', 'alarm');
    } finally {
      if (mounted.current) { setWorking(false); setAsking(false); }
    }
  };

  if (!asking) {
    return html`<${Button} variant=${variant} size=${size} icon=${icon} disabled=${disabled} busy=${busy} class=${cls}
      elRef=${triggerRef} onClick=${() => setAsking(true)} ...${rest}>${children}<//>`;
  }
  return html`<span class="confirm" role="group" aria-label=${question}
      onKeyDown=${(e) => { if (e.key === 'Escape') { e.stopPropagation(); cancel(); } }}>
    <span class="confirm-q">${question}</span>
    <${Button} variant=${confirmVariant} size=${size} busy=${working} elRef=${yesRef} onClick=${confirm}>${yes}<//>
    <${Button} variant="ghost" size=${size} disabled=${working} onClick=${cancel}>${no}<//>
  </span>`;
}

// Copies text to the clipboard and says so.
export function CopyButton({ text, label = 'Copy', done = 'Copied.', size = 'sm', variant = 'secondary', ...rest }) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(String(text ?? ''));
      toast(done, 'ok');
    } catch {
      toast('Could not copy. Select the text and press Ctrl+C.', 'warn');
    }
  };
  return html`<${Button} size=${size} variant=${variant} icon="copy" onClick=${copy} ...${rest}>${label}<//>`;
}
