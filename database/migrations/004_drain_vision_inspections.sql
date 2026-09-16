-- ============================================================
-- AI-DrainOS Migration 004 - drain_vision_inspections table
--
-- Audit trail of drain vision inspections (baseline computer-
-- vision analysis of uploaded drain images). Stores ONLY the
-- derived scores, findings and image METADATA - never the raw
-- image binary, which is kept out of PostgreSQL on purpose.
--
-- Idempotent: safe to run on existing databases without
-- destroying any data (CREATE ... IF NOT EXISTS).
-- Applied automatically by scripts/dbInit.js on startup when the
-- schema is already present (existing installs).
-- ============================================================

CREATE TABLE IF NOT EXISTS drain_vision_inspections (
  id SERIAL PRIMARY KEY,
  drain_id INTEGER NOT NULL REFERENCES drains(id) ON DELETE CASCADE,
  inspection_level VARCHAR(20) DEFAULT 'LOW',
  visual_risk_score INTEGER DEFAULT 0,
  possible_blockage_score INTEGER DEFAULT 0,
  findings JSONB DEFAULT '[]'::jsonb,
  recommendation TEXT,
  robot_inspection_recommended BOOLEAN DEFAULT false,
  image_metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_drain_vision_inspections_drain_id ON drain_vision_inspections(drain_id);
CREATE INDEX IF NOT EXISTS idx_drain_vision_inspections_created_at ON drain_vision_inspections(created_at);