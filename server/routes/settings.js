const express = require("express");
const router = express.Router();
const pool = require("../config/db");

const { authMiddleware, adminOnly } = require("../middleware/auth");

const ALLOWED_KEYS = [
  "system_name",
  "critical_threshold",
  "warning_threshold",
  "battery_low_threshold",
  "sensor_sim_interval",
  "notification_enabled",
  "risk_moderate_min",
  "risk_high_min",
  "risk_critical_min"
];

// --------------------------------------------------
// GET - All settings (key -> value)
// --------------------------------------------------

router.get("/", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT key, value
      FROM settings
      ORDER BY key ASC
    `);

    const settings = {};
    result.rows.forEach((row) => {
      settings[row.key] = row.value;
    });

    res.json(settings);

  } catch (err) {
    console.log(err);
    res.status(500).json({ error: "Server Error" });
  }
});

// --------------------------------------------------
// PUT - Update settings (partial update by key)
// --------------------------------------------------

router.put("/", authMiddleware, adminOnly, async (req, res) => {
  try {
    const body = req.body || {};

    const entries = Object.entries(body).filter(
      ([key, value]) => ALLOWED_KEYS.includes(key) && value !== undefined && value !== null
    );

    if (entries.length === 0) {
      return res.status(400).json({
        error: "No valid settings provided"
      });
    }

    for (const [key, value] of entries) {
      await pool.query(
        `
        INSERT INTO settings (key, value, updated_at)
        VALUES ($1, $2, CURRENT_TIMESTAMP)
        ON CONFLICT (key)
        DO UPDATE SET value = $2, updated_at = CURRENT_TIMESTAMP
        `,
        [key, String(value)]
      );
    }

    const result = await pool.query(`
      SELECT key, value
      FROM settings
      ORDER BY key ASC
    `);

    const settings = {};
    result.rows.forEach((row) => {
      settings[row.key] = row.value;
    });

    res.json({
      message: "Settings updated successfully",
      settings
    });

  } catch (err) {
    console.log(err);
    res.status(500).json({ error: "Server Error" });
  }
});

module.exports = router;
