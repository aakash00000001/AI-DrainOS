// ============================================================
// AI-DrainOS — Sensor Intelligence API tests (UPDATE #21)
//
// Covers /api/predictions/sensor-intelligence endpoints, the
// additive dashboard/analytics fields and the dedicated analytics
// endpoint. Real reading rows are inserted by the test.
// ============================================================

const { test, before, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const { setup } = require("./helpers");

let app;
let pool;

const START = Date.UTC(2025, 0, 1, 0, 0, 0);
const MIN = 60 * 1000;

async function insertReadings(sensorId, drainId, values, step = MIN) {
  for (let i = 0; i < values.length; i += 1) {
    await pool.query(
      `
      INSERT INTO sensor_readings (sensor_id, drain_id, water_level, gas_level, temperature, recorded_at)
      VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [
        sensorId,
        drainId,
        values[i],
        10,
        25,
        new Date(START + i * step).toISOString()
      ]
    );
  }
}

before(async () => {
  const setupResult = await setup();
  app = setupResult.app;
  pool = setupResult.pool;
});

beforeEach(async () => {
  await pool.query("DELETE FROM sensor_readings");
  await pool.query("DELETE FROM incidents");
});

test("GET /api/predictions/sensor-intelligence returns the full view", async () => {
  await insertReadings(1, 1, Array(12).fill(20));

  const res = await request(app).get("/api/predictions/sensor-intelligence");

  assert.equal(res.status, 200);
  assert.ok(res.body.summary);
  assert.ok(Array.isArray(res.body.sensors));
  assert.ok(Array.isArray(res.body.drains));
  assert.ok(Array.isArray(res.body.anomalies));
  assert.ok(res.body.disclaimer);
});

test("GET /:drainId filter returns a single drain", async () => {
  await insertReadings(1, 1, Array(12).fill(20));

  const res = await request(app).get(
    "/api/predictions/sensor-intelligence?drainId=1"
  );

  assert.equal(res.status, 200);
  assert.equal(res.body.drains.length, 1);
  assert.equal(res.body.drains[0].drainId, 1);
});

test("GET /:invalid drainId returns 400", async () => {
  const res = await request(app).get(
    "/api/predictions/sensor-intelligence?drainId=abc"
  );
  assert.equal(res.status, 400);
});

test("GET /summary returns the fleet summary", async () => {
  const res = await request(app).get(
    "/api/predictions/sensor-intelligence/summary"
  );

  assert.equal(res.status, 200);
  assert.equal(typeof res.body.totalSensors, "number");
  assert.ok(res.body.healthDistribution);
});

test("GET /anomalies returns anomalies and validates filters", async () => {
  await insertReadings(1, 1, [
    10, 10, 11, 10, 11, 10, 10, 11, 10, 10, 10, 90
  ]);

  const all = await request(app).get(
    "/api/predictions/sensor-intelligence/anomalies"
  );
  assert.equal(all.status, 200);
  assert.ok(all.body.count >= 1);

  const filtered = await request(app).get(
    "/api/predictions/sensor-intelligence/anomalies?type=SPIKE"
  );
  assert.equal(filtered.status, 200);
  assert.ok(filtered.body.anomalies.every((a) => a.type === "SPIKE"));
});

test("GET /anomalies/:sensorId validates and returns per-sensor anomalies", async () => {
  const bad = await request(app).get(
    "/api/predictions/sensor-intelligence/anomalies/0"
  );
  assert.equal(bad.status, 400);

  const missing = await request(app).get(
    "/api/predictions/sensor-intelligence/anomalies/99999"
  );
  assert.equal(missing.status, 404);

  await insertReadings(1, 1, [
    10, 10, 11, 10, 11, 10, 10, 11, 10, 10, 10, 90
  ]);

  const res = await request(app).get(
    "/api/predictions/sensor-intelligence/anomalies/1"
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.filters.sensorId, 1);
});

test("GET /drain/:drainId returns aggregation and 404s unknown drains", async () => {
  await insertReadings(1, 1, Array(12).fill(20));

  const found = await request(app).get(
    "/api/predictions/sensor-intelligence/drain/1"
  );
  assert.equal(found.status, 200);
  assert.equal(found.body.drainId, 1);
  assert.ok(found.body.counts);

  const missing = await request(app).get(
    "/api/predictions/sensor-intelligence/drain/99999"
  );
  assert.equal(missing.status, 404);
});

test("GET /:sensorId returns a sensor and validates input", async () => {
  const bad = await request(app).get(
    "/api/predictions/sensor-intelligence/abc"
  );
  assert.equal(bad.status, 400);

  const missing = await request(app).get(
    "/api/predictions/sensor-intelligence/99999"
  );
  assert.equal(missing.status, 404);

  await insertReadings(1, 1, Array(12).fill(20));

  const res = await request(app).get(
    "/api/predictions/sensor-intelligence/1"
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.sensorId, 1);
  assert.equal(typeof res.body.healthStatus, "string");
});

test("dashboard exposes additive sensor intelligence fields", async () => {
  await insertReadings(1, 1, Array(12).fill(20));

  const res = await request(app).get("/api/dashboard");

  assert.equal(res.status, 200);
  assert.ok(res.body.sensorIntelligence);
  assert.ok(res.body.sensorHealthSummary);
  assert.ok(res.body.sensorAnomalySummary);
});

test("analytics exposes additive sensor fields and endpoint", async () => {
  await insertReadings(1, 1, Array(12).fill(20));

  const main = await request(app).get("/api/analytics");
  assert.equal(main.status, 200);
  assert.ok("sensor_anomaly_count" in main.body);
  assert.ok("sensor_health_distribution" in main.body);

  const dedicated = await request(app).get("/api/analytics/sensor-intelligence");
  assert.equal(dedicated.status, 200);
  assert.ok(dedicated.body.health_distribution);
});
