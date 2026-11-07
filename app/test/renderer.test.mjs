// node:test checks for the renderer's pure helpers (run from the scratchpad; the renderer has no test runner).
import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL, fileURLToPath } from 'node:url';

const R = fileURLToPath(new URL('../src/renderer/', import.meta.url));
const load = (p) => import(pathToFileURL(R + p).href);

const fmt = await load('lib/format.js');
const router = await load('lib/router.js');
const wh = await load('lib/wowhead.js');
const welcome = await load('pages/welcome.js');
const table = await load('components/Table.js');
const status = await load('lib/status.js');
const gcmod = await load('lib/gc.js');
const pages = await load('pages/index.js');
const api = await load('lib/api.js');
const tt = await load('lib/tooltip.js');
const session = await load('lib/session.js');

test('money matches the old site', () => {
  assert.equal(fmt.money(1234567), '123g 45s 67c');
  assert.equal(fmt.money(50000), '5g 0s');
  assert.equal(fmt.money(120), '1s 20c');
  assert.equal(fmt.money(0), '0c');
  assert.equal(fmt.money(-2500), '-25s');
  assert.equal(fmt.money(123456789), '12,345g 67s 89c');
  assert.equal(fmt.money(null), '');
  assert.deepEqual(fmt.moneyParts(1234567), { neg: false, g: 123, s: 45, c: 67 });
  assert.equal(fmt.parseMoney('12g 50s'), 125000);
  assert.equal(fmt.parseMoney('300'), 300);
  assert.equal(fmt.parseMoney('1.5g'), 15000);
  assert.equal(fmt.parseMoney('abc'), null);
});

test('parseTime reads SQLite strings and ISO as UTC', () => {
  assert.equal(fmt.parseTime('2026-11-07 10:00:00').toISOString(), '2026-11-07T10:00:00.000Z');
  assert.equal(fmt.parseTime('2026-11-07T10:00:00Z').toISOString(), '2026-11-07T10:00:00.000Z');
  assert.equal(fmt.parseTime('2026-11-07T12:00:00+02:00').toISOString(), '2026-11-07T10:00:00.000Z');
  assert.equal(fmt.parseTime('2026-11-07').toISOString(), '2026-11-07T00:00:00.000Z');
  assert.equal(fmt.parseTime(''), null);
  assert.equal(fmt.parseTime('nonsense'), null);
});

test('timeAgo wording', () => {
  const now = Date.parse('2026-11-07T12:00:00Z');
  assert.equal(fmt.timeAgo('2026-11-07 11:59:30', now), 'just now');
  assert.equal(fmt.timeAgo('2026-11-07 11:55:00', now), '5 min ago');
  assert.equal(fmt.timeAgo('2026-11-07 09:00:00', now), '3 h ago');
  assert.equal(fmt.timeAgo('2026-11-05 12:00:00', now), '2 d ago');
  assert.equal(fmt.timeAgo('2026-11-07T12:20:00Z', now), 'in 20 min');
  assert.equal(fmt.timeAgo(null, now), 'never');
});

test('datetime-local round trip', () => {
  const iso = '2026-11-07T18:30:00.000Z';
  assert.equal(fmt.fromLocalInput(fmt.toLocalInput(iso)), iso);
});

test('classes and quality', () => {
  assert.equal(fmt.className('WARRIOR'), 'Warrior');
  assert.equal(fmt.classColor('warrior'), '#9a6b3f');
  assert.equal(fmt.className('Death Knight'), 'Death Knight');
  assert.equal(fmt.className(null), 'Unknown');
  assert.equal(fmt.qualityClass(4), 'q-4');
  assert.equal(fmt.qualityClass('Epic'), 'q-4');
  assert.equal(fmt.qualityName(5), 'Legendary');
  assert.equal(fmt.qualityColor(9), 'inherit');
  assert.equal(fmt.plural(1, 'raid'), '1 raid');
  assert.equal(fmt.plural(3, 'ally', 'allies'), '3 allies');
  assert.equal(fmt.bytes(92_405_112), '88 MB');
});

test('router matching', () => {
  assert.deepEqual(router.parseHref('#/raids/12?tab=loot'), { path: '/raids/12', query: { tab: 'loot' }, href: '/raids/12?tab=loot' });
  assert.deepEqual(router.parseHref(''), { path: '/', query: {}, href: '/' });
  assert.equal(router.normalizePath('raids//12/'), '/raids/12');
  assert.deepEqual(router.matchPath('/raids/:id', '/raids/12'), { id: '12' });
  assert.equal(router.matchPath('/raids/:id', '/raids/12/loot'), null);
  assert.deepEqual(router.matchPath('/characters/:name', '/characters/Gr%C3%AEmtusk'), { name: 'Grîmtusk' });
  assert.equal(router.buildPath('/raids/:id', { id: 12 }, { tab: 'loot', x: '' }), '/raids/12?tab=loot');
  assert.equal(router.isActivePath('/raids/12', '/raids'), true);
  assert.equal(router.isActivePath('/raids', '/'), false);
  assert.equal(router.isActivePath('/', '/'), true);
  const found = router.findRoute(pages.routes, '/raids/12/loot');
  assert.equal(found.route.title, 'Loot screen');
  assert.deepEqual(found.params, { id: '12' });
});

test('route table covers the architecture navigation', () => {
  const nav = pages.routes.filter((r) => r.nav).map((r) => `${r.nav}:${r.path}`);
  assert.deepEqual(nav, [
    'Play:/', 'Play:/coach', 'Play:/raids', 'Play:/crafters', 'Play:/requests', 'Play:/partners',
    'Guild:/roster', 'Guild:/bank', 'Guild:/prices', 'Guild:/drives', 'Guild:/loot',
    'Officers:/admin', 'Officers:/guild-settings',
    'App:/addon', 'App:/settings', 'App:/updates', 'App:/releases',
  ]);
  assert.ok(pages.routes.find((r) => r.path === '/releases').owner);
  assert.ok(pages.routes.find((r) => r.path === '/admin').officer);
  assert.ok(pages.staticPaths.includes('/welcome'));
  assert.ok(!pages.staticPaths.some((p) => p.includes(':')));
});

test('every page module loads and exports a component', async () => {
  for (const r of pages.routes) {
    const mod = await r.load();
    assert.equal(typeof mod.default, 'function', r.path);
  }
});

test('wowhead links follow the old views/wowhead.js', () => {
  assert.equal(wh.itemUrl(19019, 'classic'), 'https://www.wowhead.com/classic/item=19019');
  assert.equal(wh.itemUrl(19019, 'retail'), 'https://www.wowhead.com/item=19019');
  assert.equal(wh.itemUrl(19019, 'forever'), 'https://www.wowhead.com/forever/item=19019');
  assert.equal(wh.wowheadData('item', 19019, 'classic'), 'item=19019&domain=classic');
  assert.equal(wh.wowheadData('item', 19019, 'retail'), 'item=19019');
  assert.equal(wh.guildGame(null), 'classic');
  assert.equal(wh.guildGame({ wowhead_game: 'retail' }), 'retail');
});

test('welcome helpers', () => {
  const { normalizeServerUrl: n, parseInviteCode: p, validBattleTag: v } = welcome;
  assert.deepEqual(n('wow.cjplumbing.co.za'), { url: 'https://wow.cjplumbing.co.za' });
  assert.deepEqual(n('https://wow.example.com/'), { url: 'https://wow.example.com' });
  assert.deepEqual(n('localhost:3000'), { url: 'http://localhost:3000' });
  assert.deepEqual(n('http://192.168.1.5:3000'), { url: 'http://192.168.1.5:3000' });
  assert.ok(n('').error);
  assert.ok(n('ftp://x.com').error);
  assert.equal(p('https://wow.example.com/join/AbC_12-x'), 'AbC_12-x');
  assert.equal(p('guildcamp://join/AbC123'), 'AbC123');
  assert.equal(p('guildcamp://join/AbC123/'), 'AbC123');
  assert.equal(p('join/AbC123'), 'AbC123');
  assert.equal(p('  AbC123  '), 'AbC123');
  assert.equal(p('https://wow.example.com/raids/12'), '');
  assert.equal(p('no spaces allowed'), '');
  assert.equal(v('Name#1234'), true);
  assert.equal(v('Name'), false);
  assert.equal(v('#1234'), false);
  assert.equal(v(`${'x'.repeat(40)}#1`), false);
});

test('welcome: first screen and labels', () => {
  const { firstStep, listLabels, hostOf } = welcome;
  assert.equal(firstStep({ signedIn: false }), 'signin');
  assert.equal(firstStep({ signedIn: true }), 'setup');
  assert.equal(firstStep({ signedIn: true, step: 'server' }), 'server');
  assert.equal(firstStep({ signedIn: false, step: 'nonsense' }), 'signin');
  assert.equal(listLabels([]), '');
  assert.equal(listLabels(['WoW Forever']), 'WoW Forever');
  assert.equal(listLabels(['WoW Forever', 'Retail']), 'WoW Forever and Retail');
  assert.equal(listLabels(['WoW Forever', 'Retail', 'WoW Forever', '', 'Classic Era']), 'WoW Forever, Retail and Classic Era');
  assert.equal(hostOf('https://wow.example.com/x'), 'wow.example.com');
  assert.equal(hostOf('not a url'), 'not a url');
});

test('welcome: guild.autoJoin result → the "Your guild" line', () => {
  const { guildView: v, mergeMembership: merge, createGuildBody } = welcome;
  const g = { id: 1, name: 'Just Now WoW', faction: 'Horde' };
  const base = { guild: g, role: null, via: null, character: null, reason: '', detected: null };

  // Nothing yet, or still asking.
  assert.equal(v({}).state, 'working');
  assert.equal(v({ checking: true }).state, 'working');

  // Joined: says who matched; officers from rank are told why.
  const joined = v({ result: { ...base, status: 'joined', role: 'member', via: 'roster', character: 'Zulgar', reason: 'Matched Zulgar.' } });
  assert.equal(joined.state, 'done');
  assert.equal(joined.title, "You're in Just Now WoW (matched Zulgar)");
  const officer = v({ result: { ...base, status: 'joined', role: 'officer', via: 'battlenet', character: 'Grimtusk' } });
  assert.match(officer.detail, /officer/);
  assert.match(officer.detail, /rank in game/);
  // The signed-in state wins once it has the guild, whatever the last check said.
  assert.equal(v({ result: { ...base, status: 'no-match', reason: 'x' }, guild: g, role: 'owner' }).state, 'done');
  assert.match(v({ guild: g, role: 'owner' }).detail, /owner/);

  // No guild on the server: offer the one from the characters, or ask for a name.
  const setup = v({ result: { ...base, guild: null, status: 'no-guild-on-server', detected: { guild: 'Just Now WoW', realm: 'Forever', faction: 'Horde' }, reason: 'Nobody has set it up.' } });
  assert.equal(setup.state, 'setup');
  assert.equal(setup.title, 'Set up Just Now WoW on this server');
  assert.match(setup.detail, /Forever, Horde/);
  assert.deepEqual(setup.detected, { guild: 'Just Now WoW', realm: 'Forever', faction: 'Horde' });
  const create = v({ result: { ...base, guild: null, status: 'no-guild-on-server', reason: 'Nobody has set up a guild on this server yet.' } });
  assert.equal(create.state, 'create');
  assert.equal(create.detail, 'Nobody has set up a guild on this server yet.');

  // Not matched yet, or invite only: the server's reason is shown as it is.
  const reason = "None of your characters are in Just Now WoW's roster yet. Ask someone in the guild to open the guild roster in game, or use an invite link.";
  const waiting = v({ result: { ...base, status: 'no-match', reason } });
  assert.equal(waiting.state, 'waiting');
  assert.equal(waiting.title, "We haven't matched you to Just Now WoW yet");
  assert.equal(waiting.detail, reason);
  assert.equal(v({ result: { ...base, guild: null, status: 'no-match', reason }, serverGuild: { name: 'Camp' } }).title, "We haven't matched you to Camp yet");
  const off = v({ result: { ...base, status: 'disabled', reason: 'Ask an officer for an invite link.' } });
  assert.equal(off.state, 'waiting');
  assert.match(off.title, /invite link/);

  // The call failed (older server, offline): say so, keep trying.
  const err = v({ error: 'The server is not answering.' });
  assert.equal(err.state, 'error');
  assert.match(err.detail, /^The server is not answering\. Guild Camp tries again/);
  assert.equal(v({ error: 'x', checking: true }).state, 'working');
  // Unknown statuses are ignored.
  assert.equal(v({ result: { status: 'weird' } }).state, 'working');

  // An 'already' right after a 'joined' keeps the matched character.
  const first = { ...base, status: 'joined', role: 'member', via: 'roster', character: 'Zulgar' };
  const merged = merge(first, { ...base, status: 'already', role: 'member', reason: 'Already in.' });
  assert.equal(merged.status, 'joined');
  assert.equal(merged.character, 'Zulgar');
  assert.equal(merge(first, null), first);
  assert.equal(merge(null, { status: 'nope' }), null);
  assert.equal(merge(first, { ...base, status: 'no-match' }).status, 'no-match');

  // "Set up <guild> on this server" body.
  assert.deepEqual(createGuildBody({ guild: ' Just Now WoW ', realm: 'Forever', faction: 'Alliance' }),
    { name: 'Just Now WoW', faction: 'Alliance', realm: 'Forever', game_guild: 'Just Now WoW' });
  assert.deepEqual(createGuildBody({ guild: 'x'.repeat(50) }), { name: 'x'.repeat(40), faction: 'Horde', game_guild: 'x'.repeat(50) });
  assert.deepEqual(createGuildBody(null), { name: '', faction: 'Horde' });
});

test('welcome: game folders and addon lines', () => {
  const { gamesView, addonView, allSet } = welcome;
  const forever = { dir: 'D:\\WoW\\_forever_', flavor: '_forever_', label: 'WoW Forever' };
  const retail = { dir: 'D:\\WoW\\_retail_', flavor: '_retail_', label: 'Retail' };

  assert.equal(gamesView(null).state, 'working');
  assert.equal(gamesView([]).state, 'attention');
  assert.match(gamesView([]).detail, /_forever_/);
  assert.equal(gamesView([], 'Access denied.').detail, 'Access denied.');
  assert.deepEqual(gamesView([forever, retail]), { state: 'done', title: 'Found World of Warcraft', detail: 'WoW Forever and Retail' });

  assert.equal(addonView({ installs: [] }).state, 'pending');
  assert.equal(addonView({ installs: [forever], addon: null }).state, 'working');
  const st = (dir, state, extra = {}) => ({ dir, state, installed: state === 'missing' ? null : { version: '0.11.1' }, busy: false, ...extra });

  const done = addonView({ installs: [forever, retail], addon: { installs: [st(forever.dir, 'current'), st(retail.dir, 'outdated')] } });
  assert.equal(done.state, 'done');
  assert.equal(done.detail, 'Guild Camp addon 0.11.1 in WoW Forever and Retail.');
  assert.deepEqual(done.missing, []);

  const partly = addonView({ installs: [forever, retail], addon: { installs: [st(forever.dir, 'current'), st(retail.dir, 'missing')] } });
  assert.equal(partly.state, 'done');
  assert.equal(partly.detail, 'In WoW Forever. Not in Retail yet.');
  assert.deepEqual(partly.missing.map((m) => m.label), ['Retail']);

  const installing = addonView({ installs: [forever, retail], addon: { installs: [st(forever.dir, 'current'), st(retail.dir, 'missing', { busy: true })] } });
  assert.equal(installing.state, 'working');
  assert.equal(installing.detail, 'Into Retail.');
  // While the addon manager checks with "install automatically" on, missing installs are about to be installed.
  assert.equal(addonView({ installs: [retail], addon: { checking: true, installs: [st(retail.dir, 'missing')] } }).state, 'working');
  const manual = addonView({ installs: [retail], addon: { checking: true, installs: [st(retail.dir, 'missing')] }, autoInstall: false });
  assert.equal(manual.state, 'attention');
  assert.match(manual.detail, /off in Settings/);

  const none = addonView({ installs: [retail], addon: { installs: [] } });
  assert.equal(none.state, 'attention');
  assert.deepEqual(none.missing.map((m) => m.dir), [retail.dir]);

  const { setupLede, guildMark } = welcome;
  assert.equal(setupLede(['done', 'done', 'done']), 'Everything is ready.');
  assert.match(setupLede(['done', 'working', 'waiting']), /few seconds/);
  assert.equal(setupLede(['attention', 'pending', 'done']), 'Almost done. One thing needs you.');
  assert.equal(setupLede(['attention', 'pending', 'attention']), 'Almost done. A few things need you.');
  assert.match(setupLede(['done', 'done', 'waiting']), /waiting to match you/);
  assert.deepEqual(['done', 'working', 'waiting', 'setup', 'create', 'error'].map(guildMark), ['done', 'working', 'waiting', 'attention', 'attention', 'attention']);

  assert.equal(allSet({ inGuild: true, games: { state: 'done' }, addon: { state: 'done' } }), true);
  assert.equal(allSet({ inGuild: false, games: { state: 'done' }, addon: { state: 'done' } }), false);
  assert.equal(allSet({ inGuild: true, games: { state: 'attention' }, addon: { state: 'pending' } }), false);
});

test('guild settings: joining choices', async () => {
  const gs = await load('pages/guild-settings.js');
  assert.deepEqual(gs.AUTO_JOIN_OPTIONS.map((o) => o.value), ['roster', 'verified', 'off']);
  assert.match(gs.AUTO_JOIN_OPTIONS[0].label, /recommended/);
  assert.deepEqual(gs.OFFICER_RANK_OPTIONS.map((o) => o.value), ['', '0', '1', '2', '3']);
  assert.equal(gs.rankToValue(undefined), '1'); // server default
  assert.equal(gs.rankToValue(null), '');
  assert.equal(gs.rankToValue(0), '0');
  assert.equal(gs.rankToValue(12), '');
  assert.equal(gs.valueToRank(''), null);
  assert.equal(gs.valueToRank('0'), 0);
  assert.equal(gs.valueToRank('3'), 3);
  assert.equal(gs.officerRankOptions(2), gs.OFFICER_RANK_OPTIONS);
  assert.deepEqual(gs.officerRankOptions(6).at(-1), { value: '6', label: 'Guild Master and 6 ranks below' });
  const guild = { auto_join: 'roster', officer_rank_max: 1 };
  assert.deepEqual(gs.joiningChanges(guild, 'roster', '1'), {});
  assert.deepEqual(gs.joiningChanges(guild, 'off', '1'), { auto_join: 'off' });
  assert.deepEqual(gs.joiningChanges(guild, 'roster', ''), { officer_rank_max: null });
  assert.deepEqual(gs.joiningChanges({ auto_join: 'verified', officer_rank_max: null }, 'roster', '0'), { auto_join: 'roster', officer_rank_max: 0 });
});

test('dev mock: guild matching, membership and the new settings', async () => {
  const gc = gcmod.gc;
  const settings = await gc.invoke('settings.get');
  assert.equal(settings.addonAutoInstall, true);
  const det = await gc.invoke('wow.detectGuild');
  assert.ok(Array.isArray(det.characters) && det.characters.length > 0);
  for (const k of ['name', 'realm', 'guild', 'faction', 'level', 'class', 'updated', 'install', 'account']) assert.ok(k in det.characters[0], k);
  assert.equal(det.guild.name, det.characters[0].guild);
  // The default preview member is already in the guild.
  const events = [];
  const off = gc.on('membership', (r) => events.push(r));
  const r = await gc.invoke('guild.autoJoin');
  off();
  assert.equal(r.status, 'already');
  for (const k of ['status', 'guild', 'role', 'via', 'character', 'reason', 'detected']) assert.ok(k in r, k);
  assert.equal(events.length, 1);
  assert.deepEqual(await gc.invoke('membership.status'), r);
  const g = await gc.api.request('GET', '/api/guild');
  assert.equal(g.guild.auto_join, 'roster');
  assert.equal(g.guild.officer_rank_max, 1);
  const saved = await gc.api.request('PUT', '/api/guild/settings', { auto_join: 'verified', officer_rank_max: null });
  assert.equal(saved.guild.auto_join, 'verified');
  assert.equal(saved.guild.officer_rank_max, null);
  await assert.rejects(gc.api.request('PUT', '/api/guild/settings', { officer_rank_max: 12 }), (err) => err.status === 400);
  const me = await gc.api.request('GET', '/api/me');
  assert.ok(me.bnet && typeof me.bnet.characters === 'number');
});

test('table sorting keeps empties last', () => {
  const cols = [{ key: 'n' }, { key: 's' }];
  const rows = [{ n: 2, s: 'b' }, { n: null, s: 'a' }, { n: 10, s: 'C' }];
  assert.deepEqual(table.sortRows(rows, cols, { key: 'n', dir: 'asc' }).map((r) => r.n), [2, 10, null]);
  assert.deepEqual(table.sortRows(rows, cols, { key: 'n', dir: 'desc' }).map((r) => r.n), [10, 2, null]);
  assert.deepEqual(table.sortRows(rows, cols, { key: 's', dir: 'asc' }).map((r) => r.s), ['a', 'b', 'C']);
});

test('status summaries', () => {
  assert.equal(status.describeSync({ state: 'error' }).kind, 'alarm');
  assert.equal(status.describeSync({ state: 'idle', lastSyncAt: 'x' }).label, 'Synced');
  assert.equal(status.describeSync(null).kind, 'muted');
  assert.equal(status.describeUpdates({ state: 'downloaded' }, null).label, 'Restart to update');
  assert.equal(status.describeUpdates({ state: 'idle' }, { installs: [{ state: 'outdated' }, { state: 'outdated' }] }).label, '2 addon updates');
  assert.equal(status.describeUpdates({ state: 'idle' }, { installs: [] }), null);
});

test('gc wrapper cleans Electron error text and uses the mock outside Electron', async () => {
  const e = gcmod.toError(new Error("Error invoking remote method 'gc:invoke': Error: The server is not answering."));
  assert.equal(e.message, 'The server is not answering.');
  const t = gcmod.toError({ message: '[404] Raid not found.' });
  assert.equal(t.status, 404);
  assert.equal(t.message, 'Raid not found.');
  assert.equal(gcmod.isMock, true);
  const meta = await gcmod.gc.api.request('GET', '/api/meta');
  assert.equal(meta.server, 'guild-camp');
  await assert.rejects(gcmod.gc.api.request('GET', '/api/does-not-exist'), (err) => err.status === 404);
  assert.equal(api.qs({ q: 'ore', page: 2, x: '', y: null, z: true }), '?q=ore&page=2&z=1');
});

// ---------- Wowhead tooltips drawn by the app (lib/tooltip.js) ----------

test("tooltip data address: the same request as Wowhead's tooltips.js, per guild game", () => {
  assert.deepEqual(tt.parseWowheadData('item=19019&domain=classic'), { kind: 'item', id: 19019, domain: 'classic' });
  assert.deepEqual(tt.parseWowheadData('spell=17187&domain=forever'), { kind: 'spell', id: 17187, domain: 'forever' });
  assert.deepEqual(tt.parseWowheadData('item=19019'), { kind: 'item', id: 19019, domain: '' });
  assert.deepEqual(tt.parseWowheadData('item=19019&domain=ptr-of-doom'), { kind: 'item', id: 19019, domain: '' }, 'unknown domains are Retail, as on Wowhead');
  for (const bad of ['', 'item=abc', 'item=0', 'npc=1', 'item=1e3', null, 42]) assert.equal(tt.parseWowheadData(bad), null, String(bad));

  assert.equal(tt.tooltipUrl('item=19019&domain=classic'), 'https://nether.wowhead.com/tooltip/item/19019?dataEnv=4&locale=0');
  assert.equal(tt.tooltipUrl('item=19019&domain=forever'), 'https://nether.wowhead.com/tooltip/item/19019?dataEnv=16&locale=0');
  assert.equal(tt.tooltipUrl('spell=17187'), 'https://nether.wowhead.com/tooltip/spell/17187?dataEnv=1&locale=0');
  assert.equal(tt.tooltipUrl({ kind: 'item', id: 5, domain: 'classic' }), 'https://nether.wowhead.com/tooltip/item/5?dataEnv=4&locale=0');
  assert.equal(tt.tooltipUrl({ kind: 'npc', id: 5 }), null);
  assert.equal(tt.tooltipUrl('nope'), null);
  // What ItemLink / SpellLink render is understood for every game.
  const envs = Object.fromEntries(wh.GAMES.map((game) => [game, tt.tooltipUrl(wh.wowheadData('item', 19019, game))]));
  assert.deepEqual(envs, {
    forever: 'https://nether.wowhead.com/tooltip/item/19019?dataEnv=16&locale=0',
    retail: 'https://nether.wowhead.com/tooltip/item/19019?dataEnv=1&locale=0',
    classic: 'https://nether.wowhead.com/tooltip/item/19019?dataEnv=4&locale=0',
  });

  assert.equal(tt.iconUrl('inv_sword_39'), 'https://wow.zamimg.com/images/wow/icons/medium/inv_sword_39.jpg');
  assert.equal(tt.iconUrl('INV_Misc_StoneTablet_05'), 'https://wow.zamimg.com/images/wow/icons/medium/inv_misc_stonetablet_05.jpg');
  for (const bad of ['../x', 'a b', 'x.jpg', 'https://evil.example/x', '', null]) assert.equal(tt.iconUrl(bad), null, String(bad));
});

test("tooltip sanitiser keeps Wowhead's markup and drops scripts, styles, handlers and links", () => {
  const S = tt.sanitizeTooltipHtml;
  // A real (shortened) reply: tables, quality classes, comments, an inline link.
  const real = '<table><tr><td><!--nstart--><b class="q5">Thunderfury, Blessed Blade of the Windseeker</b><!--nend--><span class="q"><br>Item Level <!--ilvl-->80</span>'
    + '<table width="100%"><tr><td>One-Hand</td><th><!--scstart2:7--><span class="q1">Sword</span><!--scend--></th></tr></table></td></tr></table>'
    + '<table><tr><td><span id="useText1" class="q2">Chance on hit: <a href="/classic/spell=21992/thunderfury" class="q2">Blasts your enemy &nbsp;with lightning.</a></span>'
    + '<div class="whtt-sellprice">Sell Price: <span class="moneygold">15</span> <span class="moneysilver">10</span></div><br /></td></tr></table>';
  assert.equal(S(real),
    '<table><tr><td><b class="q5">Thunderfury, Blessed Blade of the Windseeker</b><span class="q"><br>Item Level 80</span>'
    + '<table><tr><td>One-Hand</td><th><span class="q1">Sword</span></th></tr></table></td></tr></table>'
    + '<table><tr><td><span class="q2">Chance on hit: <a class="q2">Blasts your enemy &nbsp;with lightning.</a></span>'
    + '<div class="whtt-sellprice">Sell Price: <span class="moneygold">15</span> <span class="moneysilver">10</span></div><br></td></tr></table>');

  // Scripts and styles go, contents included.
  assert.equal(S('a<script>alert(1)</script>b<SCRIPT type="x">alert(2)</SCRIPT >c'), 'abc');
  assert.equal(S('<style>body{display:none}</style><b>x</b>'), '<b>x</b>');
  assert.equal(S('<script>never closed <b>bold</b>'), '');
  assert.equal(S('<svg><script>alert(1)</script><a>x</a></svg>y'), 'y');
  assert.equal(S('<noscript><p title="</noscript><img src=x onerror=alert(1)>">'), '"&gt;');
  assert.equal(S('<iframe src="javascript:alert(1)"></iframe><template><b>t</b></template>z'), 'z');
  // Event handlers, style, id, src, href: every attribute except class is removed.
  assert.equal(S('<span onclick="alert(1)" onmouseover=alert(2) style="position:fixed" id="x" class="q3">x</span>'), '<span class="q3">x</span>');
  assert.equal(S('<div class="q1" ONLOAD="x" data-x="1" title="t">y</div>'), '<div class="q1">y</div>');
  // Links keep their text only: javascript: links and Wowhead links alike.
  assert.equal(S('<a href="javascript:alert(1)">click</a>'), '<a>click</a>');
  assert.equal(S('<a href="https://www.wowhead.com/item=1" target="_blank" class="q4">Item</a>'), '<a class="q4">Item</a>');
  // Tags that are not allowed are dropped, their text kept and escaped.
  assert.equal(S('<img src=x onerror=alert(1)>pic<input value="v"><p>para</p><h1>h</h1>'), 'picparah');
  assert.equal(S('<object data="x"><b>in</b></object>after'), 'after');
  // Only Wowhead's own class names survive (the app's classes can't be borrowed).
  assert.equal(S('<div class="modal-backdrop q4 whtt-extra indent toasts">x</div>'), '<div class="q4 whtt-extra indent">x</div>');
  assert.equal(S('<span class="  ">x</span>'), '<span>x</span>');
  // Text is escaped; well-formed character references stay text; tags are balanced.
  assert.equal(S('1 < 2 & 3 > 2 &amp; &#60;script&#62; &bogus'), '1 &lt; 2 &amp; 3 &gt; 2 &amp; &#60;script&#62; &amp;bogus');
  assert.equal(S('<b><i>open'), '<b><i>open</i></b>');
  assert.equal(S('</div></b>text<br/></br>'), 'text<br>');
  assert.equal(S('<b><span>x</b>y</span>'), '<b><span>x</span></b>y');
  assert.equal(S('<!-- a --><!doctype html><?xml x?>ok<!-- never closed'), 'ok');
  assert.equal(S('<span class="q1>broken'), '', 'a tag that never ends swallows the rest, like a browser');
  assert.equal(S('<b title=">">x</b>'), '<b>x</b>', 'a > inside a quoted value does not end the tag');
  assert.equal(S(null), '');
  // Nothing that could run survives, whatever goes in.
  const nasty = ['<img src=x onerror=alert(1)>', '<a href=javascript:alert(1)>x', '<svg/onload=alert(1)>', '<body onload=alert(1)>',
    '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>', '<<script>script>alert(1)<</script>/script>', '<scr<script>ipt>alert(1)</script>',
    '"><script>alert(1)</script>', '<div style="background:url(javascript:alert(1))">x</div>', '<a href="&#106;avascript:alert(1)">x</a>',
    '<form action="javascript:alert(1)"><button>x</button></form>', '<base href="https://evil.example/">', '<meta http-equiv="refresh" content="0;url=https://evil.example">',
    '<link rel="stylesheet" href="https://evil.example/x.css">', '<b style="x" onclick="y">ok</b>', '<span class="q1" src="x" href="y">ok</span>'];
  const allowedTag = /^<\/?(table|tbody|tr|td|th|div|span|b|i|small|br|a)( class="[\w -]+")?>$/;
  for (const n of nasty) {
    const out = S(n);
    for (const tag of out.match(/<[^>]*>/g) || []) assert.match(tag, allowedTag, `${n} → ${out}`);
    assert.doesNotMatch(out, /<(?![/a-z])/i, n);
  }
});

test('tooltip replies are read defensively', () => {
  const r = tt.readTooltip({ name: 'Arcanite Bar', quality: 2, icon: 'inv_misc_stonetablet_05', tooltip: '<b class="q2" onclick="x">Arcanite Bar</b><script>bad()</script>' });
  assert.deepEqual(r, { name: 'Arcanite Bar', quality: 2, icon: 'https://wow.zamimg.com/images/wow/icons/medium/inv_misc_stonetablet_05.jpg', html: '<b class="q2">Arcanite Bar</b>' });
  assert.equal(tt.readTooltip({ error: 'ID is out of range' }), null);
  assert.equal(tt.readTooltip(null), null);
  assert.equal(tt.readTooltip([1]), null);
  assert.deepEqual(tt.readTooltip({ name: 'X', quality: 99, icon: '../../evil', tooltip: 5 }), { name: 'X', quality: null, icon: null, html: '' });
  // initTooltips is safe to call outside a browser (no document).
  assert.doesNotThrow(() => tt.initTooltips());
  assert.equal(typeof wh.watchTooltips(null), 'function');
});

test('no third-party script runs in the app window (Content-Security-Policy)', async () => {
  const { readFile } = await import('node:fs/promises');
  const { createHash } = await import('node:crypto');
  const page = await readFile(new URL('../src/renderer/index.html', import.meta.url), 'utf8');
  const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(page)[1];
  const dir = Object.fromEntries(csp.split(';').map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v]));
  assert.ok(dir['script-src'].every((v) => v === "'self'" || /^'sha256-/.test(v)), `script-src: ${dir['script-src'].join(' ')}`);
  assert.ok(!/<script[^>]+src=["']?https?:/i.test(page), 'no remote <script src>');
  assert.ok(!page.includes('tooltips.js') && !page.includes('wowhead-config'), "Wowhead's script is gone");
  assert.deepEqual(dir['connect-src'], ["'self'", 'https://nether.wowhead.com']);
  assert.ok(dir['img-src'].includes('https://wow.zamimg.com'), 'item icons');
  assert.match(page, /href="\.\/styles\/tooltip\.css"/);
  // The hash still matches the inline import map (scripts/vendor.js keeps it current).
  const map = /<script type="importmap">([\s\S]*?)<\/script>/.exec(page)[1];
  assert.ok(dir['script-src'].includes(`'sha256-${createHash('sha256').update(map, 'utf8').digest('base64')}'`));
});

test("a 403 reloads the profile once, so a demoted officer's nav catches up", async () => {
  const g = gcmod.gc;
  const realRequest = g.api.request;
  const realState = g.auth.state;
  const asked = [];
  g.auth.state = async (opts) => { asked.push(opts || null); return { signedIn: true, user: { id: 1 }, guild: { id: 1 }, role: 'member' }; };
  g.api.request = async () => { throw Object.assign(new Error('Officers only.'), { status: 403 }); };
  try {
    session.setSession({ signedIn: true, user: { id: 1 }, guild: { id: 1 }, role: 'officer' });
    await assert.rejects(api.api.get('/api/admin/audit'), (err) => err.status === 403 && err.message === 'Officers only.');
    await assert.rejects(api.api.post('/api/raids', {}), (err) => err.status === 403);
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(asked, [{ refresh: true }], 'one profile reload for a burst of 403s');
    assert.equal(session.getSession().role, 'member');
    assert.equal(session.getSession().isOfficer, false);
    // Other failures don't reload anything; a later 403 (after the gap) does again.
    assert.equal(api.recheckRoleAfter({ status: 404 }), false);
    assert.equal(api.recheckRoleAfter({ status: 403 }, Date.now() + api.ROLE_CHECK_GAP_MS + 1), true);
  } finally {
    g.api.request = realRequest;
    g.auth.state = realState;
  }
});
