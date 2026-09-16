import {
  FaBell,
  FaSearch,
  FaUserCircle,
  FaMoon,
  FaSun,
  FaCog,
  FaSignOutAlt
} from "react-icons/fa";

import { useEffect, useState } from "react";
import axios from "axios";

import "../../styles/header.css";
import NotificationDropdown from "../NotificationDropdown";
import { API_URL } from "../../services/api";
function Header() {

  const [time, setTime] = useState(new Date());

  const [darkMode, setDarkMode] = useState(false);

  const [showProfile, setShowProfile] = useState(false);
const [showNotifications, setShowNotifications] = useState(false);
  const [alertCount, setAlertCount] = useState(0);

  useEffect(() => {

    let active = true;

    const loadAlerts = async () => {

      try {

        const res = await axios.get(`${API_URL}/alerts`);

        if (active) {

          setAlertCount(
            res.data.filter((a) => a.alert_status === "Open").length
          );

        }

      } catch (err) {

        console.log(err);

      }

    };

    loadAlerts();

    const interval = setInterval(loadAlerts, 30000);

    return () => {

      active = false;

      clearInterval(interval);

    };

  }, []);
  useEffect(() => {

    const timer = setInterval(() => {

      setTime(new Date());

    }, 1000);

    return () => clearInterval(timer);

  }, []);

  useEffect(() => {

    if (darkMode) {

      document.body.classList.add("dark-mode");

    } else {

      document.body.classList.remove("dark-mode");

    }

  }, [darkMode]);

  const logout = () => {

    localStorage.removeItem("token");

    localStorage.removeItem("user");

    window.location.reload();

  };

  return (

    <header className="header">

      <div className="header-left">

        <h1>🚧 AI-DrainOS</h1>

        <p>Smart Drainage Monitoring Dashboard</p>

      </div>

      <div className="header-center">

        <div className="search-box">

          <FaSearch />

          <input
            type="text"
            placeholder="Search zones, robots, sensors..."
          />

        </div>

      </div>

      <div className="header-right">

        <button
          className="theme-btn"
          onClick={() => setDarkMode(!darkMode)}
        >

          {darkMode ? <FaSun /> : <FaMoon />}

        </button>

        <div
  className="notification"
  onClick={() => setShowNotifications(!showNotifications)}
>

  <FaBell />

  {alertCount > 0 && (

    <span className="badge">{alertCount}</span>

  )}

  {

    showNotifications &&

    <NotificationDropdown />

  }

</div>

        <div className="clock">

          {time.toLocaleDateString()}

          <br />

          {time.toLocaleTimeString()}

        </div>

        <div
          className="profile"
          onClick={() => setShowProfile(!showProfile)}
        >
          <FaUserCircle />

          <span>
            {(() => {
              const currentUser = JSON.parse(localStorage.getItem("user") || "{}");
              const name = currentUser.full_name || currentUser.email || "User";
              const role = currentUser.role || "Operator";
              return `${name} (${role}) ▼`;
            })()}
          </span>

          {showProfile && (

            <div className="profile-menu">

              <p>

                <FaCog />

                Settings

              </p>

              <p
                onClick={(e) => {

                  e.stopPropagation();

                  logout();

                }}
              >

                <FaSignOutAlt />

                Logout

              </p>

            </div>

          )}

        </div>

      </div>

    </header>

  );

}

export default Header;