# Historical Intelligence — Frontend UI

> **Status:** UPDATE #26 — full Historical Intelligence UI (read-only, additive).
> Backend analytics foundation shipped in UPDATE #20A is described in
> [docs/historical-intelligence.md](historical-intelligence.md). This document
> covers the frontend: the dedicated **Historical Intelligence** page, the
> dashboard/analytics integrations, the service layer, the frontend test suite
> and the honesty contract.

The Historical Intelligence UI turns the read-only `/api/historical` analytics
into an operator-facing view of **what the recorded history actually shows** —
never a prediction, never fabricated data. Every value rendered comes from the
backend's `null`-or-`INSUFFICIENT_DATA` contract.

---

## 1. Where it lives

- **Navigation:** a "Historical Intelligence" item in the sidebar (below
  Analytics) routes to the dedicated page.
- **Dashboard:** a compact `HistoricalIntelligencePanel` preview card renders
  the additive `/api/dashboard` `historicalSummary`.
- **Analytics page:** a `HistoricalIntelligenceAnalyticsSection` renders the
  full `GET /api/analytics/historical` overview.

All three are additive: existing pages, panels and socket wiring are untouched.

---

## 2. Components

| Component | Surfaces | Data source |
| --- | --- | --- |
| `HistoricalIntelligencePage.jsx` | Dedicated page | `/api/historical` (all sections) + `/api/drains` (filter) |
| `HistoricalIntelligencePanel.jsx` | Dashboard card | `GET /api/dashboard` → `historicalSummary` |
| `HistoricalIntelligenceAnalyticsSection.jsx` | Analytics page | `GET /api/analytics/historical` |

### 2.1 Page layout (`HistoricalIntelligencePage.jsx`)

- **Controls:** a period selector (`24h / 7d / 30d / 90d`, default `30d`), a
  drain filter (`All drains` + every drain from the real `/api/drains` list), a
  **Refresh** button and a live status badge (`OK` / `PARTIAL` / `SPARSE` /
  `INSUFFICIENT_DATA`).
- **Overview strip:** record count, sensor count, incident/mission/alert counts,
  degraded/critical drain counts and data-quality label.
- **Cards:** Sensor History (per-sensor avg/min/max/trend), Drain Historical
  Health (descriptive label + reasons + live current status kept separate),
  Incident History (severity/source/daily buckets + real timing averages),
  Mission History (completion rate, per-robot counts, average duration),
  Robot Response History (counts, average mission duration; response time is
  honestly `null` — the schema has no response timestamp),
  Alert History (severity/type buckets), Time Patterns (hourly/weekday CSS
  distribution bars, peaks only when the sample is large enough).
- **Period Comparison:** CURRENT vs HISTORICAL vs CHANGE kept as separate,
  labelled columns — never merged into a single score.
- **Data Quality:** the backend `data_quality` block (label, record count,
  coverage ratio, missing signals, tables used) plus the non-causal disclaimer.

### 2.2 Honest states

- **Loading:** initial spinner — never a blank screen.
- **Error:** friendly banner with the real message and a **Retry**.
- **`INSUFFICIENT_DATA`** (or `SPARSE`): an explicit "not enough recorded data"
  banner on the affected card/section — the page never shows zeros, averages or
  trends for a window with no records.
- **`null` values** (e.g. response-time averages) are rendered as `"—"`.

---

## 3. Service layer (`client/src/services/historicalIntelligenceService.js`)

Single axios consumer with `HISTORICAL_PERIODS` / `HISTORICAL_DEFAULT_PERIOD`
constants. Every function builds `?period=` (and `?drainId=` when provided) and
maps onto the documented endpoints:

`getHistoricalOverview` (`/api/historical`), `getHistoricalSummary`
(`/summary`), `getHistoricalSensorHistory` (`/sensors`),
`getHistoricalTrends` (`/trends`), `getHistoricalDrains` (`/drains`),
`getHistoricalIncidents` (`/incidents`), `getHistoricalMissions`
(`/missions`), `getHistoricalRobots` (`/robots`), `getHistoricalAlerts`
(`/alerts`), `getHistoricalPatterns` (`/patterns`),
`getHistoricalComparison` (`/comparison`), `getHistoricalAnalytics`
(`${API_URL}/analytics/historical`), `getDrainList` (`/api/drains`) and
`getDashboardHistoricalSummary` (`/dashboard` → `historicalSummary`).

---

## 4. Styling

`client/src/styles/historicalIntelligence.css` — `hi-` prefixed classes scoped
to the page/panels (page/panel, controls, stat strip, cards, tables, pills,
distribution bars, comparison grid). No global styles are touched.

---

## 5. Frontend tests

Vitest + jsdom + Testing Library (see `client/vitest.config.js` and
`client/src/test/setup.js`). Run with `cd client && npm test` (32 tests):

- `historicalIntelligenceService.test.js` — URL + params for every endpoint.
- `HistoricalIntelligencePage.test.jsx` — loading, error, `INSUFFICIENT_DATA`
  + empty data, period change refetch, drain filter, drain options, comparison
  render, Refresh reload.
- `HistoricalIntelligencePanel.test.jsx` — summary render, insufficient + error
  states, "Historical Console" navigation callback.
- `HistoricalIntelligenceAnalyticsSection.test.jsx` — overview render, period
  refetch, link navigation, insufficient + error states.
- `layout/Sidebar.test.jsx` — navigation + active state for the new item.

`client/src/test/setup.js` imports `@testing-library/jest-dom/vitest` and calls
`cleanup()` after each test (vitest runs with `globals: false`).

---

## 6. Digital Twin

The Digital Twin page is **intentionally not** extended with historical data:
it renders a complex live 3D scene driven by a shared pure reducer over live
REST + Socket.IO state, with no additive slot for a windowed analytics view, and
historical values have no meaningful 3D mapping (they are aggregate statistics,
not per-object live state). Keeping the Historical Intelligence UI as a dedicated
page + dashboard/analytics cards avoids modifying the 3D scene's reducer and
rendering path. Deferred; can be revisited if a historical entity overlay is
ever wanted.

---

## 7. Limitations

- **Read-only, poll-driven.** The page loads on mount / period / drain change /
  Refresh; the backend `historicalIntelligenceUpdate` socket emission remains
  unwired to the live loop (see the backend doc) so there is no live push.
- **No fake data.** A window with no records shows the honest
  `INSUFFICIENT_DATA` state, never fabricated averages or counts.
- **No predictions.** The time-pattern charts and health labels are descriptive
  only; wording is non-causal.