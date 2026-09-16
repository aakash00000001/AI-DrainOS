// ============================================================
// MQTT service tests
//
// Cover topic parsing, payload validation, database mapping,
// AI integration + fallback, Socket.IO emission, alert
// escalation/dedup and broker-failure resilience.
//
// handleMessage is tested directly with an injected predict stub
// so no real MQTT broker is required.
// ============================================================

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { setup } = require("./helpers");

let app;
let pool;
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
  mqttService = require("../services/mqttService");
});

after(async () => {
  await pool.end();
});

// --------------------------------------------------
// Topic parsing
// --------------------------------------------------

test("parseTopic - valid topic returns drain and sensor ids", () => {
  const parsed = mqttService.parseTopic("ai-drainos/drains/5/sensors/7");
  assert.deepEqual(parsed, { drainId: 5, sensorId: 7 });
});

test("parseTopic - rejects malformed topics", () => {
  assert.equal(mqttService.parseTopic(""), null);
  assert.equal(mqttService.parseTopic("not/a/topic"), null);
  assert.equal(mqttService.parseTopic("ai-drainos/drains/x/sensors/7"), null);
  assert.equal(mqttService.parseTopic("ai-drainos/drains/5/sensors/abc"), null);
  assert.equal(mqttService.parseTopic("ai-drainos/drains/5"), null);
  assert.equal(mqttService.parseTopic("other/drains/5/sensors/7"), null);
});

// --------------------------------------------------
// Payload validation
// --------------------------------------------------

test("validateReading - accepts valid reading and normalizes it", () => {
  const { reading, error } = mqttService.validateReading({
    water_level: 90.4,
    gas_level: 80.6,
    temperature: 33.333,
    timestamp: "2026-08-05T10:30:00Z"
  });

  assert.equal(error, undefined);
  assert.deepEqual(reading, {
    water_level: 90,
    gas_level: 81,
    temperature: 33.33,
    timestamp: "2026-08-05T10:30:00.000Z"
  });
});

test("validateReading - missing required fields are rejected", () => {
  assert.match(mqttService.validateReading({ gas_level: 10, temperature: 30 }).error, /water_level/);
  assert.match(mqttService.validateReading({ water_level: 10, temperature: 30 }).error, /gas_level/);
  assert.match(mqttService.validateReading({ water_level: 10, gas_level: 10 }).error, /temperature/);
});

test("validateReading - non-numeric and null values are rejected", () => {
  assert.ok(mqttService.validateReading({
    water_level: "90", gas_level: 10, temperature: 30
  }).error);

  assert.ok(mqttService.validateReading({
    water_level: null, gas_level: 10, temperature: 30
  }).error);

  assert.ok(mqttService.validateReading({
    water_level: 90, gas_level: 10, temperature: "hot"
  }).error);
});

test("validateReading - impossible values are rejected", () => {
  assert.ok(mqttService.validateReading({
    water_level: 150, gas_level: 10, temperature: 30
  }).error);

  assert.ok(mqttService.validateReading({
    water_level: 50, gas_level: -5, temperature: 30
  }).error);

  assert.ok(mqttService.validateReading({
    water_level: 50, gas_level: 10, temperature: 100
  }).error);
});

test("validateReading - invalid timestamp is rejected", () => {
  assert.ok(mqttService.validateReading({
    water_level: 50, gas_level: 10, temperature: 30,
    timestamp: "not-a-date"
  }).error);
});

test("parsePayload - malformed JSON is rejected safely", () => {
  const result = mqttService.parsePayload("{ not json");
  assert.equal(result.error, "Invalid JSON payload");
});

// --------------------------------------------------
// End-to-end message handling (direct, no broker)
// --------------------------------------------------

test("handleMessage - stores a valid reading and emits sensorUpdate", async () => {
  const io = fakeIo();
  const predict = async () => ({ prediction: "LOW" });

  const topic = mqttService.buildTopic(1, 1);
  const payload = JSON.stringify({
    water_level: 20,
    gas_level: 15,
    temperature: 29.5,
    timestamp: "2026-08-05T10:30:00Z"
  });

  const result = await mqttService.handleMessage(topic, payload, { io, predict });

  assert.equal(result.status, "accepted");
  assert.equal(result.water_level, 20);
  assert.equal(result.gas_level, 15);
  assert.equal(result.temperature, 29.5);

  const row = (await pool.query("SELECT * FROM sensors WHERE id = 1")).rows[0];
  assert.equal(row.water_level, 20);
  assert.equal(row.gas_level, 15);
  assert.equal(Number(row.temperature), 29.5);

  const update = io.emitted.find((e) => e.event === "sensorUpdate");
  assert.ok(update);
  assert.equal(update.payload.drainId, 1);
  assert.equal(update.payload.sensorId, 1);
  assert.equal(update.payload.water_level, 20);
  assert.equal(update.payload.gas_level, 15);
  assert.equal(update.payload.temperature, 29.5);
  assert.equal(update.payload.prediction, "LOW");
  assert.equal(update.payload.source, "ai");
  assert.equal(update.payload.timestamp, "2026-08-05T10:30:00.000Z");
});

test("handleMessage - unknown drain is rejected without crashing", async () => {
  const io = fakeIo();

  const result = await mqttService.handleMessage(
    "ai-drainos/drains/999999/sensors/1",
    JSON.stringify({ water_level: 90, gas_level: 10, temperature: 30 }),
    { io }
  );

  assert.equal(result.status, "rejected");
  assert.equal(result.reason, "drain_not_found");
  assert.equal(io.emitted.length, 0);
});

test("handleMessage - sensor belonging to another drain is rejected", async () => {
  const result = await mqttService.handleMessage(
    "ai-drainos/drains/1/sensors/2",
    JSON.stringify({ water_level: 90, gas_level: 10, temperature: 30 }),
    { io: fakeIo() }
  );

  assert.equal(result.status, "rejected");
  assert.equal(result.reason, "sensor_drain_mismatch");
});

test("handleMessage - unknown sensor id maps to the drain's own sensor", async () => {
  const io = fakeIo();

  const result = await mqttService.handleMessage(
    "ai-drainos/drains/3/sensors/9999",
    JSON.stringify({ water_level: 55, gas_level: 40, temperature: 33 }),
    { io, predict: async () => ({ prediction: "MEDIUM" }) }
  );

  assert.equal(result.status, "accepted");
  assert.equal(result.sensorId, 3);

  const row = (await pool.query("SELECT * FROM sensors WHERE id = 3")).rows[0];
  assert.equal(row.water_level, 55);
});

test("handleMessage - creates a sensor for a drain that has none", async () => {
  const createdDrain = await pool.query(
    "INSERT INTO drains (zone_name, location, status, blockage_level) VALUES ('Zone MQTT', 'MQTT Test Area', 'Normal', 10) RETURNING id"
  );
  const drainId = createdDrain.rows[0].id;

  const io = fakeIo();

  const result = await mqttService.handleMessage(
    `ai-drainos/drains/${drainId}/sensors/5555`,
    JSON.stringify({ water_level: 12, gas_level: 8, temperature: 28 }),
    { io, predict: async () => ({ prediction: "LOW" }) }
  );

  assert.equal(result.status, "accepted");

  const row = (await pool.query(
    "SELECT * FROM sensors WHERE drain_id = $1",
    [drainId]
  )).rows[0];

  assert.ok(row);
  assert.equal(row.water_level, 12);
  assert.equal(result.sensorId, row.id);
});

test("handleMessage - bad JSON never crashes and leaves DB untouched", async () => {
  await pool.query("UPDATE sensors SET water_level = 20 WHERE id = 4");

  const result = await mqttService.handleMessage(
    "ai-drainos/drains/4/sensors/4",
    Buffer.from("{ not json"),
    { io: fakeIo() }
  );

  assert.equal(result.status, "rejected");
  assert.equal(result.reason, "invalid_payload");

  const row = (await pool.query("SELECT * FROM sensors WHERE id = 4")).rows[0];
  assert.equal(row.water_level, 20);
});

test("handleMessage - missing field message is rejected", async () => {
  const result = await mqttService.handleMessage(
    "ai-drainos/drains/6/sensors/6",
    JSON.stringify({ water_level: 25, gas_level: 15 }),
    { io: fakeIo() }
  );

  assert.equal(result.status, "rejected");
  assert.equal(result.reason, "invalid_payload");
});

// --------------------------------------------------
// AI integration
// --------------------------------------------------

test("handleMessage - AI prediction cached for unchanged readings", async () => {
  let aiCalls = 0;

  const predict = async () => {
    aiCalls += 1;
    return { prediction: "HIGH" };
  };

  const payload = JSON.stringify({
    water_level: 92,
    gas_level: 70,
    temperature: 35
  });

  const first = await mqttService.handleMessage(
    "ai-drainos/drains/7/sensors/7",
    payload,
    { io: fakeIo(), predict }
  );

  assert.equal(first.status, "accepted");
  assert.equal(first.prediction, "HIGH");
  assert.equal(first.source, "ai");
  assert.equal(aiCalls, 1);

  // Identical reading -> cached, AI not called again
  const second = await mqttService.handleMessage(
    "ai-drainos/drains/7/sensors/7",
    payload,
    { io: fakeIo(), predict }
  );

  assert.equal(second.status, "accepted");
  assert.equal(second.prediction, "HIGH");
  assert.equal(second.source, "cached");
  assert.equal(aiCalls, 1);
});

test("handleMessage - falls back to thresholds when AI is unreachable", async () => {
  const predict = async () => {
    throw new Error("AI service down");
  };

  const result = await mqttService.handleMessage(
    "ai-drainos/drains/6/sensors/6",
    JSON.stringify({ water_level: 20, gas_level: 15, temperature: 30 }),
    { io: fakeIo(), predict }
  );

  assert.equal(result.status, "accepted");
  assert.equal(result.prediction, "LOW");
  assert.equal(result.source, "fallback");
});

// --------------------------------------------------
// Alert workflow (escalation + dedupe + recovery)
// --------------------------------------------------

test("handleMessage - escalates drain, creates alert once, resolves on recovery", async () => {
  const floodAlerts = async () => {
    const r = await pool.query(
      `
      SELECT * FROM alerts
      WHERE drain_id = 4 AND alert_type = 'Flood Risk'
      ORDER BY id ASC
      `
    );
    return r.rows;
  };

  // 1. High water -> drain 4 (Bypass Road, Normal) becomes Critical
  const critical = await mqttService.handleMessage(
    "ai-drainos/drains/4/sensors/4",
    JSON.stringify({ water_level: 95, gas_level: 80, temperature: 37 }),
    { io: fakeIo(), predict: async () => ({ prediction: "HIGH" }) }
  );

  assert.equal(critical.status, "accepted");

  const drain = (await pool.query("SELECT * FROM drains WHERE id = 4")).rows[0];
  assert.equal(drain.status, "Critical");

  let alerts = await floodAlerts();
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].severity, "Critical");
  assert.equal(alerts[0].alert_status, "Open");

  // 2. Republishing a high reading must NOT duplicate the alert
  await mqttService.handleMessage(
    "ai-drainos/drains/4/sensors/4",
    JSON.stringify({ water_level: 96, gas_level: 80, temperature: 37 }),
    { io: fakeIo(), predict: async () => ({ prediction: "HIGH" }) }
  );

  alerts = await floodAlerts();
  assert.equal(alerts.length, 1);

  // 3. Recovery -> drain Normal and flood alert resolved
  const recovered = await mqttService.handleMessage(
    "ai-drainos/drains/4/sensors/4",
    JSON.stringify({ water_level: 10, gas_level: 5, temperature: 28 }),
    { io: fakeIo(), predict: async () => ({ prediction: "LOW" }) }
  );

  assert.equal(recovered.status, "accepted");

  const drainAfter = (await pool.query("SELECT * FROM drains WHERE id = 4")).rows[0];
  assert.equal(drainAfter.status, "Normal");

  alerts = await floodAlerts();
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].alert_status, "Resolved");
});

// --------------------------------------------------
// Broker failure resilience
// --------------------------------------------------

test("startMqttService - survives a missing broker without throwing", async () => {
  process.env.MQTT_BROKER_URL = "mqtt://127.0.0.1:59999";

  const client = mqttService.startMqttService({ io: fakeIo() });

  assert.ok(client);

  // The service returns a live client that keeps retrying in the background.
  client.end(true);

  delete process.env.MQTT_BROKER_URL;
});