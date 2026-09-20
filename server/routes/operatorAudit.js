// ============================================================
// operatorAudit.js
//
// Update #27 (Operator Action Audit Trail - admin-only REST).
//
// The trail is written by the NON-FATAL auditMutation middleware
// used on the protected mutation routes. This API is strictly
// read-only and ADMIN-ONLY: an Operator role receives 403.
//
// Every GET is a bounded, parameterized read into the append-only
// operator_audits table. No secrets are returned - the stored
// payloads are already redacted before persistence.
// ============================================================

const express = require("express");
const router = express.Router();

const operatorAuditService = require("../services/operatorAuditService");
const { authMiddleware, adminOnly } = require("../middleware/auth");

function parsePositiveInt(value) {
  const num = Number(value);
  return Number.isInteger(num) && num > 0 ? num : null;
}

function parseOptionalPositiveInt(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = parsePositiveInt(value);
  return parsed === null && value !== undefined ? false : parsed;
}

function parseAction(value) {
  if (!value) return null;
  const action = String(value).trim().toUpperCase();
  return operatorAuditService.ACTIONS.includes(action) ? action : null;
}

function parseEntityType(value) {
  if (!value) return null;
  const type = String(value).trim().toUpperCase();
  return operatorAuditService.ENTITY_TYPES.includes(type) ? type : null;
}

function validateFilters(req, res, next) {
  const { action, entityType } = req.query;

  if (action) {
    const parsed = parseAction(action);
    if (!parsed) {
      return res.status(400).json({ error: "Invalid action" });
    }
    req.auditAction = parsed;
  }

  if (entityType) {
    const parsed = parseEntityType(entityType);
    if (!parsed) {
      return res.status(400).json({ error: "Invalid entityType" });
    }
    req.auditEntityType = parsed;
  }

  next();
}

router.get("/", authMiddleware, adminOnly, validateFilters, async (req, res) => {
  try {
    const page = parsePositiveInt(req.query.page) || 1;
    const limit = parsePositiveInt(req.query.limit) || operatorAuditService.DEFAULT_PAGE_SIZE;

    const entityIdRaw = req.query.entityId;
    const userIdRaw = req.query.userId;

    const entityId =
      entityIdRaw === undefined || entityIdRaw === ""
        ? null
        : parseOptionalPositiveInt(entityIdRaw);
    const userId =
      userIdRaw === undefined || userIdRaw === ""
        ? null
        : parseOptionalPositiveInt(userIdRaw);

    if (entityId === false || userId === false) {
      return res.status(400).json({ error: "Invalid entityId or userId" });
    }

    const audits = await operatorAuditService.getAudits({
      action: req.auditAction || null,
      entityType: req.auditEntityType || null,
      entityId,
      userId,
      limit,
      offset: (page - 1) * Math.min(limit, operatorAuditService.MAX_PAGE_SIZE)
    });

    res.json({
      status: "READY",
      page,
      limit: Math.min(limit, operatorAuditService.MAX_PAGE_SIZE),
      count: audits.length,
      audits
    });
  } catch (err) {
    console.log("Operator audit list failed:", err.message);
    res.status(500).json({ error: "Operator audit query failed" });
  }
});

router.get("/summary", authMiddleware, adminOnly, async (req, res) => {
  try {
    const summary = await operatorAuditService.getAuditSummary();
    res.json({ status: "READY", summary });
  } catch (err) {
    console.log("Operator audit summary failed:", err.message);
    res.status(500).json({ error: "Operator audit summary failed" });
  }
});

router.get("/actions", authMiddleware, adminOnly, async (req, res) => {
  res.json({ status: "READY", actions: operatorAuditService.ACTIONS });
});

router.get("/:id", authMiddleware, adminOnly, async (req, res) => {
  try {
    const id = parsePositiveInt(req.params.id);
    if (id === null) {
      return res.status(400).json({ error: "Invalid audit id" });
    }
    const audit = await operatorAuditService.getAuditById(id);
    if (!audit) {
      return res.status(404).json({ error: "Operator audit not found" });
    }
    res.json({ status: "READY", audit });
  } catch (err) {
    console.log("Operator audit lookup failed:", err.message);
    res.status(500).json({ error: "Operator audit lookup failed" });
  }
});

module.exports = router;