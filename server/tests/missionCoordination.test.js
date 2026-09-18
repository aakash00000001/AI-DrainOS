// ============================================================
// AI-DrainOS Mission Coordination API tests (UPDATE #22)
//
// Covers /api/missions/coordination read endpoints, the additive
// dashboard/analytics fields, the auth-protected POST /plan
// (advisory vs autonomous) and the hard guarantees that:
//   * advisory never mutates missions
//   * autonomous dispatches ONLY through missionEngine
// ============================================================

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

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

async function resetState() {
  await pool.query("DELETE FROM incidents");
  await pool.query("DELETE FROM missions");
  await pool.query("DELETE FROM robots");
  await pool.query("UPDATE drains SET status = 'Normal'");

  for (const [id, [lat, lng]] of Object.entries(DRAIN_COORDS)) {
    await pool.query("UPDATE drains SET latitude = $1, longitude = $2 WHERE id = $3", [lat, lng, Number(id)]);
  }

  for (const [name, zone, status, battery, lat, lng] of STANDARD_ROBOTS) {
    await pool.query(
      `INSERT INTO robots (robot_name, assigned_zone, status, battery_level, latitude, longitude)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [name, zone, status, battery, lat, lng]
    );
  }

  coordinator.resetCoordinationRuntime();
  captured.length = 0;
}

async function setDrainStatus(drainId, status) {
  await pool.query("UPDATE drains SET status = $1 WHERE id = $2", [status, drainId]);
}

async function loginToken() {
  const res = await request(app)
    .post("/api/auth/login")
    .send({ email: "admin@aidrain.com", password: "admin123" });
  assert.equal(res.status, 200);
  return res.body.token;
}

before(async () => {
  ({ app, pool } = await setup());
  coordinator = require("../services/missionCoordinatorService");
  socketHub = require("../services/socketHub");
  socketHub.init(fakeIo);
});

after(async () => {
  socketHub.init(null);
  await pool.end();
});

beforeEach(async () => {
  await resetState();
});

// --------------------------------------------------
// Read endpoints
// --------------------------------------------------

test("1. GET /api/missions/coordination returns the full advisory plan", async () => {
  await setDrainStatus(5, "Critical");

  const res = await request(app).get("/api/missions/coordination");

  assert.equal(res.status, 200);
  assert.equal(res.body.mode, "ADVISORY_PLAN");
  assert.ok("status" in res.body);
  assert.ok(res.body.summary);
  assert.ok(Array.isArray(res.body.tasks));
  assert.ok(Array.isArray(res.body.assignments));
  assert.ok(Array.isArray(res.body.conflicts));
  assert.ok(res.body.disclaimer.includes("missionEngine"));
});

test("2. GET /tasks and /robots expose the live coordination views", async () => {
  await setDrainStatus(3, "Warning");
  await setDrainStatus(5, "Critical");

  const tasks = await request(app).get("/api/missions/coordination/tasks");
  assert.equal(tasks.status, 200);
  assert.equal(tasks.body.status, "OK");
  assert.ok(Array.isArray(tasks.body.tasks));
  assert.equal(tasks.body.tasks.length, 2);

  const robots = await request(app).get("/api/missions/coordination/robots");
  assert.equal(robots.status, 200);
  assert.equal(robots.body.robots.length, 5);
  const a1 = robots.body.robots.find((r) => r.robot_name === "Robot-A1");
  assert.equal(a1.availability_state, "AVAILABLE");
});

test("3. GET /conflicts and /summary expose the additive shapes", async () => {
  await setDrainStatus(5, "Critical");

  const conflicts = await request(app).get("/api/missions/coordination/conflicts");
  assert.equal(conflicts.status, 200);
  assert.ok(Array.isArray(conflicts.body.conflicts));

  const summary = await request(app).get("/api/missions/coordination/summary");
  assert.equal(summary.status, 200);
  assert.equal(summary.body.mode, "ADVISORY_PLAN");
  assert.ok(summary.body.summary);
  assert.ok(Array.isArray(summary.body.warnings));
});

test("4. GET /api/analytics/coordination and /api/analytics carry additive coordination fields", async () => {
  await setDrainStatus(5, "Critical");

  const coord = await request(app).get("/api/analytics/coordination");
  assert.equal(coord.status, 200);
  assert.equal(typeof coord.body.coordination_pending_tasks, "number");
  assert.ok(coord.body.robot_utilization);

  const analytics = await request(app).get("/api/analytics");
  assert.equal(analytics.status, 200);
  assert.equal(typeof analytics.body.coordination_pending_tasks, "number");
  assert.equal(typeof analytics.body.coordination_conflict_count, "number");
  assert.ok("coordination_status" in analytics.body);
});

// --------------------------------------------------
// POST /plan
// --------------------------------------------------

test("5. POST /plan without a token is rejected", async () => {
  const res = await request(app).post("/api/missions/coordination/plan").send({ mode: "advisory" });
  assert.equal(res.status, 401);
});

test("6. POST /plan with an invalid mode is rejected", async () => {
  const token = await loginToken();
  const res = await request(app)
    .post("/api/missions/coordination/plan")
    .set("Authorization", `Bearer ${token}`)
    .send({ mode: "banana" });

  assert.equal(res.status, 400);
  assert.deepEqual(res.body.allowed_modes, ["advisory", "autonomous"]);
});

test("7. POST /plan advisory plans but never mutates missions", async () => {
  await setDrainStatus(3, "Warning");
  await setDrainStatus(5, "Critical");
  await setDrainStatus(7, "Warning");
  const token = await loginToken();

  const before = (await pool.query("SELECT COUNT(*) AS c FROM missions")).rows[0].c;
  const res = await request(app)
    .post("/api/missions/coordination/plan")
    .set("Authorization", `Bearer ${token}`)
    .send({ mode: "advisory" });
  const after = (await pool.query("SELECT COUNT(*) AS c FROM missions")).rows[0].c;

  assert.equal(res.status, 200);
  assert.equal(res.body.mode, "ADVISORY_PLAN");
  assert.equal(before, after);
  assert.equal(res.body.execution, undefined);
});

test("8. POST /plan autonomous dispatches ONLY through missionEngine", async () => {
  await setDrainStatus(3, "Warning");
  await setDrainStatus(5, "Critical");
  await setDrainStatus(7, "Warning");
  const token = await loginToken();

  const res = await request(app)
    .post("/api/missions/coordination/plan")
    .set("Authorization", `Bearer ${token}`)
    .send({ mode: "autonomous" });

  assert.equal(res.status, 200);
  assert.equal(res.body.mode, "AUTONOMOUS_PLAN");
  assert.ok(res.body.execution);
  assert.equal(res.body.execution.failed.length, 0);

  const assigned = await pool.query("SELECT COUNT(*) AS c FROM missions WHERE mission_status = 'Assigned'");
  assert.equal(Number(assigned.rows[0].c), res.body.execution.executed.length);

  // The existing mission API (missionEngine authority) still lists them.
  const missions = await request(app).get("/api/missions");
  assert.equal(missions.status, 200);
  for (const executed of res.body.execution.executed) {
    assert.ok(missions.body.some((m) => Number(m.id) === Number(executed.mission_id)));
  }
});

// --------------------------------------------------
// Additive dashboard
// --------------------------------------------------

test("9. GET /api/dashboard includes additive coordination fields", async () => {
  await setDrainStatus(3, "Warning");
  await setDrainStatus(5, "Critical");

  const res = await request(app).get("/api/dashboard");

  assert.equal(res.status, 200);
  assert.ok(res.body.coordination);
  assert.equal(typeof res.body.coordination.pendingTasks, "number");
  assert.equal(typeof res.body.coordination.assignedTasks, "number");
  assert.equal(typeof res.body.coordination.unassignedTasks, "number");
  assert.equal(typeof res.body.coordination.availableRobots, "number");
  assert.equal(typeof res.body.coordination.busyRobots, "number");
  assert.equal(typeof res.body.coordination.chargingRobots, "number");
  assert.equal(typeof res.body.coordination.coordinationConflicts, "number");
  assert.equal(typeof res.body.coordination.reassignmentRequired, "number");
});

test("10. the coordination API does not shadow the existing missionEngine API", async () => {
  const coordination = await request(app).get("/api/missions/coordination");
  assert.equal(coordination.status, 200);
  assert.equal(coordination.body.mode, "ADVISORY_PLAN");

  const missions = await request(app).get("/api/missions");
  assert.equal(missions.status, 200);
  assert.ok(Array.isArray(missions.body));
});
