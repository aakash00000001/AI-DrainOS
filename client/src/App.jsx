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

    socket.on("dashboardUpdate", (data) => {

      setDashboard(data);

    });

    return () => {

      socket.off("connect");
      socket.off("disconnect");
      socket.off("drainCleaned");
      socket.off("criticalAlert");
      socket.off("batteryLow");
      socket.off("dashboardUpdate");

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