// Economy: the guild bank (tabs, gold, log), bank requests, bank characters, a search across your own
// alts' bags and banks, the guild price index, and supply drives. Ported from the old web/src/routes/phase3.js.
// Data arrives with app uploads (services/sync.js → services/economy.js applyEconomy); this file only reads it,
// apart from requests, bank characters and drives. Shapes are documented in docs/api/economy.md.
//
// Bank requests, bank characters and supply drives are guild data shared through the addon
// (docs/SHARING.md §10). Each change queues a record with sharing.queue(), which also remakes the rows
// (bank_requests, characters.is_bank, drives, drive_contribs) at once:
//   bank request → bq, cancelling it → bq 'x' (final); sent or declined by an officer → BH; bank characters →
//   BC (the whole list, edited on top of the stored version); start a drive → DR, close it → DR 'c' (final,
//   on top of the stored version); a hand-in → dc.
// Guildmates are told by their own apps, and Discord posts go out when the game confirms the change.
const E = require('../services/economy');
const { RAID_CONSUMABLES } = require('../consumables');
const D = require('../services/deals');
const Donations = require('../services/donations');
const sharing = require('../sharing');
const { notElsewhere } = require('../identity');
const { HttpError, str, int, needGuild, needOfficer, isOfficer } = require('../http');

const shortName = (battletag) => String(battletag || '').split('#')[0];
const likeEscape = (s) => `%${s.replace(/[\\%_]/g, (m) => '\\' + m)}%`;
const REQUEST_VERBS = ['sent', 'declined', 'cancel'];
const MAX_BANK_CHARACTERS = 50;
// Rows made before guild data was shared (no share_id) can be read but not changed.
const OLD_ROW = 'This was made with an older Guild Camp and can’t be changed. Make it again.';
const NO_CHARACTER = 'Log in to World of Warcraft on a character in your guild first, then log out or type /reload.';
// A drive with its running total and how many members have given.
const DRIVE_SELECT = `SELECT d.*, u.battletag AS creator_tag,
    COALESCE((SELECT SUM(amount) FROM drive_contribs c WHERE c.drive_id = d.id), 0) AS total,
    (SELECT COUNT(DISTINCT user_id) FROM drive_contribs c WHERE c.drive_id = d.id) AS contributors
  FROM drives d LEFT JOIN users u ON u.id = d.created_by`;

// Positive whole number from a route parameter, or null.
const idParam = (v) => (/^\d{1,12}$/.test(String(v)) ? Number(v) : null);

// Percent change from the oldest to the newest point of a price history, one decimal place.
function priceChange(history) {
  if (!Array.isArray(history) || history.length < 2) return null;
  const first = history[0].price;
  const last = history[history.length - 1].price;
  if (!first) return null;
  return Math.round(((last - first) / first) * 1000) / 10;
}

function register(app, ctx) {
  const { db } = ctx;
  const q = {
    itemName: db.prepare('SELECT name FROM item_names WHERE item_id = ?'),
    // rowid keeps the order the addon read the tabs in (the table is rewritten on every newer scan).
    guildBank: db.prepare('SELECT tab, item_id, count FROM guild_bank WHERE guild_id = ? ORDER BY rowid'),
    bankChars: db.prepare(`SELECT c.id, c.name, c.class, c.level, c.updated_at, u.battletag AS owner
      FROM characters c LEFT JOIN users u ON u.id = c.user_id
      WHERE c.guild_id = ? AND c.is_bank = 1 ORDER BY c.name COLLATE NOCASE`),
    charHoldings: db.prepare('SELECT item_id, SUM(count) AS count FROM inventory WHERE character_id = ? GROUP BY item_id'),
    requests: db.prepare(`SELECT b.*, u.battletag AS requester_tag, h.battletag AS handler_tag FROM bank_requests b
      JOIN users u ON u.id = b.requester_id LEFT JOIN users h ON h.id = b.handled_by
      WHERE b.guild_id = ? AND (b.status = 'open' OR b.updated_at > datetime('now','-7 days')) AND b.status != 'cancelled'
      ORDER BY b.status = 'open' DESC, b.id DESC`),
    request: db.prepare(`SELECT b.*, u.battletag AS requester_tag, h.battletag AS handler_tag FROM bank_requests b
      JOIN users u ON u.id = b.requester_id LEFT JOIN users h ON h.id = b.handled_by WHERE b.id = ? AND b.guild_id = ?`),
    requestByKey: db.prepare('SELECT id FROM bank_requests WHERE guild_id = ? AND share_id = ?'),
    log: db.prepare('SELECT id, kind, who, item_id, count, amount, at FROM bank_log WHERE guild_id = ? ORDER BY at DESC, id DESC LIMIT 40'),
    myItems: db.prepare(`SELECT c.name AS character, c.class, i.location, i.item_id, i.count, n.name FROM inventory i
      JOIN characters c ON c.id = i.character_id JOIN item_names n ON n.item_id = i.item_id
      WHERE c.guild_id = ? AND c.user_id = ? AND n.name LIKE ? ESCAPE '\\' ORDER BY n.name, c.name LIMIT 100`),
    // Characters an officer can mark: every linked character, plus any already marked (even if unlinked since).
    altCandidates: db.prepare(`SELECT c.id, c.name, c.class, c.level, c.is_bank, u.battletag AS owner,
        (SELECT COUNT(*) FROM inventory i WHERE i.character_id = c.id) AS items
      FROM characters c LEFT JOIN users u ON u.id = c.user_id
      WHERE c.guild_id = ? AND (c.user_id IS NOT NULL OR c.is_bank = 1) ORDER BY c.is_bank DESC, c.name COLLATE NOCASE`),
    charByName: db.prepare('SELECT id, name, is_bank FROM characters WHERE guild_id = ? AND name = ? COLLATE NOCASE'),
    ahPrice: db.prepare('SELECT price, quantity, fetched_at FROM ah_prices WHERE guild_id = ? AND item_id = ?'),
    itemName: db.prepare('SELECT name FROM item_names WHERE item_id = ?'),
    priceStats: db.prepare('SELECT COUNT(DISTINCT item_id) AS items, MAX(day) AS newest FROM prices WHERE guild_id = ?'),
    // Without a search: price up what members carry most often (bags, banks and the guild bank).
    held: db.prepare(`SELECT x.item_id, n.name, COUNT(*) AS holders FROM (
          SELECT i.item_id FROM inventory i JOIN characters c ON c.id = i.character_id WHERE c.guild_id = ?
          UNION ALL SELECT item_id FROM guild_bank WHERE guild_id = ?) x
        JOIN item_names n ON n.item_id = x.item_id
        WHERE EXISTS (SELECT 1 FROM prices p WHERE p.guild_id = ? AND p.item_id = x.item_id)
        GROUP BY x.item_id ORDER BY holders DESC, n.name LIMIT 30`),
    openDrives: db.prepare(`${DRIVE_SELECT} WHERE d.guild_id = ? AND d.status = 'open' ORDER BY d.id DESC LIMIT 20`),
    pastDrives: db.prepare(`${DRIVE_SELECT} WHERE d.guild_id = ? AND d.status != 'open' ORDER BY d.id DESC LIMIT 20`),
    drive: db.prepare(`${DRIVE_SELECT} WHERE d.id = ? AND d.guild_id = ?`),
    board: db.prepare(`SELECT COALESCE(c.character, u.battletag) AS who, SUM(c.amount) AS amount FROM drive_contribs c
      JOIN users u ON u.id = c.user_id WHERE c.drive_id = ? GROUP BY who ORDER BY amount DESC, who LIMIT 10`),
    myGiven: db.prepare('SELECT COALESCE(SUM(amount), 0) AS n FROM drive_contribs WHERE drive_id = ? AND user_id = ?'),
    myChars: db.prepare(`SELECT name FROM characters WHERE guild_id = ? AND user_id = ? AND ${notElsewhere()} ORDER BY is_main DESC, level DESC, name`),
    driveByKey: db.prepare('SELECT id FROM drives WHERE guild_id = ? AND share_id = ?'),
  };
  const who = (req) => shortName(req.user.battletag);
  const itemName = (id) => { const r = q.itemName.get(id); return r ? r.name : null; };

  // My player id (made on my main character the first time): the player my requests and hand-ins belong to.
  function myPid() {
    const pid = sharing.myPid(db);
    if (!pid) throw new HttpError(409, NO_CHARACTER);
    return pid;
  }
  // The record key of a row; rows from before sharing have none and can't be changed.
  function keyOf(row) {
    if (!row.share_id) throw new HttpError(409, OLD_ROW);
    return row.share_id;
  }

  // ---------- shared reads ----------

  // Guild bank tabs and bank characters' holdings, priced at recent guild auction prices.
  function bankStock(guildId) {
    const gbRows = q.guildBank.all(guildId);
    const chars = q.bankChars.all(guildId).map((c) => ({ ...c, rows: q.charHoldings.all(c.id) }));
    const ids = [...new Set([...gbRows.map((r) => r.item_id), ...chars.flatMap((c) => c.rows.map((r) => r.item_id))])];
    const prices = E.latestPrices(db, guildId, ids);
    const names = new Map(ids.map((id) => [id, itemName(id)]));
    const item = (r) => {
      const unit = prices[r.item_id] ? prices[r.item_id].price : null;
      return { item_id: r.item_id, name: names.get(r.item_id), count: r.count, unit, value: unit != null ? unit * r.count : null };
    };
    const byName = (a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'en', { sensitivity: 'base' }) || a.item_id - b.item_id;
    const sum = (items) => items.reduce((t, x) => t + (x.value || 0), 0);

    const tabMap = new Map();
    for (const r of gbRows) {
      if (!tabMap.has(r.tab)) tabMap.set(r.tab, []);
      tabMap.get(r.tab).push(item(r));
    }
    const tabs = [...tabMap].map(([name, items]) => {
      items.sort(byName);
      return { name, items, value: sum(items) };
    });
    const bankCharacters = chars.map((c) => {
      const items = c.rows.map(item).sort(byName);
      return { name: c.name, class: c.class, level: c.level, owner: c.owner ? shortName(c.owner) : null, updated_at: c.updated_at, items, value: sum(items) };
    });
    // Every stack, saying where it is (a guild bank tab or a bank character).
    const all = [
      ...tabs.flatMap((t) => t.items.map((x) => ({ ...x, tab: t.name, character: null }))),
      ...bankCharacters.flatMap((c) => c.items.map((x) => ({ ...x, tab: null, character: c.name }))),
    ];
    const guildBankValue = sum(tabs);
    const bankCharactersValue = sum(bankCharacters);
    return {
      tabs,
      bankCharacters,
      value: { guildBank: guildBankValue, bankCharacters: bankCharactersValue, total: guildBankValue + bankCharactersValue },
      priced: all.filter((x) => x.unit != null).length,
      unpriced: all.filter((x) => x.unit == null).length,
      all,
    };
  }

  const requestJson = (r, userId) => ({
    id: r.id,
    item: r.item,
    count: r.count,
    note: r.note || null,
    status: r.status,
    requester_id: r.requester_id,
    requester: shortName(r.requester_tag),
    handled_by: r.handled_by ?? null,
    handler: r.handler_tag ? shortName(r.handler_tag) : null,
    created_at: r.created_at,
    updated_at: r.updated_at,
    mine: r.requester_id === userId,
  });

  const priceRow = (r) => ({ ...r, change: priceChange(r.history) });

  // Raid consumables: the guild's Auctionator prices, plus Blizzard's auction house when gamedata.js has it.
  const consumableRows = (gid) => RAID_CONSUMABLES.map((c) => {
    const n = q.itemName.get(c.id);
    return priceRow({ item_id: c.id, name: (n && n.name) || c.name, kind: c.kind, ...E.priceHistory(db, gid, c.id), ah: q.ahPrice.get(gid, c.id) || null });
  });

  function driveJson(d, userId) {
    return {
      id: d.id,
      title: d.title,
      unit: d.unit,
      goal: d.goal,
      notes: d.notes || null,
      status: d.status,
      created_by: d.created_by ?? null,
      creator: d.creator_tag ? shortName(d.creator_tag) : null,
      created_at: d.created_at,
      total: d.total,
      pct: d.goal > 0 ? Math.min(100, Math.round((d.total / d.goal) * 100)) : 0,
      contributors: d.contributors,
      mine: q.myGiven.get(d.id, userId).n,
      leaderboard: q.board.all(d.id).map((b) => ({ who: shortName(b.who), amount: b.amount })),
    };
  }

  // ---------- Bank ----------

  // Donations: what guildies asked the bank for (with today's prices) and who has given what (services/donations.js).
  app.get('/api/donations', needGuild, (req, res) => {
    const days = int(req.query.days, 1, 365) || 30;
    res.json(Donations.overview(db, req.guild.id, req.user.id, { days }));
  });

  app.get('/api/bank', needGuild, (req, res) => {
    const gid = req.guild.id;
    const stock = bankStock(gid);
    res.json({
      money: req.guild.bank_money ?? null,
      scanned_at: req.guild.bank_scanned_at ?? null,
      tabs: stock.tabs,
      bankCharacters: stock.bankCharacters,
      value: stock.value,
      requests: q.requests.all(gid).map((r) => requestJson(r, req.user.id)),
      log: q.log.all(gid).map((l) => ({ ...l, name: l.item_id ? itemName(l.item_id) : null })),
    });
  });

  // "Which alt has my Runecloth?": items on your own synced characters whose name matches.
  app.get('/api/bank/search', needGuild, (req, res) => {
    const text = str(req.query.q, 60) || '';
    const results = text ? q.myItems.all(req.guild.id, req.user.id, likeEscape(text)) : [];
    res.json({ q: text, results });
  });

  // A bank request (bq) for my player. Officers hear about it from their own apps.
  app.post('/api/bank/requests', needGuild, (req, res) => {
    const item = str(req.body.item, 100);
    if (!item) throw new HttpError(400, 'Name the item you need.');
    const count = int(req.body.count, 1, 1000) ?? 1;
    const note = str(req.body.note, 200);
    const key = sharing.newKey();
    sharing.queue(db, ctx, { type: 'bq', key, fields: { pid: myPid(), item, count, note: note || '', state: 'o' } });
    ctx.activity(req.guild.id, 'bank', `${who(req)} asked the bank for ${count} × ${item}`);
    const id = q.requestByKey.get(req.guild.id, key).id;
    res.status(201).json({ ok: true, request: requestJson(q.request.get(id, req.guild.id), req.user.id), message: 'Request posted.' });
  });

  // Officers mark a request sent or declined (BH); the person who asked can cancel it (bq 'x', final).
  app.post('/api/bank/requests/:id/:verb', needGuild, (req, res) => {
    const id = idParam(req.params.id);
    const verb = req.params.verb;
    if (!id || !REQUEST_VERBS.includes(verb)) throw new HttpError(404, 'Not found.');
    const r = q.request.get(id, req.guild.id);
    if (!r) throw new HttpError(404, 'Request not found.');
    if (r.status !== 'open') throw new HttpError(409, 'That request has already been handled.');
    if (verb === 'cancel' && r.requester_id !== req.user.id) throw new HttpError(403, 'Only the person who asked can cancel a request.');
    if (verb !== 'cancel' && !isOfficer(req)) throw new HttpError(403, 'Only officers can mark bank requests sent or declined.');
    const key = keyOf(r);
    if (verb === 'cancel') {
      const bq = sharing.recordOf(db, req.guild.id, `bq:${key}`);
      if (!bq || bq.del || !bq.fields) throw new HttpError(409, 'That request has already been handled.');
      sharing.queue(db, ctx, { type: 'bq', key, fields: { ...bq.fields, state: 'x' } });
    } else {
      sharing.queue(db, ctx, { type: 'BH', key, fields: { state: verb === 'sent' ? 's' : 'd' }, need: 'o' });
    }
    if (verb === 'sent') ctx.activity(req.guild.id, 'bank', `${r.count} × ${r.item} sent from the bank`);
    if (verb !== 'cancel') ctx.audit(req, `bank request ${verb}`, `${r.count} × ${r.item}`);
    res.json({
      ok: true,
      request: requestJson(q.request.get(r.id, req.guild.id), req.user.id),
      message: verb === 'sent' ? 'Marked as sent.' : verb === 'declined' ? 'Request declined.' : 'Request cancelled.',
    });
  });

  // Officers: the characters that can be marked as bank characters (for guilds without a guild bank).
  app.get('/api/bank/alts', needOfficer, (req, res) => {
    res.json({
      characters: q.altCandidates.all(req.guild.id).map((c) => ({
        name: c.name, class: c.class, level: c.level, owner: c.owner ? shortName(c.owner) : null, is_bank: c.is_bank, items: c.items,
      })),
    });
  });

  // Officers: { names: [...] } is the complete list of bank characters (BC). Characters left out stop being
  // bank characters. Their bags and banks reach the guild from their own players' addons.
  app.put('/api/bank/alts', needOfficer, (req, res) => {
    const raw = req.body.names;
    if (!Array.isArray(raw)) throw new HttpError(400, 'Send the bank characters as a list of names.');
    if (raw.length > MAX_BANK_CHARACTERS) throw new HttpError(400, `Mark at most ${MAX_BANK_CHARACTERS} bank characters.`);
    const wanted = new Map();
    for (const v of raw) {
      const name = str(v, 40);
      if (!name) continue;
      const c = q.charByName.get(req.guild.id, name);
      if (!c) throw new HttpError(400, `There is no character called ${name} in the guild.`);
      wanted.set(c.id, c);
    }
    const current = q.bankChars.all(req.guild.id);
    const added = [...wanted.values()].filter((c) => !c.is_bank);
    const removed = current.filter((c) => !wanted.has(c.id));
    if (added.length || removed.length) {
      const names = [...wanted.values()].map((c) => c.name);
      sharing.queue(db, ctx, { type: 'BC', key: '1', fields: { names }, need: 'o', base: sharing.baseOf(db, req.guild.id, 'BC:1') });
    }
    for (const c of added) ctx.audit(req, 'bank character added', c.name);
    for (const c of removed) ctx.audit(req, 'bank character removed', c.name);
    let message = 'No changes.';
    if (added.length === 1 && !removed.length) message = `${added[0].name} is now a bank character. Its bags and bank show here after its next sync.`;
    else if (removed.length === 1 && !added.length) message = `${removed[0].name} is no longer a bank character.`;
    else if (added.length || removed.length) message = 'Bank characters saved. New ones show their bags and bank after their next sync.';
    res.json({
      ok: true,
      bankCharacters: q.bankChars.all(req.guild.id).map((c) => c.name),
      added: added.map((c) => c.name),
      removed: removed.map((c) => c.name),
      message,
    });
  });

  // ---------- Prices ----------

  app.get('/api/prices', needGuild, (req, res) => {
    const gid = req.guild.id;
    const text = str(req.query.q, 60) || '';
    const stock = bankStock(gid);
    // The five most valuable stacks in the guild bank and on bank characters.
    const top = stock.all.filter((x) => x.value).sort((a, b) => b.value - a.value).slice(0, 5);
    res.json({
      q: text,
      stats: q.priceStats.get(gid),
      results: text ? E.searchPrices(db, gid, text).map(priceRow) : [],
      held: text ? [] : q.held.all(gid, gid, gid).map((h) => priceRow({ ...h, ...E.priceHistory(db, gid, h.item_id) })),
      bank: { ...stock.value, priced: stock.priced, unpriced: stock.unpriced, top },
      consumables: text ? [] : consumableRows(gid),
    });
  });

  // ---------- Deal hunter ----------

  // What to buy on the auction house now and sell again for more, from my own Auctionator scans.
  app.get('/api/deals', needGuild, (req, res) => {
    const g = db.prepare('SELECT realm, faction FROM guilds WHERE id = ?').get(req.guild.id) || {};
    const money = (v) => { const n = int(v); return n && n > 0 ? Math.min(n, 1e10) : null; };
    res.json(D.findDeals(db, {
      realm: str(req.query.realm, 80) || null,
      minProfit: money(req.query.min_profit) ?? 5000,
      maxPrice: money(req.query.max_price),
      budget: money(req.query.budget),
      preferRealms: g.realm ? [`${g.realm} ${g.faction || ''}`.trim(), g.realm] : [],
    }));
  });

  // ---------- Supply drives ----------

  app.get('/api/drives', needGuild, (req, res) => {
    const gid = req.guild.id;
    res.json({
      open: q.openDrives.all(gid).map((d) => driveJson(d, req.user.id)),
      past: q.pastDrives.all(gid).map((d) => driveJson(d, req.user.id)),
      myCharacters: q.myChars.all(gid, req.user.id).map((c) => c.name),
    });
  });

  // A supply drive (DR). Members hear about it from their own apps.
  app.post('/api/drives', needOfficer, (req, res) => {
    const title = str(req.body.title, 80);
    const unit = str(req.body.unit, 40);
    const goalIn = int(req.body.goal);
    if (!title || !unit || !goalIn || goalIn < 1) throw new HttpError(400, 'Give the drive a name, what you’re collecting, and a goal.');
    const goal = Math.min(1e7, goalIn);
    const notes = str(req.body.notes, 300);
    const key = sharing.newKey();
    sharing.queue(db, ctx, { type: 'DR', key, fields: { title, unit, goal, notes: notes || '', state: 'o' }, need: 'o' });
    ctx.activity(req.guild.id, 'drive', `New supply drive: ${title}`);
    ctx.audit(req, 'drive started', title);
    const id = q.driveByKey.get(req.guild.id, key).id;
    res.status(201).json({ ok: true, drive: driveJson(q.drive.get(id, req.guild.id), req.user.id), message: 'Drive started.' });
  });

  // A hand-in (dc) for my player. The drive's total and whether it reached its goal come from all hand-ins
  // the guild shared, so the goal is reached once, everywhere.
  app.post('/api/drives/:id/give', needGuild, (req, res) => {
    const id = idParam(req.params.id);
    const d = id && q.drive.get(id, req.guild.id);
    if (!d) throw new HttpError(404, 'Drive not found.');
    if (d.status !== 'open') throw new HttpError(409, 'That drive has finished.');
    const amountIn = int(req.body.amount);
    if (!amountIn || amountIn < 1) throw new HttpError(400, 'How many did you hand in?');
    const amount = Math.min(1e6, amountIn);
    const driveKey = keyOf(d);
    sharing.queue(db, ctx, {
      type: 'dc', key: sharing.newKey(),
      fields: { pid: myPid(), drive: driveKey, character: str(req.body.character, 40) || '', amount, note: str(req.body.note, 120) || '' },
    });
    const after = q.drive.get(d.id, req.guild.id);
    const reached = after.status === 'done';
    if (reached) ctx.activity(req.guild.id, 'drive', `${d.title} reached its goal!`);
    res.json({
      ok: true,
      reached,
      drive: driveJson(after, req.user.id),
      message: reached ? 'Goal reached. Thank you!' : `Logged ${amount.toLocaleString('en')} ${d.unit}.`,
    });
  });

  // Closing an open drive (DR 'c', final), on top of the version this computer holds.
  app.post('/api/drives/:id/close', needOfficer, (req, res) => {
    const id = idParam(req.params.id);
    const d = id && q.drive.get(id, req.guild.id);
    if (!d) throw new HttpError(404, 'Drive not found.');
    if (d.status === 'open') {
      const key = keyOf(d);
      const dr = sharing.recordOf(db, req.guild.id, `DR:${key}`);
      if (dr && !dr.del && dr.fields) {
        sharing.queue(db, ctx, { type: 'DR', key, fields: { ...dr.fields, state: 'c' }, need: 'o', base: sharing.baseOf(db, req.guild.id, `DR:${key}`) });
        ctx.audit(req, 'drive closed', `#${d.id}`);
      }
    }
    res.json({ ok: true, drive: driveJson(q.drive.get(d.id, req.guild.id), req.user.id), message: 'Drive closed.' });
  });
}

module.exports = { register, priceChange };
