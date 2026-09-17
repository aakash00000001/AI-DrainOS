# 🚑 Autonomous Emergency Response & Incident Intelligence (Update #18)

The incident layer turns the system's real high-stakes signals into a **trackable
emergency workflow** instead of a transient toast. It is built **additively** on top of
the existing architecture: it reuses the existing robot path planner, the existing
single Socket.IO connection, the existing database pool and the existing route/service
patterns. It does **not** modify `missionEngine.js`, does not add a second Socket.IO
server, and does not duplicate robot selection or path-planning logic.

📄 Related docs: [decision-engine.md](decision-engine.md) ·
[robot-path-planning.md](robot-path-planning.md) ·
[flood-risk.md](flood-risk.md) · [forecasting.md](forecasting.md) ·
[maintenance-prediction.md](maintenance-prediction.md) ·
[vision-inspection.md](vision-inspection.md) · [digital-twin.md](digital-twin.md) ·
[api.md](api.md) · [database.md](database.md)

---

## 1. Lifecycle

```
OPEN ──acknowledge──▶ ACKNOWLEDGED ──respond──▶ RESPONDING ──resolve──▶ RESOLVED
  │                          │                       │
  └──────────────respond─────┴───────────────────────┘   (acknowledge can be skipped)
```

- **OPEN** — created, not yet seen by an operator.
- **ACKNOWLEDGED** — an operator has accepted ownership.
- **RESPONDING** — active response in progress (robot dispatched or crew engaged).
- **RESOLVED** — closed with optional `resolution_notes`.

Transitions are **guarded** in `server/services/incidentService.js`:

- `ACKNOWLEDGED → OPEN` is rejected.
- `RESOLVED` (or `RESPONDING`) cannot be acknowledged/responded again.
- Re-sending the **same** transition is an idempotent no-op (returns the current row).
- Invalid moves return `409 INVALID_TRANSITION`.

A `RESOLVED` incident no longer blocks a new active incident for the same drain.

---

## 2. Severity & source

| Severity   | Meaning                                   |
| ---------- | ----------------------------------------- |
| `LOW`      | Informational / low impact                |
| `MODERATE` | Needs attention                           |
| `HIGH`     | Serious, monitor closely                  |
| `CRITICAL` | Emergency — automatic robot planning runs |

| Source        | Raised by                                                            |
| ------------- | ------------------------------------------------------------------- |
| `AI_DECISION` | A real **READY + CRITICAL** drain decision (never fabricated)        |
| `FLOOD_RISK`  | Flood risk engine signals                                            |
| `FORECAST`    | Predictive flood forecast signals                                    |
| `MAINTENANCE` | Maintenance / blockage prediction signals                            |
| `VISION`      | Computer-vision drain inspection signals                             |
| `MANUAL`      | An operator, via the panel or `POST /api/incidents`                  |

Severity is **never invented**. An `AI_DECISION` incident is only created when the
existing decision engine returns `status === "READY"` **and** `priorityLevel ===
"CRITICAL"`; otherwise the request is rejected with `409 NOT_CRITICAL` /
`NO_VALID_DECISION`.

---

## 3. Creation paths

1. **MQTT pipeline hook** — after an AI decision is computed in `mqttService.js`,
   a `READY + CRITICAL` result calls `incidentService.createIncidentFromDecision(...)`
   **fire-and-forget** inside a `try/catch`. It can never break or delay the sensor
   pipeline. Duplicate active incidents are silently skipped.
2. **`POST /api/incidents` with `source: "AI_DECISION"`** — re-reads the real decision
   from `decisionEngine.getDrainDecision(drainId)` and creates the incident only for a
   genuine CRITICAL result.
3. **`POST /api/incidents` with any other source** (e.g. `MANUAL`) — created directly.

---

## 4. Robot dispatch reuse (no duplicate planner)

For a CRITICAL incident the service calls the **existing**
`robotPathPlanningService.planRoute(drainId)` — the same engine used by the Robot Route
Planner. It never re-implements robot selection and never dispatches a robot;
`missionEngine.js` remains the authority for missions.

The recorded `route_status` is honest:

| `route_status`         | Meaning                                                        |
| ---------------------- | -------------------------------------------------------------- |
| `PLANNED`              | Planner selected a robot and produced a real route             |
| `MANUAL`               | Operator assigned a specific `assigned_robot_id`               |
| `NO_ROBOT_AVAILABLE`   | No robot qualified (none idle / all busy or charging)          |
| `NO_COORDINATES`       | The drain has no coordinates — planning is impossible          |

> Note: `robotPathPlanningService.finiteNumber()` coerces `NULL` to `0`, so a drain with
> missing coordinates could look "valid" to the planner. The incident service therefore
> checks the drain's coordinates **itself** first and records `NO_COORDINATES` honestly
> without touching the shared planner.

A manually supplied `assigned_robot_id` is validated **before** the incident row is
inserted, so an unknown robot never leaves a stray incident behind.

---

## 5. Integrity rules

- **One active incident per drain.** Enforced by the application check **and** a partial
  unique index `idx_incidents_one_active_per_drain`
  (`WHERE status IN ('OPEN','ACKNOWLEDGED','RESPONDING')`).
- **Guarded transitions** (section 1).
- **Stored-timestamp-only timeline.** The timeline is derived exclusively from the real
  columns (`created_at`, `assigned_at`, `route_status_changed_at`, `acknowledged_at`,
  `responding_at`, `resolved_at`). A missing timestamp means the event never happened and
  is omitted — history is never invented.
- **Honest analytics.** Average response/resolution times are computed from real
  timestamps and returned as `null` (with a `data_points` count) until there is enough
  data.

---

## 6. Data model

Table `incidents` (see `database/schema.sql` and the idempotent
`database/migrations/005_incidents.sql`):

| Column                  | Type          | Notes                                             |
| ----------------------- | ------------- | ------------------------------------------------- |
| `id`                    | SERIAL PK     |                                                   |
| `drain_id`              | INT FK drains | `ON DELETE CASCADE`                               |
| `severity`              | VARCHAR(20)   | CHECK in LOW/MODERATE/HIGH/CRITICAL               |
| `title`                 | VARCHAR(255)  | nullable                                          |
| `description`           | TEXT          | nullable                                          |
| `source`                | VARCHAR(30)   | CHECK in AI_DECISION/FLOOD_RISK/FORECAST/MAINTENANCE/VISION/MANUAL |
| `decision_score`        | INT           | nullable, real decision 0–100                     |
| `decision_level`        | VARCHAR(20)   | nullable                                          |
| `assigned_robot_id`     | INT FK robots | nullable, `ON DELETE SET NULL`                    |
| `route_status`          | VARCHAR(30)   | nullable (PLANNED/MANUAL/NO_ROBOT_AVAILABLE/NO_COORDINATES) |
| `route`                 | JSONB         | nullable, real planner route when available       |
| `status`                | VARCHAR(20)   | CHECK in OPEN/ACKNOWLEDGED/RESPONDING/RESOLVED    |
| `created_at`            | TIMESTAMPTZ   | `CURRENT_TIMESTAMP`                               |
| `assigned_at`           | TIMESTAMPTZ   | nullable                                          |
| `route_status_changed_at` | TIMESTAMPTZ | nullable                                          |
| `acknowledged_at`       | TIMESTAMPTZ   | nullable                                          |
| `responding_at`         | TIMESTAMPTZ   | nullable                                          |
| `resolved_at`           | TIMESTAMPTZ   | nullable, CHECK `resolved_at IS NULL OR status='RESOLVED'` |
| `resolution_notes`      | TEXT          | nullable                                          |

Indexes: `drain_id`, `status`, `severity`, `created_at`, plus the partial unique active
index.

---

## 7. REST API

Base path: `/api/incidents`. GET endpoints are public; POST/PUT require a JWT
(`Authorization: Bearer <token>`), matching the existing alerts pattern.

| Method | Path                       | Description                                              |
| ------ | -------------------------- | -------------------------------------------------------- |
| GET    | `/api/incidents`           | List incidents. Filters: `status`, `severity`, `drain_id` |
| GET    | `/api/incidents/active`    | Only OPEN / ACKNOWLEDGED / RESPONDING                     |
| GET    | `/api/incidents/:id`       | One incident (404 when missing)                          |
| GET    | `/api/incidents/:id/timeline` | Stored-timestamp lifecycle events                     |
| POST   | `/api/incidents`           | Create (201)                                             |
| PUT    | `/api/incidents/:id/acknowledge` | OPEN → ACKNOWLEDGED                                |
| PUT    | `/api/incidents/:id/respond`     | OPEN/ACKNOWLEDGED → RESPONDING                     |
| PUT    | `/api/incidents/:id/resolve`     | → RESOLVED (optional `resolution_notes`)           |

Status codes: `201` created, `200` transition, `400` invalid input, `404` not found,
`409` duplicate active incident / invalid transition / not critical.

**Create body**

```json
{
  "drain_id": 5,
  "severity": "CRITICAL",
  "source": "MANUAL",
  "title": "Sinkhole reported",
  "description": "Optional context"
}
```

`source: "AI_DECISION"` ignores a supplied severity and uses the real decision.

---

## 8. Socket.IO event

The service emits through the **existing shared** `socketHub`:

```js
socketHub.emit("incidentUpdate", { eventType, incident });
```

`eventType` ∈ `created`, `assigned`, `robotUnavailable`, `acknowledged`, `responded`,
`resolved`. `incident` is the full row (nested `drain` and `robot` when available). No
second Socket.IO server is created; `socketHub.emit` is a safe no-op when the hub is not
initialized (used by tests).

---

## 9. Dashboard & analytics (additive)

- `GET /api/dashboard` adds `incidents: { counts: { active, critical, responding,
  resolved, open, acknowledged, total }, latest }`. Existing fields are unchanged and the
  additions are best-effort (a safe default is returned on error).
- The `dashboardUpdate` socket payload additively carries `incidents.counts`.
- `GET /api/analytics` adds incident totals/by-severity plus average response/resolution
  times (minutes, `null` until enough data).
- `GET /api/analytics/incidents` returns `by_severity`, `by_status`, `by_source`, real
  `average_response_seconds` / `average_resolution_seconds` (and minute equivalents) and
  a `data_points` count.

---

## 10. Frontend

| Piece                       | File                                              | Role                                                                 |
| --------------------------- | ------------------------------------------------- | -------------------------------------------------------------------- |
| REST client                 | `client/src/services/incidentService.js`          | Thin axios wrapper (adds auth headers on mutations)                  |
| Dashboard panel             | `client/src/components/EmergencyResponsePanel.jsx`| Active-incident stat strip, list, quick actions, manual create       |
| Full page                   | `client/src/components/IncidentsPage.jsx`         | Filters, incident table, detail panel, resolve-with-notes, live updates |
| Timeline                    | `client/src/components/IncidentTimeline.jsx`      | Renders the stored-timestamp lifecycle events                        |
| Styles                      | `client/src/styles/incidents.css`                 | Severity/status badges, route pills, timeline                        |
| Navigation & toasts         | `Sidebar.jsx`, `App.jsx`                          | "Emergency / Incidents" nav item; `incidentUpdate` toast + cleanup   |

- The app-level `incidentUpdate` listener shows a toast (error for CRITICAL `created`,
  warning for `robotUnavailable`, info otherwise) and is removed on cleanup.
- The panel and page re-fetch from the server on every event so the UI always reflects
  real state (no client-side fabrication).

---

## 11. Digital Twin overlay (additive)

The Digital Twin consumes `GET /api/incidents/active` in its existing aggregation
(`loadDigitalTwinData` → `Promise.allSettled`) and merges active incidents onto drains:

- `normalizeIncidentSignal` maps a row to a small signal (id, drainId, severity, status,
  route status, robot).
- `buildActiveIncidentByDrain` keeps one active incident per drain (most severe wins).
- The reducer handles `SET_DATA` (derived map) and `INCIDENT_UPDATE` (live overlay, auto
  clearing on resolve).
- `DigitalTwin.jsx` draws an emergency beacon + label on affected drains and keeps
  incident drains visible in the "critical" focus.
- **Degraded but usable**: if the incident API fails, `loadError` includes `"incidents"`
  and the scene renders normally without incident beacons.

---

## 12. Failure / degraded states

| Situation                       | Behaviour                                                        |
| ------------------------------- | ---------------------------------------------------------------- |
| Incident API down (Twin)        | Scene stays usable; `loadError` reports `incidents`; no beacons   |
| Duplicate active incident       | `409 DUPLICATE_ACTIVE_INCIDENT`                                   |
| Unknown drain / robot           | `404 DRAIN_NOT_FOUND` / `400 ROBOT_NOT_FOUND` (validated pre-insert) |
| Missing drain coordinates       | `route_status = NO_COORDINATES` (no fake route)                   |
| No robot available              | `route_status = NO_ROBOT_AVAILABLE`                              |
| AI decision not CRITICAL/READY  | `409 NOT_CRITICAL` / `NO_VALID_DECISION`                         |
| Resolve an already-resolved row | `409 INVALID_TRANSITION`                                         |

---

## 13. Tests

- `server/tests/incidentService.test.js` — 22 unit/integration tests for the service.
- `server/tests/incidents.test.js` — 20 tests for the REST API + socket behaviour.
- 5 additive Digital Twin incident tests in `server/tests/digitalTwin.test.js`.
- Run the full backend suite (from `server/`): `npm test`
  (`node --test --test-concurrency=1 "tests/*.test.js"`). Total: **284 tests**.

---

## 14. Non-goals / limitations

- The incident layer does **not** dispatch robots or move them — `missionEngine.js` and
  the movement loop are untouched.
- `FLOOD_RISK` / `FORECAST` / `MAINTENANCE` / `VISION` are supported as **sources** for
  manual/API creation; only the AI-decision path is wired to auto-create, matching the
  existing engine contracts. Additional auto-hooks can be added later without schema
  changes.
- Response/resolution time analytics are honest averages over **stored** timestamps only;
  they return `null` until real data exists.
