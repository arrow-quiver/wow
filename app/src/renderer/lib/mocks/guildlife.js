// Preview sample data for guild life: the bulletin board, leveling matches and the weekly digest (docs/api/community.md).
import { addMockRoutes } from '../mock.js';

const ago = (h) => new Date(Date.now() - h * 3600000).toISOString().replace('T', ' ').slice(0, 19);
const KINDS = { lfg: 'Looking for group', wts: 'Selling', wtb: 'Buying', help: 'Help wanted' };
const posts = [
  { id: 4, character: 'Mokra', class: 'WARRIOR', level: 34, kind: 'lfg', text: 'LF2M Scarlet Monastery Armory, healer and dps', price: null, created_at: ago(1), mine: false },
  { id: 3, character: 'Grimtusk', class: 'MAGE', level: 60, kind: 'wts', text: 'Mooncloth, 4 left. Can drop it off in Orgrimmar', price: 125000, created_at: ago(5), mine: true },
  { id: 2, character: 'Zulsha', class: 'PRIEST', level: 47, kind: 'wtb', text: 'Arcanite Bar x2', price: 600000, created_at: ago(20), mine: false },
  { id: 1, character: 'Rokhan', class: 'HUNTER', level: 28, kind: 'help', text: 'Need a hand with the Ashenvale escort, keeps dying', price: null, created_at: ago(30), mine: false },
].map((p) => ({ ...p, kindLabel: KINDS[p.kind] }));

addMockRoutes({
  'GET /api/board': () => ({ posts, myCharacters: [{ name: 'Grimtusk', class: 'MAGE', level: 60 }, { name: 'Grimlet', class: 'ROGUE', level: 27 }], kinds: KINDS }),
  'POST /api/board': () => ({ post: posts[1], message: 'Posted to the guild. It stays up for a week.' }),
  'POST /api/board/:id/remove': () => ({ ok: true, message: 'Post taken down.' }),
  'GET /api/leveling': () => ({ levelGap: 3, characters: [{ character: 'Grimlet', class: 'ROGUE', level: 27, usually: 'Weekday evenings', matches: [
    { name: 'Rokhan', class: 'HUNTER', level: 28, zone: 'Ashenvale', online: true, lastSeen: ago(0), sharedHours: 9, usually: 'Weekday evenings', lookingForPartners: true },
    { name: 'Tazgar', class: 'SHAMAN', level: 25, zone: 'Hillsbrad Foothills', online: false, lastSeen: ago(14), sharedHours: 6, usually: 'Weekday evenings', lookingForPartners: false },
    { name: 'Vashka', class: 'WARLOCK', level: 29, zone: 'Stonetalon Mountains', online: false, lastSeen: ago(40), sharedHours: 1, usually: 'Weekend afternoons', lookingForPartners: false },
  ] }] }),
  'GET /api/digest': () => ({
    week: '2026-11-09', from: '2026-11-09T00:00:00.000Z', to: '2026-11-16T00:00:00.000Z', current: true, previous: '2026-11-02', next: null, guild: 'wow',
    members: { total: 27, joined: ['Rokhan'], atMax: 11 },
    top: [{ name: 'Mokra', points: 214 }, { name: 'Grimtusk', points: 160 }, { name: 'Zulsha', points: 92 }],
    points: { gold: 120, kills: 31, crafts: 6, raidNights: 18 },
    raids: [{ title: 'Molten Core', startsAt: '2026-11-12T18:00:00.000Z', done: true, attended: 18 }, { title: 'Onyxia', startsAt: '2026-11-15T18:00:00.000Z', done: false, attended: 0 }],
    donations: { count: 9, value: 1450000, top: { name: 'Grimtusk', value: 800000 } }, crafts: 6, war: { kills: 31, deaths: 12 }, ctas: 4, board: 7, posted: false,
    canPost: true, discord: true,
    text: '📰 **wow — the week of 2026-11-09**\n🏆 Top of the week: 🥇 Mokra (214)  🥈 Grimtusk (160)  🥉 Zulsha (92)\n🗓️ Raids: Molten Core (Thu, 18 came), Onyxia (Sun)\n⚔️ Out in the world: 31 Alliance slain, 12 deaths, 4 calls to arms\n🎁 9 donations to the guild bank, worth 145g. Most generous: Grimtusk\n🔨 6 crafting requests made\n📌 7 new posts on the bulletin board\n👋 Welcome Rokhan!\n27 members, 11 at level 60. For the Horde!',
  }),
  'POST /api/digest/post': () => ({ ok: true, posted: true, message: 'The weekly digest is on Discord.' }),
});
