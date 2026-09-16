const express = require("express");
const router = express.Router();

const pool = require("../config/db");

const { authMiddleware } = require("../middleware/auth");

const VALID_SEVERITIES = ["Critical", "Medium", "Low"];

// --------------------------------------------------
// GET - All alerts (optional ?status=Open|Resolved)
// --------------------------------------------------

router.get("/", async (req, res) => {
  try {
    const { status } = req.query;

    const statusFilter =
      status && ["Open", "Resolved"].includes(status)
        ? "WHERE a.alert_status = $1"
        : "";

    const params = status && ["Open", "Resolved"].includes(status) ? [status] : [];

    const result = await pool.query(
      `
      SELECT
        a.id,
        a.alert_type,
        a.severity,
        a.message,
        a.alert_status,
        a.created_at,
        d.zone_name,
        d.location
      FROM alerts a
      JOIN drains d
        ON a.drain_id = d.id
      ${statusFilter}
      ORDER BY a.id DESC
      `,
      params
    );

    res.json(result.rows);

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --------------------------------------------------
// POST - Create alert manually (auth required)
// --------------------------------------------------

router.post("/", authMiddleware, async (req, res) => {
  try {
    const {
      drain_id,
      alert_type,
      message,
      severity = "Medium"
    } = req.body;

    if (!drain_id || !alert_type || !message) {
      return res.status(400).json({
        error: "drain_id, alert_type and message are required"
      });
    }

    if (!VALID_SEVERITIES.includes(severity)) {
      return res.status(400).json({
        error: "severity must be Critical, Medium or Low"
      });
    }

    const drain = await pool.query(
      "SELECT * FROM drains WHERE id = $1",
      [drain_id]
    );

    if (drain.rows.length === 0) {
      return res.status(404).json({ error: "Drain not found" });
    }

    const result = await pool.query(
      `
      INSERT INTO alerts (drain_id, alert_type, message, severity, alert_status)
      VALUES ($1, $2, $3, $4, 'Open')
      RETURNING *
      `,
      [drain_id, alert_type, message, severity]
    );

    res.status(201).json(result.rows[0]);

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --------------------------------------------------
// PUT - Update alert (resolve / reopen) (auth required)
// --------------------------------------------------

router.put("/:id", authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { alert_status } = req.body;

    if (!["Open", "Resolved"].includes(alert_status)) {
      return res.status(400).json({
        error: "alert_status must be Open or Resolved"
      });
    }

    const result = await pool.query(
      `
      UPDATE alerts
      SET alert_status = $1
      WHERE id = $2
      RETURNING *
      `,
      [alert_status, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Alert not found" });
    }

    res.json(result.rows[0]);

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
