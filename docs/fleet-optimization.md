# 🚚 Predictive Resource & Robot Fleet Optimization (Update #19)

The fleet optimization layer (`server/services/fleetOptimizationService.js`) is a
**fleet-LEVEL, advisory** optimization layer. It reads the current system state — robots,
drains, active incidents, AI decisions, existing routes, charging stations and missions —
and produces **explainable robot-to-task recommendations** ranked by a deterministic,
documented score.

It is built **additively** on top of the existing architecture and obeys three hard rules:

1. **It is not a mission engine.** It never assigns or dispatches robots and never moves
   them. `missionEngine.js` remains the sole authority for assignment + movement.
2. **It does not replace anything.** It reuses the existing `decisionEngine` scores and
   the existing `robotPathPlanningService` primitives (distance/time/battery estimation,
   charging-station lookup). It never creates a second AI formula or a second planner.
3. **It never fabricates data.** Missing battery/location/decision values stay `null` and
   are reported honestly.

📄 Related docs: [robot-path-planning.md](robot-path-planning.md) ·
[decision-engine.md](decision-engine.md) · [incidents.md](incidents.md) ·
[digital-twin.md](digital-twin.md) · [api.md](api.md) · [database.md](database.md)

---

## 1. Advisory contract

> Fleet optimization is **ADVISORY ONLY**. Recommendations do **not** dispatch or assign
> robots — `missionEngine.js` remains the sole authority for mission assignment and
> movement. Distances/times are coordinate-space estimates derived from the existing
> movement-loop constants.

This disclaimer is returned in every non-error response (`disclaimer` field) and is shown
in the UI panels.

---

## 2. Inputs (all real)

| Source                       | Used for                                                        |
| ---------------------------- | --------------------------------------------------------------- |
| `robots` table               | Fleet state: status, battery, lat/lng, target lat/lng           |
| `missions` (`Assigned`)      | Whether a robot is **BUSY** (one assigned mission per robot)    |
| `charging_stations` table    | Nearest-station lookup for charging-stop routes                 |
| `drains` (Critical/Warning)  | Task queue candidates                                           |
| `incidents` (active)         | Task queue candidates + real decision score/level from incident |
| `decisionEngine` (existing)  | Real AI priority score/level for non-incident drain tasks       |
| `robotPathPlanningService`   | Distance, travel-time and battery-cost primitives               |

No new tables and no schema changes are required for this feature.

---

## 3. Availability states

Every robot is classified into exactly one honest availability state:

| State         | Meaning                                                             |
| ------------- | ------------------------------------------------------------------- |
| `AVAILABLE`   | `Idle` with a known battery above the mission reserve               |
| `BUSY`        | On an active (`Assigned`) mission — cannot safely take a second task |
| `CHARGING`    | `Charging` status (estimated time-to-full is derived from the +2%/tick rate) |
| `LOW_BATTERY` | Battery ≤ `MIN_BATTERY_MISSION` (20%) — charging required           |
| `OFFLINE`     | `Offline` status                                                    |
| `UNAVAILABLE` | `Maintenance`, unknown battery, or an `Active` robot with no assigned mission |

Only `AVAILABLE` robots are eligible for recommendations.

---

## 4. Task queue

Tasks come from **real** active incidents and Critical/Warning drains:

- `task_id` is `incident:<id>` for incidents and `drain:<id>` for drain-status tasks.
- A drain already covered by an active incident is **not** duplicated as a drain task.
- Decision scores come from the stored incident (captured by the incident layer) or the
  existing AI Decision Engine — never invented.

### Priority formula

```
taskPriority = decisionScore × 0.60
             + severityScore × 0.20
             + ageScore      × 0.10
             + urgency       × 0.10
```

- `severityScore`: LOW 25 · MODERATE 50 · HIGH 75 · CRITICAL 100.
- `ageScore`: 0 at age 0 → 100 at `AGE_RAMP_MINUTES` (60 min) and above.
- `urgency`: drain status (Critical 100 / Warning 60 / Normal 0) + incident status
  (OPEN 30 / ACKNOWLEDGED 20 / RESPONDING 10) + unassigned route status
  (`NO_ROBOT_AVAILABLE` 40 / `NO_COORDINATES` 20), clamped 0–100.
- If `decisionScore` is unavailable it is **not** fabricated: the remaining available
  signals are **renormalized** and `priority_status` is `RENORMALIZED`. When no signal is
  available the task is `INSUFFICIENT_DATA` with a `null` score.

Every task returns `priority_score`, `priority_status`, `priority_breakdown` and an
`estimated_urgency` level (same 25/50/75 banding as the rest of the system).

---

## 5. Candidate scoring (100-point budget)

Each eligible robot for a task is scored deterministically:

| Component    | Weight | Formula                                                |
| ------------ | ------ | ------------------------------------------------------ |
| Distance     | 35     | `max(0, 35 − distance × 4000)` (closer is better)      |
| Battery      | 25     | `(battery / 100) × 25`                                 |
| ETA          | 20     | `max(0, 20 − travelSeconds / 60)` (faster is better)   |
| Availability | 10     | `+10` for an `AVAILABLE` robot                         |
| Feasibility  | 10     | `+10` when a feasible route exists                     |

Ineligible robots receive a `null` score (and the reason/warning that made them
ineligible).

### Battery-aware route modes

Reusing `robotPathPlanningService`:

```
START → TASK                     => DIRECT
START → CHARGING STATION → TASK  => CHARGE_THEN_TASK
otherwise                        => NO_FEASIBLE_ROUTE
```

A route is never reported feasible when the battery is insufficient, even with a charging
stop. Each recommendation carries `estimated_distance`, `estimated_travel_time`,
`estimated_battery_cost`, `battery_before`, `battery_after` and `charging_required`.

---

## 6. Greedy multi-task assignment

- Tasks are processed in **priority order** (ties broken by `task_id`).
- A robot can be recommended for **at most one** task.
- If no eligible/available robot remains, the task is returned under `unassigned` with a
  real `reason` and a `required_action`:

| Reason                | Meaning                                            |
| --------------------- | -------------------------------------------------- |
| `NO_ROBOTS`           | The fleet is empty                                 |
| `NO_COORDINATES`      | The task's drain has no latitude/longitude         |
| `NO_FEASIBLE_ROUTE`   | No robot can reach it even with a charging stop    |
| `NO_ELIGIBLE_ROBOT`   | Eligible robots exist but are already committed    |
| `INSUFFICIENT_DATA`   | Missing battery/location data for the fleet        |

Every recommendation includes a human-readable `explanation`, `reasons`, `warnings` and
ranked `alternatives`.

---

## 7. Fleet status

`buildGlobalStatus` returns one deterministic status:

`OK` · `NO_TASKS` · `NO_ROBOTS` · `NO_ELIGIBLE_ROBOT` · `NO_COORDINATES` ·
`NO_FEASIBLE_ROUTE` · `INSUFFICIENT_DATA`

### Summary fields

`total_robots`, `available_robots`, `busy_robots`, `charging_robots`,
`low_battery_robots`, `offline_robots`, `unavailable_robots`, `active_tasks`,
`assigned_tasks`, `unassigned_tasks`, `recommended_assignments`, `fleet_utilization`
(`(busy + charging) / total × 100`), `battery_risk_count`, `charging_requirement_count`.

---

## 8. REST API

Base path: `/api/fleet-optimization`. All endpoints are **read-only** and public
(no authentication, no state changes), matching the other analytical read endpoints.

| Method | Path                                 | Description                                        |
| ------ | ------------------------------------ | -------------------------------------------------- |
| GET    | `/api/fleet-optimization`            | Full advisory view                                 |
| GET    | `/api/fleet-optimization/summary`    | Status + summary + warnings + disclaimer           |
| GET    | `/api/fleet-optimization/tasks`      | Prioritized task queue (with recommendation status)|
| GET    | `/api/fleet-optimization/robots`     | Robot state + availability states                  |
| GET    | `/api/fleet-optimization/recommendations` | Assignments + unassigned + charging needs      |
| GET    | `/api/fleet-optimization/analytics`  | Fleet metrics (utilization, coverage, response)    |
| GET    | `/api/fleet-optimization/:taskId`    | One task + its recommendation/unassigned (404 when missing) |

Additive dashboard/analytics surfaces:

- `GET /api/dashboard` gains a best-effort `fleet` object (camelCase).
- `GET /api/dashboard/fleet` returns `getSummary()`.
- `GET /api/analytics` gains `fleet_*` fields.
- `GET /api/analytics/fleet-optimization` returns `getAnalytics()`.

---

## 9. Socket.IO event

The service emits through the **existing shared** `socketHub`:

```js
socketHub.emit("fleetOptimizationUpdate", {
  status, summary, tasks, recommendations, robots, unassigned, generated_at
});
```

Emission is **signature-guarded** so it only fires on a meaningful change. The raw
per-tick battery value is deliberately excluded from the signature (it changes every 5 s
as robots drain/charge), so the event does not spam; availability-state changes, task
priority/recommendation changes and summary changes are what trigger it. No second
Socket.IO server is created; `socketHub.emit` is a safe no-op when the hub is not
initialized (used by tests).

---

## 10. Frontend

| Piece             | File                                                   | Role                                                        |
| ----------------- | ------------------------------------------------------ | ----------------------------------------------------------- |
| REST client       | `client/src/services/fleetOptimizationService.js`       | Thin axios wrappers for all 7 endpoints                     |
| Dashboard panel   | `client/src/components/FleetOptimizationPanel.jsx`      | Stat strip, top recommendations, unassigned warnings        |
| Full page         | `client/src/components/FleetOptimizationPage.jsx`       | Task queue, recommendations, availability, charging view    |
| Styles            | `client/src/styles/fleetOptimization.css`               | Status/availability/route pills                             |
| Navigation        | `Sidebar.jsx`, `App.jsx`                                | "Fleet Optimization" nav item; `fleetOptimizationUpdate` toast + cleanup |

The app-level `fleetOptimizationUpdate` listener shows a warning toast only when there is
an unassigned task or the status is `NO_ELIGIBLE_ROBOT` (silent otherwise) and is removed
on cleanup. Both the panel and page re-fetch from the server so the UI always reflects
real state.

---

## 11. Digital Twin overlay (additive)

The Digital Twin consumes `GET /api/fleet-optimization` in its existing aggregation
(`loadDigitalTwinData` → `Promise.allSettled`) and merges the advisory overlay onto drains
and robots:

- `normalizeFleetOptimization` builds `byRobot`, `byDrain` and `unassignedByDrain` maps
  plus `criticalUnassignedDrainIds`.
- The reducer handles `SET_DATA` (fleet field) and `FLEET_OPTIMIZATION_UPDATE` (live
  overlay; an invalid payload never clobbers existing state).
- `DigitalTwin.jsx` draws an **availability ring** around each robot and a
  **recommended-task ring** (cyan) on the assigned robot; drains get a cyan ring when a
  robot is recommended and a red ring when unassigned, with labels.
- The page header gains an "Unassigned tasks" stat and the details panel/fallback table
  show availability + suggested task (all via the `AVAILABILITY_COLOR` /
  `FLEET_STATUS_COLOR` shared palette).
- **Degraded but usable**: if the fleet API fails, `loadError` includes
  `"fleetOptimization"`, `fleet` is `null`, and the scene renders normally with no fleet
  markers.

---

## 12. Failure / degraded states

| Situation                     | Behaviour                                                         |
| ----------------------------- | ----------------------------------------------------------------- |
| Fleet API down (Twin)         | Scene stays usable; `loadError` reports `fleetOptimization`; no fleet markers |
| Fleet API down (panel/page)   | Panel/page show an error state; no fabricated recommendations     |
| Empty fleet                   | Status `NO_ROBOTS`; all tasks unassigned with reason `NO_ROBOTS`  |
| No active tasks               | Status `NO_TASKS`                                                 |
| Missing drain coordinates     | Status `NO_COORDINATES`; task reason `NO_COORDINATES`             |
| All eligible robots committed | Status `NO_ELIGIBLE_ROBOT`; task reason `NO_ELIGIBLE_ROBOT`       |
| Missing battery/location      | Robot is ineligible (or `UNAVAILABLE`); never a fabricated value  |

---

## 13. Tests

- `server/tests/fleetOptimizationService.test.js` — 26 unit/integration tests (priority &
  candidate formulas, route modes, availability states, recommendations, summary,
  signature-guarded emission).
- `server/tests/fleetOptimization.test.js` — 13 REST API tests for `/api/fleet-optimization`.
- 6 additive Digital Twin fleet-overlay tests in `server/tests/digitalTwin.test.js`.
- Run the full backend suite (from `server/`): `npm test`
  (`node --test --test-concurrency=1 "tests/*.test.js"`).

---

## 14. Non-goals / limitations

- The layer does **not** dispatch or move robots — `missionEngine.js` and the movement
  loop are untouched.
- Distances/times/battery costs are **coordinate-space** estimates derived from the
  existing movement-loop constants, not road-network measurements.
- `fleet_utilization` counts robots committed to work (`busy + charging`); it is an
  operational snapshot, not a long-term utilization statistic.
- Recommendations are recomputed from live state on each request/loop tick; they are not
  persisted.
