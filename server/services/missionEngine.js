const pool = require("../config/db");

// --------------------------------------------------
// DISPATCH MISSION - assign a robot to a drain
// Used by both the auto mission engine and manual dispatch
// --------------------------------------------------

async function dispatchMission(robotId, drainId) {
  const [robotResult, drainResult] = await Promise.all([
    pool.query("SELECT * FROM robots WHERE id = $1", [robotId]),
    pool.query("SELECT * FROM drains WHERE id = $1", [drainId])
  ]);

  if (robotResult.rows.length === 0) {
    throw new Error("Robot not found");
  }

  if (drainResult.rows.length === 0) {
    throw new Error("Drain not found");
  }

  const robot = robotResult.rows[0];
  const drain = drainResult.rows[0];

  // Robot must be free
  const activeMission = await pool.query(
    `
    SELECT *
    FROM missions
    WHERE robot_id = $1 AND mission_status = 'Assigned'
    `,
    [robot.id]
  );

  if (activeMission.rows.length > 0) {
    throw new Error(`${robot.robot_name} already has an active mission`);
  }

  // Drain must not already have a mission assigned
  const drainMission = await pool.query(
    `
    SELECT *
    FROM missions
    WHERE drain_id = $1 AND mission_status = 'Assigned'
    `,
    [drain.id]
  );

  if (drainMission.rows.length > 0) {
    throw new Error(`${drain.location} already has a mission assigned`);
  }

  // Create mission
  const mission = await pool.query(
    `
    INSERT INTO missions (robot_id, drain_id, mission_status, progress)
    VALUES ($1, $2, 'Assigned', 0)
    RETURNING *
    `,
    [robot.id, drain.id]
  );

  // Assign target to robot
  await pool.query(
    `
    UPDATE robots
    SET
      status = 'Active',
      target_latitude = $1,
      target_longitude = $2
    WHERE id = $3
    `,
    [drain.latitude, drain.longitude, robot.id]
  );

  console.log("");
  console.log("🚨 MISSION DISPATCHED");
  console.log(`🤖 Robot: ${robot.robot_name}`);
  console.log(`🕳️ Drain: ${drain.location}`);
  console.log(`📋 Mission ID: ${mission.rows[0].id}`);
  console.log("");

  return {
    mission: mission.rows[0],
    robot,
    drain
  };
}

// --------------------------------------------------
// AUTO MISSION ENGINE - assign one Critical drain
// to the nearest available robot
// --------------------------------------------------

async function assignMission() {
  try {
    // 1. Find one Critical drain without an active mission
    const drainResult = await pool.query(`
      SELECT *
      FROM drains
      WHERE status = 'Critical'
      AND id NOT IN (
        SELECT drain_id
        FROM missions
        WHERE mission_status = 'Assigned'
      )
      ORDER BY id ASC
      LIMIT 1
    `);

    if (drainResult.rows.length === 0) {
      return null;
    }

    const drain = drainResult.rows[0];

    // 2. Find available robots
    const robotResult = await pool.query(`
      SELECT *
      FROM robots
      WHERE status IN ('Active', 'Idle')
      AND battery_level > 20
      AND target_latitude IS NULL
      AND target_longitude IS NULL
      AND id NOT IN (
        SELECT robot_id
        FROM missions
        WHERE mission_status = 'Assigned'
      )
      ORDER BY battery_level DESC
    `);

    if (robotResult.rows.length === 0) {
      console.log("⚠️ No available robot for Critical drain");
      return null;
    }

    // 3. Find nearest robot
    let nearestRobot = null;
    let shortestDistance = Number.MAX_VALUE;

    robotResult.rows.forEach((robot) => {
      const distance = Math.sqrt(
        Math.pow(Number(robot.latitude) - Number(drain.latitude), 2) +
        Math.pow(Number(robot.longitude) - Number(drain.longitude), 2)
      );

      if (distance < shortestDistance) {
        shortestDistance = distance;
        nearestRobot = robot;
      }
    });

    if (!nearestRobot) {
      return null;
    }

    // 4. Dispatch
    const result = await dispatchMission(nearestRobot.id, drain.id);

    console.log("🚨 NEW CRITICAL MISSION ASSIGNED (AUTO)");
    console.log("");

    return result;
  } catch (err) {
    console.log("========== MISSION ENGINE ERROR ==========");
    console.log(err.message);
    return null;
  }
}

module.exports = {
  assignMission,
  dispatchMission
};
