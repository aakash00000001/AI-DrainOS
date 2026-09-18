-- ============================================================
-- AI-DrainOS Migration 007 - weather_observations
--
-- Update #23 (Weather + Flood Correlation Intelligence) persists
-- REAL forward-observed OpenWeatherMap snapshots in this table.
-- It is NEVER backfilled or seeded with invented history - on a
-- fresh install it starts empty and the correlation layer reports
-- honest WEATHER_UNAVAILABLE states until real observations
-- accumulate.
--
-- Fields mirror the raw OWM current-weather payload (metric
-- units). rain_1h / rain_3h are only present when the payload
-- reported rain; analysis treats missing values as 0 mm (dry),
-- never as invented rainfall.
--
-- Idempotent: safe to run on every startup for existing installs.
-- Mirrors database/schema.sql for fresh installs.
-- ============================================================

CREATE TABLE IF NOT EXISTS weather_observations (
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

CREATE INDEX IF NOT EXISTS idx_weather_observations_observed_at
  ON weather_observations(observed_at);