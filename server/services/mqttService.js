// ============================================================
// AI-DrainOS MQTT Service
//
// Connects to an MQTT broker and subscribes to IoT sensor
// topics:
//
//   ai-drainos/drains/{drainId}/sensors/{sensorId}
//
// Incoming readings are validated, mapped to the existing
// PostgreSQL sensors schema, persisted, fed into the existing
// AI prediction service and alert workflow, and broadcast as
// sensorUpdate Socket.IO events.
//
// The service never throws on broker problems - the backend
// keeps serving REST APIs and Socket.IO and MQTT reconnects
// automatically when the broker is available again.
// ============================================================

const mqtt = require("mqtt");
const axios = require("axios");

const pool = require("../config/db");

const floodRisk = require("./floodRiskService");
const floodForecast = require("./floodForecastService");
const maintenanceService = require("./maintenancePredictionService");
const decisionEngine = require("./decisionEngine");

const AI_SERVICE_URL =
  process.env.AI_SERVICE_URL || "http://127.0.0.1:5001";

// Minimum time between two AI calls for the same drain
const AI_MIN_INTERVAL_MS = 5000;

const MQTT_TOPIC_PREFIX =
  process.env.MQTT_TOPIC_PREFIX || "ai-drainos";

const TOPIC_PATTERN = new RegExp(
  `^${MQTT_TOPIC_PREFIX}/drains/(\\d+)/sensors/(\\d+)$`
);

// Per-drain AI call cache (values, last call time, prediction)
const aiState = new Map();

// Per-drain flood risk emission state (dedupe for floodRiskUpdate)
const floodRiskState = new Map();

// Per-drain flood forecast emission state (dedupe for forecastUpdate)
const forecastState = new Map();

// Per-drain maintenance - last emission state (dedupe for
// maintenanceUpdate) and recompute throttle (sub-30s messages for
// the same drain reuse the last computation).
const maintenanceState = new Map();
const mqttMaintenanceThrottle = new Map();
const MAINTENANCE_RECOMPUTE_INTERVAL_MS = 30000;

// Per-drain decision - the engine recomputes the full priority
// blend (forecast + maintenance + vision + alerts + robots) so it
// is re-run per drain at most every DECISION_RECOMPUTE_INTERVAL_MS
// and only ever adds fields to the existing sensorUpdate payload.
const mqttDecisionThrottle = new Map();
const DECISION_RECOMPUTE_INTERVAL_MS = 30000;

let aiUnreachableLoggedAt = null;

function logAiUnreachable(message) {
  const now = Date.now();

  if (!aiUnreachableLoggedAt || now - aiUnreachableLoggedAt > 60000) {
    console.log("⚠️ AI service unreachable, using fallback:", message);
    aiUnreachableLoggedAt = now;
  }
}

// --------------------------------------------------
// Topic helpers
// --------------------------------------------------

function buildTopic(drainId, sensorId) {
  return `${MQTT_TOPIC_PREFIX}/drains/${drainId}/sensors/${sensorId}`;
}

function parseTopic(topic) {
  if (typeof topic !== "string") {
    return null;
  }

  const match = TOPIC_PATTERN.exec(topic);

  if (!match) {
    return null;
  }

  return {
    drainId: Number(match[1]),
    sensorId: Number(match[2])
  };
}

// --------------------------------------------------
// Payload validation
// --------------------------------------------------

function validateReading(payload) {
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    return { error: "Payload must be a JSON object" };
  }

  const { water_level, gas_level, temperature, timestamp } = payload;

  if (
    typeof water_level !== "number" ||
    !Number.isFinite(water_level) ||
    water_level < 0 ||
    water_level > 100
  ) {
    return { error: "water_level must be a number between 0 and 100" };
  }

  if (
    typeof gas_level !== "number" ||
    !Number.isFinite(gas_level) ||
    gas_level < 0 ||
    gas_level > 100
  ) {
    return { error: "gas_level must be a number between 0 and 100" };
  }

  if (
    typeof temperature !== "number" ||
    !Number.isFinite(temperature) ||
    temperature < -40 ||
    temperature > 65
  ) {
    return { error: "temperature must be a number between -40 and 65" };
  }

  if (
    timestamp !== undefined &&
    timestamp !== null &&
    Number.isNaN(new Date(timestamp).getTime())
  ) {
    return { error: "timestamp must be a valid date" };
  }

  return {
    reading: {
      water_level: Math.round(water_level),
      gas_level: Math.round(gas_level),
      temperature: Number(Number(temperature).toFixed(2)),
      timestamp:
        timestamp !== undefined && timestamp !== null
          ? new Date(timestamp).toISOString()
          : null
    }
  };
}

function parsePayload(rawPayload) {
  let parsed;

  try {
    parsed = JSON.parse(rawPayload.toString());
  } catch (err) {
    return { error: "Invalid JSON payload" };
  }

  return validateReading(parsed);
}

// --------------------------------------------------
// Thresholds + fallback prediction (same logic as AI route)
// --------------------------------------------------

async function getThresholds() {
  const result = await pool.query(`
    SELECT key, value
    FROM settings
    WHERE key IN ('critical_threshold', 'warning_threshold')
  `);

  const thresholds = {
    critical_threshold: 80,
    warning_threshold: 50
  };

  result.rows.forEach((row) => {
    thresholds[row.key] = Number(row.value);
  });

  return thresholds;
}

function fallbackPrediction(waterLevel, thresholds) {
  if (waterLevel >= thresholds.critical_threshold) {
    return "HIGH";
  }

  if (waterLevel >= thresholds.warning_threshold) {
    return "MEDIUM";
  }

  return "LOW";
}

async function defaultPredict(reading) {
  const aiResponse = await axios.post(
    `${AI_SERVICE_URL}/predict`,
    {
      water_level: reading.water_level,
      gas_level: reading.gas_level,
      temperature: reading.temperature
    },
    { timeout: 3000 }
  );

  return { prediction: aiResponse.data.prediction };
}

// --------------------------------------------------
// AI call with throttling/deduplication
// --------------------------------------------------

async function getPrediction(drainId, reading, predict) {
  const valuesKey =
    `${reading.water_level}|${reading.gas_level}|${reading.temperature}`;

  const prev = aiState.get(drainId);

  // Same values as last reading for this drain -> reuse result
  if (prev && prev.valuesKey === valuesKey) {
    return { prediction: prev.prediction, source: "cached" };
  }

  // Values changed but we called AI recently -> reuse last result
  if (prev && Date.now() - prev.lastCallAt < AI_MIN_INTERVAL_MS) {
    return { prediction: prev.prediction, source: "throttled" };
  }

  try {
    const result = await predict(reading);
    const prediction = result && result.prediction ? result.prediction : "LOW";

    aiState.set(drainId, {
      valuesKey,
      lastCallAt: Date.now(),
      prediction
    });

    return { prediction, source: "ai" };
  } catch (err) {
    logAiUnreachable(err.message);

    const thresholds = await getThresholds();
    const prediction = fallbackPrediction(reading.water_level, thresholds);

    aiState.set(drainId, {
      valuesKey,
      lastCallAt: Date.now(),
      prediction
    });

    return { prediction, source: "fallback" };
  }
}

// --------------------------------------------------
// Flood risk update dedupe - emit a floodRiskUpdate event only
// when something meaningful changed (level, or score moved by at
// least 2 points) so the browser is not flooded by every packet.
// --------------------------------------------------

function shouldEmitFloodRisk(drainId, riskScore, riskLevel) {
  const prev = floodRiskState.get(drainId);

  const levelChanged = !prev || prev.level !== riskLevel;
  const scoreChanged = !prev || Math.abs(prev.score - riskScore) >= 2;

  if (levelChanged || scoreChanged) {
    floodRiskState.set(drainId, { score: riskScore, level: riskLevel });
    return true;
  }

  return false;
}

// --------------------------------------------------
// Forecast update dedupe - emit a forecastUpdate event only when
// the worst predicted (60 min) level changed or its score moved
// by at least 2 points.
// --------------------------------------------------

function shouldEmitForecast(drainId, score, level) {
  const prev = forecastState.get(drainId);

  const levelChanged = !prev || prev.level !== level;
  const scoreChanged = !prev || Math.abs(prev.score - score) >= 2;

  if (levelChanged || scoreChanged) {
    forecastState.set(drainId, { score, level });
    return true;
  }

  return false;
}

// --------------------------------------------------
// Maintenance update dedupe - emit a maintenanceUpdate event only
// when the maintenance level changed or the maintenance score
// moved by at least 3 points, so the browser is not flooded by
// every packet.
// --------------------------------------------------

function shouldEmitMaintenance(drainId, maintenanceScore, level, blockageScore) {
  const prev = maintenanceState.get(drainId);

  const levelChanged = !prev || prev.level !== level;
  const scoreChanged =
    !prev || Math.abs(prev.maintenanceScore - maintenanceScore) >= 3;

  if (levelChanged || scoreChanged) {
    maintenanceState.set(drainId, { maintenanceScore, level, blockageScore });
    return true;
  }

  return false;
}

// --------------------------------------------------
// Reset maintenance in-memory runtime (throttle + dedupe state)
// and the maintenance service caches. Used by tests and on
// demand so a fresh prediction is always computed next.
// --------------------------------------------------

function resetMaintenanceEmitter() {
  maintenanceState.clear();
  mqttMaintenanceThrottle.clear();
  maintenanceService.resetMaintenanceRuntime();
}

// --------------------------------------------------
// Main message handler (testable without a broker)
// --------------------------------------------------

async function handleMessage(topic, rawPayload, context = {}) {
  const io = context.io || { emit: () => {} };
  const predict = context.predict || defaultPredict;

  const topicInfo = parseTopic(topic);

  if (!topicInfo) {
    console.log(`🚫 MQTT ignored: invalid topic "${topic}"`);
    return { status: "rejected", reason: "invalid_topic" };
  }

  const { drainId, sensorId } = topicInfo;

  const parsed = parsePayload(rawPayload);

  if (parsed.error) {
    console.log(`🚫 MQTT rejected ${topic}: ${parsed.error}`);
    return { status: "rejected", reason: "invalid_payload", error: parsed.error };
  }

  const { reading } = parsed;

  try {

    // --------------------------------------------------
    // 1. Identify drain
    // --------------------------------------------------

    const drainResult = await pool.query(
      "SELECT * FROM drains WHERE id = $1",
      [drainId]
    );

    if (drainResult.rows.length === 0) {
      console.log(`🚫 MQTT rejected ${topic}: drain ${drainId} not found`);
      return { status: "rejected", reason: "drain_not_found" };
    }

    const drain = drainResult.rows[0];

    // --------------------------------------------------
    // 2. Map to the existing sensor for the drain
    // --------------------------------------------------

    let resolvedSensorId = sensorId;

    const existingSensor = await pool.query(
      "SELECT id, drain_id FROM sensors WHERE id = $1",
      [sensorId]
    );

    if (existingSensor.rows.length > 0) {
      // Sensor exists -> must belong to the drain in the topic
      if (Number(existingSensor.rows[0].drain_id) !== drainId) {
        console.log(
          `🚫 MQTT rejected ${topic}: sensor ${sensorId} belongs to drain ${existingSensor.rows[0].drain_id}`
        );
        return { status: "rejected", reason: "sensor_drain_mismatch" };
      }
    } else {
      // Sensor id unknown -> reuse the drain's own sensor if present
      const drainSensor = await pool.query(
        "SELECT id FROM sensors WHERE drain_id = $1 ORDER BY id ASC LIMIT 1",
        [drainId]
      );

      if (drainSensor.rows.length > 0) {
        resolvedSensorId = drainSensor.rows[0].id;
        console.log(
          `ℹ️ MQTT mapped ${topic} to existing sensor ${resolvedSensorId}`
        );
      } else {
        const inserted = await pool.query(
          `
          INSERT INTO sensors (drain_id, water_level, gas_level, temperature, status)
          VALUES ($1, $2, $3, $4, 'Normal')
          RETURNING id
          `,
          [
            drainId,
            reading.water_level,
            reading.gas_level,
            reading.temperature
          ]
        );

        resolvedSensorId = inserted.rows[0].id;
        console.log(
          `🌱 MQTT created sensor ${resolvedSensorId} for drain ${drainId}`
        );
      }
    }

    // --------------------------------------------------
    // 3. Compute status from configured thresholds
    // --------------------------------------------------

    const thresholds = await getThresholds();

    let status = "Normal";

    if (reading.water_level >= thresholds.critical_threshold) {
      status = "Critical";
    } else if (reading.water_level >= thresholds.warning_threshold) {
      status = "Warning";
    }

    // --------------------------------------------------
    // 4. Persist reading in the existing sensors table
    // --------------------------------------------------

    await pool.query(
      `
      UPDATE sensors
      SET
        water_level = $1,
        gas_level = $2,
        temperature = $3,
        status = $4,
        recorded_at = COALESCE($5, CURRENT_TIMESTAMP)
      WHERE id = $6
      `,
      [
        reading.water_level,
        reading.gas_level,
        reading.temperature,
        status,
        reading.timestamp,
        resolvedSensorId
      ]
    );

    // --------------------------------------------------
    // 4b. Historical reading + trend history (flood risk)
    // --------------------------------------------------

    let history = [];

    try {
      // Trend must be computed from readings BEFORE the current
      // one, so the history is fetched before recording.
      history = await floodRisk.getWaterHistory(
        drainId,
        floodRisk.HISTORY_WINDOW
      );

      await floodRisk.recordReading(resolvedSensorId, drainId, reading);
    } catch (riskErr) {
      console.log("⚠️ Flood risk history could not be recorded:", riskErr.message);
      history = [];
    }

    // --------------------------------------------------
    // 5. Drain status + alert workflow (same as simulator)
    // --------------------------------------------------

    const oldStatus = drain.status;

    if (oldStatus !== status) {
      await pool.query(
        "UPDATE drains SET status = $1 WHERE id = $2",
        [status, drainId]
      );

      console.log(`📍 MQTT ${drain.location}: ${oldStatus} → ${status}`);
    }

    const escalation =
      (oldStatus === "Normal" && status !== "Normal") ||
      (oldStatus === "Warning" && status === "Critical");

    if (escalation) {
      const existingAlert = await pool.query(
        `
        SELECT id
        FROM alerts
        WHERE drain_id = $1
          AND alert_status = 'Open'
          AND alert_type = 'Flood Risk'
        `,
        [drainId]
      );

      if (existingAlert.rows.length === 0) {
        const severity = status === "Critical" ? "Critical" : "Medium";

        await pool.query(
          `
          INSERT INTO alerts (drain_id, alert_type, message, severity, alert_status)
          VALUES ($1, 'Flood Risk', $2, $3, 'Open')
          `,
          [
            drainId,
            `Water level in ${drain.location} reached ${reading.water_level}% (${status})`,
            severity
          ]
        );

        console.log(`🚨 MQTT new ${severity} alert for ${drain.location}`);
      }
    }

    // Sensor reports drain back to Normal -> resolve flood alerts
    if (oldStatus !== "Normal" && status === "Normal") {
      const resolved = await pool.query(
        `
        UPDATE alerts
        SET alert_status = 'Resolved'
        WHERE drain_id = $1
          AND alert_status = 'Open'
          AND alert_type = 'Flood Risk'
        RETURNING id
        `,
        [drainId]
      );

      if (resolved.rows.length > 0) {
        console.log(`✅ MQTT resolved alerts for ${drain.location}`);
      }
    }

    // --------------------------------------------------
    // 6. AI prediction (throttled + fallback)
    // --------------------------------------------------

    const { prediction, source } = await getPrediction(
      drainId,
      reading,
      predict
    );

    // --------------------------------------------------
    // 7. Flood risk intelligence + early warning
    // --------------------------------------------------

    let risk = null;

    try {
      const thresholds = await floodRisk.getRiskThresholds();

      risk = floodRisk.calculateFloodRisk({
        water_level: reading.water_level,
        gas_level: reading.gas_level,
        temperature: reading.temperature,
        history,
        thresholds
      });

      // Risk-driven early warning alert (HIGH -> Medium,
      // CRITICAL -> Critical, upgraded in place when needed).
      if (risk.riskLevel === "CRITICAL" || risk.riskLevel === "HIGH") {
        const severity = risk.riskLevel === "CRITICAL" ? "Critical" : "Medium";

        await floodRisk.ensureRiskAlert({
          drainId,
          location: drain.location,
          severity,
          message: `Flood risk ${risk.riskLevel} (score ${risk.riskScore}/100) at ${drain.location}`
        });
      }

      // Emit floodRiskUpdate only when something meaningful changed
      if (shouldEmitFloodRisk(drainId, risk.riskScore, risk.riskLevel)) {
        io.emit("floodRiskUpdate", {
          drainId: Number(drainId),
          sensorId: Number(resolvedSensorId),
          riskScore: risk.riskScore,
          riskLevel: risk.riskLevel,
          prediction,
          predictionSource: source,
          waterLevel: reading.water_level,
          gasLevel: reading.gas_level,
          temperature: reading.temperature,
          breakdown: risk.breakdown,
          timestamp: reading.timestamp || new Date().toISOString()
        });
      }
    } catch (riskErr) {
      // A risk engine problem must never break the existing
      // MQTT -> sensor -> AI -> alert pipeline.
      console.log("⚠️ Flood risk calculation skipped:", riskErr.message);
      risk = null;
    }

    // --------------------------------------------------
    // 7b. Predictive flood forecast (15/30/60 min) + early
    // warning. Best-effort: a forecast problem must never break
    // the existing pipeline.
    // --------------------------------------------------

    let forecast = null;

    try {
      forecast = await floodForecast.getDrainForecast(drainId);

      if (forecast && forecast.status === "ready" && forecast.worst) {
        // Forecast-driven early warning alert (predicted HIGH ->
        // Medium, CRITICAL -> Critical, upgraded in place).
        const predicted = forecast.worst.predictedRiskLevel;

        if (predicted === "CRITICAL" || predicted === "HIGH") {
          const severity = predicted === "CRITICAL" ? "Critical" : "Medium";

          await floodForecast.ensureForecastAlert({
            drainId,
            location: drain.location,
            severity,
            message: `Flood forecast ${predicted} within ${forecast.worst.forecastMinutes} min (score ${forecast.worst.predictedRiskScore}/100) at ${drain.location}`
          });
        } else {
          // Prediction dropped below HIGH -> resolve forecast alerts
          await floodForecast.resolveForecastAlerts(drainId);
        }

        // Emit forecastUpdate only when something meaningful changed
        if (
          shouldEmitForecast(
            drainId,
            forecast.worst.predictedRiskScore,
            forecast.worst.predictedRiskLevel
          )
        ) {
          io.emit("forecastUpdate", {
            drainId: Number(drainId),
            sensorId: Number(resolvedSensorId),
            currentRiskLevel: risk ? risk.riskLevel : null,
            currentWaterLevel: reading.water_level,
            method: forecast.method,
            trendDirection: forecast.trendDirection,
            waterTrendPerMinute: forecast.waterTrendPerMinute,
            horizons: forecast.horizons,
            worst: forecast.worst,
            timestamp: reading.timestamp || new Date().toISOString()
          });
        }
      } else if (forecast) {
        // Insufficient history - no prediction possible right now.
        await floodForecast.resolveForecastAlerts(drainId);
      }
    } catch (forecastErr) {
      console.log("⚠️ Flood forecast skipped:", forecastErr.message);
      forecast = null;
    }

    // --------------------------------------------------
    // 7c. Maintenance & blockage prediction (potential
    // obstruction pattern) + maintenance alert workflow + live
    // update. Best-effort and throttled per drain so this extra
    // layer never blocks or floods the existing sensor pipeline.
    // --------------------------------------------------

    let maintenance = null;

    try {
      const throttle = mqttMaintenanceThrottle.get(drainId);

      if (
        !throttle ||
        Date.now() - throttle.lastComputedAt >=
          MAINTENANCE_RECOMPUTE_INTERVAL_MS
      ) {
        maintenance = await maintenanceService.getDrainMaintenance(drainId);

        mqttMaintenanceThrottle.set(drainId, { lastComputedAt: Date.now() });

        if (maintenance && maintenance.status === "READY") {
          // Maintenance-level early warning alert (HIGH -> Medium,
          // CRITICAL -> Critical, upgraded in place when needed).
          if (
            maintenance.maintenanceLevel === "CRITICAL" ||
            maintenance.maintenanceLevel === "HIGH"
          ) {
            const severity =
              maintenance.maintenanceLevel === "CRITICAL"
                ? "Critical"
                : "Medium";

            await maintenanceService.ensureMaintenanceAlert({
              drainId,
              location: drain.location,
              severity,
              message: `Maintenance ${maintenance.maintenanceLevel} (maintenance score ${maintenance.maintenanceScore}/100, blockage risk ${maintenance.blockageRiskScore}/100) at ${drain.location}`
            });
          } else {
            // Prediction dropped below HIGH -> resolve maintenance alerts
            await maintenanceService.resolveMaintenanceAlerts(drainId);
          }

          // Emit maintenanceUpdate only when something meaningful changed
          if (
            shouldEmitMaintenance(
              drainId,
              maintenance.maintenanceScore,
              maintenance.maintenanceLevel,
              maintenance.blockageRiskScore
            )
          ) {
            io.emit("maintenanceUpdate", {
              drainId: Number(drainId),
              sensorId: Number(maintenance.sensorId),
              maintenanceScore: maintenance.maintenanceScore,
              maintenanceLevel: maintenance.maintenanceLevel,
              blockageRiskScore: maintenance.blockageRiskScore,
              blockageRiskLevel: maintenance.blockageRiskLevel,
              inspectionPriority: maintenance.inspectionPriority,
              maintenanceRecommendation: maintenance.maintenanceRecommendation,
              reasons: maintenance.reasons,
              unavailableSignals: maintenance.unavailableSignals,
              timestamp: reading.timestamp || new Date().toISOString()
            });
          }
        }
      }
    } catch (maintenanceErr) {
      // A maintenance engine problem must never break the existing
      // MQTT -> sensor -> AI -> alert pipeline.
      console.log("⚠️ Maintenance prediction skipped:", maintenanceErr.message);
      maintenance = null;
    }

    // --------------------------------------------------
    // 7d. AI Decision & Priority Engine (additive + throttled).
    // The decision engine recomputes the full priority blend from
    // the existing flood risk / forecast / maintenance / vision /
    // alert / robot signals, so it is re-run per drain at most
    // every DECISION_RECOMPUTE_INTERVAL_MS and can never break
    // the sensor pipeline. getDrainDecision also emits
    // decisionUpdate only on a meaningful change. The result is
    // added to sensorUpdate as new fields only.
    // --------------------------------------------------

    let decisionSummary = null;

    try {
      const decisionThrottle = mqttDecisionThrottle.get(drainId);

      if (
        !decisionThrottle ||
        Date.now() - decisionThrottle.lastComputedAt >=
          DECISION_RECOMPUTE_INTERVAL_MS
      ) {
        const decisionResult = await decisionEngine.getDrainDecision(drainId);

        mqttDecisionThrottle.set(drainId, { lastComputedAt: Date.now() });

        if (decisionResult && decisionResult.status === "READY") {
          decisionSummary = {
            decisionPriorityScore: decisionResult.priorityScore,
            decisionPriorityLevel: decisionResult.priorityLevel,
            decisionRecommendedAction: decisionResult.recommendedAction
          };
        }
      }
    } catch (decisionErr) {
      // A decision engine problem must never break the existing
      // MQTT -> sensor -> AI -> alert pipeline.
      console.log("⚠️ Decision engine skipped:", decisionErr.message);
      decisionSummary = null;
    }

    // --------------------------------------------------
    // 8. Emit live update
    // --------------------------------------------------

    const update = {
      drainId: Number(drainId),
      sensorId: Number(resolvedSensorId),
      water_level: reading.water_level,
      gas_level: reading.gas_level,
      temperature: reading.temperature,
      prediction,
      source,
      riskScore: risk ? risk.riskScore : null,
      riskLevel: risk ? risk.riskLevel : null,
      riskTrend: risk ? risk.trend.label : null,
      forecast60Score:
        forecast && forecast.status === "ready" && forecast.worst
          ? forecast.worst.predictedRiskScore
          : null,
      forecast60Level:
        forecast && forecast.status === "ready" && forecast.worst
          ? forecast.worst.predictedRiskLevel
          : null,
      forecastTrendDirection:
        forecast && forecast.status === "ready"
          ? forecast.trendDirection
          : null,
      maintenanceScore:
        maintenance && maintenance.status === "READY"
          ? maintenance.maintenanceScore
          : null,
      maintenanceLevel:
        maintenance && maintenance.status === "READY"
          ? maintenance.maintenanceLevel
          : null,
      blockageRiskScore:
        maintenance && maintenance.status === "READY"
          ? maintenance.blockageRiskScore
          : null,
      blockageRiskLevel:
        maintenance && maintenance.status === "READY"
          ? maintenance.blockageRiskLevel
          : null,
      maintenanceRecommendation:
        maintenance && maintenance.status === "READY"
          ? maintenance.maintenanceRecommendation
          : null,
      decisionPriorityScore:
        decisionSummary ? decisionSummary.decisionPriorityScore : null,
      decisionPriorityLevel:
        decisionSummary ? decisionSummary.decisionPriorityLevel : null,
      decisionRecommendedAction:
        decisionSummary ? decisionSummary.decisionRecommendedAction : null,
      timestamp: reading.timestamp || new Date().toISOString()
    };

    io.emit("sensorUpdate", update);

    console.log(
      `📡 MQTT ${topic} → ${drain.location} water=${reading.water_level}% gas=${reading.gas_level} temp=${reading.temperature}°C prediction=${prediction} (${source})` +
        (risk ? ` risk=${risk.riskScore}(${risk.riskLevel})` : "") +
        (update.forecast60Level
          ? ` forecast60=${update.forecast60Score}(${update.forecast60Level})`
          : "")
    );

    return { status: "accepted", ...update };

  } catch (err) {

    console.log("========== MQTT HANDLER ERROR ==========");
    console.log(err.message);

    return { status: "error", error: err.message };

  }
}

// --------------------------------------------------
// Service bootstrap - never crashes the backend
// --------------------------------------------------

function startMqttService({ io } = {}) {
  if (process.env.MQTT_ENABLED === "false") {
    console.log("🔌 MQTT service disabled (MQTT_ENABLED=false)");
    return null;
  }

  const brokerUrl =
    process.env.MQTT_BROKER_URL || "mqtt://localhost:1883";

  const username = process.env.MQTT_USERNAME || undefined;
  const password = process.env.MQTT_PASSWORD || undefined;

  const clientId =
    process.env.MQTT_CLIENT_ID || "ai-drainos-backend";

  const subscribeTopic = `${MQTT_TOPIC_PREFIX}/drains/+/sensors/+`;

  console.log(`🔌 Connecting to MQTT broker: ${brokerUrl}`);

  let client;

  try {

    client = mqtt.connect(brokerUrl, {
      clientId,
      username,
      password,
      clean: true,
      connectTimeout: 10000,
      reconnectPeriod: 5000
    });

  } catch (err) {

    console.log("❌ MQTT client could not be created:", err.message);
    return null;

  }

  // The error listener MUST be attached before anything else so
  // broker outages are logged instead of crashing the process.
  client.on("error", (err) => {
    console.log("🔌 MQTT error:", err.message);
  });

  client.on("connect", () => {
    console.log(`✅ MQTT connected: ${brokerUrl}`);

    client.subscribe(subscribeTopic, (err) => {
      if (err) {
        console.log("❌ MQTT subscribe failed:", err.message);
        return;
      }

      console.log(`📥 MQTT subscribed to ${subscribeTopic}`);
    });
  });

  client.on("reconnect", () => {
    console.log("🔌 MQTT reconnecting...");
  });

  client.on("offline", () => {
    console.log("🔌 MQTT offline - will retry automatically");
  });

  client.on("close", () => {
    console.log("🔌 MQTT connection closed");
  });

  client.on("message", (topic, payload) => {
    handleMessage(topic, payload, { io }).catch((err) => {
      console.log("========== MQTT MESSAGE ERROR ==========");
      console.log(err.message);
    });
  });

  return client;
}

module.exports = {
  startMqttService,
  handleMessage,
  parseTopic,
  parsePayload,
  validateReading,
  buildTopic,
  fallbackPrediction,
  defaultPredict,
  getPrediction,
  shouldEmitFloodRisk,
  shouldEmitForecast,
  shouldEmitMaintenance,
  resetMaintenanceEmitter
};