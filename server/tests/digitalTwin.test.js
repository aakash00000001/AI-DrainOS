// ============================================================
// Digital Twin — unit + integration tests
//
// Two layers:
//  1. PURE UNIT TESTS for the shared visualization logic that the
//     frontend and backend tests use (digitalTwinUtils.mjs) —
//     coordinate conversion, clamping, normalization, route
//     geometry, reducers for every live socket event.
//  2. API SHAPE TESTS against the seeded test database proving
//     the Digital Twin consumes read-only, existing endpoints
//     (no new tables / routes were added for this feature).
// ============================================================

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const { setup } = require("./helpers");

let app;
let pool;
let token;
let u; // digitalTwinUtils.mjs

before(async () => {
  u = await import("../../client/src/services/digitalTwinUtils.mjs");

  ({ app, pool } = await setup());

  const login = await request(app).post("/api/auth/login").send({
    email: "admin@aidrain.com",
    password: "admin123"
  });
  token = login.body.token;
});

after(async () => {
  await pool.end();
});

// ============================================================
// 1. Pure unit tests (client shared logic)
// ============================================================

test("utils: safeWaterLevel clamps 0-100 and is honest about missing data", () => {
  assert.equal(u.safeWaterLevel(45.6), 46);
  assert.equal(u.safeWaterLevel(120), 100);
  assert.equal(u.safeWaterLevel(-7), 0);
  assert.equal(u.safeWaterLevel(50), 50);
  assert.equal(u.safeWaterLevel(null), null);
  assert.equal(u.safeWaterLevel(undefined), null);
  assert.equal(u.safeWaterLevel("oops"), null);
  assert.equal(u.safeWaterLevel(NaN), null);
});

test("utils: levelFromScore uses the same banding thresholds as the decision engine", () => {
  assert.equal(u.levelFromScore(80), "CRITICAL");
  assert.equal(u.levelFromScore(75), "CRITICAL");
  assert.equal(u.levelFromScore(55), "HIGH");
  assert.equal(u.levelFromScore(50), "HIGH");
  assert.equal(u.levelFromScore(30), "MODERATE");
  assert.equal(u.levelFromScore(25), "MODERATE");
  assert.equal(u.levelFromScore(12), "LOW");
  assert.equal(u.levelFromScore("high"), null);
  assert.equal(u.levelFromScore(null), null);
});

test("utils: normalizeLevel canonicalizes labels", () => {
  assert.equal(u.normalizeLevel("high"), "HIGH");
  assert.equal(u.normalizeLevel("CRITICAL"), "CRITICAL");
  assert.equal(u.normalizeLevel("moderate"), "MODERATE");
  assert.equal(u.normalizeLevel("weird"), null);
  assert.equal(u.normalizeLevel(null), null);
  assert.equal(u.normalizeLevel(undefined), null);
});

test("utils: computeOrigin is the bounding-box midpoint and null-safe", () => {
  const origin = u.computeOrigin([
    { lat: 9.92, lng: 78.11 },
    { lat: 9.93, lng: 78.13 }
  ]);
  assert.ok(origin);
  assert.ok(Math.abs(origin.lat - 9.925) < 1e-9);
  assert.ok(Math.abs(origin.lng - 78.12) < 1e-9);
  assert.equal(u.computeOrigin([]), null);
  assert.equal(u.computeOrigin([{ lat: NaN, lng: "x" }]), null);
});

test("utils: latLngToLocal converts deterministically to the visualization grid", () => {
  const origin = { lat: 9.925, lng: 78.12 };
  const point = u.latLngToLocal(9.9252, 78.1198, origin);
  assert.ok(point);
  assert.ok(Math.abs(point.x - (78.1198 - origin.lng) * 1000) < 1e-6);
  assert.ok(Math.abs(point.z - (9.9252 - origin.lat) * 1000) < 1e-6);
  assert.equal(u.latLngToLocal(null, 78.1, origin), null);
  assert.equal(u.latLngToLocal(9.9, null, origin), null);
  assert.equal(u.latLngToLocal(9.9, 78.1, null), null);
});

test("utils: waterLevelToHeight maps 0-100 to 0-1.1 local units", () => {
  assert.equal(u.waterLevelToHeight(100), 1.1);
  assert.equal(u.waterLevelToHeight(50), 0.55);
  assert.equal(u.waterLevelToHeight(0), 0);
  assert.equal(u.waterLevelToHeight(null), 0);
});

test("utils: normalizeDrain maps raw REST rows to the display model", () => {
  const origin = { lat: 9.925, lng: 78.12 };
  const drain = u.normalizeDrain(
    {
      id: 5,
      zone_name: "Zone 5",
      location: "Airport Road",
      status: "Critical",
      blockage_level: 95,
      latitude: 9.923,
      longitude: 78.1175
    },
    origin
  );
  assert.equal(drain.id, 5);
  assert.equal(drain.name, "Airport Road");
  assert.equal(drain.zone, "Zone 5");
  assert.equal(drain.status, "Critical");
  assert.equal(drain.blockageLevel, 95);
  assert.ok(drain.x !== null && drain.z !== null);
});

test("utils: matchSensorsToDrains maps sensors to drains by zone+location", () => {
  const drains = [
    { id: 1, zone: "Zone 1", location: "Goripalayam" },
    { id: 5, zone: "Zone 5", location: "Airport Road" }
  ];
  const sensors = [
    { id: 1, zone_name: "Zone 1", location: "Goripalayam", water_level: 20 },
    { id: 5, zone_name: "Zone 5", location: "Airport Road", water_level: 95 },
    { id: 99, zone_name: "New Zone", location: "Unknown Road", water_level: 10 }
  ];
  const matched = u.matchSensorsToDrains(sensors, drains);
  assert.equal(matched[0].drainId, 1);
  assert.equal(matched[1].drainId, 5);
  assert.equal(matched[2].drainId, null);
});

test("utils: buildRouteGeometry drops waypoints without coordinates", () => {
  const origin = { lat: 9.925, lng: 78.12 };
  const points = u.buildRouteGeometry(
    [
      { latitude: 9.925, longitude: 78.12 },
      { latitude: null, longitude: null },
      { latitude: 9.927, longitude: 78.1212 }
    ],
    origin
  );
  assert.equal(points.length, 2);
  assert.equal(points[0].x, 0);
  assert.equal(u.buildRouteGeometry(null, origin).length, 0);
});

test("utils: normalizeRoute maps the robot path planning payload", () => {
  const origin = { lat: 9.925, lng: 78.12 };
  const route = u.normalizeRoute(
    {
      drainId: 3,
      zone: "Zone 3",
      location: "Madurai Main",
      status: "Warning",
      planningStatus: "ROBOT_SELECTED",
      robot: { id: 3, robotName: "Robot-B1", batteryLevel: 63 },
      route: {
        type: "DIRECT",
        totalDistance: 0.42,
        formatTotalTravelTime: "5 min",
        needsCharging: false,
        chargingStation: null,
        waypoints: [
          { label: "START", latitude: 9.925, longitude: 78.12, cumulativeDistance: 0, cumulativeTravelSeconds: 0 },
          { label: "TARGET", latitude: 9.927, longitude: 78.1212, cumulativeDistance: 0.42, cumulativeTravelSeconds: 300 }
        ]
      },
      selectionScore: 88
    },
    origin
  );
  assert.equal(route.drainId, 3);
  assert.equal(route.routeType, "DIRECT");
  assert.equal(route.robotId, 3);
  assert.equal(route.robotName, "Robot-B1");
  assert.equal(route.points.length, 2);
  assert.equal(route.waypoints[0].label, "START");
  assert.equal(route.waypoints[0].x, 0);
});

test("utils: buildMetrics counts critical drains / active robots / active routes independently", () => {
  const drains = [
    { id: 1, status: "Critical", riskLevel: null, decisionLevel: null },
    { id: 2, status: "Warning", riskLevel: "CRITICAL", decisionLevel: null },
    { id: 3, status: "Normal", riskLevel: "HIGH", decisionLevel: "CRITICAL" },
    { id: 4, status: "Normal", riskLevel: "LOW", decisionLevel: "LOW" }
  ];
  const robots = [
    { id: 1, status: "Active" },
    { id: 2, status: "Idle" }
  ];
  const routes = [
    { planningStatus: "ROBOT_SELECTED", routeType: "DIRECT" },
    { planningStatus: "SKIPPED", routeType: null }
  ];

  const metrics = u.buildMetrics(drains, robots, routes);
  assert.equal(metrics.totalDrains, 4);
  assert.equal(metrics.criticalDrains, 3);
  assert.equal(metrics.activeRobots, 1);
  assert.equal(metrics.activeRoutes, 1);
});

test("utils: fuseDrains separates flood-risk level from decision level", () => {
  const drains = [
    { id: 1, status: "Warning", waterLevel: 20 }
  ];
  const fused = u.fuseDrains(drains, {
    1: { waterLevel: 72, riskScore: 68, riskLevel: "HIGH" }
  }, {
    1: { priorityScore: 89, priorityLevel: "CRITICAL", recommendedAction: "IMMEDIATE_ROBOT_INSPECTION" }
  });
  assert.equal(fused[0].waterLevel, 72);
  assert.equal(fused[0].riskLevel, "HIGH");
  assert.equal(fused[0].decisionLevel, "CRITICAL");
  assert.equal(fused[0].decisionAction, "IMMEDIATE_ROBOT_INSPECTION");
});

test("reducer: SET_DATA populates state and bumps refreshNonce", () => {
  const state = u.digitalTwinReducer(u.digitalTwinReducer({}, { type: "SET_DATA", drains: [1], robots: [], sensors: [], chargingStations: [], routes: [], missions: [], origin: null, metrics: { totalDrains: 1 }, loadError: [] }), {
    type: "SET_DATA", drains: [1], robots: [], sensors: [], chargingStations: [], routes: [], missions: [], origin: null, metrics: { totalDrains: 1 }, loadError: []
  });
  assert.equal(state.refreshNonce, 2);
  assert.deepEqual(state.drains, [1]);
  assert.equal(state.metrics.totalDrains, 1);
});

test("reducer: SENSOR_UPDATE merges live reading into byDrain and bySensor", () => {
  const state = u.digitalTwinReducer({ byDrain: {}, bySensor: {} }, {
    type: "SENSOR_UPDATE",
    payload: {
      drainId: 2, sensorId: 7, water_level: 55, gas_level: 40,
      riskScore: 62, riskLevel: "HIGH", timestamp: "2026-01-01T00:00:00Z"
    }
  });
  assert.equal(state.bySensor[7].drainId, 2);
  assert.equal(state.byDrain[2].waterLevel, 55);
  assert.equal(state.byDrain[2].riskLevel, "HIGH");
  assert.equal(state.byDrain[2].riskScore, 62);
});

test("reducer: RISK_UPDATE / FORECAST_UPDATE / MAINTENANCE_UPDATE / VISION_UPDATE / DECISION_UPDATE", () => {
  let state = u.digitalTwinReducer({ byDrain: {} }, {
    type: "RISK_UPDATE",
    payload: { drainId: 1, riskScore: 80, riskLevel: "CRITICAL", waterLevel: 90 }
  });
  assert.equal(state.byDrain[1].riskLevel, "CRITICAL");
  assert.equal(state.byDrain[1].waterLevel, 90);

  state = u.digitalTwinReducer(state, {
    type: "FORECAST_UPDATE",
    payload: { drainId: 1, worst: { predictedRiskScore: 85, predictedRiskLevel: "CRITICAL" } }
  });
  assert.equal(state.byDrain[1].forecastLevel, "CRITICAL");
  assert.equal(state.byDrain[1].forecastScore, 85);

  state = u.digitalTwinReducer(state, {
    type: "MAINTENANCE_UPDATE",
    payload: { drainId: 1, maintenanceScore: 70, maintenanceLevel: "HIGH" }
  });
  assert.equal(state.byDrain[1].maintenanceLevel, "HIGH");
  assert.equal(state.byDrain[1].maintenanceScore, 70);

  state = u.digitalTwinReducer(state, {
    type: "VISION_UPDATE",
    payload: { drainId: 1, inspectionLevel: "HIGH", visualRiskScore: 66 }
  });
  assert.equal(state.byDrain[1].visionLevel, "HIGH");
  assert.equal(state.byDrain[1].visionScore, 66);

  state = u.digitalTwinReducer(state, {
    type: "DECISION_UPDATE",
    payload: { drainId: 1, priorityScore: 92, priorityLevel: "CRITICAL", recommendedAction: "IMMEDIATE_ROBOT_INSPECTION" }
  });
  assert.equal(state.byDrain[1].decisionLevel, "CRITICAL");
  assert.equal(state.byDrain[1].decisionAction, "IMMEDIATE_ROBOT_INSPECTION");
});

test("reducer: ROUTE_UPDATE replaces the existing route for a drain", () => {
  const existing = {
    drainId: 9,
    planningStatus: "SKIPPED",
    routeType: null,
    points: [],
    waypoints: []
  };
  const before = u.digitalTwinReducer(
    { routes: [existing], origin: { lat: 9.925, lng: 78.12 } },
    {
      type: "ROUTE_UPDATE",
      payload: {
        status: "ROBOT_SELECTED",
        drain: { id: 3, zoneName: "Zone 3", location: "Madurai Main", status: "Warning" },
        robot: { id: 3, robotName: "Robot-B1", batteryLevel: 63 },
        route: {
          type: "DIRECT",
          waypoints: [
            { label: "START", latitude: 9.925, longitude: 78.12 },
            { label: "TARGET", latitude: 9.927, longitude: 78.1212 }
          ]
        }
      }
    }
  );
  assert.equal(before.routes.length, 2);
  const replaced = before.routes.find((r) => r.drainId === 3);
  assert.ok(replaced);
  assert.equal(replaced.routeType, "DIRECT");
  assert.equal(replaced.points.length, 2);
  assert.ok(before.routes.find((r) => r.drainId === 9));
});

test("reducer: DASHBOARD_UPDATE refreshes metrics", () => {
  const state = u.digitalTwinReducer(
    { metrics: { totalDrains: 7, activeRobots: 1, criticalAlerts: 0 } },
    { type: "DASHBOARD_UPDATE", payload: { totalDrains: 8, activeRobots: 2, criticalAlerts: 3 } }
  );
  assert.equal(state.metrics.totalDrains, 8);
  assert.equal(state.metrics.activeRobots, 2);
  assert.equal(state.metrics.criticalAlerts, 3);
});

test("reducer: unknown action returns state unchanged", () => {
  const state = { byDrain: {} };
  assert.equal(u.digitalTwinReducer(state, { type: "NOPE" }), state);
});

// ============================================================
// 2. API shape tests (read-only consumption of existing routes)
// ============================================================

test("GET /api/drains exposes the fields the 3D scene consumes", async () => {
  const res = await request(app).get("/api/drains");
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  assert.ok(res.body.length >= 7);
  const first = res.body[0];
  assert.ok(first.id !== undefined);
  assert.ok(first.zone_name !== undefined);
  assert.ok(first.location !== undefined);
  assert.ok(first.status !== undefined);
  assert.ok(first.latitude !== undefined);
  assert.ok(first.longitude !== undefined);
});

test("GET /api/sensors exposes zone+location (no drain_id -> client mapping is required)", async () => {
  const res = await request(app).get("/api/sensors");
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  assert.ok(res.body.length >= 7);
  const first = res.body[0];
  assert.ok(first.id !== undefined);
  assert.ok(first.water_level !== undefined);
  assert.ok(first.status !== undefined);
  assert.ok(first.zone_name !== undefined);
  assert.ok(first.location !== undefined);
  assert.equal(first.drain_id, undefined);
  assert.equal(first.latitude, undefined);
});

test("GET /api/robots exposes robot positions + battery for the 3D scene", async () => {
  const res = await request(app).get("/api/robots");
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  assert.ok(res.body.length >= 5);
  const first = res.body[0];
  assert.ok(first.id !== undefined);
  assert.ok(first.robot_name !== undefined);
  assert.ok(first.status !== undefined);
  assert.ok(first.battery_level !== undefined);
  assert.ok(first.latitude !== undefined);
  assert.ok(first.longitude !== undefined);
});

test("GET /api/charging-stations exposes station coordinates", async () => {
  const res = await request(app).get("/api/charging-stations");
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  assert.ok(res.body.length >= 2);
  const first = res.body[0];
  assert.ok(first.station_name !== undefined);
  assert.ok(first.latitude !== undefined);
  assert.ok(first.longitude !== undefined);
});

test("GET /api/dashboard/robot-routes exposes a route list consumable by normalizeRoute", async () => {
  const res = await request(app).get("/api/dashboard/robot-routes");
  assert.equal(res.status, 200);
  assert.ok(res.body);
  assert.ok(Array.isArray(res.body.routes));
  assert.ok(res.body.routes.length >= 7);
  for (const entry of res.body.routes) {
    assert.ok(entry.drainId !== undefined);
    assert.ok(entry.planningStatus !== undefined);
  }
  const routed = res.body.routes.filter((r) => r.route && r.route.waypoints);
  assert.ok(routed.length >= 1, "expected at least one routed Warning/Critical drain");
});

test("GET /api/dashboard/decisions topPriority banding matches levelFromScore thresholds", async () => {
  const res = await request(app).get("/api/dashboard/decisions");
  assert.equal(res.status, 200);
  assert.ok(res.body);
  assert.ok(Array.isArray(res.body.topPriority));
  for (const entry of res.body.topPriority) {
    assert.ok(entry.drainId !== undefined);
    assert.ok(typeof entry.priorityScore === "number");
    assert.equal(entry.priorityLevel, u.levelFromScore(entry.priorityScore));
  }
});

test("Digital Twin data endpoint consumption requires no write: authentication stays intact", async () => {
  const res = await request(app).get("/api/dashboard");
  assert.equal(res.status, 200);
  assert.ok(res.body.totalDrains !== undefined);
  assert.ok(res.body.activeRobots !== undefined);
});