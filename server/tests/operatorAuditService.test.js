// ============================================================
// AI-DrainOS — Operator Audit Service tests (UPDATE #27)
//
// Covers the recursive secret redaction, the bounded/parameterized
// reads, the summary aggregation and the append-only guarantee of
// the operator_audits trail.
// ============================================================

const { test, before, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");

const { setup } = require("./helpers");

const operatorAuditService = require("../services/operatorAuditService");

let pool;

before(async () => {
  ({ pool } = await setup());
});

beforeEach(async () => {
  await pool.query("TRUNCATE operator_audits");
});

after(async () => {
  await pool.end();
});

// ------------------------------------------------------------
// Redaction (pure functions)
// ------------------------------------------------------------

test("redactPayload replaces nested sensitive keys with [REDACTED]", () => {
  const input = {
    full_name: "Admin",
    password: "supersecret",
    access_token: "abc",
    api_key: "k",
    "Authorization": "Bearer x",
    client_secret: "s3",
    issuer_jwt: "j",
    settings: { notification_enabled: "true" }
  };

  const out = operatorAuditService.redactPayload(input);

  assert.equal(out.password, "[REDACTED]");
  assert.equal(out.access_token, "[REDACTED]");
  assert.equal(out.api_key, "[REDACTED]");
  assert.equal(out.Authorization, "[REDACTED]");
  assert.equal(out.client_secret, "[REDACTED]");
  assert.equal(out.issuer_jwt, "[REDACTED]");
  assert.equal(out.full_name, "Admin");
  assert.deepEqual(out.settings, { notification_enabled: "true" });
});

test("redactPayload masks arrays deeply and preserves numbers/booleans", () => {
  const out = operatorAuditService.redactPayload({
    list: [{ password: "x", score: 3 }, "y", null],
    enabled: true
  });
  assert.equal(out.list[0].password, "[REDACTED]");
  assert.equal(out.list[0].score, 3);
  assert.equal(out.enabled, true);
});

test("redactPayload tolerates circular references", () => {
  const circular = { name: "drain", deep: {} };
  circular.deep.self = circular;

  const out = operatorAuditService.redactPayload(circular);
  assert.equal(out.deep.self, "[CIRCULAR]");
  assert.equal(out.name, "drain");
});

test("isSensitiveKey catches password_hash and refresh token spellings", () => {
  assert.equal(operatorAuditService.isSensitiveKey("password_hash"), true);
  assert.equal(operatorAuditService.isSensitiveKey("refresh_token"), true);
  assert.equal(operatorAuditService.isSensitiveKey("zone_name"), false);
  assert.equal(operatorAuditService.isSensitiveKey("blockage_level"), false);
});

// ------------------------------------------------------------
// Write + read paths
// ------------------------------------------------------------

test("recordAudit inserts a row with redacted payloads", async () => {
  const { recorded, id } = await operatorAuditService.recordAudit({
    requestId: "req-123",
    userId: 1,
    userEmail: "admin@aidrain.com",
    method: "PUT",
    route: "/api/drains/1",
    status: 200,
    action: "DRAIN_UPDATE",
    entityType: "DRAIN",
    entityId: 1,
    beforeData: { zone_name: "Old", password: "hunter2" },
    afterData: { zone_name: "New" }
  });

  assert.equal(recorded, true);
  assert.ok(Number.isInteger(id));

  const row = await pool.query(
    "SELECT action, user_email, before_data, after_data FROM operator_audits WHERE id = $1",
    [id]
  );

  assert.equal(row.rows[0].action, "DRAIN_UPDATE");
  assert.equal(row.rows[0].user_email, "admin@aidrain.com");
  assert.equal(row.rows[0].before_data.zone_name, "Old");
  assert.equal(row.rows[0].before_data.password, "[REDACTED]");
  assert.deepEqual(row.rows[0].after_data, { zone_name: "New" });
});

test("recordAudit refuses a missing action", async () => {
  const result = await operatorAuditService.recordAudit({
    entityType: "DRAIN",
    entityId: 1
  });
  assert.deepEqual(result, { recorded: false, reason: "MISSING_ACTION" });

  const count = await pool.query("SELECT COUNT(*)::int AS c FROM operator_audits");
  assert.equal(count.rows[0].c, 0);
});

test("getAudits returns newest-first camelCase rows", async () => {
  await operatorAuditService.recordAudit({ action: "DRAIN_CREATE", entityType: "DRAIN", entityId: 1, afterData: { zone_name: "A" } });
  await operatorAuditService.recordAudit({ action: "ALERT_CREATE", entityType: "ALERT", entityId: 4, afterData: { severity: "High" } });

  const audits = await operatorAuditService.getAudits();
  assert.equal(audits.length, 2);
  assert.equal(audits[0].action, "ALERT_CREATE");
  assert.equal(audits[0].entityType, "ALERT");
  assert.equal(audits[0].entityId, 4);
  assert.equal(audits[1].entityType, "DRAIN");
  assert.ok(audits[0].createdAt);
});

test("getAudits filters by action, entityType and entityId", async () => {
  await operatorAuditService.recordAudit({ action: "DRAIN_CREATE", entityType: "DRAIN", entityId: 1, userId: 1 });
  await operatorAuditService.recordAudit({ action: "DRAIN_UPDATE", entityType: "DRAIN", entityId: 1, userId: 1 });
  await operatorAuditService.recordAudit({ action: "ALERT_CREATE", entityType: "ALERT", entityId: 2, userId: 1 });

  assert.equal((await operatorAuditService.getAudits({ action: "DRAIN_CREATE" })).length, 1);
  assert.equal((await operatorAuditService.getAudits({ entityType: "ALERT" })).length, 1);
  assert.equal((await operatorAuditService.getAudits({ entityId: 1 })).length, 2);
  assert.equal((await operatorAuditService.getAudits({ entityType: "DRAIN", userId: 1 })).length, 2);
});

test("getAudits honors limit and offset", async () => {
  for (let i = 1; i <= 5; i += 1) {
    await operatorAuditService.recordAudit({ action: "SETTINGS_UPDATE", entityType: "SETTINGS", entityId: i });
  }

  const first = await operatorAuditService.getAudits({ limit: 2, offset: 0 });
  const second = await operatorAuditService.getAudits({ limit: 2, offset: 2 });

  assert.equal(first.length, 2);
  assert.equal(second.length, 2);
  assert.equal(first[0].entityId, 5);
  assert.equal(second[0].entityId, 3);
});

test("getAuditById returns the row or null", async () => {
  const { id } = await operatorAuditService.recordAudit({
    action: "DRAIN_DELETE",
    entityType: "DRAIN",
    entityId: 7
  });

  const audit = await operatorAuditService.getAuditById(id);
  assert.equal(audit.action, "DRAIN_DELETE");
  assert.equal(audit.entityId, 7);

  const missing = await operatorAuditService.getAuditById(999999);
  assert.equal(missing, null);
});

test("getAuditSummary aggregates totals, actions, entities and operators", async () => {
  await operatorAuditService.recordAudit({
    action: "DRAIN_UPDATE",
    entityType: "DRAIN",
    entityId: 1,
    userEmail: "admin@aidrain.com"
  });
  await operatorAuditService.recordAudit({
    action: "DRAIN_UPDATE",
    entityType: "DRAIN",
    entityId: 2,
    userEmail: "admin@aidrain.com"
  });
  await operatorAuditService.recordAudit({
    action: "INCIDENT_RESOLVE",
    entityType: "INCIDENT",
    entityId: 3,
    userEmail: "operator@aidrain.com"
  });

  const summary = await operatorAuditService.getAuditSummary();

  assert.equal(summary.total, 3);
  assert.equal(summary.byAction.DRAIN_UPDATE, 2);
  assert.equal(summary.byAction.INCIDENT_RESOLVE, 1);
  assert.equal(summary.byEntityType.DRAIN, 2);
  assert.equal(summary.byEntityType.INCIDENT, 1);
  assert.equal(summary.byOperator["admin@aidrain.com"], 2);
  assert.ok(summary.generatedAt);
});

// ------------------------------------------------------------
// Append-only guarantee
// ------------------------------------------------------------

test("operator_audits blocks UPDATE and DELETE via trigger", async () => {
  const { id } = await operatorAuditService.recordAudit({
    action: "ALERT_UPDATE",
    entityType: "ALERT",
    entityId: 1
  });

  await assert.rejects(
    () => pool.query("UPDATE operator_audits SET action = 'DRAIN_CREATE' WHERE id = $1", [id]),
    /append-only/
  );

  await assert.rejects(
    () => pool.query("DELETE FROM operator_audits WHERE id = $1", [id]),
    /append-only/
  );

  const still = await operatorAuditService.getAuditById(id);
  assert.equal(still.action, "ALERT_UPDATE");
});