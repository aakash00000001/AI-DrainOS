-- ============================================================
-- AI-DrainOS Migration 002 - sensor_readings history table
--
-- Adds the minimal historical sensor-reading table used by the
-- flood risk engine for trend analysis and risk analytics.
--
-- Idempotent: safe to run on existing databases without
-- destroying any data (CREATE ... IF NOT EXISTS).
-- Applied automatically by scripts/dbInit.js on startup when the
-- schema is already present (existing installs).
-- ============================================================

CREATE TABLE IF NOT EXISTS sensor_readings (
  id SERIAL PRIMARY KEY,
  sensor_id INTEGER NOT NULL REFERENCES sensors(id) ON DELETE CASCADE,
  drain_id INTEGER NOT NULL REFERENCES drains(id) ON DELETE CASCADE,
  water_level INTEGER NOT NULL,
  gas_level INTEGER NOT NULL,
  temperature NUMERIC(5,2) NOT NULL,
  recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sensor_readings_sensor_id ON sensor_readings(sensor_id);
CREATE INDEX IF NOT EXISTS idx_sensor_readings_drain_id ON sensor_readings(drain_id);
CREATE INDEX IF NOT EXISTS idx_sensor_readings_recorded_at ON sensor_readings(recorded_at);