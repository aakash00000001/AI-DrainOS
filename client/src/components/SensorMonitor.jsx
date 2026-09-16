import { useEffect, useState } from "react";
import axios from "axios";
import { API_URL } from "../services/api";

function SensorMonitor() {

  const [sensors, setSensors] = useState([]);

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

  return (

    <div className="sensor-box">

      <h2>📡 Live Sensor Monitor</h2>

      {

        sensors.map((sensor) => (

          <div
            key={sensor.id}
            className="sensor-data"
          >

            <h3>{sensor.zone_name}</h3>

            <p>
              🌊 Water Level :
              <strong> {sensor.water_level}%</strong>
            </p>

            <p>
              💨 Gas Level :
              <strong> {sensor.gas_level} ppm</strong>
            </p>

            <p>
              🌡 Temperature :
              <strong> {sensor.temperature}°C</strong>
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

            <hr />

          </div>

        ))

      }

    </div>

  );

}

export default SensorMonitor;