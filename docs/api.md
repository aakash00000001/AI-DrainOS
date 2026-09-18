# AI-DrainOS REST API Documentation

Base URL: `http://localhost:5000/api` (or environment configured `VITE_API_URL`)

> **Digital Twin (read-only consumer).** The interactive 3D Digital Twin
> (page + dashboard preview) adds **no new endpoints**. It consumes the
> existing GET routes listed below: `/api/drains`, `/api/sensors`,
> `/api/robots`, `/api/charging-stations`, `/api/dashboard/robot-routes`,
> `/api/dashboard/decisions`, and the per-drain prediction detail routes
> (`/api/predictions/risk|forecast|maintenance|decision|vision/:drainId`).
> See [digital-twin.md](digital-twin.md) for the aggregation model and the
> visualization-coordinate caveat.
>
> **Emergency incidents (additive).** Update #18 adds a `/api/incidents`
> surface plus additive incident fields on `/api/dashboard` and
> `/api/analytics`. Existing response fields are unchanged. The Digital Twin
> additionally consumes `GET /api/incidents/active`. See
> [incidents.md](incidents.md).

---

## Authentication & User Management (`/api/auth`)

### `POST /api/auth/login`
- **Access**: Public
- **Request Body**:
  ```json
  {
    "email": "admin@aidrain.com",
    "password": "admin123"
  }
  ```
- **Response** (200 OK):
  ```json
  {
    "token": "<JWT_ACCESS_TOKEN>",
    "refreshToken": "<JWT_REFRESH_TOKEN>",
    "user": {
      "id": 1,
      "full_name": "Administrator",
      "email": "admin@aidrain.com",
      "role": "Admin",
      "status": "Active"
    }
  }
  ```

### `POST /api/auth/refresh`
- **Access**: Public
- **Request Body**: `{ "refreshToken": "<JWT_REFRESH_TOKEN>" }`
- **Response** (200 OK): `{ "token": "<NEW_JWT_ACCESS_TOKEN>", "user": { ... } }`

### `POST /api/auth/logout`
- **Access**: Public
- **Request Body**: `{ "refreshToken": "<JWT_REFRESH_TOKEN>" }`
- **Response** (200 OK): `{ "message": "Logged out successfully" }`

### `GET /api/auth/me`
- **Access**: Authenticated (`Bearer <token>`)
- **Response** (200 OK): User profile object omitting password hash.

### `PUT /api/auth/me/password`
- **Access**: Authenticated (`Bearer <token>`)
- **Request Body**: `{ "currentPassword": "admin123", "newPassword": "newpassword123" }`
- **Response** (200 OK): `{ "message": "Password changed successfully" }`

### `GET /api/auth/users`
- **Access**: Admin Only (`Bearer <token>`)
- **Response** (200 OK): Array of all user accounts.

### `POST /api/auth/register`
- **Access**: Admin Only (`Bearer <token>`)
- **Request Body**: `{ "full_name": "John Doe", "email": "john@aidrain.com", "password": "password123", "role": "Operator", "status": "Active" }`
- **Response** (201 Created): User creation summary.

### `PUT /api/auth/users/:id`
- **Access**: Admin Only (`Bearer <token>`)
- **Request Body**: `{ "full_name": "Updated Name", "email": "john@aidrain.com", "role": "Operator", "status": "Active" }`
- **Response** (200 OK): Updated user details.

### `PATCH /api/auth/users/:id/status`
- **Access**: Admin Only (`Bearer <token>`)
- **Request Body**: `{ "status": "Inactive" }`
- **Response** (200 OK): Updated user record with new status.

### `DELETE /api/auth/users/:id`
- **Access**: Admin Only (`Bearer <token>`)
- **Response** (200 OK): `{ "message": "User deleted successfully" }`

---

## Drains API (`/api/drains`)

### `GET /api/drains`
- **Access**: Public / Authenticated
- **Response** (200 OK): Array of drain zone objects with coordinates and blockage levels.

### `GET /api/drains/:id`
- **Access**: Public / Authenticated
- **Response** (200 OK): Single drain object.

### `POST /api/drains`
- **Access**: Authenticated
- **Request Body**: `{ "zone_name": "Zone 8", "location": "Anna Nagar", "status": "Normal", "blockage_level": 15, "latitude": 9.93, "longitude": 78.12 }`
- **Response** (201 Created): Created drain record.

### `PUT /api/drains/:id`
- **Access**: Authenticated
- **Request Body**: `{ "zone_name": "Zone 1", "location": "Goripalayam", "status": "Normal", "blockage_level": 30, "latitude": 9.9252, "longitude": 78.1198 }`
- **Response** (200 OK): Updated drain record.
- **Note**: When `status` is set to `Normal`, any open alerts for that drain are automatically marked `Resolved`. Setting a drain to `Critical` (via this route or `PATCH /api/drains/:id/status`) triggers the mission engine to auto-dispatch the nearest available robot.

### `PATCH /api/drains/:id/status`
- **Access**: Authenticated
- **Request Body**: `{ "status": "Critical" }`
- **Response** (200 OK): Updated status confirmation.

### `DELETE /api/drains/:id`
- **Access**: Authenticated
- **Response** (200 OK): Deletion status.

---

## Robots & Mission API (`/api/robots`, `/api/missions`)

### `GET /api/robots`
- **Access**: Public / Authenticated
- **Response** (200 OK): List of robots with status, battery level, location, target coordinates.

### `GET /api/missions`
- **Access**: Public / Authenticated
- **Response** (200 OK): Current active & recent missions list.

### `GET /api/missions/history`
- **Access**: Public / Authenticated
- **Query Params**: `?robot_id=2&status=Completed`
- **Response** (200 OK): Mission history records.

### `POST /api/missions/dispatch`
- **Access**: Authenticated
- **Request Body**: `{ "robot_id": 2, "drain_id": 3 }`
- **Response** (201 Created): Mission dispatch object.

---

## Sensors & Predictions (`/api/sensors`, `/api/predictions`)

### `GET /api/sensors`
- **Access**: Public / Authenticated
- **Response** (200 OK): Sensor telemetry list.

### `GET /api/predictions`
- **Access**: Public / Authenticated
- **Response** (200 OK): Returns AI machine learning prediction or fallback calculation.
  ```json
  {
    "prediction": "HIGH",
    "sensor": { "water_level": 90, "gas_level": 75, "temperature": 37.0 },
    "source": "ai"
  }
  ```

### `GET /api/predictions/risk/:drainId`
- **Access**: Public / Authenticated
- **Response** (200 OK): Explainable flood risk score, risk level, trend, and weighted breakdown for a single drain. See [flood-risk.md](flood-risk.md).
- **Response** (404): `{ "error": "Drain not found" }`
- **Response** (400): `{ "error": "Invalid drain id" }`

### `GET /api/predictions/forecast/:drainId`
- **Access**: Public / Authenticated
- **Response** (200 OK): 15/30/60-minute flood forecast with worst-horizon prediction, trend direction, and per-horizon risk levels. See [forecasting.md](forecasting.md).
- **Response** (404): `{ "error": "Drain not found" }`
- **Response** (400): `{ "error": "Invalid drain id" }`

### `GET /api/predictions/maintenance/:drainId`
- **Access**: Public / Authenticated
- **Response** (200 OK): Maintenance and blockage prediction — whether a drain needs inspection or cleaning. Includes `maintenanceScore`, `maintenanceLevel`, `blockageRiskScore`, `blockageRiskLevel`, `inspectionPriority`, `maintenanceRecommendation`, `reasons` (array of explainable strings), and `unavailableSignals`. Returns `status: "INSUFFICIENT_DATA"` when not enough sensor history. See [maintenance-prediction.md](maintenance-prediction.md).
- **Response** (404): `{ "error": "Drain not found" }`
- **Response** (400): `{ "error": "Invalid drain id" }`

### `POST /api/predictions/vision/:drainId`
- **Access**: Public / Authenticated
- **Request**: `multipart/form-data` with a single `image` field (JPG/JPEG/PNG/WEBP, ≤ 5 MB). Magic bytes are verified server-side (file name / MIME are never trusted alone).
- **Response** (200 OK): Drain vision inspection result.
  - `status: "READY"` — visual inspection completed:
    ```json
    {
      "status": "READY",
      "inspectionLevel": "HIGH",
      "visualRiskScore": 62,
      "possibleBlockageScore": 71,
      "findings": ["dark debris-like region", "low-texture region suggests coating"],
      "recommendation": "Manual visual inspection recommended",
      "debrisDetected": true,
      "robotInspectionRecommended": true,
      "imageQuality": { "dimensions": { "width": 640, "height": 480 }, "usable": true },
      "method": "OpenCV Engineering Baseline (Computer Vision) | Local PNG fallback",
      "analyzedAt": "2026-01-01T12:00:00.000Z"
    }
    ```
    Honest wording only — the payload never contains a `confidence`, `accuracy` or `blocked` claim.
  - `status: "INSUFFICIENT_IMAGE_QUALITY"` — image could not be analyzed (undecodable, empty, too small, or AI down with a non-PNG image). Never a fabricated result.
- **Response** (400): `{ "error": "No image file provided" }` | `"Invalid image type"` | `"Image is empty"` | `"Image exceeds the 5MB size limit"` | `"Invalid drain id"` | `"Drain not found"`.
- See [vision-inspection.md](vision-inspection.md).

### `GET /api/predictions/decision/:drainId`
- **Access**: Public / Authenticated
- **Response** (200 OK): AI Drain Decision & Priority Engine output for a single drain — a bounded 0–100 attention-priority score (`priorityScore`), `priorityLevel`, `recommendedAction`, human-readable `reasons`, weighted `contributingFactors`, additive `modifiers` (trend + open alerts), `robotRecommendation` (nearest / already-assigned / battery-too-low / none), `dataAvailability`, and honest `status` (`"READY"` or `"INSUFFICIENT_DATA"` with a null score). See [decision-engine.md](decision-engine.md).
- **Response** (404): `{ "error": "Drain not found" }`
- **Response** (400): `{ "error": "Invalid drain id" }`

### `GET /api/predictions/robot-route/:drainId`
- **Access**: Public / Authenticated
- **Response** (200 OK): Robot Path Planning output for a single drain — selected robot (`robot`), explainable `selectionScore` / `selectionReasons`, a battery-aware `route` (type `DIRECT` or `CHARGING_STOP`) with ordered `waypoints` (START / CHARGING_STATION / TARGET), `totalDistance`, `totalTravelSeconds`, `totalBatteryCost`, `formatTotalTravelTime`, `needsCharging`, optional `chargingStation`, `hasEnoughBattery`, and honest `status` (`"ROBOT_SELECTED"`, `"NO_ROBOT_AVAILABLE"`, `"NO_COORDINATES"`, `"DRAIN_NOT_FOUND"`). Never selects Charging robots or robots with active missions. See [robot-path-planning.md](robot-path-planning.md).
  ```json
  {
    "status": "ROBOT_SELECTED",
    "drain": { "id": 5, "zoneName": "Zone 5", "location": "Airport Road", "latitude": 9.923, "longitude": 78.1175 },
    "robot": { "id": 1, "robotName": "Robot-A1", "status": "Idle", "batteryLevel": 100, "latitude": 9.925, "longitude": 78.12 },
    "selectionScore": 91.7,
    "selectionReasons": ["Distance: 0.003 (~5 m)", "Battery: 100%", "Sufficient battery for direct route"],
    "hasEnoughBattery": true,
    "route": {
      "type": "DIRECT",
      "totalDistance": 0.003,
      "totalTravelSeconds": 300,
      "totalBatteryCost": 60,
      "formatTotalTravelTime": "5 m",
      "needsCharging": false,
      "chargingStation": null,
      "waypoints": [
        { "label": "START", "latitude": 9.925, "longitude": 78.12, "cumulativeDistance": 0 },
        { "label": "TARGET", "latitude": 9.923, "longitude": 78.1175, "cumulativeDistance": 0.003 }
      ]
    },
    "disclaimer": "Route is a coordinate-space approximation ...",
    "generatedAt": "2026-01-01T12:00:00.000Z"
  }
  ```
- **Response** (404): `{ "error": "Drain not found" }`
- **Response** (400): `{ "error": "Invalid drain id" }`

### `GET /api/predictions/vision/:drainId`
- **Access**: Public / Authenticated
- **Query**: optional `history` (default 1, max 20) — how many recent inspections to include.
- **Response** (200 OK): Latest inspection (same shape as the POST result, with `status`, inspection level, scores, findings, recommendation, image metadata) plus `history` array of recent inspections from the `drain_vision_inspections` audit table.
- **Response** (404): `{ "error": "Drain not found" }`
- **Response** (400): `{ "error": "Invalid drain id" }`
- See [vision-inspection.md](vision-inspection.md).

---

## Weather + Flood Correlation API (`/api/predictions/weather-correlation`)

All endpoints are **read-only**, public, and describe the Pearson association between
**real** weather observations (`weather_observations`) and **real** sensor readings
(`sensor_readings`) inside a bounded window (default 24 h, max 168 h). No endpoint ever
fabricates weather, correlation or causality. Every response carries a non-causal
`disclaimer`. See [weather-flood-correlation.md](weather-flood-correlation.md).

| Signal keys | availability |
| ----------- | ------------ |
| `rainfall_water_level`, `humidity_water_level`, `temperature_water_level`, `pressure_water_level`, `wind_water_level` | computed from real aligned pairs |
| `weather_flood_risk`, `weather_forecast` | always `NOT_AVAILABLE` (history not persisted; never recomputed) |

### `GET /api/predictions/weather-correlation`
- **Access**: Public / Authenticated
- **Query**: optional `?window=1..168` (hours; default 24).
- **Response** (200 OK): `{ "status", "generated_at", "window_hours", "disclaimer",
  "weather_data_quality": { "status", "observation_count", "window_hours",
  "first_observation_at", "last_observation_at" }, "signals_ready", "signals_total",
  "signals": [ { "signal", "label", "shortLabel", "description", "status", "r",
  "direction", "strength", "matched_pairs", "message" } ], "strongest", "latest_weather",
  "message" }`.
- **Response** (400): `{ "error": "Invalid window hours" }`.

### `GET /api/predictions/weather-correlation/summary`
- **Access**: Public / Authenticated
- **Query**: optional `?window=`.
- **Response** (200 OK): Compact summary (same shape as the full overview minus `signals`).

### `GET /api/predictions/weather-correlation/signals`
- **Access**: Public / Authenticated
- **Query**: optional `?window=`.
- **Response** (200 OK): Signal definitions plus each signal's current computed
  `status` / `r` / `direction` / `strength`)`.

### `GET /api/predictions/weather-correlation/trends`
- **Access**: Public / Authenticated
- **Query**: optional `?signal=` (default `rainfall_water_level`), `?drainId=`,
  `?window=`, `?lag=0|15|30|60` (rainfall lag minutes, default 0).
- **Response** (200 OK): `{ "status", "samples", "buckets": [ { "bucket",
  "bucket_start", "bucket_end", "matched_pairs", "status", "r", "direction",
  "strength" } ], "trend": "strengthening" | "weakening" | "stable" | "insufficient",
  "trend_reason" }`.
- **Response** (400): `{ "error": "Invalid signal", "valid_signals": [...] }` |
  `{ "error": "Invalid window hours" }` | `{ "error": "Invalid lag minutes",
  "valid_lag_minutes": [0,15,30,60] }` | `{ "error": "Invalid drain id" }`.

### `GET /api/predictions/weather-correlation/drains`
- **Access**: Public / Authenticated
- **Query**: optional `?window=`.
- **Response** (200 OK): `{ "status", "window_hours", "generated_at", "disclaimer",
  "drains": [ { "drain_id", "zone", "location", "status", "strongest" } ] }`.

### `GET /api/predictions/weather-correlation/drain/:drainId`
- **Access**: Public / Authenticated
- **Query**: optional `?signal=`, `?window=`, `?lag=`.
- **Response** (200 OK): Full per-drain correlation result: signal summary (compact) plus
  `samples` (`matched_pairs`, `weather_used`, `sensor_used`, `weather_total`,
  `sensor_total`, `missing_weather`, `timestamp_alignment`, `window_hours`, `lag_minutes`,
  `tolerance_minutes`), `correlation`, `wording`, `disclaimer` and `drain_id`.
- **Response** (404): `{ "error": "Drain not found" }`.
- **Response** (400): `{ "error": "Invalid drain id" }` | invalid signal / window / lag.

### `GET /api/predictions/weather-correlation/:signal`
- **Access**: Public / Authenticated
- **Query**: optional `?drainId=`, `?window=`, `?lag=`.
- **Response** (200 OK): Single-signal correlation (full detail, optionally filtered to one
  drain).
- **Response** (404): `{ "error": "Signal not found" }`.
- **Response** (400): `{ "error": "Invalid signal", "valid_signals": [...] }` | invalid
  drain id / window / lag.

### Socket event
The service emits `weatherFloodCorrelationUpdate` through the **existing shared** hub
(signature + throttle guarded — never per 5-second tick, never per MQTT packet) with the
summary payload. No second Socket.IO server is created. Wired into the live 5-second loop;
the MQTT pipeline only triggers the guarded refresh path.

---

## Incidents API (`/api/incidents`)

An auditable emergency lifecycle: `OPEN → ACKNOWLEDGED → RESPONDING → RESOLVED`.
GET routes are Public; POST/PUT require `Bearer <token>`. Severity is one of
`LOW | MODERATE | HIGH | CRITICAL`; source is one of
`AI_DECISION | FLOOD_RISK | FORECAST | MAINTENANCE | VISION | MANUAL`.
See [incidents.md](incidents.md).

### `GET /api/incidents`
- **Access**: Public / Authenticated
- **Query Params**: `?status=OPEN&severity=CRITICAL&drain_id=5` (all optional)
- **Response** (200 OK): Array of incident objects. Each row carries `id`, `drain_id`,
  `severity`, `title`, `description`, `source`, `decision_score`, `decision_level`,
  `assigned_robot_id`, `route_status`, `status`, all lifecycle timestamps,
  `resolution_notes`, and nested `drain` (zone/location) and `robot` (robotName).

### `GET /api/incidents/active`
- **Access**: Public / Authenticated
- **Response** (200 OK): Only incidents in `OPEN`, `ACKNOWLEDGED` or `RESPONDING`.

### `GET /api/incidents/:id`
- **Access**: Public / Authenticated
- **Response** (200 OK): Single incident object.
- **Response** (404): `{ "error": "Incident not found" }`

### `GET /api/incidents/:id/timeline`
- **Access**: Public / Authenticated
- **Response** (200 OK): Lifecycle events derived **only** from stored timestamps
  (`incident created`, `robot assigned`, `route status`, `acknowledged`,
  `response started`, `resolved`). Missing timestamps are omitted, never fabricated.
- **Response** (404): `{ "error": "Incident not found" }`

### `POST /api/incidents`
- **Access**: Authenticated
- **Request Body**:
  ```json
  {
    "drain_id": 5,
    "severity": "CRITICAL",
    "source": "MANUAL",
    "title": "Sinkhole reported",
    "description": "Optional context"
  }
  ```
- **Response** (201 Created): The created incident (for a CRITICAL incident an automatic robot plan may set `route_status` to `PLANNED`, `NO_ROBOT_AVAILABLE` or `NO_COORDINATES`).
- **Response** (400): `{ "error": "Invalid drain id" }` | `"Invalid severity"` | `"Invalid source"`.
- **Response** (404): `{ "error": "Drain not found" }`.
- **Response** (409): duplicate active incident (`DUPLICATE_ACTIVE_INCIDENT`), or — for `source: "AI_DECISION"` — `NOT_CRITICAL` / `NO_VALID_DECISION` (the real decision engine result is authoritative; severity is never fabricated).

### `PUT /api/incidents/:id/acknowledge`
- **Access**: Authenticated
- **Response** (200 OK): Updated incident (`status: "ACKNOWLEDGED"`).
- **Response** (409): invalid transition (e.g. already resolved).

### `PUT /api/incidents/:id/respond`
- **Access**: Authenticated
- **Response** (200 OK): Updated incident (`status: "RESPONDING"`).
- **Response** (409): invalid transition.

### `PUT /api/incidents/:id/resolve`
- **Access**: Authenticated
- **Request Body**: `{ "resolution_notes": "Cleared and inspected" }` (optional)
- **Response** (200 OK): Updated incident (`status: "RESOLVED"`).
- **Response** (409): already resolved.

### Socket event
Every real change emits `incidentUpdate` through the existing shared hub:
```json
{ "eventType": "created", "incident": { "id": 12, "severity": "CRITICAL", "status": "OPEN" } }
```
`eventType` ∈ `created | assigned | robotUnavailable | acknowledged | responded | resolved`.

---

## Alerts, Settings & Dashboard

### `GET /api/alerts`
- **Access**: Public / Authenticated

### `POST /api/alerts`
- **Access**: Authenticated

### `PUT /api/alerts/:id`
- **Access**: Authenticated

### `GET /api/settings`
- **Access**: Public / Authenticated

### `PUT /api/settings`
- **Access**: Admin Only (`Bearer <token>`)

### `GET /api/dashboard`
- **Access**: Public / Authenticated
- **Response** (200 OK): `{ "totalDrains": 7, "activeRobots": 1, "criticalAlerts": 2, "incidents": { "counts": { "active": 1, "critical": 1, "responding": 0, "resolved": 2, "open": 1, "acknowledged": 0, "total": 3 }, "latest": [ ...incidents ] }, "fleet": { "totalRobots": 5, "availableRobots": 2, "busyRobots": 1, "chargingRobots": 1, "lowBatteryRobots": 1, "activeTasks": 1, "unassignedTasks": 0, "recommendedAssignments": 1, "fleetUtilization": 40, "status": "OK" } }`
  - `incidents` is **additive** (Update #18) and best-effort: existing fields are unchanged.
  - `fleet` is **additive** (Update #19), camelCase and best-effort. See [fleet-optimization.md](fleet-optimization.md).
  - `historicalSummary` is **additive** (Update #20A), camelCase and best-effort: `{ "period", "historicalIncidentCount", "recurrentDrainCount", "degradedDrainCount", "historicalDataQuality", "topRecurringDrains", "recentHistoricalTrend" }`. See [historical-intelligence.md](historical-intelligence.md).
  - `coordination` is **additive** (Update #22), camelCase and best-effort: `{ "pendingTasks", "assignedTasks", "unassignedTasks", "availableRobots", "busyRobots", "chargingRobots", "coordinationConflicts", "reassignmentRequired", "status" }`. See [mission-coordination.md](mission-coordination.md).
  - `sensorIntelligence`, `sensorHealthSummary` and `sensorAnomalySummary` are **additive** (Update #21), camelCase and best-effort: total/healthy/degraded/critical sensor counts, average health, anomaly/stale/missing-data/out-of-range counts and affected drains. See [sensor-intelligence.md](sensor-intelligence.md).
  - `weatherCorrelation` is **additive** (Update #23), camelCase and best-effort: `{ "status", "weatherDataQuality", "signalsReady", "signalsTotal", "strongest", "latestWeather", "message" }`. Honest `WEATHER_UNAVAILABLE` when no real weather has been recorded. See [weather-flood-correlation.md](weather-flood-correlation.md).

### `GET /api/dashboard/fleet`
- **Access**: Public / Authenticated
- **Response** (200 OK): `{ "status", "generated_at", "summary", "warnings", "disclaimer" }` — the advisory fleet summary. See [fleet-optimization.md](fleet-optimization.md).

### `GET /api/dashboard/risk`
- **Access**: Public / Authenticated
- **Response** (200 OK): Flood risk summary + top-risk drain with full breakdown. See [flood-risk.md](flood-risk.md).

### `GET /api/dashboard/forecast`
- **Access**: Public / Authenticated
- **Response** (200 OK): Forecast summary + top predicted-risk drain with 15/30/60-minute horizons. See [forecasting.md](forecasting.md).

### `GET /api/dashboard/maintenance`
- **Access**: Public / Authenticated
- **Response** (200 OK): Maintenance summary + highest-maintenance-priority drain with recommendation, blockage risk, and drain overview list. See [maintenance-prediction.md](maintenance-prediction.md).

### `GET /api/dashboard/decisions`
- **Access**: Public / Authenticated
- **Query**: optional `refresh=true` bypasses the 10-second summary cache.
- **Response** (200 OK): AI Decision & Priority summary for the dashboard panel: total drains evaluated, `averagePriorityScore`, per-level `counts` + `distribution`, `insufficientData`, `actionDistribution`, `signalCoverage` and the top-5 `topPriority` drains (drainId, zone, location, priorityScore, priorityLevel, recommendedAction). See [decision-engine.md](decision-engine.md).

### `GET /api/dashboard/robot-routes`
- **Access**: Public / Authenticated
- **Response** (200 OK): Robot path planning summary for the dashboard panel: `totalDrains`, `warningCritical` count, and a `routes` array covering every drain. Normal drains carry `planningStatus: "SKIPPED"`; Warning/Critical drains carry `planningStatus` (`ROBOT_SELECTED` / `NO_ROBOT_AVAILABLE` / `NO_COORDINATES`), the selected `robot`, the planned `route`, `selectionScore` and `selectionReasons`. Includes `disclaimer` and `generatedAt`. See [robot-path-planning.md](robot-path-planning.md).

---

## Analytics API (`/api/analytics`)

### `GET /api/analytics`
- **Access**: Public / Authenticated
- **Response** (200 OK): Derived from live database state:
  ```json
  {
    "total_cleanings": 3,
    "total_missions": 3,
    "blockages_detected": 3,
    "critical_alerts_total": 3,
    "robot_operations": 3,
    "flood_predictions": 7,
    "total_drains": 7,
    "avg_mission_duration_minutes": 10.0
  }
  ```
  - `total_cleanings` / `robot_operations` / `total_missions`: mission records.
  - `blockages_detected`: open Critical alerts.
  - `flood_predictions`: sensor readings count.
  - Also includes `risk_average_score` / `risk_*` fields (see [flood-risk.md](flood-risk.md)), `forecast_average_risk` / `forecast_*` fields (see [forecasting.md](forecasting.md)), `maintenance_average_score` / `maintenance_*` fields (see [maintenance-prediction.md](maintenance-prediction.md)), `vision_average_visual_risk` / `vision_*` fields (see [vision-inspection.md](vision-inspection.md)), and additive incident fields `incident_total`, `incident_active`, `incident_responding`, `incident_resolved`, `incident_by_severity`, `incident_average_response_minutes`, `incident_average_resolution_minutes` (see [incidents.md](incidents.md)), additive fleet fields `fleet_status`, `fleet_total_robots`, `fleet_available_robots`, `fleet_busy_robots`, `fleet_charging_robots`, `fleet_low_battery_robots`, `fleet_utilization`, `fleet_active_tasks`, `fleet_assigned_tasks`, `fleet_unassigned_tasks`, `fleet_assignment_coverage`, `fleet_average_response_minutes` (see [fleet-optimization.md](fleet-optimization.md)), and additive historical fields `historical_period`, `historical_incident_count`, `historical_resolved_incident_count`, `historical_mission_count`, `historical_alert_count`, `historical_sensor_reading_count`, `historical_recurrent_drain_count`, `historical_degraded_drain_count`, `historical_data_quality`, `historical_recent_trend`, `historical_top_recurring_drains` (see [historical-intelligence.md](historical-intelligence.md)), and additive coordination fields `coordination_status`, `coordination_pending_tasks`, `coordination_assigned_tasks`, `coordination_unassigned_tasks`, `coordination_available_robots`, `coordination_busy_robots`, `coordination_charging_robots`, `coordination_conflict_count`, `coordination_reassignment_required`, `coordination_average_task_priority`, `coordination_average_candidate_score` (see [mission-coordination.md](mission-coordination.md)), and additive weather fields `weather_correlation`, `weather_flood_risk`, `rainfall_water_level`, `weather_strongest`, `weather_data_quality`, `weather_observation_count`, `weather_signals_ready`, `weather_signals_total` (see [weather-flood-correlation.md](weather-flood-correlation.md)).

### `GET /api/analytics/monthly`
- **Access**: Public / Authenticated
- **Response** (200 OK): Monthly sensor aggregates for the last 6 months (drives the "Monthly Flood Risk" chart):
  ```json
  [
    { "month": "Sep", "avg_water": 54.3, "max_water": 95, "avg_gas": 38.2, "readings": 7 }
  ]
  ```

### `GET /api/analytics/risk`
- **Access**: Public / Authenticated
- **Response** (200 OK): Aggregate flood risk summary. See [flood-risk.md](flood-risk.md).

### `GET /api/analytics/forecast`
- **Access**: Public / Authenticated
- **Response** (200 OK): Aggregate forecast summary. See [forecasting.md](forecasting.md).

### `GET /api/analytics/maintenance`
- **Access**: Public / Authenticated
- **Response** (200 OK): Maintenance analytics: distribution, average scores, drains requiring inspection/cleaning, and 24-hour trend history from the audit table. See [maintenance-prediction.md](maintenance-prediction.md).

### `GET /api/analytics/vision`
- **Access**: Public / Authenticated
- **Response** (200 OK): Vision inspection analytics driven by the `drain_vision_inspections` audit table: total inspections, `READY` vs `INSUFFICIENT_IMAGE_QUALITY` status split, level distribution, average visual risk / possible blockage scores, drains needing manual inspection (HIGH/CRITICAL, deduplicated), and 24-hour trend history. See [vision-inspection.md](vision-inspection.md).

### `GET /api/analytics/decisions`
- **Access**: Public / Authenticated
- **Query**: optional `refresh=true` bypasses the 10-second summary cache.
- **Response** (200 OK): AI Decision & Priority analytics in snake_case: `total_drains`, `eligible_drains`, `insufficient_data`, `average_priority_score`, `decision_low/moderate/high/critical`, `decision_distribution`, `action_distribution`, `signal_coverage`, `top_priority_drains`, `disclaimer`, `generated_at`. See [decision-engine.md](decision-engine.md).

### `GET /api/analytics/robot-routes`
- **Access**: Public / Authenticated
- **Response** (200 OK): Robot path planning analytics in snake_case: `total_drains`, `warning_critical_drains`, `planned_routes`, `routes_by_type` (+ `routes_by_type_list`), `robots_selected`, `average_travel_seconds`, `average_distance`, `average_battery_cost`, `direct_routes`, `charging_stop_routes`, `disclaimer`, `generated_at`. See [robot-path-planning.md](robot-path-planning.md).

### `GET /api/analytics/incidents`
- **Access**: Public / Authenticated
- **Response** (200 OK): Incident analytics: `total`, `by_severity`, `by_status`, `by_source`, `average_response_seconds` / `average_response_minutes`, `average_resolution_seconds` / `average_resolution_minutes`, and a `data_points` count. Averages are computed only from **real** stored timestamps and are `null` when there is not enough data. See [incidents.md](incidents.md).

### `GET /api/analytics/fleet-optimization`
- **Access**: Public / Authenticated
- **Response** (200 OK): Fleet optimization analytics in snake_case: `status`, `generated_at`, `robot_utilization`, `available_robots`, `busy_robots`, `charging_robots`, `low_battery_robots`, `offline_robots`, `unavailable_robots`, `total_robots`, `task_assignment_coverage`, `active_tasks`, `assigned_tasks`, `unassigned_task_count`, `average_estimated_response_seconds` / `average_estimated_response_minutes`, `battery_risk_count`, `charging_requirement_count`, `unassigned_reasons`, and `disclaimer`. Averages are `null` when there is not enough real data. See [fleet-optimization.md](fleet-optimization.md).

### `GET /api/analytics/historical`
- **Access**: Public / Authenticated
- **Query**: `?period=24h|7d|30d|90d` (alias `?window=`), optional `?drainId=`.
- **Response** (200 OK): Full historical overview (same shape as `GET /api/historical`). See [historical-intelligence.md](historical-intelligence.md).
- **Response** (400): `{ "error": "Invalid period", "allowed_periods": ["24h", "7d", "30d", "90d"] }`.

### `GET /api/analytics/coordination`
- **Access**: Public / Authenticated
- **Response** (200 OK): Mission coordination analytics in snake_case: `status`, `generated_at`, `task_assignment_count`, `task_completion_count`, `task_cancelled_count`, `unassigned_task_count`, `reassignment_count`, `average_assignment_time_seconds` (always `null` + `average_assignment_time_available: false` with an explicit `average_assignment_time_reason`), `average_mission_duration_seconds`, `robot_utilization`, coherent `coordination_conflicts`, `active_tasks`, `pending_tasks`, the flat `coordination_*` aliases, `coordination_average_task_priority`, `coordination_average_candidate_score`, `coordination_status` and `disclaimer`. See [mission-coordination.md](mission-coordination.md).

### `GET /api/analytics/weather-correlation`
- **Access**: Public / Authenticated
- **Query**: optional `?window=1..168` (default 24).
- **Response** (200 OK): Descriptive weather-flood correlation analytics in snake_case:
  `weather_correlation_status`, `weather_data_quality`, `weather_observation_count`,
  `weather_signals_ready`, `weather_signals_total`, `weather_window_hours`,
  `weather_strongest`, per-signal compact results (`rainfall_water_level`,
  `humidity_water_level`, `temperature_water_level`, `pressure_water_level`,
  `wind_water_level`, `weather_flood_risk`, `weather_forecast` — each `{ status`, `r`,
  `direction`, `strength`, `matched_pairs` }), `latest_weather`, `disclaimer` and
  `generated_at`. Honest `WEATHER_UNAVAILABLE` / `INSUFFICIENT_DATA` / `NOT_AVAILABLE`
  states only — never causal. See [weather-flood-correlation.md](weather-flood-correlation.md).

### Advisory Socket event
Fleet optimization emits `fleetOptimizationUpdate` (signature-guarded, only on meaningful change) through the existing shared hub:
```json
{ "status": "OK", "summary": { "active_tasks": 1, "unassigned_tasks": 0 }, "tasks": [], "recommendations": [], "robots": [], "unassigned": [], "generated_at": "..." }
```

Mission coordination emits `missionCoordinationUpdate` (signature-guarded, only on meaningful change) through the same hub:
```json
{ "status": "OK", "mode": "ADVISORY_PLAN", "summary": { "total_tasks": 4, "assigned_tasks": 3, "unassigned_tasks": 1, "coordination_conflicts": 0, "reassignment_required": 0 }, "assignments": [], "unassigned": [], "conflicts": [], "reassignment_required": [], "generated_at": "..." }
```

---

## Fleet Optimization API (`/api/fleet-optimization`)

A **read-only, advisory** fleet-level layer. It never assigns or dispatches robots
(`missionEngine.js` remains the authority) and never changes state. All routes are Public.
See [fleet-optimization.md](fleet-optimization.md).

### `GET /api/fleet-optimization`
- **Access**: Public / Authenticated
- **Response** (200 OK): Full advisory view: `status`, `generated_at`, `summary`,
  `robots`, `tasks`, `recommendations`, `unassigned`, `robots_without_assignment`,
  `robots_requiring_charging`, `warnings` and `disclaimer`. `status` is one of
  `OK | NO_TASKS | NO_ROBOTS | NO_ELIGIBLE_ROBOT | NO_COORDINATES | NO_FEASIBLE_ROUTE | INSUFFICIENT_DATA`.

### `GET /api/fleet-optimization/summary`
- **Access**: Public / Authenticated
- **Response** (200 OK): `status`, `generated_at`, `summary`, `warnings`, `disclaimer`.

### `GET /api/fleet-optimization/tasks`
- **Access**: Public / Authenticated
- **Response** (200 OK): `status`, `generated_at`, and the prioritized `tasks` array
  (priority score/status/breakdown, `recommendation_status`, `recommended_robot_id`,
  `route_mode`, `candidate_score`).

### `GET /api/fleet-optimization/robots`
- **Access**: Public / Authenticated
- **Response** (200 OK): `status`, `generated_at`, and the `robots` array with
  `availability_state` (`AVAILABLE | BUSY | CHARGING | LOW_BATTERY | OFFLINE | UNAVAILABLE`),
  battery, location, current mission/target and `estimated_available_time`/`reason`.

### `GET /api/fleet-optimization/recommendations`
- **Access**: Public / Authenticated
- **Response** (200 OK): `status`, `generated_at`, `recommendations` (chosen robot, route
  mode, distance/time/battery estimates, reasons, warnings, explanation, alternatives),
  `unassigned` (reason + required action), `robots_without_assignment`,
  `robots_requiring_charging`, `warnings`, `disclaimer`.

### `GET /api/fleet-optimization/analytics`
- **Access**: Public / Authenticated
- **Response** (200 OK): Same shape as `/api/analytics/fleet-optimization`.

### `GET /api/fleet-optimization/:taskId`
- **Access**: Public / Authenticated
- **Path Params**: `taskId` = `incident:<id>` or `drain:<id>`.
- **Response** (200 OK): `status`, `generated_at`, `task`, `recommendation`, `unassigned`, `disclaimer`.
- **Response** (404): `{ "error": "Task not found" }`

---

## Mission Coordination API (`/api/missions/coordination`)

Fleet-wide **autonomous mission scheduling & multi-robot coordination** (Update #22). Read
endpoints are public and never change state; the only state-changing endpoint is `POST /plan`
(auth-protected). `missionEngine.js` remains the sole dispatch authority — advisory mode never
mutates missions and autonomous mode dispatches only through `missionEngine.dispatchMission`.
See [mission-coordination.md](mission-coordination.md).

### `GET /api/missions/coordination`
- **Access**: Public / Authenticated
- **Response** (200 OK): Full advisory plan: `status`, `mode`, `generated_at`, `summary`,
  `tasks`, `assignments`, `unassigned`, `conflicts`, `reassignment_required`,
  `robot_availability`, `warnings` and `disclaimer`. `status` is one of
  `OK | NO_TASKS | NO_ROBOTS | NO_ELIGIBLE_ROBOT | NO_FEASIBLE_ROUTE | NO_COORDINATES | INSUFFICIENT_DATA`.

### `GET /api/missions/coordination/tasks`
- **Access**: Public / Authenticated
- **Response** (200 OK): `{ "status": "OK", "generated_at", "tasks" }` — the live task queue.

### `GET /api/missions/coordination/robots`
- **Access**: Public / Authenticated
- **Response** (200 OK): Robot eligibility view with `availability_state`
  (`AVAILABLE | BUSY | CHARGING | LOW_BATTERY | OFFLINE | UNAVAILABLE`), battery, current
  mission/target.

### `GET /api/missions/coordination/conflicts`
- **Access**: Public / Authenticated
- **Response** (200 OK): Explicit conflict list (`type`, `severity`, `message`,
  `required_action`, robot/drain ids). Conflicts are reported, never silently resolved.

### `GET /api/missions/coordination/summary`
- **Access**: Public / Authenticated
- **Response** (200 OK): `status`, `mode`, `generated_at`, `summary`, `warnings`, `disclaimer`.

### `GET /api/missions/coordination/analytics`
- **Access**: Public / Authenticated
- **Response** (200 OK): Same shape as `/api/analytics/coordination`.

### `POST /api/missions/coordination/plan`
- **Access**: Authenticated (`Bearer <token>`)
- **Body / Query**: `{ "mode": "advisory" | "autonomous" }` (also accepts
  `ADVISORY_PLAN` / `AUTONOMOUS_PLAN`; defaults to advisory).
- **Response** (200 OK): The plan; in autonomous mode also `execution: { executed, failed }`.
- **Response** (400): `{ "error": "Invalid mode", "allowed_modes": ["advisory", "autonomous"] }`.
- **Response** (401): missing/invalid token.

---

## Historical Intelligence API (`/api/historical`)

An **evidence/analytics**, strictly **read-only** layer (Update #20A). It describes
what the stored records actually show over a bounded window and never fabricates data
(a metric with no samples is `null`; a period with no records is `INSUFFICIENT_DATA`).
No new tables, no writes, no dispatches. All routes are Public.

Common query parameters (all routes except where noted):

| Param | Values | Notes |
| --- | --- | --- |
| `period` | `24h`, `7d`, `30d` (default), `90d` | alias `window` |
| `drainId` | positive integer | optional per-drain filter |

- **Response** (400): `{ "error": "Invalid period", "allowed_periods": ["24h", "7d", "30d", "90d"] }` or `{ "error": "Invalid drainId" }`.

See [historical-intelligence.md](historical-intelligence.md) for the full contract,
metric definitions, data-quality labels and limitations.

### `GET /api/historical`
- **Response** (200 OK): Full historical overview: `period`, `start_time`, `end_time`, `sensors`, `drains`, `incidents`, `missions`, `robots`, `alerts`, `patterns`, `comparison`, `drain_health`, `data_quality`, `generated_at`, `disclaimer`.

### `GET /api/historical/overview`
- Alias of `GET /api/historical`.

### `GET /api/historical/summary`
- **Response** (200 OK): Compact summary: `period`, `historical_incident_count`, `historical_resolved_count`, `historical_mission_count`, `historical_alert_count`, `historical_sensor_reading_count`, `recurrent_drain_count`, `degraded_drain_count`, `historical_data_quality`, `historical_sufficient_data`, `drain_health_by_status`, `top_recurring_drains`, `recent_historical_trend`, `disclaimer`, `generated_at`.

### `GET /api/historical/sensors`
- Per-sensor reading counts, earliest/latest timestamps and `average` / `minimum` / `maximum` / `first` / `last` / `change` / `trend` for water level, gas level and temperature.

### `GET /api/historical/trends`
- Per-sensor trend labels only (`RISING` / `FALLING` / `STABLE` / `INSUFFICIENT_DATA`).

### `GET /api/historical/drains`
- Per-drain history (`incident_count`, `alert_count`, `mission_count`, maintenance/vision event counts, last-activity timestamps) + descriptive `historical_health` label with reasons and an `evidence` object. Live `current_status` / `current_blockage_level` are kept separate.

### `GET /api/historical/incidents`
- Incident counts, severity/status/source breakdowns, top drains, daily buckets and real timing averages; each timing average is `null` when no row carries the required timestamp.

### `GET /api/historical/missions`
- Mission counts, status breakdown, per-drain and per-robot history, completion rate and average duration. Response time is `null` (no response timestamp in the schema).

### `GET /api/historical/robots`
- Per-robot response history (`mission_count`, `completed`, `assigned`, `completion_rate`, last activity).

### `GET /api/historical/alerts`
- Alert counts, severity/type breakdowns, top drains and daily buckets.

### `GET /api/historical/patterns`
- Descriptive hourly/weekday distributions for incidents and alerts with peak hour/day (only when the sample is `>= 3`).

### `GET /api/historical/comparison`
- Live `sensors` value (**CURRENT**) vs window average (**HISTORICAL**) with a separate **CHANGE**, and incident count vs the immediately preceding window of equal length.
