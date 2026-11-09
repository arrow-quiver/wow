// Preview sample data for the War page (used only when the renderer runs in a plain browser without window.gc).
// Shapes match docs/api/war.md (the local core's routes/war.js). &war=empty shows a guild with no fights yet.
import { addMockRoutes, httpError } from '../mock.js';

const MODE = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('war') : null;
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const unix = (msAgo) => Math.floor((Date.now() - msAgo) / 1000);

function hillsbrad() {
  const marks = [
    [452, 381, 12 * MIN, 'd', 'Grimtusk'], [461, 372, 15 * MIN, 'k', 'Grimtusk'], [447, 390, 40 * MIN, 'd', 'Mokra'],
    [455, 377, 2 * HOUR, 'k', 'Thrallia'], [620, 210, 5 * HOUR, 'd', 'Thrallia'], [318, 548, 26 * HOUR, 'd', 'Zuljin'],
    [327, 541, 27 * HOUR, 'k', 'Mokra'], [705, 655, 3 * 24 * HOUR, 'k', 'Grimtusk'],
  ].map(([x, y, ago, kind, who]) => ({ x, y, at: unix(ago), kind, who, n: null }));
  return { mapId: 1424, zone: 'Hillsbrad Foothills', deaths: marks.filter((m) => m.kind === 'd').length, kills: marks.filter((m) => m.kind === 'k').length, marks };
}

addMockRoutes({
  'GET /api/war': ({ query }) => {
    const days = Number(query.days) || 7;
    if (MODE === 'empty') {
      return { days, alerts: false, guild: { deaths: 0, kills: 0, players: 0 }, zones: [], hotspots: [], mine: { deaths: 0, pvpDeaths: 0, recent: [], nemeses: [] } };
    }
    const hb = hillsbrad();
    const ashen = { mapId: 1440, zone: 'Ashenvale', deaths: 2, kills: 3, marks: [
      { x: 512, y: 455, at: unix(3 * HOUR), kind: 'k', who: 'Mokra' }, { x: 520, y: 449, at: unix(3 * HOUR + 5 * MIN), kind: 'k', who: 'Mokra' },
      { x: 515, y: 462, at: unix(4 * HOUR), kind: 'd', who: 'Zuljin' }, { x: 280, y: 300, at: unix(30 * HOUR), kind: 'd', who: 'Thrallia' },
      { x: 702, y: 610, at: unix(50 * HOUR), kind: 'k', who: 'Grimtusk' }] };
    return {
      days, alerts: true,
      guild: { deaths: hb.deaths + ashen.deaths, kills: hb.kills + ashen.kills, players: 4 },
      zones: [hb, ashen],
      hotspots: [
        { mapId: 1424, zone: 'Hillsbrad Foothills', x: 454, y: 380, deaths: 2, kills: 2, last: unix(12 * MIN) },
        { mapId: 1440, zone: 'Ashenvale', x: 516, y: 455, deaths: 1, kills: 2, last: unix(3 * HOUR) },
        { mapId: 1424, zone: 'Hillsbrad Foothills', x: 322, y: 545, deaths: 1, kills: 1, last: unix(26 * HOUR) },
      ],
      mine: {
        deaths: 5, pvpDeaths: 4,
        recent: [
          { character: 'Grimtusk', at: Date.now() - 12 * MIN, pvp: true, killer: 'Sneakypete', enemies: ['Sneakypete', 'Holymoly', 'Bigaxe'], zone: 'Hillsbrad Foothills', spell: 'Eviscerate', amount: 612, posted: true },
          { character: 'Grimtusk', at: Date.now() - 2 * HOUR, pvp: true, killer: 'Sneakypete', enemies: ['Sneakypete'], zone: 'Hillsbrad Foothills', spell: 'Ambush', amount: 488, posted: true },
          { character: 'Grimtusk', at: Date.now() - 5 * HOUR, pvp: false, killer: 'Crushridge Ogre', enemies: [], zone: 'Alterac Mountains', spell: 'Melee', amount: 140, posted: false },
          { character: 'Shadowfen', at: Date.now() - 26 * HOUR, pvp: true, killer: 'Frostbyte', enemies: ['Frostbyte', 'Sneakypete'], zone: 'Ashenvale', spell: 'Frostbolt', amount: 395, posted: true },
          { character: 'Grimtusk', at: Date.now() - 50 * HOUR, pvp: true, killer: 'Bigaxe', enemies: ['Bigaxe'], zone: 'Stranglethorn Vale', spell: 'Mortal Strike', amount: 701, posted: false },
        ],
        nemeses: [{ name: 'Sneakypete', kills: 2 }, { name: 'Frostbyte', kills: 1 }, { name: 'Bigaxe', kills: 1 }],
      },
    };
  },
  'POST /api/war/help': () => {
    if (MODE === 'nohook') throw httpError(409, "Add your guild's Discord webhook in Settings → Discord first.");
    return { posted: true };
  },
});
