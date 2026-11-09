// Tabs (the tab strip only; render the matching panel yourself).
//   const [tab, setTab] = useState('upcoming');
//   html`<${Tabs} tabs=${[{ id: 'upcoming', label: 'Upcoming', count: 3 }, { id: 'past', label: 'Past' }]}
//          value=${tab} onChange=${setTab} label="Raid lists" />
//        <div role="tabpanel" id=${tabPanelId('upcoming')} aria-labelledby=${tabId('upcoming')}>...</div>`
// Arrow keys, Home and End move between tabs. To keep the tab in the URL, pair with setQuery({ tab }).
import { html, useRef } from '../lib/html.js';

export const tabId = (id, prefix = 'tab') => `${prefix}-${id}`;
export const tabPanelId = (id, prefix = 'tab') => `${prefix}-${id}-panel`;

export function Tabs({ tabs = [], value, onChange, label = 'Sections', idPrefix = 'tab', class: cls }) {
  const listRef = useRef(null);
  const enabled = tabs.filter((t) => !t.disabled);

  const onKeyDown = (e) => {
    const i = enabled.findIndex((t) => t.id === value);
    let next = null;
    if (e.key === 'ArrowRight') next = enabled[(i + 1) % enabled.length];
    else if (e.key === 'ArrowLeft') next = enabled[(i - 1 + enabled.length) % enabled.length];
    else if (e.key === 'Home') next = enabled[0];
    else if (e.key === 'End') next = enabled[enabled.length - 1];
    if (!next) return;
    e.preventDefault();
    onChange?.(next.id);
    setTimeout(() => listRef.current?.querySelector(`#${CSS.escape(tabId(next.id, idPrefix))}`)?.focus(), 0);
  };

  return html`<div class=${cls ? `tabs ${cls}` : 'tabs'} role="tablist" aria-label=${label} ref=${listRef} onKeyDown=${onKeyDown}>
    ${tabs.map((t) => {
      const selected = t.id === value;
      return html`<button key=${t.id} type="button" role="tab" class="tab" id=${tabId(t.id, idPrefix)}
          aria-selected=${selected ? 'true' : 'false'} aria-controls=${tabPanelId(t.id, idPrefix)}
          tabIndex=${selected ? 0 : -1} disabled=${t.disabled} onClick=${() => onChange?.(t.id)}>
        ${t.label}
        ${t.count !== undefined && t.count !== null ? html`<span class="tab-count">${t.count}</span>` : null}
      </button>`;
    })}
  </div>`;
}
