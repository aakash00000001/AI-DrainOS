import { useCallback, useEffect, useMemo, useState } from "react";
import {
  FaSync,
  FaHistory,
  FaDatabase,
  FaWater,
  FaExclamationTriangle,
  FaClock,
  FaChartLine,
  FaRobot,
  FaBell,
  FaClipboardList,
  FaBalanceScale,
  FaCheckCircle
} from "react-icons/fa";
import "../styles/historicalIntelligence.css";
import {
  HISTORICAL_PERIODS,
  HISTORICAL_DEFAULT_PERIOD,
  getHistoricalOverview,
  getHistoricalSensorHistory,
  getHistoricalDrains,
  getHistoricalIncidents,
  getHistoricalMissions,
  getHistoricalRobots,
  getHistoricalAlerts,
  getHistoricalPatterns,
  getHistoricalComparison,
  getDrainList
} from "../services/historicalIntelligenceService";

const HEALTH_CLASS = {
  HEALTHY: "hi-health-healthy",
  WATCH: "hi-health-watch",
  DEGRADED: "hi-health-degraded",
  CRITICAL: "hi-health-critical",
  INSUFFICIENT_DATA: "hi-health-insufficient"
};

const TREND_CLASS = {
  RISING: "hi-trend-rising",
  FALLING: "hi-trend-falling",
  STABLE: "hi-trend-stable",
  INSUFFICIENT_DATA: "hi-trend-insufficient"
};

const SEVERITY_CLASS = {
  CRITICAL: "hi-sev-critical",
  HIGH: "hi-sev-high",
  MODERATE: "hi-sev-moderate",
  LOW: "hi-sev-low"
};

const PERIOD_LABELS = {
  "24h": "Last 24 hours",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days"
};

const DIRECTION_CLASS = {
  INCREASE: "hi-cmp-direction-increase",
  DECREASE: "hi-cmp-direction-decrease",
  NO_CHANGE: "hi-cmp-direction-no_change"
};

function formatTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString();
}

function num(value) {
  if (value === null || value === undefined) return "—";
  return value;
}

function formatDuration(seconds) {
  if (seconds === null || seconds === undefined) return "—";
  const mins = seconds / 60;
  if (mins < 1) return `${Math.round(seconds)}s`;
  return `${mins.toFixed(1)}m`;
}

function Distribution({ values, max }) {
  const peak = max || Math.max(1, ...values.map((v) => Number(v) || 0));
  return (
    <div className="hi-dist-grid">
      {values.map((value, index) => {
        const count = Number(value) || 0;
        const width = peak > 0 ? Math.round((count / peak) * 100) : 0;
        return (
          <div className="hi-dist-row" key={`${index}-${count}`}>
            <span className="hi-muted">{index}</span>
            <div className="hi-dist-bar">
              <div className="hi-dist-fill" style={{ width: `${width}%` }} />
            </div>
            <span className="hi-dist-count">{count}</span>
          </div>
        );
      })}
    </div>
  );
}

function OverTimeChart({ buckets }) {
  if (!buckets || buckets.length === 0) {
    return <div className="hi-no-rows">No daily activity in this window.</div>;
  }
  const peak = Math.max(...buckets.map((b) => Number(b.count) || 0));
  return (
    <div className="hi-dist-grid">
      {buckets.map((bucket) => {
        const count = Number(bucket.count) || 0;
        const width = peak > 0 ? Math.round((count / peak) * 100) : 0;
        return (
          <div className="hi-dist-row" key={bucket.bucket}>
            <span className="hi-muted">{bucket.bucket}</span>
            <div className="hi-dist-bar">
              <div className="hi-dist-fill" style={{ width: `${width}%` }} />
            </div>
            <span className="hi-dist-count">{count}</span>
          </div>
        );
      })}
    </div>
  );
}

function PercentBadge({ value }) {
  if (value === null || value === undefined) return <span className="hi-muted">—</span>;
  return <strong>{value}%</strong>;
}

function HistoricalIntelligencePage() {
  const [period, setPeriod] = useState(HISTORICAL_DEFAULT_PERIOD);
  const [drainId, setDrainId] = useState("");
  const [drainList, setDrainList] = useState([]);

  const [overview, setOverview] = useState(null);
  const [sensors, setSensors] = useState(null);
  const [drains, setDrains] = useState(null);
  const [incidents, setIncidents] = useState(null);
  const [missions, setMissions] = useState(null);
  const [robots, setRobots] = useState(null);
  const [alerts, setAlerts] = useState(null);
  const [patterns, setPatterns] = useState(null);
  const [comparison, setComparison] = useState(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(0);

  const params = useMemo(
    () => ({ period, ...(drainId ? { drainId } : {}) }),
    [period, drainId]
  );

  const load = useCallback(() => {
    setLoading(true);
    setError(null);

    const requests = [
      getHistoricalOverview(params),
      getHistoricalSensorHistory(params),
      getHistoricalDrains(params),
      getHistoricalIncidents(params),
      getHistoricalMissions(params),
      getHistoricalRobots(params),
      getHistoricalAlerts(params),
      getHistoricalPatterns(params),
      getHistoricalComparison(params)
    ];

    Promise.allSettled(requests).then((results) => {
      const [o, s, d, i, m, r, a, p, c] = results;
      const failed = results.filter((r2) => r2.status === "rejected").length;

      if (o.status === "fulfilled") setOverview(o.value);
      if (s.status === "fulfilled") setSensors(s.value);
      if (d.status === "fulfilled") setDrains(d.value);
      if (i.status === "fulfilled") setIncidents(i.value);
      if (m.status === "fulfilled") setMissions(m.value);
      if (r.status === "fulfilled") setRobots(r.value);
      if (a.status === "fulfilled") setAlerts(a.value);
      if (p.status === "fulfilled") setPatterns(p.value);
      if (c.status === "fulfilled") setComparison(c.value);

      if (failed > 0) {
        setError("Some historical data is unavailable. Showing only the sections that loaded.");
      }
      setLoading(false);
      setLastUpdated(Date.now());
    });
  }, [params]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    getDrainList()
      .then((list) => setDrainList(Array.isArray(list) ? list : []))
      .catch(() => setDrainList([]));
  }, []);

  const status = overview?.status;
  const dataQuality = overview?.data_quality;
  const sufficient = overview?.data_quality?.sufficient_data;

  return (
    <div className="hi-page">
      <div className="hi-page-header">
        <div>
          <h2>🗂️ Historical Intelligence Console</h2>
          <p className="hi-subtitle">
            Descriptive evidence from recorded data · each number is read from the
            database, never estimated ↻ the live AI score
          </p>
        </div>

        <div className="hi-actions">
          {overview && (
            <span className={`hi-status ${status === "OK" ? "hi-status-ok" : "hi-status-insufficient"}`}>
              {status || "INSUFFICIENT_DATA"}
            </span>
          )}
          {lastUpdated > 0 && (
            <span className="hi-updated">
              Updated {new Date(lastUpdated).toLocaleTimeString()}
            </span>
          )}
          <button className="btn btn-outline btn-sm" onClick={load} disabled={loading}>
            <FaSync /> {loading ? "Loading…" : "Refresh"}
          </button>
        </div>
      </div>

      <div className="hi-controls" role="group" aria-label="Historical window controls">
        <label>
          <FaClock aria-hidden="true" /> Period
          <select
            value={period}
            aria-label="Historical period"
            onChange={(e) => setPeriod(e.target.value)}
          >
            {HISTORICAL_PERIODS.map((p) => (
              <option key={p} value={p}>
                {p} · {PERIOD_LABELS[p]}
              </option>
            ))}
          </select>
        </label>

        <label>
          <FaDatabase aria-hidden="true" /> Drain
          <select
            value={drainId}
            aria-label="Drain filter"
            onChange={(e) => setDrainId(e.target.value)}
          >
            <option value="">All drains</option>
            {drainList.map((drain) => (
              <option key={drain.id} value={String(drain.id)}>
                Drain {drain.id}: {drain.zone_name || "—"}
                {drain.location ? ` (${drain.location})` : ""}
              </option>
            ))}
          </select>
        </label>

        <span className="hi-results-meta">
          {period} window{drainId ? ` · drain ${drainId}` : ""}
        </span>
      </div>

      {error && <div className="status-msg error">{error}</div>}
      {loading && <div className="hi-empty"><FaClock /> Loading historical data…</div>}
      {!loading && overview && !sufficient && (
        <div className="hi-insufficient">
          <FaExclamationTriangle /> No recorded data found in the selected window — every
          section below reports INSUFFICIENT_DATA rather than inventing values.
        </div>
      )}

      {overview && (
        <div className="hi-stat-strip">
          <div className="hi-stat">
            <FaDatabase />
            <div>
              <strong>{overview.record_count}</strong>
              <span>Total records</span>
            </div>
          </div>

          <div className="hi-stat">
            <FaWater />
            <div>
              <strong>{overview.sensors.reading_count}</strong>
              <span>Sensor readings ({overview.sensors.sensor_count} sensors)</span>
            </div>
          </div>

          <div className={`hi-stat ${overview.incidents.active > 0 ? "stat-warn" : ""}`}>
            <FaExclamationTriangle />
            <div>
              <strong>{overview.incidents.total}</strong>
              <span>Incidents · {overview.incidents.resolved} resolved</span>
            </div>
          </div>

          <div className="hi-stat">
            <FaRobot />
            <div>
              <strong>{overview.missions.total}</strong>
              <span>Missions</span>
            </div>
          </div>

          <div className={`hi-stat ${overview.alerts.unresolved > 0 ? "stat-warn" : ""}`}>
            <FaBell />
            <div>
              <strong>{overview.alerts.total}</strong>
              <span>Alerts · {overview.alerts.unresolved} unresolved</span>
            </div>
          </div>

          <div className={`hi-stat ${overview.drain_health.degraded_or_critical > 0 ? "stat-warn" : ""}`}>
            <FaWater />
            <div>
              <strong>{overview.drain_health.degraded_or_critical}</strong>
              <span>Degraded / critical drains</span>
            </div>
          </div>

          <div className="hi-stat">
            <FaHistory />
            <div>
              <strong>{overview.period}</strong>
              <span>Window · {dataQuality ? dataQuality.label : ""}</span>
            </div>
          </div>
        </div>
      )}

      {sensors && (
        <div className="hi-card">
          <div className="hi-card-header">
            <h3><FaWater /> Sensor History ({sensors.sensor_count} sensors, {sensors.reading_count} readings)</h3>
            {sensors.status === "INSUFFICIENT_DATA" && (
              <span className="hi-muted">INSUFFICIENT_DATA</span>
            )}
          </div>
          <div className="hi-table-scroll">
            <table className="hi-table">
              <thead>
                <tr>
                  <th>Sensor</th>
                  <th>Zone</th>
                  <th>Readings</th>
                  <th>Water avg</th>
                  <th>Water trend</th>
                  <th>Gas avg</th>
                  <th>Temp avg</th>
                  <th>Latest</th>
                </tr>
              </thead>
              <tbody>
                {sensors.sensors.length === 0 && (
                  <tr>
                    <td colSpan="8" className="hi-no-rows">
                      No sensor readings recorded in this window.
                    </td>
                  </tr>
                )}
                {sensors.sensors.map((sensor) => (
                  <tr key={sensor.sensor_id}>
                    <td className="hi-id">#{sensor.sensor_id}</td>
                    <td>{sensor.zone || "—"}</td>
                    <td>{sensor.reading_count}</td>
                    <td>{num(sensor.water_level.average)}</td>
                    <td>
                      <span className={`hi-pill ${TREND_CLASS[sensor.water_level.trend] || "hi-trend-insufficient"}`}>
                        {sensor.water_level.trend}
                      </span>
                    </td>
                    <td>{num(sensor.gas_level.average)}</td>
                    <td>{num(sensor.temperature.average)}</td>
                    <td>{formatTime(sensor.latest_timestamp)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {drains && (
        <div className="hi-card">
          <div className="hi-card-header">
            <h3><FaHistory /> Drain Historical Health ({drains.drain_count})</h3>
            {drains.status === "INSUFFICIENT_DATA" && (
              <span className="hi-muted">INSUFFICIENT_DATA</span>
            )}
          </div>
          <div className="hi-table-scroll">
            <table className="hi-table">
              <thead>
                <tr>
                  <th>Drain</th>
                  <th>Zone</th>
                  <th>Current status</th>
                  <th>Historical health</th>
                  <th>Incidents</th>
                  <th>Alerts</th>
                  <th>Missions</th>
                  <th>Last incident</th>
                </tr>
              </thead>
              <tbody>
                {drains.drains.length === 0 && (
                  <tr>
                    <td colSpan="8" className="hi-no-rows">
                      No drains registered.
                    </td>
                  </tr>
                )}
                {drains.drains.map((drain) => (
                  <tr key={drain.drain_id}>
                    <td className="hi-id">#{drain.drain_id}</td>
                    <td>{drain.zone || "—"}</td>
                    <td>{drain.current_status || "—"}</td>
                    <td>
                      <span className={`hi-pill ${HEALTH_CLASS[drain.historical_health] || "hi-health-insufficient"}`}>
                        {drain.historical_health}
                      </span>
                    </td>
                    <td>{drain.incident_count}</td>
                    <td>{drain.alert_count}</td>
                    <td>{drain.mission_count}</td>
                    <td>{formatTime(drain.last_incident_time)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {incidents && (
        <div className="hi-card">
          <div className="hi-card-header">
            <h3><FaExclamationTriangle /> Incident History ({incidents.total})</h3>
            {incidents.status === "INSUFFICIENT_DATA" && (
              <span className="hi-muted">INSUFFICIENT_DATA</span>
            )}
          </div>
          <div className="hi-metrics-grid">
            <div className="hi-metric">
              <strong>{incidents.active}</strong>
              <span>Active</span>
            </div>
            <div className="hi-metric">
              <strong>{incidents.resolved}</strong>
              <span>Resolved</span>
            </div>
            <div className="hi-metric">
              <strong>{formatDuration(incidents.average_response_minutes)}</strong>
              <span>Avg response</span>
            </div>
            <div className="hi-metric">
              <strong>{formatDuration(incidents.average_resolution_minutes)}</strong>
              <span>Avg resolution</span>
            </div>
            <div className="hi-metric">
              <strong>{incidents.data_points.with_response}</strong>
              <span>Timed responses</span>
            </div>
          </div>

          <div className="hi-card-header" style={{ borderTop: "1px solid #e2e8f0", borderBottom: "none" }}>
            <h3>By severity</h3>
          </div>
          <div style={{ padding: "8px 12px" }}>
            {Object.entries(incidents.by_severity || {}).map(([severity, count]) => (
              <span key={severity} className={`hi-pill ${SEVERITY_CLASS[severity] || ""}`}>
                {severity}: {count}
              </span>
            ))}
            {Object.keys(incidents.by_severity || {}).length === 0 && (
              <span className="hi-muted">No severity breakdown</span>
            )}
          </div>

          <div className="hi-card-header" style={{ borderTop: "1px solid #e2e8f0", borderBottom: "none" }}>
            <h3>By source</h3>
          </div>
          <div style={{ padding: "8px 12px" }}>
            {Object.entries(incidents.by_source || {})
              .filter(([, count]) => Number(count) > 0)
              .map(([source, count]) => (
                <span key={source} className="hi-pill">{source}: {count}</span>
              ))}
            {Object.entries(incidents.by_source || {}).every(([, count]) => !Number(count)) && (
              <span className="hi-muted">No source breakdown</span>
            )}
          </div>

          <div className="hi-card-header" style={{ borderTop: "1px solid #e2e8f0", borderBottom: "none" }}>
            <h3>Daily incident activity</h3>
          </div>
          <OverTimeChart buckets={incidents.over_time} />

          {(incidents.by_drain || []).length > 0 && (
            <>
              <div className="hi-card-header" style={{ borderTop: "1px solid #e2e8f0", borderBottom: "none" }}>
                <h3>Top drains by incidents</h3>
              </div>
              <div className="hi-table-scroll">
                <table className="hi-table">
                  <thead>
                    <tr>
                      <th>Drain</th>
                      <th>Zone</th>
                      <th>Incidents</th>
                      <th>Critical</th>
                    </tr>
                  </thead>
                  <tbody>
                    {incidents.by_drain.map((drain) => (
                      <tr key={drain.drain_id}>
                        <td className="hi-id">#{drain.drain_id}</td>
                        <td>{drain.zone || "—"}</td>
                        <td>{drain.count}</td>
                        <td>{drain.critical_count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          <p className="hi-note">{incidents.disclaimer}</p>
        </div>
      )}

      {missions && (
        <div className="hi-card">
          <div className="hi-card-header">
            <h3><FaRobot /> Mission History ({missions.total})</h3>
            {missions.completion_rate !== null && missions.completion_rate !== undefined && (
              <div className="hi-toolbar">
                <PercentBadge value={missions.completion_rate} />
                <span className="hi-muted">completion rate</span>
              </div>
            )}
          </div>
          <div style={{ padding: "8px 12px" }}>
            {Object.entries(missions.by_status || {}).map(([status, count]) => (
              <span key={status} className="hi-pill">{status}: {count}</span>
            ))}
            {Object.keys(missions.by_status || {}).length === 0 && (
              <span className="hi-muted">No mission status breakdown</span>
            )}
          </div>
          <div className="hi-card-header" style={{ borderTop: "1px solid #e2e8f0", borderBottom: "none" }}>
            <h3>Missions by drain</h3>
          </div>
          <div className="hi-table-scroll">
            <table className="hi-table">
              <thead>
                <tr>
                  <th>Drain</th>
                  <th>Zone</th>
                  <th>Missions</th>
                  <th>Completed</th>
                  <th>Last mission</th>
                </tr>
              </thead>
              <tbody>
                {missions.by_drain.length === 0 && (
                  <tr>
                    <td colSpan="5" className="hi-no-rows">
                      No missions recorded in this window.
                    </td>
                  </tr>
                )}
                {missions.by_drain.map((drain) => (
                  <tr key={drain.drain_id}>
                    <td className="hi-id">#{drain.drain_id}</td>
                    <td>{drain.zone || "—"}</td>
                    <td>{drain.mission_count}</td>
                    <td>{drain.completed}</td>
                    <td>{formatTime(drain.last_mission_time)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="hi-note">{missions.disclaimer}</p>
        </div>
      )}

      {robots && (
        <div className="hi-card">
          <div className="hi-card-header">
            <h3><FaRobot /> Robot Response History ({robots.robot_count})</h3>
            {robots.average_mission_duration_seconds !== null && robots.average_mission_duration_seconds !== undefined && (
              <div className="hi-toolbar">
                <span className="hi-pill">
                  Avg mission {formatDuration(robots.average_mission_duration_seconds)}
                </span>
              </div>
            )}
          </div>
          <div className="hi-table-scroll">
            <table className="hi-table">
              <thead>
                <tr>
                  <th>Robot</th>
                  <th>Missions</th>
                  <th>Completed</th>
                  <th>Completion rate</th>
                  <th>Last mission</th>
                </tr>
              </thead>
              <tbody>
                {robots.robots.length === 0 && (
                  <tr>
                    <td colSpan="5" className="hi-no-rows">
                      No robot activity recorded in this window.
                    </td>
                  </tr>
                )}
                {robots.robots.map((robot) => (
                  <tr key={`${robot.robot_id ?? "none"}`}>
                    <td>
                      <strong>{robot.robot_name || "Unassigned"}</strong>
                      {robot.robot_id !== null && <span className="cell-sub">robot {robot.robot_id}</span>}
                    </td>
                    <td>{robot.mission_count}</td>
                    <td>{robot.completed}</td>
                    <td>{num(robot.completion_rate)}</td>
                    <td>{formatTime(robot.last_mission_time)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="hi-note">
            Robots are derived from real mission records. Response time is{" "}
            {robots.response_time_available ? "reported below" : "not available — the missions table has no response-timestamp column, so it is honestly left null."}
          </p>
        </div>
      )}

      {alerts && (
        <div className="hi-card">
          <div className="hi-card-header">
            <h3><FaBell /> Alert History ({alerts.total})</h3>
            {alerts.status === "INSUFFICIENT_DATA" && (
              <span className="hi-muted">INSUFFICIENT_DATA</span>
            )}
          </div>
          <div className="hi-metrics-grid">
            <div className="hi-metric">
              <strong>{alerts.resolved}</strong>
              <span>Resolved</span>
            </div>
            <div className={`hi-metric ${alerts.unresolved > 0 ? "stat-warn" : ""}`}>
              <strong>{alerts.unresolved}</strong>
              <span>Unresolved</span>
            </div>
            <div className="hi-metric">
              <strong>{alerts.critical}</strong>
              <span>Critical</span>
            </div>
          </div>

          <div className="hi-card-header" style={{ borderTop: "1px solid #e2e8f0", borderBottom: "none" }}>
            <h3>Alert types</h3>
          </div>
          <div className="hi-table-scroll">
            <table className="hi-table">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Count</th>
                </tr>
              </thead>
              <tbody>
                {alerts.by_type.length === 0 && (
                  <tr>
                    <td colSpan="2" className="hi-no-rows">
                      No alerts recorded in this window.
                    </td>
                  </tr>
                )}
                {alerts.by_type.map((alert) => (
                  <tr key={alert.alert_type}>
                    <td>{alert.alert_type}</td>
                    <td>{alert.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="hi-card-header" style={{ borderTop: "1px solid #e2e8f0", borderBottom: "none" }}>
            <h3>Daily alert activity</h3>
          </div>
          <OverTimeChart buckets={alerts.over_time} />
          <p className="hi-note">{alerts.disclaimer}</p>
        </div>
      )}

      {patterns && (
        <div className="hi-card">
          <div className="hi-card-header">
            <h3><FaChartLine /> Historical Time Patterns</h3>
            {patterns.status === "INSUFFICIENT_DATA" && (
              <span className="hi-muted">INSUFFICIENT_DATA</span>
            )}
          </div>

          <div className="hi-card-header" style={{ borderTop: "1px solid #e2e8f0", borderBottom: "none" }}>
            <h3>Incident peaks</h3>
          </div>
          <div style={{ padding: "8px 12px" }}>
            {patterns.incidents.summary && <p className="hi-note" style={{ border: "none", padding: 0 }}>{patterns.incidents.summary}</p>}
            <span className="hi-pill">
              Peak day: {patterns.incidents.peak_incident_day || "n/a"}
            </span>
            <span className="hi-pill">
              Peak hour: {patterns.incidents.peak_incident_hour === null ? "n/a" : `${patterns.incidents.peak_incident_hour}:00`}
            </span>
          </div>
          <div className="hi-card-header" style={{ borderTop: "1px solid #e2e8f0", borderBottom: "none" }}>
            <h3>Alerts peaks</h3>
          </div>
          <div style={{ padding: "8px 12px" }}>
            {patterns.alerts.summary && <p className="hi-note" style={{ border: "none", padding: 0 }}>{patterns.alerts.summary}</p>}
            <span className="hi-pill">
              Peak day: {patterns.alerts.peak_alert_day || "n/a"}
            </span>
            <span className="hi-pill">
              Peak hour: {patterns.alerts.peak_alert_hour === null ? "n/a" : `${patterns.alerts.peak_alert_hour}:00`}
            </span>
          </div>

          <div className="hi-card-header" style={{ borderTop: "1px solid #e2e8f0", borderBottom: "none" }}>
            <h3>Incidents · hour of day</h3>
          </div>
          <Distribution values={patterns.incidents.hourly_distribution} max={Math.max(1, ...patterns.incidents.hourly_distribution)} />
          <div className="hi-card-header" style={{ borderTop: "1px solid #e2e8f0", borderBottom: "none" }}>
            <h3>Incidents · weekday</h3>
          </div>
          <div className="hi-dist-grid">
            {patterns.incidents.weekday_distribution.map((count, index) => (
              <div className="hi-dist-row" key={`wd-${index}`}>
                <span className="hi-muted">{patterns.weekday_names[index] || index}</span>
                <div className="hi-dist-bar">
                  <div
                    className="hi-dist-fill"
                    style={{
                      width: `${patterns.incidents.total > 0
                        ? Math.round((Number(count) / patterns.incidents.total) * 100)
                        : 0}%`
                    }}
                  />
                </div>
                <span className="hi-dist-count">{count}</span>
              </div>
            ))}
          </div>
          <p className="hi-note">{patterns.disclaimer}</p>
        </div>
      )}

      {comparison && (
        <div className="hi-card">
          <div className="hi-card-header">
            <h3><FaBalanceScale /> Period Comparison — CURRENT window vs PREVIOUS window</h3>
            {comparison.status === "INSUFFICIENT_DATA" && (
              <span className="hi-muted">INSUFFICIENT_DATA</span>
            )}
          </div>

          <div className="hi-comparison">
            <div className="hi-comparison-row">
              <div>
                <div className="hi-cmp-label">Incidents · current</div>
                <div className="hi-cmp-value">{comparison.incident_comparison.current_period}</div>
              </div>
              <div>
                <div className="hi-cmp-label">Incidents · previous</div>
                <div className="hi-cmp-value">{comparison.incident_comparison.previous_period}</div>
              </div>
              <div>
                <div className="hi-cmp-label">Change</div>
                <div className={`hi-cmp-value ${DIRECTION_CLASS[comparison.incident_comparison.direction] || "hi-cmp-direction-none"}`}>
                  {comparison.incident_comparison.change === null ? "—" : comparison.incident_comparison.change}
                  {" "}
                  {comparison.incident_comparison.direction || ""}
                </div>
              </div>
            </div>
          </div>

          {(comparison.sensor_comparison || []).length > 0 && (
            <div className="hi-table-scroll" style={{ maxHeight: "none" }}>
              <table className="hi-table">
                <thead>
                  <tr>
                    <th>Metric</th>
                    <th>Current</th>
                    <th>Historical avg</th>
                    <th>Change</th>
                    <th>Direction</th>
                  </tr>
                </thead>
                <tbody>
                  {comparison.sensor_comparison.map((row) => (
                    <tr key={row.metric}>
                      <td>{row.metric}</td>
                      <td>{num(row.current_value)}</td>
                      <td>{num(row.historical_average)}</td>
                      <td>{num(row.change)}</td>
                      <td>
                        {row.status === "INSUFFICIENT_DATA" ? (
                          <span className="hi-muted">insufficient</span>
                        ) : (
                          row.direction || "—"
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <p className="hi-note">{comparison.incident_comparison.note}</p>
          <p className="hi-note">{comparison.note}</p>
          <p className="hi-note">{comparison.disclaimer}</p>
        </div>
      )}

      {overview && dataQuality && (
        <div className="hi-card">
          <div className="hi-card-header">
            <h3><FaClipboardList /> Data Quality</h3>
            <div className="hi-toolbar">
              <span className={`hi-pill ${dataQuality.sufficient_data ? "hi-status-ok" : "hi-status-insufficient"}`}>
                {dataQuality.label}
              </span>
            </div>
          </div>
          <div className="hi-metrics-grid">
            <div className="hi-metric">
              <strong>{dataQuality.record_count}</strong>
              <span>Records in window</span>
            </div>
            <div className="hi-metric">
              <strong>{num(dataQuality.coverage_ratio)}</strong>
              <span>Coverage ratio</span>
            </div>
            <div className="hi-metric">
              <strong>{formatTime(dataQuality.earliest_timestamp)}</strong>
              <span>Earliest record</span>
            </div>
            <div className="hi-metric">
              <strong>{formatTime(dataQuality.latest_timestamp)}</strong>
              <span>Latest record</span>
            </div>
          </div>
          {(dataQuality.missing_signals || []).length > 0 && (
            <p className="hi-note">
              Missing signals: {dataQuality.missing_signals.join(", ")}
            </p>
          )}
        </div>
      )}

      {overview && <p className="hi-disclaimer"><FaCheckCircle /> {overview.disclaimer}</p>}
    </div>
  );
}

export default HistoricalIntelligencePage;