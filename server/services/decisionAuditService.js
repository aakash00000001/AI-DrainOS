// ============================================================
// decisionAuditService.js
//
// Update #24 (Explainable AI + Decision Audit).
//
// This service is a READ-ONLY AUDIT LAYER over the existing AI
// services. It explains, records and reports what those services
// already compute - it NEVER recomputes a decision, NEVER replaces a
// formula, NEVER changes a weight and NEVER dispatches a robot.
//
// Every snapshot is built from REAL outputs of the existing engines
// (decisionEngine, floodRisk/floodForecast/maintenance/sensor-
// intelligence/weather-correlation/robot-path-planning/coordination/
// fleet-optimization/incidents). Missing signals are never invented.
//
// Storage is an append-only `decision_audits` table (UPDATE/DELETE
// blocked by trigger). Only MEANINGFUL changes are written - there is
// never a row per live-tick. All reads are bounded and parameterized.
// ============================================================

const crypto = require("crypto");
const pool = require("../config/db");
const socketHub = require("./socketHub");
const decisionEngine = require("./decisionEngine");
const floodRiskService = require("./floodRiskService");
const floodForecastService = require("./floodForecastService");
const maintenancePredictionService = require("./maintenancePredictionService");
const sensorIntelligenceService = require("./sensorIntelligenceService");
const weatherFloodCorrelationService = require("./weatherFloodCorrelationService");
const robotPathPlanningService = require("./robotPathPlanningService");
const missionCoordinatorService = require("./missionCoordinatorService");
const fleetOptimizationService = require("./fleetOptimizationService");
const incidentService = require("./incidentService");

// ------------------------------------------------------------
// Constants
// ------------------------------------------------------------

const DECISION_TYPES = [
  "AI_DECISION",
  "FLOOD_RISK",
  "FORECAST",
  "MAINTENANCE",
  "SENSOR_INTELLIGENCE",
  "WEATHER_CORRELATION",
  "ROBOT_ROUTE",
  "MISSION_COORDINATION",
  "FLEET_OPTIMIZATION",
  "INCIDENT"
];

const ENTITY_TYPES = ["DRAIN", "ROBOT", "SYSTEM", "SENSOR", "INCIDENT", "SIGNAL"];

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

// Live evaluation happens at most every 30s and only over the top
// READY drains; the writes are deduped to meaningful changes only.
const LIVE_EVALUATE_INTERVAL_MS = 30000;
const MAX_LIVE_DRAINS = 5;

// decisionAuditUpdate is emitted at most every 60s and only when the
// summarized trail meaningfully changed (mirrors the existing
// weather/coordination/fleet throttling conventions).
const EMIT_MIN_INTERVAL_MS = 60000;

// A score change below this threshold is not "material" (matches the
// decision engine's own emission tolerance of `>= 3`).
const DEDUP_ABS_SCORE_EPSILON = 3;

const RETAINED_COLUMNS = [
  "id",
  "decision_id",
  "decision_type",
  "entity_type",
  "entity_id",
  "drain_id",
  "robot_id",
  "timestamp",
  "status",
  "level",
  "score",
  "inputs",
  "contributions",
  "modifiers",
  "evidence",
  "explanation",
  "limitations",
  "signature",
  "created_at"
];

const RETENTION_NOTE =
  "Records are append-only. Retention (a documented operations decision) " +
  "removes whole audits via a maintenance run; a single row is never " +
  "silently rewritten or deleted.";

// ------------------------------------------------------------
// In-memory live-emission state
// ------------------------------------------------------------

let emitEnabled = true;
let lastEvaluateAt = 0;
let lastEmittedAt = 0;
let lastEmittedSignature = null;

function setEmitEnabled(enabled) {
  emitEnabled = Boolean(enabled);
}

// ------------------------------------------------------------
// Small deterministic helpers
// ------------------------------------------------------------

function clamp(value, min, max) {
  return Math.min(Math.max(Number(value), min), max);
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function round1(value) {
  if (value === null || value === undefined || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? Math.round(num * 10) / 10 : null;
}

function round3(value) {
  if (value === null || value === undefined || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? Math.round(num * 1000) / 1000 : null;
}

function asString(value, fallback = "") {
  if (value === null || value === undefined) return fallback;
  return String(value);
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return Object.values(value);
  return [];
}

function toISO(value, fallback = null) {
  if (!value) return fallback;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return fallback;
  return d.toISOString();
}

function buildSignature(parts) {
  const canonical = {};
  Object.keys(parts)
    .sort()
    .forEach((key) => {
      canonical[key] = parts[key];
    });
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex");
}

// Human-readable explanation in the agreed section format. The same
// structured facts are ALSO carried in the JSONB columns so the UI can
// render either representation.
function formatExplanation({ why, what, missing, how, evidence, limitations }) {
  const lines = [];
  if (why) lines.push(`WHY - ${why}`);
  if (what) lines.push(`WHAT - ${what}`);
  if (missing) lines.push(`MISSING - ${missing}`);
  if (how) lines.push(`HOW - ${how}`);
  if (evidence) lines.push(`EVIDENCE - ${evidence}`);
  if (limitations) lines.push(`LIMITATIONS - ${limitations}`);
  return lines.join("\n");
}

function normalizeScore(value) {
  const num = finiteNumber(value);
  if (num === null) return null;
  return clamp(num, 0, 100);
}

// ------------------------------------------------------------
// Deterministic AI-decision explainer (uses the EXISTING output)
// ------------------------------------------------------------

function explainDeterministicDecision(decision) {
  const dataAvailability = decision.dataAvailability || {};
  const signals = decision.signals || {};
  const availableKeys = Object.keys(signals);
  const missingKeys = Object.keys(dataAvailability).filter(
    (key) => dataAvailability[key] === false
  );

  const availableWeights = availableKeys
    .filter((key) => decisionEngine.WEIGHTS[key] !== undefined)
    .map((key) => ({ key, weight: decisionEngine.WEIGHTS[key] }));
  const weightSum = availableWeights.reduce((sum, entry) => sum + entry.weight, 0);
  const renormalized =
    weightSum > 0
      ? availableWeights.map((entry) => ({
          key: entry.key,
          weight: entry.weight,
          normalizedWeight: round3(entry.weight / weightSum)
        }))
      : [];

  const modifiers = asArray(decision.modifiers);
  const modifierTotal = modifiers.reduce((sum, mod) => sum + (Number(mod.points) || 0), 0);
  const score = normalizeScore(decision.priorityScore);
  const trendRising = modifiers.some((mod) => asString(mod.name).includes("Rising water trend"));

  const missingNames = missingKeys.map((key) => {
    const labels = {
      floodRisk: "Flood Risk",
      forecast: "Forecast (60 min)",
      maintenance: "Maintenance",
      vision: "Vision Inspection"
    };
    return labels[key] || key;
  });

  let how, missing;
  if (decision.status === "READY") {
    how =
      `Deterministic weighted average of the available signals: ` +
      `score = SUM(value x weight) / SUM(weight), with weights ` +
      `floodRisk 0.40, forecast 0.25, maintenance 0.20, vision 0.15, ` +
      `renormalized over the ${availableKeys.length} available signal(s).` +
      (weightSum > 0
        ? ` Available weights actually used: ${availableKeys
            .map((k) => `${k}=${decisionEngine.WEIGHTS[k] !== undefined ? decisionEngine.WEIGHTS[k] : "?"}`)
            .join(", ")}.`
        : "");
    if (trendRising) how += " A rising water trend adds 5 points.";
    if (modifierTotal > 0) how += ` Open-alert modifiers add ${modifierTotal} point(s), capped at 20.`;
    how += " The result is clamped to 0-100 and mapped to a level via the existing thresholds (moderate 25 / high 50 / critical 75).";
    missing =
      missingNames.length > 0
        ? `The engine reported the following signal(s) as unavailable: ${missingNames.join(", ")}. They were excluded from the weighted average (weights were renormalized over the available signals).`
        : "None - all four signals were available to the engine.";
  } else {
    how = "No signal was available, so the existing engine returned status INSUFFICIENT_DATA and computed no score or level.";
    missing = `The engine reported the following signal(s) as unavailable: ${missingNames.join(", ")} (all). No value was estimated.`;
  }

  const why =
    decision.status === "READY"
      ? `Final priority ${decision.priorityLevel} (${score}) reflects a deterministic blend of the existing ${availableKeys.length} signal(s).`
      : `This drain recorded no usable monitoring signal, so no priority assessment exists yet.`;

  const limits = [
    "The explanation restates the existing deterministic score; it does not include any confidence value because the engine does not report one.",
    "Missing signals are reported by the engine as unavailable and are never estimated.",
    asString(decision.disclaimer)
  ].filter(Boolean);

  return {
    status: asString(decision.status, "READY"),
    level: decision.priorityLevel || null,
    score,
    inputs: {
      signals,
      dataAvailability,
      availableSignals: availableKeys,
      missingSignals: missingKeys.length > 0 ? missingKeys : [],
      weights: { floodRisk: 0.4, forecast: 0.25, maintenance: 0.2, vision: 0.15 },
      normalizedWeights: renormalized,
      trendRising
    },
    contributions: asArray(decision.contributingFactors),
    modifiers,
    evidence: {
      reasons: asArray(decision.reasons),
      robotRecommendation: decision.robotRecommendation || null,
      modifierTotal,
      sensorIntelligence: decision.sensorIntelligence || null,
      weatherCorrelation: decision.weatherCorrelation || null,
      disclaimer: decision.disclaimer || null
    },
    explanation: formatExplanation({
      why,
      what:
        decision.status === "READY"
          ? `The engine used these signals: ${availableKeys.join(", ")} (values: ${availableKeys
              .map((key) => `${key}=${signals[key] ? signals[key].value : "n/a"}`)
              .join(", ")}).`
          : "No signal values were available.",
      missing,
      how,
      evidence:
        decision.status === "READY"
          ? `Weighted contributions (score x normalized weight): ${asArray(decision.contributingFactors)
              .map((factor) => `${factor.name}=${factor.contribution}`)
              .join(", ")}. Modifiers: ${modifierTotal} point(s).`
          : "No evidence to report.",
      limitations: limits.join(" ")
    }),
    limitations: limits.join(" "),
    policy: {
      status: asString(decision.status, "READY"),
      level: decision.priorityLevel || null,
      score: round1(decision.priorityScore) === null ? null : round1(decision.priorityScore),
      action: decision.recommendedAction || null,
      modifierTotal: round1(modifierTotal) || 0,
      signalKeys: availableKeys.concat(missingKeys).sort().join(",")
    }
  };
}

// ------------------------------------------------------------
// Per-decision-type explainers (reuse existing service outputs only)
// ------------------------------------------------------------

function explainFloodRisk(detail) {
  const limitText =
    "Flood risk is the existing flood-risk engine's weighted blend (water 0.50, gas 0.15, temperature 0.10, trend 0.25) applied to the recorded sensor values and history; the audit only restates the engine's own result.";

  const limitations =
    `Descriptive restatement only. ${limitText} Sensor-health and weather correlation are informational context and do not alter the risk score.`;

  return {
    status: "READY",
    level: detail.riskLevel || null,
    score: normalizeScore(detail.riskScore),
    inputs: {
      waterLevel: finiteNumber(detail.waterLevel),
      gasLevel: finiteNumber(detail.gasLevel),
      temperature: finiteNumber(detail.temperature),
      trend: detail.trend || null,
      weights: floodRiskService.WEIGHTS || {
        water: 0.5,
        gas: 0.15,
        temperature: 0.1,
        trend: 0.25
      }
    },
    contributions: asArray(detail.factors),
    modifiers: [],
    evidence: {
      breakdown: detail.breakdown || null,
      sensorId: detail.sensorId || null,
      zone: detail.zone || null,
      location: detail.location || null,
      timestamp: toISO(detail.timestamp),
      sensorIntelligence: detail.sensorIntelligence || null,
      weatherCorrelation: detail.weatherCorrelation || null
    },
    explanation: formatExplanation({
      why: `Flood risk level ${detail.riskLevel} (score ${normalizeScore(detail.riskScore)}) for drain ${detail.drainId}.`,
      what: `Recorded values -> water ${finiteNumber(detail.waterLevel)}, gas ${finiteNumber(detail.gasLevel)}, temperature ${finiteNumber(detail.temperature)}, trend ${detail.trend && detail.trend.label ? detail.trend.label : "n/a"}.`,
      missing: "No signal missing - the flood risk engine only uses the values above.",
      how: `Weighted blend (water 0.50, gas 0.15, temperature 0.10, trend 0.25), clamped 0-100. ${limitText}`,
      evidence: `Breakdown contributions: ${asArray(detail.factors)
        .map((f) => `${f.name}=${f.contribution}`)
        .join(", ")}.`,
      limitations
    }),
    limitations,
    policy: {
      status: "READY",
      level: detail.riskLevel || null,
      score: round1(detail.riskScore) === null ? null : round1(detail.riskScore),
      trend: detail.trend && detail.trend.label ? detail.trend.label : null
    }
  };
}

function explainForecast(forecast) {
  const ready = forecast.status === "ready";
  const model = forecast.model || null;

  const limitText =
    "The forecast uses the existing transparent linear-baseline method (floodForecastService) and reuses the flood-risk engine for the predicted score. The existing forecast reports NO confidence value, so the audit reports none either.";

  const limitations = [
    "Descriptive restatement of the existing forecast output only.",
    limitText
  ].join(" ");

  return {
    status: forecast.status || "insufficient_history",
    level: ready && forecast.worst ? forecast.worst.predictedRiskLevel || null : null,
    score: ready && forecast.worst ? normalizeScore(forecast.worst.predictedRiskScore) : null,
    inputs: {
      method: asString(forecast.method),
      trendDirection: forecast.trendDirection || null,
      waterTrendPerMinute: finiteNumber(forecast.waterTrendPerMinute),
      model: model
        ? {
            fit: model.fit || null,
            pointsUsed: model.pointsUsed || null,
            readingsAvailable: model.readingsAvailable || null
          }
        : null,
      horizonMinutes: asArray(forecast.horizons).map((h) => h.forecastMinutes)
    },
    contributions: asArray(forecast.horizons).map((h) => ({
      name: `${h.forecastMinutes} min forecast`,
      value: finiteNumber(h.predictedWaterLevel),
      level: h.predictedRiskLevel || null,
      contribution: null
    })),
    modifiers: [],
    evidence: {
      worst: forecast.worst || null,
      currentRiskScore: finiteNumber(forecast.currentRiskScore),
      currentRiskLevel: forecast.currentRiskLevel || null,
      currentWaterLevel: finiteNumber(forecast.currentWaterLevel),
      reason: forecast.reason || null,
      disclaimer: asString(forecast.disclaimer, null)
    },
    explanation:
      ready
        ? formatExplanation({
            why: `Worst-case predicted risk ${forecast.worst && forecast.worst.predictedRiskLevel} (score ${normalizeScore(forecast.worst && forecast.worst.predictedRiskScore)}) at ${forecast.worst && forecast.worst.forecastMinutes} minutes for drain ${forecast.drainId}.`,
            what: `Trend direction ${forecast.trendDirection}, water trend ${finiteNumber(forecast.waterTrendPerMinute)} units/min across ${model && model.readingsAvailable} reading(s).`,
            missing: "None for the forecast itself; horizons listed above are all the engine projected.",
            how: `Linear fit over ${model && model.pointsUsed} point(s), projected to ${forecast.horizons && forecast.horizons.length} horizon(s); predicted risk reuses the existing flood-risk engine.`,
            evidence: `Worst horizon -> ${forecast.worst.forecastMinutes} min, predicted water ${finiteNumber(forecast.worst && forecast.worst.predictedWaterLevel)}, predicted risk score ${normalizeScore(forecast.worst && forecast.worst.predictedRiskScore)}.`,
            limitations: limitText
          })
        : formatExplanation({
            why: `No usable forecast is possible for drain ${forecast.drainId}.`,
            what: `Trend direction ${forecast.trendDirection || "n/a"}, readings available ${forecast.model ? forecast.model.readingsAvailable : (forecast.readingsAvailable || 0)}.`,
            missing: `Fewer than 2 distinct timestamped readings: ${forecast.reason || "insufficient history"}.`,
            how: "The existing forecast engine requires at least 2 distinct readings; no projection was produced.",
            evidence: `Status: ${forecast.status}.`,
            limitations: limitText
          }),
    limitations,
    policy: {
      status: forecast.status || "insufficient_history",
      level: ready && forecast.worst ? forecast.worst.predictedRiskLevel || null : null,
      score:
        ready && forecast.worst
          ? round1(forecast.worst.predictedRiskScore) === null
            ? null
            : round1(forecast.worst.predictedRiskScore)
          : null,
      trend: forecast.trendDirection || null,
      readings: model ? model.readingsAvailable || null : null
    }
  };
}

function explainMaintenance(maintenance) {
  const ready = maintenance.status === "READY";
  const signalRow = maintenance.signals || {};

  // Per-signal sub-scores are not carried in the existing output, so
  // the audit honestly surfaces the recorded signal values and labels
  // them as inputs to the existing weighted formula (weights exported
  // by the maintenance service, never recomputed here).
  const contributions = Object.keys(signalRow).map((key) => ({
    name: key,
    value: signalRow[key],
    contribution: null
  }));

  const limitText =
    "maintenanceScore is the existing maintenance engine's rounded weighted sum of signal sub-scores using MAINTENANCE_WEIGHTS. The existing output does not carry per-signal sub-scores, so the audit surfaces the recorded signal values only - it does not recompute the formula.";

  const limitations = [
    "Descriptive restatement of the existing maintenance prediction only.",
    limitText
  ].join(" ");
  const warning = mantrNonReady(maintenance);

  return {
    status: ready ? "READY" : "INSUFFICIENT_DATA",
    level: ready ? maintenance.maintenanceLevel || null : null,
    score: ready ? normalizeScore(maintenance.maintenanceScore) : null,
    inputs: {
      signals: signalRow,
      weights: maintenancePredictionService.MAINTENANCE_WEIGHTS || null,
      blockageWeights: maintenancePredictionService.BLOCKAGE_WEIGHTS || null
    },
    contributions,
    modifiers: [],
    evidence: {
      blockageRiskScore: ready ? finiteNumber(maintenance.blockageRiskScore) : null,
      blockageRiskLevel: ready ? maintenance.blockageRiskLevel || null : null,
      inspectionPriority: ready ? maintenance.inspectionPriority || null : null,
      reason: warning,
      disclaimer: asString(maintenance.disclaimer, null)
    },
    explanation: ready
      ? formatExplanation({
          why: `Maintenance level ${maintenance.maintenanceLevel} (score ${normalizeScore(maintenance.maintenanceScore)}), blockage ${maintenance.blockageRiskLevel} (${normalizeScore(maintenance.blockageRiskScore)}) for drain ${maintenance.drainId}.`,
          what: `Signal values recorded: ${Object.keys(signalRow)
            .map((key) => `${key}=${signalRow[key]}`)
            .join(", ")}.`,
          missing: "None - every maintenance signal above was present in the existing output.",
          how: "The existing maintenance engine computes the weighted score from these signals via MAINTENANCE_WEIGHTS and derives the recommendation.",
          evidence: `Recommendation: ${maintenance.maintenanceRecommendation}. Inspection priority: ${maintenance.inspectionPriority}.`,
          limitations: limitations
        })
      : formatExplanation({
          why: `No maintenance prediction is possible for drain ${maintenance.drainId}.`,
          what: "No usable signal set was recorded.",
          missing: asString(maintenance.reason, "Signal inputs are insufficient for the existing model."),
          how: "The existing maintenance engine returned INSUFFICIENT_DATA and no score/level.",
          evidence: `Reason: ${asString(maintenance.reason)}.`,
          limitations: situationsNotReady(maintenance)
        }),
    limitations: ready ? limitations : situationsNotReady(maintenance),
    policy: {
      status: ready ? "READY" : "INSUFFICIENT_DATA",
      level: ready ? maintenance.maintenanceLevel || null : null,
      score:
        ready && finiteNumber(maintenance.maintenanceScore) !== null
          ? round1(maintenance.maintenanceScore)
          : null,
      recommendation: ready ? asString(maintenance.maintenanceRecommendation, null) : null,
      blockageLevel: ready ? maintenance.blockageRiskLevel || null : null
    }
  };
}

function mantrNonReady(maintenance) {
  return maintenance.status === "READY"
    ? null
    : asString(maintenance.reason, "Maintenance inputs are insufficient.");
}

function situationsNotReady(maintenance) {
  const limits = [
    "Descriptive restatement of the existing maintenance prediction only.",
    "No score, level or recommendation was produced because the existing engine reported insufficient data."
  ];
  if (lastTruthy(maintenance.reason)) limits.push(asString(maintenance.reason));
  return limits.join(" ");
}

function lastTruthy(value) {
  return value !== null && value !== undefined && value !== "";
}

function explainSensorIntelligence(context) {
  const limitations =
    "Descriptive restatement of the existing sensor-intelligence context only. It reports sensor-integrity state and never changes any formula.";

  return {
    status: "READY",
    level: context.healthStatus || null,
    score: finiteNumber(context.averageHealthScore) !== null
      ? clamp(context.averageHealthScore, 0, 100)
      : null,
    inputs: {
      totalSensors: finiteNumber(context.totalSensors),
      staleCount: finiteNumber(context.staleCount),
      missingDataCount: finiteNumber(context.missingDataCount),
      outOfRangeCount: finiteNumber(context.outOfRangeCount),
      crossSensorConsistency: asString(context.crossSensorConsistency, null)
    },
    contributions: [
      { name: "Anomaly count", value: finiteNumber(context.anomalyCount), contribution: null },
      { name: "Anomalies by severity", value: context.anomaliesBySeverity || {}, contribution: null },
      { name: "Anomalies by type", value: context.anomaliesByType || {}, contribution: null }
    ],
    modifiers: [],
    evidence: {
      disclaimer: context.disclaimer || null
    },
    explanation: formatExplanation({
      why: `Sensor health status ${context.healthStatus} (average score ${finiteNumber(context.averageHealthScore)}) for drain ${context.drainId}.`,
      what: `${context.totalSensors} sensor(s); ${context.anomalyCount} anomaly(s); stale ${context.staleCount}, missing-data ${context.missingDataCount}, out-of-range ${context.outOfRangeCount}.`,
      missing: "None - the reported context fields are all the sensor-intelligence service exposes for this drain.",
      how: "Restates the existing sensor-intelligence context (health score, status, anomalies).",
      evidence: `Cross-sensor consistency: ${asString(context.crossSensorConsistency, "n/a")}.`,
      limitations
    }),
    limitations,
    policy: {
      status: "READY",
      level: context.healthStatus || null,
      score:
        finiteNumber(context.averageHealthScore) !== null
          ? round1(context.averageHealthScore)
          : null,
      anomalyCount: finiteNumber(context.anomalyCount) || 0
    }
  };
}

// ------------------------------------------------------------
// Builders - one per decision type
// ------------------------------------------------------------

async function buildAiDecisionSnapshot(drainId) {
  const decision = await decisionEngine.getDrainDecision(drainId);
  if (!decision) return null;
  const expanded = explainDeterministicDecision(decision);
  return {
    decisionType: "AI_DECISION",
    entityType: "DRAIN",
    entityId: Number(drainId),
    drainId: Number(drainId),
    robotId: null,
    timestamp: toISO(decision.generatedAt) || toISO(new Date()),
    ...expanded
  };
}

async function buildFloodRiskSnapshot(drainId) {
  const detail = await floodRiskService.buildDrainRiskDetail(drainId);
  if (!detail || finiteNumber(detail.riskScore) === null) return null;
  const expanded = explainFloodRisk(detail);
  return {
    decisionType: "FLOOD_RISK",
    entityType: "DRAIN",
    entityId: Number(drainId),
    drainId: Number(drainId),
    robotId: null,
    timestamp: toISO(detail.timestamp) || toISO(new Date()),
    ...expanded
  };
}

async function buildForecastSnapshot(drainId) {
  const forecast = await floodForecastService.getDrainForecast(drainId);
  if (!forecast) return null;
  const expanded = explainForecast(forecast);
  return {
    decisionType: "FORECAST",
    entityType: "DRAIN",
    entityId: Number(drainId),
    drainId: Number(drainId),
    robotId: null,
    timestamp: toISO(new Date()),
    ...expanded
  };
}

async function buildMaintenanceSnapshot(drainId) {
  const maintenance = await maintenancePredictionService.getDrainMaintenance(drainId);
  if (!maintenance) return null;
  const expanded = explainMaintenance(maintenance);
  return {
    decisionType: "MAINTENANCE",
    entityType: "DRAIN",
    entityId: Number(drainId),
    drainId: Number(drainId),
    robotId: null,
    timestamp: toISO(maintenance.timestamp) || toISO(new Date()),
    ...expanded
  };
}

async function buildSensorIntelligenceSnapshot(drainId) {
  const context = await sensorIntelligenceService.getSensorContextCached(drainId);
  if (!context) return null;
  const expanded = explainSensorIntelligence(context);
  return {
    decisionType: "SENSOR_INTELLIGENCE",
    entityType: "DRAIN",
    entityId: Number(drainId),
    drainId: Number(drainId),
    robotId: null,
    timestamp: toISO(new Date()),
    ...expanded
  };
}

async function buildWeatherCorrelationSnapshot({ drainId = null, signal = null } = {}) {
  const opts = { signal: signal || undefined };
  const result = drainId
    ? await weatherFloodCorrelationService.getDrainCorrelation(Number(drainId), opts)
    : await weatherFloodCorrelationService.getWeatherCorrelation(opts);
  if (!result) return null;

  const correlation = result.correlation || null;
  const samples = result.samples || null;

  const limitations = [
    "Descriptive restatement of the existing weather-flood correlation output only.",
    correlation
      ? "Correlation indicates a statistical association and does not establish causation."
      : "No correlation was computed; status reflects the existing engine's honest state."
  ].join(" ");

  const fields = {
    status: result.status,
    level: null,
    score: null,
    inputs: {
      signal: result.signal || null,
      label: result.label || null,
      description: result.description || null,
      units: result.units || null,
      windowHours: samples ? samples.window_hours : null,
      lagMinutes: samples ? samples.lag_minutes : 0,
      available: Boolean(result.available)
    },
    contributions: correlation
      ? [
          { name: "Pearson correlation (r)", value: correlation.r, contribution: null },
          { name: "Matched pairs", value: correlation.pairs, contribution: null }
        ]
      : [],
    modifiers: [],
    evidence: {
      correlation: correlation
        ? {
            r: correlation.r,
            direction: correlation.direction,
            strength: correlation.strength,
            strengthLabel: correlation.strength_label
          }
        : null,
      wording: result.wording || null,
      samples: samples
        ? {
            windowHours: samples.window_hours,
            lagMinutes: samples.lag_minutes,
            matchedPairs: samples.matched_pairs,
            weatherSamples: samples.weather_samples,
            sensorSamples: samples.sensor_samples,
            weatherTotal: samples.weather_total,
            sensorTotal: samples.sensor_total
          }
        : null,
      message: result.message || null,
      disclaimer: result.disclaimer || null
    },
    explanation: correlation
      ? formatExplanation({
          why: `Correlation of ${correlation.direction} ${correlation.strength_label} (r=${correlation.r}) between ${result.label} and the flood signal${drainId ? ` for drain ${drainId}` : ""}.`,
          what: `${samples ? samples.matched_pairs : 0} aligned observation pair(s) in a ${samples ? samples.window_hours : ""}h window`, 
          missing: "None - the existing output states availability, window and pair counts above.",
          how: "Restates the existing Pearson correlation computed by weatherFloodCorrelationService (identical, no re-computation).",
          evidence: `Direction ${correlation.direction}, strength ${correlation.strength_label}, pairs ${correlation.pairs}.`,
          limitations: limitations
        })
      : formatExplanation({
          why: `The existing engine reports status ${result.status} for ${result.label}${drainId ? ` (drain ${drainId})` : ""}.`,
          what: `Available ${Boolean(result.available)}, samples ${samples ? samples.matched_pairs : 0} matched pair(s).`,
          missing: asString(result.message, "Insufficient weather or sensor data."),
          how: "Restates the existing correlation engine's state; no correlation was computed.",
          evidence: `Message: ${asString(result.message)}.`,
          limitations: limitations
        }),
    limitations,
    policy: {
      status: result.status,
      level: null,
      score: null,
      signal: result.signal || null,
      r: round3(correlation ? correlation.r : null) === null ? null : round3(correlation ? correlation.r : null),
      direction: correlation ? correlation.direction || null : null,
      pairs: correlation ? correlation.pairs || null : null
    }
  };

  return {
    decisionType: "WEATHER_CORRELATION",
    entityType: drainId ? "DRAIN" : "SYSTEM",
    entityId: drainId ? Number(drainId) : 0,
    drainId: drainId ? Number(drainId) : null,
    robotId: null,
    timestamp: toISO(result.generated_at) || toISO(new Date()),
    ...fields
  };
}

async function buildRobotRouteSnapshot(drainId) {
  const planning = await robotPathPlanningService.planRoute(drainId);
  if (!planning) return null;

  const robotId = planning.robot
    ? planning.robot.id !== undefined && planning.robot.id !== null
      ? Number(planning.robot.id)
      : planning.robot.robotId !== undefined && planning.robot.robotId !== null
        ? Number(planning.robot.robotId)
        : null
    : null;

  const selected = planning.status === "ROBOT_SELECTED";
  const score =
    finiteNumber(planning.candidate_score) !== null
      ? planning.candidate_score
      : finiteNumber(planning.score);

  const limitations = [
    "Route planning is advisory and was invoked by the audit layer for explanation only.",
    "The audit describes the existing path-planning recommendation; it does not dispatch any robot - dispatch is the mission engine's responsibility."
  ].join(" ");

  const routeInfo = planning.route
    ? {
        mode: planning.route.mode || null,
        hasEnoughBattery: planning.route.hasEnoughBattery,
        routeMode: planning.route.route_mode || null
      }
    : null;

  return {
    decisionType: "ROBOT_ROUTE",
    entityType: "DRAIN",
    entityId: Number(drainId),
    drainId: Number(drainId),
    robotId,
    timestamp: toISO(planning.generatedAt) || toISO(new Date()),
    status: planning.status,
    level: null,
    score,
    inputs: {
      drainCoordsOk: planning.candidate_components
        ? planning.candidate_components.distance !== undefined || planning.candidate_components.battery !== undefined
        : null,
      mode: planning.mode || null,
      candidateComponentLabels: planning.candidate_components
        ? Object.keys(planning.candidate_components)
        : []
    },
    contributions:
      planning.candidate_components && typeof planning.candidate_components === "object"
        ? Object.keys(planning.candidate_components).map((key) => ({
            name: key,
            value: planning.candidate_components[key],
            contribution: null
          }))
        : [],
    modifiers: [],
    evidence: {
      reason: planning.reason || null,
      hasEnoughBattery: planning.hasEnoughBattery,
      route: routeInfo,
      robot: planning.robot
        ? {
            robotId: robotId,
            robotName: planning.robot.robotName || planning.robot.name || null,
            status: planning.robot.status || null,
            battery: finiteNumber(planning.robot.batteryLevel)
          }
        : null,
      disclaimer: planning.disclaimer || null
    },
    explanation: selected
      ? formatExplanation({
          why: `Best route for drain ${drainId} selects robot ${robotId} (candidate score ${score}).`,
          what: `Candidate components evaluated: ${Object.keys(planning.candidate_components || {})
            .map((key) => `${key}=${planning.candidate_components[key]}`)
            .join(", ")}.`,
          missing: "Only real candidate data entered the selection; no synthetic metrics were added.",
          how: "Restates the existing robot path-planning selection (candidate scoring unchanged).",
          evidence: `Mode ${planning.mode}, buffer battery ${planning.hasEnoughBattery}.`,
          limitations
        })
      : formatExplanation({
          why: `No route recommendation can be made for drain ${drainId} right now.`,
          what: `Status: ${planning.status}.`,
          missing: asString(planning.reason, "No eligible robot / coordinates are available."),
          how: "Restates the existing path-planning decision; nothing was dispatched.",
          evidence: `Status: ${planning.status}.`,
          limitations
        }),
    limitations,
    policy: {
      status: planning.status,
      level: null,
      score: round1(score) === null ? null : round1(score),
      robotId,
      hasEnoughBattery: planning.hasEnoughBattery
    }
  };
}

async function buildMissionCoordinationSnapshot({ drainId = null } = {}) {
  // Read-only restatement of the SAME advisory plan the coordination API
  // serves (GET /api/missions/coordination). plan-building never
  // dispatches - missions are only written by missionEngine via the
  // autonomous execution path, which the audit never triggers.
  const snapshot = await missionCoordinatorService.buildCoordinationPlan();
  if (!snapshot || !snapshot.tasks) return null;

  const tasks = Array.isArray(snapshot.tasks) ? snapshot.tasks : [];

  if (drainId) {
    const task = tasks.find(
      (t) => Number(t.drain_id) === Number(drainId) || Number(t.drainId) === Number(drainId)
    );
    if (!task) return null;

    const unassignedReason = task.unassigned_reason || task.unassignedReason || null;

    const limitations = [
      "Descriptive restatement of the existing coordination state only.",
      "The audit explains the existing coordination plan; it assigns no robots and dispatches nothing."
    ].join(" ");

    return {
      decisionType: "MISSION_COORDINATION",
      entityType: "DRAIN",
      entityId: Number(drainId),
      drainId: Number(drainId),
      robotId: task.candidate_robot_id || task.candidateRobotId || null,
      timestamp: toISO(snapshot.generated_at) || toISO(new Date()),
      status: task.coordination_state || task.coordinationState || asString(task.status, "UNKNOWN"),
      level: task.severity || task.level || null,
      score: finiteNumber(task.priority_score) !== null ? task.priority_score : finiteNumber(task.priorityScore),
      inputs: {
        taskId: task.task_id || task.id || null,
        incidentId: task.incident_id || null,
        severity: task.severity || null,
        priorityScore: finiteNumber(task.priority_score),
        candidateCount: task.candidate_count || asArray(task.candidates).length
      },
      contributions: asArray(task.candidates).map((c) => ({
        name: c.robot_name || c.robotName || String(c.robot_id || c.robotId),
        value: c.candidate_score || c.candidateScore || null,
        contribution: null
      })),
      modifiers: [],
      evidence: {
        unassignedReason,
        requiredAction: task.required_action || null,
        conflicts: Array.isArray(snapshot.conflicts) ? snapshot.conflicts.length : 0,
        mode: snapshot.mode || null
      },
      explanation: task.coordination_state === "ASSIGNED"
        ? formatExplanation({
            why: `Task for drain ${drainId} is ${task.coordination_state} (severity ${task.severity || "n/a"}).`,
            what: `Candidate robots: ${asArray(task.candidates)
              .map((c) => String(c.robot_name || c.robotName || c.robot_id || c.robotId))
              .join(", ") || "none"}.`,
            missing: asString(unassignedReason, "None."),
            how: "Restates the existing coordination plan (candidate scoring unchanged).",
            evidence: `Candidate robot ${task.candidate_robot_id || task.candidateRobotId || "n/a"}.`,
            limitations
          })
        : formatExplanation({
            why: `Task for drain ${drainId} could not be assigned (state ${task.coordination_state || "UNASSIGNED"}).`,
            what: "No eligible robot was available to the coordination layer.",
            missing: asString(unassignedReason, "No candidate met the requirements."),
            how: "Restates the existing coordination decision; no assignment was made.",
            evidence: `Reason: ${asString(unassignedReason)}.`,
            limitations
          }),
      limitations,
      policy: {
        status: task.coordination_state || task.coordinationState || asString(task.status, "UNKNOWN"),
        level: task.severity || task.level || null,
        score: finiteNumber(task.priority_score) !== null ? round1(task.priority_score) : null,
        robotId: task.candidate_robot_id || task.candidateRobotId || null
      }
    };
  }

  const states = {
    assigned: tasks.filter((t) => (t.coordination_state || t.coordinationState) === "ASSIGNED").length,
    unassigned: tasks.filter((t) => (t.coordination_state || t.coordinationState) === "UNASSIGNED").length
  };

  const limitations =
    "Descriptive summary of the existing coordination snapshot. The audit assigns no robots and dispatches nothing.";

  return {
    decisionType: "MISSION_COORDINATION",
    entityType: "SYSTEM",
    entityId: 0,
    drainId: null,
    robotId: null,
    timestamp: toISO(snapshot.generated_at) || toISO(new Date()),
    status: asString(snapshot.status, "READY"),
    level: null,
    score: null,
    inputs: {
      totalTasks: tasks.length,
      assessedTasks: states.assigned + states.unassigned,
      assignedTasks: states.assigned,
      unassignedTasks: states.unassigned,
      mode: snapshot.mode || null
    },
    contributions: [],
    modifiers: [],
    evidence: {
      reservations: Array.isArray(snapshot.reservations) ? snapshot.reservations.length : 0,
      conflicts: Array.isArray(snapshot.conflicts) ? snapshot.conflicts.length : 0,
      assertions: Array.isArray(snapshot.assertions) ? snapshot.assertions.length : 0
    },
    explanation: formatExplanation({
      why: `Coordination evaluated ${tasks.length} task(s): ${states.assigned} assigned, ${states.unassigned} unassigned.`,
      what: `Mode ${snapshot.mode || "default"}, ${snapshot.conflicts ? snapshot.conflicts.length : 0} conflict(s), ${snapshot.reservations ? snapshot.reservations.length : 0} reservation(s).`,
      missing: "Not-applicable rows (already assigned missions) are excluded by the coordinator, as always.",
      how: "Restates the existing coordination snapshot (counts and states unchanged).",
      evidence: `Assigned ${states.assigned}, unassigned ${states.unassigned}.`,
      limitations
    }),
    limitations,
    policy: {
      status: asString(snapshot.status, "READY"),
      level: null,
      score: null,
      assigned: states.assigned,
      unassigned: states.unassigned,
      conflicts: Array.isArray(snapshot.conflicts) ? snapshot.conflicts.length : 0
    }
  };
}

async function buildFleetOptimizationSnapshot({ drainId = null } = {}) {
  const fleet = await fleetOptimizationService.getFleetOptimization();
  if (!fleet) return null;

  const summary = fleet.summary || {};

  if (drainId) {
    const task = asArray(fleet.tasks).find((t) => Number(t.drain_id) === Number(drainId));
    if (!task) return null;

    const recommendation = asArray(fleet.recommendations).find(
      (r) => Number(r.drain_id) === Number(drainId)
    );

    const limitations =
      "The fleet optimizer is advisory and does not itself dispatch robots; the audit restates its recommendation only.";

    return {
      decisionType: "FLEET_OPTIMIZATION",
      entityType: "DRAIN",
      entityId: Number(drainId),
      drainId: Number(drainId),
      robotId: recommendation ? recommendation.robot_id || recommendation.robotId || null : null,
      timestamp: toISO(fleet.generated_at) || toISO(new Date()),
      status: recommendation ? asString(recommendation.route_mode, "NO_FEASIBLE_ROUTE") : null,
      level: task.severity || null,
      score: finiteNumber(task.priority_score) !== null ? task.priority_score : null,
      inputs: {
        taskId: task.task_id || null,
        incidentId: task.incident_id || null,
        priorityScore: finiteNumber(task.priority_score),
        ageSeconds: finiteNumber(task.age_seconds),
        hasCoordinates: Boolean(task.has_coordinates)
      },
      contributions: recommendation && recommendation.candidate_components
        ? Object.keys(recommendation.candidate_components).map((key) => ({
            name: key,
            value: recommendation.candidate_components[key],
            contribution: null
          }))
        : [],
      modifiers: [],
      evidence: {
        recommendation: recommendation
          ? {
              robotId: recommendation.robot_id || recommendation.robotId || null,
              robotName: recommendation.robot_name || recommendation.robotName || null,
              candidateScore: finiteNumber(recommendation.candidate_score),
              routeMode: recommendation.route_mode || null,
              estimatedDistance: finiteNumber(recommendation.estimated_distance),
              estimatedTravelTime: finiteNumber(recommendation.estimated_travel_time),
              estimatedBatteryCost: finiteNumber(recommendation.estimated_battery_cost),
              chargingRequired: Boolean(recommendation.charging_required),
              alternatives: asArray(recommendation.alternatives).map((alt) => ({
                robotId: alt.robot_id || alt.robotId || null,
                robotName: alt.robot_name || alt.robotName || null,
                candidateScore: finiteNumber(alt.candidate_score)
              }))
            }
          : null,
        taskStatus: task.status || null,
        unassignedReason:
          asArray(fleet.unassigned).find((u) => Number(u.drain_id) === Number(drainId))
            ? (asArray(fleet.unassigned).find((u) => Number(u.drain_id) === Number(drainId)).reason || null)
            : null
      },
      explanation: recommendation
        ? formatExplanation({
            why: `Fleet advisory for drain ${drainId}: recommend robot ${recommendation.robot_name || recommendation.robotId || "n/a"} (score ${finiteNumber(recommendation.candidate_score)}).`,
            what: `Route mode ${recommendation.route_mode}, distance ${finiteNumber(recommendation.estimated_distance)}, travel ${finiteNumber(recommendation.estimated_travel_time)}s, estimated battery cost ${finiteNumber(recommendation.estimated_battery_cost)}.`,
            missing: "Honest status from the existing optimizer; no synthetic feasibility was added.",
            how: "Restates the existing fleet optimization recommendation (scoring unchanged).",
            evidence: `Alternatives: ${asArray(recommendation.alternatives)
              .map((alt) => `${alt.robot_name || alt.robotId || "?"} (${finiteNumber(alt.candidate_score)})`)
              .join(", ") || "none"}.`,
            limitations
          })
        : formatExplanation({
            why: `No fleet recommendation exists for drain ${drainId}.`,
            what: `Task status ${task.status || "n/a"}, unassigned.`,
            missing: "No eligible robot met the existing optimizer's requirements.",
            how: "Restates the existing fleet optimization state (advisory).",
            evidence: `Unassigned reason: ${asArray(fleet.unassigned)
              .find((u) => Number(u.drain_id) === Number(drainId))
              ? asArray(fleet.unassigned).find((u) => Number(u.drain_id) === Number(drainId)).reason
              : "n/a"}.`,
            limitations
          }),
      limitations,
      policy: {
        status: recommendation ? asString(recommendation.route_mode, "NO_FEASIBLE_ROUTE") : (task.status || null),
        level: task.severity || null,
        score:
          finiteNumber(task.priority_score) !== null ? round1(task.priority_score) : null,
        robotId: recommendation ? recommendation.robot_id || recommendation.robotId || null : null,
        routeMode: recommendation ? recommendation.route_mode || null : null
      }
    };
  }

  const limitations =
    "The fleet optimizer is advisory and does not itself dispatch robots; this audit restates its summary only.";

  return {
    decisionType: "FLEET_OPTIMIZATION",
    entityType: "SYSTEM",
    entityId: 0,
    drainId: null,
    robotId: null,
    timestamp: toISO(fleet.generated_at) || toISO(new Date()),
    status: asString(fleet.status, "READY"),
    level: null,
    score: null,
    inputs: {
      summary: summary
        ? {
            totalRobots: finiteNumber(summary.total_robots),
            availableRobots: finiteNumber(summary.available_robots),
            busyRobots: finiteNumber(summary.busy_robots),
            chargingRobots: finiteNumber(summary.charging_robots),
            offRobots: finiteNumber(summary.offline_robots),
            activeTasks: finiteNumber(summary.active_tasks),
            unassignedTasks: finiteNumber(summary.unassigned_tasks),
            recommendedAssignments: finiteNumber(summary.recommended_assignments)
          }
        : null
    },
    contributions: [],
    modifiers: [],
    evidence: {
      warnings: asArray(fleet.warnings),
      unassignedCount: asArray(fleet.unassigned).length,
      disclaimer: fleet.disclaimer || null
    },
    explanation: formatExplanation({
      why: `Fleet status ${fleet.status}: ${summary.available_robots || 0} of ${summary.total_robots || 0} robot(s) available; ${summary.unassigned_tasks || 0} of ${summary.active_tasks || 0} task(s) unassigned.`,
      what: `Recommended assignments ${summary.recommended_assignments || 0}, charging robots ${summary.charging_robots || 0}, low-battery robots ${summary.low_battery_robots || 0}.`,
      missing: "None - summary numbers come directly from the existing optimizer.",
      how: "Restates the existing fleet optimization summary (values unchanged, advisory only).",
      evidence: `Unassigned ${asArray(fleet.unassigned).length}, warnings ${asArray(fleet.warnings).length}.`,
      limitations
    }),
    limitations,
    policy: {
      status: asString(fleet.status, "READY"),
      level: null,
      score: null,
      recommended: finiteNumber(summary.recommended_assignments) || 0,
      unassigned: finiteNumber(summary.unassigned_tasks) || 0,
      warnings: asArray(fleet.warnings).length
    }
  };
}

async function buildIncidentSnapshot(incidentId) {
  const incident = await incidentService.getIncidentById(incidentId);
  if (!incident) return null;

  const route = incident.route && typeof incident.route === "object" ? incident.route : null;
  const routeInfo = route
    ? {
        status: route.status || null,
        mode: route.mode || route.route_mode || null,
        hasEnoughBattery: route.hasEnoughBattery
      }
    : null;

  const drainId =
    incident.drain_id !== undefined && incident.drain_id !== null
      ? Number(incident.drain_id)
      : Number(incident.drainId) || null;
  const robotId =
    incident.assigned_robot_id !== undefined && incident.assigned_robot_id !== null
      ? Number(incident.assigned_robot_id)
      : Number(incident.assignedRobotId) || null;

  const timeline = {
    created: toISO(incident.created_at),
    acknowledged: toISO(incident.acknowledged_at),
    responding: toISO(incident.responding_at),
    resolved: toISO(incident.resolved_at),
    assigned: toISO(incident.assigned_at)
  };

  const limitations =
    "Descriptive restatement of the existing incident record only; lifecycle timestamps are the ones actually recorded by the system.";

  return {
    decisionType: "INCIDENT",
    entityType: "INCIDENT",
    entityId: Number(incidentId),
    drainId,
    robotId,
    timestamp: toISO(incident.created_at) || toISO(new Date()),
    status: asString(incident.status, "OPEN"),
    level: incident.decision_level || incident.severity || null,
    score:
      finiteNumber(incident.decision_score) !== null
        ? normalizeScore(incident.decision_score)
        : null,
    inputs: {
      source: asString(incident.source, null),
      severity: incident.severity || null,
      decisionScore: finiteNumber(incident.decision_score),
      decisionLevel: incident.decision_level || null,
      title: asString(incident.title, null),
      description: asString(incident.description, null),
      zone: incident.zone_name || incident.zone || null,
      location: incident.location || null
    },
    contributions: [],
    modifiers: [],
    evidence: {
      routeStatus: incident.route_status || null,
      route: routeInfo,
      timeline,
      resolutionNotes: asString(incident.resolution_notes, null),
      robotName: incident.robot_name || null,
      robotBattery: finiteNumber(incident.battery_level)
    },
    explanation: formatExplanation({
      why: `Incident ${incidentId} is ${incident.status} (severity ${incident.severity || "n/a"}, source ${incident.source || "n/a"}) for drain ${drainId || "n/a"}.`,
      what: `Decision context: score ${finiteNumber(incident.decision_score)} level ${incident.decision_level || "n/a"}; route status ${incident.route_status || "n/a"}; response timeline ${Object.keys(timeline)
        .filter((key) => timeline[key])
        .join(", ") || "created only"}.`,
      missing: "None - the audit uses the incident fields actually stored.",
      how: "Restates the existing incident record (state machine OPEN -> ACKNOWLEDGED -> RESPONDING -> RESOLVED unchanged).",
      evidence: `Route status: ${JSON.stringify(routeInfo || {})}.`,
      limitations
    }),
    limitations,
    policy: {
      status: asString(incident.status, "OPEN"),
      level: incident.decision_level || incident.severity || null,
      score:
        finiteNumber(incident.decision_score) !== null
          ? round1(incident.decision_score)
          : null,
      severity: incident.severity || null,
      robotId,
      routeStatus: incident.route_status || null
    }
  };
}

// ------------------------------------------------------------
// Snapshot factory + normalization + persistence
// ------------------------------------------------------------

function normalizeSnapshot(partial) {
  const score = finiteNumber(partial.score);
  return {
    decisionId: buildDecisionId(partial),
    decisionType: asString(partial.decisionType),
    entityType: asString(partial.entityType, "DRAIN"),
    entityId: Number(partial.entityId) || 0,
    drainId: partial.drainId !== null && partial.drainId !== undefined ? Number(partial.drainId) || null : null,
    robotId: partial.robotId !== null && partial.robotId !== undefined ? Number(partial.robotId) || null : null,
    timestamp: toISO(partial.timestamp) || toISO(new Date()),
    status: asString(partial.status, "READY"),
    level: partial.level || null,
    score: score !== null ? clamp(score, 0, 100) : null,
    inputs: partial.inputs || {},
    contributions: asArray(partial.contributions),
    modifiers: asArray(partial.modifiers),
    evidence: partial.evidence || {},
    explanation: asString(partial.explanation),
    limitations: asString(partial.limitations),
    details: partial.policy || {}
  };
}

function buildDecisionId(partial) {
  return `${asString(partial.decisionType)}:${Number(partial.entityId) || 0}:${Date.now()}`;
}

async function buildSnapshotForType(decisionType, args = {}) {
  switch (decisionType) {
    case "AI_DECISION":
      return buildAiDecisionSnapshot(args.drainId);
    case "FLOOD_RISK":
      return buildFloodRiskSnapshot(args.drainId);
    case "FORECAST":
      return buildForecastSnapshot(args.drainId);
    case "MAINTENANCE":
      return buildMaintenanceSnapshot(args.drainId);
    case "SENSOR_INTELLIGENCE":
      return buildSensorIntelligenceSnapshot(args.drainId);
    case "WEATHER_CORRELATION":
      return buildWeatherCorrelationSnapshot({ drainId: args.drainId, signal: args.signal });
    case "ROBOT_ROUTE":
      return buildRobotRouteSnapshot(args.drainId);
    case "MISSION_COORDINATION":
      return buildMissionCoordinationSnapshot({ drainId: args.drainId });
    case "FLEET_OPTIMIZATION":
      return buildFleetOptimizationSnapshot({ drainId: args.drainId });
    case "INCIDENT":
      return buildIncidentSnapshot(args.incidentId);
    default:
      return null;
  }
}

function snapshotSignatureMeanings(snapshot) {
  return {
    decisionType: snapshot.decisionType,
    status: asString(snapshot.status, "READY"),
    level: snapshot.level || null,
    score: finiteNumber(snapshot.score) !== null ? round1(snapshot.score) : null,
    detail: snapshot.details || null
  };
}

function buildSnapshotSignature(snapshot) {
  return buildSignature(snapshotSignatureMeanings(snapshot));
}

function policyDiffers(latestEvidence, policy) {
  const latestDetail = latestEvidence && latestEvidence.summary ? latestEvidence.summary : null;
  const nextDetail = policy || null;
  if (!latestDetail && nextDetail) return true;
  if (latestDetail && !nextDetail) return true;
  if (!latestDetail && !nextDetail) return false;
  const keys = new Set([...Object.keys(latestDetail), ...Object.keys(nextDetail)]);
  for (const key of keys) {
    if (JSON.stringify(latestDetail[key]) !== JSON.stringify(nextDetail[key])) {
      return true;
    }
  }
  return false;
}

async function getLatestFor(decisionType, entityType, entityId) {
  const result = await pool.query(
    `
    SELECT id, level, status, score, signature, evidence
    FROM decision_audits
    WHERE decision_type = $1 AND entity_type = $2 AND entity_id = $3
    ORDER BY id DESC
    LIMIT 1
    `,
    [decisionType, entityType, Number(entityId)]
  );
  return result.rows[0] || null;
}

async function storeAudit(snapshot, { force = false } = {}) {
  const normalized = normalizeSnapshot(snapshot);

  const latest = await getLatestFor(
    normalized.decisionType,
    normalized.entityType,
    normalized.entityId
  );

  const signature = buildSignature(snapshotSignatureMeanings(normalized));

  if (latest) {
    if (!force && latest.signature === signature) {
      return { recorded: false, reason: "UNCHANGED", snapshot: normalized };
    }

    const levelChanged = String(latest.level || "") !== String(normalized.level || "");
    const statusChanged = String(latest.status || "") !== String(normalized.status || "");
    const oldScore = finiteNumber(latest.score);
    const newScore = finiteNumber(normalized.score);
    const scoreChanged =
      oldScore !== null && newScore !== null && Math.abs(newScore - oldScore) >= DEDUP_ABS_SCORE_EPSILON;
    const detailChanged = policyDiffers(latest.evidence, normalized.details);

    if (!force && !levelChanged && !statusChanged && !scoreChanged && !detailChanged) {
      return { recorded: false, reason: "NOT_MATERIAL", snapshot: normalized };
    }
  }

  const inserted = await pool.query(
    `
    INSERT INTO decision_audits
      (decision_id, decision_type, entity_type, entity_id,
       drain_id, robot_id, timestamp, status, level, score,
       inputs, contributions, modifiers, evidence,
       explanation, limitations, signature)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
    RETURNING id
    `,
    [
      normalized.decisionId,
      normalized.decisionType,
      normalized.entityType,
      normalized.entityId,
      normalized.drainId,
      normalized.robotId,
      normalized.timestamp,
      normalized.status,
      normalized.level,
      normalized.score,
      JSON.stringify(normalized.inputs || {}),
      JSON.stringify(normalized.contributions || []),
      JSON.stringify(normalized.modifiers || []),
      JSON.stringify({
        ...(normalized.evidence || {}),
        summary: normalized.details || null
      }),
      normalized.explanation,
      normalized.limitations,
      signature
    ]
  );

  normalized.id = Number(inserted.rows[0].id);

  return { recorded: true, reason: "RECORDED", snapshot: normalized };
}

// ------------------------------------------------------------
// Queries (all bounded + parameterized)
// ------------------------------------------------------------

function rowToSnapshot(row) {
  return {
    id: Number(row.id),
    decisionId: row.decision_id,
    decisionType: row.decision_type,
    entityType: row.entity_type,
    entityId: Number(row.entity_id),
    drainId: row.drain_id !== null ? Number(row.drain_id) : null,
    robotId: row.robot_id !== null ? Number(row.robot_id) : null,
    timestamp: toISO(row.timestamp),
    status: row.status,
    level: row.level,
    score: finiteNumber(row.score),
    inputs: parseJson(row.inputs),
    contributions: parseJson(row.contributions),
    modifiers: parseJson(row.modifiers),
    evidence: parseJson(row.evidence),
    explanation: row.explanation,
    limitations: row.limitations,
    createdAt: toISO(row.created_at)
  };
}

function parseJson(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch (err) {
    return null;
  }
}

async function getAudits({
  decisionType = null,
  drainId = null,
  robotId = null,
  entityType = null,
  entityId = null,
  limit = DEFAULT_PAGE_SIZE,
  offset = 0
} = {}) {
  const pageSize = clamp(limit, 1, MAX_PAGE_SIZE);
  const skip = Math.max(0, offset);

  const clauses = [];
  const params = [];

  if (decisionType) {
    params.push(decisionType);
    clauses.push(`decision_type = $${params.length}`);
  }
  if (drainId !== null && drainId !== undefined) {
    params.push(Number(drainId));
    clauses.push(`drain_id = $${params.length}`);
  }
  if (robotId !== null && robotId !== undefined) {
    params.push(Number(robotId));
    clauses.push(`robot_id = $${params.length}`);
  }
  if (entityType) {
    params.push(entityType);
    clauses.push(`entity_type = $${params.length}`);
  }
  if (entityId !== null && entityId !== undefined) {
    params.push(Number(entityId));
    clauses.push(`entity_id = $${params.length}`);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";

  const result = await pool.query(
    `
    SELECT ${RETAINED_COLUMNS.join(", ")}
    FROM decision_audits
    ${where}
    ORDER BY timestamp DESC, id DESC
    LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `,
    [...params, pageSize, skip]
  );

  return result.rows.map(rowToSnapshot);
}

async function getAuditById(id) {
  const result = await pool.query(
    `SELECT ${RETAINED_COLUMNS.join(", ")} FROM decision_audits WHERE id = $1 LIMIT 1`,
    [Number(id)]
  );
  return result.rows.length > 0 ? rowToSnapshot(result.rows[0]) : null;
}

async function getAuditByDecisionId(decisionId) {
  const result = await pool.query(
    `SELECT ${RETAINED_COLUMNS.join(", ")} FROM decision_audits WHERE decision_id = $1 LIMIT 1`,
    [String(decisionId)]
  );
  return result.rows.length > 0 ? rowToSnapshot(result.rows[0]) : null;
}

async function getRecentAudits(limit = 10) {
  return getAudits({ limit: clamp(limit, 1, MAX_PAGE_SIZE), offset: 0 });
}

async function getAuditSummary() {
  const [totalResult, byTypeResult, byLevelResult, spanResult] = await Promise.all([
    pool.query("SELECT COUNT(*)::int AS total FROM decision_audits"),
    pool.query(
      "SELECT decision_type, COUNT(*)::int AS count FROM decision_audits GROUP BY decision_type ORDER BY count DESC"
    ),
    pool.query(
      "SELECT level, COUNT(*)::int AS count FROM decision_audits WHERE level IS NOT NULL GROUP BY level ORDER BY count DESC"
    ),
    pool.query(
      "SELECT MIN(timestamp) AS oldest, MAX(timestamp) AS newest FROM decision_audits"
    )
  ]);

  const byDecisionType = {};
  byTypeResult.rows.forEach((row) => {
    byDecisionType[row.decision_type] = Number(row.count);
  });

  const byLevel = {};
  byLevelResult.rows.forEach((row) => {
    byLevel[row.level] = Number(row.count);
  });

  const total = Number(totalResult.rows[0].total);

  return {
    total,
    byDecisionType,
    byLevel,
    oldest: spanResult.rows[0].oldest ? toISO(spanResult.rows[0].oldest) : null,
    newest: spanResult.rows[0].newest ? toISO(spanResult.rows[0].newest) : null,
    generatedAt: toISO(new Date())
  };
}

async function getExplanation(id) {
  const result = await pool.query(
    `
    SELECT id, decision_id, decision_type, explanation, limitations,
           inputs, evidence, contributions
    FROM decision_audits
    WHERE id = $1
    LIMIT 1
    `,
    [Number(id)]
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    id: Number(row.id),
    decisionId: row.decision_id,
    decisionType: row.decision_type,
    explanation: row.explanation,
    limitations: row.limitations,
    inputs: parseJson(row.inputs),
    evidence: parseJson(row.evidence),
    contributions: parseJson(row.contributions)
  };
}

// ------------------------------------------------------------
// Live loop: evaluate + emit (meaningful changes only)
// ------------------------------------------------------------

async function evaluateAndEmitDecisionAudit({ force = false } = {}) {
  if (!emitEnabled && !force) {
    return { evaluated: false, recorded: 0, emitted: false, reason: "EMIT_DISABLED" };
  }

  const now = Date.now();
  if (!force && now - lastEvaluateAt < LIVE_EVALUATE_INTERVAL_MS) {
    return { evaluated: false, recorded: 0, emitted: false, reason: "THROTTLED" };
  }
  lastEvaluateAt = now;

  let checked = 0;
  let recorded = 0;

  const summary = await decisionEngine.getDecisionSummary({ force: false });
  const topPriority = Array.isArray(summary && summary.topPriority)
    ? summary.topPriority.slice(0, MAX_LIVE_DRAINS)
    : [];

  for (const entry of topPriority) {
    if (!entry || entry.drainId === undefined) continue;
    const decision = await decisionEngine.getDrainDecision(Number(entry.drainId));
    if (!decision) continue;
    checked += 1;
    const snapshot = await buildAiDecisionSnapshot(Number(entry.drainId));
    if (!snapshot) continue;
    const result = await storeAudit(snapshot);
    if (result.recorded) recorded += 1;
  }

  const emitted = await maybeEmitDecisionAuditUpdate({ checked, recorded, force });

  return { evaluated: true, checked, recorded, emitted };
}

async function maybeEmitDecisionAuditUpdate({ checked = 0, recorded = 0, force = false } = {}) {
  if (!emitEnabled && !force) return false;
  if (!socketHub || typeof socketHub.emit !== "function") return false;

  const now = Date.now();

  let summary = null;
  try {
    summary = await getAuditSummary();
  } catch (err) {
    return false;
  }

  const signature = buildSignature({
    total: summary.total,
    byLevel: summary.byLevel,
    newest: summary.newest || ""
  });

  if (!force && recorded === 0) {
    return false;
  }
  if (!force && now - lastEmittedAt < EMIT_MIN_INTERVAL_MS) {
    return false;
  }

  lastEmittedAt = now;
  lastEmittedSignature = signature;

  socketHub.emit("decisionAuditUpdate", {
    status: "READY",
    generated_at: toISO(new Date()),
    counts: {
      total: summary.total,
      byDecisionType: summary.byDecisionType,
      byLevel: summary.byLevel
    },
    recorded,
    checked,
    recent_changes: (await getRecentAudits(5)).map((row) => ({
      id: row.id,
      decisionType: row.decisionType,
      entityType: row.entityType,
      entityId: row.entityId,
      drainId: row.drainId,
      robotId: row.robotId,
      status: row.status,
      level: row.level,
      score: row.score,
      timestamp: row.timestamp
    })),
    dwell: "Meaningful changes only - records are append-only and never rewritten."
  });

  return true;
}

// ------------------------------------------------------------
// Dashboard + analytics (additive)
// ------------------------------------------------------------

async function getDashboardSummary() {
  let summary = null;
  try {
    summary = await getAuditSummary();
  } catch (err) {
    return { status: "NO_AUDIT_DATA", total: 0, byLevel: {}, recentChanges: [] };
  }

  if (!summary || summary.total === 0) {
    return {
      status: "NO_AUDIT_DATA",
      total: 0,
      byLevel: {},
      recentChanges: [],
      generatedAt: toISO(new Date())
    };
  }

  return {
    status: "READY",
    total: summary.total,
    byLevel: summary.byLevel,
    byDecisionType: summary.byDecisionType,
    recentChanges: (await getRecentAudits(5)).map((row) => ({
      id: row.id,
      decisionType: row.decisionType,
      entityType: row.entityType,
      entityId: row.entityId,
      drainId: row.drainId,
      robotId: row.robotId,
      status: row.status,
      level: row.level,
      score: row.score,
      timestamp: row.timestamp
    })),
    generatedAt: summary.generatedAt
  };
}

async function getAnalytics() {
  let summary = null;
  try {
    summary = await getAuditSummary();
  } catch (err) {
    summary = { total: 0, byDecisionType: {}, byLevel: {}, oldest: null, newest: null };
  }

  return {
    audit_summary: {
      total: summary.total,
      oldest: summary.oldest,
      newest: summary.newest,
      generated_at: summary.generatedAt
    },
    audit_decision_counts: summary.byDecisionType,
    audit_level_counts: summary.byLevel,
    audit_recent_changes: (await getRecentAudits(5)).map((row) => ({
      id: row.id,
      decision_type: row.decisionType,
      decision_id: row.decisionId,
      entity_type: row.entityType,
      entity_id: row.entityId,
      drain_id: row.drainId,
      robot_id: row.robotId,
      status: row.status,
      level: row.level,
      score: row.score,
      timestamp: row.timestamp
    })),
    audit_retention: RETENTION_NOTE
  };
}

// ------------------------------------------------------------
// Test/ops helpers
// ------------------------------------------------------------

function resetDecisionAuditRuntime() {
  lastEvaluateAt = 0;
  lastEmittedAt = 0;
  lastEmittedSignature = null;
  emitEnabled = true;
}

module.exports = {
  DECISION_TYPES,
  ENTITY_TYPES,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  DEDUP_ABS_SCORE_EPSILON,
  RETENTION_NOTE,
  setEmitEnabled,
  buildSnapshotForType,
  buildAiDecisionSnapshot,
  buildFloodRiskSnapshot,
  buildForecastSnapshot,
  buildMaintenanceSnapshot,
  buildSensorIntelligenceSnapshot,
  buildWeatherCorrelationSnapshot,
  buildRobotRouteSnapshot,
  buildMissionCoordinationSnapshot,
  buildFleetOptimizationSnapshot,
  buildIncidentSnapshot,
  storeAudit,
  getAudits,
  getAuditById,
  getAuditByDecisionId,
  getRecentAudits,
  getAuditSummary,
  getExplanation,
  evaluateAndEmitDecisionAudit,
  getDashboardSummary,
  getAnalytics,
  resetDecisionAuditRuntime
};