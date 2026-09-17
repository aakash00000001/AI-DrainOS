import { useEffect, useMemo, useState } from "react";
import {
  FaTruckMoving,
  FaBolt,
  FaBatteryQuarter,
  FaRoute,
  FaExclamationTriangle,
  FaCheckCircle,
  FaRandom,
  FaNetworkWired
} from "react-icons/fa";
import "../styles/fleetOptimization.css";
import socket from "../services/socket";
import { getFleetOptimization } from "../services/fleetOptimizationService";

const STATUS_CLASS = {
  OK: "fleet-status-ok",
  NO_TASKS: "fleet-status-idle",
  NO_ROBOTS: "fleet-status-bad",
  NO_ELIGIBLE_ROBOT: "fleet-status-warn",
  NO_COORDINATES: "fleet-status-warn",
  NO_FEASIBLE_ROUTE: "fleet-status-warn",
  INSUFFICIENT_DATA: "fleet-status-idle",
  UNAVAILABLE: "fleet-status-idle"
};

function FleetOptimizationPanel({ onOpen }) {

  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    getFleetOptimization()
      .then((payload) => setData(payload))
      .catch((err) => {
        console.log("Fleet optimization load error:", err);
        setError("Fleet optimization unavailable");
      });

    const onUpdate = (payload) => {
      if (payload && payload.summary) setData(payload);
    };

    socket.on("fleetOptimizationUpdate", onUpdate);

    return () => {
      socket.off("fleetOptimizationUpdate", onUpdate);
    };
  }, []);

  const summary = data?.summary || null;

  const topRecommendations = useMemo(() => {
    if (!data || !Array.isArray(data.recommendations)) return [];
    return data.recommendations.slice(0, 3);
  }, [data]);

  const unassigned = data?.unassigned || [];
  const warnings = data?.warnings || [];

  return (
    <div className="fleet-shell">

      <div className="fleet-shell-header">
        <div>
          <h2>🚚 Fleet Optimization</h2>
          <p className="fleet-subtitle">
            Predictive resource &amp; robot fleet optimization · advisory only
          </p>
        </div>

        <div className="fleet-actions">
          {data && (
            <span className={`fleet-status ${STATUS_CLASS[data.status] || "fleet-status-idle"}`}>
              {data.status}
            </span>
          )}
          <button className="btn btn-outline btn-sm" onClick={onOpen}>
            <FaNetworkWired /> Fleet Console
          </button>
        </div>
      </div>

      {error && <div className="status-msg error">{error}</div>}

      {summary && (
        <div className="fleet-stat-strip">

          <div className="fleet-stat">
            <FaCheckCircle />
            <div>
              <strong>{summary.available_robots}</strong>
              <span>Available</span>
            </div>
          </div>

          <div className={`fleet-stat ${summary.busy_robots > 0 ? "stat-active" : ""}`}>
            <FaTruckMoving />
            <div>
              <strong>{summary.busy_robots}</strong>
              <span>Busy</span>
            </div>
          </div>

          <div className={`fleet-stat ${summary.charging_robots > 0 ? "stat-charge" : ""}`}>
            <FaBolt />
            <div>
              <strong>{summary.charging_robots}</strong>
              <span>Charging</span>
            </div>
          </div>

          <div className={`fleet-stat ${summary.low_battery_robots > 0 ? "stat-warn" : ""}`}>
            <FaBatteryQuarter />
            <div>
              <strong>{summary.low_battery_robots}</strong>
              <span>Low Battery</span>
            </div>
          </div>

          <div className={`fleet-stat ${summary.unassigned_tasks > 0 ? "stat-danger" : ""}`}>
            <FaRandom />
            <div>
              <strong>{summary.assigned_tasks}/{summary.active_tasks}</strong>
              <span>Tasks Assigned</span>
            </div>
          </div>

        </div>
      )}

      {topRecommendations.length > 0 && (
        <div className="fleet-reco-list">
          {topRecommendations.map((rec) => (
            <div key={rec.task_id} className="fleet-reco">
              <div className="fleet-reco-top">
                <span className={`fleet-sev sev-${(rec.severity || "").toLowerCase()}`}>
                  {rec.severity}
                </span>
                <span className="fleet-task-id">{rec.task_id}</span>
                <span className="fleet-priority">priority {rec.priority_score}/100</span>
              </div>
              <p className="fleet-reco-line">
                <FaTruckMoving /> <strong>{rec.robot_name}</strong> →{" "}
                {rec.location || rec.zone || `drain ${rec.drain_id}`}
              </p>
              <p className="fleet-reco-meta">
                <FaRoute /> {rec.route_mode}
                {rec.estimated_travel_time !== null
                  ? ` · ETA ~${Math.round(rec.estimated_travel_time)}s`
                  : ""}
                {rec.charging_required ? " · charging stop required" : ""}
              </p>
            </div>
          ))}
        </div>
      )}

      {summary && summary.active_tasks > 0 && topRecommendations.length === 0 && (
        <div className="fleet-alert">
          <FaExclamationTriangle /> {unassigned.length} task(s) could not be assigned.
        </div>
      )}

      {summary && summary.active_tasks === 0 && (
        <div className="fleet-empty">
          <FaCheckCircle /> No active tasks. The fleet is idle and monitoring.
        </div>
      )}

      {warnings.length > 0 && (
        <ul className="fleet-warnings">
          {warnings.slice(0, 4).map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}

      {data && <p className="fleet-disclaimer">{data.disclaimer}</p>}

    </div>
  );
}

export default FleetOptimizationPanel;
