import { useEffect, useState } from "react";
import axios from "axios";
import { API_URL } from "../services/api";

function WeatherMonitor() {

  const [weather, setWeather] = useState(null);

  const loadWeather = () => {

    axios
      .get(`${API_URL}/weather`)
      .then((response) => {

        setWeather(response.data);

      })
      .catch((error) => {

        console.log(error);

      });

  };

  useEffect(() => {

    loadWeather();

    const interval = setInterval(loadWeather, 600000); // 10 minutes

    return () => clearInterval(interval);

  }, []);

  if (!weather) {

    return (

      <div className="weather-box">

        Loading Weather...

      </div>

    );

  }

  return (

    <div className="weather-box">

      <h2>🌦 Live Weather</h2>

      <h3>{weather.name}</h3>

      <p>

        🌡 Temperature :
        <strong> {weather.main.temp} °C</strong>

      </p>

      <p>

        🤒 Feels Like :
        <strong> {weather.main.feels_like} °C</strong>

      </p>

      <p>

        💧 Humidity :
        <strong> {weather.main.humidity}%</strong>

      </p>

      <p>

        🌬 Wind :
        <strong> {weather.wind.speed} m/s</strong>

      </p>

      <p>

        ☁ Condition :
        <strong> {weather.weather[0].description}</strong>

      </p>

      <p>

        📊 Pressure :
        <strong> {weather.main.pressure} hPa</strong>

      </p>

    </div>

  );

}

export default WeatherMonitor;