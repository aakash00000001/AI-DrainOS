# Predictive Flood Forecasting & 15/30/60-Minute Early Warning

> **IMPORTANT — MODEL LIMITATION**
>
> The forecasting layer is an **engineering/demo forecasting method** and is
> **not a scientifically validated flood forecasting model**. It intentionally
> reports **no confidence values** (nothing is fabricated). It is structured as
> a separate service (`server/services/floodForecastService.js`) behind a stable
> API + events contract so that a real trained ML model can be swapped in later
> **without rewriting the backend routes, the frontend, or the tests**. **Do not
> use these projections to make real public-safety decisions.**

This phase extends the existing Flood Risk Intelligence layer (CURRENT risk)
with **PREDICTED FUTURE risk** at three horizons — **15 / 30 / 60 minutes** —
and adds a new forecast-driven early warning alert type. It does **not** replace
any existing feature; it adds a new layer on top.

---

## 1. Why a baseline model?

The project already has a flood risk engine that turns *current* sensor values
into a current risk score. That engine cannot answer the question:

> "Is this LOW/MODERATE drain **about to flood** in the next hour?"

Forecasting answers it with the simplest defensible approach:

1. Fit a **time-aware trend** (per-minute rate of water-level change) over the
   most recent sensor readings.
2. **Project** each drain's water level at 15 / 30 / 60 minutes.
3. Feed each projected water level through the **existing** flood risk engine
   (same formula, same thresholds) to get a **predicted risk level**.

Because the existing engine is reused, the forecast never disagrees with the
current-risk model on the mechanics — it only moves the inputs forward in time.

---

## 2. Method: "Explainable Baseline Forecast"

```
readings (sensor_readings, last 30 rows, oldest→newest)
    ↓
cleanTimeSeries()  →  [{ water, timeMin }]  (dedupe + sort + drop invalid)
    ↓
fitSlope()  →  linear regression of water % vs time (minutes)
                over last 15 points (two-point fallback, flat fallback)
    ↓
trendDirectionFromSlope(slopePerMinute)
    RAPIDLY_RISING / RISING / STABLE / FALLING / RAPIDLY_FALLING
    ↓
for each horizon in [15, 30, 60]:
    predictedWater = clamp(waterNow + slopePerMinute * minutes, 0, 100)
    predictedRisk  = floodRisk.calculateFloodRisk({
        water_level: predictedWater,
        gas_level:   gasNow,
        temperature: tempNow,
        history:     recent 10 actual readings,   // includes current trend
    })
    ↓
worst = horizon with the highest predicted risk score
```

### 2.1 Properties

| Property | Value |
|----------|-------|
| Method name | `Explainable Baseline Forecast` |
| History window | last `30` readings per drain (`FORECAST_READINGS_LIMIT`) |
| Regression window | last `15` points (`TREND_REGRESSION_MAX_POINTS`) |
| Fit | simple linear regression (OLS), two-point fallback |
| Trend slope unit | `% water per minute` |
| Direction thresholds | rise `≥ +0.15`, rapid rise `≥ +0.50`, fall `≤ -0.15`, rapid fall `≤ -0.50` |
| Confidence values | **none** — never fabricated |
| Risk reuse | `floodRiskService.calculateFloodRisk` (identical formula/thresholds) |

### 2.2 Why "time-indexed" matters

The trend is a **slope over real elapsed minutes**, not a reading-to-reading
delta. Two readings 1 second apart rising from 20 → 80 imply the same steepness
as two readings 1 minute apart — only much, much faster per minute. Using real
timestamps instead of just "change per reading" keeps the model honest about
the demo-time scales of the simulator.

---

## 3. Data source (no schema change)

Forecasting reuses the existing **`sensor_readings`** history table from the
Flood Risk phase — **no new table or migration is required**:

```
id            serial
sensor_id     int
drain_id      int
water_level   numeric
gas_level     numeric
temperature   numeric
recorded_at   timestamptz
```

Every MQTT reading is already stored there by `mqttService.recordReading()`, so
once ≥ 2 distinct timestamped readings exist for a drain, a forecast is
available. Forecast status is **honest**:

| Status | Meaning |
|--------|---------|
| `ready` | 15/30/60 projections computed |
| `insufficient_history` | < 2 distinct timestamped readings — no fake projection |

---

## 4. Forecast early-warning alerts

A new alert type is added to the existing `alerts` table:
**`Flood Forecast`** (existing workflows — list, resolve, robot completion, live
loop — work unchanged because the drains `PUT` handler resolves *all* open
alerts for a drain).

| Predicted worst-horizon level | Alert severity |
|-------------------------------|----------------|
| HIGH                          | Medium         |
| CRITICAL                      | Critical       |
| lower than HIGH               | existing alert resolved |

Rules (mirror the flood-risk alerts so behaviour stays consistent):

- **Deduplicated** — only one Open `Flood Forecast` alert per drain.
- **Never downgraded** — an existing Medium alert is upgraded to Critical in
  place; it is only resolved when the prediction drops below HIGH.
- Every MQTT message re-evaluates; a storm surge that is about to hit a
  currently-LOW drain raises the alarm **before** the drain turns Critical.

---

## 5. Real-time events (Socket.IO)

| Event | Payload (relevant fields) | When |
|-------|---------------------------|------|
| `forecastUpdate` | `drainId`, `horizons[{forecastMinutes,predictedWaterLevel,predictedRiskScore,predictedRiskLevel,trendDirection}]`, `worst`, `trendDirection`, `waterTrendPerMinute`, `method`, `timestamp` | each meaningful change (worst level changed or worst score moved ≥ 2 points) |
| `sensorUpdate` | additive: `forecast60Score`, `forecast60Level`, `forecastTrendDirection` | every reading (existing event, new fields) |

---

## 6. REST API

| Endpoint | Auth | Returns |
|----------|------|---------|
| `GET /api/predictions/forecast/:drainId` | public | full per-drain forecast: current state + horizon projections + worst + model info |
| `GET /api/dashboard/forecast` | public | summary (avg predicted risk + LOW/MODERATE/HIGH/CRITICAL counts) + the highest predicted-risk drain's full forecast |
| `GET /api/analytics/forecast` | public | full aggregate forecast summary (ranked drains list) |
| `GET /api/analytics` | public | additive `forecast_average_risk`, `forecast_low/moderate/high/critical`, `forecast_distribution`, `forecast_ready` |

`GET /api/predictions/forecast/:drainId` example:

```json
{
  "drainId": 3,
  "sensorId": 3,
  "zone": "Zone C",
  "location": "Central Complex - Entry/Exit",
  "currentWaterLevel": 62,
  "currentRiskScore": 55,
  "currentRiskLevel": "HIGH",
  "status": "ready",
  "method": "Explainable Baseline Forecast",
  "trendDirection": "RISING",
  "waterTrendPerMinute": 0.75,
  "model": {
    "method": "Explainable Baseline Forecast",
    "fit": "linear_regression",
    "pointsUsed": 15,
    "readingsAvailable": 30,
    "waterTrendPerMinute": 0.75,
    "trendDirection": "RISING"
  },
  "horizons": [
    { "forecastMinutes": 15, "predictedWaterLevel": 73, "predictedRiskScore": 66, "predictedRiskLevel": "HIGH", "trendDirection": "RISING" },
    { "forecastMinutes": 30, "predictedWaterLevel": 85, "predictedRiskScore": 86, "predictedRiskLevel": "CRITICAL", "trendDirection": "RISING" },
    { "forecastMinutes": 60, "predictedWaterLevel": 100, "predictedRiskScore": 100, "predictedRiskLevel": "CRITICAL", "trendDirection": "RISING" }
  ],
  "worst": {
    "forecastMinutes": 60,
    "predictedWaterLevel": 100,
    "predictedRiskScore": 100,
    "predictedRiskLevel": "CRITICAL",
    "trendDirection": "RISING"
  },
  "timestamp": "2026-09-16T12:00:00.000Z",
  "disclaimer": "Engineering/demo forecast - not a scientifically validated flood forecasting model."
}
```

---

## 7. Aggregation (`GET /api/analytics/forecast`)

The summary is cached for **5 seconds** (`SUMMARY_CACHE_TTL_MS`) and ranks every
drain with sufficient history by its **worst** predicted-horizon risk score:

```
{
  totalDrains,
  averagePredictedRiskScore,
  counts:       { low, moderate, high, critical },
  distribution: [{ level, count }],
  drains:       [ { drainId, zone, location, worstRiskScore, worstRiskLevel,
                    worstMinutes, trendDirection } ]  (ranked desc),
  topForecast:  the #1 ranked entry
}
```

---

## 8. Frontend

| Component | Adds |
|-----------|------|
| `ForecastPanel.jsx` (new) | dashboard panel: worst predicted risk badge, 15/30/60 horizon cards, trend + %/min, aggregate count chips, model + disclaimer footer; live via `forecastUpdate` |
| `SensorMonitor.jsx` | per-sensor "60-min Forecast" line (score + level + trend) fed by `sensorUpdate` |
| `AnalyticsReport.jsx` | "Flood Forecast Summary (60 min)" metric grid (avg predicted + per-level predicted drains) |
| `App.jsx` | mounts `<ForecastPanel />` directly after `<FloodRiskPanel />` |

---

## 9. Future ML drop-in

The forecast is deliberately isolated in one service. To replace it with a
trained model, keep the same public surface and the same data shapes:

- `buildForecast(() => forecast)` → returns `{ status, method, trendDirection,
  waterTrendPerMinute, model, horizons, worst, disclaimer }`
- `getDrainForecast(drainId)` → per-drain payload
- `getForecastSummary()` → aggregate summary

The MQTT pipeline, routes, Socket.IO events, alerts, panels and tests need **no
changes** as long as the consumer contract (section 6) is preserved.