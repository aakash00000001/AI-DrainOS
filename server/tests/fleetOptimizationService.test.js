// ============================================================
// AI-DrainOS Fleet Optimization — service tests
//
// Covers the pure, deterministic scoring helpers plus the
// state-dependent behavior of the advisory fleet optimizer:
// task priority, candidate scoring, battery-aware routing,
// availability states, greedy assignment, summaries, analytics,
// and the signature-guarded live emission.
//
// The optimizer is ADVISORY ONLY — it never assigns or moves
// robots. These tests assert that it only RECOMMENDS.
// ============================================================

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const { setup } = require("./helpers");

let app;
let pool;
let fleet;
let socketHub;

const captured = [];

const fakeIo = {
  emit(event, payload) {
    captured.push({ event, payload });
  }
};

async function insertIncident({
  drainId,
  severity = "HIGH",
  status = "OPEN",
  decisionScore = null,
  decisionLevel = null,
  routeStatus = null
}) {
  const res = await pool.query(
    `
    INSERT INTO incidents
      (drain_id, severity, source, status, decision_score, decision_level, route_status)
    VALUES ($1, $2, 'AI_DECISION', $3, $4, $5, $6)
    RETURNING id
    `,
    [drainId, severity, status, decisionScore, decisionLevel, routeStatus]
  );
  return Number(res.rows[0].id);
}

async function insertRobots() {
  const res = await pool.query(
    `
    INSERT INTO robots (robot_name, assigned_zone, status, battery_level, latitude, longitude) VALUES
    ('Robot-A1', 'Zone 1', 'Idle',   100, 9.9250000, 78.1200000),
    ('Robot-A2', 'Zone 2', 'Idle',    64, 9.9248500, 78.1198500),
    ('Robot-B1', 'Zone 3', 'Idle',    63, 9.9248500, 78.1198500),
    ('Robot-C1', 'Zone 4', 'Idle',   100, 9.9250000, 78.1200000),
    ('Robot-D1', 'Zone 5', 'Active',  76, 9.9277218, 78.1174649)
    RETURNING id, robot_name
    `
  );
  const byName = {};
  for (const row of res.rows) byName[row.robot_name] = Number(row.id);

  // Mirror the real running system: an Active robot has an Assigned
  // mission, which is what makes it BUSY (not merely UNAVAILABLE).
  await pool.query(
    "INSERT INTO missions (robot_id, drain_id, mission_status) VALUES ($1, $2, 'Assigned')",
    [byName["Robot-D1"], 5]
  );

  return byName;
}

before(async () => {
  ({ app, pool } = await setup());
  fleet = require("../services/fleetOptimizationService");
  socketHub = require("../services/socketHub");
  socketHub.init(null);
});

after(async () => {
  socketHub.init(null);
  await pool.end();
});

beforeEach(async () => {
  await pool.query("DELETE FROM incidents");
  await pool.query("DELETE FROM missions");
  await pool.query("DELETE FROM robots");
  await pool.query("UPDATE drains SET status = 'Normal'");
  // Restore coordinates mutated by earlier tests (never fabricate).
  await pool.query(
    "UPDATE drains SET latitude = 9.9230000, longitude = 78.1175000 WHERE id = 5"
  );
  await pool.query(
    "UPDATE drains SET latitude = 9.9270000, longitude = 78.1212000 WHERE id = 3"
  );
  await insertRobots();
  fleet.resetFleetOptimizationRuntime();
  captured.length = 0;
});

// --------------------------------------------------
// Pure scoring helpers
// --------------------------------------------------

test("1. severityScore maps every level and defaults to 0", () => {
  assert.equal(fleet.severityScore("LOW"), 25);
  assert.equal(fleet.severityScore("moderate"), 50);
  assert.equal(fleet.severityScore("High"), 75);
  assert.equal(fleet.severityScore("CRITICAL"), 100);
  assert.equal(fleet.severityScore(null), 0);
  assert.equal(fleet.severityScore("bogus"), 0);
});

test("2. ageScore ramps 0 -> 100 over AGE_RAMP_MINUTES and is null when unknown", () => {
  assert.equal(fleet.ageScore(0), 0);
  assert.equal(fleet.ageScore(30 * 60), 50);
  assert.equal(fleet.ageScore(60 * 60), 100);
  assert.equal(fleet.ageScore(120 * 60), 100);
  assert.equal(fleet.ageScore(null), null);
  assert.equal(fleet.ageScore("nope"), null);
});

test("3. operationalUrgencyScore sums drain/incident/route and clamps to 100", () => {
  assert.equal(fleet.operationalUrgencyScore({ drainStatus: "Critical" }), 100);
  assert.equal(fleet.operationalUrgencyScore({ drainStatus: "Warning" }), 60);
  assert.equal(
    fleet.operationalUrgencyScore({ drainStatus: "Critical", incidentStatus: "OPEN" }),
    100
  );
  assert.equal(
    fleet.operationalUrgencyScore({ routeStatus: "NO_ROBOT_AVAILABLE" }),
    40
  );
  assert.equal(fleet.operationalUrgencyScore({}), 0);
});

test("4. computeTaskPriority is a documented weighted sum", () => {
  const result = fleet.computeTaskPriority({
    decisionScore: 100,
    decisionLevel: "CRITICAL",
    severity: "CRITICAL",
    ageSeconds: 60 * 60,
    operationalUrgency: 100
  });

  assert.equal(result.priority_score, 100);
  assert.equal(result.priority_status, "OK");
  assert.equal(result.decision_level, "CRITICAL");
  assert.deepEqual(result.priority_breakdown, {
    decision_score: 100,
    severity: 100,
    age: 100,
    operational_urgency: 100
  });
});

test("5. computeTaskPriority renormalizes when the decision score is missing", () => {
  const result = fleet.computeTaskPriority({
    decisionScore: null,
    severity: "MODERATE",
    ageSeconds: null,
    operationalUrgency: 0
  });

  // weights present: severity 0.2 + urgency 0.1 = 0.3
  // weighted = 50 * (0.2 / 0.3) = 33.3
  assert.equal(result.priority_score, 33.3);
  assert.equal(result.priority_status, "RENORMALIZED");
  assert.equal(result.priority_breakdown.decision_score, undefined);
  assert.equal(result.priority_breakdown.age, undefined);
});

test("6. computeCandidateScore returns null for ineligible candidates", () => {
  const result = fleet.computeCandidateScore({
    distance: 0.001,
    batteryLevel: 80,
    travelSeconds: 100,
    eligible: false
  });
  assert.equal(result.candidate_score, null);
  assert.equal(result.components, null);
});

test("7. computeCandidateScore rewards closer, fuller, faster robots", () => {
  const close = fleet.computeCandidateScore({
    distance: 0.0005,
    batteryLevel: 100,
    travelSeconds: 50,
    eligible: true
  });
  const far = fleet.computeCandidateScore({
    distance: 0.006,
    batteryLevel: 30,
    travelSeconds: 600,
    eligible: true
  });

  assert.ok(close.candidate_score > far.candidate_score);
  assert.ok(close.components.distance >= far.components.distance);
  assert.ok(close.components.battery > far.components.battery);
  assert.ok(close.components.eta > far.components.eta);
});

// --------------------------------------------------
// Battery-aware routing
// --------------------------------------------------

test("8. evaluateRouteMode returns DIRECT when battery covers the trip plus reserve", () => {
  const route = fleet.evaluateRouteMode({
    robotBattery: 100,
    robotLatitude: 0,
    robotLongitude: 0,
    taskLatitude: 0.001,
    taskLongitude: 0,
    chargingStation: null
  });

  assert.equal(route.route_mode, fleet.ROUTE_MODE.DIRECT);
  assert.equal(route.charging_required, false);
  assert.equal(route.estimated_battery_cost, 20);
  assert.equal(route.battery_after, 80);
});

test("9. evaluateRouteMode reports NO_COORDINATES honestly", () => {
  const route = fleet.evaluateRouteMode({
    robotBattery: 100,
    robotLatitude: 0,
    robotLongitude: 0,
    taskLatitude: null,
    taskLongitude: null,
    chargingStation: null
  });

  assert.equal(route.route_mode, fleet.ROUTE_MODE.NO_FEASIBLE_ROUTE);
  assert.equal(route.reason, fleet.FLEET_STATUS.NO_COORDINATES);
  assert.equal(route.estimated_distance, null);
});

test("10. evaluateRouteMode reports INSUFFICIENT_DATA when battery is unknown", () => {
  const route = fleet.evaluateRouteMode({
    robotBattery: null,
    robotLatitude: 0,
    robotLongitude: 0,
    taskLatitude: 0.001,
    taskLongitude: 0,
    chargingStation: null
  });

  assert.equal(route.route_mode, fleet.ROUTE_MODE.NO_FEASIBLE_ROUTE);
  assert.equal(route.reason, fleet.FLEET_STATUS.INSUFFICIENT_DATA);
  assert.equal(route.battery_before, null);
});

test("11. evaluateRouteMode inserts a charging stop when needed", () => {
  const route = fleet.evaluateRouteMode({
    robotBattery: 45,
    robotLatitude: 0,
    robotLongitude: 0,
    taskLatitude: 0.003,
    taskLongitude: 0,
    chargingStation: { id: 7, station_name: "Station X", latitude: 0.001, longitude: 0 }
  });

  assert.equal(route.route_mode, fleet.ROUTE_MODE.CHARGE_THEN_TASK);
  assert.equal(route.charging_required, true);
  assert.equal(route.charging_station.id, 7);
  assert.ok(route.estimated_distance > 0);
});

test("12. evaluateRouteMode refuses a route when battery is insufficient even after charging", () => {
  const route = fleet.evaluateRouteMode({
    robotBattery: 21,
    robotLatitude: 0,
    robotLongitude: 0,
    taskLatitude: 0.002,
    taskLongitude: 0,
    chargingStation: { id: 1, station_name: "S", latitude: 0.001, longitude: 0 }
  });

  assert.equal(route.route_mode, fleet.ROUTE_MODE.NO_FEASIBLE_ROUTE);
  assert.equal(route.reason, "BATTERY_INSUFFICIENT");
  assert.equal(route.charging_required, true);
});

// --------------------------------------------------
// Availability
// --------------------------------------------------

test("13. availabilityStateFor maps robot status/mission/battery honestly", () => {
  const base = { status: "Idle", battery_level: 100 };

  assert.equal(fleet.availabilityStateFor(base, null), fleet.AVAILABILITY.AVAILABLE);
  assert.equal(
    fleet.availabilityStateFor({ status: "Charging", battery_level: 40 }, null),
    fleet.AVAILABILITY.CHARGING
  );
  assert.equal(
    fleet.availabilityStateFor({ status: "Maintenance", battery_level: 100 }, null),
    fleet.AVAILABILITY.UNAVAILABLE
  );
  assert.equal(
    fleet.availabilityStateFor({ status: "Offline", battery_level: 100 }, null),
    fleet.AVAILABILITY.OFFLINE
  );
  assert.equal(
    fleet.availabilityStateFor({ status: "Idle", battery_level: 15 }, null),
    fleet.AVAILABILITY.LOW_BATTERY
  );
  assert.equal(
    fleet.availabilityStateFor(base, { mission_id: 1 }),
    fleet.AVAILABILITY.BUSY
  );
  assert.equal(
    fleet.availabilityStateFor({ status: "Idle", battery_level: null }, null),
    fleet.AVAILABILITY.UNAVAILABLE
  );
});

// --------------------------------------------------
// Full optimization (DB-backed)
// --------------------------------------------------

test("14. getFleetOptimization reports NO_TASKS when there is nothing to do", async () => {
  const optimization = await fleet.getFleetOptimization();

  assert.equal(optimization.status, fleet.FLEET_STATUS.NO_TASKS);
  assert.equal(optimization.summary.active_tasks, 0);
  assert.equal(optimization.summary.total_robots, 5);
  assert.ok(Array.isArray(optimization.recommendations));
  assert.equal(optimization.recommendations.length, 0);
  assert.ok(optimization.disclaimer.length > 0);
});

test("15. getFleetOptimization reports NO_ROBOTS when the fleet is empty", async () => {
  await pool.query("DELETE FROM robots");
  await insertIncident({ drainId: 5, severity: "CRITICAL", decisionScore: 95 });

  const optimization = await fleet.getFleetOptimization();

  assert.equal(optimization.status, fleet.FLEET_STATUS.NO_ROBOTS);
  assert.equal(optimization.summary.total_robots, 0);
});

test("16. an incident task is recommended to an eligible robot (advisory only)", async () => {
  const incidentId = await insertIncident({
    drainId: 5,
    severity: "CRITICAL",
    decisionScore: 95,
    decisionLevel: "CRITICAL"
  });

  const optimization = await fleet.getFleetOptimization();

  assert.equal(optimization.status, fleet.FLEET_STATUS.OK);
  assert.equal(optimization.recommendations.length, 1);

  const rec = optimization.recommendations[0];
  assert.equal(rec.task_id, `incident:${incidentId}`);
  assert.equal(rec.robot_name, "Robot-A1");
  assert.ok(rec.explanation.includes("Robot-A1"));
  assert.equal(rec.route_mode, fleet.ROUTE_MODE.DIRECT);

  // Advisory only: no mission row was created for the recommended
  // robot and it is still Idle — the optimizer never dispatches.
  const a1Missions = await pool.query(
    `
    SELECT COUNT(*) FROM missions m
    JOIN robots r ON r.id = m.robot_id
    WHERE r.robot_name = 'Robot-A1'
    `
  );
  assert.equal(Number(a1Missions.rows[0].count), 0);
  const robot = await pool.query(
    "SELECT status FROM robots WHERE robot_name = 'Robot-A1'"
  );
  assert.equal(robot.rows[0].status, "Idle");
});

test("17. tasks are processed in priority order", async () => {
  const lowIncident = await insertIncident({
    drainId: 3,
    severity: "HIGH",
    decisionScore: 55,
    decisionLevel: "HIGH"
  });
  const highIncident = await insertIncident({
    drainId: 5,
    severity: "CRITICAL",
    decisionScore: 95,
    decisionLevel: "CRITICAL"
  });

  const optimization = await fleet.getFleetOptimization();

  assert.equal(optimization.recommendations.length, 2);
  assert.equal(optimization.tasks[0].task_id, `incident:${highIncident}`);
  assert.equal(optimization.tasks[1].task_id, `incident:${lowIncident}`);
  assert.ok(
    optimization.tasks[0].priority_score >= optimization.tasks[1].priority_score
  );
});

test("18. a robot is recommended for at most one task; leftovers are unassigned", async () => {
  await pool.query(
    "UPDATE robots SET status = 'Charging' WHERE robot_name IN ('Robot-A2','Robot-B1','Robot-C1')"
  );

  await insertIncident({ drainId: 5, severity: "CRITICAL", decisionScore: 95 });
  await insertIncident({ drainId: 3, severity: "HIGH", decisionScore: 70 });

  const optimization = await fleet.getFleetOptimization();

  assert.equal(optimization.recommendations.length, 1);
  assert.equal(optimization.unassigned.length, 1);
  assert.equal(
    optimization.unassigned[0].reason,
    fleet.FLEET_STATUS.NO_ELIGIBLE_ROBOT
  );
  assert.ok(optimization.unassigned[0].required_action.length > 0);

  const assignedRobots = optimization.recommendations.map((r) => r.robot_id);
  assert.equal(new Set(assignedRobots).size, assignedRobots.length);
});

test("19. charging and busy robots are not eligible candidates", async () => {
  await insertIncident({ drainId: 5, severity: "CRITICAL", decisionScore: 95 });

  const optimization = await fleet.getFleetOptimization();
  const byName = Object.fromEntries(
    optimization.robots.map((r) => [r.robot_name, r])
  );

  assert.equal(byName["Robot-D1"].availability_state, fleet.AVAILABILITY.BUSY);
  assert.equal(byName["Robot-A1"].availability_state, fleet.AVAILABILITY.AVAILABLE);
  assert.equal(optimization.recommendations[0].robot_name, "Robot-A1");
});

test("20. getFleetOptimization reports NO_COORDINATES when the task has no location", async () => {
  await pool.query("UPDATE drains SET latitude = NULL, longitude = NULL WHERE id = 5");
  await insertIncident({ drainId: 5, severity: "CRITICAL", decisionScore: 95 });

  const optimization = await fleet.getFleetOptimization();

  assert.equal(optimization.status, fleet.FLEET_STATUS.NO_COORDINATES);
  assert.equal(optimization.recommendations.length, 0);
  assert.equal(optimization.unassigned[0].reason, fleet.FLEET_STATUS.NO_COORDINATES);
});

test("21. getTask resolves incident/drain task ids and returns null for unknown", async () => {
  const incidentId = await insertIncident({
    drainId: 5,
    severity: "CRITICAL",
    decisionScore: 95
  });

  const found = await fleet.getTask(`incident:${incidentId}`);
  assert.ok(found);
  assert.equal(found.task.task_id, `incident:${incidentId}`);
  assert.equal(found.recommendation.task_id, `incident:${incidentId}`);

  const missing = await fleet.getTask("drain:999999");
  assert.equal(missing, null);
  assert.equal(await fleet.getTask(null), null);
});

test("22. buildSummary counts availability states and utilization", async () => {
  await insertIncident({ drainId: 5, severity: "CRITICAL", decisionScore: 95 });

  const optimization = await fleet.getFleetOptimization();
  const s = optimization.summary;

  assert.equal(s.total_robots, 5);
  assert.equal(s.available_robots, 4);
  assert.equal(s.busy_robots, 1);
  assert.equal(s.active_tasks, 1);
  assert.equal(s.recommended_assignments, 1);
  // utilization = (busy + charging) / total = 1 / 5 = 20%
  assert.equal(s.fleet_utilization, 20);
});

test("23. getAnalytics derives assignment coverage and average response", async () => {
  await pool.query(
    "UPDATE robots SET status = 'Charging' WHERE robot_name IN ('Robot-A2','Robot-B1','Robot-C1')"
  );
  await insertIncident({ drainId: 5, severity: "CRITICAL", decisionScore: 95 });
  await insertIncident({ drainId: 3, severity: "HIGH", decisionScore: 70 });

  const analytics = await fleet.getAnalytics();

  assert.equal(analytics.total_robots, 5);
  assert.equal(analytics.active_tasks, 2);
  assert.equal(analytics.assigned_tasks, 1);
  assert.equal(analytics.unassigned_task_count, 1);
  assert.equal(analytics.task_assignment_coverage, 50);
  assert.equal(analytics.charging_robots, 3);
  assert.ok(analytics.average_estimated_response_seconds !== null);
  assert.ok(analytics.unassigned_reasons.NO_ELIGIBLE_ROBOT >= 1);
});

test("24. getDashboardSummary returns camelCase additive fields", async () => {
  const summary = await fleet.getDashboardSummary();

  assert.equal(summary.totalRobots, 5);
  assert.equal(typeof summary.fleetUtilization, "number");
  assert.ok("availableRobots" in summary);
  assert.ok("recommendedAssignments" in summary);
  assert.ok("status" in summary);
});

// --------------------------------------------------
// Signature-guarded emission
// --------------------------------------------------

test("25. evaluateAndEmitFleetOptimization emits only on meaningful change", async () => {
  socketHub.init(fakeIo);
  fleet.resetFleetOptimizationRuntime();

  const first = await fleet.evaluateAndEmitFleetOptimization();
  assert.equal(first.emitted, true);
  assert.equal(
    captured.filter((e) => e.event === "fleetOptimizationUpdate").length,
    1
  );

  // Unchanged state => no duplicate emission.
  const second = await fleet.evaluateAndEmitFleetOptimization();
  assert.equal(second.emitted, false);
  assert.equal(
    captured.filter((e) => e.event === "fleetOptimizationUpdate").length,
    1
  );

  // A real change (new incident) => a new emission.
  await insertIncident({ drainId: 5, severity: "CRITICAL", decisionScore: 95 });
  const third = await fleet.evaluateAndEmitFleetOptimization();
  assert.equal(third.emitted, true);
  assert.equal(
    captured.filter((e) => e.event === "fleetOptimizationUpdate").length,
    2
  );

  socketHub.init(null);
});

test("26. a battery-only change does not re-emit (no per-tick churn)", async () => {
  socketHub.init(fakeIo);
  fleet.resetFleetOptimizationRuntime();

  await fleet.evaluateAndEmitFleetOptimization();
  const baseline = captured.filter(
    (e) => e.event === "fleetOptimizationUpdate"
  ).length;

  // Drain an already-AVAILABLE robot's battery without changing its
  // availability state — the signature must stay identical.
  await pool.query(
    "UPDATE robots SET battery_level = battery_level - 30 WHERE robot_name = 'Robot-A1'"
  );

  const result = await fleet.evaluateAndEmitFleetOptimization();
  assert.equal(result.emitted, false);
  assert.equal(
    captured.filter((e) => e.event === "fleetOptimizationUpdate").length,
    baseline
  );

  socketHub.init(null);
});
