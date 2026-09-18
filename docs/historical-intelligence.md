# Historical Intelligence & Continuous Learning Layer

> **Status:** UPDATE #20A — backend analytics foundation (read-only).
> The Historical Intelligence **UI** is intentionally **not** part of this
> update; this document covers the analytics engine, REST API, additive
> dashboard/analytics fields and the data-quality contract.

The Historical Intelligence layer (`server/services/historicalIntelligenceService.js`)
is an **evidence / analytics** layer. It describes what **actually happened**
in the stored PostgreSQL records over a bounded historical window. It is
**not** a prediction engine, it never replaces the existing flood risk,
forecast, maintenance, vision, decision, path-planning, incident or fleet
services, and it never fabricates data.

---

## 1. Purpose

AI-DrainOS already produces *current* and *predictive* signals. Historical
Intelligence answers a different question: **what does the recorded history
actually show?** It provides explainable, deterministic historical metrics
(reading counts, averages, min/max, trends, incident/mission/alert
aggregates, time-of-day patterns, current-vs-historical comparison and a
descriptive historical drain-health label) so operators can reason from
evidence.

**No-fabrication policy**

- Every value is computed from rows that exist in the database.
- A metric with no samples is `null` (never `0` as a stand-in for "unknown").
- A time-based average is `null` (never `0`) when its denominator is `0`.
- A period with no records is reported as `INSUFFICIENT_DATA`.
- Missing metrics / unavailable tables are listed explicitly in the
  data-quality metadata — nothing is hidden.

---

## 2. Data sources

Reused as-is (no new tables, no duplicate history tables):

| Source | Used for |
| --- | --- |
| `sensor_readings` | Historical sensor analytics (water level, gas level, temperature) |
| `sensors` | **CURRENT** live sensor values for current-vs-historical comparison |
| `drains` | Drain metadata + **CURRENT** status/blockage |
| `incidents` | Incident counts, severity/source/drain breakdowns, response/resolution timings, time patterns |
| `missions` | Mission counts, per-robot/per-drain history, completion rate, duration |
| `alerts` | Alert counts, severity/type/drain breakdowns, open vs resolved |
| `maintenance_predictions` | Maintenance event counts per drain (best-effort) |
| `drain_vision_inspections` | Vision inspection counts per drain (best-effort) |

> No new database tables are required. Historical intelligence derives
> entirely from existing records. (`maintenance_predictions` and
> `drain_vision_inspections` are read best-effort; if a table is missing the
> affected signal is reported in `data_quality.missing_signals`.)

---

## 3. Historical windows

| Period | Meaning |
| --- | --- |
| `24h` | Last 24 hours |
| `7d` | Last 7 days |
| `30d` | Last 30 days (**default**) |
| `90d` | Last 90 days |

`?period=` (alias `?window=`) selects the window; an optional
`?drainId=<positive int>` filters the response to one drain. The service
converts the validated period into safe PostgreSQL time boundaries
(`start_time` ≤ `recorded_at`/`created_at`/`assigned_time` ≤ `end_time`).
Invalid periods or drain ids are rejected with HTTP **400** — arbitrary SQL
fragments or column names are never accepted.

---

## 4. Metrics

### 4.1 Sensor history (`getSensorHistory`)

Per sensor (grouped by `sensor_id`/`drain_id`):

- `reading_count`, `earliest_timestamp`, `latest_timestamp`
- For each of `water_level`, `gas_level`, `temperature`: `average`, `minimum`,
  `maximum`, `first`, `last`, `change`, `trend`, `sample_count`.
- `trend` is derived from the **real first and last reading** in the window
  (ordered by `recorded_at`):

  | Condition (needs ≥ 3 readings) | Trend |
  | --- | --- |
  | `last - first >= threshold` | `RISING` |
  | `last - first <= -threshold` | `FALLING` |
  | otherwise | `STABLE` |
  | `< 3` readings | `INSUFFICIENT_DATA` |

  Thresholds (`TREND_THRESHOLDS`): water `5`, gas `5`, temperature `1.0 °C`.

### 4.2 Drain history + historical health (`getDrainHistory`)

Per drain: sensor summary, `incident_count`, `critical_incident_count`,
`high_incident_count`, `alert_count`, `mission_count`,
`maintenance_event_count`, `vision_inspection_count`, and the last
incident/alert/mission/reading timestamps.

`historical_health` is a **descriptive label** built only from real evidence
counts — it is **not** the live AI Decision score and is **not** a
prediction:

| Label | Trigger (documented thresholds) |
| --- | --- |
| `CRITICAL` | ≥ 1 CRITICAL incident **or** max recorded water level ≥ 90 |
| `DEGRADED` | ≥ 1 HIGH incident **or** ≥ 1 unresolved Critical alert **or** max water ≥ 75 |
| `WATCH` | any incident / alert / maintenance record **or** max water ≥ 50 |
| `HEALTHY` | evidence exists but no adverse signal |
| `INSUFFICIENT_DATA` | no evidence at all in the window |

Each drain also carries `historical_health_reasons` (human-readable, derived
from the real counts) and a transparent `evidence` object.

**CURRENT vs HISTORICAL:** `current_status` / `current_blockage_level` come
from the live `drains` row and are always kept **separate** from
`historical_health`.

### 4.3 Incident history (`getIncidentHistory`)

`total`, `active`, `resolved`, `by_severity` (LOW/MODERATE/HIGH/CRITICAL),
`by_status`, `by_source`, `by_drain` (top 10), `over_time` (daily buckets),
and timing:

- `average_acknowledgement_*` from `acknowledged_at - created_at`
- `average_response_*` from `responding_at - created_at`
- `average_resolution_*` from `resolved_at - created_at`

Each average is `null` when no row carries the required timestamp. Counts of
rows with real timestamps are exposed in `data_points`.

### 4.4 Mission / robot history (`getMissionHistory`, `getRobotHistory`)

`total`, `completed`, `assigned`, `by_status`, `by_drain`, per-robot history
(`mission_count`, `completed`, `assigned`, `completion_rate`), `completion_rate`
and `average_mission_duration_*` from `completed_time - assigned_time`.

The `missions` table has **no response timestamp**, so `average_response_*` is
honestly `null` and `response_time_available` is `false` — it is never
estimated.

### 4.5 Alert history (`getAlertHistory`)

`total`, `resolved`, `unresolved`, `critical`, `by_severity`, `by_type`,
`by_drain` (top 10) and `over_time` (daily buckets).

### 4.6 Time patterns (`getTimePatterns`)

Descriptive distributions from **real timestamps** (PostgreSQL
`EXTRACT(HOUR ...)` / `EXTRACT(DOW ...)`):

- `hourly_distribution` (24 buckets) and `weekday_distribution` (7 buckets)
  for incidents and alerts.
- `peak_incident_hour`, `peak_incident_day`, `peak_alert_hour`,
  `peak_alert_day` — reported only when the total ≥ `MIN_PATTERN_SAMPLES` (3);
  otherwise `null`.

Wording is deliberately non-causal: *"Most recorded incidents occurred during
the 14:00 hour."* — never "X causes incidents".

### 4.7 Current vs historical comparison (`getComparison`)

- **Sensor comparison:** live `sensors` value (**CURRENT**) vs the historical
  window average from `sensor_readings` (**HISTORICAL**), with
  `change` (**CHANGE**) and an `INSUFFICIENT_DATA` status when either side is
  missing.
- **Incident comparison:** incident count in the selected window vs the
  **immediately preceding window of equal length** (like-for-like; windows are
  never mixed), with `change` and `direction`.

CURRENT, HISTORICAL and CHANGE are labelled separately and **never combined
into a single score**.

### 4.8 Overview + summary

`getHistoricalOverview` aggregates every section plus a merged data-quality
block. `getHistoricalSummary` produces the compact shape used by the
dashboard/analytics integrations (`historical_incident_count`, recurrent /
degraded drain counts, `top_recurring_drains`, `recent_historical_trend`).

---

## 5. Data quality / `INSUFFICIENT_DATA`

Every response includes a `data_quality` block:

```json
{
  "period": "30d",
  "label": "PARTIAL",
  "sufficient_data": true,
  "record_count": 12,
  "earliest_timestamp": "...",
  "latest_timestamp": "...",
  "window_start": "...",
  "window_end": "...",
  "coverage_ratio": 0.42,
  "missing_signals": [],
  "tables_used": ["sensor_readings", "sensors", "drains"]
}
```

`label` uses documented record-count thresholds:

| Records in window | Label |
| --- | --- |
| `0` | `INSUFFICIENT_DATA` |
| `1 – 4` | `SPARSE` |
| `5 – 29` | `PARTIAL` |
| `>= 30` | `COMPLETE` |

`coverage_ratio` (span of real data ÷ window length) is informational.
Missing tables/metrics appear in `missing_signals`.

---

## 6. REST API

Mounted at `/api/historical` (read-only, no mutation, follows the existing
public read-analytics conventions).

| Method & path | Returns |
| --- | --- |
| `GET /api/historical` | Full overview |
| `GET /api/historical/overview` | Full overview (alias) |
| `GET /api/historical/summary` | Compact summary |
| `GET /api/historical/sensors` | Sensor history |
| `GET /api/historical/trends` | Per-sensor trend labels |
| `GET /api/historical/drains` | Per-drain history + health |
| `GET /api/historical/incidents` | Incident history |
| `GET /api/historical/missions` | Mission history |
| `GET /api/historical/robots` | Robot response history |
| `GET /api/historical/alerts` | Alert history |
| `GET /api/historical/patterns` | Descriptive time patterns |
| `GET /api/historical/comparison` | Current vs historical |

Query: `?period=24h|7d|30d|90d` (alias `?window=`), optional `?drainId=`.

### Additive dashboard / analytics

- `GET /api/dashboard` → add `historicalSummary`
  (`historicalIncidentCount`, `recurrentDrainCount`, `degradedDrainCount`,
  `historicalDataQuality`, `topRecurringDrains`, `recentHistoricalTrend`).
- `GET /api/analytics` → add `historical_period`, `historical_incident_count`,
  `historical_resolved_incident_count`, `historical_mission_count`,
  `historical_alert_count`, `historical_sensor_reading_count`,
  `historical_recurrent_drain_count`, `historical_degraded_drain_count`,
  `historical_data_quality`, `historical_recent_trend`,
  `historical_top_recurring_drains`.
- `GET /api/analytics/historical` → full overview (same validation).

Existing dashboard/analytics fields are never removed or renamed; these are
purely additive and degrade to safe defaults if the historical layer fails.

---

## 7. Socket.IO

The historical layer owns a **signature-guarded** emission contract
(`buildSignature` / `evaluateAndEmitHistoricalIntelligence` /
`resetHistoricalIntelligenceRuntime`) for a `historicalIntelligenceUpdate`
event on the **existing shared** `socketHub` — it never opens a second
Socket.IO server, and the signature ensures the event fires only when the
historical state meaningfully changes (never on every tick).

> In this update (#20A) the emission function is implemented and tested but
> is **not wired into the 5-second live loop**, to avoid repeatedly running
> windowed aggregation queries that are not needed every few seconds. Wiring
> is reserved for the live-emission sub-update. There is therefore no
> `historicalIntelligenceUpdate` in the running server's event list yet.

---

## 8. Performance

- All queries are bounded by the validated time window.
- Aggregation happens in PostgreSQL; the Node layer never loads an entire
  table into memory.
- Per-drain aggregations use one grouped query per source (no N+1).
- Existing indexes are used (`sensor_readings.drain_id`, `.recorded_at`,
  `incidents.created_at`, `.drain_id`, `alerts.drain_id`, `missions.*`).
- Default window is `30d`; result lists (top drains) are capped.

---

## 9. Security

- All parameters are validated (`period` against the allow-list, `drainId` as
  a positive integer).
- Every query is parameterized (`$1`, `$2`, …) — request values are never
  interpolated into SQL.
- Database errors are logged server-side and returned as a generic
  `{ error }`; raw database errors are never exposed.
- All endpoints are strictly read-only.

---

## 10. Limitations

- **Descriptive only.** No causality, seasonality or prediction claims.
- Historical health is a **label from evidence counts/thresholds**, not a
  trained model and not the AI Decision score.
- Mission **response time** cannot be computed — the schema stores no response
  timestamp — so it is `null`.
- Data quality is volume-based (record count); `coverage_ratio` is provided
  for callers that want to gauge temporal spread.
- `maintenance_predictions` / `drain_vision_inspections` are optional signals;
  absence is surfaced, not fabricated.
- No Historical Intelligence **UI** in this update (#20A) — backend
  foundation only.
