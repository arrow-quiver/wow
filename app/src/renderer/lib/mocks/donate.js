// Preview sample data for the Donate page (docs/api/economy.md "Donations"). &donate=empty: nothing yet.
import { addMockRoutes } from '../mock.js';

const MODE = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('donate') : null;
const ago = (h) => new Date(Date.now() - h * 3600000).toISOString().replace('T', ' ').slice(0, 19);

addMockRoutes({
  'GET /api/donations': ({ query }) => {
    const days = Number(query.days) || 30;
    if (MODE === 'empty') return { days, requests: [], toBuy: 0, unpricedRequests: 0, total: 0, board: [], mine: { value: 0, gold: 0, items: 0, count: 0, rank: null }, recent: [] };
    const requests = [
      { id: 1, item: 'Major Mana Potion', count: 10, note: 'for Molten Core', created_at: ago(20), requester: 'Shadowfen', item_id: 13444, unit_price: 9200, total: 92000, priced_from: 'auction' },
      { id: 2, item: 'Runecloth', count: 40, note: null, created_at: ago(30), requester: 'Mokra', item_id: 14047, unit_price: 1150, total: 46000, priced_from: 'auction' },
      { id: 3, item: 'Elixir of the Mongoose', count: 5, note: 'raid night', created_at: ago(5), requester: 'Zuljin', item_id: 13452, unit_price: 31000, total: 155000, priced_from: 'auction' },
      { id: 4, item: 'Heavy Leather', count: 20, note: null, created_at: ago(50), requester: 'Thrallia', item_id: null, unit_price: null, total: null, priced_from: null },
    ];
    const board = [
      { rank: 1, userId: 2, who: 'Thrallia', value: 2150000, gold: 1500000, items: 650000, count: 9, me: false },
      { rank: 2, userId: 1, who: 'Grimtusk', value: 940000, gold: 500000, items: 440000, count: 6, me: true },
      { rank: 3, userId: 3, who: 'Mokra', value: 312500, gold: 0, items: 312500, count: 4, me: false },
      { rank: 4, userId: 4, who: 'Zuljin', value: 88000, gold: 50000, items: 38000, count: 2, me: false },
    ];
    return {
      days, requests, toBuy: 293000, unpricedRequests: 1, total: board.reduce((a, b) => a + b.value, 0), board,
      mine: { value: 940000, gold: 500000, items: 440000, count: 6, rank: 2 },
      recent: [
        { id: 10, who: 'Grimtusk', kind: 'item', item_id: 13444, item_name: 'Major Mana Potion', quality: 'COMMON', count: 8, value: 73600, priced_from: 'auction', at: ago(2), me: true },
        { id: 9, who: 'Thrallia', kind: 'gold', item_id: null, item_name: null, quality: null, count: null, value: 1000000, priced_from: 'gold', at: ago(6), me: false },
        { id: 8, who: 'Mokra', kind: 'item', item_id: 14047, item_name: 'Runecloth', quality: 'COMMON', count: 60, value: 69000, priced_from: 'auction', at: ago(9), me: false },
        { id: 7, who: 'Zuljin', kind: 'item', item_id: 2589, item_name: 'Linen Cloth', quality: 'COMMON', count: 40, value: 520, priced_from: 'vendor', at: ago(30), me: false },
        { id: 6, who: 'Mokra', kind: 'item', item_id: 12808, item_name: 'Essence of Undeath', quality: 'UNCOMMON', count: 2, value: null, priced_from: null, at: ago(31), me: false },
      ],
    };
  },
});
