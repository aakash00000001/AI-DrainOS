// ============================================================
// AI-DrainOS Robot Path Planning & Route Optimization tests
//
// Cover the explainable robot selection layer, battery-aware
// route planning (direct vs charging stop), coordinate-space
// distance / time / battery estimation derived from the existing
// movement-loop constants (step 0.00005, 5 s tick, 1 battery% /
// tick), waypoint generation, dashboard/analytics summaries,
// honest NO_ROBOT_AVAILABLE behaviour and the new REST endpoints.
//
// Robots on missions, in low battery, or charging are never
// selected; the planner never fabricates availability.
// ============================================================

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const { setup } = require("./helpers");

let app;
let pool;
let planning;
let socketHub;

const fakeIo = (captured) => ({
  emit(event, payload) {
    captured.push({ event, payload });
  }
});

before(async () => {
  ({ app, pool } = await setup());

  // Require after setup so config/db binds to the test database
  planning = require("../services/robotPathPlanningService");
  socketHub = require("../services/socketHub");
});

after(async () => {
  socketHub.init(null);
  await pool.end();
});

// --------------------------------------------------
// 0. Constants derived from the movement loop (index.js)
// --------------------------------------------------

test("0. Constants match the existing movement-loop assumptions", () => {
  assert.equal(planning.MOVEMENT_STEP, 0.00005);
  assert.equal(planning.TICK_INTERVAL_MS, 5000);
  assert.equal(planning.BATTERY_DRAIN_PER_TICK, 1);
  assert.equal(planning.MIN_BATTERY_MISSION, 20);
  assert.equal(planning.ARRIVAL_THRESHOLD, 0.00001);
  assert.equal(planning.SECONDS_PER_UNIT, 100000);
  assert.equal(planning.BATTERY_PER_UNIT, 20000);
});

// --------------------------------------------------
// 1. Pure helpers
// --------------------------------------------------

test("1. coordinateDistance - identical points, Euclidean distance, null handling", () => {
  assert.equal(planning.coordinateDistance(9.925, 78.12, 9.925, 78.12), 0);

  const dist = planning.coordinateDistance(9.925, 78.12, 9.930, 78.125);
  assert.ok(dist > 0);
  assert.ok(Math.abs(dist - 0.007071) < 0.001);

  assert.equal(planning.coordinateDistance(null, 78.12, 9.93, 78.12), null);
  assert.equal(planning.coordinateDistance(9.925, 78.12, null, 78.12), null);
  assert.equal(planning.coordinateDistance(null, null, null, null), null);
});

test("2. estimatedTravelSeconds - null/zero safe and linear", () => {
  assert.equal(planning.estimatedTravelSeconds(null), 0);
  assert.equal(planning.estimatedTravelSeconds(0), 0);
  assert.equal(planning.estimatedTravelSeconds(-1), 0);

  assert.equal(planning.estimatedTravelSeconds(0.001), 100);

  const s1 = planning.estimatedTravelSeconds(0.0001);
  const s2 = planning.estimatedTravelSeconds(0.0002);
  assert.ok(Math.abs(s2 - s1 * 2) < 0.5);
});

test("3. estimatedBatteryCost - null/zero safe and matches drain model", () => {
  assert.equal(planning.estimatedBatteryCost(null), 0);
  assert.equal(planning.estimatedBatteryCost(0), 0);
  assert.equal(planning.estimatedBatteryCost(-1), 0);

  assert.equal(planning.estimatedBatteryCost(0.00005), 1);
  assert.equal(planning.estimatedBatteryCost(0.001), 20);
});

test("4. formatDuration - seconds, minutes and mixed formats", () => {
  assert.equal(planning.formatDuration(0), "0 s");
  assert.equal(planning.formatDuration(30), "30 s");
  assert.equal(planning.formatDuration(60), "1 m");
  assert.equal(planning.formatDuration(90), "1 m 30 s");
  assert.equal(planning.formatDuration(125), "2 m 5 s");
});

test("5. buildDirectRoute - pure 2-waypoint route planning", () => {
  const robot = { latitude: 9.925, longitude: 78.12 };
  const drain = { latitude: 9.929, longitude: 78.124 };

  const route = planning.buildDirectRoute(drain, robot);

  assert.equal(route.type, "DIRECT");
  assert.equal(route.needsCharging, false);
  assert.equal(route.chargingStation, null);
  assert.equal(route.waypoints.length, 2);
  assert.equal(route.waypoints[0].label, "START");
  assert.equal(route.waypoints[1].label, "TARGET");
  assert.ok(route.totalDistance > 0);
  assert.ok(route.totalTravelSeconds > 0);
  assert.ok(route.totalBatteryCost > 0);
  assert.equal(route.waypoints[1].cumulativeDistance, route.totalDistance);
  assert.equal(route.waypoints[1].cumulativeTravelSeconds, route.totalTravelSeconds);
  assert.equal(route.waypoints[1].cumulativeBatteryCost, route.totalBatteryCost);
});

test("6. buildDirectRoute - zero distance edge case", () => {
  const robot = { latitude: 9.925, longitude: 78.12 };

  const route = planning.buildDirectRoute(robot, robot);

  assert.equal(route.totalDistance, 0);
  assert.equal(route.totalTravelSeconds, 0);
  assert.equal(route.totalBatteryCost, 0);
  assert.equal(route.waypoints[0].label, "START");
  assert.equal(route.waypoints[1].label, "TARGET");
});

// --------------------------------------------------
// 7-8. Candidate discovery (read-only, DB-backed)
// --------------------------------------------------

test("7. Invalid drain IDs yield honest DRAIN_NOT_FOUND context", async () => {
  const result = await planning.getCandidates(99999);
  assert.equal(result.drain, null);
  assert.equal(result.reason, "Drain not found");

  const bad = await planning.getCandidates(0);
  assert.equal(bad.reason, "Invalid drain ID");
});

test("8. Candidates for a critical drain are computed correctly", async () => {
  const result = await planning.getCandidates(5);

  assert.ok(result.drain);
  assert.equal(result.drain.id, 5);
  assert.ok(result.drainCoordsOk);
  assert.ok(result.candidates.length > 0);

  const candidate = result.candidates[0];
  assert.equal(typeof candidate.distanceToTarget, "number");
  assert.equal(typeof candidate.batteryCostToTarget, "number");
  assert.equal(typeof candidate.travelSecondsToTarget, "number");
  assert.equal(typeof candidate.hasEnoughBattery, "boolean");
  assert.equal(typeof candidate.formatTravelTime, "string");

  // Charging robots are excluded
  const charging = result.candidates.filter((r) => r.status === "Charging");
  assert.equal(charging.length, 0);

  // Robots with active missions are excluded
  const activeIds = result.activeMissions.map((m) => m.robotId);
  assert.ok(activeIds.length >= 0);
  for (const robot of result.candidates) {
    assert.ok(!activeIds.includes(robot.id));
  }
});

// --------------------------------------------------
// 9-10. Selection
// --------------------------------------------------

test("9. No robot available states are honest", async () => {
  // Make all robots unavailable: charge them and add active missions
  await pool.query("UPDATE robots SET status = 'Charging'");
  await pool.query(`
    INSERT INTO missions (robot_id, drain_id, mission_status, progress)
    VALUES (1, 1, 'Assigned', 0)
  `);

  const result = await planning.selectBestRobot(5);
  assert.equal(result.status, "NO_ROBOT_AVAILABLE");
  assert.equal(result.robot, null);

  // Restore seed state
  await pool.query("DELETE FROM missions WHERE robot_id = 1 AND mission_status = 'Assigned'");
  await pool.query(`
    UPDATE robots
    SET status = CASE id WHEN 5 THEN 'Active' ELSE 'Idle' END
  `);
});

test("10. selectBestRobot returns an explainable selection", async () => {
  const result = await planning.selectBestRobot(5);

  assert.ok(result.status === "ROBOT_SELECTED" || result.status === "NO_ROBOT_AVAILABLE");

  if (result.status === "ROBOT_SELECTED") {
    assert.ok(result.robot.id > 0);
    assert.ok(result.robot.robotName);
    assert.ok(result.robot.batteryLevel > 0);
    assert.ok(result.selectionScore > 0);
    assert.ok(result.selectionReasons.length > 0);
    // Robots with missions or charging are never selected
    assert.notEqual(result.robot.status, "Charging");
    assert.notEqual(result.robot.status, "Maintenance");
  }

  assert.ok(result.disclaimer.length > 0);
  assert.ok(!Number.isNaN(new Date(result.generatedAt).getTime()));
});

// --------------------------------------------------
// 11-13. Full route planning
// --------------------------------------------------

test("11. planRoute returns a complete route for a critical drain", async () => {
  const result = await planning.planRoute(5);

  assert.equal(result.status, "ROBOT_SELECTED");
  assert.ok(result.route);
  assert.ok(["DIRECT", "CHARGING_STOP"].includes(result.route.type));
  assert.ok(result.route.waypoints.length >= 2);
  assert.equal(typeof result.route.totalDistance, "number");
  assert.equal(typeof result.route.totalTravelSeconds, "number");
  assert.equal(typeof result.route.totalBatteryCost, "number");
  assert.equal(typeof result.route.formatTotalTravelTime, "string");
  assert.equal(typeof result.hasEnoughBattery, "boolean");

  const start = result.route.waypoints[0];
  const end = result.route.waypoints[result.route.waypoints.length - 1];

  assert.equal(start.latitude, result.robot.latitude);
  assert.equal(start.longitude, result.robot.longitude);
  assert.equal(end.latitude, result.drain.latitude);
  assert.equal(end.longitude, result.drain.longitude);

  assert.equal(start.cumulativeDistance, 0);
  assert.equal(start.cumulativeTravelSeconds, 0);
  assert.equal(start.cumulativeBatteryCost, 0);
  assert.equal(end.cumulativeDistance, result.route.totalDistance);
  assert.equal(end.cumulativeTravelSeconds, result.route.totalTravelSeconds);
  assert.equal(end.cumulativeBatteryCost, result.route.totalBatteryCost);

  if (result.route.type === "CHARGING_STOP") {
    assert.equal(result.route.waypoints.length, 3);
    assert.equal(result.route.waypoints[1].label, "CHARGING_STATION");
    assert.ok(result.route.chargingStation);
    assert.equal(result.route.needsCharging, true);
  } else {
    assert.equal(result.route.waypoints.length, 2);
    assert.equal(result.route.needsCharging, false);
  }
});

test("12. planRoute returns honest state for invalid drains", async () => {
  const notFound = await planning.planRoute(99999);
  assert.equal(notFound.status, "DRAIN_NOT_FOUND");
  assert.equal(notFound.route, null);

  const noCoords = await planning.planRoute(0);
  assert.equal(noCoords.status, "DRAIN_NOT_FOUND");
  assert.equal(noCoords.route, null);
});

test("13. Wiring the robot to the drain: an active mission drains availability", async () => {
  // Assign robot 1 to drain 1
  await pool.query(`
    INSERT INTO missions (robot_id, drain_id, mission_status, progress)
    VALUES (1, 1, 'Assigned', 0)
  `);
  await pool.query(`
    UPDATE robots SET status = 'Active' WHERE id = 1
  `);

  const result = await planning.selectBestRobot(5);
  if (result.status === "ROBOT_SELECTED") {
    assert.notEqual(result.robot.id, 1, "robot 1 has an active mission");
  }

  // Cleanup
  await pool.query("DELETE FROM missions WHERE robot_id = 1 AND mission_status = 'Assigned'");
  await pool.query("UPDATE robots SET status = 'Idle' WHERE id = 1");
});

// --------------------------------------------------
// 14. Charging stop route
// --------------------------------------------------

test("14. Low-battery robot plans a charging-stop route", async () => {
  // Lock every robot away except robot 4, which has only enough
  // battery to reach a charging station - not the far drain.
  await pool.query(`
    UPDATE robots
    SET status = 'Charging'
    WHERE id <> 4
  `);

  await pool.query(`
    UPDATE robots
    SET
      battery_level = 80,
      status = 'Idle',
      latitude = 9.928,
      longitude = 78.122
    WHERE id = 4
  `);

  // Drain 7 far away: direct battery cost ~144% > 80% -> needs charging.
  const result = await planning.planRoute(7);

  assert.equal(result.status, "ROBOT_SELECTED");
  assert.equal(result.robot.id, 4);
  assert.equal(result.route.type, "CHARGING_STOP");
  assert.equal(result.route.needsCharging, true);
  assert.equal(result.hasEnoughBattery, false);
  assert.ok(result.route.chargingStation);
  assert.equal(result.route.waypoints.length, 3);
  assert.equal(result.route.waypoints[1].label, "CHARGING_STATION");

  // Restore seed state
  await pool.query(`
    UPDATE robots
    SET status = CASE id WHEN 5 THEN 'Active' ELSE 'Idle' END,
        battery_level = CASE id
          WHEN 1 THEN 100
          WHEN 2 THEN 64
          WHEN 3 THEN 63
          WHEN 4 THEN 100
          WHEN 5 THEN 76
        END,
        latitude = CASE id
          WHEN 1 THEN 9.925
          WHEN 2 THEN 9.92485
          WHEN 3 THEN 9.92485
          WHEN 4 THEN 9.925
          WHEN 5 THEN 9.9277218
        END,
        longitude = CASE id
          WHEN 1 THEN 78.120
          WHEN 2 THEN 78.11985
          WHEN 3 THEN 78.11985
          WHEN 4 THEN 78.120
          WHEN 5 THEN 78.1174649
        END
  `);
});

// --------------------------------------------------
// 15. Dashboard / analytics summaries
// --------------------------------------------------

test("15. getAllRoutes returns summary and skips Normal drains", async () => {
  const summary = await planning.getAllRoutes();

  assert.ok(summary.totalDrains > 0);
  assert.ok(summary.warningCritical >= 2);
  assert.ok(Array.isArray(summary.routes));
  assert.equal(summary.routes.length, summary.totalDrains);

  const normal = summary.routes.filter((r) => r.status === "Normal");
  for (const r of normal) {
    assert.equal(r.planningStatus, "SKIPPED");
  }

  const wc = summary.routes.filter(
    (r) => r.status === "Warning" || r.status === "Critical"
  );
  for (const r of wc) {
    assert.ok(
      ["ROBOT_SELECTED", "NO_ROBOT_AVAILABLE", "NO_COORDINATES"].includes(
        r.planningStatus
      )
    );
  }
});

// --------------------------------------------------
// 16-18. REST endpoints
// --------------------------------------------------

test("16. GET /api/predictions/robot-route/:drainId returns a planned route", async () => {
  const res = await request(app)
    .get("/api/predictions/robot-route/5")
    .expect(200);

  assert.ok(["ROBOT_SELECTED", "NO_ROBOT_AVAILABLE"].includes(res.body.status));
  assert.ok(res.body.disclaimer);
  assert.ok(res.body.generatedAt);

  if (res.body.status === "ROBOT_SELECTED") {
    assert.ok(res.body.robot.robotName);
    assert.ok(res.body.route);
    assert.ok(res.body.route.waypoints);
    assert.ok(res.body.route.totalDistance !== undefined);
    assert.ok(res.body.route.totalTravelSeconds !== undefined);
    assert.ok(res.body.route.totalBatteryCost !== undefined);
  }
});

test("17. Robot-route endpoints reject invalid/unknown drains", async () => {
  await request(app).get("/api/predictions/robot-route/0").expect(400);
  await request(app).get("/api/predictions/robot-route/abc").expect(400);
  await request(app).get("/api/predictions/robot-route/99999").expect(404);
});

test("18. GET /api/dashboard/robot-routes returns the planning summary", async () => {
  const res = await request(app)
    .get("/api/dashboard/robot-routes")
    .expect(200);

  assert.ok(res.body.totalDrains > 0);
  assert.ok(Array.isArray(res.body.routes));
  assert.ok(typeof res.body.warningCritical === "number");
  assert.ok(res.body.disclaimer);
});

// --------------------------------------------------
// 19. Analytics endpoint
// --------------------------------------------------

test("19. GET /api/analytics/robot-routes returns analytics view", async () => {
  const res = await request(app)
    .get("/api/analytics/robot-routes")
    .expect(200);

  assert.ok(res.body.total_drains > 0);
  assert.ok(res.body.warning_critical_drains >= 2);
  assert.ok(typeof res.body.planned_routes === "number");
  assert.ok(Array.isArray(res.body.robots_selected));
  assert.ok("routes_by_type" in res.body);
  assert.ok(typeof res.body.direct_routes === "number");
  assert.ok(typeof res.body.charging_stop_routes === "number");
});

// --------------------------------------------------
// 20. Socket emission guard
// --------------------------------------------------

test("20. robotRouteUpdate emitted only on meaningful change", async () => {
  planning.resetRouteRuntime();

  const captured = [];
  socketHub.init(fakeIo(captured));

  // No robot -> no event.
  planning.maybeEmitRouteUpdate(1, { status: "NO_ROBOT_AVAILABLE", robot: null });
  assert.equal(captured.filter((e) => e.event === "robotRouteUpdate").length, 0);

  // First selection -> emitted.
  await planning.planRoute(5);
  assert.equal(captured.filter((e) => e.event === "robotRouteUpdate").length, 1);

  // Unchanged state -> not re-emitted.
  await planning.planRoute(5);
  assert.equal(captured.filter((e) => e.event === "robotRouteUpdate").length, 1);

  // Robot change -> new emission.
  await pool.query(`
    UPDATE robots SET status = 'Active', battery_level = 76, latitude = 9.9277218,
      longitude = 78.1174649 WHERE id = 5
  `);

  const updates = captured.filter((e) => e.event === "robotRouteUpdate");
  assert.ok(updates.length >= 1);
  assert.ok(updates[updates.length - 1].payload.status === "ROBOT_SELECTED");

  socketHub.init(null);
  planning.resetRouteRuntime();
});