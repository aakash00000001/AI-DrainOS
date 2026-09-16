const express = require("express");
const router = express.Router();
const pool = require("../config/db");

const floodRisk = require("../services/floodRiskService");
const floodForecast = require("../services/floodForecastService");
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

module.exports = router;