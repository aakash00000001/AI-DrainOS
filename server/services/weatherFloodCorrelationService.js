// ============================================================
// AI-DrainOS Weather + Flood Correlation Intelligence
// (Update #23)
//
// Additive intelligence layer that measures the linear association
// between REAL weather observations (OpenWeatherMap, metric units,
// city = WEATHER_CITY || "Madurai") and REAL recorded sensor
// readings (water_level) in the existing sensor_readings table.
//
// Design rules:
//  * Data is never fabricated. Weather snapshots are stored as they
//    are fetched (throttled, forward-only) in the new
//    weather_observations table and are NEVER backfilled or seeded.
//    A fresh install reports honest WEATHER_UNAVAILABLE states until
//    real observations accumulate. rain_1h / rain_3h are only ever
//    0 mm ("dry") when the payload did not report rain.
//  * Correlation is a descriptive Pearson coefficient over aligned
//    (timestamp-matched) pairs within a bounded window. It NEVER
//    claims causation - every result carries a non-causal disclaimer
//    and wording.
//  * The layer is strictly ADDITIVE: it never rewrites or replaces
//    the existing flood risk / forecast / maintenance / decision
//    formulas, never touches missionEngine.js and never dispatches
//    robots. No incidents are ever opened from a correlation.
//  * Historical flood risk and forecast outputs are NOT persisted in
//    this system, so weather-vs-risk and weather-vs-forecast
//    correlation are honest NOT_AVAILABLE states (never recomputed,
//    never invented).
//  * Live `weatherFloodCorrelationUpdate` events use the shared
//    socketHub and are signature-guarded + throttle-guarded so the
//    event is never emitted on every 5 s tick.
// ============================================================

const axios = require("axios");
const pool = require("../config/db");
const socketHub = require("./socketHub");

// ------------------------------------------------------------
// Constants
// ------------------------------------------------------------

const DEFAULT_WINDOW_HOURS = 24;
const MAX_WINDOW_HOURS = 168;
const DEFAULT_SIGNAL = "rainfall_water_level";

// Minimum aligned pairs required before a correlation is reported.
const MIN_PAIRS = 20;

// Maximum timestamp gap between a weather observation and the sensor
// reading it is paired with.
const TIME_TOLERANCE_MINUTES = 30;

// Optional rainfall-lag analysis increments (minutes).
const LAG_OPTIONS = [0, 15, 30, 60];

// Timestamp-alignment trend buckets.
const BUCKET_COUNT = 4;
const MIN_PAIRS_PER_BUCKET = 10;
const TREND_DELTA = 0.05;

// Bounded weather refresh: fetch a new snapshot at most every
// WEATHER_REFRESH_INTERVAL_MS, and only re-check freshness in the
// hot path every WEATHER_CHECK_INTERVAL_MS.
const WEATHER_REFRESH_INTERVAL_MS = 10 * 60 * 1000;
const WEATHER_CHECK_INTERVAL_MS = 60 * 1000;

// Min gap between two weatherFloodCorrelationUpdate emissions.
const EMIT_MIN_INTERVAL_MS = 60 * 1000;

// TTL for the cached additive correlation context.
const CONTEXT_CACHE_TTL_MS = 30 * 1000;

const GEN_NO_WEATHER_MSG =
  "No real weather observations have been recorded yet. Keep the weather refresh enabled (OPENWEATHER_API_KEY in server/.env) so real observations can accumulate - this system never invents weather history.";

const CORRELATION_DISCLAIMER =
  "Pearson correlation describes a linear association between recorded weather and recorded sensor readings. It is descriptive only and does not imply causation.";

const STATUS = {
  READY: "READY",
  INSUFFICIENT_DATA: "INSUFFICIENT_DATA",
  WEATHER_UNAVAILABLE: "WEATHER_UNAVAILABLE",
  NOT_AVAILABLE: "NOT_AVAILABLE"
};

const DIRECTION = {
  POSITIVE: "POSITIVE",
  NEGATIVE: "NEGATIVE",
  NONE: "NONE"
};

const STRENGTH_BANDS = [
  { key: "VERY_WEAK", min: 0, max: 0.19, label: "Very weak" },
  { key: "WEAK", min: 0.2, max: 0.39, label: "Weak" },
  { key: "MODERATE", min: 0.4, max: 0.59, label: "Moderate" },
  { key: "STRONG", min: 0.6, max: 0.79, label: "Strong" },
  { key: "VERY_STRONG", min: 0.8, max: 1, label: "Very strong" }
];

const SIGNAL_DEFINITIONS = [
  {
    key: "rainfall_water_level",
    label: "Rainfall vs Water Level",
    shortLabel: "Rainfall \u00b7 Water",
    description:
      "Linear association between recorded rainfall (mm) and sensor water level (%) in the observation window.",
    weatherMetric: "rainfall",
    weatherLabel: "Rainfall",
    readingMetric: "water_level",
    readingLabel: "Water level",
    unitX: "mm",
    unitY: "%",
    available: true
  },
  {
    key: "humidity_water_level",
    label: "Humidity vs Water Level",
    shortLabel: "Humidity \u00b7 Water",
    description:
      "Linear association between recorded humidity (%) and sensor water level (%) in the observation window.",
    weatherMetric: "humidity",
    weatherLabel: "Humidity",
    readingMetric: "water_level",
    readingLabel: "Water level",
    unitX: "%",
    unitY: "%",
    available: true
  },
  {
    key: "temperature_water_level",
    label: "Temperature vs Water Level",
    shortLabel: "Temp \u00b7 Water",
    description:
      "Linear association between recorded air temperature (°C) and sensor water level (%) in the observation window.",
    weatherMetric: "temperature",
    weatherLabel: "Temperature",
    readingMetric: "water_level",
    readingLabel: "Water level",
    unitX: "\u00b0C",
    unitY: "%",
    available: true
  },
  {
    key: "pressure_water_level",
    label: "Pressure vs Water Level",
    shortLabel: "Pressure \u00b7 Water",
    description:
      "Linear association between recorded air pressure (hPa) and sensor water level (%) in the observation window.",
    weatherMetric: "pressure",
    weatherLabel: "Pressure",
    readingMetric: "water_level",
    readingLabel: "Water level",
    unitX: "hPa",
    unitY: "%",
    available: true
  },
  {
    key: "wind_water_level",
    label: "Wind vs Water Level",
    shortLabel: "Wind \u00b7 Water",
    description:
      "Linear association between recorded wind speed (m/s) and sensor water level (%) in the observation window.",
    weatherMetric: "wind_speed",
    weatherLabel: "Wind speed",
    readingMetric: "water_level",
    readingLabel: "Water level",
    unitX: "m/s",
    unitY: "%",
    available: true
  },
  {
    key: "weather_flood_risk",
    label: "Weather vs Flood Risk",
    shortLabel: "Weather \u00b7 Risk",
    description:
      "Would relate weather to flood risk. The system does not persist historical flood-risk scores, so this association cannot be computed and is reported as NOT_AVAILABLE (never recomputed).",
    weatherMetric: "rainfall",
    weatherLabel: "Weather",
    readingMetric: "water_level",
    readingLabel: "Flood risk",
    unitX: null,
    unitY: null,
    available: false,
    unavailableReason:
      "Historical flood risk scores are not persisted in this system, so a weather-flood-risk correlation cannot be computed from recorded data."
  },
  {
    key: "weather_forecast",
    label: "Weather vs Flood Forecast",
    shortLabel: "Weather \u00b7 Forecast",
    description:
      "Would relate weather to the flood forecast. Forecast outputs are not persisted, so this association is reported as NOT_AVAILABLE (never recomputed).",
    weatherMetric: "rainfall",
    weatherLabel: "Weather",
    readingMetric: "water_level",
    readingLabel: "Forecast risk",
    unitX: null,
    unitY: null,
    available: false,
    unavailableReason:
      "Historical flood forecast outputs are not persisted in this system, so a weather-forecast correlation cannot be computed from recorded data."
  }
];

const SIGNAL_KEYS = SIGNAL_DEFINITIONS.map((d) => d.key);
const WEATHER_SIGNALS = SIGNAL_DEFINITIONS.filter((d) => d.available);

// ------------------------------------------------------------
// Runtime emission state
// ------------------------------------------------------------

let lastFetchAttemptAt = 0;
let lastStalenessCheckAt = 0;
let weatherFetchInFlight = null;
const lastEmitted = { signature: null, at: 0 };
let contextCache = { at: 0, data: null };

// ------------------------------------------------------------
// Pure helpers (exported for tests)
// ------------------------------------------------------------

function clamp(value, min, max) {
  if (!Number.isFinite(Number(value))) return min;
  return Math.min(max, Math.max(min, Number(value)));
}

function round3(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) {
    return null;
  }
  return Math.round(Number(value) * 1000) / 1000;
}

function toFinite(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function pearson(pairs) {
  const n = pairs.length;
  if (n < 2) return null;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumX2 = 0;
  let sumY2 = 0;
  for (const pair of pairs) {
    const x = Number(pair.x);
    const y = Number(pair.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumX2 += x * x;
    sumY2 += y * y;
  }
  const numerator = n * sumXY - sumX * sumY;
  const denomX = n * sumX2 - sumX * sumX;
  const denomY = n * sumY2 - sumY * sumY;
  if (denomX <= 0 || denomY <= 0) return null;
  const denom = Math.sqrt(denomX) * Math.sqrt(denomY);
  if (denom === 0) return null;
  const r = numerator / denom;
  return clamp(r, -1, 1);
}

function directionFromR(r, epsilon = 0.05) {
  if (r === null || r === undefined || !Number.isFinite(Number(r))) {
    return DIRECTION.NONE;
  }
  const value = Number(r);
  if (value > epsilon) return DIRECTION.POSITIVE;
  if (value < -epsilon) return DIRECTION.NEGATIVE;
  return DIRECTION.NONE;
}

function strengthFromR(absR) {
  const r = Number(absR) === Number(absR) ? Math.abs(Number(absR)) : 0;
  for (const band of STRENGTH_BANDS) {
    if (r >= band.min && r <= band.max) {
      return { key: band.key, label: band.label };
    }
  }
  if (r > 1) return { key: "VERY_STRONG", label: "Very strong" };
  return STRENGTH_BANDS[0];
}

function parseWindowHours(value) {
  if (value === null || value === undefined || value === "") {
    return DEFAULT_WINDOW_HOURS;
  }
  const v = Number(value);
  if (!Number.isFinite(v)) return DEFAULT_WINDOW_HOURS;
  return Math.max(1, Math.min(MAX_WINDOW_HOURS, Math.round(v)));
}

function isMissingTableError(err) {
  if (!err) return false;
  if (err.code === "42P01") return true;
  return /relation ".*" does not exist/.test(String(err.message || ""));
}

function buildSamples({
  count,
  weatherUsed,
  sensorUsed,
  weatherTotal,
  sensorTotal,
  windowHours,
  lagMinutes,
  toleranceMinutes
}) {
  return {
    window_hours: windowHours,
    lag_minutes: lagMinutes || 0,
    tolerance_minutes: toleranceMinutes,
    matched_pairs: count,
    weather_samples: weatherUsed,
    sensor_samples: sensorUsed,
    weather_total: weatherTotal,
    sensor_total: sensorTotal,
    missing_weather: Math.max(0, weatherTotal - weatherUsed),
    timestamp_alignment:
      weatherTotal > 0
        ? Math.round((weatherUsed / weatherTotal) * 100) / 100
        : 0
  };
}

function buildWording({ signalDef, direction, strength, matchedPairs }) {
  if (direction === DIRECTION.NONE) {
    return `Across ${matchedPairs} aligned observation pair(s), ${signalDef.weatherLabel.toLowerCase()} shows no meaningful linear relationship with ${signalDef.readingLabel.toLowerCase()} in this window. Descriptive association only; never a causal claim.`;
  }
  const tendency =
    direction === DIRECTION.POSITIVE ? "higher" : "lower";
  return `Recorded ${signalDef.weatherLabel.toLowerCase()} tended to coincide with ${tendency} ${signalDef.readingLabel.toLowerCase()} across ${matchedPairs} aligned pair(s) (${strength.label.toLowerCase()} ${direction.toLowerCase()} relationship). Descriptive association only; never a causal claim.`;
}

function nearestReadingIndex(readings, targetMs) {
  let lo = 0;
  let hi = readings.length - 1;
  let best = -1;
  let bestDelta = Number.POSITIVE_INFINITY;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const rt = new Date(readings[mid].recorded_at).getTime();
    const d = Math.abs(rt - targetMs);
    if (d < bestDelta) {
      bestDelta = d;
      best = mid;
    }
    if (rt < targetMs) {
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

// Aligns each weather observation to the single sensor reading
// closest in time, within the tolerance, honoring an optional lag
// (reading observed lagMinutes AFTER the weather observation).
// Deterministic: ties are resolved by position in the sorted list.
function alignToNearest({ weather, readings, toleranceMinutes, lagMinutes = 0 }) {
  if (!weather || weather.length === 0 || !readings || readings.length === 0) {
    return [];
  }
  const toleranceMs =
    (Number(toleranceMinutes) || TIME_TOLERANCE_MINUTES) * 60 * 1000;
  const lagMs = (Number(lagMinutes) || 0) * 60 * 1000;
  const aligned = [];
  for (let i = 0; i < weather.length; i += 1) {
    const obs = weather[i];
    const targetMs = new Date(obs.observed_at).getTime() + lagMs;
    const idx = nearestReadingIndex(readings, targetMs);
    if (idx === -1) continue;
    const reading = readings[idx];
    const deltaMs = Math.abs(new Date(reading.recorded_at).getTime() - targetMs);
    if (deltaMs > toleranceMs) continue;
    aligned.push({ obsIndex: i, obs, reading, deltaMs });
  }
  return aligned;
}

function extractPairs(aligned, signalDef) {
  const pairs = [];
  for (const a of aligned) {
    const x = toFinite(a.obs[signalDef.weatherMetric]);
    const y = toFinite(a.reading[signalDef.readingMetric]);
    if (x === null || y === null) continue;
    pairs.push({ x, y });
  }
  return pairs;
}

function buildSignature(summary) {
  const lastObs = summary.latest_weather
    ? new Date(summary.latest_weather.observed_at).getTime()
    : "none";
  const signals = (summary.signals || [])
    .map(
      (s) =>
        `${s.signal}:${s.status}:${
          s.r === null || s.r === undefined ? "null" : s.r.toFixed(4)
        }:${s.direction || ""}`
    )
    .join("|");
  return `${summary.status}|${lastObs}|${signals}`;
}

// ------------------------------------------------------------
// Data access (bounded, parameterized, read-only)
// ------------------------------------------------------------

async function loadWeather(windowHours) {
  try {
    const res = await pool.query(
      `
      SELECT
        id,
        observed_at,
        temperature,
        humidity,
        pressure,
        wind_speed,
        weather_main,
        weather_description,
        rain_1h,
        rain_3h,
        COALESCE(rain_1h, rain_3h, 0) AS rainfall
      FROM weather_observations
      WHERE observed_at >= NOW() - make_interval(hours => $1)
      ORDER BY observed_at ASC
      `,
      [windowHours]
    );
    return res.rows;
  } catch (err) {
    if (isMissingTableError(err)) {
      console.log("⚠️ weather_observations table missing (run migration 007): treating as no weather data");
      return [];
    }
    throw err;
  }
}

async function loadReadings({ drainId = null, windowHours }) {
  const params = [windowHours];
  let where = "recorded_at >= NOW() - make_interval(hours => $1)";
  if (drainId) {
    params.push(drainId);
    where += " AND drain_id = $2";
  }
  const res = await pool.query(
    `
    SELECT id, drain_id, water_level, recorded_at
    FROM sensor_readings
    WHERE ${where}
    ORDER BY recorded_at ASC
    `,
    params
  );
  return res.rows;
}

async function getLatestWeatherObservation() {
  try {
    const res = await pool.query(
      `
      SELECT
        id,
        observed_at,
        temperature,
        humidity,
        pressure,
        wind_speed,
        weather_main,
        weather_description,
        rain_1h,
        rain_3h,
        COALESCE(rain_1h, rain_3h, 0) AS rainfall,
        source,
        created_at
      FROM weather_observations
      ORDER BY observed_at DESC
      LIMIT 1
      `,
      []
    );
    if (res.rows.length === 0) return null;
    const o = res.rows[0];
    return {
      observed_at: o.observed_at,
      temperature: numberOrNull(o.temperature),
      humidity: numberOrNull(o.humidity),
      pressure: numberOrNull(o.pressure),
      wind_speed: numberOrNull(o.wind_speed),
      weather_main: o.weather_main || null,
      weather_description: o.weather_description || null,
      rainfall_mm: numberOrNull(o.rainfall) || 0,
      is_precipitating: Boolean(
        o.weather_main &&
          /rain|thunder|shower|drizzle/i.test(String(o.weather_main))
      ),
      source: o.source || "OPENWEATHERMAP",
      created_at: o.created_at
    };
  } catch (err) {
    if (isMissingTableError(err)) return null;
    throw err;
  }
}

async function hasRecentObservation() {
  try {
    const res = await pool.query(
      `
      SELECT 1
      FROM weather_observations
      WHERE observed_at >= NOW() - make_interval(mins => $1)
      LIMIT 1
      `,
      [Math.ceil(WEATHER_REFRESH_INTERVAL_MS / 60000)]
    );
    return res.rows.length > 0;
  } catch (err) {
    if (isMissingTableError(err)) return false;
    throw err;
  }
}

// ------------------------------------------------------------
// Weather refresh (throttled, bounded, forward-only)
// ------------------------------------------------------------

async function fetchWeatherSnapshot() {
  const apiKey = process.env.OPENWEATHER_API_KEY;
  if (!apiKey) return { fetched: false, reason: "NO_API_KEY" };
  if (process.env.WEATHER_FETCH_DISABLED === "true") {
    return { fetched: false, reason: "DISABLED" };
  }
  const city = process.env.WEATHER_CITY || "Madurai";

  try {
    const resp = await axios.get(
      "https://api.openweathermap.org/data/2.5/weather",
      {
        params: { q: city, units: "metric", appid: apiKey },
        timeout: 10000
      }
    );
    const d = resp.data;
    if (!d || !d.main || d.main.temp === undefined || d.dt === undefined) {
      return { fetched: false, reason: "MALFORMED_RESPONSE" };
    }
    await pool.query(
      `
      INSERT INTO weather_observations
        (observed_at, temperature, humidity, pressure, wind_speed,
         weather_main, weather_description, rain_1h, rain_3h, source)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'OPENWEATHERMAP')
      ON CONFLICT (observed_at) DO NOTHING
      `,
      [
        new Date(d.dt * 1000).toISOString(),
        numberOrNull(d.main.temp),
        numberOrNull(d.main.humidity),
        numberOrNull(d.main.pressure),
        d.wind ? numberOrNull(d.wind.speed) : null,
        d.weather && d.weather[0] ? d.weather[0].main : null,
        d.weather && d.weather[0] ? d.weather[0].description : null,
        d.rain ? numberOrNull(d.rain["1h"]) : null,
        d.rain ? numberOrNull(d.rain["3h"]) : null
      ]
    );
    return { fetched: true };
  } catch (err) {
    if (err && err.response && err.response.status === 401) {
      return { fetched: false, reason: "INVALID_API_KEY" };
    }
    if (err && err.response && err.response.status) {
      return { fetched: false, reason: `HTTP_${err.response.status}` };
    }
    return { fetched: false, reason: "FETCH_FAILED" };
  }
}

async function refreshWeatherIfStale({ force = false } = {}) {
  if (force) {
    if (weatherFetchInFlight) {
      return { refreshed: false, reason: "IN_FLIGHT" };
    }
    lastFetchAttemptAt = Date.now();
    weatherFetchInFlight = fetchWeatherSnapshot().finally(() => {
      weatherFetchInFlight = null;
    });
    const result = await weatherFetchInFlight;
    return { refreshed: result.fetched, reason: result.reason };
  }

  const now = Date.now();

  // Bounded: only re-check freshness at most every minute.
  if (now - lastStalenessCheckAt < WEATHER_CHECK_INTERVAL_MS) {
    return { refreshed: false, reason: "CACHED_FRESHNESS" };
  }
  lastStalenessCheckAt = now;

  const fresh = await hasRecentObservation();
  if (fresh) return { refreshed: false, reason: "FRESH_OBSERVATION" };
  if (weatherFetchInFlight) return { refreshed: false, reason: "IN_FLIGHT" };
  if (now - lastFetchAttemptAt < WEATHER_REFRESH_INTERVAL_MS) {
    return { refreshed: false, reason: "THROTTLED" };
  }

  lastFetchAttemptAt = now;
  weatherFetchInFlight = fetchWeatherSnapshot().finally(() => {
    weatherFetchInFlight = null;
  });
  const result = await weatherFetchInFlight;
  return { refreshed: result.fetched, reason: result.reason };
}

// ------------------------------------------------------------
// Context (additive consumption by decision / risk / forecast)
// ------------------------------------------------------------

async function getWeatherContext() {
  const latest = await getLatestWeatherObservation();
  return {
    status: latest ? STATUS.READY : STATUS.WEATHER_UNAVAILABLE,
    latest,
    age_minutes:
      latest ? Math.max(0, Math.round((Date.now() - new Date(latest.observed_at).getTime()) / 60000)) : null,
    service: {
      configured: Boolean(process.env.OPENWEATHER_API_KEY),
      refresh_enabled: process.env.WEATHER_FETCH_DISABLED !== "true",
      city: process.env.WEATHER_CITY || "Madurai"
    },
    message: latest ? null : GEN_NO_WEATHER_MSG,
    disclaimer: CORRELATION_DISCLAIMER
  };
}

// Additive context consumed by the existing decision / flood-risk /
// forecast engines (Update #23). Cached so the hot paths never
// re-query it on every reading; a failure degrades to null at the
// caller. Never changes the underlying formulas.
async function getWeatherCorrelationContext({
  windowHours = DEFAULT_WINDOW_HOURS
} = {}) {
  const now = Date.now();
  if (contextCache.data && now - contextCache.at < CONTEXT_CACHE_TTL_MS) {
    return contextCache.data;
  }
  const summary = await getCorrelationSummary({ windowHours });
  const latest = summary.latest_weather;
  const data = {
    weatherContext: {
      status: latest ? STATUS.READY : STATUS.WEATHER_UNAVAILABLE,
      latest,
      age_minutes:
        latest ? Math.max(0, Math.round((Date.now() - new Date(latest.observed_at).getTime()) / 60000)) : null,
      service: {
        configured: Boolean(process.env.OPENWEATHER_API_KEY),
        refresh_enabled: process.env.WEATHER_FETCH_DISABLED !== "true",
        city: process.env.WEATHER_CITY || "Madurai"
      },
      message: summary.message,
      disclaimer: CORRELATION_DISCLAIMER
    },
    weatherCorrelation: {
      status: summary.status,
      signals_ready: summary.signals_ready,
      signals_total: summary.signals_total,
      window_hours: summary.window_hours,
      strongest: summary.strongest,
      signals: summary.signals.map((s) => ({
        signal: s.signal,
        label: s.label,
        shortLabel: s.shortLabel,
        status: s.status,
        r: s.r,
        direction: s.direction,
        strength: s.strength,
        matched_pairs: s.matched_pairs
      }))
    }
  };
  contextCache = { at: now, data };
  return data;
}

// ------------------------------------------------------------
// Correlation computation
// ------------------------------------------------------------

function buildSignalResult({ signalDef, weather, readings, windowHours, lagMinutes, samples }) {
  if (!signalDef.available) {
    return {
      signal: signalDef.key,
      label: signalDef.label,
      shortLabel: signalDef.shortLabel,
      description: signalDef.description,
      units: { x: signalDef.unitX, y: signalDef.unitY },
      status: STATUS.NOT_AVAILABLE,
      message: signalDef.unavailableReason,
      available: false,
      samples: samples || buildSamples({
        count: 0,
        weatherUsed: 0,
        sensorUsed: 0,
        weatherTotal: weather ? weather.length : 0,
        sensorTotal: readings ? readings.length : 0,
        windowHours,
        lagMinutes,
        toleranceMinutes: TIME_TOLERANCE_MINUTES
      }),
      correlation: null,
      wording: null,
      disclaimer: CORRELATION_DISCLAIMER
    };
  }

  const baseSamples = {
    count: 0,
    weatherUsed: 0,
    sensorUsed: 0,
    weatherTotal: weather ? weather.length : 0,
    sensorTotal: readings ? readings.length : 0,
    windowHours,
    lagMinutes,
    toleranceMinutes: TIME_TOLERANCE_MINUTES
  };

  if (!weather || weather.length === 0) {
    return {
      signal: signalDef.key,
      label: signalDef.label,
      shortLabel: signalDef.shortLabel,
      description: signalDef.description,
      units: { x: signalDef.unitX, y: signalDef.unitY },
      status: STATUS.WEATHER_UNAVAILABLE,
      message: GEN_NO_WEATHER_MSG,
      available: true,
      samples: buildSamples(baseSamples),
      correlation: null,
      wording: null,
      disclaimer: CORRELATION_DISCLAIMER
    };
  }

  if (!readings || readings.length === 0) {
    return {
      signal: signalDef.key,
      label: signalDef.label,
      shortLabel: signalDef.shortLabel,
      description: signalDef.description,
      units: { x: signalDef.unitX, y: signalDef.unitY },
      status: STATUS.INSUFFICIENT_DATA,
      message: "No sensor readings were recorded within the window for this scope.",
      available: true,
      samples: buildSamples(baseSamples),
      correlation: null,
      wording: null,
      disclaimer: CORRELATION_DISCLAIMER
    };
  }

  const aligned = alignToNearest({
    weather,
    readings,
    toleranceMinutes: TIME_TOLERANCE_MINUTES,
    lagMinutes
  });

  const weatherUsed = new Set(aligned.map((a) => a.obsIndex)).size;
  const sensorUsed = new Set(aligned.map((a) => a.reading.id)).size;
  const pairs = extractPairs(aligned, signalDef);

  const samplesResult = buildSamples({
    count: pairs.length,
    weatherUsed,
    sensorUsed,
    weatherTotal: weather.length,
    sensorTotal: readings.length,
    windowHours,
    lagMinutes,
    toleranceMinutes: TIME_TOLERANCE_MINUTES
  });

  if (pairs.length < MIN_PAIRS) {
    return {
      signal: signalDef.key,
      label: signalDef.label,
      shortLabel: signalDef.shortLabel,
      description: signalDef.description,
      units: { x: signalDef.unitX, y: signalDef.unitY },
      status: STATUS.INSUFFICIENT_DATA,
      message: `Only ${pairs.length} aligned observation pair(s) were found within the ${windowHours}h window (minimum ${MIN_PAIRS} required).`,
      available: true,
      samples: samplesResult,
      correlation: null,
      wording: null,
      disclaimer: CORRELATION_DISCLAIMER
    };
  }

  let r = pearson(pairs);

  if (r === null) {
    return {
      signal: signalDef.key,
      label: signalDef.label,
      shortLabel: signalDef.shortLabel,
      description: signalDef.description,
      units: { x: signalDef.unitX, y: signalDef.unitY },
      status: STATUS.INSUFFICIENT_DATA,
      message: "The aligned series has zero variance within the window (flat data); a meaningful correlation cannot be computed.",
      available: true,
      samples: samplesResult,
      correlation: null,
      wording: null,
      disclaimer: CORRELATION_DISCLAIMER
    };
  }

  r = round3(r);
  const direction = directionFromR(r);
  const strength = strengthFromR(Math.abs(r));
  const wording = buildWording({
    signalDef,
    direction,
    strength,
    matchedPairs: pairs.length
  });

  return {
    signal: signalDef.key,
    label: signalDef.label,
    shortLabel: signalDef.shortLabel,
    description: signalDef.description,
    units: { x: signalDef.unitX, y: signalDef.unitY },
    status: STATUS.READY,
    message: null,
    available: true,
    samples: samplesResult,
    correlation: {
      r,
      direction,
      strength: strength.key,
      strength_label: strength.label,
      pairs: pairs.length
    },
    wording,
    disclaimer: CORRELATION_DISCLAIMER
  };
}

function compactSignal(sig) {
  return {
    signal: sig.signal,
    label: sig.label,
    shortLabel: sig.shortLabel,
    description: sig.description,
    status: sig.status,
    r: sig.correlation ? sig.correlation.r : null,
    direction: sig.correlation ? sig.correlation.direction : null,
    strength: sig.correlation ? sig.correlation.strength : null,
    matched_pairs: sig.samples ? sig.samples.matched_pairs : 0,
    message: sig.message || null
  };
}

// ------------------------------------------------------------
// Views
// ------------------------------------------------------------

async function getWeatherCorrelation({
  signal = DEFAULT_SIGNAL,
  drainId = null,
  windowHours = DEFAULT_WINDOW_HOURS,
  lagMinutes = 0
} = {}) {
  const def = SIGNAL_DEFINITIONS.find((d) => d.key === signal);
  if (!def) return null;

  const wh = parseWindowHours(windowHours);

  if (drainId) {
    const drainCheck = await pool.query(
      "SELECT 1 FROM drains WHERE id = $1",
      [drainId]
    );
    if (drainCheck.rows.length === 0) return null;
  }

  const weather = await loadWeather(wh);
  const readings = drainId
    ? await loadReadings({ drainId, windowHours: wh })
    : await loadReadings({ windowHours: wh });

  const result = buildSignalResult({
    signalDef: def,
    weather,
    readings,
    windowHours: wh,
    lagMinutes: Number(lagMinutes) || 0
  });

  return {
    ...result,
    drain_id: drainId,
    generated_at: new Date().toISOString()
  };
}

async function getCorrelationSignals({
  windowHours = DEFAULT_WINDOW_HOURS
} = {}) {
  const wh = parseWindowHours(windowHours);
  const weather = await loadWeather(wh);
  const readings = await loadReadings({ windowHours: wh });

  const entries = SIGNAL_DEFINITIONS.map((def) => {
    if (!def.available) {
      return {
        signal: def.key,
        label: def.label,
        shortLabel: def.shortLabel,
        description: def.description,
        units: { x: def.unitX, y: def.unitY },
        available: false,
        status: STATUS.NOT_AVAILABLE,
        message: def.unavailableReason
      };
    }
    const sig = buildSignalResult({
      signalDef: def,
      weather,
      readings,
      windowHours: wh,
      lagMinutes: 0
    });
    return compactSignal(sig);
  });

  return {
    signal_definitions: entries,
    window_hours: wh,
    generated_at: new Date().toISOString(),
    disclaimer: CORRELATION_DISCLAIMER
  };
}

async function getCorrelationSummary({
  windowHours = DEFAULT_WINDOW_HOURS
} = {}) {
  const wh = parseWindowHours(windowHours);
  const weather = await loadWeather(wh);
  const readings = await loadReadings({ windowHours: wh });

  const signals = SIGNAL_DEFINITIONS.map((def) =>
    compactSignal(
      buildSignalResult({
        signalDef: def,
        weather,
        readings,
        windowHours: wh,
        lagMinutes: 0
      })
    )
  );

  const ready = signals.filter((s) => s.status === STATUS.READY);
  let strongest = null;
  if (ready.length > 0) {
    strongest = ready
      .slice()
      .sort(
        (a, b) =>
          Math.abs(b.r) - Math.abs(a.r) || b.matched_pairs - a.matched_pairs
      )[0];
    strongest = {
      signal: strongest.signal,
      label: strongest.label,
      shortLabel: strongest.shortLabel,
      r: strongest.r,
      direction: strongest.direction,
      strength: strongest.strength,
      matched_pairs: strongest.matched_pairs
    };
  }

  const overall =
    weather.length === 0
      ? STATUS.WEATHER_UNAVAILABLE
      : ready.length > 0
        ? STATUS.READY
        : STATUS.INSUFFICIENT_DATA;

  const latest = await getLatestWeatherObservation();

  return {
    status: overall,
    generated_at: new Date().toISOString(),
    window_hours: wh,
    disclaimer: CORRELATION_DISCLAIMER,
    weather_data_quality: {
      status:
        weather.length === 0
          ? "NO_WEATHER_DATA"
          : ready.length > 0
            ? "READY"
            : "INSUFFICIENT_DATA",
      observation_count: weather.length,
      window_hours: wh,
      first_observation_at:
        weather.length > 0 ? weather[0].observed_at : null,
      last_observation_at:
        weather.length > 0 ? weather[weather.length - 1].observed_at : null
    },
    signals_ready: ready.length,
    signals_total: signals.length,
    signals,
    strongest,
    latest_weather: latest,
    message:
      overall === STATUS.WEATHER_UNAVAILABLE
        ? GEN_NO_WEATHER_MSG
        : overall === STATUS.INSUFFICIENT_DATA
          ? "Weather observations exist but fewer than the minimum aligned pairs are available across the window."
          : null
  };
}

async function getCorrelationTrends({
  signal = DEFAULT_SIGNAL,
  drainId = null,
  windowHours = DEFAULT_WINDOW_HOURS,
  lagMinutes = 0
} = {}) {
  const def = SIGNAL_DEFINITIONS.find((d) => d.key === signal);
  if (!def) return null;

  const wh = parseWindowHours(windowHours);
  const lag = Number(lagMinutes) || 0;
  const base = {
    signal: def.key,
    label: def.label,
    drain_id: drainId,
    window_hours: wh,
    lag_minutes: lag,
    generated_at: new Date().toISOString(),
    disclaimer: CORRELATION_DISCLAIMER
  };

  if (!def.available) {
    return {
      ...base,
      status: STATUS.NOT_AVAILABLE,
      message: def.unavailableReason,
      buckets: [],
      trend: "insufficient"
    };
  }

  const weather = await loadWeather(wh);
  if (!weather || weather.length === 0) {
    return {
      ...base,
      status: STATUS.WEATHER_UNAVAILABLE,
      message: GEN_NO_WEATHER_MSG,
      buckets: [],
      trend: "insufficient"
    };
  }

  const readings = drainId
    ? await loadReadings({ drainId, windowHours: wh })
    : await loadReadings({ windowHours: wh });

  if (!readings || readings.length === 0) {
    return {
      ...base,
      status: STATUS.INSUFFICIENT_DATA,
      message: "No sensor readings were recorded within the window for this scope.",
      buckets: [],
      trend: "insufficient"
    };
  }

  const aligned = alignToNearest({
    weather,
    readings,
    toleranceMinutes: TIME_TOLERANCE_MINUTES,
    lagMinutes: lag
  });

  if (aligned.length < MIN_PAIRS) {
    return {
      ...base,
      status: STATUS.INSUFFICIENT_DATA,
      message: `Only ${aligned.length} aligned observation pair(s) were found within the ${wh}h window (minimum ${MIN_PAIRS} required).`,
      samples: buildSamples({
        count: aligned.length,
        weatherUsed: new Set(aligned.map((a) => a.obsIndex)).size,
        sensorUsed: new Set(aligned.map((a) => a.reading.id)).size,
        weatherTotal: weather.length,
        sensorTotal: readings.length,
        windowHours: wh,
        lagMinutes: lag,
        toleranceMinutes: TIME_TOLERANCE_MINUTES
      }),
      buckets: [],
      trend: "insufficient"
    };
  }

  const nowMs = Date.now();
  const startMs = nowMs - wh * 3600 * 1000;
  const bucketMs = (wh * 3600 * 1000) / BUCKET_COUNT;
  const buckets = [];

  for (let b = 0; b < BUCKET_COUNT; b += 1) {
    const loMs = startMs + b * bucketMs;
    const hiMs = loMs + bucketMs;
    const bucketAligned = aligned.filter((a) => {
      const t = new Date(a.obs.observed_at).getTime();
      return t >= loMs && t < hiMs;
    });
    const pairs = extractPairs(bucketAligned, def);
    const entry = {
      bucket: b + 1,
      bucket_start: new Date(loMs).toISOString(),
      bucket_end: new Date(hiMs).toISOString(),
      matched_pairs: pairs.length,
      status: STATUS.INSUFFICIENT_DATA,
      r: null,
      direction: null,
      strength: null
    };
    if (pairs.length >= MIN_PAIRS_PER_BUCKET) {
      const r = pearson(pairs);
      if (r !== null) {
        entry.status = STATUS.READY;
        entry.r = round3(r);
        entry.direction = directionFromR(r);
        entry.strength = strengthFromR(Math.abs(r)).key;
      }
    }
    buckets.push(entry);
  }

  const halfIndex = Math.floor(aligned.length / 2);
  const rFirst = pearson(extractPairs(aligned.slice(0, halfIndex), def));
  const rSecond = pearson(extractPairs(aligned.slice(halfIndex), def));

  let trend = "insufficient";
  if (rFirst !== null && rSecond !== null) {
    const delta = Math.abs(rSecond) - Math.abs(rFirst);
    trend =
      Math.abs(delta) < TREND_DELTA
        ? "stable"
        : delta > 0
          ? "strengthening"
          : "weakening";
  }

  const fullPairs = extractPairs(aligned, def);

  return {
    ...base,
    status: STATUS.READY,
    samples: buildSamples({
      count: fullPairs.length,
      weatherUsed: new Set(aligned.map((a) => a.obsIndex)).size,
      sensorUsed: new Set(aligned.map((a) => a.reading.id)).size,
      weatherTotal: weather.length,
      sensorTotal: readings.length,
      windowHours: wh,
      lagMinutes: lag,
      toleranceMinutes: TIME_TOLERANCE_MINUTES
    }),
    buckets,
    trend,
    trend_reason:
      trend === "insufficient"
        ? "Trend could not be computed from the available buckets."
        : `Recent |r| is ${trend === "stable" ? "broadly unchanged" : trend} versus the earlier half of the window.`
  };
}

async function getDrainCorrelations({
  windowHours = DEFAULT_WINDOW_HOURS
} = {}) {
  const wh = parseWindowHours(windowHours);
  const weather = await loadWeather(wh);
  const readings = await loadReadings({ windowHours: wh });

  const drainRows = await pool.query(
    `
    SELECT id, zone_name, location
    FROM drains
    ORDER BY id ASC
    `
  );

  const byDrain = new Map();
  for (const r of readings) {
    const key = Number(r.drain_id);
    if (!byDrain.has(key)) byDrain.set(key, []);
    byDrain.get(key).push(r);
  }

  const entries = [];
  for (const drain of drainRows.rows) {
    const drainReadings = byDrain.get(Number(drain.id)) || [];
    const signals = WEATHER_SIGNALS.map((def) =>
      compactSignal(
        buildSignalResult({
          signalDef: def,
          weather,
          readings: drainReadings,
          windowHours: wh,
          lagMinutes: 0
        })
      )
    );
    const ready = signals.filter((s) => s.status === STATUS.READY);
    let strongest = null;
    if (ready.length > 0) {
      strongest = ready
        .slice()
        .sort(
          (a, b) =>
            Math.abs(b.r) - Math.abs(a.r) || b.matched_pairs - a.matched_pairs
        )[0];
      strongest = {
        signal: strongest.signal,
        label: strongest.label,
        r: strongest.r,
        direction: strongest.direction,
        strength: strongest.strength,
        matched_pairs: strongest.matched_pairs
      };
    }
    entries.push({
      drain_id: Number(drain.id),
      zone: drain.zone_name,
      location: drain.location,
      status:
        weather.length === 0
          ? STATUS.WEATHER_UNAVAILABLE
          : ready.length > 0
            ? STATUS.READY
            : STATUS.INSUFFICIENT_DATA,
      signals_ready: ready.length,
      signals,
      strongest
    });
  }

  return {
    status:
      weather.length === 0 ? STATUS.WEATHER_UNAVAILABLE : STATUS.READY,
    window_hours: wh,
    generated_at: new Date().toISOString(),
    disclaimer: CORRELATION_DISCLAIMER,
    drains: entries
  };
}

async function getDrainCorrelation(drainId, {
  signal = DEFAULT_SIGNAL,
  windowHours = DEFAULT_WINDOW_HOURS,
  lagMinutes = 0
} = {}) {
  const def = SIGNAL_DEFINITIONS.find((d) => d.key === signal);
  if (!def) return null;
  return getWeatherCorrelation({
    signal,
    drainId,
    windowHours,
    lagMinutes
  });
}

// ------------------------------------------------------------
// Analytics + dashboard (additive)
// ------------------------------------------------------------

function analyticsCompact(sig) {
  if (!sig) return null;
  return {
    status: sig.status,
    r: sig.r,
    direction: sig.direction,
    strength: sig.strength,
    matched_pairs: sig.matched_pairs
  };
}

async function getWeatherAnalytics({
  windowHours = DEFAULT_WINDOW_HOURS
} = {}) {
  const summary = await getCorrelationSummary({ windowHours });
  const bySignal = {};
  for (const s of summary.signals) bySignal[s.signal] = s;
  const latest = await getLatestWeatherObservation();

  return {
    weather_correlation_status: summary.status,
    weather_data_quality: summary.weather_data_quality,
    weather_observation_count: summary.weather_data_quality
      ? summary.weather_data_quality.observation_count
      : 0,
    weather_signals_ready: summary.signals_ready,
    weather_signals_total: summary.signals_total,
    weather_window_hours: summary.window_hours,
    weather_strongest: summary.strongest,
    rainfall_water_level: analyticsCompact(bySignal.rainfall_water_level),
    humidity_water_level: analyticsCompact(bySignal.humidity_water_level),
    temperature_water_level: analyticsCompact(bySignal.temperature_water_level),
    pressure_water_level: analyticsCompact(bySignal.pressure_water_level),
    wind_water_level: analyticsCompact(bySignal.wind_water_level),
    weather_flood_risk: analyticsCompact(bySignal.weather_flood_risk),
    weather_forecast: analyticsCompact(bySignal.weather_forecast),
    latest_weather: latest,
    disclaimer: CORRELATION_DISCLAIMER,
    generated_at: new Date().toISOString()
  };
}

async function getDashboardSummary({
  windowHours = DEFAULT_WINDOW_HOURS
} = {}) {
  let summary;
  try {
    summary = await getCorrelationSummary({ windowHours });
  } catch (err) {
    console.log("⚠️ Dashboard weather correlation summary skipped:", err.message);
    return {
      weatherCorrelation: {
        status: STATUS.WEATHER_UNAVAILABLE,
        weatherDataQuality: "NO_WEATHER_DATA",
        signalsReady: 0,
        signalsTotal: SIGNAL_DEFINITIONS.length,
        strongest: null,
        latestWeather: null,
        message: "Weather correlation is temporarily unavailable."
      }
    };
  }

  return {
    weatherCorrelation: {
      status: summary.status,
      weatherDataQuality: summary.weather_data_quality
        ? summary.weather_data_quality.status
        : "NO_WEATHER_DATA",
      signalsReady: summary.signals_ready,
      signalsTotal: summary.signals_total,
      strongest: summary.strongest,
      latestWeather: summary.latest_weather,
      message: summary.message
    }
  };
}

// ------------------------------------------------------------
// Live emission (weatherFloodCorrelationUpdate, signature-guarded)
// ------------------------------------------------------------

async function evaluateAndEmitWeatherCorrelation({
  forceRefresh = false,
  windowHours = DEFAULT_WINDOW_HOURS
} = {}) {
  try {
    if (!forceRefresh) {
      await refreshWeatherIfStale();
    }
    const summary = await getCorrelationSummary({ windowHours });
    const signature = buildSignature(summary);
    const now = Date.now();

    if (signature === lastEmitted.signature) {
      return { emitted: false, reason: "UNCHANGED" };
    }
    if (now - lastEmitted.at < EMIT_MIN_INTERVAL_MS) {
      return { emitted: false, reason: "THROTTLED" };
    }

    lastEmitted.signature = signature;
    lastEmitted.at = now;
    socketHub.emit("weatherFloodCorrelationUpdate", summary);
    return { emitted: true, signature };
  } catch (err) {
    return { emitted: false, reason: "ERROR", error: err.message };
  }
}

function resetWeatherCorrelationRuntime() {
  lastFetchAttemptAt = 0;
  lastStalenessCheckAt = 0;
  weatherFetchInFlight = null;
  lastEmitted.signature = null;
  lastEmitted.at = 0;
  contextCache = { at: 0, data: null };
}

// ------------------------------------------------------------
// Exports
// ------------------------------------------------------------

module.exports = {
  // constants
  DEFAULT_WINDOW_HOURS,
  MAX_WINDOW_HOURS,
  DEFAULT_SIGNAL,
  MIN_PAIRS,
  MIN_PAIRS_PER_BUCKET,
  TIME_TOLERANCE_MINUTES,
  LAG_OPTIONS,
  BUCKET_COUNT,
  TREND_DELTA,
  WEATHER_REFRESH_INTERVAL_MS,
  WEATHER_CHECK_INTERVAL_MS,
  EMIT_MIN_INTERVAL_MS,
  CONTEXT_CACHE_TTL_MS,
  GEN_NO_WEATHER_MSG,
  CORRELATION_DISCLAIMER,
  STATUS,
  DIRECTION,
  STRENGTH_BANDS,
  SIGNAL_DEFINITIONS,
  SIGNAL_KEYS,
  WEATHER_SIGNALS,
  // pure helpers
  clamp,
  round3,
  toFinite,
  numberOrNull,
  pearson,
  directionFromR,
  strengthFromR,
  parseWindowHours,
  buildSamples,
  buildWording,
  alignToNearest,
  extractPairs,
  buildSignature,
  buildSignalResult,
  compactSignal,
  // data access + views
  loadWeather,
  loadReadings,
  hasRecentObservation,
  getLatestWeatherObservation,
  getWeatherContext,
  getWeatherCorrelationContext,
  getWeatherCorrelation,
  getCorrelationSignals,
  getCorrelationSummary,
  getCorrelationTrends,
  getDrainCorrelations,
  getDrainCorrelation,
  getWeatherAnalytics,
  getDashboardSummary,
  // refresh + live emission
  fetchWeatherSnapshot,
  refreshWeatherIfStale,
  evaluateAndEmitWeatherCorrelation,
  resetWeatherCorrelationRuntime
};