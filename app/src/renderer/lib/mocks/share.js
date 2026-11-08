// Preview sample data for sharing in game (used only when the renderer runs in a plain browser without window.gc).
// Shapes match the local core's routes/share.js and sharing.status() (docs/SHARING.md):
//
//   GET  /api/share/status                → { enabled, pid, peers, records, lastHello, lastExchange,
//                                            outbox: [{ op, id, type, summary, state, note, createdAt, sentAt }],
//                                            refused: [same], authorChecks: [{ id, summary, via, at, kind, count }],
//                                            webhookOffer: { from, at } | null }
//   POST /api/share/outbox/:op/cancel     → { ok, message }
//   POST /api/share/author-checks/:id     { action: 'mine' | 'undo' } → { ok, message }
//   POST /api/share/webhook/accept        → { url }      (officers)
//   POST /api/share/webhook/dismiss       → { ok }
//   POST /api/share/webhook/share         → { ok, op, message } (officers, with a webhook in Settings)
//
// ?share=full (default) · empty · off picks the sample (see ../mock.js). Times in outbox rows are SQLite UTC
// strings, as the core sends them; lastHello, lastExchange and webhookOffer.at are ISO.
import { addMockRoutes, httpError, needGuild, needOfficer, isOfficerIn, mockQueue, SHARE_SAVED, SCENARIO } from '../mock.js';

const params = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
const SHARE = ['full', 'empty', 'off'].includes(params.get('share')) ? params.get('share') : 'full';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const sqlTime = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString().replace('T', ' ').slice(0, 19);
const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString();

const LINES = {
  officer: 'Log in on an officer character to send this.',
  stale: 'Someone changed this in the meantime. Check it and try again.',
  expired: 'This waited too long and was not sent.',
};
const PIDS = { owner: 'Grimtusk.p4m7', officer: 'Velanne.k2d9', member: 'Mokra.a8x2' };
// Days within which every addon drops a record of a type it doesn't know (shared/sharing.js K.UNKNOWN_DAYS).
const UNKNOWN_DAYS = 14;

let seeded = false;
function world(state) {
  const sh = state.share;
  if (seeded) return sh;
  seeded = true;
  if (SHARE !== 'full') return sh;
  const officer = isOfficerIn(state);
  sh.outbox.push(
    officer
      ? { op: 'o1k3fa', id: 'RT:k3f9a2', type: 'RT', summary: 'Molten Core Friday: locked', state: 'waiting', note: LINES.officer, createdAt: sqlTime(35 * MIN), sentAt: null }
      : { op: 'o1k3fa', id: `lp:${PIDS.member}:Mokra`, type: 'lp', summary: 'Leveling partner post for Mokra', state: 'waiting', note: 'Log in on Mokra once so guildmates know your characters are yours.', createdAt: sqlTime(35 * MIN), sentAt: null },
    { op: 'o1k3fb', id: `su:k3f9a2:${PIDS[SCENARIO] || PIDS.owner}`, type: 'su', summary: 'Sign-up for Molten Core Friday: coming as healer', state: 'queued', note: SHARE_SAVED, createdAt: sqlTime(12 * MIN), sentAt: null },
    { op: 'o1k3f7', id: 'cr:x8k2pq', type: 'cr', summary: 'Crafting request: Runecloth Bag', state: 'sent', note: null, createdAt: sqlTime(5 * HOUR), sentAt: sqlTime(3 * HOUR) },
  );
  sh.refused.push(officer
    ? { op: 'o1k3f2', id: 'LL:2dv8n1', type: 'LL', summary: 'Loot list for Molten Core', state: 'refused', note: LINES.stale, createdAt: sqlTime(26 * HOUR), sentAt: sqlTime(20 * HOUR) }
    : { op: 'o1k3f2', id: 'bq:m4n8zz', type: 'bq', summary: 'Bank request: 20 × Runecloth', state: 'refused', note: LINES.expired, createdAt: sqlTime(15 * 24 * HOUR - 3 * HOUR), sentAt: sqlTime(2 * HOUR) });
  sh.authorChecks.push({ id: 7, summary: 'Sign-up for Molten Core Friday: not coming', via: 'Kazgul', at: sqlTime(2 * HOUR), kind: null, count: 1, undo: 'Sign-up for Molten Core Friday: coming as healer', recId: 'su:k3f9a2:me' });
  // Records of a type this version doesn't know, in my name, from one sender: the core can only close the check.
  sh.authorChecks.push({ id: 8, summary: "3 changes of a kind this version doesn't know", via: 'Kazgul', at: sqlTime(3 * HOUR), kind: 'unknown', count: 3 });
  if (officer) sh.webhook = { from: SCENARIO === 'officer' ? 'Grimtusk' : 'Velanne', at: iso(3 * HOUR), url: 'https://discord.com/api/webhooks/987654321098765432/shared-in-game-sample', handled: false };
  return sh;
}

function statusJson(state) {
  const sh = world(state);
  if (SHARE === 'off') {
    return { enabled: false, pid: null, peers: 0, records: 0, lastHello: null, lastExchange: null, outbox: [], refused: [], authorChecks: [], webhookOffer: null };
  }
  const offer = sh.webhook && !sh.webhook.handled && isOfficerIn(state) ? { from: sh.webhook.from, at: sh.webhook.at } : null;
  return {
    enabled: true,
    pid: PIDS[SCENARIO] || PIDS.owner,
    peers: 7,
    records: 1368,
    lastHello: iso(4 * MIN),
    lastExchange: iso(6 * MIN),
    outbox: sh.outbox.filter((e) => ['queued', 'waiting', 'sent'].includes(e.state)),
    refused: sh.refused,
    authorChecks: sh.authorChecks.map(({ id, summary, via, at, kind, count }) => ({ id, summary, via, at, kind: kind || null, count: count || 1 })),
    webhookOffer: offer,
  };
}

addMockRoutes({
  'GET /api/share/status': ({ state }) => {
    needGuild(state);
    return statusJson(state);
  },
  'POST /api/share/outbox/:op/cancel': ({ params: p, state }) => {
    needGuild(state);
    const sh = world(state);
    const i = sh.outbox.findIndex((e) => e.op === p.op);
    if (i < 0) throw httpError(404, 'That change was not found.');
    if (!['queued', 'waiting'].includes(sh.outbox[i].state)) throw httpError(409, 'That change already went to your guild, or was dropped.');
    sh.outbox.splice(i, 1);
    return { ok: true, message: 'Change dropped. It will not be sent.' };
  },
  'POST /api/share/author-checks/:id': ({ params: p, body, state }) => {
    needGuild(state);
    const sh = world(state);
    const i = sh.authorChecks.findIndex((c) => String(c.id) === String(p.id));
    if (i < 0) throw httpError(404, 'That change was already handled.');
    const action = body && body.action;
    if (action === 'mine') {
      sh.authorChecks.splice(i, 1);
      return { ok: true, message: 'Thanks. Nothing changes.' };
    }
    if (action !== 'undo') throw httpError(400, 'Pick "It was me" or "Undo it".');
    const [check] = sh.authorChecks.splice(i, 1);
    // "Close it" on a group of a kind this version doesn't know: nothing can be sent (core sharing.authorCheck).
    if (check.kind === 'unknown') {
      return {
        ok: true,
        message: check.count > 1
          ? `Closed. This version can't undo those changes. They go away by themselves within ${UNKNOWN_DAYS} days.`
          : `Closed. This version can't undo that kind of change. It goes away by itself within ${UNKNOWN_DAYS} days.`,
      };
    }
    mockQueue({ id: check.recId, summary: check.undo || check.summary });
    return { ok: true, message: SHARE_SAVED };
  },
  'POST /api/share/webhook/accept': ({ state }) => {
    needOfficer(state);
    const sh = world(state);
    if (!sh.webhook || sh.webhook.handled) throw httpError(404, 'There is no shared webhook waiting.');
    sh.webhook.handled = true;
    return { url: sh.webhook.url };
  },
  'POST /api/share/webhook/dismiss': ({ state }) => {
    needGuild(state);
    const sh = world(state);
    if (sh.webhook) sh.webhook.handled = true;
    return { ok: true };
  },
  'POST /api/share/webhook/share': ({ state }) => {
    needOfficer(state);
    if (!state.settings.discordWebhook) throw httpError(400, 'Add a Discord webhook in Settings first.');
    const entry = mockQueue({ id: 'WH:1', summary: 'Discord webhook' });
    return { ok: true, op: entry.op, message: SHARE_SAVED };
  },
});
