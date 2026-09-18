-- ============================================================
-- AI-DrainOS Database Schema
-- Run via: node database/setup.js   (or psql -f)
-- ============================================================

DROP TABLE IF EXISTS weather_observations CASCADE;
DROP TABLE IF EXISTS sensor_readings CASCADE;
DROP TABLE IF EXISTS drain_vision_inspections CASCADE;
DROP TABLE IF EXISTS maintenance_predictions CASCADE;
DROP TABLE IF EXISTS refresh_tokens CASCADE;
DROP TABLE IF EXISTS settings CASCADE;
DROP TABLE IF EXISTS reports CASCADE;
DROP TABLE IF EXISTS incidents CASCADE;
DROP TABLE IF EXISTS missions CASCADE;
DROP TABLE IF EXISTS alerts CASCADE;
DROP TABLE IF EXISTS sensors CASCADE;
DROP TABLE IF EXISTS robots CASCADE;
DROP TABLE IF EXISTS drains CASCADE;
DROP TABLE IF EXISTS charging_stations CASCADE;
DROP TABLE IF EXISTS users CASCADE;

-- ============================================================
-- USERS
-- ============================================================

CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  full_name VARCHAR(100) NOT NULL,
  email VARCHAR(100) NOT NULL UNIQUE,
  password VARCHAR(255) NOT NULL,
  role VARCHAR(20) NOT NULL DEFAULT 'Operator',
  status VARCHAR(20) NOT NULL DEFAULT 'Active',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- REFRESH TOKENS
-- ============================================================

CREATE TABLE refresh_tokens (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- SYSTEM SETTINGS
-- ============================================================

CREATE TABLE settings (
  key VARCHAR(100) PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- DRAINS
-- ============================================================

CREATE TABLE drains (
  id SERIAL PRIMARY KEY,
  zone_name VARCHAR(100),
  location VARCHAR(255),
  status VARCHAR(50) DEFAULT 'Normal',
  blockage_level INTEGER DEFAULT 0,
  latitude NUMERIC(10,7),
  longitude NUMERIC(10,7),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- ROBOTS
-- ============================================================

CREATE TABLE robots (
  id SERIAL PRIMARY KEY,
  robot_name VARCHAR(100),
  assigned_zone VARCHAR(100),
  status VARCHAR(50) DEFAULT 'Idle',
  battery_level INTEGER DEFAULT 100,
  last_active TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  latitude NUMERIC(10,7),
  longitude NUMERIC(10,7),
  target_latitude NUMERIC(10,7),
  target_longitude NUMERIC(10,7)
);

-- ============================================================
-- SENSORS
-- ============================================================

CREATE TABLE sensors (
  id SERIAL PRIMARY KEY,
  drain_id INTEGER REFERENCES drains(id) ON DELETE CASCADE,
  water_level INTEGER DEFAULT 0,
  gas_level INTEGER DEFAULT 0,
  temperature NUMERIC(5,2),
  sensor_status VARCHAR(50) DEFAULT 'Active',
  status VARCHAR(50) DEFAULT 'Normal',
  recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- SENSOR READINGS (flood risk history)
--
-- Minimal historical table used by the flood risk engine for
-- trend analysis (Water Trend factor) and risk analytics.
-- Kept deliberately small on purpose - the live sensors table
-- above remains the source of truth for current values.
-- ============================================================

CREATE TABLE sensor_readings (
  id SERIAL PRIMARY KEY,
  sensor_id INTEGER NOT NULL REFERENCES sensors(id) ON DELETE CASCADE,
  drain_id INTEGER NOT NULL REFERENCES drains(id) ON DELETE CASCADE,
  water_level INTEGER NOT NULL,
  gas_level INTEGER NOT NULL,
  temperature NUMERIC(5,2) NOT NULL,
  recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_sensor_readings_sensor_id ON sensor_readings(sensor_id);
CREATE INDEX idx_sensor_readings_drain_id ON sensor_readings(drain_id);
CREATE INDEX idx_sensor_readings_recorded_at ON sensor_readings(recorded_at);

-- ============================================================
-- WEATHER OBSERVATIONS (Weather + Flood Correlation Intelligence)
--
-- Update #23. Stores only REAL weather snapshots fetched from the
-- existing OpenWeatherMap integration (server/routes/weather.js)
-- at a bounded, throttled cadence. Every row is a genuine
-- observation - this table is NEVER backfilled or seeded with
-- invented history, so a fresh install starts empty and honest
-- WEATHER_UNAVAILABLE states are reported until real observations
-- accumulate.
--
-- Correlation analysis pairs these observations with the real
-- sensor_readings rows above. Fields mirror the raw OWM current-
-- weather payload (metric units). rain_1h / rain_3h are only
-- present when the payload reported rain - analysis treats missing
-- values as 0 mm (dry), never as invented rainfall.
-- Mirrored by database/migrations/007_weather_observations.sql for
-- existing databases.
-- ============================================================

CREATE TABLE weather_observations (
  id SERIAL PRIMARY KEY,
  observed_at TIMESTAMP NOT NULL UNIQUE,
  temperature REAL,
  humidity REAL,
  pressure REAL,
  wind_speed REAL,
  weather_main VARCHAR(40),
  weather_description VARCHAR(120),
  rain_1h REAL,
  rain_3h REAL,
  source VARCHAR(30) NOT NULL DEFAULT 'OPENWEATHERMAP',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_weather_observations_observed_at
  ON weather_observations(observed_at);

-- ============================================================
-- MAINTENANCE PREDICTIONS (maintenance / blockage prediction)
--
-- Audit trail of the explainable maintenance prediction engine.
-- Each engine run persists one row per drain so analytics can
-- report recent maintenance trends. This is NOT a duplicate of
-- raw sensor data - it stores the derived maintenance/blockage
-- prediction scores only.
-- ============================================================

CREATE TABLE maintenance_predictions (
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

CREATE INDEX idx_maintenance_predictions_drain_id ON maintenance_predictions(drain_id);
CREATE INDEX idx_maintenance_predictions_created_at ON maintenance_predictions(created_at);

-- ============================================================
-- DRAIN VISION INSPECTIONS (computer-vision drain inspection)
--
-- Audit trail of drain vision inspections (baseline computer-
-- vision analysis of uploaded drain images). Stores ONLY the
-- derived scores, findings and image METADATA - never the raw
-- image binary, which is kept out of PostgreSQL on purpose.
-- ============================================================

CREATE TABLE drain_vision_inspections (
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

CREATE INDEX idx_drain_vision_inspections_drain_id ON drain_vision_inspections(drain_id);
CREATE INDEX idx_drain_vision_inspections_created_at ON drain_vision_inspections(created_at);

-- ============================================================
-- ALERTS
-- ============================================================

CREATE TABLE alerts (
  id SERIAL PRIMARY KEY,
  drain_id INTEGER REFERENCES drains(id) ON DELETE CASCADE,
  alert_type VARCHAR(100),
  message TEXT,
  severity VARCHAR(20) DEFAULT 'Medium',
  alert_status VARCHAR(20) DEFAULT 'Open',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- INCIDENTS (Autonomous Emergency Response & Incident Intelligence)
--
-- A critical AI decision (or a manual/flood/forecast/maintenance/
-- vision trigger) becomes a trackable incident with a complete,
-- timestamped response lifecycle:
--
--   OPEN -> ACKNOWLEDGED -> RESPONDING -> RESOLVED
--
-- Only REAL database timestamps are stored. route_status is honest:
-- PLANNED / NO_ROBOT_AVAILABLE / NO_COORDINATES / MANUAL / NULL
-- when unassigned. Mirrored by database/migrations/005_incidents.sql
-- for existing databases.
-- ============================================================

CREATE TABLE incidents (
  id SERIAL PRIMARY KEY,
  drain_id INTEGER NOT NULL REFERENCES drains(id) ON DELETE CASCADE,
  severity VARCHAR(20) NOT NULL DEFAULT 'HIGH'
    CHECK (severity IN ('LOW', 'MODERATE', 'HIGH', 'CRITICAL')),
  title TEXT,
  description TEXT,
  source VARCHAR(30) NOT NULL DEFAULT 'AI_DECISION'
    CHECK (source IN ('AI_DECISION', 'FLOOD_RISK', 'FORECAST', 'MAINTENANCE', 'VISION', 'SENSOR', 'MANUAL')),
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

CREATE INDEX idx_incidents_drain_id ON incidents(drain_id);
CREATE INDEX idx_incidents_status ON incidents(status);
CREATE INDEX idx_incidents_severity ON incidents(severity);
CREATE INDEX idx_incidents_source ON incidents(source);
CREATE INDEX idx_incidents_created_at ON incidents(created_at);

CREATE UNIQUE INDEX idx_incidents_one_active_per_drain
  ON incidents(drain_id)
  WHERE status IN ('OPEN', 'ACKNOWLEDGED', 'RESPONDING');

-- ============================================================
-- MISSIONS
-- ============================================================

CREATE TABLE missions (
  id SERIAL PRIMARY KEY,
  robot_id INTEGER REFERENCES robots(id) ON DELETE SET NULL,
  drain_id INTEGER REFERENCES drains(id) ON DELETE SET NULL,
  mission_status VARCHAR(30) DEFAULT 'Assigned',
  assigned_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  completed_time TIMESTAMP,
  progress INTEGER DEFAULT 0
);

-- ============================================================
-- CHARGING STATIONS
-- ============================================================

CREATE TABLE charging_stations (
  id SERIAL PRIMARY KEY,
  station_name VARCHAR(100),
  latitude NUMERIC(10,7),
  longitude NUMERIC(10,7)
);

-- ============================================================
-- REPORTS
-- ============================================================

CREATE TABLE reports (
  id SERIAL PRIMARY KEY,
  report_title VARCHAR(255),
  total_drains INTEGER DEFAULT 0,
  active_robots INTEGER DEFAULT 0,
  critical_alerts INTEGER DEFAULT 0,
  generated_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);