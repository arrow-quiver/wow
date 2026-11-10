// Preview sample data for the hunt: kill on sight and bounties (docs/api/war.md).
import { addMockRoutes } from '../mock.js';

const ago = (h) => new Date(Date.now() - h * 3600000).toISOString().replace('T', ' ').slice(0, 19);
const inDays = (d) => Math.floor(Date.now() / 1000) + d * 86400;
addMockRoutes({
  'GET /api/hunt': () => ({
    canPost: true, kosPoints: 8,
    kos: [
      { name: 'Gankalot', reason: 'Camps the Crossroads flight path', addedBy: 'Mokra', addedAt: ago(30), kills: 4, lastKill: null },
      { name: 'Stabby', reason: 'Killed three lowbies in the Barrens', addedBy: 'Grimtusk', addedAt: ago(5), kills: 0, lastKill: null },
    ],
    bounties: [
      { id: 2, key: 'b2b2b2', target: 'Stabby', zone: null, points: 50, cap: 1, ends: inDays(3), note: 'Ganking lowbies', createdAt: ago(5), status: 'open', claims: [], left: 1 },
      { id: 3, key: 'z3z3z3', target: null, zone: 'Hillsbrad Foothills', points: 5, cap: 10, ends: inDays(5), note: 'Take back Tarren Mill', createdAt: ago(20), status: 'open', claims: [{ name: 'Mokra', target: 'Lightbro', at: 0, points: 5 }], left: 9 },
      { id: 1, key: 'a1a1a1', target: 'Gankalot', zone: null, points: 100, cap: 1, ends: inDays(-1), note: '', createdAt: ago(200), status: 'claimed', claims: [{ name: 'Zulsha', target: 'Gankalot', at: 0, points: 100 }], left: 0 },
    ],
  }),
  'POST /api/kos': () => ({ ok: true, message: 'Added to kill on sight.' }),
  'POST /api/kos/:name/remove': () => ({ ok: true, message: 'Off the list.' }),
  'POST /api/bounties': () => ({ ok: true, key: 'n1n1n1', message: 'Bounty up.' }),
  'POST /api/bounties/:id/close': () => ({ ok: true, message: 'Bounty closed.' }),
});
