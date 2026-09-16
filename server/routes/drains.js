const express = require("express");
const router = express.Router();

const pool = require("../config/db");

const { authMiddleware } = require("../middleware/auth");

const VALID_STATUSES = ["Normal", "Warning", "Critical"];

// ==========================
// GET - All Drains
// ==========================
router.get("/", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM drains ORDER BY id ASC"
    );

    res.json(result.rows);

  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
});

// ==========================
// GET - Single Drain by ID
// ==========================
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      "SELECT * FROM drains WHERE id = $1",
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Drain not found" });
    }

    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================
// POST - Add New Drain (auth)
// ==========================
router.post("/", authMiddleware, async (req, res) => {
  try {

    const {
      zone_name,
      location,
      status,
      blockage_level,
      latitude,
      longitude
    } = req.body;

    const result = await pool.query(
      `INSERT INTO drains
      (zone_name, location, status, blockage_level, latitude, longitude)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *`,
      [
        zone_name,
        location,
        status,
        blockage_level,
        latitude,
        longitude
      ]
    );

    res.status(201).json(result.rows[0]);

  } catch (error) {

    res.status(500).json({
      error: error.message
    });

  }
});
// ==========================
// PUT - Update Drain (auth)
// ==========================
router.put("/:id", authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;

    const {
      zone_name,
      location,
      status,
      blockage_level,
      latitude,
      longitude
    } = req.body;

    const result = await pool.query(
      `UPDATE drains
       SET
         zone_name = $1,
         location = $2,
         status = $3,
         blockage_level = $4,
         latitude = $5,
         longitude = $6
       WHERE id = $7
       RETURNING *`,
      [
        zone_name,
        location,
        status,
        blockage_level,
        latitude,
        longitude,
        id
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        message: "Drain not found"
      });
    }

    if (status === "Normal") {
      await pool.query(
        `
        UPDATE alerts
        SET alert_status = 'Resolved'
        WHERE drain_id = $1
          AND alert_status = 'Open'
        `,
        [id]
      );
    }

    res.json(result.rows[0]);

  } catch (error) {

    res.status(500).json({
      error: error.message
    });

  }
});
// ==========================
// PATCH - Quick status change (auth)
// Used for manual "flag Critical" / "clear"
// ==========================
router.patch("/:id/status", authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!VALID_STATUSES.includes(status)) {
      return res.status(400).json({
        error: "status must be Normal, Warning or Critical"
      });
    }

    const result = await pool.query(
      `
      UPDATE drains
      SET status = $1
      WHERE id = $2
      RETURNING *
      `,
      [status, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Drain not found" });
    }

    if (status === "Normal") {
      await pool.query(
        `
        UPDATE alerts
        SET alert_status = 'Resolved'
        WHERE drain_id = $1
          AND alert_status = 'Open'
        `,
        [id]
      );
    }

    res.json({
      message: `Drain status set to ${status}`,
      drain: result.rows[0]
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================
// DELETE - Remove Drain (auth)
// ==========================
router.delete("/:id", authMiddleware, async (req, res) => {
  try {

    const { id } = req.params;

    await pool.query(
  "DELETE FROM alerts WHERE drain_id = $1",
  [id]
);

const result = await pool.query(
  "DELETE FROM drains WHERE id = $1 RETURNING *",
  [id]
);

    if (result.rows.length === 0) {
      return res.status(404).json({
        message: "Drain not found"
      });
    }

    res.json({
      message: "Drain Deleted Successfully",
      drain: result.rows[0]
    });

  } catch (error) {

    res.status(500).json({
      error: error.message
    });

  }
});
module.exports = router;