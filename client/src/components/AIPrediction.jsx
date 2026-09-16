import { useEffect, useState } from "react";
import axios from "axios";
import { API_URL } from "../services/api";

function AIPrediction() {
  const [prediction, setPrediction] = useState(null);
  const [error, setError] = useState("");

  const showNotification = (risk) => {
    if (!("Notification" in window)) {
      return;
    }

    if (Notification.permission !== "granted") {
      return;
    }

    if (risk === "HIGH") {
      new Notification("🚨 AI-DrainOS Alert", {
        body: "High Flood Risk Detected! Immediate Action Required.",
      });
    }

    if (risk === "MEDIUM") {
      new Notification("⚠️ AI-DrainOS Alert", {
        body: "Medium Flood Risk. Monitor Drain Conditions.",
      });
    }
  };

  const loadPrediction = async () => {
    try {
      const response = await axios.get(
        `${API_URL}/predictions`
      );

      console.log("🤖 AI Prediction:", response.data);

      setPrediction(response.data);
      setError("");

      showNotification(response.data.prediction);
    } catch (err) {
      console.error("❌ Prediction Error:", err);

      setError("Unable to load AI prediction.");
    }
  };

  useEffect(() => {
    if (
      "Notification" in window &&
      Notification.permission === "default"
    ) {
      Notification.requestPermission();
    }

    loadPrediction();

    const interval = setInterval(() => {
      loadPrediction();
    }, 5000);

    return () => {
      clearInterval(interval);
    };
  }, []);

  if (error) {
    return (
      <div
        style={{
          background: "#fee2e2",
          color: "#b91c1c",
          padding: "20px",
          borderRadius: "12px",
          marginBottom: "20px",
        }}
      >
        ❌ {error}
      </div>
    );
  }

  if (!prediction) {
    return (
      <div
        style={{
          background: "#eff6ff",
          padding: "20px",
          borderRadius: "12px",
          marginBottom: "20px",
        }}
      >
        🤖 Loading AI Prediction...
      </div>
    );
  }

  const risk = prediction.prediction;

  return (
    <div
      style={{
        background: "#ffffff",
        padding: "24px",
        borderRadius: "18px",
        boxShadow: "0 8px 25px rgba(0,0,0,0.08)",
        marginBottom: "20px",
      }}
    >
      <h2>🤖 AI Flood Prediction</h2>

      <div
        style={{
          display: "inline-block",
          padding: "12px 30px",
          borderRadius: "50px",
          fontSize: "28px",
          fontWeight: "bold",
          color: "#ffffff",
          background:
            risk === "HIGH"
              ? "#ef4444"
              : risk === "MEDIUM"
              ? "#f59e0b"
              : "#22c55e",
          marginBottom: "20px",
        }}
      >
        {risk}
      </div>

      <hr />

      <h3>📡 Latest Sensor Values</h3>

      <p>
        🌊 Water Level :{" "}
        <b>{prediction.sensor?.water_level ?? "N/A"}</b>
      </p>

      <p>
        🧪 Gas Level :{" "}
        <b>{prediction.sensor?.gas_level ?? "N/A"}</b>
      </p>

      <p>
        🌡 Temperature :{" "}
        <b>{prediction.sensor?.temperature ?? "N/A"}°C</b>
      </p>

      <br />

      {risk === "HIGH" && (
        <div
          style={{
            background: "#fee2e2",
            color: "#b91c1c",
            padding: "15px",
            borderRadius: "10px",
            fontWeight: "bold",
          }}
        >
          🚨 HIGH FLOOD RISK
          <br />
          Immediate Drain Cleaning Required
        </div>
      )}

      {risk === "MEDIUM" && (
        <div
          style={{
            background: "#fef3c7",
            color: "#92400e",
            padding: "15px",
            borderRadius: "10px",
            fontWeight: "bold",
          }}
        >
          ⚠️ MEDIUM FLOOD RISK
          <br />
          Keep Monitoring Sensors
        </div>
      )}

      {risk === "LOW" && (
        <div
          style={{
            background: "#dcfce7",
            color: "#166534",
            padding: "15px",
            borderRadius: "10px",
            fontWeight: "bold",
          }}
        >
          ✅ SAFE CONDITION
          <br />
          No Flood Risk Detected
        </div>
      )}
    </div>
  );
}

export default AIPrediction;