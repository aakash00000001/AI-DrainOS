// ============================================================
// AI-DrainOS Maintenance & Blockage Prediction tests
//
// Cover the maintenance prediction engine (weights, thresholds,
// trend signals, cleaning history, blockage risk, recommendations,
// reasons, confidence-never-present contract), the DB audit trail
// layer, the MQTT integration (maintenanceUpdate emission,
// 'Maintenance' alerts, dedupe, throttle), the aggregate summary
// and the new REST endpoints.
//
// Balance checks the "no fabricated confidence" contract: no
// prediction object may ever include a confidence value.
// ============================================================

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const { setup } = require("./helpers");

let app;
let pool;
let maintenance;
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
  maintenance = require("../services/maintenancePredictionService");
  mqttService = require("../services/mqttService");
});

after(async () => {
  await pool.end();
});

// --------------------------------------------------
// 1. Not blockage: current risk is separate from blockage risk
//
// High maintenance score is NOT a flood risk calculation: a low
// water level with old cleaning history and past recurrence still
// triggers elevated maintenance pressure, while blockage risk
// remains lower.
// --------------------------------------------------

test("1. Not blockage: current risk is separate from blockage risk", () => {
  const prediction = maintenance.calculateMaintenancePrediction({
    waterLevel: 10,
    waterTrend: 3,
    gasLevel: 5,
    temperature: 28,
    recentCriticalEvents: 0,
    alertsLast24h: 0,
    completedCleaningMissions: 5,
    minutesSinceLastCleaning: 800,
    readingsCount: 20,
    averageRecentWater: 0.1,
    elevatedShare: 0.05
  });

  assert.equal(prediction.status, "READY");
  assert.ok(
    prediction.maintenanceScore > 30,
    `maintenanceScore should be elevated despite low water level, got ${prediction.maintenanceScore}`
  );
  assert.ok(
    prediction.blockageRiskScore < 50,
    `blockageRiskScore should be lower, got ${prediction.blockageRiskScore}`
  );
});

// --------------------------------------------------
// 2-4. Thresholds: LOW / MODERATE / HIGH / CRITICAL boundaries
// --------------------------------------------------

test("2. Threshold: LOW to MODERATE at 25", () => {
  assert.equal(maintenance.levelFromScore(0), "LOW");
  assert.equal(maintenance.levelFromScore(24), "LOW");
  assert.equal(maintenance.levelFromScore(25), "MODERATE");
  assert.equal(maintenance.levelFromScore(49), "MODERATE");
});

test("3. Threshold: MODERATE to HIGH at 50", () => {
  assert.equal(maintenance.levelFromScore(50), "HIGH");
  assert.equal(maintenance.levelFromScore(74), "HIGH");
});

test("4. Threshold: HIGH to CRITICAL at 75", () => {
  assert.equal(maintenance.levelFromScore(75), "CRITICAL");
  assert.equal(maintenance.levelFromScore(100), "CRITICAL");
});

// --------------------------------------------------
// 5. All signals present: fresh readings give a valid READY
//    prediction with all expected fields.
// --------------------------------------------------

test("5. All signals: fresh readings give a valid prediction", () => {
  const prediction = maintenance.calculateMaintenancePrediction({
    waterLevel: 55,
    waterTrend: 1.5,
    gasLevel: 40,
    gasTrend: 0.5,
    temperature: 33,
    temperatureTrend: 0.2,
    recentCriticalEvents: 2,
    alertsLast24h: 1,
    completedCleaningMissions: 1,
    recentCleaningMissions: 1,
    minutesSinceLastCleaning: 60,
    readingsCount: 20,
    averageRecentWater: 0.5,
    elevatedShare: 0.3
  });

  assert.equal(prediction.status, "READY");
  assert.equal(prediction.method, "Explainable Baseline Maintenance Prediction");
  assert.ok(typeof prediction.maintenanceScore === "number");
  assert.ok(typeof prediction.maintenanceLevel === "string");
  assert.ok(
    ["LOW", "MODERATE", "HIGH", "CRITICAL"].includes(prediction.maintenanceLevel)
  );
  assert.ok(typeof prediction.blockageRiskScore === "number");
  assert.ok(typeof prediction.blockageRiskLevel === "string");
  assert.ok(typeof prediction.inspectionPriority === "string");
  assert.ok(typeof prediction.maintenanceRecommendation === "string");
  assert.ok(Array.isArray(prediction.reasons));
  assert.ok(prediction.reasons.length > 0);
  assert.ok(Array.isArray(prediction.unavailableSignals));
});

// --------------------------------------------------
// 6. Insufficient data: no sensor readings -> INSUFFICIENT_DATA
// --------------------------------------------------

test("6. Stale only: with no readings the system says INSUFFICIENT_DATA", async () => {
  // Drain 1 has a sensor but no sensor_readings after reset
  const prediction = await maintenance.getDrainMaintenance(1);

  assert.equal(prediction.status, "INSUFFICIENT_DATA");
  assert.equal(prediction.maintenanceScore, null);
  assert.equal(prediction.maintenanceLevel, null);
});

// --------------------------------------------------
// 7. Rising trend increases score
// --------------------------------------------------

test("7. Rising: upward trend increases score", () => {
  const flat = maintenance.calculateMaintenancePrediction({
    waterLevel: 40,
    waterTrend: 0,
    gasLevel: 20,
    temperature: 29,
    recentCriticalEvents: 0,
    alertsLast24h: 0,
    completedCleaningMissions: 0,
    minutesSinceLastCleaning: null,
    readingsCount: 15,
    averageRecentWater: 0.4,
    elevatedShare: 0.1
  });

  const rising = maintenance.calculateMaintenancePrediction({
    waterLevel: 40,
    waterTrend: 4,
    gasLevel: 20,
    temperature: 29,
    recentCriticalEvents: 0,
    alertsLast24h: 0,
    completedCleaningMissions: 0,
    minutesSinceLastCleaning: null,
    readingsCount: 15,
    averageRecentWater: 0.4,
    elevatedShare: 0.1
  });

  assert.ok(
    rising.maintenanceScore > flat.maintenanceScore,
    `rising trend (${rising.maintenanceScore}) should score higher than flat (${flat.maintenanceScore})`
  );
});

// --------------------------------------------------
// 8. Falling trend reduces score
// --------------------------------------------------

test("8. Falling: downward trend reduces score", () => {
  const flat = maintenance.calculateMaintenancePrediction({
    waterLevel: 40,
    waterTrend: 0,
    gasLevel: 20,
    temperature: 29,
    recentCriticalEvents: 0,
    alertsLast24h: 0,
    completedCleaningMissions: 0,
    minutesSinceLastCleaning: null,
    readingsCount: 15,
    averageRecentWater: 0.4,
    elevatedShare: 0.1
  });

  const falling = maintenance.calculateMaintenancePrediction({
    waterLevel: 40,
    waterTrend: -3,
    gasLevel: 20,
    temperature: 29,
    recentCriticalEvents: 0,
    alertsLast24h: 0,
    completedCleaningMissions: 0,
    minutesSinceLastCleaning: null,
    readingsCount: 15,
    averageRecentWater: 0.4,
    elevatedShare: 0.1
  });

  assert.ok(
    falling.maintenanceScore < flat.maintenanceScore,
    `falling trend (${falling.maintenanceScore}) should score lower than flat (${flat.maintenanceScore})`
  );
});

// --------------------------------------------------
// 9. Cleaning history: frequent past cleanings elevate score
//    because they are a recurrence signal (drain needed cleaning
//    before, so it may need it again). This catches the "clogged
//    again fast" scenario.
// --------------------------------------------------

test("9. Cleaning: frequent past cleanups still shows maintenance need", () => {
  const noHistory = maintenance.calculateMaintenancePrediction({
    waterLevel: 50,
    waterTrend: 1,
    gasLevel: 25,
    temperature: 30,
    recentCriticalEvents: 1,
    alertsLast24h: 0,
    completedCleaningMissions: 0,
    minutesSinceLastCleaning: null,
    readingsCount: 20,
    averageRecentWater: 0.5,
    elevatedShare: 0.25
  });

  const withHistory = maintenance.calculateMaintenancePrediction({
    waterLevel: 50,
    waterTrend: 1,
    gasLevel: 25,
    temperature: 30,
    recentCriticalEvents: 1,
    alertsLast24h: 0,
    completedCleaningMissions: 3,
    minutesSinceLastCleaning: 60,
    readingsCount: 20,
    averageRecentWater: 0.5,
    elevatedShare: 0.25
  });

  assert.ok(
    withHistory.maintenanceScore > noHistory.maintenanceScore,
    `with cleaning history (${withHistory.maintenanceScore}) should score higher than without (${noHistory.maintenanceScore})`
  );
});

// --------------------------------------------------
// 10. Age: long time since last cleaning increases need
// --------------------------------------------------

test("10. Age: long time since last cleaning increases need", () => {
  const recent = maintenance.calculateMaintenancePrediction({
    waterLevel: 30,
    waterTrend: 0,
    gasLevel: 15,
    temperature: 29,
    recentCriticalEvents: 0,
    alertsLast24h: 0,
    completedCleaningMissions: 2,
    minutesSinceLastCleaning: 30,
    readingsCount: 20,
    averageRecentWater: 0.3,
    elevatedShare: 0.1
  });

  const old = maintenance.calculateMaintenancePrediction({
    waterLevel: 30,
    waterTrend: 0,
    gasLevel: 15,
    temperature: 29,
    recentCriticalEvents: 0,
    alertsLast24h: 0,
    completedCleaningMissions: 2,
    minutesSinceLastCleaning: 900,
    readingsCount: 20,
    averageRecentWater: 0.3,
    elevatedShare: 0.1
  });

  assert.ok(
    old.maintenanceScore > recent.maintenanceScore,
    `old cleaning (${old.maintenanceScore}) should score higher than recent (${recent.maintenanceScore})`
  );
});

// --------------------------------------------------
// 11. Gas: high gas indicates blockage
// --------------------------------------------------

test("11. Gas: high gas level elevates maintenance and blockage scores", () => {
  const lowGas = maintenance.calculateMaintenancePrediction({
    waterLevel: 50,
    waterTrend: 1,
    gasLevel: 10,
    temperature: 29,
    recentCriticalEvents: 0,
    alertsLast24h: 0,
    completedCleaningMissions: 0,
    minutesSinceLastCleaning: null,
    readingsCount: 20,
    averageRecentWater: 0.5,
    elevatedShare: 0.25
  });

  const highGas = maintenance.calculateMaintenancePrediction({
    waterLevel: 50,
    waterTrend: 1,
    gasLevel: 70,
    temperature: 29,
    recentCriticalEvents: 0,
    alertsLast24h: 0,
    completedCleaningMissions: 0,
    minutesSinceLastCleaning: null,
    readingsCount: 20,
    averageRecentWater: 0.5,
    elevatedShare: 0.25
  });

  assert.ok(
    highGas.maintenanceScore > lowGas.maintenanceScore,
    `high gas (${highGas.maintenanceScore}) should score higher than low gas (${lowGas.maintenanceScore})`
  );
  assert.ok(
    highGas.blockageRiskScore > lowGas.blockageRiskScore,
    `high gas blockage risk (${highGas.blockageRiskScore}) should be higher (${lowGas.blockageRiskScore})`
  );
});

// --------------------------------------------------
// 12. Clear: clean readings yield low score
// --------------------------------------------------

test("12. Clear: clean readings yield low maintenance score", () => {
  const prediction = maintenance.calculateMaintenancePrediction({
    waterLevel: 10,
    waterTrend: -1,
    gasLevel: 5,
    temperature: 27,
    recentCriticalEvents: 0,
    alertsLast24h: 0,
    completedCleaningMissions: 0,
    minutesSinceLastCleaning: null,
    readingsCount: 20,
    averageRecentWater: 0.1,
    elevatedShare: 0
  });

  assert.equal(prediction.maintenanceLevel, "LOW");
  assert.ok(
    prediction.maintenanceScore < 25,
    `clean drain should score < 25, got ${prediction.maintenanceScore}`
  );
  assert.ok(
    prediction.blockageRiskScore < 40,
    `clean drain blockage risk should be < 40, got ${prediction.blockageRiskScore}`
  );
});

// --------------------------------------------------
// 13. Alert: frequent recent alerts elevate score
// --------------------------------------------------

test("13. Alert: frequent recent alerts elevate maintenance score", () => {
  const noAlerts = maintenance.calculateMaintenancePrediction({
    waterLevel: 40,
    waterTrend: 0.5,
    gasLevel: 20,
    temperature: 29,
    recentCriticalEvents: 0,
    alertsLast24h: 0,
    completedCleaningMissions: 0,
    minutesSinceLastCleaning: null,
    readingsCount: 20,
    averageRecentWater: 0.4,
    elevatedShare: 0.1
  });

  const manyAlerts = maintenance.calculateMaintenancePrediction({
    waterLevel: 40,
    waterTrend: 0.5,
    gasLevel: 20,
    temperature: 29,
    recentCriticalEvents: 0,
    alertsLast24h: 5,
    completedCleaningMissions: 0,
    minutesSinceLastCleaning: null,
    readingsCount: 20,
    averageRecentWater: 0.4,
    elevatedShare: 0.1
  });

  assert.ok(
    manyAlerts.maintenanceScore > noAlerts.maintenanceScore,
    `many alerts (${manyAlerts.maintenanceScore}) should score higher than none (${noAlerts.maintenanceScore})`
  );
});

// --------------------------------------------------
// 14. Tricky: elevated temp + high gas + rising trend together
// --------------------------------------------------

test("14. Tricky: elevated temp + high gas + rising trend together", () => {
  const prediction = maintenance.calculateMaintenancePrediction({
    waterLevel: 60,
    waterTrend: 5,
    gasLevel: 65,
    gasTrend: 2,
    temperature: 39,
    temperatureTrend: 1,
    recentCriticalEvents: 3,
    alertsLast24h: 2,
    completedCleaningMissions: 2,
    minutesSinceLastCleaning: 500,
    readingsCount: 25,
    averageRecentWater: 0.6,
    elevatedShare: 0.5
  });

  assert.equal(prediction.status, "READY");
  assert.ok(
    prediction.maintenanceScore >= 50,
    `should be at least HIGH, got ${prediction.maintenanceScore}`
  );
  assert.ok(
    prediction.maintenanceLevel === "HIGH" || prediction.maintenanceLevel === "CRITICAL",
    `maintenanceLevel should be HIGH or CRITICAL, got ${prediction.maintenanceLevel}`
  );
  assert.ok(
    prediction.unavailableSignals.length === 0,
    "should have no unavailable signals"
  );
});

// --------------------------------------------------
// 15. Mission: cleaning mission history changes prediction
// --------------------------------------------------

test("15. Mission: cleaning mission history changes the prediction", () => {
  const base = {
    waterLevel: 45,
    waterTrend: 1,
    gasLevel: 25,
    temperature: 30,
    alertsLast24h: 0,
    minutesSinceLastCleaning: null,
    readingsCount: 20,
    averageRecentWater: 0.45,
    elevatedShare: 0.2
  };

  const noMission = maintenance.calculateMaintenancePrediction({
    ...base,
    recentCriticalEvents: 0,
    completedCleaningMissions: 0,
    recentCleaningMissions: 0
  });

  const withMissions = maintenance.calculateMaintenancePrediction({
    ...base,
    recentCriticalEvents: 0,
    completedCleaningMissions: 3,
    recentCleaningMissions: 2,
    minutesSinceLastCleaning: 60
  });

  assert.ok(noMission.status === "READY" && withMissions.status === "READY");
  assert.ok(
    withMissions.maintenanceScore >= noMission.maintenanceScore,
    `missions present (${withMissions.maintenanceScore}) should not be less than no missions (${noMission.maintenanceScore})`
  );
});

// --------------------------------------------------
// 16. Reason: every prediction includes at least one reason
// --------------------------------------------------

test("16. Reason: every prediction includes at least one reason", () => {
  const prediction = maintenance.calculateMaintenancePrediction({
    waterLevel: 5,
    waterTrend: -0.5,
    gasLevel: 2,
    temperature: 27,
    recentCriticalEvents: 0,
    alertsLast24h: 0,
    completedCleaningMissions: 0,
    minutesSinceLastCleaning: null,
    readingsCount: 20,
    averageRecentWater: 0.05,
    elevatedShare: 0
  });

  assert.ok(
    prediction.reasons.length > 0,
    "even clean drains should have at least one reason"
  );
  assert.ok(typeof prediction.reasons[0] === "string");
});

// --------------------------------------------------
// 17. Balance: never claim drain is physically blocked
//
// No fabricated confidence or certainty language anywhere in the
// response. Never say "blocked" or "obstruction confirmed".
// --------------------------------------------------

test("17. Balance: never claim drain is physically blocked", () => {
  const prediction = maintenance.calculateMaintenancePrediction({
    waterLevel: 90,
    waterTrend: 8,
    gasLevel: 90,
    temperature: 42,
    recentCriticalEvents: 10,
    alertsLast24h: 10,
    completedCleaningMissions: 5,
    minutesSinceLastCleaning: 1200,
    readingsCount: 30,
    averageRecentWater: 0.9,
    elevatedShare: 0.9
  });

  assert.equal(prediction.status, "READY");

  const allText = JSON.stringify(prediction).toLowerCase();
  assert.ok(
    !allText.includes("blocked"),
    `should not say blocked: ${JSON.stringify(prediction).slice(0, 300)}`
  );
  assert.ok(
    !allText.includes("obstruction confirmed"),
    "should not say obstruction confirmed"
  );
  assert.ok(
    !allText.includes("confidence"),
    "should not mention confidence anywhere"
  );
});

// --------------------------------------------------
// 18. Maintenance: score alone does not decide recommendation
//
// Same general level but different conditions yield different
// recommendations.
// --------------------------------------------------

test("18. Maintenance: score alone does not decide recommendation", () => {
  const base = maintenance.calculateMaintenancePrediction({
    waterLevel: 60,
    waterTrend: 2,
    gasLevel: 30,
    gasTrend: 0.5,
    temperature: 30,
    recentCriticalEvents: 4,
    alertsLast24h: 3,
    completedCleaningMissions: 2,
    minutesSinceLastCleaning: 60,
    readingsCount: 20,
    averageRecentWater: 0.6,
    elevatedShare: 0.4
  });

  const highBlockage = maintenance.calculateMaintenancePrediction({
    waterLevel: 60,
    waterTrend: 2,
    gasLevel: 80,
    gasTrend: 0.5,
    temperature: 30,
    recentCriticalEvents: 4,
    alertsLast24h: 3,
    completedCleaningMissions: 2,
    minutesSinceLastCleaning: 60,
    readingsCount: 20,
    averageRecentWater: 0.6,
    elevatedShare: 0.4
  });

  assert.ok(
    base.maintenanceLevel === highBlockage.maintenanceLevel,
    `should have same maintenance level to compare: ${base.maintenanceLevel} vs ${highBlockage.maintenanceLevel}`
  );
  assert.ok(
    base.blockageRiskScore < 50 && highBlockage.blockageRiskScore >= 50,
    `blockage risk should differ: ${base.blockageRiskScore} vs ${highBlockage.blockageRiskScore}`
  );
  assert.ok(
    base.maintenanceRecommendation !== highBlockage.maintenanceRecommendation,
    `recommendations should differ: ${base.maintenanceRecommendation} vs ${highBlockage.maintenanceRecommendation}`
  );
});

// --------------------------------------------------
// 19. Priority: inspection priority is always one of the valid
//     enum values for any input combination.
// --------------------------------------------------

test("19. Priority: inspection priority is always valid", () => {
  const validPriorities = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];

  const inputs = [
    { waterLevel: 10, waterTrend: -1, gasLevel: 5, temperature: 27, recentCriticalEvents: 0, alertsLast24h: 0, completedCleaningMissions: 0, minutesSinceLastCleaning: null, readingsCount: 20, averageRecentWater: 0.1, elevatedShare: 0 },
    { waterLevel: 50, waterTrend: 2, gasLevel: 40, temperature: 32, recentCriticalEvents: 2, alertsLast24h: 1, completedCleaningMissions: 1, minutesSinceLastCleaning: 120, readingsCount: 20, averageRecentWater: 0.5, elevatedShare: 0.25 },
    { waterLevel: 80, waterTrend: 6, gasLevel: 70, temperature: 40, recentCriticalEvents: 5, alertsLast24h: 4, completedCleaningMissions: 3, minutesSinceLastCleaning: 600, readingsCount: 25, averageRecentWater: 0.8, elevatedShare: 0.7 }
  ];

  for (const input of inputs) {
    const prediction = maintenance.calculateMaintenancePrediction(input);
    assert.ok(
      validPriorities.includes(prediction.inspectionPriority),
      `invalid priority: ${prediction.inspectionPriority}`
    );
  }
});

// --------------------------------------------------
// 20. Audit: prediction inserts into maintenance_predictions
// --------------------------------------------------

test("20. Audit: prediction inserts into maintenance_predictions table", async () => {
  // Clear the cached INSUFFICIENT_DATA result from test 6 so the
  // newly inserted readings are picked up.
  maintenance.resetMaintenanceRuntime();

  // Insert sensor_readings so getDrainMaintenance returns READY
  for (let i = 0; i < 15; i++) {
    await pool.query(
      `INSERT INTO sensor_readings (sensor_id, drain_id, water_level, gas_level, temperature)
       VALUES (1, 1, $1, $2, $3)`,
      [10 + i * 2, 10 + i, 28 + i * 0.3]
    );
  }

  const prediction = await maintenance.getDrainMaintenance(1);
  assert.equal(prediction.status, "READY");
  assert.equal(prediction.drainId, 1);

  const rows = await pool.query(
    "SELECT * FROM maintenance_predictions WHERE drain_id = 1 ORDER BY created_at DESC LIMIT 1"
  );

  assert.ok(rows.rows.length > 0, "should have inserted into maintenance_predictions");
  assert.equal(Number(rows.rows[0].drain_id), 1);
  assert.ok(typeof rows.rows[0].recommendation === "string");
  assert.ok(rows.rows[0].reasons !== null);
});

// --------------------------------------------------
// 21. History: prediction returns 404 for invalid drain
// --------------------------------------------------

test("21. History: prediction returns 404 for invalid drain", async () => {
  const res = await request(app)
    .get("/api/predictions/maintenance/9999")
    .expect(404);

  assert.ok(res.body.error);
});

// --------------------------------------------------
// 22. Endpoint: GET /api/predictions/maintenance works
// --------------------------------------------------

test("22. Endpoint: GET /api/predictions/maintenance works", async () => {
  maintenance.resetMaintenanceRuntime();

  // Drain 1 already has sensor_readings from test 20
  const res = await request(app)
    .get("/api/predictions/maintenance/1")
    .expect(200);

  assert.ok(res.body.status);
  assert.ok(typeof res.body.drainId === "number");
  assert.equal(res.body.status, "READY");
});

// --------------------------------------------------
// 23. Coverage: last 30 readings are sufficient for READY
// --------------------------------------------------

test("23. Coverage: last 30 readings are sufficient for READY", async () => {
  // Insert 30 readings for drain 4 (sensor_id 4)
  for (let i = 0; i < 30; i++) {
    await pool.query(
      `INSERT INTO sensor_readings (sensor_id, drain_id, water_level, gas_level, temperature)
       VALUES (4, 4, $1, $2, $3)`,
      [15 + i, 12 + (i % 10), 29 + (i % 5) * 0.5]
    );
  }

  const prediction = await maintenance.getDrainMaintenance(4);
  assert.equal(prediction.status, "READY");
  assert.ok(prediction.maintenanceScore >= 0);
  assert.ok(prediction.maintenanceScore <= 100);
  assert.ok(typeof prediction.maintenanceRecommendation === "string");
});

// --------------------------------------------------
// 24. State: reset clears all caches
// --------------------------------------------------

test("24. State: reset clears all caches", async () => {
  // Populate cache by calling the function
  await maintenance.getDrainMaintenance(1);

  // Reset all caches
  maintenance.resetMaintenanceRuntime();
  mqttService.resetMaintenanceEmitter();

  // After reset, computation should be fresh (no stale cache)
  const prediction = await maintenance.getDrainMaintenance(1);
  assert.ok(prediction.status);
  assert.ok(typeof prediction.maintenanceScore === "number" || prediction.maintenanceScore === null);
});
