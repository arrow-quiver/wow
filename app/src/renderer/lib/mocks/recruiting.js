// Preview sample data for recruiting (docs/api/community.md).
import { addMockRoutes } from '../mock.js';

const ago = (h) => Math.floor(Date.now() / 1000) - h * 3600;
const STATES = { c: 'contacted', i: 'interested', n: 'no thanks', j: 'joined' };
const recruits = [
  { name: 'Grakhul', level: 24, class: 'SHAMAN', zone: 'Stonetalon Mountains', state: 'i', recruiter: 'Mokra', at: ago(1), joinedAt: null, stayed: false, left: false },
  { name: 'Zulvex', level: 31, class: 'PRIEST', zone: 'Hillsbrad Foothills', state: 'j', recruiter: 'Grimtusk', at: ago(200), joinedAt: ago(200), stayed: true, left: false },
  { name: 'Morthak', level: 18, class: 'WARRIOR', zone: 'The Barrens', state: 'c', recruiter: 'Mokra', at: ago(3), joinedAt: null, stayed: false, left: false },
  { name: 'Selvara', level: 40, class: 'MAGE', zone: 'Desolace', state: 'n', recruiter: 'Zulsha', at: ago(30), joinedAt: null, stayed: false, left: false },
].map((r) => ({ ...r, stateLabel: STATES[r.state] }));
addMockRoutes({
  'GET /api/recruiting': () => ({
    recruits, points: 25, stayDays: 7, canEdit: true,
    classes: ['WARRIOR', 'PALADIN', 'HUNTER', 'ROGUE', 'PRIEST', 'SHAMAN', 'MAGE', 'WARLOCK', 'DRUID'],
    stats: { counts: { c: 1, i: 1, n: 1, j: 1 }, recruiters: [{ name: 'Grimtusk', contacted: 6, interested: 0, joined: 1, stayed: 1 }, { name: 'Mokra', contacted: 9, interested: 1, joined: 0, stayed: 0 }] },
    settings: { ad: 'wow is recruiting! A friendly Horde PvP guild: war parties, raids, a guild bank. All levels welcome. /w me', msg: 'Hey {name}! Want to join a friendly Horde PvP guild?', classes: 'PRIEST,SHAMAN', minLevel: 10, maxLevel: 60, custom: true },
  }),
  'PUT /api/recruiting/settings': () => ({ ok: true, message: 'Saved and shared with the guild\'s addons.' }),
});
