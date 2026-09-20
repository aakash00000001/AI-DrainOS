// ============================================================
// gracefulShutdown.js
//
// Update #25 - Single-invocation graceful shutdown helper. Stops
// the live loop, ends MQTT + socket connections, closes the HTTP
// server, then drains the DB pool. A force-exit timer guarantees
// the process always exits.
// ============================================================

const logger = require("../config/logger");

function safeClose(fn, label, timeoutMs = 10000) {
  return new Promise((resolve) => {
    if (typeof fn !== "function") return resolve();
    const timer = setTimeout(() => {
      logger.warn(`${label} close timed out`);
      resolve();
    }, timeoutMs);
    if (timer.unref) timer.unref();
    try {
      const result = fn();
      if (result && typeof result.then === "function") {
        result.then(() => { clearTimeout(timer); resolve(); })
          .catch(() => { clearTimeout(timer); resolve(); });
      } else {
        clearTimeout(timer);
        resolve();
      }
    } catch (err) {
      clearTimeout(timer);
      logger.warn(`${label} close failed`, { message: err.message });
      resolve();
    }
  });
}

function installShutdown({ server, io, pool, liveLoop, getMqttClient, timeoutMs = 10000 } = {}) {
  let shuttingDown = false;

  return async function shutdown(signal) {
    if (shuttingDown) {
      logger.info("Shutdown already in progress; ignoring duplicate signal", { signal });
      return;
    }
    shuttingDown = true;

    logger.info("Graceful shutdown started", { signal });

    const forceExitTimer = setTimeout(() => {
      logger.error("Graceful shutdown timed out; forcing exit");
      process.exit(1);
    }, timeoutMs);
    if (forceExitTimer.unref) forceExitTimer.unref();

    try {
      if (liveLoop && typeof liveLoop.stop === "function") {
        liveLoop.stop();
      }

      const mqttClient = typeof getMqttClient === "function" ? getMqttClient() : null;
      if (mqttClient && typeof mqttClient.end === "function") {
        await safeClose((done) => mqttClient.end(true, done), "MQTT");
      }

      if (io && typeof io.close === "function") {
        await safeClose((done) => io.close(done), "Socket.IO");
      }

      if (server && typeof server.close === "function") {
        await safeClose((done) => server.close(done), "HTTP server");
      }

      if (pool && typeof pool.end === "function") {
        await safeClose(() => pool.end(), "PostgreSQL pool", 5000);
      }

      clearTimeout(forceExitTimer);
      logger.info("Graceful shutdown complete");
      process.exit(0);
    } catch (err) {
      clearTimeout(forceExitTimer);
      logger.error("Graceful shutdown error", { message: err.message });
      process.exit(1);
    }
  };
}

module.exports = { installShutdown };