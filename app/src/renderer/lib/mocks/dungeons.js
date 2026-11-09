// Preview sample data for the Dungeons page (used only when the renderer runs in a plain browser without window.gc).
// Shapes match docs/api/dungeons.md (the local core's routes/dungeons.js). A small in-memory world so starting,
// joining, leaving and calling off groups work in the preview. The line-up follows the core's rule: the leader
// fills a slot of their role, then first come, first in; the rest wait.
import { addMockRoutes, httpError, needGuild } from '../mock.js';
import { CHARS } from './community.js';

const MIN = 60 * 1000;
const iso = (msFromNow) => new Date(Date.now() + msFromNow).toISOString();
const USERS = { 1: 'Calvin#1234', 2: 'Velanne#2210', 3: 'Mokra#9031', 4: 'Tazrik#4410', 5: 'Ilyra#7777' };
const char = (name) => CHARS.find((c) => c.name === name) || { name, class: null, level: null, user_id: null };
const person = (name, role, at) => {
  const c = char(name);
  return { character: name, role, class: c.class, level: c.level, uid: c.user_id, at };
};

let nextKey = 100;
const world = {
  groups: [
    { key: 'bd7k2m', dungeon: 'Blackrock Depths', startsAt: iso(40 * MIN), note: 'Emperor run, need a tank who knows the pulls',
      state: 'o', leader: person('Velanne', 'healer', 0), slots: { tank: 1, healer: 1, dps: 3 },
      joins: [person('Hrogar', 'dps', 1), person('Brannoc', 'dps', 2)] },
    { key: 'wc9x1a', dungeon: 'Wailing Caverns', startsAt: iso(-5 * MIN), note: 'Quest run',
      state: 'o', leader: person('Ilyra', 'dps', 0), slots: { tank: 1, healer: 1, dps: 3 }, joins: [],
      guests: [{ character: 'Brokk-Mirage', role: 'dps', class: 'WARRIOR', level: 19 }] },
  ],
};

const myChars = (uid) => CHARS.filter((c) => c.user_id === uid).sort((a, b) => b.is_main - a.is_main || b.level - a.level)
  .map(({ name, class: cls, level, is_main }) => ({ name, class: cls, level, is_main }));

function groupJson(g, uid) {
  const open = { ...g.slots };
  if (open[g.leader.role] > 0) open[g.leader.role]--;
  const members = [];
  const waiting = [];
  const seat = (j) => { if (open[j.role] > 0) { open[j.role]--; members.push(j); } else waiting.push(j); };
  for (const gu of g.guests || []) seat({ ...gu, guest: true, uid: null });
  for (const j of [...g.joins].sort((a, b) => a.at - b.at)) seat(j);
  const view = (p, w) => ({ character: p.character, role: p.role, class: p.class || null, level: p.level ?? null,
    battletag: p.guest ? null : USERS[p.uid] || p.character, mine: !p.guest && p.uid === uid, waiting: w, guest: Boolean(p.guest) });
  const mine = g.leader.uid === uid;
  const myJoin = g.joins.find((j) => j.uid === uid) || null;
  const state = g.state === 'x' ? 'cancelled' : g.state === 'd' ? 'done' : open.tank + open.healer + open.dps === 0 ? 'full' : 'open';
  const live = state === 'open' || state === 'full';
  return {
    key: g.key, dungeon: g.dungeon, startsAt: g.startsAt, note: g.note, state, pending: Boolean(g.pending),
    leader: view(g.leader, false), slots: g.slots, open,
    members: members.map((m) => view(m, false)), waiting: waiting.map((m) => view(m, true)), mine,
    joined: myJoin ? { character: myJoin.character, role: myJoin.role, waiting: waiting.includes(myJoin) } : null,
    canJoin: live && !mine && !myJoin, canLeave: live && Boolean(myJoin), canCancel: live && mine, canDone: live && mine,
    over: Date.parse(g.startsAt) < Date.now(),
  };
}

const find = (key) => {
  const g = world.groups.find((x) => x.key === key);
  if (!g) throw httpError(404, 'That group no longer exists.');
  return g;
};

addMockRoutes({
  'GET /api/dungeons': ({ state }) => {
    needGuild(state);
    return {
      groups: world.groups.filter((g) => g.state === 'o').map((g) => groupJson(g, state.userId)),
      myCharacters: myChars(state.userId),
    };
  },
  'POST /api/dungeons': ({ state, body }) => {
    needGuild(state);
    const dungeon = String(body?.dungeon || '').trim().slice(0, 60);
    if (!dungeon) throw httpError(400, 'Name the dungeon.');
    const role = ['tank', 'healer', 'dps'].includes(body?.role) ? body.role : null;
    if (!role) throw httpError(400, 'Pick your role: tank, healer or dps.');
    const mine = myChars(state.userId);
    const c = mine.find((x) => x.name === body?.character) || mine[0];
    if (!c) throw httpError(409, 'Log in to World of Warcraft on a character in your guild first, then log out or type /reload.');
    const s = body?.slots || {};
    const slots = { tank: Number(s.tank ?? 1), healer: Number(s.healer ?? 1), dps: Number(s.dps ?? 3) };
    if (slots[role] < 1) slots[role] = 1;
    const g = {
      key: `m${(nextKey++).toString(36).padStart(5, '0')}`, dungeon, startsAt: body?.startsAt || iso(0), note: String(body?.note || '').slice(0, 140),
      state: 'o', leader: person(c.name, role, 0), slots, joins: [], pending: true,
    };
    world.groups.push(g);
    return { group: groupJson(g, state.userId), message: 'Group posted. Guildmates see it in game and in Guild Camp.' };
  },
  'POST /api/dungeons/:key/:verb': ({ state, params, body }) => {
    needGuild(state);
    const g = find(params.key);
    const uid = state.userId;
    const view = groupJson(g, uid);
    let message;
    if (params.verb === 'join') {
      if (!view.canJoin) throw httpError(409, 'You are already in this group.');
      const mine = myChars(uid);
      const c = mine.find((x) => x.name === body?.character) || mine[0];
      g.joins.push(person(c.name, body?.role || 'dps', Date.now()));
      const after = groupJson(g, uid);
      message = after.joined.waiting ? `The ${body?.role} spots are taken. You're on the waiting list.` : `You're in. ${g.leader.character} invites you in game.`;
    } else if (params.verb === 'leave') {
      g.joins = g.joins.filter((j) => j.uid !== uid);
      message = 'You left the group.';
    } else if (params.verb === 'guest' || params.verb === 'unguest') {
      if (!view.mine) throw httpError(403, 'Only the leader can add or remove players.');
      const name = String(body?.name || '').trim();
      if (!/^\p{L}{2,24}(-[\p{L}']{2,30})?$/u.test(name)) throw httpError(400, "Type the player's character name, like Brokk or Brokk-Mirage.");
      g.guests = g.guests || [];
      const i = g.guests.findIndex((x) => x.character.toLowerCase() === name.toLowerCase());
      if (params.verb === 'guest') {
        if (i >= 0) throw httpError(409, `${name} is already in the group.`);
        g.guests.push({ character: name, role: body?.role || 'dps' });
        message = `${name} added to the group.`;
      } else {
        if (i < 0) throw httpError(404, `${name} isn't in the group.`);
        g.guests.splice(i, 1);
        message = `${name} removed from the group.`;
      }
    } else if (params.verb === 'cancel' || params.verb === 'done') {
      if (!view.mine) throw httpError(403, 'Only the leader can do that.');
      g.state = params.verb === 'cancel' ? 'x' : 'd';
      message = params.verb === 'cancel' ? 'Group called off.' : 'Marked as done. Good run!';
    } else throw httpError(404, 'Not found.');
    return { ok: true, group: groupJson(g, uid), message };
  },
});
