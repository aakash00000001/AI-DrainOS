const express = require("express");
const router = express.Router();
const axios = require("axios");
const config = require("../config/env");
const logger = require("../config/logger");

router.get("/", async (req, res) => {
  try {
    if (!config.openWeatherApiKey) {
      return res.status(503).json({
        error: {
          code: "WEATHER_UNAVAILABLE",
          message: "Weather service is not configured (OPENWEATHER_API_KEY missing)"
        }
      });
    }

    const city = req.query.city || config.weatherCity;

    const response = await axios.get(
      "https://api.openweathermap.org/data/2.5/weather",
      {
        params: {
          q: city,
          units: "metric",
          appid: config.openWeatherApiKey
        },
        timeout: 10000
      }
    );

    res.json(response.data);

  } catch (err) {
    logger.error("Weather upstream error", {
      message: err.message,
      status: err.response?.status
    });

    const status = err.response && err.response.status >= 400 && err.response.status < 500
      ? 502
      : 503;

    res.status(status).json({
      error: {
        code: "WEATHER_UNAVAILABLE",
        message: status === 503
          ? "Weather service is temporarily unavailable"
          : "Could not fetch weather for the requested location"
      }
    });
  }
});

module.exports = router;