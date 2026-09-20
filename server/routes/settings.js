const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const config = require("../config/env");
const logger = require("../config/logger");

const { authMiddleware, adminOnly } = require("../middleware/auth");
const { createRateLimiter } = require("../middleware/rateLimiter");

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

// Per-key validation rules. Thresholds are percentages; intervals are
// positive seconds; notification_enabled is a boolean.
const RULES = {
  critical_threshold: (v) => Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 100,
  warning_threshold: (v) => Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 100,
  battery_low_threshold: (v) => Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 100,
  sensor_sim_interval: (v) => Number.isInteger(Number(v)) && Number(v) > 0,
  notification_enabled: (v) => v === true || v === false || v === "true" || v === "false",
  system_name: (v) => typeof v === "string" && v.trim().length > 0 && v.length <= 100,
  risk_moderate_min: (v) => Number.isFinite(Number(v)) && Number(v) > 0,
  risk_high_min: (v) => Number.isFinite(Number(v)) && Number(v) > 0,
  risk_critical_min: (v) => Number.isFinite(Number(v)) && Number(v) > 0
};

const mutationLimiter = createRateLimiter({
  name: "settingsMutationLimiter",
  windowMs: config.rateLimits.mutation.windowMs,
  max: config.rateLimits.mutation.max
});

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
    logger.error("Settings GET failed", { message: err.message });
    res.status(500).json({ error: "Server Error" });
  }
});

// --------------------------------------------------
// PUT - Update settings (partial update by key)
// --------------------------------------------------

router.put("/", authMiddleware, adminOnly, mutationLimiter, async (req, res) => {
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

    const invalid = entries.filter(([key, value]) => !RULES[key](value));
    if (invalid.length > 0) {
      return res.status(400).json({
        error: `Invalid value for: ${invalid.map(([k]) => k).join(", ")}`
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
    logger.error("Settings PUT failed", { message: err.message });
    res.status(500).json({ error: "Server Error" });
  }
});

module.exports = router;