-- ============================================================
-- AI-DrainOS Migration 005 - incidents table
--
-- Autonomous Emergency Response & Incident Intelligence layer.
-- A critical AI decision (or a manual/flood/forecast/maintenance/
-- vision trigger) becomes a trackable incident with a complete,
-- timestamped response lifecycle:
--
--   OPEN -> ACKNOWLEDGED -> RESPONDING -> RESOLVED
--
-- Important:
--  * Only REAL database timestamps are stored/used. No fabricated
--    history: every timeline row maps to a stored timestamp.
--  * assigned_robot_id + route + route_status snapshot the robot
--    assigned by the existing Robot Path Planning engine (reused,
--    never duplicated).
--  * route_status is honest: PLANNED / NO_ROBOT_AVAILABLE /
--    NO_COORDINATES / MANUAL / NULL when unassigned.
--  * CHECK constraints enforce the documented status/severity set,
--    and "resolved_at only when status = RESOLVED" integrity.
--
-- Idempotent: safe to run on existing databases without
-- destroying any data (CREATE ... IF NOT EXISTS).
-- Applied automatically by scripts/dbInit.js on startup when the
-- schema is already present (existing installs).
-- ============================================================

CREATE TABLE IF NOT EXISTS incidents (
  id SERIAL PRIMARY KEY,
  drain_id INTEGER NOT NULL REFERENCES drains(id) ON DELETE CASCADE,
  severity VARCHAR(20) NOT NULL DEFAULT 'HIGH'
    CHECK (severity IN ('LOW', 'MODERATE', 'HIGH', 'CRITICAL')),
  title TEXT,
  description TEXT,
  source VARCHAR(30) NOT NULL DEFAULT 'AI_DECISION'
    CHECK (source IN ('AI_DECISION', 'FLOOD_RISK', 'FORECAST', 'MAINTENANCE', 'VISION', 'MANUAL')),
  decision_score INTEGER
    CHECK (decision_score IS NULL OR (decision_score >= 0 AND decision_score <= 100)),
  decision_level VARCHAR(20),
  assigned_robot_id INTEGER REFERENCES robots(id) ON DELETE SET NULL,
  route_status VARCHAR(30),
  route JSONB,
  status VARCHAR(20) NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN', 'ACKNOWLEDGED', 'RESPONDING', 'RESOLVED')),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  acknowledged_at TIMESTAMP,
  responding_at TIMESTAMP,
  resolved_at TIMESTAMP
    CHECK (resolved_at IS NULL OR status = 'RESOLVED'),
  assigned_at TIMESTAMP,
  route_status_changed_at TIMESTAMP,
  resolution_notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_incidents_drain_id ON incidents(drain_id);
CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents(status);
CREATE INDEX IF NOT EXISTS idx_incidents_severity ON incidents(severity);
CREATE INDEX IF NOT EXISTS idx_incidents_source ON incidents(source);
CREATE INDEX IF NOT EXISTS idx_incidents_created_at ON incidents(created_at);

-- Partial uniqueness enforcement: at most ONE active incident
-- (OPEN/ACKNOWLEDGED/RESPONDING) per drain. RESOLVED incidents are
-- excluded so history accumulates while the live incident stays
-- unique. This hardens the application-level duplicate guard.
CREATE UNIQUE INDEX IF NOT EXISTS idx_incidents_one_active_per_drain
  ON incidents(drain_id)
  WHERE status IN ('OPEN', 'ACKNOWLEDGED', 'RESPONDING');