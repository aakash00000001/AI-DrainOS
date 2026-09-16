// ============================================================
// AI-DrainOS Drain Vision Inspection Service
//
// Baseline computer-vision analysis of a single drain inspection
// image (JPG/JPEG/PNG/WEBP accepted by the upload route).
//
//   PRIMARY PATH  : the Python AI service decodes the image with
//                   OpenCV and returns low-level pixel features.
//   FALLBACK PATH : when the AI service is unreachable the same
//                   feature set is computed locally for PNG
//                   images with a tiny pure-Node decoder. Other
//                   formats honestly report INSUFFICIENT_IMAGE_
//                   QUALITY instead of inventing a result.
//
// IMPORTANT - HONESTY CONTRACT:
// This is an ENGINEERING BASELINE, not a trained deep-learning
// model. It extracts observable pixel statistics only, never
// claims to detect a physical blockage, and never reports an
// accuracy or confidence value. Terminology stays possible /
// consistent ("possible blockage pattern", "debris-like"), and an
// unusable image yields status INSUFFICIENT_IMAGE_QUALITY.
//
// Vision results are SEPARATE from the sensor maintenance engine:
// visualRiskScore / possibleBlockageScore / findings are additive
// signals and never overwrite maintenanceScore. Robot dispatch is
// only ever a recommendation flag here - missionEngine.js remains
// the sole authority for assigning missions.
// ============================================================

const zlib = require("zlib");
const axios = require("axios");

const pool = require("../config/db");
const socketHub = require("./socketHub");

// --------------------------------------------------
// Configuration
// --------------------------------------------------

const METHOD_NAME = "Drain Vision Inspection (OpenCV baseline)";
const VISION_DISCLAIMER =
  "Baseline computer-vision analysis of a single image - does NOT prove a physical blockage and is not a trained ML model.";

// Public contract of the accepted image formats (route + service share it).
const ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp"
];

const ALLOWED_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"];

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB

const VISION_THRESHOLDS = {
  moderate: 25,
  high: 50,
  critical: 75
};

// Minimum pixel dimension for a meaningful analysis.
const MIN_IMAGE_DIMENSION = 16;

let aiUnreachableLoggedAt = null;

const VALID_FINDING_TYPES = new Set([
  "possible_blockage",
  "debris_or_garbage",
  "heavy_waste",
  "possible_overflow",
  "structural_anomaly",
  "low_brightness",
  "normal"
]);

// --------------------------------------------------
// Small helpers
// --------------------------------------------------

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function toFiniteNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function levelFromScore(score, thresholds = VISION_THRESHOLDS) {
  const numeric = toFiniteNumber(score);

  if (numeric >= thresholds.critical) return "CRITICAL";
  if (numeric >= thresholds.high) return "HIGH";
  if (numeric >= thresholds.moderate) return "MODERATE";
  return "LOW";
}

function logAiUnreachable(message) {
  const now = Date.now();

  if (!aiUnreachableLoggedAt || now - aiUnreachableLoggedAt > 60000) {
    console.log("⚠️ Vision AI service unreachable, using local fallback:", message);
    aiUnreachableLoggedAt = now;
  }
}

// --------------------------------------------------
// Image type detection from magic bytes (never trusts the
// filename or the Content-Type header).
// --------------------------------------------------

function detectImageType(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;

  if (
    buffer.length > 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return "png";
  }

  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "jpeg";
  }

  if (buffer.length > 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") {
    return "webp";
  }

  return null;
}

function typeToMime(type) {
  if (type === "png") return "image/png";
  if (type === "jpeg") return "image/jpeg";
  if (type === "webp") return "image/webp";
  return null;
}

// --------------------------------------------------
// Pure-Node PNG decoder (8-bit, non-interlaced; used only by the
// local fallback path). Returns { width, height, rgba } or null.
// --------------------------------------------------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function readPngChunks(buffer) {
  const chunks = [];
  let offset = 8;

  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    chunks.push({ type, data: buffer.subarray(offset + 8, offset + 8 + length) });
    offset += 12 + length;
    if (type === "IEND") break;
  }

  return chunks;
}

function decodePng(buffer) {
  if (buffer.length < 24 || !PNG_SIGNATURE.equals(buffer.subarray(0, 8))) {
    return null;
  }

  const chunks = readPngChunks(buffer);
  const ihdr = chunks.find((chunk) => chunk.type === "IHDR");
  if (!ihdr || ihdr.data.length < 13) return null;

  const width = ihdr.data.readUInt32BE(0);
  const height = ihdr.data.readUInt32BE(4);
  const bitDepth = ihdr.data[8];
  const colorType = ihdr.data[9];
  const interlace = ihdr.data[12];

  if (bitDepth !== 8 || interlace !== 0) return null;

  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 6 ? 4 : 0;
  if (channels === 0) return null;

  const idat = chunks.filter((chunk) => chunk.type === "IDAT").map((chunk) => chunk.data);
  if (idat.length === 0) return null;

  let inflated;
  try {
    inflated = zlib.inflateSync(Buffer.concat(idat));
  } catch (err) {
    return null;
  }

  const stride = width * channels;
  const expected = (stride + 1) * height;
  if (inflated.length < expected) return null;

  const unfiltered = Buffer.alloc(height * stride);
  let pos = 0;

  for (let y = 0; y < height; y++) {
    const filterType = inflated[pos];
    pos += 1;

    if (filterType > 4) return null;

    const row = unfiltered.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : unfiltered.subarray((y - 1) * stride, y * stride);

    for (let x = 0; x < stride; x++) {
      const raw = inflated[pos];
      pos += 1;

      const left = x >= channels ? row[x - channels] : 0;
      const up = prev ? prev[x] : 0;
      const upLeft = prev && x >= channels ? prev[x - channels] : 0;

      let value = raw;

      if (filterType === 1) value = (raw + left) & 0xff;
      else if (filterType === 2) value = (raw + up) & 0xff;
      else if (filterType === 3) value = (raw + ((left + up) >> 1)) & 0xff;
      else if (filterType === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
        value = (raw + predictor) & 0xff;
      }

      row[x] = value;
    }
  }

  const rgba = Buffer.alloc(width * height * 4);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const si = y * stride + x * channels;
      const di = (y * width + x) * 4;

      let r;
      let g;
      let b;
      let a = 255;

      if (channels === 1) {
        r = unfiltered[si];
        g = r;
        b = r;
      } else if (channels === 3) {
        r = unfiltered[si];
        g = unfiltered[si + 1];
        b = unfiltered[si + 2];
      } else {
        r = unfiltered[si];
        g = unfiltered[si + 1];
        b = unfiltered[si + 2];
        a = unfiltered[si + 3];
      }

      rgba[di] = r;
      rgba[di + 1] = g;
      rgba[di + 2] = b;
      rgba[di + 3] = a;
    }
  }

  return { width, height, rgba };
}

// --------------------------------------------------
// Local feature extraction (fallback path, mirrors the feature
// contract returned by the OpenCV AI service).
// --------------------------------------------------

function extractFeaturesFromRgba(width, height, rgba) {
  const count = width * height;
  const gray = new Float32Array(count);
  const edgeScale = new Uint8Array(count);

  let sum = 0;
  let sumSq = 0;
  let darkCount = 0;
  let waterCount = 0;

  for (let i = 0; i < count; i++) {
    const r = rgba[i * 4];
    const g = rgba[i * 4 + 1];
    const b = rgba[i * 4 + 2];

    const luma = 0.299 * r + 0.587 * g + 0.114 * b;
    gray[i] = luma;

    sum += luma;
    sumSq += luma * luma;

    if (luma < 60) darkCount += 1;
    if (b > g + 12 && b > r + 12 && b > 70) waterCount += 1;
  }

  const brightness = sum / count;
  const variance = sumSq / count - brightness * brightness;

  // Edge density via simple gradient magnitude.
  let edgeCount = 0;

  for (let y = 1; y < height; y++) {
    for (let x = 1; x < width; x++) {
      const i = y * width + x;
      const dx = Math.abs(gray[i] - gray[y * width + x - 1]);
      const dy = Math.abs(gray[i] - gray[(y - 1) * width + x]);
      const grad = dx + dy;

      edgeScale[i] = grad;
      if (grad > 40) edgeCount += 1;
    }
  }

  const edgeDensity = edgeCount / count;

  // Dense irregular regions: 8x8 blocks that are both dark and
  // textured (typical of waste / debris piles).
  let denseBlocks = 0;
  let totalBlocks = 0;

  for (let y = 0; y < height; y += 8) {
    for (let x = 0; x < width; x += 8) {
      const w = Math.min(8, width - x);
      const h = Math.min(8, height - y);

      if (w <= 0 || h <= 0) continue;
      totalBlocks += 1;

      let blockSum = 0;
      let blockSumSq = 0;
      let n = 0;

      for (let by = 0; by < h; by++) {
        for (let bx = 0; bx < w; bx++) {
          const v = gray[(y + by) * width + (x + bx)];
          blockSum += v;
          blockSumSq += v * v;
          n += 1;
        }
      }

      const mean = blockSum / n;
      const blockVar = blockSumSq / n - mean * mean;

      if (mean < 110 && Math.sqrt(Math.max(blockVar, 0)) > 20) denseBlocks += 1;
    }
  }

  return {
    brightness: Number(brightness.toFixed(2)),
    darknessRatio: Number((darkCount / count).toFixed(4)),
    edgeDensity: Number(edgeDensity.toFixed(4)),
    textureVariance: Number(Math.min(variance, 5000).toFixed(2)),
    waterLikeRatio: Number((waterCount / count).toFixed(4)),
    denseRegionRatio: Number((denseBlocks / Math.max(totalBlocks, 1)).toFixed(4)),
    width,
    height
  };
}

// --------------------------------------------------
// Image-quality gate: an unusable image is reported honestly
// instead of yielding a fabricated score.
// --------------------------------------------------

function checkImageQuality(features) {
  if (!features || !features.width || !features.height) {
    return "Image could not be decoded for analysis";
  }

  if (features.width < MIN_IMAGE_DIMENSION || features.height < MIN_IMAGE_DIMENSION) {
    return "Image is too small to analyze reliably";
  }

  if (features.brightness < 8 && features.darknessRatio > 0.99) {
    return "Image appears effectively black with no usable detail";
  }

  return null;
}

// --------------------------------------------------
// Single scoring implementation used by BOTH the AI-service path
// and the local fallback so behaviour stays consistent.
// --------------------------------------------------

function featuresToResult(features) {
  const brightness = clamp(toFiniteNumber(features.brightness), 0, 255);
  const darknessRatio = clamp(toFiniteNumber(features.darknessRatio), 0, 1);
  const edgeDensity = clamp(toFiniteNumber(features.edgeDensity), 0, 1);
  const textureVariance = clamp(toFiniteNumber(features.textureVariance), 0, 5000);
  const waterLikeRatio = clamp(toFiniteNumber(features.waterLikeRatio), 0, 1);
  const denseRegionRatio = clamp(toFiniteNumber(features.denseRegionRatio), 0, 1);

  const darknessScore = clamp(darknessRatio * 100, 0, 100);
  const brightnessPressure = clamp((128 - brightness) * 2, 0, 100);
  const edgeScore = clamp(edgeDensity * 200, 0, 100);
  const denseScore = clamp(denseRegionRatio * 150, 0, 100);
  const textureScore = clamp((textureVariance / 500) * 100, 0, 100);
  const waterScore = clamp(waterLikeRatio * 160, 0, 100);

  const rawVisual = clamp(
    darknessScore * 0.25 +
      denseScore * 0.20 +
      edgeScore * 0.20 +
      waterScore * 0.15 +
      brightnessPressure * 0.10 +
      textureScore * 0.10,
    0,
    100
  );

  const rawBlockage = clamp(
    darknessScore * 0.35 +
      denseScore * 0.30 +
      edgeScore * 0.20 +
      textureScore * 0.15,
    0,
    100
  );

  const visualRiskScore = Math.round(rawVisual);
  const possibleBlockageScore = Math.round(rawBlockage);
  const inspectionLevel = levelFromScore(visualRiskScore);

  const findings = [];

  if (darknessScore >= 40) {
    findings.push({
      type: "possible_blockage",
      severity: darknessScore >= 70 ? "high" : "medium",
      description: "Dark dense regions consistent with a possible obstruction or heavy shadowing were detected."
    });
  }

  if (denseScore >= 45) {
    findings.push({
      type: "debris_or_garbage",
      severity: denseScore >= 70 ? "high" : "medium",
      description: "Dense irregular debris-like regions were detected in the image."
    });
  }

  if (edgeScore >= 50) {
    findings.push({
      type: "structural_anomaly",
      severity: edgeScore >= 75 ? "high" : "medium",
      description: "High edge activity suggests textured surfaces or structural detail worth a closer look."
    });
  }

  if (waterScore >= 45) {
    findings.push({
      type: "possible_overflow",
      severity: waterScore >= 75 ? "high" : "medium",
      description: "Water-like pooling regions were detected, consistent with possible overflow or standing water."
    });
  }

  if (darknessScore >= 70 && denseScore >= 45) {
    findings.push({
      type: "heavy_waste",
      severity: "high",
      description: "Large dark dense areas are consistent with heavy waste or a build-up at the drain."
    });
  }

  if (brightnessPressure >= 60) {
    findings.push({
      type: "low_brightness",
      severity: "low",
      description: "Overall image illumination is low; visual assessment may be less reliable."
    });
  }

  if (findings.length === 0) {
    findings.push({
      type: "normal",
      severity: "low",
      description: "No dominant visual signal detected; the drain appears clear in this image."
    });
  }

  let recommendation = "No immediate visual concern";
  let robotInspectionRecommended = false;

  if (inspectionLevel === "CRITICAL") {
    recommendation = "Immediate drain inspection and cleaning recommended";
    robotInspectionRecommended = true;
  } else if (inspectionLevel === "HIGH") {
    recommendation = "Drain inspection and cleaning recommended";
    robotInspectionRecommended = true;
  } else if (inspectionLevel === "MODERATE") {
    recommendation = "Schedule a follow-up inspection";
    robotInspectionRecommended = false;
  }

  const limitations = [
    VISION_DISCLAIMER,
    "This baseline analysis reports no measured performance or certainty value."
  ];

  if (robotInspectionRecommended) {
    limitations.push(
      "Robot dispatch is a recommendation only - mission assignment authority stays with the mission engine."
    );
  }

  if (brightnessPressure >= 60) {
    limitations.push("Low image quality may reduce the reliability of the visual assessment.");
  }

  return {
    status: "READY",
    method: METHOD_NAME,
    inspectionLevel,
    visualRiskScore,
    possibleBlockageScore,
    findings,
    recommendation,
    robotInspectionRecommended,
    imageQuality: {
      decodable: true,
      dimensions: { width: Number(features.width), height: Number(features.height) },
      brightness: Number(brightness),
      darknessRatio: Number(darknessRatio)
    },
    limitations
  };
}

// --------------------------------------------------
// Feature acquisition: OpenCV AI service first, local fallback
// for PNG when the service is unreachable.
// --------------------------------------------------

async function aiFeatures(buffer) {
  const aiUrl = (process.env.AI_SERVICE_URL || "http://127.0.0.1:5001") + "/vision/analyze";

  const form = new FormData();
  form.append("image", new Blob([buffer]), "image");

  const response = await axios.post(aiUrl, form, {
    timeout: 8000
  });

  if (response.data && response.data.status === "READY" && response.data.features) {
    return response.data.features;
  }

  return null;
}

async function getFeatures(buffer) {
  try {
    const features = await aiFeatures(buffer);
    if (features) return features;
  } catch (err) {
    logAiUnreachable(err.message);
  }

  // Local deterministic fallback (PNG only - decoding only what we
  // can decode without help; other formats are reported honestly).
  if (detectImageType(buffer) === "png") {
    const decoded = decodePng(buffer);
    if (decoded) {
      return extractFeaturesFromRgba(decoded.width, decoded.height, decoded.rgba);
    }
  }

  return null;
}

// --------------------------------------------------
// Insufficient-quality payload (honest, never fabricated)
// --------------------------------------------------

function insufficientPayload(drainId, reason, meta = {}) {
  return {
    drainId: Number(drainId),
    status: "INSUFFICIENT_IMAGE_QUALITY",
    reason,
    method: METHOD_NAME,
    inspectionLevel: null,
    visualRiskScore: null,
    possibleBlockageScore: null,
    findings: [],
    recommendation: null,
    robotInspectionRecommended: false,
    imageQuality: meta.imageQuality || null,
    limitations: [VISION_DISCLAIMER, "This baseline analysis reports no measured performance or certainty value."],
    analyzedAt: new Date().toISOString()
  };
}

// --------------------------------------------------
// Alert workflow ('Vision Inspection' category)
//
// Dedup: a single Open alert per drain. Severity may only be
// upgraded (up to Critical). Resolved once a later inspection
// drops below HIGH. Robot completion + drain->Normal flows stay
// untouched by the existing mission loop.
// --------------------------------------------------

async function ensureVisionAlert({ drainId, location, severity, message }) {
  const existing = await pool.query(
    `
    SELECT id, severity
    FROM alerts
    WHERE drain_id = $1
      AND alert_status = 'Open'
      AND alert_type = 'Vision Inspection'
    ORDER BY id ASC
    LIMIT 1
    `,
    [drainId]
  );

  if (existing.rows.length === 0) {
    const inserted = await pool.query(
      `
      INSERT INTO alerts (drain_id, alert_type, message, severity, alert_status)
      VALUES ($1, 'Vision Inspection', $2, $3, 'Open')
      RETURNING id
      `,
      [drainId, message, severity]
    );

    console.log(`👁️ Vision Inspection alert created for ${location} (${severity})`);
    return { action: "created", id: inserted.rows[0].id };
  }

  const current = existing.rows[0];

  if (severity === "Critical" && current.severity !== "Critical") {
    await pool.query(
      `
      UPDATE alerts
      SET severity = 'Critical', message = $2
      WHERE id = $1
      `,
      [current.id, message]
    );

    console.log(`👁️ Vision Inspection alert upgraded to Critical for ${location}`);
    return { action: "upgraded", id: current.id };
  }

  return { action: "kept", id: current.id };
}

async function resolveVisionAlerts(drainId) {
  const resolved = await pool.query(
    `
    UPDATE alerts
    SET alert_status = 'Resolved'
    WHERE drain_id = $1
      AND alert_status = 'Open'
      AND alert_type = 'Vision Inspection'
    RETURNING id
    `,
    [drainId]
  );

  if (resolved.rows.length > 0) {
    console.log(`✅ Vision Inspection alerts resolved for drain ${drainId}`);
  }

  return resolved.rows.length;
}

// --------------------------------------------------
// Persistence (audit trail - metadata only, never the raw image)
// --------------------------------------------------

async function persistInspection(result, meta = {}) {
  await pool.query(
    `
    INSERT INTO drain_vision_inspections
      (drain_id, inspection_level, visual_risk_score, possible_blockage_score,
       findings, recommendation, robot_inspection_recommended, image_metadata,
       created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP)
    `,
    [
      result.drainId,
      result.inspectionLevel,
      result.visualRiskScore,
      result.possibleBlockageScore,
      JSON.stringify(result.findings || []),
      result.recommendation,
      result.robotInspectionRecommended === true,
      JSON.stringify({
        format: meta.format || null,
        mime: meta.mime || null,
        originalName: meta.originalName || null,
        bytes: meta.bytes || null,
        dimensions: result.imageQuality && result.imageQuality.dimensions
          ? result.imageQuality.dimensions
          : null,
        method: result.method || null
      })
    ]
  );
}

// --------------------------------------------------
// Per-drain inspection (route entry point)
// --------------------------------------------------

async function analyzeDrainImage(drainId, file) {
  const drainResult = await pool.query(
    "SELECT id, zone_name, location FROM drains WHERE id = $1",
    [drainId]
  );

  if (drainResult.rows.length === 0) {
    return null;
  }

  const drain = drainResult.rows[0];
  const rawType = detectImageType(file.buffer);
  const mime = typeToMime(rawType) || file.mimetype;

  const features = await getFeatures(file.buffer);

  if (!features) {
    return insufficientPayload(
      drainId,
      "Image could not be decoded and the vision analysis service is unavailable"
    );
  }

  const qualityReason = checkImageQuality(features);

  if (qualityReason) {
    return insufficientPayload(drainId, qualityReason, {
      imageQuality: {
        decodable: false,
        dimensions: {
          width: Number(features.width) || null,
          height: Number(features.height) || null
        }
      }
    });
  }

  const result = {
    drainId: Number(drainId),
    sensorId: null,
    zone: drain.zone_name,
    location: drain.location,
    analyzedAt: new Date().toISOString(),
    disclaimer: VISION_DISCLAIMER,
    ...featuresToResult(features)
  };

  try {
    await persistInspection(result, {
      format: rawType,
      mime,
      originalName: file.originalname || "image",
      bytes: file.buffer.length
    });
  } catch (persistErr) {
    console.log("⚠️ Vision inspection persistence skipped:", persistErr.message);
  }

  // --------------------------------------------------
  // Alert workflow + live update
  // --------------------------------------------------

  try {
    if (result.inspectionLevel === "CRITICAL" || result.inspectionLevel === "HIGH") {
      const severity = result.inspectionLevel === "CRITICAL" ? "Critical" : "Medium";

      await ensureVisionAlert({
        drainId,
        location: drain.location,
        severity,
        message: `Vision inspection ${result.inspectionLevel} (visual risk ${result.visualRiskScore}/100, possible blockage ${result.possibleBlockageScore}/100) at ${drain.location}`
      });
    } else {
      await resolveVisionAlerts(drainId);
    }
  } catch (alertErr) {
    console.log("⚠️ Vision Inspection alert workflow skipped:", alertErr.message);
  }

  socketHub.emit("visionInspectionUpdate", {
    drainId: result.drainId,
    zone: result.zone,
    location: result.location,
    inspectionLevel: result.inspectionLevel,
    visualRiskScore: result.visualRiskScore,
    possibleBlockageScore: result.possibleBlockageScore,
    recommendation: result.recommendation,
    robotInspectionRecommended: result.robotInspectionRecommended,
    analyzedAt: result.analyzedAt
  });

  return result;
}

// --------------------------------------------------
// Map a DB row to the API shape
// --------------------------------------------------

function rowToInspection(row) {
  const metadata = row.image_metadata || {};

  return {
    id: Number(row.id),
    drainId: Number(row.drain_id),
    status: "READY",
    inspectionLevel: row.inspection_level,
    visualRiskScore: Number(row.visual_risk_score),
    possibleBlockageScore: Number(row.possible_blockage_score),
    findings: row.findings || [],
    recommendation: row.recommendation,
    robotInspectionRecommended: row.robot_inspection_recommended === true,
    imageMetadata: metadata,
    imageQuality: {
      decodable: true,
      dimensions: metadata.dimensions || null
    },
    analyzedAt: new Date(row.created_at).toISOString()
  };
}

// --------------------------------------------------
// Latest inspection + short history for a drain
// --------------------------------------------------

async function getLatestInspection(drainId, historyLimit = 5) {
  const latestResult = await pool.query(
    `
    SELECT *
    FROM drain_vision_inspections
    WHERE drain_id = $1
    ORDER BY created_at DESC, id DESC
    LIMIT 1
    `,
    [drainId]
  );

  if (latestResult.rows.length === 0) {
    return null;
  }

  const historyResult = await pool.query(
    `
    SELECT *
    FROM drain_vision_inspections
    WHERE drain_id = $1
    ORDER BY created_at DESC, id DESC
    LIMIT $2
    `,
    [drainId, historyLimit]
  );

  return {
    ...rowToInspection(latestResult.rows[0]),
    history: historyResult.rows.map(rowToInspection)
  };
}

// --------------------------------------------------
// Analytics (audit-trail based, used by GET /api/analytics/vision
// and the additive vision_* fields on GET /api/analytics)
// --------------------------------------------------

async function getVisionAnalytics() {
  const snapshot = await pool.query(
    `
    SELECT
      COUNT(*) AS total,
      COALESCE(ROUND(AVG(visual_risk_score)), 0) AS avg_visual,
      COALESCE(ROUND(AVG(possible_blockage_score)), 0) AS avg_blockage,
      COUNT(DISTINCT drain_id) AS distinct_drains,
      COUNT(*) FILTER (WHERE inspection_level IN ('HIGH', 'CRITICAL')) AS issue_count,
      COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours') AS last_24h
    FROM drain_vision_inspections
    `
  );

  const levelRows = await pool.query(
    `
    SELECT inspection_level, COUNT(*) AS count
    FROM drain_vision_inspections
    GROUP BY inspection_level
    `
  );

  const counts = { low: 0, moderate: 0, high: 0, critical: 0 };

  levelRows.rows.forEach((row) => {
    const key = String(row.inspection_level).toLowerCase();
    if (key in counts) counts[key] = Number(row.count);
  });

  const repeatedDrains = await pool.query(
    `
    SELECT
      d.id AS drain_id,
      d.zone_name,
      d.location,
      COUNT(v.id) AS inspections,
      MAX(v.inspection_level) AS latest_level,
      MAX(v.visual_risk_score) AS latest_score
    FROM drain_vision_inspections v
    JOIN drains d ON d.id = v.drain_id
    WHERE v.inspection_level IN ('HIGH', 'CRITICAL')
    GROUP BY d.id, d.zone_name, d.location
    HAVING COUNT(v.id) >= 2
    ORDER BY COUNT(v.id) DESC, MAX(v.visual_risk_score) DESC
    LIMIT 5
    `
  );

  const recentTrends = await pool.query(
    `
    SELECT
      to_char(date_trunc('hour', created_at), 'HH24:00') AS hour,
      ROUND(AVG(visual_risk_score)) AS avg_visual_risk,
      ROUND(AVG(possible_blockage_score)) AS avg_blockage_risk,
      COUNT(*) AS inspections
    FROM drain_vision_inspections
    WHERE created_at >= NOW() - INTERVAL '24 hours'
    GROUP BY date_trunc('hour', created_at)
    ORDER BY date_trunc('hour', created_at) ASC
    `
  );

  const recentInspections = await pool.query(
    `
    SELECT *
    FROM drain_vision_inspections
    ORDER BY created_at DESC, id DESC
    LIMIT 10
    `
  );

  return {
    totalInspections: Number(snapshot.rows[0].total),
    averageVisualRisk: Number(snapshot.rows[0].avg_visual),
    averageBlockageRisk: Number(snapshot.rows[0].avg_blockage),
    drainsInspected: Number(snapshot.rows[0].distinct_drains),
    drainsWithVisualIssues: Number(snapshot.rows[0].issue_count),
    inspectionsLast24h: Number(snapshot.rows[0].last_24h),
    counts,
    distribution: Object.entries(counts).map(([level, count]) => ({ level: level.toUpperCase(), count })),
    repeatedIssueDrains: repeatedDrains.rows.map((row) => ({
      drainId: Number(row.drain_id),
      zone: row.zone_name,
      location: row.location,
      inspections: Number(row.inspections),
      latestLevel: row.latest_level,
      latestScore: Number(row.latest_score)
    })),
    recentTrends: recentTrends.rows.map((row) => ({
      hour: row.hour,
      averageVisualRisk: Number(row.avg_visual_risk),
      averageBlockageRisk: Number(row.avg_blockage_risk),
      inspections: Number(row.inspections)
    })),
    recentInspections: recentInspections.rows.map(rowToInspection)
  };
}

// --------------------------------------------------
// Exports
// --------------------------------------------------

module.exports = {
  METHOD_NAME,
  VISION_DISCLAIMER,
  ALLOWED_MIME_TYPES,
  ALLOWED_EXTENSIONS,
  MAX_IMAGE_BYTES,
  VISION_THRESHOLDS,
  MIN_IMAGE_DIMENSION,
  VALID_FINDING_TYPES,
  clamp,
  levelFromScore,
  detectImageType,
  typeToMime,
  decodePng,
  extractFeaturesFromRgba,
  checkImageQuality,
  featuresToResult,
  getFeatures,
  insufficientPayload,
  analyzeDrainImage,
  ensureVisionAlert,
  resolveVisionAlerts,
  persistInspection,
  getLatestInspection,
  getVisionAnalytics
};
