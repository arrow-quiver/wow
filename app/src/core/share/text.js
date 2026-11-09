'use strict';
// Plain-English text for shared records: one-line summaries (outbox, author checks), the notes shown for
// waiting and refused changes, audit lines and Discord posts. No database access: callers pass a
// lookup(id) → decoded record (or record string) | null for context such as a raid's title.
const S = require('../../shared/sharing');

const KIND_ICON = { r: '🗓️', p: '⚔️', e: '🎉' };
const KIND_NAME = { r: 'Raid', p: 'PvP', e: 'Event' };
const ROLE = { t: 'tank', h: 'healer', d: 'damage' };
const SIGNUP = { y: 'coming', t: 'maybe', n: 'not coming', b: 'bench' };
const RAID_STATUS = { o: 'reopened', l: 'locked', x: 'cancelled', d: 'closed' };
const AWARD = { s: 'SR', m: 'MS', o: 'OS', f: 'FREE' };

// The UI lines (docs/SHARING.md §2).
const LINES = Object.freeze({
  saved: 'Saved. It goes to your guild the next time you log in or type /reload.',
  newData: 'New guild data shows here after you log out or type /reload in game.',
  instance: 'Waiting until you leave the dungeon.',
  officer: 'Log in on an officer character to send this.',
  stale: 'Someone changed this in the meantime. Check it and try again.',
});

const asRec = (r) => (typeof r === 'string' ? S.decode(r) : r && typeof r === 'object' ? r : null);
const clip = (s, n) => {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const num = (n) => (typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString('en') : '0');
const unixTag = (t, f) => `<t:${Math.floor(Number(t) || 0)}:${f}>`;

function raidTitle(key, lookup) {
  const rd = typeof lookup === 'function' ? asRec(lookup(`RD:${key}`)) : null;
  return rd && rd.fields && rd.fields.title ? rd.fields.title : 'a raid';
}

// "Molten Core Thursday: locked". lookup is optional.
function summaryOf(recIn, lookup) {
  const r = asRec(recIn);
  if (!r) return 'A guild change';
  const f = r.fields || {};
  const del = r.del;
  const removed = (s) => (del ? `${s}: removed` : s);
  const segs = String(r.key || '').split(':');
  switch (r.type) {
    case 'ch': return `Character ${r.key}`;
    case 'rc': return `${segs[0]}'s ${S.SKILLS[S.fromB36(segs[1] || '')] || 'profession'} recipes`;
    case 'su': {
      const t = raidTitle(segs[0], lookup);
      if (del) return `Sign-up for ${t}: removed`;
      return `Sign-up for ${t}: ${SIGNUP[f.status] || 'coming'}${f.role ? ` as ${ROLE[f.role]}` : ''}`;
    }
    case 'cr': {
      if (del) return 'Crafting request: removed';
      const st = f.state === 'x' ? ' (cancelled)' : f.state === 'd' ? ' (done)' : '';
      return `Crafting request: ${clip(f.item, 60) || 'an item'}${st}`;
    }
    case 'cl': {
      const cr = typeof lookup === 'function' ? asRec(lookup(`cr:${segs[0]}`)) : null;
      const item = cr && cr.fields && cr.fields.item ? cr.fields.item : 'a crafting request';
      const verb = del ? 'Claim removed' : f.state === 'd' ? 'Made' : f.state === 'w' ? 'Claim withdrawn' : 'Claimed';
      return `${verb}: ${clip(item, 60)}`;
    }
    case 'lp': return del ? `Leveling partner post for ${segs[1] || 'a character'}: closed` : `Leveling partner post for ${f.character || segs[1]}`;
    case 'ca': return removed(`Call to arms: ${clip(f.zone, 40) || 'somewhere'}`);
    case 'dc': {
      const dr = typeof lookup === 'function' && f.drive ? asRec(lookup(`DR:${f.drive}`)) : null;
      const unit = dr && dr.fields ? ` ${dr.fields.unit}` : '';
      return removed(`Hand-in: ${num(f.amount)}${unit}${dr && dr.fields ? ` for ${clip(dr.fields.title, 40)}` : ''}`);
    }
    case 'bq': {
      if (del) return 'Bank request: removed';
      return `Bank request: ${num(f.count || 1)} × ${clip(f.item, 60)}${f.state === 'x' ? ' (cancelled)' : ''}`;
    }
    case 'gb': return r.key === '0' ? 'Guild bank money and log' : `Guild bank tab ${r.key}`;
    case 'bk': return `Bank character stock of ${r.key}`;
    case 'sh': return removed('Shopping list');
    case 'pr': return 'Auction prices';
    case 'wm': return removed('War map: deaths and kills in the open world');
    case 'RD': return removed(`${f.title || 'Raid'}: scheduled`);
    case 'RT': return `${raidTitle(r.key, lookup)}: ${del ? 'status removed' : f.status === 'o' ? 'open' : (RAID_STATUS[f.status] || 'open')}`;
    case 'LA': return removed(`${clip(f.itemName, 60) || 'Loot'} to ${f.character || 'someone'}`);
    case 'LL': return removed(`Loot list for ${clip(f.name, 50) || 'an instance'}`);
    case 'LY': return 'SR+ checkpoint';
    case 'AN': return del ? 'Notice: removed' : `Notice: ${clip(f.body, 50)}`;
    case 'DR': return removed(`Supply drive: ${clip(f.title, 50)}${f.state === 'c' ? ' (closed)' : ''}`);
    case 'BH': {
      const bq = typeof lookup === 'function' ? asRec(lookup(`bq:${r.key}`)) : null;
      const item = bq && bq.fields ? `${num(bq.fields.count || 1)} × ${clip(bq.fields.item, 50)}` : 'a bank request';
      return `Bank request ${f.state === 's' ? 'sent' : 'declined'}: ${item}`;
    }
    case 'BC': return 'Bank characters';
    case 'CFG': return `Guild settings: officers up to rank ${f.officerRankMax == null ? 1 : f.officerRankMax}`;
    case 'WH': return 'Discord webhook';
    default: return 'A guild change';
  }
}

// What an officer-space record did, for the audit log: "Grommash cancelled Molten Core".
function auditSentence(recIn, lookup) {
  const r = asRec(recIn);
  if (!r) return null;
  const a = r.author;
  const f = r.fields || {};
  switch (r.type) {
    case 'RD': return r.del ? `${a} removed a raid` : `${a} scheduled ${f.title || 'a raid'}`;
    case 'RT': return `${a} ${r.del ? 'reset the status of' : f.status === 'o' ? 'reopened' : RAID_STATUS[f.status] || 'changed'} ${raidTitle(r.key, lookup)}`;
    case 'LA': return r.del ? `${a} took back a loot award` : `${a} gave ${f.itemName || 'loot'} to ${f.character || 'someone'}`;
    case 'LL': return `${a} ${r.del ? 'removed' : 'edited'} the loot list${f.name ? ` for ${f.name}` : ''}`;
    case 'LY': return `${a}'s app saved an SR+ checkpoint`;
    case 'AN': return r.del ? `${a} deleted a notice` : `${a} posted a notice`;
    case 'DR': return r.del ? `${a} removed a supply drive` : f.state === 'c' ? `${a} closed the drive ${f.title}` : `${a} started the drive ${f.title}`;
    case 'BH': {
      const bq = typeof lookup === 'function' ? asRec(lookup(`bq:${r.key}`)) : null;
      const what = bq && bq.fields ? `the bank request for ${num(bq.fields.count || 1)} × ${bq.fields.item}` : 'a bank request';
      return `${a} marked ${what} as ${f.state === 's' ? 'sent' : 'declined'}`;
    }
    case 'BC': return `${a} changed the bank characters`;
    case 'CFG': return `${a} changed who counts as an officer`;
    case 'WH': return `${a} shared a Discord webhook`;
    default: return `${a} changed ${summaryOf(r, lookup)}`;
  }
}

const REASONS = {
  link: 'that character is not linked to that player yet',
  raid: 'the raid is not known yet',
  'loot list': 'an item is not on the loot list',
  limit: 'more reserves than the raid allows',
  'own request': 'nobody can claim their own crafting request',
  bank: 'that character is not a bank character',
  rank: 'only officers can make that change',
  'officers only': 'only officers keep a shared webhook',
  owner: 'only the person who made it can change it',
};
const reasonText = (code) => REASONS[code] || 'it broke a guild rule';

// Note for a 'wait,<reason>' acknowledgement.
function waitNote(reason, { anchor } = {}) {
  switch (reason) {
    case 'officer': return LINES.officer;
    case 'gm': return 'Log in on your Guild Master character to send this.';
    case 'link': return anchor ? `Log in on ${anchor} once so guildmates know your characters are yours.` : 'Log in on your main character once so guildmates know your characters are yours.';
    case 'instance': case 'combat': return LINES.instance;
    case 'guild': return 'Log in on a character in this guild to send this.';
    default: return 'Waiting for the game to send this.';
  }
}

// Note for a 'no,<reason>' acknowledgement.
function refusedNote(reason) {
  switch (reason) {
    case 'stale': return LINES.stale;
    case 'final': return 'Someone already closed or cancelled this. Check it and try again.';
    case 'expired': return 'This waited too long and was not sent.';
    case 'rank': return 'Only officers can make that change.';
    case 'size': case 'oversize': return 'This change is too large to send.';
    default: return 'The game did not send this change.';
  }
}

// Discord posts for my own records, sent when the game says they went out (each app posts only what its
// own player did). created: there was no record before this one (a new raid, notice, request ...).
// from 'game': written in game (a /wow cta). → message text or null.
function discordPost(recIn, { lookup, created = false, from } = {}) {
  const r = asRec(recIn);
  if (!r || r.del) return null;
  const f = r.fields || {};
  switch (r.type) {
    case 'RD':
      if (!created) return null;
      return `${KIND_ICON[f.kind] || KIND_ICON.r} **${KIND_NAME[f.kind] || 'Raid'}: ${f.title}** (${f.instance})\n${unixTag(f.startsAt, 'F')}, ${unixTag(f.startsAt, 'R')}\nSign up${f.kind === 'r' || !f.kind ? ' and reserve' : ''} in Guild Camp.`;
    case 'RT': {
      if (f.status !== 'x') return null;
      const rd = typeof lookup === 'function' ? asRec(lookup(`RD:${r.key}`)) : null;
      return `❌ **${raidTitle(r.key, lookup)}**${rd && rd.fields ? ` on ${unixTag(rd.fields.startsAt, 'F')}` : ''} is cancelled.`;
    }
    case 'LA': return created ? `💎 **${f.itemName}** → ${f.character || 'someone'} (${AWARD[f.kind] || 'MS'}, ${raidTitle(f.raid, lookup)})` : null;
    case 'AN': return created ? `📜 **Notice**\n${f.body}` : null;
    case 'ca':
      if (!created) return null;
      return [`⚔️ **Call to arms: ${f.zone}**${f.needed ? ` (need ${f.needed})` : ''}`, String(f.message || '').trim(),
        `— ${f.character || r.author}${from === 'game' ? ' (from in game)' : ''}`].filter(Boolean).join('\n');
    case 'cr': return created && f.state === 'o' ? `🔨 **Crafting request:** ${f.item}${f.notes ? ` (${f.notes})` : ''}, for ${r.author}` : null;
    case 'bq': return created && f.state === 'o' ? `🏦 **Bank request:** ${f.count || 1} × ${f.item}, for ${r.author}` : null;
    case 'DR': return created && f.state !== 'c' ? `📦 **Supply drive: ${f.title}**. Goal: ${num(f.goal)} ${f.unit}. Log what you hand in under Drives in Guild Camp.` : null;
    default: return null;
  }
}

// The Discord post when my hand-in brings a supply drive to its goal (the old server's line). dr: the DR record.
function driveGoalPost(drIn) {
  const f = (asRec(drIn) || {}).fields || {};
  return `🎉 **${f.title || 'The supply drive'}** reached its goal of ${num(f.goal)}${f.unit ? ` ${f.unit}` : ''}. Thanks everyone!`;
}

// "Thu 12 Nov, 20:00 UTC" for notifications.
function whenLabel(t) {
  const d = new Date((Number(t) || 0) * 1000);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = (n) => String(n).padStart(2, '0');
  return `${days[d.getUTCDay()]} ${d.getUTCDate()} ${months[d.getUTCMonth()]}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

module.exports = { LINES, KIND_ICON, KIND_NAME, summaryOf, auditSentence, reasonText, waitNote, refusedNote, discordPost, driveGoalPost, whenLabel, clip, unixTag, raidTitle, num };
