# AI-DrainOS Decision & Priority Engine

**Status**: implemented as an on-demand, deterministic computation layer. It does **not**
write to the database, does **not** replace any existing service, and does **not** change
`missionEngine.js` behavior.

## 1. What it does

For every drain the system produces several independent, explainable scores:

| Signal | Source service | Score used |
| --- | --- | --- |
| Flood Risk | `floodRiskService.buildDrainRiskDetail` | `riskScore` (0–100) + level |
| Forecast (60 min) | `floodForecastService.getDrainForecast` | `worst.predictedRiskScore` (0–100) |
| Maintenance | `maintenancePredictionService.getDrainMaintenance` | `maintenanceScore` (0–100) + blockage risk |
| Vision Inspection | `drainVisionService.getLatestInspection` | `visualRiskScore` (0–100) |

The **Decision & Priority Engine** answers one operational question: *"given everything
we know about this drain right now, how urgently should it be looked at, and what should
happen?"* It returns a single bounded **attention-priority score** (0–100), a priority
level, a recommended action, human-readable reasons, the weighted contributing factors,
and a robot dispatch recommendation.

## 2. Scoring (deterministic, bounded 0–100)

Weights (single source of truth in `decisionEngine.js`):

| Weight | Factor |
| --- | --- |
| 0.40 | Current Flood Risk |
| 0.25 | Forecast (60-min worst predicted risk) |
| 0.20 | Maintenance / blockage score |
| 0.15 | Latest Vision Inspection |

- Only **present** signals participate. Missing signals renormalize the remaining weights
  (e.g. a drain with no vision inspection yet simply scores on the other three).
- Additive modifiers (documented, capped):
  - **Rising water trend**: `+5` when the forecast trend direction is `rising` (or the flood
    risk trend label indicates a rise).
  - **Open alerts**: `+10` per open Critical alert, `+4` per open Medium alert, capped at a
    total of `+20` (proportionally scaled when exceeded).
- The result is `clamp(weightedBase + trend + alerts, 0, 100)`.

### Priority levels & actions

| Score | Level | Recommended action |
| --- | --- | --- |
| 0–24 | LOW | `CONTINUE_MONITORING` |
| 25–49 | MODERATE | `MONITOR_CLOSELY` |
| 50–74 | HIGH | `INSPECT_DRAIN` |
| 75–100 | CRITICAL | `IMMEDIATE_ROBOT_INSPECTION` |

## 3. Honesty contract

- An unavailable signal is **reported as unavailable** (`dataAvailability.* = false`) — it is
  never estimated, extrapolated or fabricated.
- When **no** signal is available the decision has `status: "INSUFFICIENT_DATA"`,
  `priorityScore: null`, `priorityLevel: null`, `recommendedAction: null`.
- `reasons` and `contributingFactors` only ever reference signals that actually existed.
- The engine never stores anything and exposes `disclaimer` text on every decision.

## 4. Robot dispatch recommendation

- Only HIGH / CRITICAL priorities consider robot dispatch (`required: true`).
- If a robot **already has an Assigned mission** for this drain → `assignedToDrain: true`
  with the robot's name/id.
- Otherwise the nearest available robot is recommended (Active/Idle, battery ≥ 30%,
  not busy with another drain). Distance is an approximate straight-line
  coordinate-space value.
- If no robot qualifies the response explains **why** (e.g. `"Robot-A1 battery too low (15%)"`
  or `"No robot currently available for inspection"`).
- This is a **recommendation only**. `missionEngine.js` remains the only authority that
  actually creates missions.

## 5. Real-time `decisionUpdate` event

When a decision is computed the engine emits `decisionUpdate` over Socket.IO **only on a
meaningful change**: the priority level changes **or** the score moves by ≥ 3 points. This
uses the shared `socketHub` (safe no-op outside a running server). The payload is the
full decision object.

The decision is recomputed automatically in two places:

1. On-demand REST calls (`/api/predictions/decision/:drainId`, and the shared
   dashboard/analytics summaries).
2. In the MQTT sensor pipeline: while handling a live reading, the engine is re-run per
   drain at most every 30 s and its result is **added** to the existing `sensorUpdate`
   payload as `decisionPriorityScore`, `decisionPriorityLevel` and
   `decisionRecommendedAction`. This is purely additive and never changes the MQTT core
   behavior (reading storage, AI prediction, alerts are untouched).

## 6. API endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /api/predictions/decision/:drainId` | Full decision for one drain (400 invalid id, 404 unknown drain). |
| `GET /api/dashboard/decisions` | Priority summary + top-5 drains for the dashboard panel. Optional `?refresh=true`. |
| `GET /api/analytics/decisions` | Decision analytics: distribution, average score, action distribution, signal coverage. Optional `?refresh=true`. |

All endpoints follow the existing public predictions model (no auth). `GET
/api/dashboard/decisions` and `/api/analytics/decisions` share the same computation
(`decisionEngine.getDecisionSummary`) with a 10-second cache.

## 7. Frontend

- **`AIDecisionPanel`** (mounted on the dashboard below the vision panel, and on a dedicated
  "AI Decisions" page): level counts, average priority, top-priority drains with score bars
  and action badges, and the recommended-action distribution. It refreshes on
  `decisionUpdate` live events and every 5s.
- **`AnalyticsReport`** renders an "AI Decision & Priority Summary" section
  (`/api/analytics/decisions`): drains evaluated, average priority score, per-level counts,
  insufficient-data count and top-priority drain badges.
- A toast appears when a `decisionUpdate` event arrives.

## 8. File map

- `server/services/decisionEngine.js` — the engine (weights, scoring, robots, summary,
  emission throttle).
- `server/routes/predictions.js` — `GET /api/predictions/decision/:drainId`.
- `server/routes/dashboard.js` — `GET /api/dashboard/decisions`.
- `server/routes/analytics.js` — `GET /api/analytics/decisions`.
- `client/src/components/AIDecisionPanel.jsx` — dashboard panel + dedicated page.
- `client/src/App.jsx` — mount, socket toast, page registration.
- `client/src/components/layout/Sidebar.jsx` — nav item.
- `client/src/components/AnalyticsReport.jsx` — analytics section.
- `server/tests/decisionEngine.test.js` — tests.

## 9. Testing

`server/tests/decisionEngine.test.js` covers: level boundaries (24/25, 49/50, 74/75),
action mapping, weighted/renormalized/bounded scoring, LOW and CRITICAL seed drains,
full-signal availability, INSUFFICIENT_DATA for a sensor-less drain, robot dispatch
(nearest / assigned / low battery / none), the `decisionUpdate` throttle (first, changed
≥3, level change, unchanged dedupe), determinism, honest reason generation, and the three
REST endpoints (including 400/404 handling).

Run with the full suite: `npm test` (from `server/`).