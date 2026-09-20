import { useCallback, useEffect, useState } from "react";
import {
  FaClock,
  FaHistory,
  FaDatabase,
  FaWater,
  FaExclamationTriangle,
  FaRobot,
  FaBell,
  FaCheckCircle
} from "react-icons/fa";
import "../styles/historicalIntelligence.css";
import {
  HISTORICAL_PERIODS,
  HISTORICAL_DEFAULT_PERIOD,
  getHistoricalAnalytics
} from "../services/historicalIntelligenceService";

function HistoricalIntelligenceAnalyticsSection({ onOpen }) {
  const [period, setPeriod] = useState(HISTORICAL_DEFAULT_PERIOD);
  const [data, setData] = useState(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    getHistoricalAnalytics({ period })
      .then((payload) => {
        setData(payload);
        setError(false);
      })
      .catch((err) => {
        console.log("Historical analytics load error:", err);
        setError(true);
      })
      .finally(() => setLoading(false));
  }, [period]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading && !data) {
    return (
      <div className="hi-panel">
        <div className="hi-panel-header">
          <h3>🗂️ Historical Overview (recorded data)</h3>
        </div>
        <p className="hi-muted">Loading historical analytics…</p>
      </div>
    );
  }

  return (
    <div className="hi-panel">
      <div className="hi-panel-header">
        <div>
          <h3>🗂️ Historical Overview (recorded data)</h3>
          <p className="hi-panel-sub">
            Using /api/analytics/historical · descriptive evidence only
          </p>
        </div>

        <div className="hi-actions">
          <label style={{ display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "0.78rem", fontWeight: 600, color: "#475569" }}>
            <FaClock aria-hidden="true" /> Period
            <select
              value={period}
              aria-label="Historical analytics period"
              onChange={(e) => setPeriod(e.target.value)}
            >
              {HISTORICAL_PERIODS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
          {data?.data_quality?.label && (
            <span className={`hi-pill ${data.data_quality.sufficient_data ? "hi-status-ok" : "hi-status-insufficient"}`}>
              {data.data_quality.label}
            </span>
          )}
        </div>
      </div>

      {error && <div className="status-msg error">Historical analytics unavailable - check the backend.</div>}

      {data && (
        <>
          <div className="hi-panel-stats">
            <div className="hi-panel-stat">
              <strong>{data.record_count}</strong>
              <span><FaDatabase /> Total records</span>
            </div>
            <div className="hi-panel-stat">
              <strong>{data.sensors?.reading_count}</strong>
              <span><FaWater /> Sensor readings</span>
            </div>
            <div className="hi-panel-stat">
              <strong>{data.incidents?.total}</strong>
              <span><FaExclamationTriangle /> Incidents ({data.incidents?.resolved} resolved)</span>
            </div>
            <div className="hi-panel-stat">
              <strong>{data.missions?.total}</strong>
              <span><FaRobot /> Missions</span>
            </div>
            <div className="hi-panel-stat">
              <strong>{data.alerts?.total}</strong>
              <span><FaBell /> Alerts ({data.alerts?.unresolved} unresolved)</span>
            </div>
            <div className="hi-panel-stat">
              <strong>{data.drain_health?.degraded_or_critical}</strong>
              <span><FaWater /> Degraded / critical</span>
            </div>
          </div>

          {data.comparison?.incident_comparison && (
            <p className="hi-note">
              Incident comparison ({data.period} vs previous {data.period}):{" "}
              <strong>{data.comparison.incident_comparison.current_period}</strong> current vs{" "}
              <strong>{data.comparison.incident_comparison.previous_period}</strong> previous ·{" "}
              <strong>
                {data.comparison.incident_comparison.direction === "INSUFFICIENT_DATA"
                  ? "insufficient"
                  : `${data.comparison.incident_comparison.direction || "no data"}`}
              </strong>
            </p>
          )}

          {data.data_quality?.label === "INSUFFICIENT_DATA" && (
            <div className="hi-insufficient">
              <FaExclamationTriangle /> No recorded data in this window — values are reported as
              INSUFFICIENT_DATA, never invented.
            </div>
          )}

          <div className="hi-panel-actions">
            {onOpen && (
              <button className="btn btn-outline btn-sm" onClick={onOpen}>
                <FaHistory /> View Historical Intelligence
              </button>
            )}
          </div>
        </>
      )}

      {data && <p className="hi-disclaimer"><FaCheckCircle /> {data.disclaimer}</p>}
    </div>
  );
}

export default HistoricalIntelligenceAnalyticsSection;