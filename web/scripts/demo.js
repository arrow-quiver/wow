// Fills a local database with sample guild data so you can see the site working.
// Usage: DB_FILE=data/demo.db node scripts/demo.js
const dbm = require('../src/db');
const A = require('../src/auth');
const { applyPayload } = require('../src/sync');
const db = dbm.open(process.env.DB_FILE || 'data/demo.db');
if (db.prepare('SELECT COUNT(*) n FROM guilds').get().n) { console.log('Already has a guild; delete the file to reseed.'); process.exit(0); }
const user = (bt) => db.prepare('INSERT INTO users (bnet_id, battletag) VALUES (?,?)').run('dev:' + bt, bt).lastInsertRowid;
const j = user('J#1001'), grom = user('Grom#2002'), zul = user('Zul#3003');
const g = db.prepare("INSERT INTO guilds (name, faction, invite_code) VALUES ('wow','Horde',?)").run(A.inviteCode()).lastInsertRowid;
db.prepare("INSERT INTO memberships (user_id, guild_id, role) VALUES (?,?,'owner'),(?,?,'officer'),(?,?,'member')").run(j, g, grom, g, zul, g);
const classes = ['WARRIOR','SHAMAN','HUNTER','ROGUE','PRIEST','MAGE','WARLOCK','DRUID'];
const zones = ['The Barrens','Stonetalon Mountains','Hillsbrad Foothills','Thousand Needles','Ashenvale','Riverglades'];
const names = ['Thrallia','Grommash Hellscream','Zuljinne','Vexa Nightbloom','Korrin Ashmane','Tavi','Murk','Sylra Dawnshade','Bront','Ilsa Emberwake','Garrok','Nyx'];
const now = Math.floor(Date.now()/1000);
applyPayload(db, g, j, {
  characters: { Thrallia: { name: 'Thrallia', class: 'SHAMAN', race: 'Orc', level: 24, faction: 'Horde', zone: 'The Barrens', money: 245000,
    professions: [{ name: 'Blacksmithing', skill: 132, max: 150 }, { name: 'Mining', skill: 140, max: 150 }, { name: 'Cooking', skill: 85, max: 150 }],
    recipes: { Blacksmithing: ['Rough Sharpening Stone','Coarse Sharpening Stone','Copper Chain Vest','Runed Copper Belt','Heavy Copper Maul','Silvered Bronze Shoulders'].map((name) => ({ name })) }, updated: now } },
  roster: { scannedAt: now - 120, members: names.map((name, i) => ({ name, class: classes[i % 8], level: 12 + (i * 7) % 30, rank: i === 0 ? 'Guild Master' : i < 3 ? 'Officer' : 'Member', zone: zones[i % 6], online: i % 3 !== 2 })) },
  ctaQueue: [{ zone: 'The Crossroads', needed: 6, msg: 'Alliance raid hitting the flight master', at: now - 600, character: 'Thrallia' }],
});
applyPayload(db, g, grom, { characters: { 'Grommash Hellscream': { name: 'Grommash Hellscream', class: 'WARRIOR', race: 'Orc', level: 31, faction: 'Horde', zone: 'Hillsbrad Foothills',
  professions: [{ name: 'Tailoring', skill: 160, max: 225 }], recipes: { Tailoring: ['Heavy Linen Bandage','Brown Linen Robe','Red Woolen Bag','Heavy Silk Bandage'].map((name) => ({ name })) }, updated: now } } });
db.prepare("INSERT INTO craft_requests (guild_id, requester_id, item, notes) VALUES (?,?,?,?)").run(g, zul, 'Copper Chain Vest', 'Mats in the mail');
db.prepare("INSERT INTO craft_requests (guild_id, requester_id, item, notes, status, crafter_id) VALUES (?,?,?,?, 'claimed', ?)").run(g, j, 'Red Woolen Bag', '', grom);
db.prepare("INSERT INTO buddy_posts (guild_id, user_id, character, level, zone, when_text, note) VALUES (?,?,?,?,?,?,?)").run(g, zul, 'Zuljinne', 18, 'Stonetalon Mountains', 'Tonight 8pm', 'Doing the Venture Co. chain');
db.prepare("INSERT INTO announcements (guild_id, user_id, body) VALUES (?,?,?)").run(g, j, 'Welcome to Forever! Everyone grab the addon and companion from Settings.');
db.prepare("INSERT INTO activity (guild_id, kind, text) VALUES (?,?,?),(?,?,?)").run(g, 'craft', 'Zul asked for Copper Chain Vest', g, 'buddy', 'Zuljinne is looking for leveling partners in Stonetalon Mountains');
// Phase 2 sample: loot list, a raid with sign-ups, reserves and readiness.
const R = require('../src/raids');
R.importItems(db, g, 'Hyjal Summit', ['Rage Winterchill | Frostbound Greaves', 'Rage Winterchill | Chillheart Band', 'Anetheron | Cloak of the Long Night',
  'Anetheron | Dreadlord Signet', 'Kaz\'rogal | Mark of the Legion', 'Azgalor | Doomfire Shoulders', 'Archimonde | Tear of the Earthmother', 'Archimonde | Hammer of Nordrassil'].join('\n'));
const ids = Object.fromEntries(R.itemsForInstance(db, g, 'Hyjal Summit').map((i) => [i.name, i.id]));
const ready = (ilvl, dur, c) => JSON.stringify({ ilvl, durability: dur, consumables: c, at: now - 3600 });
db.prepare('UPDATE characters SET readiness = ? WHERE name = ?').run(ready(58, 92, { flask: 2, potion: 8, food: 20 }), 'Thrallia');
db.prepare('UPDATE characters SET readiness = ? WHERE name = ?').run(ready(61, 24, { potion: 3 }), 'Grommash Hellscream');
const raidAt = new Date(Date.now() + 2 * 86400000); raidAt.setUTCHours(18, 0, 0, 0);
const rid = db.prepare("INSERT INTO raids (guild_id, title, instance, starts_at, size, sr_limit, notes, created_by) VALUES (?,?,?,?,?,?,?,?)")
  .run(g, 'Hyjal week 1', 'Hyjal Summit', raidAt.toISOString(), 20, 2, 'Bring fire resistance gear for Azgalor.', j).lastInsertRowid;
const raid = R.raidFor(db, g, rid);
const sign = (u, ch, role, st, note) => db.prepare('INSERT INTO signups (raid_id, user_id, character, role, status, note) VALUES (?,?,?,?,?,?)').run(rid, u, ch, role, st, note || null);
sign(j, 'Thrallia', 'healer', 'yes'); sign(grom, 'Grommash Hellscream', 'tank', 'yes'); sign(zul, 'Zuljinne', 'dps', 'tentative', 'Might be 15 min late');
R.setReserves(db, raid, j, [ids['Chillheart Band'], ids['Tear of the Earthmother']]);
R.setReserves(db, raid, grom, [ids['Frostbound Greaves'], ids['Tear of the Earthmother']]);
R.setReserves(db, raid, zul, [ids['Cloak of the Long Night']]);
db.prepare('INSERT INTO loyalty (guild_id, user_id, item_id, bonus) VALUES (?,?,?,20),(?,?,?,10)').run(g, grom, ids['Tear of the Earthmother'], g, j, ids['Chillheart Band']);
R.rollItem(db, raid, ids['Tear of the Earthmother']);
console.log('Demo data ready. Sign in (dev) as J#1001.');
