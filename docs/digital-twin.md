# Interactive 3D Digital Twin

> Additive, **read-only** 3D visualization layer for AI-DrainOS.
> It renders the *existing* system state (drains, sensors, robots,
> charging stations, planner routes, AI decisions) in one interactive
> `three.js` scene. It never writes to the database, never starts a
> second Socket.IO connection, and never adds a second movement loop.

---

## 1. Purpose

The dashboard already answers *"what is happening?"* for each system in
isolation. The Digital Twin answers *"where is everything, right now, and
how urgent is it?"* in a single glanceable 3D view:

- Every drain as a color-coded manhole with a **flood-risk ring** and a
  separate **AI-decision bar** (two independent indicators).
- Live sensor nodes with real water levels (clamped 0–100).
- Robots (status color + battery bar) and charging stations.
- Planner route lines (direct = blue, charging-stop = amber) with clickable
  waypoints.
- Click-to-inspect details that lazy-load per-drain risk / forecast /
  maintenance / decision / vision from the existing prediction APIs.

It appears in two places:

1. **Dashboard** — compact live preview (`DigitalTwinPreview.jsx`) with an
   "Open full 3D view" button.
2. **Digital Twin page** — full page (`DigitalTwinPage.jsx`) with header
   stats (Requirement #14), toolbar, scene, legend, details panel and a
   non-3D data-list fallback (Requirement #17).

---

## 2. Architecture

```
React UI
 ├─ DigitalTwinPage / DigitalTwinPreview
 │    ├─ useReducer(digitalTwinReducer)          // pure, unit-tested
 │    ├─ digitalTwinService.js                   // REST aggregation (read-only)
 │    │    └─ GET /api/drains, /api/sensors, /api/robots,
 │    │       /api/charging-stations,
 │    │       /api/dashboard/robot-routes,
 │    │       /api/dashboard/decisions
 │    │    └─ lazy per-drain detail (on click)
 │    │         GET /api/predictions/risk|forecast|maintenance|decision|vision/:id
 │    └─ DigitalTwin.jsx (three.js scene, memoized per-entity meshes)
 │         fused view-model via digitalTwinUtils.mjs `fuseDrains`
 └─ socket.js (existing single Socket.IO connection)
      └─ sensorUpdate, floodRiskUpdate, forecastUpdate, maintenanceUpdate,
         visionInspectionUpdate, decisionUpdate, robotRouteUpdate,
         dashboardUpdate  →  digitalTwinReducer
```

Key files:

| File | Role |
| --- | --- |
| `client/src/services/digitalTwinUtils.mjs` | Pure, side-effect-free ESM: level banding, clamping, coordinate conversion, entity normalization, route geometry, metrics, and the immutable reducer for every live event. Shared by the browser *and* the Node test suite. |
| `client/src/services/digitalTwinService.js` | Browser data layer. Loads and normalizes the six datasets with `Promise.allSettled` so one failing endpoint never breaks the scene; lazy per-drain details. |
| `client/src/components/DigitalTwin.jsx` | The `@react-three/fiber` scene: environment, camera rig, memoized mesh components per entity. |
| `client/src/components/DigitalTwinPage.jsx` | Requirement #14 page layout + toolbar + socket wiring + details + fallback table. |
| `client/src/components/DigitalTwinPreview.jsx` | Compact dashboard preview (same service, same reducer, no second connection). |
| `client/src/components/DigitalTwinLegend.jsx` | Shares the exact same palette constants as the scene (`LEVEL_COLOR`, `STATUS_COLOR`). |
| `client/src/styles/digitaltwin.css` | DT page/legend/table styles incl. mobile breakpoints (Requirement #18). |
| `server/tests/digitalTwin.test.js` | 25 Node tests (pure utils + reducer + read-only API shape checks). |

---

## 3. Data flow & honesty contract

1. On mount, `digitalTwinService.loadDigitalTwinData()` fires six GETs in
   parallel (`Promise.allSettled`). Whatever succeeds is normalized; whatever
   fails contributes to `loadError` and is shown as a warning banner —
   **never** a crash.
2. Normalization uses `safeWaterLevel` (clamps 0–100, returns `null` for
   missing/non-numeric → "Data unavailable").
3. Levels follow the same banding as the existing engines
   (`moderate ≥ 25`, `high ≥ 50`, `critical ≥ 75`) via `levelFromScore`.
4. **Flood risk and AI decision are kept completely separate** in the scene
   (ground ring vs. standing bar) and in the details panel. They are never
   averaged or merged.
5. Live Socket.IO events are folded in through the pure
   `digitalTwinReducer` (`SET_DATA`, `SENSOR_UPDATE`, `RISK_UPDATE`,
   `FORECAST_UPDATE`, `MAINTENANCE_UPDATE`, `VISION_UPDATE`,
   `DECISION_UPDATE`, `ROUTE_UPDATE`, `DASHBOARD_UPDATE`) — the same reducer
   is exercised by the test suite.
6. Sensor → drain association comes from zone + location matching because
   `/api/sensors` intentionally does not expose `drain_id` or coordinates;
   unmatched sensors are honestly reported as unassigned. Where a real
   reading exists it is mapped onto the drain's water fill; where none
   exists the fill is not raised.

### DRY / single-source of truth

- One shared socket (`client/src/services/socket.js`) — the page and the
  preview subscribe/unsubscribe to existing events only.
- One palette (`digitalTwinUtils.mjs`) — the legend literally imports the
  same color constants the meshes use, so they cannot drift.
- One reducer — same code paths are unit-tested in Node, so every live
  event has a proven pure behavior.

---

## 4. Coordinate contract (IMPORTANT)

The 3D scene uses a **visualization space**, not survey-grade GIS:

```
origin = midpoint of the bounding box of all loaded lat/lng points
X      = (lng − origin.lng) × 1000      // local units east
Z      = (lat − origin.lat) × 1000      // local units north
Y      = reserved for elevation (water fill, labels, bars)
MAX_WATER_HEIGHT = 1.1 local units      // maps a 100% water level
```

- Deterministic: identical inputs always produce identical layouts.
- Centered near the scene origin for a comfortable camera view.
- Deliberately **not** real-world meters; the canvas bottom-right corner
  always labels the scene "Visualization coords (not survey-grade GIS)".
- Points with missing/invalid coordinates are skipped rather than guessed.

---

## 5. Visualizations

| Visual | Meaning |
| --- | --- |
| Manhole ring color | Drain status (Normal green / Warning amber / Critical red). |
| Blue fill inside manhole | Real clamped water level from sensors/live events. |
| Flat colored ring on ground | Flood-risk level (Low/Moderate/High/Critical palette). |
| Standing colored bar (+1-axis) | AI-decision priority level — separate from the risk ring. |
| Octahedron node | Sensor node (cyan; red at ≥75% water or Warning/Critical). |
| Robot body color + battery bar | Robot status and charge (green/amber/red battery). |
| Amber pillar + beacon | Charging station. |
| Blue / amber polyline | Planner route — direct / charging-stop — with clickable waypoint spheres. |
| Yellow halo rings | Selected object highlight. |

Legend: `DigitalTwinLegend.jsx` renders level + object swatches from the
same constants (see §3 DRY).

---

## 6. Interaction

- **Rotate / zoom / pan**: OrbitControls with damping, clamped polar angle.
- **Click any object** → selects it, highlights it, shows the details panel;
  for drains this lazy-loads the five per-drain prediction endpoints.
- **Toolbar**:
  - Search — filters the scene by drain location/zone/name, robot name/zone,
    sensor/station name (and the non-3D table).
  - Focus chips — `All`, `Critical drains` (only critical drains + their
    routes), `Robots` (robots + stations + drains context).
  - Camera buttons — `Overview`, `Top`, `Reset`.
- Requirements: #14 layout on the page; #17 non-3D data-list fallback table
  (click to select, keyboard accessible with `Enter`); #18 responsive
  mobile canvas heights + touch controls.

---

## 7. Live events consumed (existing!)

| Event | Reducer action | Scene effect |
| --- | --- | --- |
| `sensorUpdate` | `SENSOR_UPDATE` | updates drain water fill + risk/forecast/maintenance/decision fields per drain |
| `floodRiskUpdate` | `RISK_UPDATE` | risk ring color/height |
| `forecastUpdate` | `FORECAST_UPDATE` | forecast badge in details + panel |
| `maintenanceUpdate` | `MAINTENANCE_UPDATE` | maintenance badge + recommendation |
| `visionInspectionUpdate` | `VISION_UPDATE` | vision badge + recommendation |
| `decisionUpdate` | `DECISION_UPDATE` | AI-decision bar |
| `robotRouteUpdate` | `ROUTE_UPDATE` | replaces the route line/waypoints for that drain |
| `dashboardUpdate` | `DASHBOARD_UPDATE` | header stats refresh |

No new server events were added; the backend never knew this feature exists.

---

## 8. Performance notes

- Each entity is a `React.memo` component keyed on **primitive** props —
  a live event only re-renders the affected mesh, not the whole scene.
- `fuseDrains` runs in a `useMemo` keyed on the actual arrays.
- Stable `EMPTY_ARRAY` / `EMPTY_OBJECT` references avoid memo-invalidation
  while datasets are still loading.
- The scene canvas uses `dpr={[1, 1.75]}`, a cap on cameras and no second
  render loop; rAF-driven damping is idle-cost.

---

## 9. Tests

`server/tests/digitalTwin.test.js` (25 tests, `npm test` in `server/`):

- `safeWaterLevel` clamping and honesty on bad input.
- `levelFromScore` boundaries (25/50/75) and `normalizeLevel`.
- `computeOrigin` midpoint / null-safety, `latLngToLocal` determinism,
  `waterLevelToHeight` mapping.
- `normalizeDrain`, `matchSensorsToDrains`, `buildRouteGeometry`,
  `normalizeRoute`, `buildMetrics`, `fuseDrains`.
- Every reducer action (`SET_DATA`, `SENSOR_UPDATE`, `RISK_UPDATE`,
  `FORECAST_UPDATE`, `MAINTENANCE_UPDATE`, `VISION_UPDATE`,
  `DECISION_UPDATE`, `ROUTE_UPDATE`, `DASHBOARD_UPDATE`, unknown → no-op).
- Read-only API shape checks for all six consumed endpoints, including the
  decisions↔`levelFromScore` banding consistency assertion.

---

## 10. Known limitations

- **Visualization coordinates** — see §4; not survey-grade GIS.
- **Sensor → drain matching by zone+location** — the sensor endpoint has no
  `drain_id`/coordinates; identical zone+location pairs in overlapping zones
  could alias (the implementation prefers the first matching drain).
- **Static scene positions** — drains/stations/spawn robots are rendered at
  their last known coordinates; robot movement between REST refresh cycles
  is reflected only when live events are received (this feature adds no
  movement loop by design).
- **Lazy per-drain details** — fetched once on selection; a manual refresh is
  not offered on the details panel (live events still update the scene).

---

## 11. In scope / out of scope

| In scope | Out of scope |
| --- | --- |
| New client components, service, styles, tests, docs | Backend route/service changes |
| Navigation + compact dashboard preview | New Socket.IO server or events |
| Read-only aggregation of existing APIs | New database tables/migrations |
| Live rendering via the existing socket | Any write/dispatch/mission automation |