-- ============================================================
-- AI-DrainOS Migration 006 - allow SENSOR incident source
--
-- Update #21 (Sensor Intelligence) may open at most one incident
-- per drain for a SEVERE sensor-integrity issue through the
-- existing incidentService. Such incidents use the dedicated
-- 'SENSOR' source and NEVER dispatch a robot (enforced in
-- incidentService by the NON_DISPATCH_SOURCES guard).
--
-- This migration only widens the existing source CHECK constraint
-- to include 'SENSOR'. It does not touch any data.
--
-- Idempotent: the CHECK is dropped (IF EXISTS) and re-added, so it
-- is safe to run on every startup for existing installs.
-- ============================================================

ALTER TABLE incidents DROP CONSTRAINT IF EXISTS incidents_source_check;

ALTER TABLE incidents ADD CONSTRAINT incidents_source_check
  CHECK (source IN ('AI_DECISION', 'FLOOD_RISK', 'FORECAST', 'MAINTENANCE', 'VISION', 'SENSOR', 'MANUAL'));
