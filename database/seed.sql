-- ============================================================
-- AI-DrainOS Seed Data (Madurai, Tamil Nadu)
-- Placeholders __ADMIN_HASH__ / __OPERATOR_HASH__ are replaced
-- with real bcrypt hashes by database/setup.js
-- ============================================================

-- ------------------------------------------------------------
-- USERS  (default passwords: admin123 / operator123)
-- ------------------------------------------------------------

INSERT INTO users (full_name, email, password, role) VALUES
('Administrator', 'admin@aidrain.com', '__ADMIN_HASH__', 'Admin'),
('Operator', 'operator@aidrain.com', '__OPERATOR_HASH__', 'Operator');

-- ------------------------------------------------------------
-- SETTINGS
-- ------------------------------------------------------------

INSERT INTO settings (key, value) VALUES
('system_name', 'AI-DrainOS'),
('critical_threshold', '80'),
('warning_threshold', '50'),
('battery_low_threshold', '20'),
('sensor_sim_interval', '10'),
('notification_enabled', 'true');

-- ------------------------------------------------------------
-- DRAINS
-- ------------------------------------------------------------

INSERT INTO drains (zone_name, location, status, blockage_level, latitude, longitude) VALUES
('Zone 1', 'Goripalayam',        'Normal',   20, 9.9252000, 78.1198000),
('Zone 2', 'KK Nagar',           'Normal',   85, 9.9252000, 78.1198000),
('Zone 3', 'Madurai Main',       'Warning',  45, 9.9270000, 78.1212000),
('Zone 4', 'Bypass Road',        'Normal',   15, 9.9290000, 78.1235000),
('Zone 5', 'Airport Road',       'Critical', 95, 9.9230000, 78.1175000),
('Zone 6', 'Railway Colony',     'Normal',   30, 9.9215000, 78.1205000),
('Zone 7', 'Villapuram',         'Warning',  60, 9.9310000, 78.1240000);

-- ------------------------------------------------------------
-- CHARGING STATIONS
-- ------------------------------------------------------------

INSERT INTO charging_stations (station_name, latitude, longitude) VALUES
('Charging Station A', 9.9250000, 78.1200000),
('Charging Station B', 9.9295000, 78.1185000);

-- ------------------------------------------------------------
-- ROBOTS
-- ------------------------------------------------------------

INSERT INTO robots (robot_name, assigned_zone, status, battery_level, latitude, longitude) VALUES
('Robot-A1', 'Zone 1', 'Idle', 100, 9.9250000, 78.1200000),
('Robot-A2', 'Zone 2', 'Idle',  64, 9.9248500, 78.1198500),
('Robot-B1', 'Zone 3', 'Idle',  63, 9.9248500, 78.1198500),
('Robot-C1', 'Zone 4', 'Idle', 100, 9.9250000, 78.1200000),
('Robot-D1', 'Zone 5', 'Active', 76, 9.9277218, 78.1174649);

-- ------------------------------------------------------------
-- SENSORS
-- ------------------------------------------------------------

INSERT INTO sensors (drain_id, water_level, gas_level, temperature, status) VALUES
(1, 20, 10, 29.00, 'Normal'),
(2, 90, 75, 37.00, 'Critical'),
(3, 55, 40, 33.00, 'Warning'),
(4, 20, 10, 29.00, 'Normal'),
(5, 95, 85, 39.00, 'Critical'),
(6, 25, 15, 30.00, 'Normal'),
(7, 60, 35, 32.00, 'Warning');

-- ------------------------------------------------------------
-- ALERTS
-- ------------------------------------------------------------

INSERT INTO alerts (drain_id, alert_type, message, severity, alert_status) VALUES
(2, 'Blockage',     'Heavy blockage detected in Zone 2',      'Critical', 'Open'),
(5, 'Flood Risk',   'Water level rising rapidly',             'Critical', 'Open'),
(3, 'Sensor Warning', 'Sensor reporting unstable values',     'Medium',   'Open'),
(4, 'Gas Alert',    'Gas level above safe threshold',         'Critical', 'Open');

-- ------------------------------------------------------------
-- MISSION HISTORY
-- ------------------------------------------------------------

INSERT INTO missions (robot_id, drain_id, mission_status, progress, assigned_time, completed_time) VALUES
(1, 5, 'Completed', 100, NOW() - INTERVAL '2 hours',  NOW() - INTERVAL '1 hour 50 minutes'),
(2, 2, 'Completed', 100, NOW() - INTERVAL '5 hours',  NOW() - INTERVAL '4 hours 40 minutes'),
(3, 3, 'Completed', 100, NOW() - INTERVAL '1 day',    NOW() - INTERVAL '23 hours 30 minutes');

-- ------------------------------------------------------------
-- REPORTS
-- ------------------------------------------------------------

INSERT INTO reports (report_title, total_drains, active_robots, critical_alerts) VALUES
('Initial System Report', 7, 1, 2);