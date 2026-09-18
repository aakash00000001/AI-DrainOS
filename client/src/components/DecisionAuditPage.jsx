import { useEffect, useMemo, useState } from "react";
import {
  FaClipboardList,
  FaFileAlt,
  FaLayerGroup,
  FaExclamationTriangle,
  FaChevronRight,
  FaChevronDown,
  FaClock,
  FaSync,
  FaPlus
} from "react-icons/fa";
import "../styles/decisionAudit.css";
import socket from "../services/socket";
import {
  getDecisionAudits,
  getDecisionAuditSummary,
  getDecisionAuditExplanation,
  snapshotDecisionAudit
} from "../services/decisionAuditService";

const LEVEL_CLASS = {
  LOW: "audit-chip-low",
  MODERATE: "audit-chip-moderate",
  HIGH: "audit-chip-high",
  CRITICAL: "audit-chip-critical"
};

const DECISION_TYPE_OPTIONS = [
  "AI_DECISION",
  "FLOOD_RISK",
  "FORECAST",
  "MAINTENANCE",
  "SENSOR_INTELLIGENCE",
  "WEATHER_CORRELATION",
  "ROBOT_ROUTE",
  "MISSION_COORDINATION",
  "FLEET_OPTIMIZATION",
  "INCIDENT"
];

function formatTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString();
}

function formatJson(value) {
  if (value === null || value === undefined) return "—";
  return JSON.stringify(value, null, 2);
}

function DecisionAuditPage() {
  const [summary, setSummary] = useState(null);
  const [audits, setAudits] = useState([]);
  const [explanation, setExplanation] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [expandedId, setExpandedId] = useState(null);

  const [filterType, setFilterType] = useState("");
  const [filterDrain, setFilterDrain] = useState("");
  const [filterRobot, setFilterRobot] = useState("");
  const [page, setPage] = useState(1);

  const [snapshotType, setSnapshotType] = useState("AI_DECISION");
  const [snapshotDrain, setSnapshotDrain] = useState("");
  const [snapshotIncident, setSnapshotIncident] = useState("");

  const loadSummary = () => {
    getDecisionAuditSummary()
      .then((payload) => setSummary(payload.summary || null))
      .catch(() => setSummary(null));
  };

  const loadAudits = (nextPage = page, type = filterType, drain = filterDrain, robot = filterRobot) => {
    setLoading(true);
    setError(null);
    const params = {};
    if (type) params.decisionType = type;
    if (drain) params.drainId = drain;
    if (robot) params.robotId = robot;
    params.page = nextPage;
    params.limit = 20;

    getDecisionAudits(params)
      .then((payload) => setAudits(payload.audits || []))
      .catch((err) => {
        console.log("Decision audit list error:", err);
        setAudits([]);
        setError(err.response?.data?.error || "Could not load decision audits");
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    const initialLoad = setTimeout(() => {
      loadSummary();
      loadAudits(1);
    }, 0);
    const onUpdate = () => {
      loadSummary();
      loadAudits(page, filterType, filterDrain, filterRobot);
    };
    socket.on("decisionAuditUpdate", onUpdate);
    return () => {
      clearTimeout(initialLoad);
      socket.off("decisionAuditUpdate", onUpdate);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applyFilters = () => {
    setPage(1);
    loadAudits(1, filterType, filterDrain, filterRobot);
  };

  const toggleExplanation = (row) => {
    if (expandedId === row.id) {
      setExpandedId(null);
      setExplanation(null);
      return;
    }
    setExpandedId(row.id);
    setExplanation(null);
    getDecisionAuditExplanation(row.id)
      .then((payload) => setExplanation(payload.explanation || null))
      .catch(() => setExplanation(null));
  };

  const takeSnapshot = () => {
    setError(null);
    setNotice(null);
    const payload = { decisionType: snapshotType };
    if (snapshotDrain) payload.drainId = Number(snapshotDrain);
    if (snapshotIncident) payload.incidentId = Number(snapshotIncident);

    snapshotDecisionAudit(payload)
      .then((result) => {
        setNotice(
          result.recorded
            ? `Snapshot recorded (${result.reason}) for ${snapshotType}`
            : `Snapshot unchanged — no new record needed (${result.reason}) · audit is append-only`
        );
        loadSummary();
        applyFilters();
      })
      .catch((err) => setError(err.response?.data?.error || "Snapshot failed"));
  };

  const byLevel = useMemo(() => summary?.byLevel || {}, [summary]);
  const byType = useMemo(() => summary?.byDecisionType || {}, [summary]);

  return (
    <div className="audit-page">
      <div className="audit-page-header">
        <div>
          <h2>📋 Decision Audit</h2>
          <p className="audit-subtitle">
            Explainable AI + decision audit — a read-only trail that restates what the
            existing AI services computed. It never changes a formula or dispatches a robot.
          </p>
        </div>
        <div className="audit-actions">
          <button className="audit-btn" onClick={() => { loadSummary(); applyFilters(); }}>
            <FaSync /> Refresh
          </button>
        </div>
      </div>

      {error && <div className="audit-error">{error}</div>}
      {notice && <div className="audit-success">{notice}</div>}

      <div className="audit-stat-strip">
        <div className="audit-stat">
          <FaFileAlt />
          <div>
            <div className="audit-stat-value">{summary ? summary.total : "—"}</div>
            <div className="audit-stat-label">Recorded decisions</div>
          </div>
        </div>
        <div className="audit-stat">
          <FaLayerGroup />
          <div>
            <div className="audit-stat-value">{summary ? Object.keys(byType).length : "—"}</div>
            <div className="audit-stat-label">Decision types</div>
          </div>
        </div>
        <div className="audit-stat">
          <FaExclamationTriangle />
          <div>
            <div className="audit-stat-value">
              {summary ? (byLevel.CRITICAL || 0) + (byLevel.HIGH || 0) : "—"}
            </div>
            <div className="audit-stat-label">High + critical</div>
          </div>
        </div>
        <div className="audit-stat">
          <FaClipboardList />
          <div>
            <div className="audit-stat-value">
              {summary && summary.newest ? formatTime(summary.newest).split(",")[0] : "—"}
            </div>
            <div className="audit-stat-label">Latest record</div>
          </div>
        </div>
      </div>

      <div className="audit-level-chips">
        {Object.keys(byLevel)
          .sort()
          .map((level) => (
            <span key={level} className={`audit-chip ${LEVEL_CLASS[level] || ""}`}>
              {level}: {byLevel[level]}
            </span>
          ))}
      </div>

      <div className="audit-filters">
        <div className="audit-field">
          <label>Decision type</label>
          <select value={filterType} onChange={(e) => setFilterType(e.target.value)}>
            <option value="">All types</option>
            {DECISION_TYPE_OPTIONS.map((type) => (
              <option key={type} value={type}>{type}</option>
            ))}
          </select>
        </div>
        <div className="audit-field">
          <label>Drain ID</label>
          <input
            type="number"
            min="1"
            value={filterDrain}
            onChange={(e) => setFilterDrain(e.target.value)}
            placeholder="e.g. 3"
          />
        </div>
        <div className="audit-field">
          <label>Robot ID</label>
          <input
            type="number"
            min="1"
            value={filterRobot}
            onChange={(e) => setFilterRobot(e.target.value)}
            placeholder="e.g. 1"
          />
        </div>
        <button className="audit-btn audit-btn-primary" onClick={applyFilters}>
          Apply filters
        </button>
      </div>

      <div className="audit-list">
        {loading && <div className="audit-empty">Loading audits…</div>}
        {!loading && audits.length === 0 && (
          <div className="audit-empty">
            No audit records match. Records are only created on meaningful changes or
            explicit snapshots.
          </div>
        )}
        {!loading &&
          audits.map((row) => (
            <div className="audit-row" key={row.id}>
              <div className="audit-row-head" onClick={() => toggleExplanation(row)}>
                <span className="audit-badge audit-badge-ready">{row.decisionType}</span>
                {row.level && (
                  <span className={`audit-chip ${LEVEL_CLASS[row.level] || ""}`}>{row.level}</span>
                )}
                <span className="audit-type">
                  {row.entityType === "DRAIN" ? `Drain ${row.drainId || row.entityId}` : (row.entityType || "")}
                  {row.robotId ? ` · Robot ${row.robotId}` : ""}
                </span>
                <span className="audit-meta">
                  <FaClock /> {formatTime(row.timestamp)}
                  {row.score !== null && row.score !== undefined ? ` · score ${row.score}` : ""}
                  <span className="audit-expand" style={{ cursor: "pointer" }}>
                    {expandedId === row.id ? <FaChevronDown /> : <FaChevronRight />}{" "}
                    {expandedId === row.id ? "Hide explanation" : "Explain"}
                  </span>
                </span>
              </div>

              {expandedId === row.id && (
                <div className="audit-detail">
                  {explanation ? (
                    <pre className="audit-explanation">{explanation.explanation}</pre>
                  ) : (
                    <div className="audit-empty">Loading explanation…</div>
                  )}
                  <div className="audit-grid">
                    <div className="audit-card">
                      <h4>Inputs</h4>
                      <pre>{formatJson(explanation ? explanation.inputs : row.inputs)}</pre>
                    </div>
                    <div className="audit-card">
                      <h4>Contributions</h4>
                      <pre>{formatJson(explanation ? explanation.contributions : row.contributions)}</pre>
                    </div>
                    <div className="audit-card">
                      <h4>Evidence</h4>
                      <pre>{formatJson(explanation ? explanation.evidence : row.evidence)}</pre>
                    </div>
                    <div className="audit-card">
                      <h4>Limitations</h4>
                      <pre>{row.limitations || "—"}</pre>
                    </div>
                  </div>
                </div>
              )}
            </div>
          ))}
      </div>

      <div className="audit-pagination">
        <button
          className="audit-btn"
          disabled={page <= 1}
          onClick={() => {
            const next = page - 1;
            setPage(next);
            loadAudits(next);
          }}
        >
          ← Prev
        </button>
        <span className="audit-meta">Page {page}</span>
        <button
          className="audit-btn"
          disabled={audits.length < 20}
          onClick={() => {
            const next = page + 1;
            setPage(next);
            loadAudits(next);
          }}
        >
          Next →
        </button>
      </div>

      <div className="audit-shell" style={{ marginTop: "18px" }}>
        <h3 style={{ margin: "0 0 8px" }}>Take an on-demand snapshot</h3>
        <p className="audit-subtitle">
          Records the current state of an existing engine into the append-only trail.
          Repeated identical snapshots are de-duplicated.
        </p>
        <div className="audit-filters">
          <div className="audit-field">
            <label>Decision type</label>
            <select value={snapshotType} onChange={(e) => setSnapshotType(e.target.value)}>
              {DECISION_TYPE_OPTIONS.map((type) => (
                <option key={type} value={type}>{type}</option>
              ))}
            </select>
          </div>
          <div className="audit-field">
            <label>Drain ID (most types)</label>
            <input
              type="number"
              min="1"
              value={snapshotDrain}
              onChange={(e) => setSnapshotDrain(e.target.value)}
              placeholder="e.g. 3"
            />
          </div>
          <div className="audit-field">
            <label>Incident ID (INCIDENT only)</label>
            <input
              type="number"
              min="1"
              value={snapshotIncident}
              onChange={(e) => setSnapshotIncident(e.target.value)}
              placeholder="e.g. 5"
            />
          </div>
          <button className="audit-btn audit-btn-primary" onClick={takeSnapshot}>
            <FaPlus /> Record snapshot
          </button>
        </div>
      </div>

      <p className="audit-note">
        Append-only trail: records are never updated or deleted. Explanations restate the
        existing AI services&apos; own outputs — no confidence values are invented, no causal
        claims are made, and the audit layer never dispatches robots.
      </p>
    </div>
  );
}

export default DecisionAuditPage;