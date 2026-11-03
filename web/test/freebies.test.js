// Free resources: calendar feeds, web push, Blizzard API watcher, PWA files.
const test = require('node:test');
const assert = require('node:assert');
const dbm = require('../src/db');
const { buildIcs } = require('../src/calendar');
const { createPush } = require('../src/push');
const blizzard = require('../src/blizzard');
const { createApp, config } = require('../src/server');

test('calendar feed is valid iCalendar with reminders and cancellations', () => {
  const ics = buildIcs({ guildName: 'wow', baseUrl: 'https://wow.example', raids: [
    { id: 7, title: 'Hyjal, week 1', instance: 'Hyjal Summit', starts_at: '2026-12-09T18:00:00.000Z', duration_min: 180, coming: 12, signup: 'yes' },
    { id: 8, title: 'Old', instance: 'MC', starts_at: '2026-12-10T18:00:00.000Z', cancelled_at: '2026-12-01', status: 'cancelled' },
  ] });
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /END:VCALENDAR\r\n$/);
  assert.match(ics, /UID:raid-7@wow\.example/);
  assert.match(ics, /DTSTART:20261209T180000Z/);
  assert.match(ics, /DTEND:20261209T210000Z/);
  assert.match(ics, /SUMMARY:Raid: Hyjal\\, week 1/);
  assert.match(ics, /BEGIN:VALARM[\s\S]*TRIGGER:-PT30M/);
  for (const line of ics.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, `line too long: ${line}`);
});

test('push respects choices, targets users and forgets dead subscriptions', async () => {
  const db = dbm.open(':memory:');
  const a = db.prepare("INSERT INTO users (bnet_id, battletag) VALUES ('a','A#1')").run().lastInsertRowid;
  const b = db.prepare("INSERT INTO users (bnet_id, battletag) VALUES ('b','B#1')").run().lastInsertRowid;
  const g = db.prepare("INSERT INTO guilds (name, invite_code) VALUES ('wow','i')").run().lastInsertRowid;
  const add = db.prepare('INSERT INTO push_subs (user_id, guild_id, endpoint, p256dh, auth, prefs) VALUES (?,?,?,?,?,?)');
  add.run(a, g, 'https://push.example/a', 'k', 'x', '{"cta":true,"raids":false}');
  add.run(b, g, 'https://push.example/b', 'k', 'x', '{"cta":true,"raids":true}');
  add.run(b, g, 'https://push.example/gone', 'k', 'x', '{}');
  const sent = [];
  const push = createPush(db, { baseUrl: 'https://wow.example' }, { send: async (sub, payload) => {
    if (sub.endpoint.endsWith('gone')) { const e = new Error('gone'); e.statusCode = 410; throw e; }
    sent.push([sub.endpoint, JSON.parse(payload)]);
  } });
  assert.ok(push.publicKey.length > 40);
  assert.strictEqual(createPush(db, { baseUrl: 'x' }).publicKey, push.publicKey, 'keys are kept, not regenerated');
  assert.strictEqual(await push.notify(g, 'raids', { title: 'Raid', body: 'Hyjal', url: '/raids/1' }), 1);
  assert.deepStrictEqual(sent.map((s) => s[0]), ['https://push.example/b']);
  assert.strictEqual(sent[0][1].url, '/raids/1');
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM push_subs').get().n, 2, 'dead subscription removed');
  sent.length = 0;
  assert.strictEqual(await push.notify(g, 'cta', { title: 'CTA' }, { exceptUserId: b }), 1);
  assert.deepStrictEqual(sent.map((s) => s[0]), ['https://push.example/a']);
});

test('Blizzard watcher reads the token price and spots a Forever namespace', async () => {
  const calls = [];
  const fake = async (url) => {
    calls.push(url);
    const json = (o) => ({ ok: true, status: 200, json: async () => o });
    if (url.includes('oauth')) return json({ access_token: 't' });
    if (url.includes('/token/index')) return json({ price: 2500000000 });
    if (url.includes('static-camelot-eu')) return json({});
    return { ok: false, status: 404 };
  };
  const s = await blizzard.check({ bnetClientId: 'id', bnetClientSecret: 'sec' }, fake);
  assert.strictEqual(s.ok, true);
  assert.strictEqual(s.tokenGold, 250000);
  assert.strictEqual(s.forever, 'static-camelot-eu');
  const none = await blizzard.check({}, fake);
  assert.strictEqual(none.ok, false);
  const db = dbm.open(':memory:');
  blizzard.save(db, s);
  assert.strictEqual(blizzard.load(db).forever, 'static-camelot-eu');
});

test('calendar, notifications and PWA work over HTTP', async () => {
  const db = dbm.open(':memory:');
  const pushed = [];
  const cfg = { ...config({}), devLogin: true, timers: false, pushSend: async (sub, payload) => pushed.push([sub.endpoint, JSON.parse(payload)]) };
  const app = createApp(cfg, db);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const url = `http://127.0.0.1:${srv.address().port}`;
  try {
    const login = async (bt) => {
      const res = await fetch(`${url}/login/dev`, { method: 'POST', body: new URLSearchParams({ battletag: bt }), redirect: 'manual' });
      const cookie = res.headers.get('set-cookie').split(';')[0];
      const html = await (await fetch(`${url}/`, { headers: { cookie } })).text();
      return { cookie, csrf: (/name="_csrf" value="([^"]+)"/.exec(html) || [])[1] };
    };
    const post = (s, path, body) => fetch(url + path, { method: 'POST', headers: { cookie: s.cookie }, body: new URLSearchParams({ _csrf: s.csrf, ...body }), redirect: 'manual' });
    const postJson = (s, path, body) => fetch(url + path, { method: 'POST', headers: { cookie: s.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ _csrf: s.csrf, ...body }) });
    const get = async (s, path) => { const r = await fetch(url + path, { headers: s ? { cookie: s.cookie } : {} }); return { status: r.status, type: r.headers.get('content-type'), text: await r.text() }; };

    const owner = await login('Owner#1');
    await post(owner, '/guild/create', { name: 'wow', faction: 'Horde' });
    const invite = db.prepare('SELECT invite_code FROM guilds').get().invite_code;
    const member = await login('Member#2');
    await post(member, `/join/${invite}`, {});
    await post(member, '/join', { code: invite });

    // Settings shows the calendar link and the notification controls.
    const settings = await get(member, '/settings');
    assert.match(settings.text, /Raids in your calendar/);
    assert.match(settings.text, /id="push-controls"/);
    const cal = /https?:\/\/[^"<\s]+\/calendar\/[\w-]+\.ics/.exec(settings.text)[0];
    assert.match(settings.text, /calendar\.google\.com\/calendar\/r\?cid=webcal/);

    // Subscribing a device, then a raid being scheduled, sends a notification.
    assert.strictEqual((await postJson(member, '/push/subscribe', { subscription: { endpoint: 'https://push.example/m', keys: { p256dh: 'p', auth: 'a' } } })).status, 200);
    assert.strictEqual((await postJson(member, '/push/subscribe', { subscription: { endpoint: 'http://evil', keys: {} } })).status, 400);
    assert.strictEqual((await postJson(member, '/push/subscribe', { subscription: { endpoint: 'https://push.example/m2', keys: { p256dh: 'p', auth: 'a' } }, _csrf: 'wrong' })).status >= 400, true);
    assert.strictEqual((await get(member, '/push/key')).text.includes('publicKey'), true);
    const made = await post(owner, '/raids', { title: 'Hyjal week 1', instance: 'Hyjal Summit', starts: '2026-12-09T20:00', tz_offset: '-120', sr_limit: '1' });
    assert.strictEqual(made.status, 302);
    assert.ok(pushed.some(([ep, p]) => ep === 'https://push.example/m' && /Hyjal/.test(p.title + p.body)), JSON.stringify(pushed));

    // The calendar feed works without a login and has the raid.
    const feed = await get(null, new URL(cal).pathname);
    assert.strictEqual(feed.status, 200);
    assert.match(feed.type, /text\/calendar/);
    assert.match(feed.text, /Hyjal week 1/);
    assert.strictEqual((await get(null, '/calendar/not-a-real-token-at-all-xx.ics')).status, 404);

    // Turning raids off stops raid notifications; test send reaches the device.
    await post(member, '/push/prefs', { cta: 'on' });
    pushed.length = 0;
    await post(owner, '/raids', { title: 'Hyjal week 2', instance: 'Hyjal Summit', starts: '2026-12-16T20:00', tz_offset: '-120', sr_limit: '1' });
    assert.strictEqual(pushed.length, 0);
    await post(member, '/push/test', {});
    assert.strictEqual(pushed.length, 1);

    // Replacing the calendar link kills the old one.
    await post(member, '/settings/calendar/reset', {});
    assert.strictEqual((await get(null, new URL(cal).pathname)).status, 404);

    // PWA bits are served.
    assert.match((await get(null, '/manifest.webmanifest')).text, /"display": "standalone"/);
    assert.match((await get(null, '/sw.js')).text, /showNotification/);
    assert.strictEqual((await fetch(`${url}/icon-192.png`)).status, 200);
    // Officers see the Blizzard status box.
    assert.match((await get(owner, '/admin')).text, /Blizzard game data/);
  } finally { srv.close(); }
});
