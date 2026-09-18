import { useEffect, useMemo, useState } from "react";
import {
  FaFileAlt,
  FaLayerGroup,
  FaExclamationTriangle,
  FaChevronRight,
  FaClock
} from "react-icons/fa";
import "../styles/decisionAudit.css";
import socket from "../services/socket";
import {
  getDecisionAuditSummary,
  getRecentDecisionAudits
} from "../services/decisionAuditService";

const LEVEL_CLASS = {
  LOW: "audit-chip-low",
  MODERATE: "audit-chip-moderate",
  HIGH: "audit-chip-high",
  CRITICAL: "audit-chip-critical"
};

function formatTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString();
}

function DecisionAuditPanel({ onOpen }) {
  const [summary, setSummary] = useState(null);
  const [recent, setRecent] = useState([]);
  const [expandedId, setExpandedId] = useState(null);

  const refresh = () => {
    getDecisionAuditSummary()
      .then((payload) => setSummary(payload.summary || null))
      .catch((err) => {
        console.log("Decision audit summary error:", err);
        setSummary(null);
      });
    getRecentDecisionAudits(5)
      .then((payload) => setRecent(payload.audits || []))
      .catch((err) => {
        console.log("Decision audit recent error:", err);
        setRecent([]);
      });
  };

  useEffect(() => {
    refresh();
    const onUpdate = () => refresh();
    socket.on("decisionAuditUpdate", onUpdate);
    return () => {
      socket.off("decisionAuditUpdate", onUpdate);
    };
  }, []);

  const byLevel = useMemo(() => summary?.byLevel || {}, [summary]);
  const typeCount = useMemo(
    () => (summary ? Object.keys(summary.byDecisionType || {}).length : 0),
    [summary]
  );

  return (
    <div className="audit-shell">
      <div className="audit-shell-header">
        <div>
          <h2>📋 Decision Audit</h2>
          <p className="audit-subtitle">
            Read-only trail of the AI layer's own outputs · meaningful changes only
          </p>
        </div>
        <div className="audit-actions">
          <button className="audit-btn" onClick={onOpen}>
            Open audit <FaChevronRight />
          </button>
        </div>
      </div>

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
            <div className="audit-stat-value">{typeCount || "—"}</div>
            <div className="audit-stat-label">Decision types</div>
          </div>
        </div>
        <div className="audit-stat">
          <FaExclamationTriangle />
          <div>
            <div className="audit-stat-value">{(byLevel.CRITICAL || 0) + (byLevel.HIGH || 0) || 0}</div>
            <div className="audit-stat-label">High + critical</div>
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
        {(!summary || summary.total === 0) && (
          <span className="audit-chip">No audit records yet</span>
        )}
      </div>

      {summary && summary.total === 0 ? (
        <div className="audit-empty">
          No decisions have been recorded yet. The audit trail fills when the live loop
          records a meaningful change or an on-demand snapshot is taken.
        </div>
      ) : (
        <div className="audit-list">
          {recent.map((row) => (
            <div className="audit-row" key={row.id}>
              <div
                className="audit-row-head"
                onClick={() => setExpandedId(expandedId === row.id ? null : row.id)}
              >
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
                  <span className="audit-expand">
                    {expandedId === row.id ? "Hide" : "Explain"}
                  </span>
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      <p className="audit-note">
        Audit records are append-only and never rewritten. Explanations restate the
        existing AI services&apos; own outputs — no confidence values are invented and no
        robots are dispatched from the audit layer.
      </p>
    </div>
  );
}

export default DecisionAuditPanel;