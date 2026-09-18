// ============================================================
// AI-DrainOS Maintenance & Blockage Prediction Service
//
// Answers a different question from the flood risk and flood
// forecast engines:
//
//   Flood risk      -> "What is the CURRENT flood risk?"
//   Flood forecast  -> "What may happen in the next 15/30/60 min?"
//   MAINTENANCE     -> "Does this drain show signs that
//                      inspection, cleaning or maintenance may
//                      soon be required?"
//
// Two independent systems are kept separate ON PURPOSE:
//   1. floodRiskService.js      (current flood risk)
//   2. floodForecastService.js  (short-term flood forecasting)
//   3. THIS maintenancePredictionService.js
//
// This is an EXPLAINABLE BASELINE model, not a trained ML model.
// It uses deterministic calculations over recent historical
// sensor readings (sensor_readings) plus operational history
// (missions + alerts). It never fabricates confidence - there is
// no "accuracy %" anywhere.
//
// IMPORTANT - MODEL LIMITATION:
// The maintenance score indicates a POTENTIAL need for
// inspection/cleaning based on observable sensor patterns. It
// does NOT prove that a physical blockage exists - that would
// require additional sensors (flow / pressure / camera /
// ultrasonic). Terminology stays honest: "Potential blockage
// risk" / "possible obstruction pattern", never "definitely
// blocked".
// ============================================================

const pool = require("../config/db");

// Additive sensor-health context (Update #21). Exposes a descriptive
// sensor-health/anomaly block on the per-drain maintenance detail
// WITHOUT changing the prediction formula below. Best-effort +
// TTL-cached so the MQTT hot path is not re-querying it per reading.
const sensorIntelligenceService = require("./sensorIntelligenceService");

// --------------------------------------------------
// Configuration (single location)
// --------------------------------------------------

const METHOD_NAME = "Explainable Baseline Maintenance Prediction";
const MODEL_DISCLAIMER =
  "Engineering/demo prediction - not a trained ML model and not physical blockage detection.";

// Bounded number of historical readings analysed per drain.
const READINGS_LIMIT = 30;

// Most recent readings used for the per-reading trend slopes.
const TREND_WINDOW = 10;

// At least this many total readings are required before a READY
// prediction (fewer => INSUFFICIENT_DATA).
const MIN_READINGS_FOR_READY = 1;

// Readings with water_level >= this are counted as high/critical
// (matches the flood risk engine's default CRITICAL threshold).
const CRITICAL_WATER_THRESHOLD = 75;

// Maintenance level thresholds (same banding as the other engines).
const DEFAULT_MAINTENANCE_THRESHOLDS = {
  moderate: 25,
  high: 50,
  critical: 75
};

// Time after a completed cleaning at which a drain is considered
// "aging" (used by recommendation + reasons).
const CLEANING_AGING_MINUTES = 720;

// Maintenance score weights (engineering/demo values, sum = 1.0)
const MAINTENANCE_WEIGHTS = {
  waterLevel: 0.20,
  waterTrend: 0.18,
  gasLevel: 0.08,
  gasTrend: 0.03,
  temperature: 0.04,
  temperatureTrend: 0.02,
  highRiskEvents: 0.13,
  alertFrequency: 0.05,
  cleaningHistory: 0.08,
  timeSinceCleaning: 0.12,
  readingFrequency: 0.04,
  persistentAbnormal: 0.03
};

// Blockage-risk weights (engineering/demo values, sum = 1.0).
// Only ever described as a POTENTIAL blockage / possible
// obstruction pattern.
const BLOCKAGE_WEIGHTS = {
  waterTrend: 0.30,
  waterLevelPersistence: 0.25,
  abnormalGas: 0.15,
  highRiskRecurrence: 0.15,
  cleaningRecurrence: 0.15
};

// Cache for the aggregate summary (dashboard + analytics).
const SUMMARY_CACHE_TTL_MS = 10000;
let summaryCache = { at: 0, data: null };

// Per-drain prediction cache (avoids recomputing expensive
// history queries on the same drain for every sensor message).
const DRAIN_CACHE_TTL_MS = 10000;
let drainCache = new Map();

// --------------------------------------------------
// Low-level helpers
// --------------------------------------------------

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function toFiniteNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function levelFromScore(score, thresholds = DEFAULT_MAINTENANCE_THRESHOLDS) {
  const numeric = toFiniteNumber(score);

  if (numeric >= thresholds.critical) return "CRITICAL";
  if (numeric >= thresholds.high) return "HIGH";
  if (numeric >= thresholds.moderate) return "MODERATE";
  return "LOW";
}

// --------------------------------------------------
// Signal -> 0-100 scores (deterministic)
// --------------------------------------------------

// Simple linear slope over a chronological numeric series.
// Returns null when fewer than 2 valid points exist.
function seriesSlope(values) {
  const clean = (Array.isArray(values) ? values : [])
    .map(toFiniteNumber)
    .filter((value) => Number.isFinite(value));

  if (clean.length < 2) {
    return null;
  }

  const first = clean[0];
  const last = clean[clean.length - 1];

  return (last - first) / (clean.length - 1);
}

// Rising trend increases the score, falling trend lowers it,
// flat stays near the neutral middle.
function trendScoreFromSlope(slope) {
  if (slope === null || slope === undefined) return null;
  return clamp(50 + slope * 15, 0, 100);
}

// Elevated water persistence / abnormal gas -> direct 0-100.
function levelScore(value) {
  return clamp(toFiniteNumber(value), 0, 100);
}

// Abnormal drain temperature (e.g. fermentation / biofilm heat):
// <= 30C is normal, >= 40C is extreme.
function abnormalTemperatureScore(value) {
  const num = toFiniteNumber(value);

  if (num <= 30) return 0;
  if (num >= 40) return 100;

  return ((num - 30) / 10) * 100;
}

// Repeated high/critical readings raise the maintenance pressure.
function highRiskEventsScore(count) {
  return clamp(toFiniteNumber(count, 0) * 15, 0, 100);
}

function alertFrequencyScore(count) {
  return clamp(toFiniteNumber(count, 0) * 10, 0, 100);
}

// Drains that needed cleaning repeatedly in the past tend to need
// it again - a recurrence signal, not a proof.
function cleaningHistoryScore(totalCompleted) {
  return clamp(toFiniteNumber(totalCompleted, 0) * 20, 0, 100);
}

// Aging since last completed cleaning: full pressure after 12h.
function timeSinceCleaningScore(minutes) {
  if (minutes === null || minutes === undefined) return 0;
  return clamp((toFiniteNumber(minutes) / CLEANING_AGING_MINUTES) * 100, 0, 100);
}

// Data-support signal: more recent readings = the observed
// patterns are better supported.
function readingFrequencyScore(count) {
  const target = READINGS_LIMIT / 2;
  return clamp((toFiniteNumber(count, 0) / target) * 100, 0, 100);
}

// Share of the analysed readings that had elevated water.
function persistentAbnormalScore(ratioElevated) {
  return clamp(toFiniteNumber(ratioElevated, 0) * 100, 0, 100);
}

// --------------------------------------------------
// Recommendation + inspection priority (deterministic)
// --------------------------------------------------

function buildRecommendation(maintenanceLevel, maintenanceScore, trendScore, blockageRiskScore, minutesSinceLastCleaning) {
  const blockersRising = trendScore !== null && trendScore >= 60;
  const blockageConcern = blockageRiskScore >= 50;

  if (maintenanceLevel === "CRITICAL") {
    return { recommendation: "Immediate maintenance attention required", inspectionPriority: "CRITICAL" };
  }

  if (maintenanceLevel === "HIGH") {
    if (blockageConcern) {
      return { recommendation: "Priority inspection required", inspectionPriority: "HIGH" };
    }
    return { recommendation: "Schedule cleaning", inspectionPriority: "HIGH" };
  }

  if (maintenanceLevel === "MODERATE") {
    if (blockersRising || blockageConcern) {
      return { recommendation: "Schedule inspection", inspectionPriority: "MEDIUM" };
    }
    if (minutesSinceLastCleaning !== null && minutesSinceLastCleaning >= CLEANING_AGING_MINUTES) {
      return { recommendation: "Schedule cleaning", inspectionPriority: "MEDIUM" };
    }
    return { recommendation: "Monitor drain", inspectionPriority: "MEDIUM" };
  }

  if (blockageConcern || (minutesSinceLastCleaning !== null && minutesSinceLastCleaning >= CLEANING_AGING_MINUTES * 2)) {
    return { recommendation: "Monitor drain", inspectionPriority: "LOW" };
  }

  return { recommendation: "No immediate maintenance required", inspectionPriority: "LOW" };
}

// --------------------------------------------------
// Explainable reasons (deterministic, honest wording)
// --------------------------------------------------

function buildReasons({
  waterLevelScore,
  waterSlope,
  gasScore,
  temperature,
  highRiskEvents,
  alertFrequency,
  cleaningHistory,
  recentCleanings,
  minutesSinceLastCleaning,
  blockageRiskScore
}) {
  const reasons = [];

  if (waterLevelScore >= 70) {
    reasons.push("Recent water level remains elevated");
  }

  if (waterSlope !== null && waterSlope !== undefined) {
    if (waterSlope > 2) {
      reasons.push("Water level is rising rapidly");
    } else if (waterSlope > 0.3) {
      reasons.push("Water level has been rising consistently");
    }
  }

  if (gasScore >= 50) {
    reasons.push("Abnormal gas level observed");
  }

  if (Number(temperature) >= 38) {
    reasons.push("Abnormally high temperature observed");
  }

  if (highRiskEvents >= 3) {
    reasons.push("Drain has experienced repeated high-risk readings");
  }

  if (alertFrequency >= 2) {
    reasons.push("Frequent recent alerts at this drain");
  }

  if (cleaningHistory >= 2) {
    reasons.push("Drain has required multiple cleaning missions");
  }

  if (recentCleanings >= 1 && cleaningHistory >= 2) {
    reasons.push("Recent cleaning activity detected; watch for recurrence");
  }

  if (minutesSinceLastCleaning !== null && minutesSinceLastCleaning !== undefined && minutesSinceLastCleaning >= CLEANING_AGING_MINUTES) {
    reasons.push("Time since last cleaning is long");
  }

  if (blockageRiskScore >= 50) {
    reasons.push("Possible obstruction pattern detected in recent sensor data");
  }

  if (reasons.length === 0) {
    reasons.push("No notable maintenance pressure signals detected");
  }

  return reasons;
}

// --------------------------------------------------
// Pure deterministic prediction builder (testable)
//
// Inputs (each may be null/undefined when unavailable):
//   waterLevel, waterTrend (slope/reading),
//   gasLevel, gasTrend, temperature, temperatureTrend,
//   recentCriticalEvents, alertsLast24h,
//   completedCleaningMissions, recentCleaningMissions,
//   minutesSinceLastCleaning (null = no cleaning history),
//   readingsCount, averageRecentWater, elevatedShare
//
// Returns a ready prediction OR a status object.
// --------------------------------------------------

function calculateMaintenancePrediction(input = {}) {
  const unavailable = [];

  const waterLevel = toFiniteNumber(input.waterLevel);
  const gasLevel = toFiniteNumber(input.gasLevel);
  const temperature = toFiniteNumber(input.temperature);

  const waterTrendVal = input.waterTrend;
  const gasTrendVal = input.gasTrend;
  const temperatureTrendVal = input.temperatureTrend;

  const waterLevelScore = levelScore(waterLevel);
  const waterTrendScore = trendScoreFromSlope(waterTrendVal);
  const gasScore = levelScore(gasLevel);
  const gasTrendScore = trendScoreFromSlope(gasTrendVal);
  const temperatureScore = abnormalTemperatureScore(temperature);
  const temperatureTrendScore = trendScoreFromSlope(temperatureTrendVal);

  if (waterTrendScore === null) unavailable.push("waterTrend");
  if (gasTrendScore === null) unavailable.push("gasTrend");
  if (temperatureTrendScore === null) unavailable.push("temperatureTrend");

  const highRiskEvents = toFiniteNumber(input.recentCriticalEvents, 0);
  const alerts = toFiniteNumber(input.alertsLast24h, 0);
  const cleaningHistory = toFiniteNumber(input.completedCleaningMissions, 0);
  const recentCleanings = toFiniteNumber(input.recentCleaningMissions, 0);
  const minutesSince = input.minutesSinceLastCleaning === null || input.minutesSinceLastCleaning === undefined
    ? null
    : toFiniteNumber(input.minutesSinceLastCleaning);
  if (minutesSince === null) unavailable.push("timeSinceLastCleaning");

  const readingsCount = toFiniteNumber(input.readingsCount, 0);
  const avgWater = toFiniteNumber(input.averageRecentWater);
  const elevatedShare = toFiniteNumber(input.elevatedShare, 0);

  const scores = {
    waterLevelScore,
    waterTrendScore: waterTrendScore === null ? 50 : waterTrendScore,
    gasScore,
    gasTrendScore: gasTrendScore === null ? 50 : gasTrendScore,
    temperatureScore,
    temperatureTrendScore: temperatureTrendScore === null ? 50 : temperatureTrendScore,
    highRiskEventsScore: highRiskEventsScore(highRiskEvents),
    alertFrequencyScore: alertFrequencyScore(alerts),
    cleaningHistoryScore: cleaningHistoryScore(cleaningHistory),
    timeSinceCleaningScore: timeSinceCleaningScore(minutesSince),
    readingFrequencyScore: readingFrequencyScore(readingsCount),
    persistentAbnormalScore: persistentAbnormalScore(elevatedShare)
  };

  const rawMaintenance = clamp(
    scores.waterLevelScore * MAINTENANCE_WEIGHTS.waterLevel +
      scores.waterTrendScore * MAINTENANCE_WEIGHTS.waterTrend +
      scores.gasScore * MAINTENANCE_WEIGHTS.gasLevel +
      scores.gasTrendScore * MAINTENANCE_WEIGHTS.gasTrend +
      scores.temperatureScore * MAINTENANCE_WEIGHTS.temperature +
      scores.temperatureTrendScore * MAINTENANCE_WEIGHTS.temperatureTrend +
      scores.highRiskEventsScore * MAINTENANCE_WEIGHTS.highRiskEvents +
      scores.alertFrequencyScore * MAINTENANCE_WEIGHTS.alertFrequency +
      scores.cleaningHistoryScore * MAINTENANCE_WEIGHTS.cleaningHistory +
      scores.timeSinceCleaningScore * MAINTENANCE_WEIGHTS.timeSinceCleaning +
      scores.readingFrequencyScore * MAINTENANCE_WEIGHTS.readingFrequency +
      scores.persistentAbnormalScore * MAINTENANCE_WEIGHTS.persistentAbnormal,
    0,
    100
  );

  const maintenanceScore = Math.round(rawMaintenance);
  const maintenanceLevel = levelFromScore(rawMaintenance);

  // -----------------------------------------------
  // Blockage risk score (potential obstruction pattern)
  // -----------------------------------------------

  const rawBlockage = clamp(
    (waterTrendScore === null ? 50 : waterTrendScore) * BLOCKAGE_WEIGHTS.waterTrend +
      avgWater * BLOCKAGE_WEIGHTS.waterLevelPersistence +
      gasScore * BLOCKAGE_WEIGHTS.abnormalGas +
      highRiskEventsScore(highRiskEvents) * BLOCKAGE_WEIGHTS.highRiskRecurrence +
      cleaningHistoryScore(cleaningHistory) * BLOCKAGE_WEIGHTS.cleaningRecurrence,
    0,
    100
  );

  const blockageRiskScore = Math.round(rawBlockage);
  const blockageRiskLevel = levelFromScore(rawBlockage);

  const { recommendation, inspectionPriority } = buildRecommendation(
    maintenanceLevel,
    maintenanceScore,
    waterTrendScore,
    blockageRiskScore,
    minutesSince
  );

  const reasons = buildReasons({
    waterLevelScore,
    waterSlope: waterTrendVal === null || waterTrendVal === undefined ? null : waterTrendVal,
    gasScore,
    temperature,
    highRiskEvents,
    alertFrequency: alerts,
    cleaningHistory,
    recentCleanings,
    minutesSinceLastCleaning: minutesSince,
    blockageRiskScore
  });

  return {
    status: "READY",
    method: METHOD_NAME,
    maintenanceScore,
    maintenanceLevel,
    blockageRiskScore,
    blockageRiskLevel,
    inspectionPriority,
    maintenanceRecommendation: recommendation,
    reasons,
    unavailableSignals: unavailable,
    signals: {
      waterLevel: Math.round(waterLevel),
      waterTrend: waterTrendVal === null || waterTrendVal === undefined ? null : Math.round(waterTrendVal * 100) / 100,
      gasLevel: Math.round(gasLevel),
      gasTrend: gasTrendVal === null || gasTrendVal === undefined ? null : Math.round(gasTrendVal * 100) / 100,
      temperature: Math.round(temperature * 100) / 100,
      temperatureTrend: temperatureTrendVal === null || temperatureTrendVal === undefined ? null : Math.round(temperatureTrendVal * 100) / 100,
      recentCriticalEvents: highRiskEvents,
      completedCleaningMissions: cleaningHistory,
      recentCleaningMissions: recentCleanings,
      timeSinceLastCleaningMinutes: minutesSince,
      alertsLast24h: alerts,
      readingsAnalyzed: readingsCount
    }
  };
}

// --------------------------------------------------
// Historical readings (parameterized SQL only, bounded)
// --------------------------------------------------

async function getSeries(drainId, limit = READINGS_LIMIT) {
  const result = await pool.query(
    `
    SELECT water_level, gas_level, temperature, recorded_at
    FROM sensor_readings
    WHERE drain_id = $1
    ORDER BY recorded_at ASC, id ASC
    LIMIT $2
    `,
    [drainId, limit]
  );

  return result.rows;
}

// --------------------------------------------------
// Persistence (audit trail for analytics trends)
// --------------------------------------------------

async function persistPrediction(prediction) {
  await pool.query(
    `
    INSERT INTO maintenance_predictions
      (drain_id, maintenance_score, maintenance_level, blockage_risk_score,
       inspection_priority, recommendation, reasons, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)
    `,
    [
      prediction.drainId,
      prediction.maintenanceScore,
      prediction.maintenanceLevel,
      prediction.blockageRiskScore,
      prediction.inspectionPriority,
      prediction.maintenanceRecommendation,
      JSON.stringify(prediction.reasons || [])
    ]
  );
}

// --------------------------------------------------
// Per-drain prediction (REST + dashboard + MQTT)
// --------------------------------------------------

async function getDrainMaintenance(drainId) {
  const now = Date.now();

  const cached = drainCache.get(drainId);
  if (cached && now - cached.at < DRAIN_CACHE_TTL_MS) {
    return cached.data;
  }

  const drainResult = await pool.query(
    `
    SELECT
      d.id, d.zone_name, d.location,
      s.id AS sensor_id, s.water_level, s.gas_level, s.temperature
    FROM drains d
    LEFT JOIN sensors s
      ON s.drain_id = d.id
    WHERE d.id = $1
    ORDER BY s.id ASC
    LIMIT 1
    `,
    [drainId]
  );

  if (drainResult.rows.length === 0) {
    return null;
  }

  const row = drainResult.rows[0];

  const insufficient = (reason) => {
    const payload = {
      drainId: Number(row.id),
      status: "INSUFFICIENT_DATA",
      method: METHOD_NAME,
      maintenanceScore: null,
      maintenanceLevel: null,
      blockageRiskScore: null,
      blockageRiskLevel: null,
      inspectionPriority: null,
      maintenanceRecommendation: null,
      reasons: [],
      reason,
      sensorIntelligence: null
    };
    drainCache.set(drainId, { at: Date.now(), data: payload });
    return payload;
  };

  if (row.sensor_id === null) {
    return insufficient("No sensor attached to this drain");
  }

  const series = await getSeries(drainId, READINGS_LIMIT);

  if (series.length === 0) {
    return insufficient("No historical sensor readings yet");
  }

  const chronologicalWater = series.map((r) => Number(r.water_level));
  const chronologicalGas = series.map((r) => Number(r.gas_level));
  const chronologicalTemp = series.map((r) => Number(r.temperature));

  const waterTrendWindow = chronologicalWater.slice(-TREND_WINDOW);
  const gasTrendWindow = chronologicalGas.slice(-TREND_WINDOW);
  const tempTrendWindow = chronologicalTemp.slice(-TREND_WINDOW);

  const recentCriticalEvents = chronologicalWater.filter(
    (w) => w >= CRITICAL_WATER_THRESHOLD
  ).length;

  const elevatedCount = chronologicalWater.filter((w) => w >= 50).length;
  const averageRecentWater =
    chronologicalWater.reduce((sum, w) => sum + w, 0) / chronologicalWater.length;

  // Operational history (parameterized SQL only)
  const [alertResult, cleanResult, lastCleanResult] = await Promise.all([
    pool.query(
      `
      SELECT
        (SELECT COUNT(*) FROM alerts
         WHERE drain_id = $1 AND alert_status = 'Open') AS open_count,
        (SELECT COUNT(*) FROM alerts
         WHERE drain_id = $1
           AND created_at >= NOW() - INTERVAL '24 hours') AS recent_24h
      `,
      [drainId]
    ),
    pool.query(
      `
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (
          WHERE completed_time >= NOW() - INTERVAL '48 hours'
        ) AS recent
      FROM missions
      WHERE drain_id = $1 AND mission_status = 'Completed'
      `,
      [drainId]
    ),
    pool.query(
      `
      SELECT MAX(completed_time) AS last_completed
      FROM missions
      WHERE drain_id = $1 AND mission_status = 'Completed'
        AND completed_time IS NOT NULL
      `,
      [drainId]
    )
  ]);

  const totalCleanings = Number(cleanResult.rows[0].total);
  const recentCleanings = Number(cleanResult.rows[0].recent);

  let minutesSinceLastCleaning = null;
  const lastCompleted = lastCleanResult.rows[0].last_completed;
  if (lastCompleted) {
    minutesSinceLastCleaning = Math.round(
      (Date.now() - new Date(lastCompleted).getTime()) / 60000
    );
  }

  const prediction = calculateMaintenancePrediction({
    waterLevel: Number(row.water_level),
    waterTrend: seriesSlope(waterTrendWindow),
    gasLevel: Number(row.gas_level),
    gasTrend: seriesSlope(gasTrendWindow),
    temperature: Number(row.temperature),
    temperatureTrend: seriesSlope(tempTrendWindow),
    recentCriticalEvents,
    alertsLast24h: Number(alertResult.rows[0].recent_24h),
    completedCleaningMissions: totalCleanings,
    recentCleaningMissions: recentCleanings,
    minutesSinceLastCleaning,
    readingsCount: series.length,
    averageRecentWater,
    elevatedShare: elevatedCount / series.length
  });

  // Additive sensor-health context (Update #21). Best-effort + cached;
  // a failure or missing sensor data degrades to null and never changes
  // the maintenance prediction above.
  let sensorIntelligence = null;
  try {
    sensorIntelligence = await sensorIntelligenceService.getSensorContextCached(drainId);
  } catch (sensorErr) {
    sensorIntelligence = null;
  }

  const payload = {
    drainId: Number(row.id),
    sensorId: Number(row.sensor_id),
    zone: row.zone_name,
    location: row.location,
    timestamp: new Date().toISOString(),
    disclaimer: MODEL_DISCLAIMER,
    ...prediction,
    sensorIntelligence
  };

  // Audit trail (best-effort - never break the caller on failure)
  try {
    await persistPrediction(payload);
  } catch (persistErr) {
    console.log("⚠️ Maintenance prediction persistence skipped:", persistErr.message);
  }

  drainCache.set(drainId, { at: Date.now(), data: payload });

  return payload;
}

// --------------------------------------------------
// Aggregate summary (dashboard + analytics)
// --------------------------------------------------

async function getMaintenanceSummary({ force = false } = {}) {
  if (!force && summaryCache.data && Date.now() - summaryCache.at < SUMMARY_CACHE_TTL_MS) {
    return summaryCache.data;
  }

  const drains = await pool.query(`
    SELECT d.id AS drain_id, d.zone_name, d.location
    FROM drains d
    ORDER BY d.id ASC
  `);

  const entries = [];

  for (const drain of drains.rows) {
    const prediction = await getDrainMaintenance(drain.drain_id);

    if (!prediction || prediction.status !== "READY") {
      continue;
    }

    entries.push({
      drainId: Number(prediction.drainId),
      sensorId: prediction.sensorId,
      zone: prediction.zone,
      location: prediction.location,
      maintenanceScore: prediction.maintenanceScore,
      maintenanceLevel: prediction.maintenanceLevel,
      blockageRiskScore: prediction.blockageRiskScore,
      blockageRiskLevel: prediction.blockageRiskLevel,
      inspectionPriority: prediction.inspectionPriority,
      maintenanceRecommendation: prediction.maintenanceRecommendation,
      timeSinceLastCleaningMinutes: prediction.signals.timeSinceLastCleaningMinutes
    });
  }

  entries.sort((a, b) => b.maintenanceScore - a.maintenanceScore);

  const counts = { low: 0, moderate: 0, high: 0, critical: 0 };

  let totalMaintenance = 0;
  let totalBlockage = 0;

  entries.forEach((entry) => {
    totalMaintenance += entry.maintenanceScore;
    totalBlockage += entry.blockageRiskScore;
    counts[entry.maintenanceLevel.toLowerCase()] += 1;
  });

  const drainsRequiringInspection = entries.filter(
    (e) => e.inspectionPriority === "HIGH" || e.inspectionPriority === "CRITICAL"
  );

  const drainsRequiringCleaning = entries.filter((e) =>
    /cleaning|Maintenance attention/i.test(e.maintenanceRecommendation)
  );

  const highestBlockage = entries.length > 0
    ? entries.reduce((a, b) => (b.blockageRiskScore > a.blockageRiskScore ? b : a))
    : null;

  const summary = {
    totalDrains: entries.length,
    counts,
    distribution: Object.entries(counts).map(([level, count]) => ({
      level: level.toUpperCase(),
      count
    })),
    averageMaintenanceScore: entries.length > 0 ? Math.round(totalMaintenance / entries.length) : 0,
    averageBlockageRisk: entries.length > 0 ? Math.round(totalBlockage / entries.length) : 0,
    drainsRequiringInspection,
    drainsRequiringCleaning,
    highestMaintenanceScore: entries.length > 0 ? entries[0].maintenanceScore : 0,
    highestBlockageRisk: highestBlockage ? highestBlockage.blockageRiskScore : 0,
    topMaintenance: entries.length > 0 ? entries[0] : null,
    drains: entries
  };

  summaryCache = { at: Date.now(), data: summary };

  return summary;
}

// --------------------------------------------------
// Maintenance alert workflow
//
// Uses the existing alerts table with a dedicated 'Maintenance'
// alert_type so it stays clearly distinguishable from 'Flood
// Risk' and 'Flood Forecast' alerts. Existing alert workflows
// (list, resolve, robot completion, drain->Normal) keep working
// untouched.
//
// Deduplication: only one Open 'Maintenance' alert per drain.
// Severity may only be upgraded here; the alert is resolved once
// the predicted maintenance level drops below HIGH.
// --------------------------------------------------

async function ensureMaintenanceAlert({ drainId, location, severity, message }) {
  const existing = await pool.query(
    `
    SELECT id, severity
    FROM alerts
    WHERE drain_id = $1
      AND alert_status = 'Open'
      AND alert_type = 'Maintenance'
    ORDER BY id ASC
    LIMIT 1
    `,
    [drainId]
  );

  if (existing.rows.length === 0) {
    const inserted = await pool.query(
      `
      INSERT INTO alerts (drain_id, alert_type, message, severity, alert_status)
      VALUES ($1, 'Maintenance', $2, $3, 'Open')
      RETURNING id
      `,
      [drainId, message, severity]
    );

    console.log(`🛠️ Maintenance alert created for ${location} (${severity})`);
    return { action: "created", id: inserted.rows[0].id };
  }

  const current = existing.rows[0];

  if (severity === "Critical" && current.severity !== "Critical") {
    await pool.query(
      `
      UPDATE alerts
      SET severity = 'Critical', message = $2
      WHERE id = $1
      `,
      [current.id, message]
    );

    console.log(`🛠️ Maintenance alert upgraded to Critical for ${location}`);
    return { action: "upgraded", id: current.id };
  }

  return { action: "kept", id: current.id };
}

async function resolveMaintenanceAlerts(drainId) {
  const resolved = await pool.query(
    `
    UPDATE alerts
    SET alert_status = 'Resolved'
    WHERE drain_id = $1
      AND alert_status = 'Open'
      AND alert_type = 'Maintenance'
    RETURNING id
    `,
    [drainId]
  );

  if (resolved.rows.length > 0) {
    console.log(`✅ Maintenance alerts resolved for drain ${drainId}`);
  }

  return resolved.rows.length;
}

// --------------------------------------------------
// Analytics (recent maintenance trends)
// --------------------------------------------------

async function getMaintenanceAnalytics() {
  const summary = await getMaintenanceSummary();

  const trends = await pool.query(
    `
    SELECT
      to_char(date_trunc('hour', created_at), 'HH24:00') AS hour,
      ROUND(AVG(maintenance_score)) AS avg_maintenance_score,
      ROUND(AVG(blockage_risk_score)) AS avg_blockage_risk,
      COUNT(*) AS predictions
    FROM maintenance_predictions
    WHERE created_at >= NOW() - INTERVAL '24 hours'
    GROUP BY date_trunc('hour', created_at)
    ORDER BY date_trunc('hour', created_at) ASC
    `
  );

  return {
    totalDrains: summary.totalDrains,
    counts: summary.counts,
    distribution: summary.distribution,
    averageMaintenanceScore: summary.averageMaintenanceScore,
    averageBlockageRisk: summary.averageBlockageRisk,
    drainsRequiringInspection: summary.drainsRequiringInspection,
    drainsRequiringCleaning: summary.drainsRequiringCleaning,
    recentTrends: trends.rows.map((row) => ({
      hour: row.hour,
      averageMaintenanceScore: Number(row.avg_maintenance_score),
      averageBlockageRisk: Number(row.avg_blockage_risk),
      predictions: Number(row.predictions)
    })),
    topDrains: summary.drains.slice(0, 5)
  };
}

// --------------------------------------------------
// Cache flushing (tests + cache-invalidation on demand)
// --------------------------------------------------

function resetMaintenanceRuntime() {
  drainCache.clear();
  summaryCache = { at: 0, data: null };
}

// --------------------------------------------------
// Exports
// --------------------------------------------------

module.exports = {
  METHOD_NAME,
  MODEL_DISCLAIMER,
  READINGS_LIMIT,
  TREND_WINDOW,
  MIN_READINGS_FOR_READY,
  CRITICAL_WATER_THRESHOLD,
  DEFAULT_MAINTENANCE_THRESHOLDS,
  CLEANING_AGING_MINUTES,
  MAINTENANCE_WEIGHTS,
  BLOCKAGE_WEIGHTS,
  clamp,
  seriesSlope,
  trendScoreFromSlope,
  levelScore,
  abnormalTemperatureScore,
  highRiskEventsScore,
  alertFrequencyScore,
  cleaningHistoryScore,
  timeSinceCleaningScore,
  readingFrequencyScore,
  persistentAbnormalScore,
  levelFromScore,
  buildRecommendation,
  buildReasons,
  calculateMaintenancePrediction,
  getSeries,
  persistPrediction,
  getDrainMaintenance,
  getMaintenanceSummary,
  ensureMaintenanceAlert,
  resolveMaintenanceAlerts,
  getMaintenanceAnalytics,
  resetMaintenanceRuntime
};