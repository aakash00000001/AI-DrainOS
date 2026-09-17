// ============================================================
// AI-DrainOS Fleet Optimization API tests
//
// Covers /api/fleet-optimization read endpoints, the additive
// dashboard/analytics fleet fields, the socket emission through
// the SHARED socketHub (single Socket.IO server), and the hard
// guarantee that the endpoints are READ-ONLY (advisory only).
// ============================================================

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

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
  await pool.query(
    `
    INSERT INTO robots (robot_name, assigned_zone, status, battery_level, latitude, longitude) VALUES
    ('Robot-A1', 'Zone 1', 'Idle',   100, 9.9250000, 78.1200000),
    ('Robot-A2', 'Zone 2', 'Idle',    64, 9.9248500, 78.1198500),
    ('Robot-B1', 'Zone 3', 'Idle',    63, 9.9248500, 78.1198500),
    ('Robot-C1', 'Zone 4', 'Idle',   100, 9.9250000, 78.1200000),
    ('Robot-D1', 'Zone 5', 'Active',  76, 9.9277218, 78.1174649)
    `
  );
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
  await insertRobots();
  fleet.resetFleetOptimizationRuntime();
  captured.length = 0;
});

// --------------------------------------------------
// Read endpoints
// --------------------------------------------------

test("1. GET /api/fleet-optimization returns the full advisory view", async () => {
  const res = await request(app).get("/api/fleet-optimization");

  assert.equal(res.status, 200);
  assert.ok("status" in res.body);
  assert.ok("summary" in res.body);
  assert.ok(Array.isArray(res.body.robots));
  assert.ok(Array.isArray(res.body.tasks));
  assert.ok(Array.isArray(res.body.recommendations));
  assert.ok(res.body.disclaimer.includes("ADVISORY"));
});

test("2. GET /api/fleet-optimization/summary returns only summary fields", async () => {
  const res = await request(app).get("/api/fleet-optimization/summary");

  assert.equal(res.status, 200);
  assert.equal(res.body.status, "NO_TASKS");
  assert.ok(res.body.summary);
  assert.equal(res.body.summary.total_robots, 5);
  assert.equal(res.body.robots, undefined);
});

test("3. GET /api/fleet-optimization/robots returns robot availability states", async () => {
  const res = await request(app).get("/api/fleet-optimization/robots");

  assert.equal(res.status, 200);
  assert.equal(res.body.robots.length, 5);
  const a1 = res.body.robots.find((r) => r.robot_name === "Robot-A1");
  assert.equal(a1.availability_state, "AVAILABLE");
  assert.equal(a1.battery_level, 100);
});

test("4. GET /api/fleet-optimization/tasks returns prioritized tasks", async () => {
  const incidentId = await insertIncident({
    drainId: 5,
    severity: "CRITICAL",
    decisionScore: 95
  });

  const res = await request(app).get("/api/fleet-optimization/tasks");

  assert.equal(res.status, 200);
  assert.equal(res.body.tasks.length, 1);
  assert.equal(res.body.tasks[0].task_id, `incident:${incidentId}`);
  // 95*0.6 + 100*0.2 + 0*0.1 + 30*0.1 = 80
  assert.equal(res.body.tasks[0].priority_score, 80);
  assert.equal(res.body.tasks[0].recommendation_status, "RECOMMENDED");
});

test("5. GET /api/fleet-optimization/recommendations returns assignments + unassigned", async () => {
  await insertIncident({ drainId: 5, severity: "CRITICAL", decisionScore: 95 });

  const res = await request(app).get("/api/fleet-optimization/recommendations");

  assert.equal(res.status, 200);
  assert.equal(res.body.recommendations.length, 1);
  assert.equal(res.body.recommendations[0].robot_name, "Robot-A1");
  assert.ok(Array.isArray(res.body.unassigned));
  assert.ok(Array.isArray(res.body.robots_without_assignment));
  assert.ok(res.body.disclaimer.includes("ADVISORY"));
});

test("6. GET /api/fleet-optimization/analytics returns fleet metrics", async () => {
  await insertIncident({ drainId: 5, severity: "CRITICAL", decisionScore: 95 });

  const res = await request(app).get("/api/fleet-optimization/analytics");

  assert.equal(res.status, 200);
  assert.equal(res.body.total_robots, 5);
  assert.equal(res.body.active_tasks, 1);
  assert.equal(res.body.assigned_tasks, 1);
  assert.equal(res.body.task_assignment_coverage, 100);
  assert.ok(res.body.robot_utilization !== null);
});

test("7. GET /api/fleet-optimization/:taskId resolves a task and 404s when missing", async () => {
  const incidentId = await insertIncident({
    drainId: 5,
    severity: "CRITICAL",
    decisionScore: 95
  });

  const found = await request(app).get(`/api/fleet-optimization/incident:${incidentId}`);
  assert.equal(found.status, 200);
  assert.equal(found.body.task.task_id, `incident:${incidentId}`);
  assert.equal(found.body.recommendation.robot_name, "Robot-A1");

  const missing = await request(app).get("/api/fleet-optimization/drain:999999");
  assert.equal(missing.status, 404);
});

test("8. fleet endpoints are READ-ONLY (no mission created, robots unchanged)", async () => {
  await insertIncident({ drainId: 5, severity: "CRITICAL", decisionScore: 95 });

  await request(app).get("/api/fleet-optimization");
  await request(app).get("/api/fleet-optimization/recommendations");
  await request(app).get("/api/fleet-optimization/analytics");

  const missions = await pool.query("SELECT COUNT(*) FROM missions");
  assert.equal(Number(missions.rows[0].count), 0);

  const robots = await pool.query("SELECT status FROM robots ORDER BY id");
  assert.deepEqual(
    robots.rows.map((r) => r.status),
    ["Idle", "Idle", "Idle", "Idle", "Active"]
  );
});

// --------------------------------------------------
// Additive dashboard + analytics
// --------------------------------------------------

test("9. GET /api/dashboard includes an additive fleet summary", async () => {
  await insertIncident({ drainId: 5, severity: "CRITICAL", decisionScore: 95 });

  const res = await request(app).get("/api/dashboard");

  assert.equal(res.status, 200);
  assert.ok(res.body.fleet);
  assert.equal(res.body.fleet.totalRobots, 5);
  assert.equal(res.body.fleet.activeTasks, 1);
  assert.ok("fleetUtilization" in res.body.fleet);
  // Existing fields remain intact.
  assert.ok("totalDrains" in res.body);
  assert.ok("activeRobots" in res.body);
  assert.ok("incidents" in res.body);
});

test("10. GET /api/dashboard/fleet returns the fleet summary", async () => {
  const res = await request(app).get("/api/dashboard/fleet");

  assert.equal(res.status, 200);
  assert.ok(res.body.summary);
  assert.equal(res.body.summary.total_robots, 5);
});

test("11. GET /api/analytics includes additive fleet fields", async () => {
  await insertIncident({ drainId: 5, severity: "CRITICAL", decisionScore: 95 });

  const res = await request(app).get("/api/analytics");

  assert.equal(res.status, 200);
  assert.equal(res.body.fleet_total_robots, 5);
  assert.equal(res.body.fleet_active_tasks, 1);
  assert.equal(res.body.fleet_assigned_tasks, 1);
  // Existing fields remain intact.
  assert.ok("total_drains" in res.body);
  assert.ok("incident_total" in res.body);
});

test("12. GET /api/analytics/fleet-optimization returns fleet analytics", async () => {
  await insertIncident({ drainId: 5, severity: "CRITICAL", decisionScore: 95 });

  const res = await request(app).get("/api/analytics/fleet-optimization");

  assert.equal(res.status, 200);
  assert.equal(res.body.total_robots, 5);
  assert.equal(res.body.assigned_tasks, 1);
  assert.ok(res.body.disclaimer.includes("ADVISORY"));
});

// --------------------------------------------------
// Socket emission (shared hub — never a second server)
// --------------------------------------------------

test("13. the live loop emits fleetOptimizationUpdate through the shared hub", async () => {
  socketHub.init(fakeIo);
  await insertIncident({ drainId: 5, severity: "CRITICAL", decisionScore: 95 });

  await fleet.evaluateAndEmitFleetOptimization();

  const events = captured.filter((e) => e.event === "fleetOptimizationUpdate");
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.recommendations.length, 1);
  assert.equal(events[0].payload.summary.total_robots, 5);

  socketHub.init(null);
});
