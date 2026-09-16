import { useEffect, useState } from "react";
import axios from "axios";
import { API_URL } from "../services/api";
import {
  FaWater,
  FaRobot,
  FaExclamationTriangle
} from "react-icons/fa";

function DashboardCards({ dashboard }) {

  const [data, setData] = useState(dashboard);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {

    axios
      .get(`${API_URL}/dashboard`)
      .then((res) => {
        setData(res.data);
        setLoaded(true);
      })
      .catch((err) => {
        console.log("Dashboard Error:", err);
        setError(true);
        setLoaded(true);
      });

  }, []);

  useEffect(() => {

    if (!dashboard) return;

    const hasRealValues =
      dashboard.totalDrains !== 0 ||
      dashboard.activeRobots !== 0 ||
      dashboard.criticalAlerts !== 0;

    if (hasRealValues || loaded) {
      setData(dashboard);
    }

  }, [dashboard, loaded]);

  if (!loaded) {

    return (
      <div className="dashboard-cards">
        <div className="dashboard-card">
          <p style={{ color: "#64748b" }}>Loading dashboard...</p>
        </div>
      </div>
    );

  }

  return (
    <div className="dashboard-cards">

      {error && (
        <div className="status-msg error">
          Dashboard data unavailable - check that the backend is running.
        </div>
      )}

      <div className="dashboard-card">
        <FaWater className="card-icon" />
        <h2>{data.totalDrains}</h2>
        <p>Total Drains</p>
      </div>

      <div className="dashboard-card">
        <FaRobot className="card-icon" />
        <h2>{data.activeRobots}</h2>
        <p>Active Robots</p>
      </div>

      <div className="dashboard-card">
        <FaExclamationTriangle className="card-icon" />
        <h2>{data.criticalAlerts}</h2>
        <p>Critical Alerts</p>
      </div>

    </div>
  );
}

export default DashboardCards;