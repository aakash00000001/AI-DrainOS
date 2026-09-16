// ============================================================
// Flood Risk Intelligence tests
//
// Cover the deterministic risk engine (normalization, trend,
// levels, breakdown) plus the DB/history layer, the MQTT
// integration, Socket.IO floodRiskUpdate emission + dedupe,
// risk-driven alert behaviour and the new REST endpoints.
// ============================================================

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const { setup } = require("./helpers");

let app;
let pool;
let risk;
let mqttService;

const fakeIo = () => ({
  emitted: [],
  emit(event, payload) {
    this.emitted.push({ event, payload });
  }
});

before(async () => {
  ({ app, pool } = await setup());

  // Require after setup so config/db binds to the test database
  risk = require("../services/floodRiskService");
  mqttService = require("../services/mqttService");
});

after(async () => {
  await pool.end();
});

// --------------------------------------------------
// Input normalization
// --------------------------------------------------

test("normalizeWater - clamps any value to 0-100", () => {
  assert.equal(risk.normalizeWater(50), 50);
  assert.equal(risk.normalizeWater(0), 0);
  assert.equal(risk.normalizeWater(100), 100);
  assert.equal(risk.normalizeWater(150), 100);
  assert.equal(risk.normalizeWater(-10), 0);
});

test("normalizeGas - clamps any value to 0-100", () => {
  assert.equal(risk.normalizeGas(15), 15);
  assert.equal(risk.normalizeGas(200), 100);
  assert.equal(risk.normalizeGas(-5), 0);
  assert.equal(risk.normalizeGas(0), 0);
});

test("normalizeTemperature - safe ramp that never dominates", () => {
  assert.equal(risk.normalizeTemperature(20), 0);
  assert.equal(risk.normalizeTemperature(10), 0);
  assert.equal(risk.normalizeTemperature(27), 28);
  assert.equal(risk.normalizeTemperature(34), 56);
  assert.equal(risk.normalizeTemperature(45), 100);
  assert.equal(risk.normalizeTemperature(65), 100);
  assert.equal(risk.normalizeTemperature(-40), 0);
});

test("normalization - null / non-numeric values become 0 (no crash)", () => {
  assert.equal(risk.normalizeWater(null), 0);
  assert.equal(risk.normalizeGas("n/a"), 0);
  assert.equal(risk.normalizeTemperature(undefined), 0);
});

// --------------------------------------------------
// Trend calculation
// --------------------------------------------------

test("trendScore - insufficient data yields no trend signal", () => {
  const result = risk.trendScore([], 50);
  assert.equal(result.score, 0);
  assert.equal(result.label, "Insufficient data");
  assert.equal(risk.trendScore([], 50).score, 0);
});

test("trendScore - stable water yields a low trend score", () => {
  const result = risk.trendScore([20, 20, 20], 20);
  assert.equal(result.score, risk.TREND_STABLE_BASE);
  assert.equal(result.label, "Stable");
});

test("trendScore - increasing water increases the trend score", () => {
  const rising = risk.trendScore([20], 24);
  assert.equal(rising.score, 50);
  assert.ok(rising.label === "Rising" || rising.label === "Rapidly Rising");

  const rapidly = risk.trendScore([60, 76, 84], 92);
  assert.equal(rapidly.score, 100);
  assert.equal(rapidly.label, "Rapidly Rising");
});

test("trendScore - decreasing water reduces the trend score", () => {
  const falling = risk.trendScore([80, 70], 60);
  assert.equal(falling.score, 0);
  assert.ok(falling.label === "Falling" || falling.label === "Rapidly Falling");

  const gentleDrop = risk.trendScore([50, 50], 49);
  assert.equal(gentleDrop.score, 5);
});

// --------------------------------------------------
// Risk score composition + classification
// --------------------------------------------------

test("calculateFloodRisk - LOW example (water 20, gas 20, temp 27, stable)", () => {
  const result = risk.calculateFloodRisk({
    water_level: 20,
    gas_level: 20,
    temperature: 27,
    history: [20, 20, 20]
  });

  // water 10 + gas 3 + temp 2.8 + trend 2.5 = 18.3 -> 18
  assert.equal(result.riskScore, 18);
  assert.equal(result.riskLevel, "LOW");
  assert.deepEqual(result.breakdown, { water: 10, gas: 3, temperature: 3, trend: 3 });
  assert.equal(result.factors.length, 4);
});

test("calculateFloodRisk - LOW with no history stays LOW", () => {
  const result = risk.calculateFloodRisk({
    water_level: 20,
    gas_level: 20,
    temperature: 27
  });

  assert.equal(result.riskScore, 16);
  assert.equal(result.riskLevel, "LOW");
});

test("calculateFloodRisk - MODERATE example (water ~50, gentle rise)", () => {
  const result = risk.calculateFloodRisk({
    water_level: 50,
    gas_level: 30,
    temperature: 30,
    history: [45, 48]
  });

  // 25 + 4.5 + 4 + 8.75 = 42.25 -> 42
  assert.equal(result.riskScore, 42);
  assert.equal(result.riskLevel, "MODERATE");
});

test("calculateFloodRisk - HIGH example (water 70, elevated gas, rising)", () => {
  const result = risk.calculateFloodRisk({
    water_level: 70,
    gas_level: 60,
    temperature: 36,
    history: [60, 66]
  });

  // 35 + 9 + 6.4 + 15 = 65.4 -> 65
  assert.equal(result.riskScore, 65);
  assert.equal(result.riskLevel, "HIGH");
});

test("calculateFloodRisk - CRITICAL example (water 92+, rising fast)", () => {
  const result = risk.calculateFloodRisk({
    water_level: 92,
    gas_level: 80,
    temperature: 38,
    history: [60, 76, 84]
  });

  // 46 + 12 + 7.2 + 25 = 90.2 -> 90
  assert.equal(result.riskScore, 90);
  assert.equal(result.riskLevel, "CRITICAL");
  assert.equal(result.breakdown.trend, 25);
});

test("calculateFloodRisk - invalid/null sensor values are handled safely", () => {
  const result = risk.calculateFloodRisk({
    water_level: null,
    gas_level: "oops",
    temperature: undefined
  });

  assert.equal(result.riskScore, 0);
  assert.equal(result.riskLevel, "LOW");
  assert.ok(Number.isFinite(result.riskScore));
});

test("calculateFloodRisk - risk score is clamped to 0-100", () => {
  const max = risk.calculateFloodRisk({
    water_level: 100,
    gas_level: 100,
    temperature: 60,
    history: [50, 90]
  });

  assert.equal(max.riskScore, 100);
  assert.equal(max.riskLevel, "CRITICAL");
});

// --------------------------------------------------
// Risk level classification thresholds
// --------------------------------------------------

test("riskLevelFromScore - threshold boundaries (0-24 LOW)", () => {
  assert.equal(risk.riskLevelFromScore(0), "LOW");
  assert.equal(risk.riskLevelFromScore(24), "LOW");
});

test("riskLevelFromScore - threshold boundaries (25-49 MODERATE)", () => {
  assert.equal(risk.riskLevelFromScore(25), "MODERATE");
  assert.equal(risk.riskLevelFromScore(49), "MODERATE");
});

test("riskLevelFromScore - threshold boundaries (50-74 HIGH)", () => {
  assert.equal(risk.riskLevelFromScore(50), "HIGH");
  assert.equal(risk.riskLevelFromScore(74), "HIGH");
});

test("riskLevelFromScore - threshold boundaries (75-100 CRITICAL)", () => {
  assert.equal(risk.riskLevelFromScore(75), "CRITICAL");
  assert.equal(risk.riskLevelFromScore(100), "CRITICAL");
});

test("riskLevelFromScore - supports custom thresholds", () => {
  const thresholds = { moderate: 30, high: 60, critical: 85 };
  assert.equal(risk.riskLevelFromScore(55, thresholds), "MODERATE");
  assert.equal(risk.riskLevelFromScore(80, thresholds), "HIGH");
  assert.equal(risk.riskLevelFromScore(90, thresholds), "CRITICAL");
});

test("getRiskThresholds - reads thresholds from settings config", async () => {
  const defaults = await risk.getRiskThresholds();
  assert.deepEqual(defaults, { moderate: 25, high: 50, critical: 75 });

  await pool.query(
    "UPDATE settings SET value = $1 WHERE key = 'risk_moderate_min'",
    ["30"]
  );

  const overridden = await risk.getRiskThresholds();
  assert.equal(overridden.moderate, 30);

  await pool.query(
    "UPDATE settings SET value = $1 WHERE key = 'risk_moderate_min'",
    ["25"]
  );
});

// --------------------------------------------------
// Historical readings (DB)
// --------------------------------------------------

test("recordReading - inserts history and getWaterHistory returns chronological values", async () => {
  const { rows } = await pool.query(`
    INSERT INTO drains (zone_name, location, status, blockage_level)
    VALUES ('Zone Hist', 'History Test', 'Normal', 10)
    RETURNING id
  `);
  const drainId = rows[0].id;

  const sensor = await pool.query(
    `
    INSERT INTO sensors (drain_id, water_level, gas_level, temperature, status)
    VALUES ($1, 0, 0, 25.00, 'Normal')
    RETURNING id
    `,
    [drainId]
  );
  const sensorId = sensor.rows[0].id;

  await risk.recordReading(sensorId, drainId, {
    water_level: 30, gas_level: 10, temperature: 27
  });
  await risk.recordReading(sensorId, drainId, {
    water_level: 45, gas_level: 15, temperature: 28
  });
  await risk.recordReading(sensorId, drainId, {
    water_level: 60, gas_level: 20, temperature: 29
  });

  const history = await risk.getWaterHistory(drainId, 10);

  assert.deepEqual(history, [30, 45, 60]);

  const count = await pool.query(
    "SELECT COUNT(*) FROM sensor_readings WHERE drain_id = $1",
    [drainId]
  );
  assert.equal(Number(count.rows[0].count), 3);
});

// --------------------------------------------------
// MQTT integration
// --------------------------------------------------

test("handleMessage - MQTT reading flows through risk + emits floodRiskUpdate (deduped)", async () => {
  const io = fakeIo();

  const predict = async () => ({ prediction: "HIGH" });

  // 1st reading: water 60 -> MODERATE risk
  const first = await mqttService.handleMessage(
    "ai-drainos/drains/4/sensors/4",
    JSON.stringify({ water_level: 60, gas_level: 40, temperature: 33 }),
    { io, predict }
  );

  assert.equal(first.status, "accepted");
  assert.equal(first.riskScore, 41);
  assert.equal(first.riskLevel, "MODERATE");
  assert.equal(first.riskTrend, "Insufficient data");

  // 2nd reading: water 92 with rising history -> CRITICAL
  const second = await mqttService.handleMessage(
    "ai-drainos/drains/4/sensors/4",
    JSON.stringify({ water_level: 92, gas_level: 80, temperature: 38 }),
    { io, predict }
  );

  assert.equal(second.status, "accepted");
  assert.equal(second.riskScore, 90);
  assert.equal(second.riskLevel, "CRITICAL");
  assert.equal(second.riskTrend, "Rapidly Rising");

  // sensorUpdate carries the risk fields (additive)
  const sensorUpdate = io.emitted.filter((e) => e.event === "sensorUpdate");
  assert.ok(sensorUpdate.length >= 2);
  assert.equal(sensorUpdate[sensorUpdate.length - 1].payload.riskScore, 90);
  assert.equal(sensorUpdate[sensorUpdate.length - 1].payload.riskLevel, "CRITICAL");

  // floodRiskUpdate emitted twice (level changed MODERATE -> CRITICAL)
  const riskUpdates = io.emitted.filter((e) => e.event === "floodRiskUpdate");
  assert.equal(riskUpdates.length, 2);

  const last = riskUpdates[riskUpdates.length - 1].payload;
  assert.equal(last.drainId, 4);
  assert.equal(last.sensorId, 4);
  assert.equal(last.riskScore, 90);
  assert.equal(last.riskLevel, "CRITICAL");
  assert.equal(last.prediction, "HIGH");
  assert.equal(last.waterLevel, 92);
  assert.equal(last.gasLevel, 80);
  assert.equal(last.temperature, 38);
  assert.ok(last.breakdown);
  assert.ok(last.timestamp);

  // Identical reading again -> score/level unchanged, no new emit
  const third = await mqttService.handleMessage(
    "ai-drainos/drains/4/sensors/4",
    JSON.stringify({ water_level: 92, gas_level: 80, temperature: 38 }),
    { io, predict }
  );

  assert.equal(third.status, "accepted");
  assert.equal(third.riskScore, 90);

  const riskUpdatesAfter = io.emitted.filter((e) => e.event === "floodRiskUpdate");
  assert.equal(riskUpdatesAfter.length, 2);
});

test("handleMessage - CRITICAL risk creates/upgrades a Flood Risk alert (deduped)", async () => {
  const io = fakeIo();

  const predict = async () => ({ prediction: "HIGH" });

  await mqttService.handleMessage(
    "ai-drainos/drains/4/sensors/4",
    JSON.stringify({ water_level: 92, gas_level: 80, temperature: 38 }),
    { io, predict }
  );

  await mqttService.handleMessage(
    "ai-drainos/drains/4/sensors/4",
    JSON.stringify({ water_level: 93, gas_level: 81, temperature: 38 }),
    { io, predict }
  );

  // Exactly one open Flood Risk alert for drain 4, escalated to Critical
  const alerts = (await pool.query(
    `
    SELECT * FROM alerts
    WHERE drain_id = 4 AND alert_type = 'Flood Risk' AND alert_status = 'Open'
    `
  )).rows;

  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].severity, "Critical");
});

test("handleMessage - risk falls -> recovery resolves open flood alerts", async () => {
  const io = fakeIo();
  const predict = async () => ({ prediction: "LOW" });

  // Escalate drain 6 (reads build rising history)
  await mqttService.handleMessage(
    "ai-drainos/drains/6/sensors/6",
    JSON.stringify({ water_level: 90, gas_level: 70, temperature: 36 }),
    { io, predict }
  );

  const critical = await mqttService.handleMessage(
    "ai-drainos/drains/6/sensors/6",
    JSON.stringify({ water_level: 95, gas_level: 75, temperature: 37 }),
    { io, predict }
  );

  assert.equal(critical.riskLevel, "CRITICAL");

  // Recover
  const recovered = await mqttService.handleMessage(
    "ai-drainos/drains/6/sensors/6",
    JSON.stringify({ water_level: 10, gas_level: 5, temperature: 28 }),
    { io, predict }
  );

  assert.equal(recovered.status, "accepted");
  assert.equal(recovered.riskLevel, "LOW");

  const alerts = (await pool.query(
    `
    SELECT * FROM alerts
    WHERE drain_id = 6 AND alert_type = 'Flood Risk'
    `
  )).rows;

  assert.ok(alerts.length >= 1);
  assert.ok(alerts.every((a) => a.alert_status === "Resolved"));
});

test("handleMessage - AI unavailable: risk still works and prediction falls back", async () => {
  const io = fakeIo();

  const predict = async () => {
    throw new Error("AI service down");
  };

  const result = await mqttService.handleMessage(
    "ai-drainos/drains/7/sensors/7",
    JSON.stringify({ water_level: 92, gas_level: 70, temperature: 35 }),
    { io, predict }
  );

  assert.equal(result.status, "accepted");
  assert.equal(result.prediction, "HIGH");
  assert.equal(result.source, "fallback");
  assert.ok(result.riskScore > 0);
  assert.ok(["LOW", "MODERATE", "HIGH", "CRITICAL"].includes(result.riskLevel));
});

// --------------------------------------------------
// REST endpoints
// --------------------------------------------------

test("GET /api/predictions/risk/:drainId - returns full explainable risk", async () => {
  const original = mqttService.defaultPredict;
  mqttService.defaultPredict = async () => ({ prediction: "MEDIUM" });

  try {
    const res = await request(app)
      .get("/api/predictions/risk/5")
      .expect(200);

    const body = res.body;

    assert.equal(body.drainId, 5);
    assert.ok(body.sensorId);
    assert.equal(typeof body.riskScore, "number");
    assert.ok(["LOW", "MODERATE", "HIGH", "CRITICAL"].includes(body.riskLevel));
    assert.equal(body.prediction, "MEDIUM");
    assert.ok(["ai", "cached", "throttled", "fallback"].includes(body.predictionSource));
    assert.deepEqual(Object.keys(body.breakdown).sort(), ["gas", "temperature", "trend", "water"]);
    assert.equal(body.factors.length, 4);
    assert.equal(body.factors[0].name, "Water Level");
    assert.ok(body.timestamp);
  } finally {
    mqttService.defaultPredict = original;
  }
});

test("GET /api/predictions/risk/:drainId - missing drain returns 404", async () => {
  const res = await request(app)
    .get("/api/predictions/risk/999999")
    .expect(404);

  assert.ok(res.body.error);
});

test("GET /api/predictions/risk/:drainId - invalid id returns 400", async () => {
  const res = await request(app)
    .get("/api/predictions/risk/abc")
    .expect(400);

  assert.ok(res.body.error);
});

test("GET /api/analytics/risk - returns real risk distribution summary", async () => {
  risk.flushRiskSummaryCache();

  const res = await request(app)
    .get("/api/analytics/risk")
    .expect(200);

  const body = res.body;

  assert.ok(typeof body.totalDrains === "number");
  assert.ok(typeof body.averageRiskScore === "number");
  assert.ok(body.counts);
  assert.deepEqual(Object.keys(body.counts).sort(), ["critical", "high", "low", "moderate"]);
  assert.equal(body.distribution.length, 4);
  assert.ok(Array.isArray(body.drains));
});

test("GET /api/analytics - includes flood risk metrics", async () => {
  risk.flushRiskSummaryCache();

  const res = await request(app)
    .get("/api/analytics")
    .expect(200);

  const body = res.body;

  assert.ok(typeof body.risk_average_score === "number");
  assert.ok(typeof body.risk_low === "number");
  assert.ok(typeof body.risk_high === "number");
  assert.ok(typeof body.risk_critical === "number");
  assert.ok(Array.isArray(body.risk_distribution));
});

test("GET /api/dashboard/risk - returns top-risk drain + summary", async () => {
  const original = mqttService.defaultPredict;
  mqttService.defaultPredict = async () => ({ prediction: "MEDIUM" });

  try {
    risk.flushRiskSummaryCache();

    const res = await request(app)
      .get("/api/dashboard/risk")
      .expect(200);

    const body = res.body;

    assert.ok(body.summary);
    assert.ok(typeof body.summary.averageRiskScore === "number");
    assert.ok(body.summary.counts);
    assert.ok(Array.isArray(body.summary.distribution));

    assert.ok(body.topRisk);
    assert.ok(body.topRisk.drainId);
    assert.ok(body.topRisk.location);
    assert.ok(typeof body.topRisk.riskScore === "number");
    assert.ok(body.topRisk.breakdown);
    assert.ok(Array.isArray(body.topRisk.factors));
    assert.ok(body.topRisk.prediction);
  } finally {
    mqttService.defaultPredict = original;
  }
});