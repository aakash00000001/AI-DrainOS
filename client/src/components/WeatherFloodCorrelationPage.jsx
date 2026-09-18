import { useCallback, useEffect, useMemo, useState } from "react";
import {
  FaSync,
  FaCloudSun,
  FaWater,
  FaLink,
  FaTachometerAlt,
  FaExclamationTriangle,
  FaClock,
  FaChartLine,
  FaListUl
} from "react-icons/fa";
import "../styles/weatherFloodCorrelation.css";
import socket from "../services/socket";
import {
  getWeatherCorrelation,
  getWeatherCorrelationSignal,
  getWeatherCorrelationTrends,
  getWeatherCorrelationDrains
} from "../services/weatherFloodCorrelationService";

const STATUS_CLASS = {
  READY: "wfc-status-ready",
  INSUFFICIENT_DATA: "wfc-status-insufficient",
  WEATHER_UNAVAILABLE: "wfc-status-unavailable",
  NOT_AVAILABLE: "wfc-status-notavailable"
};

const STRENGTH_CLASS = {
  VERY_STRONG: "wfc-strength-verystrong",
  STRONG: "wfc-strength-strong",
  MODERATE: "wfc-strength-moderate",
  WEAK: "wfc-strength-weak",
  VERY_WEAK: "wfc-strength-veryweak",
  NONE: "wfc-strength-none"
};

const DIR_CLASS = {
  POSITIVE: "wfc-dir-positive",
  NEGATIVE: "wfc-dir-negative",
  NONE: "wfc-dir-none"
};

const TREND_CLASS = {
  strengthening: "wfc-trend-strengthening",
  weakening: "wfc-trend-weakening",
  stable: "wfc-trend-stable",
  insufficient: "wfc-trend-insufficient"
};

const WINDOW_OPTIONS = [24, 48, 72, 168];
const LAG_OPTIONS = [0, 15, 30, 60];

function formatTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString();
}

function WeatherFloodCorrelationPage() {
  const [data, setData] = useState(null);
  const [selectedSignal, setSelectedSignal] = useState("rainfall_water_level");
  const [detail, setDetail] = useState(null);
  const [trends, setTrends] = useState(null);
  const [drains, setDrains] = useState(null);
  const [windowHours, setWindowHours] = useState(24);
  const [lagMinutes, setLagMinutes] = useState(0);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(0);

  const loadOverview = useCallback(() => {
    getWeatherCorrelation()
      .then((payload) => {
        setData(payload);
        setError(null);
        setLastUpdated(Date.now());
      })
      .catch((err) => {
        console.log("Weather correlation load error:", err);
        setError("Weather correlation unavailable");
      });
  }, []);

  useEffect(() => {
    loadOverview();
  }, [loadOverview]);

  useEffect(() => {
    socket.on("weatherFloodCorrelationUpdate", (payload) => {
      if (payload && payload.status) {
        setData(payload);
        setLastUpdated(Date.now());
      }
    });
    return () => {
      socket.off("weatherFloodCorrelationUpdate");
    };
  }, []);

  useEffect(() => {
    const params = { window: windowHours, lag: lagMinutes };
    getWeatherCorrelationSignal(selectedSignal, params)
      .then((payload) => setDetail(payload))
      .catch((err) => {
        console.log("Signal detail load error:", err);
        setDetail(null);
      });
    getWeatherCorrelationTrends({ signal: selectedSignal, window: windowHours, lag: lagMinutes })
      .then((payload) => setTrends(payload))
      .catch((err) => {
        console.log("Trends load error:", err);
        setTrends(null);
      });
  }, [selectedSignal, windowHours, lagMinutes]);

  useEffect(() => {
    getWeatherCorrelationDrains({ window: windowHours })
      .then((payload) => setDrains(payload))
      .catch((err) => {
        console.log("Drains load error:", err);
        setDrains(null);
      });
  }, [windowHours]);

  const signals = useMemo(() => data?.signals || [], [data]);
  const strongest = data?.strongest || null;
  const latestWeather = data?.latest_weather || null;
  const quality = data?.weather_data_quality || null;

  return (
    <div className="wfc-page">
      <div className="wfc-page-header">
        <div>
          <h2>⛅ Weather + Flood Correlation Console</h2>
          <p className="wfc-subtitle">
            Descriptive Pearson correlation between real weather observations and real sensor
            readings · association only, never a causal claim
          </p>
        </div>

        <div className="wfc-actions">
          {data && (
            <span className={`wfc-status ${STATUS_CLASS[data.status] || "wfc-status-notavailable"}`}>
              {data.status}
            </span>
          )}
          {lastUpdated > 0 && (
            <span className="wfc-updated">
              Updated {new Date(lastUpdated).toLocaleTimeString()}
            </span>
          )}
          <button className="btn btn-outline btn-sm" onClick={loadOverview}>
            <FaSync /> Refresh
          </button>
        </div>
      </div>

      {error && <div className="status-msg error">{error}</div>}

      {latestWeather && (
        <div className="wfc-weather-now">
          <span className="wfc-w-label">
            <FaCloudSun /> Latest weather
          </span>
          <span className="wfc-w-desc">
            <strong>{latestWeather.weather_main || "—"}</strong>
            {latestWeather.weather_description ? ` · ${latestWeather.weather_description}` : ""}
            {latestWeather.temperature !== null ? ` · ${latestWeather.temperature}°C` : ""}
            {latestWeather.humidity !== null ? ` · ${latestWeather.humidity}% RH` : ""}
            {latestWeather.pressure !== null ? ` · ${latestWeather.pressure} hPa` : ""}
            {latestWeather.wind_speed !== null ? ` · ${latestWeather.wind_speed} m/s` : ""}
            {latestWeather.rain_1h !== null ? ` · rain ${latestWeather.rain_1h} mm/1h` : ""}
          </span>
          <span className="wfc-w-age">
            <FaClock /> {formatTime(latestWeather.observed_at)}
          </span>
        </div>
      )}

      {quality && Number(quality.observation_count) > 0 && (
        <div className="wfc-stat-strip">
          <div className="wfc-stat">
            <FaCloudSun />
            <div>
              <strong>{quality.observation_count}</strong>
              <span>Weather obs ({quality.window_hours}h)</span>
            </div>
          </div>

          <div className={`wfc-stat ${data?.signals_ready > 0 ? "stat-active" : ""}`}>
            <FaLink />
            <div>
              <strong>
                {data?.signals_ready}/{data?.signals_total}
              </strong>
              <span>Signals computed</span>
            </div>
          </div>

          {strongest ? (
            <div className="wfc-stat stat-info">
              <FaTachometerAlt />
              <div>
                <strong>{strongest.r}</strong>
                <span>
                  Strongest |r| · {strongest.shortLabel} · {strongest.direction} ·{" "}
                  {strongest.strength}
                </span>
              </div>
            </div>
          ) : (
            <div className="wfc-stat">
              <FaTachometerAlt />
              <div>
                <strong>—</strong>
                <span>Strongest |r|</span>
              </div>
            </div>
          )}

          <div className="wfc-stat">
            <FaWater />
            <div>
              <strong>{quality.first_observation_at ? formatTime(quality.first_observation_at) : "—"}</strong>
              <span>First observation</span>
            </div>
          </div>
        </div>
      )}

      {strongest && (
        <div className="wfc-strongest">
          <FaChartLine style={{ color: "#0ea5e9" }} />
          <span className="wfc-strongest-r">{strongest.r}</span>
          <div>
            <div className="wfc-strongest-name">{strongest.label}</div>
            <div className="wfc-strongest-meta">
              <span className={`wfc-label ${DIR_CLASS[strongest.direction] || ""}`}>
                {strongest.direction}
              </span>
              <span className={`wfc-label ${STRENGTH_CLASS[strongest.strength] || ""}`}>
                {strongest.strength}
              </span>
              <span className="wfc-pairs">{strongest.matched_pairs} pairs</span>
            </div>
          </div>
          <span className="wfc-strongest-label" style={{ marginLeft: "auto" }}>
            strongest |r|
          </span>
        </div>
      )}

      <div className="wfc-card">
        <div className="wfc-card-header">
          <h3>
            <FaListUl /> Correlation Signals ({signals.length})
          </h3>
          <div className="wfc-toolbar">
            <label>
              Window
              <select
                value={windowHours}
                onChange={(e) => setWindowHours(Number(e.target.value))}
              >
                {WINDOW_OPTIONS.map((w) => (
                  <option key={w} value={w}>
                    {w}h
                  </option>
                ))}
              </select>
            </label>
            <label>
              Lag
              <select
                value={lagMinutes}
                onChange={(e) => setLagMinutes(Number(e.target.value))}
              >
                {LAG_OPTIONS.map((l) => (
                  <option key={l} value={l}>
                    {l > 0 ? `${l}m` : "none"}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
        <div className="wfc-table-scroll">
          <table className="wfc-table">
            <thead>
              <tr>
                <th>Signal</th>
                <th>Status</th>
                <th>r</th>
                <th>Direction</th>
                <th>Strength</th>
                <th>Matched Pairs</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              {signals.map((signal) => (
                <tr
                  key={signal.signal}
                  style={{
                    cursor: "pointer",
                    background:
                      signal.signal === selectedSignal ? "#f0f9ff" : undefined
                  }}
                  onClick={() => setSelectedSignal(signal.signal)}
                >
                  <td>
                    <strong>{signal.label}</strong>
                    <span className="cell-sub">{signal.signal}</span>
                  </td>
                  <td>
                    <span
                      className={`wfc-label ${
                        STATUS_CLASS[signal.status] || "wfc-status-notavailable"
                      }`}
                    >
                      {signal.status}
                    </span>
                  </td>
                  <td className="wfc-id">
                    {signal.r === null || signal.r === undefined ? "—" : signal.r}
                  </td>
                  <td>
                    {signal.direction ? (
                      <span className={`wfc-label ${DIR_CLASS[signal.direction] || ""}`}>
                        {signal.direction}
                      </span>
                    ) : (
                      <span className="wfc-muted">—</span>
                    )}
                  </td>
                  <td>
                    {signal.strength ? (
                      <span className={`wfc-label ${STRENGTH_CLASS[signal.strength] || ""}`}>
                        {signal.strength}
                      </span>
                    ) : (
                      <span className="wfc-muted">—</span>
                    )}
                  </td>
                  <td className="wfc-pairs">{signal.matched_pairs}</td>
                  <td className="wfc-muted">{signal.description}</td>
                </tr>
              ))}
              {signals.length === 0 && (
                <tr>
                  <td colSpan="7" className="wfc-no-rows">
                    No signal data available.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {detail && (
        <div className="wfc-card">
          <div className="wfc-card-header">
            <h3>
              <FaChartLine /> Detail · {detail.label} ({detail.signal})
            </h3>
            {detail.status === "READY" && detail.correlation && (
              <div className="wfc-toolbar">
                <span className={`wfc-label ${STRENGTH_CLASS[detail.correlation.strength] || ""}`}>
                  {detail.correlation.strength} · r = {detail.correlation.r}
                </span>
                <span className={`wfc-label ${DIR_CLASS[detail.correlation.direction] || ""}`}>
                  {detail.correlation.direction}
                </span>
              </div>
            )}
          </div>
          <div className="wfc-table-scroll">
            {detail.wording && <p style={{ padding: "10px 12px", margin: 0, fontSize: "0.82rem" }}>{detail.wording}</p>}
            {detail.message && (
              <p className="wfc-signal-note" style={{ margin: "10px 12px" }}>
                <FaExclamationTriangle /> {detail.message}
              </p>
            )}
            {detail.samples && (
              <table className="wfc-table">
                <thead>
                  <tr>
                    <th>Matched Pairs</th>
                    <th>Weather Used</th>
                    <th>Sensor Used</th>
                    <th>Weather Total</th>
                    <th>Sensor Total</th>
                    <th>Timestamp Alignment</th>
                    <th>Window / Lag / Tolerance</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className="wfc-pairs">{detail.samples.matched_pairs}</td>
                    <td className="wfc-pairs">{detail.samples.weather_used}</td>
                    <td className="wfc-pairs">{detail.samples.sensor_used}</td>
                    <td className="wfc-pairs">{detail.samples.weather_total}</td>
                    <td className="wfc-pairs">{detail.samples.sensor_total}</td>
                    <td className="wfc-pairs">{detail.samples.timestamp_alignment}</td>
                    <td className="wfc-pairs">
                      {detail.samples.window_hours}h / {detail.samples.lag_minutes}m /{" "}
                      {detail.samples.tolerance_minutes}m
                    </td>
                  </tr>
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {trends && (
        <div className="wfc-card">
          <div className="wfc-card-header">
            <h3>
              <FaChartLine /> Time-bucketed trend · {trends.label}
            </h3>
            <div className="wfc-toolbar">
              <span className={`wfc-label ${TREND_CLASS[trends.trend] || "wfc-trend-insufficient"}`}>
                {trends.trend}
              </span>
              <span className="wfc-muted">{trends.trend_reason}</span>
            </div>
          </div>
          <div className="wfc-bucket-grid">
            {trends.buckets.map((bucket) => (
              <div key={bucket.bucket} className="wfc-bucket">
                <div className="wfc-bucket-head">
                  Bucket {bucket.bucket} · {bucket.matched_pairs} pairs
                </div>
                <div className="wfc-bucket-r">
                  {bucket.r === null || bucket.r === undefined ? "—" : bucket.r}
                </div>
                <div className="wfc-bucket-pairs">
                  {bucket.direction ? (
                    <>
                      {bucket.direction}
                      {bucket.strength ? ` · ${bucket.strength}` : ""}
                    </>
                  ) : (
                    "insufficient pairs"
                  )}
                </div>
              </div>
            ))}
            {trends.buckets.length === 0 && (
              <div className="wfc-no-rows" style={{ padding: "12px" }}>
                No time-bucketed correlation is available for this signal.
              </div>
            )}
          </div>
        </div>
      )}

      {drains && (
        <div className="wfc-card">
          <div className="wfc-card-header">
            <h3>
              <FaWater /> Per-drain correlations ({drains.drains.length})
            </h3>
          </div>
          <div className="wfc-table-scroll">
            <table className="wfc-table">
              <thead>
                <tr>
                  <th>Drain</th>
                  <th>Zone</th>
                  <th>Status</th>
                  <th>Strongest Signal</th>
                  <th>r</th>
                  <th>Direction</th>
                  <th>Strength</th>
                  <th>Pairs</th>
                </tr>
              </thead>
              <tbody>
                {drains.drains.map((drain) => (
                  <tr key={drain.drain_id}>
                    <td>
                      <strong>{drain.location || `Drain ${drain.drain_id}`}</strong>
                      <span className="cell-sub">drain {drain.drain_id}</span>
                    </td>
                    <td>{drain.zone || "—"}</td>
                    <td>
                      <span
                        className={`wfc-label ${
                          STATUS_CLASS[drain.status] || "wfc-status-notavailable"
                        }`}
                      >
                        {drain.status}
                      </span>
                    </td>
                    <td>
                      {drain.strongest
                        ? drain.strongest.label || drain.strongest.signal
                        : <span className="wfc-muted">—</span>}
                    </td>
                    <td className="wfc-id">
                      {drain.strongest ? drain.strongest.r : "—"}
                    </td>
                    <td>
                      {drain.strongest?.direction ? (
                        <span className={`wfc-label ${DIR_CLASS[drain.strongest.direction] || ""}`}>
                          {drain.strongest.direction}
                        </span>
                      ) : (
                        <span className="wfc-muted">—</span>
                      )}
                    </td>
                    <td>
                      {drain.strongest?.strength ? (
                        <span className={`wfc-label ${STRENGTH_CLASS[drain.strongest.strength] || ""}`}>
                          {drain.strongest.strength}
                        </span>
                      ) : (
                        <span className="wfc-muted">—</span>
                      )}
                    </td>
                    <td className="wfc-pairs">
                      {drain.strongest ? drain.strongest.matched_pairs : "—"}
                    </td>
                  </tr>
                ))}
                {drains.drains.length === 0 && (
                  <tr>
                    <td colSpan="8" className="wfc-no-rows">
                      No drains registered.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {data && <p className="wfc-disclaimer">{data.disclaimer}</p>}
    </div>
  );
}

export default WeatherFloodCorrelationPage;