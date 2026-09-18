// ============================================================
// AI-DrainOS — Decision Audit service tests (UPDATE #24)
//
// Verifies the explainable-AI + append-only audit layer:
//   * normalized snapshot shape for every decision type
//   * explanations that RESTATE existing engine outputs (weights,
//     formula names) and never invent confidence/evidence
//   * honest INSUFFICIENT_DATA / unavailable / no-causation states
//   * meaningful-change dedup (UNCHANGED / NOT_MATERIAL / RECORDED)
//   * bounded, filtered, paginated queries + summary aggregation
//   * live loop emits decisionAuditUpdate and never dispatches robots
// ============================================================

const { test, before, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");

const { setup } = require("./helpers");

let pool;
let service;
let decision;
let floodRisk;
let socketHub;

const captured = [];

const fakeIo = {
  emit(event, payload) {
    captured.push({ event, payload });
  }
};

before(async () => {
  await setup();
  pool = require("../config/db");

  service = require("../services/decisionAuditService");
  decision = require("../services/decisionEngine");
  floodRisk = require("../services/floodRiskService");
  socketHub = require("../services/socketHub");
  socketHub.init(fakeIo);
});

beforeEach(async () => {
  // TRUNCATE (not DELETE) because the table is append-only by design;
  // the append-only guarantee itself is asserted in the API tests.
  await pool.query("TRUNCATE decision_audits");
  service.resetDecisionAuditRuntime();
  captured.length = 0;
});

after(async () => {
  socketHub.init(null);
  await pool.end();
});

async function sensorIdFor(drainId) {
  const result = await pool.query(
    "SELECT id FROM sensors WHERE drain_id = $1 ORDER BY id ASC LIMIT 1",
    [drainId]
  );
  return result.rows[0] ? result.rows[0].id : null;
}

async function insertDrainWithoutSensor() {
  const inserted = await pool.query(
    "INSERT INTO drains (zone_name, location, status, blockage_level) VALUES ('Zone 8', 'Observatory', 'Normal', 0) RETURNING id"
  );
  return Number(inserted.rows[0].id);
}

async function insertReadings(drainId, count, base = 10) {
  const sensorId = await sensorIdFor(drainId);
  for (let i = 0; i < count; i += 1) {
    await pool.query(
      `INSERT INTO sensor_readings (sensor_id, drain_id, water_level, gas_level, temperature, recorded_at)
       VALUES ($1, $2, $3, $4, $5, now() - ($6 || ' minutes')::interval)`,
      [sensorId, drainId, base + i * 2, 10 + i, 26 + i * 0.2, count - i]
    );
  }
}

test("exports expose the bounded, documented constants", () => {
  assert.ok(Array.isArray(service.DECISION_TYPES));
  assert.equal(service.DECISION_TYPES.length, 10);
  assert.ok(service.DECISION_TYPES.includes("AI_DECISION"));
  assert.ok(service.DECISION_TYPES.includes("MISSION_COORDINATION"));
  assert.equal(service.MAX_PAGE_SIZE, 100);
  assert.equal(service.DEFAULT_PAGE_SIZE, 20);
  assert.equal(service.DEDUP_ABS_SCORE_EPSILON, 3);
  assert.ok(service.RETENTION_NOTE);
  assert.ok(service.ENTITY_TYPES.includes("DRAIN"));
  assert.ok(service.ENTITY_TYPES.includes("SYSTEM"));
  assert.ok(service.ENTITY_TYPES.length >= 3);
});

// ------------------------------------------------------------
// AI decision explanations
// ------------------------------------------------------------

test("AI decision: READY snapshot restates the weighted formula, no invented confidence", async () => {
  const snapshot = await service.buildAiDecisionSnapshot(5);

  assert.ok(snapshot);
  assert.equal(snapshot.decisionType, "AI_DECISION");
  assert.equal(snapshot.entityType, "DRAIN");
  assert.equal(snapshot.drainId, 5);
  assert.equal(snapshot.status, "READY");
  assert.equal(snapshot.level, "CRITICAL");
  assert.ok(snapshot.score >= 75);
  assert.ok(snapshot.inputs.signals);
  assert.ok(Array.isArray(snapshot.contributions));
  assert.ok(snapshot.evidence.reasons.length > 0);
  assert.ok(snapshot.explanation);

  // Existing engine formula is restated verbatim, never invented.
  assert.ok(snapshot.explanation.includes("floodRisk 0.40"));
  assert.ok(snapshot.explanation.includes("weighted average"));
  // Missing vision signal is reported honestly.
  assert.ok(snapshot.inputs.missingSignals.includes("vision"));
  // No fabricated confidence value.
  assert.ok(!/confidence\s+\d/.test(snapshot.explanation), snapshot.explanation);
  assert.ok(snapshot.limitations.includes("never estimated"));
});

test("AI decision: INSUFFICIENT_DATA is honest (no score, no level, nothing estimated)", async () => {
  const drainId = await insertDrainWithoutSensor();

  const snapshot = await service.buildAiDecisionSnapshot(drainId);

  assert.ok(snapshot);
  assert.equal(snapshot.status, "INSUFFICIENT_DATA");
  assert.equal(snapshot.level, null);
  assert.equal(snapshot.score, null);
  assert.ok(snapshot.explanation.includes("No signal was available"));
  assert.ok(snapshot.explanation.includes("INSUFFICIENT_DATA"));
});

// ------------------------------------------------------------
// Per-type builders
// ------------------------------------------------------------

test("flood risk: restates the existing weighted blend and breakdown", async () => {
  const snapshot = await service.buildFloodRiskSnapshot(1);

  assert.ok(snapshot);
  assert.equal(snapshot.decisionType, "FLOOD_RISK");
  assert.equal(snapshot.status, "READY");
  assert.ok(snapshot.score >= 0 && snapshot.score <= 100);
  assert.ok(snapshot.inputs.weights.water, 0.5);
  assert.ok(snapshot.evidence.breakdown);
  assert.ok(Array.isArray(snapshot.contributions));
  assert.ok(snapshot.explanation.includes("weighted blend"));
});

test("forecast: insufficient history reports honestly with no projected score", async () => {
  // Drain 1 has a sensor but no readings at this point in the sequence,
  // so the existing forecast engine reports insufficient_history.
  const snapshot = await service.buildForecastSnapshot(1);

  assert.ok(snapshot);
  assert.equal(snapshot.decisionType, "FORECAST");
  assert.equal(snapshot.status, "insufficient_history");
  assert.equal(snapshot.level, null);
  assert.equal(snapshot.score, null);
  assert.ok(snapshot.explanation.includes("at least 2 distinct readings"));
});

test("forecast: a history of readings produces a READY linear-baseline explanation", async () => {
  const sensorId = await sensorIdFor(1);
  const now = Date.now();
  await floodRisk.recordReading(sensorId, 1, {
    water_level: 10,
    gas_level: 5,
    temperature: 26,
    timestamp: new Date(now - 120000).toISOString()
  });
  await floodRisk.recordReading(sensorId, 1, {
    water_level: 15,
    gas_level: 8,
    temperature: 27,
    timestamp: new Date(now - 60000).toISOString()
  });
  await floodRisk.recordReading(sensorId, 1, {
    water_level: 20,
    gas_level: 12,
    temperature: 28,
    timestamp: new Date(now - 30000).toISOString()
  });

  const snapshot = await service.buildForecastSnapshot(1);

  assert.ok(snapshot);
  assert.equal(snapshot.status, "ready");
  assert.ok(snapshot.evidence.worst);
  assert.ok(snapshot.explanation.includes("linear"));
  // The existing forecast reports no confidence value; neither does the audit.
  assert.ok(!/confidence\s+\d/.test(snapshot.explanation));
});

test("maintenance: READY explanation uses MAINTENANCE_WEIGHTS and never recomputes sub-scores", async () => {
  await insertReadings(1, 15);

  const snapshot = await service.buildMaintenanceSnapshot(1);

  assert.ok(snapshot);
  assert.equal(snapshot.decisionType, "MAINTENANCE");
  assert.equal(snapshot.status, "READY");
  assert.ok(snapshot.inputs.weights);
  assert.ok(Array.isArray(snapshot.contributions));
  // Per-signal sub-scores are not carried by the existing output, so
  // the audit surfaces values only (contribution always null).
  assert.ok(snapshot.contributions.every((c) => c.contribution === null));
  assert.ok(snapshot.explanation.includes("MAINTENANCE_WEIGHTS"));
  assert.ok(snapshot.explanation.includes("does not recompute"));
});

test("weather correlation: empty history stays honest with a clear status", async () => {
  const snapshot = await service.buildWeatherCorrelationSnapshot({});

  assert.ok(snapshot);
  assert.equal(snapshot.decisionType, "WEATHER_CORRELATION");
  assert.ok(["WEATHER_UNAVAILABLE", "READY", "INSUFFICIENT_DATA"].includes(snapshot.status));
  assert.ok(snapshot.limitations.length > 0);
});

test("mission coordination: snapshot restates the plan and never dispatches", async () => {
  const missionsBefore = await pool.query("SELECT COUNT(*)::int AS c FROM missions");

  const snapshot = await service.buildMissionCoordinationSnapshot({});

  assert.ok(snapshot);
  assert.equal(snapshot.decisionType, "MISSION_COORDINATION");
  assert.ok(snapshot.inputs);
  assert.ok(Array.isArray(snapshot.contributions));

  const missionsAfter = await pool.query("SELECT COUNT(*)::int AS c FROM missions");
  assert.equal(
    Number(missionsAfter.rows[0].c),
    Number(missionsBefore.rows[0].c),
    "reading the coordination plan must not create missions"
  );
});

// ------------------------------------------------------------
// Append-only store + meaningful-change dedup
// ------------------------------------------------------------

test("storeAudit: identical snapshot is UNCHANGED, force bypasses dedup", async () => {
  const snapshot = await service.buildAiDecisionSnapshot(1);
  const first = await service.storeAudit(snapshot);
  assert.equal(first.recorded, true);
  assert.equal(first.reason, "RECORDED");

  const second = await service.storeAudit(snapshot);
  assert.equal(second.recorded, false);
  assert.equal(second.reason, "UNCHANGED");

  const forced = await service.storeAudit(snapshot, { force: true });
  assert.equal(forced.recorded, true);

  const rows = await pool.query("SELECT COUNT(*)::int AS c FROM decision_audits");
  assert.equal(Number(rows.rows[0].c), 2);
});

test("storeAudit: a non-material score wobble (<3) is NOT_MATERIAL", async () => {
  const snapshot = await service.buildAiDecisionSnapshot(1);
  await service.storeAudit(snapshot);

  const tweaked = {
    ...snapshot,
    score: snapshot.score !== null ? snapshot.score + 1 : snapshot.score,
    decisionId: undefined
  };
  const result = await service.storeAudit(tweaked);
  assert.equal(result.recorded, false);
  assert.equal(result.reason, "NOT_MATERIAL");
});

test("storeAudit: a material score change (>=3) is RECORDED", async () => {
  const snapshot = await service.buildAiDecisionSnapshot(1);
  await service.storeAudit(snapshot);

  const tweaked = {
    ...snapshot,
    score: snapshot.score !== null ? snapshot.score + 5 : snapshot.score,
    level: snapshot.level,
    decisionId: undefined
  };
  const result = await service.storeAudit(tweaked);
  assert.equal(result.recorded, true);
  assert.equal(result.reason, "RECORDED");
});

// ------------------------------------------------------------
// Bounded queries + aggregation
// ------------------------------------------------------------

test("getAudits: pagination, filters and clamping stay bounded", async () => {
  await service.storeAudit(await service.buildAiDecisionSnapshot(1));
  await service.storeAudit(await service.buildAiDecisionSnapshot(5));
  await service.storeAudit(await service.buildAiDecisionSnapshot(2));

  const page1 = await service.getAudits({ limit: 2, offset: 0 });
  assert.equal(page1.length, 2);

  const page2 = await service.getAudits({ limit: 2, offset: 2 });
  assert.equal(page2.length, 1);

  const byDrain = await service.getAudits({ drainId: 5 });
  assert.equal(byDrain.length, 1);
  assert.equal(byDrain[0].drainId, 5);

  const clamped = await service.getAudits({ limit: 100000 });
  assert.ok(clamped.length <= service.MAX_PAGE_SIZE);
});

test("getAuditSummary aggregates by type and level", async () => {
  await service.storeAudit(await service.buildAiDecisionSnapshot(5));
  const second = await service.buildAiDecisionSnapshot(1);
  await service.storeAudit(second);

  const summary = await service.getAuditSummary();

  assert.equal(summary.total, 2);
  assert.equal(summary.byDecisionType.AI_DECISION, 2);
  assert.equal(summary.byLevel.CRITICAL, 1);
  assert.equal(summary.byLevel[second.level], 1);
  assert.ok(summary.oldest);
  assert.ok(summary.newest);
});

test("getExplanation returns the restated fields for a stored record", async () => {
  const stored = await service.storeAudit(await service.buildAiDecisionSnapshot(1));
  const id = stored.snapshot.id;

  const explanation = await service.getExplanation(id);

  assert.ok(explanation);
  assert.equal(explanation.decisionType, "AI_DECISION");
  assert.ok(explanation.explanation);
  assert.ok(explanation.limitations);
  assert.ok(explanation.inputs);
});

// ------------------------------------------------------------
// Live loop + additive surfaces
// ------------------------------------------------------------

test("evaluateAndEmitDecisionAudit emits, dedups, throttles and never dispatches", async () => {
  const missionsBefore = await pool.query("SELECT COUNT(*)::int AS c FROM missions");

  const first = await service.evaluateAndEmitDecisionAudit({ force: true });
  assert.equal(first.evaluated, true);
  assert.ok(first.checked >= 1);
  assert.equal(first.emitted, true);

  const emitted = captured.filter((c) => c.event === "decisionAuditUpdate");
  assert.equal(emitted.length, 1);
  assert.ok(emitted[0].payload.counts);
  assert.ok(Array.isArray(emitted[0].payload.recent_changes));
  assert.ok(emitted[0].payload.dwell.includes("append-only"));

  // A second call within the throttle window is refused.
  const throttled = await service.evaluateAndEmitDecisionAudit({});
  assert.equal(throttled.evaluated, false);
  assert.equal(throttled.reason, "THROTTLED");

  // Reset and re-evaluate: nothing changed, so nothing emits.
  service.resetDecisionAuditRuntime();
  const unchanged = await service.evaluateAndEmitDecisionAudit({});
  assert.equal(unchanged.evaluated, true);
  assert.equal(unchanged.recorded, 0);
  assert.equal(unchanged.emitted, false);

  // No robot dispatch ever happened.
  const missionsAfter = await pool.query("SELECT COUNT(*)::int AS c FROM missions");
  assert.equal(Number(missionsAfter.rows[0].c), Number(missionsBefore.rows[0].c));
});

test("setEmitEnabled(false) blocks evaluation+emission until reset", async () => {
  service.setEmitEnabled(false);
  const result = await service.evaluateAndEmitDecisionAudit({});
  assert.equal(result.evaluated, false);
  assert.equal(result.reason, "EMIT_DISABLED");

  service.resetDecisionAuditRuntime();
  const restored = await service.evaluateAndEmitDecisionAudit({ force: true });
  assert.equal(restored.evaluated, true);
});

test("getDashboardSummary and getAnalytics expose additive fields", async () => {
  const snap = await service.buildAiDecisionSnapshot(1);
  await service.storeAudit(snap);

  const dashboard = await service.getDashboardSummary();
  assert.equal(dashboard.status, "READY");
  assert.equal(dashboard.total, 1);
  assert.equal(dashboard.byLevel[snap.level], 1);
  assert.equal(dashboard.recentChanges.length, 1);

  const analytics = await service.getAnalytics();
  assert.equal(analytics.audit_summary.total, 1);
  assert.equal(analytics.audit_decision_counts.AI_DECISION, 1);
  assert.equal(analytics.audit_level_counts[snap.level], 1);
  assert.equal(analytics.audit_recent_changes.length, 1);
  assert.equal(analytics.audit_retention, service.RETENTION_NOTE);
});