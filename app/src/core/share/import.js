'use strict';
// Records coming in from the addon's store (docs/SHARING.md §10 "Import", steps 1–5).
//
// importShared(db, ctx, payloadShared, { file }) → { imported, ignored, acked, refused, checks, posts }
//   Runs inside applyPayload's transaction, after characters and roster. payloadShared is
//   WowGuildDB.shared from one SavedVariables file (untrusted). `posts` are Discord messages for my own
//   records whose "ok" arrived; services/sync.js sends them after the transaction (afterImport). `ctas`
//   are my own calls to arms written in game ({ id, zone, character, message, needed }, as stats.ctas).
const S = require('../../shared/sharing');
const CtaDiscord = require('../services/ctaDiscord');
const identity = require('../identity');
const { rememberNames } = require('../services/economy');
const st = require('./store');
const project = require('./project');
const text = require('./text');
const prune = require('./prune');
const { queue, ensurePid } = require('./queue');

// Built by the addon itself, never by the app: a copy in my name from elsewhere is normal.
// Dungeon groups and joins are also made in game (/wow lfg).
const ADDON_BUILT = new Set(['ch', 'rc', 'gb', 'bk', 'sh', 'ca', 'dg', 'dj']);
// Reasons that a later record (a link, a raid, a loot list, the bank characters, my role) can fix.
const RETRY = ['link', 'raid', 'loot list', 'bank', 'officers only'];
// ch first (links), then settings and lists that later records are checked against.
const PRIORITY = { ch: 0, CFG: 1, BC: 2, LL: 3, RD: 4, RT: 5, LY: 6, DR: 7, cr: 8, bq: 8, dg: 8 };
const prio = (type) => (type in PRIORITY ? PRIORITY[type] : 9);
const DAY = 86400;

const obj = (v) => (v && typeof v === 'object' ? v : {});
const seg = (r, i) => String(r.key).split(':')[i];
// Where a pid-keyed record names its player.
const PID_OF = {
  su: (r) => seg(r, 1), cl: (r) => seg(r, 1), dj: (r) => seg(r, 1), dg: (r) => r.fields && r.fields.pid, lp: (r) => seg(r, 0), sh: (r) => r.key, pr: (r) => r.key, wm: (r) => r.key,
  cr: (r) => r.fields && r.fields.pid, dc: (r) => r.fields && r.fields.pid, bq: (r) => r.fields && r.fields.pid,
};

// via = "<first sender>,<time>,<how>" (the addon writes "<me>,<time>,d" for what it made itself);
// no via: the app stored it from an acknowledgement ('o').
function parseVia(s) {
  if (typeof s !== 'string' || !s) return { by: null, at: null, how: 'o', raw: null };
  const [by, at, how] = s.split(',');
  return { by: by || null, at: Number(at) || null, how: ['d', 't', 'm', 's'].includes(how) ? how : 'm', raw: s.slice(0, 120) };
}

function amOfficer(db) {
  const m = identity.myMembership(db);
  return Boolean(m && (m.role === 'owner' || m.role === 'officer'));
}

// §5 import rules. → null when the record may be used, else a reason code (text.reasonText).
function importRule(db, gid, rec, how, prevOk) {
  if (S.spaceOf(rec.type) === 'officer' && how === 'm') return 'rank';
  if (rec.type === 'WH' && !rec.del && !amOfficer(db)) return 'officers only';
  const pidOf = PID_OF[rec.type];
  if (pidOf) {
    let pid = pidOf(rec);
    if (!pid && rec.del && prevOk && !prevOk.del) pid = pidOf(prevOk);
    if (pid) {
      if (!st.isLinked(db, gid, rec.author, pid)) return 'link';
      if (prevOk && !prevOk.del && ['cr', 'dc', 'bq', 'dg'].includes(rec.type) && !rec.del && prevOk.fields.pid !== pid) return 'owner';
    } else if (!rec.del) return 'link';
  }
  if (rec.del) return null;
  if (rec.type === 'cl') {
    const cr = st.live(db, gid, `cr:${seg(rec, 0)}`);
    if (cr && cr.rec.fields.pid === seg(rec, 1)) return 'own request';
  }
  if (rec.type === 'dj') {
    const dg = st.live(db, gid, `dg:${seg(rec, 0)}`);
    if (dg && dg.rec.fields.pid === seg(rec, 1)) return 'own group';
  }
  if (rec.type === 'bk') {
    const bc = st.live(db, gid, 'BC:1');
    if (!bc || !(bc.rec.fields.names || []).includes(rec.author)) return 'bank';
  }
  if (rec.type === 'su' && (rec.fields.reserves || []).length) {
    const rd = st.live(db, gid, `RD:${seg(rec, 0)}`);
    if (!rd) return 'raid';
    const limit = rd.rec.fields.srLimit == null ? 2 : rd.rec.fields.srLimit;
    if (rec.fields.reserves.length > limit) return 'limit';
    const ll = st.live(db, gid, `LL:${S.instanceKey(rd.rec.fields.instance)}`);
    if (!ll) return 'loot list';
    const keys = new Set((ll.rec.fields.items || []).map((i) => i && i.item));
    if (rec.fields.reserves.some((k) => !keys.has(k))) return 'loot list';
  }
  return null;
}

function audit(db, gid, author, detail, action = 'from the guild') {
  const uid = author ? st.userForCharacter(db, gid, author, { create: false }) : null;
  db.prepare('INSERT INTO audit_log (guild_id, user_id, action, detail) VALUES (?,?,?,?)').run(gid, uid, action, String(detail).slice(0, 300));
}

const passedOn = (rec, via) => (via && via.by && via.by !== rec.author ? ` (passed on by ${via.by})` : '');

// ---- step 1: names ------------------------------------------------------------------------------
function entriesOf(v) {
  if (Array.isArray(v)) return v.map((name, i) => [i + 1, name]);
  return Object.entries(obj(v)).map(([k, name]) => [Number(k), name]);
}

function saveNames(db, gid, names, tasks) {
  const n = obj(names);
  let added = 0;
  const spell = db.prepare('SELECT name FROM spell_names WHERE spell_id = ?');
  const upSpell = db.prepare('INSERT INTO spell_names (spell_id, name) VALUES (?,?) ON CONFLICT (spell_id) DO UPDATE SET name = excluded.name');
  for (const [id, name] of entriesOf(n.s).slice(0, 20000)) {
    if (!Number.isInteger(id) || id <= 0 || typeof name !== 'string' || !name.trim()) continue;
    const old = spell.get(id);
    if (old && old.name === name.slice(0, 100)) continue;
    upSpell.run(id, name.slice(0, 100));
    added++;
  }
  const item = db.prepare('SELECT name FROM item_names WHERE item_id = ?');
  const fresh = [];
  for (const [id, name] of entriesOf(n.i).slice(0, 20000)) {
    if (!Number.isInteger(id) || id <= 0 || typeof name !== 'string' || !name.trim()) continue;
    const old = item.get(id);
    if (old && old.name === name.slice(0, 100)) continue;
    fresh.push({ id, name });
  }
  rememberNames(db, fresh);
  added += fresh.length;
  if (!added) return;
  // Recipes that only had a number for a name get theirs now, from their rc record. Rows whose record is gone (dropped
  // once every addon had expired it, its share_pruned entry forgotten since) stay as they are: remaking them without
  // a record would only delete them.
  const byName = Object.fromEntries(Object.entries(S.SKILLS).map(([k, v]) => [v, Number(k)]));
  const stored = db.prepare('SELECT 1 FROM shared_records WHERE guild_id = ? AND id = ? LIMIT 1');
  for (const r of db.prepare(`SELECT DISTINCT c.name, r.profession FROM recipes r JOIN characters c ON c.id = r.character_id
      WHERE c.guild_id = ? AND r.name LIKE 'Recipe %'`).all(gid)) {
    const skill = byName[r.profession] || (/^Skill (\d+)$/.exec(r.profession) || [])[1];
    const id = skill ? `rc:${r.name}:${S.toB36(Number(skill))}` : null;
    if (id && stored.get(gid, id)) tasks.add(id);
  }
}

// ---- step 2: acknowledgements -------------------------------------------------------------------
function rebuild(row, v, author) {
  return `${row.rec_id}^${v}^${author}^${row.del ? 'd' : ''}${!row.del && row.body ? `^${row.body}` : ''}`;
}

// A drive as the guild has it (stored records only: this computer's unsent hand-ins don't count yet), and the
// hand-in that reached the goal: the first one, in the order they were made, that brought the total to it.
// → { dr: record string, state: S.driveState, reachedBy: player id of that hand-in | null } | null
function guildDrive(db, gid, key) {
  const dr = st.lookupFor(db, gid)(`DR:${key}`);
  if (!dr) return null;
  const dcs = db.prepare(`SELECT CASE WHEN state = 'ok' THEN body ELSE kept END AS body FROM shared_records
    WHERE guild_id = ? AND substr(id, 1, 3) = 'dc:' AND (state = 'ok' OR kept IS NOT NULL)`).all(gid).map((r) => r.body);
  const state = S.driveState(dr, dcs);
  let reachedBy = null;
  if (state.reached) {
    const given = dcs.map((s) => S.decode(s)).filter((r) => r && !r.del && r.fields && r.fields.drive === key)
      .sort((a, b) => (a.t - b.t) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    let total = 0;
    for (const r of given) {
      total += r.fields.amount || 0;
      if (total >= state.goal) { reachedBy = r.fields.pid || null; break; }
    }
  }
  return { dr, state, reachedBy };
}

function processAcks(db, gid, sent, run) {
  const { tasks, result, lookup } = run;
  const goals = new Map(); // drive key → the drive as the guild had it before my first hand-in in these answers
  for (const [op, val] of Object.entries(obj(sent))) {
    if (typeof val !== 'string') continue;
    const row = st.outboxRow(db, op);
    if (!row || row.guild_id !== gid) continue;
    const parts = val.split(',');
    const kind = parts[0];
    if (kind === 'ok') {
      if (row.state === 'sent' || row.sent_v) continue;
      const v = parts[1] || '';
      const author = parts[2] || '';
      const at = st.iso(st.localNow()).replace('T', ' ').slice(0, 19);
      const dropped = row.state === 'dropped';
      db.prepare('UPDATE share_outbox SET state = ?, sent_v = ?, sent_author = ?, sent_at = ?, note = NULL WHERE op = ?')
        .run(dropped ? 'dropped' : 'sent', v, author, at, op);
      // This version went out from here (a dropped entry too: the game had sent it already): never an author check.
      if (v) st.noteSent(db, gid, row.rec_id, v);
      if (dropped) continue;
      result.acked++;
      const prov = row.record ? S.decode(row.record) : null;
      const str = rebuild(row, v, author);
      const rec = S.decode(str);
      if (rec && rec.v === v && rec.author === author) {
        const before = st.effective(db, gid, row.rec_id);
        const stored = st.storedRow(db, gid, row.rec_id);
        const driveKey = rec.type === 'dc' && !rec.del && rec.fields ? rec.fields.drive : null;
        const driveBefore = driveKey && !goals.has(driveKey) ? guildDrive(db, gid, driveKey) : null;
        const wrote = !stored || S.compareRecords(stored.body, str) < 0;
        if (wrote) {
          db.prepare(`INSERT INTO shared_records (guild_id, id, v, author, via, how, body, state, reason, kept) VALUES (?,?,?,?,NULL,'o',?,'ok',NULL,NULL)
            ON CONFLICT (guild_id, id) DO UPDATE SET v = excluded.v, author = excluded.author, via = NULL, how = 'o', body = excluded.body,
            state = 'ok', reason = NULL, kept = NULL`).run(gid, row.rec_id, v, author, str);
        }
        for (const t of project.tasksFor(rec, before && before.rec)) tasks.add(t);
        const post = text.discordPost(rec, { lookup, created: !row.base });
        // A call to arms already posted by the app or from the chat log (services/ctaDiscord.js) doesn't go twice.
        const ca = rec.type === 'ca' && rec.fields ? { character: rec.fields.character || rec.author, zone: rec.fields.zone, message: rec.fields.message } : null;
        if (post && (!ca || CtaDiscord.claim(db, gid, ca))) result.posts.push(post);
        if (wrote && driveKey && !goals.has(driveKey)) goals.set(driveKey, driveBefore);
      }
      for (const t of project.tasksFor(prov, null)) tasks.add(t);
    } else if (kind === 'wait') {
      if (!st.ACTIVE.includes(row.state)) continue;
      const note = text.waitNote(parts[1], { anchor: st.anchorOf(st.myPid(db)) });
      if (row.state !== 'waiting' || row.note !== note) db.prepare("UPDATE share_outbox SET state = 'waiting', note = ? WHERE op = ?").run(note, op);
    } else if (kind === 'no') {
      if (!st.ACTIVE.includes(row.state)) continue;
      db.prepare("UPDATE share_outbox SET state = 'refused', note = ?, sent_at = ? WHERE op = ?")
        .run(text.refusedNote(parts[1]), st.iso(st.localNow()).replace('T', ' ').slice(0, 19), op);
      result.refused++;
      // Roll back: the rows are made again without the provisional record.
      const prov = row.record ? S.decode(row.record) : null;
      for (const t of project.tasksFor(prov, null)) tasks.add(t);
      const now = st.effective(db, gid, row.rec_id);
      for (const t of project.tasksFor(now && now.rec, null)) tasks.add(t);
    }
  }
  // My hand-in brought a drive to its goal: said once, by the app of the player whose hand-in did it (the
  // first, in the order they were made, to bring the total to the goal). Checked once the whole upload is in
  // (run.after), so a drive I started and filled at once counts whichever answer came first, and a guildmate's
  // earlier hand-in that came with my "ok" counts before mine (their app then stays quiet).
  for (const [key, before] of goals) {
    if (before && before.state.reached) continue;
    run.after.push(() => {
      const after = guildDrive(db, gid, key);
      if (after && after.state.reached && !after.state.closed && after.reachedBy && after.reachedBy === st.myPid(db, gid)) {
        result.posts.push(text.driveGoalPost(after.dr));
      }
    });
  }
}

// ---- step 3 and 5: one record -------------------------------------------------------------------
function upsertRecord(db, gid, rec, str, via, reason, existing) {
  let kept = null;
  if (reason && existing) kept = existing.state === 'ok' ? existing.body : existing.kept;
  db.prepare(`INSERT INTO shared_records (guild_id, id, v, author, via, how, body, state, reason, kept) VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT (guild_id, id) DO UPDATE SET v = excluded.v, author = excluded.author, via = excluded.via, how = excluded.how,
    body = excluded.body, state = excluded.state, reason = excluded.reason, kept = excluded.kept`)
    .run(gid, rec.id, rec.v, rec.author, via.raw, via.how, str, reason ? 'ignored' : 'ok', reason || null, kept);
}

function emitLater(run, fn) { run.after.push(fn); }

// Notifications (step 5): valid records under 24 hours old that are not mine. A record from before the guild's
// last fresh start comes back with the store as new, but was shown then: no second notification.
function notify(db, ctx, gid, rec, prevOk, run) {
  if (!ctx || typeof ctx.emit !== 'function') return;
  if (st.isMine(db, gid, rec.author) || rec.t < run.now - DAY || rec.t <= run.resetAt) return;
  const f = rec.fields || {};
  const who = rec.author;
  const created = !prevOk;
  const raidRoute = (k) => {
    const r = db.prepare('SELECT id FROM raids WHERE guild_id = ? AND share_id = ?').get(gid, k);
    return r ? `/raids/${r.id}` : '/raids';
  };
  switch (rec.type) {
    case 'RD':
      if (!created || rec.del) return;
      emitLater(run, () => ctx.emit(gid, 'raid', {
        title: `${text.KIND_ICON[f.kind] || text.KIND_ICON.r} ${f.title}`,
        body: `${f.instance}, ${text.whenLabel(f.startsAt)}. Sign up in Guild Camp.`,
        route: raidRoute(rec.key),
      }));
      return;
    case 'RT': {
      if (rec.del || f.status !== 'x' || (prevOk && !prevOk.del && prevOk.fields.status === 'x')) return;
      emitLater(run, () => {
        const raid = db.prepare('SELECT id, title FROM raids WHERE guild_id = ? AND share_id = ?').get(gid, rec.key);
        if (!raid) return;
        const signed = db.prepare("SELECT 1 FROM signups WHERE raid_id = ? AND user_id = ? AND status != 'no'").get(raid.id, identity.meId(db));
        if (signed) ctx.emit(gid, 'raid', { title: `❌ ${raid.title} is cancelled`, body: 'Check Guild Camp for details.', route: `/raids/${raid.id}`, userId: identity.meId(db) });
      });
      return;
    }
    case 'AN':
      if (created && !rec.del) emitLater(run, () => ctx.emit(gid, 'notice', { title: '📜 Guild notice', body: f.body, route: '/' }));
      return;
    case 'ca':
      if (!created || rec.del || rec.t < run.now - 3600) return;
      emitLater(run, () => ctx.emit(gid, 'cta', {
        title: `⚔️ Call to arms: ${f.zone}`,
        body: [f.needed ? `Need ${f.needed}.` : '', f.message || '', `(${f.character || who})`].filter(Boolean).join(' '),
        route: '/',
      }));
      return;
    case 'dg':
      // A new group from a guildmate, still to come: everyone hears (the Calls to arms choice turns it off).
      if (!created || rec.del || f.state !== 'o' || f.pid === st.myPid(db) || (f.startsAt || 0) < run.now - 3600) return;
      emitLater(run, () => ctx.emit(gid, 'cta', {
        title: `🛡️ ${f.character || who} is grouping for ${f.dungeon || 'a dungeon'}`,
        body: `${text.dungeonWhen(f.startsAt, run.now)}.${f.note ? ` ${f.note}` : ''} Join in Guild Camp or with /wow lfg.`,
        route: '/dungeons',
      }));
      return;
    case 'dj': {
      // Someone joined (or left) my group.
      if (rec.del || (prevOk && !prevOk.del && prevOk.fields.status === f.status)) return;
      const dg = st.live(db, gid, `dg:${seg(rec, 0)}`);
      if (!dg || dg.rec.fields.pid !== st.myPid(db) || dg.rec.fields.state !== 'o') return;
      const role = text.ROLE[f.role] || 'damage';
      emitLater(run, () => ctx.emit(gid, 'cta', f.status === 'y'
        ? { title: `🛡️ ${f.character || who} joined your ${dg.rec.fields.dungeon} group`, body: `As ${role}. Invite them in game.`, route: '/dungeons', userId: identity.meId(db) }
        : { title: `🛡️ ${f.character || who} left your ${dg.rec.fields.dungeon} group`, body: 'Their spot is open again.', route: '/dungeons', userId: identity.meId(db) }));
      return;
    }
    case 'cr':
      if (!created || rec.del || f.state !== 'o' || f.pid === st.myPid(db)) return;
      emitLater(run, () => ctx.emit(gid, 'request', {
        title: `🔨 ${who} needs ${f.item}`, body: `You can craft it.${f.notes ? ` ${f.notes}` : ''}`, route: '/requests', recipe: f.item,
      }));
      return;
    case 'cl': {
      if (rec.del || (prevOk && !prevOk.del && prevOk.fields.state === f.state)) return;
      const cr = st.live(db, gid, `cr:${seg(rec, 0)}`);
      if (!cr || cr.rec.fields.pid !== st.myPid(db) || (f.state !== 'c' && f.state !== 'd')) return;
      const item = cr.rec.fields.item;
      emitLater(run, () => ctx.emit(gid, 'request', f.state === 'c'
        ? { title: `🔨 ${who} is making ${item}`, body: 'They claimed your crafting request.', route: '/requests', userId: identity.meId(db) }
        : { title: `📦 ${item} delivered`, body: `${who} marked your crafting request as delivered.`, route: '/requests', userId: identity.meId(db) }));
      return;
    }
    case 'bq':
      if (!created || rec.del || f.state !== 'o') return;
      emitLater(run, () => ctx.emit(gid, 'bank', {
        title: `🏦 Bank request from ${who}`, body: `${f.count || 1} × ${f.item}`, route: '/bank?tab=requests', officersOnly: true,
      }));
      return;
    case 'BH': {
      if (rec.del || (prevOk && !prevOk.del && prevOk.fields.state === f.state)) return;
      const bq = st.live(db, gid, `bq:${rec.key}`);
      if (!bq || bq.rec.fields.pid !== st.myPid(db)) return;
      const sent = f.state === 's';
      emitLater(run, () => ctx.emit(gid, 'bank', {
        title: sent ? '🏦 Your bank request is on its way' : '🏦 Your bank request was declined',
        body: `${bq.rec.fields.count || 1} × ${bq.rec.fields.item}. ${sent ? 'Sent' : 'Declined'} by ${who}.`,
        route: '/bank?tab=requests', userId: identity.meId(db),
      }));
      return;
    }
    case 'DR':
      if (!created || rec.del || f.state === 'c') return;
      emitLater(run, () => ctx.emit(gid, 'drive', {
        title: `📦 Supply drive: ${f.title}`, body: `Goal: ${text.num(f.goal)} ${f.unit}. Log what you hand in under Drives.`, route: '/drives',
      }));
      return;
    default:
  }
}

// "Jaina", "Jaina and Bob", "Jaina, Bob and Zed".
const namesText = (list) => (list.length < 2 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`);

// §3 author check for my anchor's ch: anyone can relay a ch in my anchor's name, so one that lists a character
// this computer doesn't know as mine (not uploaded here, not confirmed, not on my Battle.net account) asks me.
// Nothing is linked to me meanwhile (project.relinkPid). "It was me" confirms the names (my other PC, say);
// "Undo it" leaves them out, and the addon re-stamps my own list at the next login on the anchor.
function chAltsCheck(db, gid, rec, via, run) {
  if (rec.type !== 'ch' || rec.del || !rec.fields || !via.raw) return;
  const pid = st.myPid(db, gid);
  if (!pid || rec.fields.pid !== pid || rec.key !== st.anchorOf(pid)) return;
  const unknown = [...new Set((Array.isArray(rec.fields.alts) ? rec.fields.alts : [])
    .filter((n) => typeof n === 'string' && n && n !== rec.key && !st.isMine(db, gid, n) && !st.mayBeMine(db, gid, n)))].slice(0, 20);
  if (!unknown.length) return;
  const summary = `Character ${rec.key} lists ${namesText(unknown)} as your character${unknown.length > 1 ? 's' : ''}`;
  const r = db.prepare('INSERT OR IGNORE INTO share_author_checks (guild_id, rec_id, v, prev, via, summary, names) VALUES (?,?,?,?,?,?,?)')
    .run(gid, rec.id, rec.v, null, via.by, summary, JSON.stringify(unknown));
  if (r.changes) run.result.checks++;
}

// Did this computer make this version (sent from here, still to send, or said to be mine)?
function ourVersion(db, gid, rec) {
  if (st.wasSent(db, gid, rec.id, rec.v)) return true;
  return Boolean(db.prepare(`SELECT 1 FROM share_outbox WHERE guild_id = ? AND rec_id = ? AND (sent_v = ? OR state IN ('queued','waiting')) LIMIT 1`)
    .get(gid, rec.id, rec.v));
}

// "3 changes of a kind this version doesn't know" (one record: the usual summary).
const unknownSummary = (rec, n) => (n > 1 ? `${n} changes of a kind this version doesn't know` : text.summaryOf(rec));

// "<id> <v>" of every record in a closed group of records of a type this version doesn't know (read once per import).
function closedUnknown(db, gid, run) {
  if (run.closedUnknown) return run.closedUnknown;
  const out = new Set();
  for (const c of db.prepare("SELECT recs FROM share_author_checks WHERE guild_id = ? AND kind = 'unknown' AND state = 'undone'").all(gid)) {
    let recs = [];
    try { recs = JSON.parse(c.recs || '[]'); } catch { recs = []; }
    for (const x of Array.isArray(recs) ? recs : []) if (Array.isArray(x)) out.add(`${x[0]} ${x[1]}`);
  }
  run.closedUnknown = out;
  return out;
}

// Records of a type this version doesn't know, in my name: anyone may pass one on, and a forger can send a lot, of
// as many made-up types as they like. One open check per sender holds them all, whatever their type ([[id, v], ...]
// in recs, the count in n).
function unknownCheck(db, gid, rec, via, run) {
  const by = via.by || '';
  // Already answered with "Close it" (a closed group outlives a fresh start, services/reset.js): not asked again.
  if (closedUnknown(db, gid, run).has(`${rec.id} ${rec.v}`)) return;
  const open = db.prepare(`SELECT * FROM share_author_checks WHERE guild_id = ? AND state = 'open' AND kind = 'unknown'
      AND COALESCE(via, '') = ? ORDER BY id LIMIT 1`).get(gid, by);
  if (open) {
    let recs = [];
    try { recs = JSON.parse(open.recs || '[]'); } catch { recs = []; }
    if (!Array.isArray(recs)) recs = [];
    if (recs.some((x) => Array.isArray(x) && x[0] === rec.id && x[1] === rec.v)) return;
    recs = recs.filter((x) => Array.isArray(x) && x[0] !== rec.id);
    recs.push([rec.id, rec.v]);
    recs = recs.slice(-S.K.UNKNOWN_MAX_RECORDS);
    db.prepare('UPDATE share_author_checks SET recs = ?, n = ?, summary = ? WHERE id = ?')
      .run(JSON.stringify(recs), recs.length, unknownSummary(rec, recs.length), open.id);
    return;
  }
  const r = db.prepare(`INSERT OR IGNORE INTO share_author_checks (guild_id, rec_id, v, prev, via, summary, kind, n, recs)
      VALUES (?,?,?,NULL,?,?, 'unknown', 1, ?)`).run(gid, rec.id, rec.v, via.by, unknownSummary(rec, 1), JSON.stringify([[rec.id, rec.v]]));
  if (r.changes) run.result.checks++;
}

// Everything that follows a record being accepted ('ok').
function accepted(db, ctx, gid, rec, str, via, prev, run) {
  const { prevEff, prevOk, existing } = prev;
  const mine = st.isMine(db, gid, rec.author);

  // A newer version from someone else beats my pending change: it is dropped, with the reason.
  if (!mine) {
    for (const o of st.activeEntries(db, gid, rec.id)) {
      if (o.record && S.compareRecords(str, o.record) > 0) {
        // A close or cancel (final version) says so; any other newer change is the plain "changed" line.
        const note = S.isFinalV(rec.v) ? text.refusedNote('final') : text.LINES.stale;
        db.prepare("UPDATE share_outbox SET state = 'refused', note = ?, sent_at = ? WHERE op = ?")
          .run(note, st.iso(st.localNow()).replace('T', ' ').slice(0, 19), o.op);
        run.result.refused++;
      }
    }
  }

  const tasks = project.tasksFor(rec, prevEff && prevEff.rec);
  if (rec.type === 'ch') project.run(db, gid, tasks); // links first: later records are checked against them
  else for (const t of tasks) run.tasks.add(t);
  if (rec.type === 'ch') run.ranks = true;

  // §5 author check: a change in my name that this computer never made. (The addon stores what it sent itself
  // with via = me,<time>,d, so via can't tell; this computer's outbox and its log of sent versions can.) Only
  // records newer than when this computer started sharing in the guild: older ones are another install's. A
  // fresh start keeps that time and the log, so a forged record from before it is still asked about when it
  // comes back, and my own records coming back are not.
  if (mine && !ADDON_BUILT.has(rec.type) && via.raw && rec.t > st.sinceOf(db, gid) && !ourVersion(db, gid, rec)) {
    if (!S.TYPES[rec.type]) unknownCheck(db, gid, rec, via, run);
    else {
      const before = existing ? (existing.state === 'ok' ? existing.body : existing.kept) : null;
      const prevMine = before && st.isMine(db, gid, (S.parse(before) || {}).author) ? before : null;
      const r = db.prepare('INSERT OR IGNORE INTO share_author_checks (guild_id, rec_id, v, prev, via, summary) VALUES (?,?,?,?,?,?)')
        .run(gid, rec.id, rec.v, prevMine, via.by, text.summaryOf(rec, run.lookup));
      if (r.changes) run.result.checks++;
    }
  }
  chAltsCheck(db, gid, rec, via, run);

  // Officer records add an audit line: "Grommash cancelled Molten Core (passed on by Thrallia)."
  if (S.spaceOf(rec.type) === 'officer' && !mine && S.TYPES[rec.type]) {
    audit(db, gid, rec.author, `${text.auditSentence(rec, run.lookup)}${passedOn(rec, via)}.`);
  }

  // A webhook shared by an officer (officers' apps only; the rule above ignores it elsewhere).
  if (rec.type === 'WH' && !rec.del && !mine && rec.fields.url) {
    const cur = st.getJson(db, 'shared_webhook');
    if (!cur || cur.v !== rec.v) {
      const using = ctx && ctx.cfg ? ctx.cfg.discordWebhook : '';
      st.setJson(db, 'shared_webhook', { url: rec.fields.url, from: rec.author, at: rec.t, v: rec.v, handled: using === rec.fields.url });
    }
  }

  // A call to arms I sent in game with /wow cta: the upload's reply counts it and the sync route posts it
  // to Discord, as before (the app's own ones post when their "ok" arrives). After a fresh start the store
  // brings back calls from before it as new records: those were posted then (services/reset.js).
  const fromMe = via.how === 'o' || (via.by && st.isMine(db, gid, via.by));
  if (rec.type === 'ca' && mine && fromMe && !prevOk && !rec.del && rec.t >= run.now - 3600 && rec.t > run.resetAt) {
    const queued = db.prepare('SELECT 1 FROM share_outbox WHERE guild_id = ? AND rec_id = ?').get(gid, rec.id);
    if (!queued) run.gameCtas.push(rec.key);
  }

  notify(db, ctx, gid, rec, prevOk, run);
}

function importOne(db, ctx, gid, str, via, run) {
  const p = S.parse(str);
  if (!p) return;
  const existing = st.storedRow(db, gid, p.id);
  if (existing && S.compareRecords(existing.body, str) >= 0) return;
  if (S.checkRecord(str, run.now, run.lookupStr)) return; // the addon checked it; expired or broken: skip
  const rec = S.decode(str);
  if (!rec) return;
  // This computer dropped that version, or the parent this record expires with, once every addon had expired it.
  if (prune.expiredHere(db, gid, rec)) return;
  const prevEff = st.effective(db, gid, rec.id);
  const shown = existing ? (existing.state === 'ok' ? existing.body : existing.kept) : null;
  const prevOk = shown ? S.decode(shown) : null;
  const driveKey = rec.type === 'dc' ? (rec.fields && rec.fields.drive) || (prevOk && prevOk.fields && prevOk.fields.drive) : null;
  const driveBefore = driveKey ? project.driveStateOf(db, gid, driveKey) : null;

  const reason = importRule(db, gid, rec, via.how, prevOk);
  upsertRecord(db, gid, rec, str, via, reason, existing);
  if (reason) {
    run.result.ignored++;
    if (!existing || existing.reason !== reason) {
      audit(db, gid, rec.author, `Ignored ${text.summaryOf(rec, run.lookup)} from ${rec.author}: ${text.reasonText(reason)}${passedOn(rec, via)}.`, 'ignored from the guild');
    }
    return;
  }
  // A newer version of a dropped record, used: it lives again. (An ignored one leaves the rows as history.)
  if (!existing) db.prepare('DELETE FROM share_pruned WHERE guild_id = ? AND id = ?').run(gid, rec.id);
  run.result.imported++;
  accepted(db, ctx, gid, rec, str, via, { prevEff, prevOk, existing }, run);

  // A guildmate's hand-in that reached a drive's goal.
  if (driveKey && driveBefore && ctx && !st.isMine(db, gid, rec.author) && rec.t >= run.now - DAY && rec.t > run.resetAt) {
    const after = project.driveStateOf(db, gid, driveKey);
    const dr = st.live(db, gid, `DR:${driveKey}`);
    if (after && dr && after.reached && !driveBefore.reached && !after.closed) {
      emitLater(run, () => ctx.emit(gid, 'drive', {
        title: `🎉 ${dr.rec.fields.title} reached its goal`, body: `${text.num(dr.rec.fields.goal)} ${dr.rec.fields.unit}. Thanks everyone!`, route: '/drives',
      }));
    }
  }
}

// Ignored records whose reason a later record fixed (a link, the raid, the loot list ...).
function retryIgnored(db, ctx, gid, run) {
  for (let round = 0; round < 3; round++) {
    let changed = 0;
    const rows = db.prepare(`SELECT * FROM shared_records WHERE guild_id = ? AND state = 'ignored' AND reason IN (${RETRY.map(() => '?').join(',')})`)
      .all(gid, ...RETRY);
    for (const row of rows) {
      const rec = S.decode(row.body);
      if (!rec) continue;
      const prevOk = row.kept ? S.decode(row.kept) : null;
      const reason = importRule(db, gid, rec, row.how || 'm', prevOk);
      if (reason) {
        if (reason !== row.reason) db.prepare('UPDATE shared_records SET reason = ? WHERE guild_id = ? AND id = ?').run(reason, gid, row.id);
        continue;
      }
      const prevEff = st.effective(db, gid, row.id);
      db.prepare("UPDATE shared_records SET state = 'ok', reason = NULL, kept = NULL WHERE guild_id = ? AND id = ?").run(gid, row.id);
      changed++;
      run.result.imported++;
      const via = row.via ? parseVia(row.via) : { by: null, at: null, how: row.how || 'o', raw: null };
      accepted(db, ctx, gid, rec, row.body, via, { prevEff, prevOk, existing: { ...row, state: 'ignored' } }, run);
    }
    if (!changed) break;
  }
}

// Ignored records that a character I just confirmed as mine now links ("It was me"): used at once, not only at
// the next upload. → the counts, as importShared gives them.
function retryNow(db, ctx, gid) {
  const result = { imported: 0, ignored: 0, acked: 0, refused: 0, checks: 0, checkpoints: 0, posts: [], ctas: [] };
  const run = {
    now: st.serverNow(db), tasks: new Set(), after: [], gameCtas: [], result, ranks: false,
    lookupStr: st.lookupFor(db, gid), resetAt: st.resetOf(db, gid),
    lookup: (id) => { const e = st.effective(db, gid, id); return e ? e.rec : null; },
  };
  retryIgnored(db, ctx, gid, run);
  const out = project.run(db, gid, run.tasks);
  if (out.ranks || run.ranks) identity.syncRanks(db, gid);
  for (const fn of run.after) {
    try { fn(); } catch (e) { if (ctx && ctx.log) ctx.log.warn('A sharing notification failed:', e.message); }
  }
  return result;
}

// §4.4 LY writer: an officer's app checkpoints SR+ when the newest LY is over 14 days old.
function writeCheckpoints(db, ctx, gid, now) {
  if (!amOfficer(db) || !st.myAuthor(db, gid)) return 0;
  const iks = new Set();
  for (const prefix of ['RT:', 'LA:']) {
    for (const [, e] of st.effectiveMany(db, gid, prefix)) {
      if (!e.rec.del && e.rec.fields && S.isFoldable(e.rec) && e.rec.fields.instance) iks.add(e.rec.fields.instance);
    }
  }
  let n = 0;
  for (const ik of iks) {
    if (!S.keyOk('LY', ik) || st.activeEntries(db, gid, `LY:${ik}`).length) continue;
    const recs = project.foldRecords(db, gid, ik);
    if (!S.needsCheckpoint(ik, recs, now)) continue;
    queue(db, ctx, { type: 'LY', key: ik, fields: S.loyaltyCheckpoint(ik, recs, now), need: 'o' });
    n++;
  }
  return n;
}

// Each account's store size, for the seed rule (§9).
function noteStore(db, gid, file, count) {
  const key = file && typeof file === 'object' ? [file.install, file.account].filter(Boolean).join('|') : typeof file === 'string' ? file : '';
  const stores = st.getJson(db, `share_stores:${gid}`, {}) || {};
  stores[key || 'default'] = { count, at: st.serverNow(db) };
  // Forget stores not seen for 60 days.
  for (const [k, v] of Object.entries(stores)) if (!v || v.at < st.serverNow(db) - 60 * DAY) delete stores[k];
  st.setJson(db, `share_stores:${gid}`, stores);
}

// §3 my player id in this guild, when the app has none yet. Only a pid made on one of my characters can be mine
// (store.pidCouldBeMine): a guildmate can relay a ch of my character naming any pid, and one made on their own
// character would make me part of their player. First a pid another computer of mine already uses (live in a ch
// of one of my characters, so two PCs of one player end up with one id), then the one the addon made for this
// guild (shared.guilds[g].pid; shared.pid from before ids were per guild); else ensurePid makes one at the end.
// When the addon has its own id, another computer's id must be made on a character this computer doesn't play
// (one of my Battle.net characters): the addon stamps the ch of every character it plays with its own id, so a
// relayed ch of such a character naming another id that is also made on it may be a guildmate's invention, and
// the addon already took a copy from the guild before making its own (Share.lua adoptPid).
function adoptPid(db, gid, part, p, now) {
  const ok = (pid) => typeof pid === 'string' && S.pidOk(pid) && st.pidCouldBeMine(db, gid, pid);
  const addonPid = [part && part.pid, p.pid].find(ok) || null;
  const playedHere = new Set(st.myCharacters(db, gid, { loose: true }));
  const otherOk = (pid) => ok(pid) && (!addonPid || !playedHere.has(st.anchorOf(pid)));
  const recs = part ? obj(part.recs) : {};
  const lookup = st.lookupFor(db, gid);
  // The newest ch of a character: the upload's copy or the one this computer has.
  const chOf = (name) => {
    let best = null;
    const raw = recs[`ch:${name}`];
    if (typeof raw === 'string' && !S.checkRecord(raw, now, lookup)) {
      const r = S.decode(raw);
      if (r && r.type === 'ch' && r.key === name) best = { str: raw, rec: r };
    }
    const e = st.effective(db, gid, `ch:${name}`);
    if (e && (!best || S.compareRecords(e.str, best.str) > 0)) best = e;
    return best && !best.rec.del && best.rec.fields ? best.rec : null;
  };
  // Another computer's id is one its anchor's own ch names (not just any ch of mine naming a made-up id).
  const others = new Set();
  for (const name of new Set([...st.myCharacters(db, gid), ...st.bnetNames(db, gid)])) {
    const r = chOf(name);
    const pid = r && r.fields.pid;
    if (!otherOk(pid) || pid === addonPid) continue;
    const a = chOf(st.anchorOf(pid));
    if (a && a.fields.pid === pid) others.add(pid);
  }
  const pid = [...others].sort()[0] || addonPid;
  if (pid) st.setMyPid(db, gid, pid);
}

function importShared(db, ctx, payloadShared, { file, guildId } = {}) {
  const result = { imported: 0, ignored: 0, acked: 0, refused: 0, checks: 0, checkpoints: 0, posts: [], ctas: [] };
  const p = payloadShared;
  if (!p || typeof p !== 'object' || Array.isArray(p)) return result;
  const guild = identity.currentGuild(db);
  // Records only ever go into the current guild (the one the upload picked).
  if (!guild || (guildId != null && Number(guildId) !== guild.id)) return result;
  const gid = guild.id;

  // 1. Clock skew and my player id.
  const clock = obj(p.clock);
  if (Number.isFinite(clock.server) && Number.isFinite(clock.here) && clock.server > 1e9 && clock.here > 1e9) {
    const skew = Math.trunc(clock.server - clock.here);
    if (Math.abs(skew) < 30 * DAY) st.set(db, 'server_skew', skew);
  }
  const now = st.serverNow(db);
  st.startSharing(db, gid, now);

  const lookupStr = st.lookupFor(db, gid);
  const run = {
    now, tasks: new Set(), after: [], gameCtas: [], result, ranks: false, lookupStr, resetAt: st.resetOf(db, gid),
    lookup: (id) => { const e = st.effective(db, gid, id); return e ? e.rec : null; },
  };
  const parts = obj(p.guilds);

  // The partition of the current guild.
  const saved = st.get(db, `share_g:${gid}`);
  const gkey = saved && parts[saved] ? saved : Object.keys(parts).find((k) => st.partitionMatches(k, guild)) || null;
  const part = gkey ? obj(parts[gkey]) : null;
  const recs = part ? obj(part.recs) : {};
  if (!st.myPid(db, gid)) adoptPid(db, gid, part, p, now);

  // 2. Acknowledgements (ops are unique, whatever partition they are in).
  for (const pt of Object.values(parts)) processAcks(db, gid, obj(pt).sent, run);

  noteStore(db, gid, file, Object.keys(recs).length);
  if (part) {
    if (gkey !== saved) st.set(db, `share_g:${gid}`, gkey);
    saveNames(db, gid, part.names, run.tasks);
    const s = obj(part.stats);
    const num = (v) => (Number.isFinite(v) ? v : null);
    st.setJson(db, `share_stats:${gid}`, {
      peers: num(s.peers), lastHello: num(s.lastHello), lastExchange: num(s.lastExchange), dropped: num(s.dropped), refused: num(s.refused), at: now,
    });

    // 3. Records newer than what this computer has.
    const via = obj(part.via);
    const list = [];
    for (const [id, str] of Object.entries(recs)) {
      if (typeof str !== 'string') continue;
      const pr = S.parse(str);
      if (!pr || pr.id !== id) continue;
      list.push({ id, str, type: pr.type, t: pr.t || 0 });
    }
    list.sort((a, b) => (prio(a.type) - prio(b.type)) || (a.t - b.t) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const it of list) importOne(db, ctx, gid, it.str, parseVia(via[it.id]), run);
  }
  retryIgnored(db, ctx, gid, run);

  // Rows for everything touched, once each.
  const out = project.run(db, gid, run.tasks);
  if (out.ranks || run.ranks) {
    identity.syncRanks(db, gid, {
      audit: (action, detail) => audit(db, gid, null, detail, action),
    });
  }
  for (const key of run.gameCtas) {
    const c = db.prepare('SELECT id, zone, character, message, needed FROM ctas WHERE guild_id = ? AND share_id = ?').get(gid, key);
    if (c) result.ctas.push({ ...c });
  }
  for (const fn of run.after) {
    try { fn(); } catch (e) { if (ctx && ctx.log) ctx.log.warn('A sharing notification failed:', e.message); }
  }

  // 4.4: the SR+ checkpoint, and housekeeping: records every addon has expired leave this computer's copy too
  // (their rows stay), at most once an hour.
  if (part) result.checkpoints = writeCheckpoints(db, ctx, gid, now);
  if (part) prune.maybePrune(db, gid, now);
  db.prepare(`DELETE FROM share_outbox WHERE state IN ('sent','dropped','refused') AND created_at < datetime('now', '-30 days')`).run();
  ensurePid(db, gid);
  return result;
}

module.exports = { importShared, importRule, parseVia, noteStore, writeCheckpoints, namesText, retryNow, PID_OF, RETRY, ADDON_BUILT };
