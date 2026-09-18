// ============================================================
// AI-DrainOS Decision & Priority Engine
//
// Explainable per-drain attention-priority decision layer.
//
// The engine does NOT invent new scoring maths: it consumes the
// existing explainable service outputs (flood risk, flood
// forecast, maintenance/blockage prediction, vision inspection)
// and combines them into a single bounded attention-priority
// score (0-100) with an accompanying action, human-readable
// reasons, weighted contributing factors and a robot dispatch
// recommendation.
//
// HONESTY CONTRACT: a signal that is missing (no sensor, no
// readings, no vision inspection yet, insufficient history) is
// reported as unavailable - never estimated or fabricated. When
// NO signal is available the decision status is INSUFFICIENT_DATA
// with a null score. The engine never writes to the database: it
// is a pure on-demand computation layer.
// ============================================================

const pool = require("../config/db");

const floodRisk = require("./floodRiskService");
const floodForecast = require("./floodForecastService");
const maintenanceService = require("./maintenancePredictionService");
const visionService = require("./drainVisionService");
const socketHub = require("./socketHub");
const sensorIntelligenceService = require("./sensorIntelligenceService");
const weatherFloodCorrelationService = require("./weatherFloodCorrelationService");

// ------------------------------------------------------------
// Model constants (single source of truth for the prioritisation)
// ------------------------------------------------------------

const WEIGHTS = {
  floodRisk: 0.4,
  forecast: 0.25,
  maintenance: 0.2,
  vision: 0.15
};

const TREND_RISING_BONUS = 5;
const ALERT_CRITICAL_BONUS = 10;
const ALERT_MEDIUM_BONUS = 4;
const MAX_ALERT_BONUS = 20;

const MIN_BATTERY_FOR_INSPECTION = 30;

const DEFAULT_PRIORITY_THRESHOLDS = {
  moderate: 25,
  high: 50,
  critical: 75
};

const ACTIONS = {
  LOW: "CONTINUE_MONITORING",
  MODERATE: "MONITOR_CLOSELY",
  HIGH: "INSPECT_DRAIN",
  CRITICAL: "IMMEDIATE_ROBOT_INSPECTION"
};

const DECISION_DISCLAIMER =
  "Priority is a deterministic blend of the existing flood risk, " +
  "forecast, maintenance and vision signals. Missing signals are " +
  "reported as unavailable and are never estimated.";

const SUMMARY_CACHE_TTL_MS = 10000;
const MAX_DRAINS_FOR_SUMMARY = 100;

let summaryCache = { at: 0, data: null };
const lastEmitted = new Map();

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function finiteNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function priorityLevelFromScore(score, thresholds = DEFAULT_PRIORITY_THRESHOLDS) {
  if (score < thresholds.moderate) return "LOW";
  if (score < thresholds.high) return "MODERATE";
  if (score < thresholds.critical) return "HIGH";
  return "CRITICAL";
}

function recommendedAction(priorityLevel) {
  return ACTIONS[priorityLevel] || null;
}

// ------------------------------------------------------------
// Alert context (open alerts for a drain)
// ------------------------------------------------------------

async function getOpenAlertModifiers(drainId) {
  const result = await pool.query(
    `
    SELECT severity, COUNT(*)::int AS count
    FROM alerts
    WHERE drain_id = $1
      AND alert_status = 'Open'
    GROUP BY severity
    `,
    [drainId]
  );

  const modifiers = [];
  let totalPoints = 0;

  for (const row of result.rows) {
    const severity = String(row.severity || "");
    const count = Number(row.count) || 0;
    let points = 0;

    if (severity === "Critical") {
      points = count * ALERT_CRITICAL_BONUS;
    } else if (severity === "Medium") {
      points = count * ALERT_MEDIUM_BONUS;
    }

    if (points > 0) {
      modifiers.push({
        name: `Open ${severity} alert${count > 1 ? "s" : ""}`,
        severity,
        count,
        points
      });
      totalPoints += points;
    }
  }

  if (totalPoints > MAX_ALERT_BONUS) {
    const scale = MAX_ALERT_BONUS / totalPoints;

    modifiers.forEach((modifier) => {
      modifier.points = round1(modifier.points * scale);
    });

    totalPoints = MAX_ALERT_BONUS;
  }

  return { modifiers, totalPoints: round1(totalPoints) };
}

// ------------------------------------------------------------
// Robot dispatch context (read-only - missionEngine is untouched)
// ------------------------------------------------------------

async function getRobotContext(drain) {
  const result = await pool.query(
    `
    SELECT
      r.id,
      r.robot_name,
      r.status,
      r.battery_level,
      r.assigned_zone,
      r.latitude,
      r.longitude,
      m.drain_id AS mission_drain_id
    FROM robots r
    LEFT JOIN LATERAL (
      SELECT id, drain_id
      FROM missions
      WHERE robot_id = r.id
        AND mission_status = 'Assigned'
      ORDER BY id DESC
      LIMIT 1
    ) m ON true
    ORDER BY r.id ASC
    `
  );

  const robots = result.rows.map((row) => ({
    id: Number(row.id),
    robotName: row.robot_name,
    status: row.status,
    batteryLevel: finiteNumber(row.battery_level),
    assignedZone: row.assigned_zone,
    latitude: finiteNumber(row.latitude),
    longitude: finiteNumber(row.longitude),
    missionDrainId: row.mission_drain_id === null ? null : Number(row.mission_drain_id)
  }));

  const drainLat = finiteNumber(drain.latitude);
  const drainLng = finiteNumber(drain.longitude);

  return {
    robots,
    drainCoordinates: drainLat !== null && drainLng !== null,
    drainLat,
    drainLng
  };
}

function coordinateDistance(aLat, aLng, bLat, bLng) {
  if (
    aLat === null || aLng === null ||
    bLat === null || bLng === null
  ) {
    return null;
  }

  return (
    Math.round(
      Math.sqrt(
        Math.pow(aLat - bLat, 2) + Math.pow(aLng - bLng, 2)
      ) * 1000000
    ) / 1000000
  );
}

function buildRobotRecommendation({ drain, priorityLevel, robotContext }) {
  const { robots, drainCoordinates, drainLat, drainLng } = robotContext;

  if (priorityLevel !== "HIGH" && priorityLevel !== "CRITICAL") {
    return {
      required: false,
      recommended: false,
      available: false,
      assignedToDrain: false,
      robotName: null,
      robotId: null,
      batteryLevel: null,
      reason: `Robotic inspection not required at ${priorityLevel} priority`
    };
  }

  const alreadyAssigned = robots.find((robot) => robot.missionDrainId === drain.drainId);

  if (alreadyAssigned) {
    return {
      required: true,
      recommended: true,
      available: true,
      assignedToDrain: true,
      robotName: alreadyAssigned.robotName,
      robotId: alreadyAssigned.id,
      batteryLevel: alreadyAssigned.batteryLevel,
      reason: `${alreadyAssigned.robotName} is already assigned to this drain`
    };
  }

  const candidates = robots.filter(
    (robot) =>
      (robot.status === "Active" || robot.status === "Idle") &&
      (robot.batteryLevel === null || robot.batteryLevel >= MIN_BATTERY_FOR_INSPECTION) &&
      (robot.missionDrainId === null || robot.missionDrainId === drain.drainId)
  );

  const nearest = candidates
    .map((robot) => ({
      robot,
      distance: drainCoordinates
        ? coordinateDistance(drainLat, drainLng, robot.latitude, robot.longitude)
        : robot.assignedZone === drain.zoneName
          ? 0
          : null
    }))
    .sort((a, b) => {
      if (a.distance === null && b.distance === null) {
        return a.robot.id - b.robot.id;
      }
      if (a.distance === null) return 1;
      if (b.distance === null) return -1;
      if (a.distance === b.distance) return a.robot.id - b.robot.id;
      return a.distance - b.distance;
    })[0];

  if (nearest) {
    return {
      required: true,
      recommended: true,
      available: true,
      assignedToDrain: false,
      robotName: nearest.robot.robotName,
      robotId: nearest.robot.id,
      batteryLevel: nearest.robot.batteryLevel,
      approximateDistance:
        nearest.distance !== null ? nearest.distance : null,
      reason:
        nearest.distance !== null
          ? `Nearest available robot: ${nearest.robot.robotName}`
          : `Available robot: ${nearest.robot.robotName}`
    };
  }

  const lowBattery = robots.find(
    (robot) =>
      (robot.status === "Active" || robot.status === "Idle") &&
      robot.batteryLevel !== null &&
      robot.batteryLevel < MIN_BATTERY_FOR_INSPECTION
  );

  const busy = robots.find(
    (robot) =>
      (robot.status === "Active" || robot.status === "Idle") &&
      robot.missionDrainId !== null &&
      robot.missionDrainId !== drain.drainId
  );

  let reason = "No robot currently available for inspection";

  if (lowBattery) {
    reason = `${lowBattery.robotName} battery too low (${lowBattery.batteryLevel}%)`;
  } else if (busy) {
    reason = `${busy.robotName} is already busy with another drain`;
  }

  return {
    required: true,
    recommended: true,
    available: false,
    assignedToDrain: false,
    robotName: null,
    robotId: null,
    batteryLevel: lowBattery ? lowBattery.batteryLevel : null,
    reason
  };
}

// ------------------------------------------------------------
// Pure scoring (deterministic, bounded 0-100)
// ------------------------------------------------------------

function buildReasons({ risk, forecast, maintenance, vision, trendRising, alertModifiers }) {
  const reasons = [];

  if (risk) {
    reasons.push(`Flood risk ${risk.riskLevel} (${risk.riskScore}/100)`);
  }

  if (forecast && forecast.status === "ready" && forecast.worst) {
    reasons.push(
      `60-minute forecast predicts ${forecast.worst.predictedRiskLevel} risk (${forecast.worst.predictedRiskScore}/100)`
    );
  }

  if (maintenance && maintenance.status === "READY") {
    reasons.push(
      `Maintenance engine reports ${maintenance.maintenanceLevel} score (${maintenance.maintenanceScore}/100)`
    );

    if (
      maintenance.blockageRiskScore !== null &&
      maintenance.blockageRiskScore >= 50
    ) {
      reasons.push(
        `Blockage risk ${maintenance.blockageRiskLevel} (${maintenance.blockageRiskScore}/100)`
      );
    }
  }

  if (vision && vision.status === "READY") {
    reasons.push(
      `Latest vision inspection: ${vision.inspectionLevel} visual risk (${vision.visualRiskScore}/100)`
    );
  }

  if (trendRising) {
    reasons.push("Water level trend is rising");
  }

  for (const modifier of alertModifiers) {
    reasons.push(`${modifier.name} (+${modifier.points})`);
  }

  return reasons;
}

function computeScore({ signals, trendRising, alertTotal }) {
  let weightedSum = 0;
  let weightSum = 0;
  const contributingFactors = [];

  for (const signal of signals) {
    const weight = WEIGHTS[signal.key];
    weightedSum += weight * signal.value;
    weightSum += weight;

    contributingFactors.push({
      name: signal.name,
      key: signal.key,
      value: signal.value,
      level: signal.level,
      weight,
      contribution: round1(weight * signal.value)
    });
  }

  let baseScore = 0;

  if (weightSum > 0) {
    baseScore = weightedSum / weightSum;
  }

  contributingFactors.forEach((factor) => {
    factor.contribution = round1(
      (factor.weight / weightSum) * baseScore
    );
  });

  const score = Math.round(
    clamp(baseScore + (trendRising ? TREND_RISING_BONUS : 0) + alertTotal, 0, 100)
  );

  return { score, contributingFactors };
}

// ------------------------------------------------------------
// Per-drain decision
// ------------------------------------------------------------

async function getDrainDecision(drainId) {
  if (!Number.isInteger(drainId) || drainId <= 0) {
    return null;
  }

  const drainResult = await pool.query(
    `
    SELECT id, zone_name, location, latitude, longitude
    FROM drains
    WHERE id = $1
    `,
    [drainId]
  );

  if (drainResult.rows.length === 0) {
    return null;
  }

  const drain = {
    ...drainResult.rows[0],
    drainId: Number(drainResult.rows[0].id),
    zoneName: drainResult.rows[0].zone_name
  };

  // Additive sensor health/anomaly context (Update #21). This never
  // changes the priority formula or its weights - it is extra
  // explainability only and a failure here never breaks the engine.
  // The context is TTL-cached so the hot path is not re-querying it
  // on every reading.
  let sensorContext = null;

  try {
    sensorContext = await sensorIntelligenceService.getSensorContextCached(drainId);
  } catch (sensorErr) {
    sensorContext = null;
  }

  // Additive weather + weather-flood correlation context (Update #23).
  // Descriptive only - never changes the priority formula, its
  // weights or the score. Best-effort and TTL-cached; a failure here
  // degrades to null and never breaks the engine.
  let weatherCorrelationContext = null;

  try {
    weatherCorrelationContext =
      await weatherFloodCorrelationService.getWeatherCorrelationContext();
  } catch (weatherErr) {
    weatherCorrelationContext = null;
  }

  let risk = null;
  let forecast = null;
  let maintenance = null;
  let vision = null;

  const forecastResult = await floodForecast.getDrainForecast(drainId);

  if (forecastResult) {
    forecast = forecastResult;

    risk = {
      drainId: Number(forecastResult.drainId),
      sensorId: forecastResult.sensorId,
      zone: forecastResult.zone,
      location: forecastResult.location,
      waterLevel: forecastResult.currentWaterLevel,
      riskScore: finiteNumber(forecastResult.currentRiskScore),
      riskLevel: forecastResult.currentRiskLevel,
      timestamp: forecastResult.timestamp
    };
  } else {
    const riskResult = await floodRisk.buildDrainRiskDetail(drainId);

    if (riskResult) {
      risk = riskResult;
    }
  }

  maintenance = await maintenanceService.getDrainMaintenance(drainId);

  try {
    const visionResult = await visionService.getLatestInspection(drainId, 1);

    if (visionResult) {
      vision = visionResult;
    }
  } catch (visionErr) {
    console.log("⚠️ Decision engine: vision signal skipped:", visionErr.message);
  }

  let alertModifiers = [];
  let alertTotal = 0;

  try {
    const alertResult = await getOpenAlertModifiers(drainId);
    alertModifiers = alertResult.modifiers;
    alertTotal = alertResult.totalPoints;
  } catch (alertErr) {
    console.log("⚠️ Decision engine: alert signal skipped:", alertErr.message);
  }

  let robotContext = { robots: [] };

  try {
    robotContext = await getRobotContext(drain);
  } catch (robotErr) {
    console.log("⚠️ Decision engine: robot context skipped:", robotErr.message);
  }

  // ----------------------------------------------------------
  // Build signals (only present, real values)
  // ----------------------------------------------------------

  const forecastScore =
    forecast && forecast.status === "ready" && forecast.worst
      ? finiteNumber(forecast.worst.predictedRiskScore)
      : null;

  const forecastLevel =
    forecast && forecast.status === "ready" && forecast.worst
      ? forecast.worst.predictedRiskLevel
      : null;

  const maintenanceReady = maintenance && maintenance.status === "READY";

  const visionReady = vision && vision.status === "READY";

  const trendRising =
    (forecast && forecast.trendDirection === "rising") ||
    (risk && risk.trend && String(risk.trend.label || "").toLowerCase().includes("rising")) ||
    (risk && risk.trendDirection === "rising");

  const signals = [];

  if (risk && finiteNumber(risk.riskScore) !== null) {
    signals.push({
      key: "floodRisk",
      name: "Flood Risk",
      value: finiteNumber(risk.riskScore),
      level: risk.riskLevel
    });
  }

  if (forecastScore !== null) {
    signals.push({
      key: "forecast",
      name: "Forecast (60 min)",
      value: forecastScore,
      level: forecastLevel
    });
  }

  if (
    maintenanceReady &&
    finiteNumber(maintenance.maintenanceScore) !== null
  ) {
    signals.push({
      key: "maintenance",
      name: "Maintenance",
      value: finiteNumber(maintenance.maintenanceScore),
      level: maintenance.maintenanceLevel
    });
  }

  if (visionReady && finiteNumber(vision.visualRiskScore) !== null) {
    signals.push({
      key: "vision",
      name: "Vision Inspection",
      value: finiteNumber(vision.visualRiskScore),
      level: vision.inspectionLevel
    });
  }

  if (signals.length === 0) {
    const decision = {
      drainId: Number(drain.id),
      zone: drain.zone_name,
      location: drain.location,
      status: "INSUFFICIENT_DATA",
      reason:
        maintenance && maintenance.status === "INSUFFICIENT_DATA"
          ? maintenance.reason
          : "No monitoring signal is available for this drain",
      priorityScore: null,
      priorityLevel: null,
      recommendedAction: null,
      reasons: [],
      contributingFactors: [],
      modifiers: [],
      robotRecommendation: {
        required: false,
        recommended: false,
        available: false,
        assignedToDrain: false,
        robotName: null,
        robotId: null,
        batteryLevel: null,
        reason: "No priority assessment to act on"
      },
      dataAvailability: {
        floodRisk: false,
        forecast: false,
        maintenance: false,
        vision: false
      },
      sensorIntelligence: sensorContext,
      weatherContext: weatherCorrelationContext
        ? weatherCorrelationContext.weatherContext
        : null,
      weatherCorrelation: weatherCorrelationContext
        ? weatherCorrelationContext.weatherCorrelation
        : null,
      disclaimer: DECISION_DISCLAIMER,
      generatedAt: new Date().toISOString()
    };

    maybeEmitDecision(drainId, decision);
    return decision;
  }

  const { score, contributingFactors } = computeScore({
    signals,
    trendRising,
    alertTotal
  });

  const priorityLevel = priorityLevelFromScore(score);
  const action = recommendedAction(priorityLevel);

  const decision = {
    drainId: Number(drain.id),
    zone: drain.zone_name,
    location: drain.location,
    sensorId: risk ? risk.sensorId : null,
    status: "READY",
    priorityScore: score,
    priorityLevel,
    recommendedAction: action,
    reasons: buildReasons({
      risk,
      forecast,
      maintenance,
      vision,
      trendRising,
      alertModifiers
    }),
    contributingFactors,
    modifiers: [
      ...(trendRising ? [{ name: "Rising water trend", points: TREND_RISING_BONUS }] : []),
      ...alertModifiers.map((modifier) => ({
        name: modifier.name,
        points: modifier.points
      }))
    ],
    robotRecommendation: buildRobotRecommendation({
      drain,
      priorityLevel,
      robotContext
    }),
    dataAvailability: {
      floodRisk: !!(risk && finiteNumber(risk.riskScore) !== null),
      forecast: !!(forecast && forecast.status === "ready" && forecast.worst),
      maintenance: !!(maintenanceReady && finiteNumber(maintenance.maintenanceScore) !== null),
      vision: !!(visionReady && finiteNumber(vision.visualRiskScore) !== null)
    },
    sensorIntelligence: sensorContext,
    weatherContext: weatherCorrelationContext
      ? weatherCorrelationContext.weatherContext
      : null,
    weatherCorrelation: weatherCorrelationContext
      ? weatherCorrelationContext.weatherCorrelation
      : null,
    disclaimer: DECISION_DISCLAIMER,
    generatedAt: new Date().toISOString()
  };

  maybeEmitDecision(drainId, decision);
  return decision;
}

// ------------------------------------------------------------
// Live emission (decisionUpdate on meaningful change)
// ------------------------------------------------------------

function maybeEmitDecision(drainId, decision) {
  if (!decision || decision.status !== "READY") {
    lastEmitted.delete(drainId);
    return;
  }

  const prev = lastEmitted.get(drainId);

  if (!prev) {
    lastEmitted.set(drainId, {
      priorityScore: decision.priorityScore,
      priorityLevel: decision.priorityLevel
    });
    socketHub.emit("decisionUpdate", decision);
    return;
  }

  const scoreDelta = Math.abs(prev.priorityScore - decision.priorityScore);

  if (prev.priorityLevel !== decision.priorityLevel || scoreDelta >= 3) {
    lastEmitted.set(drainId, {
      priorityScore: decision.priorityScore,
      priorityLevel: decision.priorityLevel
    });
    socketHub.emit("decisionUpdate", decision);
  }
}

// ------------------------------------------------------------
// Aggregate decision summary (dashboard + analytics)
// ------------------------------------------------------------

async function getDecisionSummary({ force = false } = {}) {
  if (!force && summaryCache.data && Date.now() - summaryCache.at < SUMMARY_CACHE_TTL_MS) {
    return summaryCache.data;
  }

  const drains = await pool.query(
    `
    SELECT id, zone_name, location, latitude, longitude
    FROM drains
    ORDER BY id ASC
    LIMIT $1
    `,
    [MAX_DRAINS_FOR_SUMMARY]
  );

  const decisions = [];

  for (const drainRow of drains.rows) {
    const decision = await getDrainDecision(Number(drainRow.id));

    if (decision) {
      decisions.push(decision);
    }
  }

  const counts = { low: 0, moderate: 0, high: 0, critical: 0 };
  const actionDistribution = {
    CONTINUE_MONITORING: 0,
    MONITOR_CLOSELY: 0,
    INSPECT_DRAIN: 0,
    IMMEDIATE_ROBOT_INSPECTION: 0
  };

  let insufficient = 0;
  let scoreSum = 0;
  let scoreCount = 0;

  const signalCoverage = {
    floodRisk: 0,
    forecast: 0,
    maintenance: 0,
    vision: 0
  };

  for (const decision of decisions) {
    if (decision.status !== "READY") {
      insufficient += 1;
      continue;
    }

    const level = decision.priorityLevel;
    counts[level] = (counts[level] || 0) + 1;

    if (decision.recommendedAction in actionDistribution) {
      actionDistribution[decision.recommendedAction] += 1;
    }

    scoreSum += decision.priorityScore;
    scoreCount += 1;

    for (const key of Object.keys(signalCoverage)) {
      if (decision.dataAvailability[key]) {
        signalCoverage[key] += 1;
      }
    }
  }

  const topPriority = decisions
    .filter((decision) => decision.status === "READY")
    .sort((a, b) => b.priorityScore - a.priorityScore)
    .slice(0, 5)
    .map((decision) => ({
      drainId: decision.drainId,
      zone: decision.zone,
      location: decision.location,
      priorityScore: decision.priorityScore,
      priorityLevel: decision.priorityLevel,
      recommendedAction: decision.recommendedAction
    }));

  const summary = {
    totalDrains: decisions.length,
    eligibleDrains: scoreCount + insufficient,
    insufficientData: insufficient,
    averagePriorityScore: scoreCount > 0 ? Math.round(scoreSum / scoreCount) : null,
    counts,
    distribution: Object.entries(counts).map(([level, count]) => ({ level, count })),
    actionDistribution,
    signalCoverage,
    topPriority,
    disclaimer: DECISION_DISCLAIMER,
    generatedAt: new Date().toISOString()
  };

  summaryCache = { at: Date.now(), data: summary };
  return summary;
}

function resetDecisionRuntime() {
  summaryCache = { at: 0, data: null };
  lastEmitted.clear();
}

// ------------------------------------------------------------
// Exports
// ------------------------------------------------------------

module.exports = {
  WEIGHTS,
  TREND_RISING_BONUS,
  ALERT_CRITICAL_BONUS,
  ALERT_MEDIUM_BONUS,
  MAX_ALERT_BONUS,
  MIN_BATTERY_FOR_INSPECTION,
  DEFAULT_PRIORITY_THRESHOLDS,
  ACTIONS,
  DECISION_DISCLAIMER,
  clamp,
  finiteNumber,
  round1,
  priorityLevelFromScore,
  recommendedAction,
  coordinateDistance,
  buildRobotRecommendation,
  buildReasons,
  computeScore,
  getOpenAlertModifiers,
  getRobotContext,
  getDrainDecision,
  getDecisionSummary,
  maybeEmitDecision,
  resetDecisionRuntime
};