# 🤝 Autonomous Mission Scheduling & Multi-Robot Coordination (Update #22)

The mission coordination layer (`server/services/missionCoordinatorService.js`) is a
**fleet-wide, deterministic and explainable** scheduling layer. It answers, for the whole
fleet at once: which task matters most, which robot should take it, can that robot reach it,
and what conflicts / reassignments already exist.

It is built **additively** on top of the existing architecture and obeys four hard rules:

1. **`missionEngine.js` stays the sole authority.** Coordination never inserts a competing
   mission record. In `AUTONOMOUS_PLAN` mode it only ever calls
   `missionEngine.dispatchMission(robotId, drainId)`, which enforces the existing
   uniqueness/authority rules.
2. **Nothing is replaced.** It reuses `fleetOptimizationService` (robot/task state, route
   evaluator, availability), `robotPathPlanningService` (distance/time/battery/charging
   primitives) and `decisionEngine` (aggregated AI signals). No second planner, no second AI
   formula.
3. **No fabricated data.** Missing battery / coordinates / priority signals are reported
   explicitly (`INSUFFICIENT_DATA`, `NO_COORDINATES`, `NO_FEASIBLE_ROUTE`, …) and never
   invented.
4. **Deterministic + explainable.** Every score is a documented weighted sum of real inputs
   and every assignment carries a reason.

📄 Related docs: [fleet-optimization.md](fleet-optimization.md) ·
[robot-path-planning.md](robot-path-planning.md) · [decision-engine.md](decision-engine.md) ·
[incidents.md](incidents.md) · [digital-twin.md](digital-twin.md) · [api.md](api.md) ·
[database.md](database.md)

---

## 1. Planning contract

> Mission coordination is a **planning** layer. `ADVISORY_PLAN` (the default) never mutates
> missions. `AUTONOMOUS_PLAN` only ever dispatches through the existing `missionEngine`.
> Distances / times are coordinate-space estimates derived from the existing movement-loop
> constants.

This disclaimer is returned in every non-error response (`disclaimer` field) and shown in the
UI. The default mode on every read endpoint and on the live loop is **advisory**.

---

## 2. Modes

| Mode              | Behaviour                                                                  |
| ----------------- | -------------------------------------------------------------------------- |
| `ADVISORY_PLAN`   | Builds and returns the plan. **Never changes any mission.** This is the default. |
| `AUTONOMOUS_PLAN` | Builds the plan, then executes each assignment through `missionEngine.dispatchMission`. |

`POST /plan` accepts `"advisory"` / `"autonomous"` (case-insensitive) as well as the
canonical `ADVISORY_PLAN` / `AUTONOMOUS_PLAN`. Any other value returns `400` with
`allowed_modes: ["advisory", "autonomous"]`.

---

## 3. Inputs (all real)

| Source                                  | Used for                                                     |
| --------------------------------------- | ------------------------------------------------------------ |
| `robots` table                          | Fleet state: status, battery, lat/lng, current mission       |
| `missions` (`Assigned`)                 | Whether a robot is committed; duplicate/double-assignment detection |
| `charging_stations` table               | Nearest-station lookup for charging-stop routes              |
| `drains`                                | Task coordinates + flood-risk signals                        |
| `incidents` (active)                    | Task severity + age, and real decision score/level           |
| `floodRiskService` (signals)            | Flood-risk component of the coordination priority            |
| `floodForecastService` (signals)        | Forecast-urgency component                                   |
| `maintenancePredictionService` (signals)| Maintenance component                                        |
| `drainVisionService` (signals)          | Vision component                                             |
| `decisionEngine` (existing)             | AI decision score/level component                            |
| `robotPathPlanningService`              | Distance, travel-time and battery-cost primitives            |
| `fleetOptimizationService`              | Availability states, route evaluator, shared constants       |

No new tables and no schema changes are required for this feature.

---

## 4. Coordination priority (100% budget)

Task priority is **separate from** the AI Decision score (which is itself one of its inputs):

```
coordinationPriority = decision          × 0.40
                     + incidentSeverity  × 0.25
                     + floodRisk         × 0.15
                     + forecastUrgency   × 0.10
                     + maintenance/vision× 0.10
```

- Weights come from `COORDINATION_WEIGHTS` (documented, deterministic).
- When a signal is unavailable it is **dropped and the remaining weights are renormalized**;
  `priority_status` becomes `RENORMALIZED`. When no signal is available the task reports
  `priority_status = "INSUFFICIENT_DATA"` with a `null` `priority_score` — never a fabricated
  number.

---

## 5. Candidate scoring (100-point budget)

Each eligible robot for a task is scored deterministically:

| Component    | Weight | Meaning                                              |
| ------------ | ------ | ---------------------------------------------------- |
| Distance     | 30     | Closer is better (`DISTANCE_FALLOFF` from fleet opt.)|
| Battery      | 25     | Battery sufficiency above the mission reserve        |
| ETA          | 20     | Faster is better                                     |
| Availability | 15     | Availability state of the robot                      |
| Feasibility  | 10     | A feasible route exists                              |

Ineligible robots receive a `null` score plus the explicit `rejection_reason` that made them
ineligible.

### Battery-aware route modes

Reusing `fleetOptimizationService.evaluateRouteMode` / `robotPathPlanningService`:

```
START → TASK                     => DIRECT
START → CHARGING STATION → TASK  => CHARGE_THEN_TASK
otherwise                        => NO_FEASIBLE_ROUTE
```

A route is never reported feasible when the battery is insufficient, even with a charging
stop.

---

## 6. Assignment, unassigned reasons and conflicts

- Tasks are processed in **priority order**, deterministic tie-breaking.
- A robot is assigned to **at most one** task.
- When no eligible/free robot remains, the task is returned under `unassigned` with a real
  `reason` and `required_action`:

| Reason                | Meaning                                                     |
| --------------------- | ----------------------------------------------------------- |
| `NO_AVAILABLE_ROBOT`  | No robot is available for the task                          |
| `NO_FEASIBLE_ROUTE`   | No robot can reach it even with a charging stop             |
| `INSUFFICIENT_BATTERY`| Battery is insufficient for every candidate                 |
| `ALL_ROBOTS_BUSY`     | Eligible robots exist but are all committed                 |
| `NO_COORDINATES`      | The task's drain has no latitude/longitude                  |
| `INSUFFICIENT_DATA`   | Missing battery/location data for the fleet                 |

### Conflict types

`detectConflicts` raises explicit, non-destructive conflicts (never silently overwriting
anything):

`ROBOT_DOUBLE_ASSIGNED` · `DUPLICATE_ACTIVE_MISSION` · `DUPLICATE_DRAIN_TASK` ·
`ROBOT_CHARGING_WITH_MISSION` · `ROBOT_UNAVAILABLE_WITH_MISSION` · `LOW_BATTERY_WITH_MISSION` ·
`TASK_WITHOUT_COORDINATES` · `ROBOT_WITHOUT_COORDINATES`.

### Reassignment

`getReassignmentPlan` flags active missions that need reassignment
(`REASSIGNMENT_REASON`: `ROBOT_OFFLINE`, `ROBOT_UNAVAILABLE`, `ROBOT_CHARGING`,
`BATTERY_INSUFFICIENT`, `ROUTE_INFEASIBLE`, `MISSION_CANCELLED`) and recommends the best
eligible **replacement** — it never reassigns by itself.

---

## 7. Global status & summary

`buildGlobalStatus` returns one deterministic status:

`OK` · `NO_TASKS` · `NO_ROBOTS` · `NO_ELIGIBLE_ROBOT` · `NO_FEASIBLE_ROUTE` ·
`NO_COORDINATES` · `INSUFFICIENT_DATA`

### Summary fields

`total_tasks`, `assigned_tasks`, `already_assigned_tasks`, `unassigned_tasks`,
`total_robots`, `available_robots`, `busy_robots`, `charging_robots`, `low_battery_robots`,
`offline_robots`, `unavailable_robots`, `coordination_conflicts`, `reassignment_required`.

---

## 8. REST API

Base path: `/api/missions/coordination`. Read endpoints are public (matching the other
analytical read endpoints). The **only** state-changing endpoint is `POST /plan`, which is
auth-protected.

| Method | Path                                        | Description                                      |
| ------ | ------------------------------------------- | ------------------------------------------------ |
| GET    | `/api/missions/coordination`                | Full advisory plan (status, summary, tasks, assignments, unassigned, conflicts, reassignments, robot_availability, warnings) |
| GET    | `/api/missions/coordination/tasks`          | Live task queue                                  |
| GET    | `/api/missions/coordination/robots`         | Robot eligibility / availability view            |
| GET    | `/api/missions/coordination/conflicts`      | Conflict list                                    |
| GET    | `/api/missions/coordination/summary`        | Status + summary + warnings + disclaimer         |
| GET    | `/api/missions/coordination/analytics`      | Coordination metrics + prefixed aliases          |
| POST   | `/api/missions/coordination/plan`           | Build (and, in autonomous mode, execute) a plan — **auth required** |

The router is mounted in `server/app.js` **before** `/api/missions`, so
`/api/missions/coordination/*` is not shadowed by the mission router.

Additive dashboard/analytics surfaces:

- `GET /api/dashboard` gains a best-effort `coordination` object (camelCase).
- `GET /api/analytics` gains `coordination_*` fields (including
  `coordination_average_task_priority`, `coordination_average_candidate_score`,
  `coordination_status`).
- `GET /api/analytics/coordination` returns `getAnalytics()`.

---

## 9. Socket.IO event

The service emits through the **existing shared** `socketHub`:

```js
socketHub.emit("missionCoordinationUpdate", {
  status, mode, summary, assignments, unassigned, conflicts,
  reassignment_required, generated_at
});
```

Emission is **signature-guarded**: raw per-tick battery is deliberately excluded so the event
does not spam; status, assignment, unassigned-reason, conflict and reassignment changes are
what trigger it. The event is wired into the existing 5 s live loop in `server/index.js`
(section "12. MISSION COORDINATION"). No second Socket.IO server is created;
`socketHub.emit` is a safe no-op when the hub is not initialized (used by tests).

---

## 10. Analytics honesty note

`average_assignment_time_seconds` is returned as `null` with
`average_assignment_time_available: false` and an explicit
`average_assignment_time_reason`: the schema stores no queue timestamp, so assignment wait
time cannot be computed honestly. The real `missions` timestamps ARE used for
`average_mission_duration_seconds`.

---

## 11. Frontend

| Piece           | File                                                 | Role                                                              |
| --------------- | ---------------------------------------------------- | ----------------------------------------------------------------- |
| REST client     | `client/src/services/missionCoordinationService.js`  | Thin axios wrappers + authenticated `POST /plan`                  |
| Dashboard panel | `client/src/components/MissionCoordinationPanel.jsx` | Stat strip, top assignments, unassigned/conflict warnings         |
| Full page       | `client/src/components/MissionCoordinationPage.jsx`  | Task queue, robot availability, assignments/alternatives, unassigned, conflicts, reassignments, Advisory / Autonomous actions |
| Styles          | `client/src/styles/missionCoordination.css`          | Status/severity/route/availability pills                          |
| Navigation      | `Sidebar.jsx`, `App.jsx`                             | "Mission Coordination" nav item; `missionCoordinationUpdate` toast + cleanup |

The app-level `missionCoordinationUpdate` listener shows a warning toast only when there are
unassigned tasks / conflicts / `NO_ELIGIBLE_ROBOT` (silent otherwise) and is cleaned up on
unmount. The Autonomous button calls `POST /plan` with `mode: "autonomous"`; without a token
the UI shows a sign-in message (the endpoint is auth-protected). Both panel and page re-fetch
from the server so the UI always reflects real state.

---

## 12. Digital Twin & robot-page overlay (additive, READ ONLY)

- `normalizeMissionCoordination` (in `digitalTwinUtils.mjs`) builds `byDrain`, `byRobot`,
  `unassignedByDrain`, `conflicts` and `reassignments` maps plus
  `criticalUnassignedDrainIds`.
- The twin reducer handles `SET_DATA` (coordination field) and `MISSION_COORDINATION_UPDATE`
  (live overlay; an invalid payload never clobbers existing state).
- The page header gains a "Mission coordination" stat; the drain/robot details panels show
  the coordination priority, planned robot/route, ETA and required action.
- `RobotSimulation` shows a per-robot coordination line (availability + planned/current
  drain).
- **Degraded but usable**: if the coordination API fails, `loadError` includes
  `"missionCoordination"`, `coordination` is `null`, and the scene renders normally with no
  coordination markers.

---

## 13. Failure / degraded states

| Situation                    | Behaviour                                                            |
| ---------------------------- | -------------------------------------------------------------------- |
| Coordination API down (Twin) | Scene stays usable; `loadError` reports `missionCoordination`; no coordination markers |
| Coordination API down (UI)   | Panel/page show an error state; no fabricated recommendations        |
| Empty fleet                  | Status `NO_ROBOTS`                                                    |
| No active tasks              | Status `NO_TASKS`                                                     |
| Missing drain coordinates    | Status `NO_COORDINATES`; task reason `NO_COORDINATES`                 |
| All eligible robots committed| Task reason `ALL_ROBOTS_BUSY`                                         |
| Missing battery/location     | Robot ineligible / `INSUFFICIENT_DATA`; never a fabricated value      |
| Existing mission needs swap  | Reported under `reassignment_required` with a recommended replacement; never silently overwritten |

---

## 14. Tests

- `server/tests/missionCoordinatorService.test.js` — 26 unit/integration tests (priority &
  candidate formulas, route modes, availability, assignment, conflicts, reassignment,
  summary, analytics, signature-guarded emission).
- `server/tests/missionCoordination.test.js` — 10 REST API tests for
  `/api/missions/coordination` (including auth + mode validation on `POST /plan`).
- Run the full backend suite (from `server/`): `npm test`
  (`node --test --test-concurrency=1 "tests/*.test.js"`).

---

## 15. Non-goals / limitations

- The layer does **not** replace `missionEngine.js`; advisory mode never dispatches and
  autonomous mode dispatches only through it. The movement loop is untouched.
- It does **not** require the sensor intelligence signal ([sensor-intelligence.md](sensor-intelligence.md));
  the optional additive `sensor_quality` block is simply absent when no decision context
  exists and the remaining weights renormalize honestly.
- Distances / times / battery costs are **coordinate-space** estimates derived from the
  existing movement-loop constants, not road-network measurements.
- Plans are recomputed from live state on each request/loop tick; advisory plans are not
  persisted. Autonomous dispatches create real `missions` rows via `missionEngine`.
