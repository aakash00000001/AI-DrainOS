const express = require("express");
const router = express.Router();
const pool = require("../config/db");

const floodRisk = require("../services/floodRiskService");
const floodForecast = require("../services/floodForecastService");
const maintenanceService = require("../services/maintenancePredictionService");

router.get("/", async (req, res) => {

  try {

    const totalDrains = await pool.query(
      "SELECT COUNT(*) FROM drains"
    );

    const totalCleanings = await pool.query(
      "SELECT COUNT(*) FROM missions WHERE mission_status = 'Completed'"
    );

    const totalMissions = await pool.query(
      "SELECT COUNT(*) FROM missions"
    );

    const openCriticalAlerts = await pool.query(
      "SELECT COUNT(*) FROM alerts WHERE severity = 'Critical' AND alert_status = 'Open'"
    );

    const totalCriticalAlerts = await pool.query(
      "SELECT COUNT(*) FROM alerts WHERE severity = 'Critical'"
    );

    const totalSensors = await pool.query(
      "SELECT COUNT(*) FROM sensors"
    );

    const avgDuration = await pool.query(
      `
      SELECT COALESCE(
        ROUND(AVG(EXTRACT(EPOCH FROM (completed_time - assigned_time)) / 60)::numeric, 1),
        0
      ) AS avg_minutes
      FROM missions
      WHERE mission_status = 'Completed'
        AND completed_time IS NOT NULL
      `
    );

    const riskSummary = await floodRisk.getRiskSummary();
    const forecastSummary = await floodForecast.getForecastSummary({ force: true });
    const maintenanceSummary = await maintenanceService.getMaintenanceSummary();

    res.json({
      total_cleanings: Number(totalCleanings.rows[0].count),
      total_missions: Number(totalMissions.rows[0].count),
      blockages_detected: Number(openCriticalAlerts.rows[0].count),
      critical_alerts_total: Number(totalCriticalAlerts.rows[0].count),
      robot_operations: Number(totalMissions.rows[0].count),
      flood_predictions: Number(totalSensors.rows[0].count),
      total_drains: Number(totalDrains.rows[0].count),
      avg_mission_duration_minutes: Number(avgDuration.rows[0].avg_minutes),
      risk_average_score: riskSummary.averageRiskScore,
      risk_low: riskSummary.counts.low,
      risk_moderate: riskSummary.counts.moderate,
      risk_high: riskSummary.counts.high,
      risk_critical: riskSummary.counts.critical,
      risk_distribution: riskSummary.distribution,
      forecast_average_risk: forecastSummary.averagePredictedRiskScore,
      forecast_low: forecastSummary.counts.low,
      forecast_moderate: forecastSummary.counts.moderate,
      forecast_high: forecastSummary.counts.high,
      forecast_critical: forecastSummary.counts.critical,
      forecast_distribution: forecastSummary.distribution,
      forecast_ready: forecastSummary.totalDrains,
      maintenance_average_score: maintenanceSummary.averageMaintenanceScore,
      maintenance_average_blockage_risk: maintenanceSummary.averageBlockageRisk,
      maintenance_low: maintenanceSummary.counts.low,
      maintenance_moderate: maintenanceSummary.counts.moderate,
      maintenance_high: maintenanceSummary.counts.high,
      maintenance_critical: maintenanceSummary.counts.critical,
      maintenance_distribution: maintenanceSummary.distribution,
      maintenance_ready_drains: maintenanceSummary.totalDrains,
      maintenance_drains_inspection: maintenanceSummary.drainsRequiringInspection.length
    });

  }

  catch(err){

    console.log(err);

    res.status(500).json({

      error:"Analytics Error"

    });

  }

});

router.get("/monthly", async (req, res) => {

  try {

    const result = await pool.query(
      `
      SELECT
        to_char(date_trunc('month', recorded_at), 'Mon') AS month,
        ROUND(AVG(water_level)::numeric, 1) AS avg_water,
        MAX(water_level) AS max_water,
        ROUND(AVG(gas_level)::numeric, 1) AS avg_gas,
        COUNT(*) AS readings
      FROM sensors
      WHERE recorded_at >= date_trunc('month', CURRENT_DATE) - INTERVAL '5 months'
      GROUP BY date_trunc('month', recorded_at)
      ORDER BY date_trunc('month', recorded_at) ASC
      `
    );

    res.json(result.rows);

  } catch (err) {

    console.log(err);

    res.status(500).json({ error: "Analytics Error" });

  }

});

router.get("/risk", async (req, res) => {
  try {
    const force = req.query.refresh === "true";

    const run = async () => floodRisk.getRiskSummary({ force });
    const summary = await run();

    res.json(summary);
  } catch (err) {
    console.log(err);
    res.status(500).json({ error: "Analytics Error" });
  }
});

router.get("/forecast", async (req, res) => {
  try {
    const force = req.query.refresh === "true";
    const summary = await floodForecast.getForecastSummary({ force });
    res.json(summary);
  } catch (err) {
    console.log(err);
    res.status(500).json({ error: "Analytics Error" });
  }
});

router.get("/maintenance", async (req, res) => {
  try {
    const data = await maintenanceService.getMaintenanceAnalytics();
    res.json(data);
  } catch (err) {
    console.log(err);
    res.status(500).json({ error: "Analytics Error" });
  }
});

module.exports = router;