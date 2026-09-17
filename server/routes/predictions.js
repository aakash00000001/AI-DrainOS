const express = require("express");
const router = express.Router();
const axios = require("axios");
const multer = require("multer");
const pool = require("../config/db");

const floodRisk = require("../services/floodRiskService");
const floodForecast = require("../services/floodForecastService");
const maintenanceService = require("../services/maintenancePredictionService");
const visionService = require("../services/drainVisionService");
const decisionEngine = require("../services/decisionEngine");
const robotPathPlanning = require("../services/robotPathPlanningService");
const mqttService = require("../services/mqttService");

const AI_SERVICE_URL =
  process.env.AI_SERVICE_URL || "http://127.0.0.1:5001";

let aiUnreachableLoggedAt = null;

// --------------------------------------------------
// Vision image upload (secure multipart handling)
//
// - JPG/JPEG/PNG/WEBP only (extension + declared MIME must both
//   pass, and the actual file bytes are re-checked in the route).
// - 5 MB cap enforced by multer.
// - Memory storage: images are processed in memory and never
//   written to disk or stored in the database.
// --------------------------------------------------

const visionUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: visionService.MAX_IMAGE_BYTES },
  fileFilter(req, file, cb) {
    const name = String(file.originalname || "").toLowerCase();
    const extOk = visionService.ALLOWED_EXTENSIONS.some((ext) => name.endsWith(ext));
    const mimeOk = visionService.ALLOWED_MIME_TYPES.includes(file.mimetype);

    if (!extOk || !mimeOk) {
      cb(null, false);
      return;
    }

    cb(null, true);
  }
});

function handleVisionUpload(req, res, next) {
  visionUpload.single("image")(req, res, (err) => {
    if (err) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({ error: "Image exceeds the 5 MB limit" });
      }

      return res.status(400).json({ error: "Invalid image upload: " + err.message });
    }

    next();
  });
}

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

// --------------------------------------------------
// GET /api/predictions/forecast/:drainId
// --------------------------------------------------
// Predictive flood forecast (15/30/60 minutes) for a single
// drain. Uses the same public model as GET /api/predictions (no
// auth) and does not expose server configuration. No confidence
// values are fabricated - the model is an explainable baseline.
// --------------------------------------------------

router.get("/forecast/:drainId", async (req, res) => {
  try {
    const drainId = Number(req.params.drainId);

    if (!Number.isInteger(drainId) || drainId <= 0) {
      return res.status(400).json({ error: "Invalid drain id" });
    }

    const forecast = await floodForecast.getDrainForecast(drainId);

    if (!forecast) {
      return res.status(404).json({ error: "Drain or sensor not found" });
    }

    res.json(forecast);
  } catch (err) {
    console.log("========== FLOOD FORECAST API ERROR ==========");
    console.log(err.message);

    res.status(500).json({ error: "Flood forecast calculation failed" });
  }
});

// --------------------------------------------------
// GET /api/predictions/maintenance/:drainId
// --------------------------------------------------
// Maintenance & blockage prediction for a single drain: does the
// drain show signs inspection, cleaning or maintenance may soon
// be required? Uses the same public model as GET /api/predictions
// (no auth). Returns an honest INSUFFICIENT_DATA status when not
// enough history exists - no fabricated score or confidence.
// --------------------------------------------------

router.get("/maintenance/:drainId", async (req, res) => {
  try {
    const drainId = Number(req.params.drainId);

    if (!Number.isInteger(drainId) || drainId <= 0) {
      return res.status(400).json({ error: "Invalid drain id" });
    }

    const prediction = await maintenanceService.getDrainMaintenance(drainId);

    if (!prediction) {
      return res.status(404).json({ error: "Drain not found" });
    }

    res.json(prediction);
  } catch (err) {
    console.log("========== MAINTENANCE PREDICTION API ERROR ==========");
    console.log(err.message);

    res.status(500).json({ error: "Maintenance prediction failed" });
  }
});

// --------------------------------------------------
// GET /api/predictions/decision/:drainId
// --------------------------------------------------
// AI Drain Decision & Priority Engine for a single drain:
// a bounded 0-100 attention-priority score blending the existing
// flood risk, forecast, maintenance and vision signals, plus the
// recommended action, reasons, contributing factors and robot
// dispatch context. Missing signals are reported as unavailable
// (status INSUFFICIENT_DATA when nothing is available) - no
// fabricated values. Same public model as GET /api/predictions
// (no auth).
// --------------------------------------------------

router.get("/decision/:drainId", async (req, res) => {
  try {
    const drainId = Number(req.params.drainId);

    if (!Number.isInteger(drainId) || drainId <= 0) {
      return res.status(400).json({ error: "Invalid drain id" });
    }

    const decision = await decisionEngine.getDrainDecision(drainId);

    if (!decision) {
      return res.status(404).json({ error: "Drain not found" });
    }

    res.json(decision);
  } catch (err) {
    console.log("========== DECISION ENGINE API ERROR ==========");
    console.log(err.message);

    res.status(500).json({ error: "Decision calculation failed" });
  }
});

// --------------------------------------------------
// GET /api/predictions/robot-route/:drainId
// --------------------------------------------------
// Intelligent robot path planning & route optimization for a
// single drain: selects the best available robot, plans a
// battery-aware route (direct or via a charging station) and
// returns explainable waypoints, distance, time and battery
// estimates. Additive - the decision engine is untouched.
// --------------------------------------------------

router.get("/robot-route/:drainId", async (req, res) => {
  try {
    const drainId = Number(req.params.drainId);

    if (!Number.isInteger(drainId) || drainId <= 0) {
      return res.status(400).json({ error: "Invalid drain id" });
    }

    const result = await robotPathPlanning.planRoute(drainId);

    if (result.status === "DRAIN_NOT_FOUND") {
      return res.status(404).json({ error: "Drain not found" });
    }

    res.json(result);
  } catch (err) {
    console.log("========== ROBOT PATH PLANNING API ERROR ==========");
    console.log(err.message);

    res.status(500).json({ error: "Robot route planning failed" });
  }
});

// --------------------------------------------------
// POST /api/predictions/vision/:drainId
// --------------------------------------------------
// Baseline computer-vision drain inspection: upload a single
// image (field "image", JPG/JPEG/PNG/WEBP, max 5 MB), decode and
// analyze it, and return honest READY or INSUFFICIENT_IMAGE_
// QUALITY results. The image is processed in memory only - never
// stored on disk or in the database (metadata is stored only).
//
// Same public model as GET /api/predictions (no auth). Invalid
// drain id -> 400, unknown drain -> 404, invalid image -> 400.
// --------------------------------------------------

router.post("/vision/:drainId", handleVisionUpload, async (req, res) => {
  try {
    const drainId = Number(req.params.drainId);

    if (!Number.isInteger(drainId) || drainId <= 0) {
      return res.status(400).json({ error: "Invalid drain id" });
    }

    const drainExists = await pool.query(
      "SELECT id FROM drains WHERE id = $1",
      [drainId]
    );

    if (drainExists.rows.length === 0) {
      return res.status(404).json({ error: "Drain not found" });
    }

    if (!req.file) {
      return res.status(400).json({
        error:
          "Image file is required (multipart field 'image', JPG/JPEG/PNG/WEBP)"
      });
    }

    // Defense in depth: verify the actual bytes are a supported
    // image regardless of the declared filename/Content-Type.
    const detectedType = visionService.detectImageType(req.file.buffer);

    if (!detectedType) {
      return res.status(400).json({
        error: "Unsupported or invalid image - JPG, JPEG, PNG or WEBP required"
      });
    }

    const result = await visionService.analyzeDrainImage(drainId, {
      buffer: req.file.buffer,
      mimetype: req.file.mimetype,
      originalname: req.file.originalname
    });

    if (!result) {
      return res.status(404).json({ error: "Drain not found" });
    }

    res.json(result);
  } catch (err) {
    console.log("========== VISION INSPECTION API ERROR ==========");
    console.log(err.message);

    res.status(500).json({ error: "Vision inspection failed" });
  }
});

// --------------------------------------------------
// GET /api/predictions/vision/:drainId
// --------------------------------------------------
// Latest vision inspection result for a single drain, plus a
// short history of recent inspections (additive - the latest
// result is at the root of the response). 404 when the drain has
// no vision inspection yet.
// --------------------------------------------------

router.get("/vision/:drainId", async (req, res) => {
  try {
    const drainId = Number(req.params.drainId);

    if (!Number.isInteger(drainId) || drainId <= 0) {
      return res.status(400).json({ error: "Invalid drain id" });
    }

    const historyLimit = Math.min(
      Math.max(Number(req.query.history) || 5, 1),
      20
    );

    const latest = await visionService.getLatestInspection(drainId, historyLimit);

    if (!latest) {
      return res.status(404).json({ error: "No vision inspection found for this drain" });
    }

    res.json(latest);
  } catch (err) {
    console.log("========== VISION INSPECTION API ERROR ==========");
    console.log(err.message);

    res.status(500).json({ error: "Vision inspection lookup failed" });
  }
});

module.exports = router;