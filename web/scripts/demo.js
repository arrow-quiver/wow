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
console.log('Demo data ready. Sign in (dev) as J#1001.');
