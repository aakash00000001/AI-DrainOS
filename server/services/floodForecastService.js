// ============================================================
// AI-DrainOS Predictive Flood Forecasting Service
//
// Extends the Flood Risk Intelligence engine from CURRENT RISK
// to PREDICTED FUTURE RISK (15 / 30 / 60 minute horizons) using
// a transparent, explainable statistical baseline method:
//
//   "Explainable Baseline Forecast"
//
//   - water-level trend is fit with a time-aware simple linear
//     regression over the most recent bounded historical
//     readings (per-minute rate of change)
//   - each horizon projects: predictedWater = currentWater +
//     trendPerMinute * forecastMinutes (clamped to 0-100)
//   - the predicted risk score / level for each horizon is
//     NOT a second formula - it reuses the existing flood risk
//     engine (floodRiskService.calculateFloodRisk) by feeding it
//     the predicted water level + current gas/temperature + the
//     recent history (so the future trend is included).
//
// MODEL LIMITATION (documented, do not remove):
// This is an ENGINEERING/DEMO forecasting layer. It is NOT a
// scientifically validated flood forecasting model and it does
// NOT report confidence values. It is intentionally structured
// behind this service so a real trained model can be swapped in
// later without rewriting the API or the frontend.
// ============================================================

const pool = require("../config/db");
const floodRisk = require("./floodRiskService");

// --------------------------------------------------
// Configuration (single location)
// --------------------------------------------------

const METHOD_NAME = "Explainable Baseline Forecast";
const MODEL_DISCLAIMER =
  "Engineering/demo forecast - not a scientifically validated flood forecasting model.";

// Bounded number of historical readings loaded per drain.
const FORECAST_READINGS_LIMIT = 30;

// Regression fit window (most recent points only).
const TREND_REGRESSION_MAX_POINTS = 15;

// Forecast horizons in minutes.
const FORECAST_HORIZONS = [15, 30, 60];

// Trend-direction thresholds on the per-minute water slope.
// Engineering/demo calibration, documented in docs/forecasting.md.
const TREND_DIRECTION_THRESHOLDS = {
  rapidRise: 0.5,
  rise: 0.15,
  rapidFall: -0.5,
  fall: -0.15
};

// Cache for the aggregate forecast summary (dashboard + analytics).
const SUMMARY_CACHE_TTL_MS = 5000;
let summaryCache = { at: 0, data: null };

// --------------------------------------------------
// Low-level helpers
// --------------------------------------------------

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// --------------------------------------------------
// Time-series cleaning
//
// Converts raw DB rows (water_level + recorded_at) into a
// sorted, ascending, deduplicated time series:
// [{ water, timeMin }] where timeMin is unix time in minutes.
//
// Handles safely: null rows, null / invalid timestamps, null /
// out-of-range water values and duplicate timestamps (the first
// occurrence wins).
// --------------------------------------------------

function cleanTimeSeries(rows) {
  if (!Array.isArray(rows)) {
    return [];
  }

  const seen = new Set();
  const points = [];

  for (const row of rows) {
    if (!row) continue;

    if (
      row.water_level === null ||
      row.water_level === undefined ||
      row.recorded_at === null ||
      row.recorded_at === undefined
    ) {
      continue;
    }

    const water = Number(row.water_level);
    const time = new Date(row.recorded_at).getTime();

    if (!Number.isFinite(water) || water < 0 || water > 100) continue;
    if (Number.isNaN(time)) continue;

    // Duplicate timestamps -> keep the first observation only.
    if (seen.has(time)) continue;
    seen.add(time);

    points.push({ water, timeMin: time / 60000 });
  }

  points.sort((a, b) => a.timeMin - b.timeMin);

  return points;
}

// --------------------------------------------------
// Trend fit (time-aware)
//
// Prefers a simple linear regression (y = water %, x = time in
// minutes) over the most recent TREND_REGRESSION_MAX_POINTS
// points. Falls back to a two point slope when only two distinct
// timestamps exist, and to a flat slope (0) when the x-range is
// empty/zero (e.g. all readings share a timestamp).
// --------------------------------------------------

function fitSlope(points) {
  if (!Array.isArray(points) || points.length < 2) {
    return { slopePerMinute: 0, pointsUsed: points ? points.length : 0, fit: "insufficient" };
  }

  const use = points.slice(-TREND_REGRESSION_MAX_POINTS);
  const base = use[0].timeMin;

  const times = use.map((p) => p.timeMin - base);
  const values = use.map((p) => p.water);

  const n = times.length;
  const meanT = times.reduce((sum, v) => sum + v, 0) / n;
  const meanV = values.reduce((sum, v) => sum + v, 0) / n;

  let numerator = 0;
  let denominator = 0;

  for (let i = 0; i < n; i++) {
    numerator += (times[i] - meanT) * (values[i] - meanV);
    denominator += (times[i] - meanT) * (times[i] - meanT);
  }

  let slope;
  let fit;

  if (denominator > 1e-9) {
    slope = numerator / denominator;
    fit = "linear_regression";
  } else {
    // No time spread -> cannot fit a slope over time.
    slope = 0;
    fit = "flat";
  }

  if (points.length === 2) {
    const dt = points[1].timeMin - points[0].timeMin;
    slope = dt > 0 ? (points[1].water - points[0].water) / dt : 0;
    fit = "two_point";
  }

  return {
    slopePerMinute: Number(slope.toFixed(4)),
    pointsUsed: use.length,
    fit
  };
}

// --------------------------------------------------
// Trend direction (per-minute water slope)
// --------------------------------------------------

function trendDirectionFromSlope(slope) {
  const t = TREND_DIRECTION_THRESHOLDS;

  if (slope >= t.rapidRise) return "RAPIDLY_RISING";
  if (slope >= t.rise) return "RISING";
  if (slope > t.fall) return "STABLE";
  if (slope > t.rapidFall) return "FALLING";
  return "RAPIDLY_FALLING";
}

// --------------------------------------------------
// Water projection (bounded)
// --------------------------------------------------

function projectWater(currentWater, slopePerMinute, minutes) {
  const projected = currentWater + slopePerMinute * minutes;
  return Math.round(clamp(projected, 0, 100));
}

// --------------------------------------------------
// Pure forecast builder (deterministic, testable)
//
// water/gas/temp: current sensor values.
// series: raw readings [{ water_level, recorded_at }].
// thresholds: { moderate, high, critical } (or undefined for the
// flood risk engine defaults).
// --------------------------------------------------

function buildForecast({ water, gas, temp, series, thresholds }) {
  const points = cleanTimeSeries(series);

  if (points.length < 2) {
    return {
      status: "insufficient_history",
      method: METHOD_NAME,
      trendDirection: null,
      waterTrendPerMinute: null,
      model: null,
      horizons: [],
      worst: null,
      reason: "Need at least 2 distinct timestamped readings to fit a trend"
    };
  }

  const fit = fitSlope(points);
  const trendDirection = trendDirectionFromSlope(fit.slopePerMinute);

  const model = {
    method: METHOD_NAME,
    fit: fit.fit,
    pointsUsed: fit.pointsUsed,
    readingsAvailable: points.length,
    waterTrendPerMinute: fit.slopePerMinute,
    trendDirection
  };

  const recentHistory = points
    .slice(-floodRisk.HISTORY_WINDOW)
    .map((p) => p.water);

  const horizons = FORECAST_HORIZONS.map((minutes) => {
    const predictedWaterLevel = projectWater(
      water,
      fit.slopePerMinute,
      minutes
    );

    // Reuse the EXISTING flood risk engine for the predicted
    // risk - no second formula. The predicted water level is fed
    // in as the "current" reading and the recent actual history
    // provides the trend component.
    const risk = floodRisk.calculateFloodRisk({
      water_level: predictedWaterLevel,
      gas_level: gas,
      temperature: temp,
      history: recentHistory,
      thresholds
    });

    return {
      forecastMinutes: minutes,
      predictedWaterLevel,
      predictedRiskScore: risk.riskScore,
      predictedRiskLevel: risk.riskLevel,
      trendDirection
    };
  });

  const worst = horizons
    .slice()
    .sort((a, b) => b.predictedRiskScore - a.predictedRiskScore)[0];

  return {
    status: "ready",
    method: METHOD_NAME,
    trendDirection,
    waterTrendPerMinute: fit.slopePerMinute,
    model,
    horizons,
    worst,
    disclaimer: MODEL_DISCLAIMER
  };
}

// --------------------------------------------------
// Historical readings (parameterized SQL only, bounded)
// --------------------------------------------------

async function getSeries(drainId, limit = FORECAST_READINGS_LIMIT) {
  const result = await pool.query(
    `
    SELECT water_level, recorded_at
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
// Per-drain forecast (REST + MQTT + dashboard)
//
// Reuses floodRisk.buildDrainRiskDetail for the current risk
// state so the CURRENT risk always stays identical between the
// risk API and the forecast API.
// --------------------------------------------------

async function getDrainForecast(drainId) {
  const detail = await floodRisk.buildDrainRiskDetail(drainId);

  if (!detail) {
    return null;
  }

  const series = await getSeries(drainId, FORECAST_READINGS_LIMIT);
  const thresholds = await floodRisk.getRiskThresholds();

  const forecast = buildForecast({
    water: detail.waterLevel,
    gas: detail.gasLevel,
    temp: detail.temperature,
    series,
    thresholds
  });

  return {
    drainId: Number(detail.drainId),
    sensorId: Number(detail.sensorId),
    zone: detail.zone,
    location: detail.location,
    currentWaterLevel: Number(detail.waterLevel),
    currentRiskScore: Number(detail.riskScore),
    currentRiskLevel: detail.riskLevel,
    timestamp: detail.timestamp,
    ...forecast,
    // Additive sensor-quality context (Update #21). Carried over from
    // the flood-risk detail (which is itself best-effort + TTL-cached);
    // never alters the forecast model above and degrades to null.
    sensorIntelligence: detail.sensorIntelligence || null,
    // Additive weather + weather-flood correlation context (Update
    // #23). Carried over from the flood-risk detail as descriptive
    // context only; never alters the forecast model above.
    weatherContext: detail.weatherContext || null,
    weatherCorrelation: detail.weatherCorrelation || null
  };
}

// --------------------------------------------------
// Forecast early-warning alerts
//
// Uses the existing alerts table with a dedicated
// 'Flood Forecast' alert_type so the existing alert workflow
// (list, resolve, robot completion, live loop) keeps working.
//
// Deduplication: only one Open 'Flood Forecast' alert per drain.
// Severity may only be upgraded here; when the prediction drops
// below HIGH the alert is resolved via resolveForecastAlerts.
// --------------------------------------------------

async function ensureForecastAlert({ drainId, location, severity, message }) {
  const existing = await pool.query(
    `
    SELECT id, severity
    FROM alerts
    WHERE drain_id = $1
      AND alert_status = 'Open'
      AND alert_type = 'Flood Forecast'
    ORDER BY id ASC
    LIMIT 1
    `,
    [drainId]
  );

  if (existing.rows.length === 0) {
    const inserted = await pool.query(
      `
      INSERT INTO alerts (drain_id, alert_type, message, severity, alert_status)
      VALUES ($1, 'Flood Forecast', $2, $3, 'Open')
      RETURNING id
      `,
      [drainId, message, severity]
    );

    console.log(`🔮 Forecast alert created for ${location} (${severity})`);
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

    console.log(`🔮 Forecast alert upgraded to Critical for ${location}`);
    return { action: "upgraded", id: current.id };
  }

  return { action: "kept", id: current.id };
}

async function resolveForecastAlerts(drainId) {
  const resolved = await pool.query(
    `
    UPDATE alerts
    SET alert_status = 'Resolved'
    WHERE drain_id = $1
      AND alert_status = 'Open'
      AND alert_type = 'Flood Forecast'
    RETURNING id
    `,
    [drainId]
  );

  if (resolved.rows.length > 0) {
    console.log(`✅ Forecast alerts resolved for drain ${drainId}`);
  }

  return resolved.rows.length;
}

// --------------------------------------------------
// Aggregate forecast summary (dashboard + analytics)
// --------------------------------------------------

async function getForecastSummary({ force = false } = {}) {
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

  const thresholds = await floodRisk.getRiskThresholds();

  const entries = [];

  for (const drain of drains.rows) {
    if (drain.water_level === null) {
      continue;
    }

    const series = await getSeries(drain.drain_id, FORECAST_READINGS_LIMIT);

    const forecast = buildForecast({
      water: drain.water_level,
      gas: drain.gas_level,
      temp: drain.temperature,
      series,
      thresholds
    });

    if (forecast.status !== "ready" || !forecast.worst) {
      continue;
    }

    const currentRisk = floodRisk.calculateFloodRisk({
      water_level: drain.water_level,
      gas_level: drain.gas_level,
      temperature: drain.temperature,
      thresholds
    });

    entries.push({
      drainId: Number(drain.drain_id),
      zone: drain.zone_name,
      location: drain.location,
      currentRiskScore: currentRisk.riskScore,
      currentRiskLevel: currentRisk.riskLevel,
      worstRiskScore: forecast.worst.predictedRiskScore,
      worstRiskLevel: forecast.worst.predictedRiskLevel,
      worstMinutes: forecast.worst.forecastMinutes,
      trendDirection: forecast.trendDirection
    });
  }

  entries.sort((a, b) => b.worstRiskScore - a.worstRiskScore);

  const counts = {
    low: 0,
    moderate: 0,
    high: 0,
    critical: 0
  };

  let totalScore = 0;

  entries.forEach((entry) => {
    totalScore += entry.worstRiskScore;
    counts[entry.worstRiskLevel.toLowerCase()] += 1;
  });

  const summary = {
    totalDrains: entries.length,
    counts,
    distribution: Object.entries(counts).map(([level, count]) => ({
      level: level.toUpperCase(),
      count
    })),
    averagePredictedRiskScore: entries.length > 0 ? Math.round(totalScore / entries.length) : 0,
    drains: entries,
    topForecast: entries.length > 0 ? entries[0] : null
  };

  summaryCache = { at: Date.now(), data: summary };

  return summary;
}

function flushForecastSummaryCache() {
  summaryCache = { at: 0, data: null };
}

// --------------------------------------------------
// Exports
// --------------------------------------------------

module.exports = {
  METHOD_NAME,
  MODEL_DISCLAIMER,
  FORECAST_READINGS_LIMIT,
  TREND_REGRESSION_MAX_POINTS,
  FORECAST_HORIZONS,
  TREND_DIRECTION_THRESHOLDS,
  clamp,
  cleanTimeSeries,
  fitSlope,
  trendDirectionFromSlope,
  projectWater,
  buildForecast,
  getSeries,
  getDrainForecast,
  ensureForecastAlert,
  resolveForecastAlerts,
  getForecastSummary,
  flushForecastSummaryCache
};