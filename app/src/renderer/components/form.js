// Form controls. Each control takes `label`, `hint` and `error` and wires up ids and aria for you.
// `onValue(value)` is a shortcut for onInput/onChange that hands you the value (or checked state).
//   html`<${Input} label="Guild name" value=${name} onValue=${setName} maxLength="40" required />`
import { html, cx, useId } from '../lib/html.js';

// Wraps any control with a label, hint and error. Pass `id` of the control so the label points at it.
export function Field({ label, hint, error, id, required = false, children, class: cls }) {
  return html`<div class=${cx('field', cls)}>
    ${label ? html`<label class="field-label" for=${id}>${label}${required ? html`<span class="field-req" aria-hidden="true">*</span>` : null}</label>` : null}
    ${children}
    ${hint ? html`<p class="field-hint" id=${id ? `${id}-hint` : undefined}>${hint}</p>` : null}
    ${error ? html`<p class="field-error" id=${id ? `${id}-error` : undefined} role="alert">${error}</p>` : null}
  </div>`;
}

function describedBy(id, hint, error) {
  const ids = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean);
  return ids.length ? ids.join(' ') : undefined;
}

function useControlId(id) {
  const auto = useId();
  return id || `f-${auto}`;
}

export function Input({ label, hint, error, id, onValue, onInput, class: cls, fieldClass, required, type = 'text', ...rest }) {
  const cid = useControlId(id);
  const input = html`<input id=${cid} type=${type} class=${cx('input', cls)} required=${required}
    aria-invalid=${error ? 'true' : undefined} aria-describedby=${describedBy(cid, hint, error)}
    onInput=${(e) => { onInput?.(e); onValue?.(e.currentTarget.value); }} ...${rest} />`;
  if (!label && !hint && !error) return input;
  return html`<${Field} label=${label} hint=${hint} error=${error} id=${cid} required=${required} class=${fieldClass}>${input}<//>`;
}

export function Textarea({ label, hint, error, id, onValue, onInput, class: cls, fieldClass, required, rows = 4, ...rest }) {
  const cid = useControlId(id);
  const el = html`<textarea id=${cid} class=${cx('textarea', cls)} rows=${rows} required=${required}
    aria-invalid=${error ? 'true' : undefined} aria-describedby=${describedBy(cid, hint, error)}
    onInput=${(e) => { onInput?.(e); onValue?.(e.currentTarget.value); }} ...${rest}></textarea>`;
  if (!label && !hint && !error) return el;
  return html`<${Field} label=${label} hint=${hint} error=${error} id=${cid} required=${required} class=${fieldClass}>${el}<//>`;
}

// options: ['Horde', 'Alliance'] or [{ value, label, disabled }]. `placeholder` adds a first empty option.
export function Select({ label, hint, error, id, options = [], value, placeholder, onValue, onChange, class: cls, fieldClass, required, ...rest }) {
  const cid = useControlId(id);
  const opts = options.map((o) => (typeof o === 'object' && o !== null ? o : { value: o, label: String(o) }));
  const el = html`<select id=${cid} class=${cx('select', cls)} required=${required}
    aria-invalid=${error ? 'true' : undefined} aria-describedby=${describedBy(cid, hint, error)}
    onChange=${(e) => { onChange?.(e); onValue?.(e.currentTarget.value); }} value=${value ?? ''} ...${rest}>
    ${placeholder !== undefined ? html`<option value="" disabled=${required}>${placeholder}</option>` : null}
    ${opts.map((o) => html`<option value=${o.value} disabled=${o.disabled} selected=${String(o.value) === String(value ?? '')}>${o.label ?? o.value}</option>`)}
  </select>`;
  if (!label && !hint && !error) return el;
  return html`<${Field} label=${label} hint=${hint} error=${error} id=${cid} required=${required} class=${fieldClass}>${el}<//>`;
}

export function Checkbox({ label, hint, id, checked = false, onValue, onChange, disabled, class: cls, ...rest }) {
  const cid = useControlId(id);
  return html`<label class=${cx('check', disabled && 'is-disabled', cls)} for=${cid}>
    <input id=${cid} type="checkbox" checked=${!!checked} disabled=${disabled}
      aria-describedby=${hint ? `${cid}-hint` : undefined}
      onChange=${(e) => { onChange?.(e); onValue?.(e.currentTarget.checked); }} ...${rest} />
    <span class="check-text"><span>${label}</span>${hint ? html`<span class="field-hint" id=${`${cid}-hint`}>${hint}</span>` : null}</span>
  </label>`;
}
