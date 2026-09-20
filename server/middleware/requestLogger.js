const crypto = require("crypto");
const logger = require("../config/logger");

function requestLogger(req, res, next) {
  req.id = req.headers["x-request-id"] || crypto.randomUUID();
  res.setHeader("X-Request-Id", req.id);

  const startedAt = process.hrtime.bigint();
  const onFinish = () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const isHealth = req.originalUrl === "/health" || req.originalUrl === "/ready";
    const entry = {
      requestId: req.id,
      method: req.method,
      url: req.originalUrl,
      status: res.statusCode,
      durationMs: Math.round(durationMs * 10) / 10,
      ip: req.ip
    };
    if (isHealth) {
      logger.debug("HTTP request", entry);
    } else {
      logger.info("HTTP request", entry);
    }
  };
  res.on("finish", onFinish);
  next();
}

module.exports = requestLogger;