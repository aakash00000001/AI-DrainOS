import { useEffect, useState } from "react";
import axios from "axios";
import {
  FaPaperPlane,
  FaHistory,
  FaRobot,
  FaMapMarkerAlt,
  FaBatteryHalf,
  FaClipboardList
} from "react-icons/fa";
import "../styles/pages.css";
import { API_URL } from "../services/api";

function MissionControl() {
  const [robots, setRobots] = useState([]);
  const [drains, setDrains] = useState([]);
  const [missions, setMissions] = useState([]);
  const [history, setHistory] = useState([]);

  const [selectedRobot, setSelectedRobot] = useState("");
  const [selectedDrain, setSelectedDrain] = useState("");
  const [dispatching, setDispatching] = useState(false);
  const [message, setMessage] = useState(null);

  const headers = { Authorization: `Bearer ${localStorage.getItem("token")}` };

  const loadAll = async () => {
    try {
      const [robotsRes, drainsRes, missionsRes, historyRes] = await Promise.all([
        axios.get(`${API_URL}/robots`),
        axios.get(`${API_URL}/drains`),
        axios.get(`${API_URL}/missions`),
        axios.get(`${API_URL}/missions/history`)
      ]);

      setRobots(robotsRes.data);
      setDrains(drainsRes.data);
      setMissions(missionsRes.data);
      setHistory(historyRes.data.slice(0, 10));
    } catch (err) {
      console.log(err);
    }
  };

  useEffect(() => {

    axios
      .get(`${API_URL}/robots`)
      .then((r) => setRobots(r.data));

    axios
      .get(`${API_URL}/drains`)
      .then((r) => setDrains(r.data));

    axios
      .get(`${API_URL}/missions`)
      .then((r) => setMissions(r.data));

    axios
      .get(`${API_URL}/missions/history`)
      .then((r) => setHistory(r.data.slice(0, 10)));

    const interval = setInterval(loadAll, 5000);
    return () => clearInterval(interval);
  }, []);

  const dispatch = async () => {
    setMessage(null);

    if (!selectedRobot || !selectedDrain) {
      setMessage({ type: "error", text: "Select both a robot and a drain" });
      return;
    }

    setDispatching(true);

    try {
      await axios.post(
        `${API_URL}/missions/dispatch`,
        { robot_id: Number(selectedRobot), drain_id: Number(selectedDrain) },
        { headers }
      );

      setMessage({
        type: "success",
        text: `🚀 Dispatched ${robots.find(r => r.id === Number(selectedRobot))?.robot_name} → ${drains.find(d => d.id === Number(selectedDrain))?.location}`
      });

      setSelectedRobot("");
      setSelectedDrain("");
      loadAll();
    } catch (err) {
      setMessage({ type: "error", text: err.response?.data?.error || "Dispatch failed" });
    } finally {
      setDispatching(false);
    }
  };

  const idleRobots = robots.filter((r) => r.status !== "Charging");

  return (
    <div className="page-section">

      <h2>🎯 Mission Control</h2>

      {message && (
        <div className={`status-msg ${message.type}`}>
          {message.text}
        </div>
      )}

      <div className="panel-grid">

        <div className="panel-card">

          <h2>🚀 Dispatch Robot</h2>

          <p>Manually assign a robot to a drain zone</p>

          <div className="dispatch-form">

            <div className="form-group">
              <label>
                <FaRobot /> Robot
              </label>
              <select
                value={selectedRobot}
                onChange={(e) => setSelectedRobot(e.target.value)}
              >
                <option value="">Select robot...</option>
                {robots.map((robot) => (
                  <option key={robot.id} value={robot.id}>
                    {robot.robot_name} — {robot.status} ({robot.battery_level}%)
                  </option>
                ))}
              </select>
            </div>

            <div className="form-group">
              <label>
                <FaMapMarkerAlt /> Drain
              </label>
              <select
                value={selectedDrain}
                onChange={(e) => setSelectedDrain(e.target.value)}
              >
                <option value="">Select drain...</option>
                {drains.map((drain) => (
                  <option key={drain.id} value={drain.id}>
                    {drain.zone_name} — {drain.location} ({drain.status})
                  </option>
                ))}
              </select>
            </div>

            <button
              className="btn btn-primary"
              onClick={dispatch}
              disabled={dispatching}
            >
              <FaPaperPlane /> {dispatching ? "Dispatching..." : "Dispatch"}
            </button>

          </div>

          <div className="form-group" style={{ marginTop: 18 }}>
            <label>Available Robots</label>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {idleRobots.map((robot) => (
                <span
                  key={robot.id}
                  className={`role-badge ${robot.battery_level <= 20 ? "role-admin" : "role-operator"}`}
                >
                  <FaBatteryHalf /> {robot.robot_name} ({robot.battery_level}%)
                </span>
              ))}
            </div>
          </div>

        </div>

        <div className="panel-card">

          <h2>
            <FaClipboardList /> Live Missions
          </h2>

          {missions.length === 0 ? (
            <div className="empty-state">No missions yet</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Robot</th>
                  <th>Drain</th>
                  <th>Status</th>
                  <th>Progress</th>
                </tr>
              </thead>
              <tbody>
                {missions.map((mission) => (
                  <tr key={mission.id}>
                    <td>{mission.robot_name}</td>
                    <td>
                      {mission.zone_name} — {mission.location}
                    </td>
                    <td>
                      <span className={`mission-status ${mission.mission_status}`}>
                        {mission.mission_status}
                      </span>
                    </td>
                    <td>
                      <div className="progress-track">
                        <div
                          className="progress-fill-mini"
                          style={{
                            width: `${mission.progress}%`,
                            background: mission.progress === 100 ? "#16a34a" : "#2563eb"
                          }}
                        />
                      </div>
                      {" "}{mission.progress}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

        </div>

      </div>

      <div className="panel-card">

        <h2>
          <FaHistory /> Mission History Log
        </h2>

        {history.length === 0 ? (
          <div className="empty-state">No completed missions yet</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Robot</th>
                <th>Zone</th>
                <th>Status</th>
                <th>Assigned</th>
                <th>Completed</th>
                <th>Duration</th>
              </tr>
            </thead>
            <tbody>
              {history.map((mission) => (
                <tr key={mission.id}>
                  <td>{mission.robot_name}</td>
                  <td>
                    {mission.zone_name} — {mission.location}
                  </td>
                  <td>
                    <span className={`mission-status ${mission.mission_status}`}>
                      {mission.mission_status}
                    </span>
                  </td>
                  <td>{new Date(mission.assigned_time).toLocaleString()}</td>
                  <td>{mission.completed_time ? new Date(mission.completed_time).toLocaleString() : "—"}</td>
                  <td className="duration-text">
                    {mission.duration_seconds
                      ? `${Math.round(mission.duration_seconds / 60)} min`
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

      </div>

    </div>
  );
}

export default MissionControl;