import { useEffect, useState } from "react";
import axios from "axios";
import {
  FaRobot,
  FaBatteryThreeQuarters,
  FaMapMarkerAlt,
  FaNetworkWired
} from "react-icons/fa";
import { API_URL } from "../services/api";
import { getMissionCoordination } from "../services/missionCoordinationService";

function RobotSimulation() {

  const [robots, setRobots] = useState([]);
  const [coordinationByRobot, setCoordinationByRobot] = useState({});
  const [coordinationStatus, setCoordinationStatus] = useState(null);

  const loadRobots = async () => {

    try {

      const response = await axios.get(`${API_URL}/robots`);

      setRobots(response.data);

    } catch (error) {

      console.log(error);

    }

  };

  // Mission coordination overlay (Update #22) — additive + advisory.
  // Best-effort: a failed endpoint leaves robots without coordination
  // badges instead of breaking fleet monitoring.
  const loadCoordination = async () => {

    try {

      const payload = await getMissionCoordination();

      const byRobot = payload && payload.robot_availability ? payload.robot_availability : [];

      const map = {};

      for (const item of byRobot) {

        map[Number(item.robot_id)] = { ...item, planned_drain_id: null, planned_route_mode: null };

      }

      const assignments = payload && payload.assignments ? payload.assignments : [];

      for (const assignment of assignments) {

        const key = Number(assignment.robot_id);

        if (map[key]) {

          map[key] = {
            ...map[key],
            planned_drain_id: assignment.drain_id,
            planned_route_mode: assignment.route_mode,
            planned_task_id: assignment.task_id
          };

        }

      }

      setCoordinationByRobot(map);
      setCoordinationStatus(payload ? payload.status : null);

    } catch (error) {

      console.log("Mission coordination overlay error:", error);

    }

  };

  useEffect(() => {

    loadRobots();
    loadCoordination();

    const interval = setInterval(() => {

      loadRobots();
      loadCoordination();

    }, 5000);

    return () => clearInterval(interval);

  }, []);

  return (

    <div className="robot-card">

      <div className="card-header">
        <h2>🤖 Robot Fleet Monitoring</h2>
      </div>

      <div className="robot-list">

        {robots.map((robot) => (

          <div
            className="robot-item"
            key={robot.id}
          >

            <div className="robot-top">

              <FaRobot className="robot-icon" />

              <div>

                <h3>{robot.robot_name}</h3>

                <p>{robot.assigned_zone || "No Zone Assigned"}</p>

              </div>

            </div>

            <div className="robot-middle">

              <span
                className={
                  robot.status === "Active"
                    ? "status active"
                    : robot.status === "Charging"
                    ? "status charging"
                    : "status maintenance"
                }
              >
                {robot.status}
              </span>

            </div>

            <div className="battery">

              <FaBatteryThreeQuarters />

              <span>{robot.battery_level}%</span>

            </div>

            <div className="progress">

              <div
                className="progress-fill"
                style={{
                  width: `${robot.battery_level}%`,
                  background:
                    robot.battery_level > 70
                      ? "#22c55e"
                      : robot.battery_level > 30
                      ? "#f59e0b"
                      : "#ef4444"
                }}
              ></div>

            </div>

            <br />

            <p>
              <FaMapMarkerAlt /> {robot.latitude}, {robot.longitude}
            </p>

            {coordinationByRobot[Number(robot.id)] && (
              <p
                className="robot-coordination"
                style={{ color: "#7c3aed", fontSize: "0.8rem", fontWeight: 600 }}
              >
                <FaNetworkWired />{" "}
                {coordinationByRobot[Number(robot.id)].availability_state}
                {coordinationByRobot[Number(robot.id)].planned_drain_id != null
                  ? ` → drain ${coordinationByRobot[Number(robot.id)].planned_drain_id}`
                  : coordinationByRobot[Number(robot.id)].target_drain_id != null
                    ? ` → drain ${coordinationByRobot[Number(robot.id)].target_drain_id}`
                    : ""}
                {coordinationStatus ? ` · ${coordinationStatus}` : ""}
              </p>
            )}

          </div>

        ))}

      </div>

    </div>

  );

}

export default RobotSimulation;