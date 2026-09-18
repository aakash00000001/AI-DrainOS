import { useCallback, useEffect, useMemo, useState } from "react";
import {
  FaSync,
  FaRobot,
  FaBatteryQuarter,
  FaRoute,
  FaExclamationTriangle,
  FaCheckCircle,
  FaBolt,
  FaTasks,
  FaPlay,
  FaEye,
  FaRandom
} from "react-icons/fa";
import "../styles/missionCoordination.css";
import socket from "../services/socket";
import {
  getMissionCoordination,
  planMissionCoordination
} from "../services/missionCoordinationService";

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

function MissionCoordinationPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [actionMsg, setActionMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(0);

  const load = useCallback(() => {
    getMissionCoordination()
      .then((payload) => {
        setData(payload);
        setError(null);
        setLastUpdated(Date.now());
      })
      .catch((err) => {
        console.log("Mission coordination load error:", err);
        setError("Mission coordination unavailable");
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

    socket.on("missionCoordinationUpdate", onUpdate);

    return () => {
      socket.off("missionCoordinationUpdate", onUpdate);
    };
  }, [load]);

  const run = async (mode) => {
    setBusy(true);
    setActionMsg(null);
    try {
      const result = await planMissionCoordination(mode);
      if (mode === "autonomous" && result.execution) {
        setActionMsg({
          ok: true,
          text: `Autonomous plan dispatched ${result.execution.executed.length} mission(s) via missionEngine${
            result.execution.failed.length > 0
              ? `, ${result.execution.failed.length} failed`
              : ""
          }.`
        });
      } else {
        setActionMsg({
          ok: true,
          text: `Advisory plan generated for ${result.assignments?.length || 0} task(s). No missions were changed.`
        });
      }
      load();
    } catch (err) {
      console.log("Mission coordination plan error:", err);
      setActionMsg({
        ok: false,
        text:
          err?.response?.status === 401
            ? "Sign in as a user to run a plan."
            : err?.response?.data?.message || "Unable to run the coordination plan."
      });
    } finally {
      setBusy(false);
    }
  };

  const summary = data?.summary || null;
  const tasks = data?.tasks || [];
  const robots = data?.robot_availability || data?.robots || [];
  const assignments = data?.assignments || [];
  const unassigned = data?.unassigned || [];
  const conflicts = data?.conflicts || [];
  const reassignments = data?.reassignment_required || [];
  const warnings = data?.warnings || [];

  const assignmentByRobot = useMemo(() => {
    const map = {};
    const list = data && Array.isArray(data.assignments) ? data.assignments : [];
    for (const assignment of list) {
      map[assignment.robot_id] = assignment;
    }
    return map;
  }, [data]);

  return (
    <div className="mc-page">
      <div className="mc-page-header">
        <div>
          <h2>🤝 Mission Coordination Console</h2>
          <p className="mc-subtitle">
            Autonomous mission scheduling &amp; multi-robot coordination · advisory by default
          </p>
        </div>

        <div className="mc-actions">
          {data && (
            <span className={`mc-status ${STATUS_CLASS[data.status] || "mc-status-idle"}`}>
              {data.status}
            </span>
          )}
          {lastUpdated > 0 && (
            <span className="mc-updated">
              Updated {new Date(lastUpdated).toLocaleTimeString()}
            </span>
          )}
          <button className="btn btn-outline btn-sm" onClick={load} disabled={busy}>
            <FaSync /> Refresh
          </button>
          <button className="btn btn-outline btn-sm" onClick={() => run("advisory")} disabled={busy}>
            <FaEye /> Advisory Plan
          </button>
          <button className="btn btn-sm" onClick={() => run("autonomous")} disabled={busy}>
            <FaPlay /> Autonomous Plan
          </button>
        </div>
      </div>

      {error && <div className="status-msg error">{error}</div>}

      {actionMsg && (
        <div className={actionMsg.ok ? "status-msg" : "status-msg error"}>{actionMsg.text}</div>
      )}

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
            <FaRandom />
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

          <div className={`mc-stat ${summary.busy_robots > 0 ? "stat-active" : ""}`}>
            <FaRobot />
            <div>
              <strong>{summary.busy_robots}</strong>
              <span>Busy</span>
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

          <div className={`mc-stat ${reassignments.length > 0 ? "stat-danger" : ""}`}>
            <FaExclamationTriangle />
            <div>
              <strong>{reassignments.length}</strong>
              <span>Reassignments</span>
            </div>
          </div>
        </div>
      )}

      {warnings.length > 0 && (
        <ul className="mc-warnings mc-warnings-wide">
          {warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}

      <div className="mc-layout">
        <div className="mc-card">
          <div className="mc-card-header">
            <h3>
              <FaTasks /> Task Queue
            </h3>
          </div>
          <div className="mc-table-scroll">
            <table className="mc-table">
              <thead>
                <tr>
                  <th>Task</th>
                  <th>Drain</th>
                  <th>Severity</th>
                  <th>Priority</th>
                  <th>State</th>
                  <th>Candidate / Reason</th>
                </tr>
              </thead>
              <tbody>
                {tasks.length === 0 && (
                  <tr>
                    <td colSpan="6" className="mc-no-rows">
                      No active tasks require coordination.
                    </td>
                  </tr>
                )}
                {tasks.map((task) => (
                  <tr key={task.task_id}>
                    <td className="mc-task-id">{task.task_id}</td>
                    <td>
                      <strong>{task.zone || "Unknown"}</strong>
                      <span className="cell-sub">{task.location || "—"}</span>
                    </td>
                    <td>
                      <span className={`mc-sev sev-${(task.severity || "").toLowerCase()}`}>
                        {task.severity}
                      </span>
                    </td>
                    <td>
                      {task.priority_score === null || task.priority_score === undefined ? (
                        <span className="mc-muted">insufficient data</span>
                      ) : (
                        <>
                          {task.priority_score}
                          <span className="cell-sub">{task.priority_status}</span>
                        </>
                      )}
                    </td>
                    <td>
                      <span className={`mc-pill`}>{task.coordination_state}</span>
                    </td>
                    <td>
                      {task.assigned_robot_id ? (
                        <>
                          Robot #{task.assigned_robot_id}
                          {task.route_mode ? (
                            <span className="cell-sub">{task.route_mode}</span>
                          ) : null}
                        </>
                      ) : (
                        <span className="mc-muted">{task.unassigned_reason || "—"}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="mc-card">
          <div className="mc-card-header">
            <h3>
              <FaRobot /> Robot Availability
            </h3>
          </div>
          <div className="mc-table-scroll">
            <table className="mc-table">
              <thead>
                <tr>
                  <th>Robot</th>
                  <th>Availability</th>
                  <th>Battery</th>
                  <th>Planned Task</th>
                  <th>Route</th>
                </tr>
              </thead>
              <tbody>
                {robots.length === 0 && (
                  <tr>
                    <td colSpan="5" className="mc-no-rows">
                      No robots registered.
                    </td>
                  </tr>
                )}
                {robots.map((robot) => {
                  const plan = assignmentByRobot[robot.robot_id] || null;
                  return (
                    <tr key={robot.robot_id}>
                      <td>
                        <strong>{robot.robot_name}</strong>
                        <span className="cell-sub">
                          {robot.current_mission_id
                            ? `mission #${robot.current_mission_id}${
                                robot.target_drain_id ? ` → drain ${robot.target_drain_id}` : ""
                              }`
                            : "no active mission"}
                        </span>
                      </td>
                      <td>
                        <span
                          className={`mc-pill ${
                            AVAILABILITY_CLASS[robot.availability_state] || ""
                          }`}
                        >
                          {robot.availability_state}
                        </span>
                      </td>
                      <td>{robot.battery_level === null ? "—" : `${robot.battery_level}%`}</td>
                      <td>
                        {plan ? (
                          <>
                            {plan.task_id}
                            <span className="cell-sub">
                              priority {plan.priority_score ?? "n/a"}
                            </span>
                          </>
                        ) : (
                          <span className="mc-muted">none</span>
                        )}
                      </td>
                      <td>
                        {plan ? (
                          <span className={`mc-pill ${ROUTE_CLASS[plan.route_mode] || ""}`}>
                            {plan.route_mode}
                          </span>
                        ) : (
                          <span className="mc-muted">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="mc-layout">
        <div className="mc-card">
          <div className="mc-card-header">
            <h3>
              <FaRoute /> Assignments &amp; Alternatives ({assignments.length})
            </h3>
          </div>
          <div className="mc-table-scroll">
            <table className="mc-table">
              <thead>
                <tr>
                  <th>Task</th>
                  <th>Robot</th>
                  <th>Score</th>
                  <th>Route</th>
                  <th>ETA</th>
                  <th>Alternatives</th>
                </tr>
              </thead>
              <tbody>
                {assignments.length === 0 && (
                  <tr>
                    <td colSpan="6" className="mc-no-rows">
                      No robots could be assigned.
                    </td>
                  </tr>
                )}
                {assignments.map((assignment) => (
                  <tr key={assignment.task_id}>
                    <td className="mc-task-id">{assignment.task_id}</td>
                    <td>{assignment.robot_name}</td>
                    <td>{assignment.candidate_score}/100</td>
                    <td>
                      <span className={`mc-pill ${ROUTE_CLASS[assignment.route_mode] || ""}`}>
                        {assignment.route_mode}
                      </span>
                    </td>
                    <td>
                      {assignment.estimated_travel_time != null
                        ? `${Math.round(assignment.estimated_travel_time)}s`
                        : "—"}
                    </td>
                    <td>
                      {assignment.alternatives && assignment.alternatives.length > 0
                        ? assignment.alternatives
                            .map((alt) => `${alt.robot_name} (${alt.candidate_score})`)
                            .join(", ")
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="mc-card">
          <div className="mc-card-header">
            <h3>
              <FaExclamationTriangle /> Unassigned ({unassigned.length})
            </h3>
          </div>
          <div className="mc-table-scroll">
            <table className="mc-table">
              <thead>
                <tr>
                  <th>Task</th>
                  <th>Severity</th>
                  <th>Reason</th>
                  <th>Required Action</th>
                </tr>
              </thead>
              <tbody>
                {unassigned.length === 0 && (
                  <tr>
                    <td colSpan="4" className="mc-no-rows">
                      Every task has an eligible robot.
                    </td>
                  </tr>
                )}
                {unassigned.map((item) => (
                  <tr key={item.task_id}>
                    <td className="mc-task-id">{item.task_id}</td>
                    <td>
                      <span className={`mc-sev sev-${(item.severity || "").toLowerCase()}`}>
                        {item.severity}
                      </span>
                    </td>
                    <td>
                      <span className="mc-pill route-infeasible">{item.reason}</span>
                    </td>
                    <td>{item.required_action}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="mc-layout">
        <div className="mc-card">
          <div className="mc-card-header">
            <h3>
              <FaExclamationTriangle /> Conflicts ({conflicts.length})
            </h3>
          </div>
          <div className="mc-table-scroll">
            <table className="mc-table">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Severity</th>
                  <th>Message</th>
                  <th>Required Action</th>
                </tr>
              </thead>
              <tbody>
                {conflicts.length === 0 && (
                  <tr>
                    <td colSpan="4" className="mc-no-rows">
                      <FaCheckCircle /> No coordination conflicts detected.
                    </td>
                  </tr>
                )}
                {conflicts.map((conflict, index) => (
                  <tr key={`${conflict.type}-${conflict.robot_id ?? "r"}-${conflict.drain_id ?? "d"}-${index}`}>
                    <td>{conflict.type}</td>
                    <td>
                      <span className={`mc-sev sev-${(conflict.severity || "").toLowerCase()}`}>
                        {conflict.severity}
                      </span>
                    </td>
                    <td>{conflict.message}</td>
                    <td>{conflict.required_action}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="mc-card">
          <div className="mc-card-header">
            <h3>
              <FaRandom /> Reassignment Required ({reassignments.length})
            </h3>
          </div>
          <div className="mc-table-scroll">
            <table className="mc-table">
              <thead>
                <tr>
                  <th>Mission</th>
                  <th>Robot</th>
                  <th>Reason</th>
                  <th>Replacement</th>
                  <th>Required Action</th>
                </tr>
              </thead>
              <tbody>
                {reassignments.length === 0 && (
                  <tr>
                    <td colSpan="5" className="mc-no-rows">
                      No active mission requires reassignment.
                    </td>
                  </tr>
                )}
                {reassignments.map((item) => (
                  <tr key={item.mission_id}>
                    <td>
                      #{item.mission_id}
                      <span className="cell-sub">drain {item.drain_id ?? "—"}</span>
                    </td>
                    <td>
                      {item.current_robot_name || item.current_robot_id}
                      <span className="cell-sub">{item.current_status}</span>
                    </td>
                    <td>
                      <span className="mc-pill route-infeasible">{item.reason}</span>
                    </td>
                    <td>
                      {item.recommended_replacement
                        ? `${item.recommended_replacement.robot_name} (${item.recommended_replacement.candidate_score})`
                        : "none available"}
                    </td>
                    <td>{item.required_action}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {data && <p className="mc-disclaimer">{data.disclaimer}</p>}
    </div>
  );
}

export default MissionCoordinationPage;
