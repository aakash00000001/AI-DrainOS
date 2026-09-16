const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const { setup } = require("./helpers");

let app;
let pool;
let token;

before(async () => {
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

test("GET /api/drains returns seeded drains", async () => {
  const res = await request(app).get("/api/drains");
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  assert.ok(res.body.length >= 7);
  assert.equal(res.body[0].zone_name, "Zone 1");
});

test("POST /api/drains - requires auth", async () => {
  const res = await request(app).post("/api/drains").send({
    zone_name: "Zone X",
    location: "Test Area",
    status: "Normal",
    blockage_level: 10
  });

  assert.equal(res.status, 401);
});

test("POST /api/drains creates a drain", async () => {
  const res = await request(app)
    .post("/api/drains")
    .set("Authorization", `Bearer ${token}`)
    .send({
      zone_name: "Zone 99",
      location: "Test Colony",
      status: "Normal",
      blockage_level: 12,
      latitude: 9.92,
      longitude: 78.11
    });

  assert.equal(res.status, 201);
  assert.equal(res.body.location, "Test Colony");
});

test("PATCH /api/drains/:id/status - manual flag Critical", async () => {
  const res = await request(app)
    .patch("/api/drains/1/status")
    .set("Authorization", `Bearer ${token}`)
    .send({ status: "Critical" });

  assert.equal(res.status, 200);
  assert.equal(res.body.drain.status, "Critical");
});

test("PATCH /api/drains/:id/status - rejects invalid status", async () => {
  const res = await request(app)
    .patch("/api/drains/1/status")
    .set("Authorization", `Bearer ${token}`)
    .send({ status: "Broken" });

  assert.equal(res.status, 400);
});

test("PATCH /api/drains/:id/status - 404 for missing drain", async () => {
  const res = await request(app)
    .patch("/api/drains/99999/status")
    .set("Authorization", `Bearer ${token}`)
    .send({ status: "Critical" });

  assert.equal(res.status, 404);
});

test("PUT /api/drains/:id updates a drain", async () => {
  const res = await request(app)
    .put("/api/drains/1")
    .set("Authorization", `Bearer ${token}`)
    .send({
      zone_name: "Zone 1",
      location: "Goripalayam",
      status: "Normal",
      blockage_level: 25
    });

  assert.equal(res.status, 200);
  assert.equal(res.body.blockage_level, 25);
});

test("DELETE /api/drains/:id - requires auth", async () => {
  const res = await request(app).delete("/api/drains/1");
  assert.equal(res.status, 401);
});

test("DELETE /api/drains/:id deletes a drain", async () => {
  const create = await request(app)
    .post("/api/drains")
    .set("Authorization", `Bearer ${token}`)
    .send({
      zone_name: "Zone 98",
      location: "To Delete",
      status: "Normal",
      blockage_level: 5
    });

  const res = await request(app)
    .delete(`/api/drains/${create.body.id}`)
    .set("Authorization", `Bearer ${token}`);

  assert.equal(res.status, 200);

  const missing = await request(app).get(`/api/drains/${create.body.id}`);
  assert.equal(missing.status, 404);
});

test("POST /api/missions/dispatch - manually dispatches a robot", async () => {
  const res = await request(app)
    .post("/api/missions/dispatch")
    .set("Authorization", `Bearer ${token}`)
    .send({ robot_id: 2, drain_id: 2 });

  assert.equal(res.status, 201);
  assert.equal(res.body.mission.mission_status, "Assigned");
});

test("POST /api/missions/dispatch - rejects double dispatch", async () => {
  const res = await request(app)
    .post("/api/missions/dispatch")
    .set("Authorization", `Bearer ${token}`)
    .send({ robot_id: 2, drain_id: 2 });

  assert.equal(res.status, 400);
});

test("GET /api/missions/history returns completed missions", async () => {
  const res = await request(app).get("/api/missions/history");
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));

  res.body.forEach((m) => {
    assert.equal(m.mission_status, "Completed");
  });
});

test("POST /api/alerts creates an alert", async () => {
  const res = await request(app)
    .post("/api/alerts")
    .set("Authorization", `Bearer ${token}`)
    .send({
      drain_id: 1,
      alert_type: "Manual Test",
      message: "Manual alert created by test",
      severity: "Medium"
    });

  assert.equal(res.status, 201);
  assert.equal(res.body.alert_status, "Open");
});

test("POST /api/alerts - requires auth", async () => {
  const res = await request(app).post("/api/alerts").send({
    drain_id: 1,
    alert_type: "X",
    message: "Y"
  });

  assert.equal(res.status, 401);
});

test("PUT /api/alerts/:id resolves an alert", async () => {
  const create = await request(app)
    .post("/api/alerts")
    .set("Authorization", `Bearer ${token}`)
    .send({
      drain_id: 1,
      alert_type: "Manual Test 2",
      message: "Will be resolved",
      severity: "Low"
    });

  const res = await request(app)
    .put(`/api/alerts/${create.body.id}`)
    .set("Authorization", `Bearer ${token}`)
    .send({ alert_status: "Resolved" });

  assert.equal(res.status, 200);
  assert.equal(res.body.alert_status, "Resolved");
});

test("GET /api/settings returns settings", async () => {
  const res = await request(app).get("/api/settings");
  assert.equal(res.status, 200);
  assert.equal(res.body.critical_threshold, "80");
});

test("PUT /api/settings - operator forbidden, admin can update", async () => {
  const operatorLogin = await request(app).post("/api/auth/login").send({
    email: "operator@aidrain.com",
    password: "operator123"
  });

  const forbidden = await request(app)
    .put("/api/settings")
    .set("Authorization", `Bearer ${operatorLogin.body.token}`)
    .send({ critical_threshold: 90 });

  assert.equal(forbidden.status, 403);

  const ok = await request(app)
    .put("/api/settings")
    .set("Authorization", `Bearer ${token}`)
    .send({ critical_threshold: 90 });

  assert.equal(ok.status, 200);
  assert.equal(ok.body.settings.critical_threshold, "90");
});
