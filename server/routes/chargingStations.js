const express = require("express");
const router = express.Router();
const pool = require("../config/db");

// Get all charging stations
router.get("/", async (req, res) => {

  try {

    const result = await pool.query(`
      SELECT *
      FROM charging_stations
      ORDER BY id
    `);

    res.json(result.rows);

  } catch (err) {

    console.log(err);

    res.status(500).json({
      error: "Server Error"
    });

  }

});

module.exports = router;