// ============================================================
// operatorAuditService.js
//
// Update #27 (Operator Action Audit Trail).
//
// This service records HUMAN operator actions performed through
// the protected mutation endpoints. Records are written by the
// NON-FATAL auditMutation middleware: an audit failure must never
// fail the business action that triggered it.
//
// Storage is an append-only `operator_audits` table (UPDATE/DELETE
// blocked by trigger). Reads are bounded and parameterized.
// Nothing sensitive is ever stored: request/response payloads are
// recursively redacted so credentials/tokens never reach the DB.
// ============================================================

const pool = require("../config/db");

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

const ACTIONS = [
  "DRAIN_CREATE",
  "DRAIN_UPDATE",
  "DRAIN_UPDATE_STATUS",
  "DRAIN_DELETE",
  "ALERT_CREATE",
  "ALERT_UPDATE",
  "MISSION_DISPATCH",
  "INCIDENT_CREATE",
  "INCIDENT_ACKNOWLEDGE",
  "INCIDENT_RESPOND",
  "INCIDENT_RESOLVE",
  "SETTINGS_UPDATE",
  "MISSION_COORDINATION_PLAN",
  "USER_CREATE",
  "USER_UPDATE",
  "USER_UPDATE_ROLE",
  "USER_UPDATE_STATUS",
  "USER_DELETE",
  "PASSWORD_CHANGE"
];

const ENTITY_TYPES = ["DRAIN", "ALERT", "MISSION", "INCIDENT", "SETTINGS", "USER", "SYSTEM"];

// Substring parts (case-insensitive, punctuation-stripped). A key like
// "password_hash", "access_token" or "authorization" matches and is
// redacted before anything is persisted.
const SENSITIVE_PARTS = [
  "password",
  "passwd",
  "token",
  "authorization",
  "apikey",
  "secret",
  "credential",
  "jwt",
  "cookie"
];

const MAX_JSON_DEPTH = 6;
const MAX_JSON_BYTES = 80000;

const RETURN_COLUMNS = [
  "id",
  "request_id",
  "user_id",
  "user_email",
  "action",
  "entity_type",
  "entity_id",
  "method",
  "route",
  "status",
  "before_data",
  "after_data",
  "meta_data",
  "created_at"
];

// ------------------------------------------------------------
// Redaction helpers (exported for tests + the client-safe API)
// ------------------------------------------------------------

function isSensitiveKey(key) {
  const normalized = String(key).toLowerCase().replace(/[^a-z0-9]/g, "");
  return SENSITIVE_PARTS.some((part) => normalized.includes(part));
}

function maskJson(value, depth = 0, seen = null) {
  if (value === null || value === undefined) return value;
  if (typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    return depth > MAX_JSON_DEPTH ? "[TRUNCATED]" : value;
  }
  if (depth > MAX_JSON_DEPTH) return "[TRUNCATED]";
  if (typeof value === "object") {
    if (seen === null) seen = new WeakSet();
    if (seen.has(value)) return "[CIRCULAR]";
    seen.add(value);
    try {
      if (typeof value.toISOString === "function") return value.toISOString();
      if (Buffer.isBuffer(value)) return "[BINARY]";
      if (Array.isArray(value)) {
        return value.map((item) => maskJson(item, depth + 1, seen));
      }
      const out = {};
      for (const [key, item] of Object.entries(value)) {
        out[key] = isSensitiveKey(key) ? "[REDACTED]" : maskJson(item, depth + 1, seen);
      }
      return out;
    } finally {
      seen.delete(value);
    }
  }
  return String(value);
}

function redactPayload(value) {
  return maskJson(value);
}

function sizeCapped(value) {
  if (value === null || value === undefined) return value;
  const json = JSON.stringify(value);
  if (json && json.length > MAX_JSON_BYTES) {
    return {
      truncated: true,
      note: `payload exceeds ${MAX_JSON_BYTES} bytes and is not stored`
    };
  }
  return value;
}

// ------------------------------------------------------------
// Small deterministic helpers
// ------------------------------------------------------------

function clamp(value, min, max) {
  return Math.min(Math.max(Number(value), min), max);
}

function toISO(value) {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function rowToAudit(row) {
  return {
    id: Number(row.id),
    requestId: row.request_id || null,
    userId: row.user_id === null || row.user_id === undefined ? null : Number(row.user_id),
    userEmail: row.user_email || null,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id === null || row.entity_id === undefined ? null : Number(row.entity_id),
    method: row.method || null,
    route: row.route || null,
    status: row.status === null || row.status === undefined ? null : Number(row.status),
    beforeData: row.before_data,
    afterData: row.after_data,
    metaData: row.meta_data,
    createdAt: toISO(row.created_at)
  };
}

// ------------------------------------------------------------
// Write path (best-effort; consumers must never block on it)
// ------------------------------------------------------------

async function recordAudit({
  requestId = null,
  userId = null,
  userEmail = null,
  method = null,
  route = null,
  status = null,
  action,
  entityType = null,
  entityId = null,
  beforeData = null,
  afterData = null,
  metaData = null
} = {}) {
  if (!action || typeof action !== "string") {
    return { recorded: false, reason: "MISSING_ACTION" };
  }

  const toIntOrNull = (value) =>
    value === null || value === undefined || value === ""
      ? null
      : Number.isInteger(Number(value))
        ? Number(value)
        : null;

  const result = await pool.query(
    `
    INSERT INTO operator_audits
      (request_id, user_id, user_email, method, route, status,
       action, entity_type, entity_id, before_data, after_data, meta_data)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    RETURNING id, created_at
    `,
    [
      requestId ? String(requestId).slice(0, 64) : null,
      toIntOrNull(userId),
      userEmail ? String(userEmail).slice(0, 120) : null,
      method ? String(method).slice(0, 10) : null,
      route ? String(route).slice(0, 2048) : null,
      toIntOrNull(status),
      String(action).slice(0, 60),
      entityType ? String(entityType).slice(0, 30) : null,
      toIntOrNull(entityId),
      sizeCapped(redactPayload(beforeData)),
      sizeCapped(redactPayload(afterData)),
      sizeCapped(redactPayload(metaData))
    ]
  );

  return { recorded: true, id: Number(result.rows[0].id) };
}

// ------------------------------------------------------------
// Read path (bounded + parameterized)
// ------------------------------------------------------------

async function getAudits({
  action = null,
  entityType = null,
  entityId = null,
  userId = null,
  limit = DEFAULT_PAGE_SIZE,
  offset = 0
} = {}) {
  const pageSize = clamp(limit, 1, MAX_PAGE_SIZE);
  const skip = Math.max(0, offset);

  const clauses = [];
  const params = [];

  if (action) {
    params.push(action);
    clauses.push(`action = $${params.length}`);
  }
  if (entityType) {
    params.push(entityType);
    clauses.push(`entity_type = $${params.length}`);
  }
  if (entityId !== null && entityId !== undefined) {
    params.push(Number(entityId));
    clauses.push(`entity_id = $${params.length}`);
  }
  if (userId !== null && userId !== undefined) {
    params.push(Number(userId));
    clauses.push(`user_id = $${params.length}`);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";

  const result = await pool.query(
    `
    SELECT ${RETURN_COLUMNS.join(", ")}
    FROM operator_audits
    ${where}
    ORDER BY created_at DESC, id DESC
    LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `,
    [...params, pageSize, skip]
  );

  return result.rows.map(rowToAudit);
}

async function getAuditById(id) {
  const result = await pool.query(
    `
    SELECT ${RETURN_COLUMNS.join(", ")}
    FROM operator_audits
    WHERE id = $1
    LIMIT 1
    `,
    [Number(id)]
  );
  return result.rows.length > 0 ? rowToAudit(result.rows[0]) : null;
}

async function getRecentAudits(limit = 10) {
  return getAudits({ limit: clamp(limit, 1, MAX_PAGE_SIZE), offset: 0 });
}

async function getAuditSummary() {
  const [totalResult, byActionResult, byEntityResult, byOperatorResult, spanResult] =
    await Promise.all([
      pool.query("SELECT COUNT(*)::int AS total FROM operator_audits"),
      pool.query(
        "SELECT action, COUNT(*)::int AS count FROM operator_audits GROUP BY action ORDER BY count DESC"
      ),
      pool.query(
        "SELECT entity_type, COUNT(*)::int AS count FROM operator_audits WHERE entity_type IS NOT NULL GROUP BY entity_type ORDER BY count DESC"
      ),
      pool.query(
        "SELECT user_email, COUNT(*)::int AS count FROM operator_audits WHERE user_email IS NOT NULL GROUP BY user_email ORDER BY count DESC LIMIT 10"
      ),
      pool.query(
        "SELECT MIN(created_at) AS oldest, MAX(created_at) AS newest FROM operator_audits"
      )
    ]);

  const byAction = {};
  byActionResult.rows.forEach((row) => {
    byAction[row.action] = Number(row.count);
  });

  const byEntityType = {};
  byEntityResult.rows.forEach((row) => {
    byEntityType[row.entity_type] = Number(row.count);
  });

  const byOperator = {};
  byOperatorResult.rows.forEach((row) => {
    byOperator[row.user_email] = Number(row.count);
  });

  const total = Number(totalResult.rows[0].total);

  return {
    total,
    byAction,
    byEntityType,
    byOperator,
    oldest: spanResult.rows[0].oldest ? toISO(spanResult.rows[0].oldest) : null,
    newest: spanResult.rows[0].newest ? toISO(spanResult.rows[0].newest) : null,
    generatedAt: toISO(new Date())
  };
}

module.exports = {
  ACTIONS,
  ENTITY_TYPES,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  recordAudit,
  getAudits,
  getAuditById,
  getRecentAudits,
  getAuditSummary,
  isSensitiveKey,
  redactPayload,
  maskJson
};