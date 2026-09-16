const express = require("express");
const router = express.Router();
const pool = require("../config/db");

router.get("/", async (req, res) => {
  try {
    const totalDrains = await pool.query("SELECT COUNT(*) FROM drains");

    const activeRobots = await pool.query(
      "SELECT COUNT(*) FROM robots WHERE status = 'Active'"
    );

    const criticalAlerts = await pool.query(
      "SELECT COUNT(*) FROM alerts WHERE severity = 'Critical'"
    );

    res.json({
      totalDrains: Number(totalDrains.rows[0].count),
      activeRobots: Number(activeRobots.rows[0].count),
      criticalAlerts: Number(criticalAlerts.rows[0].count),
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server Error" });
  }
});

module.exports = router;