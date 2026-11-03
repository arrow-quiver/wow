// Blizzard's free Game Data API (client credentials from the same Battle.net app used for sign-in).
// Checks what's available, watches for a WoW: Forever namespace, and reads the Retail token price.
const FOREVER_GUESSES = ['forever', 'camelot', 'classicplus', 'classic-forever'];

async function token(cfg, fetchImpl = fetch) {
  const basic = Buffer.from(`${cfg.bnetClientId}:${cfg.bnetClientSecret}`).toString('base64');
  const res = await fetchImpl('https://oauth.battle.net/token', {
    method: 'POST', headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials', signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`token ${res.status}`);
  return (await res.json()).access_token;
}

async function check(cfg, fetchImpl = fetch) {
  const region = cfg.bnetRegion || 'eu';
  const status = { checkedAt: new Date().toISOString(), region, ok: false, forever: null, tokenGold: null, notes: [] };
  if (!cfg.bnetClientId || !cfg.bnetClientSecret) { status.notes.push('No Battle.net app configured.'); return status; }
  const t = await token(cfg, fetchImpl);
  const get = (path, ns) => fetchImpl(`https://${region}.api.blizzard.com${path}?namespace=${ns}&locale=en_GB`,
    { headers: { Authorization: `Bearer ${t}` }, signal: AbortSignal.timeout(10000) });
  const tok = await get('/data/wow/token/index', `dynamic-${region}`);
  if (tok.ok) { status.ok = true; status.tokenGold = Math.round((await tok.json()).price / 10000); }
  else status.notes.push(`Retail token price: ${tok.status}`);
  for (const g of FOREVER_GUESSES) {
    const r = await get('/data/wow/item-class/index', `static-${g}-${region}`);
    if (r.ok) { status.forever = `static-${g}-${region}`; break; }
  }
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

module.exports = { check, save, load, FOREVER_GUESSES };
