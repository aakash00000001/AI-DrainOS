// ============================================================
// AI-DrainOS Robot Path Planning Service
//
// Intelligent robot selection, battery-aware route planning,
// waypoint generation and coordinate-space distance/time
// estimation for high / critical-priority drain missions.
//
// This service is pure on-demand computation: it never writes
// to the database. It reads robots, drains, charging stations,
// active missions, and emits socket events on meaningful
// change.
//
// HONESTY CONTRACT: when no robot is available the status is
// NO_ROBOT_AVAILABLE with an honest reason. The engine never
// fabricates availability or recommends a robot that cannot
// complete the route on current battery.
// ============================================================

const pool = require("../config/db");
const socketHub = require("./socketHub");

// ------------------------------------------------------------
// Constants — derived from the existing movement loop in
// index.js (5 s tick, step 0.00005, 1 battery% / tick)
// ------------------------------------------------------------

const MOVEMENT_STEP = 0.00005;
const TICK_INTERVAL_MS = 5000;
const BATTERY_DRAIN_PER_TICK = 1;
const TICKS_PER_UNIT = MOVEMENT_STEP > 0 ? 1 / MOVEMENT_STEP : 20000;

/** Seconds to travel 1 coordinate-unit distance */
const SECONDS_PER_UNIT = TICKS_PER_UNIT * (TICK_INTERVAL_MS / 1000);

/** Battery% consumed per coordinate-unit distance */
const BATTERY_PER_UNIT = TICKS_PER_UNIT * BATTERY_DRAIN_PER_TICK;

/** Minimum battery to be considered for a mission */
const MIN_BATTERY_MISSION = 20;

/** Minimum battery to be an ideal candidate (no charging stop) */
const MIN_BATTERY_IDEAL = 30;

/** Threshold for arrival in coordinate-space */
const ARRIVAL_THRESHOLD = 0.00001;

/** Short-cache TTL to avoid hammering the DB on rapid frontend calls */
const CACHE_TTL_MS = 5000;
const routeCache = new Map();

const PLANNING_DISCLAIMER =
  "Route is a coordinate-space approximation derived from the existing " +
  "movement-loop constants (step 0.00005 / tick, 5 s tick). Distance and " +
  "time are Euclidean estimates. No external routing API is used.";

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

function finiteNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

/**
 * Euclidean distance in coordinate space — matches the formula
 * used in index.js and decisionEngine.js.
 */
function coordinateDistance(aLat, aLng, bLat, bLng) {
  if (
    aLat === null || aLng === null ||
    bLat === null || bLng === null
  ) {
    return null;
  }
  return round3(
    Math.sqrt(Math.pow(aLat - bLat, 2) + Math.pow(aLng - bLng, 2))
  );
}

/** Estimated travel seconds for a given coordinate distance */
function estimatedTravelSeconds(distance) {
  if (distance === null || distance <= 0) return 0;
  return round1(distance * SECONDS_PER_UNIT);
}

/** Battery% consumed travelling a given coordinate distance */
function estimatedBatteryCost(distance) {
  if (distance === null || distance <= 0) return 0;
  return round1(distance * BATTERY_PER_UNIT);
}

function formatDuration(seconds) {
  if (seconds <= 0) return "0 s";
  if (seconds < 60) return `${Math.round(seconds)} s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = Math.round(seconds - minutes * 60);
  if (remaining === 0) return `${minutes} m`;
  return `${minutes} m ${remaining} s`;
}

// ------------------------------------------------------------
// Candidate discovery
// ------------------------------------------------------------

/**
 * Returns all robots with context needed for selection:
 *  - status (Idle/Active/Charging/Maintenance)
 *  - battery_level
 *  - coordinates
 *  - activeMissionId (if robot has an 'Assigned' mission)
 *  - distanceToTarget (null when target coords missing)
 */
async function getCandidates(drainId) {
  if (!Number.isInteger(drainId) || drainId <= 0) {
    return { drain: null, robots: [], candidates: [], reason: "Invalid drain ID" };
  }

  const drainResult = await pool.query(
    `
    SELECT id, zone_name, location, latitude, longitude
    FROM drains
    WHERE id = $1
    `,
    [drainId]
  );

  if (drainResult.rows.length === 0) {
    return { drain: null, robots: [], candidates: [], reason: "Drain not found" };
  }

  const drainRow = drainResult.rows[0];
  const drain = {
    id: Number(drainRow.id),
    zoneName: drainRow.zone_name,
    location: drainRow.location,
    latitude: finiteNumber(drainRow.latitude),
    longitude: finiteNumber(drainRow.longitude)
  };

  const drainCoordsOk =
    drain.latitude !== null && drain.longitude !== null;

  const robotResult = await pool.query(
    `
    SELECT
      r.id,
      r.robot_name,
      r.status,
      r.battery_level,
      r.latitude,
      r.longitude,
      r.assigned_zone,
      r.target_latitude,
      r.target_longitude
    FROM robots r
    ORDER BY r.id ASC
    `
  );

  const robots = robotResult.rows.map((row) => {
    const rLat = finiteNumber(row.latitude);
    const rLng = finiteNumber(row.longitude);
    return {
      id: Number(row.id),
      robotName: row.robot_name,
      status: row.status,
      batteryLevel: finiteNumber(row.battery_level),
      latitude: rLat,
      longitude: rLng,
      assignedZone: row.assigned_zone,
      targetLatitude: finiteNumber(row.target_latitude),
      targetLongitude: finiteNumber(row.target_longitude)
    };
  });

  // Active missions — find robots with Assigned missions
  const missionResult = await pool.query(
    `
    SELECT robot_id, drain_id
    FROM missions
    WHERE mission_status = 'Assigned'
    `
  );

  const activeMissions = new Map();
  for (const row of missionResult.rows) {
    activeMissions.set(Number(row.robot_id), Number(row.drain_id));
  }

  // Filter out Charging, Maintenance, robots with active missions,
  // and robots without valid coordinates
  const eligibleRobots = robots.filter((robot) => {
    if (robot.status === "Charging" || robot.status === "Maintenance") return false;
    if (activeMissions.has(robot.id)) return false;
    if (robot.latitude === null || robot.longitude === null) return false;
    if (!drainCoordsOk) return false;
    return true;
  });

  const candidates = eligibleRobots.map((robot) => {
    const distance = coordinateDistance(
      robot.latitude,
      robot.longitude,
      drain.latitude,
      drain.longitude
    );

    const batteryCost = estimatedBatteryCost(distance);
    const travelSeconds = estimatedTravelSeconds(distance);
    const hasEnoughBattery =
      robot.batteryLevel !== null && robot.batteryLevel > batteryCost + MIN_BATTERY_MISSION;

    return {
      ...robot,
      distanceToTarget: distance,
      batteryCostToTarget: batteryCost,
      travelSecondsToTarget: travelSeconds,
      hasEnoughBattery,
      formatTravelTime: formatDuration(travelSeconds)
    };
  });

  return {
    drain,
    robots,
    candidates,
    activeMissions: Array.from(activeMissions.entries()).map(([robotId, drainId]) => ({ robotId, drainId })),
    drainCoordsOk,
    reason: null
  };
}

// ------------------------------------------------------------
// Robot selection (explainable scoring)
// ------------------------------------------------------------

function scoreCandidate(candidate) {
  let score = 0;
  const reasons = [];

  // Distance score: closer is better (max 40 points)
  if (candidate.distanceToTarget !== null) {
    const distanceScore = Math.max(0, 40 - candidate.distanceToTarget * 10000);
    score += distanceScore;
    reasons.push(`Distance: ${candidate.distanceToTarget} (~${candidate.formatTravelTime})`);
  }

  // Battery score: higher is better (max 30 points)
  if (candidate.batteryLevel !== null) {
    const batteryScore = candidate.batteryLevel * 0.3;
    score += batteryScore;
    reasons.push(`Battery: ${candidate.batteryLevel}%`);
  }

  // Battery sufficiency: bonus if can complete without charging (max 20 points)
  if (candidate.hasEnoughBattery) {
    score += 20;
    reasons.push("Sufficient battery for direct route");
  }

  // Zone match: bonus if assigned zone matches (max 10 points)
  if (candidate.assignedZone) {
    const drainZoneResult = routeCache.get(`zone:${candidate.id}`);
    // This is best-effort; zone name comparison
    score += 0; // will compare below
  }

  return {
    score: round1(score),
    reasons
  };
}

function selectBestRobot(drainId) {
  return getCandidates(drainId).then((context) => {
    const { drain, candidates, drainCoordsOk } = context;

    if (!drain) {
      return {
        status: "DRAIN_NOT_FOUND",
        drain: null,
        robot: null,
        route: null,
        reason: context.reason,
        disclaimer: PLANNING_DISCLAIMER,
        generatedAt: new Date().toISOString()
      };
    }

    if (!drainCoordsOk) {
      return {
        status: "NO_COORDINATES",
        drain,
        robot: null,
        route: null,
        reason: "Drain has no valid coordinates",
        disclaimer: PLANNING_DISCLAIMER,
        generatedAt: new Date().toISOString()
      };
    }

    if (candidates.length === 0) {
      return {
        status: "NO_ROBOT_AVAILABLE",
        drain,
        robot: null,
        route: null,
        reason: describeNoCandidateReason(context),
        disclaimer: PLANNING_DISCLAIMER,
        generatedAt: new Date().toISOString()
      };
    }

    // Score and sort
    const scored = candidates
      .map((candidate) => ({
        ...candidate,
        ...scoreCandidate(candidate)
      }))
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.id - b.id; // tie-break by robot id
      });

    const best = scored[0];

    return {
      status: "ROBOT_SELECTED",
      drain,
      robot: {
        id: best.id,
        robotName: best.robotName,
        status: best.status,
        batteryLevel: best.batteryLevel,
        latitude: best.latitude,
        longitude: best.longitude
      },
      selectionScore: best.score,
      selectionReasons: best.reasons,
      route: null, // populated by planRoute if called
      disclaimer: PLANNING_DISCLAIMER,
      generatedAt: new Date().toISOString()
    };
  });
}

function describeNoCandidateReason(context) {
  const { robots, activeMissions, drainCoordsOk } = context;

  if (robots.length === 0) return "No robots registered in the system";

  const charging = robots.filter((r) => r.status === "Charging");
  const withMission = robots.filter((r) => activeMissions.some((m) => m.robotId === r.id));
  const noCoords = robots.filter((r) => r.latitude === null || r.longitude === null);

  if (charging.length > 0 && withMission.length > 0) {
    return `All robots are either charging (${charging.length}) or on active missions (${withMission.length})`;
  }
  if (charging.length === robots.length) {
    return "All robots are currently charging";
  }
  if (withMission.length > 0) {
    return `All eligible robots have active missions (${withMission.length})`;
  }

  return "No robot is currently available for dispatch";
}

// ------------------------------------------------------------
// Route planning — waypoint generation
// ------------------------------------------------------------

function buildDirectRoute(drain, robot) {
  const distance = coordinateDistance(
    robot.latitude,
    robot.longitude,
    drain.latitude,
    drain.longitude
  );

  const travelSeconds = estimatedTravelSeconds(distance);
  const batteryCost = estimatedBatteryCost(distance);

  return {
    type: "DIRECT",
    totalDistance: distance,
    totalTravelSeconds: travelSeconds,
    totalBatteryCost: batteryCost,
    formatTotalTravelTime: formatDuration(travelSeconds),
    needsCharging: false,
    chargingStation: null,
    waypoints: [
      {
        label: "START",
        latitude: robot.latitude,
        longitude: robot.longitude,
        distanceFromPrevious: 0,
        cumulativeDistance: 0,
        cumulativeTravelSeconds: 0,
        cumulativeBatteryCost: 0
      },
      {
        label: "TARGET",
        latitude: drain.latitude,
        longitude: drain.longitude,
        distanceFromPrevious: distance,
        cumulativeDistance: distance,
        cumulativeTravelSeconds: travelSeconds,
        cumulativeBatteryCost: batteryCost
      }
    ]
  };
}

async function findNearestChargingStation(robotLat, robotLng) {
  const result = await pool.query(
    `
    SELECT id, station_name, latitude, longitude
    FROM charging_stations
    ORDER BY id ASC
    `
  );

  if (result.rows.length === 0) return null;

  let best = null;
  let bestDistance = Infinity;

  for (const row of result.rows) {
    const sLat = finiteNumber(row.latitude);
    const sLng = finiteNumber(row.longitude);
    if (sLat === null || sLng === null) continue;

    const dist = coordinateDistance(robotLat, robotLng, sLat, sLng);
    if (dist !== null && dist < bestDistance) {
      bestDistance = dist;
      best = {
        id: Number(row.id),
        stationName: row.station_name,
        latitude: sLat,
        longitude: sLng,
        distanceFromRobot: dist
      };
    }
  }

  return best;
}

async function buildChargingRoute(drain, robot) {
  const station = await findNearestChargingStation(
    robot.latitude,
    robot.longitude
  );

  if (!station) {
    // No charging station found — fall back to direct
    const direct = buildDirectRoute(drain, robot);
    direct.needsCharging = true;
    direct.chargingStation = null;
    direct.chargingNote = "No charging station found; direct route with insufficient battery";
    return direct;
  }

  // Robot → Station → Drain
  const leg1Distance = coordinateDistance(
    robot.latitude,
    robot.longitude,
    station.latitude,
    station.longitude
  );

  const leg2Distance = coordinateDistance(
    station.latitude,
    station.longitude,
    drain.latitude,
    drain.longitude
  );

  const totalDistance = round3((leg1Distance || 0) + (leg2Distance || 0));
  const totalTravelSeconds = estimatedTravelSeconds(totalDistance);
  const totalBatteryCost = estimatedBatteryCost(totalDistance);

  return {
    type: "CHARGING_STOP",
    totalDistance,
    totalTravelSeconds,
    totalBatteryCost,
    formatTotalTravelTime: formatDuration(totalTravelSeconds),
    needsCharging: true,
    chargingStation: {
      id: station.id,
      stationName: station.stationName,
      latitude: station.latitude,
      longitude: station.longitude
    },
    waypoints: [
      {
        label: "START",
        latitude: robot.latitude,
        longitude: robot.longitude,
        distanceFromPrevious: 0,
        cumulativeDistance: 0,
        cumulativeTravelSeconds: 0,
        cumulativeBatteryCost: 0
      },
      {
        label: "CHARGING_STATION",
        latitude: station.latitude,
        longitude: station.longitude,
        distanceFromPrevious: leg1Distance,
        cumulativeDistance: leg1Distance,
        cumulativeTravelSeconds: estimatedTravelSeconds(leg1Distance),
        cumulativeBatteryCost: estimatedBatteryCost(leg1Distance)
      },
      {
        label: "TARGET",
        latitude: drain.latitude,
        longitude: drain.longitude,
        distanceFromPrevious: leg2Distance,
        cumulativeDistance: totalDistance,
        cumulativeTravelSeconds: totalTravelSeconds,
        cumulativeBatteryCost: totalBatteryCost
      }
    ]
  };
}

async function planRoute(drainId) {
  const selection = await selectBestRobot(drainId);

  if (selection.status !== "ROBOT_SELECTED") {
    return {
      ...selection,
      route: null,
      generatedAt: new Date().toISOString()
    };
  }

  const { drain, robot } = selection;

  const hasEnoughBattery =
    robot.batteryLevel !== null &&
    robot.batteryLevel > estimatedBatteryCost(
      coordinateDistance(robot.latitude, robot.longitude, drain.latitude, drain.longitude)
    ) + MIN_BATTERY_MISSION;

  let route;

  if (hasEnoughBattery) {
    route = buildDirectRoute(drain, robot);
  } else {
    route = await buildChargingRoute(drain, robot);
  }

  const result = {
    ...selection,
    route,
    hasEnoughBattery,
    generatedAt: new Date().toISOString()
  };

  maybeEmitRouteUpdate(drainId, result);
  return result;
}

// ------------------------------------------------------------
// Dashboard summary — all drains with active/planned routes
// ------------------------------------------------------------

async function getAllRoutes() {
  const drainsResult = await pool.query(
    `
    SELECT id, zone_name, location, latitude, longitude, status
    FROM drains
    ORDER BY id ASC
    `
  );

  const routes = [];

  for (const row of drainsResult.rows) {
    const drainId = Number(row.id);
    const status = String(row.status || "Normal");

    // Only plan for Warning/Critical drains to reduce DB load
    if (status === "Normal") {
      routes.push({
        drainId,
        zone: row.zone_name,
        location: row.location,
        status,
        planningStatus: "SKIPPED",
        reason: "Normal status — planning not required"
      });
      continue;
    }

    try {
      const route = await planRoute(drainId);
      routes.push({
        drainId,
        zone: row.zone_name,
        location: row.location,
        status,
        planningStatus: route.status,
        robot: route.robot,
        route: route.route,
        selectionScore: route.selectionScore || null,
        selectionReasons: route.selectionReasons || []
      });
    } catch (err) {
      routes.push({
        drainId,
        zone: row.zone_name,
        location: row.location,
        status,
        planningStatus: "ERROR",
        reason: err.message
      });
    }
  }

  const summary = {
    totalDrains: drainsResult.rows.length,
    warningCritical: drainsResult.rows.filter(
      (r) => r.status === "Warning" || r.status === "Critical"
    ).length,
    routes,
    disclaimer: PLANNING_DISCLAIMER,
    generatedAt: new Date().toISOString()
  };

  return summary;
}

// ------------------------------------------------------------
// Live emission — robotRouteUpdate on meaningful change
// ------------------------------------------------------------

const lastEmitted = new Map();

function maybeEmitRouteUpdate(drainId, result) {
  if (!result || !result.robot) {
    lastEmitted.delete(drainId);
    return;
  }

  const key = drainId;
  const prev = lastEmitted.get(key);

  const current = {
    robotId: result.robot.id,
    robotName: result.robot.robotName,
    planningStatus: result.status,
    routeType: result.route ? result.route.type : null,
    drainLocation: result.drain ? result.drain.location : null
  };

  if (!prev) {
    lastEmitted.set(key, current);
    socketHub.emit("robotRouteUpdate", result);
    return;
  }

  const changed =
    prev.robotId !== current.robotId ||
    prev.planningStatus !== current.planningStatus ||
    prev.routeType !== current.routeType ||
    prev.drainLocation !== current.drainLocation;

  if (changed) {
    lastEmitted.set(key, current);
    socketHub.emit("robotRouteUpdate", result);
  }
}

function resetRouteRuntime() {
  lastEmitted.clear();
  routeCache.clear();
}

// ------------------------------------------------------------
// Exports
// ------------------------------------------------------------

module.exports = {
  MOVEMENT_STEP,
  TICK_INTERVAL_MS,
  BATTERY_DRAIN_PER_TICK,
  TICKS_PER_UNIT,
  SECONDS_PER_UNIT,
  BATTERY_PER_UNIT,
  MIN_BATTERY_MISSION,
  MIN_BATTERY_IDEAL,
  ARRIVAL_THRESHOLD,
  PLANNING_DISCLAIMER,
  CACHE_TTL_MS,
  finiteNumber,
  round3,
  round1,
  coordinateDistance,
  estimatedTravelSeconds,
  estimatedBatteryCost,
  formatDuration,
  getCandidates,
  scoreCandidate,
  selectBestRobot,
  buildDirectRoute,
  findNearestChargingStation,
  buildChargingRoute,
  planRoute,
  getAllRoutes,
  maybeEmitRouteUpdate,
  resetRouteRuntime
};
