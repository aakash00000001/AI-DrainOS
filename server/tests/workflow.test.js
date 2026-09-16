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

test("POST /api/drains persists latitude and longitude", async () => {
  const res = await request(app)
    .post("/api/drains")
    .set("Authorization", `Bearer ${token}`)
    .send({
      zone_name: "Zone X",
      location: "Coordinates Test",
      status: "Warning",
      blockage_level: 40,
      latitude: 9.9566,
      longitude: 78.1039
    });

  assert.equal(res.status, 201);

  const all = await request(app).get("/api/drains");
  const created = all.body.find((d) => d.location === "Coordinates Test");

  assert.ok(created);
  assert.equal(Number(created.latitude), 9.9566);
  assert.equal(Number(created.longitude), 78.1039);
});

test("PUT /api/drains to Normal resolves open alerts", async () => {
  const drain = await pool.query(
    "SELECT id FROM drains WHERE location = 'Bypass Road'"
  );
  const drainId = drain.rows[0].id;

  const before = await pool.query(
    "SELECT * FROM alerts WHERE drain_id = $1",
    [drainId]
  );

  assert.ok(
    before.rows.some((a) => a.alert_status === "Open")
  );

  const putRes = await request(app)
    .put(`/api/drains/${drainId}`)
    .set("Authorization", `Bearer ${token}`)
    .send({ status: "Normal" });

  assert.equal(putRes.status, 200);

  const after = await pool.query(
    "SELECT * FROM alerts WHERE drain_id = $1",
    [drainId]
  );

  assert.ok(
    after.rows.every((a) => a.alert_status === "Resolved")
  );
});

test("GET /api/analytics returns real seeded metrics", async () => {

  const expectedBlockages = Number(
    (await pool.query(
      "SELECT COUNT(*)::int AS count FROM alerts WHERE severity = 'Critical' AND alert_status = 'Open'"
    )).rows[0].count
  );

  const res = await request(app).get("/api/analytics");

  assert.equal(res.status, 200);
  assert.equal(res.body.total_cleanings, 3);
  assert.equal(res.body.robot_operations, 3);
  assert.equal(res.body.flood_predictions, 7);
  assert.equal(res.body.blockages_detected, expectedBlockages);
  assert.ok(res.body.total_drains >= 7);
});

test("GET /api/analytics/monthly returns sensor-derived series", async () => {
  const res = await request(app).get("/api/analytics/monthly");

  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));

  if (res.body.length > 0) {
    const row = res.body[0];
    assert.ok(row.month);
    assert.ok(Number.isFinite(Number(row.avg_water)));
    assert.ok(Number(row.readings) >= 1);
  }
});