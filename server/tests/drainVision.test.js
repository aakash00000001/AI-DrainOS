// ============================================================
// AI-DrainOS Drain Vision Inspection tests
//
// Cover the baseline computer-vision service (field extraction,
// scoring, thresholds, honesty contract, image-quality gate,
// PNG decode fallback, type detection), the DB audit trail, the
// alert workflow ('Vision Inspection'), the Socket.IO update,
// and the new REST endpoints.
//
// HONESTY CONTRACT: no READY result may include a confidence
// value or claim to "prove" a physical blockage.
//
// The AI service is intentionally unreachable in these tests
// (AI_SERVICE_URL points at a closed port) so every analysis runs
// through the deterministic local PNG fallback.
// ============================================================

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const zlib = require("zlib");

process.env.AI_SERVICE_URL = "http://127.0.0.1:1";

const { setup } = require("./helpers");

let app;
let pool;
let vision;
let socketHub;

// --------------------------------------------------
// Test image builders (deterministic, CRC-free PNGs)
// --------------------------------------------------

function buildPng(width, height, pixelFn) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0; // no interlace

  const ihdrChunk = Buffer.concat([
    Buffer.from([0, 0, 0, 13]),
    Buffer.from("IHDR"),
    ihdr,
    Buffer.from([0, 0, 0, 0])
  ]);

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);

  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixelFn(x, y);
      const offset = y * (stride + 1) + 1 + x * 4;
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
      raw[offset + 3] = a;
    }
  }

  const idatData = zlib.deflateSync(raw);
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(idatData.length, 0);

  const idatChunk = Buffer.concat([
    lenBuf,
    Buffer.from("IDAT"),
    idatData,
    Buffer.from([0, 0, 0, 0])
  ]);

  const iendChunk = Buffer.concat([
    Buffer.from([0, 0, 0, 0]),
    Buffer.from("IEND"),
    Buffer.from([0, 0, 0, 0])
  ]);

  return Buffer.concat([sig, ihdrChunk, idatChunk, iendChunk]);
}

const brightPixels = () => [220, 225, 230, 255];

// Dark/light checkerboard -> strong edge activity + dark regions
// (deterministically HIGH).
const checkerPixels = (x, y) =>
  (x + y) % 2 === 0 ? [10, 10, 15, 255] : [185, 190, 200, 255];

const blackPixels = () => [5, 5, 5, 255];

const tiny = buildPng(8, 8, brightPixels);
const brightImage = buildPng(64, 64, brightPixels);
const checkerImage = buildPng(64, 64, checkerPixels);
const blackImage = buildPng(64, 64, blackPixels);

const fakeJpegBytes = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46,
  0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01
]);

before(async () => {
  ({ app, pool } = await setup());

  // Require after setup so config/db binds to the test database
  vision = require("../services/drainVisionService");
  socketHub = require("../services/socketHub");
});

after(async () => {
  socketHub.init(null);
  await pool.end();
});

// --------------------------------------------------
// 1-3. Threshold boundaries for the inspection level
// --------------------------------------------------

test("1. Threshold: LOW to MODERATE at 25", () => {
  assert.equal(vision.levelFromScore(0), "LOW");
  assert.equal(vision.levelFromScore(24), "LOW");
  assert.equal(vision.levelFromScore(25), "MODERATE");
  assert.equal(vision.levelFromScore(49), "MODERATE");
});

test("2. Threshold: MODERATE to HIGH at 50", () => {
  assert.equal(vision.levelFromScore(50), "HIGH");
  assert.equal(vision.levelFromScore(74), "HIGH");
});

test("3. Threshold: HIGH to CRITICAL at 75", () => {
  assert.equal(vision.levelFromScore(75), "CRITICAL");
  assert.equal(vision.levelFromScore(100), "CRITICAL");
});

// --------------------------------------------------
// 4. Clean bright image -> LOW, no robot recommendation
// --------------------------------------------------

test("4. Clear image scores LOW with a normal finding", () => {
  const decoded = vision.decodePng(brightImage);
  assert.ok(decoded, "bright image should decode");
  assert.equal(decoded.width, 64);
  assert.equal(decoded.height, 64);

  const features = vision.extractFeaturesFromRgba(
    decoded.width,
    decoded.height,
    decoded.rgba
  );

  const result = vision.featuresToResult(features);

  assert.equal(result.status, "READY");
  assert.equal(result.inspectionLevel, "LOW");
  assert.ok(result.visualRiskScore < 25);
  assert.equal(result.robotInspectionRecommended, false);
  assert.ok(result.findings.some((f) => f.type === "normal"));
  assert.equal(result.imageQuality.decodable, true);
});

// --------------------------------------------------
// 5. Dark/light checkerboard -> HIGH with robot flag
// --------------------------------------------------

test("5. Dark textured image scores HIGH and recommends inspection", () => {
  const decoded = vision.decodePng(checkerImage);
  const features = vision.extractFeaturesFromRgba(
    decoded.width,
    decoded.height,
    decoded.rgba
  );

  const result = vision.featuresToResult(features);

  assert.equal(result.status, "READY");
  assert.ok(
    result.visualRiskScore >= 50,
    `expected HIGH, got visualRiskScore ${result.visualRiskScore}`
  );
  assert.ok(
    result.inspectionLevel === "HIGH" || result.inspectionLevel === "CRITICAL",
    `expected HIGH or CRITICAL, got ${result.inspectionLevel}`
  );
  assert.equal(result.robotInspectionRecommended, true);
  assert.ok(result.findings.some((f) => f.type === "possible_blockage"));
  assert.ok(typeof result.possibleBlockageScore === "number");
});

// --------------------------------------------------
// 6. Honesty: never claim confidence or "blocked"
// --------------------------------------------------

test("6. Honesty: no confidence and no definitive blocked claim", () => {
  const decoded = vision.decodePng(checkerImage);
  const features = vision.extractFeaturesFromRgba(
    decoded.width,
    decoded.height,
    decoded.rgba
  );

  const result = vision.featuresToResult(features);
  const allText = JSON.stringify(result).toLowerCase();

  assert.ok(!allText.includes("confidence"), "must not mention confidence");
  assert.ok(!allText.includes("blocked"), "must not say blocked");
  assert.ok(!allText.includes("accuracy"), "must not mention accuracy");
  assert.ok(vision.VISION_DISCLAIMER.includes("does NOT prove"));
  assert.ok(Array.isArray(result.limitations) && result.limitations.length > 0);
});

// --------------------------------------------------
// 7-8. Type detection from magic bytes
// --------------------------------------------------

test("7. detectImageType identifies png/jpeg/webp by magic bytes", () => {
  assert.equal(vision.detectImageType(brightImage), "png");

  const jpeg = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff]),
    Buffer.from([0, 0, 0, 0, 0])
  ]);
  assert.equal(vision.detectImageType(jpeg), "jpeg");

  const webp = Buffer.concat([
    Buffer.from("RIFF" + "0000", "ascii"),
    Buffer.from("WEBP", "ascii"),
    Buffer.from([0, 0, 0, 0])
  ]);
  assert.equal(vision.detectImageType(webp), "webp");

  assert.equal(vision.detectImageType(Buffer.from("not an image")), null);
  assert.equal(vision.detectImageType(null), null);
});

test("8. decodePng rejects non-PNG and corrupt data", () => {
  assert.equal(vision.decodePng(Buffer.from("hello world")), null);
  assert.equal(vision.decodePng(fakeJpegBytes), null);
});

// --------------------------------------------------
// 9. Image-quality gate reports unusable images honestly
// --------------------------------------------------

test("9. Image-quality gate: black and tiny images are rejected honestly", () => {
  const decodedBlack = vision.decodePng(blackImage);
  const blackFeatures = vision.extractFeaturesFromRgba(
    decodedBlack.width,
    decodedBlack.height,
    decodedBlack.rgba
  );
  assert.ok(vision.checkImageQuality(blackFeatures));

  const decodedTiny = vision.decodePng(tiny);
  const tinyFeatures = vision.extractFeaturesFromRgba(
    decodedTiny.width,
    decodedTiny.height,
    decodedTiny.rgba
  );
  assert.ok(vision.checkImageQuality(tinyFeatures));

  const decodedBright = vision.decodePng(brightImage);
  const brightFeatures = vision.extractFeaturesFromRgba(
    decodedBright.width,
    decodedBright.height,
    decodedBright.rgba
  );
  assert.equal(vision.checkImageQuality(brightFeatures), null);
});

// --------------------------------------------------
// 10. POST /api/predictions/vision/:drainId - clear image
// --------------------------------------------------

test("10. POST vision: clear image yields READY LOW and persists", async () => {
  const res = await request(app)
    .post("/api/predictions/vision/1")
    .attach("image", brightImage, { filename: "clear.png", contentType: "image/png" })
    .expect(200);

  assert.equal(res.body.status, "READY");
  assert.equal(res.body.drainId, 1);
  assert.equal(res.body.inspectionLevel, "LOW");
  assert.ok(typeof res.body.visualRiskScore === "number");
  assert.ok(typeof res.body.possibleBlockageScore === "number");
  assert.equal(res.body.robotInspectionRecommended, false);

  // Audit trail row written
  const rows = await pool.query(
    "SELECT * FROM drain_vision_inspections WHERE drain_id = 1 ORDER BY created_at DESC LIMIT 1"
  );
  assert.ok(rows.rows.length > 0, "inspection should be persisted");
  assert.equal(Number(rows.rows[0].drain_id), 1);
  assert.equal(rows.rows[0].inspection_level, "LOW");
  assert.ok(rows.rows[0].image_metadata !== null);
});

// --------------------------------------------------
// 11-14. Error and honest-failure cases
// --------------------------------------------------

test("11. POST vision: unknown drain returns 404", async () => {
  const res = await request(app)
    .post("/api/predictions/vision/9999")
    .attach("image", brightImage, { filename: "clear.png", contentType: "image/png" })
    .expect(404);

  assert.ok(res.body.error);
});

test("12. POST vision: missing image returns 400", async () => {
  const res = await request(app)
    .post("/api/predictions/vision/1")
    .send({})
    .expect(400);

  assert.ok(res.body.error);
});

test("13. POST vision: garbage bytes (valid PNG name) rejected as 400", async () => {
  const res = await request(app)
    .post("/api/predictions/vision/1")
    .attach("image", Buffer.from("this is not an image at all"), {
      filename: "fake.png",
      contentType: "image/png"
    })
    .expect(400);

  assert.ok(res.body.error);
});

test("14. POST vision: oversize image rejected with 5 MB limit message", async () => {
  const big = Buffer.alloc(5 * 1024 * 1024 + 1);

  const res = await request(app)
    .post("/api/predictions/vision/1")
    .attach("image", big, { filename: "big.png", contentType: "image/png" })
    .expect(400);

  assert.ok(res.body.error.includes("5 MB"));
});

// --------------------------------------------------
// 15. POST vision: effectively black image -> INSUFFICIENT_IMAGE_QUALITY
// --------------------------------------------------

test("15. POST vision: black image returns INSUFFICIENT_IMAGE_QUALITY", async () => {
  const res = await request(app)
    .post("/api/predictions/vision/1")
    .attach("image", blackImage, { filename: "black.png", contentType: "image/png" })
    .expect(200);

  assert.equal(res.body.status, "INSUFFICIENT_IMAGE_QUALITY");
  assert.ok(res.body.reason);
  assert.equal(res.body.visualRiskScore, null);
  assert.equal(res.body.inspectionLevel, null);
});

// --------------------------------------------------
// 16. POST vision: undecodable JPEG with AI down is honest
//     INSUFFICIENT_IMAGE_QUALITY (local fallback only decodes PNG)
// --------------------------------------------------

test("16. POST vision: undecodable format reports INSUFFICIENT honestly", async () => {
  const res = await request(app)
    .post("/api/predictions/vision/1")
    .attach("image", fakeJpegBytes, { filename: "photo.jpg", contentType: "image/jpeg" })
    .expect(200);

  assert.equal(res.body.status, "INSUFFICIENT_IMAGE_QUALITY");
  assert.ok(res.body.reason);
});

// --------------------------------------------------
// 17. GET /api/predictions/vision/:drainId - latest + history
// --------------------------------------------------

test("17. GET vision: latest inspection returns with history", async () => {
  const res = await request(app)
    .get("/api/predictions/vision/1")
    .expect(200);

  assert.equal(res.body.drainId, 1);
  assert.equal(res.body.status, "READY");
  assert.ok(typeof res.body.inspectionLevel === "string");
  assert.ok(Array.isArray(res.body.findings));
  assert.ok(Array.isArray(res.body.history));
  assert.ok(res.body.history.length > 0);
});

test("17b. GET vision: drain without inspections returns 404", async () => {
  const res = await request(app)
    .get("/api/predictions/vision/9999")
    .expect(404);

  assert.ok(res.body.error);
});

// --------------------------------------------------
// 18-20. Alert workflow: create, dedupe, upgrade, resolve
// --------------------------------------------------

test("18. Alert: HIGH inspection creates a single Open Medium alert", async () => {
  // Clear any prior Vision Inspection alerts for drain 1
  await pool.query(
    "UPDATE alerts SET alert_status = 'Resolved' WHERE drain_id = 1 AND alert_type = 'Vision Inspection'"
  );

  await request(app)
    .post("/api/predictions/vision/1")
    .attach("image", checkerImage, { filename: "debris.png", contentType: "image/png" })
    .expect(200);

  const rows = await pool.query(
    `SELECT * FROM alerts
     WHERE drain_id = 1 AND alert_type = 'Vision Inspection' AND alert_status = 'Open'
     ORDER BY id ASC`
  );

  assert.equal(rows.rows.length, 1, "should have exactly one open alert");
  assert.equal(rows.rows[0].severity, "Medium");

  // Second inspection must NOT create a second alert (dedupe)
  await request(app)
    .post("/api/predictions/vision/1")
    .attach("image", checkerImage, { filename: "debris2.png", contentType: "image/png" })
    .expect(200);

  const after = await pool.query(
    `SELECT COUNT(*) AS count FROM alerts
     WHERE drain_id = 1 AND alert_type = 'Vision Inspection' AND alert_status = 'Open'`
  );
  assert.equal(Number(after.rows[0].count), 1, "dedupe: still one open alert");
});

test("19. Alert: clear inspection resolves the open Vision Inspection alert", async () => {
  await request(app)
    .post("/api/predictions/vision/1")
    .attach("image", brightImage, { filename: "clear.png", contentType: "image/png" })
    .expect(200);

  const rows = await pool.query(
    `SELECT * FROM alerts
     WHERE drain_id = 1 AND alert_type = 'Vision Inspection' AND alert_status = 'Open'`
  );

  assert.equal(rows.rows.length, 0, "alert should be resolved after clear inspection");
});

test("20. Alert helper: upgrade to Critical and resolve", async () => {
  const created = await vision.ensureVisionAlert({
    drainId: 2,
    location: "Test Zone",
    severity: "Medium",
    message: "Vision inspection HIGH (visual risk 60/100) at Test Zone"
  });
  assert.equal(created.action, "created");

  const upgraded = await vision.ensureVisionAlert({
    drainId: 2,
    location: "Test Zone",
    severity: "Critical",
    message: "Vision inspection CRITICAL (visual risk 80/100) at Test Zone"
  });
  assert.equal(upgraded.action, "upgraded");

  const kept = await vision.ensureVisionAlert({
    drainId: 2,
    location: "Test Zone",
    severity: "Critical",
    message: "Vision inspection CRITICAL again"
  });
  assert.equal(kept.action, "kept");

  const rows = await pool.query(
    `SELECT * FROM alerts
     WHERE drain_id = 2 AND alert_type = 'Vision Inspection' AND alert_status = 'Open'`
  );
  assert.equal(rows.rows.length, 1, "single alert even after upgrade attempts");
  assert.equal(rows.rows[0].severity, "Critical");

  const resolvedCount = await vision.resolveVisionAlerts(2);
  assert.equal(resolvedCount, 1);
});

// --------------------------------------------------
// 21-22. Analytics endpoints
// --------------------------------------------------

test("21. Analytics: GET /api/analytics/vision returns summary", async () => {
  const res = await request(app)
    .get("/api/analytics/vision")
    .expect(200);

  assert.ok(res.body.totalInspections >= 1);
  assert.ok(typeof res.body.averageVisualRisk === "number");
  assert.ok(typeof res.body.drainsInspected === "number");
  assert.ok(typeof res.body.counts.low === "number");
  assert.ok(Array.isArray(res.body.distribution));
  assert.ok(Array.isArray(res.body.recentTrends));
  assert.ok(Array.isArray(res.body.recentInspections));
});

test("22. Analytics: GET /api/analytics includes additive vision fields", async () => {
  const res = await request(app)
    .get("/api/analytics")
    .expect(200);

  assert.ok(typeof res.body.vision_total_inspections === "number");
  assert.ok(typeof res.body.vision_average_visual_risk === "number");
  assert.ok(typeof res.body.vision_low === "number");
  assert.ok(Array.isArray(res.body.vision_distribution));
});

// --------------------------------------------------
// 23. SocketHub: safe no-op without io, forwards with io
// --------------------------------------------------

test("23. SocketHub: emit is safe without io and forwards with io", () => {
  assert.doesNotThrow(() =>
    socketHub.emit("visionInspectionUpdate", { drainId: 1 })
  );

  const emitted = [];
  socketHub.init({
    emit(event, payload) {
      emitted.push({ event, payload });
    }
  });

  socketHub.emit("visionInspectionUpdate", { drainId: 1, inspectionLevel: "HIGH" });

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].event, "visionInspectionUpdate");
  assert.equal(emitted[0].payload.inspectionLevel, "HIGH");
});