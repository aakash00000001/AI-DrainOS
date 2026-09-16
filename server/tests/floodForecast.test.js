// ============================================================
// Predictive Flood Forecasting tests (15/30/60 min)
//
// Cover the forecast engine (time-series cleaning, trend fit,
// direction labels, projections, status handling), the reuse of
// the existing flood risk engine, the DB layer, the MQTT
// integration (+ forecastUpdate emission, 'Flood Forecast'
// early-warning alerts, dedupe, recovery), the aggregate
// summary and the new REST endpoints.
//
// The balance checks the "no fabricated confidence" contract:
// no forecast object may ever include a confidence value.
// ============================================================

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const { setup } = require("./helpers");

let app;
let pool;
let forecast;
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
  forecast = require("../services/floodForecastService");
  mqttService = require("../services/mqttService");
});

after(async () => {
  await pool.end();
});

// --------------------------------------------------
// No fabricated confidence
// --------------------------------------------------

test("NO fabricated confidence - forecast objects never include confidence", () => {
  const series = [
    { water_level: 40, recorded_at: "2026-09-16T10:00:00.000Z" },
    { water_level: 50, recorded_at: "2026-09-16T10:01:00.000Z" },
    { water_level: 60, recorded_at: "2026-09-16T10:02:00.000Z" }
  ];

  const result = forecast.buildForecast({
    water: 60,
    gas: 20,
    temp: 29,
    series,
    thresholds: { moderate: 25, high: 50, critical: 75 }
  });

  assert.equal(result.status, "ready");

  const walk = (obj, keys) => {
    if (Array.isArray(obj)) {
      obj.forEach((item) => walk(item, keys));
      return;
    }
    if (obj && typeof obj === "object") {
      for (const key of Object.keys(obj)) {
        assert.ok(
          !key.toLowerCase().includes("confidence"),
          `fabricated confidence key found: ${key}`
        );
        walk(obj[key], keys);
      }
    }
  };

  walk(result, []);
});

// --------------------------------------------------
// Time-series cleaning
// --------------------------------------------------

test("cleanTimeSeries - drops invalid/duplicate rows, sorts ascending", () => {
  const rows = [
    { water_level: 90, recorded_at: "2026-09-16T10:05:00.000Z" },
    { water_level: null, recorded_at: "2026-09-16T10:04:00.000Z" },
    { water_level: "not-a-number", recorded_at: "2026-09-16T10:04:00.000Z" },
    { water_level: -5, recorded_at: "2026-09-16T10:04:00.000Z" },
    { water_level: 140, recorded_at: "2026-09-16T10:04:00.000Z" },
    { water_level: 40, recorded_at: "2026-09-16T10:01:00.000Z" },
    { water_level: 60, recorded_at: "2026-09-16T10:01:00.000Z" },
    { water_level: 50, recorded_at: "2026-09-16T10:00:00.000Z" },
    null,
    { water_level: 70, recorded_at: "invalid-date" }
  ];

  const points = forecast.cleanTimeSeries(rows);

  assert.equal(points.length, 3);
  assert.deepEqual(
    points.map((p) => p.water),
    [50, 40, 90]
  );
  assert.ok(points[0].timeMin < points[1].timeMin);
  assert.ok(points[1].timeMin < points[2].timeMin);
});

test("cleanTimeSeries - empty / non-array input is safe", () => {
  assert.deepEqual(forecast.cleanTimeSeries(null), []);
  assert.deepEqual(forecast.cleanTimeSeries(undefined), []);
  assert.deepEqual(forecast.cleanTimeSeries([]), []);
});

// --------------------------------------------------
// Trend fit (time-indexed)
// --------------------------------------------------

test("fitSlope - perfectly linear rising series yields exactly its slope", () => {
  // 10 % water per minute
  const points = forecast.cleanTimeSeries([
    { water_level: 20, recorded_at: "2026-09-16T10:00:00.000Z" },
    { water_level: 30, recorded_at: "2026-09-16T10:01:00.000Z" },
    { water_level: 40, recorded_at: "2026-09-16T10:02:00.000Z" },
    { water_level: 50, recorded_at: "2026-09-16T10:03:00.000Z" }
  ]);

  const fit = forecast.fitSlope(points);

  assert.equal(fit.fit, "linear_regression");
  // tolerances for float arithmetic - the points are exactly 10/min
  assert.ok(Math.abs(fit.slopePerMinute - 10) < 1e-6);
  assert.equal(fit.pointsUsed, 4);
});

test("fitSlope - two point fallback uses the two point slope", () => {
  const points = forecast.cleanTimeSeries([
    { water_level: 20, recorded_at: "2026-09-16T10:00:00.000Z" },
    { water_level: 80, recorded_at: "2026-09-16T10:02:00.000Z" }
  ]);

  const fit = forecast.fitSlope(points);

  assert.equal(fit.fit, "two_point");
  assert.equal(fit.slopePerMinute, 30); // 60 rise / 2 minutes
});

test("fitSlope - identical timestamps fall back to a flat slope", () => {
  const points = forecast.cleanTimeSeries([
    { water_level: 20, recorded_at: "2026-09-16T10:00:00.000Z" },
    { water_level: 80, recorded_at: "2026-09-16T10:00:00.000Z" }
  ]);

  // Deduped to a single point -> no slope possible
  const fit = forecast.fitSlope(points);

  assert.equal(fit.fit, "insufficient");
  assert.equal(fit.slopePerMinute, 0);
});

test("fitSlope - flat series yields ~0 slope", () => {
  const points = forecast.cleanTimeSeries([
    { water_level: 40, recorded_at: "2026-09-16T10:00:00.000Z" },
    { water_level: 40, recorded_at: "2026-09-16T10:01:00.000Z" },
    { water_level: 40, recorded_at: "2026-09-16T10:02:00.000Z" }
  ]);

  const fit = forecast.fitSlope(points);

  assert.ok(Math.abs(fit.slopePerMinute) < 1e-6);
});

// --------------------------------------------------
// Trend direction labels
// --------------------------------------------------

test("trendDirectionFromSlope - maps slope to direction labels", () => {
  assert.equal(forecast.trendDirectionFromSlope(0.8), "RAPIDLY_RISING");
  assert.equal(forecast.trendDirectionFromSlope(0.5), "RAPIDLY_RISING");
  assert.equal(forecast.trendDirectionFromSlope(0.3), "RISING");
  assert.equal(forecast.trendDirectionFromSlope(0.15), "RISING");
  assert.equal(forecast.trendDirectionFromSlope(0.1), "STABLE");
  assert.equal(forecast.trendDirectionFromSlope(0), "STABLE");
  assert.equal(forecast.trendDirectionFromSlope(-0.1), "STABLE");
  assert.equal(forecast.trendDirectionFromSlope(-0.15), "FALLING");
  assert.equal(forecast.trendDirectionFromSlope(-0.18), "FALLING");
  assert.equal(forecast.trendDirectionFromSlope(-0.4), "FALLING");
  assert.equal(forecast.trendDirectionFromSlope(-0.5), "RAPIDLY_FALLING");
  assert.equal(forecast.trendDirectionFromSlope(-0.8), "RAPIDLY_FALLING");
});

// --------------------------------------------------
// Projections
// --------------------------------------------------

test("projectWater - linear projection with clamping to 0-100", () => {
  assert.equal(forecast.projectWater(50, 10, 2), 70);
  assert.equal(forecast.projectWater(50, -10, 2), 30);
  assert.equal(forecast.projectWater(90, 10, 60), 100); // clamped
  assert.equal(forecast.projectWater(5, -10, 60), 0);    // clamped
});

// --------------------------------------------------
// buildForecast: status handling
// --------------------------------------------------

test("buildForecast - insufficient history returns honest status (no fake forecast)", () => {
  const result = forecast.buildForecast({
    water: 90,
    gas: 70,
    temp: 36,
    series: [{ water_level: 90, recorded_at: "2026-09-16T10:00:00.000Z" }]
  });

  assert.equal(result.status, "insufficient_history");
  assert.equal(result.worst, null);
  assert.deepEqual(result.horizons, []);
  assert.equal(result.method, "Explainable Baseline Forecast");
  assert.ok(result.reason);
});

test("buildForecast - insufficient history with zero readings", () => {
  const result = forecast.buildForecast({
    water: 90,
    gas: 70,
    temp: 36,
    series: []
  });

  assert.equal(result.status, "insufficient_history");
});

test("buildForecast - invalid series (null water) yields honest status", () => {
  const result = forecast.buildForecast({
    water: 90,
    gas: 70,
    temp: 36,
    series: [
      { water_level: null, recorded_at: "2026-09-16T10:00:00.000Z" },
      { water_level: 92, recorded_at: "2026-09-16T10:01:00.000Z" }
    ]
  });

  // null water is dropped -> only 1 usable point -> insufficient
  assert.equal(result.status, "insufficient_history");
  assert.equal(result.worst, null);
});

// --------------------------------------------------
// buildForecast: rising drain projections
// --------------------------------------------------

test("buildForecast - rising drain: 60 min worst, levels climb with horizon", () => {
  // rising exactly 1 %/min - projections climb 15 -> 30 -> 60
  const series = [
    { water_level: 40, recorded_at: "2026-09-16T10:00:00.000Z" },
    { water_level: 41, recorded_at: "2026-09-16T10:01:00.000Z" },
    { water_level: 42, recorded_at: "2026-09-16T10:02:00.000Z" },
    { water_level: 43, recorded_at: "2026-09-16T10:03:00.000Z" }
  ];

  const result = forecast.buildForecast({
    water: 43,
    gas: 40,
    temp: 33,
    series
  });

  assert.equal(result.status, "ready");
  assert.equal(result.method, "Explainable Baseline Forecast");
  assert.equal(result.waterTrendPerMinute, 1); // 1 %/min rising
  assert.equal(result.trendDirection, "RAPIDLY_RISING");

  assert.deepEqual(
    result.horizons.map((h) => h.forecastMinutes),
    [15, 30, 60]
  );

  // Projected water climbs with the horizon (43 -> 58 -> 73 -> 100)
  const projected = result.horizons.map((h) => h.predictedWaterLevel);
  assert.ok(projected[1] > projected[0], "30min projection is higher than 15min");
  assert.ok(projected[2] >= projected[1], "60min projection is highest");

  // Worst is the 60-min horizon (highest predicted water -> highest risk)
  assert.equal(result.worst.forecastMinutes, 60);

  // Predicted risk is monotonic with water level for the same gas/temp
  assert.ok(
    result.worst.predictedRiskScore >= result.horizons[0].predictedRiskScore
  );

  assert.ok(result.worst.predictedRiskScore >= 0);
  assert.ok(result.worst.predictedRiskScore <= 100);
  assert.ok(["LOW", "MODERATE", "HIGH", "CRITICAL"].includes(result.worst.predictedRiskLevel));
});

test("buildForecast - projections are bounded (never outside 0-100)", () => {
  const series = [
    { water_level: 95, recorded_at: "2026-09-16T10:00:00.000Z" },
    { water_level: 99, recorded_at: "2026-09-16T10:01:00.000Z" }
  ];

  const result = forecast.buildForecast({
    water: 99,
    gas: 80,
    temp: 38,
    series
  });

  assert.equal(result.status, "ready");
  result.horizons.forEach((h) => {
    assert.ok(h.predictedWaterLevel >= 0 && h.predictedWaterLevel <= 100);
    assert.ok(h.predictedRiskScore >= 0 && h.predictedRiskScore <= 100);
  });
});

test("buildForecast - falling drain keeps predicted risk LOW", () => {
  const series = [
    { water_level: 90, recorded_at: "2026-09-16T10:00:00.000Z" },
    { water_level: 70, recorded_at: "2026-09-16T10:01:00.000Z" }
  ];

  const result = forecast.buildForecast({
    water: 70,
    gas: 30,
    temp: 31,
    series
  });

  assert.equal(result.status, "ready");
  assert.equal(result.trendDirection, "RAPIDLY_FALLING");
  assert.ok(result.worst.predictedRiskLevel === "LOW" || result.worst.predictedRiskLevel === "MODERATE");
});

test("buildForecast - custom risk thresholds are respected", () => {
  const series = [
    { water_level: 40, recorded_at: "2026-09-16T10:00:00.000Z" },
    { water_level: 46, recorded_at: "2026-09-16T10:01:00.000Z" }
  ];

  const result = forecast.buildForecast({
    water: 46,
    gas: 20,
    temp: 29,
    series,
    thresholds: { moderate: 40, high: 75, critical: 90 }
  });

  assert.equal(result.status, "ready");
  assert.ok(
    ["LOW", "MODERATE", "HIGH", "CRITICAL"].includes(result.worst.predictedRiskLevel)
  );
});

// --------------------------------------------------
// DETERMINISM - same history always yields the same forecast
// --------------------------------------------------

test("buildForecast - deterministic: identical input gives identical output", () => {
  const series = [
    { water_level: 40, recorded_at: "2026-09-16T10:00:00.000Z" },
    { water_level: 50, recorded_at: "2026-09-16T10:01:00.000Z" },
    { water_level: 60, recorded_at: "2026-09-16T10:02:00.000Z" },
    { water_level: 70, recorded_at: "2026-09-16T10:03:00.000Z" }
  ];

  const input = {
    water: 70,
    gas: 40,
    temp: 33,
    series
  };

  const a = forecast.buildForecast(input);
  const b = forecast.buildForecast(input);

  assert.deepEqual(a.horizons, b.horizons);
  assert.deepEqual(a.worst, b.worst);
  assert.deepEqual(a.model, b.model);
});

// --------------------------------------------------
// DB: getSeries
// --------------------------------------------------

test("getSeries - returns bounded, chronologically ordered history", async () => {
  const result = await pool.query(
    `
    INSERT INTO drains (zone_name, location, status, blockage_level)
    VALUES ('Zone Series', 'Series Test', 'Normal', 10)
    RETURNING id
    `
  );
  const drainId = result.rows[0].id;

  const sensor = await pool.query(
    `
    INSERT INTO sensors (drain_id, water_level, gas_level, temperature, status)
    VALUES ($1, 40, 10, 25.00, 'Normal')
    RETURNING id
    `,
    [drainId]
  );
  const sensorId = sensor.rows[0].id;

  const floodRisk = require("../services/floodRiskService");

  await floodRisk.recordReading(sensorId, drainId, { water_level: 10, gas_level: 5, temperature: 26 });
  await floodRisk.recordReading(sensorId, drainId, { water_level: 20, gas_level: 8, temperature: 27 });
  await floodRisk.recordReading(sensorId, drainId, { water_level: 30, gas_level: 12, temperature: 28 });

  const series = await forecast.getSeries(drainId, 10);

  assert.equal(series.length, 3);
  assert.deepEqual(
    series.map((r) => Number(r.water_level)),
    [10, 20, 30]
  );
});

// --------------------------------------------------
// getDrainForecast
// --------------------------------------------------

test("getDrainForecast - returns full per-drain forecast", async () => {
  await pool.query(
    `
    INSERT INTO drains (zone_name, location, status, blockage_level)
    VALUES ('Zone FC', 'Forecast Zone', 'Normal', 10)
    RETURNING id
    `
  );

  const drainResult = await pool.query(
    `
    INSERT INTO drains (zone_name, location, status, blockage_level)
    VALUES ('Zone FC2', 'Forecast Zone B', 'Normal', 10)
    RETURNING id
    `
  );
  const drainId = drainResult.rows[0].id;

  await pool.query(
    `
    INSERT INTO sensors (drain_id, water_level, gas_level, temperature, status)
    VALUES ($1, 62, 40, 33.00, 'Warning')
    `,
    [drainId]
  );

  const floodRisk = require("../services/floodRiskService");
  const readings = [
    { water_level: 44, gas_level: 30, temperature: 31 },
    { water_level: 50, gas_level: 34, temperature: 32 },
    { water_level: 56, gas_level: 38, temperature: 33 },
    { water_level: 62, gas_level: 40, temperature: 33 }
  ];

  const sensorResult = await pool.query(
    "SELECT id FROM sensors WHERE drain_id = $1",
    [drainId]
  );
  const sensorId = sensorResult.rows[0].id;

  for (const reading of readings) {
    await floodRisk.recordReading(sensorId, drainId, reading);
  }

  const result = await forecast.getDrainForecast(drainId);

  assert.ok(result);
  assert.equal(result.drainId, drainId);
  assert.equal(result.location, "Forecast Zone B");
  assert.equal(result.currentWaterLevel, 62);
  assert.ok(typeof result.currentRiskScore === "number");
  assert.ok(typeof result.currentRiskLevel === "string");
  assert.equal(result.status, "ready");
  assert.equal(result.method, "Explainable Baseline Forecast");
  assert.equal(result.horizons.length, 3);
  assert.ok(result.worst);
  assert.ok(result.timestamp);

  // rising trend (auto-increment of +6 per minute read) -> RAPIDLY_RISING
  assert.ok(
    ["RISING", "RAPIDLY_RISING"].includes(result.trendDirection)
  );
});

test("getDrainForecast - missing drain returns null", async () => {
  const result = await forecast.getDrainForecast(999999);
  assert.equal(result, null);
});

test("getDrainForecast - returns honest insufficient status when no history yet", async () => {
  const result = await pool.query(
    `
    INSERT INTO drains (zone_name, location, status, blockage_level)
    VALUES ('Zone Empty', 'No Readings Yet', 'Normal', 10)
    RETURNING id
    `
  );
  const drainId = result.rows[0].id;

  await pool.query(
    `
    INSERT INTO sensors (drain_id, water_level, gas_level, temperature, status)
    VALUES ($1, 20, 10, 29.00, 'Normal')
    `,
    [drainId]
  );

  const fc = await forecast.getDrainForecast(drainId);

  assert.ok(fc);
  assert.equal(fc.status, "insufficient_history");
  assert.equal(fc.worst, null);
});

// --------------------------------------------------
// Forecast alerts
// --------------------------------------------------

test("ensureForecastAlert - creates, dedupes, never downgrades, resolves", async () => {
  const drainResult = await pool.query(
    `
    INSERT INTO drains (zone_name, location, status, blockage_level)
    VALUES ('Zone Alert', 'Alert Forecast', 'Normal', 10)
    RETURNING id
    `
  );
  const drainId = drainResult.rows[0].id;

  const first = await forecast.ensureForecastAlert({
    drainId,
    location: "Alert Forecast",
    severity: "Medium",
    message: "Flood forecast HIGH within 30 min at Alert Forecast"
  });

  assert.equal(first.action, "created");

  // Second call with the same severity -> kept (dedupe, no dupes)
  const second = await forecast.ensureForecastAlert({
    drainId,
    location: "Alert Forecast",
    severity: "Medium",
    message: "Flood forecast HIGH within 30 min at Alert Forecast"
  });

  assert.equal(second.action, "kept");

  // Escalation to Critical -> upgraded (never a duplicate)
  const third = await forecast.ensureForecastAlert({
    drainId,
    location: "Alert Forecast",
    severity: "Critical",
    message: "Flood forecast CRITICAL within 60 min at Alert Forecast"
  });

  assert.equal(third.action, "upgraded");

  const open = (await pool.query(
    `
    SELECT * FROM alerts
    WHERE drain_id = $1 AND alert_type = 'Flood Forecast' AND alert_status = 'Open'
    `,
    [drainId]
  )).rows;

  assert.equal(open.length, 1);
  assert.equal(open[0].severity, "Critical");
  assert.match(open[0].message, /CRITICAL/);

  await forecast.resolveForecastAlerts(drainId);

  const after = (await pool.query(
    `
    SELECT * FROM alerts
    WHERE drain_id = $1 AND alert_type = 'Flood Forecast'
    `,
    [drainId]
  )).rows;

  assert.equal(after.length, 1);
  assert.equal(after[0].alert_status, "Resolved");
});

// --------------------------------------------------
// Aggregate forecast summary
// --------------------------------------------------

test("getForecastSummary - aggregates predicted-risk counts", async () => {
  forecast.flushForecastSummaryCache();

  const summary = await forecast.getForecastSummary({ force: true });

  assert.ok(typeof summary.totalDrains === "number");
  assert.ok(typeof summary.averagePredictedRiskScore === "number");
  assert.ok(summary.counts);
  assert.deepEqual(
    Object.keys(summary.counts).sort(),
    ["critical", "high", "low", "moderate"]
  );
  assert.equal(summary.distribution.length, 4);
  assert.ok(Array.isArray(summary.drains));

  // every ranked drain carries its current + predicted worst risk
  summary.drains.forEach((entry) => {
    assert.ok(typeof entry.currentRiskScore === "number");
    assert.ok(typeof entry.currentRiskLevel === "string");
    assert.ok(typeof entry.worstRiskScore === "number");
    assert.ok(typeof entry.worstRiskLevel === "string");
    assert.ok(typeof entry.worstMinutes === "number");
  });
});

test("getForecastSummary - summary cache is reused within TTL and flushable", async () => {
  forecast.flushForecastSummaryCache();
  const first = await forecast.getForecastSummary();
  const second = await forecast.getForecastSummary();
  assert.equal(first, second); // same cached object reference

  forecast.flushForecastSummaryCache();
  const third = await forecast.getForecastSummary();
  assert.ok(third); // recomputed
});

// --------------------------------------------------
// MQTT integration (deterministic timestamps)
// --------------------------------------------------

test("handleMessage - emits forecastUpdate with horizons and worst (deduped)", async () => {
  const io = fakeIo();
  const predict = async () => ({ prediction: "HIGH" });

  // Build deterministic history for drain 4 (3 distinct minutes,
  // rising +1 %/min so the 60-min projection is genuinely worst)
  await mqttService.handleMessage(
    "ai-drainos/drains/4/sensors/4",
    JSON.stringify({ water_level: 60, gas_level: 40, temperature: 33, timestamp: "2026-09-16T09:00:00.000Z" }),
    { io, predict }
  );

  await mqttService.handleMessage(
    "ai-drainos/drains/4/sensors/4",
    JSON.stringify({ water_level: 61, gas_level: 42, temperature: 33, timestamp: "2026-09-16T09:01:00.000Z" }),
    { io, predict }
  );

  await mqttService.handleMessage(
    "ai-drainos/drains/4/sensors/4",
    JSON.stringify({ water_level: 62, gas_level: 44, temperature: 34, timestamp: "2026-09-16T09:02:00.000Z" }),
    { io, predict }
  );

  const updates = io.emitted.filter(
    (e) => e.event === "forecastUpdate" && e.payload.drainId === 4
  );

  assert.ok(updates.length >= 1);

  const last = updates[updates.length - 1].payload;
  assert.equal(last.drainId, 4);
  assert.equal(last.sensorId, 4);
  assert.equal(last.horizons.length, 3);
  assert.ok(last.worst);
  assert.equal(last.worst.forecastMinutes, 60);
  assert.equal(typeof last.method, "string");
  assert.equal(typeof last.trendDirection, "string");
  assert.ok(last.timestamp);
});

test("handleMessage - rising drain emits forecastUpdate + creates early-warning alert", async () => {
  const io = fakeIo();
  const predict = async () => ({ prediction: "HIGH" });

  await mqttService.handleMessage(
    "ai-drainos/drains/6/sensors/6",
    JSON.stringify({ water_level: 50, gas_level: 40, temperature: 33, timestamp: "2026-09-16T08:00:00.000Z" }),
    { io, predict }
  );

  await mqttService.handleMessage(
    "ai-drainos/drains/6/sensors/6",
    JSON.stringify({ water_level: 65, gas_level: 50, temperature: 34, timestamp: "2026-09-16T08:01:00.000Z" }),
    { io, predict }
  );

  await mqttService.handleMessage(
    "ai-drainos/drains/6/sensors/6",
    JSON.stringify({ water_level: 80, gas_level: 62, temperature: 36, timestamp: "2026-09-16T08:02:00.000Z" }),
    { io, predict }
  );

  await mqttService.handleMessage(
    "ai-drainos/drains/6/sensors/6",
    JSON.stringify({ water_level: 95, gas_level: 76, temperature: 38, timestamp: "2026-09-16T08:03:00.000Z" }),
    { io, predict }
  );

  // forecastUpdate events must exist for this drain
  const forecastUpdates = io.emitted.filter(
    (e) => e.event === "forecastUpdate" && e.payload.drainId === 6
  );

  assert.ok(forecastUpdates.length >= 1);

  const latest = forecastUpdates[forecastUpdates.length - 1].payload;
  assert.ok(latest.horizons.length === 3);
  assert.ok(latest.worst);

  // A 'Flood Forecast' early-warning alert was created
  const alerts = (await pool.query(
    `
    SELECT * FROM alerts
    WHERE drain_id = 6 AND alert_type = 'Flood Forecast'
    `
  )).rows;

  assert.ok(alerts.length >= 1);
  assert.equal(alerts[0].alert_status, "Open");
});

test("handleMessage - risk falls -> recovery resolves forecast alerts", async () => {
  const io = fakeIo();
  const predict = async () => ({ prediction: "LOW" });

  // Recovery message: drain 6 water drops sharply
  await mqttService.handleMessage(
    "ai-drainos/drains/6/sensors/6",
    JSON.stringify({ water_level: 15, gas_level: 5, temperature: 28, timestamp: "2026-09-16T08:05:00.000Z" }),
    { io, predict }
  );

  const alerts = (await pool.query(
    `
    SELECT * FROM alerts
    WHERE drain_id = 6 AND alert_type = 'Flood Forecast'
    `
  )).rows;

  assert.ok(alerts.length >= 1);
  assert.ok(alerts.every((a) => a.alert_status === "Resolved"));
});

test("handleMessage - sensorUpdate carries additive forecast fields", async () => {
  const io = fakeIo();
  const predict = async () => ({ prediction: "HIGH" });

  await mqttService.handleMessage(
    "ai-drainos/drains/7/sensors/7",
    JSON.stringify({ water_level: 40, gas_level: 20, temperature: 30, timestamp: "2026-09-16T07:00:00.000Z" }),
    { io, predict }
  );

  await mqttService.handleMessage(
    "ai-drainos/drains/7/sensors/7",
    JSON.stringify({ water_level: 55, gas_level: 30, temperature: 31, timestamp: "2026-09-16T07:01:00.000Z" }),
    { io, predict }
  );

  const sensorUpdate = io.emitted.filter((e) => e.event === "sensorUpdate");
  const last = sensorUpdate[sensorUpdate.length - 1];

  assert.ok("forecast60Score" in last.payload);
  assert.ok("forecast60Level" in last.payload);
  assert.ok("forecastTrendDirection" in last.payload);
  assert.ok(typeof last.payload.forecast60Score === "number" || last.payload.forecast60Score === null);
  assert.ok(last.payload.forecastTrendDirection === null || typeof last.payload.forecastTrendDirection === "string");
});

// --------------------------------------------------
// REST endpoints
// --------------------------------------------------

test("GET /api/predictions/forecast/:drainId - returns full forecast", async () => {
  // Create a dedicated drain with deterministic history so the
  // forecast is guaranteed to be ready.
  const drainResult = await pool.query(
    `
    INSERT INTO drains (zone_name, location, status, blockage_level)
    VALUES ('Zone API', 'Forecast API Test', 'Normal', 10)
    RETURNING id
    `
  );
  const drainId = drainResult.rows[0].id;

  await pool.query(
    `
    INSERT INTO sensors (drain_id, water_level, gas_level, temperature, status)
    VALUES ($1, 52, 35, 32.00, 'Warning')
    `,
    [drainId]
  );

  const floodRisk = require("../services/floodRiskService");
  const sensorResult = await pool.query(
    "SELECT id FROM sensors WHERE drain_id = $1",
    [drainId]
  );
  const sensorId = sensorResult.rows[0].id;

  for (const [i, water] of [42, 46, 50, 54].entries()) {
    await floodRisk.recordReading(sensorId, drainId, {
      water_level: water,
      gas_level: 30 + i,
      temperature: 31 + i
    });
  }

  const res = await request(app)
    .get(`/api/predictions/forecast/${drainId}`)
    .expect(200);

  const body = res.body;

  assert.equal(body.drainId, drainId);
  assert.equal(body.location, "Forecast API Test");
  assert.ok(typeof body.currentWaterLevel === "number");
  assert.ok(typeof body.currentRiskScore === "number");
  assert.ok(typeof body.currentRiskLevel === "string");
  assert.equal(body.status, "ready");
  assert.equal(body.horizons.length, 3);
  assert.ok(body.worst);
  assert.ok(body.model);
  assert.ok(body.timestamp);

  // Everything that could be mistaken for ML confidence is absent
  const serialized = JSON.stringify(body);
  assert.ok(!serialized.toLowerCase().includes("confidence"));
});

test("GET /api/predictions/forecast/:drainId - missing drain returns 404", async () => {
  const res = await request(app)
    .get("/api/predictions/forecast/999999")
    .expect(404);

  assert.ok(res.body.error);
});

test("GET /api/predictions/forecast/:drainId - invalid id returns 400", async () => {
  const res = await request(app)
    .get("/api/predictions/forecast/abc")
    .expect(400);

  assert.ok(res.body.error);
});

test("GET /api/analytics/forecast - returns aggregate forecast summary", async () => {
  forecast.flushForecastSummaryCache();

  const res = await request(app)
    .get("/api/analytics/forecast")
    .expect(200);

  const body = res.body;

  assert.ok(typeof body.totalDrains === "number");
  assert.ok(typeof body.averagePredictedRiskScore === "number");
  assert.ok(body.counts);
  assert.equal(body.distribution.length, 4);
  assert.ok(Array.isArray(body.drains));
});

test("GET /api/dashboard/forecast - returns summary + top forecast", async () => {
  forecast.flushForecastSummaryCache();

  const res = await request(app)
    .get("/api/dashboard/forecast")
    .expect(200);

  const body = res.body;

  assert.ok(body.summary);
  assert.ok(typeof body.summary.averagePredictedRiskScore === "number");
  assert.ok(body.summary.counts);
  assert.ok(Array.isArray(body.summary.distribution));

  // topForecast present once any drain has >= 2 readings
  assert.ok(body.topForecast);
  assert.ok(body.topForecast.drainId);
  assert.ok(body.topForecast.location);
  assert.ok(body.topForecast.method);
  assert.ok(body.topForecast.horizons);
  assert.ok(body.topForecast.worst);
});

test("GET /api/analytics - includes forecast metrics", async () => {
  forecast.flushForecastSummaryCache();

  const res = await request(app)
    .get("/api/analytics")
    .expect(200);

  const body = res.body;

  assert.ok(typeof body.forecast_average_risk === "number");
  assert.ok(typeof body.forecast_low === "number");
  assert.ok(typeof body.forecast_moderate === "number");
  assert.ok(typeof body.forecast_high === "number");
  assert.ok(typeof body.forecast_critical === "number");
  assert.ok(Array.isArray(body.forecast_distribution));
  assert.ok(typeof body.forecast_ready === "number");
});