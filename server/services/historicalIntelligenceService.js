// ============================================================
// AI-DrainOS Historical Intelligence Service
//
// UPDATE #20A — Historical Data Analytics Foundation.
//
// A READ-ONLY, deterministic evidence/analytics layer that
// describes what ACTUALLY happened in the stored PostgreSQL
// records over a bounded historical window. It is NOT a
// prediction engine and never replaces or re-implements the
// existing flood risk / forecast / maintenance / vision /
// decision / path-planning / incident / fleet services — it
// only reads their persisted data.
//
// Hard guarantees:
//  * NO fabricated records, timestamps or readings. Every number
//    returned is computed from rows that exist in the database.
//  * When there is no evidence for a metric the value is null (for
//    numbers) or an explicit INSUFFICIENT_DATA status — never 0 as a
//    stand-in for "unknown".
//  * Time-based averages are null (not 0) when the denominator is 0.
//  * Queries are bounded by a validated time window, use existing
//    indexes, aggregate in PostgreSQL and never load the whole
//    database into Node.
//  * All SQL is parameterized; no request value is ever interpolated.
//  * CURRENT (live `sensors` row) and HISTORICAL (window aggregates)
//    values are always returned as clearly separate fields.
//
// No new database tables are required: historical intelligence
// derives entirely from existing records.
// ============================================================

const pool = require("../config/db");
const socketHub = require("./socketHub");

// ------------------------------------------------------------
// Supported windows / periods
// ------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

const PERIODS = {
  "24h": { label: "24h", ms: DAY_MS, description: "Last 24 hours" },
  "7d": { label: "7d", ms: 7 * DAY_MS, description: "Last 7 days" },
  "30d": { label: "30d", ms: 30 * DAY_MS, description: "Last 30 days" },
  "90d": { label: "90d", ms: 90 * DAY_MS, description: "Last 90 days" }
};

const DEFAULT_PERIOD = "30d";
const VALID_PERIODS = Object.keys(PERIODS);

// ------------------------------------------------------------
// Deterministic, documented thresholds
// ------------------------------------------------------------

// Data quality reflects the VOLUME of real records found in the
// selected window (documented, deterministic):
//   0            -> INSUFFICIENT_DATA
//   1 .. 4       -> SPARSE
//   5 .. 29      -> PARTIAL
//   >= 30        -> COMPLETE
const MIN_PARTIAL_RECORDS = 5;
const MIN_COMPLETE_RECORDS = 30;

const DATA_QUALITY = {
  COMPLETE: "COMPLETE",
  PARTIAL: "PARTIAL",
  SPARSE: "SPARSE",
  INSUFFICIENT_DATA: "INSUFFICIENT_DATA"
};

// Trend is derived from the REAL first and last reading in the
// window (ordered by recorded_at). A trend needs at least 3
// readings; otherwise INSUFFICIENT_DATA.
//   delta >=  threshold -> RISING
//   delta <= -threshold -> FALLING
//   otherwise           -> STABLE
const MIN_TREND_READINGS = 3;
const TREND_THRESHOLDS = {
  water_level: 5, // water level units (0-100)
  gas_level: 5, // gas level units (0-100)
  temperature: 1 // degrees Celsius
};

const TREND = {
  RISING: "RISING",
  FALLING: "FALLING",
  STABLE: "STABLE",
  INSUFFICIENT_DATA: "INSUFFICIENT_DATA"
};

// Historical health is a DESCRIPTIVE label built only from real
// evidence counts. It is intentionally separate from the live AI
// Decision Engine priority score and from the flood risk score.
const HEALTH = {
  HEALTHY: "HEALTHY",
  WATCH: "WATCH",
  DEGRADED: "DEGRADED",
  CRITICAL: "CRITICAL",
  INSUFFICIENT_DATA: "INSUFFICIENT_DATA"
};

// Documented historical water-level thresholds (0-100 scale used by
// the live sensor table). These are historical-analytics thresholds
// only — they are NOT the flood risk formula.
const HEALTH_THRESHOLDS = {
  WATER_WATCH: 50,
  WATER_DEGRADED: 75,
  WATER_CRITICAL: 90
};

// Time patterns require at least this many timestamped records before
// a peak hour/day is reported.
const MIN_PATTERN_SAMPLES = 3;

const TOP_DRAIN_LIMIT = 10;

const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday"
];

const VALID_INCIDENT_SEVERITIES = ["LOW", "MODERATE", "HIGH", "CRITICAL"];
const VALID_INCIDENT_SOURCES = [
  "AI_DECISION",
  "FLOOD_RISK",
  "FORECAST",
  "MAINTENANCE",
  "VISION",
  "MANUAL"
];
const ACTIVE_INCIDENT_STATUSES = ["OPEN", "ACKNOWLEDGED", "RESPONDING"];
const INCIDENT_STATUSES = ["OPEN", "ACKNOWLEDGED", "RESPONDING", "RESOLVED"];

const HISTORICAL_DISCLAIMER =
  "Historical intelligence describes RECORDED data only. It is descriptive evidence, not a prediction, and is independent of the live flood-risk, AI decision, anomaly and fleet-optimization scores.";

// ------------------------------------------------------------
// Small numeric / formatting helpers
// ------------------------------------------------------------

function asIso(value) {
  if (value === null || value === undefined) return null;
  return new Date(value).toISOString();
}

function num(value) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round(value, digits = 1) {
  const n = num(value);
  if (n === null) return null;
  const factor = Math.pow(10, digits);
  return Math.round(n * factor) / factor;
}

function round1(value) {
  return round(value, 1);
}

function round2(value) {
  return round(value, 2);
}

function secondsToMinutes(seconds) {
  const n = num(seconds);
  return n === null ? null : round1(n / 60);
}

// ------------------------------------------------------------
// Validation (all request values pass through here)
// ------------------------------------------------------------

function isValidPeriod(period) {
  return Object.prototype.hasOwnProperty.call(PERIODS, period);
}

// Resolves a validated period into safe PostgreSQL time boundaries.
// Returns null for an invalid period (route responds 400).
function resolvePeriod(input, now = new Date()) {
  const period =
    input === undefined || input === null || input === ""
      ? DEFAULT_PERIOD
      : String(input).toLowerCase();

  if (!isValidPeriod(period)) return null;

  const endTime = new Date(now.getTime());
  const startTime = new Date(endTime.getTime() - PERIODS[period].ms);

  return { period, startTime, endTime };
}

// drainId is optional; when supplied it must be a positive integer.
function parseDrainId(input) {
  if (input === undefined || input === null || input === "") {
    return { ok: true, value: null };
  }
  const n = Number(input);
  if (!Number.isInteger(n) || n <= 0) return { ok: false, value: null };
  return { ok: true, value: n };
}

// ------------------------------------------------------------
// Data quality
// ------------------------------------------------------------

function classifyDataQuality(recordCount) {
  const count = num(recordCount) || 0;
  if (count <= 0) return DATA_QUALITY.INSUFFICIENT_DATA;
  if (count < MIN_PARTIAL_RECORDS) return DATA_QUALITY.SPARSE;
  if (count < MIN_COMPLETE_RECORDS) return DATA_QUALITY.PARTIAL;
  return DATA_QUALITY.COMPLETE;
}

function buildDataQuality({
  window,
  recordCount,
  earliest = null,
  latest = null,
  missingSignals = [],
  tablesUsed = []
}) {
  const label = classifyDataQuality(recordCount);
  const windowMs = window.endTime.getTime() - window.startTime.getTime();
  const hasSpan = earliest !== null && latest !== null;
  const spanMs = hasSpan
    ? new Date(latest).getTime() - new Date(earliest).getTime()
    : 0;

  return {
    period: window.period,
    label,
    sufficient_data: label !== DATA_QUALITY.INSUFFICIENT_DATA,
    record_count: num(recordCount) || 0,
    earliest_timestamp: asIso(earliest),
    latest_timestamp: asIso(latest),
    window_start: asIso(window.startTime),
    window_end: asIso(window.endTime),
    coverage_ratio: windowMs > 0 ? round2(spanMs / windowMs) : 0,
    missing_signals: missingSignals,
    tables_used: tablesUsed
  };
}

// ------------------------------------------------------------
// Trend / metric summaries
// ------------------------------------------------------------

function computeTrend(firstValue, lastValue, count, threshold) {
  if (
    firstValue === null ||
    lastValue === null ||
    num(firstValue) === null ||
    num(lastValue) === null ||
    count < MIN_TREND_READINGS
  ) {
    return TREND.INSUFFICIENT_DATA;
  }

  const delta = Number(lastValue) - Number(firstValue);
  if (delta >= threshold) return TREND.RISING;
  if (delta <= -threshold) return TREND.FALLING;
  return TREND.STABLE;
}

// Builds a metric summary from REAL aggregated values only. When the
// metric has no samples, every numeric field is null and the trend is
// INSUFFICIENT_DATA (never a substituted 0 / fake trend).
function buildMetricSummary({
  count,
  average,
  minimum,
  maximum,
  first,
  last,
  threshold
}) {
  const samples = num(count) || 0;
  const hasSamples = samples > 0 && num(average) !== null;

  if (!hasSamples) {
    return {
      sample_count: samples,
      average: null,
      minimum: null,
      maximum: null,
      first: null,
      last: null,
      change: null,
      trend: TREND.INSUFFICIENT_DATA
    };
  }

  return {
    sample_count: samples,
    average: round1(average),
    minimum: num(minimum),
    maximum: num(maximum),
    first: num(first),
    last: num(last),
    change: round1(Number(last) - Number(first)),
    trend: computeTrend(first, last, samples, threshold)
  };
}

// ------------------------------------------------------------
// Shared queries
// ------------------------------------------------------------

async function listDrains(drainId) {
  if (drainId) {
    const result = await pool.query(
      `
      SELECT id, zone_name, location, status, blockage_level, latitude, longitude
      FROM drains
      WHERE id = $1
      `,
      [drainId]
    );
    return result.rows;
  }

  const result = await pool.query(
    `
    SELECT id, zone_name, location, status, blockage_level, latitude, longitude
    FROM drains
    ORDER BY id ASC
    `
  );
  return result.rows;
}

const SENSOR_HISTORY_SQL = `
  WITH windowed AS (
    SELECT
      sensor_id,
      drain_id,
      water_level,
      gas_level,
      temperature,
      recorded_at,
      ROW_NUMBER() OVER (PARTITION BY sensor_id ORDER BY recorded_at ASC, id ASC) AS rn_asc,
      ROW_NUMBER() OVER (PARTITION BY sensor_id ORDER BY recorded_at DESC, id DESC) AS rn_desc
    FROM sensor_readings
    WHERE recorded_at >= $1
      AND recorded_at <= $2
      AND ($3::int IS NULL OR drain_id = $3)
  ),
  grouped AS (
    SELECT
      sensor_id,
      drain_id,
      COUNT(*)::int AS reading_count,
      MIN(recorded_at) AS earliest,
      MAX(recorded_at) AS latest,
      AVG(water_level) AS avg_water,
      MIN(water_level) AS min_water,
      MAX(water_level) AS max_water,
      AVG(gas_level) AS avg_gas,
      MIN(gas_level) AS min_gas,
      MAX(gas_level) AS max_gas,
      AVG(temperature) AS avg_temperature,
      MIN(temperature) AS min_temperature,
      MAX(temperature) AS max_temperature
    FROM windowed
    GROUP BY sensor_id, drain_id
  )
  SELECT
    g.sensor_id,
    g.drain_id,
    g.reading_count,
    g.earliest,
    g.latest,
    g.avg_water,
    g.min_water,
    g.max_water,
    g.avg_gas,
    g.min_gas,
    g.max_gas,
    g.avg_temperature,
    g.min_temperature,
    g.max_temperature,
    f.water_level AS first_water,
    f.gas_level AS first_gas,
    f.temperature AS first_temperature,
    l.water_level AS last_water,
    l.gas_level AS last_gas,
    l.temperature AS last_temperature,
    d.zone_name,
    d.location,
    s.status AS sensor_status,
    s.sensor_status AS sensor_health_status
  FROM grouped g
  JOIN windowed f ON f.sensor_id = g.sensor_id AND f.rn_asc = 1
  JOIN windowed l ON l.sensor_id = g.sensor_id AND l.rn_desc = 1
  LEFT JOIN sensors s ON s.id = g.sensor_id
  LEFT JOIN drains d ON d.id = g.drain_id
  ORDER BY g.drain_id ASC, g.sensor_id ASC
`;

function shapeSensorRow(row) {
  const count = Number(row.reading_count);

  return {
    sensor_id: Number(row.sensor_id),
    drain_id: Number(row.drain_id),
    zone: row.zone_name || null,
    location: row.location || null,
    sensor_status: row.sensor_status || null,
    sensor_health_status: row.sensor_health_status || null,
    reading_count: count,
    earliest_timestamp: asIso(row.earliest),
    latest_timestamp: asIso(row.latest),
    water_level: buildMetricSummary({
      count,
      average: row.avg_water,
      minimum: row.min_water,
      maximum: row.max_water,
      first: row.first_water,
      last: row.last_water,
      threshold: TREND_THRESHOLDS.water_level
    }),
    gas_level: buildMetricSummary({
      count,
      average: row.avg_gas,
      minimum: row.min_gas,
      maximum: row.max_gas,
      first: row.first_gas,
      last: row.last_gas,
      threshold: TREND_THRESHOLDS.gas_level
    }),
    temperature: buildMetricSummary({
      count,
      average: row.avg_temperature,
      minimum: row.min_temperature,
      maximum: row.max_temperature,
      first: row.first_temperature,
      last: row.last_temperature,
      threshold: TREND_THRESHOLDS.temperature
    })
  };
}

// ------------------------------------------------------------
// Sensor history
// ------------------------------------------------------------

async function getSensorHistory(options = {}) {
  const window = resolvePeriod(options.period);
  if (!window) return null;

  const drainId = options.drainId ?? null;
  const result = await pool.query(SENSOR_HISTORY_SQL, [
    window.startTime,
    window.endTime,
    drainId
  ]);

  const sensorsList = result.rows.map(shapeSensorRow);
  const recordCount = sensorsList.reduce((sum, s) => sum + s.reading_count, 0);

  let earliest = null;
  let latest = null;
  for (const s of sensorsList) {
    if (s.earliest_timestamp && (!earliest || s.earliest_timestamp < earliest)) {
      earliest = s.earliest_timestamp;
    }
    if (s.latest_timestamp && (!latest || s.latest_timestamp > latest)) {
      latest = s.latest_timestamp;
    }
  }

  return {
    period: window.period,
    start_time: asIso(window.startTime),
    end_time: asIso(window.endTime),
    drain_id: drainId,
    status: recordCount > 0 ? "OK" : "INSUFFICIENT_DATA",
    reading_count: recordCount,
    sensor_count: sensorsList.length,
    sensors: sensorsList,
    data_quality: buildDataQuality({
      window,
      recordCount,
      earliest,
      latest,
      missingSignals: recordCount === 0 ? ["sensor_readings"] : [],
      tablesUsed: ["sensor_readings", "sensors", "drains"]
    }),
    disclaimer: HISTORICAL_DISCLAIMER,
    generated_at: new Date().toISOString()
  };
}

// ------------------------------------------------------------
// Incident history
// ------------------------------------------------------------

async function getIncidentHistory(options = {}) {
  const window = resolvePeriod(options.period);
  if (!window) return null;

  const drainId = options.drainId ?? null;
  const params = [window.startTime, window.endTime, drainId];

  const [summaryResult, timingResult, drainResult, overTimeResult] =
    await Promise.all([
      pool.query(
        `
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE severity = 'LOW')::int AS low,
          COUNT(*) FILTER (WHERE severity = 'MODERATE')::int AS moderate,
          COUNT(*) FILTER (WHERE severity = 'HIGH')::int AS high,
          COUNT(*) FILTER (WHERE severity = 'CRITICAL')::int AS critical,
          COUNT(*) FILTER (WHERE status = 'OPEN')::int AS open,
          COUNT(*) FILTER (WHERE status = 'ACKNOWLEDGED')::int AS acknowledged,
          COUNT(*) FILTER (WHERE status = 'RESPONDING')::int AS responding,
          COUNT(*) FILTER (WHERE status = 'RESOLVED')::int AS resolved,
          COUNT(*) FILTER (WHERE source = 'AI_DECISION')::int AS ai_decision,
          COUNT(*) FILTER (WHERE source = 'FLOOD_RISK')::int AS flood_risk,
          COUNT(*) FILTER (WHERE source = 'FORECAST')::int AS forecast,
          COUNT(*) FILTER (WHERE source = 'MAINTENANCE')::int AS maintenance,
          COUNT(*) FILTER (WHERE source = 'VISION')::int AS vision,
          COUNT(*) FILTER (WHERE source = 'MANUAL')::int AS manual,
          MIN(created_at) AS earliest,
          MAX(created_at) AS latest
        FROM incidents
        WHERE created_at >= $1
          AND created_at <= $2
          AND ($3::int IS NULL OR drain_id = $3)
        `,
        params
      ),
      pool.query(
        `
        SELECT
          COUNT(acknowledged_at)::int AS with_acknowledgement,
          COUNT(responding_at)::int AS with_response,
          COUNT(resolved_at)::int AS with_resolution,
          ROUND(AVG(EXTRACT(EPOCH FROM (acknowledged_at - created_at)))::numeric, 1)
            AS avg_ack_seconds,
          ROUND(AVG(EXTRACT(EPOCH FROM (responding_at - created_at)))::numeric, 1)
            AS avg_response_seconds,
          ROUND(AVG(EXTRACT(EPOCH FROM (resolved_at - created_at)))::numeric, 1)
            AS avg_resolution_seconds
        FROM incidents
        WHERE created_at >= $1
          AND created_at <= $2
          AND ($3::int IS NULL OR drain_id = $3)
        `,
        params
      ),
      pool.query(
        `
        SELECT
          i.drain_id,
          d.zone_name,
          d.location,
          COUNT(*)::int AS count,
          COUNT(*) FILTER (WHERE i.severity = 'CRITICAL')::int AS critical_count
        FROM incidents i
        LEFT JOIN drains d ON d.id = i.drain_id
        WHERE i.created_at >= $1
          AND i.created_at <= $2
          AND ($3::int IS NULL OR i.drain_id = $3)
        GROUP BY i.drain_id, d.zone_name, d.location
        ORDER BY count DESC, i.drain_id ASC
        LIMIT ${TOP_DRAIN_LIMIT}
        `,
        params
      ),
      pool.query(
        `
        SELECT
          to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS bucket,
          COUNT(*)::int AS count
        FROM incidents
        WHERE created_at >= $1
          AND created_at <= $2
          AND ($3::int IS NULL OR drain_id = $3)
        GROUP BY 1
        ORDER BY 1 ASC
        `,
        params
      )
    ]);

  const s = summaryResult.rows[0];
  const timing = timingResult.rows[0];
  const total = Number(s.total);

  const withAck = Number(timing.with_acknowledgement);
  const withResponse = Number(timing.with_response);
  const withResolution = Number(timing.with_resolution);

  const avgAck = withAck > 0 ? num(timing.avg_ack_seconds) : null;
  const avgResponse = withResponse > 0 ? num(timing.avg_response_seconds) : null;
  const avgResolution =
    withResolution > 0 ? num(timing.avg_resolution_seconds) : null;

  return {
    period: window.period,
    start_time: asIso(window.startTime),
    end_time: asIso(window.endTime),
    drain_id: drainId,
    status: total > 0 ? "OK" : "INSUFFICIENT_DATA",
    total,
    active:
      Number(s.open) + Number(s.acknowledged) + Number(s.responding),
    resolved: Number(s.resolved),
    by_severity: {
      LOW: Number(s.low),
      MODERATE: Number(s.moderate),
      HIGH: Number(s.high),
      CRITICAL: Number(s.critical)
    },
    by_status: {
      OPEN: Number(s.open),
      ACKNOWLEDGED: Number(s.acknowledged),
      RESPONDING: Number(s.responding),
      RESOLVED: Number(s.resolved)
    },
    by_source: {
      AI_DECISION: Number(s.ai_decision),
      FLOOD_RISK: Number(s.flood_risk),
      FORECAST: Number(s.forecast),
      MAINTENANCE: Number(s.maintenance),
      VISION: Number(s.vision),
      MANUAL: Number(s.manual)
    },
    by_drain: drainResult.rows.map((row) => ({
      drain_id: Number(row.drain_id),
      zone: row.zone_name || null,
      location: row.location || null,
      count: Number(row.count),
      critical_count: Number(row.critical_count)
    })),
    over_time: overTimeResult.rows.map((row) => ({
      bucket: row.bucket,
      count: Number(row.count)
    })),
    // Response/resolution timing is ONLY computed from real timestamps
    // and is null (not 0) when no row carries the required timestamp.
    average_acknowledgement_seconds: avgAck,
    average_acknowledgement_minutes: secondsToMinutes(avgAck),
    average_response_seconds: avgResponse,
    average_response_minutes: secondsToMinutes(avgResponse),
    average_resolution_seconds: avgResolution,
    average_resolution_minutes: secondsToMinutes(avgResolution),
    data_points: {
      with_acknowledgement: withAck,
      with_response: withResponse,
      with_resolution: withResolution
    },
    earliest_timestamp: asIso(s.earliest),
    latest_timestamp: asIso(s.latest),
    data_quality: buildDataQuality({
      window,
      recordCount: total,
      earliest: s.earliest,
      latest: s.latest,
      missingSignals: total === 0 ? ["incidents"] : [],
      tablesUsed: ["incidents", "drains"]
    }),
    disclaimer: HISTORICAL_DISCLAIMER,
    generated_at: new Date().toISOString()
  };
}

// ------------------------------------------------------------
// Mission / robot history
// ------------------------------------------------------------

async function getMissionHistory(options = {}) {
  const window = resolvePeriod(options.period);
  if (!window) return null;

  const drainId = options.drainId ?? null;
  const params = [window.startTime, window.endTime, drainId];

  const [summaryResult, statusResult, robotResult, drainResult] =
    await Promise.all([
      pool.query(
        `
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE mission_status = 'Completed')::int AS completed,
          COUNT(*) FILTER (WHERE mission_status = 'Assigned')::int AS assigned,
          COUNT(completed_time)::int AS with_duration,
          ROUND(AVG(EXTRACT(EPOCH FROM (completed_time - assigned_time)))::numeric, 1)
            AS avg_duration_seconds,
          MIN(assigned_time) AS earliest,
          MAX(assigned_time) AS latest
        FROM missions
        WHERE assigned_time >= $1
          AND assigned_time <= $2
          AND ($3::int IS NULL OR drain_id = $3)
        `,
        params
      ),
      pool.query(
        `
        SELECT mission_status, COUNT(*)::int AS count
        FROM missions
        WHERE assigned_time >= $1
          AND assigned_time <= $2
          AND ($3::int IS NULL OR drain_id = $3)
        GROUP BY mission_status
        ORDER BY mission_status ASC
        `,
        params
      ),
      pool.query(
        `
        SELECT
          m.robot_id,
          r.robot_name,
          COUNT(*)::int AS mission_count,
          COUNT(*) FILTER (WHERE m.mission_status = 'Completed')::int AS completed,
          COUNT(*) FILTER (WHERE m.mission_status = 'Assigned')::int AS assigned,
          MAX(m.assigned_time) AS last_mission_time
        FROM missions m
        LEFT JOIN robots r ON r.id = m.robot_id
        WHERE m.assigned_time >= $1
          AND m.assigned_time <= $2
          AND ($3::int IS NULL OR m.drain_id = $3)
        GROUP BY m.robot_id, r.robot_name
        ORDER BY mission_count DESC, m.robot_id ASC
        `,
        params
      ),
      pool.query(
        `
        SELECT
          m.drain_id,
          d.zone_name,
          d.location,
          COUNT(*)::int AS mission_count,
          COUNT(*) FILTER (WHERE m.mission_status = 'Completed')::int AS completed,
          MAX(m.assigned_time) AS last_mission_time
        FROM missions m
        LEFT JOIN drains d ON d.id = m.drain_id
        WHERE m.assigned_time >= $1
          AND m.assigned_time <= $2
          AND m.drain_id IS NOT NULL
          AND ($3::int IS NULL OR m.drain_id = $3)
        GROUP BY m.drain_id, d.zone_name, d.location
        ORDER BY mission_count DESC, m.drain_id ASC
        LIMIT ${TOP_DRAIN_LIMIT}
        `,
        params
      )
    ]);

  const s = summaryResult.rows[0];
  const total = Number(s.total);
  const completed = Number(s.completed);
  const withDuration = Number(s.with_duration);
  const avgDuration = withDuration > 0 ? num(s.avg_duration_seconds) : null;

  const byStatus = {};
  for (const row of statusResult.rows) {
    byStatus[row.mission_status] = Number(row.count);
  }

  return {
    period: window.period,
    start_time: asIso(window.startTime),
    end_time: asIso(window.endTime),
    drain_id: drainId,
    status: total > 0 ? "OK" : "INSUFFICIENT_DATA",
    total,
    completed,
    assigned: Number(s.assigned),
    completion_rate: total > 0 ? round1((completed / total) * 100) : null,
    by_status: byStatus,
    average_mission_duration_seconds: avgDuration,
    average_mission_duration_minutes: secondsToMinutes(avgDuration),
    // Missions have no "response" timestamp column, so a response time
    // cannot be computed from real data — it is honestly null.
    average_response_seconds: null,
    average_response_minutes: null,
    response_time_available: false,
    robots: robotResult.rows.map((row) => {
      const count = Number(row.mission_count);
      const done = Number(row.completed);
      return {
        robot_id: row.robot_id === null ? null : Number(row.robot_id),
        robot_name: row.robot_name || null,
        mission_count: count,
        completed: done,
        assigned: Number(row.assigned),
        completion_rate: count > 0 ? round1((done / count) * 100) : null,
        last_mission_time: asIso(row.last_mission_time)
      };
    }),
    by_drain: drainResult.rows.map((row) => ({
      drain_id: Number(row.drain_id),
      zone: row.zone_name || null,
      location: row.location || null,
      mission_count: Number(row.mission_count),
      completed: Number(row.completed),
      last_mission_time: asIso(row.last_mission_time)
    })),
    data_points: { with_duration: withDuration },
    earliest_timestamp: asIso(s.earliest),
    latest_timestamp: asIso(s.latest),
    data_quality: buildDataQuality({
      window,
      recordCount: total,
      earliest: s.earliest,
      latest: s.latest,
      missingSignals:
        total === 0
          ? ["missions"]
          : ["missions.response_timestamp (not present in schema)"],
      tablesUsed: ["missions", "robots", "drains"]
    }),
    disclaimer: HISTORICAL_DISCLAIMER,
    generated_at: new Date().toISOString()
  };
}

// ------------------------------------------------------------
// Alert history
// ------------------------------------------------------------

async function getAlertHistory(options = {}) {
  const window = resolvePeriod(options.period);
  if (!window) return null;

  const drainId = options.drainId ?? null;
  const params = [window.startTime, window.endTime, drainId];

  const [summaryResult, severityResult, typeResult, drainResult, overTimeResult] =
    await Promise.all([
      pool.query(
        `
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE alert_status = 'Resolved')::int AS resolved,
          COUNT(*) FILTER (WHERE alert_status <> 'Resolved' OR alert_status IS NULL)::int AS unresolved,
          COUNT(*) FILTER (WHERE severity = 'Critical')::int AS critical,
          MIN(created_at) AS earliest,
          MAX(created_at) AS latest
        FROM alerts
        WHERE created_at >= $1
          AND created_at <= $2
          AND ($3::int IS NULL OR drain_id = $3)
        `,
        params
      ),
      pool.query(
        `
        SELECT severity, COUNT(*)::int AS count
        FROM alerts
        WHERE created_at >= $1
          AND created_at <= $2
          AND ($3::int IS NULL OR drain_id = $3)
        GROUP BY severity
        ORDER BY severity ASC
        `,
        params
      ),
      pool.query(
        `
        SELECT alert_type, COUNT(*)::int AS count
        FROM alerts
        WHERE created_at >= $1
          AND created_at <= $2
          AND ($3::int IS NULL OR drain_id = $3)
        GROUP BY alert_type
        ORDER BY count DESC, alert_type ASC
        `,
        params
      ),
      pool.query(
        `
        SELECT
          a.drain_id,
          d.zone_name,
          d.location,
          COUNT(*)::int AS count,
          COUNT(*) FILTER (WHERE a.severity = 'Critical')::int AS critical_count
        FROM alerts a
        LEFT JOIN drains d ON d.id = a.drain_id
        WHERE a.created_at >= $1
          AND a.created_at <= $2
          AND ($3::int IS NULL OR a.drain_id = $3)
        GROUP BY a.drain_id, d.zone_name, d.location
        ORDER BY count DESC, a.drain_id ASC
        LIMIT ${TOP_DRAIN_LIMIT}
        `,
        params
      ),
      pool.query(
        `
        SELECT
          to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS bucket,
          COUNT(*)::int AS count
        FROM alerts
        WHERE created_at >= $1
          AND created_at <= $2
          AND ($3::int IS NULL OR drain_id = $3)
        GROUP BY 1
        ORDER BY 1 ASC
        `,
        params
      )
    ]);

  const s = summaryResult.rows[0];
  const total = Number(s.total);

  const bySeverity = {};
  for (const row of severityResult.rows) {
    bySeverity[row.severity || "Unknown"] = Number(row.count);
  }

  return {
    period: window.period,
    start_time: asIso(window.startTime),
    end_time: asIso(window.endTime),
    drain_id: drainId,
    status: total > 0 ? "OK" : "INSUFFICIENT_DATA",
    total,
    resolved: Number(s.resolved),
    unresolved: Number(s.unresolved),
    critical: Number(s.critical),
    by_severity: bySeverity,
    by_type: typeResult.rows.map((row) => ({
      alert_type: row.alert_type || "Unknown",
      count: Number(row.count)
    })),
    by_drain: drainResult.rows.map((row) => ({
      drain_id: row.drain_id === null ? null : Number(row.drain_id),
      zone: row.zone_name || null,
      location: row.location || null,
      count: Number(row.count),
      critical_count: Number(row.critical_count)
    })),
    over_time: overTimeResult.rows.map((row) => ({
      bucket: row.bucket,
      count: Number(row.count)
    })),
    earliest_timestamp: asIso(s.earliest),
    latest_timestamp: asIso(s.latest),
    data_quality: buildDataQuality({
      window,
      recordCount: total,
      earliest: s.earliest,
      latest: s.latest,
      missingSignals: total === 0 ? ["alerts"] : [],
      tablesUsed: ["alerts", "drains"]
    }),
    disclaimer: HISTORICAL_DISCLAIMER,
    generated_at: new Date().toISOString()
  };
}

// ------------------------------------------------------------
// Drain history + historical health
// ------------------------------------------------------------

function emptyHealthEvidence() {
  return {
    reading_count: 0,
    max_water_level: null,
    incident_count: 0,
    critical_incident_count: 0,
    high_incident_count: 0,
    unresolved_incident_count: 0,
    alert_count: 0,
    open_critical_alert_count: 0,
    mission_count: 0,
    maintenance_event_count: 0,
    vision_inspection_count: 0
  };
}

// Deterministic, descriptive health label from REAL evidence counts.
// It is NOT the AI Decision score and NOT a prediction.
function computeDrainHealth(evidence) {
  const e = { ...emptyHealthEvidence(), ...evidence };

  const hasAnyEvidence =
    e.reading_count > 0 ||
    e.incident_count > 0 ||
    e.alert_count > 0 ||
    e.mission_count > 0 ||
    e.maintenance_event_count > 0 ||
    e.vision_inspection_count > 0 ||
    e.max_water_level !== null;

  if (!hasAnyEvidence) {
    return {
      status: HEALTH.INSUFFICIENT_DATA,
      reasons: ["No historical evidence for this drain in the selected window."],
      evidence: e
    };
  }

  const order = [HEALTH.HEALTHY, HEALTH.WATCH, HEALTH.DEGRADED, HEALTH.CRITICAL];
  let status = HEALTH.HEALTHY;
  const reasons = [];
  const escalate = (next) => {
    if (order.indexOf(next) > order.indexOf(status)) status = next;
  };

  const maxWater = e.max_water_level;

  if (e.critical_incident_count > 0) {
    escalate(HEALTH.CRITICAL);
    reasons.push(
      `${e.critical_incident_count} CRITICAL incident(s) recorded in the window.`
    );
  }
  if (maxWater !== null && maxWater >= HEALTH_THRESHOLDS.WATER_CRITICAL) {
    escalate(HEALTH.CRITICAL);
    reasons.push(`Maximum recorded water level reached ${maxWater}.`);
  }
  if (e.high_incident_count > 0) {
    escalate(HEALTH.DEGRADED);
    reasons.push(`${e.high_incident_count} HIGH incident(s) recorded in the window.`);
  }
  if (e.open_critical_alert_count > 0) {
    escalate(HEALTH.DEGRADED);
    reasons.push(
      `${e.open_critical_alert_count} unresolved Critical alert(s) recorded.`
    );
  }
  if (maxWater !== null && maxWater >= HEALTH_THRESHOLDS.WATER_DEGRADED) {
    escalate(HEALTH.DEGRADED);
    reasons.push(`Maximum recorded water level reached ${maxWater}.`);
  }
  if (e.unresolved_incident_count > 0) {
    escalate(HEALTH.WATCH);
    reasons.push(`${e.unresolved_incident_count} unresolved incident(s).`);
  }
  if (e.incident_count > 0) {
    escalate(HEALTH.WATCH);
    reasons.push(`${e.incident_count} incident(s) recorded in the window.`);
  }
  if (e.alert_count > 0) {
    escalate(HEALTH.WATCH);
    reasons.push(`${e.alert_count} alert(s) recorded in the window.`);
  }
  if (e.maintenance_event_count > 0) {
    escalate(HEALTH.WATCH);
    reasons.push(`${e.maintenance_event_count} maintenance record(s) in the window.`);
  }
  if (maxWater !== null && maxWater >= HEALTH_THRESHOLDS.WATER_WATCH) {
    escalate(HEALTH.WATCH);
    reasons.push(`Maximum recorded water level reached ${maxWater}.`);
  }

  if (reasons.length === 0) {
    reasons.push("No adverse historical signals recorded in the selected window.");
  }

  return { status, reasons, evidence: e };
}

async function getDrainHistory(options = {}) {
  const window = resolvePeriod(options.period);
  if (!window) return null;

  const drainId = options.drainId ?? null;
  const params = [window.startTime, window.endTime, drainId];

  const [drains, sensorHistory] = await Promise.all([
    listDrains(drainId),
    getSensorHistory({ period: window.period, drainId })
  ]);

  // Per-drain aggregations (one grouped query each — no N+1).
  const [incidentRes, alertRes, missionRes] = await Promise.all([
    pool.query(
      `
      SELECT
        drain_id,
        COUNT(*)::int AS incident_count,
        COUNT(*) FILTER (WHERE severity = 'CRITICAL')::int AS critical_count,
        COUNT(*) FILTER (WHERE severity = 'HIGH')::int AS high_count,
        COUNT(*) FILTER (WHERE severity = 'MODERATE')::int AS moderate_count,
        COUNT(*) FILTER (WHERE severity = 'LOW')::int AS low_count,
        COUNT(*) FILTER (WHERE status = ANY($4::varchar[]))::int AS unresolved_count,
        MAX(created_at) AS last_incident_time
      FROM incidents
      WHERE created_at >= $1
        AND created_at <= $2
        AND ($3::int IS NULL OR drain_id = $3)
      GROUP BY drain_id
      `,
      [...params, ACTIVE_INCIDENT_STATUSES]
    ),
    pool.query(
      `
      SELECT
        drain_id,
        COUNT(*)::int AS alert_count,
        COUNT(*) FILTER (WHERE severity = 'Critical' AND (alert_status <> 'Resolved' OR alert_status IS NULL))::int AS open_critical_count,
        COUNT(*) FILTER (WHERE alert_status <> 'Resolved' OR alert_status IS NULL)::int AS open_count,
        MAX(created_at) AS last_alert_time
      FROM alerts
      WHERE created_at >= $1
        AND created_at <= $2
        AND ($3::int IS NULL OR drain_id = $3)
      GROUP BY drain_id
      `,
      params
    ),
    pool.query(
      `
      SELECT
        drain_id,
        COUNT(*)::int AS mission_count,
        COUNT(*) FILTER (WHERE mission_status = 'Completed')::int AS completed_count,
        MAX(assigned_time) AS last_mission_time
      FROM missions
      WHERE assigned_time >= $1
        AND assigned_time <= $2
        AND drain_id IS NOT NULL
        AND ($3::int IS NULL OR drain_id = $3)
      GROUP BY drain_id
      `,
      params
    )
  ]);

  // Maintenance + vision records are read best-effort so a missing
  // optional table never breaks the historical contract.
  const missingSignals = [];
  const tablesUsed = [
    "drains",
    "sensors",
    "sensor_readings",
    "incidents",
    "alerts",
    "missions"
  ];

  let maintenanceRes = { rows: [] };
  try {
    maintenanceRes = await pool.query(
      `
      SELECT
        drain_id,
        COUNT(*)::int AS maintenance_count,
        MAX(created_at) AS last_maintenance_time
      FROM maintenance_predictions
      WHERE created_at >= $1
        AND created_at <= $2
        AND ($3::int IS NULL OR drain_id = $3)
      GROUP BY drain_id
      `,
      params
    );
    tablesUsed.push("maintenance_predictions");
  } catch (err) {
    missingSignals.push("maintenance_predictions");
  }

  let visionRes = { rows: [] };
  try {
    visionRes = await pool.query(
      `
      SELECT
        drain_id,
        COUNT(*)::int AS vision_count,
        MAX(created_at) AS last_vision_time
      FROM drain_vision_inspections
      WHERE created_at >= $1
        AND created_at <= $2
        AND ($3::int IS NULL OR drain_id = $3)
      GROUP BY drain_id
      `,
      params
    );
    tablesUsed.push("drain_vision_inspections");
  } catch (err) {
    missingSignals.push("drain_vision_inspections");
  }

  const indexByDrain = (rows) => {
    const map = new Map();
    for (const row of rows) map.set(Number(row.drain_id), row);
    return map;
  };

  const incidentByDrain = indexByDrain(incidentRes.rows);
  const alertByDrain = indexByDrain(alertRes.rows);
  const missionByDrain = indexByDrain(missionRes.rows);
  const maintenanceByDrain = indexByDrain(maintenanceRes.rows);
  const visionByDrain = indexByDrain(visionRes.rows);

  const sensorByDrain = new Map();
  for (const sensor of sensorHistory ? sensorHistory.sensors : []) {
    const list = sensorByDrain.get(sensor.drain_id) || [];
    list.push(sensor);
    sensorByDrain.set(sensor.drain_id, list);
  }

  const drainHealth = drains.map((drain) => {
    const id = Number(drain.id);
    const sensorsForDrain = sensorByDrain.get(id) || [];

    const readingCount = sensorsForDrain.reduce(
      (sum, s) => sum + s.reading_count,
      0
    );

    let maxWater = null;
    for (const s of sensorsForDrain) {
      const candidate = s.water_level.maximum;
      if (candidate !== null && (maxWater === null || candidate > maxWater)) {
        maxWater = candidate;
      }
    }

    const incident = incidentByDrain.get(id);
    const alert = alertByDrain.get(id);
    const mission = missionByDrain.get(id);
    const maintenance = maintenanceByDrain.get(id);
    const vision = visionByDrain.get(id);

    const health = computeDrainHealth({
      reading_count: readingCount,
      max_water_level: maxWater,
      incident_count: incident ? Number(incident.incident_count) : 0,
      critical_incident_count: incident ? Number(incident.critical_count) : 0,
      high_incident_count: incident ? Number(incident.high_count) : 0,
      unresolved_incident_count: incident ? Number(incident.unresolved_count) : 0,
      alert_count: alert ? Number(alert.alert_count) : 0,
      open_critical_alert_count: alert ? Number(alert.open_critical_count) : 0,
      mission_count: mission ? Number(mission.mission_count) : 0,
      maintenance_event_count: maintenance ? Number(maintenance.maintenance_count) : 0,
      vision_inspection_count: vision ? Number(vision.vision_count) : 0
    });

    return {
      drain_id: id,
      zone: drain.zone_name || null,
      location: drain.location || null,
      // CURRENT live state (from the drains table) — kept separate from
      // the HISTORICAL health label below.
      current_status: drain.status || null,
      current_blockage_level:
        drain.blockage_level === null ? null : Number(drain.blockage_level),
      historical_health: health.status,
      historical_health_reasons: health.reasons,
      evidence: health.evidence,
      sensor_summary: {
        sensor_count: sensorsForDrain.length,
        reading_count: readingCount,
        sensors: sensorsForDrain.map((s) => ({
          sensor_id: s.sensor_id,
          reading_count: s.reading_count,
          water_level: s.water_level,
          gas_level: s.gas_level,
          temperature: s.temperature
        }))
      },
      incident_count: health.evidence.incident_count,
      critical_incident_count: health.evidence.critical_incident_count,
      alert_count: health.evidence.alert_count,
      mission_count: health.evidence.mission_count,
      maintenance_event_count: health.evidence.maintenance_event_count,
      vision_inspection_count: health.evidence.vision_inspection_count,
      last_incident_time: incident ? asIso(incident.last_incident_time) : null,
      last_alert_time: alert ? asIso(alert.last_alert_time) : null,
      last_mission_time: mission ? asIso(mission.last_mission_time) : null,
      last_reading_time:
        sensorsForDrain.length > 0
          ? sensorsForDrain
              .map((s) => s.latest_timestamp)
              .filter(Boolean)
              .sort()
              .pop() || null
          : null
    };
  });

  // Order by historical pressure: most evidence first (incidents, then
  // alerts, then readings), deterministic tie-break by drain id.
  drainHealth.sort((a, b) => {
    if (b.incident_count !== a.incident_count) {
      return b.incident_count - a.incident_count;
    }
    if (b.alert_count !== a.alert_count) {
      return b.alert_count - a.alert_count;
    }
    return a.drain_id - b.drain_id;
  });

  return {
    period: window.period,
    start_time: asIso(window.startTime),
    end_time: asIso(window.endTime),
    drain_id: drainId,
    status: drainHealth.some(
      (d) => d.historical_health !== HEALTH.INSUFFICIENT_DATA
    )
      ? "OK"
      : "INSUFFICIENT_DATA",
    drain_count: drainHealth.length,
    drains: drainHealth,
    data_quality: sensorHistory
      ? sensorHistory.data_quality
      : buildDataQuality({ window, recordCount: 0 }),
    missing_signals: missingSignals,
    tables_used: tablesUsed,
    disclaimer: HISTORICAL_DISCLAIMER,
    generated_at: new Date().toISOString()
  };
}

// ------------------------------------------------------------
// Time patterns (descriptive only — never causal / seasonal)
// ------------------------------------------------------------

function buildDistribution(rows, size, keyName) {
  const distribution = new Array(size).fill(0);
  for (const row of rows) {
    const idx = Number(row[keyName]);
    if (Number.isInteger(idx) && idx >= 0 && idx < size) {
      distribution[idx] = Number(row.count);
    }
  }
  return distribution;
}

function peakIndex(distribution, total) {
  if (total < MIN_PATTERN_SAMPLES) return null;
  let best = -1;
  let bestValue = -1;
  for (let i = 0; i < distribution.length; i += 1) {
    if (distribution[i] > bestValue) {
      bestValue = distribution[i];
      best = i;
    }
  }
  return best >= 0 ? best : null;
}

async function getTimePatterns(options = {}) {
  const window = resolvePeriod(options.period);
  if (!window) return null;

  const drainId = options.drainId ?? null;
  const params = [window.startTime, window.endTime, drainId];

  const [incidentHours, incidentDays, alertHours, alertDays, counts] =
    await Promise.all([
      pool.query(
        `
        SELECT EXTRACT(HOUR FROM created_at)::int AS hour, COUNT(*)::int AS count
        FROM incidents
        WHERE created_at >= $1 AND created_at <= $2
          AND ($3::int IS NULL OR drain_id = $3)
        GROUP BY 1 ORDER BY 1 ASC
        `,
        params
      ),
      pool.query(
        `
        SELECT EXTRACT(DOW FROM created_at)::int AS dow, COUNT(*)::int AS count
        FROM incidents
        WHERE created_at >= $1 AND created_at <= $2
          AND ($3::int IS NULL OR drain_id = $3)
        GROUP BY 1 ORDER BY 1 ASC
        `,
        params
      ),
      pool.query(
        `
        SELECT EXTRACT(HOUR FROM created_at)::int AS hour, COUNT(*)::int AS count
        FROM alerts
        WHERE created_at >= $1 AND created_at <= $2
          AND ($3::int IS NULL OR drain_id = $3)
        GROUP BY 1 ORDER BY 1 ASC
        `,
        params
      ),
      pool.query(
        `
        SELECT EXTRACT(DOW FROM created_at)::int AS dow, COUNT(*)::int AS count
        FROM alerts
        WHERE created_at >= $1 AND created_at <= $2
          AND ($3::int IS NULL OR drain_id = $3)
        GROUP BY 1 ORDER BY 1 ASC
        `,
        params
      ),
      pool.query(
        `
        SELECT
          (SELECT COUNT(*)::int FROM incidents
            WHERE created_at >= $1 AND created_at <= $2
              AND ($3::int IS NULL OR drain_id = $3)) AS incident_count,
          (SELECT COUNT(*)::int FROM alerts
            WHERE created_at >= $1 AND created_at <= $2
              AND ($3::int IS NULL OR drain_id = $3)) AS alert_count
        `,
        params
      )
    ]);

  const incidentTotal = Number(counts.rows[0].incident_count);
  const alertTotal = Number(counts.rows[0].alert_count);

  const incidentHourly = buildDistribution(incidentHours.rows, 24, "hour");
  const incidentWeekday = buildDistribution(incidentDays.rows, 7, "dow");
  const alertHourly = buildDistribution(alertHours.rows, 24, "hour");
  const alertWeekday = buildDistribution(alertDays.rows, 7, "dow");

  const incidentPeakHour = peakIndex(incidentHourly, incidentTotal);
  const incidentPeakDay = peakIndex(incidentWeekday, incidentTotal);
  const alertPeakHour = peakIndex(alertHourly, alertTotal);
  const alertPeakDay = peakIndex(alertWeekday, alertTotal);

  return {
    period: window.period,
    start_time: asIso(window.startTime),
    end_time: asIso(window.endTime),
    drain_id: drainId,
    status: incidentTotal > 0 || alertTotal > 0 ? "OK" : "INSUFFICIENT_DATA",
    minimum_samples_for_peak: MIN_PATTERN_SAMPLES,
    incidents: {
      total: incidentTotal,
      status: incidentTotal > 0 ? "OK" : "INSUFFICIENT_DATA",
      hourly_distribution: incidentHourly,
      weekday_distribution: incidentWeekday,
      peak_incident_hour: incidentPeakHour,
      peak_incident_day:
        incidentPeakDay === null ? null : WEEKDAY_NAMES[incidentPeakDay],
      peak_incident_day_index: incidentPeakDay,
      // Descriptive wording only — recorded distribution, not causation.
      summary:
        incidentPeakHour === null
          ? null
          : `Most recorded incidents occurred during the ${incidentPeakHour}:00 hour.`
    },
    alerts: {
      total: alertTotal,
      status: alertTotal > 0 ? "OK" : "INSUFFICIENT_DATA",
      hourly_distribution: alertHourly,
      weekday_distribution: alertWeekday,
      peak_alert_hour: alertPeakHour,
      peak_alert_day: alertPeakDay === null ? null : WEEKDAY_NAMES[alertPeakDay],
      peak_alert_day_index: alertPeakDay,
      summary:
        alertPeakHour === null
          ? null
          : `Most recorded alerts occurred during the ${alertPeakHour}:00 hour.`
    },
    weekday_names: WEEKDAY_NAMES,
    disclaimer: HISTORICAL_DISCLAIMER,
    generated_at: new Date().toISOString()
  };
}

// ------------------------------------------------------------
// Current vs historical comparison
// ------------------------------------------------------------

function buildComparisonRow(metric, currentValue, historicalAverage) {
  const current = num(currentValue);
  const historical = num(historicalAverage);
  const ok = current !== null && historical !== null;

  if (!ok) {
    return {
      metric,
      current_value: current,
      historical_average: historical,
      change: null,
      direction: null,
      status: "INSUFFICIENT_DATA"
    };
  }

  const change = round1(current - historical);
  return {
    metric,
    current_value: current,
    historical_average: historical,
    change,
    direction: change > 0 ? "INCREASE" : change < 0 ? "DECREASE" : "NO_CHANGE",
    status: "OK"
  };
}

async function getComparison(options = {}) {
  const window = resolvePeriod(options.period);
  if (!window) return null;

  const drainId = options.drainId ?? null;

  const previousStart = new Date(
    window.startTime.getTime() - PERIODS[window.period].ms
  );

  const [currentSensors, historical, previousIncidents, currentIncidents] =
    await Promise.all([
      // CURRENT values come from the live `sensors` row (source of truth).
      pool.query(
        `
        SELECT
          s.id AS sensor_id,
          s.drain_id,
          s.water_level,
          s.gas_level,
          s.temperature,
          s.recorded_at,
          d.zone_name,
          d.location
        FROM sensors s
        LEFT JOIN drains d ON d.id = s.drain_id
        WHERE ($1::int IS NULL OR s.drain_id = $1)
        ORDER BY s.drain_id ASC, s.id ASC
        `,
        [drainId]
      ),
      getSensorHistory({ period: window.period, drainId }),
      pool.query(
        `
        SELECT COUNT(*)::int AS count
        FROM incidents
        WHERE created_at >= $1 AND created_at < $2
          AND ($3::int IS NULL OR drain_id = $3)
        `,
        [previousStart, window.startTime, drainId]
      ),
      pool.query(
        `
        SELECT COUNT(*)::int AS count
        FROM incidents
        WHERE created_at >= $1 AND created_at <= $2
          AND ($3::int IS NULL OR drain_id = $3)
        `,
        [window.startTime, window.endTime, drainId]
      )
    ]);

  const historicalBySensor = new Map();
  for (const s of historical ? historical.sensors : []) {
    historicalBySensor.set(s.sensor_id, s);
  }

  const sensorComparisons = [];
  for (const row of currentSensors.rows) {
    const sensorId = Number(row.sensor_id);
    const hist = historicalBySensor.get(sensorId);
    if (!hist) {
      sensorComparisons.push({
        sensor_id: sensorId,
        drain_id: Number(row.drain_id),
        zone: row.zone_name || null,
        location: row.location || null,
        status: "INSUFFICIENT_DATA",
        metrics: []
      });
      continue;
    }

    const metrics = [
      buildComparisonRow(
        "water_level",
        row.water_level,
        hist.water_level.average
      ),
      buildComparisonRow("gas_level", row.gas_level, hist.gas_level.average),
      buildComparisonRow(
        "temperature",
        row.temperature,
        hist.temperature.average
      )
    ];

    sensorComparisons.push({
      sensor_id: sensorId,
      drain_id: Number(row.drain_id),
      zone: row.zone_name || null,
      location: row.location || null,
      current_timestamp: asIso(row.recorded_at),
      historical_latest_timestamp: hist.latest_timestamp,
      status: metrics.some((m) => m.status === "OK") ? "OK" : "INSUFFICIENT_DATA",
      metrics
    });
  }

  // Like-for-like incident comparison: current window vs the
  // immediately preceding window of the same length.
  const currentIncidentCount = Number(currentIncidents.rows[0].count);
  const previousIncidentCount = Number(previousIncidents.rows[0].count);
  const incidentChange = currentIncidentCount - previousIncidentCount;

  const incidentComparison = {
    current_period: currentIncidentCount,
    previous_period: previousIncidentCount,
    change: incidentChange,
    direction:
      incidentChange > 0
        ? "INCREASE"
        : incidentChange < 0
          ? "DECREASE"
          : "NO_CHANGE",
    previous_period_start: asIso(previousStart),
    previous_period_end: asIso(window.startTime),
    note: "CURRENT period is the selected window; PREVIOUS is the immediately preceding window of equal length."
  };

  const anySensorOk = sensorComparisons.some((c) => c.status === "OK");

  return {
    period: window.period,
    start_time: asIso(window.startTime),
    end_time: asIso(window.endTime),
    drain_id: drainId,
    status: anySensorOk ? "OK" : "INSUFFICIENT_DATA",
    current_label: "CURRENT (live sensors table)",
    historical_label: "HISTORICAL (window aggregate)",
    change_label: "CHANGE (current - historical)",
    sensor_comparison: sensorComparisons,
    incident_comparison: incidentComparison,
    note:
      "CURRENT and HISTORICAL are independent signals and are never merged into a single score.",
    disclaimer: HISTORICAL_DISCLAIMER,
    generated_at: new Date().toISOString()
  };
}

// ------------------------------------------------------------
// Overview (aggregate of all sections)
// ------------------------------------------------------------

async function getHistoricalOverview(options = {}) {
  const window = resolvePeriod(options.period);
  if (!window) return null;

  const drainId = options.drainId ?? null;
  const scoped = { period: window.period, drainId };

  const [sensors, incidents, missions, alerts, drains, patterns, comparison] =
    await Promise.all([
      getSensorHistory(scoped),
      getIncidentHistory(scoped),
      getMissionHistory(scoped),
      getAlertHistory(scoped),
      getDrainHistory(scoped),
      getTimePatterns(scoped),
      getComparison(scoped)
    ]);

  const totalRecords =
    sensors.reading_count +
    incidents.total +
    missions.total +
    alerts.total;

  const earliestCandidates = [
    sensors.data_quality.earliest_timestamp,
    incidents.earliest_timestamp,
    missions.earliest_timestamp,
    alerts.earliest_timestamp
  ].filter(Boolean);
  const latestCandidates = [
    sensors.data_quality.latest_timestamp,
    incidents.latest_timestamp,
    missions.latest_timestamp,
    alerts.latest_timestamp
  ].filter(Boolean);

  const earliest =
    earliestCandidates.length > 0
      ? earliestCandidates.slice().sort()[0]
      : null;
  const latest =
    latestCandidates.length > 0
      ? latestCandidates.slice().sort().pop()
      : null;

  return {
    period: window.period,
    start_time: asIso(window.startTime),
    end_time: asIso(window.endTime),
    drain_id: drainId,
    status: totalRecords > 0 ? "OK" : "INSUFFICIENT_DATA",
    record_count: totalRecords,
    sensors: {
      reading_count: sensors.reading_count,
      sensor_count: sensors.sensor_count,
      status: sensors.status,
      data_quality: sensors.data_quality.label
    },
    incidents: {
      total: incidents.total,
      active: incidents.active,
      resolved: incidents.resolved,
      by_severity: incidents.by_severity,
      status: incidents.status,
      data_quality: incidents.data_quality.label
    },
    missions: {
      total: missions.total,
      completed: missions.completed,
      completion_rate: missions.completion_rate,
      status: missions.status,
      data_quality: missions.data_quality.label
    },
    alerts: {
      total: alerts.total,
      unresolved: alerts.unresolved,
      status: alerts.status,
      data_quality: alerts.data_quality.label
    },
    drain_health: {
      drain_count: drains.drain_count,
      by_status: drains.drains.reduce((acc, d) => {
        acc[d.historical_health] = (acc[d.historical_health] || 0) + 1;
        return acc;
      }, {}),
      degraded_or_critical: drains.drains.filter(
        (d) =>
          d.historical_health === HEALTH.DEGRADED ||
          d.historical_health === HEALTH.CRITICAL
      ).length
    },
    patterns: {
      incidents: patterns.incidents,
      alerts: patterns.alerts
    },
    comparison,
    data_quality: buildDataQuality({
      window,
      recordCount: totalRecords,
      earliest,
      latest,
      missingSignals: [
        ...new Set([
          ...sensors.data_quality.missing_signals,
          ...incidents.data_quality.missing_signals,
          ...missions.data_quality.missing_signals,
          ...alerts.data_quality.missing_signals,
          ...drains.missing_signals
        ])
      ],
      tablesUsed: [
        "drains",
        "sensors",
        "sensor_readings",
        "incidents",
        "missions",
        "alerts",
        "maintenance_predictions",
        "drain_vision_inspections"
      ]
    }),
    disclaimer: HISTORICAL_DISCLAIMER,
    generated_at: new Date().toISOString()
  };
}

// ------------------------------------------------------------
// Compact summary (for dashboards / analytics)
// ------------------------------------------------------------

async function getHistoricalSummary(options = {}) {
  const overview = await getHistoricalOverview(options);
  if (!overview) return null;

  const drains = await getDrainHistory(options);
  const recurring = (drains ? drains.drains : [])
    .filter((d) => d.incident_count >= 2)
    .sort((a, b) => b.incident_count - a.incident_count)
    .slice(0, 5)
    .map((d) => ({
      drain_id: d.drain_id,
      zone: d.zone,
      location: d.location,
      incident_count: d.incident_count,
      historical_health: d.historical_health
    }));

  const comparison = overview.comparison
    ? overview.comparison.incident_comparison
    : null;

  let recentTrend = TREND.INSUFFICIENT_DATA;
  if (comparison) {
    if (comparison.current_period === 0 && comparison.previous_period === 0) {
      recentTrend = TREND.INSUFFICIENT_DATA;
    } else if (comparison.direction === "INCREASE") {
      recentTrend = TREND.RISING;
    } else if (comparison.direction === "DECREASE") {
      recentTrend = TREND.FALLING;
    } else {
      recentTrend = TREND.STABLE;
    }
  }

  return {
    period: overview.period,
    start_time: overview.start_time,
    end_time: overview.end_time,
    historical_incident_count: overview.incidents.total,
    historical_resolved_count: overview.incidents.resolved,
    historical_mission_count: overview.missions.total,
    historical_alert_count: overview.alerts.total,
    historical_sensor_reading_count: overview.sensors.reading_count,
    recurrent_drain_count: (drains ? drains.drains : []).filter(
      (d) => d.incident_count >= 2
    ).length,
    degraded_drain_count: overview.drain_health.degraded_or_critical,
    historical_data_quality: overview.data_quality.label,
    historical_sufficient_data: overview.data_quality.sufficient_data,
    drain_health_by_status: overview.drain_health.by_status,
    top_recurring_drains: recurring,
    recent_historical_trend: recentTrend,
    disclaimer: HISTORICAL_DISCLAIMER,
    generated_at: overview.generated_at
  };
}

// ------------------------------------------------------------
// Dashboard integration (additive, camelCase to match dashboard)
// ------------------------------------------------------------

async function getDashboardSummary(options = {}) {
  const summary = await getHistoricalSummary({
    period: options.period || DEFAULT_PERIOD,
    drainId: options.drainId ?? null
  });

  if (!summary) {
    return {
      period: DEFAULT_PERIOD,
      historicalIncidentCount: 0,
      recurrentDrainCount: 0,
      degradedDrainCount: 0,
      historicalDataQuality: DATA_QUALITY.INSUFFICIENT_DATA,
      topRecurringDrains: [],
      recentHistoricalTrend: TREND.INSUFFICIENT_DATA
    };
  }

  return {
    period: summary.period,
    historicalIncidentCount: summary.historical_incident_count,
    recurrentDrainCount: summary.recurrent_drain_count,
    degradedDrainCount: summary.degraded_drain_count,
    historicalDataQuality: summary.historical_data_quality,
    topRecurringDrains: summary.top_recurring_drains,
    recentHistoricalTrend: summary.recent_historical_trend
  };
}

// ------------------------------------------------------------
// Analytics integration (additive, snake_case to match analytics)
// ------------------------------------------------------------

async function getAnalytics(options = {}) {
  const period = options.period || DEFAULT_PERIOD;
  const summary = await getHistoricalSummary({ period });

  if (!summary) {
    return {
      historical_period: period,
      historical_incident_count: 0,
      historical_resolved_incident_count: 0,
      historical_mission_count: 0,
      historical_alert_count: 0,
      historical_recurrent_drain_count: 0,
      historical_degraded_drain_count: 0,
      historical_data_quality: DATA_QUALITY.INSUFFICIENT_DATA
    };
  }

  return {
    historical_period: summary.period,
    historical_incident_count: summary.historical_incident_count,
    historical_resolved_incident_count: summary.historical_resolved_count,
    historical_mission_count: summary.historical_mission_count,
    historical_alert_count: summary.historical_alert_count,
    historical_sensor_reading_count: summary.historical_sensor_reading_count,
    historical_recurrent_drain_count: summary.recurrent_drain_count,
    historical_degraded_drain_count: summary.degraded_drain_count,
    historical_data_quality: summary.historical_data_quality,
    historical_recent_trend: summary.recent_historical_trend,
    historical_top_recurring_drains: summary.top_recurring_drains
  };
}

// ------------------------------------------------------------
// Live emission (shared socketHub, signature-guarded so the event is
// never emitted on every tick — only when the historical state
// meaningfully changes). Reserved for the live-emission wiring; it is
// exported and tested here so the historical layer already owns the
// deduplication contract.
// ------------------------------------------------------------

let lastHistoricalSignature = null;

function buildSignature(summary) {
  if (!summary) return "null";
  const healthSig = Object.entries(summary.drain_health_by_status || {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}:${v}`)
    .join(",");

  return [
    summary.period,
    summary.historical_incident_count,
    summary.historical_resolved_count,
    summary.historical_mission_count,
    summary.historical_alert_count,
    summary.historical_sensor_reading_count,
    summary.recurrent_drain_count,
    summary.degraded_drain_count,
    summary.historical_data_quality,
    summary.recent_historical_trend,
    healthSig
  ].join("|");
}

async function evaluateAndEmitHistoricalIntelligence(options = {}) {
  const summary = await getHistoricalSummary(options);
  if (!summary) return { emitted: false, summary: null };

  const signature = buildSignature(summary);

  if (signature === lastHistoricalSignature) {
    return { emitted: false, summary };
  }

  lastHistoricalSignature = signature;
  socketHub.emit("historicalIntelligenceUpdate", {
    period: summary.period,
    summary: {
      historical_incident_count: summary.historical_incident_count,
      historical_resolved_count: summary.historical_resolved_count,
      historical_mission_count: summary.historical_mission_count,
      historical_alert_count: summary.historical_alert_count,
      recurrent_drain_count: summary.recurrent_drain_count,
      degraded_drain_count: summary.degraded_drain_count,
      historical_data_quality: summary.historical_data_quality,
      recent_historical_trend: summary.recent_historical_trend,
      drain_health_by_status: summary.drain_health_by_status
    },
    generated_at: summary.generated_at
  });

  return { emitted: true, summary };
}

function resetHistoricalIntelligenceRuntime() {
  lastHistoricalSignature = null;
}

// ------------------------------------------------------------
// Exports
// ------------------------------------------------------------

module.exports = {
  // constants
  PERIODS,
  DEFAULT_PERIOD,
  VALID_PERIODS,
  DATA_QUALITY,
  TREND,
  HEALTH,
  HEALTH_THRESHOLDS,
  TREND_THRESHOLDS,
  MIN_TREND_READINGS,
  MIN_PARTIAL_RECORDS,
  MIN_COMPLETE_RECORDS,
  MIN_PATTERN_SAMPLES,
  WEEKDAY_NAMES,
  HISTORICAL_DISCLAIMER,
  // validation + helpers
  isValidPeriod,
  resolvePeriod,
  parseDrainId,
  classifyDataQuality,
  buildDataQuality,
  computeTrend,
  buildMetricSummary,
  computeDrainHealth,
  // views
  getSensorHistory,
  getDrainHistory,
  getIncidentHistory,
  getMissionHistory,
  getAlertHistory,
  getTimePatterns,
  getComparison,
  getHistoricalOverview,
  getHistoricalSummary,
  getDashboardSummary,
  getAnalytics,
  // live emission
  buildSignature,
  evaluateAndEmitHistoricalIntelligence,
  resetHistoricalIntelligenceRuntime
};
