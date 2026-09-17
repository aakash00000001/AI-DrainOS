# AI-DrainOS Robot Path Planning & Route Optimization

**Status**: implemented as an on-demand, deterministic computation layer. It does **not**
write to the database, does **not** replace `missionEngine.js`, and does **not** change the
existing robot movement loop or battery-drain logic in `index.js`. Robot selection and route
planning are **recommendations/visualisations** — `missionEngine.js` remains the only
authority that creates missions.

## 1. What it does

For a high/critical-priority drain the **Robot Path Planning Service**
(`server/services/robotPathPlanningService.js`) answers three operational questions:

1. *Which robot should go?* — explainable scoring across availability, distance, battery
   and battery sufficiency.
2. *Can it get there on the current battery?* — battery-aware planning that inserts a
   charging stop when the direct route is not feasible.
3. *What does the route look like?* — ordered waypoints (`START → TARGET` or
   `START → CHARGING_STATION → TARGET`) with cumulative distance, time and battery cost.

Everything is coordinate-space only: **no external routing API, no fake GPS routing**.

## 2. Movement-loop assumptions (single source of truth)

The planner reuses the constants of the real robot movement loop in `server/index.js`
rather than inventing its own:

| Constant | Value | Meaning |
| --- | --- | --- |
| `MOVEMENT_STEP` | `0.00005` | coordinate units moved per tick |
| `TICK_INTERVAL_MS` | `5000` | loop tick (5 s) |
| `BATTERY_DRAIN_PER_TICK` | `1` | battery % lost per tick while Active |
| `SECONDS_PER_UNIT` | `100000` | travel seconds per coordinate unit |
| `BATTERY_PER_UNIT` | `20000` | battery % per coordinate unit |
| `MIN_BATTERY_MISSION` | `20` | minimum battery to be mission-eligible |
| `ARRIVAL_THRESHOLD` | `0.00001` | arrival tolerance (matches `index.js`) |

Distance is the **Euclidean coordinate-space** distance used by `index.js` and
`decisionEngine.js`:

```
distance = sqrt((latA - latB)² + (lngA - lngB)²)
timeSeconds = distance × SECONDS_PER_UNIT
batteryCost = distance × BATTERY_PER_UNIT
```

This is an **approximation**, explicitly documented on every response via `disclaimer`.

## 3. Robot selection (explainable scoring)

A candidate must be:

- `status` not `Charging` and not `Maintenance`, **and**
- **not** holding an `Assigned` mission, **and**
- have valid latitude/longitude, **and**
- the drain must have valid coordinates.

Candidates are scored deterministically:

| Component | Max points | Rule |
| --- | --- | --- |
| Distance | 40 | `max(0, 40 − distance × 10000)` (closer is better) |
| Battery | 30 | `battery_level × 0.3` (higher is better) |
| Battery sufficiency | 20 | `+20` when the robot can reach the target and still hold the mission reserve |
| Tie-break | — | lowest robot `id` |

`selectionReasons` explains the score (distance + travel time, battery, sufficiency) and is
returned with the selection. **Charging robots and robots on active missions are never
selected.**

## 4. Honest states

| Status | When |
| --- | --- |
| `ROBOT_SELECTED` | A robot was scored and chosen. |
| `NO_ROBOT_AVAILABLE` | No eligible robot; `reason` explains why (all charging, all on missions, etc.). |
| `NO_COORDINATES` | The drain has no valid coordinates. |
| `DRAIN_NOT_FOUND` | The drain id does not exist. |

Availability is never fabricated: if no robot can serve the drain the response returns
`NO_ROBOT_AVAILABLE` with a human-readable reason.

## 5. Battery-aware route planning

After selection:

```
hasEnoughBattery = battery_level > (batteryCostToTarget + MIN_BATTERY_MISSION)
```

- **Enough battery** → `DIRECT` route with two waypoints:
  `START → TARGET`.
- **Not enough** → `CHARGING_STOP` route with three waypoints:
  `START → CHARGING_STATION → TARGET`, where the charging station is the nearest one to the
  robot. `needsCharging: true` and the station details are included.

Each waypoint carries:

```json
{
  "label": "START | CHARGING_STATION | TARGET",
  "latitude": 9.925,
  "longitude": 78.12,
  "distanceFromPrevious": 0,
  "cumulativeDistance": 0,
  "cumulativeTravelSeconds": 0,
  "cumulativeBatteryCost": 0
}
```

The route also exposes `totalDistance`, `totalTravelSeconds`, `totalBatteryCost`,
`formatTotalTravelTime` (e.g. `"1 m 30 s"`), `needsCharging` and `chargingStation`.

The existing battery-drain algorithm in `index.js` is **not** modified.

## 6. Real-time `robotRouteUpdate` event

The service emits `robotRouteUpdate` over Socket.IO via the shared `socketHub` (safe no-op
outside a running server) **only on a meaningful change**:

- the selected robot changes, **or**
- the planning status changes, **or**
- the route type changes (`DIRECT` ↔ `CHARGING_STOP`), **or**
- the target drain changes.

The payload is the full planning result. Emission state is keyed per drain.

## 7. Aggregate summaries

`getAllRoutes()` builds a dashboard/analytics view across all drains:

- `Normal` drains are `SKIPPED` (planning not required) to keep the DB load low.
- `Warning` / `Critical` drains are planned and carry robot + route + selection reasons.

## 8. API endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /api/predictions/robot-route/:drainId` | Full plan for one drain (400 invalid id, 404 unknown drain). |
| `GET /api/dashboard/robot-routes` | Planning summary for all drains (Normal skipped). |
| `GET /api/analytics/robot-routes` | Analytics view: planned routes, route-type split, robots selected, average distance/time/battery cost. |

All endpoints follow the existing public predictions model (no auth).

## 9. Frontend

- **`RobotRoutePlanner`** (dashboard, directly after the AI Decision panel; also on the "AI
  Decisions" page): route counts (planned / direct / charging stops), a per-drain table
  (planning status, selected robot, route type, battery, estimated time) and an expandable
  detail card showing selection reasons, route totals and the waypoint list. It refreshes on
  `robotRouteUpdate` live events and every 10 s.
- **`DrainMap`** renders the planned routes as polylines — solid green for `DIRECT`, dashed
  amber for routes via a charging station — additive to the existing robot/charging markers.

## 10. File map

- `server/services/robotPathPlanningService.js` — the service (constants, selection,
  route building, summary, emission throttle).
- `server/routes/predictions.js` — `GET /api/predictions/robot-route/:drainId`.
- `server/routes/dashboard.js` — `GET /api/dashboard/robot-routes`.
- `server/routes/analytics.js` — `GET /api/analytics/robot-routes`.
- `client/src/components/RobotRoutePlanner.jsx` — dashboard panel + dedicated page.
- `client/src/components/DrainMap.jsx` — route polylines.
- `client/src/App.jsx` — mount.
- `server/tests/robotPathPlanning.test.js` — tests.

## 11. Testing

`server/tests/robotPathPlanning.test.js` covers: movement-loop constants, coordinate
distance, time/battery estimation, duration formatting, direct-route construction (and the
zero-distance edge case), invalid-drain handling, candidate discovery (charging / on-mission
exclusion), honest `NO_ROBOT_AVAILABLE`, explainable selection, full route planning (with
waypoint cumulative consistency), active-mission exclusion, a forced `CHARGING_STOP` route,
the aggregate summary (Normal skipped), the three REST endpoints (including 400/404), and the
`robotRouteUpdate` emission throttle.

Run with the full suite: `npm test` (from `server/`).
