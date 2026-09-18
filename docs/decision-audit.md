# 🧾 Explainable AI + Decision Audit (Update #24)

The decision audit layer (`server/services/decisionAuditService.js`) records an
**append-only, read-only trail** of what the existing engines decided and *why* — as a
restatement of the **current** system state, never a recomputation. It snapshots ten
decision types (flood risk, forecast, maintenance, decision, sensor intelligence, weather
correlation, robot route, mission coordination, fleet optimization, incidents) into the new
`decision_audits` table, dedupes repeated snapshots to meaningful changes, and exposes the
trail through a bounded `/api/audit` REST surface, a live `decisionAuditUpdate` socket
event, additive dashboard/analytics blocks, a Digital Twin overlay, and a frontend
Explainable AI panel + page.

It obeys four hard rules:

1. **It only restates, never recomputes.** `inputs`, `contributions`, `modifiers`,
   `evidence` and `explanation` are copied from the **existing** engine outputs (field
   names normalized, scores rounded to 1 decimal, correlations to 3 decimals). The audit
   layer has no scoring formulas of its own — it never changes `decisionEngine.WEIGHTS`,
   the flood-risk/forecast/maintenance/sensor/weather/mission formulas, or
   `server/services/missionEngine.js`.
2. **It reports honest unavailability.** Missing history is `INSUFFICIENT_DATA` /
   `NO_DATA` / `NO_COORDINATES` with `null` values — never zeros. `Number(null) = 0` is
   explicitly guarded (`finiteNumber` / `round1` / `round3` return `null` for
   `null` / `undefined` / `""`).
3. **Storage is append-only and bounded.** The `decision_audits` table is protected by an
   SQL trigger that **blocks `UPDATE` and `DELETE`** on any single row. Every read is a
   bounded, parameterized query (default page size 20, hard cap **100**). Retention — a
   documented operations decision — removes *whole* audit rows via a maintenance run; a
   single record is never silently rewritten.
4. **It never dispatches and never claims cause.** The layer never dispatches robots,
   never opens incidents and never mutates missions (mission snapshots re-read
   `buildCoordinationPlan()`, exactly like `GET /api/missions/coordination`). Wording in
   evidence/explanation is descriptive ("recorded window shows", "coincided with") and
   never causal.

📄 Related docs: [decision-engine.md](decision-engine.md) ·
[flood-risk.md](flood-risk.md) · [forecasting.md](forecasting.md) ·
[mission-coordination.md](mission-coordination.md) · [fleet-optimization.md](fleet-optimization.md) ·
[sensor-intelligence.md](sensor-intelligence.md) ·
[weather-flood-correlation.md](weather-flood-correlation.md) ·
[incidents.md](incidents.md) · [digital-twin.md](digital-twin.md) · [api.md](api.md) ·
[database.md](database.md)

---

## 1. Snapshot shape

Every audit record is a normalized `snapshot`:

| Field          | Meaning                                                                 |
| -------------- | ----------------------------------------------------------------------- |
| `decisionId`   | Stable id derived from the caller's scope (e.g. `decision-<drainId>-<ts>`, `mission-coordination`, `incident-<id>`) |
| `entityType`   | `DRAIN` \| `ROBOT` \| `SENSOR` \| `SIGNAL` \| `INCIDENT` \| `SYSTEM`    |
| `entityId`     | Id of the entity (drain id, robot id, …)                                |
| `drainId`      | Drain id when relevant, else `null`                                     |
| `robotId`      | Robot id when relevant, else `null`                                     |
| `timestamp`    | `decision-*`/`incident-*` rows use the decision time; system rows use `generated_at` / `now` |
| `decisionType` | One of the 10 types (see §2)                                             |
| `status`       | `READY` \| `INSUFFICIENT_DATA` \| `NO_DATA` \| `NO_COORDINATES` \| … (honest) |
| `level`        | Risk/priority level from the existing engine, else `null`              |
| `score`        | Score rounded to 1 decimal from the existing engine, else `null`       |
| `inputs`       | Real input payload the engine consumed                                  |
| `contributions`| Contribution/priority breakdown or correlation strength                 |
| `modifiers`    | Policy/time/battery modifiers, or `[]` where the engine has none       |
| `evidence`     | Human-readable restated facts (real numbers only)                       |
| `explanation`  | Fixed `WHY / WHAT / MISSING / HOW / EVIDENCE / LIMITATIONS` structure  |
| `limitations`  | Honest limits of the driving engine (e.g. forecast horizon, reading counts) |
| `signature`    | sha-256 over the canonicalized `{decisionType, status, level, score(1dp), details}` |
| `recorded`/`reason` | Dedup outcome: `RECORDED` \| `NOT_MATERIAL` \| `UNCHANGED`        |

Explanations always use the fixed structure **`WHY / WHAT / MISSING / HOW / EVIDENCE /
LIMITATIONS`** — every section is always present, and `MISSING`/`LIMITATIONS` truthfully
state what the engine could not know.

## 2. Decision types and snapshot sources

`DECISION_TYPES` (`server/services/decisionAuditService.js:39`):

| `decisionType`        | Entity type         | Snapshot source (= restated engine output)                                  |
| --------------------- | ------------------- | --------------------------------------------------------------------------- |
| `AI_DECISION`         | `DRAIN`             | `/api/predictions/decision/:drainId` (priority score/level, recommended action, reasons, factors, robot) |
| `FLOOD_RISK`          | `DRAIN`             | flood risk summary (score, level, trend, water threshold, zone)             |
| `FORECAST`            | `DRAIN`             | 60-min forecast (worst level/score/trend, horizon projections; needs ≥ 2 historical readings else `insufficient_history`) |
| `MAINTENANCE`         | `DRAIN`             | maintenance summary (score, level, blockage risk, recommendation, reasons)  |
| `SENSOR_INTELLIGENCE` | `SENSOR`/`DRAIN`    | sensor intelligence summary (health, anomaly signals, generator)            |
| `WEATHER_CORRELATION` | `SIGNAL`            | weather correlation summary (descriptive, `NOT_AVAILABLE` where history is not persisted) |
| `ROBOT_ROUTE`         | `ROBOT`/`DRAIN`     | robot route plan (selected robot, route type, distance/time/battery, reasons)|
| `MISSION_COORDINATION`| `SYSTEM`            | `missionCoordinatorService.buildCoordinationPlan()` — the same read every `GET /api/missions/coordination` serves; **never** `applyAutonomousPlan` |
| `FLEET_OPTIMIZATION`  | `SYSTEM`            | fleet optimization summary (tasks, recommendations, robots, unassigned, status) |
| `INCIDENT`            | `INCIDENT`          | incident record (severity, status, decision score/level, source, route status) |

`ENTITY_TYPES = DRAIN, ROBOT, SYSTEM, SENSOR, INCIDENT, SIGNAL`.

## 3. Dedup semantics (meaningful changes only)

`storeAudit(snapshot)` compares against the **latest** row for the same
`(decision_type, entity_type, entity_id)` using a sha-256 signature over
`{decisionType, status, level, score(1 decimal), details}`:

- **`UNCHANGED`** — identical signature (byte-for-byte policy detail), or the latest row is
  brand new. Skipped, not stored, not emitted.
- **`NOT_MATERIAL`** — signature differs but nothing material changed: same `status` and
  `level`, and `|score − last.score| < 3` (matches the decision engine's own `≥ 3`
  emission tolerance). A reasoning bump alone is not a new audit row.
- **`RECORDED`** — material change (new status/level, or score moved ≥ 3, or policy detail
  changed). Inserted chronologically (by signature, not wall-clock) as the new latest row.

`POST /api/audit/snapshot` reports the exact outcome (201 on `RECORDED`, 200 on
`UNCHANGED`/`NOT_MATERIAL`).

## 4. Live emission (throttled + signature guarded)

Wired into the live 5-second loop (§ `decision-audit` in `server/index.js`):

- At most every **30 s** over at most the top **5 READY drains** (`LIVE_EVALUATE_INTERVAL_MS`,
  `MAX_LIVE_DRAINS`).
- `decisionAuditUpdate` is emitted at most every **60 s** and **only when meaningful rows
  were actually recorded** (`recorded > 0`); a reset to unchanged state never emits. The emit
  is signature-guarded so only a changed trail touches the socket.
- Payload: `{ status, generated_at, counts: { total, byDecisionType, byLevel }, recorded,
  checked, recent_changes, dwell }`. Shared `socketHub`, no second Socket.IO server.

## 5. REST API (`server/routes/decisionAudit.js`)

| Route                                  | Method | Access          | Purpose                                          |
| -------------------------------------- | ------ | --------------- | ------------------------------------------------ |
| `/api/audit`                           | GET    | Public          | Paged trail (`?page=`, `?limit=` ≤ 100, `?decisionType=`, `?drainId=`, `?robotId=`) |
| `/api/audit/summary`                   | GET    | Public          | Total / level & type distribution / oldest-newest |
| `/api/audit/recent`                    | GET    | Public          | Latest ≤ `?limit=` (default 10) rows             |
| `/api/audit/drain/:drainId`            | GET    | Public          | Trail for one drain                              |
| `/api/audit/robot/:robotId`            | GET    | Public          | Trail for one robot                              |
| `/api/audit/type/:decisionType`        | GET    | Public          | Trail for one decision type                      |
| `/api/audit/decision/:decisionId`      | GET    | Public          | Lookup by `decisionId` (404 if missing)          |
| `/api/audit/:id`                       | GET    | Public          | Single audit row                                 |
| `/api/audit/:id/explanation`           | GET    | Public          | Rendered `WHY/WHAT/MISSING/HOW/EVIDENCE/LIMITATIONS` explanation |
| `/api/audit/snapshot`                  | POST   | Bearer token    | On-demand snapshot of the **current** state of an existing engine (only write path; never dispatches). `201` = `RECORDED`, `200` = deduped, `422` = engine returned no data for that scope |

Invalid `decisionType` → `400 {"error":"Invalid decision type"}`; malformed ids →
`400`; unknown decisionId/audit id → `404`.

## 6. Additive upstream surfaces

- **Dashboard** (`GET /api/dashboard`) adds a top-level `decisionAudit` object:
  `{ status, total, byLevel, byDecisionType, recentChanges: [≤5 rows], generatedAt }`
  (`NO_AUDIT_DATA` until the first audit exists — never a fabricated summary).
- **Analytics** (`GET /api/analytics`) adds `audit_summary` (`total`, `oldest`, `newest`,
  `generated_at`), `audit_decision_counts`, `audit_level_counts`, `audit_recent_changes`
  (≤5 rows) and `audit_retention` (the append-only retention note). Existing fields are
  byte-for-byte unchanged.
- **Digital Twin**: `digitalTwinUtils.mjs` normalizes audit rows
  (`normalizeDecisionAudit`), handles the `DECISION_AUDIT_UPDATE` reducer event (only when
  `payload.recorded`), and `digitalTwinService.js` supplies `/api/audit/recent` as a
  read-only dataset with audit metrics.

## 7. Frontend

- `DecisionAuditPanel` (dashboard): live summary counts (total / by level / by type) from
  the additive `decisionAudit` block + `decisionAuditUpdate`.
- `DecisionAuditPage` (`#/decisionaudit`): paged trail with `decisionType`, drain and robot
  filters, the 10-type mirror `DECISION_TYPE_OPTIONS`, and an explanation drawer per row.
- App-level socket toast fires only when `payload.recorded` (>0 meaningful changes).

## 8. Tests

`server/tests/decisionAuditService.test.js` (18) + `server/tests/decisionAudit.test.js`
(20) + 2 Digital Twin reducer tests cover: snapshot builders for all 10 types (including
honest `INSUFFICIENT_DATA`/`NO_DATA`/`insufficient_history`), the null-not-zero guard,
append-only trigger rejection, dedup `UNCHANGED`/`NOT_MATERIAL`/`RECORDED`, chronological
latest-row ordering, the signature, live-loop throttling + emit-on-record-only, summary /
dashboard / analytics shapes, the full `/api/audit` REST surface incl. auth on
`POST /snapshot`, the no-side-effect contract (incident/mission deltas stay 0), and
frontend build/lint cleanliness. Full suite: **535/535** (`cd server && node --test
--test-concurrency=1 "tests/*.test.js"`).

## 9. Non-goals / limitations

- **No realtime "live decision stream"** of every recompute — the system snapshots on
  meaningful change, not per reading tick (matching every other engine's dedupe).
- **No retention rewriting** — expiring old records removes whole rows only; there is no
  edit/soft-delete of a single decision.
- **Explanation quality is bounded by the engine** — the audit can only restate what the
  engine already outputs; it cannot add facts the engine never observed.
- **Correlation under accuracy** — for signals whose history is not persisted in this
  system, the audit records the engine's honest `NOT_AVAILABLE`.