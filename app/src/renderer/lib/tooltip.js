// Item and spell tooltips for Wowhead links, drawn by the app itself.
//
// The window that has the preload bridge (window.gc) runs no third-party script. Instead of loading
// Wowhead's tooltips.js, this module asks Wowhead's tooltip service for the same JSON that script
// uses and shows it in our own box:
//
//   GET https://nether.wowhead.com/tooltip/<item|spell>/<id>?dataEnv=<n>&locale=0
//   → { name, quality, icon, tooltip: "<table>…</table>" }   or   { error }
//
// The tooltip HTML comes from another site, so it is rebuilt from scratch by sanitizeTooltipHtml()
// (a short list of tags, class names only, every piece of text escaped) and parsed in an inert
// <template> before it is shown. Links inside a tooltip become plain text.
//
// Elements with data-wowhead="item=19019&domain=classic" (ItemLink / SpellLink in components/wow.js)
// get the tooltip on hover and on keyboard focus. initTooltips() attaches one set of listeners to the
// document (event delegation), so links that pages add later need nothing extra. Escape hides it.
//
// Everything above initTooltips() is pure and tested in plain Node (test/renderer.test.mjs).

export const TOOLTIP_HOST = 'https://nether.wowhead.com';
export const ICON_BASE = 'https://wow.zamimg.com/images/wow/icons/medium/';

// Wowhead's data environment for each data-wowhead domain, from tooltips.js (WH.dataEnv and the
// domain selectors): no domain = Retail (MAIN, 1), "classic" = CLASSIC (4), "forever" = CLASSICPLUS (16).
export const DATA_ENV = Object.freeze({ '': 1, classic: 4, forever: 16 });
export const KINDS = Object.freeze(['item', 'spell']);

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** "item=19019&domain=classic" → { kind: 'item', id: 19019, domain: 'classic' } | null. */
export function parseWowheadData(attr) {
  if (typeof attr !== 'string' || !attr || attr.length > 200) return null;
  let params;
  try { params = new URLSearchParams(attr); } catch { return null; }
  for (const kind of KINDS) {
    const raw = params.get(kind);
    if (raw !== null && /^\d{1,8}$/.test(raw) && Number(raw) > 0) {
      const d = (params.get('domain') || '').toLowerCase();
      // Wowhead treats a domain it doesn't know as Retail too.
      return { kind, id: Number(raw), domain: own(DATA_ENV, d) ? d : '' };
    }
  }
  return null;
}

/** The tooltip JSON address for a parsed data-wowhead value (or the attribute itself). */
export function tooltipUrl(ref) {
  const r = typeof ref === 'string' ? parseWowheadData(ref) : ref;
  if (!r || !KINDS.includes(r.kind) || !Number.isInteger(r.id) || r.id <= 0) return null;
  const env = DATA_ENV[own(DATA_ENV, r.domain || '') ? r.domain || '' : ''];
  return `${TOOLTIP_HOST}/tooltip/${r.kind}/${r.id}?dataEnv=${env}&locale=0`;
}

/** Wowhead icon name → the medium (36 px) icon on Wowhead's image host, or null. */
export function iconUrl(icon) {
  return typeof icon === 'string' && /^[a-z0-9_-]{1,80}$/i.test(icon) ? `${ICON_BASE}${icon.toLowerCase()}.jpg` : null;
}

/** The parts of a tooltip reply we use, checked. → { name, quality, icon, html } | null. */
export function readTooltip(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.error) return null;
  const name = typeof data.name === 'string' ? data.name.slice(0, 200) : '';
  const q = Number(data.quality);
  const html = typeof data.tooltip === 'string' ? sanitizeTooltipHtml(data.tooltip.slice(0, 50000)) : '';
  if (!name && !html) return null;
  return { name, quality: Number.isInteger(q) && q >= 0 && q <= 7 ? q : null, icon: iconUrl(data.icon), html };
}

// ---------- sanitiser ----------

// Tags that may appear in a tooltip. Everything else is dropped (its text is kept).
export const ALLOWED_TAGS = Object.freeze(['table', 'tbody', 'tr', 'td', 'th', 'div', 'span', 'b', 'i', 'small', 'br', 'a']);
const ALLOWED = new Set(ALLOWED_TAGS);
// Dropped together with everything inside them.
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript', 'plaintext']);
const SUBTREE = new Set(['svg', 'math', 'template', 'object', 'select', 'head', 'frameset', 'applet', 'video', 'audio', 'canvas', 'picture', 'map']);
// Wowhead's own class names (quality colours, money, indents, its whtt-* layout classes). Anything else,
// including the app's own classes, is removed so a tooltip can't borrow the app's styles.
const CLASS_OK = /^(?:q[0-7]?|whtt-[a-z0-9-]{1,40}|wowhead-tooltip-[a-z0-9-]{1,40}|money(?:gold|silver|copper)|indent|icontiny)$/;
const MAX_DEPTH = 40;

function escapeText(text) {
  // Well-formed character references stay as they are (they are only text); any other & is escaped.
  return text
    .replace(/&(?!(?:[A-Za-z][A-Za-z0-9]{0,31}|#\d{1,7}|#[xX][0-9A-Fa-f]{1,6});)/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function cleanClass(value) {
  if (typeof value !== 'string') return '';
  return [...new Set(value.split(/\s+/).filter((c) => CLASS_OK.test(c)))].slice(0, 8).join(' ');
}

const TAG_START = /<(\/?)([A-Za-z][^\s/>]*)/y;
const SPACE = /[\s/]*/y;
const ATTR_NAME = /[^\s/>=][^\s/>=]*/y;
const UNQUOTED = /[^\s>]*/y;

/** Reads the attributes of a tag starting at `from`. → { attrs: [[name, value]], end, selfClosing } (end = index after '>'), or null when the tag never ends. */
function readAttributes(s, from) {
  const attrs = [];
  let i = from;
  for (;;) {
    SPACE.lastIndex = i;
    SPACE.exec(s);
    const before = i;
    i = SPACE.lastIndex;
    if (i >= s.length) return null;
    if (s[i] === '>') return { attrs, end: i + 1, selfClosing: s[i - 1] === '/' && i > before };
    ATTR_NAME.lastIndex = i;
    const m = ATTR_NAME.exec(s);
    if (!m) { i += 1; continue; } // a stray "=": skip it
    const name = m[0].toLowerCase();
    i = ATTR_NAME.lastIndex;
    let j = i;
    while (j < s.length && /\s/.test(s[j])) j += 1;
    let value = '';
    if (s[j] === '=') {
      j += 1;
      while (j < s.length && /\s/.test(s[j])) j += 1;
      const q = s[j];
      if (q === '"' || q === "'") {
        const close = s.indexOf(q, j + 1);
        if (close === -1) return null;
        value = s.slice(j + 1, close);
        i = close + 1;
      } else {
        UNQUOTED.lastIndex = j;
        value = UNQUOTED.exec(s)[0];
        i = UNQUOTED.lastIndex;
      }
    }
    if (attrs.length < 32) attrs.push([name, value]);
  }
}

/**
 * Rebuilds tooltip HTML from another site so it is safe to put into the page.
 * The output only ever contains the ALLOWED_TAGS, each with at most a class attribute made of
 * Wowhead's own class names, and escaped text. Comments, scripts, styles, event handlers, links
 * (href) and every other attribute are gone; <a> keeps only its text. Tags are balanced.
 */
export function sanitizeTooltipHtml(input) {
  const s = String(input ?? '');
  const n = s.length;
  const open = []; // allowed elements written and not closed yet
  const skip = []; // dropped elements whose contents are dropped too
  let out = '';
  let i = 0;
  while (i < n) {
    const lt = s.indexOf('<', i);
    if (lt !== i) {
      const end = lt === -1 ? n : lt;
      if (!skip.length) out += escapeText(s.slice(i, end));
      i = end;
      continue;
    }
    if (s.startsWith('<!--', i)) {
      const c = s.indexOf('-->', i + 4);
      i = c === -1 ? n : c + 3;
      continue;
    }
    TAG_START.lastIndex = i;
    const m = TAG_START.exec(s);
    if (!m) {
      const next = s[i + 1];
      if (next === '!' || next === '?' || next === '/') {
        // <!DOCTYPE>, <?xml?>, "</ >": skipped up to the next '>'
        const g = s.indexOf('>', i);
        i = g === -1 ? n : g + 1;
      } else {
        if (!skip.length) out += '&lt;';
        i += 1;
      }
      continue;
    }
    const closing = m[1] === '/';
    const name = m[2].toLowerCase();
    const tag = readAttributes(s, TAG_START.lastIndex);
    if (!tag) break; // a tag that never ends: the rest is part of it
    i = tag.end;

    if (closing) {
      if (skip.length) {
        if (skip[skip.length - 1] === name) skip.pop();
      } else if (ALLOWED.has(name) && name !== 'br' && open.includes(name)) {
        while (open.length) {
          const top = open.pop();
          out += `</${top}>`;
          if (top === name) break;
        }
      }
      continue;
    }

    if (RAW_TEXT.has(name)) {
      // Its contents are not markup: skip to its end tag (or the end of the input).
      const re = new RegExp(`</${name}(?=[\\s/>])`, 'ig');
      re.lastIndex = i;
      const r = re.exec(s);
      i = r ? r.index : n;
      continue;
    }
    if (SUBTREE.has(name)) {
      if (!tag.selfClosing) skip.push(name);
      continue;
    }
    if (skip.length || !ALLOWED.has(name)) continue;

    if (name === 'br') { out += '<br>'; continue; }
    if (open.length >= MAX_DEPTH) continue;
    const cls = cleanClass((tag.attrs.find(([k]) => k === 'class') || [])[1]);
    out += cls ? `<${name} class="${cls}">` : `<${name}>`;
    open.push(name);
  }
  while (open.length) out += `</${open.pop()}>`;
  return out;
}

/**
 * Second line of defence, run on the parsed <template> content before it is shown: removes any
 * element that is not allowed and any attribute other than class. (sanitizeTooltipHtml already
 * produces only allowed markup; this keeps it that way whatever the browser's parser does.)
 */
export function scrubTree(root) {
  const walk = (node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === 1) {
        const tag = child.localName;
        if (!ALLOWED.has(tag) || child.namespaceURI !== 'http://www.w3.org/1999/xhtml') { child.remove(); continue; }
        for (const a of [...child.attributes]) if (a.name !== 'class') child.removeAttribute(a.name);
        walk(child);
      } else if (child.nodeType !== 3) {
        child.remove(); // comments, processing instructions
      }
    }
  };
  walk(root);
  return root;
}

// ---------- the tooltip box (browser only) ----------

const SHOW_DELAY_MS = 120; // hover this long before anything is fetched or shown
const CACHE_MAX = 300;
const FAIL_TTL_MS = 60 * 1000; // a failed fetch is tried again after this long
const FETCH_TIMEOUT_MS = 10000;
const GAP = 14; // px between the cursor (or the link) and the box
const EDGE = 8; // px kept free at the window edges

const cache = new Map(); // url → { at, data: readTooltip() result | null (failed) }
const pending = new Map(); // url → { promise, controller }

function remember(url, data) {
  cache.delete(url);
  cache.set(url, { at: Date.now(), data });
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

function cached(url) {
  const hit = cache.get(url);
  if (!hit) return undefined;
  if (!hit.data && Date.now() - hit.at > FAIL_TTL_MS) { cache.delete(url); return undefined; }
  return hit.data;
}

function load(url) {
  const known = cached(url);
  if (known !== undefined) return Promise.resolve(known);
  if (pending.has(url)) return pending.get(url).promise;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const promise = fetch(url, { signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'force-cache' })
    .then((res) => (res.ok ? res.json() : null))
    .then((json) => { const data = readTooltip(json); remember(url, data); return data; })
    .catch(() => {
      // Offline, blocked or timed out: show just the name, and try again a minute later. (Leaving the
      // link before the reply came is not a failure.)
      if (controller.signal.reason !== 'left') remember(url, null);
      return null;
    })
    .finally(() => { clearTimeout(timer); pending.delete(url); });
  pending.set(url, { promise, controller });
  return promise;
}

let box = null;
let initialised = false;
const state = { el: null, url: null, timer: 0, x: 0, y: 0, byPointer: false, suppressed: null, frame: 0 };

function ensureBox() {
  if (box && box.isConnected) return box;
  box = document.createElement('div');
  box.className = 'gc-tooltip';
  box.id = 'gc-tooltip';
  box.setAttribute('role', 'tooltip');
  box.hidden = true;
  document.body.appendChild(box);
  return box;
}

function linkName(el) {
  return (el.textContent || '').trim().slice(0, 200);
}

function linkQuality(el) {
  const m = /(?:^|\s)q-([0-7])(?:\s|$)/.exec(el.className && typeof el.className === 'string' ? el.className : '');
  return m ? Number(m[1]) : null;
}

/** Fills the box: the full tooltip when `data` is there, otherwise just the name (and "Loading…" while it loads). */
function fill(el, data, loading) {
  const b = ensureBox();
  const head = document.createElement('div');
  head.className = 'gc-tooltip-inner';
  if (data && data.icon) {
    const img = document.createElement('img');
    img.className = 'gc-tooltip-icon';
    img.alt = '';
    img.width = 36;
    img.height = 36;
    img.referrerPolicy = 'no-referrer';
    img.src = data.icon;
    img.addEventListener('error', () => img.remove(), { once: true });
    head.appendChild(img);
  }
  const body = document.createElement('div');
  body.className = 'gc-tooltip-body';
  if (data && data.html) {
    const t = document.createElement('template');
    t.innerHTML = data.html;
    body.appendChild(scrubTree(t.content));
  } else {
    const name = document.createElement('div');
    const q = data && data.quality !== null ? data.quality : linkQuality(el);
    name.className = `gc-tooltip-name${q !== null && q !== undefined ? ` q${q}` : ''}`;
    name.textContent = (data && data.name) || linkName(el) || 'Unknown';
    body.appendChild(name);
    if (loading) {
      const wait = document.createElement('div');
      wait.className = 'gc-tooltip-loading';
      wait.textContent = 'Loading…';
      body.appendChild(wait);
    }
  }
  head.appendChild(body);
  b.replaceChildren(head);
}

function place() {
  if (!box || box.hidden || !state.el) return;
  const vw = document.documentElement.clientWidth || window.innerWidth;
  const vh = document.documentElement.clientHeight || window.innerHeight;
  const w = box.offsetWidth;
  const h = box.offsetHeight;
  let left;
  let top;
  if (state.byPointer) {
    left = state.x + GAP;
    top = state.y + GAP;
    if (left + w > vw - EDGE) left = state.x - GAP - w; // flip to the left of the cursor
    if (top + h > vh - EDGE) top = state.y - GAP - h; // and above it
  } else {
    const r = state.el.getBoundingClientRect();
    left = r.left;
    top = r.bottom + 6;
    if (top + h > vh - EDGE) top = r.top - 6 - h;
  }
  left = Math.max(EDGE, Math.min(left, vw - EDGE - w));
  top = Math.max(EDGE, Math.min(top, vh - EDGE - h));
  box.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
}

function schedulePlace() {
  if (state.frame) return;
  state.frame = requestAnimationFrame(() => { state.frame = 0; place(); });
}

function hide() {
  clearTimeout(state.timer);
  state.timer = 0;
  // Leaving before the reply arrived: stop waiting for it.
  const p = state.url && pending.get(state.url);
  if (p) p.controller.abort('left');
  if (state.el) state.el.removeAttribute('aria-describedby');
  state.el = null;
  state.url = null;
  if (box) { box.hidden = true; box.replaceChildren(); }
}

function show(el) {
  if (!el.isConnected || state.el !== el) return;
  const url = tooltipUrl(el.getAttribute('data-wowhead'));
  if (!url) { hide(); return; }
  state.url = url;
  const b = ensureBox();
  const known = cached(url);
  fill(el, known === undefined ? null : known, known === undefined);
  b.hidden = false;
  el.setAttribute('aria-describedby', b.id);
  place();
  if (known !== undefined) return;
  load(url).then((data) => {
    if (state.el !== el || state.url !== url) return;
    fill(el, data, false);
    place();
  });
}

function begin(el, byPointer) {
  if (state.el === el) return;
  hide();
  if (state.suppressed && state.suppressed !== el) state.suppressed = null;
  if (state.suppressed === el) return;
  state.el = el;
  state.byPointer = byPointer;
  state.timer = setTimeout(() => show(el), SHOW_DELAY_MS);
}

function targetOf(node) {
  return node && node.nodeType === 1 && typeof node.closest === 'function' ? node.closest('[data-wowhead]') : null;
}

function focusVisible(node) {
  try { return node.matches(':focus-visible'); } catch { return true; }
}

/** Attaches the tooltip listeners to the document once. Safe to call again; does nothing outside a browser. */
export function initTooltips() {
  if (initialised || typeof document === 'undefined') return;
  initialised = true;
  document.addEventListener('mouseover', (e) => {
    const el = targetOf(e.target);
    state.x = e.clientX;
    state.y = e.clientY;
    if (el) begin(el, true);
    else if (state.el && state.byPointer) hide();
  });
  document.addEventListener('mouseout', (e) => {
    const from = targetOf(e.target);
    if (!from) return;
    const to = e.relatedTarget;
    if (to && to.nodeType === 1 && from.contains(to)) return; // still on the link
    if (state.suppressed === from) state.suppressed = null;
    if (state.el === from && state.byPointer) hide();
  });
  document.addEventListener('mousemove', (e) => {
    state.x = e.clientX;
    state.y = e.clientY;
    if (!state.el) return;
    if (!state.el.isConnected) { hide(); return; }
    if (state.byPointer) schedulePlace();
  }, { passive: true });
  document.addEventListener('focusin', (e) => {
    const el = targetOf(e.target);
    // Keyboard focus only: a click also focuses the link, and the box would pop up under it.
    if (el && focusVisible(e.target)) begin(el, false);
  });
  document.addEventListener('focusout', (e) => {
    const el = targetOf(e.target);
    if (el && state.suppressed === el) state.suppressed = null;
    if (el && state.el === el && !state.byPointer) hide();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.el) {
      state.suppressed = state.el; // stays hidden until the pointer or focus leaves this link
      hide();
    }
  });
  // Anything that moves the page under the box, or a click, hides it.
  document.addEventListener('mousedown', hide, true);
  document.addEventListener('scroll', () => { if (state.el) hide(); }, { capture: true, passive: true });
  window.addEventListener('blur', hide);
  window.addEventListener('resize', hide);
}
