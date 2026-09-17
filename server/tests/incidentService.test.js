// ============================================================
// AI-DrainOS Incident Service tests
//
// Cover the Autonomous Emergency Response & Incident Intelligence
// layer at the service level:
//  - incident creation (manual + AI_DECISION emergency)
//  - duplicate-active prevention (one active incident per drain)
//  - invalid drains never create incidents
//  - robot assignment via the EXISTING path-planning engine
//    (PLANNED / MANUAL / NO_ROBOT_AVAILABLE / NO_COORDINATES)
//  - lifecycle transitions (acknowledge / respond / resolve)
//  - status-transition guards (never re-resolve, never ack a
//    resolved incident)
//  - timeline derived ONLY from stored timestamps (never fabricated)
//  - dashboard incident counts
//  - analytics averages: null when no real data, real numbers when
//    real timestamps exist
// ============================================================

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { setup } = require("./helpers");

let pool;
let incidents;

before(async () => {
  ({ pool } = await setup());

  incidents = require("../services/incidentService");
  require("../services/socketHub").init(null);
});

after(async () => {
  await pool.end();
});

// --------------------------------------------------
// 1. Constants
// --------------------------------------------------

test("1. Lifecycle constants match the documented contract", () => {
  assert.deepEqual(incidents.ACTIVE_STATUSES, ["OPEN", "ACKNOWLEDGED", "RESPONDING"]);
  assert.deepEqual(incidents.VALID_STATUSES, ["OPEN", "ACKNOWLEDGED", "RESPONDING", "RESOLVED"]);
  assert.deepEqual(incidents.VALID_SEVERITIES, ["LOW", "MODERATE", "HIGH", "CRITICAL"]);
  assert.deepEqual(incidents.VALID_SOURCES, [
    "AI_DECISION",
    "FLOOD_RISK",
    "FORECAST",
    "MAINTENANCE",
    "VISION",
    "MANUAL"
  ]);
});

// --------------------------------------------------
// 2. Analytics on an empty table -> honest nulls
// --------------------------------------------------

test("2. Analytics returns zero/null (never fabricated) with no incidents", async () => {
  const data = await incidents.getAnalytics();

  assert.equal(data.total, 0);
  assert.deepEqual(data.by_severity, { LOW: 0, MODERATE: 0, HIGH: 0, CRITICAL: 0 });
  assert.deepEqual(data.by_status, { OPEN: 0, ACKNOWLEDGED: 0, RESPONDING: 0, RESOLVED: 0 });
  assert.equal(data.average_response_seconds, null);
  assert.equal(data.average_response_minutes, null);
  assert.equal(data.average_resolution_seconds, null);
  assert.equal(data.average_resolution_minutes, null);
  assert.equal(data.data_points.with_response_time, 0);
  assert.equal(data.data_points.with_resolution_time, 0);
});

// --------------------------------------------------
// 3. Validation - never create for missing/invalid drains
// --------------------------------------------------

test("3. createIncident rejects an invalid drain id", async () => {
  const result = await incidents.createIncident({ drainId: "abc", source: "MANUAL" });

  assert.equal(result.ok, false);
  assert.equal(result.code, "INVALID_DRAIN_ID");
});

test("4. createIncident rejects a drain that does not exist", async () => {
  const result = await incidents.createIncident({ drainId: 9999, source: "MANUAL" });

  assert.equal(result.ok, false);
  assert.equal(result.code, "DRAIN_NOT_FOUND");
});

test("5. createIncident validates severity/source envelopes", async () => {
  const badSeverity = await incidents.createIncident({ drainId: 1, source: "MANUAL", severity: "URGENT" });
  assert.equal(badSeverity.ok, false);
  assert.equal(badSeverity.code, "INVALID_SEVERITY");

  const badSource = await incidents.createIncident({ drainId: 1, source: "ALERT" });
  assert.equal(badSource.ok, false);
  assert.equal(badSource.code, "INVALID_SOURCE");
});

// --------------------------------------------------
// 6. Manual creation + fields
// --------------------------------------------------

test("6. Manual incident is created OPEN with real timestamps", async () => {
  const result = await incidents.createIncident({
    drainId: 1,
    title: "Manual check Goripalayam",
    description: "Operator-reported overflow risk",
    source: "MANUAL"
  });

  assert.equal(result.ok, true);
  assert.equal(result.incident.status, "OPEN");
  assert.equal(result.incident.source, "MANUAL");
  assert.equal(result.incident.severity, "HIGH");
  assert.equal(result.incident.drain_id, 1);
  assert.ok(result.incident.created_at);
  assert.equal(new Date(result.incident.created_at).getTime() > 0, true);
  assert.equal(result.incident.assigned_robot_id, null);
  assert.equal(result.incident.route_status, null);
  assert.equal(result.incident.drain.location, "Goripalayam");
});

// --------------------------------------------------
// 7. Duplicate prevention
// --------------------------------------------------

test("7. Duplicate active incident for the same drain is prevented", async () => {
  const first = await incidents.createIncident({ drainId: 4, source: "MANUAL" });
  assert.equal(first.ok, true);

  const dup = await incidents.createIncident({ drainId: 4, source: "MANUAL" });

  assert.equal(dup.ok, false);
  assert.equal(dup.code, "DUPLICATE_ACTIVE_INCIDENT");
  assert.ok(dup.incident);
  assert.equal(dup.incident.drain_id, 4);

  // Clean up so drain 4 can be reused later.
  await incidents.resolveIncident(first.incident.id, "duplicate check done");
});

test("8. A RESOLVED incident does not block a new active incident", async () => {
  const created = await incidents.createIncident({ drainId: 3, source: "MANUAL" });
  await incidents.resolveIncident(created.incident.id, "cleared");

  const after = await incidents.createIncident({ drainId: 3, source: "MANUAL" });
  assert.equal(after.ok, true);
  assert.equal(after.incident.status, "OPEN");
});

// --------------------------------------------------
// 9. Manual robot assignment (MANUAL route status)
// --------------------------------------------------

test("9. Manual assignment stores the real robot with MANUAL route status", async () => {
  const result = await incidents.createIncident({
    drainId: 2,
    source: "MANUAL",
    assignedRobotId: 1
  });

  assert.equal(result.ok, true);
  assert.equal(result.incident.assigned_robot_id, 1);
  assert.equal(result.incident.route_status, "MANUAL");
  assert.ok(result.incident.assigned_at);
  assert.equal(result.incident.robot.robotName, "Robot-A1");
});

test("10. Manual assignment rejects a robot that does not exist", async () => {
  const result = await incidents.createIncident({
    drainId: 6,
    source: "MANUAL",
    assignedRobotId: 9999
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "ROBOT_NOT_FOUND");
});

// --------------------------------------------------
// 11. AI_DECISION guards (never fabricate decision data)
// --------------------------------------------------

test("11. AI_DECISION requires real decision score/level", async () => {
  const result = await incidents.createIncident({ drainId: 6, source: "AI_DECISION" });

  assert.equal(result.ok, false);
  assert.equal(result.code, "DECISION_DATA_MISSING");
});

test("12. createIncidentFromDecision rejects non-critical or missing decisions", async () => {
  const noDecision = await incidents.createIncidentFromDecision({ drainId: 6, decision: null });
  assert.equal(noDecision.ok, false);
  assert.equal(noDecision.code, "NO_VALID_DECISION");

  const notReady = await incidents.createIncidentFromDecision({
    drainId: 6,
    decision: { status: "INSUFFICIENT_DATA", priorityLevel: null, priorityScore: null }
  });
  assert.equal(notReady.ok, false);
  assert.equal(notReady.code, "NO_VALID_DECISION");

  const notCritical = await incidents.createIncidentFromDecision({
    drainId: 6,
    decision: { status: "READY", priorityLevel: "HIGH", priorityScore: 60 }
  });
  assert.equal(notCritical.ok, false);
  assert.equal(notCritical.code, "NOT_CRITICAL");
});

// --------------------------------------------------
// 13. Emergency auto-assignment via the existing planner
// --------------------------------------------------

test("13. CRITICAL AI decision creates an incident with a PLANNED route", async () => {
  const result = await incidents.createIncidentFromDecision({
    drainId: 7,
    decision: {
      status: "READY",
      priorityLevel: "CRITICAL",
      priorityScore: 88,
      recommendedAction: "IMMEDIATE_ROBOT_INSPECTION"
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.incident.status, "OPEN");
  assert.equal(result.incident.source, "AI_DECISION");
  assert.equal(result.incident.severity, "CRITICAL");
  assert.equal(result.incident.decision_level, "CRITICAL");
  assert.equal(result.incident.decision_score, 88);

  // The existing path-planning engine assigned a real robot + route.
  assert.ok(result.incident.assigned_robot_id, "expected a robot assignment");
  assert.equal(result.incident.route_status, "PLANNED");
  assert.ok(result.incident.route, "expected a planned route snapshot");
  assert.ok(result.incident.route.type === "DIRECT" || result.incident.route.type === "CHARGING_STOP");
  assert.ok(result.incident.assigned_at);
  assert.ok(result.incident.robot.robotName);
});

// --------------------------------------------------
// 14. Missing coordinates -> NO_COORDINATES (honest)
// --------------------------------------------------

test("14. Drain without coordinates yields NO_COORDINATES, never a fake route", async () => {
  await pool.query(
    "INSERT INTO drains (zone_name, location, status, latitude, longitude) VALUES ('Zone X', 'No Coords', 'Warning', NULL, NULL)"
  );

  const result = await incidents.createIncident({
    drainId: 8,
    source: "FLOOD_RISK",
    severity: "CRITICAL"
  });

  assert.equal(result.ok, true);
  assert.equal(result.incident.route_status, "NO_COORDINATES");
  assert.equal(result.incident.assigned_robot_id, null);
  assert.equal(result.incident.route, null);
});

// --------------------------------------------------
// 15. No robot available -> NO_ROBOT_AVAILABLE (honest)
// --------------------------------------------------

test("15. No available robot yields NO_ROBOT_AVAILABLE", async () => {
  await pool.query("UPDATE robots SET status = 'Charging'");

  const result = await incidents.createIncident({
    drainId: 5,
    source: "FORECAST",
    severity: "CRITICAL"
  });

  assert.equal(result.ok, true);
  assert.equal(result.incident.route_status, "NO_ROBOT_AVAILABLE");
  assert.equal(result.incident.assigned_robot_id, null);
});

// --------------------------------------------------
// 16. Lifecycle transitions
// --------------------------------------------------

test("16. OPEN -> ACKNOWLEDGED -> RESPONDING -> RESOLVED with real timestamps", async () => {
  const created = await incidents.createIncident({
    drainId: 6,
    source: "MAINTENANCE",
    severity: "MODERATE",
    description: "Blockage risk rising"
  });
  assert.equal(created.ok, true);
  const id = created.incident.id;

  const ack = await incidents.acknowledgeIncident(id);
  assert.equal(ack.ok, true);
  assert.equal(ack.incident.status, "ACKNOWLEDGED");
  assert.ok(ack.incident.acknowledged_at);

  const respond = await incidents.startResponse(id);
  assert.equal(respond.ok, true);
  assert.equal(respond.incident.status, "RESPONDING");
  assert.ok(respond.incident.responding_at);

  const resolve = await incidents.resolveIncident(id, "Drain cleared and monitored");
  assert.equal(resolve.ok, true);
  assert.equal(resolve.incident.status, "RESOLVED");
  assert.ok(resolve.incident.resolved_at);
  assert.equal(resolve.incident.resolution_notes, "Drain cleared and monitored");
});

test("17. Transition guards reject invalid lifecycle moves", async () => {
  const created = await incidents.createIncident({ drainId: 6, source: "VISION", severity: "HIGH" });
  const id = created.incident.id;

  // Resolving from OPEN is allowed, but a second resolve is not.
  const resolve = await incidents.resolveIncident(id, "resolved once");
  assert.equal(resolve.ok, true);

  const reResolve = await incidents.resolveIncident(id, "again");
  assert.equal(reResolve.ok, false);
  assert.equal(reResolve.code, "ALREADY_RESOLVED");

  const ackResolved = await incidents.acknowledgeIncident(id);
  assert.equal(ackResolved.ok, false);
  assert.equal(ackResolved.code, "INVALID_TRANSITION");

  const respondResolved = await incidents.startResponse(id);
  assert.equal(respondResolved.ok, false);
  assert.equal(respondResolved.code, "INVALID_TRANSITION");
});

test("18. Respond is allowed directly from OPEN (ack can be skipped)", async () => {
  const created = await incidents.createIncident({ drainId: 3, source: "MANUAL" });
  const respond = await incidents.startResponse(created.incident.id);

  assert.equal(respond.ok, true);
  assert.equal(respond.incident.status, "RESPONDING");
});

// --------------------------------------------------
// 19. Timeline - only stored timestamps, never fabricated
// --------------------------------------------------

test("19. Timeline reflects every real lifecycle event and no imaginary ones", async () => {
  const created = await incidents.createIncident({
    drainId: 4,
    source: "MANUAL",
    title: "Timeline sample"
  });
  const id = created.incident.id;

  await incidents.acknowledgeIncident(id);
  await incidents.startResponse(id);
  await incidents.resolveIncident(id, "All clear");

  const incident = await incidents.getIncidentById(id);
  const timeline = incidents.getTimeline(incident);

  const events = timeline.map((e) => e.event);
  assert.ok(events.includes("incident created"));
  assert.ok(events.includes("acknowledged"));
  assert.ok(events.includes("response started"));
  assert.ok(events.includes("resolved"));

  // Manual incident with no robot: assigning a robot would be a LIE.
  assert.ok(!events.includes("robot assigned"));

  const resolvedEvent = timeline.find((e) => e.event === "resolved");
  assert.equal(resolvedEvent.notes, "All clear");

  // Timeline is sorted ascending by real timestamp.
  for (let i = 1; i < timeline.length; i++) {
    assert.ok(new Date(timeline[i].at) >= new Date(timeline[i - 1].at));
  }
});

// --------------------------------------------------
// 20. Dashboard counts
// --------------------------------------------------

test("20. Dashboard summary reports real counts + latest incidents", async () => {
  const summary = await incidents.getDashboardSummary();

  assert.equal(typeof summary.counts.active, "number");
  assert.equal(typeof summary.counts.critical, "number");
  assert.equal(typeof summary.counts.responding, "number");
  assert.equal(typeof summary.counts.resolved, "number");
  assert.ok(Array.isArray(summary.latest));

  // At this point we have created several active incidents.
  assert.ok(summary.counts.active >= 4, `expected >=4 active incidents, got ${summary.counts.active}`);
  assert.ok(summary.counts.resolved >= 4, `expected >=4 resolved incidents, got ${summary.counts.resolved}`);
});

// --------------------------------------------------
// 21. Filtering helper
// --------------------------------------------------

test("21. listIncidents supports status / severity / drain_id filters", async () => {
  const openOnly = await incidents.listIncidents({ status: "OPEN" });
  assert.ok(openOnly.every((i) => i.status === "OPEN"));

  const critical = await incidents.listIncidents({ severity: "CRITICAL" });
  assert.ok(critical.every((i) => i.severity === "CRITICAL"));

  const oneDrain = await incidents.listIncidents({ drainId: 1 });
  assert.ok(oneDrain.every((i) => i.drain_id === 1));

  const active = await incidents.listActive();
  assert.ok(active.length > 0);
  assert.ok(active.every((i) => incidents.ACTIVE_STATUSES.includes(i.status)));
});

// --------------------------------------------------
// 22. Analytics with real data
// --------------------------------------------------

test("22. Analytics computes real response/resolution averages when data exists", async () => {
  const before = await incidents.getAnalytics();

  // Stage REAL historical timestamps so the averages become larger and
  // provably derive from stored data (never fabricated guesses).
  const created = await incidents.createIncident({ drainId: 4, source: "FLOOD_RISK", severity: "HIGH" });
  const id = created.incident.id;

  await pool.query(
    `
    UPDATE incidents
    SET status = 'RESOLVED',
        created_at = NOW() - INTERVAL '10 minutes',
        responding_at = NOW() - INTERVAL '5 minutes',
        resolved_at = NOW() - INTERVAL '1 minute'
    WHERE id = $1
    `,
    [id]
  );

  const after = await incidents.getAnalytics();

  assert.ok(after.total > (before.total || 0));
  assert.ok(after.data_points.with_response_time >= 1);
  assert.ok(after.data_points.with_resolution_time >= 1);

  // The staged 5-minute response + 9-minute resolution pull the real
  // averages up above the earlier (near-instant) data.
  assert.equal(typeof after.average_response_minutes, "number");
  assert.equal(typeof after.average_resolution_minutes, "number");
  assert.ok(after.average_response_seconds > before.average_response_seconds);
  assert.ok(after.average_resolution_seconds > before.average_resolution_seconds);

  assert.equal(typeof after.by_severity.CRITICAL, "number");
  assert.equal(typeof after.by_source.FLOOD_RISK, "number");
  assert.equal(typeof after.by_source.MANUAL, "number");
});