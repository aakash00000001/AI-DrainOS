from flask import Flask, request, jsonify
import joblib

app = Flask(__name__)

# Load trained model
model = joblib.load("model.pkl")

labels = {
    0: "LOW",
    1: "MEDIUM",
    2: "HIGH"
}

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

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5001, debug=True)