// Preview sample data for the Seasons page (docs/api/seasons.md). &seasons=empty: a new season with nobody yet.
import { addMockRoutes } from '../mock.js';

const MODE = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('seasons') : null;
const BADGES = [
  ['donor1', 'Benefactor', 'gold', 100], ['donor2', 'Patron', 'gold', 500], ['donor3', 'Guild Treasure', 'gold', 2000],
  ['pvp1', 'Bloodied', 'kills', 10], ['pvp2', 'Slayer', 'kills', 100], ['pvp3', 'Warbringer', 'kills', 500],
  ['craft1', 'Helping Hands', 'crafts', 10], ['craft2', 'Artisan of the Guild', 'crafts', 50],
  ['raid1', 'Raid Regular', 'raids', 5], ['raid2', 'Veteran', 'raids', 20], ['raid3', 'Raid Legend', 'raids', 50],
  ['streak1', 'Steady', 'streak', 4], ['streak2', 'Devoted', 'streak', 8], ['streak3', 'Unbreakable', 'streak', 12],
].map(([id, name, what, n]) => ({ id, name, what, n }));
const b = (...ids) => BADGES.filter((x) => ids.includes(x.id));
const CATS = [
  { id: 'donor', title: 'Quartermaster', label: 'Most given to the guild bank', unit: 'gold' },
  { id: 'pvp', title: 'Warlord', label: 'Most kills in the open world', unit: 'kills' },
  { id: 'crafter', title: 'Master Crafter', label: 'Most crafting requests filled', unit: 'crafts' },
  { id: 'raider', title: 'Stalwart', label: 'Most raids attended', unit: 'raids' },
];

addMockRoutes({
  'GET /api/seasons': ({ query }) => {
    const past = Boolean(query.month);
    const month = query.month || '2026-11';
    const players = MODE === 'empty' ? [] : [
      { userId: 2, name: 'Thrallia', class: 'SHAMAN', gold: 215, kills: 9, crafts: 1, raids: 2, base: 258, streak: 4, bonus: 0.15, score: 297, titles: ['MVP', 'Quartermaster'], rank: 1, badges: b('donor1', 'raid1', 'streak1') },
      { userId: 1, name: 'Grimtusk', class: 'WARRIOR', gold: 94, kills: 41, crafts: 0, raids: 2, base: 196, streak: 3, bonus: 0.1, score: 216, titles: ['Warlord'], rank: 2, badges: b('pvp1') },
      { userId: 3, name: 'Mokra', class: 'ROGUE', gold: 31, kills: 12, crafts: 14, raids: 1, base: 135, streak: 2, bonus: 0.05, score: 142, titles: ['Master Crafter'], rank: 3, badges: b('craft1', 'pvp1') },
      { userId: 4, name: 'Zuljin', class: 'PRIEST', gold: 8, kills: 0, crafts: 2, raids: 3, base: 48, streak: 1, bonus: 0, score: 48, titles: ['Stalwart'], rank: 4, badges: [] },
      { userId: 5, name: 'Shadowfen', class: 'WARLOCK', gold: 0, kills: 6, crafts: 0, raids: 1, base: 22, streak: 1, bonus: 0, score: 22, titles: [], rank: 5, badges: [] },
    ];
    const leaders = players.length ? {
      donor: { userId: 2, name: 'Thrallia', value: 215 }, pvp: { userId: 1, name: 'Grimtusk', value: 41 },
      crafter: { userId: 3, name: 'Mokra', value: 14 }, raider: { userId: 4, name: 'Zuljin', value: 3 },
    } : {};
    return {
      month, start: `${month}-01T00:00:00.000Z`, end: '', current: !past, daysLeft: past ? 0 : 21,
      points: { gold: 1, kill: 2, craft: 5, raid: 10 }, streak: { step: 0.05, max: 0.25 }, categories: CATS,
      players, leaders, mvp: players[0] ? { userId: 2, name: 'Thrallia', score: 297 } : null,
      me: 1, mine: players.find((p) => p.userId === 1) || null, myBadges: b('pvp1'), allBadges: BADGES,
      hall: MODE === 'empty' ? [] : [
        { month: '2026-10', mvp: { userId: 3, name: 'Mokra', score: 412 }, leaders: { donor: { name: 'Thrallia' }, pvp: { name: 'Grimtusk' }, crafter: { name: 'Mokra' }, raider: { name: 'Mokra' } }, players: 7 },
      ],
      canAnnounce: past, announced: null, discord: true,
    };
  },
  'POST /api/seasons/announce': () => ({ posted: true }),
});
