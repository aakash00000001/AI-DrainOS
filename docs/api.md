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
- **Response** (200 OK): `{ "totalDrains": 7, "activeRobots": 1, "criticalAlerts": 2, "incidents": { "counts": { "active": 1, "critical": 1, "responding": 0, "resolved": 2, "open": 1, "acknowledged": 0, "total": 3 }, "latest": [ ...incidents ] } }`
  - `incidents` is **additive** (Update #18) and best-effort: existing fields are unchanged.

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
  - Also includes `risk_average_score` / `risk_*` fields (see [flood-risk.md](flood-risk.md)), `forecast_average_risk` / `forecast_*` fields (see [forecasting.md](forecasting.md)), `maintenance_average_score` / `maintenance_*` fields (see [maintenance-prediction.md](maintenance-prediction.md)), `vision_average_visual_risk` / `vision_*` fields (see [vision-inspection.md](vision-inspection.md)), and additive incident fields `incident_total`, `incident_active`, `incident_responding`, `incident_resolved`, `incident_by_severity`, `incident_average_response_minutes`, `incident_average_resolution_minutes` (see [incidents.md](incidents.md)).

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
