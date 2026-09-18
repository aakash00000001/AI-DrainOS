// ============================================================
// AI-DrainOS — Weather + Flood Correlation API tests (UPDATE #23)
//
// Covers /api/predictions/weather-correlation endpoints, the
// additive dashboard + analytics fields and the dedicated analytics
// endpoint. Real weather + reading rows are inserted by the test -
// never fabricated production data.
// ============================================================

const { test, before, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const { setup } = require("./helpers");

let app;
let pool;

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

function iso(ms) {
  return new Date(ms).toISOString();
}

async function clearTables() {
  await pool.query("DELETE FROM sensor_readings");
  await pool.query("DELETE FROM weather_observations");
  await pool.query("DELETE FROM incidents");
}

async function insertObservation({
  observedAt,
  rain1h = null,
  humidity = null,
  windSpeed = null
}) {
  await pool.query(
    `
    INSERT INTO weather_observations
      (observed_at, temperature, humidity, pressure, wind_speed,
       weather_main, rain_1h, rain_3h)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (observed_at) DO NOTHING
    `,
    [iso(observedAt), 28, humidity, 1010, windSpeed, "Rain", rain1h, null]
  );
}

async function insertReading({ drainId, recordedAt, water }) {
  await pool.query(
    `
    INSERT INTO sensor_readings
      (sensor_id, drain_id, water_level, gas_level, temperature, recorded_at)
    VALUES ($1, $2, $3, $4, $5, $6)
    `,
    [drainId, drainId, water, 10, 25, iso(recordedAt)]
  );
}

// 24 aligned pairs over the last 12h: water is an exact function of
// rainfall, so rainfall_water_level is a perfect positive match.
async function insertAlignedDataset({ count = 24 } = {}) {
  const t0 = Math.floor((Date.now() - 12 * HOUR) / MIN) * MIN;
  for (let i = 0; i < count; i += 1) {
    const obsAt = t0 + i * 30 * MIN;
    const rain = (i % 5) + Math.floor(i / 5);
    await insertObservation({
      observedAt: obsAt,
      rain1h: rain,
      humidity: ((i * 7 + 3) % 11) * 8,
      windSpeed: 80 - 2 * (10 + 3 * rain)
    });
    await insertReading({
      drainId: 1,
      recordedAt: obsAt + 5 * MIN,
      water: 10 + 3 * rain
    });
  }
}

before(async () => {
  const setupResult = await setup();
  app = setupResult.app;
  pool = setupResult.pool;
});

beforeEach(clearTables);

// ------------------------------------------------------------
// Core endpoints
// ------------------------------------------------------------

test("GET / reports WEATHER_UNAVAILABLE when no observations exist", async () => {
  const res = await request(app).get(
    "/api/predictions/weather-correlation"
  );

  assert.equal(res.status, 200);
  assert.equal(res.body.status, "WEATHER_UNAVAILABLE");
  assert.equal(res.body.weather_data_quality.status, "NO_WEATHER_DATA");
  assert.equal(res.body.signals_total, 7);
  assert.ok(res.body.disclaimer);
});

test("GET / reports READY with a perfect rainfall-water correlation", async () => {
  await insertAlignedDataset();

  const res = await request(app).get(
    "/api/predictions/weather-correlation"
  );

  assert.equal(res.status, 200);
  assert.equal(res.body.status, "READY");
  const rainfall = res.body.signals.find(
    (s) => s.signal === "rainfall_water_level"
  );
  assert.equal(rainfall.status, "READY");
  assert.ok(Math.abs(rainfall.r - 1) < 1e-9);
  assert.equal(rainfall.direction, "POSITIVE");
  assert.ok(res.body.latest_weather);
});

test("GET /summary returns the compact summary", async () => {
  const res = await request(app).get(
    "/api/predictions/weather-correlation/summary"
  );

  assert.equal(res.status, 200);
  assert.ok(res.body.status);
  assert.ok(Array.isArray(res.body.signals));
});

test("GET /signals returns all 7 definitions with statuses", async () => {
  const res = await request(app).get(
    "/api/predictions/weather-correlation/signals"
  );

  assert.equal(res.status, 200);
  assert.equal(res.body.signal_definitions.length, 7);
  const risk = res.body.signal_definitions.find(
    (s) => s.signal === "weather_flood_risk"
  );
  assert.equal(risk.status, "NOT_AVAILABLE");
  const forecast = res.body.signal_definitions.find(
    (s) => s.signal === "weather_forecast"
  );
  assert.equal(forecast.status, "NOT_AVAILABLE");
});

test("GET /drains lists every drain with per-drain signals", async () => {
  await insertAlignedDataset();

  const res = await request(app).get(
    "/api/predictions/weather-correlation/drains"
  );

  assert.equal(res.status, 200);
  assert.equal(res.body.drains.length, 7);
  assert.ok(res.body.drains[0].signals.length >= 5);
});

test("GET /drain/1 returns per-drain detail", async () => {
  await insertAlignedDataset();

  const res = await request(app).get(
    "/api/predictions/weather-correlation/drain/1"
  );

  assert.equal(res.status, 200);
  assert.equal(res.body.drain_id, 1);
  assert.ok(res.body.correlation);
});

test("GET /drain/:invalid returns 400", async () => {
  const res = await request(app).get(
    "/api/predictions/weather-correlation/drain/abc"
  );
  assert.equal(res.status, 400);
});

test("GET /drain/:unknown returns 404", async () => {
  const res = await request(app).get(
    "/api/predictions/weather-correlation/drain/9999"
  );
  assert.equal(res.status, 404);
});

test("GET /:signal computes the requested signal", async () => {
  await insertAlignedDataset();

  const res = await request(app).get(
    "/api/predictions/weather-correlation/rainfall_water_level"
  );

  assert.equal(res.status, 200);
  assert.equal(res.body.signal, "rainfall_water_level");
  assert.equal(res.body.status, "READY");
});

test("GET /:signal with drainId filter works", async () => {
  await insertAlignedDataset();

  const res = await request(app).get(
    "/api/predictions/weather-correlation/rainfall_water_level?drainId=1"
  );

  assert.equal(res.status, 200);
  assert.equal(res.body.drain_id, 1);
});

test("GET /:signal with unknown drainId returns 404", async () => {
  await insertAlignedDataset();

  const res = await request(app).get(
    "/api/predictions/weather-correlation/rainfall_water_level?drainId=9999"
  );

  assert.equal(res.status, 404);
});

test("GET /:invalid signal returns 400 with valid_signals", async () => {
  const res = await request(app).get(
    "/api/predictions/weather-correlation/bogus_signal"
  );

  assert.equal(res.status, 400);
  assert.ok(Array.isArray(res.body.valid_signals));
  assert.ok(res.body.valid_signals.includes("rainfall_water_level"));
});

test("weather_flood_risk signal is NOT_AVAILABLE via the API", async () => {
  await insertAlignedDataset();

  const res = await request(app).get(
    "/api/predictions/weather-correlation/weather_flood_risk"
  );

  assert.equal(res.status, 200);
  assert.equal(res.body.status, "NOT_AVAILABLE");
  assert.equal(res.body.correlation, null);
});

// ------------------------------------------------------------
// Query validation + trends
// ------------------------------------------------------------

test("invalid window hours return 400", async () => {
  const res = await request(app).get(
    "/api/predictions/weather-correlation?window=notanumber"
  );
  assert.equal(res.status, 400);
});

test("invalid lag minutes return 400", async () => {
  const res = await request(app).get(
    "/api/predictions/weather-correlation/rainfall_water_level?lag=7"
  );
  assert.equal(res.status, 400);
});

test("GET /trends returns time-bucketed correlation", async () => {
  await insertAlignedDataset();

  const res = await request(app).get(
    "/api/predictions/weather-correlation/trends?signal=rainfall_water_level"
  );

  assert.equal(res.status, 200);
  assert.equal(res.body.signal, "rainfall_water_level");
  assert.ok(Array.isArray(res.body.buckets));
  assert.equal(res.body.buckets.length, 4);
  assert.ok(["stable", "strengthening", "weakening", "insufficient"].includes(res.body.trend));
});

test("GET /trends accepts a valid rainfall lag", async () => {
  await insertAlignedDataset();

  const res = await request(app).get(
    "/api/predictions/weather-correlation/trends?signal=rainfall_water_level&lag=15"
  );

  assert.equal(res.status, 200);
  assert.equal(res.body.lag_minutes, 15);
});

// ------------------------------------------------------------
// Additive dashboard + analytics surfaces
// ------------------------------------------------------------

test("dashboard exposes the additive weatherCorrelation block", async () => {
  const res = await request(app).get("/api/dashboard");

  assert.equal(res.status, 200);
  assert.ok(res.body.weatherCorrelation);
  assert.ok(res.body.weatherCorrelation.status);
  assert.equal(typeof res.body.weatherCorrelation.signalsTotal, "number");
});

test("GET /api/analytics/weather-correlation returns correlation analytics", async () => {
  await insertAlignedDataset();

  const res = await request(app).get("/api/analytics/weather-correlation");

  assert.equal(res.status, 200);
  assert.equal(res.body.weather_correlation_status, "READY");
  assert.ok(res.body.rainfall_water_level);
  assert.equal(res.body.rainfall_water_level.status, "READY");
  assert.ok(Math.abs(res.body.rainfall_water_level.r - 1) < 1e-9);
});

test("main analytics include the additive weather fields", async () => {
  const res = await request(app).get("/api/analytics");

  assert.equal(res.status, 200);
  assert.equal(typeof res.body.weather_correlation, "string");
  assert.ok(res.body.weather_data_quality);
  assert.ok(res.body.rainfall_water_level);
  assert.ok(res.body.weather_flood_risk);
});

// ------------------------------------------------------------
// No side effects
// ------------------------------------------------------------

test("correlation API calls never open incidents", async () => {
  await insertAlignedDataset();

  await request(app).get("/api/predictions/weather-correlation");
  await request(app).get("/api/predictions/weather-correlation/summary");
  await request(app).get("/api/predictions/weather-correlation/drains");
  await request(app).get("/api/predictions/weather-correlation/rainfall_water_level?drainId=1");

  const incidents = await pool.query("SELECT COUNT(*) FROM incidents");
  assert.equal(Number(incidents.rows[0].count), 0);
});