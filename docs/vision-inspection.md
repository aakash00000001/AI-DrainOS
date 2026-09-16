# Drain Vision Inspection (Computer Vision Baseline)

> **IMPORTANT — MODEL LIMITATION**
>
> This is an **explainable engineering baseline** built on OpenCV pixel
> statistics. It is **not a trained deep-learning model and does not detect a
> physical blockage**. It intentionally reports **no confidence or accuracy**
> values and only uses "possible / consistent with" terminology. Results stay
> **separate** from the sensor maintenance engine, and robot dispatch is only
> ever a *recommendation flag* — `missionEngine.js` remains the sole authority
> for assigning missions. When an image cannot be analyzed the system returns
> `INSUFFICIENT_IMAGE_QUALITY` instead of inventing a result. **Do not use these
> results for real public-safety decisions.**

This feature adds a **computer-vision inspection layer** on top of the existing
analytical layers:

| Layer | Service | Answers |
|---|---|---|
| Current Risk | `floodRiskService.js` | "What is the **current** flood risk?" |
| Forecast | `floodForecastService.js` | "What **may happen** in 15/30/60 min?" |
| Maintenance | `maintenancePredictionService.js` | "Does this drain **need inspection or cleaning** soon?" |
| Vision | `drainVisionService.js` | "What does a **single inspection image** visually suggest?" |

The vision layer is deliberately kept **independent** of the sensor-based
maintenance engine: `visualRiskScore` / `possibleBlockageScore` / `findings`
are additive signals and never overwrite `maintenanceScore`.

---

## 1. What the vision layer looks at

A single drain image is decoded and reduced to **low-level pixel statistics**
(same contract on both the OpenCV path and the local fallback):

- **Brightness** — average luminance 0–255.
- **Darkness ratio** — fraction of pixels darker than 60 (dense shadows / dark
  material could hide debris).
- **Edge density** — fraction of pixels with a strong luminance gradient
  (textured / cluttered scenes).
- **Texture variance** — global luminance variance (clamped to 5000).
- **Water-like ratio** — fraction of bluish pixels (`b > g + 12 && b > r + 12 &&
  b > 70`), a hint of standing water / pooling.
- **Dense region ratio** — fraction of 8×8 blocks that are both dark (mean < 110)
  and textured (std > 20) — typical of waste / debris piles.

None of these statistics **prove** a blockage exists — they are visual signals
consistent with a drain that may need attention.

## 2. Architecture

```
uploaded image (JPG/JPEG/PNG/WEBP, <=5 MB, magic-byte checked)
        │
        ▼
routes/predictions.js (multer, ext+MIME filter, 5MB cap, magic-byte re-check)
        │
        ▼
drainVisionService.js
   ├─► Python AI service POST /vision/analyze   (OpenCV / cv2)
   │       └─ returns features {brightness, darknessRatio, edgeDensity,
   │                            textureVariance, waterLikeRatio,
   │                            denseRegionRatio, width, height}
   ├─► FALLBACK: pure-Node PNG decoder (zlib) computing the SAME features
   │       └─ non-PNG + AI down  ==>  INSUFFICIENT_IMAGE_QUALITY (honest)
   ▼
checkImageQuality gate  ==>  featuresToResult (single deterministic scorer)
   │
   ├─► persistInspection  ─►  drain_vision_inspections (metadata audit trail)
   ├─► ensureVisionAlert / resolveVisionAlerts  (alerts table)
   └─► socketHub.emit("visionInspectionUpdate")
```

### AI service path vs local fallback

- **Primary**: the Python AI service decodes the image with OpenCV and returns
  the feature contract above.
- **Fallback**: if the AI service is unreachable, a tiny pure-Node PNG decoder
  (zlib, filters 0–4, 8-bit non-interlaced) computes the **same** feature set.
  For non-PNG images while the AI service is down the route honestly returns
  `INSUFFICIENT_IMAGE_QUALITY` rather than inventing a result.
- Both paths feed the **same** `featuresToResult` scorer, so behavior stays
  consistent no matter which path produced the features.

## 3. Scoring

All components are clamped into 0–100 first:

| Feature | → Score |
|---|---|
| darknessRatio | `darknessRatio * 100` |
| brightness (avg 0–255) | `(128 - brightness) * 2` (pressure, 0–100) |
| edgeDensity | `edgeDensity * 200` |
| denseRegionRatio | `denseRegionRatio * 150` |
| textureVariance | `(textureVariance / 500) * 100` |
| waterLikeRatio | `waterLikeRatio * 160` |

```
visualRiskScore = darknessScore*0.25 + denseScore*0.20 + edgeScore*0.20
                + waterScore*0.15 + brightnessPressure*0.10 + textureScore*0.10

possibleBlockageScore = darknessScore*0.35 + denseScore*0.30
                      + edgeScore*0.20 + textureScore*0.15
```

Level thresholds (same for both engines):

| Score | Level |
|---|---|
| ≥ 75 | CRITICAL |
| 50–74 | HIGH |
| 25–49 | MODERATE |
| < 25 | LOW |

Findings (`possible_blockage`, `debris_or_garbage`, `structural_anomaly`,
`possible_overflow`, `heavy_waste`, `low_brightness`, `normal`) are emitted when
their source score crosses a per-finding threshold, using description text with
"possible / consistent with" phrasing only.

Recommendation:

| Level | Recommendation | Robot flag |
|---|---|---|
| CRITICAL | Immediate drain inspection and cleaning recommended | `true` |
| HIGH | Drain inspection and cleaning recommended | `true` |
| MODERATE | Schedule a follow-up inspection | `false` |
| LOW | No immediate visual concern | `false` |

The READY payload ships a `limitations` array that repeats the honesty contract
and **never contains the tokens `confidence`, `accuracy`, or `blocked`**
(enforced by tests).

## 4. Honest status: `INSUFFICIENT_IMAGE_QUALITY`

An image that cannot be meaningfully analyzed returns:

```json
{
  "drainId": 3,
  "status": "INSUFFICIENT_IMAGE_QUALITY",
  "reason": "Image appears effectively black with no usable detail",
  "inspectionLevel": null,
  "visualRiskScore": null,
  "possibleBlockageScore": null,
  "findings": [],
  "recommendation": null,
  "robotInspectionRecommended": false,
  "limitations": [ "...", "This baseline analysis reports no measured performance or certainty value." ]
}
```

Triggered when: not decodable (bad bytes), dimensions < 16 px, effectively
black (`brightness < 8 && darknessRatio > 0.99`), or the AI service is down and
the image is not a decodable PNG. No inspection row is persisted for these.

## 5. Upload validation

- `multipart/form-data`, field name `image`.
- Accepted: JPG/JPEG/PNG/WEBP, **≤ 5 MB**.
- Server verifies **magic bytes** (`detectImageType`): PNG signature, JPEG `FF D8
  FF`, WEBP `RIFF....WEBP`. The filename / Content-Type are never trusted alone.
- The raw image is **never stored** — only metadata
  (`format`, `mime`, `originalName`, `bytes`, `dimensions`, `method`) goes into
  `drain_vision_inspections.image_metadata`.

## 6. Alerts (`Vision Inspection` category)

Implemented via `alert_type = 'Vision Inspection'`:

- **Create**: inspection level HIGH → Medium severity (dedup per drain); CRITICAL
  → Critical severity.
- **Deduplication**: only one **Open** alert per drain.
- **Upgrade-only**: existing Open alert may be bumped to Critical, never
  downgraded.
- **Resolve**: automatically resolved when a later inspection returns
  LOW/MODERATE.

## 7. Socket.IO event: `visionInspectionUpdate`

Emitted when a drain vision inspection completes:

```json
{
  "drainId": 3,
  "zone": "Zone 1",
  "location": "Market Road 5",
  "inspectionLevel": "HIGH",
  "visualRiskScore": 62,
  "possibleBlockageScore": 71,
  "recommendation": "Drain inspection and cleaning recommended",
  "robotInspectionRecommended": true,
  "analyzedAt": "2026-01-01T12:00:00.000Z"
}
```

`INSUFFICIENT_IMAGE_QUALITY` results also emit this event (with null scores) so
the panel can refresh.

## 8. API

| Endpoint | Access | Purpose |
|---|---|---|
| `POST /api/predictions/vision/:drainId` | public | run a vision inspection on an uploaded image |
| `GET /api/predictions/vision/:drainId?history=N` | public | latest inspection (default 1, max 20) + recent history |
| `GET /api/analytics/vision` | public | aggregate vision analytics |
| `GET /api/analytics` | public | additive `vision_average_visual_risk`, `vision_*` fields |

Python AI service:

| Endpoint | Purpose |
|---|---|
| `POST /vision/analyze` (multipart `image`) | OpenCV decode + feature extraction; 400 if image field missing; `INSUFFICIENT_IMAGE_QUALITY` if undecodable; 503 if cv2 unavailable |

`GET /api/predictions/vision/:drainId` example:

```json
{
  "id": 12,
  "drainId": 3,
  "status": "READY",
  "inspectionLevel": "MODERATE",
  "visualRiskScore": 38,
  "possibleBlockageScore": 44,
  "findings": ["Dense irregular debris-like regions were detected in the image."],
  "recommendation": "Schedule a follow-up inspection",
  "robotInspectionRecommended": false,
  "imageQuality": { "decodable": true, "dimensions": { "width": 320, "height": 240 } },
  "analyzedAt": "2026-01-01T12:00:00.000Z",
  "history": [ ... ]
}
```

## 9. Analytics

`GET /api/analytics/vision` returns: `totalInspections`, `averageVisualRisk`,
`averageBlockageRisk`, `drainsInspected`, `drainsWithVisualIssues`,
`inspectionsLast24h`, `counts`/`distribution` by level,
`repeatedIssueDrains` (HIGH/CRITICAL drains with ≥ 2 inspections),
`recentTrends` (24h hourly), and `recentInspections` (last 10).

`GET /api/analytics` adds `vision_average_visual_risk`,
`vision_average_blockage_risk`, `vision_total_inspections`,
`vision_ready`, `vision_insufficient`, `vision_low` / `..._moderate` /
`..._high` / `..._critical`, and `vision_ready_drains`. These are computed
**best-effort** (guarded in try/catch) so the endpoint can never 500 because of
them. The analytics card renders only when
`analytics.vision_average_visual_risk !== undefined` — fully backward compatible.

## 10. Frontend

`client/src/components/DrainVisionInspection.jsx` adds a **Drain Vision
Inspection** panel (mounted below `MaintenancePanel` in `App.jsx`):

- Drain selector (defaults to first drain), file picker with client-side
  preview.
- Analyze button with loading state; honest handling of `INSUFFICIENT_IMAGE_QUALITY`
  (shows the reason banner instead of fake data).
- READY result: level badge, visual-risk / blockage ScoreBars, recommendation,
  robot-inspection flag, findings, image dimensions + analyzed time, and the
  disclaimer.
- **Recent inspections** history table refreshed live from
  `visionInspectionUpdate` socket events (toast "Vision Inspection completed" +
  auto-refresh when the currently selected drain is inspected).

`AnalyticsReport.jsx` shows a guarded **Vision Inspection Summary** section.

## 11. Database

Migration `database/migrations/004_drain_vision_inspections.sql` (idempotent,
auto-applied by `server/scripts/dbInit.js`), mirrored in `database/schema.sql`:

```sql
CREATE TABLE drain_vision_inspections (
  id                         SERIAL PRIMARY KEY,
  drain_id                   INTEGER NOT NULL REFERENCES drains(id) ON DELETE CASCADE,
  inspection_level           VARCHAR(20),
  visual_risk_score          INTEGER,
  possible_blockage_score    INTEGER,
  findings                   JSONB,
  recommendation             VARCHAR(255),
  robot_inspection_recommended BOOLEAN DEFAULT FALSE,
  image_metadata             JSONB,
  created_at                 TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

Indexes: `idx_drain_vision_inspections_drain_id`,
`idx_drain_vision_inspections_created_at`.

## 12. File map

| File | Role |
|---|---|
| `ai/app.py` | `POST /vision/analyze` (OpenCV) + `POST /predict` (ML) |
| `ai/requirements.txt` | pip deps incl. `opencv-python` |
| `server/services/drainVisionService.js` | core engine: features, PNG fallback, scorer, alerts, persistence, analytics |
| `server/services/socketHub.js` | shared Socket.IO emitter (no-op safe) |
| `server/routes/predictions.js` | multer + `POST/GET /api/predictions/vision/:drainId` |
| `server/routes/analytics.js` | `GET /api/analytics/vision` + additive `vision_*` fields |
| `server/index.js` | `socketHub.init(io)` wiring |
| `database/migrations/004_drain_vision_inspections.sql` | audit table (idempotent) |
| `database/schema.sql` | table + indexes for fresh setups |
| `client/src/components/DrainVisionInspection.jsx` | panel + history + socket refresh |
| `client/src/App.jsx` | mount + `visionInspectionUpdate` toast |
| `client/src/components/AnalyticsReport.jsx` | guarded vision summary card |
| `server/tests/drainVision.test.js` | 24-test vision suite |

## 13. Testing

`npm test` runs 24 vision tests covering: threshold classification, bright → LOW
and checkerboard → HIGH + robot flag, the **honesty contract** (no
`confidence`/`accuracy`/`blocked` tokens), magic-byte type detection and PNG
decoder rejection cases, the quality gate (black / tiny images), POST happy path
+ persistence, 404/400/oversize validation, `INSUFFICIENT_IMAGE_QUALITY`
(black PNG, undecodable JPEG, AI-down with non-PNG), GET latest + history,
`Vision Inspection` alert create/dedupe/upgrade/resolve, analytics endpoints,
and `socketHub` no-op/forward behaviour.

## 14. Future enhancement

A trained deep-learning vision model (e.g. segmentation + classification) can
replace `featuresToResult` / the OpenCV feature block behind the same
`analyzeDrainImage` contract without touching routes, UI, events, or tests —
mirroring how the forecast engine documents its own ML drop-in path.