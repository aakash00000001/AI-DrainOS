import { useEffect, useState } from "react";
import axios from "axios";
import socket from "../services/socket";
import { API_URL } from "../services/api";

const LEVEL_COLORS = {
  LOW: "#16a34a",
  MODERATE: "#f59e0b",
  HIGH: "#ea580c",
  CRITICAL: "#dc2626"
};

const FACTOR_COLORS = {
  "Water Level": "#2563eb",
  "Gas Level": "#9333ea",
  Temperature: "#0891b2",
  "Water Trend": "#e11d48"
};

function FloodRiskPanel() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(false);
  const [lastUpdate, setLastUpdate] = useState(null);

  const loadRisk = () => {
    axios
      .get(`${API_URL}/dashboard/risk`)
      .then((response) => {
        setData(response.data);
        setError(false);
      })
      .catch(() => {
        setError(true);
      });
  };

  useEffect(() => {
    loadRisk();

    const interval = setInterval(loadRisk, 5000);

    const onFloodRiskUpdate = (payload) => {
      setData((prev) => {
        if (!prev || !prev.topRisk || prev.topRisk.drainId !== payload.drainId) {
          return prev;
        }

        setLastUpdate(new Date());

        return {
          ...prev,
          topRisk: {
            ...prev.topRisk,
            riskScore: payload.riskScore,
            riskLevel: payload.riskLevel,
            prediction: payload.prediction,
            predictionSource: payload.predictionSource,
            waterLevel: payload.waterLevel,
            gasLevel: payload.gasLevel,
            temperature: payload.temperature,
            breakdown: payload.breakdown,
            timestamp: payload.timestamp
          }
        };
      });
    };

    socket.on("floodRiskUpdate", onFloodRiskUpdate);

    return () => {
      clearInterval(interval);
      socket.off("floodRiskUpdate", onFloodRiskUpdate);
    };
  }, []);

  if (error && !data) {
    return (
      <div className="panel-card">
        <h2>🌊 Flood Risk Intelligence</h2>
        <p className="empty-state">
          Flood risk data unavailable - check that the backend is running.
        </p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="panel-card">
        <h2>🌊 Flood Risk Intelligence</h2>
        <p className="empty-state">Loading flood risk intelligence...</p>
      </div>
    );
  }

  const { topRisk, summary } = data;

  if (!topRisk) {
    return (
      <div className="panel-card">
        <h2>🌊 Flood Risk Intelligence</h2>
        <p className="empty-state">
          No sensor data yet - run a sensor simulator to see flood risk.
        </p>
      </div>
    );
  }

  const levelColor = LEVEL_COLORS[topRisk.riskLevel] || "#64748b";
  const factors = topRisk.factors || [];
  const highest = Math.max(100, 1);

  return (
    <div className="panel-card">
      <div className="card-header">
        <h2>🌊 Flood Risk Intelligence</h2>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "24px",
          flexWrap: "wrap"
        }}
      >
        <div style={{ minWidth: "180px" }}>
          <div style={{ fontSize: "44px", fontWeight: "bold", color: "#0f172a" }}>
            {topRisk.riskScore} <span style={{ fontSize: "20px", color: "#64748b" }}>/ 100</span>
          </div>
          <div
            style={{
              display: "inline-block",
              padding: "6px 18px",
              borderRadius: "50px",
              fontSize: "16px",
              fontWeight: "bold",
              color: "#ffffff",
              background: levelColor
            }}
          >
            {topRisk.riskLevel}
          </div>
        </div>

        <div style={{ minWidth: "220px", lineHeight: 1.9 }}>
          <p style={{ margin: 0 }}>
            📍 <b>{topRisk.location}</b>
          </p>
          <p style={{ margin: 0 }}>
            🌊 Water Level: <b>{topRisk.waterLevel}%</b>
          </p>
          <p style={{ margin: 0 }}>
            💨 Gas Level: <b>{topRisk.gasLevel}</b>
          </p>
          <p style={{ margin: 0 }}>
            🌡 Temperature: <b>{topRisk.temperature}°C</b>
          </p>
          <p style={{ margin: 0 }}>
            🤖 AI Prediction:{" "}
            <b style={{ color: LEVEL_COLORS[topRisk.prediction] || "#0f172a" }}>
              {topRisk.prediction || "n/a"}
            </b>{" "}
            <span style={{ color: "#64748b", fontSize: "12px" }}>
              ({topRisk.predictionSource || "fallback"})
            </span>
          </p>
        </div>
      </div>

      <hr />

      <h3>Why is this drain at {topRisk.riskLevel} risk?</h3>

      <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
        {factors.map((factor) => (
          <div key={factor.name}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontSize: "13px",
                marginBottom: "4px"
              }}
            >
              <span>
                {factor.name}
                {factor.label ? ` (${factor.label})` : ""}
              </span>
              <span>
                <b>{factor.contribution}</b> / 100
              </span>
            </div>
            <div
              style={{
                background: "#e2e8f0",
                borderRadius: "6px",
                height: "10px",
                overflow: "hidden"
              }}
            >
              <div
                style={{
                  width: `${Math.min(100, (factor.contribution / highest) * 100)}%`,
                  height: "100%",
                  background: FACTOR_COLORS[factor.name] || "#64748b",
                  borderRadius: "6px"
                }}
              />
            </div>
          </div>
        ))}
      </div>

      {summary && (
        <div
          style={{
            marginTop: "16px",
            display: "flex",
            gap: "16px",
            flexWrap: "wrap",
            color: "#334155",
            fontSize: "13px"
          }}
        >
          <span>📊 Avg Risk: <b>{summary.averageRiskScore}</b></span>
          <span>🟢 LOW: <b>{summary.counts.low}</b></span>
          <span>🟡 MODERATE: <b>{summary.counts.moderate}</b></span>
          <span>🟠 HIGH: <b>{summary.counts.high}</b></span>
          <span>🔴 CRITICAL: <b>{summary.counts.critical}</b></span>
        </div>
      )}

      <p style={{ color: "#64748b", fontSize: "12px", marginTop: "12px" }}>
        {lastUpdate
          ? `⚡ Live update at ${lastUpdate.toLocaleTimeString()}`
          : `Updated from latest sensor data`}
      </p>
    </div>
  );
}

export default FloodRiskPanel;