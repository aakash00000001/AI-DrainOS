// ============================================================
// AI-DrainOS Sensor Intelligence & Anomaly Detection
// (Update #21)
//
// Additive intelligence layer on top of the EXISTING sensor
// pipeline (sensors + sensor_readings written by the MQTT service
// and the simulator). It performs:
//
//   * Bounded rolling-window analysis (10-30 readings, never
//     unlimited) of the existing water_level / gas_level /
//     temperature channels.
//   * Explainable anomaly detection: SPIKE, DROP, RAPID_CHANGE,
//     STUCK_SENSOR, STALE_SENSOR, MISSING_DATA, OUT_OF_RANGE and
//     NOISE / INSTABILITY.
//   * A bounded 0-100 sensor health score with an honest
//     INSUFFICIENT_DATA status when there is not enough history.
//   * Drain-level aggregation and cross-sensor comparison.
//
// Design rules:
//  * Never fabricates readings, anomaly values, confidence or
//    history. Everything comes from real sensor_readings rows.
//  * Never rewrites or replaces the existing flood risk / forecast
//    / maintenance / decision formulas. It only exposes ADDITIVE
//    context that those engines may optionally consume.
//  * Never touches missionEngine.js and never dispatches robots.
//  * Severe sensor-integrity issues may open at most ONE incident
//    per drain through the existing incidentService (source
//    SENSOR) - deduped and cooldown-guarded to avoid incident
//    storms.
//  * Live `sensorIntelligenceUpdate` events use the shared
//    socketHub and are signature-guarded so the event is never
//    emitted on every 5 s tick.
// ============================================================

const pool = require("../config/db");
const socketHub = require("./socketHub");
const incidentService = require("./incidentService");

// ------------------------------------------------------------
// Constants
// ------------------------------------------------------------

// Preferred bounded rolling window: 10-30 readings per channel.
const HISTORY_WINDOW = 20;
const MIN_READINGS = 10;
const MAX_READINGS = 30;

const CHANNELS = ["water_level", "gas_level", "temperature"];

// Physical ranges actually enforced by the existing MQTT payload
// validator - reused here so OUT_OF_RANGE is only ever reported
// where a defensible physical range genuinely exists.
const CHANNEL_RANGES = {
  water_level: { min: 0, max: 100, unit: "%", label: "Water level" },
  gas_level: { min: 0, max: 100, unit: "%", label: "Gas level" },
  temperature: { min: -40, max: 65, unit: "°C", label: "Temperature" }
};

// Single-sample jump that is significant for each channel,
// independent of the observed step noise.
const STEP_THRESHOLDS = {
  water_level: 25,
  gas_level: 25,
  temperature: 12
};

// Scale factor applied to the median absolute step so a genuinely
// noisy sensor is not flagged for its normal jitter.
const STEP_SCALE = 6;

// Cumulative change across the window consistent with a rapid
// change rather than a single spike.
const RAPID_THRESHOLDS = {
  water_level: 40,
  gas_level: 40,
  temperature: 20
};

const STUCK_MAX_VARIANCE = 0.5;
const STUCK_MIN_READINGS = 10;
const STUCK_MIN_SPAN_MS = 30 * 60 * 1000;

const NOISE_MIN_STEPS = 5;
const NOISE_SIGN_FLIP_RATIO = 0.7;
const NOISE_MIN_MEAN_ABS_STEP = 2;

const STALE_AFTER_MS = 15 * 60 * 1000;
const MISSING_GAP_MS = 10 * 60 * 1000;

const CONSISTENCY_TOLERANCE = 30;

const HEALTH_STATUS = {
  HEALTHY: "HEALTHY",
  GOOD: "GOOD",
  DEGRADED: "DEGRADED",
  POOR: "POOR",
  CRITICAL: "CRITICAL",
  INSUFFICIENT_DATA: "INSUFFICIENT_DATA"
};

const HEALTH_BANDS = [
  { status: HEALTH_STATUS.CRITICAL, min: 0, max: 24 },
  { status: HEALTH_STATUS.POOR, min: 25, max: 49 },
  { status: HEALTH_STATUS.DEGRADED, min: 50, max: 74 },
  { status: HEALTH_STATUS.GOOD, min: 75, max: 89 },
  { status: HEALTH_STATUS.HEALTHY, min: 90, max: 100 }
];

const ANOMALY_TYPE = {
  SPIKE: "SPIKE",
  DROP: "DROP",
  RAPID_CHANGE: "RAPID_CHANGE",
  STUCK_SENSOR: "STUCK_SENSOR",
  STALE_SENSOR: "STALE_SENSOR",
  MISSING_DATA: "MISSING_DATA",
  OUT_OF_RANGE: "OUT_OF_RANGE",
  NOISE: "NOISE"
};

const SEVERITY = {
  LOW: "LOW",
  MODERATE: "MODERATE",
  HIGH: "HIGH",
  CRITICAL: "CRITICAL"
};

const SEVERITY_RANK = {
  CRITICAL: 4,
  HIGH: 3,
  MODERATE: 2,
  LOW: 1
};

const SEVERITY_PENALTY = {
  LOW: 3,
  MODERATE: 8,
  HIGH: 15,
  CRITICAL: 25
};

const MAX_ANOMALY_PENALTY = 60;

const INCIDENT_COOLDOWN_MS = 10 * 60 * 1000;

// Short-lived TTL for the additive context exposed to the existing
// flood risk / forecast / maintenance / decision engines. The context
// is read-only and bounded, but the hot path recomputes it frequently,
// so it is cached ~15 s per drain instead of once per reading.
const CONTEXT_CACHE_TTL_MS = 15 * 1000;

const SENSOR_DISCLAIMER =
  "Sensor intelligence describes observed sensor patterns only. It does not diagnose a root cause and never replaces the flood risk, forecast, maintenance or decision engines.";

// Signature-guarded emission state (global + per drain).
let lastGlobalSignature = null;
const lastDrainSignatures = new Map();
const lastIncidentAt = new Map();

// Additive per-drain context cache (bounded TTL, pruned on write).
const sensorContextCache = new Map();

// ------------------------------------------------------------
// Small helpers (pure)
// ------------------------------------------------------------

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function finiteNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function nowIso() {
  return new Date().toISOString();
}

function toIso(value) {
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function toMs(value) {
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function healthStatusFromScore(score) {
  if (score === null || score === undefined || !Number.isFinite(Number(score))) {
    return HEALTH_STATUS.INSUFFICIENT_DATA;
  }

  const value = Number(score);
  const band = HEALTH_BANDS.find((b) => value >= b.min && value <= b.max);
  return band ? band.status : HEALTH_STATUS.INSUFFICIENT_DATA;
}

function mean(values) {
  if (values.length === 0) {
    return null;
  }
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function variance(values) {
  const avg = mean(values);
  if (avg === null) {
    return null;
  }
  return values.reduce((sum, v) => sum + (v - avg) ** 2, 0) / values.length;
}

function severityForMagnitude(magnitude, threshold) {
  if (!Number.isFinite(magnitude) || !Number.isFinite(threshold) || threshold <= 0) {
    return SEVERITY.MODERATE;
  }

  const ratio = magnitude / threshold;

  if (ratio >= 2) {
    return SEVERITY.CRITICAL;
  }
  if (ratio >= 1.5) {
    return SEVERITY.HIGH;
  }
  return SEVERITY.MODERATE;
}

function sortAnomalies(anomalies) {
  return [...anomalies].sort((a, b) => {
    const rank = (SEVERITY_RANK[b.severity] || 0) - (SEVERITY_RANK[a.severity] || 0);
    if (rank !== 0) {
      return rank;
    }
    return String(a.type).localeCompare(String(b.type));
  });
}

// ------------------------------------------------------------
// Reading access (bounded)
// ------------------------------------------------------------

async function getSensorReadings(sensorId, limit = HISTORY_WINDOW) {
  const bounded = clamp(Number(limit) || HISTORY_WINDOW, 2, MAX_READINGS);

  const result = await pool.query(
    `
    SELECT water_level, gas_level, temperature, recorded_at
    FROM sensor_readings
    WHERE sensor_id = $1
    ORDER BY recorded_at DESC, id DESC
    LIMIT $2
    `,
    [sensorId, bounded]
  );

  // Chronological order (oldest first) for deterministic analysis.
  return result.rows
    .map((row) => ({
      water_level: finiteNumber(row.water_level),
      gas_level: finiteNumber(row.gas_level),
      temperature: finiteNumber(row.temperature),
      recordedAt: toMs(row.recorded_at)
    }))
    .reverse();
}

// ------------------------------------------------------------
// Anomaly detection (pure)
// ------------------------------------------------------------

function windowLabel(readings) {
  if (readings.length === 0) {
    return { start: null, end: null, samples: 0 };
  }

  return {
    start: toIso(readings[0].recordedAt),
    end: toIso(readings[readings.length - 1].recordedAt),
    samples: readings.length
  };
}

function detectAnomalies({ sensorId, drainId, readings, now, sensor }) {
  const anomalies = [];
  const detectedAt = new Date(now).toISOString();

  function push(type, severity, message, evidence) {
    anomalies.push({
      type,
      severity,
      sensorId: Number(sensorId),
      drainId: Number(drainId),
      detectedAt,
      message,
      evidence,
      affectedWindow: windowLabel(readings)
    });
  }

  if (readings.length === 0) {
    return anomalies;
  }

  const latest = readings[readings.length - 1];

  // OUT_OF_RANGE - only where a real physical range exists.
  for (const channel of CHANNELS) {
    const range = CHANNEL_RANGES[channel];
    const outOfRange = readings.filter((r) => {
      const value = r[channel];
      return value === null || value < range.min || value > range.max;
    });

    if (outOfRange.length > 0) {
      const worst = outOfRange[outOfRange.length - 1];
      push(
        ANOMALY_TYPE.OUT_OF_RANGE,
        SEVERITY.HIGH,
        `${range.label} reading ${worst[channel]}${range.unit} falls outside the physically valid ${range.min}-${range.max}${range.unit} range`,
        {
          channel,
          value: worst[channel],
          min: range.min,
          max: range.max,
          unit: range.unit,
          outOfRangeCount: outOfRange.length,
          window: readings.length
        }
      );
    }
  }

  // STALE_SENSOR - latest reading is old relative to now.
  if (latest.recordedAt !== null && now - latest.recordedAt > STALE_AFTER_MS) {
    const ageMinutes = Math.round((now - latest.recordedAt) / 60000);
    push(
      ANOMALY_TYPE.STALE_SENSOR,
      SEVERITY.HIGH,
      `The latest recorded reading is ${ageMinutes} min old, which is consistent with a sensor that has stopped reporting`,
      {
        ageMinutes,
        staleAfterMinutes: STALE_AFTER_MS / 60000,
        lastReadingAt: toIso(latest.recordedAt)
      }
    );
  }

  // MISSING_DATA - a real gap between recorded readings.
  if (readings.length >= 2) {
    let maxGap = 0;
    let gapIndex = 0;

    for (let i = 1; i < readings.length; i += 1) {
      if (readings[i].recordedAt === null || readings[i - 1].recordedAt === null) {
        continue;
      }
      const gap = readings[i].recordedAt - readings[i - 1].recordedAt;
      if (gap > maxGap) {
        maxGap = gap;
        gapIndex = i;
      }
    }

    if (maxGap > MISSING_GAP_MS) {
      push(
        ANOMALY_TYPE.MISSING_DATA,
        SEVERITY.MODERATE,
        `A ${Math.round(maxGap / 60000)} min gap exists between recorded readings, which is consistent with missing sensor data`,
        {
          gapMinutes: Math.round(maxGap / 60000),
          gapAfter: toIso(readings[gapIndex - 1].recordedAt),
          resumedAt: toIso(readings[gapIndex].recordedAt),
          window: readings.length
        }
      );
    }
  }

  // Per-channel step / trend / stuck / noise detection.
  for (const channel of CHANNELS) {
    const ranged = readings.filter((r) => r[channel] !== null);

    if (ranged.length < 3) {
      continue;
    }

    const values = ranged.map((r) => r[channel]);
    const stamps = ranged.map((r) => r.recordedAt);

    const steps = [];
    for (let i = 1; i < values.length; i += 1) {
      steps.push(values[i] - values[i - 1]);
    }

    const positiveAbs = steps.map(Math.abs).filter((v) => v > 0).sort((a, b) => a - b);
    const medianAbs = positiveAbs.length > 0
      ? positiveAbs[Math.floor(positiveAbs.length / 2)]
      : 0;
    const threshold = Math.max(
      STEP_THRESHOLDS[channel],
      medianAbs * STEP_SCALE
    );

    // SPIKE / DROP - the largest single-step jump beyond threshold.
    let bestSpike = null;
    let bestDrop = null;

    steps.forEach((step, i) => {
      if (Math.abs(step) <= threshold) {
        return;
      }

      const record = {
        delta: step,
        from: values[i],
        to: values[i + 1],
        at: toIso(stamps[i + 1])
      };

      if (step > 0 && (!bestSpike || step > bestSpike.delta)) {
        bestSpike = record;
      }
      if (step < 0 && (!bestDrop || step < bestDrop.delta)) {
        bestDrop = record;
      }
    });

    const range = CHANNEL_RANGES[channel];

    if (bestSpike) {
      push(
        ANOMALY_TYPE.SPIKE,
        severityForMagnitude(bestSpike.delta, threshold),
        `${range.label} jumped ${bestSpike.delta}${range.unit} from ${bestSpike.from} to ${bestSpike.to} in a single reading, which is consistent with a spike`,
        { channel, ...bestSpike, unit: range.unit, threshold: round1(threshold) }
      );
    }

    if (bestDrop) {
      push(
        ANOMALY_TYPE.DROP,
        severityForMagnitude(Math.abs(bestDrop.delta), threshold),
        `${range.label} dropped ${Math.abs(bestDrop.delta)}${range.unit} from ${bestDrop.from} to ${bestDrop.to} in a single reading, which is consistent with a sudden drop`,
        { channel, ...bestDrop, unit: range.unit, threshold: round1(threshold) }
      );
    }

    // RAPID_CHANGE - sustained change across the whole window.
    const net = values[values.length - 1] - values[0];
    const rapid = RAPID_THRESHOLDS[channel];

    if (Math.abs(net) >= rapid) {
      const direction = net > 0 ? "rise" : "fall";
      push(
        ANOMALY_TYPE.RAPID_CHANGE,
        severityForMagnitude(Math.abs(net), rapid),
        `${range.label} shows a sustained ${direction} of ${Math.abs(net)}${range.unit} across the analysed window, which is consistent with a rapid change`,
        {
          channel,
          netChange: net,
          from: values[0],
          to: values[values.length - 1],
          threshold: rapid,
          unit: range.unit
        }
      );
    }

    // STUCK_SENSOR - essentially constant values over a meaningful span.
    const minValue = Math.min(...values);
    const maxValue = Math.max(...values);
    const spanMs =
      stamps[stamps.length - 1] !== null && stamps[0] !== null
        ? stamps[stamps.length - 1] - stamps[0]
        : 0;

    if (
      values.length >= STUCK_MIN_READINGS &&
      maxValue - minValue <= STUCK_MAX_VARIANCE &&
      spanMs >= STUCK_MIN_SPAN_MS
    ) {
      push(
        ANOMALY_TYPE.STUCK_SENSOR,
        SEVERITY.HIGH,
        `${range.label} stayed within ${round1(maxValue - minValue)}${range.unit} across ${values.length} readings, which is consistent with a stuck sensor`,
        {
          channel,
          min: minValue,
          max: maxValue,
          spanMinutes: Math.round(spanMs / 60000),
          readings: values.length,
          unit: range.unit
        }
      );
    }

    // NOISE / INSTABILITY - values oscillate without a clear direction.
    if (steps.length >= NOISE_MIN_STEPS) {
      let flips = 0;
      for (let i = 1; i < steps.length; i += 1) {
        if (steps[i] !== 0 && steps[i - 1] !== 0 && Math.sign(steps[i]) !== Math.sign(steps[i - 1])) {
          flips += 1;
        }
      }

      const flipRatio = flips / (steps.length - 1);
      const meanAbsStep = mean(steps.map(Math.abs)) || 0;

      if (flipRatio >= NOISE_SIGN_FLIP_RATIO && meanAbsStep >= NOISE_MIN_MEAN_ABS_STEP) {
        push(
          ANOMALY_TYPE.NOISE,
          SEVERITY.LOW,
          `${range.label} oscillates without a clear direction across ${steps.length} changes, which is consistent with unstable or noisy readings`,
          {
            channel,
            signFlips: flips,
            flipRatio: round1(flipRatio),
            meanAbsStep: round1(meanAbsStep),
            unit: range.unit
          }
        );
      }
    }
  }

  return sortAnomalies(anomalies);
}

// ------------------------------------------------------------
// Health scoring (pure)
// ------------------------------------------------------------

function computeSignals({ readings, now, sensor }) {
  const water = readings.map((r) => r.water_level).filter((v) => v !== null);
  const latest = readings.length > 0 ? readings[readings.length - 1] : null;
  const first = readings.length > 0 ? readings[0] : null;
  const spanMs =
    first && first.recordedAt !== null && latest && latest.recordedAt !== null
      ? latest.recordedAt - first.recordedAt
      : 0;

  return {
    readingsAnalysed: readings.length,
    windowMinutes: spanMs > 0 ? Math.round(spanMs / 60000) : 0,
    windowStart: first ? toIso(first.recordedAt) : null,
    windowEnd: latest ? toIso(latest.recordedAt) : null,
    latestReadingAt: latest ? toIso(latest.recordedAt) : null,
    latestWaterLevel: latest ? latest.water_level : null,
    latestGasLevel: latest ? latest.gas_level : null,
    latestTemperature: latest ? latest.temperature : null,
    dataCompleteness: round1(Math.min(1, readings.length / HISTORY_WINDOW)),
    waterMean: water.length > 0 ? round1(mean(water)) : null,
    waterVariance: water.length > 0 ? round1(variance(water)) : null,
    ageMinutes:
      latest && latest.recordedAt !== null
        ? Math.max(0, Math.round((now - latest.recordedAt) / 60000))
        : null,
    sensorStatus: sensor ? sensor.sensor_status : null,
    declaredStatus: sensor ? sensor.status : null
  };
}

function computeHealth({ readings, anomalies, now, sensor }) {
  const signals = computeSignals({ readings, now, sensor });

  if (readings.length < MIN_READINGS) {
    return {
      healthScore: null,
      healthStatus: HEALTH_STATUS.INSUFFICIENT_DATA,
      reasons: [
        `Only ${readings.length} recorded reading(s) are available; at least ${MIN_READINGS} are required for a health assessment (INSUFFICIENT_DATA).`
      ],
      signals
    };
  }

  let score = 100;
  const reasons = [];

  const latest = readings[readings.length - 1];
  if (latest.recordedAt !== null && now - latest.recordedAt > STALE_AFTER_MS) {
    score -= 30;
    reasons.push("The sensor has not reported within the expected interval.");
  }

  if (sensor && sensor.sensor_status && sensor.sensor_status !== "Active") {
    score -= 20;
    reasons.push(`The sensor is marked "${sensor.sensor_status}" in the sensors table.`);
  }

  if (signals.dataCompleteness < 1) {
    const missing = round1((1 - signals.dataCompleteness) * 100);
    score -= Math.round(missing / 5);
    reasons.push(
      `The rolling window is ${round1(signals.dataCompleteness * 100)}% populated (bounded ${HISTORY_WINDOW}-reading window).`
    );
  }

  let anomalyPenalty = 0;
  anomalies.forEach((anomaly) => {
    anomalyPenalty += SEVERITY_PENALTY[anomaly.severity] || 0;
  });
  anomalyPenalty = Math.min(anomalyPenalty, MAX_ANOMALY_PENALTY);

  if (anomalyPenalty > 0) {
    score -= anomalyPenalty;
    reasons.push(
      `${anomalies.length} anomaly signal(s) detected (${anomalies
        .slice(0, 3)
        .map((a) => `${a.type}/${a.severity}`)
        .join(", ")}${anomalies.length > 3 ? ", ..." : ""}).`
    );
  }

  if (anomalies.length === 0) {
    reasons.push("No anomaly signals detected in the analysed window.");
  }

  const bounded = clamp(Math.round(score), 0, 100);

  return {
    healthScore: bounded,
    healthStatus: healthStatusFromScore(bounded),
    reasons,
    signals
  };
}

// ------------------------------------------------------------
// Per-sensor intelligence (pure assembly + DB read)
// ------------------------------------------------------------

function buildSensorIntelligence({ sensor, readings, now }) {
  const sensorId = Number(sensor.id);
  const drainId = Number(sensor.drain_id);

  const anomalies = detectAnomalies({
    sensorId,
    drainId,
    readings,
    now,
    sensor
  });

  const health = computeHealth({ readings, anomalies, now, sensor });

  return {
    sensorId,
    drainId,
    drainLocation: sensor.location || null,
    zone: sensor.zone_name || null,
    sensorStatus: sensor.sensor_status || null,
    declaredStatus: sensor.status || null,
    healthScore: health.healthScore,
    healthStatus: health.healthStatus,
    reasons: health.reasons,
    signals: health.signals,
    anomalyCount: anomalies.length,
    anomalies,
    latestAnomaly: anomalies.length > 0 ? anomalies[0] : null,
    stale: anomalies.some((a) => a.type === ANOMALY_TYPE.STALE_SENSOR),
    missingData: anomalies.some((a) => a.type === ANOMALY_TYPE.MISSING_DATA),
    outOfRange: anomalies.some((a) => a.type === ANOMALY_TYPE.OUT_OF_RANGE),
    generatedAt: new Date(now).toISOString()
  };
}

async function getSensorIntelligenceById(sensorId, { now = Date.now() } = {}) {
  if (!Number.isInteger(Number(sensorId)) || Number(sensorId) <= 0) {
    return null;
  }

  const sensorResult = await pool.query(
    `
    SELECT s.*, d.location, d.zone_name
    FROM sensors s
    LEFT JOIN drains d ON d.id = s.drain_id
    WHERE s.id = $1
    `,
    [Number(sensorId)]
  );

  if (sensorResult.rows.length === 0) {
    return null;
  }

  const sensor = sensorResult.rows[0];
  const readings = await getSensorReadings(sensor.id);

  return buildSensorIntelligence({ sensor, readings, now });
}

// ------------------------------------------------------------
// All sensors (bounded, one query for sensors + per-sensor window)
// ------------------------------------------------------------

async function getAllSensorsWithReadings({ now = Date.now() } = {}) {
  const sensorResult = await pool.query(
    `
    SELECT s.*, d.location, d.zone_name
    FROM sensors s
    LEFT JOIN drains d ON d.id = s.drain_id
    ORDER BY s.id ASC
    `
  );

  const sensors = [];

  for (const sensor of sensorResult.rows) {
    const readings = await getSensorReadings(sensor.id);
    sensors.push(buildSensorIntelligence({ sensor, readings, now }));
  }

  return sensors;
}

// ------------------------------------------------------------
// Drain aggregation (pure)
// ------------------------------------------------------------

function buildCrossSensorConsistency(sensors) {
  const withWater = sensors.filter(
    (s) => s.signals && s.signals.latestWaterLevel !== null && s.signals.latestWaterLevel !== undefined
  );

  if (withWater.length < 2) {
    return {
      status: "INSUFFICIENT_DATA",
      sensorsCompared: withWater.length,
      maxDifference: null,
      tolerance: CONSISTENCY_TOLERANCE,
      message:
        "Cross-sensor consistency requires at least two sensors with recorded water levels."
    };
  }

  const levels = withWater.map((s) => s.signals.latestWaterLevel);
  const maxDifference = round1(Math.max(...levels) - Math.min(...levels));
  const consistent = maxDifference <= CONSISTENCY_TOLERANCE;

  return {
    status: consistent ? "CONSISTENT" : "INCONSISTENT",
    sensorsCompared: withWater.length,
    maxDifference,
    tolerance: CONSISTENCY_TOLERANCE,
    message: consistent
      ? `The ${withWater.length} sensors on this drain report water levels within ${CONSISTENCY_TOLERANCE}% of each other, which is consistent with agreement between sensors.`
      : `The ${withWater.length} sensors on this drain differ by ${maxDifference}%, which is consistent with disagreement between sensors.`
  };
}

function summarizeCounts(list) {
  const counts = {
    total: list.length,
    healthy: 0,
    good: 0,
    degraded: 0,
    poor: 0,
    critical: 0,
    insufficientData: 0
  };

  list.forEach((item) => {
    switch (item.healthStatus) {
      case HEALTH_STATUS.HEALTHY:
        counts.healthy += 1;
        break;
      case HEALTH_STATUS.GOOD:
        counts.good += 1;
        break;
      case HEALTH_STATUS.DEGRADED:
        counts.degraded += 1;
        break;
      case HEALTH_STATUS.POOR:
        counts.poor += 1;
        break;
      case HEALTH_STATUS.CRITICAL:
        counts.critical += 1;
        break;
      default:
        counts.insufficientData += 1;
    }
  });

  return counts;
}

function worstHealthStatus(sensors) {
  if (sensors.length === 0) {
    return HEALTH_STATUS.INSUFFICIENT_DATA;
  }

  const order = [
    HEALTH_STATUS.CRITICAL,
    HEALTH_STATUS.POOR,
    HEALTH_STATUS.DEGRADED,
    HEALTH_STATUS.GOOD,
    HEALTH_STATUS.HEALTHY,
    HEALTH_STATUS.INSUFFICIENT_DATA
  ];

  const present = new Set(sensors.map((s) => s.healthStatus));
  return order.find((status) => present.has(status)) || HEALTH_STATUS.INSUFFICIENT_DATA;
}

function buildDrainAggregate(drainId, drainInfo, sensors) {
  const counts = summarizeCounts(sensors);
  const anomalies = sensors.flatMap((s) => s.anomalies || []);

  const byType = {};
  const bySeverity = {};

  anomalies.forEach((a) => {
    byType[a.type] = (byType[a.type] || 0) + 1;
    bySeverity[a.severity] = (bySeverity[a.severity] || 0) + 1;
  });

  const scored = sensors.filter((s) => s.healthScore !== null && s.healthScore !== undefined);
  const averageHealthScore =
    scored.length > 0
      ? round1(scored.reduce((sum, s) => sum + s.healthScore, 0) / scored.length)
      : null;

  return {
    drainId: Number(drainId),
    zone: drainInfo ? drainInfo.zone_name : null,
    location: drainInfo ? drainInfo.location : null,
    status: "OK",
    totalSensors: sensors.length,
    counts,
    averageHealthScore,
    overallHealthStatus: worstHealthStatus(sensors),
    anomalyCount: anomalies.length,
    anomaliesByType: byType,
    anomaliesBySeverity: bySeverity,
    staleCount: sensors.filter((s) => s.stale).length,
    missingDataCount: sensors.filter((s) => s.missingData).length,
    outOfRangeCount: sensors.filter((s) => s.outOfRange).length,
    crossSensorConsistency: buildCrossSensorConsistency(sensors),
    sensors,
    generatedAt: nowIso()
  };
}

async function getDrainSensorIntelligence(drainId, { now = Date.now() } = {}) {
  if (!Number.isInteger(Number(drainId)) || Number(drainId) <= 0) {
    return null;
  }

  const drainResult = await pool.query(
    "SELECT id, zone_name, location FROM drains WHERE id = $1",
    [Number(drainId)]
  );

  if (drainResult.rows.length === 0) {
    return null;
  }

  const sensorResult = await pool.query(
    `
    SELECT s.*, d.location, d.zone_name
    FROM sensors s
    LEFT JOIN drains d ON d.id = s.drain_id
    WHERE s.drain_id = $1
    ORDER BY s.id ASC
    `,
    [Number(drainId)]
  );

  const sensors = [];

  for (const sensor of sensorResult.rows) {
    const readings = await getSensorReadings(sensor.id);
    sensors.push(buildSensorIntelligence({ sensor, readings, now }));
  }

  const aggregate = buildDrainAggregate(drainId, drainResult.rows[0], sensors);

  return {
    status: sensors.length > 0 ? "OK" : "NO_SENSORS",
    drain: {
      drainId: Number(drainId),
      zone: drainResult.rows[0].zone_name,
      location: drainResult.rows[0].location
    },
    ...aggregate
  };
}

// ------------------------------------------------------------
// Fleet-wide views
// ------------------------------------------------------------

function buildSummary(sensors) {
  const counts = summarizeCounts(sensors);
  const anomalies = sensors.flatMap((s) => s.anomalies || []);

  const anomaliesByType = {};
  const anomaliesBySeverity = {};

  anomalies.forEach((a) => {
    anomaliesByType[a.type] = (anomaliesByType[a.type] || 0) + 1;
    anomaliesBySeverity[a.severity] = (anomaliesBySeverity[a.severity] || 0) + 1;
  });

  const scored = sensors.filter((s) => s.healthScore !== null && s.healthScore !== undefined);
  const averageHealthScore =
    scored.length > 0
      ? round1(scored.reduce((sum, s) => sum + s.healthScore, 0) / scored.length)
      : null;

  const affectedDrains = new Set(
    sensors.filter((s) => s.anomalyCount > 0).map((s) => s.drainId)
  );

  return {
    totalSensors: sensors.length,
    counts,
    averageHealthScore,
    overallHealthStatus: worstHealthStatus(sensors),
    anomalyCount: anomalies.length,
    anomaliesByType,
    anomaliesBySeverity,
    staleSensors: sensors.filter((s) => s.stale).length,
    missingDataSensors: sensors.filter((s) => s.missingData).length,
    outOfRangeSensors: sensors.filter((s) => s.outOfRange).length,
    affectedDrains: affectedDrains.size,
    healthDistribution: {
      HEALTHY: counts.healthy,
      GOOD: counts.good,
      DEGRADED: counts.degraded,
      POOR: counts.poor,
      CRITICAL: counts.critical,
      INSUFFICIENT_DATA: counts.insufficientData
    },
    generatedAt: nowIso()
  };
}

async function getSensorIntelligence({ drainId = null, now = Date.now() } = {}) {
  let sensors;

  if (drainId !== null && drainId !== undefined) {
    if (!Number.isInteger(Number(drainId)) || Number(drainId) <= 0) {
      return null;
    }

    const drainResult = await pool.query(
      "SELECT id FROM drains WHERE id = $1",
      [Number(drainId)]
    );

    if (drainResult.rows.length === 0) {
      return null;
    }

    const full = await getDrainSensorIntelligence(Number(drainId), { now });
    sensors = full.sensors;

    return {
      status: full.status,
      generatedAt: nowIso(),
      disclaimer: SENSOR_DISCLAIMER,
      summary: buildSummary(sensors),
      drains: [full],
      sensors,
      anomalies: sensors.flatMap((s) => s.anomalies || [])
    };
  }

  sensors = await getAllSensorsWithReadings({ now });

  const drainIds = [...new Set(sensors.map((s) => s.drainId))];
  const drains = [];

  for (const id of drainIds) {
    const drainInfo = sensors.find((s) => s.drainId === id);
    drains.push(
      buildDrainAggregate(
        id,
        drainInfo
          ? { zone_name: drainInfo.zone, location: drainInfo.drainLocation }
          : null,
        sensors.filter((s) => s.drainId === id)
      )
    );
  }

  return {
    status: sensors.length > 0 ? "OK" : "INSUFFICIENT_DATA",
    generatedAt: nowIso(),
    disclaimer: SENSOR_DISCLAIMER,
    summary: buildSummary(sensors),
    drains,
    sensors,
    anomalies: sensors.flatMap((s) => s.anomalies || [])
  };
}

async function getSensorAnomalies({ sensorId = null, type = null, severity = null, now = Date.now() } = {}) {
  let sensors;

  if (sensorId !== null && sensorId !== undefined) {
    const single = await getSensorIntelligenceById(Number(sensorId), { now });
    if (!single) {
      return null;
    }
    sensors = [single];
  } else {
    sensors = await getAllSensorsWithReadings({ now });
  }

  let anomalies = sensors.flatMap((s) => s.anomalies || []);

  if (type) {
    anomalies = anomalies.filter((a) => a.type === String(type).toUpperCase());
  }

  if (severity) {
    anomalies = anomalies.filter((a) => a.severity === String(severity).toUpperCase());
  }

  return {
    status: "OK",
    generatedAt: nowIso(),
    count: anomalies.length,
    filters: {
      sensorId: sensorId !== null && sensorId !== undefined ? Number(sensorId) : null,
      type: type || null,
      severity: severity || null
    },
    anomalies: sortAnomalies(anomalies)
  };
}

async function getSummary({ now = Date.now() } = {}) {
  const sensors = await getAllSensorsWithReadings({ now });
  return buildSummary(sensors);
}

// ------------------------------------------------------------
// Additive context for the existing AI engines
// (never replaces their formulas)
// ------------------------------------------------------------

async function getSensorContext(drainId, { now = Date.now() } = {}) {
  const drain = await getDrainSensorIntelligence(drainId, { now });

  if (!drain) {
    return null;
  }

  return {
    drainId: Number(drainId),
    healthStatus: drain.overallHealthStatus,
    averageHealthScore: drain.averageHealthScore,
    totalSensors: drain.totalSensors,
    anomalyCount: drain.anomalyCount,
    anomaliesByType: drain.anomaliesByType,
    anomaliesBySeverity: drain.anomaliesBySeverity,
    staleCount: drain.staleCount,
    missingDataCount: drain.missingDataCount,
    outOfRangeCount: drain.outOfRangeCount,
    crossSensorConsistency: drain.crossSensorConsistency.status,
    disclaimer: SENSOR_DISCLAIMER
  };
}

/**
 * Additive context for the existing engines, cached ~CONTEXT_CACHE_TTL_MS
 * per drain so the MQTT / decision hot path never recomputes the bounded
 * window on every reading. Same shape as getSensorContext; a drain without
 * enough data returns null (and is NOT cached, so it is re-checked on the
 * next tick when new readings may have arrived).
 */
async function getSensorContextCached(drainId, { now = Date.now() } = {}) {
  const key = String(drainId);
  const cached = sensorContextCache.get(key);

  if (cached && now < cached.expiresAt) {
    return cached.value;
  }

  const value = await getSensorContext(drainId, { now });

  if (!value) {
    sensorContextCache.delete(key);
    return null;
  }

  // Prune expired entries so the cache stays bounded by active drains.
  for (const [entryKey, entry] of sensorContextCache) {
    if (now >= entry.expiresAt) {
      sensorContextCache.delete(entryKey);
    }
  }

  sensorContextCache.set(key, { expiresAt: now + CONTEXT_CACHE_TTL_MS, value });
  return value;
}

function resetSensorContextCache() {
  sensorContextCache.clear();
}

// ------------------------------------------------------------
// Severe sensor-integrity incidents (deduped, no robot dispatch)
// ------------------------------------------------------------

function isSevereSensorIssue(sensor) {
  if (sensor.healthStatus === HEALTH_STATUS.CRITICAL) {
    return true;
  }

  return (sensor.anomalies || []).some(
    (a) => a.severity === SEVERITY.CRITICAL && a.type !== ANOMALY_TYPE.MISSING_DATA
  );
}

function describeSensorIssue(sensor) {
  const parts = [];

  if (sensor.healthStatus === HEALTH_STATUS.CRITICAL) {
    parts.push(`sensor health is CRITICAL (score ${sensor.healthScore})`);
  }

  const critical = (sensor.anomalies || []).filter((a) => a.severity === SEVERITY.CRITICAL);
  critical.slice(0, 3).forEach((a) => parts.push(a.message));

  return parts.join("; ");
}

async function ensureSensorIncidents(sensors, now = Date.now()) {
  const created = [];

  for (const sensor of sensors) {
    if (!isSevereSensorIssue(sensor)) {
      continue;
    }

    const key = String(sensor.drainId);
    const lastAttempt = lastIncidentAt.get(key);

    if (lastAttempt && now - lastAttempt < INCIDENT_COOLDOWN_MS) {
      continue;
    }

    lastIncidentAt.set(key, now);

    const severeAnomaly = (sensor.anomalies || []).find(
      (a) => a.severity === SEVERITY.CRITICAL
    );
    const severity = severeAnomaly ? severeAnomaly.severity : SEVERITY.HIGH;

    try {
      const result = await incidentService.createIncident({
        drainId: sensor.drainId,
        title: `Sensor integrity issue at ${sensor.drainLocation || `drain ${sensor.drainId}`}`,
        description: `Sensor ${sensor.sensorId} reported: ${describeSensorIssue(sensor)}. This is a sensor-integrity observation and does not dispatch a robot.`,
        source: "SENSOR",
        severity
      });

      if (result && result.ok) {
        created.push(result.incident);
      }
    } catch (err) {
      console.log("⚠️ Sensor incident skipped:", err.message);
    }
  }

  return created;
}

// ------------------------------------------------------------
// Signature-guarded live emission
// ------------------------------------------------------------

function buildEmitPayload(intelligence) {
  return {
    status: intelligence.status,
    generated_at: intelligence.generatedAt,
    disclaimer: intelligence.disclaimer,
    summary: intelligence.summary,
    drains: intelligence.drains,
    sensors: intelligence.sensors.map((s) => ({
      sensorId: s.sensorId,
      drainId: s.drainId,
      drainLocation: s.drainLocation,
      zone: s.zone,
      healthScore: s.healthScore,
      healthStatus: s.healthStatus,
      anomalyCount: s.anomalyCount,
      stale: s.stale,
      missingData: s.missingData,
      outOfRange: s.outOfRange,
      latestAnomaly: s.latestAnomaly
        ? {
            type: s.latestAnomaly.type,
            severity: s.latestAnomaly.severity,
            message: s.latestAnomaly.message
          }
        : null
    })),
    anomalies: intelligence.anomalies
  };
}

function buildSignature(intelligence) {
  const summarySig = [
    intelligence.summary.totalSensors,
    intelligence.summary.anomalyCount,
    intelligence.summary.staleSensors,
    intelligence.summary.missingDataSensors,
    intelligence.summary.outOfRangeSensors,
    intelligence.summary.overallHealthStatus
  ].join(":");

  const sensorSig = intelligence.sensors
    .map(
      (s) =>
        `${s.sensorId}:${s.healthStatus}:${s.healthScore === null ? "na" : s.healthScore}:${s.stale ? 1 : 0}:${s.missingData ? 1 : 0}`
    )
    .sort()
    .join(",");

  const anomalySig = intelligence.anomalies
    .map((a) => `${a.sensorId}:${a.type}:${a.severity}`)
    .sort()
    .join(",");

  return `${summarySig}|${sensorSig}|${anomalySig}`;
}

async function evaluateAndEmitSensorIntelligence({ drainId = null } = {}) {
  const now = Date.now();
  const intelligence = await getSensorIntelligence({ drainId, now });

  if (!intelligence) {
    return { emitted: false, intelligence: null };
  }

  const signature = buildSignature(intelligence);
  const key = drainId !== null && drainId !== undefined ? String(drainId) : "*";
  const previous = key === "*" ? lastGlobalSignature : lastDrainSignatures.get(key);

  if (signature === previous) {
    return { emitted: false, intelligence };
  }

  if (key === "*") {
    lastGlobalSignature = signature;
  } else {
    lastDrainSignatures.set(key, signature);
  }

  socketHub.emit("sensorIntelligenceUpdate", buildEmitPayload(intelligence));

  // Severe sensor-integrity incidents are best-effort and only
  // attempted from the live emission path.
  try {
    await ensureSensorIncidents(intelligence.sensors, now);
  } catch (err) {
    console.log("⚠️ Sensor incident evaluation skipped:", err.message);
  }

  return { emitted: true, intelligence };
}

function resetSensorIntelligenceRuntime() {
  lastGlobalSignature = null;
  lastDrainSignatures.clear();
  lastIncidentAt.clear();
  resetSensorContextCache();
}

// ------------------------------------------------------------
// Dashboard + analytics views (additive)
// ------------------------------------------------------------

function buildDashboardSummary(summary) {
  return {
    sensorIntelligence: summary,
    sensorHealthSummary: {
      totalSensors: summary.totalSensors,
      counts: summary.counts,
      healthDistribution: summary.healthDistribution,
      averageHealthScore: summary.averageHealthScore,
      overallHealthStatus: summary.overallHealthStatus
    },
    sensorAnomalySummary: {
      anomalyCount: summary.anomalyCount,
      anomaliesByType: summary.anomaliesByType,
      anomaliesBySeverity: summary.anomaliesBySeverity,
      staleSensors: summary.staleSensors,
      missingDataSensors: summary.missingDataSensors,
      outOfRangeSensors: summary.outOfRangeSensors,
      affectedDrains: summary.affectedDrains
    }
  };
}

async function getDashboardSummary({ now = Date.now() } = {}) {
  const summary = await getSummary({ now });
  return buildDashboardSummary(summary);
}

async function getAnalytics({ now = Date.now() } = {}) {
  const intelligence = await getSensorIntelligence({ now });
  const summary = intelligence.summary;

  return {
    status: intelligence.status,
    generated_at: intelligence.generatedAt,
    total_sensors: summary.totalSensors,
    average_health_score: summary.averageHealthScore,
    overall_health_status: summary.overallHealthStatus,
    health_distribution: summary.healthDistribution,
    anomaly_count: summary.anomalyCount,
    anomalies_by_type: summary.anomaliesByType,
    anomalies_by_severity: summary.anomaliesBySeverity,
    stale_sensors: summary.staleSensors,
    missing_data_sensors: summary.missingDataSensors,
    out_of_range_sensors: summary.outOfRangeSensors,
    affected_drains: summary.affectedDrains,
    // No historical health scores are stored yet, so a health trend
    // cannot honestly be reported. Never fabricated.
    health_trend_status: "INSUFFICIENT_DATA",
    health_trend_message:
      "A sensor health trend requires stored historical health snapshots; this system does not persist them, so no trend is reported."
  };
}

// ------------------------------------------------------------
// Exports
// ------------------------------------------------------------

module.exports = {
  // constants
  HISTORY_WINDOW,
  MIN_READINGS,
  MAX_READINGS,
  CHANNELS,
  CHANNEL_RANGES,
  STEP_THRESHOLDS,
  RAPID_THRESHOLDS,
  STALE_AFTER_MS,
  MISSING_GAP_MS,
  CONSISTENCY_TOLERANCE,
  CONTEXT_CACHE_TTL_MS,
  HEALTH_STATUS,
  HEALTH_BANDS,
  ANOMALY_TYPE,
  SEVERITY,
  SEVERITY_RANK,
  SENSOR_DISCLAIMER,
  // pure helpers
  clamp,
  round1,
  healthStatusFromScore,
  severityForMagnitude,
  sortAnomalies,
  detectAnomalies,
  computeHealth,
  computeSignals,
  buildSensorIntelligence,
  buildCrossSensorConsistency,
  buildDrainAggregate,
  buildSummary,
  buildSignature,
  // data access + views
  getSensorReadings,
  getSensorIntelligenceById,
  getAllSensorsWithReadings,
  getDrainSensorIntelligence,
  getSensorIntelligence,
  getSensorAnomalies,
  getSummary,
  getSensorContext,
  getSensorContextCached,
  resetSensorContextCache,
  getDashboardSummary,
  getAnalytics,
  // incidents + live emission
  isSevereSensorIssue,
  ensureSensorIncidents,
  evaluateAndEmitSensorIntelligence,
  resetSensorIntelligenceRuntime
};
