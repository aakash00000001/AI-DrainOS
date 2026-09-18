// ============================================================
// AI-DrainOS — Sensor Intelligence service tests (UPDATE #21)
//
// Verifies the advanced IoT sensor intelligence & anomaly
// detection layer:
//   * health score banding + honest INSUFFICIENT_DATA
//   * SPIKE / DROP / RAPID_CHANGE / STUCK_SENSOR / STALE_SENSOR /
//     MISSING_DATA / OUT_OF_RANGE / NOISE detection
//   * deterministic analysis, bounded history, timestamp handling
//   * drain-level aggregation + cross-sensor consistency
//   * signature-guarded live emission (no per-tick spam)
//   * severe sensor incidents: deduped, cooldown-guarded and NEVER
//     dispatching a robot
//
// Every anomaly is derived from real reading rows / constructed
// sequences - no fabricated production state is used.
// ============================================================

const { test, before, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const { setup } = require("./helpers");

let app;
let pool;
let service;
let socketHub;
let incidentService;

const captured = [];

const fakeIo = {
  emit(event, payload) {
    captured.push({ event, payload });
  }
};

const START = Date.UTC(2025, 0, 1, 0, 0, 0);
const MIN = 60 * 1000;

function readsFromWater(values, { start = START, step = MIN } = {}) {
  return values.map((water, i) => ({
    water_level: water,
    gas_level: 10,
    temperature: 25,
    recordedAt: start + i * step
  }));
}

function sensorStub(overrides = {}) {
  return {
    id: 1,
    drain_id: 1,
    sensor_status: "Active",
    status: "Normal",
    location: "Zone 1",
    zone_name: "Zone 1",
    ...overrides
  };
}

function nowAfter(readings, extraMs = MIN) {
  return readings[readings.length - 1].recordedAt + extraMs;
}

async function clearReadings() {
  await pool.query("DELETE FROM sensor_readings");
  await pool.query("DELETE FROM incidents");
  service.resetSensorIntelligenceRuntime();
  captured.length = 0;
}

async function insertReadings(sensorId, drainId, values, options = {}) {
  const readings = readsFromWater(values, options);
  for (const reading of readings) {
    await pool.query(
      `
      INSERT INTO sensor_readings (sensor_id, drain_id, water_level, gas_level, temperature, recorded_at)
      VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [
        sensorId,
        drainId,
        reading.water_level,
        reading.gas_level,
        reading.temperature,
        new Date(reading.recordedAt).toISOString()
      ]
    );
  }
  return readings;
}

before(async () => {
  const setupResult = await setup();
  app = setupResult.app;
  pool = setupResult.pool;

  service = require("../services/sensorIntelligenceService");
  socketHub = require("../services/socketHub");
  incidentService = require("../services/incidentService");
  socketHub.init(fakeIo);
});

beforeEach(async () => {
  await clearReadings();
});

// ------------------------------------------------------------
// Health status banding
// ------------------------------------------------------------

test("healthStatusFromScore maps the documented bands", () => {
  assert.equal(service.healthStatusFromScore(100), "HEALTHY");
  assert.equal(service.healthStatusFromScore(90), "HEALTHY");
  assert.equal(service.healthStatusFromScore(89), "GOOD");
  assert.equal(service.healthStatusFromScore(75), "GOOD");
  assert.equal(service.healthStatusFromScore(74), "DEGRADED");
  assert.equal(service.healthStatusFromScore(50), "DEGRADED");
  assert.equal(service.healthStatusFromScore(49), "POOR");
  assert.equal(service.healthStatusFromScore(25), "POOR");
  assert.equal(service.healthStatusFromScore(24), "CRITICAL");
  assert.equal(service.healthStatusFromScore(0), "CRITICAL");
  assert.equal(service.healthStatusFromScore(null), "INSUFFICIENT_DATA");
});

// ------------------------------------------------------------
// Insufficient data + clean data
// ------------------------------------------------------------

test("fewer than MIN_READINGS yields INSUFFICIENT_DATA with a null score", () => {
  const readings = readsFromWater([10, 11, 12]);
  const anomalies = service.detectAnomalies({
    sensorId: 1,
    drainId: 1,
    readings,
    now: nowAfter(readings),
    sensor: sensorStub()
  });
  const health = service.computeHealth({
    readings,
    anomalies,
    now: nowAfter(readings),
    sensor: sensorStub()
  });

  assert.equal(health.healthScore, null);
  assert.equal(health.healthStatus, "INSUFFICIENT_DATA");
  assert.ok(health.reasons.length > 0);
});

test("a clean stable window reports no anomalies and a healthy score", () => {
  const values = [20, 21, 20, 21, 22, 21, 20, 21, 22, 21, 20, 21];
  const readings = readsFromWater(values);
  const anomalies = service.detectAnomalies({
    sensorId: 1,
    drainId: 1,
    readings,
    now: nowAfter(readings),
    sensor: sensorStub()
  });
  const health = service.computeHealth({
    readings,
    anomalies,
    now: nowAfter(readings),
    sensor: sensorStub()
  });

  assert.equal(anomalies.length, 0);
  assert.equal(health.healthStatus, "HEALTHY");
  assert.ok(health.healthScore >= 90);
});

// ------------------------------------------------------------
// Individual anomaly types
// ------------------------------------------------------------

test("SPIKE is detected for a single large upward jump", () => {
  const readings = readsFromWater([
    10, 10, 11, 10, 11, 10, 10, 11, 10, 10, 10, 80
  ]);
  const anomalies = service.detectAnomalies({
    sensorId: 1,
    drainId: 1,
    readings,
    now: nowAfter(readings),
    sensor: sensorStub()
  });

  const spike = anomalies.find((a) => a.type === "SPIKE");
  assert.ok(spike, "expected a SPIKE anomaly");
  assert.equal(spike.severity, "CRITICAL");
  assert.equal(spike.sensorId, 1);
  assert.equal(spike.drainId, 1);
  assert.ok(spike.evidence.channel === "water_level");
  assert.ok(spike.message.includes("spike"));
  assert.ok(spike.affectedWindow.samples > 0);
  assert.ok(spike.detectedAt);
});

test("DROP is detected for a single large downward jump", () => {
  const readings = readsFromWater([
    80, 80, 81, 80, 80, 81, 80, 80, 80, 80, 80, 10
  ]);
  const anomalies = service.detectAnomalies({
    sensorId: 1,
    drainId: 1,
    readings,
    now: nowAfter(readings),
    sensor: sensorStub()
  });

  const drop = anomalies.find((a) => a.type === "DROP");
  assert.ok(drop, "expected a DROP anomaly");
  assert.ok(drop.message.includes("drop"));
});

test("RAPID_CHANGE is detected for a sustained rise across the window", () => {
  const readings = readsFromWater([
    10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65
  ]);
  const anomalies = service.detectAnomalies({
    sensorId: 1,
    drainId: 1,
    readings,
    now: nowAfter(readings),
    sensor: sensorStub()
  });

  const rapid = anomalies.find((a) => a.type === "RAPID_CHANGE");
  assert.ok(rapid, "expected a RAPID_CHANGE anomaly");
  assert.ok(rapid.evidence.netChange > 0);
});

test("STUCK_SENSOR is detected for constant values over a meaningful span", () => {
  const readings = readsFromWater(Array(12).fill(40), { step: 5 * MIN });
  const anomalies = service.detectAnomalies({
    sensorId: 1,
    drainId: 1,
    readings,
    now: nowAfter(readings),
    sensor: sensorStub()
  });

  const stuck = anomalies.find((a) => a.type === "STUCK_SENSOR");
  assert.ok(stuck, "expected a STUCK_SENSOR anomaly");
  assert.equal(stuck.severity, "HIGH");
});

test("STALE_SENSOR is detected when the latest reading is old", () => {
  const readings = readsFromWater([20, 21, 20, 21]);
  const now = nowAfter(readings, 30 * MIN);
  const anomalies = service.detectAnomalies({
    sensorId: 1,
    drainId: 1,
    readings,
    now,
    sensor: sensorStub()
  });

  const stale = anomalies.find((a) => a.type === "STALE_SENSOR");
  assert.ok(stale, "expected a STALE_SENSOR anomaly");
  assert.ok(stale.evidence.ageMinutes >= 30);
});

test("MISSING_DATA is detected for a real gap between readings", () => {
  const readings = readsFromWater([20, 21, 20, 21, 20, 21], { step: MIN });
  // Introduce a 20 minute gap before the last reading.
  readings[5].recordedAt = readings[4].recordedAt + 20 * MIN;
  const anomalies = service.detectAnomalies({
    sensorId: 1,
    drainId: 1,
    readings,
    now: nowAfter(readings),
    sensor: sensorStub()
  });

  const missing = anomalies.find((a) => a.type === "MISSING_DATA");
  assert.ok(missing, "expected a MISSING_DATA anomaly");
  assert.ok(missing.evidence.gapMinutes >= 20);
});

test("OUT_OF_RANGE is detected only against the real physical range", () => {
  const readings = readsFromWater([10, 11, 10, 11, 10, 11, 10, 11, 10, 150]);
  const anomalies = service.detectAnomalies({
    sensorId: 1,
    drainId: 1,
    readings,
    now: nowAfter(readings),
    sensor: sensorStub()
  });

  const outOfRange = anomalies.find((a) => a.type === "OUT_OF_RANGE");
  assert.ok(outOfRange, "expected an OUT_OF_RANGE anomaly");
  assert.equal(outOfRange.evidence.value, 150);
  assert.equal(outOfRange.evidence.max, 100);
});

test("NOISE is detected for oscillating unstable readings", () => {
  const readings = readsFromWater([
    20, 30, 20, 30, 20, 30, 20, 30, 20, 30
  ]);
  const anomalies = service.detectAnomalies({
    sensorId: 1,
    drainId: 1,
    readings,
    now: nowAfter(readings),
    sensor: sensorStub()
  });

  const noise = anomalies.find((a) => a.type === "NOISE");
  assert.ok(noise, "expected a NOISE anomaly");
  assert.equal(noise.severity, "LOW");
});

// ------------------------------------------------------------
// Determinism + timestamps
// ------------------------------------------------------------

test("analysis is deterministic for the same input and reference time", () => {
  const readings = readsFromWater([
    10, 11, 10, 11, 10, 11, 10, 11, 10, 90
  ]);
  const now = nowAfter(readings);

  const first = service.detectAnomalies({
    sensorId: 1,
    drainId: 1,
    readings,
    now,
    sensor: sensorStub()
  });
  const second = service.detectAnomalies({
    sensorId: 1,
    drainId: 1,
    readings,
    now,
    sensor: sensorStub()
  });

  assert.deepEqual(first, second);
});

test("detectAnomalies tolerates missing timestamps and empty input", () => {
  assert.deepEqual(
    service.detectAnomalies({ sensorId: 1, drainId: 1, readings: [], now: Date.now() }),
    []
  );

  const readings = readsFromWater([20, 21, 20]).map((r) => ({ ...r, recordedAt: null }));
  const anomalies = service.detectAnomalies({
    sensorId: 1,
    drainId: 1,
    readings,
    now: Date.now(),
    sensor: sensorStub()
  });
  assert.ok(Array.isArray(anomalies));
});

// ------------------------------------------------------------
// Bounded history + DB integration
// ------------------------------------------------------------

test("getSensorReadings is bounded and chronological", async () => {
  const values = Array.from({ length: 40 }, (_, i) => i + 1);
  await insertReadings(1, 1, values, { step: MIN });

  const readings = await service.getSensorReadings(1);

  assert.equal(readings.length, service.HISTORY_WINDOW);
  assert.ok(readings.length <= service.MAX_READINGS);

  for (let i = 1; i < readings.length; i += 1) {
    assert.ok(readings[i].recordedAt >= readings[i - 1].recordedAt);
  }
});

test("buildSensorIntelligence stores an explainable reason list", async () => {
  const values = [10, 10, 11, 10, 11, 10, 10, 11, 10, 10, 10, 90];
  await insertReadings(1, 1, values);

  const intelligence = await service.getSensorIntelligenceById(1);

  assert.equal(intelligence.sensorId, 1);
  assert.equal(intelligence.drainId, 1);
  assert.ok(intelligence.anomalyCount >= 1);
  assert.ok(intelligence.reasons.length > 0);
  assert.ok(intelligence.signals.readingsAnalysed > 0);
});

test("drain aggregation reports counts and cross-sensor consistency", async () => {
  const second = await pool.query(
    "INSERT INTO sensors (drain_id, water_level, gas_level, temperature, status) VALUES (2, 20, 10, 25, 'Normal') RETURNING id"
  );

  const sensorB = second.rows[0].id;

  await insertReadings(2, 2, Array(12).fill(20));
  await insertReadings(sensorB, 2, Array(12).fill(80));

  const drain = await service.getDrainSensorIntelligence(2);

  assert.equal(drain.totalSensors, 2);
  assert.equal(drain.anomalyCount >= 0, true);
  assert.equal(drain.crossSensorConsistency.status, "INCONSISTENT");
  assert.ok(drain.averageHealthScore !== null);

  await pool.query("DELETE FROM sensors WHERE id = $1", [sensorB]);
});

test("cross-sensor consistency is INSUFFICIENT_DATA with one sensor", () => {
  const sensors = [
    service.buildSensorIntelligence({
      sensor: sensorStub(),
      readings: readsFromWater(Array(12).fill(20)),
      now: START + 12 * MIN
    })
  ];

  const consistency = service.buildCrossSensorConsistency(sensors);
  assert.equal(consistency.status, "INSUFFICIENT_DATA");
});

// ------------------------------------------------------------
// Signature-guarded emission
// ------------------------------------------------------------

test("evaluateAndEmitSensorIntelligence emits once and dedupes repeats", async () => {
  await insertReadings(1, 1, Array(12).fill(20));

  const first = await service.evaluateAndEmitSensorIntelligence();
  const second = await service.evaluateAndEmitSensorIntelligence();

  assert.equal(first.emitted, true);
  assert.equal(second.emitted, false);

  const emissions = captured.filter((c) => c.event === "sensorIntelligenceUpdate");
  assert.equal(emissions.length, 1);
  assert.ok(emissions[0].payload.summary);
});

test("per-drain emission only covers that drain", async () => {
  await insertReadings(1, 1, Array(12).fill(30));
  await insertReadings(2, 2, Array(12).fill(40));

  captured.length = 0;
  await service.evaluateAndEmitSensorIntelligence({ drainId: 1 });

  const emissions = captured.filter((c) => c.event === "sensorIntelligenceUpdate");
  assert.equal(emissions.length, 1);
  assert.equal(emissions[0].payload.drains.length, 1);
  assert.equal(emissions[0].payload.drains[0].drainId, 1);
});

// ------------------------------------------------------------
// Incident safeguards
// ------------------------------------------------------------

test("a severe sensor issue opens one SENSOR incident with no robot", async () => {
  await pool.query("DELETE FROM incidents");
  service.resetSensorIntelligenceRuntime();

  const readings = readsFromWater([
    10, 10, 11, 10, 11, 10, 10, 11, 10, 10, 10, 95
  ]);

  const intelligence = service.buildSensorIntelligence({
    sensor: sensorStub(),
    readings,
    now: nowAfter(readings)
  });

  assert.equal(service.isSevereSensorIssue(intelligence), true);

  await service.ensureSensorIncidents([intelligence], Date.now());

  const incidents = await pool.query(
    "SELECT source, severity, assigned_robot_id, route_status FROM incidents WHERE drain_id = 1"
  );

  assert.equal(incidents.rows.length, 1);
  assert.equal(incidents.rows[0].source, "SENSOR");
  assert.equal(incidents.rows[0].assigned_robot_id, null);
});

test("sensor incidents are cooldown-guarded against storms", async () => {
  await pool.query("DELETE FROM incidents");
  service.resetSensorIntelligenceRuntime();

  const readings = readsFromWater([
    10, 10, 11, 10, 11, 10, 10, 11, 10, 10, 10, 95
  ]);
  const intelligence = service.buildSensorIntelligence({
    sensor: sensorStub(),
    readings,
    now: nowAfter(readings)
  });

  await service.ensureSensorIncidents([intelligence], Date.now());
  await service.ensureSensorIncidents([intelligence], Date.now());

  const incidents = await pool.query(
    "SELECT COUNT(*) FROM incidents WHERE drain_id = 1"
  );

  assert.equal(Number(incidents.rows[0].count), 1);
});

// ------------------------------------------------------------
// Additive dashboard + analytics shapes
// ------------------------------------------------------------

test("dashboard + analytics views expose the additive fields", async () => {
  await insertReadings(1, 1, Array(12).fill(20));

  const dashboard = await service.getDashboardSummary();
  assert.ok(dashboard.sensorIntelligence);
  assert.ok(dashboard.sensorHealthSummary);
  assert.ok(dashboard.sensorAnomalySummary);
  assert.equal(typeof dashboard.sensorHealthSummary.totalSensors, "number");

  const analytics = await service.getAnalytics();
  assert.ok(analytics.health_distribution);
  assert.equal(typeof analytics.anomaly_count, "number");
  assert.equal(analytics.health_trend_status, "INSUFFICIENT_DATA");
});

// ------------------------------------------------------------
// Additive context for the existing engines (TTL-cached)
// ------------------------------------------------------------

test("getSensorContextCached - same shape as getSensorContext and reused within TTL", async () => {
  const readings = await insertReadings(1, 1, Array(12).fill(20));
  const t0 = nowAfter(readings);

  const uncached = await service.getSensorContext(1, { now: t0 });
  assert.ok(uncached);
  assert.equal(typeof uncached.healthStatus, "string");
  assert.equal(typeof uncached.averageHealthScore, "number");
  assert.equal(typeof uncached.totalSensors, "number");
  assert.equal(typeof uncached.anomalyCount, "number");
  assert.ok(uncached.disclaimer);

  const first = await service.getSensorContextCached(1, { now: t0 });
  const second = await service.getSensorContextCached(1, { now: t0 });

  assert.deepEqual(first, uncached);
  assert.strictEqual(second, first);
});

test("getSensorContextCached - expires after the TTL and recomputes", async () => {
  const readings = await insertReadings(1, 1, Array(12).fill(20));
  const t0 = nowAfter(readings);

  const first = await service.getSensorContextCached(1, { now: t0 });
  const expired = await service.getSensorContextCached(1, {
    now: t0 + service.CONTEXT_CACHE_TTL_MS
  });

  assert.ok(first);
  assert.ok(expired);
  assert.notEqual(expired, first);
  assert.equal(expired.drainId, 1);
  assert.equal(typeof expired.averageHealthScore, "number");
});

test("getSensorContextCached - reset clears entries and uncached drains stay uncached", async () => {
  const readings = await insertReadings(1, 1, Array(12).fill(20));
  const t0 = nowAfter(readings);

  const first = await service.getSensorContextCached(1, { now: t0 });

  service.resetSensorContextCache();
  const afterReset = await service.getSensorContextCached(1, { now: t0 });
  assert.notEqual(afterReset, first);
  assert.deepEqual(afterReset, first);

  const missing = await service.getSensorContextCached(999999, { now: t0 });
  const missingAgain = await service.getSensorContextCached(999999, { now: t0 });
  assert.equal(missing, null);
  assert.equal(missingAgain, null);

  service.resetSensorIntelligenceRuntime();
  const afterRuntimeReset = await service.getSensorContextCached(1, { now: t0 });
  assert.notEqual(afterRuntimeReset, afterReset);
  assert.deepEqual(afterRuntimeReset, afterReset);
});
