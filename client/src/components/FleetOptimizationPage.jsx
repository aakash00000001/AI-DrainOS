import { useCallback, useEffect, useState } from "react";
import {
  FaSync,
  FaTruckMoving,
  FaBolt,
  FaBatteryQuarter,
  FaCheckCircle,
  FaExclamationTriangle,
  FaRandom,
  FaBalanceScale,
  FaPlug
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

const AVAILABILITY_CLASS = {
  AVAILABLE: "avail-available",
  BUSY: "avail-busy",
  CHARGING: "avail-charging",
  LOW_BATTERY: "avail-low",
  OFFLINE: "avail-offline",
  UNAVAILABLE: "avail-unavailable"
};

const ROUTE_CLASS = {
  DIRECT: "route-direct",
  CHARGE_THEN_TASK: "route-charge",
  NO_FEASIBLE_ROUTE: "route-infeasible"
};

function FleetOptimizationPage() {

  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(0);

  const load = useCallback(() => {
    getFleetOptimization()
      .then((payload) => {
        setData(payload);
        setError(null);
        setLastUpdated(Date.now());
      })
      .catch((err) => {
        console.log("Fleet optimization load error:", err);
        setError("Fleet optimization unavailable");
      });
  }, []);

  useEffect(() => {
    load();

    const onUpdate = (payload) => {
      if (payload && payload.summary) {
        setData(payload);
        setLastUpdated(Date.now());
      }
    };

    socket.on("fleetOptimizationUpdate", onUpdate);

    return () => {
      socket.off("fleetOptimizationUpdate", onUpdate);
    };
  }, [load]);

  const summary = data?.summary || null;
  const tasks = data?.tasks || [];
  const robots = data?.robots || [];
  const unassigned = data?.unassigned || [];
  const warnings = data?.warnings || [];
  const robotsWithoutAssignment = data?.robots_without_assignment || [];
  const robotsRequiringCharging = data?.robots_requiring_charging || [];

  return (
    <div className="fleet-page">

      <div className="fleet-page-header">
        <div>
          <h2>🚚 Fleet Optimization Console</h2>
          <p className="fleet-subtitle">
            Predictive resource &amp; robot fleet optimization · recommendations are advisory only
          </p>
        </div>

        <div className="fleet-actions">
          {data && (
            <span className={`fleet-status ${STATUS_CLASS[data.status] || "fleet-status-idle"}`}>
              {data.status}
            </span>
          )}
          {lastUpdated > 0 && (
            <span className="fleet-updated">
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

          <div className="fleet-stat">
            <FaBalanceScale />
            <div>
              <strong>{summary.fleet_utilization ?? "—"}%</strong>
              <span>Utilization</span>
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

      {warnings.length > 0 && (
        <ul className="fleet-warnings fleet-warnings-wide">
          {warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}

      <div className="fleet-layout">

        <div className="table-card fleet-table-card">
          <div className="table-header">
            <h3>🎯 Task Queue &amp; Recommendations</h3>
          </div>

          <div className="fleet-table-scroll">
            <table className="fleet-table">
              <thead>
                <tr>
                  <th>Task</th>
                  <th>Drain</th>
                  <th>Severity</th>
                  <th>Priority</th>
                  <th>Recommended Robot</th>
                  <th>Route</th>
                  <th>ETA</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {tasks.length === 0 && (
                  <tr>
                    <td colSpan="8" className="fleet-no-rows">
                      No critical drains or active incidents require the fleet.
                    </td>
                  </tr>
                )}
                {tasks.map((task) => (
                  <tr key={task.task_id}>
                    <td className="fleet-task-id">{task.task_id}</td>
                    <td>
                      <strong>{task.zone || "Unknown"}</strong>
                      <span className="cell-sub">{task.location || "—"}</span>
                    </td>
                    <td>
                      <span className={`fleet-sev sev-${(task.severity || "").toLowerCase()}`}>
                        {task.severity}
                      </span>
                    </td>
                    <td>
                      {task.priority_score === null ? (
                        <span className="fleet-muted">insufficient data</span>
                      ) : (
                        <>
                          {task.priority_score}
                          <span className="cell-sub">{task.estimated_urgency}</span>
                        </>
                      )}
                    </td>
                    <td>
                      {task.recommended_robot_name || (
                        <span className="fleet-muted">unassigned</span>
                      )}
                    </td>
                    <td>
                      {task.route_mode ? (
                        <span className={`route-pill ${ROUTE_CLASS[task.route_mode] || ""}`}>
                          {task.route_mode}
                        </span>
                      ) : (
                        <span className="fleet-muted">—</span>
                      )}
                    </td>
                    <td>
                      {task.estimated_travel_time !== undefined && task.estimated_travel_time !== null
                        ? `${Math.round(task.estimated_travel_time)}s`
                        : "—"}
                    </td>
                    <td>
                      <span className={`fleet-reco-state state-${(task.recommendation_status || "").toLowerCase()}`}>
                        {task.recommendation_status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="table-card fleet-table-card">
          <div className="table-header">
            <h3>🤖 Fleet Availability</h3>
          </div>

          <div className="fleet-table-scroll">
            <table className="fleet-table">
              <thead>
                <tr>
                  <th>Robot</th>
                  <th>Status</th>
                  <th>Availability</th>
                  <th>Battery</th>
                  <th>Available At</th>
                </tr>
              </thead>
              <tbody>
                {robots.length === 0 && (
                  <tr>
                    <td colSpan="5" className="fleet-no-rows">No robots registered.</td>
                  </tr>
                )}
                {robots.map((robot) => (
                  <tr key={robot.robot_id}>
                    <td>
                      <strong>{robot.robot_name}</strong>
                      <span className="cell-sub">{robot.assigned_zone || "—"}</span>
                    </td>
                    <td>{robot.status}</td>
                    <td>
                      <span className={`avail-pill ${AVAILABILITY_CLASS[robot.availability_state] || ""}`}>
                        {robot.availability_state}
                      </span>
                    </td>
                    <td>{robot.battery_level === null ? "—" : `${robot.battery_level}%`}</td>
                    <td>
                      {robot.estimated_available_time
                        ? new Date(robot.estimated_available_time).toLocaleTimeString()
                        : "—"}
                      <span className="cell-sub">{robot.estimated_available_reason || ""}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

      </div>

      <div className="fleet-layout">
        <div className="table-card fleet-table-card">
          <div className="table-header">
            <h3>
              <FaExclamationTriangle /> Unassigned Tasks ({unassigned.length})
            </h3>
          </div>

          <div className="fleet-table-scroll">
            <table className="fleet-table">
              <thead>
                <tr>
                  <th>Task</th>
                  <th>Severity</th>
                  <th>Priority</th>
                  <th>Reason</th>
                  <th>Required Action</th>
                </tr>
              </thead>
              <tbody>
                {unassigned.length === 0 && (
                  <tr>
                    <td colSpan="5" className="fleet-no-rows">
                      Every task has an eligible recommended robot.
                    </td>
                  </tr>
                )}
                {unassigned.map((item) => (
                  <tr key={item.task_id}>
                    <td className="fleet-task-id">{item.task_id}</td>
                    <td>
                      <span className={`fleet-sev sev-${(item.severity || "").toLowerCase()}`}>
                        {item.severity}
                      </span>
                    </td>
                    <td>{item.priority_score ?? "—"}</td>
                    <td><span className="fleet-reason">{item.reason}</span></td>
                    <td>{item.required_action}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="table-card fleet-table-card">
          <div className="table-header">
            <h3>
              <FaPlug /> Charging &amp; Idle Robots
            </h3>
          </div>

          <div className="fleet-table-scroll">
            <table className="fleet-table">
              <thead>
                <tr>
                  <th>Robot</th>
                  <th>State</th>
                  <th>Battery</th>
                </tr>
              </thead>
              <tbody>
                {robotsRequiringCharging.length === 0 && robotsWithoutAssignment.length === 0 && (
                  <tr>
                    <td colSpan="3" className="fleet-no-rows">
                      No charging or idle robots to report.
                    </td>
                  </tr>
                )}
                {robotsRequiringCharging.map((robot) => (
                  <tr key={`charge-${robot.robot_id}`}>
                    <td><strong>{robot.robot_name}</strong></td>
                    <td>
                      <span className={`avail-pill ${AVAILABILITY_CLASS[robot.availability_state] || ""}`}>
                        {robot.availability_state}
                      </span>
                    </td>
                    <td>{robot.battery_level === null ? "—" : `${robot.battery_level}%`}</td>
                  </tr>
                ))}
                {robotsWithoutAssignment
                  .filter(
                    (robot) =>
                      !robotsRequiringCharging.some((r) => r.robot_id === robot.robot_id)
                  )
                  .map((robot) => (
                    <tr key={`idle-${robot.robot_id}`}>
                      <td><strong>{robot.robot_name}</strong></td>
                      <td>
                        <span className={`avail-pill ${AVAILABILITY_CLASS[robot.availability_state] || ""}`}>
                          {robot.availability_state}
                        </span>
                      </td>
                      <td>{robot.battery_level === null ? "—" : `${robot.battery_level}%`}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {data && <p className="fleet-disclaimer">{data.disclaimer}</p>}

    </div>
  );
}

export default FleetOptimizationPage;
