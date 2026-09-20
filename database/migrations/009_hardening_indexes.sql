-- ============================================================
-- 009_hardening_indexes.sql
--
-- Update #25 - Production Hardening & Reliability.
--
-- These indexes close the highest-cost access paths used by the
-- dashboard / live loop and the alerts resolution writes:
--
--   * alerts(drain_id, alert_status)  serves:
--       - "open alerts per drain" lookups (live loop status checks,
--         drains PUT/PATCH resolve-alerts updates) with an effective
--         partial index scope (alert_status = 'Open');
--       - the dashboard "critical alerts" COUNT and the alert list
--         filtered by status.
--
--   * missions(robot_id, mission_status) serves:
--       - "current mission for robot" lookups (live loop arrival /
--         progress checks use mission_status = 'Assigned');
--       - the missions list/history joins filtered by robot/status.
--
-- Both tables previously had no indexes beyond the primary key, so
-- these lookups were sequential scans that grow with table size.
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_alerts_drain_status
  ON alerts (drain_id, alert_status);

CREATE INDEX IF NOT EXISTS idx_missions_robot_status
  ON missions (robot_id, mission_status);