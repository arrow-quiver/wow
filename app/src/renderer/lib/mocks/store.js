// Preview sample data for the guild bank store (docs/api/seasons.md). &store=member: a member's view.
import { addMockRoutes } from '../mock.js';

const MODE = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('store') : null;
const ago = (h) => new Date(Date.now() - h * 3600000).toISOString().replace('T', ' ').slice(0, 19);
const items = [
  { key: 'a1b2c3', item: 'Major Mana Potion', itemId: 13444, cost: 40, stock: 20, left: 14 },
  { key: 'd4e5f6', item: 'Runecloth Bag', itemId: 14046, cost: 120, stock: 3, left: 2 },
  { key: 'g7h8i9', item: 'Elixir of the Mongoose', itemId: 13452, cost: 90, stock: 10, left: 7 },
  { key: 'j1k2l3', item: 'Flask of Supreme Power', itemId: 13512, cost: 600, stock: 1, left: 0 },
  { key: 'm4n5o6', item: 'Greater Fire Protection Potion', itemId: 13457, cost: 55, stock: 15, left: 15 },
  { key: 'p7q8r9', item: 'Mooncloth', itemId: 14342, cost: 260, stock: 2, left: 2 },
];

addMockRoutes({
  'GET /api/store': () => ({
    items,
    balance: { earned: 512, spent: 160, held: 80, available: 272 },
    mine: [
      { id: 7, key: 'a1b2c3', item: 'Major Mana Potion', count: 2, cost: 40, total: 80, note: 'raid night', status: 'open', requester: 'Grimtusk', created_at: ago(3) },
      { id: 5, key: 'd4e5f6', item: 'Runecloth Bag', count: 1, cost: 120, total: 120, note: '', status: 'sent', requester: 'Grimtusk', created_at: ago(50) },
      { id: 4, key: 'a1b2c3', item: 'Major Mana Potion', count: 1, cost: 40, total: 40, note: '', status: 'sent', requester: 'Grimtusk', created_at: ago(70) },
    ],
    pending: MODE === 'member' ? [] : [
      { id: 9, key: 'g7h8i9', item: 'Elixir of the Mongoose', count: 3, cost: 90, total: 270, note: 'MC on Thursday', status: 'open', requester: 'Mokra', created_at: ago(1), balance: { earned: 610, spent: 90, held: 270, available: 250 } },
      { id: 7, key: 'a1b2c3', item: 'Major Mana Potion', count: 2, cost: 40, total: 80, note: 'raid night', status: 'open', requester: 'Grimtusk', created_at: ago(3), balance: { earned: 512, spent: 160, held: 80, available: 272 } },
    ],
    canEdit: MODE !== 'member',
  }),
  'PUT /api/store': ({ body }) => ({ items: body.items, balance: { earned: 512, spent: 160, held: 80, available: 272 }, mine: [], pending: [], canEdit: true }),
  'POST /api/store/order': () => ({ items, balance: { earned: 512, spent: 160, held: 120, available: 232 }, mine: [], pending: [], canEdit: true, message: 'Ordered.' }),
});
