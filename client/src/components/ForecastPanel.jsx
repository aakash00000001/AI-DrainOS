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

const TREND_DIRECTION_LABELS = {
  RAPIDLY_RISING: "Rising fast",
  RISING: "Rising",
  STABLE: "Stable",
  FALLING: "Falling",
  RAPIDLY_FALLING: "Falling fast"
};

function ForecastPanel() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(false);
  const [lastUpdate, setLastUpdate] = useState(null);

  const loadForecast = () => {
    axios
      .get(`${API_URL}/dashboard/forecast`)
      .then((response) => {
        setData(response.data);
        setError(false);
      })
      .catch(() => {
        setError(true);
      });
  };

  useEffect(() => {
    loadForecast();

    const interval = setInterval(loadForecast, 5000);

    const onForecastUpdate = (payload) => {
      setData((prev) => {
        if (!prev || !prev.topForecast || prev.topForecast.drainId !== payload.drainId) {
          return prev;
        }

        setLastUpdate(new Date());

        return {
          ...prev,
          topForecast: {
            ...prev.topForecast,
            currentRiskScore: payload.currentRiskScore,
            currentRiskLevel: payload.currentRiskLevel,
            method: payload.method,
            trendDirection: payload.trendDirection,
            waterTrendPerMinute: payload.waterTrendPerMinute,
            horizons: payload.horizons,
            worst: payload.worst,
            timestamp: payload.timestamp
          }
        };
      });
    };

    socket.on("forecastUpdate", onForecastUpdate);

    return () => {
      clearInterval(interval);
      socket.off("forecastUpdate", onForecastUpdate);
    };
  }, []);

  if (error && !data) {
    return (
      <div className="panel-card">
        <h2>🔮 Predictive Flood Forecast</h2>
        <p className="empty-state">
          Forecast data unavailable - check that the backend is running.
        </p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="panel-card">
        <h2>🔮 Predictive Flood Forecast</h2>
        <p className="empty-state">Loading flood forecast...</p>
      </div>
    );
  }

  const { topForecast, summary } = data;

  if (!topForecast) {
    return (
      <div className="panel-card">
        <h2>🔮 Predictive Flood Forecast</h2>
        <p className="empty-state">
          Insufficient sensor history for forecasts - run the sensor simulator to
          generate trend data.
        </p>
      </div>
    );
  }

  const currentLevelColor =
    LEVEL_COLORS[topForecast.currentRiskLevel] || "#64748b";
  const trendLabel =
    TREND_DIRECTION_LABELS[topForecast.trendDirection] ||
    topForecast.trendDirection;
  const worst = topForecast.worst || {};
  const worstColor = LEVEL_COLORS[worst.predictedRiskLevel] || "#64748b";
  const horizons = topForecast.horizons || [];
  const trendRate = topForecast.waterTrendPerMinute;

  return (
    <div className="panel-card">
      <div className="card-header">
        <h2>🔮 Predictive Flood Forecast</h2>
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
          <div
            style={{
              fontSize: "44px",
              fontWeight: "bold",
              color: "#0f172a"
            }}
          >
            {worst.predictedRiskScore !== undefined
              ? worst.predictedRiskScore
              : "n/a"}{" "}
            <span style={{ fontSize: "20px", color: "#64748b" }}>/ 100</span>
          </div>
          <div
            style={{
              display: "inline-block",
              padding: "6px 18px",
              borderRadius: "50px",
              fontSize: "16px",
              fontWeight: "bold",
              color: "#ffffff",
              background: worstColor
            }}
          >
            {worst.predictedRiskLevel || "n/a"} (worst horizon)
          </div>
        </div>

        <div style={{ minWidth: "220px", lineHeight: 1.9 }}>
          <p style={{ margin: 0 }}>
            📍 <b>{topForecast.location}</b>
          </p>
          <p style={{ margin: 0 }}>
            🌊 Water Level Now: <b>{topForecast.currentWaterLevel}%</b>
          </p>
          <p style={{ margin: 0 }}>
            📊 Current Risk:{" "}
            <b style={{ color: currentLevelColor }}>
              {topForecast.currentRiskScore}/100 ({topForecast.currentRiskLevel})
            </b>
          </p>
          <p style={{ margin: 0 }}>
            📈 Trend: <b>{trendLabel}</b>
            {trendRate !== null && trendRate !== undefined && (
              <span style={{ color: "#64748b", fontSize: "12px", marginLeft: "6px" }}>
                {trendRate > 0 ? "+" : ""}
                {trendRate} %/min
              </span>
            )}
          </p>
        </div>
      </div>

      <hr />

      <h3>15 / 30 / 60 minute forecast</h3>

      <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
        {horizons.map((h) => {
          const color = LEVEL_COLORS[h.predictedRiskLevel] || "#64748b";
          return (
            <div
              key={h.forecastMinutes}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "10px 14px",
                background: "#f8fafc",
                borderRadius: "10px",
                border: "1px solid #e2e8f0"
              }}
            >
              <div style={{ fontSize: "14px" }}>
                <b>{h.forecastMinutes} min</b>
                <span style={{ marginLeft: "12px", color: "#64748b" }}>
                  {h.predictedWaterLevel}% water
                </span>
              </div>
              <div
                style={{
                  display: "inline-block",
                  padding: "4px 14px",
                  borderRadius: "50px",
                  fontSize: "14px",
                  fontWeight: "bold",
                  color: "#ffffff",
                  background: color
                }}
              >
                {h.predictedRiskLevel} ({h.predictedRiskScore})
              </div>
            </div>
          );
        })}
      </div>

      {summary && summary.counts && (
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
          <span>
            📊 Avg 60-min Risk:{" "}
            <b>{summary.averagePredictedRiskScore}</b>
          </span>
          <span>
            🟢 LOW: <b>{summary.counts.low}</b>
          </span>
          <span>
            🟡 MODERATE: <b>{summary.counts.moderate}</b>
          </span>
          <span>
            🟠 HIGH: <b>{summary.counts.high}</b>
          </span>
          <span>
            🔴 CRITICAL: <b>{summary.counts.critical}</b>
          </span>
        </div>
      )}

      <p style={{ color: "#64748b", fontSize: "12px", marginTop: "12px" }}>
        Model: {topForecast.method}. Not a scientifically validated forecast.
        {lastUpdate
          ? ` ⚡ Live at ${lastUpdate.toLocaleTimeString()}`
          : " Updated from latest sensor data"}
      </p>
    </div>
  );
}

export default ForecastPanel;