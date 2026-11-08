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
    'Guild:/roster', 'Guild:/bank', 'Guild:/prices', 'Guild:/drives', 'Guild:/loot', 'Guild:/guild-settings',
    'Officers:/admin',
    'App:/addon', 'App:/settings', 'App:/updates', 'App:/releases',
  ]);
  // Releases shows on a PC that can publish (publisher.status().canPublish), not by guild role.
  const releases = pages.routes.find((r) => r.path === '/releases');
  assert.ok(releases.publisher);
  assert.ok(!releases.owner && !releases.officer);
  assert.ok(pages.routes.find((r) => r.path === '/admin').officer);
  // Guild settings is for everyone: the Coach budget and tooltips are each player's own; ranks are the Guild Master's.
  const gs = pages.routes.find((r) => r.path === '/guild-settings');
  assert.ok(!gs.officer && !gs.owner);
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

test('welcome: first screen, the Battle.net line and labels', () => {
  const { firstStep, listLabels, signInMessage, bnetView, welcomeName } = welcome;
  // The first screen until the person signed in to Battle.net, chose to go on without it, or finished setup.
  assert.equal(firstStep({}), 'start');
  assert.equal(firstStep({ bnetSignedIn: true }), 'setup');
  assert.equal(firstStep({ withoutBnet: true }), 'setup');
  assert.equal(firstStep({ onboarded: true }), 'setup');
  assert.equal(firstStep({ bnetSignedIn: true, step: 'start' }), 'start');
  assert.equal(firstStep({ step: 'nonsense' }), 'start');
  assert.equal(listLabels([]), '');
  assert.equal(listLabels(['WoW Forever']), 'WoW Forever');
  assert.equal(listLabels(['WoW Forever', 'Retail']), 'WoW Forever and Retail');
  assert.equal(listLabels(['WoW Forever', 'Retail', 'WoW Forever', '', 'Classic Era']), 'WoW Forever, Retail and Classic Era');

  // Sign-in failures are shown as the main process words them; cancelling yourself says nothing.
  assert.equal(signInMessage({ code: 'cancelled', message: 'Sign-in was cancelled.' }), '');
  assert.equal(signInMessage({ code: 'timeout', message: 'Battle.net sign-in took too long.' }), 'Battle.net sign-in took too long.');
  assert.match(signInMessage({ code: 'x' }), /didn't work/);
  assert.equal(signInMessage(null), '');

  // The Battle.net line: hidden without built-in credentials, optional before sign-in, done after.
  assert.equal(bnetView({ available: false }), null);
  assert.equal(bnetView(null), null);
  const optional = bnetView({ available: true });
  assert.equal(optional.state, 'pending');
  assert.equal(optional.title, 'Battle.net (optional)');
  assert.match(optional.detail, /Everything works without it/);
  assert.equal(bnetView({ available: true, signingIn: true }).state, 'working');
  assert.deepEqual(bnetView({ available: true, signedIn: true, battletag: 'Zulgar#1234', characters: [{}, {}] }),
    { state: 'done', title: 'Signed in as Zulgar#1234', detail: 'Battle.net shows 2 characters on your account.' });
  assert.match(bnetView({ signedIn: true, battletag: 'Zulgar#1234', characters: [] }).detail, /no World of Warcraft characters/);

  // The heading uses the BattleTag's name, else the name the local data knows ("You" means none).
  assert.equal(welcomeName({ battletag: 'Zulgar#1234', user: { battletag: 'Zulgar#1234' } }), 'Zulgar');
  assert.equal(welcomeName({ battletag: null, user: { battletag: 'Mokra' } }), 'Mokra');
  assert.equal(welcomeName({ battletag: null, user: { battletag: 'You' } }), '');
  assert.equal(welcomeName(null), '');
});

test('welcome: the "Your guild" line comes from the game', () => {
  const { guildView } = welcome;
  const waiting = guildView({});
  assert.equal(waiting.state, 'waiting');
  assert.equal(waiting.title, 'Waiting for your guild');
  assert.equal(waiting.detail, 'Log in to World of Warcraft once with the addon. Guild Camp picks up your guild by itself.');
  const g = { id: 1, name: 'Just Now WoW', realm: 'Mirage Raceway', faction: 'Horde' };
  assert.deepEqual(guildView({ guild: g, role: 'member' }),
    { state: 'done', title: "You're in Just Now WoW (Mirage Raceway, Horde)", detail: 'Your characters and guild news stay in sync while you play.' });
  assert.match(guildView({ guild: g, role: 'owner' }).detail, /Guild Master/);
  assert.match(guildView({ guild: g, role: 'officer' }).detail, /guild rank makes you an officer/);
  assert.equal(guildView({ guild: { name: 'Camp' } }).title, "You're in Camp");
  assert.equal(guildView({ guild: { id: 3 } }).state, 'waiting', 'a guild without a name is not shown yet');
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

  // The automatic install waits while the game runs (main-1): the line says so, and a click still installs it.
  const waiting = addonView({ installs: [retail], addon: { installs: [st(retail.dir, 'missing', { waitingForGame: true })] } });
  assert.equal(waiting.state, 'attention');
  assert.equal(waiting.detail, 'Guild Camp installs it once World of Warcraft is closed. You can also install it now with one click.');
  assert.deepEqual(waiting.missing.map((m) => m.dir), [retail.dir]);

  const { setupLede } = welcome;
  assert.equal(setupLede(['done', 'done', 'done']), 'Everything is ready.');
  assert.match(setupLede(['done', 'working', 'waiting']), /few seconds/);
  assert.equal(setupLede(['attention', 'pending', 'done']), 'Almost done. One thing needs you.');
  assert.equal(setupLede(['attention', 'pending', 'attention']), 'Almost done. A few things need you.');
  assert.equal(setupLede(['done', 'done', 'waiting']), 'Almost done. Guild Camp is waiting for your guild.');

  assert.equal(allSet({ inGuild: true, games: { state: 'done' }, addon: { state: 'done' } }), true);
  assert.equal(allSet({ inGuild: false, games: { state: 'done' }, addon: { state: 'done' } }), false);
  assert.equal(allSet({ inGuild: true, games: { state: 'attention' }, addon: { state: 'pending' } }), false);
});

test('session: the local guild data plus the Battle.net sign-in', () => {
  const { buildSession, normalizeBnet, splitBattleTag, EMPTY_BNET } = session;
  const me = { user: { id: 1, battletag: 'Mokra' }, guild: { id: 2, name: 'Just Now WoW' }, role: 'officer', notifyPrefs: {} };

  const local = buildSession(me, { available: true, signedIn: false });
  assert.equal(local.loaded, true);
  assert.equal(local.ready, true);
  assert.equal(local.signedIn, true, 'kept for older code: the local data answered');
  assert.equal(local.guild.name, 'Just Now WoW');
  assert.equal(local.role, 'officer');
  assert.equal(local.battletag, null);
  assert.equal(local.name, 'Mokra');
  assert.equal(local.bnet.available, true);

  const withBnet = buildSession(me, { available: true, signedIn: true, battletag: 'Zulgar#1234', characters: [{ name: 'Zulgar' }], region: 'us', canRefresh: true });
  assert.equal(withBnet.battletag, 'Zulgar#1234');
  assert.equal(withBnet.user.battletag, 'Zulgar#1234', 'the BattleTag shows before the local data catches up');
  assert.equal(me.user.battletag, 'Mokra', 'the answer itself is not changed');
  assert.equal(withBnet.name, 'Zulgar#1234');
  assert.equal(withBnet.bnet.region, 'us');
  assert.equal(withBnet.bnet.characters.length, 1);

  // Roles only come with a guild, and only known ones.
  assert.equal(buildSession({ user: { id: 1 }, guild: null, role: 'owner' }, null).role, null);
  assert.equal(buildSession({ user: {}, guild: { name: 'G' }, role: 'king' }, null).role, null);
  assert.equal(buildSession({ user: {}, guild: { name: 'G', role: 'owner' } }, null).role, 'owner');

  // Nothing could be read.
  const none = buildSession(null, null, { error: 'Guild Camp could not read your guild data.' });
  assert.equal(none.loaded, true);
  assert.equal(none.ready, false);
  assert.equal(none.signedIn, false);
  assert.equal(none.user, null);
  assert.equal(none.error, 'Guild Camp could not read your guild data.');
  assert.deepEqual(none.bnet, EMPTY_BNET);

  // A signed-out Battle.net state carries no BattleTag or characters, whatever it was sent with.
  assert.deepEqual(normalizeBnet({ signedIn: false, battletag: 'X#1', characters: [1], canRefresh: true, error: 'Sign in again.' }), { ...EMPTY_BNET, error: 'Sign in again.' });
  assert.deepEqual(splitBattleTag('Zulgar#1234'), { name: 'Zulgar', digits: '1234' });
  assert.deepEqual(splitBattleTag('Mokra'), { name: 'Mokra', digits: '' });
  assert.deepEqual(splitBattleTag(null), { name: '', digits: '' });
});

test('settings helpers', async () => {
  const st = await load('pages/settings.js');
  assert.deepEqual(st.SECTIONS.map((x) => x.id), ['guild', 'battlenet', 'notifications', 'discord', 'coach', 'calendar', 'app', 'about']);
  // Your guild: set-up guilds first, then guilds only in the saved data, with the characters seen in each.
  const options = st.guildOptions(
    { guilds: [{ id: 1, name: 'Aunt bessys', realm: 'Silvermoon', myCharacters: 1 }, { id: 2, name: 'Cheesy Dreamboys', realm: null, myCharacters: 0 }] },
    { characters: [
      { name: 'Gorm', guild: 'cheesy dreamboys', realm: 'CAMWOW' },
      { name: 'Actual', guild: 'Cheesy Dreamboys', realm: 'CAMWOW' },
      { name: 'Pit', guild: 'Other Lot', realm: 'CAMWOW', faction: 'Horde', updated: 5 },
      { name: 'Loner', guild: null },
    ] });
  assert.deepEqual(options.map((o) => [o.id, o.name, o.characters, o.known]),
    [[1, 'Aunt bessys', [], true], [2, 'Cheesy Dreamboys', ['Gorm', 'Actual'], true], [null, 'Other Lot', ['Pit'], false]]);
  assert.deepEqual(st.guildOptions(null, null), []);
  assert.equal(st.sectionFor('account'), 'battlenet', 'older links still work');
  assert.equal(st.sectionFor('discord'), 'discord');
  assert.equal(st.sectionFor('devices'), null);
  assert.equal(st.sectionFor(undefined), null);

  assert.deepEqual(st.REGIONS.map((r) => r.value), ['eu', 'us', 'kr', 'tw']);
  assert.equal(st.regionLabel('us'), 'Americas and Oceania');
  assert.equal(st.regionLabel('nope'), 'Europe');
  assert.equal(st.gameLabel('profile-eu'), 'Retail');
  assert.equal(st.gameLabel('profile-classic-eu'), 'Classic');
  assert.equal(st.gameLabel('profile-classic1x-us'), 'Classic Era');
  assert.equal(st.gameLabel(''), 'World of Warcraft');

  // Discord webhooks: the same rule as the main process; the token part is never shown.
  assert.equal(st.isWebhookUrl('https://discord.com/api/webhooks/123456789012345678/AbC-dEf_gh'), true);
  assert.equal(st.isWebhookUrl(' https://discordapp.com/api/webhooks/1/x '), true);
  assert.equal(st.isWebhookUrl('http://discord.com/api/webhooks/1/x'), false);
  assert.equal(st.isWebhookUrl('https://evil.example/api/webhooks/1/x'), false);
  assert.equal(st.isWebhookUrl(null), false);
  const masked = st.maskWebhook('https://discord.com/api/webhooks/123456789012345678/AbC-dEf_gh');
  assert.equal(masked, 'discord.com/api/webhooks/123456…/••••');
  assert.doesNotMatch(masked, /AbC/);
  assert.equal(st.maskWebhook(''), '');
  assert.equal(st.maskWebhook('something odd'), 'A webhook is set.');

  // Anthropic keys: checked before they are sent, and never shown.
  assert.match(st.keyProblem(''), /Paste your key/);
  assert.match(st.keyProblem('sk-ant api03'), /no spaces/);
  assert.match(st.keyProblem('sk-ant-short'), /starts with sk-ant-/);
  assert.equal(st.keyProblem(`  sk-ant-api03-${'x'.repeat(40)}  `), '');
});

test('guild settings: officer ranks', async () => {
  const gs = await load('pages/guild-settings.js');
  // Off (null) and 0 both mean "only the Guild Master"; the core's default is 1.
  assert.equal(gs.rankToValue(undefined), '1');
  assert.equal(gs.rankToValue(null), '0');
  assert.equal(gs.rankToValue(0), '0');
  assert.equal(gs.rankToValue(3), '3');
  assert.equal(gs.rankToValue(12), '0');
  assert.equal(gs.valueToRank('0'), 0);
  assert.equal(gs.valueToRank('3'), 3);
  assert.equal(gs.valueToRank(''), 0);
  assert.deepEqual(gs.rankChange({ officer_rank_max: 1 }, '1'), {});
  assert.deepEqual(gs.rankChange({ officer_rank_max: null }, '0'), {}, 'off and 0 are the same choice');
  assert.deepEqual(gs.rankChange({ officer_rank_max: 1 }, '2'), { officer_rank_max: 2 });
  assert.deepEqual(gs.rankChange({ officer_rank_max: 2 }, '0'), { officer_rank_max: 0 });

  // Without rank names the choices count ranks; with them they read like the game.
  assert.deepEqual(gs.officerRankOptions(1).map((o) => o.value), ['0', '1', '2', '3']);
  assert.equal(gs.officerRankOptions(1)[0].label, 'Only the Guild Master');
  assert.equal(gs.officerRankOptions(1)[2].label, 'Guild Master and 2 ranks below');
  assert.equal(gs.officerRankOptions(6).at(-1).value, '6', 'the saved value is always offered');
  const names = new Map([[0, 'Warchief'], [1, 'Officer'], [2, 'Veteran'], [3, 'Member'], [4, 'Initiate']]);
  const opts = gs.officerRankOptions(1, names);
  assert.deepEqual(opts.map((o) => o.value), ['0', '1', '2', '3', '4']);
  assert.equal(opts[1].label, 'Guild Master and Officer');
  assert.equal(opts[2].label, 'Guild Master, Officer and Veteran');
  assert.equal(opts[3].label, 'Guild Master and the 3 ranks below (Officer, Veteran, Member)');

  // The ranks table: one row per in-game rank, with the role it gives.
  const chars = [
    { name: 'A', rank: 'Warchief', rank_index: 0, online: 1 }, { name: 'B', rank: 'Officer', rank_index: 1 },
    { name: 'C', rank: 'Veteran', rank_index: 2, online: 1 }, { name: 'D', rank: 'Veteran', rank_index: 2 },
    { name: 'E', rank: null, rank_index: null }, { name: 'F', rank_index: 5 },
  ];
  assert.deepEqual(gs.rankRows(chars, 1), [
    { index: 0, name: 'Warchief', characters: 1, online: 1, role: 'owner' },
    { index: 1, name: 'Officer', characters: 1, online: 0, role: 'officer' },
    { index: 2, name: 'Veteran', characters: 2, online: 1, role: 'member' },
    { index: 5, name: 'Rank 5', characters: 1, online: 0, role: 'member' },
  ]);
  assert.equal(gs.rankRows(chars, 2)[2].role, 'officer');
  assert.equal(gs.rankRows(chars, null)[1].role, 'member');
  assert.deepEqual(gs.rankRows(undefined, 1), []);
});

test('guild settings: who passes on officer changes', async () => {
  const gs = await load('pages/guild-settings.js');
  // null means officers only; a value at or above the officer ranks adds nobody, so it reads the same.
  assert.equal(gs.relayToValue(null, 1), 'none');
  assert.equal(gs.relayToValue(undefined, 1), 'none');
  assert.equal(gs.relayToValue(1, 1), 'none');
  assert.equal(gs.relayToValue(0, 1), 'none');
  assert.equal(gs.relayToValue(3, 1), '3');
  assert.equal(gs.relayToValue(12, 1), 'none');
  assert.equal(gs.valueToRelay('none'), null);
  assert.equal(gs.valueToRelay('3'), 3);
  assert.equal(gs.valueToRelay('x'), null);
  assert.deepEqual(gs.relayChange({ officer_rank_max: 1, relay_rank_max: null }, 'none'), {});
  assert.deepEqual(gs.relayChange({ officer_rank_max: 1, relay_rank_max: 1 }, 'none'), {}, 'already officers only');
  assert.deepEqual(gs.relayChange({ officer_rank_max: 1, relay_rank_max: null }, '2'), { relay_rank_max: 2 });
  assert.deepEqual(gs.relayChange({ officer_rank_max: 1, relay_rank_max: 3 }, 'none'), { relay_rank_max: null });
  assert.deepEqual(gs.relayChange({ officer_rank_max: 1, relay_rank_max: 3 }, '3'), {});

  // Choices start below the officer ranks and read like the game when the roster knows the rank names.
  const names = new Map([[0, 'Warchief'], [1, 'Officer'], [2, 'Veteran'], [3, 'Member'], [4, 'Initiate']]);
  const opts = gs.relayOptions({ officer_rank_max: 1, relay_rank_max: null }, names);
  assert.deepEqual(opts.map((o) => o.value), ['none', '2', '3', '4']);
  assert.deepEqual(opts.map((o) => o.label), [
    'Only officers', 'Officers and Veteran', 'Officers, Veteran and Member', 'Officers and the 3 ranks below them (Veteran, Member, Initiate)',
  ]);
  const plain = gs.relayOptions({ officer_rank_max: 2, relay_rank_max: 6 });
  assert.equal(plain[1].value, '3');
  assert.equal(plain[1].label, 'Officers and 1 rank below them');
  assert.equal(plain.at(-1).value, '6', 'the saved value is always offered');
  assert.equal(gs.relayOptions({ officer_rank_max: 9 }).length, 1, 'no ranks left below the officers');
});

test('sharing: status groups, plain lines and author checks', async () => {
  assert.deepEqual(status.SHARE_LINES, {
    saved: 'Saved. It goes to your guild the next time you log in or type /reload.',
    newData: 'New guild data shows here after you log out or type /reload in game.',
    instance: 'Waiting until you leave the dungeon.',
    officer: 'Log in on an officer character to send this.',
    stale: 'Someone changed this in the meantime. Check it and try again.',
  });
  const now = Date.parse('2026-11-08T12:00:00Z');
  const groups = status.shareGroups({
    outbox: [
      { op: 'o1', state: 'queued', createdAt: '2026-11-08 11:00:00' },
      { op: 'o2', state: 'waiting', note: status.SHARE_LINES.officer, createdAt: '2026-11-08 10:00:00' },
      { op: 'o3', state: 'sent', createdAt: '2026-11-08 09:00:00', sentAt: '2026-11-08 09:30:00' },
      null,
    ],
    refused: [
      { op: 'o4', state: 'refused', note: status.SHARE_LINES.stale, createdAt: '2026-11-07 10:00:00', sentAt: '2026-11-07 12:00:00' },
      { op: 'o5', state: 'refused', createdAt: '2026-10-01 10:00:00', sentAt: '2026-10-02 10:00:00' },
      { op: 'o6', state: 'refused' },
    ],
    authorChecks: [{ id: 3, summary: 'Sign-up for Molten Core: not coming', via: 'Kazgul' }, { summary: 'no id' }],
  }, now);
  assert.deepEqual(groups.waiting.map((e) => e.op), ['o1', 'o2']);
  assert.deepEqual(groups.sent.map((e) => e.op), ['o3']);
  assert.deepEqual(groups.refused.map((e) => e.op), ['o4', 'o6'], 'refused changes older than 14 days are left out');
  assert.deepEqual(groups.checks.map((c) => c.id), [3]);
  assert.deepEqual(status.shareGroups(null), { waiting: [], sent: [], refused: [], checks: [] });

  assert.deepEqual(status.shareStateLabel({ state: 'waiting' }), { kind: 'warn', label: 'Waiting' });
  assert.deepEqual(status.shareStateLabel({ state: 'refused' }), { kind: 'alarm', label: 'Not sent' });
  assert.equal(status.shareStateLabel({ state: 'queued' }).kind, 'info');
  assert.equal(status.shareStateLabel(null).label, 'Unknown');

  // The dungeon line only when the game said it is waiting for the player to leave one.
  assert.equal(status.waitingForDungeon({ outbox: [{ state: 'waiting', note: status.SHARE_LINES.officer }] }), false);
  assert.equal(status.waitingForDungeon({ outbox: [{ state: 'waiting', note: status.SHARE_LINES.instance }] }), true);
  assert.equal(status.waitingForDungeon({ outbox: [{ state: 'sent', note: status.SHARE_LINES.instance }] }), false);

  // docs/SHARING.md §5, word for word.
  assert.equal(status.authorCheckText({ summary: 'Sign-up for Molten Core: not coming', via: 'Kazgul' }),
    "A change in your name arrived that this computer didn't make: Sign-up for Molten Core: not coming. Passed on by Kazgul.");
  assert.equal(status.authorCheckText({ summary: 'Notice: hi.', via: null }),
    "A change in your name arrived that this computer didn't make: Notice: hi.");

  // "No guild yet": the core's code, or its sentence when the code was lost on the way.
  assert.equal(status.isNoGuild({ status: 403, code: 'NO_GUILD', message: 'x' }), true);
  assert.equal(status.isNoGuild({ status: 403, message: status.NO_GUILD_TEXT }), true);
  assert.equal(status.isNoGuild({ status: 403, message: 'Only officers can do that.' }), false);
  assert.equal(status.isNoGuild(null), false);
  const ng = await load('components/NoGuild.js');
  assert.equal(ng.noGuildText(null), status.NO_GUILD_TEXT);
  assert.equal(ng.noGuildText({ status: 403, code: 'NO_GUILD', message: 'Play once first.' }), 'Play once first.');
  assert.equal(ng.noGuildText(new Error('Something else.')), status.NO_GUILD_TEXT);

  const st = await load('pages/settings.js');
  assert.equal(st.webhookOfferText({ from: 'Velanne', at: 'x' }), 'Velanne shared a Discord webhook. Use it?');
  assert.equal(st.webhookOfferText({ from: null }), 'An officer shared a Discord webhook. Use it?');
  assert.equal(st.webhookOfferText(null), '');
});

test('app gate: the welcome flow until setup is done, then pages wait for the guild', () => {
  const { pageGate, isOnboarded, GUILDLESS_PATHS } = session;
  const camp = pages.routes.find((r) => r.path === '/');
  const addon = pages.routes.find((r) => r.path === '/addon');
  const welcomeRoute = pages.routes.find((r) => r.path === '/welcome');
  const inGuild = { loaded: true, ready: true, guild: { id: 1, name: 'Camp' } };
  const noGuild = { loaded: true, ready: true, guild: null };

  // The bug this replaces: no guild used to send people back to /welcome, and "Done" bounced.
  assert.equal(pageGate({ route: camp, session: noGuild, onboarded: true }), 'no-guild');
  assert.equal(pageGate({ route: camp, session: inGuild, onboarded: true }), 'page');
  assert.equal(pageGate({ route: camp, session: inGuild, onboarded: false }), 'welcome');
  assert.equal(pageGate({ route: camp, session: noGuild, onboarded: false, smoke: true }), 'no-guild', 'a smoke run never stops at the welcome flow');
  assert.equal(pageGate({ route: camp, session: { loaded: false }, onboarded: true }), 'loading');
  assert.equal(pageGate({ route: camp, session: { loaded: true, ready: false, guild: null }, onboarded: true }), 'unavailable');
  // App pages work without a guild; the welcome page is always reachable.
  for (const p of ['/addon', '/settings', '/updates', '/releases']) assert.ok(GUILDLESS_PATHS.includes(p), p);
  assert.equal(pageGate({ route: addon, session: noGuild, onboarded: true }), 'page');
  assert.equal(pageGate({ route: addon, session: { loaded: false }, onboarded: true }), 'page');
  assert.equal(pageGate({ route: addon, session: noGuild, onboarded: false }), 'welcome');
  assert.equal(pageGate({ route: welcomeRoute, session: noGuild, onboarded: false }), 'page');
  assert.equal(pageGate({ route: { path: '*' }, session: noGuild }), 'page');
  // Officer pages also wait for the guild before anything else.
  assert.equal(pageGate({ route: pages.routes.find((r) => r.path === '/admin'), session: noGuild }), 'no-guild');

  // Settings that can't be read never lock anyone out.
  assert.equal(isOnboarded({ onboarded: false }), false);
  assert.equal(isOnboarded({ onboarded: true }), true);
  assert.equal(isOnboarded({}), true);
  assert.equal(isOnboarded(null), true);
});

test('dev mock: sharing in game (status, cancel, author checks, "Close it" on a group of a kind this version doesn\'t know closes it with the core\'s reply and queues nothing, webhook, relay ranks)', async () => {
  const gc = gcmod.gc;
  const req = (method, path, body) => gc.api.request(method, path, body);
  const st = await req('GET', '/api/share/status');
  for (const k of ['enabled', 'pid', 'peers', 'records', 'lastHello', 'lastExchange', 'outbox', 'refused', 'authorChecks', 'webhookOffer']) assert.ok(k in st, k);
  for (const e of [...st.outbox, ...st.refused]) {
    for (const k of ['op', 'id', 'type', 'summary', 'state', 'note', 'createdAt', 'sentAt']) assert.ok(k in e, `${e.op}.${k}`);
  }
  // The preview's scenarios: an officer change waiting for an officer character, one ready to go, a stale refusal.
  const waiting = st.outbox.find((e) => e.state === 'waiting');
  assert.equal(waiting.note, 'Log in on an officer character to send this.');
  assert.ok(st.outbox.some((e) => e.state === 'queued' && e.note === status.SHARE_LINES.saved));
  assert.equal(st.refused[0].note, status.SHARE_LINES.stale);
  // A plain change in my name, and a group of a kind this version doesn't know (its second button only closes it).
  assert.deepEqual(st.authorChecks.map((c) => [c.id, c.kind, c.count]), [[7, null, 1], [8, 'unknown', 3]]);
  assert.deepEqual(Object.keys(st.authorChecks[0]).sort(), ['at', 'count', 'id', 'kind', 'summary', 'via'], 'the core sharing.status shape');
  assert.ok(st.webhookOffer && st.webhookOffer.from);

  // The shared store reads the same status.
  await status.shareStatus.refresh();
  assert.equal(status.shareStatus.get().data.records, st.records);
  assert.equal(status.shareStatus.get().error, null);

  // Cancel: only changes that haven't gone out.
  const cancelled = await req('POST', `/api/share/outbox/${waiting.op}/cancel`);
  assert.match(cancelled.message, /will not be sent/);
  await assert.rejects(req('POST', `/api/share/outbox/${waiting.op}/cancel`), (err) => err.status === 404);
  const sent = st.outbox.find((e) => e.state === 'sent');
  await assert.rejects(req('POST', `/api/share/outbox/${sent.op}/cancel`), (err) => err.status === 409);

  // "Undo it" sends my earlier version again; a second answer finds nothing.
  const check = st.authorChecks[0];
  await assert.rejects(req('POST', `/api/share/author-checks/${check.id}`, { action: 'maybe' }), (err) => err.status === 400);
  const undone = await req('POST', `/api/share/author-checks/${check.id}`, { action: 'undo' });
  assert.equal(undone.message, status.SHARE_LINES.saved);
  await assert.rejects(req('POST', `/api/share/author-checks/${check.id}`, { action: 'mine' }), (err) => err.status === 404);
  // "Close it" on the unknown-kind group: closed with the core's reply, and nothing is queued.
  const queuedBefore = (await req('GET', '/api/share/status')).outbox.length;
  const closed = await req('POST', '/api/share/author-checks/8', { action: 'undo' });
  assert.equal(closed.message, "Closed. This version can't undo those changes. They go away by themselves within 14 days.");
  const after = await req('GET', '/api/share/status');
  assert.equal(after.outbox.length, queuedBefore);
  assert.equal(after.authorChecks.length, 0);
  assert.ok(!after.outbox.some((e) => e.op === waiting.op));

  // The webhook offer: accept gives the address once; sharing mine queues a WH change for the officers.
  const { url } = await req('POST', '/api/share/webhook/accept');
  assert.match(url, /^https:\/\/discord\.com\/api\/webhooks\//);
  assert.equal((await req('GET', '/api/share/status')).webhookOffer, null);
  await assert.rejects(req('POST', '/api/share/webhook/accept'), (err) => err.status === 404);
  const shared = await req('POST', '/api/share/webhook/share');
  assert.equal(shared.message, status.SHARE_LINES.saved);
  assert.ok((await req('GET', '/api/share/status')).outbox.some((e) => e.id === 'WH:1' && e.state === 'queued'));

  // Who passes on officer changes: the Guild Master sets it; it travels as the guild settings record.
  await assert.rejects(req('PUT', '/api/guild/settings', { relay_rank_max: 12 }), (err) => err.status === 400);
  const saved = await req('PUT', '/api/guild/settings', { relay_rank_max: 3 });
  assert.equal(saved.guild.relay_rank_max, 3);
  assert.ok(saved.messages.includes(status.SHARE_LINES.saved));
  assert.ok((await req('GET', '/api/share/status')).outbox.some((e) => e.id === 'CFG:1'));
  assert.equal((await req('PUT', '/api/guild/settings', { relay_rank_max: null })).guild.relay_rank_max, null);
});

test('pages: the shared "goes out to the guild" hint, officer tools and the Coach notice', async () => {
  const hint = await load('components/ShareHint.js');
  // The lines of docs/SHARING.md §2.
  assert.equal(hint.shareHintText(), 'This goes to your guild the next time you log in or type /reload.');
  assert.equal(hint.SAVED_LINE, 'Saved. It goes to your guild the next time you log in or type /reload.');
  assert.equal(hint.NEW_DATA_LINE, 'New guild data shows here after you log out or type /reload in game.');
  assert.equal(hint.OFFICER_HINT, 'Log in on an officer character to send this.');
  assert.equal(hint.STALE_LINE, 'Someone changed this in the meantime. Check it and try again.');
  assert.equal(hint.shareHintText({ discord: true }), hint.SHARE_HINT, 'Discord only when a webhook is set');
  assert.equal(hint.shareHintText({ discord: true, webhook: true }), `${hint.SHARE_HINT} ${hint.DISCORD_HINT}`);
  assert.equal(hint.shareHintText({ discord: 'Custom line.', webhook: true, officer: true }), `${hint.SHARE_HINT} ${hint.OFFICER_HINT} Custom line.`);
  assert.equal(hint.shareHintText({ gm: true, officer: true }), `${hint.SHARE_HINT} Log in on your Guild Master character to send this.`);
  // "Waiting until you leave the dungeon." only when the game said so.
  assert.ok(!hint.shareHintText({ officer: true }).includes('dungeon'));
  assert.equal(hint.shareHintText({ dungeon: true }), `${hint.SHARE_HINT} Waiting until you leave the dungeon.`);
  assert.match(hint.shareHintText({ syncOff: true, discord: true, webhook: true, dungeon: true }), /^Sync is off/);

  const admin = await load('pages/admin.js');
  const sum = admin.adminSummary({
    roster: [{ name: 'A', rank_index: 0, online: 1 }, { name: 'B', rank_index: 1, addonOutdated: true }, { name: 'C', rank_index: 3 }],
    members: [{ id: 1, addonOutdated: false }, { id: 2, appOutdated: true }],
    backups: [{ file: 'guildcamp-1.db', created: 'x' }],
  }, 1);
  assert.deepEqual(sum, { characters: 3, online: 1, officers: 2, people: 2, outdated: 2, backups: 1, newestBackup: { file: 'guildcamp-1.db', created: 'x' } });
  assert.equal(admin.adminSummary(null, 1).characters, 0);

  const coach = await load('pages/coach.js');
  assert.equal(coach.aiNoticeText({ available: true }), null);
  assert.equal(coach.aiNoticeText({ available: false, hasKey: false }, true).link.href, '/settings?section=coach');
  assert.equal(coach.aiNoticeText({ available: false, hasKey: true, enabled: false }, true).link.href, '/guild-settings?section=coach');
  assert.match(coach.aiNoticeText({ available: false, hasKey: true, enabled: true, budgetLeft: false }, false).text, /raise your budget/);
});

test('sidebar: Releases only on a PC that can publish', async () => {
  const shell = await load('components/Shell.js');
  const member = { isOfficer: false, isOwner: false };
  const owner = { isOfficer: true, isOwner: true };
  const paths = (s, o) => shell.visibleNav(pages.routes, s, o).map((r) => r.path);
  assert.ok(!paths(owner).includes('/releases'), 'the Guild Master alone is not enough');
  assert.ok(paths(member, { canPublish: true }).includes('/releases'));
  assert.ok(paths(member).includes('/guild-settings'));
  assert.ok(!paths(member).includes('/admin'));
  assert.ok(paths(owner).includes('/admin'));
});

test('dev mock: the local core and main process shapes', async () => {
  const gc = gcmod.gc;
  const settings = await gc.invoke('settings.get');
  assert.equal(settings.addonAutoInstall, true);
  assert.ok(!('serverUrl' in settings) && !('lastEventId' in settings));
  assert.ok('discordWebhook' in settings && settings.bnetRegion === 'eu');
  await assert.rejects(gc.invoke('settings.set', { discordWebhook: 'https://evil.example/x' }), (err) => err.status === 400);
  const det = await gc.invoke('wow.detectGuild');
  assert.ok(Array.isArray(det.characters) && det.characters.length > 0);
  for (const k of ['name', 'realm', 'guild', 'faction', 'level', 'class', 'updated', 'install', 'account']) assert.ok(k in det.characters[0], k);
  assert.equal(det.guild.name, det.characters[0].guild);
  // Gone with the server: guild matching, dev sign-in and the membership channel.
  for (const m of ['guild.autoJoin', 'membership.status', 'auth.devSignIn']) await assert.rejects(gc.invoke(m), (err) => err.status === 501, m);
  assert.throws(() => gc.on('membership', () => {}), /Unknown event channel/);
  assert.ok(!gcmod.METHODS.includes('guild.autoJoin') && gcmod.METHODS.includes('calendar.export'));

  // auth.state = the Battle.net state plus who I am in the local core.
  const auth = await gc.invoke('auth.state');
  for (const k of ['available', 'signedIn', 'battletag', 'characters', 'user', 'guild', 'role']) assert.ok(k in auth, k);
  assert.equal(auth.role, 'owner');
  const me = await gc.api.request('GET', '/api/me');
  assert.deepEqual(Object.keys(me).sort(), ['bnet', 'guild', 'notifyPrefs', 'role', 'user']);
  assert.ok(me.bnet && typeof me.bnet.characters === 'number');
  assert.equal(me.guild.officer_rank_max, 1);
  assert.ok(!('invite_code' in me.guild) && !('auto_join' in me.guild));
  const meta = await gc.api.request('GET', '/api/meta');
  assert.equal(meta.app, 'guild-camp');
  assert.equal(typeof meta.blizzard, 'boolean');

  // Guild settings follow the core's rules: the Guild Master sets officer ranks; the webhook lives in Settings.
  const g = await gc.api.request('GET', '/api/guild');
  assert.equal(g.guild.officer_rank_max, 1);
  await assert.rejects(gc.api.request('PUT', '/api/guild/settings', { auto_join: 'off' }), (err) => err.status === 400 && /Nothing to save/.test(err.message));
  await assert.rejects(gc.api.request('PUT', '/api/guild/settings', { discord_webhook: '' }), (err) => err.status === 400);
  await assert.rejects(gc.api.request('PUT', '/api/guild/settings', { officer_rank_max: 12 }), (err) => err.status === 400);
  const before = (await gc.api.request('GET', '/api/members')).members.find((m) => m.battletag.startsWith('Mokra'));
  assert.equal(before.role, 'member');
  assert.equal(before.rank_index, 2);
  const saved = await gc.api.request('PUT', '/api/guild/settings', { officer_rank_max: 2 });
  assert.equal(saved.guild.officer_rank_max, 2);
  const after = (await gc.api.request('GET', '/api/members')).members.find((m) => m.battletag.startsWith('Mokra'));
  assert.equal(after.role, 'officer', 'roles follow the new officer ranks at once');
  await gc.api.request('PUT', '/api/guild/settings', { officer_rank_max: 1 });

  // The roster carries rank_index; Officer tools has local backups with their full path and no downloads.
  const roster = await gc.api.request('GET', '/api/roster');
  assert.ok(roster.characters.every((c) => 'rank_index' in c));
  const admin = await gc.api.request('GET', '/api/admin');
  assert.ok(admin.backups.length && admin.backups.every((b) => b.path && b.path.endsWith(b.file)));
  assert.ok(admin.backupDir && Array.isArray(admin.roster) && admin.knownLocally === true);
  assert.ok(!('canDownloadBackups' in admin));
  assert.ok(admin.members.every((m) => !('devices' in m) && !('sync_keys' in m) && !('discord_linked' in m)));

  // Camp onboarding has no Discord or join step; sync has no signed-out or no-guild state.
  const camp = await gc.api.request('GET', '/api/camp');
  assert.deepEqual(camp.onboarding.steps.map((x) => x.key), ['synced', 'professions', 'main', 'signup']);
  const sync = await gc.invoke('sync.status');
  assert.ok(['off', 'idle', 'syncing', 'error', 'no-game'].includes(sync.state));
  assert.ok('guildNote' in sync && !('noGuild' in sync));
  assert.ok(sync.lastResult && 'guild' in sync.lastResult);

  // The Coach key is the player's own; secrets never come back.
  assert.equal(await gc.invoke('secrets.has', 'anthropicKey'), true);
  assert.deepEqual(await gc.invoke('secrets.set', 'anthropicKey', ''), { name: 'anthropicKey', set: false, encrypted: true });
  const coach = await gc.api.request('GET', '/api/coach');
  assert.equal(coach.ai.hasKey, false);
  assert.match(coach.ai.reason, /Anthropic API key in Settings/);
  assert.ok(coach.usage && typeof coach.usage.spentUsd === 'number', 'usage is shown to everyone');
  await gc.invoke('secrets.set', 'anthropicKey', 'sk-ant-preview');
  assert.match(await gc.invoke('calendar.export'), /\.ics$/);
  const pub = await gc.invoke('publisher.status');
  assert.equal(typeof pub.canPublish, 'boolean');
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
  assert.equal(status.describeSync({ state: 'off' }).label, 'Sync is off');
  assert.equal(status.describeSync({ state: 'no-game' }).kind, 'warn');
  // No character in a guild yet: the addon's data was read, but there is no guild to keep it for.
  assert.deepEqual(status.describeSync({ state: 'idle', lastSyncAt: 'x', guildNote: 'None of your characters is in a guild yet.' }),
    { kind: 'warn', label: 'Waiting for your guild' });
  assert.equal(status.describeSync({ state: 'idle' }).label, 'Waiting for the game');
  // Roles from in-game ranks, as the core decides them.
  assert.equal(status.roleForRank(0, 1), 'owner');
  assert.equal(status.roleForRank(1, 1), 'officer');
  assert.equal(status.roleForRank(2, 1), 'member');
  assert.equal(status.roleForRank(0, null), 'owner');
  assert.equal(status.roleForRank(1, null), 'member');
  assert.equal(status.roleForRank(null, 1), null);
  assert.equal(status.roleForRank('3', '3'), 'officer');
  assert.equal(status.ROLE_NAMES.owner, 'Guild Master');
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
  assert.equal(meta.app, 'guild-camp');
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
  // Roles come from the local guild data (GET /api/me); Battle.net only adds the BattleTag.
  g.auth.state = async () => ({ available: true, signedIn: false });
  g.api.request = async (method, path) => {
    if (method === 'GET' && path === '/api/me') {
      asked.push(path);
      return { user: { id: 1, battletag: 'Mokra' }, guild: { id: 1, name: 'Camp' }, role: 'member' };
    }
    throw Object.assign(new Error('Officers only.'), { status: 403 });
  };
  try {
    session.setSession({ me: { user: { id: 1 }, guild: { id: 1, name: 'Camp' }, role: 'officer' }, bnet: null });
    assert.equal(session.getSession().isOfficer, true);
    await assert.rejects(api.api.get('/api/admin/audit'), (err) => err.status === 403 && err.message === 'Officers only.');
    await assert.rejects(api.api.post('/api/raids', {}), (err) => err.status === 403);
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(asked, ['/api/me'], 'one profile reload for a burst of 403s');
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

test("requests: a crafter who claimed a request can give it back with \"I can't make it\", and it is open again (renderer-1)", async () => {
  const rq = await load('pages/requests.js');
  // The buttons follow the core's can* flags, withdraw included.
  assert.deepEqual(rq.requestActions({ status: 'claimed', canClaim: false, canDone: true, canCancel: false, canWithdraw: true }), ['done', 'withdraw']);
  assert.deepEqual(rq.requestActions({ status: 'open', canClaim: true }), ['claim']);
  assert.deepEqual(rq.requestActions({ status: 'claimed', canDone: true, canCancel: true, canWithdraw: false }), ['done', 'cancel']);
  assert.deepEqual(rq.requestActions(null), []);

  // The dev mock answers like the core: after a claim the crafter may withdraw, which opens the request again.
  const req = (method, path, body) => gcmod.gc.api.request(method, path, body);
  const open = (await req('GET', '/api/requests')).requests.find((r) => r.status === 'open' && r.canClaim);
  assert.ok(open, 'an open request someone else asked for');
  assert.equal(open.canWithdraw, false);
  const claimed = await req('POST', `/api/requests/${open.id}/claim`);
  assert.equal(claimed.message, `You're making ${open.item}.`, 'no promise that the requester sees it already');
  assert.equal(claimed.request.canWithdraw, true);
  assert.deepEqual(rq.requestActions(claimed.request), ['done', 'withdraw']);
  const back = await req('POST', `/api/requests/${open.id}/withdraw`);
  assert.equal(back.message, `You're no longer making ${open.item}.`);
  assert.equal(back.request.status, 'open');
  assert.equal(back.request.crafter_id, null);
  assert.deepEqual(rq.requestActions(back.request), ['claim']);
  await assert.rejects(req('POST', `/api/requests/${open.id}/withdraw`), (err) => err.status === 409);
});

test('raid: before signing up, the reserve picker is read-only and says to sign up first instead of failing with 409 (renderer-4)', async () => {
  const raid = await load('pages/raid.js');
  const open = { raid: { status: 'open', kind: 'raid', sr_limit: 2 } };
  assert.deepEqual(raid.reservesState({ ...open, canReserve: false, needsSignup: true, mySignup: null }),
    { editable: false, notice: { kind: 'info', text: 'Sign up first, then pick your reserves.' } });
  assert.deepEqual(raid.reservesState({ ...open, canReserve: true, needsSignup: false, mySignup: { status: 'yes' } }), { editable: true, notice: null });
  // An older core without needsSignup: reservable but no sign-up means the same thing.
  assert.equal(raid.reservesState({ ...open, canReserve: true, mySignup: null }).notice.text, raid.SIGN_UP_FIRST);
  // Locked and closed raids keep their own notices.
  assert.equal(raid.reservesState({ raid: { status: 'locked' }, canReserve: false, needsSignup: false, mySignup: { status: 'yes' } }).notice.text, 'Reserves are locked. Your picks are shown below.');
  assert.equal(raid.reservesState({ raid: { status: 'open' }, canReserve: false, needsSignup: false, mySignup: null }).notice.text, 'Reserves are closed for this raid.');

  // The dev mock follows the core: no reserves without a sign-up.
  const req = (method, path, body) => gcmod.gc.api.request(method, path, body);
  const made = await req('POST', '/api/raids', { kind: 'raid', title: 'BWL test run', instance: 'Blackwing Lair', starts_at: new Date(Date.now() + 3 * 86400000).toISOString(), sr_limit: 1 });
  assert.equal(made.message, 'Raid scheduled.', 'no promise of a Discord post before the game sends it');
  const before = await req('GET', `/api/raids/${made.raid.id}`);
  assert.equal(before.mySignup, null);
  assert.equal(before.needsSignup, true);
  assert.equal(before.canReserve, false);
  assert.equal(raid.reservesState(before).notice.text, raid.SIGN_UP_FIRST);
  const itemId = before.items[0].id;
  await assert.rejects(req('POST', `/api/raids/${made.raid.id}/reserves`, { item_ids: [itemId] }),
    (err) => err.status === 409 && err.message === 'Sign up for this raid first, then pick your reserves.');
  await req('POST', `/api/raids/${made.raid.id}/signup`, { character: 'Grimtusk', role: 'tank', status: 'yes' });
  const after = await req('GET', `/api/raids/${made.raid.id}`);
  assert.equal(after.needsSignup, false);
  assert.equal(after.canReserve, true);
  assert.deepEqual(raid.reservesState(after), { editable: true, notice: null });
  assert.equal((await req('POST', `/api/raids/${made.raid.id}/reserves`, { item_ids: [itemId] })).message, 'Reserves saved.');
});

test('guild settings: a save refreshes the app session, so item tooltips and officer roles on other pages follow at once (renderer-2)', async () => {
  const gs = await load('pages/guild-settings.js');
  const toasts = await load('lib/toast.js');
  const g = gcmod.gc;
  const realRequest = g.api.request;
  const realState = g.auth.state;
  const asked = [];
  g.auth.state = async () => ({ available: true, signedIn: false });
  g.api.request = async (method, path) => {
    asked.push(`${method} ${path}`);
    if (method === 'GET' && path === '/api/me') return { user: { id: 1, battletag: 'Mokra' }, guild: { id: 1, name: 'Camp', wowhead_game: 'classic', officer_rank_max: 3 }, role: 'owner' };
    throw Object.assign(new Error('unexpected'), { status: 500 });
  };
  try {
    session.setSession({ me: { user: { id: 1 }, guild: { id: 1, name: 'Camp', wowhead_game: 'forever', officer_rank_max: 1 }, role: 'owner' }, bnet: null });
    let pageGuild = null;
    const saved = gs.settingsSaved({ guild: { wowhead_game: 'classic' }, messages: ["Item tooltips now use Wowhead's Classic database."] }, (guild) => { pageGuild = guild; });
    assert.deepEqual(saved, { wowhead_game: 'classic' });
    assert.deepEqual(pageGuild, { wowhead_game: 'classic' }, 'the page itself shows it at once');
    for (let i = 0; i < 50 && session.getSession().guild.wowhead_game !== 'classic'; i++) await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(asked, ['GET /api/me'], 'the session reads who I am again');
    assert.equal(session.getSession().guild.wowhead_game, 'classic');
    assert.equal(session.getSession().guild.officer_rank_max, 3);
    assert.ok(toasts.toastStore.get().some((t) => t.message === "Item tooltips now use Wowhead's Classic database."));
  } finally {
    g.api.request = realRequest;
    g.auth.state = realState;
    for (const t of toasts.toastStore.get()) toasts.dismiss(t.id);
  }
});

test("releases: the GitHub error shows its first sentence once, not again under the notice's title (K5)", async () => {
  const rel = await load('pages/releases.js');
  const msg = "Couldn't read the releases on GitHub. Couldn't reach GitHub (connection refused). Check your internet connection.";
  assert.equal(rel.withoutTitle(msg, rel.PUBLISHED_ERROR_TITLE), "Couldn't reach GitHub (connection refused). Check your internet connection.");
  assert.equal(rel.withoutTitle(`${rel.PUBLISHED_ERROR_TITLE} ${msg}`, rel.PUBLISHED_ERROR_TITLE), "Couldn't reach GitHub (connection refused). Check your internet connection.");
  assert.equal(rel.withoutTitle('GitHub said 502.', rel.PUBLISHED_ERROR_TITLE), 'GitHub said 502.');
  assert.equal(rel.withoutTitle(rel.PUBLISHED_ERROR_TITLE, rel.PUBLISHED_ERROR_TITLE), '');
});

test('Discord lines never promise a post before the game sends the change (K6)', async () => {
  const raids = await load('pages/raids.js');
  const raid = await load('pages/raid.js');
  const settings = await load('pages/settings.js');
  const hint = await load('components/ShareHint.js');
  for (const line of [raids.SCHEDULE_DISCORD_HINT, raid.CANCEL_DISCORD_HINT, settings.WEBHOOK_SAVED, hint.DISCORD_HINT]) {
    assert.match(line, /once it goes out/, line);
    assert.doesNotMatch(line, /\bnow\b|at once|right away/, line);
  }
  // No page (or the preview's answers) keeps the old wording.
  const fs = await import('node:fs');
  const path = await import('node:path');
  const old = [/Guildies can see it/, /gets a post now/, /Cancelling also posts to your Discord channel\./, /now posts to that Discord channel/, /posted to Discord/, /have been told/, /can see that\./];
  const files = fs.readdirSync(path.join(R, 'pages')).map((f) => `pages/${f}`).concat(['lib/mocks/community.js', 'lib/mocks/raids.js']);
  for (const f of files) {
    const text = fs.readFileSync(path.join(R, f), 'utf8');
    for (const re of old) assert.doesNotMatch(text, re, `${f}: ${re}`);
  }
});

test("admin: after a fresh start the card says unsent changes stay and shared guild data comes back after a log out or /reload, as the core replies (K2)", async () => {
  const admin = await load('pages/admin.js');
  assert.match(admin.FRESH_START_HINT, /unsent changes stay/);
  assert.match(admin.FRESH_START_HINT, /guild data shared in game come back after you log out or type \/reload/);
  assert.doesNotMatch(admin.FRESH_START_HINT, /next sync/);
  // The preview answers like the core: the same 403 and the same reply.
  const fs = await import('node:fs');
  const path = await import('node:path');
  const core = fs.readFileSync(path.join(R, '..', 'core', 'routes', 'admin.js'), 'utf8');
  const mock = fs.readFileSync(path.join(R, 'lib', 'mocks', 'admin.js'), 'utf8');
  const forbidden = core.match(/HttpError\(403, '(Only the Guild Master can wipe[^']*)'\)/)[1];
  assert.ok(mock.includes(`httpError(403, '${forbidden}')`), forbidden);
  const tail = 'People, settings and your unsent changes stay. Guild data shared in game comes back after you log out or type /reload.';
  assert.ok(core.includes(tail) && mock.includes(tail));
  assert.ok(mock.includes('rows of game data removed from this PC (backup'));
  assert.doesNotMatch(mock, /People and settings are untouched|wipe the guild’s data/);
});
