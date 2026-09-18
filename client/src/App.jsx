import "./App.css";
import { useState, useEffect } from "react";
import axios from "axios";

import Login from "./pages/Login";
import SettingsPage from "./pages/SettingsPage";
import UsersPage from "./pages/UsersPage";
import MissionControl from "./pages/MissionControl";

import DashboardLayout from "./components/layout/DashboardLayout";
import DashboardCards from "./components/DashboardCards";
import FloodRiskPanel from "./components/FloodRiskPanel";
import ForecastPanel from "./components/ForecastPanel";
import MaintenancePanel from "./components/MaintenancePanel";
import DrainVisionInspection from "./components/DrainVisionInspection";
import AIDecisionPanel from "./components/AIDecisionPanel";
import RobotRoutePlanner from "./components/RobotRoutePlanner";
import EmergencyResponsePanel from "./components/EmergencyResponsePanel";
import IncidentsPage from "./components/IncidentsPage";
import FleetOptimizationPanel from "./components/FleetOptimizationPanel";
import FleetOptimizationPage from "./components/FleetOptimizationPage";
import MissionCoordinationPanel from "./components/MissionCoordinationPanel";
import MissionCoordinationPage from "./components/MissionCoordinationPage";
import SensorIntelligencePanel from "./components/SensorIntelligencePanel";
import SensorIntelligencePage from "./components/SensorIntelligencePage";

import RobotSimulation from "./components/RobotSimulation";
import DrainMap from "./components/DrainMap";
import AlertSystem from "./components/AlertSystem";
import SensorMonitor from "./components/SensorMonitor";
import AIPrediction from "./components/AIPrediction";
import WeatherMonitor from "./components/WeatherMonitor";
import AnalyticsReport from "./components/AnalyticsReport";
import DrainTable from "./components/DrainTable";
import StatisticsChart from "./components/charts/StatisticsChart";
import PDFReport from "./components/PDFReport";

import DigitalTwinPreview from "./components/DigitalTwinPreview";
import DigitalTwinPage from "./components/DigitalTwinPage";

import socket from "./services/socket";

import { ToastContainer, toast } from "react-toastify";
import "react-toastify/dist/ReactToastify.css";

function App() {

  // Login
  const [isLoggedIn, setLogin] = useState(
    !!localStorage.getItem("token")
  );

  // Navigation
  const [activePage, setActivePage] = useState("dashboard");

  // Drains
  const [drains, setDrains] = useState([]);

  // Dashboard
  const [dashboard, setDashboard] = useState({
    totalDrains: 0,
    activeRobots: 0,
    criticalAlerts: 0
  });

  // --------------------------------------------------
  // Socket Events
  // --------------------------------------------------

  useEffect(() => {

    socket.on("connect", () => {
      console.log("🟢 Connected to Socket.IO");
    });

    socket.on("disconnect", () => {
      console.log("🔴 Socket Disconnected");
    });

    socket.on("drainCleaned", (data) => {

      toast.success(
        `🧹 ${data.robot} cleaned ${data.zone}`
      );

    });

    socket.on("criticalAlert", (alert) => {

      toast.error(
        `🚨 ${alert.alert_type}\n📍 ${alert.location}`
      );

    });

    socket.on("batteryLow", (robot) => {

      toast.warning(
        `🔋 ${robot.robot_name} Battery Low (${robot.battery_level}%)`
      );

    });

    socket.on("visionInspectionUpdate", (inspection) => {

      toast.info(
        `👁️ Vision Inspection ${inspection.inspectionLevel} (visual risk ${inspection.visualRiskScore}/100) - ${inspection.location}`
      );

    });

    socket.on("decisionUpdate", (decision) => {

      toast.info(
        `🧠 ${decision.location}: ${decision.priorityLevel} priority (${decision.priorityScore}/100) - ${decision.recommendedAction}`
      );

    });

    socket.on("incidentUpdate", (payload) => {

      if (!payload || !payload.incident) return;

      const incident = payload.incident;
      const where = incident.drain ? incident.drain.zone : `Drain #${incident.drain_id}`;

      if (payload.eventType === "created") {
        const warn =
          incident.severity === "CRITICAL" ? toast.error : toast.warning;
        warn(`🚑 Incident #${incident.id} [${incident.severity}] opened at ${where}`);
      } else if (payload.eventType === "robotUnavailable") {
        toast.warning(
          `⚠️ Incident #${incident.id} at ${where}: ${incident.route_status}`
        );
      } else if (payload.eventType === "assigned") {
        toast.info(
          `🤖 Incident #${incident.id}: robot assigned (${incident.route_status})`
        );
      } else {
        toast.info(`🚑 Incident #${incident.id} → ${incident.status} (${where})`);
      }

    });

    socket.on("fleetOptimizationUpdate", (payload) => {

      if (!payload || !payload.summary) return;

      const { summary, status } = payload;

      // Only surface an actionable alert (tasks that could not be
      // assigned); routine recomputations stay silent to avoid noise.
      if (summary.unassigned_tasks > 0 || status === "NO_ELIGIBLE_ROBOT") {
        toast.warning(
          `🚚 Fleet: ${summary.assigned_tasks}/${summary.active_tasks} tasks assigned · ${summary.unassigned_tasks} unassigned`
        );
      }

    });

    socket.on("dashboardUpdate", (data) => {

      setDashboard(data);

    });

    socket.on("missionCoordinationUpdate", (payload) => {

      if (!payload || !payload.summary) return;

      const { summary, status } = payload;

      // Only surface actionable coordination problems; routine
      // recomputations stay silent to avoid noise.
      if (summary.unassigned_tasks > 0 || summary.coordination_conflicts > 0 || status === "NO_ELIGIBLE_ROBOT") {
        toast.warning(
          `🤝 Coordination: ${summary.assigned_tasks}/${summary.total_tasks} tasks planned · ${summary.unassigned_tasks} unassigned`
        );
      }

    });

    socket.on("sensorIntelligenceUpdate", (payload) => {

      if (!payload || !payload.summary) return;

      const { summary } = payload;

      // Only surface severe sensor integrity problems; routine
      // recomputations stay silent to avoid noise.
      if (summary.counts && summary.counts.critical > 0) {
        toast.warning(
          `📡 Sensor integrity: ${summary.counts.critical} sensor(s) critical · ${summary.anomalyCount} anomaly signal(s)`
        );
      }

    });

    return () => {

      socket.off("connect");
      socket.off("disconnect");
      socket.off("drainCleaned");
      socket.off("criticalAlert");
      socket.off("batteryLow");
      socket.off("dashboardUpdate");
      socket.off("visionInspectionUpdate");
      socket.off("decisionUpdate");
      socket.off("incidentUpdate");
      socket.off("fleetOptimizationUpdate");
      socket.off("missionCoordinationUpdate");
      socket.off("sensorIntelligenceUpdate");

    };

  }, []);


  // --------------------------------------------------
  // Load Drains
  // --------------------------------------------------

  const API_URL = import.meta.env.VITE_API_URL || "http://localhost:5000/api";

  const loadDrains = () => {

    axios
      .get(`${API_URL}/drains`)

      .then((response) => {

        setDrains(response.data);

      })

      .catch((error) => {

        console.log("Drain Error:", error);

      });

  };


  useEffect(() => {

    loadDrains();

  }, []);


  // --------------------------------------------------
  // Load Dashboard
  // --------------------------------------------------

  useEffect(() => {

    axios
      .get(`${API_URL}/dashboard`)

      .then((response) => {

        setDashboard(response.data);

      })

      .catch((error) => {

        console.log("Dashboard Error:", error);

      });

  }, []);


  const currentUser = JSON.parse(
    localStorage.getItem("user") || "{}"
  );


  // --------------------------------------------------
  // Login
  // --------------------------------------------------

  if (!isLoggedIn) {

    return (
      <Login onLogin={() => setLogin(true)} />
    );

  }


  // --------------------------------------------------
  // Navigation
  // --------------------------------------------------

  const handleNavigate = (page) => {

    console.log("📌 Navigating to:", page);

    setActivePage(page);

  };


  // --------------------------------------------------
  // Page Content
  // --------------------------------------------------

  const renderPage = () => {

    // Dashboard
    if (activePage === "dashboard") {

      return (

        <>

          <DashboardCards
            dashboard={dashboard}
          />

          <FloodRiskPanel />

          <ForecastPanel />

          <MaintenancePanel />

          <DrainVisionInspection
            drains={drains}
          />

          <AIDecisionPanel />

          <RobotRoutePlanner />

          <EmergencyResponsePanel
            onOpen={() => handleNavigate("incidents")}
          />

          <FleetOptimizationPanel
            onOpen={() => handleNavigate("fleetoptimization")}
          />

          <MissionCoordinationPanel
            onOpen={() => handleNavigate("missioncoordination")}
          />

          <SensorIntelligencePanel
            onOpen={() => handleNavigate("sensorintelligence")}
          />

          <DigitalTwinPreview
            onOpen={() => handleNavigate("digitaltwin")}
          />

          <div className="sections">

            <RobotSimulation />

            <DrainMap />

            <AlertSystem />

            <SensorMonitor />

            <WeatherMonitor />

            <AnalyticsReport />

            <StatisticsChart />

            <PDFReport />

            <DrainTable
              drains={drains}
              onRefresh={loadDrains}
            />

          </div>

        </>

      );

    }


    // Drain Map
    if (activePage === "drainmap") {

      return (

        <div className="page-section">

          <h2>🗺️ Drain Map</h2>

          <DrainMap />

        </div>

      );

    }


    // Digital Twin (Update #17)
    if (activePage === "digitaltwin") {

      return (

        <div className="page-section">

          <h2>🧊 Digital Twin (3D)</h2>

          <DigitalTwinPage />

        </div>

      );

    }


    // Emergency / Incidents (Update #18)
    if (activePage === "incidents") {

      return (

        <div className="page-section">

          <h2>🚑 Emergency Response & Incidents</h2>

          <IncidentsPage />

        </div>

      );

    }


    // Fleet Optimization (Update #19)
    if (activePage === "fleetoptimization") {

      return (

        <div className="page-section">

          <h2>🚚 Fleet Optimization</h2>

          <FleetOptimizationPage />

        </div>

      );

    }


    // Mission Coordination (Update #22)
    if (activePage === "missioncoordination") {

      return (

        <div className="page-section">

          <h2>🤝 Mission Coordination</h2>

          <MissionCoordinationPage />

        </div>

      );

    }


    // Sensor Intelligence (Update #21)
    if (activePage === "sensorintelligence") {

      return (

        <div className="page-section">

          <h2>📡 Sensor Intelligence</h2>

          <SensorIntelligencePage />

        </div>

      );

    }


    // Robots
    if (activePage === "robots") {

      return (

        <div className="page-section">

          <h2>🤖 Robot Monitoring</h2>

          <RobotSimulation />

          <MissionControl />

        </div>

      );

    }


    // Sensors
    if (activePage === "sensors") {

      return (

        <div className="page-section">

          <h2>📡 Sensor Monitoring</h2>

          <SensorMonitor />

        </div>

      );

    }


    // Alerts
    if (activePage === "alerts") {

      return (

        <div className="page-section">

          <h2>🚨 Alert System</h2>

          <AlertSystem />

        </div>

      );

    }


    // AI Prediction
    if (activePage === "prediction") {

      return (

        <div className="page-section">

          <h2>🧠 AI Flood Prediction</h2>

          <AIPrediction />

        </div>

      );

    }


    // Analytics
    if (activePage === "analytics") {

      return (

        <div className="page-section">

          <h2>📊 Analytics</h2>

          <AnalyticsReport />

          <StatisticsChart />

          <PDFReport />

        </div>

      );

    }


    // AI Decisions
    if (activePage === "decisions") {

      return (

        <div className="page-section">

          <h2>🧠 AI Drain Decision Engine</h2>

          <AIDecisionPanel />

          <RobotRoutePlanner />

        </div>

      );

    }


    // Users (Admin)
    if (activePage === "users") {

      if (currentUser.role !== "Admin") {
        return (
          <div className="page-section">
            <h2>🚫 Access Denied</h2>
            <div className="panel-card">
              <p>User Management is restricted to Administrators only.</p>
            </div>
          </div>
        );
      }

      return (

        <div className="page-section">

          <h2>👥 User Management</h2>

          <UsersPage />

        </div>

      );

    }


    // Settings
    if (activePage === "settings") {

      return (

        <div className="page-section">

          <SettingsPage />

        </div>

      );

    }


    return null;

  };


  // --------------------------------------------------
  // Main UI
  // --------------------------------------------------

  return (

    <DashboardLayout
      activePage={activePage}
      onNavigate={handleNavigate}
      userRole={currentUser.role}
    >

      {renderPage()}

      <ToastContainer
        position="top-right"
        autoClose={4000}
        newestOnTop
        theme="colored"
      />

    </DashboardLayout>

  );

}

export default App;