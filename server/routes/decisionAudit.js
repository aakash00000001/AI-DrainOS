// ============================================================
// decisionAudit.js
//
// Update #24 - Explainable AI + Decision Audit (read-only REST).
//
// Every GET is a bounded, parameterized read into the append-only
// decision_audits table. POST /snapshot (auth-protected) is the only
// write path: it records the CURRENT state of an existing engine via
// the decision audit service and never dispatches robots.
// ============================================================

const express = require("express");
const router = express.Router();

const config = require("../config/env");
const decisionAuditService = require("../services/decisionAuditService");
const { authMiddleware } = require("../middleware/auth");
const { createRateLimiter } = require("../middleware/rateLimiter");

const snapshotLimiter = createRateLimiter({
  name: "auditSnapshotLimiter",
  windowMs: config.rateLimits.mutation.windowMs,
  max: config.rateLimits.mutation.max
});

function parsePositiveInt(value) {
  const num = Number(value);
  return Number.isInteger(num) && num > 0 ? num : null;
}

function parseDecisionType(value) {
  if (!value) return null;
  const type = String(value).trim().toUpperCase();
  return decisionAuditService.DECISION_TYPES.includes(type) ? type : null;
}

function validateType(req, res, next) {
  const { decisionType } = req.query;
  if (decisionType) {
    const type = parseDecisionType(decisionType);
    if (!type) {
      return res.status(400).json({ error: "Invalid decision type" });
    }
    req.auditDecisionType = type;
  }
  next();
}

router.get("/", validateType, async (req, res) => {
  try {
    const page = parsePositiveInt(req.query.page) || 1;
    const limit = parsePositiveInt(req.query.limit) || decisionAuditService.DEFAULT_PAGE_SIZE;
    const drainId = req.query.drainId ? parsePositiveInt(req.query.drainId) : null;
    const robotId = req.query.robotId ? parsePositiveInt(req.query.robotId) : null;

    if ((req.query.drainId && drainId === null) || (req.query.robotId && robotId === null)) {
      return res.status(400).json({ error: "Invalid drainId or robotId" });
    }

    const audits = await decisionAuditService.getAudits({
      decisionType: req.auditDecisionType || null,
      drainId,
      robotId,
      limit,
      offset: (page - 1) * Math.min(limit, decisionAuditService.MAX_PAGE_SIZE)
    });

    res.json({
      status: "READY",
      page,
      limit: Math.min(limit, decisionAuditService.MAX_PAGE_SIZE),
      count: audits.length,
      audits
    });
  } catch (err) {
    console.log("⚠️ Decision audit list failed:", err.message);
    res.status(500).json({ error: "Decision audit query failed" });
  }
});

router.get("/summary", async (req, res) => {
  try {
    const summary = await decisionAuditService.getAuditSummary();
    res.json({ status: "READY", summary });
  } catch (err) {
    console.log("⚠️ Decision audit summary failed:", err.message);
    res.status(500).json({ error: "Decision audit summary failed" });
  }
});

router.get("/recent", async (req, res) => {
  try {
    const limit = parsePositiveInt(req.query.limit) || 10;
    const audits = await decisionAuditService.getRecentAudits(
      Math.min(limit, decisionAuditService.MAX_PAGE_SIZE)
    );
    res.json({ status: "READY", limit: audits.length, audits });
  } catch (err) {
    console.log("⚠️ Decision audit recent failed:", err.message);
    res.status(500).json({ error: "Decision audit recent query failed" });
  }
});

router.get("/drain/:drainId", async (req, res) => {
  try {
    const drainId = parsePositiveInt(req.params.drainId);
    if (drainId === null) {
      return res.status(400).json({ error: "Invalid drain id" });
    }
    const audits = await decisionAuditService.getAudits({
      drainId,
      limit: decisionAuditService.MAX_PAGE_SIZE,
      offset: 0
    });
    res.json({ status: "READY", drainId, count: audits.length, audits });
  } catch (err) {
    console.log("⚠️ Decision audit drain query failed:", err.message);
    res.status(500).json({ error: "Decision audit drain query failed" });
  }
});

router.get("/robot/:robotId", async (req, res) => {
  try {
    const robotId = parsePositiveInt(req.params.robotId);
    if (robotId === null) {
      return res.status(400).json({ error: "Invalid robot id" });
    }
    const audits = await decisionAuditService.getAudits({
      robotId,
      limit: decisionAuditService.MAX_PAGE_SIZE,
      offset: 0
    });
    res.json({ status: "READY", robotId, count: audits.length, audits });
  } catch (err) {
    console.log("⚠️ Decision audit robot query failed:", err.message);
    res.status(500).json({ error: "Decision audit robot query failed" });
  }
});

router.get("/decision/:decisionId", async (req, res) => {
  try {
    const decisionId = String(req.params.decisionId || "").trim();
    if (!decisionId || decisionId.length > 120) {
      return res.status(400).json({ error: "Invalid decision id" });
    }
    const audit = await decisionAuditService.getAuditByDecisionId(decisionId);
    if (!audit) {
      return res.status(404).json({ error: "Decision audit not found" });
    }
    res.json({ status: "READY", audit });
  } catch (err) {
    console.log("⚠️ Decision audit lookup failed:", err.message);
    res.status(500).json({ error: "Decision audit lookup failed" });
  }
});

router.get("/type/:decisionType", async (req, res) => {
  try {
    const decisionType = parseDecisionType(req.params.decisionType);
    if (!decisionType) {
      return res.status(400).json({ error: "Invalid decision type" });
    }
    const audits = await decisionAuditService.getAudits({
      decisionType,
      limit: decisionAuditService.MAX_PAGE_SIZE,
      offset: 0
    });
    res.json({ status: "READY", decisionType, count: audits.length, audits });
  } catch (err) {
    console.log("⚠️ Decision audit type query failed:", err.message);
    res.status(500).json({ error: "Decision audit type query failed" });
  }
});

router.get("/:id/explanation", async (req, res) => {
  try {
    const id = parsePositiveInt(req.params.id);
    if (id === null) {
      return res.status(400).json({ error: "Invalid audit id" });
    }
    const explanation = await decisionAuditService.getExplanation(id);
    if (!explanation) {
      return res.status(404).json({ error: "Decision audit not found" });
    }
    res.json({ status: "READY", explanation });
  } catch (err) {
    console.log("⚠️ Decision audit explanation failed:", err.message);
    res.status(500).json({ error: "Decision audit explanation failed" });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const id = parsePositiveInt(req.params.id);
    if (id === null) {
      return res.status(400).json({ error: "Invalid audit id" });
    }
    const audit = await decisionAuditService.getAuditById(id);
    if (!audit) {
      return res.status(404).json({ error: "Decision audit not found" });
    }
    res.json({ status: "READY", audit });
  } catch (err) {
    console.log("⚠️ Decision audit lookup failed:", err.message);
    res.status(500).json({ error: "Decision audit lookup failed" });
  }
});

// ------------------------------------------------------------
// On-demand snapshot (auth-protected, meaningful-change policy
// still applies - repeated identical snapshots do not spam).
// ------------------------------------------------------------

router.post("/snapshot", authMiddleware, snapshotLimiter, async (req, res) => {
  try {
    const { decisionType, drainId, robotId, incidentId, signal } = req.body || {};

    const type = parseDecisionType(decisionType);
    if (!type) {
      return res.status(400).json({ error: "Invalid decision type" });
    }

    const drain = drainId ? parsePositiveInt(drainId) : null;
    const robot = robotId ? parsePositiveInt(robotId) : null;
    const incident = incidentId ? parsePositiveInt(incidentId) : null;

    if ((drainId && drain === null) || (robotId && robot === null) || (incidentId && incident === null)) {
      return res.status(400).json({ error: "Invalid drainId, robotId or incidentId" });
    }

    const requiresDrain = [
      "AI_DECISION",
      "FLOOD_RISK",
      "FORECAST",
      "MAINTENANCE",
      "SENSOR_INTELLIGENCE",
      "ROBOT_ROUTE"
    ];

    if (requiresDrain.includes(type) && !drain) {
      return res.status(400).json({ error: `${type} requires a valid drainId` });
    }

    if (type === "INCIDENT" && !incident) {
      return res.status(400).json({ error: "INCIDENT requires a valid incidentId" });
    }

    const snapshot = await decisionAuditService.buildSnapshotForType(type, {
      drainId: drain,
      robotId: robot,
      incidentId: incident,
      signal: signal ? String(signal) : null
    });

    if (!snapshot) {
      return res.status(422).json({
        error:
          "No snapshot could be built from the current system state - the existing engine returned no data for this scope."
      });
    }

    const result = await decisionAuditService.storeAudit(snapshot);
    res.status(result.recorded ? 201 : 200).json({
      status: "READY",
      recorded: result.recorded,
      reason: result.reason,
      audit: result.snapshot
    });
  } catch (err) {
    console.log("⚠️ Decision audit snapshot failed:", err.message);
    res.status(500).json({ error: "Decision audit snapshot failed" });
  }
});

module.exports = router;