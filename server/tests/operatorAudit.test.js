// ============================================================
// AI-DrainOS — Operator Audit API tests (UPDATE #27)
//
// Covers the admin-only guard, the read endpoints, filters,
// validation, the wiring of real mutation routes into the trail,
// and the mount precedence over the decision audit router.
// ============================================================

const { test, before, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const { setup } = require("./helpers");

let app;
let pool;
let adminToken;
let operatorToken;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

before(async () => {
  ({ app, pool } = await setup());

  const adminLogin = await request(app).post("/api/auth/login").send({
    email: "admin@aidrain.com",
    password: "admin123"
  });
  adminToken = adminLogin.body.token;

  const operatorLogin = await request(app).post("/api/auth/login").send({
    email: "operator@aidrain.com",
    password: "operator123"
  });
  operatorToken = operatorLogin.body.token;
});

beforeEach(async () => {
  await pool.query("TRUNCATE operator_audits");
});

after(async () => {
  await pool.end();
});

// ------------------------------------------------------------
// Authorization
// ------------------------------------------------------------

test("GET /api/audit/operator requires a token", async () => {
  const res = await request(app).get("/api/audit/operator");
  assert.equal(res.status, 401);
});

test("GET /api/audit/operator is admin-only (Operator role gets 403)", async () => {
  const res = await request(app)
    .get("/api/audit/operator")
    .set("Authorization", `Bearer ${operatorToken}`);
  assert.equal(res.status, 403);
});

test("GET /api/audit/operator/summary and detail are also admin-only", async () => {
  const summary = await request(app)
    .get("/api/audit/operator/summary")
    .set("Authorization", `Bearer ${operatorToken}`);
  assert.equal(summary.status, 403);

  const detail = await request(app)
    .get("/api/audit/operator/1")
    .set("Authorization", `Bearer ${operatorToken}`);
  assert.equal(detail.status, 403);
});

// ------------------------------------------------------------
// Read endpoints (admin)
// ------------------------------------------------------------

test("GET /api/audit/operator returns READY with an empty list on a clean trail", async () => {
  const res = await request(app)
    .get("/api/audit/operator")
    .set("Authorization", `Bearer ${adminToken}`);

  assert.equal(res.status, 200);
  assert.equal(res.body.status, "READY");
  assert.equal(res.body.page, 1);
  assert.deepEqual(res.body.audits, []);
});

test("GET /api/audit/operator clamps an invalid limit to the default", async () => {
  const res = await request(app)
    .get("/api/audit/operator?limit=abc&page=abc")
    .set("Authorization", `Bearer ${adminToken}`);

  assert.equal(res.status, 200);
  assert.equal(res.body.limit, 20);
  assert.equal(res.body.page, 1);
});

test("GET /api/audit/operator rejects invalid filters", async () => {
  const badAction = await request(app)
    .get("/api/audit/operator?action=BOGUS")
    .set("Authorization", `Bearer ${adminToken}`);
  assert.equal(badAction.status, 400);

  const badEntity = await request(app)
    .get("/api/audit/operator?entityType=BOGUS")
    .set("Authorization", `Bearer ${adminToken}`);
  assert.equal(badEntity.status, 400);

  const badId = await request(app)
    .get("/api/audit/operator?entityId=abc")
    .set("Authorization", `Bearer ${adminToken}`);
  assert.equal(badId.status, 400);
});

test("GET /api/audit/operator/summary returns 200 on a clean trail", async () => {
  const res = await request(app)
    .get("/api/audit/operator/summary")
    .set("Authorization", `Bearer ${adminToken}`);

  assert.equal(res.status, 200);
  assert.equal(res.body.status, "READY");
  assert.equal(res.body.summary.total, 0);
});

test("GET /api/audit/operator/:id returns 404 for missing records", async () => {
  const res = await request(app)
    .get("/api/audit/operator/999999")
    .set("Authorization", `Bearer ${adminToken}`);

  assert.equal(res.status, 404);
});

// ------------------------------------------------------------
// End-to-end wiring of real mutation routes
// ------------------------------------------------------------

test("DRAIN_CREATE is recorded when an operator creates a drain", async () => {
  const create = await request(app)
    .post("/api/drains")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({
      zone_name: "Audit Zone",
      location: "Test Block",
      status: "Normal",
      blockage_level: 10,
      latitude: 9.9,
      longitude: 78.1
    });

  assert.equal(create.status, 201);

  await sleep(60);

  const list = await request(app)
    .get("/api/audit/operator")
    .set("Authorization", `Bearer ${adminToken}`);

  assert.equal(list.body.audits.length, 1);
  const audit = list.body.audits[0];
  assert.equal(audit.action, "DRAIN_CREATE");
  assert.equal(audit.entityType, "DRAIN");
  assert.equal(audit.entityId, create.body.id);
  assert.equal(audit.userEmail, "admin@aidrain.com");
  assert.equal(audit.beforeData, null);
  assert.equal(audit.afterData.zone_name, "Audit Zone");
});

test("SETTINGS_UPDATE is recorded with masked before/after settings", async () => {
  const update = await request(app)
    .put("/api/settings")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ warning_threshold: "60" });

  assert.equal(update.status, 200);

  await sleep(60);

  const list = await request(app)
    .get("/api/audit/operator?action=SETTINGS_UPDATE")
    .set("Authorization", `Bearer ${adminToken}`);

  assert.equal(list.body.audits.length, 1);
  const audit = list.body.audits[0];
  assert.equal(audit.entityType, "SETTINGS");
  assert.equal(audit.beforeData.warning_threshold, "50");
  assert.equal(audit.afterData.warning_threshold, "60");
});

test("records are filterable and visible in the summary", async () => {
  await request(app)
    .put("/api/settings")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ warning_threshold: "61" });
  await sleep(60);

  const summary = await request(app)
    .get("/api/audit/operator/summary")
    .set("Authorization", `Bearer ${adminToken}`);

  assert.equal(summary.body.summary.total, 1);
  assert.equal(summary.body.summary.byAction.SETTINGS_UPDATE, 1);
  assert.equal(summary.body.summary.byEntityType.SETTINGS, 1);
});

// ------------------------------------------------------------
// Mount precedence + read-only guarantee
// ------------------------------------------------------------

test("the decision audit router still serves /api/audit correctly", async () => {
  const res = await request(app).get("/api/audit");
  assert.equal(res.status, 200);
  assert.equal(res.body.status, "READY");
});

test("operator audit endpoints are strictly read-only", async () => {
  const post = await request(app)
    .post("/api/audit/operator")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ action: "DRAIN_CREATE" });
  assert.equal(post.status, 404);

  const del = await request(app)
    .delete("/api/audit/operator/1")
    .set("Authorization", `Bearer ${adminToken}`);
  assert.equal(del.status, 404);
});