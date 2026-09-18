// ============================================================
// AI-DrainOS — Weather + Flood Correlation service tests
// (UPDATE #23)
//
// Verifies the additive weather-flood correlation intelligence:
//   * descriptive Pearson correlation from REAL weather + sensor
//     observations (never fabricated history)
//   * honest WEATHER_UNAVAILABLE / INSUFFICIENT_DATA /
//     NOT_AVAILABLE states
//   * timestamp alignment + tolerance pairing, bounded windows
//   * strength categories + direction semantics
//   * weather-vs-flood-risk and weather-vs-forecast honourably
//     NOT_AVAILABLE (nothing persisted to recompute from)
//   * data-quality metadata + determinism + non-causal wording
//   * signature-guarded live emission + NO incidents from
//     correlation alone
// ============================================================

const { test, before, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const { setup } = require("./helpers");

let app;
let pool;
let service;
let socketHub;

const captured = [];

const fakeIo = {
  emit(event, payload) {
    captured.push({ event, payload });
  }
};

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

function iso(ms) {
  return new Date(ms).toISOString();
}

async function clearTables() {
  await pool.query("DELETE FROM sensor_readings");
  await pool.query("DELETE FROM weather_observations");
  await pool.query("DELETE FROM incidents");
  service.resetWeatherCorrelationRuntime();
  captured.length = 0;
}

async function insertObservation({
  observedAt,
  temperature = null,
  humidity = null,
  pressure = null,
  windSpeed = null,
  rain1h = null,
  main = null
}) {
  await pool.query(
    `
    INSERT INTO weather_observations
      (observed_at, temperature, humidity, pressure, wind_speed,
       weather_main, weather_description, rain_1h, rain_3h)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    ON CONFLICT (observed_at) DO NOTHING
    `,
    [
      iso(observedAt),
      temperature,
      humidity,
      pressure,
      windSpeed,
      main,
      main,
      rain1h,
      null
    ]
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

// Inserts N aligned observation/reading pairs over the last ~12h.
// rain values drive water_level exactly (water = 10 + 3*rain) so the
// rainfall_water_level correlation is perfect. Other metrics use
// deterministic values decoupled from water.
async function insertAlignedDataset({
  drainId = 1,
  count = 24,
  stepMin = 30,
  rain = (i) => (i % 5) + Math.floor(i / 5),
  humidity = (i) => ((i * 7 + 3) % 11) * 8,
  wind = (i) => 80 - 2 * (10 + 3 * rain(i)),
  baseMs = null
} = {}) {
  const base = baseMs !== null ? baseMs : Date.now() - 12 * HOUR;
  const t0 = Math.floor(base / MIN) * MIN;
  for (let i = 0; i < count; i += 1) {
    const obsAt = t0 + i * stepMin * MIN;
    const water = 10 + 3 * rain(i);
    await insertObservation({
      observedAt: obsAt,
      temperature: 28 + Math.sin(i),
      humidity: humidity(i),
      pressure: 1010 + (i % 3),
      windSpeed: wind(i),
      rain1h: rain(i),
      main: rain(i) >= 3 ? "Rain" : "Clouds"
    });
    await insertReading({
      drainId,
      recordedAt: obsAt + 5 * MIN,
      water
    });
  }
}

before(async () => {
  const setupResult = await setup();
  app = setupResult.app;
  pool = setupResult.pool;

  service = require("../services/weatherFloodCorrelationService");
  socketHub = require("../services/socketHub");
  socketHub.init(fakeIo);
});

beforeEach(clearTables);

// ------------------------------------------------------------
// Pure logic: Pearson, direction, strength
// ------------------------------------------------------------

test("pearson returns ~1 for a perfect positive linear relationship", () => {
  const pairs = [0, 1, 2, 3, 4].map((x) => ({ x, y: 2 * x + 5 }));
  assert.ok(Math.abs(service.pearson(pairs) - 1) < 1e-9);
});

test("pearson returns ~-1 for a perfect negative linear relationship", () => {
  const pairs = [0, 1, 2, 3, 4].map((x) => ({ x, y: 20 - 3 * x }));
  assert.ok(Math.abs(service.pearson(pairs) + 1) < 1e-9);
});

test("pearson is deterministically 0 for orthogonal data", () => {
  const pairs = [
    { x: -2, y: 4 },
    { x: -1, y: 1 },
    { x: 0, y: 0 },
    { x: 1, y: 1 },
    { x: 2, y: 4 }
  ];
  assert.equal(service.pearson(pairs), 0);
});

test("pearson returns null for flat series (zero variance)", () => {
  const pairs = [1, 2, 3].map((x) => ({ x, y: 7 }));
  assert.equal(service.pearson(pairs), null);
});

test("directionFromR is POSITIVE / NEGATIVE / NONE with an epsilon", () => {
  assert.equal(service.directionFromR(0.85), "POSITIVE");
  assert.equal(service.directionFromR(-0.7), "NEGATIVE");
  assert.equal(service.directionFromR(0.001), "NONE");
  assert.equal(service.directionFromR(-0.02), "NONE");
});

test("strengthFromR applies the documented 5-band categories", () => {
  assert.equal(service.strengthFromR(0.05).key, "VERY_WEAK");
  assert.equal(service.strengthFromR(0.3).key, "WEAK");
  assert.equal(service.strengthFromR(0.45).key, "MODERATE");
  assert.equal(service.strengthFromR(0.7).key, "STRONG");
  assert.equal(service.strengthFromR(0.85).key, "VERY_STRONG");
});

test("alignToNearest pairs only within the tolerance window", () => {
  const weather = [
    { observed_at: iso(Date.now() - 30 * MIN), i: 0 },
    { observed_at: iso(Date.now() + 90 * MIN), i: 1 }
  ];
  const readings = [0, 10, 20].map((off) => ({
    id: off / 10 + 1,
    recorded_at: new Date(Date.now() - 30 * MIN + off * MIN),
    drain_id: 1,
    water_level: 5
  }));

  const aligned = service.alignToNearest({
    weather,
    readings,
    toleranceMinutes: 30
  });

  // Only the first observation has a reading within 30 minutes.
  assert.equal(aligned.length, 1);
  assert.equal(aligned[0].obsIndex, 0);
});

// ------------------------------------------------------------
// Honest states
// ------------------------------------------------------------

test("rainfall_water_level reports READY with a perfect correlation", async () => {
  await insertAlignedDataset({ count: 24 });

  const result = await service.getWeatherCorrelation({
    signal: "rainfall_water_level",
    drainId: 1
  });

  assert.equal(result.status, "READY");
  assert.equal(result.signal, "rainfall_water_level");
  assert.ok(Math.abs(result.correlation.r - 1) < 1e-9);
  assert.equal(result.correlation.direction, "POSITIVE");
  assert.equal(result.correlation.strength, "VERY_STRONG");
  assert.ok(result.samples.matched_pairs >= 20);
  assert.ok(/never a causal claim/.test(result.wording));
});

test("wind_water_level reports a negative relationship", async () => {
  await insertAlignedDataset({ count: 24 });

  const result = await service.getWeatherCorrelation({
    signal: "wind_water_level",
    drainId: 1
  });

  assert.equal(result.status, "READY");
  assert.ok(result.correlation.r < 0);
  assert.equal(result.correlation.direction, "NEGATIVE");
});

test("humidity_water_level reports near-zero correlation as NONE", async () => {
  await insertAlignedDataset({ count: 24 });

  const result = await service.getWeatherCorrelation({
    signal: "humidity_water_level",
    drainId: 1
  });

  assert.equal(result.status, "READY");
  assert.equal(result.correlation.direction, "NONE");
  assert.ok(Math.abs(result.correlation.r) <= 0.05);
});

test("insufficient aligned pairs reports INSUFFICIENT_DATA", async () => {
  await insertAlignedDataset({ count: 5 });

  const result = await service.getWeatherCorrelation({
    signal: "rainfall_water_level",
    drainId: 1
  });

  assert.equal(result.status, "INSUFFICIENT_DATA");
  assert.equal(result.correlation, null);
  assert.ok(result.message.includes("aligned observation pair"));
});

test("weather is unavailable (no observations) reports WEATHER_UNAVAILABLE", async () => {
  await insertReading({ drainId: 1, recordedAt: Date.now() - HOUR, water: 20 });

  const result = await service.getWeatherCorrelation({
    signal: "rainfall_water_level",
    drainId: 1
  });

  assert.equal(result.status, "WEATHER_UNAVAILABLE");
  assert.equal(result.correlation, null);
});

test("missing sensor data reports INSUFFICIENT_DATA even with weather", async () => {
  await insertObservation({
    observedAt: Date.now() - HOUR,
    rain1h: 2,
    main: "Rain"
  });

  const result = await service.getWeatherCorrelation({
    signal: "rainfall_water_level",
    drainId: 1
  });

  assert.equal(result.status, "INSUFFICIENT_DATA");
  assert.ok(result.message.includes("No sensor readings"));
});

test("weather_flood_risk is honourably NOT_AVAILABLE (risk not persisted)", async () => {
  await insertAlignedDataset({ count: 24 });

  const result = await service.getWeatherCorrelation({
    signal: "weather_flood_risk",
    drainId: 1
  });

  assert.equal(result.status, "NOT_AVAILABLE");
  assert.equal(result.correlation, null);
  assert.ok(/not persisted/.test(result.message));
});

test("weather_forecast is honourably NOT_AVAILABLE (forecast not persisted)", async () => {
  await insertAlignedDataset({ count: 24 });

  const result = await service.getWeatherCorrelation({
    signal: "weather_forecast",
    drainId: 1
  });

  assert.equal(result.status, "NOT_AVAILABLE");
  assert.equal(result.correlation, null);
});

test("unknown signals return null", async () => {
  const result = await service.getWeatherCorrelation({ signal: "bogus" });
  assert.equal(result, null);
});

test("unknown drains return null", async () => {
  const result = await service.getWeatherCorrelation({
    signal: "rainfall_water_level",
    drainId: 9999
  });
  assert.equal(result, null);
});

// ------------------------------------------------------------
// Bounded history + quality metadata
// ------------------------------------------------------------

test("bounded history respects the window hours", async () => {
  const nowMs = Date.now();
  await insertObservation({ observedAt: nowMs - 25 * HOUR, rain1h: 1 });
  await insertObservation({ observedAt: nowMs - 2 * HOUR, rain1h: 2 });

  const w24 = await service.getCorrelationSummary({ windowHours: 24 });
  const w168 = await service.getCorrelationSummary({ windowHours: 168 });

  assert.equal(w24.weather_data_quality.observation_count, 1);
  assert.equal(w168.weather_data_quality.observation_count, 2);
});

test("summary exposes data-quality metadata for every signal", async () => {
  await insertAlignedDataset({ count: 24 });

  const summary = await service.getCorrelationSummary();

  const rainfall = summary.signals.find(
    (s) => s.signal === "rainfall_water_level"
  );
  assert.ok(rainfall.matched_pairs >= 20);
  assert.ok(summary.weather_data_quality.observation_count >= 24);
  assert.ok(summary.latest_weather);
  assert.equal(summary.signals_total, 7);
  assert.ok(summary.signals.some((s) => s.status === "NOT_AVAILABLE"));
});

test("strongest picks the highest |r| among ready signals", async () => {
  await insertAlignedDataset({ count: 24 });

  const summary = await service.getCorrelationSummary();

  assert.equal(summary.status, "READY");
  assert.ok(summary.strongest);
  assert.equal(summary.strongest.signal, "rainfall_water_level");
  assert.ok(Math.abs(summary.strongest.r - 1) < 1e-9);
});

test("results are deterministic across repeated computation", async () => {
  await insertAlignedDataset({ count: 24 });

  const a = await service.getWeatherCorrelation({
    signal: "rainfall_water_level",
    drainId: 1
  });
  const b = await service.getWeatherCorrelation({
    signal: "rainfall_water_level",
    drainId: 1
  });

  assert.equal(a.correlation.r, b.correlation.r);
  assert.equal(a.correlation.direction, b.correlation.direction);
});

test("no incidents are ever opened from a correlation", async () => {
  await insertAlignedDataset({ count: 24 });

  await service.evaluateAndEmitWeatherCorrelation({ forceRefresh: true });

  const incidents = await pool.query("SELECT COUNT(*) FROM incidents");
  assert.equal(Number(incidents.rows[0].count), 0);
});

// ------------------------------------------------------------
// Live emission (signature-guarded, additive context)
// ------------------------------------------------------------

test("weatherFloodCorrelationUpdate emits only on meaningful change", async () => {
  await insertAlignedDataset({ count: 24 });

  const first = await service.evaluateAndEmitWeatherCorrelation({
    forceRefresh: true
  });
  const second = await service.evaluateAndEmitWeatherCorrelation({
    forceRefresh: true
  });

  assert.equal(first.emitted, true);
  assert.equal(second.emitted, false);
  assert.equal(second.reason, "UNCHANGED");

  const emitted = captured.filter(
    (c) => c.event === "weatherFloodCorrelationUpdate"
  );
  assert.equal(emitted.length, 1);
  assert.ok(emitted[0].payload.status);
});

test("getWeatherCorrelationContext returns cached additive context", async () => {
  await insertAlignedDataset({ count: 24 });

  const ctx = await service.getWeatherCorrelationContext();

  assert.ok(ctx.weatherContext);
  assert.equal(ctx.weatherContext.status, "READY");
  assert.ok(ctx.weatherContext.latest);
  assert.ok(ctx.weatherCorrelation);
  assert.ok(Array.isArray(ctx.weatherCorrelation.signals));
  assert.equal(ctx.weatherCorrelation.signals.length, 7);
});