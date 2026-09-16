# 🚧 AI-DrainOS: Autonomous Municipal Drainage Monitoring & Robot Dispatch System

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js Version](https://img.shields.io/badge/Node.js-v20%2B-brightgreen)](https://nodejs.org)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-15%2B-blue)](https://www.postgresql.org)
[![Python](https://img.shields.io/badge/Python-3.10%2B-blue)](https://www.python.org)
[![Docker](https://img.shields.io/badge/Docker-Supported-blue)](https://www.docker.com)

**AI-DrainOS** is an intelligent, full-stack municipal drainage management platform designed to monitor urban drainage networks in real time, predict flood risks using machine learning, automate autonomous cleaning robot dispatches, manage battery charging lifecycles, and enforce strict Role-Based Access Control (RBAC).

---

## Table of Contents

1. [Project Title](#1-project-title)
2. [Project Overview](#2-project-overview)
3. [Problem Statement](#3-problem-statement)
4. [Objectives](#4-objectives)
5. [Key Features](#5-key-features)
6. [System Architecture](#6-system-architecture)
7. [Frontend Architecture](#7-frontend-architecture)
8. [Backend Architecture](#8-backend-architecture)
9. [Python AI Service Architecture](#9-python-ai-service-architecture)
10. [PostgreSQL Database](#10-postgresql-database)
11. [Socket.IO Real-time Communication](#11-socketio-real-time-communication)
12. [Robot Mission Engine](#12-robot-mission-engine)
13. [Robot Charging System](#13-robot-charging-system)
14. [Sensor Simulator](#14-sensor-simulator)
15. [AI Flood Prediction](#15-ai-flood-prediction)
16. [Manual Mission Control](#16-manual-mission-control)
17. [Notification System](#17-notification-system)
18. [Settings Management](#18-settings-management)
19. [Authentication and RBAC](#19-authentication-and-rbac)
20. [API Endpoint List](#20-api-endpoint-list)
21. [Database Tables](#21-database-tables)
22. [Important Socket.IO Events](#22-important-socketio-events)
23. [Environment Variables](#23-environment-variables)
24. [Installation Instructions](#24-installation-instructions)
25. [Development Setup](#25-development-setup)
26. [How to Start PostgreSQL](#26-how-to-start-postgresql)
27. [How to Start Backend](#27-how-to-start-backend)
28. [How to Start Frontend](#28-how-to-start-frontend)
29. [How to Start Python AI Service](#29-how-to-start-python-ai-service)
30. [How to Start Sensor Simulator](#30-how-to-start-sensor-simulator)
31. [Testing Instructions](#31-testing-instructions)
32. [Project Folder Structure](#32-project-folder-structure)
33. [System Workflow](#33-system-workflow)
34. [Robot Lifecycle](#34-robot-lifecycle)
35. [Critical Drain Workflow](#35-critical-drain-workflow)
36. [Sensor → AI → Alert Workflow](#36-sensor--ai--alert-workflow)
37. [Mission → Robot → Cleaning → Charging Workflow](#37-mission--robot--cleaning--charging-workflow)
38. [Screenshots Section](#38-screenshots-section)
39. [Known Limitations](#39-known-limitations)
40. [Future Enhancements](#40-future-enhancements)

---

## 1. Project Title
**AI-DrainOS — Smart Municipal Drainage Monitoring & Autonomous Robot Dispatch Platform**

## 2. Project Overview
AI-DrainOS unifies IoT telemetry, machine learning flood predictions, GIS mapping, real-time WebSockets, and automated robotic cleaning into a single command center.

## 3. Problem Statement
Urban flash flooding caused by blocked storm drains poses significant risks to infrastructure and safety. Manual drain inspection is reactive, dangerous, and inefficient. AI-DrainOS solves this through real-time telemetry, predictive AI, and autonomous robot dispatches.

## 4. Objectives
- Provide real-time visibility into municipal drainage health.
- Automate flood risk predictions using machine learning.
- Dispatch autonomous robots to critical drains before flash floods occur.
- Manage robot battery lifecycles and automated charging.
- Deliver granular Role-Based Access Control (Admin / Operator).

## 5. Key Features
- **Real-Time GIS Drain Map**: Interactive Leaflet map with animated robot markers (`react-leaflet-drift-marker`).
- **Autonomous Robot Dispatch**: Automatic nearest-robot assignment for drains flagged Critical.
- **AI Risk Engine**: Python machine learning service evaluating water level, gas, and temperature telemetry.
- **Battery Management & Charging**: Autonomous routing to designated charging stations when battery drops below low threshold (20%).
- **User Management & RBAC**: Admin management of system users, role privileges, and account activation/deactivation.
- **Real-time Notifications**: Instant Socket.IO notifications for critical alerts, low battery warnings, and completed cleanings.
- **MQTT IoT Sensor Integration**: Consumes live readings from MQTT-capable IoT drain sensors (or the bundled `simulate:mqtt` simulator), validates them, persists to PostgreSQL, runs AI prediction, and streams live `sensorUpdate` events.
- **Flood Risk Intelligence & Early Warning**: An explainable, deterministic Flood Risk Score (0–100) + risk level (LOW/MODERATE/HIGH/CRITICAL) computed from water/gas/temperature plus a rising-water trend component, combined with the AI prediction and broadcast live via `floodRiskUpdate`.
- **Predictive Flood Forecasting & 15/30/60-Minute Early Warning**: An "Explainable Baseline Forecast" that fits a time-aware water-level trend and projects each drain's future risk at 15 / 30 / 60 minutes (reusing the flood risk engine), streamed live via `forecastUpdate`, with dedicated `Flood Forecast` early-warning alerts and an honest "insufficient history" status (no fabricated confidence).
- **Drain Maintenance & Blockage Prediction**: A third independent analytical layer that looks at long-term operational patterns (cleaning history, rising trends, gas/temperature anomalies, alert frequency) to predict whether a drain needs inspection or cleaning soon. Honest baseline — never claims physical blockage, never reports confidence. Live `maintenanceUpdate` events, `Maintenance` alert type, audit trail in `maintenance_predictions` table, and a dashboard panel.
- **Drain Vision Inspection**: Baseline **computer-vision** drain inspection driven by OpenCV (Python AI service) with an honest local PNG fallback. Upload a drain image (JPG/JPEG/PNG/WEBP, ≤5 MB), get visual risk / possible-blockage scores, findings and a recommendation — with an `INSUFFICIENT_IMAGE_QUALITY` status when an image cannot be analyzed (never fabricates results). Results stay **separate** from the sensor maintenance engine and are stored as metadata-only rows in the `drain_vision_inspections` table. Robot dispatch is only ever a recommendation flag — `missionEngine.js` remains the authority. Live `visionInspectionUpdate` events + `Vision Inspection` alert type (+ dashboard panel + analytics section).
- **System Settings**: Configurable thresholds for water levels, battery limits, and simulation intervals.
- **PDF Report Generation**: Exportable system analytical reports.

## 6. System Architecture

```mermaid
graph TD
    UI["React Frontend (Vite)"] <-->|REST API + WebSockets| Server["Node.js / Express Backend"]
    Server <-->|SQL Queries| DB[("PostgreSQL DB")]
    Server <-->|HTTP POST /predict| AI["Python AI Service"]
    IoT["IoT Sensors / MQTT Simulator"] -->|MQTT ai-drainos/drains/+/sensors/+| Broker["MQTT Broker"]
    Broker -->|Subscribed Readings| Server
    Server -->|Sensor Readings + History| Risk["Flood Risk Engine<br/>(current risk score 0-100 + level)"]
    Risk -->|floodRiskUpdate event| UI
    Risk -->|Predicted Water + History| Forecast["Forecast Engine<br/>(15/30/60 min projections)"]
    Forecast -->|forecastUpdate event| UI
    Server -->|Sensor + Mission + Alert History| Maintenance["Maintenance Engine<br/>(inspection/cleaning need)"]
    Maintenance -->|maintenanceUpdate event| UI
    UI -->|POST drain image| Vision["Vision Engine<br/>(OpenCV baseline + local fallback)"]
    Vision -->|visionInspectionUpdate event| UI
    Vision -->|Metadata audit trail| DB
    Sim["Sensor Simulator Script"] -->|Telemetry Inserts| DB
```

Detailed architectural specifications are available in [docs/architecture.md](docs/architecture.md).

## 7. Frontend Architecture
Built with React 19, Vite 8, Vanilla CSS design tokens, React-Leaflet, Chart.js / Recharts, and Socket.IO client. Uses modular layout components (`DashboardLayout`, `Sidebar`, `Header`) and views (`UsersPage`, `SettingsPage`, `MissionControl`).

## 8. Backend Architecture
Node.js + Express backend featuring modular routes (`auth`, `drains`, `robots`, `missions`, `sensors`, `alerts`, `predictions`, `settings`), JWT authentication middleware, role enforcement (`adminOnly`), and a 5-second event loop driving real-time simulation logic.

## 9. Python AI Service Architecture
Flask application running on port 5001. Loads joblib-serialized ML model (`model.pkl`) to predict flood risk (`LOW`, `MEDIUM`, `HIGH`) based on water level, gas level, and temperature inputs. It also exposes a baseline **computer-vision** endpoint (`POST /vision/analyze`) using OpenCV (`cv2`) that decodes a drain image and returns low-level pixel features (brightness, darkness ratio, edge density, texture variance, water-like regions, dense irregular regions) — see [docs/vision-inspection.md](docs/vision-inspection.md). Dependencies are listed in `ai/requirements.txt`.

## 10. PostgreSQL Database
Relational model database storing system accounts, session tokens, configurations, GIS drain locations, robot state, sensor telemetry, alerts, and mission logs. Detailed schema details available in [docs/database.md](docs/database.md).

## 11. Socket.IO Real-time Communication
Integrated WebSocket server pushing dynamic updates (`drainCleaned`, `criticalAlert`, `batteryLow`, `dashboardUpdate`) to connected client dashboards without requiring full-page reloads.

## 12. Robot Mission Engine
Service module (`services/missionEngine.js`) calculating nearest available idle robot using Euclidean distance formula and assigning active dispatch targets to blocked drains.

## 13. Robot Charging System
Automatic low battery detection (battery <= 20%). Re-routes active/idle robots to nearest charging hub (`charging_stations`), incrementally charges battery (+2% per loop), and resets status to `Idle` at 100%.

## 14. Sensor Simulator
Background utility (`scripts/simulateSensors.js`) inserting realistic sensor telemetry (water level, toxic gas level, temperature) to simulate real-world municipal sensor feeds.

## 15. AI Flood Prediction
Machine learning integration (`routes/predictions.js`) forwarding live sensor data to the Python AI service, with automatic fallback to local threshold rules if the AI endpoint is unreachable.

## 15b. Flood Risk Intelligence & Early Warning
The flood risk engine (`server/services/floodRiskService.js`) computes an explainable
**Risk Score (0–100)** and **Risk Level (LOW/MODERATE/HIGH/CRITICAL)** from
water (50%), gas (15%), temperature (10%) and a rising-water trend component
(25%), using a minimal historical readings table (`sensor_readings`). It combines
with the existing AI prediction, drives early-warning alerts, and broadcasts live
updates via the `floodRiskUpdate` Socket.IO event. The dashboard shows the current
highest-risk drain with a factor-by-factor breakdown, and analytics now include
average risk + HIGH/CRITICAL counts.

📄 Full documentation (formula, weights, thresholds, API, alerts, limitations):
[docs/flood-risk.md](docs/flood-risk.md).

## 15c. Predictive Flood Forecasting & 15/30/60-Minute Early Warning
The forecasting layer (`server/services/floodForecastService.js`) answers "is this
drain about to flood within the hour?". It fits a **time-aware** water-level trend
(per-minute linear regression over the most recent readings), **projects** water
level at **15 / 30 / 60 minutes** (clamped 0–100), then feeds each projected value
through the **existing** flood risk engine to get a predicted risk level per
horizon. A worst-horizon early-warning alert (`Flood Forecast`) is created for
predicted HIGH/CRITICAL and resolved once the prediction drops. Everything is
streamed live via `forecastUpdate`, the dashboard adds a **Predictive Flood
Forecast** panel, and the model is deliberately structured behind the service so a
trained ML model can replace it later without touching routes, UI or tests.

📄 Full documentation (method, formula, data, alerts, events, API, ML drop-in):
[docs/forecasting.md](docs/forecasting.md).

## 15d. Drain Vision Inspection (Computer Vision)
The vision layer (`server/services/drainVisionService.js`) accepts a single drain
inspection image. The Python AI service decodes it with OpenCV and returns pixel
features; when that service is unreachable an honest local PNG fallback computes the
same feature set. One deterministic scorer turns features into **visual risk** and
**possible blockage** scores (0–100), an inspection level
(LOW/MODERATE/HIGH/CRITICAL), explainable findings and a recommendation. Images that
cannot be analyzed return `INSUFFICIENT_IMAGE_QUALITY` — never a fabricated result.
Inspections are stored as metadata-only audit rows (`drain_vision_inspections`),
HIGH/CRITICAL results create a deduplicated, upgradable `Vision Inspection` alert
(resolved once a later inspection is clear), results stream live via
`visionInspectionUpdate`, and the dashboard adds a **Drain Vision Inspection** panel
with a recent-inspections history. Vision stays **separate** from the sensor
maintenance engine and robot dispatch remains recommendation-only
(`missionEngine.js` is untouched).

📄 Full documentation (features, scoring, honest status, API, alerts, ML replacement):
[docs/vision-inspection.md](docs/vision-inspection.md).

## 16. Manual Mission Control
UI interface (`pages/MissionControl.jsx`) enabling operators to manually select specific drains and dispatch available robots on demand.

## 17. Notification System
Toast alerts powered by `react-toastify` and `NotificationDropdown` triggered by backend Socket.IO events.

## 18. Settings Management
System parameters (`critical_threshold`, `warning_threshold`, `battery_low_threshold`, `sensor_sim_interval`) adjustable by Administrators via `SettingsPage.jsx`.

## 19. Authentication and RBAC
JWT bearer authentication with bcrypt password hashing.
- **Admin**: Full control (Manage users, settings, drains, robots, missions, view analytics/sensors).
- **Operator**: Operational view (View dashboard, map, sensors, manual robot dispatch, flag drain critical; read-only settings; restricted from user management).

## 20. API Endpoint List
Comprehensive list of REST endpoints documented in [docs/api.md](docs/api.md).

## 21. Database Tables
Database tables (`users`, `refresh_tokens`, `settings`, `drains`, `robots`, `sensors`,
`sensor_readings`, `alerts`, `missions`, `charging_stations`, `reports`,
`maintenance_predictions`, `drain_vision_inspections`) documented in
[docs/database.md](docs/database.md). `sensor_readings` is the minimal flood-risk
history table (see [docs/flood-risk.md](docs/flood-risk.md)); an idempotent migration
(`database/migrations/002_sensor_readings.sql`) is applied automatically to existing
databases by `scripts/dbInit.js` without destroying data. The vision metadata audit
table is added the same way via `database/migrations/004_drain_vision_inspections.sql`.

## 22. Important Socket.IO Events
- `drainCleaned`: Fired when a robot reaches target drain and completes cleaning.
- `criticalAlert`: Fired when a **new** Critical alert is created.
- `batteryLow`: Fired when a robot battery drops <= 20% and is routed to a charging station.
- `dashboardUpdate`: Emitted every 5s with latest system stat counters.
- `sensorUpdate`: Emitted when a valid MQTT sensor reading is stored (drainId, sensorId, water/gas/temp, AI prediction, plus additive flood risk score/level/trend, 60-min forecast score/level/trend, and maintenance score/level/blockage-risk/recommendation).
- `floodRiskUpdate`: Emitted when a drain's Flood Risk level changes (or its score moves ≥ 2 points) with the explainable risk breakdown + AI prediction.
- `forecastUpdate`: Emitted when a drain's worst predicted (60-min) forecast level changes (or its score moves ≥ 2 points) with the 15/30/60-minute horizon projections and trend information.
- `maintenanceUpdate`: Emitted when a drain's maintenance level changes (or its maintenance score moves ≥ 3 points) with maintenance/blockage scores, level, inspection priority, recommendation, and explainable reasons.
- `Maintenance` alert type: created when a drain's maintenance level is HIGH (Medium severity) or CRITICAL (Critical severity), deduplicated per drain, resolved when level drops below HIGH.
- `visionInspectionUpdate`: Emitted after a drain vision inspection completes (status READY or INSUFFICIENT_IMAGE_QUALITY) with visual-risk / possible-blockage scores, level, findings, recommendation, robot-inspection flag and image dimensions.
- `Vision Inspection` alert type: created when a vision inspection level is HIGH (Medium severity) or CRITICAL (Critical severity), deduplicated per drain, upgrade-only, resolved when a later inspection is LOW/MODERATE.

## 23. Environment Variables
- `POSTGRES_HOST` (default: localhost)
- `POSTGRES_PORT` (default: 5432)
- `POSTGRES_DB` (default: ai_drainos)
- `POSTGRES_USER` (default: postgres)
- `POSTGRES_PASSWORD` (default: admin123)
- `PORT` (default: 5000)
- `JWT_SECRET` (default: supersecretkey)
- `AI_SERVICE_URL` (default: http://127.0.0.1:5001)
- `OPENWEATHER_API_KEY` (optional key for live weather data in `WeatherMonitor` / `WeatherForm`)
- `FRONTEND_URL` (default: http://localhost:5173, used in Socket.IO CORS and the backend REST CORS allow-list; supports comma-separated origins when set)
- `MQTT_BROKER_URL` (default: mqtt://localhost:1883)
- `MQTT_USERNAME` (optional broker auth)
- `MQTT_PASSWORD` (optional broker auth)
- `MQTT_CLIENT_ID` (default: ai-drainos-backend)
- `MQTT_TOPIC_PREFIX` (default: ai-drainos)
- `MQTT_ENABLED` (default: true, set false to disable MQTT)
- `MQTT_SIM_INTERVAL` (seconds between `simulate:mqtt` publish rounds)
- `VITE_API_URL` (default: http://localhost:5000/api)
- `VITE_SOCKET_URL` (default: http://localhost:5000)

## 24. Installation Instructions
1. Clone the repository.
2. Install root, server, and client dependencies:
   ```bash
   npm run install:all
   ```

## 25. Development Setup
Run database setup script:
```bash
cd server
npm run db:setup        # create tables + seed data
npm run db:setup:fresh  # drop + recreate + seed (restores pristine demo state)
```

## 26. How to Start PostgreSQL
Ensure local PostgreSQL service is active or run via Docker:
```bash
docker compose up postgres -d
```

## 27. How to Start Backend
```bash
cd server
npm run dev
```

## 28. How to Start Frontend
```bash
cd client
npm run dev
```

## 29. How to Start Python AI Service
```bash
cd ai
python -m venv venv            # first time only
venv\Scripts\pip install -r requirements.txt   # first time only (adds OpenCV)
python app.py
```
Serves `POST /predict` (flood risk ML) and `POST /vision/analyze`
(OpenCV baseline drain-image analysis) on port 5001.

## 30. How to Start Sensor Simulator
```bash
cd server
npm run simulate
```

## 30b. How to Start MQTT Broker + MQTT Sensor Simulator
Start an MQTT broker (Docker recommended, no Docker needed if you install
[Mosquitto](https://mosquitto.org/download/) locally):
```bash
# Option 1: Docker
docker compose up -d mosquitto

# Option 2: local Mosquitto on Windows
mosquitto -v
```

Then start the MQTT simulator (from `server/`):
```bash
npm run simulate:mqtt
```

MQTT topics, payload format, dashboard wiring, and a step-by-step run/verify
guide are documented in [docs/mqtt.md](docs/mqtt.md).

## 31. Testing Instructions
Execute automated API test suite against safe test database:
```bash
cd server
npm test
```
The suite currently includes **170 tests** covering auth, RBAC, drains, robots, missions,
alerts, settings, analytics, workflow integration, MQTT (topic parsing, payload validation,
database mapping, AI prediction, socket emission, alert escalation, and broker-failure
resilience), the flood risk engine (normalization, trend, classification, historical
readings, MQTT → risk integration, `floodRiskUpdate` dedupe, alert dedup/recovery, AI
fallback, and the risk REST endpoints), the predictive flood forecast engine
(time-series cleaning, trend fit, direction labels, projections, honest status handling,
determinism, no-fabricated-confidence contract, `Flood Forecast` alerts,
`forecastUpdate` dedupe/emission, and the forecast REST/analytics endpoints), the
maintenance engine, and the drain vision inspection pipeline (image-type detection,
PNG decoder, feature extraction, scoring thresholds, honest-status contract, upload
validation, persistence, history, `Vision Inspection` alert lifecycle, and the vision
REST/analytics endpoints).

## 32. Project Folder Structure
```
AI-DrainOS/
├── ai/                      # Python Flask AI prediction + vision service
│   ├── app.py
│   ├── model.pkl
│   ├── requirements.txt
│   └── train_model.py
├── client/                  # React Vite Frontend Application
│   ├── src/
│   │   ├── components/
│   │   ├── pages/
│   │   ├── services/
│   │   └── App.jsx
│   └── vite.config.js
├── server/                  # Node.js Express Backend & Socket.IO
│   ├── config/
│   ├── controllers/
│   ├── middleware/
│   ├── routes/
│   ├── services/
│   ├── tests/
│   ├── app.js
│   └── index.js
├── database/                # SQL Schema, Migrations and Seed data
│   ├── schema.sql
│   ├── seed.sql
│   └── migrations/002_sensor_readings.sql
│   └── migrations/003_maintenance_predictions.sql
│   └── migrations/004_drain_vision_inspections.sql
├── docs/                    # Architectural & API Documentation
│   ├── architecture.md
│   ├── api.md
│   ├── database.md
│   ├── workflow.md
│   ├── mqtt.md
│   ├── flood-risk.md
│   ├── forecasting.md
│   └── vision-inspection.md
├── docker/                  # Multi-service Dockerfiles
├── docker-compose.yml
├── .env.example
└── README.md
```

## 33. System Workflow
Detailed step-by-step workflows documented in [docs/workflow.md](docs/workflow.md).

## 34. Robot Lifecycle
Idle → Active (Dispatched) → Movement to Target → Drain Cleaning → Completed → Charging (if battery <= 20%) → Fully Charged (100%) → Idle.

## 35. Critical Drain Workflow

```mermaid
flowchart LR
    Sensor --> AI[AI Risk Check] --> Critical[Drain Marked Critical] --> Mission[Mission Assigned] --> Robot[Robot Dispatched] --> Clean[Cleaned] --> Normal[Drain Reset Normal]
```

## 36. Sensor → AI → Alert Workflow
Sensor Telemetry → Express API → Flask AI (`POST /predict`) → Alert Table → Socket.IO (`criticalAlert`) → Frontend Toast Notification.

## 37. Mission → Robot → Cleaning → Charging Workflow
Mission Assigned → Target GIS Set → Live Loop Movement → Destination Reached → Drain Normal → Battery Check → Station Routing → Fully Charged.

## 38. Screenshots Section
*(Add UI Screenshots here)*
- Dashboard Overview
- Real-time Drain GIS Map
- User Management Page
- System Settings

## 39. Known Limitations
- Simulated GIS step movement uses approximate linear increments rather than road-network pathfinding.
- Sensor simulator runs locally in synthetic mode.

## 40. Future Enhancements
- Integration with OpenStreetMap OSRM routing engine for real-world road navigation.
- Physical IoT sensor device hardware integration via MQTT protocol.
- Swap the Explainable Baseline Forecast for a trained deep-learning flood forecasting model (the service contract in [docs/forecasting.md](docs/forecasting.md) is already structured for this).
