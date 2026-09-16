const express = require("express");
const router = express.Router();

const pool = require("../config/db");

const { authMiddleware } = require("../middleware/auth");
const { dispatchMission } = require("../services/missionEngine");

// --------------------------------------------------
// GET - All missions (current + recent)
// --------------------------------------------------

router.get("/", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        m.id,
        r.robot_name,
        d.zone_name,
        d.location,
        m.mission_status,
        m.progress,
        m.assigned_time,
        m.completed_time
      FROM missions m
      JOIN robots r
        ON m.robot_id = r.id
      JOIN drains d
        ON m.drain_id = d.id
      ORDER BY m.assigned_time DESC
      LIMIT 50
    `);

    res.json(result.rows);

  } catch (err) {
    console.log(err);
    res.status(500).json({ error: "Server Error" });
  }
});

// --------------------------------------------------
// GET /history - Mission history with filters
//   ?robot_id=2 &status=Completed
// --------------------------------------------------

router.get("/history", async (req, res) => {
  try {
    const { robot_id, status } = req.query;

    const conditions = ["m.mission_status = 'Completed'"];
    const params = [];

    if (robot_id) {
      params.push(robot_id);
      conditions.push(`m.robot_id = $${params.length}`);
    }

    if (status && ["Assigned", "Completed", "Cancelled"].includes(status)) {
      params.push(status);
      conditions.push(`m.mission_status = $${params.length}`);
    }

    const where = conditions.join(" AND ");

    const result = await pool.query(
      `
      SELECT
        m.id,
        r.robot_name,
        d.zone_name,
        d.location,
        m.mission_status,
        m.progress,
        m.assigned_time,
        m.completed_time,
        EXTRACT(EPOCH FROM (m.completed_time - m.assigned_time)) AS duration_seconds
      FROM missions m
      JOIN robots r
        ON m.robot_id = r.id
      JOIN drains d
        ON m.drain_id = d.id
      WHERE ${where}
      ORDER BY m.completed_time DESC
      LIMIT 200
      `,
      params
    );

    res.json(result.rows);

  } catch (err) {
    console.log(err);
    res.status(500).json({ error: "Server Error" });
  }
});

// --------------------------------------------------
// POST /dispatch - Manually dispatch a robot (auth)
//   body: { robot_id, drain_id }
// --------------------------------------------------

router.post("/dispatch", authMiddleware, async (req, res) => {
  try {
    const { robot_id, drain_id } = req.body;

    if (!robot_id || !drain_id) {
      return res.status(400).json({
        error: "robot_id and drain_id are required"
      });
    }

    const result = await dispatchMission(Number(robot_id), Number(drain_id));

    res.status(201).json({
      message: "Mission dispatched successfully",
      mission: result.mission
    });

  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
