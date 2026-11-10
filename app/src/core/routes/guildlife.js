// Guild life (services/guildlife.js): the bulletin board, leveling matches and the weekly guild digest.
//
//   GET  /api/board                 { posts, myCharacters, kinds }
//   POST /api/board                 { character, kind: lfg|wts|wtb|help, text, price? (copper) } → a "bb" record
//   POST /api/board/:id/remove      my post: taken down for the guild ("bb" state x)
//   GET  /api/leveling              { characters: [{ character, level, usually, matches: [...] }] }
//   GET  /api/digest?week=          the week's digest (YYYY-MM-DD, any day of it; this week by default) + canPost
//   POST /api/digest/post           officers: { week? } → the digest on Discord (once a week; force: true again)
//
// The Guild Master's app posts the week's digest to Discord on Sunday evening by itself (hourly check).
const G = require('../services/guildlife');
const identity = require('../identity');
const sharing = require('../sharing');
const { HttpError, str, int, needGuild, isOfficer } = require('../http');

const NO_CHARACTER = 'Log in to World of Warcraft on a character in your guild first, then log out or type /reload.';
const MAX_PRICE = 10000 * 10000; // 10,000 gold

function register(app, ctx) {
  const { db } = ctx;
  const here = identity.notElsewhere('c');
  const myChars = db.prepare(`SELECT c.name, c.class, c.level FROM characters c WHERE c.guild_id = ? AND c.user_id = ? AND c.is_bank = 0 AND ${here}
    ORDER BY c.is_main DESC, c.level DESC, c.name`);

  function myPid() {
    const pid = sharing.myPid(db);
    if (!pid) throw new HttpError(409, NO_CHARACTER);
    return pid;
  }

  app.get('/api/board', needGuild, (req, res) => {
    res.json({ posts: G.board(db, req.guild.id, req.user.id), myCharacters: myChars.all(req.guild.id, req.user.id), kinds: G.KINDS });
  });

  app.post('/api/board', needGuild, (req, res) => {
    const b = req.body || {};
    const character = str(b.character, 48);
    const mine = myChars.all(req.guild.id, req.user.id);
    if (!character || !mine.some((c) => c.name === character)) throw new HttpError(400, 'Pick one of your characters.');
    const kind = G.KIND_CODE[b.kind];
    if (!kind) throw new HttpError(400, 'Pick what kind of post it is: looking for group, selling, buying or help wanted.');
    const text = str(b.text, 200);
    if (!text) throw new HttpError(400, 'Write what the post is about.');
    let price = null;
    if (b.price != null && b.price !== '') {
      price = int(b.price, 0, MAX_PRICE);
      if (price == null) throw new HttpError(400, 'The price is in copper, up to 10,000 gold.');
    }
    const key = sharing.newKey();
    sharing.queue(db, ctx, { type: 'bb', key, fields: { pid: myPid(), character, kind, text, price: price || null, state: 'o' } });
    ctx.activity(req.guild.id, 'board', `${character}: ${G.KINDS[b.kind]}: ${text.slice(0, 80)}`);
    const post = G.board(db, req.guild.id, req.user.id).find((p) => p.text === text && p.character === character);
    res.status(201).json({ post: post || null, message: 'Posted to the guild. It stays up for a week.' });
  });

  app.post('/api/board/:id/remove', needGuild, (req, res) => {
    const id = int(req.params.id, 1);
    const row = id && db.prepare('SELECT * FROM bulletin_posts WHERE id = ? AND guild_id = ?').get(id, req.guild.id);
    if (!row) throw new HttpError(404, 'That post is already gone.');
    if (row.user_id !== req.user.id) throw new HttpError(403, 'You can only take down your own posts.');
    const rec = row.share_id && sharing.recordOf(db, req.guild.id, `bb:${row.share_id}`);
    if (rec && !rec.del && rec.fields) sharing.queue(db, ctx, { type: 'bb', key: row.share_id, fields: { ...rec.fields, state: 'x' } });
    db.prepare('DELETE FROM bulletin_posts WHERE id = ?').run(row.id);
    res.json({ ok: true, message: 'Post taken down.' });
  });

  app.get('/api/leveling', needGuild, (req, res) => {
    res.json({ characters: G.matches(db, req.guild.id, req.user.id), levelGap: G.LEVEL_GAP });
  });

  app.get('/api/digest', needGuild, (req, res) => {
    const d = G.digest(db, req.guild.id, { week: str(req.query.week, 10) });
    res.json({ ...d, canPost: isOfficer(req), discord: Boolean(ctx.cfg.discordWebhook), text: G.discordText(d) });
  });

  app.post('/api/digest/post', needGuild, async (req, res) => {
    if (!isOfficer(req)) throw new HttpError(403, 'Only officers post the weekly digest.');
    if (!ctx.cfg.discordWebhook) throw new HttpError(409, 'Add your guild\'s Discord webhook in Settings → Discord first.');
    const b = req.body || {};
    const r = await G.post(db, ctx, req.guild.id, str(b.week, 10), { force: Boolean(b.force) });
    if (r === 'failed') throw new HttpError(502, 'Discord didn\'t take the message. Check the webhook in Settings → Discord.');
    res.json({ ok: true, posted: r === 'posted', message: r === 'posted' ? 'The weekly digest is on Discord.' : 'This week\'s digest is already on Discord.' });
  });

  // Sunday evening: the Guild Master's app posts the week.
  async function autoDigest(now = new Date()) {
    if (!ctx.cfg.discordWebhook || !G.dueNow(now)) return null;
    const g = ctx.guild && ctx.guild();
    const m = identity.myMembership(db);
    if (!g || !m || m.role !== 'owner') return null;
    return G.post(db, ctx, g.id, G.weekOf(now.getTime()));
  }
  ctx.services.guildlife = { autoDigest };
  if (ctx.cfg.timers) {
    const h = setInterval(() => { autoDigest().catch((err) => (ctx.log || console).warn(`Weekly digest: ${err.message}`)); }, 60 * 60 * 1000);
    if (h.unref) h.unref();
    ctx.timers.push(h);
  }
}

module.exports = { register };
