import { useEffect, useState } from "react";
import {
  FaHistory,
  FaWater,
  FaExclamationTriangle,
  FaCheckCircle,
  FaChartLine
} from "react-icons/fa";
import "../styles/historicalIntelligence.css";
import { getDashboardHistoricalSummary } from "../services/historicalIntelligenceService";

function HistoricalIntelligencePanel({ onOpen }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    getDashboardHistoricalSummary()
      .then((summary) => setData(summary))
      .catch((err) => {
        console.log("Historical intelligence load error:", err);
        setError("Historical intelligence unavailable");
      });
  }, []);

  const topDrains = Array.isArray(data?.topRecurringDrains)
    ? data.topRecurringDrains.slice(0, 3)
    : [];

  return (
    <div className="hi-panel">
      <div className="hi-panel-header">
        <div>
          <h3>📊 Historical Intelligence</h3>
          <p className="hi-panel-sub">
            Descriptive summary of recorded activity · {data?.period ? `${data.period} window` : "30d window"}
          </p>
        </div>

        <div className="hi-actions">
          {data?.historicalDataQuality && (
            <span className={`hi-pill ${data.historicalDataQuality !== "INSUFFICIENT_DATA" ? "hi-status-ok" : "hi-status-insufficient"}`}>
              {data.historicalDataQuality}
            </span>
          )}
          <button className="btn btn-outline btn-sm" onClick={onOpen}>
            <FaHistory /> Historical Console
          </button>
        </div>
      </div>

      {error && <div className="status-msg error">{error}</div>}

      {data && (
        <div className="hi-panel-stats">
          <div className="hi-panel-stat">
            <strong>{data.historicalIncidentCount}</strong>
            <span>Historical incidents</span>
          </div>
          <div className="hi-panel-stat">
            <strong>{data.recurrentDrainCount}</strong>
            <span>Recurrent drains</span>
          </div>
          <div className={`hi-panel-stat ${data.degradedDrainCount > 0 ? "stat-warn" : ""}`}>
            <strong>{data.degradedDrainCount}</strong>
            <span>Degraded / critical</span>
          </div>
          <div className="hi-panel-stat">
            <strong>{data.recentHistoricalTrend || "—"}</strong>
            <span>Recent trend</span>
          </div>
        </div>
      )}

      {topDrains.length > 0 && (
        <ul className="hi-panel-list">
          {topDrains.map((drain) => (
            <li key={drain.drain_id}>
              <span>
                <FaWater /> {drain.zone || drain.location || `Drain ${drain.drain_id}`}
              </span>
              <strong>{drain.incident_count} incidents</strong>
            </li>
          ))}
        </ul>
      )}

      {data && data.historicalIncidentCount === 0 && (
        <div className="hi-empty">
          <FaCheckCircle /> No historical incidents recorded yet in this window.
        </div>
      )}

      {data && data.historicalDataQuality === "INSUFFICIENT_DATA" && (
        <div className="hi-insufficient">
          <FaExclamationTriangle /> Not enough recorded data in this window to summarize.
        </div>
      )}

      {data && (
        <p className="hi-disclaimer">
          <FaChartLine /> Historical values describe recorded data only and are independent of the live AI scores.
        </p>
      )}
    </div>
  );
}

export default HistoricalIntelligencePanel;