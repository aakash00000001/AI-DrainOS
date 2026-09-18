// ============================================================
// AI-DrainOS Historical Intelligence — service tests (UPDATE #20A)
//
// Verifies the read-only historical analytics foundation against a
// real PostgreSQL test database:
//   * period resolution + validation
//   * data-quality labelling / INSUFFICIENT_DATA honesty
//   * sensor analytics (averages, min/max/latest, trend)
//   * incident / mission / alert history aggregation
//   * time patterns
//   * current-vs-historical comparison
//   * historical drain health
//   * deterministic output
//
// Every value asserted here is computed from rows inserted by the
// test — no fabricated data is used anywhere.
// ============================================================

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const { setup } = require("./helpers");

let app;
let pool;
let historical;
let socketHub;

const captured = [];

const fakeIo = {
  emit(event, payload) {
    captured.push({ event, payload });
  }
};

// ------------------------------------------------------------
// Insert helpers (explicit REAL timestamps relative to NOW())
// ------------------------------------------------------------

async function insertReading({
  sensorId,
  drainId,
  water,
  gas,
  temperature,
  ageMinutes
}) {
  await pool.query(
    `
    INSERT INTO sensor_readings
      (sensor_id, drain_id, water_level, gas_level, temperature, recorded_at)
    VALUES ($1, $2, $3, $4, $5, NOW() - make_interval(mins => $6))
    `,
    [sensorId, drainId, water, gas, temperature, ageMinutes]
  );
}

async function insertIncident({
  drainId,
  severity = "HIGH",
  source = "AI_DECISION",
  status = "OPEN",
  decisionScore = null,
  ageMinutes = 60,
  ackMinutes = null,
  respondMinutes = null,
  resolveMinutes = null
}) {
  const res = await pool.query(
    `
    INSERT INTO incidents
      (drain_id, severity, source, status, decision_score, created_at,
       acknowledged_at, responding_at, resolved_at)
    VALUES (
      $1, $2, $3, $4, $5,
      NOW() - make_interval(mins => $6),
      CASE WHEN $7::int IS NULL THEN NULL ELSE NOW() - make_interval(mins => $7) END,
      CASE WHEN $8::int IS NULL THEN NULL ELSE NOW() - make_interval(mins => $8) END,
      CASE WHEN $9::int IS NULL THEN NULL ELSE NOW() - make_interval(mins => $9) END
    )
    RETURNING id
    `,
    [
      drainId,
      severity,
      source,
      status,
      decisionScore,
      ageMinutes,
      ackMinutes,
      respondMinutes,
      resolveMinutes
    ]
  );
  return Number(res.rows[0].id);
}

async function insertMission({
  robotId,
  drainId,
  status = "Completed",
  ageMinutes = 120,
  durationMinutes = 30
}) {
  const progress = status === "Completed" ? 100 : 0;
  const completedAge =
    status === "Completed" ? ageMinutes - durationMinutes : null;

  await pool.query(
    `
    INSERT INTO missions
      (robot_id, drain_id, mission_status, assigned_time, completed_time, progress)
    VALUES (
      $1, $2, $3,
      NOW() - make_interval(mins => $4),
      CASE WHEN $5::int IS NULL THEN NULL
           ELSE NOW() - make_interval(mins => $5) END,
      $6
    )
    `,
    [robotId, drainId, status, ageMinutes, completedAge, progress]
  );
}

async function insertAlert({
  drainId,
  severity = "Medium",
  type = "Blockage",
  status = "Open",
  ageMinutes = 60
}) {
  await pool.query(
    `
    INSERT INTO alerts (drain_id, alert_type, message, severity, alert_status, created_at)
    VALUES ($1, $2, $3, $4, $5, NOW() - make_interval(mins => $6))
    `,
    [drainId, type, "test alert", severity, status, ageMinutes]
  );
}

async function clearHistory() {
  await pool.query("DELETE FROM sensor_readings");
  await pool.query("DELETE FROM incidents");
  await pool.query("DELETE FROM missions");
  await pool.query("DELETE FROM alerts");
  await pool.query("DELETE FROM maintenance_predictions");
  await pool.query("DELETE FROM drain_vision_inspections");
  await pool.query(
    "UPDATE sensors SET water_level = 20, gas_level = 10, temperature = 29"
  );
}

before(async () => {
  ({ app, pool } = await setup());
  historical = require("../services/historicalIntelligenceService");
  socketHub = require("../services/socketHub");
  socketHub.init(null);
});

after(async () => {
  socketHub.init(null);
  await pool.end();
});

beforeEach(async () => {
  await clearHistory();
  historical.resetHistoricalIntelligenceRuntime();
  captured.length = 0;
});

// ------------------------------------------------------------
// Period resolution + validation helpers
// ------------------------------------------------------------

test("1. resolvePeriod defaults to 30d and validates input", () => {
  const def = historical.resolvePeriod(undefined);
  assert.equal(def.period, "30d");

  for (const p of ["24h", "7d", "30d", "90d"]) {
    const w = historical.resolvePeriod(p);
    assert.ok(w, `expected ${p} to resolve`);
    assert.equal(w.period, p);
    assert.ok(w.endTime > w.startTime);
  }

  assert.equal(historical.resolvePeriod("1y"), null);
  assert.equal(historical.resolvePeriod("abc"), null);
  assert.equal(historical.DEFAULT_PERIOD, "30d");
});

test("2. parseDrainId accepts optional positive integers only", () => {
  assert.deepEqual(historical.parseDrainId(undefined), { ok: true, value: null });
  assert.deepEqual(historical.parseDrainId(""), { ok: true, value: null });
  assert.deepEqual(historical.parseDrainId("5"), { ok: true, value: 5 });
  assert.equal(historical.parseDrainId("0").ok, false);
  assert.equal(historical.parseDrainId("-3").ok, false);
  assert.equal(historical.parseDrainId("x").ok, false);
});

test("3. classifyDataQuality uses documented thresholds", () => {
  assert.equal(historical.classifyDataQuality(0), "INSUFFICIENT_DATA");
  assert.equal(historical.classifyDataQuality(1), "SPARSE");
  assert.equal(historical.classifyDataQuality(4), "SPARSE");
  assert.equal(historical.classifyDataQuality(5), "PARTIAL");
  assert.equal(historical.classifyDataQuality(29), "PARTIAL");
  assert.equal(historical.classifyDataQuality(30), "COMPLETE");
});

test("4. computeTrend is deterministic and threshold-based", () => {
  // Needs at least 3 readings.
  assert.equal(historical.computeTrend(10, 40, 2, 5), "INSUFFICIENT_DATA");
  // +30 delta >= 5 -> RISING
  assert.equal(historical.computeTrend(10, 40, 4, 5), "RISING");
  // -30 delta <= -5 -> FALLING
  assert.equal(historical.computeTrend(40, 10, 4, 5), "FALLING");
  // small delta -> STABLE
  assert.equal(historical.computeTrend(20, 22, 4, 5), "STABLE");
  // temperature threshold 1
  assert.equal(historical.computeTrend(29, 31, 4, 1), "RISING");
  assert.equal(historical.computeTrend(29, 29.4, 4, 1), "STABLE");
});

test("5. buildMetricSummary returns nulls (never 0) when there are no samples", () => {
  const empty = historical.buildMetricSummary({
    count: 0,
    average: null,
    minimum: null,
    maximum: null,
    first: null,
    last: null,
    threshold: 5
  });

  assert.equal(empty.average, null);
  assert.equal(empty.minimum, null);
  assert.equal(empty.maximum, null);
  assert.equal(empty.change, null);
  assert.equal(empty.trend, "INSUFFICIENT_DATA");
});

test("6. computeDrainHealth is descriptive and honest", () => {
  const none = historical.computeDrainHealth({});
  assert.equal(none.status, "INSUFFICIENT_DATA");

  const healthy = historical.computeDrainHealth({
    reading_count: 40,
    max_water_level: 30
  });
  assert.equal(healthy.status, "HEALTHY");

  const watch = historical.computeDrainHealth({
    reading_count: 40,
    max_water_level: 55
  });
  assert.equal(watch.status, "WATCH");

  const degraded = historical.computeDrainHealth({
    high_incident_count: 1,
    incident_count: 1
  });
  assert.equal(degraded.status, "DEGRADED");

  const critical = historical.computeDrainHealth({
    critical_incident_count: 1,
    incident_count: 1
  });
  assert.equal(critical.status, "CRITICAL");
});

// ------------------------------------------------------------
// Empty dataset honesty
// ------------------------------------------------------------

test("7. empty dataset returns INSUFFICIENT_DATA everywhere", async () => {
  const overview = await historical.getHistoricalOverview({ period: "30d" });
  assert.equal(overview.status, "INSUFFICIENT_DATA");
  assert.equal(overview.record_count, 0);
  assert.equal(overview.data_quality.label, "INSUFFICIENT_DATA");
  assert.equal(overview.data_quality.sufficient_data, false);

  const sensors = await historical.getSensorHistory({ period: "30d" });
  assert.equal(sensors.status, "INSUFFICIENT_DATA");
  assert.equal(sensors.sensors.length, 0);

  const incidents = await historical.getIncidentHistory({ period: "30d" });
  assert.equal(incidents.total, 0);
  assert.equal(incidents.average_response_minutes, null);
  assert.equal(incidents.average_resolution_minutes, null);

  const missions = await historical.getMissionHistory({ period: "30d" });
  assert.equal(missions.total, 0);
  assert.equal(missions.completion_rate, null);

  const alerts = await historical.getAlertHistory({ period: "30d" });
  assert.equal(alerts.total, 0);

  const drains = await historical.getDrainHistory({ period: "30d" });
  assert.equal(drains.status, "INSUFFICIENT_DATA");
  assert.ok(
    drains.drains.every((d) => d.historical_health === "INSUFFICIENT_DATA")
  );
});

// ------------------------------------------------------------
// Windows
// ------------------------------------------------------------

test("8. window boundaries select only records inside each period", async () => {
  await insertReading({ sensorId: 1, drainId: 1, water: 30, gas: 10, temperature: 30, ageMinutes: 60 });
  await insertReading({ sensorId: 1, drainId: 1, water: 40, gas: 10, temperature: 30, ageMinutes: 2 * 24 * 60 });
  await insertReading({ sensorId: 1, drainId: 1, water: 50, gas: 10, temperature: 30, ageMinutes: 40 * 24 * 60 });

  const h24 = await historical.getSensorHistory({ period: "24h", drainId: 1 });
  assert.equal(h24.reading_count, 1);

  const d7 = await historical.getSensorHistory({ period: "7d", drainId: 1 });
  assert.equal(d7.reading_count, 2);

  const d30 = await historical.getSensorHistory({ period: "30d", drainId: 1 });
  assert.equal(d30.reading_count, 2);

  const d90 = await historical.getSensorHistory({ period: "90d", drainId: 1 });
  assert.equal(d90.reading_count, 3);
});

// ------------------------------------------------------------
// Sensor analytics
// ------------------------------------------------------------

test("9. sensor history computes averages, min/max, latest and change", async () => {
  await insertReading({ sensorId: 1, drainId: 1, water: 10, gas: 20, temperature: 28, ageMinutes: 200 });
  await insertReading({ sensorId: 1, drainId: 1, water: 20, gas: 30, temperature: 29, ageMinutes: 150 });
  await insertReading({ sensorId: 1, drainId: 1, water: 30, gas: 40, temperature: 30, ageMinutes: 100 });
  await insertReading({ sensorId: 1, drainId: 1, water: 40, gas: 50, temperature: 31, ageMinutes: 50 });

  const res = await historical.getSensorHistory({ period: "7d", drainId: 1 });
  assert.equal(res.reading_count, 4);
  assert.equal(res.data_quality.label, "SPARSE"); // 4 < 5

  const sensor = res.sensors[0];
  assert.equal(sensor.reading_count, 4);
  assert.equal(sensor.water_level.average, 25);
  assert.equal(sensor.water_level.minimum, 10);
  assert.equal(sensor.water_level.maximum, 40);
  assert.equal(sensor.water_level.first, 10);
  assert.equal(sensor.water_level.last, 40);
  assert.equal(sensor.water_level.change, 30);
  assert.equal(sensor.water_level.trend, "RISING");

  assert.equal(sensor.temperature.average, 29.5);
  assert.equal(sensor.temperature.trend, "RISING"); // +3 >= 1
});

test("10. sensor trend reports FALLING / STABLE / INSUFFICIENT_DATA honestly", async () => {
  // Falling
  await insertReading({ sensorId: 1, drainId: 1, water: 40, gas: 10, temperature: 30, ageMinutes: 120 });
  await insertReading({ sensorId: 1, drainId: 1, water: 30, gas: 10, temperature: 30, ageMinutes: 90 });
  await insertReading({ sensorId: 1, drainId: 1, water: 20, gas: 10, temperature: 30, ageMinutes: 60 });
  await insertReading({ sensorId: 1, drainId: 1, water: 10, gas: 10, temperature: 30, ageMinutes: 30 });

  const falling = await historical.getSensorHistory({ period: "7d", drainId: 1 });
  assert.equal(falling.sensors[0].water_level.trend, "FALLING");

  // Stable (fresh)
  await clearHistory();
  await insertReading({ sensorId: 2, drainId: 2, water: 50, gas: 10, temperature: 30, ageMinutes: 120 });
  await insertReading({ sensorId: 2, drainId: 2, water: 50, gas: 10, temperature: 30, ageMinutes: 90 });
  await insertReading({ sensorId: 2, drainId: 2, water: 51, gas: 10, temperature: 30, ageMinutes: 60 });

  const stable = await historical.getSensorHistory({ period: "7d", drainId: 2 });
  assert.equal(stable.sensors[0].water_level.trend, "STABLE");

  // Insufficient (only 2 readings)
  await clearHistory();
  await insertReading({ sensorId: 3, drainId: 3, water: 10, gas: 10, temperature: 30, ageMinutes: 120 });
  await insertReading({ sensorId: 3, drainId: 3, water: 80, gas: 10, temperature: 30, ageMinutes: 30 });

  const insufficient = await historical.getSensorHistory({ period: "7d", drainId: 3 });
  assert.equal(insufficient.sensors[0].water_level.trend, "INSUFFICIENT_DATA");
});

test("11. sensor history honours drain filtering", async () => {
  await insertReading({ sensorId: 1, drainId: 1, water: 30, gas: 10, temperature: 30, ageMinutes: 60 });
  await insertReading({ sensorId: 2, drainId: 2, water: 60, gas: 10, temperature: 30, ageMinutes: 60 });

  const all = await historical.getSensorHistory({ period: "7d" });
  assert.equal(all.sensors.length, 2);

  const one = await historical.getSensorHistory({ period: "7d", drainId: 1 });
  assert.equal(one.sensors.length, 1);
  assert.equal(one.sensors[0].drain_id, 1);
});

// ------------------------------------------------------------
// Incident history
// ------------------------------------------------------------

test("12. incident history aggregates counts, severity and real timings", async () => {
  await insertIncident({
    drainId: 1,
    severity: "CRITICAL",
    status: "RESOLVED",
    ageMinutes: 120,
    ackMinutes: 100,
    respondMinutes: 90,
    resolveMinutes: 30
  });
  await insertIncident({ drainId: 1, severity: "HIGH", status: "OPEN", ageMinutes: 60 });
  await insertIncident({ drainId: 2, severity: "LOW", status: "OPEN", ageMinutes: 30 });

  const res = await historical.getIncidentHistory({ period: "7d" });
  assert.equal(res.total, 3);
  assert.equal(res.by_severity.CRITICAL, 1);
  assert.equal(res.by_severity.HIGH, 1);
  assert.equal(res.by_severity.LOW, 1);
  assert.equal(res.active, 2);
  assert.equal(res.resolved, 1);
  assert.equal(res.by_drain.length, 2);

  // Averages computed ONLY from rows carrying the timestamp.
  assert.equal(res.average_acknowledgement_minutes, 20);
  assert.equal(res.average_response_minutes, 30);
  assert.equal(res.average_resolution_minutes, 90);
  assert.deepEqual(res.data_points, {
    with_acknowledgement: 1,
    with_response: 1,
    with_resolution: 1
  });
});

test("13. incident timing averages are null when timestamps are missing", async () => {
  await insertIncident({ drainId: 1, severity: "HIGH", status: "OPEN", ageMinutes: 60 });

  const res = await historical.getIncidentHistory({ period: "7d" });
  assert.equal(res.total, 1);
  assert.equal(res.average_acknowledgement_seconds, null);
  assert.equal(res.average_response_seconds, null);
  assert.equal(res.average_resolution_seconds, null);
});

test("14. incident history honours drain filtering", async () => {
  await insertIncident({ drainId: 1, severity: "HIGH", ageMinutes: 60 });
  await insertIncident({ drainId: 2, severity: "HIGH", ageMinutes: 60 });

  const res = await historical.getIncidentHistory({ period: "7d", drainId: 2 });
  assert.equal(res.total, 1);
  assert.equal(res.by_drain[0].drain_id, 2);
});

// ------------------------------------------------------------
// Mission / robot history
// ------------------------------------------------------------

test("15. mission history aggregates robots, completion rate and real duration", async () => {
  await insertMission({ robotId: 1, drainId: 1, status: "Completed", ageMinutes: 120, durationMinutes: 30 });
  await insertMission({ robotId: 1, drainId: 2, status: "Assigned", ageMinutes: 30 });

  const res = await historical.getMissionHistory({ period: "7d" });
  assert.equal(res.total, 2);
  assert.equal(res.completed, 1);
  assert.equal(res.assigned, 1);
  assert.equal(res.completion_rate, 50);
  assert.equal(res.average_mission_duration_minutes, 30);
  // No response timestamp exists in the schema -> honestly null.
  assert.equal(res.average_response_seconds, null);
  assert.equal(res.response_time_available, false);

  assert.equal(res.robots.length, 1);
  assert.equal(res.robots[0].robot_id, 1);
  assert.equal(res.robots[0].mission_count, 2);
  assert.equal(res.robots[0].completion_rate, 50);
});

test("16. mission duration is null when completed_time is missing", async () => {
  await insertMission({ robotId: 2, drainId: 1, status: "Assigned", ageMinutes: 30 });

  const res = await historical.getMissionHistory({ period: "7d" });
  assert.equal(res.total, 1);
  assert.equal(res.completed, 0);
  assert.equal(res.completion_rate, 0);
  assert.equal(res.average_mission_duration_seconds, null);
});

// ------------------------------------------------------------
// Alert history
// ------------------------------------------------------------

test("17. alert history aggregates severity, status and drains", async () => {
  await insertAlert({ drainId: 1, severity: "Critical", status: "Open", type: "Flood Risk" });
  await insertAlert({ drainId: 1, severity: "Medium", status: "Resolved", type: "Blockage" });
  await insertAlert({ drainId: 2, severity: "Critical", status: "Open", type: "Gas Alert" });

  const res = await historical.getAlertHistory({ period: "7d" });
  assert.equal(res.total, 3);
  assert.equal(res.resolved, 1);
  assert.equal(res.unresolved, 2);
  assert.equal(res.critical, 2);
  assert.equal(res.by_severity.Critical, 2);
  assert.equal(res.by_drain.length, 2);
  assert.ok(res.over_time.length >= 1);
});

// ------------------------------------------------------------
// Time patterns
// ------------------------------------------------------------

test("18. time patterns report real hourly/weekday distributions", async () => {
  const hourRow = await pool.query("SELECT EXTRACT(HOUR FROM NOW())::int AS h");
  const currentHour = Number(hourRow.rows[0].h);

  const incidentHour = await pool.query(
    "SELECT EXTRACT(DOW FROM NOW())::int AS d"
  );
  const currentDow = Number(incidentHour.rows[0].d);

  // 4 incidents today at the current hour (distinct drains for the
  // one-active-incident-per-drain index), 1 a few hours earlier.
  const drainsAtHour = [1, 2, 3, 4];
  for (const drainId of drainsAtHour) {
    await pool.query(
      `INSERT INTO incidents (drain_id, severity, source, status, created_at)
       VALUES ($1, 'HIGH', 'AI_DECISION', 'OPEN', date_trunc('hour', NOW()))`,
      [drainId]
    );
  }
  await pool.query(
    `INSERT INTO incidents (drain_id, severity, source, status, created_at)
     VALUES (5, 'HIGH', 'AI_DECISION', 'OPEN', date_trunc('hour', NOW()) - interval '3 hours')`
  );

  const res = await historical.getTimePatterns({ period: "7d" });
  assert.equal(res.status, "OK");
  assert.equal(res.incidents.total, 5);
  assert.equal(res.incidents.peak_incident_hour, currentHour);
  assert.equal(res.incidents.hourly_distribution[currentHour], 4);
  assert.equal(res.incidents.peak_incident_day_index, currentDow);
  assert.match(res.incidents.summary, /Most recorded incidents occurred/);
});

test("19. time patterns return null peaks with insufficient samples", async () => {
  await insertIncident({ drainId: 1, severity: "HIGH", ageMinutes: 60 });

  const res = await historical.getTimePatterns({ period: "7d" });
  assert.equal(res.incidents.total, 1);
  assert.equal(res.incidents.peak_incident_hour, null);
  assert.equal(res.incidents.peak_incident_day, null);
  assert.equal(res.incidents.summary, null);
});

// ------------------------------------------------------------
// Current vs historical comparison
// ------------------------------------------------------------

test("20. comparison compares live current values with historical averages", async () => {
  await pool.query(
    "UPDATE sensors SET water_level = 50, gas_level = 15, temperature = 35 WHERE drain_id = 1"
  );
  await insertReading({ sensorId: 1, drainId: 1, water: 30, gas: 10, temperature: 30, ageMinutes: 120 });
  await insertReading({ sensorId: 1, drainId: 1, water: 30, gas: 10, temperature: 30, ageMinutes: 60 });

  const res = await historical.getComparison({ period: "7d", drainId: 1 });
  assert.equal(res.status, "OK");
  assert.equal(res.sensor_comparison.length, 1);

  const water = res.sensor_comparison[0].metrics.find(
    (m) => m.metric === "water_level"
  );
  assert.equal(water.current_value, 50);
  assert.equal(water.historical_average, 30);
  assert.equal(water.change, 20);
  assert.equal(water.direction, "INCREASE");
  assert.equal(water.status, "OK");
});

test("21. comparison reports INSUFFICIENT_DATA for metrics with no history", async () => {
  const res = await historical.getComparison({ period: "7d", drainId: 1 });
  assert.equal(res.status, "INSUFFICIENT_DATA");
  const row = res.sensor_comparison.find((c) => c.drain_id === 1);
  assert.equal(row.status, "INSUFFICIENT_DATA");
});

test("22. comparison compares current window incidents with the previous period", async () => {
  // Current window (last 30d): 1 incident. RESOLVED so several can
  // coexist for the same drain (one-active-per-drain index).
  await insertIncident({
    drainId: 1,
    severity: "HIGH",
    status: "RESOLVED",
    ageMinutes: 60,
    resolveMinutes: 30
  });
  // Previous window (30d-60d ago): 3 incidents.
  await insertIncident({
    drainId: 1,
    severity: "HIGH",
    status: "RESOLVED",
    ageMinutes: 31 * 24 * 60,
    resolveMinutes: 31 * 24 * 60 - 30
  });
  await insertIncident({
    drainId: 1,
    severity: "HIGH",
    status: "RESOLVED",
    ageMinutes: 45 * 24 * 60,
    resolveMinutes: 45 * 24 * 60 - 30
  });
  await insertIncident({
    drainId: 1,
    severity: "HIGH",
    status: "RESOLVED",
    ageMinutes: 50 * 24 * 60,
    resolveMinutes: 50 * 24 * 60 - 30
  });

  const res = await historical.getComparison({ period: "30d", drainId: 1 });
  assert.equal(res.incident_comparison.current_period, 1);
  assert.equal(res.incident_comparison.previous_period, 3);
  assert.equal(res.incident_comparison.change, -2);
  assert.equal(res.incident_comparison.direction, "DECREASE");
});

// ------------------------------------------------------------
// Drain health + evidence
// ------------------------------------------------------------

test("23. drain history derives historical health from real evidence only", async () => {
  await insertIncident({ drainId: 1, severity: "CRITICAL", status: "OPEN", ageMinutes: 60 });
  await insertIncident({ drainId: 3, severity: "HIGH", status: "RESOLVED", ageMinutes: 120, resolveMinutes: 30 });
  await insertAlert({ drainId: 4, severity: "Medium", status: "Open" });
  await insertReading({ sensorId: 5, drainId: 5, water: 95, gas: 20, temperature: 30, ageMinutes: 60 });

  const res = await historical.getDrainHistory({ period: "7d" });
  const byId = new Map(res.drains.map((d) => [d.drain_id, d]));

  assert.equal(byId.get(1).historical_health, "CRITICAL");
  assert.ok(byId.get(1).historical_health_reasons.length > 0);
  assert.equal(byId.get(3).historical_health, "DEGRADED");
  assert.equal(byId.get(4).historical_health, "WATCH");
  assert.equal(byId.get(5).historical_health, "CRITICAL");
  assert.equal(byId.get(6).historical_health, "INSUFFICIENT_DATA");

  // CURRENT state is kept separate from HISTORICAL health.
  assert.ok("current_status" in byId.get(1));
  assert.equal(byId.get(1).current_status, "Normal");
});

test("24. drain history honours drain filtering", async () => {
  await insertIncident({ drainId: 2, severity: "HIGH", ageMinutes: 60 });

  const res = await historical.getDrainHistory({ period: "7d", drainId: 2 });
  assert.equal(res.drains.length, 1);
  assert.equal(res.drains[0].drain_id, 2);
  assert.equal(res.drains[0].historical_health, "DEGRADED");
});

// ------------------------------------------------------------
// Determinism + socket dedup
// ------------------------------------------------------------

test("25. historical output is deterministic for a fixed dataset", async () => {
  await insertIncident({ drainId: 1, severity: "CRITICAL", status: "RESOLVED", ageMinutes: 120, resolveMinutes: 30 });
  await insertReading({ sensorId: 1, drainId: 1, water: 20, gas: 10, temperature: 30, ageMinutes: 60 });

  // The window boundaries and generated_at are wall-clock values and
  // legitimately differ by a millisecond between calls; strip those
  // volatile fields and assert the evidence is otherwise identical.
  const stripVolatile = (obj) => {
    const copy = JSON.parse(JSON.stringify(obj));
    delete copy.generated_at;
    delete copy.start_time;
    delete copy.end_time;
    if (copy.data_quality) {
      delete copy.data_quality.window_start;
      delete copy.data_quality.window_end;
    }
    return copy;
  };

  const a = await historical.getIncidentHistory({ period: "7d" });
  const b = await historical.getIncidentHistory({ period: "7d" });
  assert.deepEqual(stripVolatile(a), stripVolatile(b));

  const c = await historical.getSensorHistory({ period: "7d", drainId: 1 });
  const d = await historical.getSensorHistory({ period: "7d", drainId: 1 });
  assert.deepEqual(stripVolatile(c), stripVolatile(d));
});

test("26. historicalIntelligenceUpdate is emitted only on meaningful change", async () => {
  socketHub.init(fakeIo);
  historical.resetHistoricalIntelligenceRuntime();

  const first = await historical.evaluateAndEmitHistoricalIntelligence({
    period: "30d"
  });
  assert.equal(first.emitted, true);

  const second = await historical.evaluateAndEmitHistoricalIntelligence({
    period: "30d"
  });
  assert.equal(second.emitted, false);

  assert.equal(
    captured.filter((e) => e.event === "historicalIntelligenceUpdate").length,
    1
  );

  // A real change to the recorded data must re-emit.
  await insertIncident({ drainId: 1, severity: "CRITICAL", ageMinutes: 60 });
  const third = await historical.evaluateAndEmitHistoricalIntelligence({
    period: "30d"
  });
  assert.equal(third.emitted, true);
  assert.equal(
    captured.filter((e) => e.event === "historicalIntelligenceUpdate").length,
    2
  );

  socketHub.init(null);
});
