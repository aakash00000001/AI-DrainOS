-- ============================================================
-- AI-DrainOS Migration 003 - maintenance_predictions table
--
-- Adds the derived maintenance / blockage prediction audit
-- trail used by the maintenance prediction engine and its
-- analytics. It stores ONLY the derived scores (never raw
-- sensor readings, which live in sensor_readings).
--
-- Idempotent: safe to run on existing databases without
-- destroying any data (CREATE ... IF NOT EXISTS).
-- Applied automatically by scripts/dbInit.js on startup when the
-- schema is already present (existing installs).
-- ============================================================

CREATE TABLE IF NOT EXISTS maintenance_predictions (
  id SERIAL PRIMARY KEY,
  drain_id INTEGER NOT NULL REFERENCES drains(id) ON DELETE CASCADE,
  maintenance_score INTEGER DEFAULT 0,
  maintenance_level VARCHAR(20) DEFAULT 'LOW',
  blockage_risk_score INTEGER DEFAULT 0,
  inspection_priority VARCHAR(20) DEFAULT 'LOW',
  recommendation TEXT,
  reasons JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_maintenance_predictions_drain_id ON maintenance_predictions(drain_id);
CREATE INDEX IF NOT EXISTS idx_maintenance_predictions_created_at ON maintenance_predictions(created_at);