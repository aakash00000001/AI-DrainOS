# 🛡️ Operator Action Audit Trail (Update #27)

The operator audit layer (`server/services/operatorAuditService.js`) records an
**append-only, read-only trail of human operator actions**: *WHO did WHAT, when, and what
changed*. Unlike the [decision audit](decision-audit.md) (which restates what the **AI
engines** decided), this trail captures **actual operator mutations** through the protected
endpoints — the request, the acting user, the route/method/status, and the **before/after**
state.

Recording is done by a **non-fatal** `auditMutation` middleware (`server/middleware/
auditMutation.js`). Persistence happens after the response finishes; a failure is logged
and swallowed, so an audit problem can **never** fail the business action that triggered
it.

It obeys five hard rules:

1. **Non-fatal by construction.** The middleware wraps only bookkeeping. Errors are caught,
   logged via `console.log`, and never rethrown into the request/response cycle. The
   business mutation completes regardless.
2. **Needs a human actor.** It only wraps **protected mutation endpoints** (routes already
   behind `authMiddleware`, often `adminOnly` or `mutationLimiter`). GETs, the MQTT/live
   loop, AI-only actions and public surfaces are **never** audited here. The acting user is
   resolved from the authenticated token (id + email), never from request input.
3. **Secrets never hit the disk.** Request/response state is recursively redacted before
   persistence: any key containing `password`, `passwd`, `token`, `authorization`,
   `apikey`, `secret`, `credential`, `jwt` or `cookie` (case-insensitive,
   punctuation-stripped — so `password_hash`, `access_token`, `refresh_token` match) is
   stored as `"[REDACTED]"`. JSON depth is capped at **6** and raw bytes at **80 KB**
   (larger payloads become `{ "truncated": true }`).
4. **Storage is append-only and bounded.** The `operator_audits` table is protected by an
   SQL trigger that **blocks `UPDATE` and `DELETE`** on any row. Every read is a bounded,
   parameterized query (default page size 20, hard cap **100**). There is **no write
   endpoint** — the trail can only grow via real operator actions.
5. **Admin-only reporting.** Every read endpoint requires `authMiddleware` **and**
   `adminOnly`; an Operator role gets `403`, so the trail of administrative actions is only
   visible to administrators.

📄 Related docs: [decision-audit.md](decision-audit.md) · [api.md](api.md) ·
[database.md](database.md) · [workflow.md](workflow.md)

---

## 1. Record shape

Every record maps to one row in `operator_audits`:

| Field        | Meaning                                                       |
| ------------ | ------------------------------------------------------------- |
| `id`         | Primary key                                                   |
| `requestId`  | `req.id` from the app-level `requestLogger` (X-Request-Id, 64 chars) |
| `userId`     | Acting user id (`users.id`), `null` if the user is later deleted (`ON DELETE SET NULL`) |
| `userEmail`  | Acting user email snapshot at record time (120 chars)         |
| `action`     | One of the 19 `ACTIONS` codes (see §2)                        |
| `entityType` | `DRAIN` \| `ALERT` \| `MISSION` \| `INCIDENT` \| `SETTINGS` \| `USER` \| `SYSTEM` |
| `entityId`   | Target entity id (drain/alert/incident/user…), `null` where not applicable |
| `method`     | HTTP method (`POST` / `PUT` / `PATCH` / `DELETE`)             |
| `route`      | Path as sent (e.g. `/api/drains/7`)                           |
| `status`     | HTTP status of the response (a **failed 400/404 attempt is recorded too** — you can see *attempted* actions) |
| `beforeData` | Pre-mutation state (from the DB) or response body when state is not pre-read |
| `afterData`  | Actual response body the client received (captured by a thin `res.json` patch) |
| `metaData`   | Optional action-specific extras (e.g. incident resolution notes) |
| `createdAt`  | Record time                                                       |

The `before`/`after` hooks are awaited before the record is written, so the trail holds
the **final** response state, not a promise. All payloads pass through the redactor from
rule 3.

## 2. Actions and entries

`ACTIONS` (`server/services/operatorAuditService.js:22`) — 19 codes:

| Action                   | Route wiring                               |
| ------------------------ | ------------------------------------------ |
| `DRAIN_CREATE`           | `POST /api/drains`                         |
| `DRAIN_UPDATE`           | `PUT /api/drains/:id`                      |
| `DRAIN_UPDATE_STATUS`    | `PATCH /api/drains/:id/status`             |
| `DRAIN_DELETE`           | `DELETE /api/drains/:id`                   |
| `ALERT_CREATE`           | `POST /api/alerts`                         |
| `ALERT_UPDATE`           | `PUT /api/alerts/:id`                      |
| `MISSION_DISPATCH`       | `POST /api/missions/dispatch`              |
| `INCIDENT_CREATE`        | `POST /api/incidents`                      |
| `INCIDENT_ACKNOWLEDGE`   | `PUT /api/incidents/:id/acknowledge`       |
| `INCIDENT_RESPOND`       | `PUT /api/incidents/:id/respond`           |
| `INCIDENT_RESOLVE`       | `PUT /api/incidents/:id/resolve`           |
| `SETTINGS_UPDATE`        | `PUT /api/settings`                        |
| `MISSION_COORDINATION_PLAN` | `POST /api/missions/coordination/plan`  |
| `USER_CREATE`            | `POST /api/auth/register` (admin)          |
| `USER_UPDATE`            | `PUT /api/auth/users/:id` (admin)          |
| `USER_UPDATE_ROLE`       | `PUT /api/auth/users/:id/role` (admin)     |
| `USER_UPDATE_STATUS`     | `PATCH /api/auth/users/:id/status` (admin) |
| `USER_DELETE`            | `DELETE /api/auth/users/:id` (admin)       |
| `PASSWORD_CHANGE`        | `PUT /api/auth/me/password`                |

Notes:
- **Settings** records the full current settings map as `before_data` and the applied
  response as `after_data`.
- **Incident resolve** passes `{ resolution_notes }` as `meta_data`.
- **Coordination plan** summarizes big array bodies to `{ count }` in `after_data` to keep
  records compact.
- The **auth** entries store the redacted response body (user without password/token) —
  see §4 for the redaction guarantee.

## 3. Non-fatal middleware mechanics

`auditMutation({ action, entityType, entityId?, before?, after?, meta? })` is registered on
each audited route **after** auth/validation middlewares, so user context and validation
errors are respected. On each request it:

1. Patches `res.json` (temporarily) so the final response body can be captured.
2. On `res` `finish`, builds the record — resolving `entityId` (value **or** function of
   `req`), awaiting `before`/`after`/`meta` hooks, redirecting the captured body through
   `redactPayload`, then calling `recordAudit` fire-and-forget.
3. Catches **every** error in that path: `console.log` + swallow.

A `recordAudit` failure therefore never changes the response the operator already
received.

## 4. Redaction guarantees

`redactPayload` / `maskJson` walk objects and arrays recursively (depth ≤ 6, bytes ≤ 80 KB),
replacing any value whose key contains a `SENSITIVE_PARTS` substring with `"[REDACTED]"`.
Test coverage proves that `USER_CREATE`/`PASSWORD_CHANGE` responses — even ones the mock
injects plainly — are stored redacted. The Operator Audit page also applies a **defensive
second redaction** at render time, so even a payload that somehow reached the API unredacted
is never displayed.

## 5. Admin-only REST (`/api/audit/operator`)

Mount order matters — the operator router is registered **before** `/api/audit` so it is
never shadowed by the decision audit `/:id` route. Full contract in [api.md](api.md):

| Endpoint  | Purpose                                                    |
| --------- | ---------------------------------------------------------- |
| `GET /`   | Paginated trail; filters `action`, `entityType`, `entityId`, `userId`; default 20, cap 100 |
| `GET /summary` | `{ total, oldest, newest, byOperator, byAction, byEntityType }` |
| `GET /actions` | The 19 auditable `ACTIONS` codes                       |
| `GET /:id` | Single record, `404` when absent                           |

All require authentication (`Bearer <token>`) plus the `adminOnly` role gate, so an
Operator receives `403`. There is no `POST` — the trail is write-once through the
middleware only.

## 6. Frontend

The admin **Operator Audit** page (`client/src/components/OperatorAuditPage.jsx`,
nav item `operatoraudit` in `Sidebar.jsx`, admin-gated) shows summary cards (total,
oldest/newest, top operators), a filter bar (action / entity type / entity id), a 20-row
paginated table, and expandable rows revealing request id, route, and the
**Before / After / Metadata** JSON — with the render-time `[REDACTED]` guard from §4.
Non-admin roles receive the same "Access Denied" guard used by the other admin pages.

## 7. Testing

- `server/tests/operatorAuditService.test.js` — record/read, redaction, depth/byte caps,
  `toIntOrNull` coercion, append-only trigger.
- `server/tests/operatorAudit.test.js` — full `/api/audit/operator` REST surface: auth
  `401`, admin `403`, validations, filters, pagination, summary, actions, `/:id`, `404`.
- `server/tests/auditMutation.test.js` — end-to-end: a stub service failure is swallowed
  (request still succeeds), GETs write nothing, rejected 400 attempts **are** recorded,
  drain update captures before/after, `USER_CREATE` stores no plaintext password.
- Client: `client/src/services/operatorAuditService.test.js`,
  `client/src/components/OperatorAuditPage.test.jsx`, sidebar nav tests in
  `client/src/components/layout/Sidebar.test.jsx`.

## 8. Honest limitations

- **Scope is additive, not universal.** Only the routes in §2 are audited today; adding a
  route to the trail is a one-line middleware registration. IoT/MQTT-derived actions and
  AI engine outputs are intentionally *not* in this table (see the decision audit for the
  AI-side trail).
- **Non-fatal means eventually-consistent.** The record is written asynchronously after the
  response; if the audit write fails, only the log (and the operator's absence from the
  trail) shows it. This is a deliberate availability-over-durability trade.
- **Payload depth/byte caps** truncate deeply-nested or very large bodies to
  `{ "truncated": true }` rather than expanding storage.
- **`before_data` fidelity** depends on what the route can read. Drains/incidents/users
  pre-read their current row; settings pre-read the full settings map. Where no clean
  pre-read exists the before snapshot is the request body itself.