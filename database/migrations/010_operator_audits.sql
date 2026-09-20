-- ============================================================
-- AI-DrainOS Migration 010 - operator_audits
--
-- Update #27 (Operator Action Audit Trail) persists a single,
-- append-only, read-only trail of HUMAN operator actions that
-- mutates system state through the protected mutation routes.
--
-- PRINCIPLES
--   * Only authenticated human mutations are recorded
--     (drains / alerts / missions / incidents / settings /
--     coordination / user management). Reads, MQTT ingestion,
--     the live-loop and AI updates are never recorded here.
--   * Recording is NON-FATAL middleware: an audit failure must
--     never fail the business action that triggered it. The
--     trail is best-effort by design.
--   * Append-only: UPDATE/DELETE are blocked by a trigger so the
--     trail cannot be silently rewritten.
--   * No secrets are ever stored: request/response payloads are
--     recursively redacted before persistence (password, token,
--     authorization, apiKey, secret, credential ... ->
--     "[REDACTED]").
--   * Correlation with the access log is available through the
--     request_id column (req.id / X-Request-Id header).
--
-- Idempotent: safe to run on every startup for existing installs.
-- Mirrors database/schema.sql for fresh installs.
-- ============================================================

CREATE TABLE IF NOT EXISTS operator_audits (
  id SERIAL PRIMARY KEY,
  request_id VARCHAR(64),
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  user_email VARCHAR(120),
  action VARCHAR(60) NOT NULL,
  entity_type VARCHAR(30) NOT NULL,
  entity_id INTEGER,
  method VARCHAR(10),
  route TEXT,
  status INTEGER,
  before_data JSONB,
  after_data JSONB,
  meta_data JSONB,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_operator_audits_created_at
  ON operator_audits(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_operator_audits_user_id
  ON operator_audits(user_id);

CREATE INDEX IF NOT EXISTS idx_operator_audits_entity
  ON operator_audits(entity_type, entity_id);

CREATE INDEX IF NOT EXISTS idx_operator_audits_action
  ON operator_audits(action);

-- ------------------------------------------------------------
-- Append-only guard. The audit trail is meant to be immutable
-- (retention is a documented operations decision, never a
-- silent DELETE). The trigger is idempotent.
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION prevent_operator_audit_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'operator_audits is append-only; UPDATE and DELETE are not allowed';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_operator_audits_append_only
  ON operator_audits;

CREATE TRIGGER trg_operator_audits_append_only
  BEFORE UPDATE OR DELETE ON operator_audits
  FOR EACH ROW
  EXECUTE FUNCTION prevent_operator_audit_mutation();