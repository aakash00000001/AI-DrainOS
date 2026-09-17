// ============================================================
// AI-DrainOS Incidents API tests (REST + Socket.IO behaviour)
//
// Cover the /api/incidents endpoints, lifecycle transitions over
// HTTP with consistent status codes, filters, the additive
// dashboard/analytics incident fields, and incidentUpdate socket
// events emitted through the SHARED socketHub (single Socket.IO
// server - never a second one).
// ============================================================

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const { setup } = require("./helpers");

let app;
let pool;
let token;
let decisionEngine;
let socketHub;

const captured = [];

const fakeIo = {
  emit(event, payload) {
    captured.push({ event, payload });
  }
};

const incidentEvents = () => captured.filter((e) => e.event === "incidentUpdate");

before(async () => {
  ({ app, pool } = await setup());

  decisionEngine = require("../services/decisionEngine");
  socketHub = require("../services/socketHub");
  socketHub.init(fakeIo);

  const login = await request(app).post("/api/auth/login").send({
    email: "admin@aidrain.com",
    password: "admin123"
  });
  token = login.body.token;
});

after(async () => {
  socketHub.init(null);
  await pool.end();
});

// --------------------------------------------------
// Read endpoints on an empty table
// --------------------------------------------------

test("1. GET /api/incidents returns an empty list initially", async () => {
  const res = await request(app).get("/api/incidents");
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  assert.equal(res.body.length, 0);
});

test("2. GET /api/incidents/active returns an empty list initially", async () => {
  const res = await request(app).get("/api/incidents/active");
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  assert.equal(res.body.length, 0);
});

test("3. GET /api/incidents/:id and :id/timeline 404 for missing incidents", async () => {
  const res = await request(app).get("/api/incidents/999999");
  assert.equal(res.status, 404);

  const timeline = await request(app).get("/api/incidents/999999/timeline");
  assert.equal(timeline.status, 404);
});

// --------------------------------------------------
// Creation - auth + validation
// --------------------------------------------------

test("4. POST /api/incidents requires authentication", async () => {
  const res = await request(app).post("/api/incidents").send({ drain_id: 1, source: "MANUAL" });
  assert.equal(res.status, 401);
});

test("5. POST /api/incidents rejects an invalid drain id", async () => {
  const res = await request(app)
    .post("/api/incidents")
    .set("Authorization", `Bearer ${token}`)
    .send({ drain_id: "abc", source: "MANUAL" });

  assert.equal(res.status, 400);
  assert.equal(res.body.code, "INVALID_DRAIN_ID");
});

test("6. POST /api/incidents rejects an unknown drain", async () => {
  const res = await request(app)
    .post("/api/incidents")
    .set("Authorization", `Bearer ${token}`)
    .send({ drain_id: 999999, source: "MANUAL" });

  assert.equal(res.status, 404);
  assert.equal(res.body.code, "DRAIN_NOT_FOUND");
});

test("7. POST /api/incidents creates a manual incident (201) and emits incidentUpdate", async () => {
  const res = await request(app)
    .post("/api/incidents")
    .set("Authorization", `Bearer ${token}`)
    .send({
      drain_id: 1,
      source: "MANUAL",
      title: "Market area overflow risk",
      description: "Operator reported standing water"
    });

  assert.equal(res.status, 201);
  assert.ok(res.body.id);
  assert.equal(res.body.status, "OPEN");
  assert.equal(res.body.source, "MANUAL");
  assert.equal(res.body.severity, "HIGH");
  assert.equal(res.body.drain_id, 1);
  assert.ok(res.body.created_at);
  assert.equal(res.body.drain.location, "Goripalayam");
  assert.ok(res.body.drain.zone);

  const events = incidentEvents();
  assert.ok(events.some((e) => e.payload.eventType === "created"));
});

test("8. POST /api/incidents prevents a duplicate active incident (409)", async () => {
  const res = await request(app)
    .post("/api/incidents")
    .set("Authorization", `Bearer ${token}`)
    .send({ drain_id: 1, source: "MANUAL" });

  assert.equal(res.status, 409);
  assert.equal(res.body.code, "DUPLICATE_ACTIVE_INCIDENT");
  assert.ok(res.body.incident);
});

// --------------------------------------------------
// AI_DECISION integration - uses the real Decision Engine
// --------------------------------------------------

test("9. POST /api/incidents AI_DECISION uses the real CRITICAL decision", async () => {
  const decision = await decisionEngine.getDrainDecision(5);
  assert.equal(decision.status, "READY");
  assert.equal(decision.priorityLevel, "CRITICAL");

  const res = await request(app)
    .post("/api/incidents")
    .set("Authorization", `Bearer ${token}`)
    .send({ drain_id: 5, source: "AI_DECISION" });

  assert.equal(res.status, 201);
  assert.equal(res.body.source, "AI_DECISION");
  assert.equal(res.body.severity, "CRITICAL");
  assert.equal(res.body.decision_level, "CRITICAL");
  assert.equal(res.body.decision_score, decision.priorityScore);
  assert.ok(res.body.assigned_robot_id !== null || res.body.route_status === "NO_ROBOT_AVAILABLE");
  assert.ok(res.body.route_status, "expected an honest route_status");
  assert.ok(res.body.created_at);
});

test("10. Duplicate AI_DECISION incident for the same drain is rejected (409)", async () => {
  const res = await request(app)
    .post("/api/incidents")
    .set("Authorization", `Bearer ${token}`)
    .send({ drain_id: 5, source: "AI_DECISION" });

  assert.equal(res.status, 409);
  assert.equal(res.body.code, "DUPLICATE_ACTIVE_INCIDENT");
});

test("11. AI_DECISION incidents depend on the real decision level", async () => {
  // The seeded critical drain (2) drives a real engine decision; the
  // incident service must accept only the real CRITICAL result and
  // never fabricate severity.
  const decision = await decisionEngine.getDrainDecision(2);
  const isCritical = decision && decision.status === "READY" && decision.priorityLevel === "CRITICAL";

  const res = await request(app)
    .post("/api/incidents")
    .set("Authorization", `Bearer ${token}`)
    .send({ drain_id: 2, source: "AI_DECISION" });

  if (isCritical) {
    assert.equal(res.status, 201);
    assert.equal(res.body.decision_level, "CRITICAL");
  } else {
    assert.equal(res.status, 409);
    assert.ok(["NOT_CRITICAL", "NO_VALID_DECISION"].includes(res.body.code));
  }
});

// --------------------------------------------------
// Filters
// --------------------------------------------------

test("12. GET /api/incidents supports status / severity / drain_id filters", async () => {
  const open = await request(app).get("/api/incidents?status=OPEN");
  assert.equal(open.status, 200);
  assert.ok(open.body.length >= 1);
  assert.ok(open.body.every((i) => i.status === "OPEN"));

  const critical = await request(app).get("/api/incidents?severity=CRITICAL");
  assert.equal(critical.status, 200);
  assert.ok(critical.body.every((i) => i.severity === "CRITICAL"));

  const oneDrain = await request(app).get("/api/incidents?drain_id=1");
  assert.equal(oneDrain.body.length, 1);
  assert.equal(oneDrain.body[0].drain_id, 1);
});

test("13. GET /api/incidents/active returns only active incidents", async () => {
  const res = await request(app).get("/api/incidents/active");
  assert.equal(res.status, 200);
  assert.ok(res.body.length >= 1);
  assert.ok(res.body.every((i) => ["OPEN", "ACKNOWLEDGED", "RESPONDING"].includes(i.status)));
});

// --------------------------------------------------
// Lifecycle over HTTP
// --------------------------------------------------

test("14. Full lifecycle: acknowledge -> respond -> resolve with notes", async () => {
  const created = await request(app)
    .post("/api/incidents")
    .set("Authorization", `Bearer ${token}`)
    .send({ drain_id: 3, source: "MANUAL", description: "Lifecycle sample" });

  assert.equal(created.status, 201);
  const id = created.body.id;

  const ack = await request(app)
    .put(`/api/incidents/${id}/acknowledge`)
    .set("Authorization", `Bearer ${token}`);

  assert.equal(ack.status, 200);
  assert.equal(ack.body.status, "ACKNOWLEDGED");
  assert.ok(ack.body.acknowledged_at);

  const respond = await request(app)
    .put(`/api/incidents/${id}/respond`)
    .set("Authorization", `Bearer ${token}`);

  assert.equal(respond.status, 200);
  assert.equal(respond.body.status, "RESPONDING");
  assert.ok(respond.body.responding_at);

  const resolve = await request(app)
    .put(`/api/incidents/${id}/resolve`)
    .set("Authorization", `Bearer ${token}`)
    .send({ resolution_notes: "Water receded, drain cleared by team" });

  assert.equal(resolve.status, 200);
  assert.equal(resolve.body.status, "RESOLVED");
  assert.ok(resolve.body.resolved_at);
  assert.equal(resolve.body.resolution_notes, "Water receded, drain cleared by team");
});

test("15. Resolving an already-resolved incident is rejected (409)", async () => {
  const created = await request(app)
    .post("/api/incidents")
    .set("Authorization", `Bearer ${token}`)
    .send({ drain_id: 4, source: "MANUAL" });

  const first = await request(app)
    .put(`/api/incidents/${created.body.id}/resolve`)
    .set("Authorization", `Bearer ${token}`)
    .send({ resolution_notes: "resolved" });
  assert.equal(first.status, 200);

  const again = await request(app)
    .put(`/api/incidents/${created.body.id}/resolve`)
    .set("Authorization", `Bearer ${token}`)
    .send({ resolution_notes: "again" });

  assert.equal(again.status, 409);
  assert.equal(again.body.code, "ALREADY_RESOLVED");
});

test("16. Acknowledging/responding to a resolved incident is rejected (409)", async () => {
  const missing = await request(app)
    .put("/api/incidents/999991/acknowledge")
    .set("Authorization", `Bearer ${token}`);
  assert.equal(missing.status, 404);

  const created = await request(app)
    .post("/api/incidents")
    .set("Authorization", `Bearer ${token}`)
    .send({ drain_id: 7, source: "MANUAL" });
  const id = created.body.id;

  await request(app).put(`/api/incidents/${id}/resolve`).set("Authorization", `Bearer ${token}`);

  const ackResolved = await request(app)
    .put(`/api/incidents/${id}/acknowledge`)
    .set("Authorization", `Bearer ${token}`);
  assert.equal(ackResolved.status, 409);
  assert.equal(ackResolved.body.code, "INVALID_TRANSITION");
});

// --------------------------------------------------
// Timeline - stored timestamps only
// --------------------------------------------------

test("17. Timeline exposes real stored lifecycle events with timestamps", async () => {
  const created = await request(app)
    .post("/api/incidents")
    .set("Authorization", `Bearer ${token}`)
    .send({ drain_id: 6, source: "MANUAL", title: "Timeline incident" });

  const id = created.body.id;
  await request(app).put(`/api/incidents/${id}/acknowledge`).set("Authorization", `Bearer ${token}`);
  await request(app).put(`/api/incidents/${id}/respond`).set("Authorization", `Bearer ${token}`);
  await request(app)
    .put(`/api/incidents/${id}/resolve`)
    .set("Authorization", `Bearer ${token}`)
    .send({ resolution_notes: "all clear" });

  const timeline = await request(app).get(`/api/incidents/${id}/timeline`);
  assert.equal(timeline.status, 200);

  const events = timeline.body.map((e) => e.event);
  assert.ok(events.includes("incident created"));
  assert.ok(events.includes("acknowledged"));
  assert.ok(events.includes("response started"));
  assert.ok(events.includes("resolved"));

  for (const entry of timeline.body) {
    assert.ok(entry.at, "timeline entry must carry a real timestamp");
    assert.equal(new Date(entry.at).toString() !== "Invalid Date", true);
  }
});

// --------------------------------------------------
// Dashboard + analytics - additive
// --------------------------------------------------

test("18. GET /api/dashboard adds incident counts without breaking existing fields", async () => {
  const res = await request(app).get("/api/dashboard");

  assert.equal(res.status, 200);
  assert.ok(res.body.totalDrains !== undefined);
  assert.ok(res.body.activeRobots !== undefined);
  assert.ok(res.body.criticalAlerts !== undefined);

  assert.ok(res.body.incidents, "expected additive incidents block");
  assert.equal(typeof res.body.incidents.counts.active, "number");
  assert.equal(typeof res.body.incidents.counts.resolved, "number");
  assert.equal(typeof res.body.incidents.counts.responding, "number");
  assert.ok(Array.isArray(res.body.incidents.latest));

  const activeIncidents = res.body.incidents.counts.active;
  const activeList = await request(app).get("/api/incidents/active");
  assert.equal(activeIncidents, activeList.body.length);
});

test("19. GET /api/analytics/incidents reports real counts and averages", async () => {
  const res = await request(app).get("/api/analytics/incidents");
  assert.equal(res.status, 200);

  assert.equal(typeof res.body.total, "number");
  assert.ok(res.body.total >= 5);

  assert.deepEqual(Object.keys(res.body.by_severity).sort(), ["CRITICAL", "HIGH", "LOW", "MODERATE"]);
  assert.deepEqual(Object.keys(res.body.by_status).sort(), ["ACKNOWLEDGED", "OPEN", "RESOLVED", "RESPONDING"]);
  assert.ok(res.body.by_source.AI_DECISION !== undefined);
  assert.ok(res.body.by_source.MANUAL !== undefined);

  // Several incidents were resolved -> real resolution average exists.
  assert.equal(typeof res.body.average_resolution_seconds, "number");
  assert.equal(typeof res.body.average_resolution_minutes, "number");
  assert.ok(res.body.data_points.with_resolution_time >= 1);
});

// --------------------------------------------------
// Socket.IO behaviour (shared server, no second one)
// --------------------------------------------------

test("20. incidentUpdate events are emitted through the shared socketHub", async () => {
  const events = incidentEvents();
  const types = events.map((e) => e.payload.eventType);

  assert.ok(types.includes("created"), "expected a created event");
  assert.ok(types.includes("acknowledged"), "expected an acknowledged event");
  assert.ok(types.includes("responded"), "expected a responded event");
  assert.ok(types.includes("resolved"), "expected a resolved event");

  for (const entry of events) {
    assert.ok(entry.payload.incident, "incidentUpdate must carry the incident");
    assert.ok(entry.payload.incident.id);
  }
});