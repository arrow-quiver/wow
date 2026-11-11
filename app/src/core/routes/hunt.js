// The hunt (services/hunt.js): the kill-on-sight list and bounties. API: docs/api/war.md.
//
//   GET  /api/hunt                    { kos, bounties, canPost, kosPoints }
//   POST /api/kos                     { name, reason? } → on the list for the guild ("ko")
//   POST /api/kos/:name/remove        off the list
//   POST /api/bounties                officers: { target? | zone?, points, cap?, days?, note? } ("BT")
//   POST /api/bounties/:id/close      officers: closes it (final)
const H = require('../services/hunt');
const sharing = require('../sharing');
const { keyOk } = require('../../shared/sharing');
const { HttpError, str, int, needGuild, isOfficer } = require('../http');

const NO_CHARACTER = 'Log in to World of Warcraft on a character in your guild first, then log out or type /reload.';
const cap1 = (s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

function register(app, ctx) {
  const { db } = ctx;
  function myPid() {
    const pid = sharing.myPid(db);
    if (!pid) throw new HttpError(409, NO_CHARACTER);
    return pid;
  }
  function enemyName(v) {
    const s = cap1(String(v || '').trim().split('-')[0]);
    if (!s || !keyOk('ko', s)) throw new HttpError(400, 'Type the player\'s name as it shows in game (letters only, no realm).');
    return s;
  }

  app.get('/api/hunt', needGuild, (req, res) => {
    res.json({ kos: H.kos(db, req.guild.id), bounties: H.bounties(db, req.guild.id), canPost: isOfficer(req), kosPoints: H.KOS_POINTS });
  });

  app.post('/api/kos', needGuild, (req, res) => {
    const name = enemyName(req.body && req.body.name);
    const reason = str(req.body && req.body.reason, 100) || '';
    sharing.queue(db, ctx, { type: 'ko', key: name, fields: { pid: myPid(), reason, state: 'o' } });
    res.status(201).json({ ok: true, message: `${name} is now kill on sight for the guild.` });
  });

  app.post('/api/kos/:name/remove', needGuild, (req, res) => {
    const name = enemyName(req.params.name);
    const row = db.prepare('SELECT * FROM kos WHERE guild_id = ? AND name = ?').get(req.guild.id, name);
    if (!row) throw new HttpError(404, `${name} isn't on the list.`);
    sharing.queue(db, ctx, { type: 'ko', key: name, fields: { pid: myPid(), reason: row.reason || '', state: 'x' }, base: sharing.baseOf(db, req.guild.id, `ko:${name}`) });
    db.prepare('DELETE FROM kos WHERE guild_id = ? AND name = ?').run(req.guild.id, name);
    res.json({ ok: true, message: `${name} is off the list.` });
  });

  app.post('/api/bounties', needGuild, (req, res) => {
    if (!isOfficer(req)) throw new HttpError(403, 'Only officers put up bounties.');
    const b = req.body || {};
    const target = b.target ? enemyName(b.target) : '';
    const zone = target ? '' : str(b.zone, 60) || '';
    if (!target && !zone) throw new HttpError(400, 'Name a player, or a zone for kills anywhere in it.');
    const points = int(b.points, 1, 1000);
    if (!points) throw new HttpError(400, 'Points: 1 to 1,000.');
    const cap = target ? 1 : int(b.cap, 1, 100) || 10;
    const days = int(b.days, 1, 30) || 7;
    const until = Math.floor(Date.now() / 1000) + days * H.DAY;
    const note = str(b.note, 100) || '';
    const key = sharing.newKey();
    sharing.queue(db, ctx, { type: 'BT', key, fields: { target, zone, points, cap, ends: until, note, state: 'o' }, need: 'o' });
    ctx.audit(req, 'bounty posted', `${target || zone}: ${points} points`);
    res.status(201).json({ ok: true, key, message: target ? `Bounty up: ${points} points for ${target}.` : `Bounty up: ${points} points a kill in ${zone}, ${cap} kills.` });
  });

  app.post('/api/bounties/:id/close', needGuild, (req, res) => {
    if (!isOfficer(req)) throw new HttpError(403, 'Only officers close bounties.');
    const id = int(req.params.id, 1);
    const row = id && db.prepare('SELECT * FROM bounties WHERE id = ? AND guild_id = ?').get(id, req.guild.id);
    if (!row) throw new HttpError(404, 'That bounty is gone.');
    const rec = sharing.recordOf(db, req.guild.id, `BT:${row.share_id}`);
    if (rec && rec.fields) sharing.queue(db, ctx, { type: 'BT', key: row.share_id, fields: { ...rec.fields, state: 'x' }, need: 'o', base: sharing.baseOf(db, req.guild.id, `BT:${row.share_id}`) });
    db.prepare("UPDATE bounties SET state = 'x' WHERE id = ?").run(row.id);
    res.json({ ok: true, message: 'Bounty closed.' });
  });
}

module.exports = { register };
