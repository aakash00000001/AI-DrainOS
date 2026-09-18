// ============================================================
// AI-DrainOS Historical Intelligence — API tests (UPDATE #20A)
//
// Covers the READ-ONLY /api/historical endpoints, period/drain
// validation, INSUFFICIENT_DATA behaviour on an empty dataset, the
// additive dashboard/analytics historical fields, /api/analytics/
// historical, and the hard guarantee that every endpoint is
// read-only (no mutation of live data).
// ============================================================

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const { setup } = require("./helpers");

let app;
let pool;
let historical;

async function insertIncident({
  drainId,
  severity = "HIGH",
  status = "OPEN",
  ageMinutes = 60,
  resolveMinutes = null
}) {
  await pool.query(
    `
    INSERT INTO incidents (drain_id, severity, source, status, created_at, resolved_at)
    VALUES (
      $1, $2, 'AI_DECISION', $3,
      NOW() - make_interval(mins => $4),
      CASE WHEN $5::int IS NULL THEN NULL ELSE NOW() - make_interval(mins => $5) END
    )
    `,
    [drainId, severity, status, ageMinutes, resolveMinutes]
  );
}

async function insertReading({ sensorId, drainId, water, ageMinutes }) {
  await pool.query(
    `
    INSERT INTO sensor_readings
      (sensor_id, drain_id, water_level, gas_level, temperature, recorded_at)
    VALUES ($1, $2, $3, 10, 30, NOW() - make_interval(mins => $4))
    `,
    [sensorId, drainId, water, ageMinutes]
  );
}

before(async () => {
  ({ app, pool } = await setup());
  historical = require("../services/historicalIntelligenceService");
});

after(async () => {
  await pool.end();
});

beforeEach(async () => {
  await pool.query("DELETE FROM sensor_readings");
  await pool.query("DELETE FROM incidents");
  await pool.query("DELETE FROM missions");
  await pool.query("DELETE FROM alerts");
  historical.resetHistoricalIntelligenceRuntime();
});

// ------------------------------------------------------------
// Endpoints
// ------------------------------------------------------------

test("1. GET /api/historical returns the overview with a default 30d window", async () => {
  const res = await request(app).get("/api/historical");

  assert.equal(res.status, 200);
  assert.equal(res.body.period, "30d");
  assert.ok(res.body.start_time);
  assert.ok(res.body.end_time);
  assert.equal(res.body.drain_id, null);
  assert.equal(res.body.status, "INSUFFICIENT_DATA");
  assert.ok(res.body.data_quality);
  assert.equal(res.body.data_quality.label, "INSUFFICIENT_DATA");
});

test("2. GET /api/historical/overview is an alias and respects the period", async () => {
  const res = await request(app).get("/api/historical/overview?period=24h");

  assert.equal(res.status, 200);
  assert.equal(res.body.period, "24h");
});

test("3. GET /api/historical/summary returns compact summary fields", async () => {
  await insertIncident({ drainId: 1, severity: "HIGH", status: "RESOLVED", ageMinutes: 120, resolveMinutes: 90 });
  await insertIncident({ drainId: 1, severity: "HIGH", status: "RESOLVED", ageMinutes: 60, resolveMinutes: 30 });

  const res = await request(app).get("/api/historical/summary");

  assert.equal(res.status, 200);
  assert.equal(res.body.historical_incident_count, 2);
  assert.equal(res.body.recurrent_drain_count, 1);
  assert.ok(Array.isArray(res.body.top_recurring_drains));
  assert.ok(res.body.historical_data_quality);
});

test("4. GET /api/historical/sensors returns sensor analytics", async () => {
  await insertReading({ sensorId: 1, drainId: 1, water: 30, ageMinutes: 120 });
  await insertReading({ sensorId: 1, drainId: 1, water: 40, ageMinutes: 60 });

  const res = await request(app).get("/api/historical/sensors?period=7d");

  assert.equal(res.status, 200);
  assert.equal(res.body.reading_count, 2);
  assert.equal(res.body.sensors.length, 1);
  assert.equal(res.body.sensors[0].water_level.average, 35);
});

test("5. GET /api/historical/trends returns per-sensor trend labels", async () => {
  await insertReading({ sensorId: 1, drainId: 1, water: 10, ageMinutes: 180 });
  await insertReading({ sensorId: 1, drainId: 1, water: 20, ageMinutes: 120 });
  await insertReading({ sensorId: 1, drainId: 1, water: 40, ageMinutes: 60 });

  const res = await request(app).get("/api/historical/trends?period=7d");

  assert.equal(res.status, 200);
  assert.equal(res.body.trends.length, 1);
  assert.equal(res.body.trends[0].water_level_trend, "RISING");
});

test("6. GET /api/historical/drains returns per-drain history + health", async () => {
  await insertIncident({ drainId: 5, severity: "CRITICAL" });

  const res = await request(app).get("/api/historical/drains?period=7d");

  assert.equal(res.status, 200);
  const drain5 = res.body.drains.find((d) => d.drain_id === 5);
  assert.equal(drain5.historical_health, "CRITICAL");
  assert.ok("current_status" in drain5);
});

test("7. GET /api/historical/incidents returns incident history", async () => {
  await insertIncident({ drainId: 1, severity: "CRITICAL" });
  await insertIncident({ drainId: 2, severity: "LOW" });

  const res = await request(app).get("/api/historical/incidents");

  assert.equal(res.status, 200);
  assert.equal(res.body.total, 2);
  assert.equal(res.body.by_severity.CRITICAL, 1);
  assert.equal(res.body.by_severity.LOW, 1);
});

test("8. GET /api/historical/missions returns mission history", async () => {
  const res = await request(app).get("/api/historical/missions");

  assert.equal(res.status, 200);
  assert.ok("total" in res.body);
  assert.ok("completion_rate" in res.body);
  assert.equal(res.body.response_time_available, false);
});

test("9. GET /api/historical/robots returns robot response history", async () => {
  const res = await request(app).get("/api/historical/robots");

  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.robots));
});

test("10. GET /api/historical/alerts returns alert history", async () => {
  await pool.query(
    `INSERT INTO alerts (drain_id, alert_type, message, severity, alert_status)
     VALUES (1, 'Blockage', 'x', 'Critical', 'Open')`
  );

  const res = await request(app).get("/api/historical/alerts");

  assert.equal(res.status, 200);
  assert.equal(res.body.total, 1);
  assert.equal(res.body.unresolved, 1);
});

test("11. GET /api/historical/patterns returns descriptive time patterns", async () => {
  const res = await request(app).get("/api/historical/patterns?period=7d");

  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.incidents.hourly_distribution));
  assert.equal(res.body.incidents.hourly_distribution.length, 24);
  assert.equal(res.body.incidents.weekday_distribution.length, 7);
});

test("12. GET /api/historical/comparison returns current-vs-historical", async () => {
  await insertReading({ sensorId: 1, drainId: 1, water: 30, ageMinutes: 60 });

  const res = await request(app).get("/api/historical/comparison?period=7d");

  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.sensor_comparison));
  assert.ok(res.body.incident_comparison);
});

// ------------------------------------------------------------
// Validation
// ------------------------------------------------------------

test("13. invalid period returns 400 with allowed values", async () => {
  for (const endpoint of [
    "/api/historical",
    "/api/historical/summary",
    "/api/historical/sensors",
    "/api/historical/drains",
    "/api/historical/incidents",
    "/api/historical/missions",
    "/api/historical/robots",
    "/api/historical/alerts",
    "/api/historical/trends",
    "/api/historical/patterns",
    "/api/historical/comparison"
  ]) {
    const res = await request(app).get(`${endpoint}?period=42h`);
    assert.equal(res.status, 400, `${endpoint} should reject 42h`);
    assert.deepEqual(res.body.allowed_periods, ["24h", "7d", "30d", "90d"]);
  }
});

test("14. invalid drainId returns 400", async () => {
  const res = await request(app).get("/api/historical/drains?drainId=abc");
  assert.equal(res.status, 400);

  const zero = await request(app).get("/api/historical/drains?drainId=0");
  assert.equal(zero.status, 400);
});

test("15. ?window= is accepted as an alias for ?period=", async () => {
  const res = await request(app).get("/api/historical/sensors?window=90d");
  assert.equal(res.status, 200);
  assert.equal(res.body.period, "90d");
});

test("16. drainId filters the historical response", async () => {
  await insertIncident({ drainId: 1 });
  await insertIncident({ drainId: 2 });

  const res = await request(app).get("/api/historical/incidents?drainId=2");
  assert.equal(res.status, 200);
  assert.equal(res.body.total, 1);
  assert.equal(res.body.by_drain[0].drain_id, 2);
});

// ------------------------------------------------------------
// Additive dashboard / analytics integration
// ------------------------------------------------------------

test("17. GET /api/dashboard adds historicalSummary without breaking existing fields", async () => {
  await insertIncident({ drainId: 1, severity: "HIGH", status: "RESOLVED", ageMinutes: 120, resolveMinutes: 90 });
  await insertIncident({ drainId: 1, severity: "HIGH", status: "RESOLVED", ageMinutes: 60, resolveMinutes: 30 });

  const res = await request(app).get("/api/dashboard");

  assert.equal(res.status, 200);
  assert.ok(res.body.historicalSummary);
  assert.equal(res.body.historicalSummary.historicalIncidentCount, 2);
  assert.equal(res.body.historicalSummary.recurrentDrainCount, 1);
  assert.ok(res.body.historicalSummary.historicalDataQuality);

  // Existing contract intact.
  assert.ok("totalDrains" in res.body);
  assert.ok("activeRobots" in res.body);
  assert.ok("criticalAlerts" in res.body);
  assert.ok("incidents" in res.body);
  assert.ok("fleet" in res.body);
});

test("18. GET /api/analytics adds historical_* fields without breaking existing fields", async () => {
  await insertIncident({ drainId: 1, severity: "HIGH" });

  const res = await request(app).get("/api/analytics");

  assert.equal(res.status, 200);
  assert.equal(res.body.historical_period, "30d");
  assert.equal(res.body.historical_incident_count, 1);
  assert.ok(res.body.historical_data_quality);

  // Existing contract intact.
  assert.ok("total_drains" in res.body);
  assert.ok("incident_total" in res.body);
  assert.ok("fleet_total_robots" in res.body);
});

test("19. GET /api/analytics/historical returns the full overview + validates", async () => {
  const ok = await request(app).get("/api/analytics/historical?period=7d");
  assert.equal(ok.status, 200);
  assert.equal(ok.body.period, "7d");

  const bad = await request(app).get("/api/analytics/historical?period=nope");
  assert.equal(bad.status, 400);
  assert.ok(bad.body.allowed_periods);
});

// ------------------------------------------------------------
// Read-only guarantee
// ------------------------------------------------------------

test("20. historical endpoints never mutate live data", async () => {
  await insertIncident({ drainId: 1, severity: "CRITICAL" });
  await insertReading({ sensorId: 1, drainId: 1, water: 80, ageMinutes: 60 });

  const before = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM incidents) AS incidents,
       (SELECT COUNT(*) FROM missions) AS missions,
       (SELECT COUNT(*) FROM sensor_readings) AS readings,
       (SELECT COUNT(*) FROM alerts) AS alerts`
  );

  for (const endpoint of [
    "/api/historical",
    "/api/historical/summary",
    "/api/historical/sensors",
    "/api/historical/drains",
    "/api/historical/incidents",
    "/api/historical/missions",
    "/api/historical/robots",
    "/api/historical/alerts",
    "/api/historical/trends",
    "/api/historical/patterns",
    "/api/historical/comparison",
    "/api/analytics/historical"
  ]) {
    const res = await request(app).get(endpoint);
    assert.equal(res.status, 200, `${endpoint} should return 200`);
  }

  const after = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM incidents) AS incidents,
       (SELECT COUNT(*) FROM missions) AS missions,
       (SELECT COUNT(*) FROM sensor_readings) AS readings,
       (SELECT COUNT(*) FROM alerts) AS alerts`
  );

  assert.deepEqual(after.rows[0], before.rows[0]);
});
