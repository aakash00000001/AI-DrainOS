-- ============================================================
-- AI-DrainOS Database Schema
-- Run via: node database/setup.js   (or psql -f)
-- ============================================================

DROP TABLE IF EXISTS sensor_readings CASCADE;
DROP TABLE IF EXISTS refresh_tokens CASCADE;
DROP TABLE IF EXISTS settings CASCADE;
DROP TABLE IF EXISTS reports CASCADE;
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