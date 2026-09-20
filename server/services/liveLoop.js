// ============================================================
// liveLoop.js
//
// Update #25 - Live system loop extracted from index.js into a
// testable service with:
//   - failure isolation (a failed step can never kill the loop)
//   - overlap guard (a slow tick is never overlapped; the next
//     tick is skipped if the previous one is still running)
//
// The step ORDER and the missionEngine authority are preserved
// exactly as before - missionEngine.assignMission() still runs
// first, still dispatches robots for critical drains, and nothing
// here grants any other service dispatch authority.
// ============================================================

const logger = require("../config/logger");
const { assignMission } = require("./missionEngine");
const incidentService = require("./incidentService");
const fleetOptimizationService = require("./fleetOptimizationService");
const missionCoordinatorService = require("./missionCoordinatorService");
const sensorIntelligenceService = require("./sensorIntelligenceService");
const weatherFloodCorrelationService = require("./weatherFloodCorrelationService");
const decisionAuditService = require("./decisionAuditService");

// Builds the 15-step tick used by the live loop. Accepts explicit deps so
// tests can stub any step (see tests/hardening.test.js).
function createTickRunner({ io, pool, mission = assignMission } = {}) {
  let lastCriticalAlertId = 0;
  const emit = io && typeof io.emit === "function"
    ? io.emit.bind(io)
    : () => {};

  return async function runTick() {
    // ==================================================
    // 1. ASSIGN CRITICAL DRAIN MISSION
    // ==================================================

    await mission();

    // ==================================================
    // 2. BATTERY DRAIN
    // ==================================================

    await pool.query(`
      UPDATE robots
      SET battery_level = GREATEST(battery_level - 1, 0)
      WHERE
        status = 'Active'
        AND battery_level > 0
    `);

    // ==================================================
    // 3. LOW BATTERY → CHARGING STATION
    // ==================================================

    const lowBatteryRobots = await pool.query(`
      SELECT *
      FROM robots
      WHERE
        battery_level <= 20
        AND target_latitude IS NULL
        AND target_longitude IS NULL
        AND status IN ('Active', 'Idle')
    `);

    for (const robot of lowBatteryRobots.rows) {
      const stationResult = await pool.query(`
        SELECT *
        FROM charging_stations
      `);

      if (stationResult.rows.length === 0) {
        logger.warn("No charging station found");
        continue;
      }

      let chargingStation = stationResult.rows[0];
      let shortestDistance = Number.MAX_VALUE;

      stationResult.rows.forEach((station) => {
        const distance =
          Math.pow(Number(station.latitude) - Number(robot.latitude), 2) +
          Math.pow(Number(station.longitude) - Number(robot.longitude), 2);

        if (distance < shortestDistance) {
          shortestDistance = distance;
          chargingStation = station;
        }
      });

      await pool.query(
        `
        UPDATE robots
        SET
          status = 'Charging',
          target_latitude = $1,
          target_longitude = $2
        WHERE id = $3
        `,
        [
          chargingStation.latitude,
          chargingStation.longitude,
          robot.id,
        ]
      );

      emit("batteryLow", {
        id: robot.id,
        robot_name: robot.robot_name,
        battery_level: robot.battery_level,
        status: "Charging",
        station: chargingStation.station_name,
      });

      logger.info(`${robot.robot_name} going to ${chargingStation.station_name}`);
    }

    // ==================================================
    // 4. CHARGING BATTERY
    // ==================================================

    const chargingRobots = await pool.query(`
      SELECT *
      FROM robots
      WHERE
        status = 'Charging'
        AND battery_level < 100
        AND target_latitude IS NULL
        AND target_longitude IS NULL
    `);

    if (chargingRobots.rows.length > 0) {
      await pool.query(`
        UPDATE robots
        SET battery_level = LEAST(battery_level + 2, 100)
        WHERE
          status = 'Charging'
          AND battery_level < 100
          AND target_latitude IS NULL
          AND target_longitude IS NULL
      `);

      for (const robot of chargingRobots.rows) {
        const newBattery = Math.min(
          Number(robot.battery_level) + 2,
          100
        );

        logger.info(`${robot.robot_name} charging... ${newBattery}%`);
      }
    }

    // ==================================================
    // 5. CHARGING COMPLETE
    // ==================================================

    const completedCharging = await pool.query(`
      SELECT *
      FROM robots
      WHERE
        status = 'Charging'
        AND battery_level >= 100
        AND target_latitude IS NULL
        AND target_longitude IS NULL
    `);

    for (const robot of completedCharging.rows) {
      await pool.query(
        `
        UPDATE robots
        SET
          status = 'Idle',
          battery_level = 100
        WHERE id = $1
        `,
        [robot.id]
      );

      logger.info(`${robot.robot_name} fully charged and now Idle`);
    }

    // ==================================================
    // 6. ROBOT MOVEMENT
    // ==================================================

    const robots = await pool.query(`
      SELECT *
      FROM robots
      WHERE
        target_latitude IS NOT NULL
        AND target_longitude IS NOT NULL
    `);

    for (const robot of robots.rows) {
      const lat = Number(robot.latitude);
      const lng = Number(robot.longitude);

      const targetLat = Number(robot.target_latitude);
      const targetLng = Number(robot.target_longitude);

      const step = 0.00005;

      let newLat = lat;
      let newLng = lng;

      // ----------------------------------------------
      // Latitude movement
      // ----------------------------------------------

      if (Math.abs(targetLat - lat) > step) {
        newLat += targetLat > lat ? step : -step;
      } else {
        newLat = targetLat;
      }

      // ----------------------------------------------
      // Longitude movement
      // ----------------------------------------------

      if (Math.abs(targetLng - lng) > step) {
        newLng += targetLng > lng ? step : -step;
      } else {
        newLng = targetLng;
      }

      // ----------------------------------------------
      // Update robot location
      // ----------------------------------------------

      await pool.query(
        `
        UPDATE robots
        SET
          latitude = $1,
          longitude = $2
        WHERE id = $3
        `,
        [
          newLat,
          newLng,
          robot.id,
        ]
      );

      // ==================================================
      // 7. DESTINATION REACHED
      // ==================================================

      if (
        Math.abs(targetLat - newLat) < 0.00001 &&
        Math.abs(targetLng - newLng) < 0.00001
      ) {

        // ----------------------------------------------
        // Charging station reached
        // ----------------------------------------------

        if (robot.status === "Charging") {
          await pool.query(
            `
            UPDATE robots
            SET
              target_latitude = NULL,
              target_longitude = NULL
            WHERE id = $1
            `,
            [robot.id]
          );

          logger.info(`${robot.robot_name} reached charging station`);

          continue;
        }

        // ----------------------------------------------
        // Mission destination reached
        // ----------------------------------------------

        logger.info(`${robot.robot_name} reached destination`);

        // Find only currently assigned mission
        const mission = await pool.query(
          `
          SELECT *
          FROM missions
          WHERE
            robot_id = $1
            AND mission_status = 'Assigned'
          ORDER BY id DESC
          LIMIT 1
          `,
          [robot.id]
        );

        if (mission.rows.length === 0) {
          // No mission → simply clear target
          await pool.query(
            `
            UPDATE robots
            SET
              target_latitude = NULL,
              target_longitude = NULL
            WHERE id = $1
            `,
            [robot.id]
          );

          continue;
        }

        logger.info("Mission Found:", { mission: mission.rows });

        const missionData = mission.rows[0];

        // ----------------------------------------------
        // Drain → Normal
        // ----------------------------------------------

        await pool.query(
          `
          UPDATE drains
          SET status = 'Normal'
          WHERE id = $1
          `,
          [missionData.drain_id]
        );

        await pool.query(
          `
          UPDATE alerts
          SET alert_status = 'Resolved'
          WHERE drain_id = $1
            AND alert_status = 'Open'
          `,
          [missionData.drain_id]
        );

        // ----------------------------------------------
        // Mission → Completed
        // ----------------------------------------------

        await pool.query(
          `
          UPDATE missions
          SET
            mission_status = 'Completed',
            progress = 100,
            completed_time = NOW()
          WHERE id = $1
          `,
          [missionData.id]
        );

        // ----------------------------------------------
        // Robot reset
        // ----------------------------------------------

        await pool.query(
          `
          UPDATE robots
          SET
            status = 'Idle',
            target_latitude = NULL,
            target_longitude = NULL
          WHERE id = $1
          `,
          [robot.id]
        );

        logger.info(`${robot.robot_name} completed mission`);

        // ----------------------------------------------
        // Frontend notification
        // ----------------------------------------------

        const drainInfo = await pool.query(
          `
          SELECT location
          FROM drains
          WHERE id = $1
          `,
          [missionData.drain_id]
        );

        emit("drainCleaned", {
          robot: robot.robot_name,
          zone:
            drainInfo.rows.length > 0
              ? drainInfo.rows[0].location
              : `Drain ${missionData.drain_id}`,
        });

        continue;
      }

      // ==================================================
      // 8. MISSION PROGRESS
      // ==================================================

      const assignedMission = await pool.query(
        `
        SELECT *
        FROM missions
        WHERE
          robot_id = $1
          AND mission_status = 'Assigned'
        ORDER BY id DESC
        LIMIT 1
        `,
        [robot.id]
      );

      if (assignedMission.rows.length > 0) {
        const totalDistance = Math.sqrt(
          Math.pow(targetLat - lat, 2) +
          Math.pow(targetLng - lng, 2)
        );

        const remainingDistance = Math.sqrt(
          Math.pow(targetLat - newLat, 2) +
          Math.pow(targetLng - newLng, 2)
        );

        let progress = 0;

        if (totalDistance > 0) {
          progress = Math.round(
            ((totalDistance - remainingDistance) /
              totalDistance) *
              100
          );
        }

        progress = Math.max(
          0,
          Math.min(100, progress)
        );

        await pool.query(
          `
          UPDATE missions
          SET progress = $1
          WHERE
            id = $2
            AND mission_status = 'Assigned'
          `,
          [
            progress,
            assignedMission.rows[0].id,
          ]
        );
      }
    }

    // ==================================================
    // 9. CRITICAL ALERT
    // ==================================================

    const alert = await pool.query(`
      SELECT
        a.id,
        a.alert_type,
        a.message,
        a.severity,
        d.location
      FROM alerts a
      JOIN drains d
        ON a.drain_id = d.id
      WHERE
        a.severity = 'Critical'
      ORDER BY a.id DESC
      LIMIT 1
    `);

    if (alert.rows.length > 0) {
      const latest = alert.rows[0];

      if (latest.id > lastCriticalAlertId) {
        lastCriticalAlertId = latest.id;
        emit("criticalAlert", latest);
      }
    }

    // ==================================================
    // 10. DASHBOARD
    // ==================================================

    const totalDrains = await pool.query(
      `
      SELECT COUNT(*)
      FROM drains
      `
    );

    const activeRobots = await pool.query(
      `
      SELECT COUNT(*)
      FROM robots
      WHERE status = 'Active'
      `
    );

    const criticalAlerts = await pool.query(
      `
      SELECT COUNT(*)
      FROM alerts
      WHERE severity = 'Critical'
      `
    );

    // Additive emergency/incident counts on the shared dashboard
    // event. Best-effort: the live loop must never break if the
    // incidents table is unavailable.
    let incidentCounts = null;

    try {
      const incidentSummary = await incidentService.getDashboardSummary();
      incidentCounts = incidentSummary.counts;
    } catch (incidentErr) {
      logger.warn("dashboardUpdate incident counts skipped", { message: incidentErr.message });
    }

    emit("dashboardUpdate", {
      totalDrains: Number(
        totalDrains.rows[0].count
      ),

      activeRobots: Number(
        activeRobots.rows[0].count
      ),

      criticalAlerts: Number(
        criticalAlerts.rows[0].count
      ),

      ...(incidentCounts ? { incidents: { counts: incidentCounts } } : {})
    });

    // ==================================================
    // 11. FLEET OPTIMIZATION (advisory)
    // ==================================================
    // Recomputes fleet recommendations and emits
    // `fleetOptimizationUpdate` ONLY when the recommendation-relevant
    // state actually changed (signature-guarded inside the service).
    // Best-effort: the live loop must never break here.

    try {
      await fleetOptimizationService.evaluateAndEmitFleetOptimization();
    } catch (fleetErr) {
      logger.warn("fleetOptimizationUpdate skipped", { message: fleetErr.message });
    }

    // ==================================================
    // 12. MISSION COORDINATION (advisory)
    // ==================================================
    // Computes multi-robot scheduling and emits
    // `missionCoordinationUpdate` ONLY when the coordination-relevant
    // state actually changed (signature-guarded inside the service).
    // Advisory: never dispatches from the live loop.

    try {
      await missionCoordinatorService.evaluateAndEmitMissionCoordination();
    } catch (coordErr) {
      logger.warn("missionCoordinationUpdate skipped", { message: coordErr.message });
    }

    // ==================================================
    // 13. SENSOR INTELLIGENCE (additive)
    // ==================================================

    try {
      await sensorIntelligenceService.evaluateAndEmitSensorIntelligence();
    } catch (sensorErr) {
      logger.warn("sensorIntelligenceUpdate skipped", { message: sensorErr.message });
    }

    // ==================================================
    // 14. WEATHER + FLOOD CORRELATION (additive)
    // ==================================================

    try {
      await weatherFloodCorrelationService.evaluateAndEmitWeatherCorrelation();
    } catch (weatherErr) {
      logger.warn("weatherFloodCorrelationUpdate skipped", { message: weatherErr.message });
    }

    // ==================================================
    // 15. DECISION AUDIT (explainer + append-only trail)
    // ==================================================

    try {
      await decisionAuditService.evaluateAndEmitDecisionAudit();
    } catch (auditErr) {
      logger.warn("decisionAuditUpdate skipped", { message: auditErr.message });
    }
  };
}

// Timer loop with an overlap guard: if a tick is still running when the
// interval fires, that firing is skipped instead of overlapping.
function createLiveLoop({ io, pool, tickIntervalMs = 5000 } = {}) {
  const runTick = createTickRunner({ io, pool });
  let timer = null;
  let ticking = false;
  let stopped = false;

  async function tickGuard() {
    if (ticking || stopped) return;
    ticking = true;
    try {
      await runTick();
    } catch (err) {
      logger.error("Live loop tick failed", { message: err.message });
    } finally {
      ticking = false;
    }
  }

  return {
    runTick,
    start() {
      if (timer) return;
      stopped = false;
      timer = setInterval(tickGuard, tickIntervalMs);
      if (timer.unref) timer.unref();
      logger.info("Live loop started", { tickIntervalMs });
    },
    stop() {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      logger.info("Live loop stopped");
    },
    isTicking() {
      return ticking;
    }
  };
}

module.exports = { createTickRunner, createLiveLoop };