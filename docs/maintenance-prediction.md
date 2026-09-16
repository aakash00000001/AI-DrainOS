# AI-Based Drain Maintenance & Blockage Prediction

> **IMPORTANT — MODEL LIMITATION**
>
> This is an **explainable baseline engineering layer** and **not a trained ML
> model and not physical blockage detection**. It intentionally reports **no
> confidence values** (nothing is fabricated). It is structured as a separate
> service (`server/services/maintenancePredictionService.js`) behind a stable
> API + events contract so that a real trained ML model or physical
> blockage/obstruction sensor (flow / pressure / camera / ultrasonic) can be
> swapped in later **without rewriting the backend routes, the frontend, or the
> tests**. **Do not use these predictions for real public-safety decisions.**

This feature extends AI-DrainOS with a **third independent analytical layer**:

| Layer | Service | Answers |
|---|---|---|
| Current Risk | `floodRiskService.js` | "What is the **current** flood risk?" |
| Forecast | `floodForecastService.js` | "What **may happen** in 15/30/60 min?" |
| Maintenance | `maintenancePredictionService.js` | "Does this drain **need inspection or cleaning** soon?" |

The three systems are kept **separate on purpose** because the questions are
fundamentally different.

---

## 1. What the maintenance engine looks at

A drain may need maintenance even when its flood risk is low — and a high flood
risk does not automatically mean cleaning is overdue. The maintenance layer
examines **long-term operational patterns**, not just the latest reading:

- **Water level trend** — persistent elevation or rising trajectory
- **Gas level** — elevated or rising gas often indicates biofilm or blockage
- **Temperature** — abnormally high drainage temperature (>38C) signals heat
- **Cleaning history** — drains that needed cleaning before often need it again
  (recurrence signal)
- **Time since last cleaning** — drain age and degradatio
- **Alert frequency** — many recent alerts indicate a drain under pressure
- **High-risk reading events** — water_level >= 75 in recent readings
- **Reading frequency** — how well-supported the observed patterns are

None of these signals prove a physical blockage exists — only that the **pattern
of readings is consistent with a drain that may need attention**.

---

## 2. Architecture

```
sensor_readings  ─┐
                  ├─► maintenancePredictionService.js  ─►  maintenance_predictions
sensors           ─┘         │
                             ▼
                    mqttService.js (section 7c, throttled)
                             │
                             ├──► maintenanceUpdate (Socket.IO)
                             ├──► Maintenance alert workflow (alerts table)
                             └──► Additive sensorUpdate fields
```

Key design decisions:

- **Throttled per drain**: recompute runs at most every ~30 s per drain
- **Deduplication**: `maintenanceUpdate` emits only when maintenance level
  changes or maintenance score moves by >= 3 points
- **Alert workflow**: `alert_type = 'Maintenance'` (distinct from Flood Risk /
  Flood Forecast). Severity: Medium for HIGH, Critical for CRITICAL.
  Deduplication: only one open maintenance alert per drain, severity may only
  be upgraded in place, resolved when level < HIGH
- **Cache**: 10 s per-drain cache; 10 s aggregate summary cache; reset by
  `resetMaintenanceRuntime()`

---

## 3. Scores and thresholds

### Maintenance score

Computed from a weighted sum of all signals. Weights sum to 1.0.

| Signal | Weight |
|---|---|
| water_level | 0.20 |
| water_level_trend (slope) | 0.18 |
| high_risk_events (>= 75) | 0.13 |
| time_since_last_cleaning | 0.12 |
| gas_level | 0.08 |
| cleaning_history (total missions) | 0.08 |
| alert_frequency (24h) | 0.05 |
| temperature | 0.04 |
| reading_frequency | 0.04 |
| persistent_elevated_ratio | 0.03 |
| gas_trend | 0.03 |
| temperature_trend | 0.02 |

Level thresholds (0-100):

| Level | Range |
|---|---|
| LOW | 0 - 24 |
| MODERATE | 25 - 49 |
| HIGH | 50 - 74 |
| CRITICAL | 75 - 100 |

### Blockage risk score

A secondary score capturing potential obstruction patterns. **Never described as
"confirmed blockage"** — only "potential blockage risk" / "possible obstruction
pattern".

| Signal | Weight |
|---|---|
| water_trend | 0.30 |
| water_level_persistence (avg) | 0.25 |
| abnormal_gas | 0.15 |
| high_risk_recurrence | 0.15 |
| cleaning_recurrence | 0.15 |

Same level thresholds (0-100) as maintenance score.

---

## 4. Recommendations and inspection priority

Recommendations depend on **both** maintenance level and blockage risk — not
maintenance level alone.

| Maintenance Level | Blockage Risk | Recommendation | Priority |
|---|---|---|---|
| CRITICAL | any | Immediate maintenance attention required | CRITICAL |
| HIGH | >= 50 | Priority inspection required | HIGH |
| HIGH | < 50 | Schedule cleaning | HIGH |
| MODERATE | rising/blockage >= 50 | Schedule inspection | MEDIUM |
| MODERATE | aging + no trend | Schedule cleaning | MEDIUM |
| MODERATE | low | Monitor drain | MEDIUM |
| LOW | low | No immediate maintenance required | LOW |
| LOW | >= 50 / very aged | Monitor drain | LOW |

Inspection priority is always one of: `LOW`, `MEDIUM`, `HIGH`, `CRITICAL`.

---

## 5. API endpoints

All endpoints are public (no auth required), matching the existing prediction
endpoints.

### Single drain maintenance prediction

```
GET /api/predictions/maintenance/:drainId
```

Returns the maintenance and blockage risk prediction for one drain.

**Response** (200 OK):
```json
{
  "drainId": 1,
  "sensorId": 1,
  "zone": "Zone 1",
  "location": "Goripalayam",
  "timestamp": "2026-09-16T10:00:00.000Z",
  "status": "READY",
  "method": "Explainable Baseline Maintenance Prediction",
  "maintenanceScore": 62,
  "maintenanceLevel": "HIGH",
  "blockageRiskScore": 48,
  "blockageRiskLevel": "MODERATE",
  "inspectionPriority": "HIGH",
  "maintenanceRecommendation": "Schedule cleaning",
  "reasons": [
    "Drain has experienced repeated high-risk readings",
    "Drain has required multiple cleaning missions",
    "Possible obstruction pattern detected in recent sensor data"
  ],
  "unavailableSignals": [],
  "signals": {
    "waterLevel": 60,
    "waterTrend": 1.2,
    "gasLevel": 45,
    "gasTrend": null,
    "temperature": 32,
    "temperatureTrend": null,
    "recentCriticalEvents": 4,
    "completedCleaningMissions": 2,
    "recentCleaningMissions": 1,
    "timeSinceLastCleaningMinutes": 420,
    "alertsLast24h": 2,
    "readingsAnalyzed": 25
  },
  "disclaimer": "Engineering/demo prediction - not a trained ML model and not physical blockage detection."
}
```

**Response** (404 Not Found): `{ "error": "Drain not found" }`

**Response** when insufficient history (still 200 OK):
```json
{
  "drainId": 1,
  "status": "INSUFFICIENT_DATA",
  "maintenanceScore": null,
  "maintenanceLevel": null,
  "blockageRiskScore": null,
  "blockageRiskLevel": null,
  "reason": "No historical sensor readings yet"
}
```

### Dashboard maintenance overview

```
GET /api/dashboard/maintenance
```

Aggregate maintenance summary for the dashboard panel. Includes drains ordered
by maintenance score (highest first).

### Analytics maintenance

```
GET /api/analytics/maintenance
```

Detailed maintenance analytics: distribution, average scores, drains requiring
inspection, and 24-hour trend history from the `maintenance_predictions` audit
table.

### Additive fields in GET /api/analytics

The main analytics endpoint now includes:

```json
{
  "maintenance_average_score": 42,
  "maintenance_average_blockage_risk": 31,
  "maintenance_low": 3,
  "maintenance_moderate": 2,
  "maintenance_high": 1,
  "maintenance_critical": 1,
  "maintenance_distribution": [...],
  "maintenance_ready_drains": 7,
  "maintenance_drains_inspection": 2
}
```

---

## 6. Socket.IO events

### maintenanceUpdate

Emitted when a maintenance prediction changes for a drain (level changed or
maintenance score moved by >= 3 points).

```json
{
  "drainId": 1,
  "sensorId": 1,
  "maintenanceScore": 62,
  "maintenanceLevel": "HIGH",
  "blockageRiskScore": 48,
  "blockageRiskLevel": "MODERATE",
  "inspectionPriority": "HIGH",
  "maintenanceRecommendation": "Schedule cleaning",
  "reasons": ["..."],
  "unavailableSignals": [],
  "timestamp": "2026-09-16T10:00:00.000Z"
}
```

### Additive fields in sensorUpdate

Each `sensorUpdate` now includes:

```json
{
  "...existing fields...",
  "maintenanceScore": 62,
  "maintenanceLevel": "HIGH",
  "blockageRiskScore": 48,
  "blockageRiskLevel": "MODERATE",
  "maintenanceRecommendation": "Schedule cleaning"
}
```

---

## 7. Alert workflow

Maintenance alerts use `alert_type = 'Maintenance'` in the existing `alerts`
table — the same table used by flood risk and forecast alerts.

- Created when maintenance level is HIGH or CRITICAL
- Severity: Medium for HIGH, Critical for CRITICAL
- Only one open maintenance alert per drain (deduplicated in place)
- Severity may only be **upgraded** (Medium -> Critical), never downgraded
- Resolved automatically when maintenance level drops below HIGH

---

## 8. Frontend

### MaintenancePanel

New component (`client/src/components/MaintenancePanel.jsx`) placed after
ForecastPanel on the main dashboard. Shows:

- Highest-maintenance-priority drain with score, level, blockage risk,
  recommendation
- Full drain list with compact maintenance + blockage indicators
- Summary statistics (average score, distribution, drains needing inspection)
- Live updates via `maintenanceUpdate` socket event
- Honest disclaimer: "not a trained ML model and not physical blockage
  detection"

### SensorMonitor

Each sensor card now shows a maintenance line and action recommendation when a
live `maintenanceUpdate` is received. Existing risk / forecast lines are
untouched.

### AnalyticsReport

New section added after the flood forecast summary, guarded by
`analytics.maintenance_average_score !== undefined` (backward compatible).

---

## 9. Database

### New table: maintenance_predictions

```sql
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
```

Indexes: `idx_maintenance_predictions_drain_id`,
`idx_maintenance_predictions_created_at`.

The table is created by:
1. `database/schema.sql` (full reset — used by tests)
2. `database/migrations/003_maintenance_predictions.sql` (idempotent — used by
   existing installs via `scripts/dbInit.js`)

---

## 10. Files

| File | Purpose |
|---|---|
| `server/services/maintenancePredictionService.js` | Core engine |
| `server/services/mqttService.js` | Section 7c: throttle + emit + alerts |
| `server/routes/predictions.js` | `GET /api/predictions/maintenance/:drainId` |
| `server/routes/dashboard.js` | `GET /api/dashboard/maintenance` |
| `server/routes/analytics.js` | `GET /api/analytics/maintenance` + additive fields |
| `database/schema.sql` | maintenance_predictions table |
| `database/migrations/003_maintenance_predictions.sql` | Idempotent migration |
| `server/tests/maintenancePrediction.test.js` | 24 required test cases |
| `client/src/components/MaintenancePanel.jsx` | Dashboard panel |
| `client/src/App.jsx` | Mounts MaintenancePanel |
| `client/src/components/SensorMonitor.jsx` | Live maintenance per sensor |
| `client/src/components/AnalyticsReport.jsx` | Maintenance analytics section |
| `docs/maintenance-prediction.md` | This file |