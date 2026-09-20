import { useEffect, useState } from "react";
import {
  FaUserShield,
  FaChevronRight,
  FaChevronDown,
  FaSync
} from "react-icons/fa";
import "../styles/operatorAudit.css";
import {
  getOperatorAudits,
  getOperatorAuditSummary
} from "../services/operatorAuditService";

const ACTION_OPTIONS = [
  "DRAIN_CREATE",
  "DRAIN_UPDATE",
  "DRAIN_UPDATE_STATUS",
  "DRAIN_DELETE",
  "ALERT_CREATE",
  "ALERT_UPDATE",
  "MISSION_DISPATCH",
  "INCIDENT_CREATE",
  "INCIDENT_ACKNOWLEDGE",
  "INCIDENT_RESPOND",
  "INCIDENT_RESOLVE",
  "SETTINGS_UPDATE",
  "MISSION_COORDINATION_PLAN",
  "USER_CREATE",
  "USER_UPDATE",
  "USER_UPDATE_ROLE",
  "USER_UPDATE_STATUS",
  "USER_DELETE",
  "PASSWORD_CHANGE"
];

const ENTITY_TYPE_OPTIONS = [
  "DRAIN",
  "ALERT",
  "MISSION",
  "INCIDENT",
  "SETTINGS",
  "USER",
  "SYSTEM"
];

const SENSITIVE_PARTS = [
  "password",
  "passwd",
  "token",
  "authorization",
  "apikey",
  "secret",
  "credential",
  "jwt",
  "cookie"
];

function formatTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString();
}

function isSensitiveKey(key) {
  const normalized = String(key).toLowerCase().replace(/[^a-z0-9]/g, "");
  return SENSITIVE_PARTS.some((part) => normalized.includes(part));
}

// Defensive second line of defence: even if a payload somehow reached the
// API unredacted, the UI never renders sensitive values.
function redactForDisplay(value) {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(redactForDisplay);
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = isSensitiveKey(key) ? "[REDACTED]" : redactForDisplay(item);
  }
  return out;
}

function formatJson(value) {
  if (value === null || value === undefined) return "—";
  return JSON.stringify(redactForDisplay(value), null, 2);
}

function OperatorAuditPage() {
  const [summary, setSummary] = useState(null);
  const [audits, setAudits] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const [filterAction, setFilterAction] = useState("");
  const [filterEntityType, setFilterEntityType] = useState("");
  const [filterEntityId, setFilterEntityId] = useState("");
  const [page, setPage] = useState(1);
  const [expandedId, setExpandedId] = useState(null);

  const loadSummary = () => {
    getOperatorAuditSummary()
      .then((payload) => setSummary(payload.summary || null))
      .catch(() => setSummary(null));
  };

  const loadAudits = (nextPage = page, action = filterAction, entityType = filterEntityType, entityId = filterEntityId) => {
    setLoading(true);
    setError(null);
    const params = {};
    if (action) params.action = action;
    if (entityType) params.entityType = entityType;
    if (entityId) params.entityId = entityId;
    params.page = nextPage;
    params.limit = 20;

    getOperatorAudits(params)
      .then((payload) => setAudits(payload.audits || []))
      .catch((err) => {
        console.log("Operator audit list error:", err);
        setAudits([]);
        setError(err.response?.data?.error || "Could not load operator audits");
      })
      .finally(() => setLoading(false));
  };

  const initialLoad = () => {
    loadSummary();
    loadAudits(1);
  };

  useEffect(() => {
    const timer = setTimeout(initialLoad, 0);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applyFilters = () => {
    setPage(1);
    loadAudits(1, filterAction, filterEntityType, filterEntityId);
  };

  const resetFilters = () => {
    setFilterAction("");
    setFilterEntityType("");
    setFilterEntityId("");
    setPage(1);
    loadAudits(1, "", "", "");
  };

  const goToPage = (nextPage) => {
    if (nextPage < 1) return;
    setPage(nextPage);
    loadAudits(nextPage, filterAction, filterEntityType, filterEntityId);
  };

  const toggleExpand = (id) => {
    setExpandedId(expandedId === id ? null : id);
  };

  const totalFromSummary = summary ? summary.total : 0;
  const lastIndex = page * 20;
  const pageStart = totalFromSummary > 0 ? (page - 1) * 20 + 1 : 0;
  const pageEnd = Math.min(lastIndex, totalFromSummary);
  const hasMore = totalFromSummary > pageEnd;

  return (
    <div className="oa-page">
      <div className="oa-page-header">
        <div className="oa-title">
          <FaUserShield />
          <div>
            <h3>Operator Action Audit Trail</h3>
            <p>
              Admin-only, append-only record of human operator actions.
              Never blocks the real action it records.
            </p>
          </div>
        </div>
        <button
          className="oa-refresh"
          onClick={() => {
            loadSummary();
            loadAudits(page);
          }}
        >
          <FaSync />
          <span>Refresh</span>
        </button>
      </div>

      {summary && (
        <div className="oa-summary">
          <div className="oa-summary-card oa-summary-total">
            <span className="oa-summary-label">Recorded actions</span>
            <span className="oa-summary-value">{summary.total}</span>
          </div>
          <div className="oa-summary-card">
            <span className="oa-summary-label">Oldest</span>
            <span className="oa-summary-sub">{formatTime(summary.oldest)}</span>
          </div>
          <div className="oa-summary-card">
            <span className="oa-summary-label">Newest</span>
            <span className="oa-summary-sub">{formatTime(summary.newest)}</span>
          </div>
          <div className="oa-summary-card oa-summary-operators">
            <span className="oa-summary-label">Top operators</span>
            <span className="oa-summary-sub">
              {Object.entries(summary.byOperator || {})
                .slice(0, 3)
                .map(([email, count]) => `${email} (${count})`)
                .join(", ") || "—"}
            </span>
          </div>
        </div>
      )}

      <div className="oa-filters">
        <select
          value={filterAction}
          onChange={(e) => setFilterAction(e.target.value)}
        >
          <option value="">All actions</option>
          {ACTION_OPTIONS.map((action) => (
            <option key={action} value={action}>
              {action}
            </option>
          ))}
        </select>

        <select
          value={filterEntityType}
          onChange={(e) => setFilterEntityType(e.target.value)}
        >
          <option value="">All entity types</option>
          {ENTITY_TYPE_OPTIONS.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </select>

        <input
          type="number"
          min="1"
          placeholder="Entity ID"
          value={filterEntityId}
          onChange={(e) => setFilterEntityId(e.target.value)}
        />

        <button className="oa-button oa-primary" onClick={applyFilters}>
          Apply
        </button>
        <button className="oa-button" onClick={resetFilters}>
          Reset
        </button>
      </div>

      {error && <div className="oa-error">{error}</div>}

      <div className="oa-table-wrap">
        <table className="oa-table">
          <thead>
            <tr>
              <th></th>
              <th>Time</th>
              <th>Operator</th>
              <th>Action</th>
              <th>Entity</th>
              <th>Method / Status</th>
            </tr>
          </thead>
          <tbody>
            {audits.length === 0 && (
              <tr>
                <td colSpan="6" className="oa-empty">
                  {loading ? "Loading..." : "No operator actions recorded yet"}
                </td>
              </tr>
            )}
            {audits.map((audit) => (
              <AuditRow
                key={audit.id}
                audit={audit}
                expanded={expandedId === audit.id}
                onToggle={() => toggleExpand(audit.id)}
              />
            ))}
          </tbody>
        </table>
      </div>

      {totalFromSummary > 20 && (
        <div className="oa-pagination">
          <button
            className="oa-button"
            disabled={page <= 1}
            onClick={() => goToPage(page - 1)}
          >
            Prev
          </button>
          <span>
            {pageStart}-{pageEnd} of {totalFromSummary}
            {hasMore ? ` (next: ${page + 1})` : ""}
          </span>
          <button
            className="oa-button"
            disabled={!hasMore}
            onClick={() => goToPage(page + 1)}
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}

function AuditRow({ audit, expanded, onToggle }) {
  const entityLabel = audit.entityType
    ? `${audit.entityType}${audit.entityId ? ` #${audit.entityId}` : ""}`
    : "—";

  return (
    <>
      <tr className="oa-row" onClick={onToggle}>
        <td className="oa-expand-cell">
          {expanded ? <FaChevronDown /> : <FaChevronRight />}
        </td>
        <td>{formatTime(audit.createdAt)}</td>
        <td>{audit.userEmail || "—"}</td>
        <td>
          <span className="oa-chip">{audit.action}</span>
        </td>
        <td>{entityLabel}</td>
        <td>
          {audit.method || "—"} {audit.status || ""}
        </td>
      </tr>
      {expanded && (
        <tr className="oa-detail-row">
          <td></td>
          <td colSpan="5">
            <div className="oa-detail">
              {audit.requestId && (
                <div className="oa-detail-meta">
                  Request ID: {audit.requestId}
                </div>
              )}
              {audit.route && (
                <div className="oa-detail-meta">Route: {audit.route}</div>
              )}
              <div className="oa-detail-grid">
                <div>
                  <strong>Before</strong>
                  <pre>{formatJson(audit.beforeData)}</pre>
                </div>
                <div>
                  <strong>After</strong>
                  <pre>{formatJson(audit.afterData)}</pre>
                </div>
                {audit.metaData !== null && audit.metaData !== undefined && (
                  <div>
                    <strong>Metadata</strong>
                    <pre>{formatJson(audit.metaData)}</pre>
                  </div>
                )}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

export default OperatorAuditPage;