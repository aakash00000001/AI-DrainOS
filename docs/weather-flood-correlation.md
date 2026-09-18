# ⛅ Weather + Flood Correlation Intelligence (Update #23)

The weather-flood correlation layer (`server/services/weatherFloodCorrelationService.js`)
answers one descriptive question: **does the recorded weather history co-move with the
recorded sensor water levels?** It aligns real weather observations (`weather_observations`,
fetched − and only ever fetched forward − from the existing OpenWeatherMap integration) with
real sensor readings (`sensor_readings`) inside a **bounded window** and reports a Pearson
correlation for each weather signal — rainfall, humidity, temperature, pressure, wind —
against water level.

It obeys four hard rules:

1. **It never fabricates weather.** Snapshots are stored **as they are fetched**, throttled,
   forward-only. They are never backfilled or seeded. A fresh install honestly reports
   `WEATHER_UNAVAILABLE` until real observations accumulate. `rain_1h` / `rain_3h` are only
   ever `0 mm` ("dry") when the payload reported no rain.
2. **Correlation is descriptive, not causal.** Every result is a Pearson coefficient over
   timestamp-aligned pairs and ships a non-causal disclaimer. No result ever claims that
   weather *caused* a water level.
3. **It is strictly additive.** It never rewrites or replaces the existing flood-risk /
   forecast / maintenance / decision formulas, never touches `missionEngine.js` and never
   dispatches robots. No incidents are ever opened from a correlation.
4. **It reports honest unavailability.** Historical flood-risk and forecast outputs are
   **not persisted** in this system, so `weather_flood_risk` and `weather_forecast` are
   `NOT_AVAILABLE` — never recomputed, never invented.

📄 Related docs: [flood-risk.md](flood-risk.md) · [forecasting.md](forecasting.md) ·
[sensor-intelligence.md](sensor-intelligence.md) · [decision-engine.md](decision-engine.md) ·
[mission-coordination.md](mission-coordination.md) · [digital-twin.md](digital-twin.md) ·
[api.md](api.md) · [database.md](database.md) · [mqtt.md](mqtt.md)

---

## 1. Advisory contract

> Weather-flood correlation is descriptive only. It measures the linear association between
> recorded weather observations and recorded sensor readings and does **not** imply causation
> and never replaces the flood risk, forecast, maintenance or decision engines.

This disclaimer is returned in every response (`disclaimer` field), embedded in the wording
("descriptive association", "coincided with", never "causes") and shown in the UI panels.

---

## 2. Data requirements + honest states

Correlation needs **both** sides of the pair to be real:

- **Weather side** — real rows in `weather_observations`. Each row is a metric-unit
  OpenWeatherMap snapshot (`main`/`description`, `temp`, `humidity`, `pressure`,
  `wind_speed`, `rain_1h`, `rain_3h`, `observed_at`, `source` = `openweathermap` |
  `weather-api`). No weather rows ⇒ every signal is `WEATHER_UNAVAILABLE` and the summary
  message points to the `OPENWEATHER_API_KEY` (the system never invents weather history).
- **Sensor side** — real `sensor_readings` rows (`water_level`, `recorded_at`). A drain
  with no readings contributes no pairs.

Bounded analysis window:

| Constant                 | Value        |
| ------------------------ | ------------ |
| `DEFAULT_WINDOW_HOURS`   | 24 h         |
| `MAX_WINDOW_HOURS`       | 168 h        |
| `MIN_PAIRS`              | 20           |
| `TIME_TOLERANCE_MINUTES` | 30           |
| `LAG_OPTIONS`            | 0, 15, 30, 60 min |

A signal is only reported after **≥ `MIN_PAIRS` aligned pairs**. Fewer pairs (or weather too
old — `TIME_TOLERANCE_MINUTES`, or lag-shifted beyond the window) is `INSUFFICIENT_DATA` with
a real reason in `samples` (`weather_used`, `sensor_used`, `missing_weather`,
`timestamp_alignment`, `window_hours`, `lag_minutes`, `tolerance_minutes`), never an
estimate.

Alignment is **nearest-timestamp** matching (each weather observation aligned to its closest
reading within the tolerance); the pair count is what the human-readable message quotes.

---

## 3. Correlation signals

Seven immutable signal keys are exposed (`SIGNAL_KEYS`). Five are computed from real data;
two are honest `NOT_AVAILABLE` (the underlying history is not persisted):

| Signal                     | Weather metric | Reading metric | Status        |
| -------------------------- | -------------- | -------------- | ------------- |
| `rainfall_water_level`     | Rainfall (mm)  | Water level (%) | `READY` / `INSUFFICIENT_DATA` / `WEATHER_UNAVAILABLE` |
| `humidity_water_level`     | Humidity (%)   | Water level (%) | same |
| `temperature_water_level`  | Temperature (°C) | Water level (%) | same |
| `pressure_water_level`     | Pressure (hPa) | Water level (%) | same |
| `wind_water_level`         | Wind (m/s)     | Water level (%) | same |
| `weather_flood_risk`       | —              | —              | always `NOT_AVAILABLE` (risk scores are not persisted) |
| `weather_forecast`         | —              | —              | always `NOT_AVAILABLE` (forecast outputs are not persisted) |

Each computed result carries:

- `r` (Pearson, rounded to 3 decimals), `direction`, `strength`, `matched_pairs`.
- A **strength band** (`STRENGTH_BANDS`): `VERY_WEAK` ≤ 0.19, `WEAK` 0.20–0.39,
  `MODERATE` 0.40–0.59, `STRONG` 0.60–0.79, `VERY_STRONG` ≥ 0.80.
- A **direction** (`DIRECTION`): `POSITIVE` (r ≥ +0.05), `NEGATIVE` (r ≤ −0.05),
  `NONE` otherwise (two-sided epsilon 0.05).
- Human-readable `wording` built from the real pair count, direction and strength —
  descriptive ("The recorded window shows a MODERATE positive association …") and never
  causal.
- A compact `correlation` object and a `samples` object with the real alignment counts.

---

## 4. Weather refresh (bounded, real, forward-only)

Live weather is refreshed on bounded rules so the running system both keeps growing a *real*
history and never stamps the API:

- A snapshot is fetched only when a "latest observation" is **stale** (older than
  `WEATHER_REFRESH_INTERVAL_MS` = 10 min), guarded by an **in-flight** flag (never two
  concurrent fetches) and by a **staleness check** that runs at most every
  `WEATHER_CHECK_INTERVAL_MS` = 1 min in the hot path.
- Source is the existing OpenWeatherMap client (city = `WEATHER_CITY || "Madurai"`, metric
  units); a payload that fails to parse is logged and skipped — no fabricated snapshot.
- Weather is stored **as it is fetched, forward-only**. There is no backfill, no seed, and
  no per-MQTT-packet correlation (correlation refreshes are guarded by the staleness /
  in-flight / freshness checks above).

---

## 5. Live emission (signature + throttle guarded)

The service emits through the **existing shared** `socketHub` — no second Socket.IO server:

```js
socketHub.emit("weatherFloodCorrelationUpdate", summaryPayload);
```

- Wiring is in the live 5-second loop (`server/index.js`, section 14).
- Emission is **signature-guarded**: a deterministic signature of the summary means the
  event fires only on a meaningful change, never per 5-second tick.
- It is also **throttle-guarded** (`EMIT_MIN_INTERVAL_MS` = 60 s) so even rapid state changes
  cannot flood the socket.
- The MQTT pipeline never emits this event per packet; it only triggers the guarded refresh
  path (`mqttService`, section 8c). No duplicate socket listeners are added.

---

## 6. REST API

Base path: `/api/predictions/weather-correlation` (mounted in `server/app.js` **before**
`/api/predictions` so it is not shadowed). All endpoints are **read-only** and public,
matching the other analytical read endpoints.

| Method | Path                                                           | Description |
| ------ | -------------------------------------------------------------- | ----------- |
| GET    | `/api/predictions/weather-correlation`                         | Full overview: data quality, per-signal results, strongest association, latest weather. `?window=` filter |
| GET    | `/api/predictions/weather-correlation/summary`                 | Compact summary used by the dashboard + analytics |
| GET    | `/api/predictions/weather-correlation/signals`                 | Signal definitions + current computed `status`/`r`/`direction`/`strength` |
| GET    | `/api/predictions/weather-correlation/trends`                  | Time-bucketed correlation trend. `?signal=&drainId=&window=&lag=15\|30\|60` |
| GET    | `/api/predictions/weather-correlation/drains`                  | Per-drain correlations across all weather signals |
| GET    | `/api/predictions/weather-correlation/drain/:drainId`          | Full per-drain detail (404 when the drain is unknown). `?signal=&window=&lag=` |
| GET    | `/api/predictions/weather-correlation/:signal`                 | Single-signal correlation (404 when the signal key is unknown). `?drainId=&window=&lag=` |

Query validation is strict and returns HTTP 400 `{ error, valid_signals|valid_lag_minutes }`
for unknown `signal`, window outside 1–168 h or lag not in `{0,15,30,60}`. The dashboard only
calls the summary/parse the compact overlay, keeping the hot path light.

**Summary shape** (also the live socket payload and dashboard `weatherCorrelation` source):
`{ status, generated_at, window_hours, disclaimer, weather_data_quality
{ status, observation_count, window_hours, first_observation_at, last_observation_at },
signals_ready, signals_total, signals[], strongest, latest_weather, message }`.

**Trends shape**: `{ status, samples, buckets[ { bucket, bucket_start, bucket_end,
matched_pairs, status, r, direction, strength } ], trend
(`strengthening` / `weakening` / `stable` / `insufficient`), trend_reason }` — bucketed by
`BUCKET_COUNT = 4`, each bucket needs `MIN_PAIRS_PER_BUCKET = 10`, and the trend label uses
`TREND_DELTA = 0.05` on the first-vs-last bucket `r`.

Additive analytics surfaces:

- `GET /api/dashboard` gains `weatherCorrelation` (camelCase, best-effort):
  `{ status, weatherDataQuality, signalsReady, signalsTotal, strongest, latestWeather, message }`.
- `GET /api/analytics` gains `weather_*` fields: `weather_correlation`,
  `weather_flood_risk`, `rainfall_water_level`, `weather_strongest`, `weather_data_quality`,
  `weather_observation_count`, `weather_signals_ready`, `weather_signals_total`.
- `GET /api/analytics/weather-correlation` returns the dedicated view with
  `weather_*` fields, the per-signal compact results (`humidity_water_level`,
  `temperature_water_level`, `pressure_water_level`, `wind_water_level`,
  `weather_forecast`), `latest_weather`, `disclaimer` and `generated_at`.

---

## 7. Additive context for the existing engines

Section integration is strictly additive — the layer never changes the flood-risk, forecast,
maintenance or decision formulas. It exposes a **TTL-cached** correlation context
(`CONTEXT_CACHE_TTL_MS` = 30 s) so the hot path does not re-query on every reading:

- **Decision engine** — response carries `weatherCorrelation` (window hours, signals ready /
  total, strongest `{ signal, label, r, direction, strength }`, status, disclaimer).
- **Flood risk** (`buildDrainRiskDetail`) — per-drain detail carries `weatherCorrelation`
  (honestly `WEATHER_UNAVAILABLE`/`INSUFFICIENT_DATA` when there is no data).
- **Flood forecast** (`getDrainForecast`) — carries `weatherCorrelation` (reused from the
  risk detail, no extra queries).
- **Dashboard / analytics** — additive fields as above; failures degrade to the fallback
  object (never a fabricated score).

Because the context is a *description* of existing observations, a system with no weather
history returns the honest unavailable block and is not cached, so it is re-checked when real
observations arrive.

---

## 8. Frontend + Digital Twin integration

- The **Weather Correlation** panel (`client/src/components/WeatherFloodCorrelationPanel.jsx`)
  and full page (`WeatherFloodCorrelationPage.jsx`) render the real summary, latest-weather
  banner, signals-ready table, per-signal detail with samples, the trend bucket grid and the
  per-drain table. Window select (24/48/72/168 h) and lag select (0/15/30/60 min) re-query the
  read-only endpoints. It re-fetches from the server and consumes the live
  `weatherFloodCorrelationUpdate` event so the UI always reflects live state. Fallback states
  are honest (`WEATHER_UNAVAILABLE` / `INSUFFICIENT_DATA` cards, never invented numbers).
- The app-level `weatherFloodCorrelationUpdate` listener (in `App.jsx`) shows an info toast on
  meaningful change and is removed on cleanup.
- Sidebar + `App.jsx` route: **Weather Correlation** (`weathercorrelation`).
- **Digital Twin overlay** (additive): `client/src/services/digitalTwinUtils.mjs` exposes
  `normalizeWeatherFloodCorrelation` (compacts the summary into
  `{ status, windowHours, signalsReady, signalsTotal, strongest, latestWeather, disclaimer,
  message }`; returns `null` for invalid payloads) and the reducer handles
  `WEATHER_CORRELATION_UPDATE`. `DigitalTwin.jsx` shows weather context + correlation badges
  per sensor, `DigitalTwinPage.jsx` adds a "Weather correlation" header stat and weather
  fields in the sensor details, and `DigitalTwinPreview.jsx` shows a compact "Weather corr"
  chip. The overlay degrades gracefully when the API/event is unavailable — it never invents
  a correlation.

---

## 9. Failure / degraded states

| Situation                                  | Behaviour |
| ------------------------------------------ | --------- |
| No `weather_observations` rows yet         | `WEATHER_UNAVAILABLE`, `null` r, honest message pointing at the API key |
| No OWM key / fetch fails                   | Logged and skipped; existing observations still used; no fabricated snapshot |
| Fewer than `MIN_PAIRS` aligned pairs       | `INSUFFICIENT_DATA` with real `samples` reasons |
| Historical risk/forecast not persisted     | `weather_flood_risk` / `weather_forecast` always `NOT_AVAILABLE` |
| Drain has no readings in the window        | That drain contributes no pairs (never estimated) |
| Panel/page API down                        | Error/fallback state, no fabricated correlations |
| Weather feed stops coming back             | Growth stops; last recorded lens remains; emission unchanged (signature-guarded) |

---

## 10. Tests

- `server/tests/weatherFloodCorrelationService.test.js` + `server/tests/weatherFloodCorrelation.test.js`
  — 45 tests covering the constants, pure helpers (pearson tolerance, round3, direction /
  strength bands, parseWindowHours incl. the null fix), timestamp alignment + pair
  extraction, bounded windows, per-signal + summary + per-drain + trends views, honest
  `WEATHER_UNAVAILABLE` / `INSUFFICIENT_DATA` / `NOT_AVAILABLE` states, no-fabrication /
  no-causality wording, signature + throttle-guarded emission, dashboard/analytics additive
  shapes, `fetchWeatherSnapshot` refresh rules, and the full REST surface incl. the
  `/drain/:drainId` 404.
- `server/tests/digitalTwin.test.js` adds 4 weather-overlay tests (compact overlay build,
  honesty, `WEATHER_CORRELATION_UPDATE` reducer, endpoint consumability).
- Run the full backend suite (from `server/`): `npm test`
  (`node --test --test-concurrency=1 "tests/*.test.js"`).

---

## 11. Non-goals / limitations

- The layer does **not** dispatch or move robots — `missionEngine.js` and the movement loop
  are untouched, and no incident is ever opened from a correlation.
- It does **not** change the flood risk / forecast / maintenance / decision formulas; its
  context is descriptive only.
- Correlation is a linear, timestamp-aligned Pearson coefficient — it does **not** prove
  causation and never will (every payload repeats the disclaimer).
- `weather_flood_risk` and `weather_forecast` are `NOT_AVAILABLE` because historical risk /
  forecast outputs are not persisted; they are never recomputed or invented.
- Weather history only grows forward, throttled, from real fetches — never backfilled, never
  seeded, and the whole layer degrades to honest `WEATHER_UNAVAILABLE` on a clean install
  until real observations accumulate.