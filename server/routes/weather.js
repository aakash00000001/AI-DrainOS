const express = require("express");
const router = express.Router();
const axios = require("axios");

router.get("/", async (req, res) => {

  try {

    const city = "Madurai";

    const response = await axios.get(
      `https://api.openweathermap.org/data/2.5/weather?q=${city}&units=metric&appid=${process.env.OPENWEATHER_API_KEY}`
    );

    res.json(response.data);

  } catch (err) {

    console.log("========== WEATHER ERROR ==========");
    console.log(err.response?.data);
    console.log(err.message);
    console.log("===================================");

    res.status(500).json({
      error: err.response?.data || err.message
    });

  }

}); // <-- THIS WAS MISSING

module.exports = router;