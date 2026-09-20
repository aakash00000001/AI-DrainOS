const config = require("../config/env");

function createRateLimiter({ name, windowMs, max, shouldLimit }) {
  const hits = new Map();
  const sweepInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (entry.resetAt <= now) hits.delete(key);
    }
  }, Math.min(windowMs, 60000)).unref();

  return function rateLimiter(req, res, next) {
    if (shouldLimit && !shouldLimit(req)) return next();
    if (config.isTest || config.rateLimits.enabled === false) return next();

    const key = req.ip || req.socket.remoteAddress || "unknown";
    const now = Date.now();

    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;

    if (entry.count > max) {
      const retryAfter = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
      res.setHeader("Retry-After", String(retryAfter));
      return res.status(429).json({
        error: {
          code: "RATE_LIMITED",
          message: `Too many requests. Try again in ${retryAfter} second(s).`,
          requestId: req.id
        }
      });
    }
    next();
  };

  rateLimiter.name = name;
  rateLimiter.dispose = () => clearInterval(sweepInterval);
  return rateLimiter;
}

module.exports = { createRateLimiter };