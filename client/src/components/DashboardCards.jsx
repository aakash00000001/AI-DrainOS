import { useEffect, useState } from "react";
import axios from "axios";
import { API_URL } from "../services/api";
import {
  FaWater,
  FaRobot,
  FaExclamationTriangle
} from "react-icons/fa";

function DashboardCards() {

  const [dashboard, setDashboard] = useState({
    totalDrains: 0,
    activeRobots: 0,
    criticalAlerts: 0
  });

  const loadDashboard = () => {
    axios
      .get(`${API_URL}/dashboard`)
      .then((res) => {
        setDashboard(res.data);
      })
      .catch((err) => {
        console.log(err);
      });
  };

  useEffect(() => {
    loadDashboard();

    const interval = setInterval(loadDashboard, 5000);

    return () => clearInterval(interval);
  }, []);

  return (
    <div className="dashboard-cards">

      <div className="dashboard-card">
        <FaWater className="card-icon" />
        <h2>{dashboard.totalDrains}</h2>
        <p>Total Drains</p>
      </div>

      <div className="dashboard-card">
        <FaRobot className="card-icon" />
        <h2>{dashboard.activeRobots}</h2>
        <p>Active Robots</p>
      </div>

      <div className="dashboard-card">
        <FaExclamationTriangle className="card-icon" />
        <h2>{dashboard.criticalAlerts}</h2>
        <p>Critical Alerts</p>
      </div>

    </div>
  );
}

export default DashboardCards;