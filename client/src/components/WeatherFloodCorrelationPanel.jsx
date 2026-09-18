import { useEffect, useMemo, useState } from "react";
import {
  FaWater,
  FaTachometerAlt,
  FaPercent,
  FaExclamationTriangle,
  FaLink,
  FaCloudSun,
  FaClock,
  FaChartLine
} from "react-icons/fa";
import "../styles/weatherFloodCorrelation.css";
import socket from "../services/socket";
import { getWeatherCorrelation } from "../services/weatherFloodCorrelationService";

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

function WeatherFloodCorrelationPanel({ onOpen }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    getWeatherCorrelation()
      .then((payload) => setData(payload))
      .catch((err) => {
        console.log("Weather correlation load error:", err);
        setError("Weather correlation unavailable");
      });

    const onUpdate = (payload) => {
      if (payload && payload.status) setData(payload);
    };

    socket.on("weatherFloodCorrelationUpdate", onUpdate);

    return () => {
      socket.off("weatherFloodCorrelationUpdate", onUpdate);
    };
  }, []);

  const signals = useMemo(() => data?.signals || [], [data]);
  const strongest = data?.strongest || null;
  const latestWeather = data?.latest_weather || null;
  const quality = data?.weather_data_quality || null;

  function formatTime(value) {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return date.toLocaleString();
  }

  return (
    <div className="wfc-shell">
      <div className="wfc-shell-header">
        <div>
          <h2>⛅ Weather + Flood Correlation</h2>
          <p className="wfc-subtitle">
            Descriptive Pearson associations between real weather &amp; sensor data · never
            causal
          </p>
        </div>

        <div className="wfc-actions">
          {data && (
            <span className={`wfc-status ${STATUS_CLASS[data.status] || "wfc-status-notavailable"}`}>
              {data.status}
            </span>
          )}
          <button className="btn btn-outline btn-sm" onClick={onOpen}>
            <FaChartLine /> Correlation Console
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
            {latestWeather.temperature !== null
              ? ` · ${latestWeather.temperature}°C`
              : ""}
            {latestWeather.humidity !== null ? ` · ${latestWeather.humidity}% RH` : ""}
          </span>
          <span className="wfc-w-age">
            <FaClock /> {formatTime(latestWeather.observed_at)}
          </span>
        </div>
      )}

      {signals.length === 0 && (
        <div className="wfc-empty">
          <FaCloudSun /> No weather observations recorded yet — observations appear as real
          OpenWeatherMap snapshots are fetched.
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
                <span>Strongest |r| · {strongest.shortLabel}</span>
              </div>
            </div>
          ) : (
            <div className="wfc-stat">
              <FaPercent />
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

      {signals.length > 0 && (
        <div className="wfc-signal-list">
          {signals.map((signal) => (
            <div key={signal.signal} className="wfc-signal">
              <div className="wfc-signal-top">
                <span className="wfc-signal-name">{signal.label}</span>
                <span className="wfc-signal-id">{signal.signal}</span>
              </div>
              <div className="wfc-signal-meta">
                {signal.status === "READY" ? (
                  <>
                    <span className="wfc-label wfc-strength-ready">
                      r = {signal.r}
                    </span>
                    <span className={`wfc-label ${DIR_CLASS[signal.direction] || ""}`}>
                      {signal.direction}
                    </span>
                    <span
                      className={`wfc-label ${
                        STRENGTH_CLASS[signal.strength] || ""
                      }`}
                    >
                      {signal.strength}
                    </span>
                    <span className="wfc-pairs">{signal.matched_pairs} pairs</span>
                  </>
                ) : (
                  <span
                    className={`wfc-label ${
                      STATUS_CLASS[signal.status] || "wfc-status-notavailable"
                    }`}
                  >
                    {signal.status}
                  </span>
                )}
              </div>
              <p className="wfc-signal-desc">{signal.description}</p>
              {signal.status === "NOT_AVAILABLE" && signal.message && (
                <p className="wfc-signal-note">
                  <FaExclamationTriangle /> {signal.message}
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      {quality && Number(quality.observation_count) === 0 && (
        <div className="wfc-note">
          <FaCloudSun /> Correlation needs a bounded window of overlapping weather and sensor
          data (default 24h, max 168h). Forecast &amp; flood-risk history are never persisted,
          so those signals report NOT_AVAILABLE honestly.
        </div>
      )}

      {data && <p className="wfc-disclaimer">{data.disclaimer}</p>}
    </div>
  );
}

export default WeatherFloodCorrelationPanel;