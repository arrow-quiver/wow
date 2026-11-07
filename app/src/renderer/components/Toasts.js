// Toast region. The shell renders <Toasts/> once; call toast(message, kind) from anywhere.
import { html } from '../lib/html.js';
import { useStore } from '../lib/store.js';
import { toastStore, toast, dismiss, hold, release } from '../lib/toast.js';
import { Icon } from './Icon.js';

export { toast, dismiss };

const ICON = { ok: 'ok', info: 'info', warn: 'alert', alarm: 'alert' };

export function Toasts() {
  const list = useStore(toastStore);
  return html`<div class="toasts" aria-live="polite" aria-relevant="additions">
    ${list.map((t) => html`<div key=${t.id} class=${`toast toast--${t.kind}`} role=${t.kind === 'alarm' ? 'alert' : 'status'}
        onMouseEnter=${() => hold(t.id)} onMouseLeave=${() => release(t.id)}>
      <${Icon} name=${ICON[t.kind] || 'info'} />
      <div class="toast-msg">${t.message}</div>
      <button type="button" class="toast-close" aria-label="Dismiss" onClick=${() => dismiss(t.id)}><${Icon} name="close" /></button>
    </div>`)}
  </div>`;
}
