const express = require("express");
const router = express.Router();
const pool = require("../config/db");

const floodRisk = require("../services/floodRiskService");
const floodForecast = require("../services/floodForecastService");
const maintenanceService = require("../services/maintenancePredictionService");
const decisionEngine = require("../services/decisionEngine");
const robotPathPlanning = require("../services/robotPathPlanningService");
const mqttService = require("../services/mqttService");

router.get("/", async (req, res) => {
  try {
    const totalDrains = await pool.query("SELECT COUNT(*) FROM drains");

    const activeRobots = await pool.query(
      "SELECT COUNT(*) FROM robots WHERE status = 'Active'"
    );

    const criticalAlerts = await pool.query(
      "SELECT COUNT(*) FROM alerts WHERE severity = 'Critical'"
    );

    res.json({
      totalDrains: Number(totalDrains.rows[0].count),
      activeRobots: Number(activeRobots.rows[0].count),
      criticalAlerts: Number(criticalAlerts.rows[0].count),
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server Error" });
  }
});

// --------------------------------------------------
// GET /api/dashboard/risk - Flood Risk Intelligence summary
// plus the current highest-risk drain with its explainable
// breakdown and AI prediction (for the dashboard panel).
// --------------------------------------------------

router.get("/risk", async (req, res) => {
  try {
    const summary = await floodRisk.getRiskSummary({
      force: req.query.refresh === "true"
    });

    let topRisk = null;

    if (summary.topRisk) {
      const detail = await floodRisk.buildDrainRiskDetail(
        summary.topRisk.drainId
      );

      if (detail) {
        const { prediction, source } = await mqttService.getPrediction(
          detail.drainId,
          {
            water_level: detail.waterLevel,
            gas_level: detail.gasLevel,
            temperature: detail.temperature
          },
          mqttService.defaultPredict
        );

        topRisk = {
          drainId: detail.drainId,
          sensorId: detail.sensorId,
          zone: detail.zone,
          location: detail.location,
          riskScore: detail.riskScore,
          riskLevel: detail.riskLevel,
          prediction,
          predictionSource: source,
          waterLevel: detail.waterLevel,
          gasLevel: detail.gasLevel,
          temperature: detail.temperature,
          breakdown: detail.breakdown,
          factors: detail.factors,
          timestamp: detail.timestamp
        };
      }
    }

    res.json({
      summary: {
        totalDrains: summary.totalDrains,
        averageRiskScore: summary.averageRiskScore,
        counts: summary.counts,
        distribution: summary.distribution
      },
      topRisk
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server Error" });
  }
});

// --------------------------------------------------
// GET /api/dashboard/forecast - Predictive flood forecast
// summary (15/30/60 min) plus the highest predicted-risk drain
// with its horizon forecasts (for the dashboard panel).
// --------------------------------------------------

router.get("/forecast", async (req, res) => {
  try {
    const summary = await floodForecast.getForecastSummary({
      force: req.query.refresh === "true"
    });

    let topForecast = null;

    if (summary.topForecast) {
      const forecast = await floodForecast.getDrainForecast(
        summary.topForecast.drainId
      );

      if (forecast) {
        topForecast = {
          drainId: forecast.drainId,
          sensorId: forecast.sensorId,
          zone: forecast.zone,
          location: forecast.location,
          currentWaterLevel: forecast.currentWaterLevel,
          currentRiskScore: forecast.currentRiskScore,
          currentRiskLevel: forecast.currentRiskLevel,
          method: forecast.method,
          trendDirection: forecast.trendDirection,
          waterTrendPerMinute: forecast.waterTrendPerMinute,
          horizons: forecast.horizons,
          worst: forecast.worst,
          timestamp: forecast.timestamp
        };
      }
    }

    res.json({
      summary: {
        totalDrains: summary.totalDrains,
        averagePredictedRiskScore: summary.averagePredictedRiskScore,
        counts: summary.counts,
        distribution: summary.distribution
      },
      topForecast
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server Error" });
  }
});

// --------------------------------------------------
// GET /api/dashboard/maintenance - Maintenance overview summary
// for the dashboard maintenance panel: drains requiring
// inspection/cleaning, plus the highest maintenance-priority
// drain with its explainable breakdown. Additive - existing
// risk/forecast responses are untouched.
// --------------------------------------------------

router.get("/maintenance", async (req, res) => {
  try {
    const summary = await maintenanceService.getMaintenanceSummary({
      force: req.query.refresh === "true"
    });

    res.json({
      summary: {
        totalDrains: summary.totalDrains,
        averageMaintenanceScore: summary.averageMaintenanceScore,
        averageBlockageRisk: summary.averageBlockageRisk,
        counts: summary.counts,
        distribution: summary.distribution,
        drainsRequiringInspection: summary.drainsRequiringInspection,
        drainsRequiringCleaning: summary.drainsRequiringCleaning,
        highestMaintenanceScore: summary.highestMaintenanceScore,
        highestBlockageRisk: summary.highestBlockageRisk,
        topMaintenance: summary.topMaintenance
      },
      drains: summary.drains
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server Error" });
  }
});

// --------------------------------------------------
// GET /api/dashboard/decisions - AI Drain Decision & Priority
// summary for the dashboard decision panel: average priority,
// level distribution, recommended-action distribution, signal
// coverage and the top-priority drains with their actions.
// Additive - existing dashboard endpoints are untouched.
// --------------------------------------------------

router.get("/decisions", async (req, res) => {
  try {
    const summary = await decisionEngine.getDecisionSummary({
      force: req.query.refresh === "true"
    });

    res.json(summary);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server Error" });
  }
});

// --------------------------------------------------
// GET /api/dashboard/robot-routes - Path planning summary
// --------------------------------------------------
// Agentive summary of planned routes for all Warning/Critical
// drains: selected robot, planned route (direct vs charging
// stop), distance, time and battery estimates. Additive.
// --------------------------------------------------

router.get("/robot-routes", async (req, res) => {
  try {
    const summary = await robotPathPlanning.getAllRoutes();

    res.json(summary);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server Error" });
  }
});

module.exports = router;