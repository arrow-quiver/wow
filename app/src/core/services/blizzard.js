// Blizzard's free Game Data API (client credentials flow with the Battle.net app built into the installer).
// Checks what's available, watches for a WoW: Forever namespace, and reads the Retail token price.
// Ported from the old web/src/blizzard.js.
//
// Exports
//   token(cfg, fetchImpl?) → access token (client credentials)          throws Error('token <status>')
//   check(cfg, fetchImpl?) → status { checkedAt, region, ok, forever, foreverKey, classicEra, tokenGold, notes: [] }
//       Without a Battle.net app it returns at once with ok: false and a note.
//   save(db, status)   load(db) → status | null      (app_settings key 'blizzard_status')
//   FOREVER_GUESSES   namespace keys tried for WoW: Forever
// Injected dependencies: cfg.bnetClientId, cfg.bnetClientSecret, cfg.bnetRegion; outside HTTP goes through
// fetchImpl, else cfg.fetch, else global fetch. Routes/timers: `blizzard.save(db, await blizzard.check(cfg))`
// daily (cfg.timers only) and on the officer's "Check now".
const FOREVER_GUESSES = ['forever', 'wowforever', 'classicforever', 'classic-forever', 'classicplus', 'camelot'];
const fetcher = (cfg, fetchImpl) => fetchImpl || (cfg && cfg.fetch) || globalThis.fetch;

async function token(cfg, fetchImpl) {
  const basic = Buffer.from(`${cfg.bnetClientId}:${cfg.bnetClientSecret}`).toString('base64');
  const res = await fetcher(cfg, fetchImpl)('https://oauth.battle.net/token', {
    method: 'POST', headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials', signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`token ${res.status}`);
  return (await res.json()).access_token;
}

async function check(cfg, fetchImpl) {
  const f = fetcher(cfg, fetchImpl);
  const region = cfg.bnetRegion || 'eu';
  const status = { checkedAt: new Date().toISOString(), region, ok: false, forever: null, foreverKey: null, classicEra: false, tokenGold: null, notes: [] };
  if (!cfg.bnetClientId || !cfg.bnetClientSecret) { status.notes.push('Blizzard game data is off: this copy of Guild Camp has no Battle.net app built in.'); return status; }
  const t = await token(cfg, f);
  const get = (path, ns) => f(`https://${region}.api.blizzard.com${path}?namespace=${ns}&locale=en_GB`,
    { headers: { Authorization: `Bearer ${t}` }, signal: AbortSignal.timeout(10000) });
  const tok = await get('/data/wow/token/index', `dynamic-${region}`);
  if (tok.ok) { status.ok = true; status.tokenGold = Math.round((await tok.json()).price / 10000); }
  else status.notes.push(`Retail token price: ${tok.status}`);
  for (const g of FOREVER_GUESSES) {
    const r = await get('/data/wow/item-class/index', `static-${g}-${region}`);
    if (r.ok) { status.forever = `static-${g}-${region}`; status.foreverKey = g; break; }
  }
  status.classicEra = (await get('/data/wow/item-class/index', `static-classic1x-${region}`)).ok;
  if (!status.forever) status.notes.push('No WoW: Forever namespace yet (tried ' + FOREVER_GUESSES.map((g) => `static-${g}-${region}`).join(', ') + ').');
  return status;
}

function save(db, status) {
  db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?,?)').run('blizzard_status', JSON.stringify(status));
}
function load(db) {
  const r = db.prepare("SELECT value FROM app_settings WHERE key = 'blizzard_status'").get();
  try { return r ? JSON.parse(r.value) : null; } catch { return null; }
}

module.exports = { check, save, load, token, FOREVER_GUESSES };
