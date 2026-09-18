// ============================================================
// AI-DrainOS Weather + Flood Correlation API
//   /api/predictions/weather-correlation
//
// Weather + Flood Correlation Intelligence (Update #23).
//
// Read-only views computing descriptive Pearson correlations
// between REAL weather observations and REAL recorded sensor
// readings. Honest states only: WEATHER_UNAVAILABLE /
// INSUFFICIENT_DATA / NOT_AVAILABLE - never fabricated scores,
// history or causal claims.
// ============================================================

const express = require("express");
const router = express.Router();

const weatherFloodCorrelation = require("../services/weatherFloodCorrelationService");

const { SIGNAL_KEYS, LAG_OPTIONS, MAX_WINDOW_HOURS } = weatherFloodCorrelation;

function parseId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    return null;
  }
  return id;
}

function parseWindow(value) {
  if (value === undefined || value === "") return null;
  const v = Number(value);
  if (!Number.isInteger(v) || v < 1 || v > MAX_WINDOW_HOURS) {
    return "invalid";
  }
  return v;
}

function parseLag(value) {
  if (value === undefined || value === "") return 0;
  const v = Number(value);
  if (!Number.isInteger(v) || !LAG_OPTIONS.includes(v)) {
    return "invalid";
  }
  return v;
}

function invalidSignalResponse(signal) {
  return {
    error: "Invalid correlation signal",
    signal,
    valid_signals: SIGNAL_KEYS
  };
}

// --------------------------------------------------
// GET /api/predictions/weather-correlation
// Full overview: data quality, per-signal results, strongest
// association, latest weather. Optional ?window= filter.
// --------------------------------------------------

router.get("/", async (req, res) => {
  try {
    const windowHours = parseWindow(req.query.window);
    if (windowHours === "invalid") {
      return res.status(400).json({ error: "Invalid window hours" });
    }
    const summary = await weatherFloodCorrelation.getCorrelationSummary({ windowHours });
    res.json(summary);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server Error" });
  }
});

// --------------------------------------------------
// GET /api/predictions/weather-correlation/summary
// Compact fleet-wide summary used by the dashboard + analytics.
// --------------------------------------------------

router.get("/summary", async (req, res) => {
  try {
    const windowHours = parseWindow(req.query.window);
    if (windowHours === "invalid") {
      return res.status(400).json({ error: "Invalid window hours" });
    }
    const summary = await weatherFloodCorrelation.getCorrelationSummary({ windowHours });
    res.json(summary);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server Error" });
  }
});

// --------------------------------------------------
// GET /api/predictions/weather-correlation/signals
// Signal definitions plus their current computed status.
// --------------------------------------------------

router.get("/signals", async (req, res) => {
  try {
    const windowHours = parseWindow(req.query.window);
    if (windowHours === "invalid") {
      return res.status(400).json({ error: "Invalid window hours" });
    }
    const result = await weatherFloodCorrelation.getCorrelationSignals({ windowHours });
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server Error" });
  }
});

// --------------------------------------------------
// GET /api/predictions/weather-correlation/trends
// Time-bucketed correlation trend for a signal. Query params:
// ?signal=rainfall_water_level&drainId=&window=&lag=15|30|60
// --------------------------------------------------

router.get("/trends", async (req, res) => {
  try {
    const { signal } = req.query;
    if (signal && !SIGNAL_KEYS.includes(signal)) {
      return res.status(400).json(invalidSignalResponse(signal));
    }

    let drainId = null;
    if (req.query.drainId !== undefined && req.query.drainId !== "") {
      drainId = parseId(req.query.drainId);
      if (drainId === null) {
        return res.status(400).json({ error: "Invalid drain id" });
      }
    }

    const windowHours = parseWindow(req.query.window);
    if (windowHours === "invalid") {
      return res.status(400).json({ error: "Invalid window hours" });
    }

    const lagMinutes = parseLag(req.query.lag);
    if (lagMinutes === "invalid") {
      return res
        .status(400)
        .json({ error: "Invalid lag minutes", valid_lag_minutes: LAG_OPTIONS });
    }

    const result = await weatherFloodCorrelation.getCorrelationTrends({
      signal,
      drainId,
      windowHours,
      lagMinutes
    });

    if (!result) {
      return res.status(400).json(invalidSignalResponse(signal));
    }

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server Error" });
  }
});

// --------------------------------------------------
// GET /api/predictions/weather-correlation/drains
// Per-drain correlations across all weather signals.
// --------------------------------------------------

router.get("/drains", async (req, res) => {
  try {
    const windowHours = parseWindow(req.query.window);
    if (windowHours === "invalid") {
      return res.status(400).json({ error: "Invalid window hours" });
    }
    const result = await weatherFloodCorrelation.getDrainCorrelations({ windowHours });
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server Error" });
  }
});

// --------------------------------------------------
// GET /api/predictions/weather-correlation/drain/:drainId
// Full per-drain correlation detail. Query params:
// ?signal=&window=&lag=
// --------------------------------------------------

router.get("/drain/:drainId", async (req, res) => {
  try {
    const drainId = parseId(req.params.drainId);
    if (drainId === null) {
      return res.status(400).json({ error: "Invalid drain id" });
    }

    const { signal } = req.query;
    if (signal && !SIGNAL_KEYS.includes(signal)) {
      return res.status(400).json(invalidSignalResponse(signal));
    }

    const windowHours = parseWindow(req.query.window);
    if (windowHours === "invalid") {
      return res.status(400).json({ error: "Invalid window hours" });
    }

    const lagMinutes = parseLag(req.query.lag);
    if (lagMinutes === "invalid") {
      return res
        .status(400)
        .json({ error: "Invalid lag minutes", valid_lag_minutes: LAG_OPTIONS });
    }

    const result = await weatherFloodCorrelation.getDrainCorrelation(drainId, {
      signal,
      windowHours,
      lagMinutes
    });

    if (!result) {
      return res.status(404).json({ error: "Drain not found" });
    }

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server Error" });
  }
});

// --------------------------------------------------
// GET /api/predictions/weather-correlation/:signal
// Single-signal correlation. Query params:
// ?drainId=&window=&lag=
// --------------------------------------------------

router.get("/:signal", async (req, res) => {
  try {
    const { signal } = req.params;
    if (!SIGNAL_KEYS.includes(signal)) {
      return res.status(400).json(invalidSignalResponse(signal));
    }

    let drainId = null;
    if (req.query.drainId !== undefined && req.query.drainId !== "") {
      drainId = parseId(req.query.drainId);
      if (drainId === null) {
        return res.status(400).json({ error: "Invalid drain id" });
      }
    }

    const windowHours = parseWindow(req.query.window);
    if (windowHours === "invalid") {
      return res.status(400).json({ error: "Invalid window hours" });
    }

    const lagMinutes = parseLag(req.query.lag);
    if (lagMinutes === "invalid") {
      return res
        .status(400)
        .json({ error: "Invalid lag minutes", valid_lag_minutes: LAG_OPTIONS });
    }

    const result = await weatherFloodCorrelation.getWeatherCorrelation({
      signal,
      drainId,
      windowHours,
      lagMinutes
    });

    if (!result) {
      return res.status(404).json({ error: "Signal not found" });
    }

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server Error" });
  }
});

module.exports = router;