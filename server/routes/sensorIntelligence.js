// ============================================================
// AI-DrainOS Sensor Intelligence API
//   /api/predictions/sensor-intelligence
//
// Advanced IoT Sensor Intelligence & Anomaly Detection
// (Update #21).
//
// Read-only views over the EXISTING sensors + sensor_readings
// data. Same public model as the other /api/predictions
// endpoints (no auth). Responds with honest INSUFFICIENT_DATA /
// NO_SENSORS states - never fabricated scores or history.
// ============================================================

const express = require("express");
const router = express.Router();

const sensorIntelligence = require("../services/sensorIntelligenceService");

function parseId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    return null;
  }
  return id;
}

// --------------------------------------------------
// GET /api/predictions/sensor-intelligence
// Full intelligence view: summary, drain aggregates, sensors and
// anomalies. Optional ?drainId= filter.
// --------------------------------------------------

router.get("/", async (req, res) => {
  try {
    let drainId = null;

    if (req.query.drainId !== undefined && req.query.drainId !== "") {
      drainId = parseId(req.query.drainId);

      if (drainId === null) {
        return res.status(400).json({ error: "Invalid drain id" });
      }
    }

    const intelligence = await sensorIntelligence.getSensorIntelligence({ drainId });

    if (!intelligence) {
      return res.status(404).json({ error: "Drain not found" });
    }

    res.json(intelligence);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server Error" });
  }
});

// --------------------------------------------------
// GET /api/predictions/sensor-intelligence/summary
// Fleet-wide sensor health + anomaly summary.
// --------------------------------------------------

router.get("/summary", async (req, res) => {
  try {
    const summary = await sensorIntelligence.getSummary();
    res.json(summary);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server Error" });
  }
});

// --------------------------------------------------
// GET /api/predictions/sensor-intelligence/anomalies
// All anomalies, optionally filtered by ?type= &severity=.
// --------------------------------------------------

router.get("/anomalies", async (req, res) => {
  try {
    const result = await sensorIntelligence.getSensorAnomalies({
      type: req.query.type || null,
      severity: req.query.severity || null
    });

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server Error" });
  }
});

// --------------------------------------------------
// GET /api/predictions/sensor-intelligence/anomalies/:sensorId
// --------------------------------------------------

router.get("/anomalies/:sensorId", async (req, res) => {
  try {
    const sensorId = parseId(req.params.sensorId);

    if (sensorId === null) {
      return res.status(400).json({ error: "Invalid sensor id" });
    }

    const result = await sensorIntelligence.getSensorAnomalies({
      sensorId,
      type: req.query.type || null,
      severity: req.query.severity || null
    });

    if (!result) {
      return res.status(404).json({ error: "Sensor not found" });
    }

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server Error" });
  }
});

// --------------------------------------------------
// GET /api/predictions/sensor-intelligence/drain/:drainId
// Drain-level aggregation: counts, health status, anomaly totals
// and cross-sensor consistency.
// --------------------------------------------------

router.get("/drain/:drainId", async (req, res) => {
  try {
    const drainId = parseId(req.params.drainId);

    if (drainId === null) {
      return res.status(400).json({ error: "Invalid drain id" });
    }

    const result = await sensorIntelligence.getDrainSensorIntelligence(drainId);

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
// GET /api/predictions/sensor-intelligence/:sensorId
// Single sensor health + anomaly detail.
// --------------------------------------------------

router.get("/:sensorId", async (req, res) => {
  try {
    const sensorId = parseId(req.params.sensorId);

    if (sensorId === null) {
      return res.status(400).json({ error: "Invalid sensor id" });
    }

    const result = await sensorIntelligence.getSensorIntelligenceById(sensorId);

    if (!result) {
      return res.status(404).json({ error: "Sensor not found" });
    }

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server Error" });
  }
});

module.exports = router;
