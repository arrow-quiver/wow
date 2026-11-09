'use strict';
// Reading the game's combat log (shared/combatlog.js): lines from Classic and Retail, with and without advanced
// logging, and following one player's session (kills, deaths, the death recap).
const test = require('node:test');
const assert = require('node:assert');
const { parseLine, splitFields, amountOf, createSession, deathText, sessionText } = require('../../src/shared/combatlog');

const ME = 'Player-4395-0A1B2C3D,"Grom-Zuljin",0x511,0x0';
const MOB = 'Creature-0-4395-0-1-116-000ABC,"Defias Pillager",0xa48,0x0';
const ROGUE = 'Player-4395-0F0F0F0F,"Sneaky-Zuljin",0x548,0x0';
const L = (time, rest) => `11/9 ${time}  ${rest}`;

test('splitFields keeps commas inside quotes', () => {
  assert.deepStrictEqual(splitFields('A,"b, c",3'), ['A', 'b, c', '3']);
});

test('parseLine: Classic and Retail stamps, units, fields', () => {
  const e = parseLine(L('17:30:12.345', `SPELL_DAMAGE,${ME},${MOB},133,"Fireball",0x4,250,0,4,0,0,0,nil,nil,nil`), { year: 2026 });
  assert.strictEqual(e.event, 'SPELL_DAMAGE');
  assert.strictEqual(e.src.name, 'Grom-Zuljin');
  assert.strictEqual(e.dst.name, 'Defias Pillager');
  assert.strictEqual(new Date(e.t).getHours(), 17);
  assert.deepStrictEqual(amountOf(e), { spell: 'Fireball', amount: 250 });
  const r = parseLine(`11/9/2026 17:30:12.3451  SWING_DAMAGE,${MOB},${ME},80,-1,1,0,0,0,nil,nil,nil`);
  assert.strictEqual(r.event, 'SWING_DAMAGE');
  assert.deepStrictEqual(amountOf(r), { spell: 'Melee', amount: 80 });
  assert.strictEqual(parseLine('not a log line'), null);
  assert.strictEqual(parseLine(''), null);
});

test('amountOf with advanced combat logging', () => {
  const info = ['Player-4395-0A1B2C3D', '0000000000000000', '100', '100', '0', '0', '0', '0', '0', '0', '1', '0', '0', '0', '1.0', '2.0', '0'];
  const e = parseLine(L('17:30:12.345', `SPELL_DAMAGE,${ME},${MOB},133,"Fireball",0x4,${info.join(',')},300,0,4`));
  assert.deepStrictEqual(amountOf(e), { spell: 'Fireball', amount: 300 });
  const s = parseLine(L('17:30:12.345', `SWING_DAMAGE,${MOB},${ME},${info.join(',')},90,-1,1`));
  assert.deepStrictEqual(amountOf(s), { spell: 'Melee', amount: 90 });
});

test('a session: kills, damage, a PvP death and its recap', () => {
  const s = createSession({ names: ['Grom'] });
  const add = (time, rest) => s.add(parseLine(L(time, rest), { year: 2026 }));
  assert.strictEqual(add('17:00:00.000', `SPELL_DAMAGE,${ROGUE},${MOB},1,"x",0x1,5,0,1`), null, 'not about me');
  add('17:00:01.000', `SPELL_CAST_SUCCESS,${ME},${MOB},133,"Fireball",0x4`);
  add('17:00:02.000', `SPELL_DAMAGE,${ME},${MOB},133,"Fireball",0x4,250,0,4,0,0,0,nil,nil,nil`);
  add('17:00:03.000', `PARTY_KILL,${ME},${MOB}`);
  // 30 s later, a rogue: a new fight.
  add('17:00:33.000', `SWING_DAMAGE,${ROGUE},${ME},120,-1,1,0,0,0,nil,nil,nil`);
  add('17:00:34.000', `SPELL_HEAL,${ME},${ME},2061,"Flash Heal",0x2,200,0,0,nil`);
  add('17:00:35.000', `SPELL_DAMAGE,${ROGUE},${ME},1752,"Sinister Strike",0x1,300,0,1,0,0,0,nil,nil,nil`);
  add('17:00:36.000', `SPELL_DAMAGE,${ROGUE},${ME},2098,"Eviscerate",0x1,600,0,1,0,0,0,nil,nil,nil`);
  const died = add('17:00:36.100', `UNIT_DIED,0000000000000000,nil,0x80000000,0x0,${ME}`);
  assert.strictEqual(died.kind, 'died');
  const d = s.lastDeath;
  assert.strictEqual(d.killer, 'Sneaky');
  assert.strictEqual(d.pvp, true);
  assert.deepStrictEqual(d.killingBlow, { spell: 'Eviscerate', amount: 600 });
  assert.strictEqual(d.damageTaken, 1020);
  assert.strictEqual(d.healed, 200);
  assert.strictEqual(d.sources[0].spell, 'Eviscerate');
  assert.strictEqual(d.seconds, 3.1);
  const x = s.summary();
  assert.strictEqual(x.character, 'Grom');
  assert.strictEqual(x.kills, 1);
  assert.strictEqual(x.pvpKills, 0);
  assert.strictEqual(x.deaths, 1);
  assert.strictEqual(x.pvpDeaths, 1);
  assert.strictEqual(x.damageDone, 250);
  assert.strictEqual(x.fights, 2);
  assert.strictEqual(x.killsPerHour, null, 'too early for rates');
  assert.match(deathText(d), /Died to Sneaky \(a player\), killing blow Eviscerate for 600\./);
  assert.match(deathText(d), /healed for 200/);
  assert.match(sessionText(x), /1 kills \(0 players\), 1 deaths \(1 to players\), 2 fights/);
  assert.strictEqual(deathText(null), '');
});

test('a session knows me by GUID once named, and by a new name list', () => {
  const s = createSession();
  assert.strictEqual(s.add(parseLine(L('17:00:00.000', `PARTY_KILL,${ME},${MOB}`))), null);
  s.setNames(['Grom-Zuljin']);
  assert.strictEqual(s.add(parseLine(L('17:00:01.000', `PARTY_KILL,${ME},${ROGUE}`))).player, true);
  // The same GUID with no name still counts.
  s.add(parseLine(L('17:00:02.000', `PARTY_KILL,Player-4395-0A1B2C3D,nil,0x511,0x0,${MOB}`)));
  assert.strictEqual(s.summary().kills, 2);
  assert.strictEqual(s.summary().pvpKills, 1);
});

test('the zone: MAP_CHANGE names it; ZONE_CHANGE (the instance, a continent outdoors) only until the next MAP_CHANGE', () => {
  const s = createSession({ names: ['Grom'] });
  const add = (time, rest) => s.add(parseLine(L(time, rest), { year: 2026 }));
  assert.strictEqual(s.zone, null);
  // Logging in (or zoning onto a continent): the instance first, then the map.
  add('17:00:00.000', 'ZONE_CHANGE,0,"Eastern Kingdoms",0');
  assert.deepStrictEqual(s.zone, { id: 0, name: 'Eastern Kingdoms' });
  add('17:00:00.000', 'MAP_CHANGE,1424,"Hillsbrad Foothills",-1066.667,-3133.333,-1100.000,-4250.000');
  assert.deepStrictEqual(s.zone, { id: 1424, name: 'Hillsbrad Foothills' });
  // Walking into the next zone writes only a MAP_CHANGE.
  add('17:05:00.000', 'MAP_CHANGE,1425,"The Hinterlands",-1500.000,-4300.000,-500.000,-2500.000');
  assert.deepStrictEqual(s.zone, { id: 1425, name: 'The Hinterlands' });
  add('17:06:00.000', 'MAP_CHANGE,1424,"Hillsbrad Foothills",-1066.667,-3133.333,-1100.000,-4250.000');
  assert.deepStrictEqual(s.zone, { id: 1424, name: 'Hillsbrad Foothills' });
  // A dungeon: its ZONE_CHANGE stands in until its map arrives (a MAP_CHANGE from before doesn't).
  add('17:10:00.000', 'ZONE_CHANGE,33,"Shadowfang Keep",1');
  assert.deepStrictEqual(s.zone, { id: 33, name: 'Shadowfang Keep' });
  add('17:10:00.000', 'MAP_CHANGE,310,"Shadowfang Keep",0,0,0,0');
  assert.deepStrictEqual(s.zone, { id: 310, name: 'Shadowfang Keep' });
  assert.strictEqual(s.summary().zone, 'Shadowfang Keep');
});

test('a session knows the zone and every player in a death', () => {
  const s = createSession({ names: ['Grom'] });
  const add = (time, rest) => s.add(parseLine(L(time, rest), { year: 2026 }));
  const HOLY = 'Player-4395-0E0E0E0E,"Holy-Zuljin",0x548,0x0';
  add('17:00:00.000', 'ZONE_CHANGE,0,"Eastern Kingdoms",0');
  add('17:00:00.000', 'MAP_CHANGE,1424,"Hillsbrad Foothills",-1066.667,-3133.333,-1100.000,-4250.000');
  assert.deepStrictEqual(s.zone, { id: 1424, name: 'Hillsbrad Foothills' });
  add('17:00:01.000', `SPELL_DAMAGE,${HOLY},${ME},585,"Smite",0x2,200,0,2,0,0,0,nil,nil,nil`);
  add('17:00:02.000', `SWING_DAMAGE,${MOB},${ME},50,-1,1,0,0,0,nil,nil,nil`);
  add('17:00:03.000', `SPELL_DAMAGE,${ROGUE},${ME},2098,"Eviscerate",0x1,600,0,1,0,0,0,nil,nil,nil`);
  add('17:00:03.100', `UNIT_DIED,0000000000000000,nil,0x80000000,0x0,${ME}`);
  const d = s.lastDeath;
  assert.deepStrictEqual(d.enemies, ['Holy', 'Sneaky']);
  assert.strictEqual(d.zone, 'Hillsbrad Foothills');
  assert.strictEqual(d.zoneId, 1424);
  assert.match(deathText(d), /^Died to Sneaky \(a player\) and 1 other player in Hillsbrad Foothills, killing blow Eviscerate/);
  assert.strictEqual(s.summary().zone, 'Hillsbrad Foothills');
});

test("a player's pet counts as the player; a mob's last hit after players still makes a PvP death", () => {
  const s = createSession({ names: ['Grom'] });
  const add = (time, rest) => s.add(parseLine(L(time, rest), { year: 2026 }));
  const HUNTER = 'Player-4395-0D0D0D0D,"Hunty-Zuljin",0x548,0x0';
  const WOLF = 'Pet-0-4395-0-1-1234-0100ABCDEF,"Fang",0x1148,0x0';
  const CAT = 'Pet-0-4395-0-1-5678-0200ABCDEF,"Shadow",0x1148,0x0';
  // A summon line ties the wolf to its hunter (the hunter has to have been named in some line).
  add('17:00:00.000', `SPELL_SUMMON,${HUNTER},${WOLF},883,"Call Pet",0x1`);
  add('17:00:01.000', `SWING_DAMAGE,${WOLF},${ME},70,-1,1,0,0,0,nil,nil,nil`);
  add('17:00:02.000', `SWING_DAMAGE,${MOB},${ME},50,-1,1,0,0,0,nil,nil,nil`);
  add('17:00:02.100', `UNIT_DIED,0000000000000000,nil,0x80000000,0x0,${ME}`);
  let d = s.lastDeath;
  assert.strictEqual(d.killer, 'Defias Pillager');
  assert.strictEqual(d.pvp, true, 'a player was in on it');
  assert.deepStrictEqual(d.enemies, ['Hunty']);
  assert.ok(d.sources.some((x) => x.who === 'Hunty' && x.spell === 'Melee (Fang)' && x.player));
  assert.strictEqual(s.summary().pvpDeaths, 1);
  // An unknown owner: the pet's own name. Advanced logging names the owner by GUID in the unit info.
  add('17:01:00.000', `SWING_DAMAGE,${CAT},${ME},80,-1,1,0,0,0,nil,nil,nil`);
  add('17:01:00.100', `UNIT_DIED,0000000000000000,nil,0x80000000,0x0,${ME}`);
  d = s.lastDeath;
  assert.strictEqual(d.pvp, true);
  assert.deepStrictEqual(d.enemies, ['Shadow']);
  const info = ['Pet-0-4395-0-1-5678-0200ABCDEF', 'Player-4395-0D0D0D0D', '100', '100', '0', '0', '0', '0', '0', '0', '1', '0', '0', '0', '1.0', '2.0', '0'];
  add('17:02:00.000', `SWING_DAMAGE,${CAT},${ME},${info.join(',')},90,-1,1`);
  add('17:02:00.100', `UNIT_DIED,0000000000000000,nil,0x80000000,0x0,${ME}`);
  assert.deepStrictEqual(s.lastDeath.enemies, ['Hunty']);
  // Mobs and my own damage only: not PvP.
  add('17:03:00.000', `ENVIRONMENTAL_DAMAGE,0000000000000000,nil,0x80000000,0x80000000,${ME},Falling,300,0,1,0,0,0,nil,nil,nil`);
  add('17:03:00.200', `SPELL_DAMAGE,${ME},${ME},1454,"Life Tap",0x20,100,0,32,0,0,0,nil,nil,nil`);
  add('17:03:00.500', `SWING_DAMAGE,${MOB},${ME},50,-1,1,0,0,0,nil,nil,nil`);
  add('17:03:00.600', `UNIT_DIED,0000000000000000,nil,0x80000000,0x0,${ME}`);
  assert.strictEqual(s.lastDeath.pvp, false);
  assert.deepStrictEqual(s.lastDeath.enemies, []);
  assert.strictEqual(s.summary().pvpDeaths, 3);
});
