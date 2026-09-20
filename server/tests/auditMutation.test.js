// ============================================================
// AI-DrainOS — auditMutation middleware tests (UPDATE #27)
//
// Proves the NON-FATAL contract: auditing never breaks the real
// business action, GETs are never recorded, failed attempts are
// still captured, before/after state is captured correctly, and
// secrets are redacted before they reach the database.
// ============================================================

const { test, before, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const { setup } = require("./helpers");

const operatorAuditService = require("../services/operatorAuditService");

let app;
let pool;
let adminToken;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

before(async () => {
  ({ app, pool } = await setup());

  const adminLogin = await request(app).post("/api/auth/login").send({
    email: "admin@aidrain.com",
    password: "admin123"
  });
  adminToken = adminLogin.body.token;
});

beforeEach(async () => {
  await pool.query("TRUNCATE operator_audits");
});

after(async () => {
  await pool.end();
});

// ------------------------------------------------------------
// Non-fatal contract
// ------------------------------------------------------------

test("a rejected audit write never fails the business action", async () => {
  const original = operatorAuditService.recordAudit;
  operatorAuditService.recordAudit = async () => {
    throw new Error("simulated database outage");
  };

  try {
    const res = await request(app)
      .put("/api/settings")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ warning_threshold: "62" });

    assert.equal(res.status, 200);
    assert.equal(res.body.settings.warning_threshold, "62");
  } finally {
    operatorAuditService.recordAudit = original;
  }
});

test("a mutation with an active before-hook still succeeds", async () => {
  const res = await request(app)
    .put("/api/drains/1")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({
      zone_name: "Zone 1 Renamed",
      location: "Goripalayam",
      status: "Normal",
      blockage_level: 20,
      latitude: 9.9252,
      longitude: 78.1198
    });

  assert.equal(res.status, 200);
  assert.equal(res.body.zone_name, "Zone 1 Renamed");
});

// ------------------------------------------------------------
// Recording scope
// ------------------------------------------------------------

test("GET (read) routes write nothing to the trail", async () => {
  await request(app).get("/api/settings");
  await request(app).get("/api/drains");
  await sleep(60);

  const count = await pool.query("SELECT COUNT(*)::int AS c FROM operator_audits");
  assert.equal(count.rows[0].c, 0);
});

test("failed mutation attempts are still recorded with their status", async () => {
  const res = await request(app)
    .put("/api/settings")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ not_a_real_setting: "x" });

  assert.equal(res.status, 400);

  await sleep(60);

  const count = await pool.query(
    "SELECT action, status FROM operator_audits ORDER BY id DESC LIMIT 1"
  );
  assert.equal(count.rows[0].action, "SETTINGS_UPDATE");
  assert.equal(count.rows[0].status, 400);
});

// ------------------------------------------------------------
// Before/after capture
// ------------------------------------------------------------

test("an update captures the real before and after state", async () => {
  const create = await request(app)
    .post("/api/drains")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({
      zone_name: "Middle Zone",
      location: "Middle Block",
      status: "Normal",
      blockage_level: 5,
      latitude: 9.93,
      longitude: 78.12
    });
  assert.equal(create.status, 201);

  await pool.query("TRUNCATE operator_audits");

  const update = await request(app)
    .put(`/api/drains/${create.body.id}`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({
      zone_name: "Middle Zone v2",
      location: "Middle Block",
      status: "Warning",
      blockage_level: 60,
      latitude: 9.93,
      longitude: 78.12
    });
  assert.equal(update.status, 200);

  await sleep(60);

  const rows = await pool.query(
    "SELECT action, entity_type, entity_id, before_data, after_data FROM operator_audits"
  );

  assert.equal(rows.rows.length, 1);
  const audit = rows.rows[0];
  assert.equal(audit.action, "DRAIN_UPDATE");
  assert.equal(audit.entity_type, "DRAIN");
  assert.equal(Number(audit.entity_id), Number(create.body.id));
  assert.equal(audit.before_data.zone_name, "Middle Zone");
  assert.equal(audit.after_data.zone_name, "Middle Zone v2");
  assert.equal(audit.before_data.status, "Normal");
  assert.equal(audit.after_data.status, "Warning");
});

// ------------------------------------------------------------
// Secret redaction end-to-end
// ------------------------------------------------------------

test("USER_CREATE records the action and never stores plaintext secrets", async () => {
  const email = `audit_user_${Date.now()}@aidrain.com`;
  const res = await request(app)
    .post("/api/auth/register")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({
      full_name: "Audit Test User",
      email,
      password: "Secret123!"
    });

  assert.equal(res.status, 201);

  await sleep(60);

  const rows = await pool.query(
    "SELECT action, user_email, after_data FROM operator_audits WHERE action = 'USER_CREATE' ORDER BY id DESC LIMIT 1"
  );

  assert.equal(rows.rows.length, 1);
  assert.equal(rows.rows[0].user_email, "admin@aidrain.com");

  const serialized = JSON.stringify(rows.rows[0]).toLowerCase();
  assert.ok(!serialized.includes("secret123"), "password must not be stored");

  const user = await pool.query("SELECT password FROM users WHERE email = $1", [email]);
  assert.equal(user.rows.length, 1);
  assert.ok(user.rows[0].password.startsWith("$2"));
});

test("recordAudit redacts sensitive values captured through the hook path", async () => {
  const { id } = await operatorAuditService.recordAudit({
    action: "PASSWORD_CHANGE",
    entityType: "USER",
    entityId: 1,
    afterData: { message: "ok", anywhere_secret_token: "s3cr3t" }
  });

  const rows = await pool.query(
    "SELECT before_data, after_data FROM operator_audits WHERE id = $1",
    [id]
  );

  assert.equal(rows.rows[0].after_data.anywhere_secret_token, "[REDACTED]");
  assert.equal(rows.rows[0].after_data.message, "ok");
});