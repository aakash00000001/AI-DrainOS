const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const pool = require("./config/db");
const config = require("./config/env");

const requestLogger = require("./middleware/requestLogger");
const { notFoundHandler, errorHandler } = require("./middleware/errorHandler");
const { createRateLimiter } = require("./middleware/rateLimiter");

const app = express();

app.disable("x-powered-by");

// Request ID + structured access logging (health/ready logged at debug).
app.use(requestLogger);

// Security headers (CSP and COEP disabled: the API serves JSON and the SPA is
// deployed separately; SCADA-of-the-DrainOS dashboards may use inline assets).
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

// CORS: restricted to FRONTEND_URL in production (validated at startup).
// In development with no FRONTEND_URL set, all origins are allowed.
app.use(
  cors(
    config.frontendOrigins.length > 0
      ? {
          origin: config.frontendOrigins,
          credentials: true
        }
      : {}
  )
);

app.use(express.json({ limit: config.jsonBodyLimit }));

// --------------------------------------------------
// HEALTH / READINESS
// --------------------------------------------------

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

app.get("/ready", async (req, res) => {
  const timeoutMs = 3000;
  const timer = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("database check timed out")), timeoutMs)
  );
  try {
    await Promise.race([pool.query("SELECT 1"), timer]);
    res.json({ status: "ok", checks: { database: "up" } });
  } catch (err) {
    res.status(503).json({
      status: "unavailable",
      checks: { database: "down" }
    });
  }
});

// Analysiss / dashboard endpoints are heavy read-only queries; apply a
// generous per-IP limiter so dashboards keep polling but can't be abused.
const analyticsLimiter = createRateLimiter({
  name: "analyticsLimiter",
  windowMs: config.rateLimits.analytics.windowMs,
  max: config.rateLimits.analytics.max
});
app.use("/api/analytics", analyticsLimiter);
app.use("/api/dashboard", analyticsLimiter);
app.use("/api/historical", analyticsLimiter);

// --------------------------------------------------
// ROUTES
// --------------------------------------------------

app.use("/api/drains", require("./routes/drains"));
app.use("/api/alerts", require("./routes/alerts"));
app.use("/api/auth", require("./routes/auth"));
app.use("/api/sensors", require("./routes/sensors"));
app.use("/api/robots", require("./routes/robots"));
app.use(
  "/api/predictions/sensor-intelligence",
  require("./routes/sensorIntelligence")
);
app.use(
  "/api/predictions/weather-correlation",
  require("./routes/weatherFloodCorrelation")
);
app.use("/api/predictions", require("./routes/predictions"));
app.use("/api/weather", require("./routes/weather"));
app.use("/api/analytics", require("./routes/analytics"));
app.use("/api/dashboard", require("./routes/dashboard"));
app.use("/api/missions/coordination", require("./routes/missionCoordination"));
app.use("/api/missions", require("./routes/missions"));
app.use("/api/incidents", require("./routes/incidents"));
app.use("/api/fleet-optimization", require("./routes/fleetOptimization"));
app.use("/api/audit", require("./routes/decisionAudit"));
app.use("/api/historical", require("./routes/historicalIntelligence"));
app.use("/api/charging-stations", require("./routes/chargingStations"));
app.use("/api/settings", require("./routes/settings"));

app.get("/", (req, res) => {
  res.send("AI-DrainOS Server Running");
});

// --------------------------------------------------
// 404 + GLOBAL ERROR HANDLER (must be last)
// --------------------------------------------------

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;