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

const PRIORITY_COLORS = {
  LOW: "#16a34a",
  MEDIUM: "#f59e0b",
  HIGH: "#ea580c",
  CRITICAL: "#dc2626"
};

// Renders the 0-100 score as a small colored bar.
function ScoreBar({ score }) {
  if (score === null || score === undefined) {
    return <span style={{ color: "#64748b" }}>n/a</span>;
  }

  const color = LEVEL_COLORS[
    score >= 75 ? "CRITICAL" : score >= 50 ? "HIGH" : score >= 25 ? "MODERATE" : "LOW"
  ] || "#64748b";

  return (
    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
      <div
        style={{
          width: "120px",
          height: "8px",
          background: "#e2e8f0",
          borderRadius: "6px",
          overflow: "hidden"
        }}
      >
        <div
          style={{
            width: `${score}%`,
            height: "100%",
            background: color,
            borderRadius: "6px"
          }}
        />
      </div>
      <b>{score}/100</b>
    </div>
  );
}

function MaintenancePanel() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(false);
  const [lastUpdate, setLastUpdate] = useState(null);

  const loadMaintenance = () => {
    axios
      .get(`${API_URL}/dashboard/maintenance`)
      .then((response) => {
        setData(response.data);
        setError(false);
      })
      .catch(() => {
        setError(true);
      });
  };

  useEffect(() => {
    loadMaintenance();

    const interval = setInterval(loadMaintenance, 5000);

    const onMaintenanceUpdate = (payload) => {
      setData((prev) => {
        if (!prev || !prev.summary || !prev.summary.topMaintenance) {
          return prev;
        }

        if (prev.summary.topMaintenance.drainId !== payload.drainId) {
          return prev;
        }

        setLastUpdate(new Date());

        return {
          ...prev,
          summary: {
            ...prev.summary,
            topMaintenance: {
              ...prev.summary.topMaintenance,
              maintenanceScore: payload.maintenanceScore,
              maintenanceLevel: payload.maintenanceLevel,
              blockageRiskScore: payload.blockageRiskScore,
              blockageRiskLevel: payload.blockageRiskLevel,
              inspectionPriority: payload.inspectionPriority,
              maintenanceRecommendation: payload.maintenanceRecommendation
            }
          }
        };
      });
    };

    socket.on("maintenanceUpdate", onMaintenanceUpdate);

    return () => {
      clearInterval(interval);
      socket.off("maintenanceUpdate", onMaintenanceUpdate);
    };
  }, []);

  if (error && !data) {
    return (
      <div className="panel-card">
        <h2>🛠️ Drain Maintenance Prediction</h2>
        <p className="empty-state">
          Maintenance data unavailable - check that the backend is running.
        </p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="panel-card">
        <h2>🛠️ Drain Maintenance Prediction</h2>
        <p className="empty-state">Loading maintenance prediction...</p>
      </div>
    );
  }

  const { summary, drains } = data;

  if (!summary || !summary.topMaintenance) {
    return (
      <div className="panel-card">
        <h2>🛠️ Drain Maintenance Prediction</h2>
        <p className="empty-state">
          Insufficient sensor history for maintenance predictions - run the sensor
          simulator to generate trend data.
        </p>
      </div>
    );
  }

  const top = summary.topMaintenance;
  const maintenanceColor = LEVEL_COLORS[top.maintenanceLevel] || "#64748b";
  const blockageColor = LEVEL_COLORS[top.blockageRiskLevel] || "#64748b";
  const priorityColor = PRIORITY_COLORS[top.inspectionPriority] || "#64748b";
  const list = drains || [];

  return (
    <div className="panel-card">
      <div className="card-header">
        <h2>🛠️ Drain Maintenance Prediction</h2>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "24px",
          flexWrap: "wrap"
        }}
      >
        <div style={{ minWidth: "200px" }}>
          <div
            style={{
              display: "inline-block",
              padding: "6px 18px",
              borderRadius: "50px",
              fontSize: "16px",
              fontWeight: "bold",
              color: "#ffffff",
              background: maintenanceColor
            }}
          >
            {top.maintenanceScore}/100 ({top.maintenanceLevel})
          </div>
          <div style={{ marginTop: "6px", color: "#334155", fontSize: "13px" }}>
            Maintenance priority:{" "}
            <b style={{ color: priorityColor }}>{top.inspectionPriority}</b>
          </div>
        </div>

        <div style={{ minWidth: "240px", lineHeight: 1.9 }}>
          <p style={{ margin: 0 }}>
            📍 <b>{top.location}</b> ({top.zone})
          </p>
          <p style={{ margin: 0 }}>
            🚧 Blockage Risk:{" "}
            <b style={{ color: blockageColor }}>
              {top.blockageRiskScore}/100 ({top.blockageRiskLevel})
            </b>
          </p>
          <p style={{ margin: 0 }}>
            💡 Recommendation: <b>{top.maintenanceRecommendation}</b>
          </p>
        </div>
      </div>

      <hr />

      <h3>Drain maintenance overview</h3>

      <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
        {list.map((drain) => {
          const levelColor = LEVEL_COLORS[drain.maintenanceLevel] || "#64748b";
          return (
            <div
              key={drain.drainId}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: "12px",
                flexWrap: "wrap",
                padding: "10px 14px",
                background: "#f8fafc",
                borderRadius: "10px",
                border: "1px solid #e2e8f0"
              }}
            >
              <div style={{ fontSize: "14px" }}>
                <b>{drain.location}</b>
                <span style={{ marginLeft: "12px", color: "#64748b" }}>
                  maintenance
                </span>
                <span
                  style={{
                    display: "inline-block",
                    marginLeft: "8px",
                    padding: "2px 10px",
                    borderRadius: "50px",
                    fontSize: "12px",
                    fontWeight: "bold",
                    color: "#ffffff",
                    background: levelColor
                  }}
                >
                  {drain.maintenanceLevel} ({drain.maintenanceScore})
                </span>
                <span
                  style={{
                    display: "inline-block",
                    marginLeft: "8px",
                    padding: "2px 10px",
                    borderRadius: "50px",
                    fontSize: "12px",
                    fontWeight: "bold",
                    color: "#0f172a",
                    background: "#e2e8f0"
                  }}
                >
                  blockage {drain.blockageRiskLevel} ({drain.blockageRiskScore})
                </span>
              </div>
              <div style={{ fontSize: "13px", color: "#334155" }}>
                {drain.maintenanceRecommendation}
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
            📊 Avg Maintenance: <b>{summary.averageMaintenanceScore}/100</b>
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
          <span>
            🔧 Need inspection:{" "}
            <b>{summary.drainsRequiringInspection?.length || 0}</b>
          </span>
        </div>
      )}

      <p style={{ color: "#64748b", fontSize: "12px", marginTop: "12px" }}>
        Engineering explainable baseline - not a trained ML model and not physical
        blockage detection. Indicates drains that may need inspection or cleaning.
        {lastUpdate
          ? ` ⚡ Live at ${lastUpdate.toLocaleTimeString()}`
          : " Updated from latest sensor data"}
      </p>
    </div>
  );
}

export default MaintenancePanel;