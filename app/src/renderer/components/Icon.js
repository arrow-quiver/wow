// Line icons (24×24, stroke = currentColor). <Icon name="raids"/>. Unknown names render nothing.
import { html } from '../lib/html.js';

// Each entry is a list of SVG path "d" strings, or [tag, attrs] pairs for circles.
const ICONS = {
  // navigation
  camp: ['M12 3c2.2 3 4.5 4.8 4.5 8.4a4.5 4.5 0 0 1-9 0C7.5 7.8 9.8 6 12 3z', 'M12 9.5c1 1.4 2 2.4 2 4a2 2 0 0 1-4 0c0-1.6 1-2.6 2-4z', 'M4 21l16-3', 'M4 18l16 3'],
  coach: [['circle', { cx: 12, cy: 12, r: 9 }], 'M15.8 8.2l-2.3 5.3-5.3 2.3 2.3-5.3z'],
  raids: ['M14.5 17.5L3 6V3h3l11.5 11.5', 'M13 19l6-6', 'M16 16l4 4', 'M19 21l2-2', 'M9.5 17.5L21 6V3h-3L6.5 14.5', 'M11 19l-6-6', 'M8 16l-4 4', 'M5 21l-2-2'],
  dungeons: ['M5 21V10a7 7 0 0 1 14 0v11', 'M3 21h18', 'M9 21v-8', 'M12 21v-9.5', 'M15 21v-8', 'M5 15h14'],
  crafters: ['M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.1-3.1a6 6 0 0 1-7.9 7.9l-6.4 6.4a2.1 2.1 0 0 1-3-3l6.4-6.4a6 6 0 0 1 7.9-7.9z'],
  requests: ['M8 21h11a2 2 0 0 0 2-2v-1H10v1a2 2 0 1 1-4 0V5a2 2 0 0 0-2-2', 'M19 17V5a2 2 0 0 0-2-2H4', 'M10 8h6', 'M10 12h6'],
  partners: [['circle', { cx: 9, cy: 8, r: 3.5 }], 'M2.5 20a6.5 6.5 0 0 1 13 0', 'M16 4.6a3.5 3.5 0 0 1 0 6.8', 'M18 14.2a6.5 6.5 0 0 1 3.5 5.8'],
  roster: ['M9 6h12', 'M9 12h12', 'M9 18h12', 'M4 6h.01', 'M4 12h.01', 'M4 18h.01'],
  bank: ['M3 10h18v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z', 'M3 10V8a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4v2', 'M10 10v3h4v-3'],
  prices: ['M3 3v18h18', 'M7 15l4-4 3 3 5-6'],
  gift: ['M20 12v10H4V12', 'M2 7h20v5H2z', 'M12 22V7', 'M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z', 'M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z'],
  store: ['M3 9l1.5-5h15L21 9', 'M3 9h18v2a3 3 0 0 1-6 0 3 3 0 0 1-6 0 3 3 0 0 1-6 0V9z', 'M5 13v8h14v-8', 'M10 21v-5h4v5'],
  trophy: ['M6 9H4.5a2.5 2.5 0 0 1 0-5H6', 'M18 9h1.5a2.5 2.5 0 0 0 0-5H18', 'M4 22h16', 'M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22', 'M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22', 'M18 2H6v7a6 6 0 0 0 12 0V2z'],
  war: ['M14.5 17.5 3 6V3h3l11.5 11.5', 'M13 19l6-6', 'M16 16l4 4', 'M19 21l2-2', 'M14.5 6.5 18 3h3v3l-3.5 3.5', 'M5 14l4 4', 'M7 17l-3 3', 'M3 19l2 2'],
  deals: ['M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z', 'M7.5 7.5h.01'],
  drives: ['M3 7.5l9-4.5 9 4.5v9L12 21l-9-4.5z', 'M3 7.5l9 4.5 9-4.5', 'M12 12v9'],
  loot: ['M6 3h12l4 6-10 12L2 9z', 'M2 9h20', 'M12 21L8.5 9 12 3l3.5 6z'],
  admin: ['M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z', 'M9 12l2 2 4-4'],
  banner: ['M5 21V4', 'M5 4h13l-2.5 4L18 12H5'],
  addon: ['M9 2v5', 'M15 2v5', 'M6 7h12v4a6 6 0 0 1-12 0z', 'M12 17v5'],
  settings: ['M4 6h9', 'M17 6h3', 'M15 4v4', 'M4 12h3', 'M11 12h9', 'M9 10v4', 'M4 18h11', 'M19 18h1', 'M17 16v4'],
  updates: ['M21 12a9 9 0 1 1-2.6-6.4L21 8', 'M21 3v5h-5'],
  releases: ['M12 15V3', 'M7 8l5-5 5 5', 'M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4'],
  character: [['circle', { cx: 12, cy: 8, r: 4 }], 'M4 21a8 8 0 0 1 16 0'],
  // actions & states
  back: ['M15 18l-6-6 6-6'],
  forward: ['M9 18l6-6-6-6'],
  close: ['M18 6L6 18', 'M6 6l12 12'],
  check: ['M20 6L9 17l-5-5'],
  alert: ['M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z', 'M12 9v4', 'M12 17h.01'],
  info: [['circle', { cx: 12, cy: 12, r: 9 }], 'M12 16v-4', 'M12 8h.01'],
  ok: [['circle', { cx: 12, cy: 12, r: 9 }], 'M8.5 12.5l2.5 2.5 5-5'],
  off: [['circle', { cx: 12, cy: 12, r: 9 }], 'M8 12h8'],
  external: ['M15 3h6v6', 'M10 14L21 3', 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6'],
  copy: ['M9 9h11v11H9z', 'M5 15H4V4h11v1'],
  refresh: ['M3 12a9 9 0 0 1 15.4-6.4L21 8', 'M21 3v5h-5', 'M21 12a9 9 0 0 1-15.4 6.4L3 16', 'M3 21v-5h5'],
  plus: ['M12 5v14', 'M5 12h14'],
  minus: ['M5 12h14'],
  folder: ['M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'],
  download: ['M12 3v12', 'M7 10l5 5 5-5', 'M4 21h16'],
  upload: ['M12 21V9', 'M7 14l5-5 5 5', 'M4 3h16'],
  signout: ['M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4', 'M16 17l5-5-5-5', 'M21 12H9'],
  search: [['circle', { cx: 11, cy: 11, r: 7 }], 'M21 21l-4.3-4.3'],
  trash: ['M3 6h18', 'M8 6V4h8v2', 'M6 6l1 14h10l1-14'],
  edit: ['M12 20h9', 'M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z'],
  sort: ['M8 4v16', 'M4 8l4-4 4 4', 'M16 20V4', 'M12 16l4 4 4-4'],
  sortAsc: ['M12 19V5', 'M5 12l7-7 7 7'],
  sortDesc: ['M12 5v14', 'M19 12l-7 7-7-7'],
  bell: ['M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9', 'M13.7 21a2 2 0 0 1-3.4 0'],
  sync: ['M21 12a9 9 0 0 1-15 6.7L3 16', 'M3 21v-5h5', 'M3 12a9 9 0 0 1 15-6.7L21 8', 'M21 3v5h-5'],
  game: ['M6 11h4', 'M8 9v4', 'M15 12h.01', 'M18 10h.01', 'M17.3 5H6.7a4 4 0 0 0-4 3.6L2 15a3 3 0 0 0 5.4 2l1.1-1.5h7l1.1 1.5A3 3 0 0 0 22 15l-.7-6.4a4 4 0 0 0-4-3.6z'],
  shield: ['M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z'],
  link: ['M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7', 'M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7'],
  battlenet: [['circle', { cx: 12, cy: 12, r: 9 }], 'M7 9.5c3-2 7-2.5 10 0', 'M7.5 14.5c2.5 2 6.5 2.3 9 .2', 'M12 3c-2 3-2.4 9 0 18', 'M12 3c2 3 2.4 9 0 18'],
  key: [['circle', { cx: 7.5, cy: 15.5, r: 4.5 }], 'M10.7 12.3L21 2', 'M16 7l3 3', 'M19 4l2 2'],
  spark: ['M12 3v4', 'M12 17v4', 'M3 12h4', 'M17 12h4', 'M5.6 5.6l2.8 2.8', 'M15.6 15.6l2.8 2.8', 'M5.6 18.4l2.8-2.8', 'M15.6 8.4l2.8-2.8'],
  sun: [['circle', { cx: 12, cy: 12, r: 4 }], 'M12 2v2', 'M12 20v2', 'M4.9 4.9l1.4 1.4', 'M17.7 17.7l1.4 1.4', 'M2 12h2', 'M20 12h2', 'M4.9 19.1l1.4-1.4', 'M17.7 6.3l1.4-1.4'],
  moon: ['M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z'],
  build: ['M9 4h6v4H9z', 'M5 8h14v12H5z', 'M9 12h6', 'M9 16h6'],
};

export const ICON_NAMES = Object.keys(ICONS);

export function Icon({ name, class: cls, title, size }) {
  const shapes = ICONS[name];
  if (!shapes) return null;
  const style = size ? `width:${size}px;height:${size}px` : undefined;
  return html`<svg class=${cls ? `icon ${cls}` : 'icon'} style=${style} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden=${title ? undefined : 'true'}
    role=${title ? 'img' : undefined} focusable="false">
    ${title ? html`<title>${title}</title>` : null}
    ${shapes.map((s) => (typeof s === 'string' ? html`<path d=${s} />` : html`<circle ...${s[1]} />`))}
  </svg>`;
}

// The campfire mark (old site's fireSvg), animated by CSS unless reduced motion is on.
export function Campfire({ class: cls }) {
  return html`<svg class=${cls ? `campfire ${cls}` : 'campfire'} viewBox="0 0 120 140" aria-hidden="true" focusable="false">
    <path class="flame f1" d="M60 18 C75 45 92 62 86 92 C82 112 68 120 60 120 C52 120 38 112 34 92 C28 62 45 45 60 18Z" />
    <path class="flame f2" d="M60 52 C68 68 76 78 73 96 C71 108 65 113 60 113 C55 113 49 108 47 96 C44 78 52 68 60 52Z" />
    <rect class="log" x="22" y="118" width="76" height="9" rx="4.5" transform="rotate(-10 60 122)" />
    <rect class="log" x="22" y="118" width="76" height="9" rx="4.5" transform="rotate(10 60 122)" />
  </svg>`;
}
