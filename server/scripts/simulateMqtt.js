// ============================================================
// AI-DrainOS MQTT Sensor Simulator
//
// Publishes realistic water/gas/temperature readings over MQTT
// to ai-drainos/drains/{drainId}/sensors/{sensorId} topics so
// the backend MQTT service can consume them end to end.
//
// Usage (from server/):
//   npm run simulate:mqtt   (needs a running MQTT broker)
//
// Optional env overrides:
//   MQTT_SIM_INTERVAL       seconds between rounds (default: setting)
// ============================================================

const mqtt = require("mqtt");

const pool = require("../config/db");

const MQTT_TOPIC_PREFIX =
  process.env.MQTT_TOPIC_PREFIX || "ai-drainos";

const brokerUrl =
  process.env.MQTT_BROKER_URL || "mqtt://localhost:1883";

const username = process.env.MQTT_USERNAME || undefined;
const password = process.env.MQTT_PASSWORD || undefined;

const clientId =
  process.env.MQTT_CLIENT_ID || "ai-drainos-simulator";

// --------------------------------------------------
// State (random walk)
// --------------------------------------------------

const state = new Map();

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

// --------------------------------------------------
// Settings
// --------------------------------------------------

async function getSettings() {
  const result = await pool.query(`
    SELECT key, value
    FROM settings
    WHERE key IN ('critical_threshold', 'warning_threshold', 'sensor_sim_interval')
  `);

  const settings = {
    critical_threshold: 80,
    warning_threshold: 50,
    sensor_sim_interval: 10
  };

  result.rows.forEach((row) => {
    settings[row.key] = Number(row.value);
  });

  return settings;
}

// --------------------------------------------------
// Publish one round of readings
// --------------------------------------------------

async function publishRound(client) {
  if (!client.connected) {
    console.log("⏳ MQTT broker not connected, skipping round...");
    return;
  }

  const targets = await pool.query(`
    SELECT d.id AS drain_id, s.id AS sensor_id, d.location
    FROM drains d
    LEFT JOIN sensors s
      ON s.drain_id = d.id
    ORDER BY d.id ASC
  `);

  for (const target of targets.rows) {
    if (!target.sensor_id) {
      console.log(
        `⚠️ Drain ${target.drain_id} (${target.location}) has no sensor yet - skipping`
      );
      continue;
    }

    // ----------------------------------------------
    // Random walk values (keep within sane ranges)
    // ----------------------------------------------

    const prev = state.get(target.drain_id);

    const waterLevel = Math.max(
      5,
      Math.min(100, (prev?.water_level ?? randomBetween(20, 45)) + randomBetween(-8, 8))
    );

    const gasLevel = Math.max(
      0,
      Math.min(100, (prev?.gas_level ?? randomBetween(10, 30)) + randomBetween(-6, 6))
    );

    const temperature = Math.max(
      25,
      Math.min(45, (prev?.temperature ?? randomBetween(28, 34)) + randomBetween(-1, 1))
    );

    state.set(target.drain_id, {
      water_level: waterLevel,
      gas_level: gasLevel,
      temperature
    });

    // ----------------------------------------------
    // Publish
    // ----------------------------------------------

    const topic =
      `${MQTT_TOPIC_PREFIX}/drains/${target.drain_id}/sensors/${target.sensor_id}`;

    const payload = JSON.stringify({
      water_level: Math.round(waterLevel),
      gas_level: Math.round(gasLevel),
      temperature: Number(temperature.toFixed(2)),
      timestamp: new Date().toISOString()
    });

    client.publish(topic, payload, { qos: 0 }, (err) => {
      if (err) {
        console.log("❌ Publish failed:", err.message);
      }
    });

    console.log(`📤 → ${topic}  ${payload}`);
  }
}

// --------------------------------------------------
// Main
// --------------------------------------------------

async function main() {
  console.log(`🔌 MQTT sensor simulator → ${brokerUrl}`);

  const client = mqtt.connect(brokerUrl, {
    clientId,
    username,
    password,
    reconnectPeriod: 5000
  });

  client.on("error", (err) => {
    console.log("🔌 MQTT error:", err.message);
  });

  client.on("connect", () => {
    console.log("✅ Connected to MQTT broker");
  });

  client.on("reconnect", () => {
    console.log("🔌 MQTT reconnecting...");
  });

  let running = true;

  const loop = async () => {
    while (running) {
      const settings = await getSettings();

      const interval =
        Math.max(
          5,
          Number(process.env.MQTT_SIM_INTERVAL) ||
            settings.sensor_sim_interval
        ) * 1000;

      await new Promise((resolve) => setTimeout(resolve, interval));

      if (running) {
        try {
          await publishRound(client);
        } catch (err) {
          console.log("========== MQTT SIMULATOR ERROR ==========");
          console.log(err.message);
        }
      }
    }
  };

  process.on("SIGINT", async () => {
    running = false;
    console.log("\n🛑 MQTT simulator stopped");

    try {
      client.end();
    } catch (err) {
      console.log(err.message);
    }

    await pool.end();
    process.exit(0);
  });

  loop();
}

main();