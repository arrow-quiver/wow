// Accessible modal dialog: traps focus, Escape and the backdrop close it, focus returns to where it was.
//   html`<${Modal} open=${open} title="Schedule a raid" onClose=${() => setOpen(false)}
//          footer=${html`<${Button} variant="primary" onClick=${save}>Schedule<//>`}>...form...<//>`
// size: 'sm' | 'md' | 'lg'. `dismissable={false}` keeps it open on backdrop click/Escape (e.g. while saving).
import { html, cx, useEffect, useRef, useId } from '../lib/html.js';
import { Button } from './Button.js';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

let openCount = 0; // nested modals: only the top one reacts to Escape

export function Modal({ open, title, onClose, children, footer, size = 'md', dismissable = true, initialFocus, class: cls }) {
  const boxRef = useRef(null);
  const titleId = `m-${useId()}`;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const dismissRef = useRef(dismissable);
  dismissRef.current = dismissable;

  useEffect(() => {
    if (!open) return undefined;
    openCount++;
    const depth = openCount;
    const previous = document.activeElement;
    const box = boxRef.current;
    // Focus the requested element, else the first field, else the dialog itself.
    const first = (initialFocus && box?.querySelector(initialFocus))
      || box?.querySelector('.modal-body ' + FOCUSABLE.split(', ').join(', .modal-body '))
      || box;
    setTimeout(() => first?.focus?.(), 0);

    const onKey = (e) => {
      if (depth !== openCount) return;
      if (e.key === 'Escape' && dismissRef.current) {
        e.preventDefault();
        e.stopPropagation();
        closeRef.current?.();
      } else if (e.key === 'Tab' && box) {
        const items = [...box.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
        if (!items.length) { e.preventDefault(); box.focus(); return; }
        const firstEl = items[0];
        const lastEl = items[items.length - 1];
        if (e.shiftKey && (document.activeElement === firstEl || document.activeElement === box)) { e.preventDefault(); lastEl.focus(); }
        else if (!e.shiftKey && document.activeElement === lastEl) { e.preventDefault(); firstEl.focus(); }
        else if (!box.contains(document.activeElement)) { e.preventDefault(); firstEl.focus(); }
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      openCount--;
      if (previous && typeof previous.focus === 'function' && document.contains(previous)) previous.focus();
    };
  }, [open]);

  if (!open) return null;
  return html`<div class="modal-backdrop" onMouseDown=${(e) => { if (e.target === e.currentTarget && dismissable) onClose?.(); }}>
    <div class=${cx('modal', size !== 'md' && `modal--${size}`, cls)} role="dialog" aria-modal="true" aria-labelledby=${titleId} tabIndex="-1" ref=${boxRef}>
      <div class="modal-head">
        <h2 class="modal-title" id=${titleId}>${title}</h2>
        ${dismissable ? html`<${Button} variant="ghost" size="sm" icon="close" label="Close" onClick=${() => onClose?.()} />` : null}
      </div>
      <div class="modal-body">${children}</div>
      ${footer ? html`<div class="modal-foot">${footer}</div>` : null}
    </div>
  </div>`;
}
