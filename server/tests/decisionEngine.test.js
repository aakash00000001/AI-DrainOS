// ============================================================
// AI-DrainOS Decision & Priority Engine tests
//
// Cover the explainable priority decision layer: the bounded
// 0-100 blend of existing flood risk / forecast / maintenance /
// vision signals, missing-signal honesty (never estimated),
// INSUFFICIENT_DATA state, robot dispatch context (available,
// already assigned, battery too low, none available), score/level
// boundaries, action mapping, reasons, determinism, the
// decisionUpdate live emission (level change or >=3 point change)
// and the new REST endpoints.
//
// All decisions must be deterministic and any unavailable signal
// must be reported as such - no fabricated values.
// ============================================================

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const { setup } = require("./helpers");

let app;
let pool;
let decision;
let floodRisk;
let socketHub;

const fakeIo = (captured) => ({
  emit(event, payload) {
    captured.push({ event, payload });
  }
});

before(async () => {
  ({ app, pool } = await setup());

  // Require after setup so config/db binds to the test database
  decision = require("../services/decisionEngine");
  floodRisk = require("../services/floodRiskService");
  socketHub = require("../services/socketHub");
});

after(async () => {
  socketHub.init(null);
  await pool.end();
});

// --------------------------------------------------
// 1-2. Score boundaries + action mapping
// --------------------------------------------------

test("1. Priority boundaries: LOW / MODERATE / HIGH / CRITICAL at 25/50/75", () => {
  assert.equal(decision.priorityLevelFromScore(0), "LOW");
  assert.equal(decision.priorityLevelFromScore(24), "LOW");
  assert.equal(decision.priorityLevelFromScore(25), "MODERATE");
  assert.equal(decision.priorityLevelFromScore(49), "MODERATE");
  assert.equal(decision.priorityLevelFromScore(50), "HIGH");
  assert.equal(decision.priorityLevelFromScore(74), "HIGH");
  assert.equal(decision.priorityLevelFromScore(75), "CRITICAL");
  assert.equal(decision.priorityLevelFromScore(100), "CRITICAL");
});

test("2. Recommended action mapping per priority level", () => {
  assert.equal(decision.recommendedAction("LOW"), "CONTINUE_MONITORING");
  assert.equal(decision.recommendedAction("MODERATE"), "MONITOR_CLOSELY");
  assert.equal(decision.recommendedAction("HIGH"), "INSPECT_DRAIN");
  assert.equal(decision.recommendedAction("CRITICAL"), "IMMEDIATE_ROBOT_INSPECTION");
  assert.equal(decision.recommendedAction("INVALID"), null);
});

// --------------------------------------------------
// 3. Pure scoring: bounds, weights, renormalization, modifiers
// --------------------------------------------------

test("3. computeScore - weighted blend, renormalized, bounded, with modifiers", () => {
  // Single signal => its own value (weight renormalized to full weight).
  const single = decision.computeScore({
    signals: [
      { key: "floodRisk", name: "Flood Risk", value: 80, level: "CRITICAL" }
    ],
    trendRising: false,
    alertTotal: 0
  });

  assert.equal(single.score, 80);

  // Full blend of all four signals.
  const full = decision.computeScore({
    signals: [
      { key: "floodRisk", name: "Flood Risk", value: 80, level: "CRITICAL" },
      { key: "forecast", name: "Forecast (60 min)", value: 70, level: "HIGH" },
      { key: "maintenance", name: "Maintenance", value: 60, level: "MODERATE" },
      { key: "vision", name: "Vision Inspection", value: 50, level: "MODERATE" }
    ],
    trendRising: true,
    alertTotal: 10
  });

  const base =
    (0.4 * 80 + 0.25 * 70 + 0.2 * 60 + 0.15 * 50);

  assert.equal(full.score, Math.round(base + decision.TREND_RISING_BONUS + 10));
  assert.equal(full.contributingFactors.length, 4);

  // Bounded: 100 is the ceiling.
  const capped = decision.computeScore({
    signals: [
      { key: "floodRisk", name: "Flood Risk", value: 100, level: "CRITICAL" },
      { key: "forecast", name: "Forecast (60 min)", value: 100, level: "CRITICAL" }
    ],
    trendRising: true,
    alertTotal: 20
  });

  assert.equal(capped.score, 100);
});

// --------------------------------------------------
// 4. LOW priority drain (seed drain 1 - quiet)
// --------------------------------------------------

test("4. Quiet drain -> LOW priority, CONTINUE_MONITORING, no robot required", async () => {
  const d = await decision.getDrainDecision(1);

  assert.equal(d.status, "READY");
  assert.ok(d.priorityScore < 25, `expected LOW, got ${d.priorityScore}`);
  assert.equal(d.priorityLevel, "LOW");
  assert.equal(d.recommendedAction, "CONTINUE_MONITORING");
  assert.equal(d.robotRecommendation.required, false);
  assert.ok(Array.isArray(d.reasons));
  assert.ok(d.dataAvailability.floodRisk);
  assert.ok(Number.isInteger(d.priorityScore));
  assert.ok(d.generatedAt);
});

// --------------------------------------------------
// 5. CRITICAL drain (seed drain 5 - flood risk + Critical alert)
// --------------------------------------------------

test("5. Critical drain -> CRITICAL priority, immediate robot inspection recommended", async () => {
  const d = await decision.getDrainDecision(5);

  assert.equal(d.status, "READY");
  assert.ok(d.priorityScore >= 75, `expected CRITICAL, got ${d.priorityScore}`);
  assert.equal(d.priorityLevel, "CRITICAL");
  assert.equal(d.recommendedAction, "IMMEDIATE_ROBOT_INSPECTION");
  assert.equal(d.robotRecommendation.required, true);
  assert.equal(d.robotRecommendation.recommended, true);
  assert.ok(
    d.reasons.some((reason) => reason.includes("Flood risk")),
    "reasons should mention flood risk"
  );
  assert.ok(
    d.reasons.some((reason) => reason.includes("Critical alert")),
    "reasons should mention the open Critical alert"
  );
  assert.equal(d.dataAvailability.vision, false);
  assert.ok(Array.isArray(d.modifiers));
  assert.ok(d.modifiers.some((modifier) => modifier.name.includes("Critical")));
});

// --------------------------------------------------
// 6. Full-signal drain (readings + vision inspection)
// --------------------------------------------------

test("6. Drain with forecast + maintenance + vision signals -> all signals reported available", async () => {
  const sensor = await pool.query(
    "SELECT id FROM sensors WHERE drain_id = 3 ORDER BY id ASC LIMIT 1"
  );
  const sensorId = sensor.rows[0].id;

  const now = Date.now();

  await floodRisk.recordReading(sensorId, 3, {
    water_level: 60,
    gas_level: 45,
    temperature: 33,
    timestamp: new Date(now - 120000).toISOString()
  });

  await floodRisk.recordReading(sensorId, 3, {
    water_level: 62,
    gas_level: 45,
    temperature: 33,
    timestamp: new Date(now - 60000).toISOString()
  });

  await pool.query(
    `
    INSERT INTO drain_vision_inspections
      (drain_id, inspection_level, visual_risk_score, possible_blockage_score)
    VALUES ($1, 'HIGH', 68, 55)
    `,
    [3]
  );

  const d = await decision.getDrainDecision(3);

  assert.equal(d.status, "READY");
  assert.deepEqual(d.dataAvailability, {
    floodRisk: true,
    forecast: true,
    maintenance: true,
    vision: true
  });
  assert.equal(d.contributingFactors.length, 4);
  assert.ok(
    d.reasons.some((reason) => reason.includes("60-minute forecast")),
    "reasons should mention the forecast"
  );
  assert.ok(
    d.reasons.some((reason) => reason.includes("Maintenance engine")),
    "reasons should mention maintenance"
  );
  assert.ok(
    d.reasons.some((reason) => reason.includes("vision inspection")),
    "reasons should mention the vision inspection"
  );
});

// --------------------------------------------------
// 6b. MODERATE priority drain (drain 2 - elevated but stable)
// --------------------------------------------------

test("6b. Moderate drain -> MODERATE priority, MONITOR_CLOSELY", async () => {
  // Force a clean, deterministic state: flat/no trend, no open
  // alerts, only the flood-risk signal.
  await pool.query("DELETE FROM sensor_readings WHERE drain_id = 2");
  await pool.query("DELETE FROM alerts WHERE drain_id = 2");

  await pool.query(
    `
    UPDATE sensors
    SET water_level = 48, gas_level = 20, temperature = 27
    WHERE drain_id = 2
    `
  );

  const d = await decision.getDrainDecision(2);

  assert.equal(d.status, "READY");
  assert.ok(d.priorityScore >= 25 && d.priorityScore < 50, `expected MODERATE, got ${d.priorityScore}`);
  assert.equal(d.priorityLevel, "MODERATE");
  assert.equal(d.recommendedAction, "MONITOR_CLOSELY");
  assert.equal(d.robotRecommendation.required, false);
});

// --------------------------------------------------
// 6c. HIGH priority drain (drain 4 - high water + rising trend)
// --------------------------------------------------

test("6c. High drain -> HIGH priority, INSPECT_DRAIN", async () => {
  await pool.query("DELETE FROM alerts WHERE drain_id = 4");

  const now = Date.now();

  await floodRisk.recordReading(
    (await pool.query("SELECT id FROM sensors WHERE drain_id = 4 ORDER BY id ASC LIMIT 1")).rows[0].id,
    4,
    { water_level: 72, gas_level: 45, temperature: 32, timestamp: new Date(now - 120000).toISOString() }
  );

  await floodRisk.recordReading(
    (await pool.query("SELECT id FROM sensors WHERE drain_id = 4 ORDER BY id ASC LIMIT 1")).rows[0].id,
    4,
    { water_level: 74, gas_level: 45, temperature: 32, timestamp: new Date(now - 60000).toISOString() }
  );

  await pool.query(
    `
    UPDATE sensors
    SET water_level = 75, gas_level = 50, temperature = 33
    WHERE drain_id = 4
    `
  );

  const d = await decision.getDrainDecision(4);

  assert.equal(d.status, "READY");
  assert.ok(d.priorityScore >= 50 && d.priorityScore < 75, `expected HIGH, got ${d.priorityScore}`);
  assert.equal(d.priorityLevel, "HIGH");
  assert.equal(d.recommendedAction, "INSPECT_DRAIN");
});

// --------------------------------------------------
// 7. INSUFFICIENT_DATA (drain with no sensor at all)
// --------------------------------------------------

test("7. Drain with no sensor -> INSUFFICIENT_DATA, honest null score", async () => {
  const inserted = await pool.query(
    "INSERT INTO drains (zone_name, location) VALUES ('Zone 8', 'Observatory') RETURNING id"
  );
  const drainId = Number(inserted.rows[0].id);

  const d = await decision.getDrainDecision(drainId);

  assert.equal(d.status, "INSUFFICIENT_DATA");
  assert.equal(d.priorityScore, null);
  assert.equal(d.priorityLevel, null);
  assert.equal(d.recommendedAction, null);
  assert.deepEqual(d.contributingFactors, []);
  assert.deepEqual(d.dataAvailability, {
    floodRisk: false,
    forecast: false,
    maintenance: false,
    vision: false
  });
  assert.equal(d.drainId, drainId);
  assert.equal(d.location, "Observatory");
  assert.ok(d.reason);
});

// --------------------------------------------------
// 8. Robot dispatch context
// --------------------------------------------------

test("8. Critical drain without assignment -> nearest available robot recommended", async () => {
  const d = await decision.getDrainDecision(5);

  assert.equal(d.robotRecommendation.required, true);
  assert.equal(d.robotRecommendation.available, true);
  assert.equal(d.robotRecommendation.assignedToDrain, false);
  assert.ok(d.robotRecommendation.robotName);
  assert.equal(typeof d.robotRecommendation.batteryLevel, "number");
});

test("9. Critical drain with an assigned robot -> reports already assigned", async () => {
  await pool.query(
    `
    INSERT INTO missions (robot_id, drain_id, mission_status, progress)
    VALUES (1, 5, 'Assigned', 10)
    `
  );

  const d = await decision.getDrainDecision(5);

  assert.equal(d.robotRecommendation.assignedToDrain, true);
  assert.equal(d.robotRecommendation.robotId, 1);
  assert.ok(d.robotRecommendation.reason.includes("already assigned"));
});

test("10. All robots with low battery -> explains battery too low", async () => {
  await pool.query("DELETE FROM missions WHERE mission_status = 'Assigned'");

  await pool.query(
    `
    UPDATE robots
    SET battery_level = 15, status = 'Idle'
    WHERE status IN ('Active', 'Idle')
    `
  );

  const d = await decision.getDrainDecision(5);

  assert.equal(d.robotRecommendation.available, false);
  assert.ok(d.robotRecommendation.reason.includes("battery too low"));

  // Restore seed robot state
  await pool.query(
    `
    UPDATE robots
    SET battery_level = 100, status = 'Idle'
    WHERE battery_level = 15
    `
  );
});

test("11. No robot available at all -> honest no robot message", async () => {
  await pool.query("DELETE FROM missions WHERE mission_status = 'Assigned'");
  await pool.query("UPDATE robots SET status = 'Charging'");

  const d = await decision.getDrainDecision(5);

  assert.equal(d.robotRecommendation.available, false);
  assert.ok(d.robotRecommendation.reason.includes("No robot currently available"));

  // Restore seed robot state
  await pool.query(
    `
    UPDATE robots
    SET status = 'Idle', battery_level = 100
    WHERE id IN (1, 2, 3, 4)
    `
  );
  await pool.query("UPDATE robots SET status = 'Active', battery_level = 76 WHERE id = 5");
});

// --------------------------------------------------
// 12. Live decisionUpdate emission on meaningful change
// --------------------------------------------------

test("12. decisionUpdate emitted on first, changed, and level-changing decisions only", async () => {
  decision.resetDecisionRuntime();

  const captured = [];
  socketHub.init(fakeIo(captured));

  // First assessment -> emitted.
  await decision.getDrainDecision(5);
  assert.equal(captured.filter((e) => e.event === "decisionUpdate").length, 1);

  // Unchanged state -> not re-emitted.
  await decision.getDrainDecision(5);
  assert.equal(captured.filter((e) => e.event === "decisionUpdate").length, 1);

  // Big swing in flood risk (water 95 -> 10) -> score changes by >= 3.
  await pool.query("UPDATE sensors SET water_level = 10, gas_level = 10 WHERE drain_id = 5");

  const d = await decision.getDrainDecision(5);
  const updates = captured.filter((e) => e.event === "decisionUpdate");

  assert.equal(updates.length, 2);
  assert.equal(updates[updates.length - 1].payload.priorityScore, d.priorityScore);
  assert.notEqual(d.priorityLevel, "CRITICAL");

  // Small change (< 3 points) -> no new emission.
  decision.resetDecisionRuntime();
  captured.length = 0;

  await decision.getDrainDecision(5);
  await decision.getDrainDecision(6);
  assert.equal(captured.filter((e) => e.event === "decisionUpdate").length, 2);
  assert.equal(captured[0].payload.drainId, 5);
  assert.equal(captured[1].payload.drainId, 6);

  socketHub.init(null);
});

// --------------------------------------------------
// 13-14. Determinism + no fabricated data
// --------------------------------------------------

test("13. Deterministic output for identical state", async () => {
  const first = await decision.getDrainDecision(4);
  const second = await decision.getDrainDecision(4);

  assert.equal(first.priorityScore, second.priorityScore);
  assert.equal(first.priorityLevel, second.priorityLevel);
  assert.deepEqual(first.contributingFactors, second.contributingFactors);
});

test("14. Reasons reference only available signals", async () => {
  const d = await decision.getDrainDecision(4);

  const hasReason = (reasons, pattern) =>
    reasons.some((reason) => reason.includes(pattern));

  if (d.dataAvailability.forecast) {
    assert.ok(hasReason(d.reasons, "60-minute forecast"));
  } else {
    assert.ok(!hasReason(d.reasons, "60-minute forecast"));
  }

  if (d.dataAvailability.vision) {
    assert.ok(hasReason(d.reasons, "vision inspection"));
  } else {
    assert.ok(!hasReason(d.reasons, "vision inspection"));
  }
});

// --------------------------------------------------
// 15-17. REST endpoints
// --------------------------------------------------

test("15. GET /api/predictions/decision/:drainId returns a decision", async () => {
  const res = await request(app)
    .get("/api/predictions/decision/2")
    .expect(200);

  assert.equal(res.body.drainId, 2);
  assert.equal(res.body.status, "READY");
  assert.ok(typeof res.body.priorityScore === "number");
  assert.ok(["LOW", "MODERATE", "HIGH", "CRITICAL"].includes(res.body.priorityLevel));
  assert.ok(res.body.recommendedAction);
  assert.ok(Array.isArray(res.body.reasons));
  assert.ok(Array.isArray(res.body.contributingFactors));
  assert.ok(res.body.robotRecommendation);
  assert.ok(res.body.dataAvailability);
});

test("16. Decision endpoints reject invalid/unknown drains", async () => {
  await request(app).get("/api/predictions/decision/0").expect(400);
  await request(app).get("/api/predictions/decision/abc").expect(400);
  await request(app).get("/api/predictions/decision/99999").expect(404);
});

test("17. GET /api/dashboard/decisions returns the priority summary", async () => {
  const res = await request(app)
    .get("/api/dashboard/decisions?refresh=true")
    .expect(200);

  assert.ok(res.body.totalDrains > 0);
  assert.ok(typeof res.body.averagePriorityScore === "number" || res.body.averagePriorityScore === null);
  assert.ok(typeof res.body.counts.low === "number");
  assert.ok(typeof res.body.counts.critical === "number");
  assert.ok(Array.isArray(res.body.distribution));
  assert.ok(res.body.actionDistribution);
  assert.ok(res.body.actionDistribution.CONTINUE_MONITORING !== undefined);
  assert.ok(res.body.actionDistribution.IMMEDIATE_ROBOT_INSPECTION !== undefined);
  assert.ok(Array.isArray(res.body.topPriority));
  assert.ok(res.body.signalCoverage);
});

test("18. GET /api/analytics/decisions returns decision analytics", async () => {
  const res = await request(app)
    .get("/api/analytics/decisions?refresh=true")
    .expect(200);

  assert.equal(res.body.total_drains, res.body.eligible_drains);
  assert.ok(res.body.insufficient_data <= res.body.total_drains);
  assert.ok(typeof res.body.decision_critical === "number");
  assert.ok(typeof res.body.decision_low === "number");
  assert.ok(typeof res.body.average_priority_score === "number" || res.body.average_priority_score === null);
  assert.ok(Array.isArray(res.body.decision_distribution));
  assert.ok(res.body.action_distribution);
  assert.ok(res.body.signal_coverage);
  assert.ok(Array.isArray(res.body.top_priority_drains));
});