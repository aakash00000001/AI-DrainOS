import { useEffect, useState } from "react";
import axios from "axios";
import {
  FaRobot,
  FaBatteryThreeQuarters,
  FaMapMarkerAlt
} from "react-icons/fa";
import { API_URL } from "../services/api";

function RobotSimulation() {

  const [robots, setRobots] = useState([]);

  const loadRobots = async () => {

    try {

      const response = await axios.get(`${API_URL}/robots`);

      setRobots(response.data);

    } catch (error) {

      console.log(error);

    }

  };

  useEffect(() => {

    loadRobots();

    const interval = setInterval(loadRobots, 5000);

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

          </div>

        ))}

      </div>

    </div>

  );

}

export default RobotSimulation;