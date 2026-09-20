const express = require("express");
const router = express.Router();

const pool = require("../config/db");
const config = require("../config/env");
const logger = require("../config/logger");

const { authMiddleware } = require("../middleware/auth");
const { createRateLimiter } = require("../middleware/rateLimiter");
const { positiveIntParam } = require("../middleware/validate");
const { auditMutation } = require("../middleware/auditMutation");

const VALID_SEVERITIES = ["Critical", "Medium", "Low"];
const MAX_ALERTS = 1000;

async function loadAlertForAudit(req) {
  const result = await pool.query(
    `
    SELECT id, drain_id, alert_type, message, severity, alert_status
    FROM alerts
    WHERE id = $1
    `,
    [req.params.id]
  );
  return result.rows[0] || null;
}

const mutationLimiter = createRateLimiter({
  name: "alertsMutationLimiter",
  windowMs: config.rateLimits.mutation.windowMs,
  max: config.rateLimits.mutation.max
});

const handleError = (res, err) => {
  logger.error("Alerts route error", { message: err.message });
  res.status(500).json({ error: "Internal server error" });
};

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
      LIMIT ${MAX_ALERTS}
      `,
      params
    );

    res.json(result.rows);

  } catch (error) {
    handleError(res, error);
  }
});

// --------------------------------------------------
// POST - Create alert manually (auth required)
// --------------------------------------------------

router.post("/", authMiddleware, mutationLimiter, auditMutation({
  action: "ALERT_CREATE",
  entityType: "ALERT",
  entityId: (req, body) => (body && body.id !== undefined ? body.id : null)
}), async (req, res) => {
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

    if (!Number.isInteger(Number(drain_id)) || Number(drain_id) <= 0) {
      return res.status(400).json({
        error: "drain_id must be a positive integer"
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
    handleError(res, error);
  }
});

// --------------------------------------------------
// PUT - Update alert (resolve / reopen) (auth required)
// --------------------------------------------------

router.put("/:id", positiveIntParam("id"), authMiddleware, mutationLimiter, auditMutation({
  action: "ALERT_UPDATE",
  entityType: "ALERT",
  entityId: (req) => req.params.id,
  before: loadAlertForAudit
}), async (req, res) => {
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
    handleError(res, error);
  }
});

module.exports = router;