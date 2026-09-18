// ============================================================
// AI-DrainOS Historical Intelligence routes
//
// UPDATE #20A — READ-ONLY historical analytics foundation.
//
// Mounted at /api/historical. Public read-only endpoints following
// the existing analytics/dashboard conventions (no mutation, no
// auth wall required for read analytics in this project).
//
// Query params:
//   ?period=24h|7d|30d|90d   (alias: ?window=)   default 30d
//   ?drainId=<positive int>  (optional filter)
//
// Invalid params return HTTP 400. Raw database errors are never
// exposed to the client.
// ============================================================

const express = require("express");
const router = express.Router();

const historical = require("../services/historicalIntelligenceService");

// ------------------------------------------------------------
// Shared request option parsing + validation
// ------------------------------------------------------------

function parseOptions(req) {
  const rawPeriod =
    req.query.period !== undefined ? req.query.period : req.query.window;

  const window = historical.resolvePeriod(rawPeriod);
  if (!window) {
    return {
      ok: false,
      status: 400,
      body: {
        error: "Invalid period",
        message: `period must be one of: ${historical.VALID_PERIODS.join(", ")}`,
        allowed_periods: historical.VALID_PERIODS,
        default_period: historical.DEFAULT_PERIOD
      }
    };
  }

  const drain = historical.parseDrainId(req.query.drainId);
  if (!drain.ok) {
    return {
      ok: false,
      status: 400,
      body: {
        error: "Invalid drainId",
        message: "drainId must be a positive integer"
      }
    };
  }

  return { ok: true, options: { period: window.period, drainId: drain.value } };
}

function handle(res, promise) {
  promise
    .then((data) => {
      if (data === null) {
        return res.status(400).json({ error: "Invalid period" });
      }
      return res.json(data);
    })
    .catch((err) => {
      console.log(err);
      return res.status(500).json({ error: "Historical Intelligence Error" });
    });
}

// ------------------------------------------------------------
// GET /api/historical — full historical overview
// ------------------------------------------------------------

router.get("/", async (req, res) => {
  const parsed = parseOptions(req);
  if (!parsed.ok) return res.status(parsed.status).json(parsed.body);
  return handle(res, historical.getHistoricalOverview(parsed.options));
});

// ------------------------------------------------------------
// GET /api/historical/overview — full historical overview (alias)
// ------------------------------------------------------------

router.get("/overview", async (req, res) => {
  const parsed = parseOptions(req);
  if (!parsed.ok) return res.status(parsed.status).json(parsed.body);
  return handle(res, historical.getHistoricalOverview(parsed.options));
});

// ------------------------------------------------------------
// GET /api/historical/summary — compact summary
// ------------------------------------------------------------

router.get("/summary", async (req, res) => {
  const parsed = parseOptions(req);
  if (!parsed.ok) return res.status(parsed.status).json(parsed.body);
  return handle(res, historical.getHistoricalSummary(parsed.options));
});

// ------------------------------------------------------------
// GET /api/historical/sensors — historical sensor analytics
// ------------------------------------------------------------

router.get("/sensors", async (req, res) => {
  const parsed = parseOptions(req);
  if (!parsed.ok) return res.status(parsed.status).json(parsed.body);
  return handle(res, historical.getSensorHistory(parsed.options));
});

// ------------------------------------------------------------
// GET /api/historical/trends — sensor trend view
// ------------------------------------------------------------

router.get("/trends", async (req, res) => {
  const parsed = parseOptions(req);
  if (!parsed.ok) return res.status(parsed.status).json(parsed.body);

  handle(
    res,
    historical.getSensorHistory(parsed.options).then((data) => {
      if (data === null) return null;
      return {
        period: data.period,
        start_time: data.start_time,
        end_time: data.end_time,
        drain_id: data.drain_id,
        status: data.status,
        reading_count: data.reading_count,
        sensor_count: data.sensor_count,
        trends: data.sensors.map((sensor) => ({
          sensor_id: sensor.sensor_id,
          drain_id: sensor.drain_id,
          zone: sensor.zone,
          location: sensor.location,
          reading_count: sensor.reading_count,
          latest_timestamp: sensor.latest_timestamp,
          water_level_trend: sensor.water_level.trend,
          gas_level_trend: sensor.gas_level.trend,
          temperature_trend: sensor.temperature.trend,
          water_level: sensor.water_level,
          gas_level: sensor.gas_level,
          temperature: sensor.temperature
        })),
        data_quality: data.data_quality,
        disclaimer: data.disclaimer,
        generated_at: data.generated_at
      };
    })
  );
});

// ------------------------------------------------------------
// GET /api/historical/drains — per-drain history + health
// ------------------------------------------------------------

router.get("/drains", async (req, res) => {
  const parsed = parseOptions(req);
  if (!parsed.ok) return res.status(parsed.status).json(parsed.body);
  return handle(res, historical.getDrainHistory(parsed.options));
});

// ------------------------------------------------------------
// GET /api/historical/incidents — incident history
// ------------------------------------------------------------

router.get("/incidents", async (req, res) => {
  const parsed = parseOptions(req);
  if (!parsed.ok) return res.status(parsed.status).json(parsed.body);
  return handle(res, historical.getIncidentHistory(parsed.options));
});

// ------------------------------------------------------------
// GET /api/historical/missions — mission history
// ------------------------------------------------------------

router.get("/missions", async (req, res) => {
  const parsed = parseOptions(req);
  if (!parsed.ok) return res.status(parsed.status).json(parsed.body);
  return handle(res, historical.getMissionHistory(parsed.options));
});

// ------------------------------------------------------------
// GET /api/historical/robots — robot response history
// (per-robot mission aggregation derived from real missions)
// ------------------------------------------------------------

router.get("/robots", async (req, res) => {
  const parsed = parseOptions(req);
  if (!parsed.ok) return res.status(parsed.status).json(parsed.body);

  handle(
    res,
    historical.getMissionHistory(parsed.options).then((data) => {
      if (data === null) return null;
      return {
        period: data.period,
        start_time: data.start_time,
        end_time: data.end_time,
        drain_id: data.drain_id,
        status: data.robots.length > 0 ? "OK" : "INSUFFICIENT_DATA",
        robot_count: data.robots.length,
        robots: data.robots,
        average_mission_duration_seconds: data.average_mission_duration_seconds,
        average_mission_duration_minutes: data.average_mission_duration_minutes,
        average_response_seconds: data.average_response_seconds,
        response_time_available: data.response_time_available,
        data_quality: data.data_quality,
        disclaimer: data.disclaimer,
        generated_at: data.generated_at
      };
    })
  );
});

// ------------------------------------------------------------
// GET /api/historical/alerts — alert history
// ------------------------------------------------------------

router.get("/alerts", async (req, res) => {
  const parsed = parseOptions(req);
  if (!parsed.ok) return res.status(parsed.status).json(parsed.body);
  return handle(res, historical.getAlertHistory(parsed.options));
});

// ------------------------------------------------------------
// GET /api/historical/patterns — descriptive time patterns
// ------------------------------------------------------------

router.get("/patterns", async (req, res) => {
  const parsed = parseOptions(req);
  if (!parsed.ok) return res.status(parsed.status).json(parsed.body);
  return handle(res, historical.getTimePatterns(parsed.options));
});

// ------------------------------------------------------------
// GET /api/historical/comparison — current vs historical
// ------------------------------------------------------------

router.get("/comparison", async (req, res) => {
  const parsed = parseOptions(req);
  if (!parsed.ok) return res.status(parsed.status).json(parsed.body);
  return handle(res, historical.getComparison(parsed.options));
});

module.exports = router;
