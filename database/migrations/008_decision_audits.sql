-- ============================================================
-- AI-DrainOS Migration 008 - decision_audits
--
-- Update #24 (Explainable AI + Decision Audit) persists a single,
-- append-only, read-only trail of the AI layer's own outputs.
--
-- PRINCIPLES
--   * The audit table is a RECORD of what the existing decision
--     services actually returned - it never recomputes a decision
--     and never replaces a formula.
--   * Only MEANINGFUL changes are written (level changed, score
--     changed materially, recommendation/route/coordination/incident
--     state changed). No row is written per live-tick.
--   * Append-only: UPDATE/DELETE are blocked by a trigger so the
--     trail cannot be silently rewritten. No secrets, tokens or raw
--     sensor payloads are ever stored (inputs/contributions hold
--     only normalized signal scores and weights).
--
-- Idempotent: safe to run on every startup for existing installs.
-- Mirrors database/schema.sql for fresh installs.
-- ============================================================

CREATE TABLE IF NOT EXISTS decision_audits (
  id SERIAL PRIMARY KEY,
  decision_id VARCHAR(120) NOT NULL UNIQUE,
  decision_type VARCHAR(40) NOT NULL,
  entity_type VARCHAR(30) NOT NULL,
  entity_id INTEGER NOT NULL,
  drain_id INTEGER,
  robot_id INTEGER,
  timestamp TIMESTAMP NOT NULL,
  status VARCHAR(40),
  level VARCHAR(20),
  score REAL,
  inputs JSONB,
  contributions JSONB,
  modifiers JSONB,
  evidence JSONB,
  explanation TEXT,
  limitations TEXT,
  signature VARCHAR(64) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_decision_audits_timestamp
  ON decision_audits(timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_decision_audits_drain_id
  ON decision_audits(drain_id);

CREATE INDEX IF NOT EXISTS idx_decision_audits_decision_type
  ON decision_audits(decision_type);

CREATE INDEX IF NOT EXISTS idx_decision_audits_entity
  ON decision_audits(entity_type, entity_id);

-- ------------------------------------------------------------
-- Append-only guard. The audit trail is meant to be immutable
-- (retention is a documented operations decision, never a
-- silent DELETE). The trigger is idempotent.
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION prevent_decision_audit_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'decision_audits is append-only; UPDATE and DELETE are not allowed';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_decision_audits_append_only
  ON decision_audits;

CREATE TRIGGER trg_decision_audits_append_only
  BEFORE UPDATE OR DELETE ON decision_audits
  FOR EACH ROW
  EXECUTE FUNCTION prevent_decision_audit_mutation();