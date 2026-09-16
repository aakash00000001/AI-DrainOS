// ============================================================
// AI-DrainOS Sensor Simulator
//
// Generates realistic water/gas/temperature readings for every
// drain and updates drain status + alerts based on thresholds
// configured in the Settings page.
//
// Usage (from server/):
//   npm run simulate           -> loop forever (interval from settings)
//   npm run simulate:once      -> generate one round and exit
// ============================================================

const pool = require("../config/db");

const floodRisk = require("../services/floodRiskService");

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
// Generate one reading round
// --------------------------------------------------

async function simulateRound() {
  const settings = await getSettings();

  // Drains that should be monitored
  const drains = await pool.query(`
    SELECT d.*, s.id AS sensor_id
    FROM drains d
    LEFT JOIN sensors s
      ON s.drain_id = d.id
    ORDER BY d.id ASC
  `);

  for (const drain of drains.rows) {
    // --------------------------------------------------
    // Random walk values (keep within sane ranges)
    // --------------------------------------------------

    let prev = state.get(drain.id);

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

    state.set(drain.id, { water_level: waterLevel, gas_level: gasLevel, temperature });

    // --------------------------------------------------
    // Drain status from thresholds
    // --------------------------------------------------

    let status = "Normal";

    if (waterLevel >= settings.critical_threshold) {
      status = "Critical";
    } else if (waterLevel >= settings.warning_threshold) {
      status = "Warning";
    }

    // --------------------------------------------------
    // Write sensor reading
    // --------------------------------------------------

    if (drain.sensor_id) {
      await pool.query(
        `
        UPDATE sensors
        SET
          water_level = $1,
          gas_level = $2,
          temperature = $3,
          status = $4,
          recorded_at = CURRENT_TIMESTAMP
        WHERE id = $5
        `,
        [Math.round(waterLevel), Math.round(gasLevel), temperature.toFixed(2), status, drain.sensor_id]
      );
    } else {
      const inserted = await pool.query(
        `
        INSERT INTO sensors (drain_id, water_level, gas_level, temperature, status)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id
        `,
        [drain.id, Math.round(waterLevel), Math.round(gasLevel), temperature.toFixed(2), status]
      );

      drain.sensor_id = inserted.rows[0].id;
    }

    // --------------------------------------------------
    // Historical reading for flood risk trend / analytics
    // --------------------------------------------------

    await floodRisk.recordReading(drain.sensor_id, drain.id, {
      water_level: Math.round(waterLevel),
      gas_level: Math.round(gasLevel),
      temperature: Number(temperature.toFixed(2))
    });

    // --------------------------------------------------
    // Update drain status
    // --------------------------------------------------

    if (drain.status !== status) {
      await pool.query(
        `
        UPDATE drains
        SET status = $1
        WHERE id = $2
        `,
        [status, drain.id]
      );

      console.log(`📍 ${drain.location}: ${drain.status} → ${status}`);
    }

    // --------------------------------------------------
    // Create alert on escalation (only when it gets worse)
    // --------------------------------------------------

    const escalation =
      (drain.status === "Normal" && status === "Warning") ||
      (drain.status === "Normal" && status === "Critical") ||
      (drain.status === "Warning" && status === "Critical");

    if (escalation) {
      const existing = await pool.query(
        `
        SELECT id
        FROM alerts
        WHERE drain_id = $1
          AND alert_status = 'Open'
          AND alert_type = 'Flood Risk'
        `,
        [drain.id]
      );

      if (existing.rows.length === 0) {
        const severity = status === "Critical" ? "Critical" : "Medium";

        await pool.query(
          `
          INSERT INTO alerts (drain_id, alert_type, message, severity, alert_status)
          VALUES ($1, 'Flood Risk', $2, $3, 'Open')
          `,
          [
            drain.id,
            `Water level in ${drain.location} reached ${Math.round(waterLevel)}% (${status})`,
            severity
          ]
        );

        console.log(`🚨 New ${severity} alert for ${drain.location}`);
      }
    }
  }

  const summary = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE status = 'Critical') AS critical,
      COUNT(*) FILTER (WHERE status = 'Warning') AS warning,
      COUNT(*) FILTER (WHERE status = 'Normal') AS normal
    FROM drains
  `);

  const s = summary.rows[0];
  console.log(
    `📊 Round complete → Critical: ${s.critical} | Warning: ${s.warning} | Normal: ${s.normal}`
  );
}

// --------------------------------------------------
// Main
// --------------------------------------------------

async function main() {
  const once = process.argv.includes("--once");

  console.log(once ? "🔬 Sensor simulator: single round" : "🔬 Sensor simulator started (Ctrl+C to stop)");

  await simulateRound();

  if (once) {
    console.log("✅ Done");
    return pool.end();
  }

  let running = true;

  const tick = async () => {
    if (!running) return;

    try {
      await simulateRound();
    } catch (err) {
      console.log("========== SIMULATOR ERROR ==========");
      console.log(err.message);
    }
  };

  const loop = async () => {
    while (running) {
      const settings = await getSettings();
      const interval = Math.max(5, settings.sensor_sim_interval) * 1000;

      await new Promise((resolve) => setTimeout(resolve, interval));

      if (running) {
        await tick();
      }
    }
  };

  process.on("SIGINT", async () => {
    running = false;
    console.log("\n🛑 Simulator stopped");
    await pool.end();
    process.exit(0);
  });

  loop();
}

main();
