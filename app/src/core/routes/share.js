'use strict';
// Sharing through the addon (docs/SHARING.md): what is waiting to go out, what the game refused, changes
// in my name this computer didn't make, and a Discord webhook an officer shared.
//
//   GET  /api/share/status                      → { enabled, pid, peers, records, lastHello, lastExchange,
//                                                  outbox: [{ op, id, type, summary, state, note, createdAt, sentAt }],
//                                                  refused: [same], authorChecks: [{ id, summary, via, at }],
//                                                  webhookOffer: { from, at } | null }
//   POST /api/share/outbox/:op/cancel           drop a change that is still waiting; the page shows it as before
//   POST /api/share/author-checks/:id           { action: 'mine' | 'undo' }
//   POST /api/share/webhook/accept              → { url } (the app saves it in Settings), offer handled
//   POST /api/share/webhook/dismiss             offer handled, nothing saved
//   POST /api/share/webhook/share               officers: send my Settings webhook to the other officers
const { HttpError, needGuild, needOfficer, str } = require('../http');
const sharing = require('../sharing');

function register(app, ctx) {
  const { db } = ctx;

  app.get('/api/share/status', needGuild, (req, res) => {
    res.json(sharing.status(db));
  });

  app.post('/api/share/outbox/:op/cancel', needGuild, (req, res) => {
    const op = str(req.params.op, 40);
    if (!op || !/^o[0-9a-z]+$/.test(op)) throw new HttpError(404, 'That change was not found.');
    const done = db.transaction(() => sharing.cancel(db, ctx, op))();
    if (!done) throw new HttpError(409, 'That change already went to your guild, or was dropped.');
    res.json({ ok: true, message: 'Change dropped. It will not be sent.' });
  });

  app.post('/api/share/author-checks/:id', needGuild, (req, res) => {
    const id = /^\d{1,12}$/.test(String(req.params.id)) ? Number(req.params.id) : null;
    if (!id) throw new HttpError(404, 'That change was already handled.');
    const action = (req.body || {}).action;
    const out = db.transaction(() => sharing.authorCheck(db, ctx, id, action))();
    res.json(out);
  });

  app.post('/api/share/webhook/accept', needOfficer, (req, res) => {
    res.json(sharing.takeWebhook(db));
  });

  app.post('/api/share/webhook/dismiss', needGuild, (req, res) => {
    res.json(sharing.dismissWebhook(db));
  });

  app.post('/api/share/webhook/share', needOfficer, (req, res) => {
    const r = db.transaction(() => sharing.shareWebhook(db, ctx))();
    ctx.audit(req, 'shared the Discord webhook', 'with the officers');
    res.json({ ok: true, op: r.op, message: sharing.LINES.saved });
  });
}

module.exports = { register };
