const R = require('../raids');
const V = require('../views/raids');

// datetime-local value + the browser's getTimezoneOffset() → ISO UTC.
function toUtc(local, tzOffset, fallbackOffset) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(local || ''));
  if (!m) return null;
  const off = Number.isFinite(Number(tzOffset)) && String(tzOffset) !== '' ? Number(tzOffset) : fallbackOffset;
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) + off * 60000;
  return new Date(ms).toISOString();
}
const unix = (iso) => Math.floor(new Date(iso).getTime() / 1000);

module.exports = function raidRoutes(app, { db, cfg, discord, activity, needGuild, needOfficer, back }) {
  const isOfficer = (req) => ['owner', 'officer'].includes(req.guild.role);
  const getRaid = (req, res) => {
    const raid = R.raidFor(db, req.guild.id, req.params.id);
    if (!raid) { res.status(404).send('Raid not found'); return null; }
    return raid;
  };
  const who = (req) => req.user.battletag.split('#')[0];

  // ---- list + schedule ----
  app.get('/raids', needGuild, (req, res) => {
    const gid = req.guild.id;
    const withCounts = (where, order) => db.prepare(`SELECT r.*,
        (SELECT COUNT(*) FROM signups s WHERE s.raid_id = r.id AND s.status = 'yes' AND s.role = 'tank') AS tanks,
        (SELECT COUNT(*) FROM signups s WHERE s.raid_id = r.id AND s.status = 'yes' AND s.role = 'healer') AS healers,
        (SELECT COUNT(*) FROM signups s WHERE s.raid_id = r.id AND s.status = 'yes' AND s.role = 'dps') AS dps
      FROM raids r WHERE r.guild_id = ? AND ${where} ORDER BY r.starts_at ${order} LIMIT 20`).all(gid);
    const cutoff = new Date(Date.now() - 6 * 3600 * 1000).toISOString();
    const upcoming = withCounts(`r.starts_at >= '${cutoff}' AND r.status != 'done'`, 'ASC');
    const past = withCounts(`(r.starts_at < '${cutoff}' OR r.status = 'done')`, 'DESC').slice(0, 10);
    const mine = Object.fromEntries(db.prepare('SELECT raid_id, status FROM signups WHERE user_id = ?').all(req.user.id).map((r) => [r.raid_id, r.status]));
    const instances = db.prepare('SELECT DISTINCT instance FROM loot_items WHERE guild_id = ? UNION SELECT DISTINCT instance FROM raids WHERE guild_id = ?').all(gid, gid).map((r) => r.instance);
    res.page({ title: 'Raids', active: 'raids', body: V.raidsList({ csrf: req.csrf, upcoming, past, isOfficer: isOfficer(req), instances, mine }) });
  });

  app.post('/raids', needOfficer, async (req, res) => {
    const title = String(req.body.title || '').trim().slice(0, 60);
    const instance = String(req.body.instance || '').trim().slice(0, 60);
    const startsAt = toUtc(req.body.starts, req.body.tz_offset, cfg.defaultTzOffset);
    if (!title || !instance || !startsAt) return back(res, '/raids', 'Fill in the name, instance and start time.');
    const size = Math.min(40, Math.max(0, Number(req.body.size) || 0)) || null;
    const srLimit = Math.min(5, Math.max(0, Number.isFinite(Number(req.body.sr_limit)) && req.body.sr_limit !== '' ? Number(req.body.sr_limit) : 2));
    const r = db.prepare('INSERT INTO raids (guild_id, title, instance, starts_at, size, sr_limit, notes, created_by) VALUES (?,?,?,?,?,?,?,?)')
      .run(req.guild.id, title, instance, startsAt, size, srLimit, String(req.body.notes || '').slice(0, 300), req.user.id);
    activity.run(req.guild.id, 'raid', `${who(req)} scheduled ${title}`);
    await discord(req.guild, `🗓️ **Raid: ${title}** (${instance})\n<t:${unix(startsAt)}:F>, <t:${unix(startsAt)}:R>\nSign up and reserve: ${cfg.baseUrl}/raids/${r.lastInsertRowid}`);
    res.redirect(`/raids/${r.lastInsertRowid}`);
  });

  // ---- one raid ----
  app.get('/raids/:id(\\d+)', needGuild, (req, res) => {
    const raid = getRaid(req, res); if (!raid) return;
    const gid = req.guild.id;
    const items = db.prepare(`SELECT li.*, COALESCE(l.bonus, 0) AS bonus FROM loot_items li
      LEFT JOIN loyalty l ON l.guild_id = li.guild_id AND l.item_id = li.id AND l.user_id = ?
      WHERE li.guild_id = ? AND li.instance = ? ORDER BY li.boss, li.name`).all(req.user.id, gid, raid.instance);
    res.page({
      title: raid.title, active: 'raids',
      body: V.raidPage({
        raid, csrf: req.csrf, items, isOfficer: isOfficer(req),
        signups: R.signupsFor(db, raid),
        mySignup: db.prepare('SELECT * FROM signups WHERE raid_id = ? AND user_id = ?').get(raid.id, req.user.id),
        myChars: db.prepare('SELECT name FROM characters WHERE guild_id = ? AND user_id = ? ORDER BY is_main DESC, level DESC').all(gid, req.user.id),
        myReserves: R.myReserves(db, raid, req.user.id),
        board: R.reserveBoard(db, raid),
        loot: db.prepare('SELECT * FROM loot_log WHERE raid_id = ? ORDER BY id').all(raid.id),
      }),
    });
  });

  app.post('/raids/:id(\\d+)/signup', needGuild, (req, res) => {
    const raid = getRaid(req, res); if (!raid) return;
    if (!['open', 'locked'].includes(raid.status)) return back(res, `/raids/${raid.id}`, 'Sign-ups are closed for this raid.');
    const character = String(req.body.character || '').trim().slice(0, 40);
    const role = ['tank', 'healer', 'dps'].includes(req.body.role) ? req.body.role : 'dps';
    const status = ['yes', 'tentative', 'no'].includes(req.body.status) ? req.body.status : 'yes';
    if (!character) return back(res, `/raids/${raid.id}`, 'Pick a character.');
    const before = db.prepare('SELECT status FROM signups WHERE raid_id = ? AND user_id = ?').get(raid.id, req.user.id);
    db.prepare(`INSERT INTO signups (raid_id, user_id, character, role, status, note, updated_at) VALUES (?,?,?,?,?,?, datetime('now'))
      ON CONFLICT (raid_id, user_id) DO UPDATE SET character = excluded.character, role = excluded.role, status = excluded.status,
      note = excluded.note, updated_at = excluded.updated_at`).run(raid.id, req.user.id, character, role, status, String(req.body.note || '').slice(0, 120));
    if (!before && status === 'yes') activity.run(req.guild.id, 'raid', `${character} signed up for ${raid.title}`);
    back(res, `/raids/${raid.id}`, status === 'no' ? 'Marked as can’t make it.' : 'You’re signed up.');
  });

  app.post('/raids/:id(\\d+)/reserves', needGuild, (req, res) => {
    const raid = getRaid(req, res); if (!raid) return;
    const picked = [].concat(req.body.item || []);
    try { R.setReserves(db, raid, req.user.id, picked); } catch (e) { return back(res, `/raids/${raid.id}`, e.message); }
    back(res, `/raids/${raid.id}`, picked.length ? 'Reserves saved.' : 'Reserves cleared.');
  });

  // ---- officer actions ----
  const setStatus = (from, to, msg) => (req, res) => {
    const raid = getRaid(req, res); if (!raid) return;
    if (!from.includes(raid.status)) return back(res, `/raids/${raid.id}`);
    db.prepare('UPDATE raids SET status = ? WHERE id = ?').run(to, raid.id);
    if (to === 'cancelled') discord(req.guild, `❌ **${raid.title}** on <t:${unix(raid.starts_at)}:F> is cancelled.`);
    back(res, `/raids/${raid.id}`, msg);
  };
  app.post('/raids/:id(\\d+)/lock', needOfficer, setStatus(['open'], 'locked', 'Reserves locked.'));
  app.post('/raids/:id(\\d+)/unlock', needOfficer, setStatus(['locked'], 'open', 'Reserves reopened.'));
  app.post('/raids/:id(\\d+)/cancel', needOfficer, setStatus(['open', 'locked'], 'cancelled', 'Raid cancelled.'));

  app.post('/raids/:id(\\d+)/close', needOfficer, async (req, res) => {
    const raid = getRaid(req, res); if (!raid) return;
    try {
      const r = R.closeRaid(db, raid, [].concat(req.body.attended || []));
      activity.run(req.guild.id, 'raid', `${raid.title} finished with ${r.attended} raiders`);
      back(res, `/raids/${raid.id}`, `Raid closed. ${r.attended} attended${r.noShows ? `, ${r.noShows} no-show${r.noShows === 1 ? '' : 's'}` : ''}. Bonuses updated.`);
    } catch (e) { back(res, `/raids/${raid.id}`, e.message); }
  });

  // ---- loot screen ----
  const lootData = (raid) => {
    const board = R.reserveBoard(db, raid);
    const rolls = {};
    for (const b of board) { const r = R.rollsFor(db, raid, b.item_id); if (r.length) rolls[b.item_id] = r; }
    return {
      raid, board, rolls,
      items: R.itemsForInstance(db, raid.guild_id, raid.instance),
      attending: db.prepare("SELECT user_id, character FROM signups WHERE raid_id = ? AND status IN ('yes','bench') ORDER BY character").all(raid.id),
      awarded: db.prepare('SELECT * FROM loot_log WHERE raid_id = ? ORDER BY id DESC').all(raid.id),
    };
  };
  app.get('/raids/:id(\\d+)/loot', needOfficer, (req, res) => {
    const raid = getRaid(req, res); if (!raid) return;
    res.page({ title: `Loot: ${raid.title}`, active: 'raids', body: V.lootScreen({ csrf: req.csrf, ...lootData(raid) }) });
  });
  app.post('/raids/:id(\\d+)/roll', needOfficer, (req, res) => {
    const raid = getRaid(req, res); if (!raid) return;
    R.rollItem(db, raid, Number(req.body.item_id));
    res.redirect(`/raids/${raid.id}/loot#item-${Number(req.body.item_id)}`);
  });
  app.post('/raids/:id(\\d+)/award', needOfficer, async (req, res) => {
    const raid = getRaid(req, res); if (!raid) return;
    const userId = Number(req.body.user_id) || null;
    const signup = userId ? db.prepare('SELECT character FROM signups WHERE raid_id = ? AND user_id = ?').get(raid.id, userId) : null;
    const kind = ['sr', 'ms', 'os', 'free'].includes(req.body.kind) ? req.body.kind : 'ms';
    let itemId = Number(req.body.item_id) || null;
    if (!itemId && req.body.item_name) {
      const match = db.prepare('SELECT id FROM loot_items WHERE guild_id = ? AND instance = ? AND lower(name) = lower(?)').get(raid.guild_id, raid.instance, String(req.body.item_name).trim());
      if (match) itemId = match.id;
    }
    try {
      const name = R.awardItem(db, raid, { itemId, itemName: req.body.item_name, userId, character: signup ? signup.character : null, kind });
      activity.run(req.guild.id, 'loot', `${signup ? signup.character : 'Someone'} received ${name}`);
      await discord(req.guild, `💎 **${name}** → ${signup ? signup.character : 'someone'} (${kind.toUpperCase()}, ${raid.title})`);
    } catch (e) { return back(res, `/raids/${raid.id}/loot`, e.message); }
    res.redirect(`/raids/${raid.id}/loot`);
  });

  // ---- loot catalogue + history ----
  app.get('/loot', needGuild, (req, res) => {
    const gid = req.guild.id;
    const catalog = {};
    for (const i of db.prepare('SELECT * FROM loot_items WHERE guild_id = ? ORDER BY instance, boss, name').all(gid)) (catalog[i.instance] ||= []).push(i);
    res.page({
      title: 'Loot', active: 'loot',
      body: V.lootPage({
        csrf: req.csrf, isOfficer: isOfficer(req), catalog, focus: String(req.query.instance || ''),
        history: db.prepare('SELECT l.*, r.title FROM loot_log l LEFT JOIN raids r ON r.id = l.raid_id WHERE l.guild_id = ? ORDER BY l.id DESC LIMIT 100').all(gid),
        myLoyalty: db.prepare(`SELECT li.name, li.instance, l.bonus FROM loyalty l JOIN loot_items li ON li.id = l.item_id
          WHERE l.guild_id = ? AND l.user_id = ? AND l.bonus > 0 ORDER BY l.bonus DESC`).all(gid, req.user.id),
      }),
    });
  });
  app.post('/loot/items', needOfficer, (req, res) => {
    const instance = String(req.body.instance || '').trim().slice(0, 60);
    if (!instance) return back(res, '/loot', 'Name the instance.');
    const n = R.importItems(db, req.guild.id, instance, req.body.items);
    back(res, `/loot?instance=${encodeURIComponent(instance)}`, `${n} item${n === 1 ? '' : 's'} added to ${instance}.`);
  });
  app.post('/loot/items/:id(\\d+)/delete', needOfficer, (req, res) => {
    const it = db.prepare('SELECT * FROM loot_items WHERE id = ? AND guild_id = ?').get(req.params.id, req.guild.id);
    if (it) db.prepare('DELETE FROM loot_items WHERE id = ?').run(it.id);
    back(res, `/loot${it ? `?instance=${encodeURIComponent(it.instance)}` : ''}`, it ? `${it.name} removed.` : '');
  });

  // ---- one-hour reminders ----
  async function remind() {
    const soon = db.prepare(`SELECT r.*, g.discord_webhook FROM raids r JOIN guilds g ON g.id = r.guild_id
      WHERE r.reminded = 0 AND r.status IN ('open','locked') AND r.starts_at <= ? AND r.starts_at > ?`)
      .all(new Date(Date.now() + 3600 * 1000).toISOString(), new Date().toISOString());
    for (const r of soon) {
      db.prepare('UPDATE raids SET reminded = 1 WHERE id = ?').run(r.id);
      const c = V.roleCounts(db.prepare('SELECT role, status FROM signups WHERE raid_id = ?').all(r.id));
      await discord(r, `⏰ **${r.title}** starts <t:${unix(r.starts_at)}:R>. ${c.tank} tank${c.tank === 1 ? '' : 's'}, ${c.healer} healer${c.healer === 1 ? '' : 's'}, ${c.dps} damage signed up.\n${cfg.baseUrl}/raids/${r.id}`);
    }
    return soon.length;
  }
  return { remind };
};

module.exports.toUtc = toUtc;
