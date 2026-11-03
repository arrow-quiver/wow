// Web push: notifications to phones and desktops through the browser's own (free) push service.
const webpush = require('web-push');

function settings(db) {
  const get = (k) => (db.prepare('SELECT value FROM app_settings WHERE key = ?').get(k) || {}).value;
  let pub = get('vapid_public'); let priv = get('vapid_private');
  if (!pub || !priv) {
    const k = webpush.generateVAPIDKeys();
    pub = k.publicKey; priv = k.privateKey;
    const set = db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?,?)');
    set.run('vapid_public', pub); set.run('vapid_private', priv);
  }
  return { publicKey: pub, privateKey: priv };
}

function createPush(db, cfg, { send = webpush.sendNotification } = {}) {
  const keys = settings(db);
  const subject = cfg.baseUrl.startsWith('https://') ? cfg.baseUrl : 'mailto:guild@example.com';
  const options = { vapidDetails: { subject, publicKey: keys.publicKey, privateKey: keys.privateKey }, TTL: 3600 };

  // kind: cta | raids | notices | requests. userIds limits who gets it (e.g. only crafters who can make an item).
  async function notify(guildId, kind, { title, body, url, tag }, { userIds, exceptUserId, ignorePrefs } = {}) {
    let subs = db.prepare('SELECT * FROM push_subs WHERE guild_id = ?').all(guildId);
    if (userIds) { const set = new Set(userIds); subs = subs.filter((s) => set.has(s.user_id)); }
    if (exceptUserId) subs = subs.filter((s) => s.user_id !== exceptUserId);
    if (!ignorePrefs) subs = subs.filter((s) => { try { return JSON.parse(s.prefs)[kind] !== false; } catch { return true; } });
    const payload = JSON.stringify({ title, body: String(body || '').slice(0, 300), url: url || '/', tag: tag || kind });
    let sent = 0;
    await Promise.all(subs.map(async (s) => {
      try {
        await send({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, options);
        sent += 1;
      } catch (e) {
        // 404/410: the browser dropped the subscription. Forget it.
        if (e && (e.statusCode === 404 || e.statusCode === 410)) db.prepare('DELETE FROM push_subs WHERE id = ?').run(s.id);
        else console.warn('Push failed:', e && (e.statusCode || e.message));
      }
    }));
    return sent;
  }
  return { publicKey: keys.publicKey, notify };
}

module.exports = { createPush };
