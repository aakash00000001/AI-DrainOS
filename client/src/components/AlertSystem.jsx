import { useEffect, useState } from "react";
import axios from "axios";
import {
  FaExclamationTriangle,
  FaMapMarkerAlt,
  FaClock,
  FaPlus,
  FaCheckCircle
} from "react-icons/fa";
import "../styles/pages.css";
import { API_URL, authHeaders } from "../services/api";

function AlertSystem() {

  const [alerts, setAlerts] = useState([]);
  const [drains, setDrains] = useState([]);
  const [aiPrediction, setAiPrediction] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [message, setMessage] = useState(null);

  const [form, setForm] = useState({
    drain_id: "",
    alert_type: "Blockage",
    message: "",
    severity: "Medium"
  });

  const headers = authHeaders();

  const loadAlerts = async () => {

    try {

      const alertResponse = await axios.get(`${API_URL}/alerts`);
      setAlerts(alertResponse.data);

      const predictionResponse = await axios.get(`${API_URL}/predictions`);
      setAiPrediction(predictionResponse.data.prediction);

    } catch (error) {

      console.log(error);

    }

  };

  useEffect(() => {

    axios
      .get(`${API_URL}/alerts`)
      .then((res) => setAlerts(res.data));

    axios
      .get(`${API_URL}/predictions`)
      .then((res) => setAiPrediction(res.data.prediction));

    axios
      .get(`${API_URL}/drains`)
      .then((res) => setDrains(res.data));

    const interval = setInterval(loadAlerts, 5000);

    return () => clearInterval(interval);

  }, []);

  const createAlert = async () => {

    setMessage(null);

    if (!form.drain_id || !form.message) {
      setMessage({ type: "error", text: "Select a drain and enter a message" });
      return;
    }

    try {

      await axios.post(
        `${API_URL}/alerts`,
        {
          drain_id: Number(form.drain_id),
          alert_type: form.alert_type,
          message: form.message,
          severity: form.severity
        },
        { headers }
      );

      setMessage({ type: "success", text: "Alert created" });
      setForm({ drain_id: "", alert_type: "Blockage", message: "", severity: "Medium" });
      setShowForm(false);
      loadAlerts();

    } catch (error) {

      console.log(error);
      setMessage({ type: "error", text: error.response?.data?.error || "Failed to create alert" });

    }

  };

  const resolveAlert = async (id) => {

    try {

      await axios.put(
        `${API_URL}/alerts/${id}`,
        { alert_status: "Resolved" },
        { headers }
      );

      loadAlerts();

    } catch (error) {

      console.log(error);

    }

  };

  return (

    <div className="alert-card">

      <div className="card-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>

        <h2>🚨 Alert Center</h2>

        <button
          className="btn btn-primary btn-sm"
          onClick={() => setShowForm(!showForm)}
        >
          <FaPlus /> {showForm ? "Close" : "Create Alert"}
        </button>

      </div>

      {message && (
        <div className={`status-msg ${message.type}`}>
          {message.text}
        </div>
      )}

      {showForm && (

        <div className="panel-card" style={{ boxShadow: "none", padding: "20px", background: "#f8fafc" }}>

          <h3 style={{ marginTop: 0 }}>📝 Manual Alert</h3>

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
              <label>Type</label>
              <select
                value={form.alert_type}
                onChange={(e) => setForm({ ...form, alert_type: e.target.value })}
              >
                <option>Blockage</option>
                <option>Flood Risk</option>
                <option>Gas Alert</option>
                <option>Sensor Warning</option>
                <option>Manual Report</option>
              </select>
            </div>

            <div className="form-group">
              <label>Severity</label>
              <select
                value={form.severity}
                onChange={(e) => setForm({ ...form, severity: e.target.value })}
              >
                <option>Critical</option>
                <option>Medium</option>
                <option>Low</option>
              </select>
            </div>

            <div className="form-group">
              <label>Message</label>
              <input
                type="text"
                placeholder="Describe the issue..."
                value={form.message}
                onChange={(e) => setForm({ ...form, message: e.target.value })}
              />
            </div>

          </div>

          <button className="btn btn-success" onClick={createAlert}>
            <FaPlus /> Create Alert
          </button>

        </div>

      )}

      {aiPrediction === "HIGH" && (
        <div
          style={{
            background: "#ff4d4f",
            color: "#fff",
            padding: "15px",
            borderRadius: "10px",
            marginBottom: "15px",
            fontWeight: "bold",
            textAlign: "center"
          }}
        >
          🚨 HIGH FLOOD RISK DETECTED
        </div>
      )}

      {aiPrediction === "MEDIUM" && (
        <div
          style={{
            background: "#faad14",
            color: "#fff",
            padding: "15px",
            borderRadius: "10px",
            marginBottom: "15px",
            fontWeight: "bold",
            textAlign: "center"
          }}
        >
          ⚠️ MEDIUM FLOOD RISK
        </div>
      )}

      {aiPrediction === "LOW" && (
        <div
          style={{
            background: "#52c41a",
            color: "#fff",
            padding: "15px",
            borderRadius: "10px",
            marginBottom: "15px",
            fontWeight: "bold",
            textAlign: "center"
          }}
        >
          ✅ SYSTEM SAFE
        </div>
      )}

      {alerts.map((alert) => (

        <div
          key={alert.id}
          className="alert-item"
        >

          <div className="alert-top">

            <FaExclamationTriangle
              className={
                alert.severity === "Critical"
                  ? "icon-critical"
                  : "icon-warning"
              }
            />

            <div>

              <h3>{alert.alert_type}</h3>

              <p>
                <FaMapMarkerAlt /> {alert.location}
              </p>

            </div>

          </div>

          <div className="alert-middle">

            <span
              className={
                alert.severity === "Critical"
                  ? "badge-critical"
                  : "badge-warning"
              }
            >
              {alert.severity}
            </span>

          </div>

          <p className="alert-message">
            {alert.message}
          </p>

          <div className="alert-time">

            <FaClock /> {new Date(alert.created_at).toLocaleString()}

            <span
              className={
                alert.alert_status === "Resolved"
                  ? "badge-warning"
                  : "badge-critical"
              }
              style={{ marginLeft: 10, marginTop: 0 }}
            >
              {alert.alert_status}
            </span>

          </div>

          {alert.alert_status === "Open" && (

            <button
              className="btn btn-success btn-sm"
              style={{ marginTop: 12 }}
              onClick={() => resolveAlert(alert.id)}
            >
              <FaCheckCircle /> Resolve
            </button>

          )}

        </div>

      ))}

    </div>

  );

}

export default AlertSystem;