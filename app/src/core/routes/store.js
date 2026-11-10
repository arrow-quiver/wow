// The guild bank store (services/store.js): spend season points on what officers put up.
//
//   GET  /api/store          { items, balance, mine, pending (officers: open orders with each buyer's balance), canEdit }
//   PUT  /api/store          officers: { items: [{ key?, item, itemId?, cost, stock }] } → the whole list, shared as "ST"
//   POST /api/store/order    { key, count, note? } → a bank request tagged "[store:<key>:<cost>]", if I have the points
//                            and there's stock left. Officers send or decline it like any bank request
//                            (POST /api/bank/requests/:id/sent|declined); declined or cancelled gives the points back.
const Store = require('../services/store');
const Donations = require('../services/donations');
const sharing = require('../sharing');
const { HttpError, str, int, needGuild, isOfficer } = require('../http');

const MAX_ITEMS = 25;
const NO_CHARACTER = 'Guild Camp needs one of your characters first: log in with the addon and /reload once.';

function register(app, ctx) {
  const { db } = ctx;

  function view(req) {
    const gid = req.guild.id;
    Donations.capture(db, gid);
    const officer = isOfficer(req);
    const pending = officer ? Store.orders(db, gid, { status: 'open' }).map((o) => ({ ...o, balance: Store.balance(db, gid, o.requesterId) })) : [];
    return {
      items: Store.items(db, gid),
      balance: Store.balance(db, gid, req.user.id),
      mine: Store.orders(db, gid, { userId: req.user.id }).slice(0, 20),
      pending,
      canEdit: officer,
    };
  }

  app.get('/api/store', needGuild, (req, res) => res.json(view(req)));

  app.put('/api/store', needGuild, (req, res) => {
    if (!isOfficer(req)) throw new HttpError(403, 'Only officers set what the store sells.');
    const list = Array.isArray(req.body && req.body.items) ? req.body.items : null;
    if (!list) throw new HttpError(400, 'Send the store\'s items.');
    if (list.length > MAX_ITEMS) throw new HttpError(400, `The store holds up to ${MAX_ITEMS} items.`);
    const seen = new Set();
    const items = list.map((x) => {
      const item = str(x && x.item, 60);
      const cost = int(x && x.cost, 1, 1000000);
      if (!item || !cost) throw new HttpError(400, 'Every item needs a name and a price in points.');
      let key = /^[0-9a-z]{6}$/.test(String(x.key || '')) ? x.key : sharing.newKey();
      while (seen.has(key)) key = sharing.newKey();
      seen.add(key);
      return { key, item, id: int(x.itemId, 1, 10000000) || 0, cost, stock: int(x.stock, 0, 100000) ?? 0 };
    });
    sharing.queue(db, ctx, { type: 'ST', key: '1', fields: { items } });
    ctx.audit(req, 'store.items', `${items.length} items`);
    res.json(view(req));
  });

  app.post('/api/store/order', needGuild, (req, res) => {
    const gid = req.guild.id;
    const key = str(req.body && req.body.key, 6);
    const count = int(req.body && req.body.count, 1, 100) || 1;
    const item = Store.items(db, gid).find((i) => i.key === key);
    if (!item) throw new HttpError(404, 'That item isn\'t in the store any more.');
    if (item.left < count) throw new HttpError(409, item.left ? `Only ${item.left} left.` : 'Sold out. Ask an officer to restock it.');
    const b = Store.balance(db, gid, req.user.id);
    const total = item.cost * count;
    if (b.available < total) throw new HttpError(409, `That costs ${total} points and you have ${b.available} to spend.`);
    const pid = sharing.myPid(db);
    if (!pid) throw new HttpError(409, NO_CHARACTER);
    sharing.queue(db, ctx, { type: 'bq', key: sharing.newKey(), fields: { pid, item: item.item, count, note: Store.tag(item.key, item.cost, str(req.body.note, 120) || ''), state: 'o' } });
    ctx.activity(gid, 'bank', `${String(req.user.battletag || '').split('#')[0]} ordered ${count} × ${item.item} from the guild bank store`);
    res.status(201).json({ ...view(req), message: `Ordered. An officer sends it from the guild bank; ${total} points are held until then.` });
  });
}

module.exports = { register };
