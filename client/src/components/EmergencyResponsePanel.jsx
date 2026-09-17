import { useEffect, useMemo, useState } from "react";
import axios from "axios";
import {
  FaAmbulance,
  FaCheckCircle,
  FaExclamationTriangle,
  FaPlus,
  FaRobot,
  FaAngleDoubleRight,
  FaListUl
} from "react-icons/fa";
import "../styles/incidents.css";
import socket from "../services/socket";
import { API_URL } from "../services/api";
import {
  getActiveIncidents,
  createIncident,
  acknowledgeIncident,
  respondToIncident,
  resolveIncident
} from "../services/incidentService";

function EmergencyResponsePanel({ onOpen }) {

  const [incidents, setIncidents] = useState([]);
  const [drains, setDrains] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [message, setMessage] = useState(null);
  const [form, setForm] = useState({ drain_id: "", severity: "CRITICAL", title: "" });

  const loadActive = () => {
    getActiveIncidents()
      .then((data) => setIncidents(data))
      .catch((error) => console.log("Incident load error:", error));
  };

  useEffect(() => {
    loadActive();

    axios
      .get(`${API_URL}/drains`)
      .then((res) => setDrains(res.data))
      .catch(() => {});

    socket.on("incidentUpdate", (payload) => {
      if (!payload || !payload.incident) return;
      // Re-pull from the server so the list always reflects real state.
      loadActive();
    });

    return () => {
      socket.off("incidentUpdate");
    };
  }, []);

  const counts = useMemo(() => {
    const active = incidents.filter(
      (i) => i.status === "OPEN" || i.status === "ACKNOWLEDGED" || i.status === "RESPONDING"
    ).length;
    const critical = incidents.filter((i) => i.severity === "CRITICAL").length;
    const responding = incidents.filter((i) => i.status === "RESPONDING").length;
    const unacknowledged = incidents.filter((i) => i.status === "OPEN").length;
    return { active, critical, responding, unacknowledged };
  }, [incidents]);

  const createManual = async () => {
    setMessage(null);
    if (!form.drain_id) {
      setMessage({ type: "error", text: "Select a drain for the incident" });
      return;
    }

    try {
      const created = await createIncident({
        drain_id: Number(form.drain_id),
        severity: form.severity,
        source: "MANUAL",
        title: form.title.trim() || null
      });

      setMessage({ type: "success", text: `Incident #${created.id} created` });
      setForm({ drain_id: "", severity: "CRITICAL", title: "" });
      setShowForm(false);
      loadActive();
    } catch (error) {
      setMessage({
        type: "error",
        text: error.response?.data?.error || "Failed to create incident"
      });
    }
  };

  const onAction = async (id, action, isResolve) => {
    setMessage(null);

    try {
      if (isResolve) {
        const notes = window.prompt("Resolution notes (optional):") || null;
        await resolveIncident(id, notes);
      } else if (action === "ack") {
        await acknowledgeIncident(id);
      } else {
        await respondToIncident(id);
      }
      loadActive();
    } catch (error) {
      setMessage({
        type: "error",
        text: error.response?.data?.error || "Action failed"
      });
    }
  };

  return (
    <div className="incident-shell">

      <div className="incident-shell-header">

        <div>
          <h2>🚨 Emergency Response</h2>
          <p className="incident-subtitle">
            Autonomous incident lifecycle · OPEN → ACKNOWLEDGED → RESPONDING → RESOLVED
          </p>
        </div>

        <div className="incident-actions">
          <button
            className="btn btn-primary btn-sm"
            onClick={() => setShowForm(!showForm)}
          >
            <FaPlus /> {showForm ? "Close" : "Manual Incident"}
          </button>
          <button className="btn btn-outline btn-sm" onClick={onOpen}>
            <FaListUl /> All Incidents
          </button>
        </div>

      </div>

      {message && (
        <div className={`status-msg ${message.type}`}>
          {message.text}
        </div>
      )}

      <div className="incident-stat-strip">

        <div className={`incident-stat ${counts.active > 0 ? "stat-danger" : ""}`}>
          <FaAmbulance />
          <div>
            <strong>{counts.active}</strong>
            <span>Active</span>
          </div>
        </div>

        <div className={`incident-stat ${counts.critical > 0 ? "stat-critical" : ""}`}>
          <FaExclamationTriangle />
          <div>
            <strong>{counts.critical}</strong>
            <span>Critical</span>
          </div>
        </div>

        <div className={`incident-stat ${counts.responding > 0 ? "stat-active" : ""}`}>
          <FaRobot />
          <div>
            <strong>{counts.responding}</strong>
            <span>Responding</span>
          </div>
        </div>

        <div className={`incident-stat ${counts.unacknowledged > 0 ? "stat-warn" : ""}`}>
          <FaAngleDoubleRight />
          <div>
            <strong>{counts.unacknowledged}</strong>
            <span>Unacknowledged</span>
          </div>
        </div>

      </div>

      {showForm && (
        <div className="panel-card incident-create">

          <h3>📝 Manual Incident (source: MANUAL)</h3>

          <div className="panel-grid">
            <div className="form-group">
              <label>Drain</label>
              <select
                value={form.drain_id}
                onChange={(e) => setForm({ ...form, drain_id: e.target.value })}
              >
                <option value="">Select drain...</option>
                {drains.map((drain) => (
                  <option key={drain.id} value={drain.id}>
                    {drain.zone_name} — {drain.location}
                  </option>
                ))}
              </select>
            </div>

            <div className="form-group">
              <label>Severity</label>
              <select
                value={form.severity}
                onChange={(e) => setForm({ ...form, severity: e.target.value })}
              >
                <option value="CRITICAL">CRITICAL</option>
                <option value="HIGH">HIGH</option>
                <option value="MODERATE">MODERATE</option>
                <option value="LOW">LOW</option>
              </select>
            </div>

            <div className="form-group">
              <label>Title (optional)</label>
              <input
                type="text"
                placeholder="Brief description..."
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
              />
            </div>
          </div>

          <button className="btn btn-success" onClick={createManual}>
            <FaPlus /> Create Incident
          </button>

        </div>
      )}

      {incidents.length === 0 && (
        <div className="incident-empty">
          <FaCheckCircle /> No active incidents. The system is monitoring.
        </div>
      )}

      {incidents.map((incident) => (
        <div key={incident.id} className="incident-item">

          <div className="incident-item-top">
            <span className={`incident-severity sev-${(incident.severity || "").toLowerCase()}`}>
              {incident.severity}
            </span>
            <span className={`incident-status st-${(incident.status || "").toLowerCase()}`}>
              {incident.status}
            </span>
            <span className="incident-id">#{incident.id}</span>
          </div>

          <h3>{incident.title || `${incident.source} incident`}</h3>

          <p className="incident-location">
            📍 {incident.drain ? incident.drain.zone : "Unknown"} —{" "}
            {incident.drain ? incident.drain.location : "Unknown"}
            {incident.decision_level ? ` · 🧠 ${incident.decision_level}` : ""}
            {typeof incident.decision_score === "number"
              ? ` · score ${incident.decision_score}`
              : ""}
          </p>

          <p className="incident-meta">
            <span>Source: {incident.source}</span>
            <span>
              Robot:{" "}
              {incident.robot
                ? incident.robot.robotName
                : incident.assigned_robot_id
                  ? `Robot #${incident.assigned_robot_id}`
                  : "None"}
            </span>
            <span>Route: {incident.route_status || "—"}</span>
            <span>Opened: {new Date(incident.created_at).toLocaleString()}</span>
          </p>

          <div className="incident-item-actions">

            {incident.status === "OPEN" && (
              <button className="btn btn-warning btn-sm" onClick={() => onAction(incident.id, "ack")}>
                <FaAngleDoubleRight /> Acknowledge
              </button>
            )}

            {incident.status === "ACKNOWLEDGED" && (
              <button className="btn btn-primary btn-sm" onClick={() => onAction(incident.id, "respond")}>
                <FaRobot /> Start Response
              </button>
            )}

            {incident.status === "RESPONDING" && (
              <button className="btn btn-success btn-sm" onClick={() => onAction(incident.id, null, true)}>
                <FaCheckCircle /> Resolve
              </button>
            )}

          </div>

        </div>
      ))}

    </div>
  );
}

export default EmergencyResponsePanel;