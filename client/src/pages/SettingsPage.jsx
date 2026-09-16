import { useEffect, useState } from "react";
import axios from "axios";
import { FaSave, FaBell, FaBalanceScale, FaBatteryHalf, FaServer } from "react-icons/fa";
import "../styles/pages.css";
import { API_URL } from "../services/api";
import { authHeaders } from "../services/api";

const DEFAULT_SETTINGS = {
  system_name: "AI-DrainOS",
  critical_threshold: "80",
  warning_threshold: "50",
  battery_low_threshold: "20",
  sensor_sim_interval: "10",
  notification_enabled: "true"
};

function SettingsPage() {
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);

  const user = JSON.parse(localStorage.getItem("user") || "{}");
  const isAdmin = user.role === "Admin";

  useEffect(() => {

    axios
      .get(`${API_URL}/settings`)
      .then((res) => setSettings({ ...DEFAULT_SETTINGS, ...res.data }))
      .catch((err) => {
        console.log(err);
        setMessage({ type: "error", text: "Failed to load settings" });
      })
      .finally(() => setLoading(false));

  }, []);

  const update = (key, value) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  };

  const save = async () => {
    setSaving(true);
    setMessage(null);

    try {
      const res = await axios.put(
        `${API_URL}/settings`,
        {
          system_name: settings.system_name,
          critical_threshold: Number(settings.critical_threshold),
          warning_threshold: Number(settings.warning_threshold),
          battery_low_threshold: Number(settings.battery_low_threshold),
          sensor_sim_interval: Number(settings.sensor_sim_interval),
          notification_enabled: String(settings.notification_enabled)
        },
        { headers: authHeaders() }
      );

      setSettings(res.data.settings);
      setMessage({ type: "success", text: "Settings saved successfully" });
    } catch (err) {
      console.log(err);
      setMessage({
        type: "error",
        text: err.response?.data?.error || "Failed to save settings"
      });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <p style={{ color: "#64748b" }}>Loading settings...</p>;
  }

  return (
    <div className="page-section">

      <h2>⚙️ System Settings</h2>

      <div className="panel-grid">

        <div className="panel-card">

          <h2>🚧 System</h2>

          <div className="form-group">
            <label>System Name</label>
            <input
              type="text"
              value={settings.system_name}
              disabled={!isAdmin}
              onChange={(e) => update("system_name", e.target.value)}
            />
            <p className="hint">Shown in the dashboard header and reports</p>
          </div>

          <div className="form-group">
            <label>Sensor Simulation Interval (seconds)</label>
            <input
              type="number"
              min="5"
              value={settings.sensor_sim_interval}
              disabled={!isAdmin}
              onChange={(e) => update("sensor_sim_interval", e.target.value)}
            />
            <p className="hint">How often the sensor simulator writes readings</p>
          </div>

        </div>

        <div className="panel-card">

          <h2>📊 Drain Thresholds</h2>

          <p>Drains are flagged based on water level (%)</p>

          <div className="form-group">
            <label>
              <FaBalanceScale /> Critical Level (%)
            </label>
            <input
              type="number"
              min="1"
              max="100"
              value={settings.critical_threshold}
              disabled={!isAdmin}
              onChange={(e) => update("critical_threshold", e.target.value)}
            />
            <p className="hint">Water level at or above this = Critical → robot dispatched</p>
          </div>

          <div className="form-group">
            <label>
              <FaBalanceScale /> Warning Level (%)
            </label>
            <input
              type="number"
              min="1"
              max="100"
              value={settings.warning_threshold}
              disabled={!isAdmin}
              onChange={(e) => update("warning_threshold", e.target.value)}
            />
            <p className="hint">Water level at or above this = Warning</p>
          </div>

          <div className="form-group">
            <label>
              <FaBatteryHalf /> Low Battery Alert (%)
            </label>
            <input
              type="number"
              min="1"
              max="100"
              value={settings.battery_low_threshold}
              disabled={!isAdmin}
              onChange={(e) => update("battery_low_threshold", e.target.value)}
            />
            <p className="hint">Robots below this level are sent to charge</p>
          </div>

        </div>

        <div className="panel-card">

          <h2>
            <FaBell /> Notifications
          </h2>

          <div className="switch-group">
            <div className="switch-label">
              <h4>System Notifications</h4>
              <p>Send alerts for critical drains, cleaned zones and low battery</p>
            </div>
            <label className="switch">
              <input
                type="checkbox"
                checked={settings.notification_enabled === "true"}
                disabled={!isAdmin}
                onChange={(e) => update("notification_enabled", String(e.target.checked))}
              />
              <span className="switch-slider" />
            </label>
          </div>

        </div>

      </div>

      {message && (
        <div className={`status-msg ${message.type}`}>
          {message.text}
        </div>
      )}

      {isAdmin ? (
        <button className="btn btn-primary" onClick={save} disabled={saving}>
          <FaSave /> {saving ? "Saving..." : "Save Settings"}
        </button>
      ) : (
        <div className="settings-readonly">
          <FaServer /> Read-only view — only administrators can change settings
        </div>
      )}

    </div>
  );
}

export default SettingsPage;