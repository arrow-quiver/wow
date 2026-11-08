// Real renderer components, rendered with Preact into a tiny DOM (no browser), against the dev mock.
//  - addon-2: the "when does this reach my guild" lines while the game needs a restart. When Guild Camp makes the news
//    folder (WowGuild_Inbox) while World of Warcraft runs, that game session never loads it, also not after a /reload,
//    so the main process says restartNeeded in the sync status (src/main/sync.js).
//  - author checks: every kind the core sends (sharing.status authorChecks[].kind) gets its words and working buttons.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL, fileURLToPath } from 'node:url';

// ---------- a DOM just big enough for Preact ----------

class MiniNode {
  constructor(nodeType, name, ns = null) {
    this.nodeType = nodeType;
    this.nodeName = name ? String(name).toUpperCase() : '#text';
    this.localName = name ? String(name).toLowerCase() : undefined;
    this.namespaceURI = ns;
    this.childNodes = [];
    this.parentNode = null;
    this.attributes = {};
    this.style = { setProperty() {}, removeProperty() {} };
    this.listeners = {};
    this.data = '';
  }
  get firstChild() { return this.childNodes[0] || null; }
  get nextSibling() {
    if (!this.parentNode) return null;
    const list = this.parentNode.childNodes;
    return list[list.indexOf(this) + 1] || null;
  }
  appendChild(c) { return this.insertBefore(c, null); }
  insertBefore(c, ref) {
    if (c.parentNode) c.parentNode.removeChild(c);
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    if (i < 0) this.childNodes.push(c); else this.childNodes.splice(i, 0, c);
    c.parentNode = this;
    return c;
  }
  removeChild(c) {
    const i = this.childNodes.indexOf(c);
    if (i >= 0) this.childNodes.splice(i, 1);
    c.parentNode = null;
    return c;
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  setAttributeNS(_ns, k, v) { this.attributes[k] = String(v); }
  removeAttribute(k) { delete this.attributes[k]; }
  removeAttributeNS(_ns, k) { delete this.attributes[k]; }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null; }
  addEventListener(type, fn) { (this.listeners[type] ||= new Set()).add(fn); }
  removeEventListener(type, fn) { if (this.listeners[type]) this.listeners[type].delete(fn); }
  focus() {}
  get textContent() { return this.nodeType === 3 ? this.data : this.childNodes.map((c) => c.textContent).join(''); }
  /** Every element below this one (depth first). */
  all() { return this.childNodes.flatMap((c) => (c.nodeType === 1 ? [c, ...c.all()] : [])); }
}

// Preact names an event after the lower-case on<name> property when the element has one, as a browser's does.
MiniNode.prototype.onclick = null;

globalThis.document = {
  createElement: (name) => new MiniNode(1, name),
  createElementNS: (ns, name) => new MiniNode(1, name, ns),
  createTextNode: (text) => Object.assign(new MiniNode(3, null), { data: String(text) }),
};

const R = fileURLToPath(new URL('../src/renderer/', import.meta.url));
const load = (p) => import(pathToFileURL(R + p).href);

const { html, render } = await load('lib/html.js');
const status = await load('lib/status.js');
const { toastStore, dismiss } = await load('lib/toast.js');
const hint = await load('components/ShareHint.js');
const { AuthorChecks } = await load('components/AuthorChecks.js');
const addonPage = await load('pages/addon.js');
const settingsPage = await load('pages/settings.js');
const campPage = await load('pages/camp.js');
const coachPage = await load('pages/coach.js');
const { gc } = await load('lib/gc.js');

// Preact runs effects after a frame (a timer in Node) and re-renders in a microtask.
const settle = async (ms = 60) => { for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, ms / 3)); };

// Every mounted tree is taken down after each test, also a failed one: a relative time left on screen keeps a 30 s
// ticker (components/wow.js) that would keep the test run alive.
const mounted = [];
test.afterEach(() => { for (const root of mounted.splice(0)) render(null, root); });

async function mount(vnode) {
  const root = document.createElement('div');
  mounted.push(root);
  render(vnode, root);
  await settle();
  return root;
}

function click(root, label) {
  const button = root.all().find((n) => n.localName === 'button' && n.textContent.trim() === label);
  assert.ok(button, `a "${label}" button`);
  const event = { type: 'click', target: button, currentTarget: button, preventDefault() {}, stopPropagation() {} };
  for (const fn of button.listeners.click || []) fn.call(button, event);
}

const RELOAD = /the next time you log in or type \/reload/;
const RESTART = /after you restart World of Warcraft\. A \/reload isn't enough the first time\./;

// The live sync status the main process pushes: read the first one (the dev mock's), then play the main process.
await status.syncStatus.refresh();
status.syncStatus.start();
await settle();
const base = { ...status.syncStatus.get() };
const setRestart = (on) => status.syncStatus.store.set({
  ...base,
  state: 'idle',
  restartNeeded: on,
  restartFolders: on ? [{ install: 'C:\\Games\\World of Warcraft\\_forever_', label: 'WoW Forever', since: '2026-11-08T10:00:00.000Z' }] : [],
});

// Toasts close themselves after a few seconds; close them now so the run ends at once.
test.after(() => { for (const t of toastStore.get()) dismiss(t.id); });

test('the dev mock says what the main process says: restartNeeded false and no folders unless ?restart=1', () => {
  assert.equal(base.restartNeeded, false);
  assert.deepEqual(base.restartFolders, []);
});

test('addon-2: the shared hint under every form says to restart World of Warcraft while the sync status says restartNeeded, and /reload again once it is cleared', async () => {
  setRestart(true);
  const root = await mount(html`<${hint.ShareHint} officer />`);
  assert.match(root.textContent, RESTART);
  assert.doesNotMatch(root.textContent, RELOAD);
  assert.match(root.textContent, /Log in on an officer character to send this\./);
  // The main process sees the game session end: the same hint goes back to /reload.
  setRestart(false);
  await settle();
  assert.match(root.textContent, RELOAD);
  assert.doesNotMatch(root.textContent, /restart World of Warcraft/);
  render(null, root);
});

test('addon-2: the Addon & sync line above "Ready to go" changes says to restart the game while restartNeeded is set, and /reload otherwise', async () => {
  const entries = [{ op: 'o1', state: 'queued', summary: 'Sign-up for Molten Core: coming', note: status.SHARE_LINES.saved, createdAt: '2026-11-08 10:00:00' }];
  setRestart(true);
  const root = await mount(html`<${addonPage.ShareSection} title="Waiting to go out" entries=${entries} />`);
  assert.match(root.textContent, /Changes marked “Ready to go” go to your guild after you restart World of Warcraft\. A \/reload isn't enough the first time\./);
  assert.doesNotMatch(root.textContent, RELOAD);
  setRestart(false);
  await settle();
  assert.match(root.textContent, /Changes marked “Ready to go” go to your guild the next time you log in or type \/reload\./);
  render(null, root);

  // The Sync card names the folder that waits.
  const card = await mount(html`<${addonPage.SyncCard} sync=${{ ...base, state: 'idle', restartNeeded: true, restartFolders: [{ install: 'x', label: 'WoW Forever', since: null }] }} settings=${{ syncEnabled: true }} onToggle=${() => {}} />`);
  assert.match(card.textContent, /Guild Camp added its news folder in WoW Forever while the game was running\. Restart World of Warcraft to load it\. A \/reload isn't enough the first time\./);
  render(null, card);
});

test('addon-2: the saved line after "Undo it" on an author check and after sharing the webhook says to restart the game while restartNeeded is set, and /reload otherwise', async () => {
  const lastToast = () => (toastStore.get().at(-1) || {}).message;
  const savedRestart = "Saved. It goes to your guild after you restart World of Warcraft. A /reload isn't enough the first time.";
  // The dev mock answers like the core: its sample has author check 7, and "Undo it" replies with the core's saved line.
  await status.shareStatus.refresh();
  const check = (status.shareStatus.get().data.authorChecks || []).find((c) => c.id === 7);
  assert.ok(check, 'the sample author check');

  setRestart(true);
  let root = await mount(html`<${AuthorChecks} checks=${[check]} />`);
  click(root, 'Undo it');
  await settle(120);
  assert.equal(lastToast(), savedRestart);
  render(null, root);

  root = await mount(html`<${settingsPage.ShareWebhook} />`);
  assert.match(root.textContent, RESTART, 'its share hint too');
  click(root, 'Share with officers');
  await settle(120);
  assert.equal(lastToast(), savedRestart);

  // Once the game session has ended, the core's own line again.
  setRestart(false);
  await settle();
  click(root, 'Share with officers');
  await settle(120);
  assert.equal(lastToast(), status.SHARE_LINES.saved);
  render(null, root);
  assert.equal(status.savedReply('Thanks. Nothing changes.', { restartNeeded: true }), 'Thanks. Nothing changes.', 'other replies stay as the core wrote them');
});

test("addon-2: Camp's Your sync card says my changes reach the guild after a game restart while restartNeeded is set, and after a log in or /reload otherwise", async () => {
  setRestart(true);
  const root = await mount(html`<${campPage.SyncCard} mySync="2026-11-08 10:00:00" groups=${null} />`);
  assert.match(root.textContent, /Your changes reach the guild after you restart World of Warcraft\. A \/reload isn't enough the first time\./);
  setRestart(false);
  await settle();
  assert.match(root.textContent, /Your changes reach the guild when you log in or type \/reload\./);
  render(null, root);
});

test('addon-2: the plain lines, with and without restartNeeded', async () => {
  const on = { restartNeeded: true };
  assert.equal(hint.shareHintText({ restart: true }), "This goes to your guild after you restart World of Warcraft. A /reload isn't enough the first time.");
  assert.equal(hint.shareHintText(), 'This goes to your guild the next time you log in or type /reload.');
  assert.match(hint.shareHintText({ restart: true, syncOff: true }), /^Sync is off/, 'sync off says so first');
  assert.equal(status.savedLine(on), "Saved. It goes to your guild after you restart World of Warcraft. A /reload isn't enough the first time.");
  assert.equal(status.savedLine(null), status.SHARE_LINES.saved);
  assert.equal(status.readyLine(on), "Changes marked “Ready to go” go to your guild after you restart World of Warcraft. A /reload isn't enough the first time.");
  assert.equal(status.readyLine({ restartNeeded: false }), 'Changes marked “Ready to go” go to your guild the next time you log in or type /reload.');
  assert.equal(status.changesLine(on), "Your changes reach the guild after you restart World of Warcraft. A /reload isn't enough the first time.");
  assert.equal(status.changesLine(undefined), 'Your changes reach the guild when you log in or type /reload.');
  assert.equal(status.needsGameRestart({ restartNeeded: 'yes' }), false, 'only true counts');
  assert.equal(addonPage.restartNoticeText({ restartNeeded: true, restartFolders: [{ label: 'WoW Forever' }, { label: 'Retail' }, { label: 'WoW Forever' }] }),
    "Guild Camp added its news folder in WoW Forever and Retail while the game was running. Restart World of Warcraft to load it. A /reload isn't enough the first time. Your changes for the guild wait until then.");
  assert.equal(addonPage.restartNoticeText({ restartNeeded: true }),
    "Guild Camp added its news folder while the game was running. Restart World of Warcraft to load it. A /reload isn't enough the first time. Your changes for the guild wait until then.");
  assert.equal(addonPage.restartNoticeText({ restartNeeded: false, restartFolders: [{ label: 'x' }] }), '');
});

test('author checks: every kind the core sends reads sensibly, and both buttons post "mine" or "undo"; a group of a kind this version does not know says "Close it" (the core can only close it); a kind this version does not know reads like a plain change', async () => {
  const checks = [
    { id: 901, summary: 'Notice: Free gold!', via: 'Kazgul', at: null, kind: null, count: 1 },
    { id: 902, summary: "3 changes of a kind this version doesn't know", via: 'Sneaky', at: null, kind: 'unknown', count: 3 },
    { id: 903, summary: 'Notice: hi', via: null, at: null, kind: 'unknown', count: 1 },
    { id: 904, summary: "Your player id is made on Jaina, who isn't one of your characters", via: null, at: null, kind: 'pid', count: 1 },
    { id: 905, summary: 'Bob and Zul were linked to you as your characters', via: null, at: null, kind: 'repair', count: 1 },
    { id: 906, summary: 'Something new', via: 'Kazgul', at: null, kind: 'from-a-newer-core', count: 7 },
    { id: 907, at: null },
  ];
  const posts = [];
  const real = gc.api.request;
  gc.api.request = async (method, path, body) => {
    if (method === 'POST' && path.startsWith('/api/share/author-checks/')) { posts.push([path.split('/').pop(), body && body.action]); return { ok: true, message: 'Thanks. Nothing changes.' }; }
    return real(method, path, body);
  };
  try {
    const root = await mount(html`<${AuthorChecks} checks=${checks} />`);
    const texts = root.all().filter((n) => n.attributes.class === 'share-check-text').map((n) => n.textContent.trim());
    assert.deepEqual(texts, [
      "A change in your name arrived that this computer didn't make: Notice: Free gold!. Passed on by Kazgul.",
      "Changes in your name arrived that this computer didn't make: 3 changes of a kind this version doesn't know. Passed on by Sneaky.",
      "A change in your name arrived that this computer didn't make: Notice: hi.",
      "Your player id is made on Jaina, who isn't one of your characters. Is that character yours?",
      'Bob and Zul were linked to you as your characters. Is that right?',
      "A change in your name arrived that this computer didn't make: Something new. Passed on by Kazgul.",
      "A change in your name arrived that this computer didn't make: a guild change.",
    ]);
    const labels = root.all().filter((n) => n.localName === 'button').map((n) => n.textContent.trim());
    assert.deepEqual(labels, ['It was me', 'Undo it', 'It was me', 'Close it', 'It was me', 'Close it', "Yes, it's mine", 'No, make a new id',
      'Yes, mine', 'No, not mine', 'It was me', 'Undo it', 'It was me', 'Undo it']);
    click(root, 'No, make a new id');
    click(root, 'Close it');
    click(root, "Yes, it's mine");
    click(root, 'No, not mine');
    await settle(120);
    assert.deepEqual(posts.sort(), [['902', 'undo'], ['904', 'mine'], ['904', 'undo'], ['905', 'undo']].sort());
  } finally {
    gc.api.request = real;
  }
  // Pure: no check at all, or a pid check without its summary, still reads.
  assert.equal(status.authorCheckView(null).mine, 'It was me');
  assert.match(status.authorCheckView({ kind: 'pid' }).text, /^A change in your name arrived/);
});

test('addon-2: the Coach build plan card and its "plan is ready" toast say a new plan reaches the game after a game restart while restartNeeded is set, and after the next sync and /reload otherwise', async () => {
  const data = {
    character: { name: 'Grimtusk' }, plan: null, planBusy: false,
    ai: { available: true }, limits: { plansLeft: 2, plansPerDay: 3 },
  };
  const ready = { status: 'ready', char: 'Grimtusk', plan: null, message: coachPage.PLAN_READY };
  const real = gc.api.request;
  gc.api.request = async (method, path, body) => (method === 'POST' && path === '/api/coach/plan' ? ready : real(method, path, body));
  const lastToast = () => (toastStore.get().at(-1) || {}).message;
  try {
    setRestart(true);
    const root = await mount(html`<${coachPage.PlanCard} data=${data} reload=${() => {}} />`);
    assert.match(root.textContent, /2 of 3 plans left today\. A new plan reaches the game after you restart World of Warcraft\. A \/reload isn't enough the first time\./);
    assert.doesNotMatch(root.textContent, /next sync and \/reload/);
    click(root, 'Make my plan');
    await settle(120);
    assert.equal(lastToast(), "Your new build plan is ready. It reaches the game after you restart World of Warcraft. A /reload isn't enough the first time.");

    setRestart(false);
    await settle();
    assert.match(root.textContent, /2 of 3 plans left today\. A new plan reaches the game after your next sync and \/reload\./);
    click(root, 'Make my plan');
    await settle(120);
    assert.equal(lastToast(), 'Your new build plan is ready. It reaches the game after your next sync and /reload.');
  } finally {
    gc.api.request = real;
  }
  // Other replies (a plan still being written) stay as the core wrote them.
  const pending = "The Coach is writing your plan. It can take a minute; it shows here when it's ready.";
  assert.equal(coachPage.planReply(pending, { restartNeeded: true }), pending);
});
