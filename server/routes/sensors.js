const express = require("express");
const router = express.Router();

const pool = require("../config/db");


// Get all sensors
router.get("/", async (req, res) => {

    try {

        const result = await pool.query(
            `
            SELECT
            sensors.id,
            sensors.water_level,
            sensors.gas_level,
            sensors.temperature,
            sensors.status,
            drains.zone_name,
            drains.location

            FROM sensors

            JOIN drains
            ON sensors.drain_id = drains.id

            ORDER BY sensors.id ASC
            `
        );


        res.json(result.rows);


    } catch(error) {

        res.status(500).json({
            error: error.message
        });

    }

});


module.exports = router;