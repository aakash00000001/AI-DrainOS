from flask import Flask, request, jsonify
import joblib
import io
import numpy as np

app = Flask(__name__)

# 5 MB upload cap for drain inspection images.
app.config["MAX_CONTENT_LENGTH"] = 5 * 1024 * 1024

# Load trained model
model = joblib.load("model.pkl")

labels = {
    0: "LOW",
    1: "MEDIUM",
    2: "HIGH"
}

# OpenCV is optional at import time: if it is not installed the
# vision endpoint reports the engine unavailable (503) so the
# backend can fall back honestly instead of crashing.
try:
    import cv2
    HAS_CV2 = True
except Exception:
    HAS_CV2 = False

VISION_METHOD_NAME = "OpenCV Engineering Baseline (Computer Vision)"

def clamp(value, lo, hi):
    return max(lo, min(hi, value))

@app.route("/predict", methods=["POST"])
def predict():
    data = request.get_json(silent=True)

    if not isinstance(data, dict):
        return jsonify({"error": "Invalid JSON body"}), 400

    missing = [k for k in ("water_level", "gas_level", "temperature") if k not in data]
    if missing:
        return jsonify({"error": "Missing fields: " + ", ".join(missing)}), 400

    try:
        water = float(data["water_level"])
        gas = float(data["gas_level"])
        temp = float(data["temperature"])
    except (TypeError, ValueError):
        return jsonify({"error": "water_level, gas_level and temperature must be numbers"}), 400

    water = clamp(water, 0, 100)
    gas = clamp(gas, 0, 100)
    temp = clamp(temp, -20, 60)

    try:
        result = model.predict([[water, gas, temp]])
    except Exception as exc:
        return jsonify({"error": "Prediction failed: " + str(exc)}), 500

    return jsonify({
        "prediction": labels[int(result[0])],
        "water_level": water,
        "gas_level": gas,
        "temperature": temp
    })


# ------------------------------------------------------------
# POST /vision/analyze
#
# Baseline computer-vision analysis of a drain inspection image.
# Accepts a multipart image ("image" field) and returns a set of
# low-level pixel features that the backend scores. It ONLY
# extracts observable pixel statistics - it is an engineering
# demo baseline, NOT a trained deep-learning detector, and it
# never reports an accuracy/confidence value.
#
# Responses:
#   200 -> { status: "READY", method, version, features: {...} }
#   200 -> { status: "INSUFFICIENT_IMAGE_QUALITY", reason, ... }
#   400 -> invalid/missing image
#   413 -> image too large (>5 MB)
#   503 -> OpenCV not installed (backend falls back locally)
# ------------------------------------------------------------

@app.route("/vision/analyze", methods=["POST"])
def vision_analyze():
    if not HAS_CV2:
        return jsonify({
            "error": "vision_unavailable",
            "message": "OpenCV is not installed in the AI service"
        }), 503

    if "image" not in request.files:
        return jsonify({"error": "Missing image field"}), 400

    file = request.files["image"]
    file_bytes = file.read()

    if not file_bytes:
        return jsonify({"error": "Empty image"}), 400

    data = np.frombuffer(file_bytes, dtype=np.uint8)
    img = cv2.imdecode(data, cv2.IMREAD_COLOR)

    if img is None:
        return jsonify({
            "status": "INSUFFICIENT_IMAGE_QUALITY",
            "reason": "Image could not be decoded by the vision engine",
            "method": VISION_METHOD_NAME,
            "version": cv2.__version__
        }), 200

    height, width = img.shape[:2]
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)

    brightness = float(np.mean(gray))
    darkness_ratio = float(np.mean(gray < 60))

    edges = cv2.Canny(gray, 50, 150)
    edge_density = float(np.mean(edges > 0))

    texture_variance = float(np.var(gray.astype(np.float32)))

    # Water-like regions: bluish hue with moderate saturation.
    water_mask = (
        (hsv[:, :, 1] >= 40) &
        (hsv[:, :, 0] >= 80) &
        (hsv[:, :, 0] <= 140)
    )
    water_like_ratio = float(np.mean(water_mask))

    # Dense irregular regions: 8x8 blocks that are both dark and
    # textured (typical of debris / waste piles).
    block_h = min(8, height)
    block_w = min(8, width)
    dense_blocks = 0.0
    total_blocks = 0.0
    brightness_b = gray.astype(np.float32)

    for y in range(0, height, block_h):
        for x in range(0, width, block_w):
            block = brightness_b[y:y + block_h, x:x + block_w]
            if block.size == 0:
                continue
            total_blocks += 1.0
            if float(np.mean(block)) < 110 and float(np.std(block)) > 20:
                dense_blocks += 1.0

    dense_region_ratio = dense_blocks / total_blocks if total_blocks > 0 else 0.0

    features = {
        "brightness": round(brightness, 2),
        "darknessRatio": round(darkness_ratio, 4),
        "edgeDensity": round(edge_density, 4),
        "textureVariance": round(min(texture_variance, 5000.0), 2),
        "waterLikeRatio": round(water_like_ratio, 4),
        "denseRegionRatio": round(dense_region_ratio, 4),
        "width": width,
        "height": height
    }

    return jsonify({
        "status": "READY",
        "method": VISION_METHOD_NAME,
        "version": cv2.__version__,
        "features": features
    })


@app.errorhandler(413)
def too_large(_err):
    return jsonify({"error": "Image exceeds the 5 MB limit"}), 413

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5001, debug=True)