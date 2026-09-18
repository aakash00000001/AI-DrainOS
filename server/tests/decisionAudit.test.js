// ============================================================
// AI-DrainOS — Decision Audit API tests (UPDATE #24)
//
// Covers /api/audit* read endpoints, the auth-protected POST
// /api/audit/snapshot, validation, the append-only guarantee and
// the additive dashboard + analytics surfaces. The audit layer is
// read-only for everything other than explicit snapshots and it
// never opens incidents or dispatches robots.
// ============================================================

const { test, before, beforeEach, after } = require("node:test");
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

beforeEach(async () => {
  // TRUNCATE (not DELETE) because the table is append-only by design;
  // the append-only guarantee itself is asserted in the API tests below.
  await pool.query("TRUNCATE decision_audits");
});

after(async () => {
  await pool.end();
});

// ------------------------------------------------------------
// Read endpoints
// ------------------------------------------------------------

test("GET /api/audit returns READY with an empty list on a clean trail", async () => {
  const res = await request(app).get("/api/audit");

  assert.equal(res.status, 200);
  assert.equal(res.body.status, "READY");
  assert.equal(res.body.page, 1);
  assert.deepEqual(res.body.audits, []);
});

test("GET /api/audit clamps an invalid limit to the default", async () => {
  const res = await request(app).get("/api/audit?limit=abc&page=abc");

  assert.equal(res.status, 200);
  assert.equal(res.body.limit, 20);
  assert.equal(res.body.page, 1);
});

test("GET /api/audit rejects an invalid drainId", async () => {
  const res = await request(app).get("/api/audit?drainId=abc");
  assert.equal(res.status, 400);
});

test("GET /api/audit rejects an invalid decisionType", async () => {
  const res = await request(app).get("/api/audit?decisionType=BOGUS");
  assert.equal(res.status, 400);
});

test("GET /api/audit/recent returns the newest audits first", async () => {
  await request(app)
    .post("/api/audit/snapshot")
    .set("Authorization", `Bearer ${token}`)
    .send({ decisionType: "AI_DECISION", drainId: 1 });
  await request(app)
    .post("/api/audit/snapshot")
    .set("Authorization", `Bearer ${token}`)
    .send({ decisionType: "AI_DECISION", drainId: 5 });

  const recent = await request(app).get("/api/audit/recent?limit=5");

  assert.equal(recent.status, 200);
  assert.equal(recent.body.audits.length, 2);
  assert.equal(recent.body.audits[0].drainId, 5);
});

// ------------------------------------------------------------
// Snapshot endpoint (auth-protected)
// ------------------------------------------------------------

test("POST /api/audit/snapshot requires a token", async () => {
  const res = await request(app)
    .post("/api/audit/snapshot")
    .send({ decisionType: "AI_DECISION", drainId: 1 });

  assert.equal(res.status, 401);
});

test("POST /api/audit/snapshot rejects an invalid decision type", async () => {
  const res = await request(app)
    .post("/api/audit/snapshot")
    .set("Authorization", `Bearer ${token}`)
    .send({ decisionType: "BOGUS", drainId: 1 });

  assert.equal(res.status, 400);
});

test("POST /api/audit/snapshot AI_DECISION requires a drainId", async () => {
  const res = await request(app)
    .post("/api/audit/snapshot")
    .set("Authorization", `Bearer ${token}`)
    .send({ decisionType: "AI_DECISION" });

  assert.equal(res.status, 400);
  assert.match(res.body.error, /requires a valid drainId/);
});

test("POST /api/audit/snapshot INCIDENT requires an incidentId", async () => {
  const res = await request(app)
    .post("/api/audit/snapshot")
    .set("Authorization", `Bearer ${token}`)
    .send({ decisionType: "INCIDENT", drainId: 1 });

  assert.equal(res.status, 400);
  assert.match(res.body.error, /valid incidentId/);
});

test("POST /api/audit/snapshot records once then dedups identical snapshots", async () => {
  const first = await request(app)
    .post("/api/audit/snapshot")
    .set("Authorization", `Bearer ${token}`)
    .send({ decisionType: "AI_DECISION", drainId: 1 });

  assert.equal(first.status, 201);
  assert.equal(first.body.recorded, true);
  assert.equal(first.body.reason, "RECORDED");
  assert.ok(first.body.audit.decisionId);
  assert.ok(first.body.audit.explanation);

  const second = await request(app)
    .post("/api/audit/snapshot")
    .set("Authorization", `Bearer ${token}`)
    .send({ decisionType: "AI_DECISION", drainId: 1 });

  assert.equal(second.status, 200);
  assert.equal(second.body.recorded, false);
  assert.equal(second.body.reason, "UNCHANGED");
});

test("POST /api/audit/snapshot is honest when the engine has no data", async () => {
  const inserted = await pool.query(
    "INSERT INTO drains (zone_name, location) VALUES ('Zone 8', 'Observatory') RETURNING id"
  );
  const drainId = Number(inserted.rows[0].id);

  // AI_DECISION always has an honest INSUFFICIENT_DATA output for a
  // drain with no sensor, so it is RECORDED (201), never refused.
  const ai = await request(app)
    .post("/api/audit/snapshot")
    .set("Authorization", `Bearer ${token}`)
    .send({ decisionType: "AI_DECISION", drainId });

  assert.equal(ai.status, 201);
  assert.equal(ai.body.audit.status, "INSUFFICIENT_DATA");
  assert.equal(ai.body.audit.score, null);
  assert.ok(ai.body.audit.explanation.includes("No signal was available"));

  // FORECAST has no output for a drain with no sensor: 422, the
  // existing engine returned no data for this scope.
  const forecast = await request(app)
    .post("/api/audit/snapshot")
    .set("Authorization", `Bearer ${token}`)
    .send({ decisionType: "FORECAST", drainId });

  assert.equal(forecast.status, 422);
  assert.match(forecast.body.error, /existing engine returned no data/);
});

// ------------------------------------------------------------
// Lookups + filters
// ------------------------------------------------------------

async function storeDrainSnapshot(drainId) {
  return request(app)
    .post("/api/audit/snapshot")
    .set("Authorization", `Bearer ${token}`)
    .send({ decisionType: "AI_DECISION", drainId });
}

test("GET /api/audit/drain/:id lists only that drain", async () => {
  await storeDrainSnapshot(2);
  await storeDrainSnapshot(5);

  const byDrain = await request(app).get("/api/audit/drain/5");

  assert.equal(byDrain.status, 200);
  assert.equal(byDrain.body.drainId, 5);
  assert.equal(byDrain.body.count, 1);
  assert.equal(byDrain.body.audits[0].drainId, 5);

  const invalid = await request(app).get("/api/audit/drain/abc");
  assert.equal(invalid.status, 400);

  const missing = await request(app).get("/api/audit/drain/9999");
  assert.equal(missing.status, 200);
  assert.equal(missing.body.count, 0);
});

test("GET /api/audit/:id and /:id/explanation return the stored record and explanation", async () => {
  const stored = await storeDrainSnapshot(1);
  const id = stored.body.audit.id;

  const byId = await request(app).get(`/api/audit/${id}`);
  assert.equal(byId.status, 200);
  assert.equal(byId.body.audit.decisionType, "AI_DECISION");

  const explanation = await request(app).get(`/api/audit/${id}/explanation`);
  assert.equal(explanation.status, 200);
  assert.ok(explanation.body.explanation.explanation);
  assert.ok(explanation.body.explanation.limitations);

  const invalid = await request(app).get("/api/audit/abc");
  assert.equal(invalid.status, 400);

  const unknown = await request(app).get("/api/audit/999999");
  assert.equal(unknown.status, 404);

  const unknownExplanation = await request(app).get("/api/audit/999999/explanation");
  assert.equal(unknownExplanation.status, 404);
});

test("GET /api/audit/decision/:decisionId finds a record by its decision id", async () => {
  const stored = await storeDrainSnapshot(1);
  const decisionId = stored.body.audit.decisionId;

  const res = await request(app).get(`/api/audit/decision/${encodeURIComponent(decisionId)}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.audit.decisionId, decisionId);

  const missing = await request(app).get("/api/audit/decision/AI_DECISION:1:1");
  assert.equal(missing.status, 404);
});

test("GET /api/audit/type/:decisionType filters by type", async () => {
  await storeDrainSnapshot(1);

  const res = await request(app).get("/api/audit/type/AI_DECISION");
  assert.equal(res.status, 200);
  assert.equal(res.body.count, 1);
  assert.equal(res.body.audits[0].decisionType, "AI_DECISION");

  const invalid = await request(app).get("/api/audit/type/BOGUS");
  assert.equal(invalid.status, 400);
});

test("GET /api/audit/robot/:id validates its input", async () => {
  const invalid = await request(app).get("/api/audit/robot/abc");
  assert.equal(invalid.status, 400);

  const empty = await request(app).get("/api/audit/robot/1");
  assert.equal(empty.status, 200);
  assert.equal(empty.body.robotId, 1);
  assert.equal(empty.body.count, 0);
});

// ------------------------------------------------------------
// Additive dashboard + analytics
// ------------------------------------------------------------

test("dashboard exposes the additive decisionAudit block", async () => {
  await storeDrainSnapshot(1);

  const res = await request(app).get("/api/dashboard");

  assert.equal(res.status, 200);
  assert.ok(res.body.decisionAudit);
  assert.equal(res.body.decisionAudit.status, "READY");
  assert.equal(res.body.decisionAudit.total, 1);
  assert.equal(res.body.decisionAudit.recentChanges.length, 1);
});

test("analytics expose the additive audit fields", async () => {
  await storeDrainSnapshot(5);

  const res = await request(app).get("/api/analytics");

  assert.equal(res.status, 200);
  assert.equal(res.body.audit_summary.total, 1);
  assert.equal(res.body.audit_decision_counts.AI_DECISION, 1);
  assert.equal(res.body.audit_level_counts.CRITICAL, 1);
  assert.equal(res.body.audit_recent_changes.length, 1);
  assert.equal(typeof res.body.audit_retention, "string");
});

// ------------------------------------------------------------
// Append-only + no side effects
// ------------------------------------------------------------

test("decision_audits is append-only: UPDATE and DELETE are rejected", async () => {
  const stored = await storeDrainSnapshot(1);
  const id = stored.body.audit.id;

  await assert.rejects(
    pool.query("UPDATE decision_audits SET status = 'TAMPERED' WHERE id = $1", [id]),
    /append-only/
  );
  await assert.rejects(
    pool.query("DELETE FROM decision_audits WHERE id = $1", [id]),
    /append-only/
  );

  const rows = await pool.query(
    "SELECT status FROM decision_audits WHERE id = $1",
    [id]
  );
  assert.equal(rows.rows.length, 1);
  assert.equal(rows.rows[0].status, "READY");
});

test("audit API calls and snapshots never open incidents or dispatch robots", async () => {
  const incidentsBefore = await pool.query("SELECT COUNT(*)::int AS c FROM incidents");
  const missionsBefore = await pool.query("SELECT COUNT(*)::int AS c FROM missions");

  await request(app).get("/api/audit");
  await request(app).get("/api/audit/summary");
  await request(app).get("/api/audit/recent");
  await storeDrainSnapshot(1);
  await storeDrainSnapshot(5);

  const incidents = await pool.query("SELECT COUNT(*)::int AS c FROM incidents");
  assert.equal(Number(incidents.rows[0].c), Number(incidentsBefore.rows[0].c));

  const missions = await pool.query("SELECT COUNT(*)::int AS c FROM missions");
  assert.equal(Number(missions.rows[0].c), Number(missionsBefore.rows[0].c));
});