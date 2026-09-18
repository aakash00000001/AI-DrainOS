const express = require("express");
const router = express.Router();
const pool = require("../config/db");

const floodRisk = require("../services/floodRiskService");
const floodForecast = require("../services/floodForecastService");
const maintenanceService = require("../services/maintenancePredictionService");
const decisionEngine = require("../services/decisionEngine");
const robotPathPlanning = require("../services/robotPathPlanningService");
const mqttService = require("../services/mqttService");
const incidentService = require("../services/incidentService");
const fleetOptimizationService = require("../services/fleetOptimizationService");
const historicalIntelligence = require("../services/historicalIntelligenceService");
const missionCoordinator = require("../services/missionCoordinatorService");
const sensorIntelligence = require("../services/sensorIntelligenceService");

router.get("/", async (req, res) => {
  try {
    const totalDrains = await pool.query("SELECT COUNT(*) FROM drains");

    const activeRobots = await pool.query(
      "SELECT COUNT(*) FROM robots WHERE status = 'Active'"
    );

    const criticalAlerts = await pool.query(
      "SELECT COUNT(*) FROM alerts WHERE severity = 'Critical'"
    );

    // Emergency / incident intelligence — additive. Best-effort: if
    // the incidents table is somehow unavailable the existing fields
    // still respond with a safe default (no fabricated numbers).
    let incidents = {
      counts: {
        active: 0,
        critical: 0,
        responding: 0,
        resolved: 0,
        open: 0,
        acknowledged: 0,
        total: 0
      },
      latest: []
    };

    try {
      incidents = await incidentService.getDashboardSummary();
    } catch (incidentErr) {
      console.log("⚠️ Dashboard incident summary skipped:", incidentErr.message);
    }

    // Fleet optimization — additive + best-effort (mirrors the
    // incidents pattern). Advisory only; never dispatches robots.
    let fleet = {
      status: "UNAVAILABLE",
      totalRobots: 0,
      availableRobots: 0,
      busyRobots: 0,
      chargingRobots: 0,
      lowBatteryRobots: 0,
      activeTasks: 0,
      unassignedTasks: 0,
      recommendedAssignments: 0,
      fleetUtilization: null
    };

    try {
      fleet = await fleetOptimizationService.getDashboardSummary();
    } catch (fleetErr) {
      console.log("⚠️ Dashboard fleet summary skipped:", fleetErr.message);
    }

    // Historical intelligence — additive + best-effort. Describes
    // RECORDED data only; never fabricates history and degrades to a
    // safe INSUFFICIENT_DATA default if the historical layer fails.
    let historicalSummary = {
      period: historicalIntelligence.DEFAULT_PERIOD,
      historicalIncidentCount: 0,
      recurrentDrainCount: 0,
      degradedDrainCount: 0,
      historicalDataQuality: historicalIntelligence.DATA_QUALITY.INSUFFICIENT_DATA,
      topRecurringDrains: [],
      recentHistoricalTrend: historicalIntelligence.TREND.INSUFFICIENT_DATA
    };

    try {
      historicalSummary = await historicalIntelligence.getDashboardSummary();
    } catch (historyErr) {
      console.log("⚠️ Dashboard historical summary skipped:", historyErr.message);
    }

    // Mission coordination — additive + best-effort (advisory plan
    // counts only; never dispatches robots). Degrades to safe zeros.
    let coordination = {
      pendingTasks: 0,
      assignedTasks: 0,
      unassignedTasks: 0,
      availableRobots: 0,
      busyRobots: 0,
      chargingRobots: 0,
      coordinationConflicts: 0,
      reassignmentRequired: 0,
      status: "UNAVAILABLE"
    };

    try {
      coordination = await missionCoordinator.getDashboardSummary();
    } catch (coordErr) {
      console.log("⚠️ Dashboard coordination summary skipped:", coordErr.message);
    }

    // Sensor intelligence — additive + best-effort. Describes real
    // recorded sensor readings only and degrades to safe zeros.
    let sensorIntelligenceSummary = {
      sensorIntelligence: null,
      sensorHealthSummary: {
        totalSensors: 0,
        counts: {
          total: 0,
          healthy: 0,
          good: 0,
          degraded: 0,
          poor: 0,
          critical: 0,
          insufficientData: 0
        },
        healthDistribution: {
          HEALTHY: 0,
          GOOD: 0,
          DEGRADED: 0,
          POOR: 0,
          CRITICAL: 0,
          INSUFFICIENT_DATA: 0
        },
        averageHealthScore: null,
        overallHealthStatus: "INSUFFICIENT_DATA"
      },
      sensorAnomalySummary: {
        anomalyCount: 0,
        anomaliesByType: {},
        anomaliesBySeverity: {},
        staleSensors: 0,
        missingDataSensors: 0,
        outOfRangeSensors: 0,
        affectedDrains: 0
      }
    };

    try {
      sensorIntelligenceSummary = await sensorIntelligence.getDashboardSummary();
    } catch (sensorErr) {
      console.log("⚠️ Dashboard sensor intelligence skipped:", sensorErr.message);
    }

    res.json({
      totalDrains: Number(totalDrains.rows[0].count),
      activeRobots: Number(activeRobots.rows[0].count),
      criticalAlerts: Number(criticalAlerts.rows[0].count),
      incidents,
      fleet,
      historicalSummary,
      coordination,
      ...sensorIntelligenceSummary
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

// --------------------------------------------------
// GET /api/dashboard/fleet - Fleet optimization summary
// --------------------------------------------------
// Additive summary for the dashboard fleet panel: robot
// availability mix, task assignment coverage and fleet
// utilization. Advisory only. Existing endpoints untouched.
// --------------------------------------------------

router.get("/fleet", async (req, res) => {
  try {
    const summary = await fleetOptimizationService.getSummary();
    res.json(summary);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server Error" });
  }
});

module.exports = router;