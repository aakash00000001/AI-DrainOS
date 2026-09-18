const express = require("express");
const router = express.Router();
const pool = require("../config/db");

const floodRisk = require("../services/floodRiskService");
const floodForecast = require("../services/floodForecastService");
const maintenanceService = require("../services/maintenancePredictionService");
const visionService = require("../services/drainVisionService");
const decisionEngine = require("../services/decisionEngine");
const robotPathPlanning = require("../services/robotPathPlanningService");
const incidentService = require("../services/incidentService");
const fleetOptimizationService = require("../services/fleetOptimizationService");
const historicalIntelligence = require("../services/historicalIntelligenceService");
const missionCoordinator = require("../services/missionCoordinatorService");
const sensorIntelligence = require("../services/sensorIntelligenceService");

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

    // Vision analytics are additive and best-effort: if the vision
    // table is unavailable, the existing analytics contract still
    // responds with the default (zero) vision fields.
    let visionSummary = null;

    try {
      visionSummary = await visionService.getVisionAnalytics();
    } catch (visionErr) {
      console.log("⚠️ Vision analytics skipped:", visionErr.message);
    }

    // Incident analytics are additive and best-effort (mirrors the
    // vision pattern): a missing incidents table never breaks the
    // existing analytics contract.
    let incidentAnalytics = null;

    try {
      incidentAnalytics = await incidentService.getAnalytics();
    } catch (incidentErr) {
      console.log("⚠️ Incident analytics skipped:", incidentErr.message);
    }

    // Fleet optimization analytics are additive and best-effort.
    // Advisory only; never dispatches robots.
    let fleetAnalytics = null;

    try {
      fleetAnalytics = await fleetOptimizationService.getAnalytics();
    } catch (fleetErr) {
      console.log("⚠️ Fleet analytics skipped:", fleetErr.message);
    }

    // Historical intelligence analytics are additive and best-effort.
    // Descriptive evidence only (never a prediction); a failure here
    // never breaks the existing analytics contract.
    let historicalAnalytics = null;

    try {
      historicalAnalytics = await historicalIntelligence.getAnalytics();
    } catch (historyErr) {
      console.log("⚠️ Historical analytics skipped:", historyErr.message);
    }

    // Mission coordination analytics are additive and best-effort.
    // Advisory planning metrics only; failure never breaks analytics.
    let coordinationAnalytics = null;

    try {
      coordinationAnalytics = await missionCoordinator.getAnalytics();
    } catch (coordErr) {
      console.log("⚠️ Coordination analytics skipped:", coordErr.message);
    }

    // Sensor intelligence analytics are additive and best-effort.
    // Real recorded readings only; a failure here never breaks the
    // existing analytics contract.
    let sensorAnalytics = null;

    try {
      sensorAnalytics = await sensorIntelligence.getAnalytics();
    } catch (sensorErr) {
      console.log("⚠️ Sensor intelligence analytics skipped:", sensorErr.message);
    }

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
      maintenance_drains_inspection: maintenanceSummary.drainsRequiringInspection.length,
      vision_total_inspections: visionSummary ? visionSummary.totalInspections : 0,
      vision_drains_inspected: visionSummary ? visionSummary.drainsInspected : 0,
      vision_average_visual_risk: visionSummary ? visionSummary.averageVisualRisk : 0,
      vision_average_blockage_risk: visionSummary ? visionSummary.averageBlockageRisk : 0,
      vision_low: visionSummary ? visionSummary.counts.low : 0,
      vision_moderate: visionSummary ? visionSummary.counts.moderate : 0,
      vision_high: visionSummary ? visionSummary.counts.high : 0,
      vision_critical: visionSummary ? visionSummary.counts.critical : 0,
      vision_distribution: visionSummary ? visionSummary.distribution : [],
      vision_drains_with_issues: visionSummary ? visionSummary.drainsWithVisualIssues : 0,
      incident_total: incidentAnalytics ? incidentAnalytics.total : 0,
      incident_active:
        incidentAnalytics && incidentAnalytics.by_status
          ? incidentAnalytics.by_status.OPEN +
            incidentAnalytics.by_status.ACKNOWLEDGED +
            incidentAnalytics.by_status.RESPONDING
          : 0,
      incident_responding:
        incidentAnalytics && incidentAnalytics.by_status
          ? incidentAnalytics.by_status.RESPONDING
          : 0,
      incident_resolved:
        incidentAnalytics && incidentAnalytics.by_status
          ? incidentAnalytics.by_status.RESOLVED
          : 0,
      incident_by_severity: incidentAnalytics ? incidentAnalytics.by_severity : null,
      incident_average_response_minutes: incidentAnalytics
        ? incidentAnalytics.average_response_minutes
        : null,
      incident_average_resolution_minutes: incidentAnalytics
        ? incidentAnalytics.average_resolution_minutes
        : null,
      fleet_status: fleetAnalytics ? fleetAnalytics.status : null,
      fleet_total_robots: fleetAnalytics ? fleetAnalytics.total_robots : 0,
      fleet_available_robots: fleetAnalytics ? fleetAnalytics.available_robots : 0,
      fleet_busy_robots: fleetAnalytics ? fleetAnalytics.busy_robots : 0,
      fleet_charging_robots: fleetAnalytics ? fleetAnalytics.charging_robots : 0,
      fleet_low_battery_robots: fleetAnalytics ? fleetAnalytics.low_battery_robots : 0,
      fleet_utilization: fleetAnalytics ? fleetAnalytics.robot_utilization : null,
      fleet_active_tasks: fleetAnalytics ? fleetAnalytics.active_tasks : 0,
      fleet_assigned_tasks: fleetAnalytics ? fleetAnalytics.assigned_tasks : 0,
      fleet_unassigned_tasks: fleetAnalytics ? fleetAnalytics.unassigned_task_count : 0,
      fleet_assignment_coverage: fleetAnalytics
        ? fleetAnalytics.task_assignment_coverage
        : null,
      fleet_average_response_minutes: fleetAnalytics
        ? fleetAnalytics.average_estimated_response_minutes
        : null,
      historical_period: historicalAnalytics
        ? historicalAnalytics.historical_period
        : historicalIntelligence.DEFAULT_PERIOD,
      historical_incident_count: historicalAnalytics
        ? historicalAnalytics.historical_incident_count
        : 0,
      historical_resolved_incident_count: historicalAnalytics
        ? historicalAnalytics.historical_resolved_incident_count
        : 0,
      historical_mission_count: historicalAnalytics
        ? historicalAnalytics.historical_mission_count
        : 0,
      historical_alert_count: historicalAnalytics
        ? historicalAnalytics.historical_alert_count
        : 0,
      historical_sensor_reading_count: historicalAnalytics
        ? historicalAnalytics.historical_sensor_reading_count
        : 0,
      historical_recurrent_drain_count: historicalAnalytics
        ? historicalAnalytics.historical_recurrent_drain_count
        : 0,
      historical_degraded_drain_count: historicalAnalytics
        ? historicalAnalytics.historical_degraded_drain_count
        : 0,
      historical_data_quality: historicalAnalytics
        ? historicalAnalytics.historical_data_quality
        : historicalIntelligence.DATA_QUALITY.INSUFFICIENT_DATA,
      historical_recent_trend: historicalAnalytics
        ? historicalAnalytics.historical_recent_trend
        : historicalIntelligence.TREND.INSUFFICIENT_DATA,
      coordination_pending_tasks: coordinationAnalytics ? coordinationAnalytics.coordination_pending_tasks : 0,
      coordination_assigned_tasks: coordinationAnalytics ? coordinationAnalytics.coordination_assigned_tasks : 0,
      coordination_unassigned_tasks: coordinationAnalytics ? coordinationAnalytics.coordination_unassigned_tasks : 0,
      coordination_available_robots: coordinationAnalytics ? coordinationAnalytics.coordination_available_robots : 0,
      coordination_busy_robots: coordinationAnalytics ? coordinationAnalytics.coordination_busy_robots : 0,
      coordination_charging_robots: coordinationAnalytics ? coordinationAnalytics.coordination_charging_robots : 0,
      coordination_conflict_count: coordinationAnalytics ? coordinationAnalytics.coordination_conflict_count : 0,
      coordination_reassignment_required: coordinationAnalytics
        ? coordinationAnalytics.coordination_reassignment_required
        : 0,
      coordination_average_task_priority: coordinationAnalytics
        ? coordinationAnalytics.coordination_average_task_priority
        : null,
      coordination_average_candidate_score: coordinationAnalytics
        ? coordinationAnalytics.coordination_average_candidate_score
        : null,
      coordination_status: coordinationAnalytics
        ? coordinationAnalytics.coordination_status
        : missionCoordinator.COORDINATION_STATUS.INSUFFICIENT_DATA,
      sensor_health_status: sensorAnalytics
        ? sensorAnalytics.overall_health_status
        : sensorIntelligence.HEALTH_STATUS.INSUFFICIENT_DATA,
      sensor_average_health: sensorAnalytics ? sensorAnalytics.average_health_score : null,
      sensor_health_distribution: sensorAnalytics
        ? sensorAnalytics.health_distribution
        : null,
      sensor_anomaly_count: sensorAnalytics ? sensorAnalytics.anomaly_count : 0,
      sensor_anomalies_by_type: sensorAnalytics
        ? sensorAnalytics.anomalies_by_type
        : null,
      sensor_anomalies_by_severity: sensorAnalytics
        ? sensorAnalytics.anomalies_by_severity
        : null,
      sensor_stale_count: sensorAnalytics ? sensorAnalytics.stale_sensors : 0,
      sensor_missing_data_count: sensorAnalytics
        ? sensorAnalytics.missing_data_sensors
        : 0,
      sensor_out_of_range_count: sensorAnalytics
        ? sensorAnalytics.out_of_range_sensors
        : 0,
      sensor_affected_drains: sensorAnalytics ? sensorAnalytics.affected_drains : 0,
      sensor_health_trend_status: sensorAnalytics
        ? sensorAnalytics.health_trend_status
        : "INSUFFICIENT_DATA"
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

// --------------------------------------------------
// GET /api/analytics/vision - Vision inspection summary
// --------------------------------------------------

router.get("/vision", async (req, res) => {
  try {
    const data = await visionService.getVisionAnalytics();
    res.json(data);
  } catch (err) {
    console.log(err);
    res.status(500).json({ error: "Analytics Error" });
  }
});

// --------------------------------------------------
// GET /api/analytics/decisions - AI Decision & Priority summary
// --------------------------------------------------

router.get("/decisions", async (req, res) => {
  try {
    const summary = await decisionEngine.getDecisionSummary({
      force: req.query.refresh === "true"
    });

    res.json({
      total_drains: summary.totalDrains,
      eligible_drains: summary.eligibleDrains,
      insufficient_data: summary.insufficientData,
      average_priority_score: summary.averagePriorityScore,
      decision_low: summary.counts.low,
      decision_moderate: summary.counts.moderate,
      decision_high: summary.counts.high,
      decision_critical: summary.counts.critical,
      decision_distribution: summary.distribution,
      action_distribution: summary.actionDistribution,
      signal_coverage: summary.signalCoverage,
      top_priority_drains: summary.topPriority,
      disclaimer: summary.disclaimer,
      generated_at: summary.generatedAt
    });
  } catch (err) {
    console.log(err);
    res.status(500).json({ error: "Analytics Error" });
  }
});

// --------------------------------------------------
// GET /api/analytics/incidents - Incident statistics
// --------------------------------------------------
// Incidents by severity / status / source plus average response and
// resolution times. Averages are honest: null until enough REAL
// resolved/responding data exists (never fabricated).
// --------------------------------------------------

router.get("/incidents", async (req, res) => {
  try {
    const data = await incidentService.getAnalytics();
    res.json(data);
  } catch (err) {
    console.log(err);
    res.status(500).json({ error: "Analytics Error" });
  }
});

// --------------------------------------------------
// GET /api/analytics/robot-routes - Route planning analytics
// --------------------------------------------------
// Analytics-flavoured view of the robot path planning engine:
// selected robots, route types, distance/time ranges and
// battery sufficiency for Warning/Critical drains. Additive.
// --------------------------------------------------

router.get("/robot-routes", async (req, res) => {
  try {
    const summary = await robotPathPlanning.getAllRoutes();

    const planned = summary.routes.filter(
      (r) => r.planningStatus === "ROBOT_SELECTED"
    );

    const routesByType = { DIRECT: 0, CHARGING_STOP: 0 };
    const robotsSelected = [];
    let totalTravelSeconds = 0;
    let totalDistance = 0;
    let totalBatteryCost = 0;
    let withEnoughBattery = 0;

    for (const route of planned) {
      if (route.route) {
        routesByType[route.route.type] =
          (routesByType[route.route.type] || 0) + 1;

        totalTravelSeconds += route.route.totalTravelSeconds;
        totalDistance += route.route.totalDistance;
        totalBatteryCost += route.route.totalBatteryCost;

        if (route.route.type === "DIRECT") {
          withEnoughBattery += 1;
        }
      }

      if (route.robot) {
        robotsSelected.push({
          drainId: route.drainId,
          zone: route.zone,
          location: route.location,
          robotId: route.robot.id,
          robotName: route.robot.robotName,
          batteryLevel: route.robot.batteryLevel,
          routeType: route.route ? route.route.type : null
        });
      }
    }

    res.json({
      total_drains: summary.totalDrains,
      warning_critical_drains: summary.warningCritical,
      planned_routes: planned.length,
      routes_by_type: routesByType,
      routes_by_type_list: Object.entries(routesByType).map(
        ([type, count]) => ({ type, count })
      ),
      robots_selected: robotsSelected,
      average_travel_seconds:
        planned.length > 0
          ? Math.round(totalTravelSeconds / planned.length)
          : null,
      average_distance:
        planned.length > 0
          ? Math.round((totalDistance / planned.length) * 1000) / 1000
          : null,
      average_battery_cost:
        planned.length > 0
          ? Math.round((totalBatteryCost / planned.length) * 10) / 10
          : null,
      direct_routes: routesByType.DIRECT,
      charging_stop_routes: routesByType.CHARGING_STOP,
      disclaimer: summary.disclaimer,
      generated_at: summary.generatedAt
    });
  } catch (err) {
    console.log(err);
    res.status(500).json({ error: "Analytics Error" });
  }
});

// --------------------------------------------------
// GET /api/analytics/fleet-optimization - Fleet metrics
// --------------------------------------------------
// Robot availability mix, task assignment coverage, average
// estimated response time and unassigned reasons. Derived from
// live state; averages are null when they cannot be computed.
// Advisory only. Additive.
// --------------------------------------------------

router.get("/fleet-optimization", async (req, res) => {
  try {
    const data = await fleetOptimizationService.getAnalytics();
    res.json(data);
  } catch (err) {
    console.log(err);
    res.status(500).json({ error: "Analytics Error" });
  }
});

// --------------------------------------------------
// GET /api/analytics/historical - Historical analytics
// --------------------------------------------------
// Descriptive evidence over REAL records for a validated window.
// Read-only; never a prediction. Additive.
// --------------------------------------------------

router.get("/historical", async (req, res) => {
  const rawPeriod = req.query.period !== undefined ? req.query.period : req.query.window;
  const window = historicalIntelligence.resolvePeriod(rawPeriod);

  if (!window) {
    return res.status(400).json({
      error: "Invalid period",
      message: `period must be one of: ${historicalIntelligence.VALID_PERIODS.join(", ")}`,
      allowed_periods: historicalIntelligence.VALID_PERIODS,
      default_period: historicalIntelligence.DEFAULT_PERIOD
    });
  }

  const drain = historicalIntelligence.parseDrainId(req.query.drainId);
  if (!drain.ok) {
    return res.status(400).json({
      error: "Invalid drainId",
      message: "drainId must be a positive integer"
    });
  }

  try {
    const data = await historicalIntelligence.getHistoricalOverview({
      period: window.period,
      drainId: drain.value
    });
    res.json(data);
  } catch (err) {
    console.log(err);
    res.status(500).json({ error: "Analytics Error" });
  }
});

// --------------------------------------------------
// GET /api/analytics/coordination - Mission coordination analytics
// --------------------------------------------------
// Advisory scheduling metrics over live missions/robots. Read-only;
// never dispatches. Additive.
// --------------------------------------------------

router.get("/coordination", async (req, res) => {
  try {
    const data = await missionCoordinator.getAnalytics();
    res.json(data);
  } catch (err) {
    console.log(err);
    res.status(500).json({ error: "Analytics Error" });
  }
});

// --------------------------------------------------
// GET /api/analytics/sensor-intelligence
// --------------------------------------------------
// Sensor health distribution, anomalies by type/severity, stale /
// missing-data sensors and affected drains. Read-only; real
// recorded readings only; additive.
// --------------------------------------------------

router.get("/sensor-intelligence", async (req, res) => {
  try {
    const data = await sensorIntelligence.getAnalytics();
    res.json(data);
  } catch (err) {
    console.log(err);
    res.status(500).json({ error: "Analytics Error" });
  }
});

module.exports = router;