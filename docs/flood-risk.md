# Flood Risk Intelligence & Early Warning System

> **IMPORTANT — MODEL LIMITATION**
>
> This flood risk score is an **engineering/demo risk model** and is **not a
> scientifically validated municipal flood forecasting model**. The weights,
> thresholds and trend ramp are engineering choices made for the demo so that a
> handful of clear scenarios produce sensible outputs. **Do not use this score
> to make real public-safety decisions.**

The flood risk layer adds an explainable, deterministic risk score (0–100) and
risk level on top of the existing MQTT → sensor → AI prediction → alert →
robot-mission pipeline. It does **not** replace any existing feature; it extends
it.

---

## 1. Data flow

```
IoT Sensor
    ↓
MQTT  (ai-drainos/drains/{drainId}/sensors/{sensorId})
    ↓
Backend (server/services/mqttService.js)
    ↓
Sensor data stored  →  historical reading stored (sensor_readings)
    ↓
Flood Risk Engine (server/services/floodRiskService.js)
    ↓
Risk Score 0–100  +  Risk Level
    ↓
Existing AI prediction (/predict)  ── combined
    ↓
Early Warning Alert (existing alerts table)
    ↓
Existing Robot Mission System (unchanged, driven by drain.status = Critical)
```

---

## 2. Formula + weights

```
riskScore = round( clamp(                      0–100 ) )

  water       * 0.50
+ gas         * 0.15
+ temperature * 0.10
+ trend       * 0.25
```

Weights are engineering/demo values (documented in
`server/services/floodRiskService.js`, `WEIGHTS`):

| Factor        | Weight |
|---------------|--------|
| Water level   | 50%    |
| Gas level     | 15%    |
| Temperature   | 10%    |
| Water trend   | 25%    |

### Normalization (each factor is normalized to 0–100 first)

- **Water level** — `clamp(water_level, 0, 100)` (validateReading already
  guarantees 0–100).
- **Gas level** — `clamp(gas_level, 0, 100)`.
- **Temperature** — a linear risk ramp from **20°C (0 risk)** to **45°C (100
  risk)**. Values ≤ 20°C → 0, ≥ 45°C → 100. This means normal ambient
  temperatures stay low and can never dominate the score.
- **Water trend** — linear slope of the last **10** water readings
  (excluding the current reading):
  ```
  slope = (current - oldest) / (readings - 1)
  trendScore = clamp(10 + slope * 10, 0, 100)
  ```
  - No history / single reading → trend score `0` ("Insufficient data").
  - Stable water → `10` (low weight contribution).
  - Rising water → higher; a rise of ~4+ points/reading saturates at 100.
  - Falling water → heads to `0` (reduces risk).

### Example (CRITICAL scenario)

```
water 92, gas 80, temp 38, history [60, 76, 84]

water        = 92       → 46
gas          = 80       → 12
temperature  = 72/100   → 7.2
trend slope  = (92-60)/3 = 10.67 → trendScore 100 → 25
riskScore    = 46 + 12 + 7.2 + 25 = 90.2 → 90  → CRITICAL
```

---

## 3. Risk levels

Thresholds live in the **settings** table (`risk_moderate_min`, `risk_high_min`,
`risk_critical_min`) with defaults in `DEFAULT_RISK_THRESHOLDS`:

| Range    | Level    | Typical scenario                                   |
|----------|----------|-----------------------------------------------------|
| 0–24     | LOW      | water ~20, stable/decreasing trend                  |
| 25–49    | MODERATE | water ~50, mild upward trend                        |
| 50–74    | HIGH     | water 65–75 + elevated gas + rising trend           |
| 75–100   | CRITICAL | water 90+ + rapidly rising water trend              |

Thresholds are editable by an admin through `PUT /api/settings`
(`risk_moderate_min`, `risk_high_min`, `risk_critical_min`) — changes apply on
the next reading.

---

## 4. Explainable breakdown

`calculateFloodRisk` returns the score, the level, and two explainability views:

```jsonc
{
  "riskScore": 90,
  "riskLevel": "CRITICAL",
  "breakdown": { "water": 46, "gas": 12, "temperature": 7, "trend": 25 },
  "factors": [
    { "name": "Water Level", "value": 92, "contribution": 46 },
    { "name": "Gas Level", "value": 80, "contribution": 12 },
    { "name": "Temperature", "value": 72, "contribution": 7 },
    { "name": "Water Trend", "value": 10.67, "label": "Rapidly Rising", "contribution": 25 }
  ],
  "trend": { "slope": 10.67, "label": "Rapidly Rising" }
}
```

No inventing of fake confidence values — the breakdown is derived directly from
the recorded sensor readings.

---

## 5. Historical readings (`sensor_readings`)

A minimal history table was introduced only because no suitable one existed:

| column       | type           |
|--------------|----------------|
| id           | SERIAL PK      |
| sensor_id    | int, FK sensors (ON DELETE CASCADE) |
| drain_id     | int, FK drains (ON DELETE CASCADE)  |
| water_level  | int            |
| gas_level    | int            |
| temperature  | numeric(5,2)   |
| recorded_at  | timestamp, default now |

Indexes: `sensor_id`, `drain_id`, `recorded_at`.

- A row is inserted for every valid MQTT reading and every REST simulator
  reading.
- Retention is simple: only the newest **1,000** readings per drain are kept
  (`READINGS_RETENTION`).
- The live `sensors` table is untouched and remains the source of truth for
  current values.
- Migration (`database/migrations/002_sensor_readings.sql`) is applied
  automatically by `scripts/dbInit.js` on existing databases (safe, idempotent,
  no data loss). Fresh installs get the table straight from `schema.sql`.

---

## 6. AI prediction integration

The existing AI service is reused unchanged (`POST http://127.0.0.1:5001/predict`);
it is never rewritten. The MQTT service's throttled + fallback pipeline
(`getPrediction`) is reused by the REST API so **no duplicate AI calls** are
made for the same drain.

Combined result returned by the risk API / socket event:

```jsonc
{ "prediction": "HIGH", "predictionSource": "ai", "riskScore": 87, "riskLevel": "CRITICAL" }
```

If the AI service is unavailable the backend does not crash; the existing
threshold fallback runs and the source is reported:

```jsonc
{ "prediction": "HIGH", "predictionSource": "fallback", "riskScore": 63, "riskLevel": "HIGH" }
```

(Existing source values are `ai` / `cached` / `throttled` / `fallback` — the
system does not claim AI confidence it does not have.)

---

## 7. API

### `GET /api/predictions/risk/:drainId`

Per-drain explainable risk + AI prediction. Public (matching the existing
`GET /api/predictions` model).

```jsonc
{
  "drainId": 5,
  "sensorId": 7,
  "riskScore": 87,
  "riskLevel": "CRITICAL",
  "prediction": "HIGH",
  "predictionSource": "ai",
  "breakdown": { "water": 46, "gas": 12, "temperature": 7, "trend": 22 },
  "factors": [ /* see section 4 */ ],
  "waterLevel": 92,
  "gasLevel": 81,
  "temperature": 34,
  "timestamp": "2026-09-16T10:30:00.000Z"
}
```

Errors: `400` invalid id, `404` drain or sensor not found.

### `GET /api/dashboard/risk`  — dashboard panel

```jsonc
{
  "summary": {
    "totalDrains": 7,
    "averageRiskScore": 52,
    "counts": { "low": 2, "moderate": 1, "high": 2, "critical": 2 },
    "distribution": [ { "level": "LOW", "count": 2 }, ... ]
  },
  "topRisk": { /* same shape as the per-drain endpoint + zone/location */ }
}
```

### `GET /api/analytics/risk`  — risk summary

Same `summary` object as above. `GET /api/analytics` also now includes
`risk_average_score`, `risk_low`, `risk_moderate`, `risk_high`, `risk_critical`,
`risk_distribution`.

> All analytics are computed from **real stored data** (current sensors +
> `sensor_readings`). No fake historical analytics are reported. The summary is
> cached for 5 seconds to avoid running per-drain trend queries on every REST
> poll (see `getRiskSummary`).

---

## 8. Socket.IO event — `floodRiskUpdate`

New event, additive. The existing events remain untouched:
`dashboardUpdate`, `criticalAlert`, `drainCleaned`, `batteryLow`,
`sensorUpdate`.

```jsonc
{
  "drainId": 5,
  "sensorId": 7,
  "riskScore": 87,
  "riskLevel": "CRITICAL",
  "prediction": "HIGH",
  "predictionSource": "ai",
  "waterLevel": 92,
  "gasLevel": 81,
  "temperature": 34,
  "breakdown": { "water": 46, "gas": 12, "temperature": 7, "trend": 22 },
  "timestamp": "2026-09-16T10:30:00.000Z"
}
```

Emitted only when something meaningful changed: the risk **level** changed, or
the score moved by at least **2 points**. Identical/repeated packets do not
flood the browser.

`sensorUpdate` now also carries `riskScore`, `riskLevel` and `riskTrend`
(additive), so the existing SensorMonitor live tiles can render them.

---

## 9. Alert behavior (early warning)

- **LOW / MODERATE** — no risk-driven alert (existing business rules still
  apply unchanged).
- **HIGH** — ensures an open **Medium** `Flood Risk` alert.
- **CRITICAL** — ensures an open **Critical** `Flood Risk` alert; an open
  Medium alert is **upgraded in place** to Critical.
- **Deduplication** — only one **Open** `Flood Risk` alert per drain; repeated
  CRITICAL packets never create duplicates.
- **Recovery** — a drain returning to Normal resolves open Flood Risk alerts
  (existing recovery path, shared by MQTT service, simulator and mission
  engine).

The robot mission engine is **not changed**: auto-dispatch still triggers on
`drain.status = 'Critical'` (unchanged thresholds), preserving nearest-robot
selection, battery rules, movement, completion and the charging lifecycle. The
risk level influences alerts and the dashboard, not the mission priority
schema.

---

## 10. Frontend

- **FloodRiskPanel** (dashboard) — "Flood Risk Intelligence" card: score /100,
  level badge, current water/gas/temperature, AI prediction, per-factor bar
  breakdown ("Why is this drain at HIGH risk?"), and the aggregate risk
  distribution. Live-updates via `floodRiskUpdate`.
- **SensorMonitor** — each live tile now also shows risk score/level + trend.
- **AnalyticsReport** — Flood Risk Summary (average + LOW/MODERATE/HIGH/CIITICAL
  drain counts).

No new chart libraries were added.

---

## 11. Performance

- Trend uses only the last **10** readings (`HISTORY_WINDOW`).
- History table capped at 1,000 rows/drain.
- Aggregate summary cached for 5s.
- AI calls reuse the existing per-drain throttle/cache.

---

## 12. Tests

`server/tests/floodRisk.test.js` covers: water/gas/temperature normalization,
trend calculation, risk composition for LOW/MODERATE/HIGH/CRITICAL scenarios,
invalid/null values, clamping, threshold boundaries, settings-driven
thresholds, history insert + retrieval, MQTT → risk integration, `floodRiskUpdate`
emission + dedupe, alert creation/upgrade/dedup/recovery, AI fallback, and the
three new REST endpoints.

Run:

```bash
cd server && npm test          # all suites
cd client && npm run build     # frontend build
```

---

## 13. Limitations

- Demo/engineering model — not a validated flood forecast (see top of file).
- Trend needs at least 2 readings per drain before it contributes.
- Alert severity can be upgraded by risk but is only lowered when the drain
  returns to Normal (existing recovery flow).
- No mission-priority schema change: CRITICAL *risk* does not itself create a
  mission; missions still follow the existing drain-status based dispatch.