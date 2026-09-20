import {
  FaTachometerAlt,
  FaMapMarkedAlt,
  FaCube,
  FaRobot,
  FaBroadcastTower,
  FaBell,
  FaBrain,
  FaChartBar,
  FaCog,
  FaUsers,
  FaSignOutAlt,
  FaListOl,
  FaAmbulance,
  FaTruckMoving,
  FaNetworkWired,
  FaMicrochip,
  FaCloudRain,
  FaClipboardList,
  FaHistory,
  FaClipboardCheck
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

          {/* Digital Twin */}
          <li
            className={activePage === "digitaltwin" ? "active" : ""}
            onClick={() => onNavigate("digitaltwin")}
          >
            <FaCube />
            <span>Digital Twin</span>
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

          {/* Sensor Intelligence (Update #21) */}
          <li
            className={activePage === "sensorintelligence" ? "active" : ""}
            onClick={() => onNavigate("sensorintelligence")}
          >
            <FaMicrochip />
            <span>Sensor Intelligence</span>
          </li>

          {/* Weather + Flood Correlation (Update #23) */}
          <li
            className={activePage === "weathercorrelation" ? "active" : ""}
            onClick={() => onNavigate("weathercorrelation")}
          >
            <FaCloudRain />
            <span>Weather Correlation</span>
          </li>

          {/* Alerts */}
          <li
            className={activePage === "alerts" ? "active" : ""}
            onClick={() => onNavigate("alerts")}
          >
            <FaBell />
            <span>Alerts</span>
          </li>

          {/* Emergency / Incidents (Update #18) */}
          <li
            className={activePage === "incidents" ? "active" : ""}
            onClick={() => onNavigate("incidents")}
          >
            <FaAmbulance />
            <span>Emergency / Incidents</span>
          </li>

          {/* Fleet Optimization (Update #19) */}
          <li
            className={activePage === "fleetoptimization" ? "active" : ""}
            onClick={() => onNavigate("fleetoptimization")}
          >
            <FaTruckMoving />
            <span>Fleet Optimization</span>
          </li>

          {/* Mission Coordination (Update #22) */}
          <li
            className={activePage === "missioncoordination" ? "active" : ""}
            onClick={() => onNavigate("missioncoordination")}
          >
            <FaNetworkWired />
            <span>Mission Coordination</span>
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

          {/* Historical Intelligence (Update #26) */}
          <li
            className={activePage === "historical" ? "active" : ""}
            onClick={() => onNavigate("historical")}
          >
            <FaHistory />
            <span>Historical Intelligence</span>
          </li>

          {/* AI Decisions */}
          <li
            className={activePage === "decisions" ? "active" : ""}
            onClick={() => onNavigate("decisions")}
          >
            <FaListOl />
            <span>AI Decisions</span>
          </li>

          {/* Decision Audit (Update #24) */}
          <li
            className={activePage === "decisionaudit" ? "active" : ""}
            onClick={() => onNavigate("decisionaudit")}
          >
            <FaClipboardList />
            <span>Decision Audit</span>
          </li>

          {/* Operator Audit (Update #27, Admin only) */}
          {userRole === "Admin" && (
            <li
              className={activePage === "operatoraudit" ? "active" : ""}
              onClick={() => onNavigate("operatoraudit")}
            >
              <FaClipboardCheck />
              <span>Operator Audit</span>
            </li>
          )}

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