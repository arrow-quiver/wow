const express = require('express');
const E = require('../economy');
const D = require('../discord');
const V = require('../views/phase3');

// Discord interactions must be mounted before session/CSRF middleware.
function mountDiscord(app, { db, cfg, discord }) {
  app.post('/discord/interactions', express.raw({ type: '*/*', limit: '100kb' }), (req, res) => {
    if (!cfg.discordPublicKey) return res.status(404).end();
    const ok = D.verify(cfg.discordPublicKey, req.get('X-Signature-Ed25519'), req.get('X-Signature-Timestamp'), req.body || Buffer.alloc(0));
    if (!ok) return res.status(401).send('Bad signature');
    let body;
    try { body = JSON.parse(req.body.toString('utf8')); } catch { return res.status(400).end(); }
    try {
      res.json(D.handle(db, cfg, body, {
        // A call to arms made in Discord is already visible there; nothing else to post.
        onCta: (guild, zone) => db.prepare('INSERT INTO activity (guild_id, kind, text) VALUES (?,?,?)').run(guild.id, 'cta', `Call to arms in ${zone} (from Discord)`),
      }));
    } catch (e) {
      console.error('Discord interaction failed:', e);
      res.json({ type: 4, data: { content: 'Something went wrong on the guild site. Try again in a moment.', flags: 64 } });
    }
  });
}

function routes(app, { db, cfg, discord, activity, needGuild, needOfficer, back, audit = () => {} }) {
  const isOfficer = (req) => ['owner', 'officer'].includes(req.guild.role);
  const who = (req) => req.user.battletag.split('#')[0];
  const nameOf = db.prepare('SELECT name FROM item_names WHERE item_id = ?');
  const itemName = (id) => { const r = nameOf.get(id); return r ? r.name : `Item ${id}`; };

  // ---------- Discord account linking + command registration ----------
  app.post('/settings/discord/link', needGuild, (req, res) => {
    const code = D.newLinkCode(db, req.user.id, req.guild.id);
    back(res, '/settings', `Your link code is ${code}. In your Discord server, type /link ${code} within 15 minutes.`);
  });
  app.post('/settings/discord/unlink', needGuild, (req, res) => {
    db.prepare('UPDATE users SET discord_id = NULL WHERE id = ?').run(req.user.id);
    back(res, '/settings', 'Discord unlinked.');
  });
  app.post('/settings/discord/register', needOfficer, async (req, res) => {
    if (!cfg.discordAppId || !cfg.discordBotToken) return back(res, '/settings', 'The Discord app details aren’t set on the server yet.');
    try { const n = await D.registerCommands(cfg); audit(req, 'Discord commands registered', String(n)); back(res, '/settings', `${n} slash commands registered with Discord.`); } catch (e) { back(res, '/settings', e.message); }
  });

  // ---------- Bank ----------
  app.get('/bank', needGuild, (req, res) => {
    const gid = req.guild.id;
    const gbRows = db.prepare('SELECT tab, item_id, count FROM guild_bank WHERE guild_id = ? ORDER BY tab, item_id').all(gid);
    const altRows = db.prepare(`SELECT c.name AS character, i.item_id, SUM(i.count) AS count FROM inventory i JOIN characters c ON c.id = i.character_id
      WHERE c.guild_id = ? AND c.is_bank = 1 GROUP BY c.name, i.item_id ORDER BY c.name`).all(gid);
    const ids = [...new Set([...gbRows, ...altRows].map((r) => r.item_id))];
    const prices = E.latestPrices(db, gid, ids);
    const decorate = (r) => ({ ...r, name: itemName(r.item_id), unit: prices[r.item_id] ? prices[r.item_id].price : null });
    const q = String(req.query.find || '').trim().slice(0, 60);
    const mine = q ? db.prepare(`SELECT c.name AS character, i.location, i.item_id, i.count, n.name FROM inventory i
        JOIN characters c ON c.id = i.character_id JOIN item_names n ON n.item_id = i.item_id
        WHERE c.guild_id = ? AND c.user_id = ? AND n.name LIKE ? ESCAPE '\\' ORDER BY n.name, c.name LIMIT 100`)
      .all(gid, req.user.id, `%${q.replace(/[\\%_]/g, (m) => '\\' + m)}%`) : null;
    res.page({
      title: 'Bank', active: 'bank',
      body: V.bankPage({
        csrf: req.csrf, isOfficer: isOfficer(req), userId: req.user.id, guild: req.guild,
        guildBank: gbRows.map(decorate), alts: altRows.map(decorate), find: q, mine,
        bankChars: db.prepare('SELECT name, is_bank FROM characters WHERE guild_id = ? AND user_id IS NOT NULL ORDER BY is_bank DESC, name').all(gid),
        requests: db.prepare(`SELECT b.*, u.battletag AS requester, h.battletag AS handler FROM bank_requests b JOIN users u ON u.id = b.requester_id
          LEFT JOIN users h ON h.id = b.handled_by WHERE b.guild_id = ? AND (b.status = 'open' OR b.updated_at > datetime('now','-7 days'))
          AND b.status != 'cancelled' ORDER BY b.status = 'open' DESC, b.id DESC`).all(gid),
        log: db.prepare('SELECT * FROM bank_log WHERE guild_id = ? ORDER BY at DESC LIMIT 40').all(gid).map((l) => ({ ...l, name: l.item_id ? itemName(l.item_id) : null })),
      }),
    });
  });
  app.post('/bank/requests', needGuild, async (req, res) => {
    const item = String(req.body.item || '').trim().slice(0, 100);
    if (!item) return back(res, '/bank', 'Name the item you need.');
    const count = Math.min(1000, Math.max(1, Number(req.body.count) || 1));
    db.prepare('INSERT INTO bank_requests (guild_id, requester_id, item, count, note) VALUES (?,?,?,?,?)').run(req.guild.id, req.user.id, item, count, String(req.body.note || '').slice(0, 200));
    activity.run(req.guild.id, 'bank', `${who(req)} asked the bank for ${count} × ${item}`);
    await discord(req.guild, `🏦 **Bank request:** ${count} × ${item}, for ${who(req)}`);
    back(res, '/bank', 'Request sent to the officers.');
  });
  app.post('/bank/requests/:id(\\d+)/:verb(sent|declined|cancel)', needGuild, (req, res) => {
    const r = db.prepare('SELECT * FROM bank_requests WHERE id = ? AND guild_id = ?').get(req.params.id, req.guild.id);
    if (!r || r.status !== 'open') return back(res, '/bank', 'That request has already been handled.');
    const verb = req.params.verb;
    if (verb === 'cancel' && r.requester_id !== req.user.id) return res.status(403).send('Not your request');
    if (verb !== 'cancel' && !isOfficer(req)) return res.status(403).send('Officers only.');
    db.prepare("UPDATE bank_requests SET status = ?, handled_by = ?, updated_at = datetime('now') WHERE id = ?").run(verb === 'cancel' ? 'cancelled' : verb, req.user.id, r.id);
    if (verb === 'sent') activity.run(req.guild.id, 'bank', `${r.count} × ${r.item} sent from the bank`);
    if (verb !== 'cancel') audit(req, `bank request ${verb}`, `${r.count} × ${r.item}`);
    back(res, '/bank', verb === 'sent' ? 'Marked as sent.' : verb === 'declined' ? 'Request declined.' : 'Request cancelled.');
  });
  app.post('/bank/alts', needOfficer, (req, res) => {
    const name = String(req.body.character || '');
    const c = db.prepare('SELECT * FROM characters WHERE guild_id = ? AND name = ?').get(req.guild.id, name);
    if (!c) return back(res, '/bank', 'Character not found.');
    db.prepare('UPDATE characters SET is_bank = ? WHERE id = ?').run(c.is_bank ? 0 : 1, c.id);
    audit(req, c.is_bank ? 'bank character removed' : 'bank character added', c.name);
    back(res, '/bank', c.is_bank ? `${c.name} is no longer a bank character.` : `${c.name} is now a bank character. Its bags and bank show here after its next sync.`);
  });

  // ---------- Prices ----------
  app.get('/prices', needGuild, (req, res) => {
    const gid = req.guild.id;
    const q = String(req.query.q || '').trim().slice(0, 60);
    const stats = db.prepare('SELECT COUNT(DISTINCT item_id) AS items, MAX(day) AS newest FROM prices WHERE guild_id = ?').get(gid);
    // Without a search: price up what members are carrying in bags most often.
    const held = q ? [] : db.prepare(`SELECT x.item_id, n.name, COUNT(*) AS holders FROM (
          SELECT i.item_id FROM inventory i JOIN characters c ON c.id = i.character_id WHERE c.guild_id = ?
          UNION ALL SELECT item_id FROM guild_bank WHERE guild_id = ?) x
        JOIN item_names n ON n.item_id = x.item_id
        WHERE EXISTS (SELECT 1 FROM prices p WHERE p.guild_id = ? AND p.item_id = x.item_id)
        GROUP BY x.item_id ORDER BY holders DESC, n.name LIMIT 30`).all(gid, gid, gid)
      .map((h) => ({ ...h, ...E.priceHistory(db, gid, h.item_id) }));
    res.page({
      title: 'Prices', active: 'prices',
      body: V.pricesPage({ q, results: q ? E.searchPrices(db, gid, q) : [], stats, held }),
    });
  });

  // ---------- Supply drives ----------
  const driveRows = (gid, where) => db.prepare(`SELECT d.*, COALESCE((SELECT SUM(amount) FROM drive_contribs c WHERE c.drive_id = d.id), 0) AS total
    FROM drives d WHERE d.guild_id = ? AND ${where} ORDER BY d.id DESC LIMIT 20`).all(gid);
  app.get('/drives', needGuild, (req, res) => {
    const gid = req.guild.id;
    const open = driveRows(gid, "d.status = 'open'");
    const past = driveRows(gid, "d.status != 'open'");
    const board = db.prepare(`SELECT c.drive_id, COALESCE(c.character, u.battletag) AS who, SUM(c.amount) AS amount FROM drive_contribs c
      JOIN users u ON u.id = c.user_id JOIN drives d ON d.id = c.drive_id WHERE d.guild_id = ? GROUP BY c.drive_id, who ORDER BY amount DESC`).all(gid);
    const byDrive = {};
    for (const b of board) (byDrive[b.drive_id] ||= []).push(b);
    res.page({
      title: 'Supply drives', active: 'drives',
      body: V.drivesPage({
        csrf: req.csrf, isOfficer: isOfficer(req), open, past, byDrive,
        myChars: db.prepare('SELECT name FROM characters WHERE guild_id = ? AND user_id = ? ORDER BY is_main DESC, level DESC').all(gid, req.user.id),
      }),
    });
  });
  app.post('/drives', needOfficer, async (req, res) => {
    const title = String(req.body.title || '').trim().slice(0, 80);
    const unit = String(req.body.unit || '').trim().slice(0, 40);
    const goal = Math.min(1e7, Math.max(1, Number(req.body.goal) || 0));
    if (!title || !unit || !goal) return back(res, '/drives', 'Give the drive a name, what you’re collecting, and a goal.');
    db.prepare('INSERT INTO drives (guild_id, title, unit, goal, notes, created_by) VALUES (?,?,?,?,?,?)').run(req.guild.id, title, unit, goal, String(req.body.notes || '').slice(0, 300), req.user.id);
    activity.run(req.guild.id, 'drive', `New supply drive: ${title}`);
    audit(req, 'drive started', title);
    await discord(req.guild, `📦 **Supply drive: ${title}**. Goal: ${goal.toLocaleString('en')} ${unit}.\n${cfg.baseUrl}/drives`);
    back(res, '/drives', 'Drive started.');
  });
  app.post('/drives/:id(\\d+)/give', needGuild, async (req, res) => {
    const d = db.prepare("SELECT * FROM drives WHERE id = ? AND guild_id = ? AND status = 'open'").get(req.params.id, req.guild.id);
    if (!d) return back(res, '/drives', 'That drive has finished.');
    const amount = Math.min(1e6, Math.max(1, Number(req.body.amount) || 0));
    if (!amount) return back(res, '/drives', 'How many did you hand in?');
    db.prepare('INSERT INTO drive_contribs (drive_id, user_id, character, amount, note) VALUES (?,?,?,?,?)').run(d.id, req.user.id, String(req.body.character || '').slice(0, 40) || null, amount, String(req.body.note || '').slice(0, 120));
    const total = db.prepare('SELECT SUM(amount) t FROM drive_contribs WHERE drive_id = ?').get(d.id).t;
    if (total >= d.goal) {
      db.prepare("UPDATE drives SET status = 'done' WHERE id = ?").run(d.id);
      activity.run(req.guild.id, 'drive', `${d.title} reached its goal!`);
      await discord(req.guild, `🎉 **${d.title}** reached its goal of ${d.goal.toLocaleString('en')} ${d.unit}. Thanks everyone!`);
      return back(res, '/drives', 'Goal reached. Thank you!');
    }
    back(res, '/drives', `Logged ${amount} ${d.unit}.`);
  });
  app.post('/drives/:id(\\d+)/close', needOfficer, (req, res) => {
    const r = db.prepare("UPDATE drives SET status = 'closed' WHERE id = ? AND guild_id = ? AND status = 'open'").run(req.params.id, req.guild.id);
    if (r.changes) audit(req, 'drive closed', `#${req.params.id}`);
    back(res, '/drives', 'Drive closed.');
  });
}

module.exports = { mountDiscord, routes };
