const express = require("express");
const router = express.Router();
const axios = require("axios");
const pool = require("../config/db");

const floodRisk = require("../services/floodRiskService");
const mqttService = require("../services/mqttService");

const AI_SERVICE_URL =
  process.env.AI_SERVICE_URL || "http://127.0.0.1:5001";

let aiUnreachableLoggedAt = null;

function logAiUnreachable(message) {
  const now = Date.now();

  if (!aiUnreachableLoggedAt || now - aiUnreachableLoggedAt > 60000) {
    console.log("⚠️ AI service unreachable, using fallback:", message);
    aiUnreachableLoggedAt = now;
  }
}

async function getThresholds() {
  const result = await pool.query(`
    SELECT key, value
    FROM settings
    WHERE key IN ('critical_threshold', 'warning_threshold')
  `);

  const thresholds = {
    critical_threshold: 80,
    warning_threshold: 50
  };

  result.rows.forEach((row) => {
    thresholds[row.key] = Number(row.value);
  });

  return thresholds;
}

function fallbackPrediction(sensor, thresholds) {
  if (sensor.water_level >= thresholds.critical_threshold) {
    return "HIGH";
  }

  if (sensor.water_level >= thresholds.warning_threshold) {
    return "MEDIUM";
  }

  return "LOW";
}

router.get("/", async (req, res) => {

    try {

    const result = await pool.query(`
      SELECT
        water_level,
        gas_level,
        temperature
      FROM sensors
      ORDER BY id DESC
      LIMIT 1
    `);

    if (result.rows.length === 0) {

      return res.status(404).json({
        error: "No Sensor Data"
      });

    }

    const sensor = result.rows[0];

    try {

      const aiResponse = await axios.post(
        `${AI_SERVICE_URL}/predict`,
        {
          water_level: sensor.water_level,
          gas_level: sensor.gas_level,
          temperature: sensor.temperature
        },
        { timeout: 3000 }
      );

      return res.json({

        prediction: aiResponse.data.prediction,

        sensor,

        source: "ai"

      });

    } catch (aiErr) {

      logAiUnreachable(aiErr.message);

      const thresholds = await getThresholds();

      return res.json({

        prediction: fallbackPrediction(sensor, thresholds),

        sensor,

        source: "fallback"

      });

    }

  }

 catch (err) {

  console.log("========== AI ERROR ==========");

  console.log("Message:", err.message);

  res.status(500).json({
    error: err.response?.data || err.message
  });

}

});

// --------------------------------------------------
// GET /api/predictions/risk/:drainId
// --------------------------------------------------
// Flood Risk Intelligence detail for a single drain: risk score,
// risk level, explainable breakdown + factors, and the AI
// prediction (reusing the MQTT service's throttled + fallback AI
// pipeline so no duplicate AI calls are made).
//
// Follows the existing public predictions model (no auth), the
// same as GET /api/predictions. No server configuration is
// exposed.
// --------------------------------------------------

router.get("/risk/:drainId", async (req, res) => {
  try {
    const drainId = Number(req.params.drainId);

    if (!Number.isInteger(drainId) || drainId <= 0) {
      return res.status(400).json({ error: "Invalid drain id" });
    }

    const detail = await floodRisk.buildDrainRiskDetail(drainId);

    if (!detail) {
      return res.status(404).json({ error: "Drain or sensor not found" });
    }

    const { prediction, source } = await mqttService.getPrediction(
      drainId,
      {
        water_level: detail.waterLevel,
        gas_level: detail.gasLevel,
        temperature: detail.temperature
      },
      mqttService.defaultPredict
    );

    res.json({
      drainId,
      sensorId: detail.sensorId,
      riskScore: detail.riskScore,
      riskLevel: detail.riskLevel,
      prediction,
      predictionSource: source,
      breakdown: detail.breakdown,
      factors: detail.factors,
      waterLevel: detail.waterLevel,
      gasLevel: detail.gasLevel,
      temperature: detail.temperature,
      timestamp: detail.timestamp
    });
  } catch (err) {
    console.log("========== FLOOD RISK API ERROR ==========");
    console.log(err.message);

    res.status(500).json({ error: "Flood risk calculation failed" });
  }
});

module.exports = router;