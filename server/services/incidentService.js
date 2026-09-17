// ============================================================
// AI-DrainOS Incident Service — Autonomous Emergency Response
// & Incident Intelligence layer.
//
// Converts critical AI decisions into trackable incidents with a
// complete, timestamped response lifecycle:
//
//   OPEN -> ACKNOWLEDGED -> RESPONDING -> RESOLVED
//
// Design rules:
//  * REUSES the existing Robot Path Planning engine (planRoute) for
//    robot selection + route building — never duplicates the
//    selection algorithm.
//  * Does NOT touch missionEngine.js. Incident assignment is a
//    planning/response action, not a mission dispatch.
//  * Never fabricates data: decision scores come from the existing
//    AI Decision Engine, timestamps come from PostgreSQL, response
//    averages are null until enough real data exists.
//  * At most ONE active incident (OPEN/ACKNOWLEDGED/RESPONDING)
//    per drain — enforced both here and by a partial unique index.
//  * Live incidentUpdate Socket.IO events use the shared socketHub
//    (single Socket.IO server).
// ============================================================

const pool = require("../config/db");
const socketHub = require("./socketHub");
const robotPathPlanning = require("./robotPathPlanningService");

const ACTIVE_STATUSES = ["OPEN", "ACKNOWLEDGED", "RESPONDING"];
const VALID_STATUSES = ["OPEN", "ACKNOWLEDGED", "RESPONDING", "RESOLVED"];
const VALID_SEVERITIES = ["LOW", "MODERATE", "HIGH", "CRITICAL"];
const VALID_SOURCES = [
  "AI_DECISION",
  "FLOOD_RISK",
  "FORECAST",
  "MAINTENANCE",
  "VISION",
  "MANUAL"
];

// route_status is an honest snapshot of the path-planning outcome.
const ROUTE_STATUS_MANUAL = "MANUAL";
const ROUTE_STATUS_PLANNED = "PLANNED";
const ROUTE_STATUS_NO_ROBOT_AVAILABLE = "NO_ROBOT_AVAILABLE";
const ROUTE_STATUS_NO_COORDINATES = "NO_COORDINATES";

function nowIso() {
  return new Date().toISOString();
}

function asIso(value) {
  return value ? new Date(value).toISOString() : null;
}

// ------------------------------------------------------------
// Row shaping (real DB data only)
// ------------------------------------------------------------

function normalizeIncident(row) {
  if (!row) return null;

  return {
    id: Number(row.id),
    drain_id: Number(row.drain_id),
    severity: row.severity,
    title: row.title,
    description: row.description,
    source: row.source,
    decision_score:
      row.decision_score === null || row.decision_score === undefined
        ? null
        : Number(row.decision_score),
    decision_level: row.decision_level,
    assigned_robot_id:
      row.assigned_robot_id === null ? null : Number(row.assigned_robot_id),
    route_status: row.route_status,
    route: row.route,
    status: row.status,
    created_at: asIso(row.created_at),
    acknowledged_at: asIso(row.acknowledged_at),
    responding_at: asIso(row.responding_at),
    resolved_at: asIso(row.resolved_at),
    assigned_at: asIso(row.assigned_at),
    route_status_changed_at: asIso(row.route_status_changed_at),
    resolution_notes: row.resolution_notes,
    drain: row.drain ? { ...row.drain } : null,
    robot: row.robot ? { ...row.robot } : null
  };
}

// Base query joins the incident with its drain and assigned robot so
// list/detail responses include context without extra round-trips.
const INCIDENT_SELECT = `
  SELECT
    i.*,
    d.zone_name,
    d.location AS drain_location,
    d.status AS drain_status,
    d.latitude AS drain_latitude,
    d.longitude AS drain_longitude,
    r.robot_name,
    r.battery_level AS robot_battery_level
  FROM incidents i
  LEFT JOIN drains d ON d.id = i.drain_id
  LEFT JOIN robots r ON r.id = i.assigned_robot_id
`;

function shapeRow(row) {
  if (!row) return null;
  return normalizeIncident({
    ...row,
    drain:
      row.drain_location !== null || row.drain_status !== null
        ? {
            id: Number(row.drain_id),
            zone: row.zone_name,
            location: row.drain_location,
            status: row.drain_status,
            latitude: row.drain_latitude,
            longitude: row.drain_longitude
          }
        : null,
    robot:
      row.robot_name !== null
        ? {
            id: Number(row.assigned_robot_id),
            robotName: row.robot_name,
            batteryLevel: row.robot_battery_level
          }
        : null
  });
}

// ------------------------------------------------------------
// Validation helpers (safety / data integrity)
// ------------------------------------------------------------

function validPositiveInt(value) {
  return Number.isInteger(Number(value)) && Number(value) > 0;
}

// ------------------------------------------------------------
// Queries
// ------------------------------------------------------------

async function getActiveIncidentForDrain(drainId) {
  const result = await pool.query(
    `
    SELECT *
    FROM incidents
    WHERE drain_id = $1
      AND status = ANY($2::varchar[])
    ORDER BY id DESC
    LIMIT 1
    `,
    [drainId, ACTIVE_STATUSES]
  );
  return result.rows.length > 0 ? result.rows[0] : null;
}

async function getIncidentById(id) {
  if (!validPositiveInt(id)) return null;

  const result = await pool.query(
    `${INCIDENT_SELECT} WHERE i.id = $1`,
    [Number(id)]
  );

  return result.rows.length > 0 ? shapeRow(result.rows[0]) : null;
}

async function listIncidents({ status, severity, drainId } = {}) {
  const where = [];
  const params = [];

  if (status && VALID_STATUSES.includes(status)) {
    params.push(status);
    where.push(`i.status = $${params.length}`);
  }

  if (severity && VALID_SEVERITIES.includes(severity)) {
    params.push(severity);
    where.push(`i.severity = $${params.length}`);
  }

  if (drainId && validPositiveInt(drainId)) {
    params.push(Number(drainId));
    where.push(`i.drain_id = $${params.length}`);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

  const result = await pool.query(
    `${INCIDENT_SELECT} ${whereSql} ORDER BY i.created_at DESC, i.id DESC`,
    params
  );

  return result.rows.map(shapeRow);
}

async function listActive() {
  const result = await pool.query(
    `${INCIDENT_SELECT}
     WHERE i.status = ANY($1::varchar[])
     ORDER BY i.created_at DESC, i.id DESC`,
    [ACTIVE_STATUSES]
  );
  return result.rows.map(shapeRow);
}

// ------------------------------------------------------------
// Emission (shared Socket.IO via socketHub)
// ------------------------------------------------------------

function emitIncidentUpdate(eventType, incident) {
  // eventType: created | assigned | robotUnavailable | acknowledged |
  //            responded | resolved
  socketHub.emit("incidentUpdate", { eventType, incident });
}

// ------------------------------------------------------------
// Robot assignment — REUSES existing Robot Path Planning. For an
// emergency incident we obtain the planned route + selected robot
// and store them. If planning reports NO_ROBOT_AVAILABLE or
// NO_COORDINATES we persist that honest state instead of inventing
// an assignment.
// ------------------------------------------------------------

async function applyRobotAssignment(incidentId, drainId, robotId) {
  if (robotId && validPositiveInt(robotId)) {
    const robotCheck = await pool.query("SELECT id FROM robots WHERE id = $1", [Number(robotId)]);

    if (robotCheck.rows.length === 0) {
      return { ok: false, code: "ROBOT_NOT_FOUND", message: "Assigned robot does not exist" };
    }

    await pool.query(
      `
      UPDATE incidents
      SET assigned_robot_id = $1, route_status = $2, assigned_at = CURRENT_TIMESTAMP,
          route_status_changed_at = CURRENT_TIMESTAMP
      WHERE id = $3
      `,
      [Number(robotId), ROUTE_STATUS_MANUAL, incidentId]
    );

    const incident = await getIncidentById(incidentId);
    emitIncidentUpdate("assigned", incident);
    return { ok: true, incident, routeStatus: ROUTE_STATUS_MANUAL };
  }

  // Automatic emergency assignment: reuse the path-planning engine.
  // First check the drain really has coordinates — the planner's
  // finiteNumber() coerces NULL to 0, so a missing coordinate is
  // detected here honestly before any planning runs.
  const drainCoords = await pool.query(
    "SELECT latitude, longitude FROM drains WHERE id = $1",
    [Number(drainId)]
  );

  const coordsOk =
    drainCoords.rows.length > 0 &&
    drainCoords.rows[0].latitude !== null &&
    drainCoords.rows[0].longitude !== null;

  if (!coordsOk) {
    await pool.query(
      `
      UPDATE incidents
      SET route_status = $1, route_status_changed_at = CURRENT_TIMESTAMP
      WHERE id = $2
      `,
      [ROUTE_STATUS_NO_COORDINATES, incidentId]
    );

    const noCoordsIncident = await getIncidentById(incidentId);
    emitIncidentUpdate("robotUnavailable", noCoordsIncident);
    return { ok: true, incident: noCoordsIncident, routeStatus: ROUTE_STATUS_NO_COORDINATES };
  }

  let planning;
  try {
    planning = await robotPathPlanning.planRoute(drainId);
  } catch (planningErr) {
    console.log("⚠️ Incident robot planning failed:", planningErr.message);
    return { ok: true, incident: await getIncidentById(incidentId), planningError: true };
  }

  let routeStatus = null;
  let eventType = "assigned";

  if (planning.status === "ROBOT_SELECTED" && planning.robot && planning.route) {
    routeStatus = ROUTE_STATUS_PLANNED;
    await pool.query(
      `
      UPDATE incidents
      SET assigned_robot_id = $1, route_status = $2, route = $3,
          assigned_at = CURRENT_TIMESTAMP, route_status_changed_at = CURRENT_TIMESTAMP
      WHERE id = $4
      `,
      [Number(planning.robot.id), routeStatus, JSON.stringify(planning.route), incidentId]
    );
  } else if (planning.status === "NO_ROBOT_AVAILABLE") {
    routeStatus = ROUTE_STATUS_NO_ROBOT_AVAILABLE;
    eventType = "robotUnavailable";
    await pool.query(
      `
      UPDATE incidents
      SET route_status = $1, route_status_changed_at = CURRENT_TIMESTAMP
      WHERE id = $2
      `,
      [routeStatus, incidentId]
    );
  } else if (planning.status === "NO_COORDINATES") {
    routeStatus = ROUTE_STATUS_NO_COORDINATES;
    eventType = "robotUnavailable";
    await pool.query(
      `
      UPDATE incidents
      SET route_status = $1, route_status_changed_at = CURRENT_TIMESTAMP
      WHERE id = $2
      `,
      [routeStatus, incidentId]
    );
  } else {
    // e.g. DRAIN_NOT_FOUND — leave route_status null (honest).
    return { ok: true, incident: await getIncidentById(incidentId) };
  }

  const incident = await getIncidentById(incidentId);
  emitIncidentUpdate(eventType, incident);
  return { ok: true, incident, routeStatus };
}

// ------------------------------------------------------------
// Incident creation
// ------------------------------------------------------------

async function createIncident({
  drainId,
  title,
  description,
  source = "MANUAL",
  severity = "HIGH",
  decisionScore = null,
  decisionLevel = null,
  assignedRobotId = null
}) {
  if (!validPositiveInt(drainId)) {
    return { ok: false, code: "INVALID_DRAIN_ID", message: "drain_id must be a positive integer" };
  }

  if (!VALID_SOURCES.includes(source)) {
    return { ok: false, code: "INVALID_SOURCE", message: `source must be one of: ${VALID_SOURCES.join(", ")}` };
  }

  if (!VALID_SEVERITIES.includes(severity)) {
    return { ok: false, code: "INVALID_SEVERITY", message: `severity must be one of: ${VALID_SEVERITIES.join(", ")}` };
  }

  const drainResult = await pool.query(
    "SELECT id, zone_name, location FROM drains WHERE id = $1",
    [Number(drainId)]
  );

  if (drainResult.rows.length === 0) {
    return { ok: false, code: "DRAIN_NOT_FOUND", message: "Drain not found" };
  }

  if (source === "AI_DECISION" && (decisionScore === null || decisionScore === undefined)) {
    return {
      ok: false,
      code: "DECISION_DATA_MISSING",
      message: "An AI_DECISION incident requires real decision_score/decision_level from the Decision Engine"
    };
  }

  // Validate a manually supplied robot BEFORE inserting so a bad
  // assignment never leaves a stray incident behind.
  if (assignedRobotId) {
    if (!validPositiveInt(assignedRobotId)) {
      return { ok: false, code: "INVALID_ROBOT_ID", message: "assigned_robot_id must be a positive integer" };
    }

    const robotCheck = await pool.query("SELECT id FROM robots WHERE id = $1", [Number(assignedRobotId)]);
    if (robotCheck.rows.length === 0) {
      return { ok: false, code: "ROBOT_NOT_FOUND", message: "Assigned robot does not exist" };
    }
  }

  // Duplicate prevention: one active incident per drain.
  const existing = await getActiveIncidentForDrain(Number(drainId));
  if (existing) {
    return {
      ok: false,
      code: "DUPLICATE_ACTIVE_INCIDENT",
      message: `Drain ${drainId} already has an active incident`,
      incident: await getIncidentById(existing.id)
    };
  }

  const insertResult = await pool.query(
    `
    INSERT INTO incidents (
      drain_id, severity, title, description, source,
      decision_score, decision_level, status
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, 'OPEN')
    RETURNING *
    `,
    [
      Number(drainId),
      severity,
      title || null,
      description || null,
      source,
      decisionScore === null || decisionScore === undefined ? null : Number(decisionScore),
      decisionLevel || null
    ]
  );

  const created = await getIncidentById(insertResult.rows[0].id);
  emitIncidentUpdate("created", created);

  // Emergency incidents are auto-assigned by the existing planner;
  // MANUAL incidents only carry a robot when one was supplied.
  const shouldAssign =
    (source !== "MANUAL" || severity === "CRITICAL") &&
    !assignedRobotId;

  if (shouldAssign || assignedRobotId) {
    return applyRobotAssignment(insertResult.rows[0].id, Number(drainId), assignedRobotId || null);
  }

  return { ok: true, incident: created };
}

// ------------------------------------------------------------
// AI Decision Engine integration — create from a REAL decision.
// Only CRITICAL decisions produce incidents; the score/level are the
// engine's real values, never fabricated.
// ------------------------------------------------------------

async function createIncidentFromDecision({ drainId, decision = null }) {
  if (!decision || decision.status !== "READY") {
    return { ok: false, code: "NO_VALID_DECISION", message: "No READY AI decision available for this drain" };
  }

  if (decision.priorityLevel !== "CRITICAL") {
    return {
      ok: false,
      code: "NOT_CRITICAL",
      message: `Decision level is ${decision.priorityLevel}; incidents are created only for CRITICAL decisions`
    };
  }

  const score =
    decision.priorityScore === null || decision.priorityScore === undefined
      ? null
      : Number(decision.priorityScore);

  if (score === null || score < 0 || score > 100) {
    return { ok: false, code: "DECISION_DATA_MISSING", message: "CRITICAL decision is missing a real priority score" };
  }

  const drain = await pool.query(
    "SELECT id, zone_name, location FROM drains WHERE id = $1",
    [Number(drainId)]
  );

  if (drain.rows.length === 0) {
    return { ok: false, code: "DRAIN_NOT_FOUND", message: "Drain not found" };
  }

  const location = drain.rows[0].location || `Drain ${drainId}`;

  return createIncident({
    drainId: Number(drainId),
    title: `CRITICAL AI decision at ${location}`,
    description: decision.recommendedAction
      ? `Recommended action: ${decision.recommendedAction}`
      : "Critical priority evaluated by the AI Decision Engine",
    source: "AI_DECISION",
    severity: "CRITICAL",
    decisionScore: score,
    decisionLevel: "CRITICAL"
  });
}

// ------------------------------------------------------------
// Lifecycle transitions (validated, idempotent where safe)
// ------------------------------------------------------------

async function transition(id, action, updatedAtColumn, nextStatus, fromStatuses, eventType) {
  if (!validPositiveInt(id)) {
    return { ok: false, code: "INVALID_ID", message: "incident id must be a positive integer" };
  }

  const current = await pool.query(
    "SELECT id, status FROM incidents WHERE id = $1",
    [Number(id)]
  );

  if (current.rows.length === 0) {
    return { ok: false, code: "INCIDENT_NOT_FOUND", message: "Incident not found" };
  }

  const currentStatus = current.rows[0].status;

  if (!fromStatuses.includes(currentStatus)) {
    return {
      ok: false,
      code: "INVALID_TRANSITION",
      message: `Cannot ${action} an incident with status ${currentStatus}`
    };
  }

  // Acknowledge / respond are idempotent in their own state: a
  // second call to the same action is a harmless no-op.
  const alreadyThere = currentStatus === nextStatus;
  if (alreadyThere) {
    const incident = await getIncidentById(Number(id));
    return { ok: true, incident, unchanged: true };
  }

  await pool.query(
    `UPDATE incidents SET status = $1, ${updatedAtColumn} = CURRENT_TIMESTAMP WHERE id = $2`,
    [nextStatus, Number(id)]
  );

  const incident = await getIncidentById(Number(id));
  emitIncidentUpdate(eventType, incident);
  return { ok: true, incident };
}

function acknowledgeIncident(id) {
  return transition(id, "acknowledge", "acknowledged_at", "ACKNOWLEDGED", ["OPEN"], "acknowledged");
}

function startResponse(id) {
  return transition(id, "start response for", "responding_at", "RESPONDING", ["OPEN", "ACKNOWLEDGED"], "responded");
}

async function resolveIncident(id, resolutionNotes = null) {
  if (!validPositiveInt(id)) {
    return { ok: false, code: "INVALID_ID", message: "incident id must be a positive integer" };
  }

  const current = await pool.query(
    "SELECT id, status FROM incidents WHERE id = $1",
    [Number(id)]
  );

  if (current.rows.length === 0) {
    return { ok: false, code: "INCIDENT_NOT_FOUND", message: "Incident not found" };
  }

  if (current.rows[0].status === "RESOLVED") {
    return {
      ok: false,
      code: "ALREADY_RESOLVED",
      message: "Incident is already resolved",
      incident: await getIncidentById(Number(id))
    };
  }

  const notes =
    typeof resolutionNotes === "string" && resolutionNotes.trim().length > 0
      ? resolutionNotes.trim()
      : null;

  await pool.query(
    `
    UPDATE incidents
    SET status = 'RESOLVED', resolved_at = CURRENT_TIMESTAMP, resolution_notes = $1
    WHERE id = $2
    `,
    [notes, Number(id)]
  );

  const incident = await getIncidentById(Number(id));
  emitIncidentUpdate("resolved", incident);
  return { ok: true, incident };
}

// ------------------------------------------------------------
// Timeline — derived ONLY from stored timestamps.
// A null timestamp means the event never happened; it is omitted,
// never fabricated.
// ------------------------------------------------------------

function getTimeline(incident) {
  if (!incident) return [];

  const events = [];

  events.push({ event: "incident created", at: incident.created_at });

  if (incident.assigned_at && incident.assigned_robot_id) {
    events.push({
      event: "robot assigned",
      at: incident.assigned_at,
      robot: incident.robot ? incident.robot.robotName : null
    });
  }

  if (incident.route_status_changed_at && incident.route_status) {
    events.push({
      event: "route status",
      at: incident.route_status_changed_at,
      routeStatus: incident.route_status
    });
  }

  if (incident.acknowledged_at) {
    events.push({ event: "acknowledged", at: incident.acknowledged_at });
  }

  if (incident.responding_at) {
    events.push({ event: "response started", at: incident.responding_at });
  }

  if (incident.resolved_at) {
    events.push({
      event: "resolved",
      at: incident.resolved_at,
      notes: incident.resolution_notes
    });
  }

  return events
    .filter((e) => e.at)
    .sort((a, b) => new Date(a.at) - new Date(b.at));
}

// ------------------------------------------------------------
// Dashboard — additive emergency information
// ------------------------------------------------------------

async function getDashboardSummary() {
  const result = await pool.query(
    `
    SELECT
      COUNT(*) FILTER (WHERE status = 'OPEN') AS open,
      COUNT(*) FILTER (WHERE status = 'ACKNOWLEDGED') AS acknowledged,
      COUNT(*) FILTER (WHERE status = 'RESPONDING') AS responding,
      COUNT(*) FILTER (WHERE status = 'RESOLVED') AS resolved,
      COUNT(*) FILTER (WHERE status = ANY($1::varchar[])) AS active,
      COUNT(*) FILTER (WHERE severity = 'CRITICAL') AS critical
    FROM incidents
    `,
    [ACTIVE_STATUSES]
  );

  const row = result.rows[0];
  const counts = {
    open: Number(row.open),
    acknowledged: Number(row.acknowledged),
    responding: Number(row.responding),
    resolved: Number(row.resolved),
    active: Number(row.active),
    critical: Number(row.critical),
    total: Number(row.open) + Number(row.acknowledged) + Number(row.responding) + Number(row.resolved)
  };

  const latestActive = (await listActive()).slice(0, 5);

  return { counts, latest: latestActive };
}

// ------------------------------------------------------------
// Analytics — counts + real averages (null when not enough data)
// ------------------------------------------------------------

async function getAnalytics() {
  const [severityResult, statusResult, sourceResult, timingResult] = await Promise.all([
    pool.query(
      `SELECT severity, COUNT(*)::int AS count FROM incidents GROUP BY severity`
    ),
    pool.query(
      `SELECT status, COUNT(*)::int AS count FROM incidents GROUP BY status`
    ),
    pool.query(
      `SELECT source, COUNT(*)::int AS count FROM incidents GROUP BY source`
    ),
    pool.query(
      `
      SELECT
        COUNT(*)::int AS total,
        COUNT(responding_at)::int AS with_response_time,
        COUNT(resolved_at)::int AS with_resolution_time,
        ROUND(AVG(EXTRACT(EPOCH FROM (responding_at - created_at)))::numeric, 1)
          AS avg_response_seconds,
        ROUND(AVG(EXTRACT(EPOCH FROM (resolved_at - created_at)))::numeric, 1)
          AS avg_resolution_seconds
      FROM incidents
      `
    )
  ]);

  const bySeverity = { LOW: 0, MODERATE: 0, HIGH: 0, CRITICAL: 0 };
  for (const row of severityResult.rows) {
    if (bySeverity[row.severity] !== undefined) bySeverity[row.severity] = Number(row.count);
  }

  const byStatus = { OPEN: 0, ACKNOWLEDGED: 0, RESPONDING: 0, RESOLVED: 0 };
  for (const row of statusResult.rows) {
    if (byStatus[row.status] !== undefined) byStatus[row.status] = Number(row.count);
  }

  const bySource = {};
  for (const source of VALID_SOURCES) bySource[source] = 0;
  for (const row of sourceResult.rows) {
    if (bySource[row.source] !== undefined) bySource[row.source] = Number(row.count);
  }

  const timing = timingResult.rows[0];

  const secondsToMinutes = (seconds) =>
    seconds === null || seconds === undefined ? null : Math.round(seconds / 60 * 10) / 10;

  return {
    total: Number(timing.total),
    by_severity: bySeverity,
    by_status: byStatus,
    by_source: bySource,
    average_response_seconds:
      timing.with_response_time > 0 ? Number(timing.avg_response_seconds) : null,
    average_response_minutes:
      timing.with_response_time > 0
        ? secondsToMinutes(Number(timing.avg_response_seconds))
        : null,
    average_resolution_seconds:
      timing.with_resolution_time > 0 ? Number(timing.avg_resolution_seconds) : null,
    average_resolution_minutes:
      timing.with_resolution_time > 0
        ? secondsToMinutes(Number(timing.avg_resolution_seconds))
        : null,
    data_points: {
      with_response_time: Number(timing.with_response_time),
      with_resolution_time: Number(timing.with_resolution_time)
    }
  };
}

module.exports = {
  ACTIVE_STATUSES,
  VALID_STATUSES,
  VALID_SEVERITIES,
  VALID_SOURCES,
  ROUTE_STATUS_MANUAL,
  ROUTE_STATUS_PLANNED,
  ROUTE_STATUS_NO_ROBOT_AVAILABLE,
  ROUTE_STATUS_NO_COORDINATES,
  normalizeIncident,
  getActiveIncidentForDrain,
  getIncidentById,
  listIncidents,
  listActive,
  createIncident,
  createIncidentFromDecision,
  applyRobotAssignment,
  acknowledgeIncident,
  startResponse,
  resolveIncident,
  getTimeline,
  getDashboardSummary,
  getAnalytics
};