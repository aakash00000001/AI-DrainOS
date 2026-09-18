import { useCallback, useEffect, useMemo, useState } from "react";
import {
  FaSync,
  FaBroadcastTower,
  FaHeartbeat,
  FaExclamationTriangle,
  FaClock,
  FaCheckCircle,
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

const SEVERITY_RANK = { CRITICAL: 0, HIGH: 1, MODERATE: 2, LOW: 3 };

const HEALTH_ORDER = ["HEALTHY", "GOOD", "DEGRADED", "POOR", "CRITICAL", "INSUFFICIENT_DATA"];

function formatTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString();
}

function SensorIntelligencePage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(0);

  const load = useCallback(() => {
    getSensorIntelligence()
      .then((payload) => {
        setData(payload);
        setError(null);
        setLastUpdated(Date.now());
      })
      .catch((err) => {
        console.log("Sensor intelligence load error:", err);
        setError("Sensor intelligence unavailable");
      });
  }, []);

  useEffect(() => {
    load();

    const onUpdate = (payload) => {
      if (payload && payload.summary) {
        setData((prev) => ({ ...(prev || {}), ...payload }));
        setLastUpdated(Date.now());
      }
    };

    socket.on("sensorIntelligenceUpdate", onUpdate);

    return () => {
      socket.off("sensorIntelligenceUpdate", onUpdate);
    };
  }, [load]);

  const summary = data?.summary || null;
  const sensors = useMemo(() => data?.sensors || [], [data]);
  const anomalies = useMemo(() => data?.anomalies || [], [data]);
  const drains = data?.drains || [];

  const sortedSensors = useMemo(() => {
    const rank = { CRITICAL: 0, POOR: 1, DEGRADED: 2, GOOD: 3, HEALTHY: 4, INSUFFICIENT_DATA: 5 };
    return [...sensors].sort((a, b) => {
      const byStatus = (rank[a.healthStatus] ?? 6) - (rank[b.healthStatus] ?? 6);
      if (byStatus !== 0) return byStatus;
      return (b.anomalyCount || 0) - (a.anomalyCount || 0);
    });
  }, [sensors]);

  const sortedAnomalies = useMemo(() => {
    return [...anomalies].sort((a, b) => {
      const bySeverity =
        (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9);
      if (bySeverity !== 0) return bySeverity;
      return new Date(b.detectedAt || 0) - new Date(a.detectedAt || 0);
    });
  }, [anomalies]);

  return (
    <div className="si-page">
      <div className="si-page-header">
        <div>
          <h2>📡 Sensor Intelligence Console</h2>
          <p className="si-subtitle">
            Health scoring &amp; anomaly detection across the sensor fleet · descriptive only
          </p>
        </div>

        <div className="si-actions">
          {data && (
            <span className={`si-health ${HEALTH_CLASS[summary?.overallHealthStatus] || "si-health-unknown"}`}>
              {summary?.overallHealthStatus || data.status}
            </span>
          )}
          {lastUpdated > 0 && (
            <span className="si-updated">
              Updated {new Date(lastUpdated).toLocaleTimeString()}
            </span>
          )}
          <button className="btn btn-outline btn-sm" onClick={load}>
            <FaSync /> Refresh
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
            <FaHeartbeat />
            <div>
              <strong>
                {summary.averageHealthScore === null ? "—" : summary.averageHealthScore}
              </strong>
              <span>Avg health</span>
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

          <div className={`si-stat ${summary.missingDataSensors > 0 ? "stat-warn" : ""}`}>
            <FaExclamationTriangle />
            <div>
              <strong>{summary.missingDataSensors}</strong>
              <span>Missing data</span>
            </div>
          </div>

          <div className={`si-stat ${summary.outOfRangeSensors > 0 ? "stat-warn" : ""}`}>
            <FaExclamationTriangle />
            <div>
              <strong>{summary.outOfRangeSensors}</strong>
              <span>Out of range</span>
            </div>
          </div>

          <div className="si-stat">
            <FaMicrochip />
            <div>
              <strong>{summary.affectedDrains}</strong>
              <span>Affected drains</span>
            </div>
          </div>
        </div>
      )}

      {summary && (
        <div className="si-card">
          <div className="si-card-header">
            <h3>
              <FaHeartbeat /> Health Distribution
            </h3>
          </div>
          <div className="si-distribution">
            {HEALTH_ORDER.map((status) => {
              const count = summary.healthDistribution?.[status] || 0;
              const pct =
                summary.totalSensors > 0
                  ? Math.round((count / summary.totalSensors) * 100)
                  : 0;
              return (
                <div key={status} className="si-dist-row">
                  <span className={`si-health ${HEALTH_CLASS[status] || "si-health-unknown"}`}>
                    {status}
                  </span>
                  <div className="si-dist-bar">
                    <div
                      className={`si-dist-fill ${HEALTH_CLASS[status] || "si-health-unknown"}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className="si-dist-count">{count}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="si-card">
        <div className="si-card-header">
          <h3>
            <FaBroadcastTower /> Sensor Health ({sortedSensors.length})
          </h3>
        </div>
        <div className="si-table-scroll">
          <table className="si-table">
            <thead>
              <tr>
                <th>Sensor</th>
                <th>Drain</th>
                <th>Zone</th>
                <th>Health</th>
                <th>Score</th>
                <th>Anomalies</th>
                <th>Latest Signal</th>
              </tr>
            </thead>
            <tbody>
              {sortedSensors.length === 0 && (
                <tr>
                  <td colSpan="7" className="si-no-rows">
                    No sensors are registered.
                  </td>
                </tr>
              )}
              {sortedSensors.map((sensor) => (
                <tr key={sensor.sensorId}>
                  <td className="si-id">#{sensor.sensorId}</td>
                  <td>
                    <strong>{sensor.drainLocation || `Drain ${sensor.drainId}`}</strong>
                    <span className="cell-sub">drain {sensor.drainId}</span>
                  </td>
                  <td>{sensor.zone || "—"}</td>
                  <td>
                    <span
                      className={`si-health ${
                        HEALTH_CLASS[sensor.healthStatus] || "si-health-unknown"
                      }`}
                    >
                      {sensor.healthStatus}
                    </span>
                  </td>
                  <td>{sensor.healthScore === null || sensor.healthScore === undefined ? "—" : sensor.healthScore}</td>
                  <td>{sensor.anomalyCount}</td>
                  <td>
                    {sensor.latestAnomaly ? (
                      <>
                        <span
                          className={`si-sev ${
                            SEVERITY_CLASS[sensor.latestAnomaly.severity] || ""
                          }`}
                        >
                          {sensor.latestAnomaly.type} / {sensor.latestAnomaly.severity}
                        </span>
                        <span className="cell-sub">{sensor.latestAnomaly.message}</span>
                      </>
                    ) : (
                      <span className="si-muted">No anomaly signals</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="si-card">
        <div className="si-card-header">
          <h3>
            <FaExclamationTriangle /> Detected Anomalies ({sortedAnomalies.length})
          </h3>
        </div>
        <div className="si-table-scroll">
          <table className="si-table">
            <thead>
              <tr>
                <th>Type</th>
                <th>Severity</th>
                <th>Sensor</th>
                <th>Drain</th>
                <th>Message</th>
                <th>Detected</th>
              </tr>
            </thead>
            <tbody>
              {sortedAnomalies.length === 0 && (
                <tr>
                  <td colSpan="6" className="si-no-rows">
                    <FaCheckCircle /> No sensor anomalies detected in the analysed window.
                  </td>
                </tr>
              )}
              {sortedAnomalies.map((anomaly, index) => (
                <tr key={`${anomaly.sensorId}-${anomaly.type}-${index}`}>
                  <td>{anomaly.type}</td>
                  <td>
                    <span className={`si-sev ${SEVERITY_CLASS[anomaly.severity] || ""}`}>
                      {anomaly.severity}
                    </span>
                  </td>
                  <td className="si-id">#{anomaly.sensorId}</td>
                  <td className="si-id">#{anomaly.drainId}</td>
                  <td>{anomaly.message}</td>
                  <td>{formatTime(anomaly.detectedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {drains.length > 0 && (
        <div className="si-card">
          <div className="si-card-header">
            <h3>
              <FaMicrochip /> Drain Sensor Aggregates ({drains.length})
            </h3>
          </div>
          <div className="si-table-scroll">
            <table className="si-table">
              <thead>
                <tr>
                  <th>Drain</th>
                  <th>Zone</th>
                  <th>Sensors</th>
                  <th>Overall Health</th>
                  <th>Anomalies</th>
                </tr>
              </thead>
              <tbody>
                {drains.map((drain) => (
                  <tr key={drain.drainId}>
                    <td>
                      <strong>{drain.drainLocation || `Drain ${drain.drainId}`}</strong>
                      <span className="cell-sub">drain {drain.drainId}</span>
                    </td>
                    <td>{drain.zone || "—"}</td>
                    <td>{drain.totalSensors}</td>
                    <td>
                      <span
                        className={`si-health ${
                          HEALTH_CLASS[drain.overallHealthStatus] || "si-health-unknown"
                        }`}
                      >
                        {drain.overallHealthStatus}
                      </span>
                    </td>
                    <td>{drain.anomalyCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {data && <p className="si-disclaimer">{data.disclaimer}</p>}
    </div>
  );
}

export default SensorIntelligencePage;
