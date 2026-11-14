// Dungeon groups: a guildmate puts a group together for a dungeon (now or at a set time) with the role slots they
// need; others join with a role. First come, first in; joins past a role's free slots wait and move up when
// someone leaves. Shapes are documented in docs/api/dungeons.md.
//
// Groups and joins are guild data shared through the addon (docs/SHARING.md §4.3): a group is a dg record (the
// leader's player; called off 'x' and done 'd' are final), a join is dj:<group>:<my pid> (status 'y', or 'w' when
// I leave). The same records are made in game with /wow lfg. They are short-lived, so the routes read the records
// themselves (store.effective: the stored ones plus this computer's pending changes) instead of projected rows; the
// line-up comes from S.dungeonGroupState, so every PC shows the same group.
const S = require('../../shared/sharing');
const { HttpError, str, int, oneOf, needGuild } = require('../http');
const identity = require('../identity');
const sharing = require('../sharing');
const st = require('../share/store');

const NO_CHARACTER = 'Log in to World of Warcraft on a character in your guild first, then log out or type /reload.';
const ROLE_CODE = { tank: 't', healer: 'h', dps: 'd' };
const ROLE_NAME = { t: 'tank', h: 'healer', d: 'dps' };
const KEY_RE = /^[0-9a-z]{6}$/;
// A group stays on the board this long after its start time.
const SHOW_AFTER_START = 3 * 3600;
// How far ahead a group can be planned, and the most people in one (UBRS-sized).
const AHEAD_MAX = 14 * 86400;
// A dungeon group is 5; a PvP premade is 10 or 15 (the addon's premades page starts the same record).
const SIZE_MAX = 15;
const ROLE_MAX = 10; // per role, the most the shared record carries
const VERBS = ['join', 'leave', 'cancel', 'done', 'guest', 'unguest'];
// Players from outside the guild: a character name, optionally with its realm (Name-Realm).
// Letters only (any script), 2-24 of them, then an optional "-Realm" (letters, spaces and apostrophes removed).
const GUEST_RE = /^\p{L}{2,24}(-[\p{L}']{2,30})?$/u;
const GUESTS_MAX = 9;

function register(app, ctx) {
  const { db } = ctx;
  const here = () => identity.notElsewhere();
  const q = {
    myChars: db.prepare(`SELECT name, class, level, is_main FROM characters WHERE guild_id = ? AND user_id = ? AND ${here()}
      ORDER BY is_main DESC, level DESC, name`),
    char: db.prepare('SELECT class, level FROM characters WHERE guild_id = ? AND name = ?'),
    battletag: db.prepare('SELECT battletag FROM users WHERE id = ?'),
  };

  function myPid() {
    const pid = sharing.myPid(db);
    if (!pid) throw new HttpError(409, NO_CHARACTER);
    return pid;
  }
  const myCharacter = (gid, uid, name) => {
    const chars = q.myChars.all(gid, uid);
    if (!chars.length) throw new HttpError(409, NO_CHARACTER);
    const c = name ? chars.find((x) => x.name === name) : chars[0];
    if (!c) throw new HttpError(400, 'Pick one of your characters.');
    return c;
  };
  const tagOf = (gid, pid) => {
    const uid = st.userForPid(db, gid, pid, { create: false });
    const row = uid && q.battletag.get(uid);
    return (row && row.battletag) || st.anchorOf(pid) || pid;
  };

  // One group as the page shows it, or null when it is gone, over or long past.
  function groupJson(gid, key, now, mine) {
    const e = st.effective(db, gid, `dg:${key}`);
    if (!e || e.rec.del || !e.rec.fields) return null;
    const f = e.rec.fields;
    const joins = [...st.effectiveMany(db, gid, `dj:${key}:`).values()].map((x) => x.str);
    const g = S.dungeonGroupState(e.str, joins);
    const person = (m, waiting) => ({
      character: m.character, role: ROLE_NAME[m.role], class: m.class || (m.guest ? null : (q.char.get(gid, m.character) || {}).class) || null,
      level: m.level ?? null, battletag: m.guest ? null : tagOf(gid, m.pid), mine: !m.guest && m.pid === mine, waiting, guest: Boolean(m.guest),
    });
    const leaderChar = q.char.get(gid, f.character) || {};
    const myJoin = [...g.members, ...g.waiting].find((m) => m.pid === mine) || null;
    const isLeader = f.pid === mine;
    const live = g.state === 'open' || g.state === 'full';
    return {
      key,
      dungeon: f.dungeon || '?',
      startsAt: st.iso(f.startsAt || e.rec.t),
      note: f.note || '',
      state: g.state,
      pending: Boolean(e.pending),
      leader: {
        character: f.character || st.anchorOf(f.pid) || '?', role: ROLE_NAME[f.role] || 'dps', class: leaderChar.class || null,
        level: f.level ?? leaderChar.level ?? null, battletag: tagOf(gid, f.pid), mine: isLeader,
      },
      slots: { tank: g.slots.t, healer: g.slots.h, dps: g.slots.d },
      open: { tank: g.open.t, healer: g.open.h, dps: g.open.d },
      members: g.members.map((m) => person(m, false)),
      waiting: g.waiting.map((m) => person(m, true)),
      mine: isLeader,
      joined: myJoin ? { character: myJoin.character, role: ROLE_NAME[myJoin.role], waiting: g.waiting.includes(myJoin) } : null,
      canJoin: live && !isLeader && !myJoin,
      canLeave: live && Boolean(myJoin),
      canCancel: live && isLeader,
      canDone: live && isLeader,
      over: (f.startsAt || 0) < now,
    };
  }

  function listGroups(gid) {
    const now = sharing.serverNow(db);
    const mine = sharing.myPid(db);
    const out = [];
    for (const [id, e] of st.effectiveMany(db, gid, 'dg:')) {
      if (e.rec.del || !e.rec.fields || (e.rec.fields.startsAt || 0) < now - SHOW_AFTER_START) continue;
      const g = groupJson(gid, id.slice(3), now, mine);
      if (g && (g.state === 'open' || g.state === 'full')) out.push(g);
    }
    out.sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.key.localeCompare(b.key));
    return out;
  }

  // Slots wanted per role, the leader's included: { t, h, d } with 2..SIZE_MAX people and the leader's role in it.
  function slotsFrom(b, role) {
    const n = (v, d) => { const x = int(v, 0, ROLE_MAX); return x == null ? d : x; };
    const s = b.slots || {};
    const slots = { t: n(s.tank ?? b.tank, 1), h: n(s.healer ?? b.healer, 1), d: n(s.dps ?? b.dps, 3) };
    if (slots[role] < 1) slots[role] = 1;
    const size = slots.t + slots.h + slots.d;
    if (size < 2) throw new HttpError(400, 'A group needs room for at least one more person.');
    if (size > SIZE_MAX) throw new HttpError(400, `A group can have at most ${SIZE_MAX} people.`);
    return slots;
  }
  function startFrom(b, now) {
    if (b.startsAt == null || b.startsAt === '' || b.startsAt === 'now') return now;
    const ms = Date.parse(String(b.startsAt));
    if (!Number.isFinite(ms)) throw new HttpError(400, 'Pick when the group meets, or leave it empty for now.');
    const t = Math.floor(ms / 1000);
    if (t < now - 600) throw new HttpError(400, 'That time has already passed.');
    if (t > now + AHEAD_MAX) throw new HttpError(400, 'Plan at most two weeks ahead.');
    return Math.max(t, now);
  }
  const keyParam = (req) => {
    const k = String(req.params.key || '');
    if (!KEY_RE.test(k)) throw new HttpError(404, 'That group no longer exists.');
    return k;
  };

  app.get('/api/dungeons', needGuild, (req, res) => {
    res.json({ groups: listGroups(req.guild.id), myCharacters: q.myChars.all(req.guild.id, req.user.id) });
  });

  // A new group (dg). The leader is in it with their own role.
  app.post('/api/dungeons', needGuild, (req, res) => {
    const b = req.body || {};
    const gid = req.guild.id;
    const dungeon = str(b.dungeon, 60);
    if (!dungeon) throw new HttpError(400, 'Name the dungeon.');
    const role = ROLE_CODE[oneOf(b.role, Object.keys(ROLE_CODE))];
    if (!role) throw new HttpError(400, 'Pick your role: tank, healer or dps.');
    const c = myCharacter(gid, req.user.id, str(b.character, 48));
    const now = sharing.serverNow(db);
    const slots = slotsFrom(b, role);
    const key = sharing.newKey();
    sharing.queue(db, ctx, {
      type: 'dg', key,
      fields: {
        pid: myPid(), character: c.name, dungeon, startsAt: startFrom(b, now), role, level: c.level ?? null,
        tank: slots.t, heal: slots.h, dps: slots.d, note: str(b.note, 140) || '', state: 'o', guests: [],
      },
    });
    ctx.activity(gid, 'dungeon', `${c.name} is putting a group together for ${dungeon}`);
    res.status(201).json({ group: groupJson(gid, key, now, myPid()), message: 'Group posted. Guildmates see it in game and in Guild Camp.' });
  });

  // The leader changes the time, slots or note of an open group.
  app.post('/api/dungeons/:key', needGuild, (req, res) => {
    const key = keyParam(req);
    const gid = req.guild.id;
    const b = req.body || {};
    const dg = sharing.recordOf(db, gid, `dg:${key}`);
    if (!dg || dg.del || !dg.fields) throw new HttpError(404, 'That group no longer exists.');
    if (dg.fields.pid !== myPid()) throw new HttpError(403, 'Only the leader can change the group.');
    if (dg.fields.state !== 'o') throw new HttpError(409, 'That group is over.');
    const now = sharing.serverNow(db);
    const role = dg.fields.role;
    const slots = slotsFrom({ ...{ tank: dg.fields.tank, healer: dg.fields.heal, dps: dg.fields.dps }, ...b }, role);
    const fields = {
      ...dg.fields,
      dungeon: b.dungeon === undefined ? dg.fields.dungeon : (str(b.dungeon, 60) || dg.fields.dungeon),
      startsAt: b.startsAt === undefined ? dg.fields.startsAt : startFrom(b, now),
      note: b.note === undefined ? dg.fields.note : (str(b.note, 140) || ''),
      tank: slots.t, heal: slots.h, dps: slots.d,
    };
    sharing.queue(db, ctx, { type: 'dg', key, fields });
    res.json({ ok: true, group: groupJson(gid, key, now, myPid()), message: 'Group updated.' });
  });

  // join / leave → my join (dj:<group>:<my pid>); cancel / done as the leader → the group (dg), final.
  app.post('/api/dungeons/:key/:verb', needGuild, (req, res) => {
    const verb = req.params.verb;
    if (!VERBS.includes(verb)) throw new HttpError(404, 'Not found.');
    const key = keyParam(req);
    const gid = req.guild.id;
    const now = sharing.serverNow(db);
    const pid = myPid();
    const g = groupJson(gid, key, now, pid);
    if (!g) throw new HttpError(404, 'That group no longer exists.');
    const dg = sharing.recordOf(db, gid, `dg:${key}`);
    let message;
    if (verb === 'join') {
      if (g.mine) throw new HttpError(409, 'You lead this group.');
      if (!g.canJoin) throw new HttpError(409, g.joined ? 'You are already in this group.' : 'That group is over.');
      const b = req.body || {};
      const role = ROLE_CODE[oneOf(b.role, Object.keys(ROLE_CODE))];
      if (!role) throw new HttpError(400, 'Pick your role: tank, healer or dps.');
      const c = myCharacter(gid, req.user.id, str(b.character, 48));
      sharing.queue(db, ctx, {
        type: 'dj', key: `${key}:${pid}`,
        fields: { character: c.name, role, status: 'y', class: c.class || '', level: c.level ?? null, joinedAt: now },
      });
      const after = groupJson(gid, key, now, pid);
      message = after && after.joined && after.joined.waiting
        ? `The ${ROLE_NAME[role]} spots are taken. You're on the waiting list.`
        : `You're in. ${g.leader.character} invites you in game.`;
      ctx.activity(gid, 'dungeon', `${c.name} joined the ${g.dungeon} group`);
    } else if (verb === 'leave') {
      if (!g.canLeave) throw new HttpError(409, 'You are not in this group.');
      const mine = sharing.recordOf(db, gid, `dj:${key}:${pid}`);
      sharing.queue(db, ctx, { type: 'dj', key: `${key}:${pid}`, fields: { ...mine.fields, status: 'w' } });
      message = 'You left the group.';
    } else if (verb === 'guest' || verb === 'unguest') {
      // The leader adds or removes a player from outside the guild (Name or Name-Realm).
      if (!g.mine) throw new HttpError(403, 'Only the leader can add or remove players.');
      if (!g.canCancel) throw new HttpError(409, 'That group is over.');
      const b = req.body || {};
      const name = str(b.name, 48);
      if (!name || !GUEST_RE.test(name)) throw new HttpError(400, 'Type the player\'s character name, like Brokk or Brokk-Mirage.');
      const same = (x) => x && String(x.name).toLowerCase() === name.toLowerCase();
      const guests = (dg.fields.guests || []).filter((x) => x && x.name);
      if (verb === 'guest') {
        const role = ROLE_CODE[oneOf(b.role, Object.keys(ROLE_CODE))];
        if (!role) throw new HttpError(400, 'Pick their role: tank, healer or dps.');
        if (guests.some(same) || g.members.some((m) => same({ name: m.character })) || same({ name: g.leader.character })) {
          throw new HttpError(409, `${name} is already in the group.`);
        }
        if (guests.length >= GUESTS_MAX) throw new HttpError(409, `A group can list at most ${GUESTS_MAX} players from outside the guild.`);
        guests.push({ name, role, class: str(b.class, 20) || '', level: int(b.level, 1, 100) });
        message = `${name} added to the group.`;
      } else {
        if (!guests.some(same)) throw new HttpError(404, `${name} isn't in the group.`);
        guests.splice(guests.findIndex(same), 1);
        message = `${name} removed from the group.`;
      }
      sharing.queue(db, ctx, { type: 'dg', key, fields: { ...dg.fields, guests } });
    } else {
      if (!g.mine) throw new HttpError(403, 'Only the leader can do that.');
      if (!g.canCancel) throw new HttpError(409, 'That group is over.');
      sharing.queue(db, ctx, { type: 'dg', key, fields: { ...dg.fields, state: verb === 'cancel' ? 'x' : 'd' } });
      message = verb === 'cancel' ? 'Group called off.' : 'Marked as done. Good run!';
    }
    res.json({ ok: true, group: groupJson(gid, key, now, pid), message });
  });
}

module.exports = { register };
