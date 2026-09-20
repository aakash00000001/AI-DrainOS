// ============================================================
// AI-DrainOS Incident API - /api/incidents
//
// Autonomous Emergency Response & Incident Intelligence.
// Read endpoints are public (consistent with drains/analytics);
// mutations (POST / PUT lifecycle) require an authenticated user.
//
// Lifecycle: OPEN -> ACKNOWLEDGED -> RESPONDING -> RESOLVED
// ============================================================

const express = require("express");
const router = express.Router();

const config = require("../config/env");
const incidentService = require("../services/incidentService");
const decisionEngine = require("../services/decisionEngine");
const { authMiddleware } = require("../middleware/auth");
const { createRateLimiter } = require("../middleware/rateLimiter");
const { positiveIntParam, positiveIntQuery, enumQuery } = require("../middleware/validate");
const { auditMutation } = require("../middleware/auditMutation");

const VALID_STATUSES = ["OPEN", "ACKNOWLEDGED", "RESPONDING", "RESOLVED"];
const VALID_SEVERITIES = ["LOW", "MODERATE", "HIGH", "CRITICAL"];

async function loadIncidentForAudit(req) {
  const result = await pool.query(
    `
    SELECT id, drain_id, severity, title, source, status, assigned_robot_id
    FROM incidents
    WHERE id = $1
    `,
    [req.params.id]
  );
  return result.rows[0] || null;
}

const mutationLimiter = createRateLimiter({
  name: "incidentsMutationLimiter",
  windowMs: config.rateLimits.mutation.windowMs,
  max: config.rateLimits.mutation.max
});

// --------------------------------------------------
// GET /api/incidents - list with optional filters
//   ?status=OPEN|ACKNOWLEDGED|RESPONDING|RESOLVED
//   ?severity=LOW|MODERATE|HIGH|CRITICAL
//   ?drain_id=<n>
// --------------------------------------------------

router.get(
  "/",
  positiveIntQuery("drain_id"),
  enumQuery("status", VALID_STATUSES, "status"),
  enumQuery("severity", VALID_SEVERITIES, "severity"),
  async (req, res) => {
  try {
    const incidents = await incidentService.listIncidents({
      status: req.query.status,
      severity: req.query.severity,
      drainId: req.query.drain_id
    });

    res.json(incidents);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server Error" });
  }
});

// --------------------------------------------------
// GET /api/incidents/active - OPEN / ACKNOWLEDGED / RESPONDING
// --------------------------------------------------

router.get("/active", async (req, res) => {
  try {
    const incidents = await incidentService.listActive();
    res.json(incidents);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server Error" });
  }
});

// --------------------------------------------------
// GET /api/incidents/:id/timeline - real stored-timestamp events
// --------------------------------------------------

router.get("/:id/timeline", positiveIntParam("id"), async (req, res) => {
  try {
    const incident = await incidentService.getIncidentById(req.params.id);

    if (!incident) {
      return res.status(404).json({ error: "Incident not found" });
    }

    res.json(incidentService.getTimeline(incident));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server Error" });
  }
});

// --------------------------------------------------
// GET /api/incidents/:id - detail (drain + robot + route)
// --------------------------------------------------

router.get("/:id", positiveIntParam("id"), async (req, res) => {
  try {
    const incident = await incidentService.getIncidentById(req.params.id);

    if (!incident) {
      return res.status(404).json({ error: "Incident not found" });
    }

    res.json(incident);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server Error" });
  }
});

// --------------------------------------------------
// POST /api/incidents - create incident (auth required)
//
// AI_DECISION source: reuses the existing AI Decision Engine. The
// incident is created ONLY when the engine's real decision is
// CRITICAL (score/level come from the engine, never fabricated).
// Emergency incidents are auto-assigned via the existing Robot Path
// Planning engine; MANUAL incidents accept an optional
// assigned_robot_id.
// --------------------------------------------------

router.post("/", authMiddleware, mutationLimiter, auditMutation({
  action: "INCIDENT_CREATE",
  entityType: "INCIDENT",
  entityId: (req, body) => (body && body.id !== undefined ? body.id : null),
  before: async (req) => {
    const { drain_id, title, source, severity, assigned_robot_id } = req.body || {};
    return { drain_id, title, source, severity, assigned_robot_id };
  }
}), async (req, res) => {
  try {
    const { drain_id, title, description, source = "MANUAL", severity, assigned_robot_id, decision_score, decision_level } = req.body;

    if (source !== "AI_DECISION" && source !== "MANUAL") {
      return res.status(400).json({ error: "source must be AI_DECISION or MANUAL" });
    }

    let result;

    if (source === "AI_DECISION") {
      if (!Number.isInteger(Number(drain_id)) || Number(drain_id) <= 0) {
        return res.status(400).json({ error: "drain_id must be a positive integer" });
      }

      const decision = await decisionEngine.getDrainDecision(Number(drain_id));
      result = await incidentService.createIncidentFromDecision({
        drainId: Number(drain_id),
        decision
      });
    } else {
      result = await incidentService.createIncident({
        drainId: drain_id,
        title,
        description,
        source,
        severity: severity || "HIGH",
        decisionScore: decision_score,
        decisionLevel: decision_level,
        assignedRobotId: assigned_robot_id
      });
    }

    if (!result.ok) {
      const conflictCodes = [
        "DUPLICATE_ACTIVE_INCIDENT",
        "NOT_CRITICAL",
        "NO_VALID_DECISION",
        "DECISION_DATA_MISSING"
      ];

      if (["DRAIN_NOT_FOUND", "ROBOT_NOT_FOUND", "INCIDENT_NOT_FOUND"].includes(result.code)) {
        return res.status(404).json({ code: result.code, error: result.message });
      }

      const code = conflictCodes.includes(result.code) ? 409 : 400;
      return res.status(code).json({
        code: result.code,
        error: result.message,
        ...(result.incident ? { incident: result.incident } : {})
      });
    }

    res.status(201).json(result.incident);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server Error" });
  }
});

// --------------------------------------------------
// PUT /api/incidents/:id/acknowledge (auth required)
// OPEN -> ACKNOWLEDGED
// --------------------------------------------------

router.put("/:id/acknowledge", positiveIntParam("id"), authMiddleware, mutationLimiter, auditMutation({
  action: "INCIDENT_ACKNOWLEDGE",
  entityType: "INCIDENT",
  entityId: (req) => req.params.id,
  before: loadIncidentForAudit
}), async (req, res) => {
  await transitionResponse(res, incidentService.acknowledgeIncident(req.params.id));
});

// --------------------------------------------------
// PUT /api/incidents/:id/respond (auth required)
// OPEN|ACKNOWLEDGED -> RESPONDING
// --------------------------------------------------

router.put("/:id/respond", positiveIntParam("id"), authMiddleware, mutationLimiter, auditMutation({
  action: "INCIDENT_RESPOND",
  entityType: "INCIDENT",
  entityId: (req) => req.params.id,
  before: loadIncidentForAudit
}), async (req, res) => {
  await transitionResponse(res, incidentService.startResponse(req.params.id));
});

// --------------------------------------------------
// PUT /api/incidents/:id/resolve (auth required)
// OPEN|ACKNOWLEDGED|RESPONDING -> RESOLVED
// Body: { resolution_notes?: string }
// --------------------------------------------------

router.put("/:id/resolve", positiveIntParam("id"), authMiddleware, mutationLimiter, auditMutation({
  action: "INCIDENT_RESOLVE",
  entityType: "INCIDENT",
  entityId: (req) => req.params.id,
  before: loadIncidentForAudit,
  meta: async (req) => ({
    resolution_notes: (req.body && req.body.resolution_notes) || null
  })
}), async (req, res) => {
  await transitionResponse(
    res,
    incidentService.resolveIncident(req.params.id, req.body && req.body.resolution_notes)
  );
});

async function transitionResponse(res, promise) {
  try {
    const result = await promise;

    if (!result.ok) {
      if (result.code === "INCIDENT_NOT_FOUND" || result.code === "INVALID_ID") {
        return res.status(404).json({ code: result.code, error: result.message });
      }

      const conflictCodes = ["INVALID_TRANSITION", "ALREADY_RESOLVED", "INCIDENT_ALREADY_RESOLVED"];
      const code = conflictCodes.includes(result.code) ? 409 : 400;
      return res.status(code).json({
        code: result.code,
        error: result.message,
        ...(result.incident ? { incident: result.incident } : {})
      });
    }

    res.json(result.incident);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server Error" });
  }
}

module.exports = router;