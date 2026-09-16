import {
  FaTachometerAlt,
  FaMapMarkedAlt,
  FaRobot,
  FaBroadcastTower,
  FaBell,
  FaBrain,
  FaChartBar,
  FaCog,
  FaUsers,
  FaSignOutAlt
} from "react-icons/fa";

import "../../styles/sidebar.css";

function Sidebar({ activePage, onNavigate, userRole }) {
  return (
    <aside className="sidebar">

      {/* Logo */}
      <div className="logo">
        <h2>🚧 AI-DrainOS</h2>
        <p>Smart Monitoring</p>
      </div>

      {/* Navigation */}
      <nav>
        <ul>

          {/* Dashboard */}
          <li
            className={activePage === "dashboard" ? "active" : ""}
            onClick={() => onNavigate("dashboard")}
          >
            <FaTachometerAlt />
            <span>Dashboard</span>
          </li>

          {/* Drain Map */}
          <li
            className={activePage === "drainmap" ? "active" : ""}
            onClick={() => onNavigate("drainmap")}
          >
            <FaMapMarkedAlt />
            <span>Drain Map</span>
          </li>

          {/* Robots */}
          <li
            className={activePage === "robots" ? "active" : ""}
            onClick={() => onNavigate("robots")}
          >
            <FaRobot />
            <span>Robots</span>
          </li>

          {/* Sensors */}
          <li
            className={activePage === "sensors" ? "active" : ""}
            onClick={() => onNavigate("sensors")}
          >
            <FaBroadcastTower />
            <span>Sensors</span>
          </li>

          {/* Alerts */}
          <li
            className={activePage === "alerts" ? "active" : ""}
            onClick={() => onNavigate("alerts")}
          >
            <FaBell />
            <span>Alerts</span>
          </li>

          {/* AI Prediction */}
          <li
            className={activePage === "prediction" ? "active" : ""}
            onClick={() => onNavigate("prediction")}
          >
            <FaBrain />
            <span>AI Prediction</span>
          </li>

          {/* Analytics */}
          <li
            className={activePage === "analytics" ? "active" : ""}
            onClick={() => onNavigate("analytics")}
          >
            <FaChartBar />
            <span>Analytics</span>
          </li>

          {/* Users (Admin only) */}
          {userRole === "Admin" && (
            <li
              className={activePage === "users" ? "active" : ""}
              onClick={() => onNavigate("users")}
            >
              <FaUsers />
              <span>Users</span>
            </li>
          )}

          {/* Settings */}
          <li
            className={activePage === "settings" ? "active" : ""}
            onClick={() => onNavigate("settings")}
          >
            <FaCog />
            <span>Settings</span>
          </li>

        </ul>
      </nav>

      {/* Logout */}
      <div
        className="logout"
        onClick={() => {
          localStorage.removeItem("token");
          window.location.reload();
        }}
      >
        <FaSignOutAlt />
        <span>Logout</span>
      </div>

    </aside>
  );
}

export default Sidebar;