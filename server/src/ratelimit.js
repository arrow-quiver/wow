// Small in-memory rate limiter (fixed window per key). Enough for one server and a small guild.
// Expired windows are swept lazily on later requests, so no interval timer is needed.
function rateLimit({
  windowMs = 60000,
  max = 60,
  key = (req) => req.ip,
  message = 'Too many requests. Wait a minute and try again.',
  // (req, res, retryAfterSeconds, message) → sends the 429. Default: JSON { error }.
  onLimit = (req, res, retryAfter, msg) => res.status(429).json({ error: msg }),
} = {}) {
  const hits = new Map();
  let lastSweep = Date.now();
  return function limiter(req, res, next) {
    const now = Date.now();
    if (now - lastSweep >= windowMs) {
      for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
      lastSweep = now;
    }
    const k = String(key(req) || 'unknown').slice(0, 200);
    let h = hits.get(k);
    if (!h || h.reset <= now) { h = { n: 0, reset: now + windowMs }; hits.set(k, h); }
    h.n += 1;
    if (h.n > max) {
      const retryAfter = Math.max(1, Math.ceil((h.reset - now) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      return onLimit(req, res, retryAfter, message);
    }
    next();
  };
}

module.exports = { rateLimit };
