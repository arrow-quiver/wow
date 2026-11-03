// Small in-memory rate limiter (fixed window per key). Enough for one server and a small guild.
function rateLimit({ windowMs = 60000, max = 60, key = (req) => req.ip, message = 'Too many requests. Wait a minute and try again.' } = {}) {
  const hits = new Map();
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, windowMs);
  sweep.unref();
  return (req, res, next) => {
    const k = key(req);
    const now = Date.now();
    let h = hits.get(k);
    if (!h || h.reset <= now) { h = { n: 0, reset: now + windowMs }; hits.set(k, h); }
    h.n += 1;
    if (h.n > max) {
      res.setHeader('Retry-After', String(Math.ceil((h.reset - now) / 1000)));
      return res.status(429).type('text/plain').send(message);
    }
    next();
  };
}
module.exports = { rateLimit };
