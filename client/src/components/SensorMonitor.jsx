import { useEffect, useState } from "react";
import axios from "axios";
import socket from "../services/socket";
import { API_URL } from "../services/api";

function SensorMonitor() {

  const [sensors, setSensors] = useState([]);
  const [live, setLive] = useState({});

  const loadSensors = () => {

    axios
      .get(`${API_URL}/sensors`)
      .then((response) => {

        setSensors(response.data);

      })
      .catch((error) => {

        console.log(error);

      });

  };

  useEffect(() => {

    loadSensors();

    const interval = setInterval(loadSensors, 5000);

    return () => clearInterval(interval);

  }, []);

  useEffect(() => {

    const onSensorUpdate = (data) => {

      setLive((prev) => ({
        ...prev,
        [data.sensorId]: {
          ...data,
          receivedAt: new Date()
        }
      }));

    };

    socket.on("sensorUpdate", onSensorUpdate);

    return () => socket.off("sensorUpdate", onSensorUpdate);

  }, []);

  return (

    <div className="sensor-box">

      <h2>📡 Live Sensor Monitor</h2>

      {sensors.length === 0 && (

        <div className="empty-state">
          No sensor data yet - run the sensor simulator: npm run simulate
        </div>

      )}

      {

        sensors.map((sensor) => {

          const liveUpdate = live[sensor.id];

          const predictionColor = {
            HIGH: "#dc2626",
            MEDIUM: "#d97706",
            LOW: "#16a34a"
          }[liveUpdate?.prediction];

          return (

          <div
            key={sensor.id}
            className="sensor-data"
          >

            <h3>
              {sensor.zone_name}
              {liveUpdate && " ⚡"}
            </h3>

            <p>
              🌊 Water Level :
              <strong> {liveUpdate ? liveUpdate.water_level : sensor.water_level}%</strong>
            </p>

            <p>
              💨 Gas Level :
              <strong> {liveUpdate ? liveUpdate.gas_level : sensor.gas_level} ppm</strong>
            </p>

            <p>
              🌡 Temperature :
              <strong> {liveUpdate ? liveUpdate.temperature : sensor.temperature}°C</strong>
            </p>

            <p>
              📍 Location :
              <strong> {sensor.location}</strong>
            </p>

            <p>
              🚨 Status :
              <strong className={sensor.status.toLowerCase()}>
                {sensor.status}
              </strong>
            </p>

            {liveUpdate?.prediction && (
              <p>
                🤖 AI Prediction :
                <strong style={{ color: predictionColor }}>
                  {" "}{liveUpdate.prediction}
                </strong>
              </p>
            )}

            {liveUpdate?.riskScore !== undefined && liveUpdate?.riskScore !== null && (
              <p>
                🌊 Flood Risk :
                <strong
                  style={{
                    color: {
                      LOW: "#16a34a",
                      MODERATE: "#d97706",
                      HIGH: "#ea580c",
                      CRITICAL: "#dc2626"
                    }[liveUpdate.riskLevel] || "#0f172a"
                  }}
                >
                  {" "}{liveUpdate.riskScore}/100 ({liveUpdate.riskLevel})
                  {liveUpdate.riskTrend ? ` · ${liveUpdate.riskTrend}` : ""}
                </strong>
              </p>
            )}

            {liveUpdate?.forecast60Level && (
              <p>
                🔮 60-min Forecast :
                <strong
                  style={{
                    color: {
                      LOW: "#16a34a",
                      MODERATE: "#d97706",
                      HIGH: "#ea580c",
                      CRITICAL: "#dc2626"
                    }[liveUpdate.forecast60Level] || "#0f172a"
                  }}
                >
                  {" "}{liveUpdate.forecast60Score}/100 ({liveUpdate.forecast60Level})
                  {liveUpdate.forecastTrendDirection
                    ? ` · ${liveUpdate.forecastTrendDirection
                        .toLowerCase()
                        .replace(/_/g, " ")}`
                    : ""}
                </strong>
              </p>
            )}

            {liveUpdate && (
              <p>
                🕒 Last Updated :
                <strong> {liveUpdate.receivedAt.toLocaleTimeString()}</strong>
              </p>
            )}

            <hr />

          </div>

          );

        })

      }

    </div>

  );

}

export default SensorMonitor;