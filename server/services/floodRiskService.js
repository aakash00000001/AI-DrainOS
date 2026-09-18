// ============================================================
// AI-DrainOS Flood Risk Intelligence Engine
//
// Calculates an explainable, deterministic Flood Risk Score
// (0-100) from the latest sensor reading plus a trend component
// derived from recent historical readings (sensor_readings).
//
// IMPORTANT - MODEL LIMITATION:
// ----------
// This flood risk score is an engineering/demo risk model and is
// not a scientifically validated municipal flood forecasting
// model. Weights and thresholds are engineering choices made for
// the demo, tuned so a few clear scenarios produce sensible
// outputs:
//
//   LOW       (0-24)      e.g. water ~20, stable/decreasing trend
//   MODERATE  (25-49)     e.g. water ~50, mild trend
//   HIGH      (50-74)     e.g. water 65-75 + rising trend
//   CRITICAL  (75-100)    e.g. water 90+ + rapidly rising trend
//
// Do not use it to make real public-safety decisions.
// ============================================================

const pool = require("../config/db");

// Additive sensor-intelligence context (Update #21). Exposes a
// descriptive sensor-health/anomaly block on the per-drain detail
// WITHOUT changing the risk formula below. Best-effort + TTL-cached.
const sensorIntelligenceService = require("./sensorIntelligenceService");

// --------------------------------------------------
// Configuration (single location)
// --------------------------------------------------

// Factor weights (engineering/demo values, sum = 1.0)
const WEIGHTS = {
  water: 0.50,
  gas: 0.15,
  temperature: 0.10,
  trend: 0.25
};

// Temperature risk ramp: <= TEMP_COMFORT => 0 risk,
// >= TEMP_EXTREME => 100 risk. Normal ambient temperatures stay
// low so they cannot dominate the result.
const TEMP_COMFORT = 20;
const TEMP_EXTREME = 45;

// Trend component: slope is in %-points of water level per
// reading. trendScore = base + slope * rate, clamped to 0-100.
const TREND_STABLE_BASE = 10;
const TREND_RATE = 10;

// Number of historical readings used for the trend component.
const HISTORY_WINDOW = 10;

// Keep the history table small - retain only the newest N
// readings per drain.
const READINGS_RETENTION = 1000;

// Default risk level thresholds (overridable via settings keys
// risk_moderate_min / risk_high_min / risk_critical_min).
const DEFAULT_RISK_THRESHOLDS = {
  moderate: 25,
  high: 50,
  critical: 75
};

// Cache for the aggregate risk summary (avoids running expensive
// per-drain trend queries on every analytics poll).
const SUMMARY_CACHE_TTL_MS = 5000;
let summaryCache = { at: 0, data: null };

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

// --------------------------------------------------
// Input normalization -> 0-100 risk for each factor
// --------------------------------------------------

function normalizeWater(value) {
  const num = toFiniteNumber(value);
  return clamp(num, 0, 100);
}

function normalizeGas(value) {
  const num = toFiniteNumber(value);
  return clamp(num, 0, 100);
}

function normalizeTemperature(value) {
  const num = toFiniteNumber(value);

  if (num <= TEMP_COMFORT) {
    return 0;
  }

  if (num >= TEMP_EXTREME) {
    return 100;
  }

  return Math.round(
    ((num - TEMP_COMFORT) / (TEMP_EXTREME - TEMP_COMFORT)) * 100
  );
}

// --------------------------------------------------
// Trend component
// --------------------------------------------------

function trendLabel(slope) {
  if (slope > 2) return "Rapidly Rising";
  if (slope > 0.3) return "Rising";
  if (slope >= -0.3) return "Stable";
  if (slope >= -2) return "Falling";
  return "Rapidly Falling";
}

// history: previous water_level readings (chronological), NOT
// including the current reading. Returns { score, slope, label }.
function trendScore(history, currentWater) {
  const series = Array.isArray(history)
    ? history.map(toFiniteNumber).filter((value) => Number.isFinite(value))
    : [];

  series.push(toFiniteNumber(currentWater));

  if (series.length < 2) {
    return { score: 0, slope: 0, label: "Insufficient data" };
  }

  const first = series[0];
  const last = series[series.length - 1];
  const slope = (last - first) / (series.length - 1);

  const score = clamp(TREND_STABLE_BASE + slope * TREND_RATE, 0, 100);

  return { score, slope: Math.round(slope * 100) / 100, label: trendLabel(slope) };
}

// --------------------------------------------------
// Risk levels
// --------------------------------------------------

function riskLevelFromScore(score, thresholds = DEFAULT_RISK_THRESHOLDS) {
  const numeric = toFiniteNumber(score);

  if (numeric >= thresholds.critical) return "CRITICAL";
  if (numeric >= thresholds.high) return "HIGH";
  if (numeric >= thresholds.moderate) return "MODERATE";
  return "LOW";
}

// --------------------------------------------------
// Pure risk calculation (fully deterministic, testable)
// --------------------------------------------------

// thresholds: { moderate, high, critical } - defaults are used
// when not provided. history: prior readings (chronological).
function calculateFloodRisk({
  water_level,
  gas_level,
  temperature,
  history = [],
  thresholds = DEFAULT_RISK_THRESHOLDS
}) {
  const waterScore = normalizeWater(water_level);
  const gasScore = normalizeGas(gas_level);
  const temperatureScore = normalizeTemperature(temperature);
  const trend = trendScore(history, water_level);

  const waterContribution = waterScore * WEIGHTS.water;
  const gasContribution = gasScore * WEIGHTS.gas;
  const temperatureContribution = temperatureScore * WEIGHTS.temperature;
  const trendContribution = trend.score * WEIGHTS.trend;

  const rawScore = clamp(
    waterContribution +
      gasContribution +
      temperatureContribution +
      trendContribution,
    0,
    100
  );

  const riskScore = Math.round(rawScore);

  const breakdown = {
    water: Math.round(waterContribution),
    gas: Math.round(gasContribution),
    temperature: Math.round(temperatureContribution),
    trend: Math.round(trendContribution)
  };

  const factors = [
    {
      name: "Water Level",
      value: waterScore,
      contribution: breakdown.water
    },
    {
      name: "Gas Level",
      value: gasScore,
      contribution: breakdown.gas
    },
    {
      name: "Temperature",
      value: Math.round(temperatureScore * 100) / 100,
      contribution: breakdown.temperature
    },
    {
      name: "Water Trend",
      value: trend.slope,
      label: trend.label,
      contribution: breakdown.trend
    }
  ];

  return {
    riskScore,
    riskLevel: riskLevelFromScore(rawScore, thresholds),
    breakdown,
    factors,
    trend: { slope: trend.slope, label: trend.label }
  };
}

// --------------------------------------------------
// Settings-backed thresholds (one configuration location)
// --------------------------------------------------

async function getRiskThresholds() {
  const result = await pool.query(`
    SELECT key, value
    FROM settings
    WHERE key IN ('risk_moderate_min', 'risk_high_min', 'risk_critical_min')
  `);

  const thresholds = { ...DEFAULT_RISK_THRESHOLDS };

  result.rows.forEach((row) => {
    const value = Number(row.value);

    if (Number.isFinite(value)) {
      if (row.key === "risk_moderate_min") thresholds.moderate = value;
      if (row.key === "risk_high_min") thresholds.high = value;
      if (row.key === "risk_critical_min") thresholds.critical = value;
    }
  });

  return thresholds;
}

// --------------------------------------------------
// Historical readings (parameterized SQL only)
// --------------------------------------------------

async function getWaterHistory(drainId, limit = HISTORY_WINDOW) {
  const result = await pool.query(
    `
    SELECT water_level
    FROM sensor_readings
    WHERE drain_id = $1
    ORDER BY recorded_at DESC, id DESC
    LIMIT $2
    `,
    [drainId, limit]
  );

  // Reverse to chronological (oldest first)
  return result.rows.map((row) => toFiniteNumber(row.water_level)).reverse();
}

async function recordReading(sensorId, drainId, reading) {
  const result = await pool.query(
    `
    INSERT INTO sensor_readings (sensor_id, drain_id, water_level, gas_level, temperature, recorded_at)
    VALUES ($1, $2, $3, $4, $5, COALESCE($6, CURRENT_TIMESTAMP))
    RETURNING id
    `,
    [
      sensorId,
      drainId,
      normalizeWater(reading.water_level),
      normalizeGas(reading.gas_level),
      toFiniteNumber(reading.temperature).toFixed(2),
      reading.timestamp || null
    ]
  );

  // Retention: keep only the newest READINGS_RETENTION rows per drain
  await pool.query(
    `
    DELETE FROM sensor_readings
    WHERE drain_id = $1
      AND id NOT IN (
        SELECT id
        FROM sensor_readings
        WHERE drain_id = $1
        ORDER BY recorded_at DESC, id DESC
        LIMIT $2
      )
    `,
    [drainId, READINGS_RETENTION]
  );

  return result.rows[0].id;
}

// --------------------------------------------------
// Risk-driven early warning alerts
//
// Uses the existing alerts table + Flood Risk alert_type so the
// existing alert workflow (list, resolve, robot completion, live
// loop) keeps working untouched.
//
// Deduplication: only one Open 'Flood Risk' alert per drain.
// Severity may only be upgraded (never lowered here); a drain
// returning to Normal closes the alert via the existing recovery
// path in the simulator / MQTT service / mission engine.
// --------------------------------------------------

async function ensureRiskAlert({ drainId, location, severity, message }) {
  const existing = await pool.query(
    `
    SELECT id, severity
    FROM alerts
    WHERE drain_id = $1
      AND alert_status = 'Open'
      AND alert_type = 'Flood Risk'
    ORDER BY id ASC
    LIMIT 1
    `,
    [drainId]
  );

  if (existing.rows.length === 0) {
    const inserted = await pool.query(
      `
      INSERT INTO alerts (drain_id, alert_type, message, severity, alert_status)
      VALUES ($1, 'Flood Risk', $2, $3, 'Open')
      RETURNING id
      `,
      [drainId, message, severity]
    );

    console.log(`🚨 Risk alert created for ${location} (${severity})`);
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

    console.log(`🚨 Risk alert upgraded to Critical for ${location}`);
    return { action: "upgraded", id: current.id };
  }

  return { action: "kept", id: current.id };
}

// --------------------------------------------------
// Per-drain detail used by REST + dashboard
// --------------------------------------------------

async function buildDrainRiskDetail(drainId) {
  const drainResult = await pool.query(
    `
    SELECT d.id, d.zone_name, d.location,
           s.id AS sensor_id, s.water_level, s.gas_level, s.temperature, s.recorded_at
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

  if (row.sensor_id === null) {
    return null;
  }

  const history = await getWaterHistory(drainId, HISTORY_WINDOW);
  const thresholds = await getRiskThresholds();

  const risk = calculateFloodRisk({
    water_level: row.water_level,
    gas_level: row.gas_level,
    temperature: row.temperature,
    history,
    thresholds
  });

  // Additive sensor-health/anomaly context (Update #21). Best-effort:
  // a failure or a drain without sensor data degrades to null and
  // never changes the risk result above.
  let sensorIntelligence = null;
  try {
    sensorIntelligence = await sensorIntelligenceService.getSensorContextCached(drainId);
  } catch (sensorErr) {
    sensorIntelligence = null;
  }

  return {
    drainId: Number(row.id),
    sensorId: Number(row.sensor_id),
    zone: row.zone_name,
    location: row.location,
    waterLevel: Number(row.water_level),
    gasLevel: Number(row.gas_level),
    temperature: Number(row.temperature),
    timestamp: row.recorded_at,
    ...risk,
    sensorIntelligence
  };
}

// --------------------------------------------------
// Aggregate summary (dashboard + analytics)
// --------------------------------------------------

async function getRiskSummary({ force = false } = {}) {
  if (!force && summaryCache.data && Date.now() - summaryCache.at < SUMMARY_CACHE_TTL_MS) {
    return summaryCache.data;
  }

  const drains = await pool.query(`
    SELECT d.id AS drain_id, d.zone_name, d.location,
           s.water_level, s.gas_level, s.temperature
    FROM drains d
    LEFT JOIN sensors s
      ON s.drain_id = d.id
    ORDER BY d.id ASC
  `);

  const thresholds = await getRiskThresholds();

  const entries = [];

  for (const drain of drains.rows) {
    if (drain.water_level === null) {
      continue;
    }

    const history = await getWaterHistory(drain.drain_id, HISTORY_WINDOW);

    const risk = calculateFloodRisk({
      water_level: drain.water_level,
      gas_level: drain.gas_level,
      temperature: drain.temperature,
      history,
      thresholds
    });

    entries.push({
      drainId: Number(drain.drain_id),
      zone: drain.zone_name,
      location: drain.location,
      riskScore: risk.riskScore,
      riskLevel: risk.riskLevel
    });
  }

  entries.sort((a, b) => b.riskScore - a.riskScore);

  const counts = {
    low: 0,
    moderate: 0,
    high: 0,
    critical: 0
  };

  let totalScore = 0;

  entries.forEach((entry) => {
    totalScore += entry.riskScore;
    counts[entry.riskLevel.toLowerCase()] += 1;
  });

  const summary = {
    totalDrains: entries.length,
    counts,
    distribution: Object.entries(counts).map(([level, count]) => ({
      level: level.toUpperCase(),
      count
    })),
    averageRiskScore: entries.length > 0 ? Math.round(totalScore / entries.length) : 0,
    drains: entries,
    topRisk: entries.length > 0 ? entries[0] : null
  };

  summaryCache = { at: Date.now(), data: summary };

  return summary;
}

function flushRiskSummaryCache() {
  summaryCache = { at: 0, data: null };
}

// --------------------------------------------------
// Exports
// --------------------------------------------------

module.exports = {
  WEIGHTS,
  DEFAULT_RISK_THRESHOLDS,
  TEMP_COMFORT,
  TEMP_EXTREME,
  TREND_STABLE_BASE,
  TREND_RATE,
  HISTORY_WINDOW,
  READINGS_RETENTION,
  clamp,
  normalizeWater,
  normalizeGas,
  normalizeTemperature,
  trendScore,
  trendLabel,
  riskLevelFromScore,
  calculateFloodRisk,
  getRiskThresholds,
  getWaterHistory,
  recordReading,
  ensureRiskAlert,
  buildDrainRiskDetail,
  getRiskSummary,
  flushRiskSummaryCache
};