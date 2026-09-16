const express = require("express");
const router = express.Router();
const pool = require("../config/db");

router.get("/", async (req, res) => {

  try {

    const result = await pool.query(`
      SELECT
        id,
        robot_name,
        assigned_zone,
        latitude,
        longitude,
        battery_level,
        status,
        target_latitude,
        target_longitude,
        last_active
      FROM robots
      ORDER BY id ASC
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