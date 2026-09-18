import { useEffect, useMemo, useState } from "react";
import {
  FaBroadcastTower,
  FaHeartbeat,
  FaExclamationTriangle,
  FaCheckCircle,
  FaClock,
  FaMicrochip
} from "react-icons/fa";
import "../styles/sensorIntelligence.css";
import socket from "../services/socket";
import { getSensorIntelligence } from "../services/sensorIntelligenceService";

const HEALTH_CLASS = {
  HEALTHY: "si-health-healthy",
  GOOD: "si-health-good",
  DEGRADED: "si-health-degraded",
  POOR: "si-health-poor",
  CRITICAL: "si-health-critical",
  INSUFFICIENT_DATA: "si-health-unknown"
};

const SEVERITY_CLASS = {
  CRITICAL: "si-sev-critical",
  HIGH: "si-sev-high",
  MODERATE: "si-sev-moderate",
  LOW: "si-sev-low"
};

function SensorIntelligencePanel({ onOpen }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    getSensorIntelligence()
      .then((payload) => setData(payload))
      .catch((err) => {
        console.log("Sensor intelligence load error:", err);
        setError("Sensor intelligence unavailable");
      });

    const onUpdate = (payload) => {
      if (payload && payload.summary) {
        setData((prev) => ({ ...(prev || {}), ...payload }));
      }
    };

    socket.on("sensorIntelligenceUpdate", onUpdate);

    return () => {
      socket.off("sensorIntelligenceUpdate", onUpdate);
    };
  }, []);

  const summary = data?.summary || null;

  const attentionSensors = useMemo(() => {
    if (!data || !Array.isArray(data.sensors)) return [];

    const rank = {
      CRITICAL: 0,
      POOR: 1,
      DEGRADED: 2,
      GOOD: 3,
      HEALTHY: 4,
      INSUFFICIENT_DATA: 5
    };

    return [...data.sensors]
      .sort((a, b) => {
        const byStatus = (rank[a.healthStatus] ?? 6) - (rank[b.healthStatus] ?? 6);
        if (byStatus !== 0) return byStatus;
        return (b.anomalyCount || 0) - (a.anomalyCount || 0);
      })
      .slice(0, 4);
  }, [data]);

  return (
    <div className="si-shell">
      <div className="si-shell-header">
        <div>
          <h2>📡 Sensor Intelligence</h2>
          <p className="si-subtitle">
            IoT sensor health scoring &amp; anomaly detection · descriptive only
          </p>
        </div>

        <div className="si-actions">
          {data && (
            <span className="si-status">
              <FaHeartbeat /> {summary ? summary.overallHealthStatus : data.status}
            </span>
          )}
          <button className="btn btn-outline btn-sm" onClick={onOpen}>
            <FaMicrochip /> Sensor Console
          </button>
        </div>
      </div>

      {error && <div className="status-msg error">{error}</div>}

      {summary && (
        <div className="si-stat-strip">
          <div className="si-stat">
            <FaBroadcastTower />
            <div>
              <strong>{summary.totalSensors}</strong>
              <span>Sensors</span>
            </div>
          </div>

          <div className="si-stat">
            <FaCheckCircle />
            <div>
              <strong>{summary.counts.healthy + summary.counts.good}</strong>
              <span>Healthy / Good</span>
            </div>
          </div>

          <div
            className={`si-stat ${
              summary.counts.degraded + summary.counts.poor + summary.counts.critical > 0
                ? "stat-warn"
                : ""
            }`}
          >
            <FaHeartbeat />
            <div>
              <strong>
                {summary.counts.degraded + summary.counts.poor + summary.counts.critical}
              </strong>
              <span>Degraded+</span>
            </div>
          </div>

          <div className={`si-stat ${summary.anomalyCount > 0 ? "stat-danger" : ""}`}>
            <FaExclamationTriangle />
            <div>
              <strong>{summary.anomalyCount}</strong>
              <span>Anomalies</span>
            </div>
          </div>

          <div className={`si-stat ${summary.staleSensors > 0 ? "stat-warn" : ""}`}>
            <FaClock />
            <div>
              <strong>{summary.staleSensors}</strong>
              <span>Stale</span>
            </div>
          </div>
        </div>
      )}

      {attentionSensors.length > 0 && (
        <div className="si-sensor-list">
          {attentionSensors.map((sensor) => (
            <div key={sensor.sensorId} className="si-sensor">
              <div className="si-sensor-top">
                <span className="si-sensor-id">Sensor #{sensor.sensorId}</span>
                <span
                  className={`si-health ${HEALTH_CLASS[sensor.healthStatus] || "si-health-unknown"}`}
                >
                  {sensor.healthStatus}
                  {sensor.healthScore !== null && sensor.healthScore !== undefined
                    ? ` · ${sensor.healthScore}`
                    : ""}
                </span>
              </div>
              <p className="si-sensor-meta">
                {sensor.zone || `Drain ${sensor.drainId}`}
                {sensor.drainLocation ? ` · ${sensor.drainLocation}` : ""}
              </p>
              {sensor.latestAnomaly && (
                <p className="si-sensor-anomaly">
                  <span
                    className={`si-sev ${
                      SEVERITY_CLASS[sensor.latestAnomaly.severity] || ""
                    }`}
                  >
                    {sensor.latestAnomaly.severity}
                  </span>
                  <span>{sensor.latestAnomaly.message}</span>
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      {summary && summary.totalSensors === 0 && (
        <div className="si-empty">
          <FaCheckCircle /> No sensors are registered.
        </div>
      )}

      {data && <p className="si-disclaimer">{data.disclaimer}</p>}
    </div>
  );
}

export default SensorIntelligencePanel;
