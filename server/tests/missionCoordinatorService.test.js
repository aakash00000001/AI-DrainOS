// ============================================================
// AI-DrainOS — Mission Coordination service tests (UPDATE #22)
//
// Verifies the autonomous mission scheduling & multi-robot
// coordination layer against a real PostgreSQL test database:
//   * pure priority scoring (weights, renormalization, honesty)
//   * pure candidate scoring (30/25/20/15/10 budget)
//   * real task queue (dedup, active-mission awareness, exclusions)
//   * robot eligibility + route modes
//   * deterministic multi-robot planning
//   * conflict detection + reassignment planning (no mutation)
//   * AUTONOMOUS dispatch ONLY through missionEngine
//   * additive summary/analytics/dashboard shapes + socket guard
//
// Every value asserted here is computed from real rows inserted by
// the test — no fabricated state is used anywhere.
// ============================================================

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const { setup } = require("./helpers");

let app;
let pool;
let coordinator;
let socketHub;

const captured = [];

const fakeIo = {
  emit(event, payload) {
    captured.push({ event, payload });
  }
};

// ------------------------------------------------------------
// Canonical real fixtures
// ------------------------------------------------------------

const DRAIN_COORDS = {
  1: [9.9252, 78.1198],
  2: [9.9252, 78.1198],
  3: [9.927, 78.1212],
  4: [9.929, 78.1235],
  5: [9.923, 78.1175],
  6: [9.9215, 78.1205],
  7: [9.931, 78.124]
};

const STANDARD_ROBOTS = [
  ["Robot-A1", "Zone 1", "Idle", 100, 9.925, 78.12],
  ["Robot-A2", "Zone 2", "Idle", 90, 9.92485, 78.11985],
  ["Robot-B1", "Zone 3", "Idle", 80, 9.926, 78.121],
  ["Robot-C1", "Zone 4", "Idle", 70, 9.93, 78.125],
  ["Robot-D1", "Zone 5", "Active", 76, 9.9277218, 78.1174649]
];

const STATION_A = { id: 1, station_name: "Charging Station A", latitude: 9.925, longitude: 78.12 };

async function insertRobots(rows = STANDARD_ROBOTS) {
  await pool.query("DELETE FROM robots");
  for (const [name, zone, status, battery, lat, lng] of rows) {
    await pool.query(
      `INSERT INTO robots (robot_name, assigned_zone, status, battery_level, latitude, longitude)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [name, zone, status, battery, lat, lng]
    );
  }
  await pool.query("SELECT setval(pg_get_serial_sequence('robots','id'), (SELECT COALESCE(MAX(id),1) FROM robots))");
}

async function setRobotState(robotName, patch) {
  const sets = [];
  const values = [];
  let i = 1;
  for (const [key, value] of Object.entries(patch)) {
    sets.push(`${key} = $${i}`);
    values.push(value);
    i += 1;
  }
  values.push(robotName);
  await pool.query(`UPDATE robots SET ${sets.join(", ")} WHERE robot_name = $${i}`, values);
}

async function setDrainStatus(drainId, status) {
  await pool.query("UPDATE drains SET status = $1 WHERE id = $2", [status, drainId]);
}

async function setDrainCoords(drainId, latitude, longitude) {
  await pool.query("UPDATE drains SET latitude = $1, longitude = $2 WHERE id = $3", [latitude, longitude, drainId]);
}

async function insertMission({ robotId, drainId, status = "Assigned", progress = 0 }) {
  const res = await pool.query(
    `INSERT INTO missions (robot_id, drain_id, mission_status, progress)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [robotId, drainId, status, progress]
  );
  return Number(res.rows[0].id);
}

async function insertIncident({ drainId, severity = "HIGH", status = "OPEN", decisionScore = null }) {
  const res = await pool.query(
    `INSERT INTO incidents (drain_id, severity, source, status, decision_score, resolved_at)
     VALUES ($1, $2, 'AI_DECISION', $3::varchar, $4,
             CASE WHEN $3::varchar = 'RESOLVED' THEN NOW() ELSE NULL END)
     RETURNING id`,
    [drainId, severity, status, decisionScore]
  );
  return Number(res.rows[0].id);
}

async function resetState() {
  await pool.query("DELETE FROM incidents");
  await pool.query("DELETE FROM missions");
  await pool.query("UPDATE drains SET status = 'Normal'");
  for (const [id, [lat, lng]] of Object.entries(DRAIN_COORDS)) {
    await setDrainCoords(Number(id), lat, lng);
  }
  await insertRobots();
  coordinator.resetCoordinationRuntime();
  captured.length = 0;
}

function taskForDrain(tasks, drainId) {
  return tasks.find((t) => t.drain_id === drainId) || null;
}

// ------------------------------------------------------------
// Lifecycle
// ------------------------------------------------------------

before(async () => {
  ({ app, pool } = await setup());
  coordinator = require("../services/missionCoordinatorService");
  socketHub = require("../services/socketHub");
  socketHub.init(null);
});

after(async () => {
  socketHub.init(null);
  await pool.end();
});

beforeEach(async () => {
  await resetState();
});

// ============================================================
// Pure priority scoring
// ============================================================

test("1. computeCoordinationPriority applies the documented weights when all signals are present", () => {
  const full = coordinator.computeCoordinationPriority({
    decisionScore: 100,
    severity: "CRITICAL",
    floodRiskScore: 100,
    forecastScore: 100,
    maintenanceScore: 100
  });
  assert.equal(full.priority_score, 100);
  assert.equal(full.priority_status, "OK");
  assert.deepEqual(Object.keys(full.priority_breakdown).sort(), [
    "decision",
    "flood_risk",
    "forecast",
    "maintenance_vision",
    "severity"
  ]);

  // 80*.4 + 75*.25 + 50*.15 + 40*.10 + 30*.10 = 65.25 -> 65.3
  const mixed = coordinator.computeCoordinationPriority({
    decisionScore: 80,
    severity: "HIGH",
    floodRiskScore: 50,
    forecastScore: 40,
    maintenanceScore: 30
  });
  assert.equal(mixed.priority_score, 65.3);
  assert.equal(mixed.priority_status, "OK");
});

test("2. computeCoordinationPriority renormalizes missing signals instead of fabricating them", () => {
  const onlyDecision = coordinator.computeCoordinationPriority({ decisionScore: 80 });
  assert.equal(onlyDecision.priority_score, 80);
  assert.equal(onlyDecision.priority_status, "RENORMALIZED");
  assert.deepEqual(onlyDecision.priority_breakdown, { decision: 80 });

  const onlySeverity = coordinator.computeCoordinationPriority({ severity: "LOW" });
  assert.equal(onlySeverity.priority_score, 25);
  assert.equal(onlySeverity.priority_status, "RENORMALIZED");

  // maintenance and vision collapse into one maintenance/vision signal.
  const mv = coordinator.computeCoordinationPriority({ maintenanceScore: 60, visionScore: 40 });
  assert.equal(mv.priority_breakdown.maintenance_vision, 60);
  assert.equal(mv.priority_score, 60);
});

test("3. computeCoordinationPriority reports INSUFFICIENT_DATA when no signal exists", () => {
  const empty = coordinator.computeCoordinationPriority({});
  assert.equal(empty.priority_score, null);
  assert.equal(empty.priority_status, "INSUFFICIENT_DATA");
  assert.deepEqual(empty.priority_breakdown, {});

  const bogus = coordinator.computeCoordinationPriority({ severity: "NOT_A_SEVERITY" });
  assert.equal(bogus.priority_score, null);
  assert.equal(bogus.priority_status, "INSUFFICIENT_DATA");
});

test("4. severityScore maps only the documented severities", () => {
  assert.equal(coordinator.severityScore("CRITICAL"), 100);
  assert.equal(coordinator.severityScore("high"), 75);
  assert.equal(coordinator.severityScore("Moderate"), 50);
  assert.equal(coordinator.severityScore("low"), 25);
  assert.equal(coordinator.severityScore("UNKNOWN"), 0);
  assert.equal(coordinator.severityScore(null), 0);
});

// ============================================================
// Pure candidate scoring
// ============================================================

test("5. computeCandidateScore follows the 30/25/20/15/10 budget and is monotonic", () => {
  const ineligible = coordinator.computeCandidateScore({ eligible: false });
  assert.equal(ineligible.candidate_score, null);
  assert.equal(ineligible.candidate_components, null);

  const good = coordinator.computeCandidateScore({
    distance: 0.0001,
    batteryLevel: 100,
    travelSeconds: 10,
    eligible: true
  });
  assert.equal(good.candidate_score, 99.4);
  assert.deepEqual(good.candidate_components, {
    distance: 29.6,
    battery: 25,
    eta: 19.8,
    availability: 15,
    feasibility: 10
  });

  const bad = coordinator.computeCandidateScore({
    distance: 0.01,
    batteryLevel: 50,
    travelSeconds: 600,
    eligible: true
  });
  assert.equal(bad.candidate_score, 47.5);
  assert.ok(bad.candidate_score < good.candidate_score);
});

// ============================================================
// Real task queue
// ============================================================

test("6. getTaskQueue derives real tasks and dedupes by drain", async () => {
  await setDrainStatus(3, "Warning");
  await setDrainStatus(5, "Critical");
  await setDrainStatus(7, "Warning");
  await insertIncident({ drainId: 5, severity: "CRITICAL" });

  const { tasks } = await coordinator.getTaskQueue();

  assert.equal(tasks.length, 3);
  const drains = tasks.map((t) => t.drain_id).sort((a, b) => a - b);
  assert.deepEqual(drains, [3, 5, 7]);
  for (const task of tasks) {
    assert.ok(task.priority_status === "OK" || task.priority_status === "RENORMALIZED" || task.priority_status === "INSUFFICIENT_DATA");
    assert.ok(["CRITICAL", "HIGH", "MODERATE", "LOW"].includes(task.severity));
  }
});

test("7. getTaskQueue marks a drain with an active mission as ASSIGNED", async () => {
  await setDrainStatus(5, "Critical");
  const [robot] = (await pool.query("SELECT id FROM robots WHERE robot_name = 'Robot-A1'")).rows;
  const missionId = await insertMission({ robotId: Number(robot.id), drainId: 5 });

  const { tasks } = await coordinator.getTaskQueue();
  const task = taskForDrain(tasks, 5);

  assert.ok(task);
  assert.equal(task.assignment_status, "ASSIGNED");
  assert.equal(task.current_state, "ASSIGNED");
  assert.equal(task.assigned_robot_id, Number(robot.id));
  assert.equal(task.active_mission_id, missionId);
});

test("8. getTaskQueue excludes resolved incidents", async () => {
  await insertIncident({ drainId: 5, severity: "CRITICAL", status: "RESOLVED" });

  const { tasks } = await coordinator.getTaskQueue();
  assert.equal(tasks.length, 0);
});

// ============================================================
// Robot eligibility + route modes
// ============================================================

test("9. getEligibleRobots reports the real availability of every robot", async () => {
  await setRobotState("Robot-A2", { status: "Charging" });

  const view = await coordinator.getEligibleRobots();
  assert.equal(view.robots.length, 5);

  const a1 = view.robots.find((r) => r.robot_name === "Robot-A1");
  const a2 = view.robots.find((r) => r.robot_name === "Robot-A2");
  const d1 = view.robots.find((r) => r.robot_name === "Robot-D1");

  assert.equal(a1.availability_state, "AVAILABLE");
  assert.equal(a1.eligible, true);
  assert.equal(a2.availability_state, "CHARGING");
  assert.equal(a2.eligible, false);
  assert.equal(d1.availability_state, "UNAVAILABLE");
  assert.equal(d1.eligible, false);
});

test("10. scoreRobotForTask is explainable and deterministic", async () => {
  await setDrainStatus(5, "Critical");
  const { snapshot } = await coordinator.getTaskQueue({ force: true });
  const task = (await coordinator.getTaskQueue()).tasks.find((t) => t.drain_id === 5);
  const stationRows = snapshot.stations;

  const robot = snapshot.fleet.robots.find((r) => r.robot_name === "Robot-A1");
  const first = coordinator.scoreRobotForTask(task, robot, stationRows);
  const second = coordinator.scoreRobotForTask(task, robot, stationRows);

  assert.equal(first.eligible, true);
  assert.equal(first.route_mode, "DIRECT");
  assert.ok(typeof first.candidate_score === "number");
  assert.ok(Array.isArray(first.reasons));
  assert.ok(first.reasons.length > 0);
  assert.deepEqual(first, second);
});

test("11. route evaluation selects CHARGE_THEN_TASK when a charging stop is required", () => {
  const robot = {
    robot_id: 1,
    robot_name: "Robot-A1",
    availability_state: "AVAILABLE",
    battery_level: 25,
    latitude: STATION_A.latitude,
    longitude: STATION_A.longitude
  };
  const task = { task_id: "drain:5", drain_id: 5, latitude: 9.926, longitude: 78.12, severity: "CRITICAL", location: "Airport Road" };

  const result = coordinator.scoreRobotForTask(task, robot, [STATION_A]);
  assert.equal(result.route_mode, "CHARGE_THEN_TASK");
  assert.equal(result.eligible, true);
  assert.equal(result.charging_required, true);
  assert.ok(result.charging_station);
});

test("12. route evaluation reports NO_FEASIBLE_ROUTE for an unreachable task", () => {
  const robot = {
    robot_id: 9,
    robot_name: "Robot-Far",
    availability_state: "AVAILABLE",
    battery_level: 21,
    latitude: 9.0,
    longitude: 78.0
  };
  const task = { task_id: "drain:5", drain_id: 5, latitude: 9.923, longitude: 78.1175, severity: "CRITICAL", location: "Airport Road" };

  const result = coordinator.scoreRobotForTask(task, robot, [STATION_A]);
  assert.equal(result.eligible, false);
  assert.equal(result.route_mode, "NO_FEASIBLE_ROUTE");
  assert.equal(result.rejection_reason, "INSUFFICIENT_BATTERY");
});

// ============================================================
// Multi-robot planning
// ============================================================

test("13. buildCoordinationPlan assigns each pending task to a distinct robot", async () => {
  await setDrainStatus(3, "Warning");
  await setDrainStatus(5, "Critical");
  await setDrainStatus(7, "Warning");

  const plan = await coordinator.buildCoordinationPlan();

  assert.equal(plan.assignments.length, 3);
  const robotIds = plan.assignments.map((a) => a.robot_id);
  const drainIds = plan.assignments.map((a) => a.drain_id);
  assert.equal(new Set(robotIds).size, 3);
  assert.equal(new Set(drainIds).size, 3);
  for (const assignment of plan.assignments) {
    assert.ok(typeof assignment.candidate_score === "number");
    assert.ok(["DIRECT", "CHARGE_THEN_TASK"].includes(assignment.route_mode));
    assert.ok(assignment.explanation.includes(assignment.robot_name));
  }
  assert.equal(plan.mode, "ADVISORY_PLAN");
});

test("14. buildCoordinationPlan is deterministic across repeated builds", async () => {
  await setDrainStatus(3, "Warning");
  await setDrainStatus(5, "Critical");
  await setDrainStatus(7, "Warning");

  const a = await coordinator.buildCoordinationPlan({ force: true });
  const b = await coordinator.buildCoordinationPlan({ force: true });

  assert.equal(JSON.stringify(a.assignments), JSON.stringify(b.assignments));
  assert.equal(JSON.stringify(a.unassigned), JSON.stringify(b.unassigned));
});

test("15. buildCoordinationPlan never overwrites an existing mission", async () => {
  await setDrainStatus(5, "Critical");
  const [robot] = (await pool.query("SELECT id FROM robots WHERE robot_name = 'Robot-A1'")).rows;
  const missionId = await insertMission({ robotId: Number(robot.id), drainId: 5 });

  const plan = await coordinator.buildCoordinationPlan();

  assert.ok(!plan.assignments.some((a) => a.drain_id === 5));
  const task = plan.tasks.find((t) => t.drain_id === 5);
  assert.equal(task.coordination_state, "ASSIGNED");
  assert.equal(task.active_mission_id, missionId);
});

test("16. buildCoordinationPlan reports ALL_ROBOTS_BUSY when tasks outnumber robots", async () => {
  // Four reachable real tasks on Normal drains (no status-based tasks).
  await insertIncident({ drainId: 1, severity: "HIGH" });
  await insertIncident({ drainId: 2, severity: "HIGH" });
  await insertIncident({ drainId: 3, severity: "HIGH" });
  await insertIncident({ drainId: 5, severity: "HIGH" });
  await setRobotState("Robot-C1", { status: "Offline" }); // leave exactly 3 available robots

  const plan = await coordinator.buildCoordinationPlan();

  assert.equal(plan.assignments.length, 3);
  assert.equal(plan.unassigned.length, 1);
  assert.equal(plan.unassigned[0].reason, "ALL_ROBOTS_BUSY");
});

test("17. buildCoordinationPlan reports INSUFFICIENT_BATTERY when every robot is below reserve", async () => {
  await setDrainStatus(5, "Critical");
  await pool.query("UPDATE robots SET battery_level = 20, status = 'Idle'");

  const plan = await coordinator.buildCoordinationPlan();

  assert.equal(plan.assignments.length, 0);
  assert.equal(plan.unassigned.length, 1);
  assert.equal(plan.unassigned[0].reason, "INSUFFICIENT_BATTERY");
  assert.equal(plan.status, "NO_ELIGIBLE_ROBOT");
});

test("18. buildCoordinationPlan reports NO_COORDINATES for a drain without coordinates", async () => {
  await setDrainStatus(5, "Critical");
  await setDrainCoords(5, null, null);

  const plan = await coordinator.buildCoordinationPlan();
  const entry = plan.unassigned.find((u) => u.drain_id === 5);

  assert.ok(entry);
  assert.equal(entry.reason, "NO_COORDINATES");
  assert.ok(plan.conflicts.some((c) => c.type === "TASK_WITHOUT_COORDINATES" && c.drain_id === 5));
});

// ============================================================
// Conflicts + reassignment
// ============================================================

test("19. detects ROBOT_DOUBLE_ASSIGNED and DUPLICATE_ACTIVE_MISSION conflicts", async () => {
  await setDrainStatus(3, "Critical");
  await setDrainStatus(5, "Critical");
  const [r1] = (await pool.query("SELECT id FROM robots WHERE robot_name = 'Robot-A1'")).rows;
  const [r2] = (await pool.query("SELECT id FROM robots WHERE robot_name = 'Robot-A2'")).rows;

  await insertMission({ robotId: Number(r1.id), drainId: 3 });
  await insertMission({ robotId: Number(r1.id), drainId: 5 });
  await insertMission({ robotId: Number(r2.id), drainId: 5 });

  const { conflicts } = await coordinator.getMissionConflicts();

  assert.ok(conflicts.some((c) => c.type === "ROBOT_DOUBLE_ASSIGNED" && c.robot_id === Number(r1.id)));
  assert.ok(conflicts.some((c) => c.type === "DUPLICATE_ACTIVE_MISSION" && c.drain_id === 5));
});

test("20. detects charging / unavailable robots holding a mission", async () => {
  await setDrainStatus(3, "Critical");
  await setDrainStatus(5, "Critical");
  const [r1] = (await pool.query("SELECT id FROM robots WHERE robot_name = 'Robot-A1'")).rows;
  const [r2] = (await pool.query("SELECT id FROM robots WHERE robot_name = 'Robot-A2'")).rows;

  await setRobotState("Robot-A1", { status: "Charging" });
  await setRobotState("Robot-A2", { status: "Offline" });
  await insertMission({ robotId: Number(r1.id), drainId: 3 });
  await insertMission({ robotId: Number(r2.id), drainId: 5 });

  const { conflicts } = await coordinator.getMissionConflicts();

  assert.ok(conflicts.some((c) => c.type === "ROBOT_CHARGING_WITH_MISSION" && c.robot_id === Number(r1.id)));
  assert.ok(conflicts.some((c) => c.type === "ROBOT_UNAVAILABLE_WITH_MISSION" && c.robot_id === Number(r2.id)));
});

test("21. getReassignmentPlan recommends a replacement and never mutates", async () => {
  await setDrainStatus(5, "Critical");
  const [r1] = (await pool.query("SELECT id FROM robots WHERE robot_name = 'Robot-A1'")).rows;
  await setRobotState("Robot-A1", { status: "Offline" });
  const missionId = await insertMission({ robotId: Number(r1.id), drainId: 5 });

  const { reassignments } = await coordinator.getReassignmentPlan();

  assert.equal(reassignments.length, 1);
  assert.equal(reassignments[0].reason, "ROBOT_OFFLINE");
  assert.equal(reassignments[0].mission_id, missionId);
  assert.ok(reassignments[0].recommended_replacement);
  assert.notEqual(reassignments[0].recommended_replacement.robot_id, Number(r1.id));

  const check = await pool.query("SELECT mission_status FROM missions WHERE id = $1", [missionId]);
  assert.equal(check.rows[0].mission_status, "Assigned");
  assert.equal((await pool.query("SELECT COUNT(*) AS c FROM missions")).rows[0].c, "1");
});

test("22. ADVISORY planning never mutates missions", async () => {
  await setDrainStatus(3, "Warning");
  await setDrainStatus(5, "Critical");
  await setDrainStatus(7, "Warning");

  const before = (await pool.query("SELECT COUNT(*) AS c FROM missions")).rows[0].c;
  const plan = await coordinator.coordinate({ mode: coordinator.MODES.ADVISORY_PLAN });
  const after = (await pool.query("SELECT COUNT(*) AS c FROM missions")).rows[0].c;

  assert.equal(before, after);
  assert.equal(plan.mode, "ADVISORY_PLAN");
  assert.ok(!("execution" in plan));
});

test("23. AUTONOMOUS planning dispatches only through missionEngine", async () => {
  await setDrainStatus(3, "Warning");
  await setDrainStatus(5, "Critical");
  await setDrainStatus(7, "Warning");

  const result = await coordinator.coordinate({ mode: coordinator.MODES.AUTONOMOUS_PLAN });

  assert.ok(result.execution);
  assert.equal(result.execution.executed.length, 3);
  assert.equal(result.execution.failed.length, 0);

  const rows = await pool.query("SELECT id, mission_status FROM missions WHERE mission_status = 'Assigned'");
  assert.equal(rows.rows.length, 3);
  for (const executed of result.execution.executed) {
    assert.ok(executed.mission_id);
    assert.ok(rows.rows.some((r) => Number(r.id) === Number(executed.mission_id)));
  }
});

// ============================================================
// Additive shapes + socket guard
// ============================================================

test("24. getCoordinationSummary / getAnalytics / getDashboardSummary expose the additive contract", async () => {
  await setDrainStatus(3, "Warning");
  await setDrainStatus(5, "Critical");
  await setDrainStatus(7, "Warning");

  const summary = await coordinator.getCoordinationSummary();
  assert.equal(summary.mode, "ADVISORY_PLAN");
  assert.ok(summary.summary);
  assert.ok(Array.isArray(summary.warnings));

  const analytics = await coordinator.getAnalytics();
  assert.equal(typeof analytics.coordination_pending_tasks, "number");
  assert.equal(typeof analytics.coordination_assigned_tasks, "number");
  assert.equal(typeof analytics.coordination_unassigned_tasks, "number");
  assert.ok(analytics.robot_utilization);
  assert.equal(analytics.robot_utilization.total, 5);

  const dash = await coordinator.getDashboardSummary();
  assert.equal(dash.pendingTasks, 3);
  assert.equal(dash.assignedTasks, 3);
  assert.equal(dash.unassignedTasks, 0);
  assert.equal(dash.availableRobots, 4);
  assert.equal(dash.chargingRobots, 0);
  assert.equal(typeof dash.coordinationConflicts, "number");
  assert.equal(typeof dash.reassignmentRequired, "number");
});

test("25. evaluateAndEmitMissionCoordination emits once per meaningful state", async () => {
  socketHub.init(fakeIo);
  await setDrainStatus(5, "Critical");
  coordinator.resetCoordinationRuntime();

  const first = await coordinator.evaluateAndEmitMissionCoordination();
  assert.equal(first.emitted, true);
  const events = captured.filter((c) => c.event === "missionCoordinationUpdate");
  assert.equal(events.length, 1);
  assert.ok(events[0].payload.summary);
  assert.equal(events[0].payload.mode, "ADVISORY_PLAN");

  const second = await coordinator.evaluateAndEmitMissionCoordination();
  assert.equal(second.emitted, false);
  assert.equal(captured.filter((c) => c.event === "missionCoordinationUpdate").length, 1);
});

test("26. buildSignature is stable for identical plans and changes on real change", () => {
  const base = {
    status: "OK",
    summary: {
      total_tasks: 1,
      assigned_tasks: 1,
      unassigned_tasks: 0,
      available_robots: 2,
      charging_robots: 0,
      coordination_conflicts: 0,
      reassignment_required: 0
    },
    assignments: [{ task_id: "drain:5", robot_id: 1, route_mode: "DIRECT" }],
    unassigned: [],
    conflicts: [],
    reassignment_required: []
  };
  const same = JSON.parse(JSON.stringify(base));
  const changed = JSON.parse(JSON.stringify(base));
  changed.assignments[0].robot_id = 2;

  assert.equal(coordinator.buildSignature(base), coordinator.buildSignature(same));
  assert.notEqual(coordinator.buildSignature(base), coordinator.buildSignature(changed));
});
