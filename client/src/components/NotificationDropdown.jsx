import { useEffect, useState } from "react";
import axios from "axios";
import "./NotificationDropdown.css";
import { API_URL } from "../services/api";

function typeClass(alert) {
  if (alert.severity === "Critical") return "danger";
  if (alert.severity === "Medium") return "warning";
  return "success";
}

function timeLabel(createdAt) {
  const mins = Math.floor((Date.now() - new Date(createdAt).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  return `${Math.floor(mins / 60)} hr ago`;
}

function NotificationDropdown() {

  const [alerts, setAlerts] = useState([]);

  useEffect(() => {
    let active = true;

    const load = async () => {
      try {
        const res = await axios.get(`${API_URL}/alerts`);
        if (active) {
          setAlerts(res.data.slice(0, 8));
        }
      } catch (err) {
        console.log(err);
      }
    };

    load();

    const interval = setInterval(load, 15000);

    return () => {
      active = false;
      clearInterval(interval);
    };
  }, []);

  return (

    <div className="notification-dropdown">

      <h3>Notifications</h3>

      {alerts.length === 0 ? (

        <p style={{ padding: "12px", color: "#94a3b8" }}>
          No alerts yet
        </p>

      ) : (

        alerts.map((alert) => (

          <div
            key={alert.id}
            className={`notification-item ${typeClass(alert)}`}
          >

            <h4>{alert.alert_type} — {alert.location}</h4>

            <span>{timeLabel(alert.created_at)}</span>

          </div>

        ))

      )}

    </div>

  );

}

export default NotificationDropdown;