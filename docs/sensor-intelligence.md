# 📡 Advanced IoT Sensor Intelligence & Anomaly Detection (Update #21)

The sensor intelligence layer (`server/services/sensorIntelligenceService.js`) is a
**descriptive, additive** layer on top of the existing sensor pipeline. The MQTT service
and the simulator already persist `water_level` / `gas_level` / `temperature` into
`sensors` and `sensor_readings`; this layer reads a **bounded rolling window** of those
real rows and produces an **explainable sensor-health score** plus anomaly signals.

It obeys three hard rules:

1. **It never fabricates data.** No readings, anomaly values, confidence or history are
   invented. Everything is derived from real `sensor_readings` rows.
2. **It never replaces anything.** The existing flood risk, forecast, maintenance and
   decision formulas are untouched. This layer only exposes **additive context** that
   those engines may optionally consume.
3. **It never dispatches robots.** `missionEngine.js` and the movement loop are not
   touched. A severe sensor-integrity issue may open *at most one* incident per drain
   through the existing `incidentService` (deduped + cooldown-guarded).

📄 Related docs: [mqtt.md](mqtt.md) · [flood-risk.md](flood-risk.md) ·
[forecasting.md](forecasting.md) · [maintenance-prediction.md](maintenance-prediction.md) ·
[decision-engine.md](decision-engine.md) · [mission-coordination.md](mission-coordination.md) ·
[incidents.md](incidents.md) · [digital-twin.md](digital-twin.md) · [api.md](api.md) ·
[database.md](database.md)

---

## 1. Advisory contract

> Sensor intelligence describes observed sensor patterns only. It does **not** diagnose a
> root cause and never replaces the flood risk, forecast, maintenance or decision engines.

This disclaimer is returned in every response (`disclaimer` field) and shown in the UI
panels. Anomalies are worded descriptively ("consistent with…") and never claim a cause.

---

## 2. Data requirements + insufficient data

Each sensor needs a **bounded rolling window** of real readings before anything is scored:

- `MIN_READINGS = 10` — fewer readings ⇒ per-sensor status `INSUFFICIENT_DATA` with a
  `null` health score.
- `HISTORY_WINDOW = 20` — preferred window per channel.
- `MAX_READINGS = 30` — hard cap. History is never unlimited; queries are `ORDER BY
  recorded_at ASC LIMIT ?` (parameterized SQL).

Channels analysed: `water_level`, `gas_level`, `temperature`.

A drain with **no sensor attached** or with fewer than `MIN_READINGS` returns
`INSUFFICIENT_DATA` — it is reported honestly, never estimated.

---

## 3. Health score (0–100)

A per-sensor health score is computed from the real window and bounded to 0–100, then
mapped to a status:

| Band   | Status         |
| ------ | -------------- |
| 90–100 | `HEALTHY`      |
| 75–89  | `GOOD`         |
| 50–74  | `DEGRADED`     |
| 25–49  | `POOR`         |
| 0–24   | `CRITICAL`     |
| —      | `INSUFFICIENT_DATA` (not enough history) |

Anomalies apply a severity-weighted penalty (LOW 3 / MODERATE 8 / HIGH 15 / CRITICAL 25,
capped at a 60-point total penalty) so severe integrity issues visibly bring the score
down. Every score carries a list of human-readable `reasons` and the underlying `signals`
(`readingsAnalysed`, trend direction, biggest step, out-of-range flags, gap detection).

### Cross-sensor consistency (drain level)

When a drain has **2+ sensors**, their average scores are compared. A gap larger than
`CONSISTENCY_TOLERANCE` (30 points) reports `INCONSISTENT`; otherwise `CONSISTENT`. A
single-sensor drain reports `INSUFFICIENT_DATA` for consistency (nothing to compare).

---

## 4. Anomaly signals

All thresholds come from `server/services/sensorIntelligenceService.js` and are applied
to the real window as it flows chronologically:

| Signal           | Detection basis                                             |
| ---------------- | ----------------------------------------------------------- |
| `SPIKE`          | Single-sample jump above the per-channel step threshold     |
| `DROP`           | Single-sample fall above the per-channel step threshold     |
| `RAPID_CHANGE`   | Sustained cumulative rise/fall across the window            |
| `STUCK_SENSOR`   | Values held constant (variance ≤ 0.5) across ≥ 10 readings spanning ≥ 30 min |
| `STALE_SENSOR`   | Latest reading older than 15 min                            |
| `MISSING_DATA`   | A real gap ≥ 10 min between consecutive readings            |
| `OUT_OF_RANGE`   | Value outside the **physical range enforced by the MQTT validator**: water/gas 0–100 %, temperature −40…65 °C |
| `NOISE`          | Repeated sign-flipping jitter (≥ 5 steps, ≥ 70 % sign flips, non-trivial step size) |

Each anomaly is assigned a severity (LOW … CRITICAL), a human-readable message and the
sensor/channel it belongs to. `OUT_OF_RANGE` is only reported where a defensible physical
range genuinely exists — the service reuses the MQTT validator's ranges rather than
inventing new ones.

---

## 5. Live emission (signature-guarded)

The service emits through the **existing shared** `socketHub`:

```js
socketHub.emit("sensorIntelligenceUpdate", {
  status, generated_at, disclaimer,
  summary, drains, sensors, anomalies
});
```

- Wiring is in the live 5-second loop (`server/index.js`) **and** the MQTT pipeline
  (`server/services/mqttService.js` calls `evaluateAndEmitSensorIntelligence({ drainId })`
  after storing a reading).
- Emission is **signature-guarded**: a deterministic signature of the summary + per-sensor
  status + anomaly list means the event fires only on a meaningful change, never per
  5-second tick or per MQTT message that did not change anything.
- It is also **per-drain capable**: the MQTT path re-evaluates only the drain that produced
  the reading.
- No second Socket.IO server is created; `socketHub.emit` is a safe no-op when the hub is
  not initialized (used by tests).

---

## 6. Sensor-incident safeguards

Severe integrity issues (a `CRITICAL` sensor health, or a CRITICAL-severity anomaly) may
open **one** `SENSOR` incident per drain through the existing `incidentService`:

- **Source** is `SENSOR` and the accompanying message makes clear this is a
  sensor-integrity observation.
- **No robot is ever assigned** (`assigned_robot_id = null`); the incident layer's normal
  manual-dispatch rules still apply to operators.
- **Cooldown-guarded**: at most one attempt per drain per 10 minutes, so a noisy storm of
  MQTT messages cannot create an incident storm.
- **Best-effort**: an incident failure is logged and never breaks the emission path.

Migration `database/migrations/006_sensor_incidents.sql` widens the `incidents.source`
CHECK constraint to accept `SENSOR` (already applied in `database/schema.sql`).

---

## 7. REST API

Base path: `/api/predictions/sensor-intelligence` (mounted in `server/app.js` **before**
`/api/predictions` so it is not shadowed). All endpoints are **read-only** and public,
matching the other analytical read endpoints.

| Method | Path                                                       | Description                                     |
| ------ | ---------------------------------------------------------- | ----------------------------------------------- |
| GET    | `/api/predictions/sensor-intelligence`                     | Full view (summary, sensors, drains, anomalies) + `?drainId=` filter |
| GET    | `/api/predictions/sensor-intelligence/summary`             | Compact summary                                |
| GET    | `/api/predictions/sensor-intelligence/anomalies`           | Anomaly list, filterable by `?type=`/`?drainId=` |
| GET    | `/api/predictions/sensor-intelligence/anomalies/:sensorId` | Anomalies for one sensor (404 when unknown)    |
| GET    | `/api/predictions/sensor-intelligence/drain/:drainId`      | One drain's aggregation (404 when unknown)     |
| GET    | `/api/predictions/sensor-intelligence/:sensorId`           | One sensor's health + anomalies                |

Additive analytics surfaces:

- `GET /api/dashboard` gains `sensorIntelligence`, `sensorHealthSummary` and
  `sensorAnomalySummary` (camelCase, best-effort).
- `GET /api/analytics` gains `sensor_*` fields; `GET /api/analytics/sensor-intelligence`
  returns the dedicated view. `health_trend_status` is honestly `INSUFFICIENT_DATA`
  because historical health snapshots are not persisted.

---

## 8. Additive context for the existing engines

Section 9 integration is strictly additive: the layer never changes the flood-risk,
forecast, maintenance or decision formulas. It exposes a **TTL-cached** context
(`CONTEXT_CACHE_TTL_MS = 15 s` per drain, pruned on write) so the hot path does not
re-query the bounded window on every reading:

- **Decision engine** — response carries `sensorIntelligence` (health status, average
  score, anomaly counts, consistency).
- **Flood risk** (`buildDrainRiskDetail`) — per-drain detail carries `sensorIntelligence`;
  a failure or a data-less drain degrades to `null`.
- **Flood forecast** (`getDrainForecast`) — carries `sensorIntelligence` (reused from the
  risk detail, no extra queries).
- **Maintenance prediction** (`getDrainMaintenance`) — payload carries `sensorIntelligence`;
  the `INSUFFICIENT_DATA` object carries `null`.
- **Mission coordinator** — the per-drain signal bundle gains an additive `sensor_quality`
  block (health status, counts) carried from the decision context **with no extra queries**;
  it is descriptive and never alters priority, assignment, or robot dispatch.

Because the context is a *description* of existing readings, a drain without enough data
returns `null` and is simply **not cached**, so it is re-checked on the next tick when new
readings may have arrived.

---

## 9. MQTT + dashboard integration

- On every stored MQTT reading, `mqttService` runs `evaluateAndEmitSensorIntelligence({ drainId })`
  after the existing flood-risk/forecast pipeline — additive and signature-guarded, so a
  reading that changes nothing emits nothing.
- The Sensor Intelligence panel (`client/src/components/SensorIntelligencePanel.jsx`) and
  full page (`SensorIntelligencePage.jsx`) render the real summary, per-sensor health and
  anomaly tables, and re-fetch from the server so the UI always reflects live state.
- The app-level `sensorIntelligenceUpdate` listener shows a warning toast only when a
  sensor is in a critical state (silent otherwise) and is removed on cleanup.
- Sidebar + `App.jsx` route: **Sensor Intelligence** (`/sensorintelligence`).

---

## 10. Digital Twin overlay (additive)

`client/src/services/digitalTwinUtils.mjs` exposes `SENSOR_HEALTH_STATUSES` and
`normalizeSensorIntelligence` (line ~526); `DigitalTwin.jsx`'s sensor view has a health +
status ring drawn from the live `sensorIntelligenceUpdate` payload. If the sensor view has
no data it degrades to neutral markers — it never invents a health state.

---

## 11. Failure / degraded states

| Situation                          | Behaviour                                                       |
| ---------------------------------- | --------------------------------------------------------------- |
| Fewer than 10 readings             | `INSUFFICIENT_DATA`, `null` health score (never estimated)      |
| No sensor attached to the drain    | `INSUFFICIENT_DATA`                                             |
| Sensor view API down (Twin)        | Scene stays usable; sensor markers absent or neutral            |
| Panel/page API down                | Panel/page show an error state; no fabricated scores            |
| Incident creation fails            | Logged and skipped; emission path continues                     |
| New readings arrive for a drain    | Context cache expires and re-evaluates on the next tick         |

---

## 12. Tests

- `server/tests/sensorIntelligenceService.test.js` — 25 unit/integration tests (health
  banding, all 8 anomaly signals, determinism, bounded history, drain aggregation +
  consistency, signature-guarded emission, incident dedup + cooldown, additive
  dashboard/analytics shapes, TTL-cached context).
- `server/tests/sensorIntelligence.test.js` — 10 REST API tests for
  `/api/predictions/sensor-intelligence` + additive dashboard/analytics.
- Additive context is verified through the existing decision-engine / flood-risk /
  forecast / maintenance / mission-coordinator suites.
- Run the full backend suite (from `server/`): `npm test`
  (`node --test --test-concurrency=1 "tests/*.test.js"`).

---

## 13. Non-goals / limitations

- The layer does **not** dispatch or move robots — `missionEngine.js` and the movement
  loop are untouched.
- It does **not** change the flood risk / forecast / maintenance / decision formulas; its
  context is descriptive only.
- Anomalies are pattern observations ("consistent with…"), never root-cause claims.
- `health_trend_status` is `INSUFFICIENT_DATA` because health snapshots are not persisted;
  no trend is fabricated.
- Anomaly detection is based on the bounded rolling window of real readings — no sensor
  "learns" beyond that window, and no readings are ever synthesized.