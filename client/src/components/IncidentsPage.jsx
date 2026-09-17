import { useCallback, useEffect, useMemo, useState } from "react";
import axios from "axios";
import {
  FaSync,
  FaPlus,
  FaCheckCircle,
  FaAngleDoubleRight,
  FaRobot,
  FaTimes,
  FaEye
} from "react-icons/fa";
import "../styles/incidents.css";
import socket from "../services/socket";
import { API_URL } from "../services/api";
import {
  getIncidents,
  createIncident,
  acknowledgeIncident,
  respondToIncident,
  resolveIncident,
  getIncident
} from "../services/incidentService";
import IncidentTimeline from "./IncidentTimeline";

const STATUS_ORDER = ["OPEN", "ACKNOWLEDGED", "RESPONDING", "RESOLVED"];

function IncidentsPage() {

  const [incidents, setIncidents] = useState([]);
  const [drains, setDrains] = useState([]);
  const [message, setMessage] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ drain_id: "", severity: "CRITICAL", title: "", description: "" });
  const [detailMode, setDetailMode] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [resolveNotes, setResolveNotes] = useState("");
  const [filters, setFilters] = useState({ status: "", severity: "", drain_id: "" });

  const [now, setNow] = useState(0);

  const loadIncidents = useCallback(() => {
    const params = {};
    if (filters.status) params.status = filters.status;
    if (filters.severity) params.severity = filters.severity;
    if (filters.drain_id) params.drain_id = filters.drain_id;

    getIncidents(params)
      .then((data) => {
        setIncidents(data);
        setNow(Date.now());
      })
      .catch((error) => console.log("Incidents load error:", error));
  }, [filters]);

  useEffect(() => {
    loadIncidents();
  }, [loadIncidents]);

  useEffect(() => {
    axios
      .get(`${API_URL}/drains`)
      .then((res) => setDrains(res.data))
      .catch(() => {});

    socket.on("incidentUpdate", () => {
      loadIncidents();
    });

    const ticker = setInterval(() => setNow(Date.now()), 30000);

    return () => {
      socket.off("incidentUpdate");
      clearInterval(ticker);
    };
  }, [loadIncidents]);

  const sorted = useMemo(() => {
    const rank = (i) => STATUS_ORDER.indexOf(i.status);
    return [...incidents].sort(
      (a, b) => rank(a) - rank(b) || new Date(b.created_at) - new Date(a.created_at)
    );
  }, [incidents]);

  const activeCount = sorted.filter(
    (i) => i.status === "OPEN" || i.status === "ACKNOWLEDGED" || i.status === "RESPONDING"
  ).length;

  const ageLabel = (createdAt) => {
    if (!now) return "—";
    const minutes = Math.floor((now - new Date(createdAt).getTime()) / 60000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  };

  const openDetail = async (id) => {
    try {
      const incident = await getIncident(id);
      const refreshed = incident.id
        ? incidents.map((i) => (i.id === incident.id ? incident : i))
        : incidents;
      if (incident.id) setIncidents(refreshed);
    } catch (error) {
      console.log("Incident detail error:", error);
    }
    setSelectedId(id);
    setResolveNotes("");
    setDetailMode(true);
  };

  const selected = sorted.find((i) => i.id === selectedId) || null;

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
        title: form.title.trim() || null,
        description: form.description.trim() || null
      });

      setMessage({ type: "success", text: `Incident #${created.id} created` });
      setForm({ drain_id: "", severity: "CRITICAL", title: "", description: "" });
      setShowForm(false);
      loadIncidents();
    } catch (error) {
      setMessage({
        type: "error",
        text: error.response?.data?.error || "Failed to create incident"
      });
    }
  };

  const runAction = async (id, action, notes = null) => {
    setMessage(null);
    try {
      if (action === "ack") await acknowledgeIncident(id);
      if (action === "respond") await respondToIncident(id);
      if (action === "resolve") await resolveIncident(id, notes);
      await loadIncidents();
      setDetailMode(false);
    } catch (error) {
      setMessage({
        type: "error",
        text: error.response?.data?.error || "Action failed"
      });
    }
  };

  return (
    <div className="incident-page">

      <div className="incident-page-header">

        <div>
          <h2>🚨 Incident Intelligence</h2>
          <p className="incident-subtitle">
            {activeCount} active incident{activeCount === 1 ? "" : "s"} ·{" "}
            {sorted.filter((i) => i.status === "CRITICAL" || i.severity === "CRITICAL").length} critical · real-time via incidentUpdate
          </p>
        </div>

        <div className="incident-actions">
          <button className="btn btn-outline btn-sm" onClick={loadIncidents}>
            <FaSync /> Refresh
          </button>
          <button className="btn btn-primary btn-sm" onClick={() => setShowForm(!showForm)}>
            <FaPlus /> {showForm ? "Close" : "Manual Incident"}
          </button>
        </div>

      </div>

      {message && (
        <div className={`status-msg ${message.type}`}>
          {message.text}
        </div>
      )}

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
                placeholder="Brief title..."
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
              />
            </div>

            <div className="form-group">
              <label>Description (optional)</label>
              <textarea
                placeholder="Additional context..."
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
              />
            </div>
          </div>

          <button className="btn btn-success" onClick={createManual}>
            <FaPlus /> Create Incident
          </button>

        </div>
      )}

      <div className="incident-filter-bar">

        <div className="form-group">
          <label>Status</label>
          <select
            value={filters.status}
            onChange={(e) => setFilters({ ...filters, status: e.target.value })}
          >
            <option value="">All</option>
            {STATUS_ORDER.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>

        <div className="form-group">
          <label>Severity</label>
          <select
            value={filters.severity}
            onChange={(e) => setFilters({ ...filters, severity: e.target.value })}
          >
            <option value="">All</option>
            {["CRITICAL", "HIGH", "MODERATE", "LOW"].map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>

        <div className="form-group">
          <label>Drain</label>
          <select
            value={filters.drain_id}
            onChange={(e) => setFilters({ ...filters, drain_id: e.target.value })}
          >
            <option value="">All</option>
            {drains.map((drain) => (
              <option key={drain.id} value={drain.id}>
                {drain.zone_name}
              </option>
            ))}
          </select>
        </div>

      </div>

      <div className={`incident-layout ${detailMode ? "has-detail" : ""}`}>

        <div className="table-card incident-list-card">

          <div className="table-header">

            <div className="incident-table-scroll">
              <table className="incident-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Drain</th>
                    <th>Severity</th>
                    <th>Source</th>
                    <th>Decision</th>
                    <th>Robot</th>
                    <th>Route</th>
                    <th>Status</th>
                    <th>Opened</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.length === 0 && (
                    <tr>
                      <td colSpan="10" className="incident-no-rows">
                        No incidents match the current filters.
                      </td>
                    </tr>
                  )}
                  {sorted.map((incident) => (
                    <tr
                      key={incident.id}
                      className={selectedId === incident.id ? "row-selected" : ""}
                      onClick={() => openDetail(incident.id)}
                    >
                      <td className="incident-id">#{incident.id}</td>
                      <td>
                        <strong>{incident.drain ? incident.drain.zone : "Unknown"}</strong>
                        <span className="cell-sub">{incident.drain ? incident.drain.location : "—"}</span>
                      </td>
                      <td>
                        <span className={`incident-severity sev-${(incident.severity || "").toLowerCase()}`}>
                          {incident.severity}
                        </span>
                      </td>
                      <td>{incident.source}</td>
                      <td>
                        {incident.decision_level || "—"}
                        {typeof incident.decision_score === "number"
                          ? <span className="cell-sub"> ({incident.decision_score})</span>
                          : null}
                      </td>
                      <td>{incident.robot ? incident.robot.robotName : "—"}</td>
                      <td>
                        <span className={`route-pill route-${(incident.route_status || "").toLowerCase()}`}>
                          {incident.route_status || "—"}
                        </span>
                      </td>
                      <td>
                        <span className={`incident-status st-${(incident.status || "").toLowerCase()}`}>
                          {incident.status}
                        </span>
                      </td>
                      <td>
                        {ageLabel(incident.created_at)}
                        <span className="cell-sub">{new Date(incident.created_at).toLocaleDateString()}</span>
                      </td>
                      <td className="row-action">
                        <button
                          className="btn btn-outline btn-sm"
                          onClick={(e) => { e.stopPropagation(); openDetail(incident.id); }}
                        >
                          <FaEye /> Detail
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

          </div>

        </div>

        {detailMode && (
          <div className="incident-detail panel-card">

            <div className="incident-detail-head">
              <h3>
                Incident #{selected?.id}
                {selected ? (
                  <>
                    <span className={`incident-status st-${(selected.status || "").toLowerCase()}`}>
                      {selected.status}
                    </span>
                    <span className={`incident-severity sev-${(selected.severity || "").toLowerCase()}`}>
                      {selected.severity}
                    </span>
                  </>
                ) : null}
              </h3>
              <button className="btn btn-outline btn-sm" onClick={() => setDetailMode(false)}>
                <FaTimes /> Close
              </button>
            </div>

            {selected && (
              <>
                <div className="incident-detail-grid">
                  <p><strong>Drain</strong> {selected.drain ? selected.drain.zone : "Unknown"} — {selected.drain ? selected.drain.location : "—"}</p>
                  <p><strong>Source</strong> {selected.source}</p>
                  <p><strong>Decision</strong> {selected.decision_level || "—"}{typeof selected.decision_score === "number" ? ` (${selected.decision_score})` : ""}</p>
                  <p><strong>Robot</strong> {selected.robot ? selected.robot.robotName : selected.assigned_robot_id ? `Robot #${selected.assigned_robot_id}` : "None"}</p>
                  <p><strong>Route status</strong> {selected.route_status || "—"}</p>
                  <p><strong>Created</strong> {new Date(selected.created_at).toLocaleString()}</p>
                  <p><strong>Acknowledged</strong> {selected.acknowledged_at ? new Date(selected.acknowledged_at).toLocaleString() : "—"}</p>
                  <p><strong>Response started</strong> {selected.responding_at ? new Date(selected.responding_at).toLocaleString() : "—"}</p>
                  {selected.resolved_at && (
                    <p><strong>Resolved</strong> {new Date(selected.resolved_at).toLocaleString()}</p>
                  )}
                  {selected.resolution_notes && (
                    <p className="detail-wide"><strong>Resolution notes</strong> {selected.resolution_notes}</p>
                  )}
                </div>

                {selected.description && (
                  <p className="detail-wide"><strong>Description</strong> {selected.description}</p>
                )}

                <div className="incident-detail-actions">

                  {selected.status === "OPEN" && (
                    <button className="btn btn-warning" onClick={() => runAction(selected.id, "ack")}>
                      <FaAngleDoubleRight /> Acknowledge
                    </button>
                  )}

                  {selected.status === "ACKNOWLEDGED" && (
                    <button className="btn btn-primary" onClick={() => runAction(selected.id, "respond")}>
                      <FaRobot /> Start Response
                    </button>
                  )}

                  {selected.status === "RESPONDING" && (
                    <>
                      <textarea
                        className="resolve-notes"
                        placeholder="Resolution notes (optional)..."
                        value={resolveNotes}
                        onChange={(e) => setResolveNotes(e.target.value)}
                      />
                      <button
                        className="btn btn-success"
                        onClick={() => runAction(selected.id, "resolve", resolveNotes.trim() || null)}
                      >
                        <FaCheckCircle /> Resolve Incident
                      </button>
                    </>
                  )}

                </div>

                <h4 className="timeline-title">⏱ Lifecycle Timeline</h4>
                <IncidentTimeline incidentId={selected.id} />
              </>
            )}

          </div>
        )}

      </div>

    </div>
  );
}

export default IncidentsPage;