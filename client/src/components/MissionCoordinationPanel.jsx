import { useEffect, useMemo, useState } from "react";
import {
  FaRobot,
  FaBatteryQuarter,
  FaRoute,
  FaExclamationTriangle,
  FaCheckCircle,
  FaNetworkWired,
  FaBolt,
  FaTasks
} from "react-icons/fa";
import "../styles/missionCoordination.css";
import socket from "../services/socket";
import { getMissionCoordination } from "../services/missionCoordinationService";

const STATUS_CLASS = {
  OK: "mc-status-ok",
  NO_TASKS: "mc-status-idle",
  NO_ROBOTS: "mc-status-bad",
  NO_ELIGIBLE_ROBOT: "mc-status-warn",
  NO_COORDINATES: "mc-status-warn",
  NO_FEASIBLE_ROUTE: "mc-status-warn",
  INSUFFICIENT_DATA: "mc-status-idle",
  UNAVAILABLE: "mc-status-idle"
};

const ROUTE_CLASS = {
  DIRECT: "route-direct",
  CHARGE_THEN_TASK: "route-charge",
  NO_FEASIBLE_ROUTE: "route-infeasible"
};

function MissionCoordinationPanel({ onOpen }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    getMissionCoordination()
      .then((payload) => setData(payload))
      .catch((err) => {
        console.log("Mission coordination load error:", err);
        setError("Mission coordination unavailable");
      });

    const onUpdate = (payload) => {
      if (payload && payload.summary) {
        setData((prev) => ({ ...(prev || {}), ...payload }));
      }
    };

    socket.on("missionCoordinationUpdate", onUpdate);

    return () => {
      socket.off("missionCoordinationUpdate", onUpdate);
    };
  }, []);

  const summary = data?.summary || null;
  const conflicts = data?.conflicts || [];
  const unassigned = data?.unassigned || [];
  const reassignments = data?.reassignment_required || [];

  const topAssignments = useMemo(() => {
    if (!data || !Array.isArray(data.assignments)) return [];
    return data.assignments.slice(0, 3);
  }, [data]);

  return (
    <div className="mc-shell">
      <div className="mc-shell-header">
        <div>
          <h2>🤝 Mission Coordination</h2>
          <p className="mc-subtitle">
            Multi-robot task scheduling &amp; conflict detection · advisory only
          </p>
        </div>

        <div className="mc-actions">
          {data && (
            <span className={`mc-status ${STATUS_CLASS[data.status] || "mc-status-idle"}`}>
              {data.status}
            </span>
          )}
          <button className="btn btn-outline btn-sm" onClick={onOpen}>
            <FaNetworkWired /> Coordination Console
          </button>
        </div>
      </div>

      {error && <div className="status-msg error">{error}</div>}

      {summary && (
        <div className="mc-stat-strip">
          <div className="mc-stat">
            <FaTasks />
            <div>
              <strong>{summary.assigned_tasks}/{summary.total_tasks}</strong>
              <span>Tasks planned</span>
            </div>
          </div>

          <div className={`mc-stat ${summary.unassigned_tasks > 0 ? "stat-danger" : ""}`}>
            <FaExclamationTriangle />
            <div>
              <strong>{summary.unassigned_tasks}</strong>
              <span>Unassigned</span>
            </div>
          </div>

          <div className="mc-stat">
            <FaRobot />
            <div>
              <strong>{summary.available_robots}</strong>
              <span>Available</span>
            </div>
          </div>

          <div className={`mc-stat ${summary.charging_robots > 0 ? "stat-charge" : ""}`}>
            <FaBolt />
            <div>
              <strong>{summary.charging_robots}</strong>
              <span>Charging</span>
            </div>
          </div>

          <div className={`mc-stat ${summary.low_battery_robots > 0 ? "stat-warn" : ""}`}>
            <FaBatteryQuarter />
            <div>
              <strong>{summary.low_battery_robots}</strong>
              <span>Low battery</span>
            </div>
          </div>

          <div className={`mc-stat ${conflicts.length > 0 ? "stat-warn" : ""}`}>
            <FaExclamationTriangle />
            <div>
              <strong>{conflicts.length}</strong>
              <span>Conflicts</span>
            </div>
          </div>
        </div>
      )}

      {topAssignments.length > 0 && (
        <div className="mc-assignment-list">
          {topAssignments.map((assignment) => (
            <div key={assignment.task_id} className="mc-assignment">
              <div className="mc-assignment-top">
                <span className={`mc-sev sev-${(assignment.severity || "").toLowerCase()}`}>
                  {assignment.severity}
                </span>
                <span className="mc-task-id">{assignment.task_id}</span>
                <span className="mc-priority">
                  priority {assignment.priority_score ?? "n/a"}/100
                </span>
              </div>
              <p className="mc-assignment-line">
                <FaRobot /> <strong>{assignment.robot_name}</strong> →{" "}
                {assignment.location || assignment.zone || `drain ${assignment.drain_id}`}
              </p>
              <p className="mc-assignment-meta">
                <FaRoute />
                <span className={`mc-pill ${ROUTE_CLASS[assignment.route_mode] || ""}`}>
                  {assignment.route_mode}
                </span>
                {assignment.estimated_travel_time !== null &&
                  assignment.estimated_travel_time !== undefined
                  ? `ETA ~${Math.round(assignment.estimated_travel_time)}s`
                  : "ETA —"}
                {assignment.charging_required ? " · charging stop" : ""}
              </p>
            </div>
          ))}
        </div>
      )}

      {(unassigned.length > 0 || reassignments.length > 0) && (
        <div className="mc-alert">
          <FaExclamationTriangle />
          {unassigned.length > 0 && <span>{unassigned.length} task(s) unassigned. </span>}
          {reassignments.length > 0 && (
            <span>{reassignments.length} mission(s) require reassignment.</span>
          )}
        </div>
      )}

      {summary && summary.total_tasks === 0 && (
        <div className="mc-empty">
          <FaCheckCircle /> No active tasks require coordination right now.
        </div>
      )}

      {data && <p className="mc-disclaimer">{data.disclaimer}</p>}
    </div>
  );
}

export default MissionCoordinationPanel;
