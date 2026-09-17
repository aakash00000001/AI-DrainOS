// ============================================================
// AI-DrainOS — Predictive Resource & Robot Fleet Optimization
//
// A fleet-LEVEL optimization / recommendation layer that reads the
// current system state (robots, drains, active incidents, AI
// decisions, existing routes, charging stations, missions) and
// produces EXPLAINABLE robot-to-task recommendations.
//
// HARD RULES (do not violate):
//  * This is NOT a mission engine. It never assigns or dispatches
//    robots and never moves them. missionEngine.js remains the
//    authority for real assignment + movement.
//  * It does NOT replace decisionEngine.js, robotPathPlanningService
//    .js, incidentService.js or the Digital Twin. It REUSES the
//    existing Robot Path Planning primitives (distance/time/battery
//    estimation, charging-station lookup) and the existing AI
//    Decision Engine scores — it never creates a second AI formula.
//  * It never fabricates data: missing battery/location/decision
//    values stay null and are reported honestly.
//
// Deterministic + explainable: every score is a documented weighted
// sum of real inputs and every recommendation carries a reason.
// ============================================================

const pool = require("../config/db");
const socketHub = require("./socketHub");
const robotPathPlanning = require("./robotPathPlanningService");
const decisionEngine = require("./decisionEngine");

// ------------------------------------------------------------
// Constants
// ------------------------------------------------------------

// Reused primitive constants (single source of truth is the Robot
// Path Planning service, which itself mirrors index.js).
const TICK_INTERVAL_MS = robotPathPlanning.TICK_INTERVAL_MS;
const MIN_BATTERY_MISSION = robotPathPlanning.MIN_BATTERY_MISSION;

// Charging rate from the existing live loop in index.js:
// Charging robots gain +2 battery% per 5 s tick.
const CHARGE_PER_TICK = 2;

// Fleet priority weights (documented, deterministic).
const PRIORITY_WEIGHTS = {
  decision: 0.6,
  severity: 0.2,
  age: 0.1,
  urgency: 0.1
};

// Task age ramp: an age of AGE_RAMP_MINUTES maps to 100 urgency.
const AGE_RAMP_MINUTES = 60;

// Candidate score budget (sums to 100):
//   distance 35 · battery 25 · ETA 20 · availability 10 · feasibility 10
const CANDIDATE_WEIGHTS = {
  distance: 35,
  battery: 25,
  eta: 20,
  availability: 10,
  feasibility: 10
};

// Distance -> distance-score falloff (coordinate units). 4000 means
// a separation of 0.00875 units scores 0 distance points.
const DISTANCE_FALLOFF = 4000;

// Severity → score used by the priority formula.
const SEVERITY_SCORE = { LOW: 25, MODERATE: 50, HIGH: 75, CRITICAL: 100 };

// Drain status urgency contribution.
const DRAIN_STATUS_URGENCY = { Critical: 100, Warning: 60, Normal: 0 };

// Incident state urgency contribution.
const INCIDENT_STATUS_URGENCY = { OPEN: 30, ACKNOWLEDGED: 20, RESPONDING: 10, RESOLVED: 0 };

// Route status urgency contribution (unassigned emergency needs help).
const ROUTE_STATUS_URGENCY = { NO_ROBOT_AVAILABLE: 40, NO_COORDINATES: 20 };

// Availability states (explicit + honest).
const AVAILABILITY = {
  AVAILABLE: "AVAILABLE",
  BUSY: "BUSY",
  CHARGING: "CHARGING",
  LOW_BATTERY: "LOW_BATTERY",
  OFFLINE: "OFFLINE",
  UNAVAILABLE: "UNAVAILABLE"
};

// Route modes (battery-aware).
const ROUTE_MODE = {
  DIRECT: "DIRECT",
  CHARGE_THEN_TASK: "CHARGE_THEN_TASK",
  NO_FEASIBLE_ROUTE: "NO_FEASIBLE_ROUTE"
};

// No-solution / status states.
const FLEET_STATUS = {
  OK: "OK",
  NO_TASKS: "NO_TASKS",
  NO_ROBOTS: "NO_ROBOTS",
  NO_ELIGIBLE_ROBOT: "NO_ELIGIBLE_ROBOT",
  NO_COORDINATES: "NO_COORDINATES",
  NO_FEASIBLE_ROUTE: "NO_FEASIBLE_ROUTE",
  INSUFFICIENT_DATA: "INSUFFICIENT_DATA"
};

const FLEET_DISCLAIMER =
  "Fleet optimization is ADVISORY ONLY. Recommendations do not dispatch or " +
  "assign robots — missionEngine.js remains the sole authority for mission " +
  "assignment and movement. Distances/times are coordinate-space estimates " +
  "derived from the existing movement-loop constants.";

// ------------------------------------------------------------
// Small helpers
// ------------------------------------------------------------

function round1(value) {
  return Math.round(value * 10) / 10;
}

function clamp(value, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num)) return min;
  return Math.min(max, Math.max(min, num));
}

function asNumber(value) {
  if (value === null || value === undefined) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function normalizeUpper(value) {
  return value === null || value === undefined ? null : String(value).toUpperCase();
}

function nowIso() {
  return new Date().toISOString();
}

function secondsBetween(fromIso, toMs = Date.now()) {
  if (!fromIso) return null;
  const from = new Date(fromIso).getTime();
  if (!Number.isFinite(from)) return null;
  const diff = Math.floor((toMs - from) / 1000);
  return diff >= 0 ? diff : 0;
}

/** Map a 0-100 score to a level label (documented 25/50/75 bands). */
function levelFromScore(score) {
  const num = asNumber(score);
  if (num === null) return null;
  if (num >= 75) return "CRITICAL";
  if (num >= 50) return "HIGH";
  if (num >= 25) return "MODERATE";
  return "LOW";
}

// ------------------------------------------------------------
// Pure scoring functions (exported for deterministic testing)
// ------------------------------------------------------------

function severityScore(severity) {
  const key = normalizeUpper(severity);
  return SEVERITY_SCORE[key] !== undefined ? SEVERITY_SCORE[key] : 0;
}

/**
 * ageScore: 0 at age 0, 100 at AGE_RAMP_MINUTES and above.
 * Returns null when the age is unknown (never fabricated).
 */
function ageScore(ageSeconds) {
  const secs = asNumber(ageSeconds);
  if (secs === null) return null;
  const minutes = secs / 60;
  return round1(clamp((minutes / AGE_RAMP_MINUTES) * 100, 0, 100));
}

function operationalUrgencyScore({ drainStatus, incidentStatus, routeStatus } = {}) {
  const drain = DRAIN_STATUS_URGENCY[drainStatus] || 0;
  const incident = INCIDENT_STATUS_URGENCY[normalizeUpper(incidentStatus)] || 0;
  const route = ROUTE_STATUS_URGENCY[routeStatus] || 0;
  return round1(clamp(drain + incident + route, 0, 100));
}

/**
 * Task priority (0-100).
 *
 *   taskPriority = decisionScore * 0.60
 *                + severityScore * 0.20
 *                + ageScore      * 0.10
 *                + urgency       * 0.10
 *
 * If decisionScore is unavailable it is NOT fabricated: the remaining
 * available signals are RENORMALIZED (weights re-scaled to sum to 1)
 * and priority_status is reported as "RENORMALIZED". If no signal at
 * all is available the task is marked INSUFFICIENT_DATA with a null
 * score. Priority always comes from real inputs.
 */
function computeTaskPriority({
  decisionScore,
  decisionLevel,
  severity,
  ageSeconds,
  operationalUrgency
}) {
  const signals = [];
  const numericDecision = asNumber(decisionScore);

  if (numericDecision !== null) {
    signals.push({
      key: "decision_score",
      value: clamp(numericDecision, 0, 100),
      weight: PRIORITY_WEIGHTS.decision
    });
  }

  signals.push({
    key: "severity",
    value: severityScore(severity),
    weight: PRIORITY_WEIGHTS.severity
  });

  const age = ageScore(ageSeconds);
  if (age !== null) {
    signals.push({ key: "age", value: age, weight: PRIORITY_WEIGHTS.age });
  }

  signals.push({
    key: "operational_urgency",
    value: clamp(operationalUrgency || 0, 0, 100),
    weight: PRIORITY_WEIGHTS.urgency
  });

  const totalWeight = signals.reduce((sum, s) => sum + s.weight, 0);

  if (totalWeight <= 0) {
    return {
      priority_score: null,
      priority_status: FLEET_STATUS.INSUFFICIENT_DATA,
      priority_breakdown: {}
    };
  }

  const weighted = signals.reduce(
    (sum, s) => sum + s.value * (s.weight / totalWeight),
    0
  );

  const breakdown = {};
  for (const s of signals) breakdown[s.key] = round1(s.value);

  return {
    priority_score: round1(clamp(weighted, 0, 100)),
    // decisionLevel is informational only; the real numeric decision
    // score drives the weight.
    priority_status: numericDecision === null ? "RENORMALIZED" : "OK",
    priority_breakdown: breakdown,
    decision_level: decisionLevel || null
  };
}

/**
 * Candidate score (0-100) using the documented budget:
 *   distance (closer better) 35 · battery 25 · ETA (faster) 20 ·
 *   availability 10 · route feasibility 10
 * Returns a null score for ineligible candidates.
 */
function computeCandidateScore({ distance, batteryLevel, travelSeconds, eligible }) {
  if (!eligible) {
    return { candidate_score: null, components: null };
  }

  const dist = asNumber(distance);
  const battery = asNumber(batteryLevel);
  const travel = asNumber(travelSeconds);

  const distanceScore =
    dist === null
      ? 0
      : clamp(CANDIDATE_WEIGHTS.distance - dist * DISTANCE_FALLOFF, 0, CANDIDATE_WEIGHTS.distance);

  const batteryScore =
    battery === null ? 0 : clamp((battery / 100) * CANDIDATE_WEIGHTS.battery, 0, CANDIDATE_WEIGHTS.battery);

  const etaScore =
    travel === null ? 0 : clamp(CANDIDATE_WEIGHTS.eta - travel / 60, 0, CANDIDATE_WEIGHTS.eta);

  const score =
    distanceScore +
    batteryScore +
    etaScore +
    CANDIDATE_WEIGHTS.availability +
    CANDIDATE_WEIGHTS.feasibility;

  return {
    candidate_score: round1(clamp(score, 0, 100)),
    components: {
      distance: round1(distanceScore),
      battery: round1(batteryScore),
      eta: round1(etaScore),
      availability: CANDIDATE_WEIGHTS.availability,
      feasibility: CANDIDATE_WEIGHTS.feasibility
    }
  };
}

/**
 * Battery-aware route evaluation. Reuses the Robot Path Planning
 * distance/time/battery estimators (no duplicate estimation logic).
 *
 *   START -> TASK                     => DIRECT
 *   START -> CHARGING STATION -> TASK => CHARGE_THEN_TASK
 *   otherwise                         => NO_FEASIBLE_ROUTE
 *
 * A route is never reported feasible when battery is insufficient.
 */
function evaluateRouteMode({
  robotBattery,
  robotLatitude,
  robotLongitude,
  taskLatitude,
  taskLongitude,
  chargingStation
}) {
  const battery = asNumber(robotBattery);

  if (
    robotLatitude === null || robotLongitude === null ||
    taskLatitude === null || taskLongitude === null
  ) {
    return {
      route_mode: ROUTE_MODE.NO_FEASIBLE_ROUTE,
      reason: FLEET_STATUS.NO_COORDINATES,
      estimated_distance: null,
      estimated_travel_time: null,
      estimated_battery_cost: null,
      battery_before: battery,
      battery_after: null,
      charging_required: false,
      charging_station: null
    };
  }

  if (battery === null) {
    return {
      route_mode: ROUTE_MODE.NO_FEASIBLE_ROUTE,
      reason: FLEET_STATUS.INSUFFICIENT_DATA,
      estimated_distance: null,
      estimated_travel_time: null,
      estimated_battery_cost: null,
      battery_before: null,
      battery_after: null,
      charging_required: false,
      charging_station: null
    };
  }

  const directDistance = robotPathPlanning.coordinateDistance(
    robotLatitude,
    robotLongitude,
    taskLatitude,
    taskLongitude
  );
  const directCost = robotPathPlanning.estimatedBatteryCost(directDistance);
  const directTravel = robotPathPlanning.estimatedTravelSeconds(directDistance);

  if (battery > directCost + MIN_BATTERY_MISSION) {
    return {
      route_mode: ROUTE_MODE.DIRECT,
      reason: null,
      estimated_distance: directDistance,
      estimated_travel_time: directTravel,
      estimated_battery_cost: directCost,
      battery_before: battery,
      battery_after: round1(battery - directCost),
      charging_required: false,
      charging_station: null
    };
  }

  // Not enough battery for a direct run — try a charging stop.
  if (chargingStation) {
    const leg1 = robotPathPlanning.coordinateDistance(
      robotLatitude,
      robotLongitude,
      chargingStation.latitude,
      chargingStation.longitude
    );
    const leg2 = robotPathPlanning.coordinateDistance(
      chargingStation.latitude,
      chargingStation.longitude,
      taskLatitude,
      taskLongitude
    );

    const costToStation = robotPathPlanning.estimatedBatteryCost(leg1);
    const costAfterCharge = robotPathPlanning.estimatedBatteryCost(leg2);

    // Must be able to reach the station with the mission reserve intact,
    // and the post-charge leg (charging assumed to 100%) must leave the
    // reserve untouched on arrival.
    if (
      leg1 !== null && leg2 !== null &&
      battery > costToStation + MIN_BATTERY_MISSION &&
      100 - costAfterCharge >= MIN_BATTERY_MISSION
    ) {
      const totalDistance = Math.round(((leg1 || 0) + (leg2 || 0)) * 1000) / 1000;
      return {
        route_mode: ROUTE_MODE.CHARGE_THEN_TASK,
        reason: null,
        estimated_distance: totalDistance,
        estimated_travel_time: robotPathPlanning.estimatedTravelSeconds(totalDistance),
        estimated_battery_cost:
          round1(robotPathPlanning.estimatedBatteryCost(leg1) + robotPathPlanning.estimatedBatteryCost(leg2)),
        battery_before: battery,
        battery_after: round1(100 - costAfterCharge),
        charging_required: true,
        charging_station: {
          id: chargingStation.id,
          station_name: chargingStation.station_name,
          latitude: chargingStation.latitude,
          longitude: chargingStation.longitude
        }
      };
    }
  }

  return {
    route_mode: ROUTE_MODE.NO_FEASIBLE_ROUTE,
    reason: "BATTERY_INSUFFICIENT",
    estimated_distance: null,
    estimated_travel_time: null,
    estimated_battery_cost: null,
    battery_before: battery,
    battery_after: null,
    charging_required: true,
    charging_station: null
  };
}

// ------------------------------------------------------------
// State collection
// ------------------------------------------------------------

/**
 * Availability state for a robot. Honest: an unknown battery is
 * UNAVAILABLE, and a robot on an active mission is BUSY (it cannot
 * safely take a second task).
 */
function availabilityStateFor(robot, activeMission) {
  if (!robot) return null;
  const status = robot.status;

  if (status === "Charging") return AVAILABILITY.CHARGING;
  if (status === "Offline") return AVAILABILITY.OFFLINE;
  if (status === "Maintenance") return AVAILABILITY.UNAVAILABLE;

  if (activeMission) return AVAILABILITY.BUSY;

  const battery = asNumber(robot.battery_level);
  if (battery === null) return AVAILABILITY.UNAVAILABLE;
  if (battery <= MIN_BATTERY_MISSION) return AVAILABILITY.LOW_BATTERY;

  if (status === "Idle") return AVAILABILITY.AVAILABLE;

  return AVAILABILITY.UNAVAILABLE;
}

async function getChargingStations() {
  const result = await pool.query(
    "SELECT id, station_name, latitude, longitude FROM charging_stations ORDER BY id ASC"
  );
  return result.rows.map((row) => ({
    id: Number(row.id),
    station_name: row.station_name,
    latitude: asNumber(row.latitude),
    longitude: asNumber(row.longitude)
  }));
}

function nearestStation(latitude, longitude, stations) {
  if (latitude === null || longitude === null) return null;
  let best = null;
  let bestDistance = Infinity;
  for (const station of stations) {
    if (station.latitude === null || station.longitude === null) continue;
    const dist = robotPathPlanning.coordinateDistance(
      latitude,
      longitude,
      station.latitude,
      station.longitude
    );
    if (dist !== null && dist < bestDistance) {
      bestDistance = dist;
      best = station;
    }
  }
  return best;
}

/**
 * Build the robot-state list. Every field is real database data;
 * values that cannot be derived are returned as null.
 */
async function getRobotStates() {
  const [robotResult, missionResult, stations] = await Promise.all([
    pool.query(
      `
      SELECT id, robot_name, assigned_zone, status, battery_level,
             latitude, longitude, target_latitude, target_longitude
      FROM robots
      ORDER BY id ASC
      `
    ),
    pool.query(
      `
      SELECT DISTINCT ON (robot_id) id, robot_id, drain_id
      FROM missions
      WHERE mission_status = 'Assigned'
      ORDER BY robot_id, id DESC
      `
    ),
    getChargingStations()
  ]);

  const missionByRobot = new Map();
  for (const row of missionResult.rows) {
    missionByRobot.set(Number(row.robot_id), {
      mission_id: Number(row.id),
      drain_id: row.drain_id === null ? null : Number(row.drain_id)
    });
  }

  const generatedMs = Date.now();

  return robotResult.rows.map((row) => {
    const id = Number(row.id);
    const battery = asNumber(row.battery_level);
    const latitude = asNumber(row.latitude);
    const longitude = asNumber(row.longitude);
    const mission = missionByRobot.get(id) || null;
    const availability = availabilityStateFor(row, mission);

    // Estimated available time — only when it can be derived honestly.
    let estimatedAvailableTime = null;
    let estimatedAvailableReason = null;

    if (availability === AVAILABILITY.AVAILABLE) {
      estimatedAvailableTime = new Date(generatedMs).toISOString();
      estimatedAvailableReason = "Available now";
    } else if (availability === AVAILABILITY.CHARGING && battery !== null) {
      const ticksToFull = Math.max(0, (100 - battery) / CHARGE_PER_TICK);
      const seconds = Math.ceil(ticksToFull) * (TICK_INTERVAL_MS / 1000);
      estimatedAvailableTime = new Date(generatedMs + seconds * 1000).toISOString();
      estimatedAvailableReason = `Charging to full (~${robotPathPlanning.formatDuration(seconds)})`;
    } else if (availability === AVAILABILITY.BUSY && mission) {
      // Prefer the robot's own target coordinates when present (real).
      const targetLatitude = asNumber(row.target_latitude);
      const targetLongitude = asNumber(row.target_longitude);
      if (
        targetLatitude !== null &&
        targetLongitude !== null &&
        latitude !== null &&
        longitude !== null
      ) {
        const dist = robotPathPlanning.coordinateDistance(latitude, longitude, targetLatitude, targetLongitude);
        const seconds = robotPathPlanning.estimatedTravelSeconds(dist);
        estimatedAvailableTime = new Date(generatedMs + seconds * 1000).toISOString();
        estimatedAvailableReason = `On mission (ETA ~${robotPathPlanning.formatDuration(seconds)})`;
      } else {
        estimatedAvailableReason = "On active mission (no ETA available)";
      }
    } else if (availability === AVAILABILITY.LOW_BATTERY) {
      estimatedAvailableReason = "Battery below mission reserve — charging required";
    } else if (availability === AVAILABILITY.OFFLINE) {
      estimatedAvailableReason = "Robot offline";
    } else if (availability === AVAILABILITY.UNAVAILABLE) {
      estimatedAvailableReason = "Robot unavailable";
    }

    const station =
      availability === AVAILABILITY.CHARGING
        ? nearestStation(latitude, longitude, stations)
        : null;

    return {
      robot_id: id,
      robot_name: row.robot_name,
      assigned_zone: row.assigned_zone || null,
      status: row.status,
      battery_level: battery,
      latitude,
      longitude,
      current_mission_id: mission ? mission.mission_id : null,
      target_drain_id: mission ? mission.drain_id : null,
      charging_station_id: station ? station.id : null,
      estimated_available_time: estimatedAvailableTime,
      estimated_available_reason: estimatedAvailableReason,
      availability_state: availability
    };
  });
}

// ------------------------------------------------------------
// Task queue
// ------------------------------------------------------------

async function getDrainDecisionSafe(drainId) {
  try {
    const decision = await decisionEngine.getDrainDecision(drainId);
    if (!decision) return null;
    return decision;
  } catch (err) {
    console.log(`⚠️ Fleet optimizer: decision unavailable for drain ${drainId}:`, err.message);
    return null;
  }
}

const ACTIVE_INCIDENT_STATUSES = ["OPEN", "ACKNOWLEDGED", "RESPONDING"];

/**
 * Normalized task queue from REAL active incidents + critical drains.
 * Decision scores come from the stored incident (real, captured by the
 * incident layer) or the existing AI Decision Engine — never invented.
 */
async function getTasks() {
  const [incidentResult, drainResult] = await Promise.all([
    pool.query(
      `
      SELECT
        i.id, i.drain_id, i.severity, i.source, i.status,
        i.decision_score, i.decision_level, i.route_status, i.created_at,
        d.zone_name, d.location, d.status AS drain_status, d.latitude, d.longitude
      FROM incidents i
      LEFT JOIN drains d ON d.id = i.drain_id
      WHERE i.status = ANY($1::varchar[])
      ORDER BY i.created_at ASC, i.id ASC
      `,
      [ACTIVE_INCIDENT_STATUSES]
    ),
    pool.query(
      `
      SELECT id, zone_name, location, status, latitude, longitude, created_at
      FROM drains
      WHERE status IN ('Critical', 'Warning')
      ORDER BY id ASC
      `
    )
  ]);

  const incidentDrainIds = new Set(
    incidentResult.rows.map((row) => Number(row.drain_id))
  );

  const tasks = [];
  const nowMs = Date.now();

  for (const row of incidentResult.rows) {
    const severity = normalizeUpper(row.severity) || "LOW";
    const ageSeconds = secondsBetween(row.created_at, nowMs);
    const urgency = operationalUrgencyScore({
      drainStatus: row.drain_status,
      incidentStatus: row.status,
      routeStatus: row.route_status
    });
    const priority = computeTaskPriority({
      decisionScore: row.decision_score,
      decisionLevel: row.decision_level,
      severity,
      ageSeconds,
      operationalUrgency: urgency
    });

    tasks.push({
      task_id: `incident:${Number(row.id)}`,
      incident_id: Number(row.id),
      drain_id: Number(row.drain_id),
      zone: row.zone_name || null,
      location: row.location || null,
      severity,
      decision_score: asNumber(row.decision_score),
      decision_level: row.decision_level || null,
      source: row.source || null,
      status: row.status,
      latitude: asNumber(row.latitude),
      longitude: asNumber(row.longitude),
      age_seconds: ageSeconds,
      operational_urgency: urgency,
      estimated_urgency: levelFromScore(priority.priority_score),
      priority_score: priority.priority_score,
      priority_status: priority.priority_status,
      priority_breakdown: priority.priority_breakdown
    });
  }

  for (const row of drainResult.rows) {
    const drainId = Number(row.id);
    if (incidentDrainIds.has(drainId)) continue; // incident task already covers it

    const drainStatus = row.status;
    const severity = drainStatus === "Critical" ? "CRITICAL" : "HIGH";

    const decision = await getDrainDecisionSafe(drainId);
    const decisionReady = decision && decision.status === "READY";
    const decisionScore = decisionReady ? asNumber(decision.priorityScore) : null;
    const decisionLevel = decisionReady ? decision.priorityLevel || null : null;

    const ageSeconds = secondsBetween(row.created_at, nowMs);
    const urgency = operationalUrgencyScore({ drainStatus });
    const priority = computeTaskPriority({
      decisionScore,
      decisionLevel,
      severity,
      ageSeconds,
      operationalUrgency: urgency
    });

    tasks.push({
      task_id: `drain:${drainId}`,
      incident_id: null,
      drain_id: drainId,
      zone: row.zone_name || null,
      location: row.location || null,
      severity,
      decision_score: decisionScore,
      decision_level: decisionLevel,
      source: "DRAIN_STATUS",
      status: `DRAIN_${String(drainStatus).toUpperCase()}`,
      latitude: asNumber(row.latitude),
      longitude: asNumber(row.longitude),
      age_seconds: ageSeconds,
      operational_urgency: urgency,
      estimated_urgency: levelFromScore(priority.priority_score),
      priority_score: priority.priority_score,
      priority_status: priority.priority_status,
      priority_breakdown: priority.priority_breakdown
    });
  }

  return tasks;
}

// ------------------------------------------------------------
// Candidate evaluation + recommendation
// ------------------------------------------------------------

/**
 * Evaluate every robot for a task. Returns one entry per robot with
 * an explicit `eligible` flag, reasons and warnings.
 */
function evaluateCandidates(task, robots, stations) {
  const taskCoordsOk = task.latitude !== null && task.longitude !== null;

  return robots.map((robot) => {
    const reasons = [];
    const warnings = [];
    let eligible = true;

    if (robot.availability_state !== AVAILABILITY.AVAILABLE) {
      eligible = false;
      reasons.push(`Not available (${robot.availability_state})`);
    } else {
      reasons.push("Available for a new task");
    }

    const robotCoordsOk = robot.latitude !== null && robot.longitude !== null;
    if (!robotCoordsOk) {
      eligible = false;
      warnings.push("Robot location unavailable");
    }

    let route;

    if (!taskCoordsOk) {
      eligible = false;
      warnings.push("Task has no coordinates");
      route = evaluateRouteMode({
        robotBattery: robot.battery_level,
        robotLatitude: robot.latitude,
        robotLongitude: robot.longitude,
        taskLatitude: null,
        taskLongitude: null,
        chargingStation: null
      });
    } else if (!robotCoordsOk) {
      route = evaluateRouteMode({
        robotBattery: robot.battery_level,
        robotLatitude: null,
        robotLongitude: null,
        taskLatitude: task.latitude,
        taskLongitude: task.longitude,
        chargingStation: null
      });
    } else {
      const station = nearestStation(robot.latitude, robot.longitude, stations);
      route = evaluateRouteMode({
        robotBattery: robot.battery_level,
        robotLatitude: robot.latitude,
        robotLongitude: robot.longitude,
        taskLatitude: task.latitude,
        taskLongitude: task.longitude,
        chargingStation: station
      });
      if (route.route_mode === ROUTE_MODE.NO_FEASIBLE_ROUTE) {
        eligible = false;
        warnings.push(
          route.reason === "BATTERY_INSUFFICIENT"
            ? "Battery insufficient even with a charging stop"
            : `No feasible route (${route.reason})`
        );
      }
    }

    if (robot.battery_level === null) {
      eligible = false;
      warnings.push("Battery level unavailable");
    }

    if (eligible) {
      if (route.route_mode === ROUTE_MODE.DIRECT) {
        reasons.push(`Sufficient battery for a direct route (${route.battery_before}% → ${route.battery_after}%)`);
      } else if (route.route_mode === ROUTE_MODE.CHARGE_THEN_TASK) {
        reasons.push(`Charging stop required (${route.battery_before}% → ${route.battery_after}% after charging)`);
      }
      if (route.estimated_distance !== null) {
        reasons.push(`Distance ${route.estimated_distance} (~${robotPathPlanning.formatDuration(route.estimated_travel_time)})`);
      }
    }

    const { candidate_score, components } = computeCandidateScore({
      distance: route.estimated_distance,
      batteryLevel: robot.battery_level,
      travelSeconds: route.estimated_travel_time,
      eligible
    });

    return {
      robot_id: robot.robot_id,
      robot_name: robot.robot_name,
      eligible,
      candidate_score,
      candidate_components: components,
      route_mode: route.route_mode,
      estimated_distance: route.estimated_distance,
      estimated_travel_time: route.estimated_travel_time,
      estimated_battery_cost: route.estimated_battery_cost,
      battery_before: route.battery_before,
      battery_after: route.battery_after,
      charging_required: Boolean(route.charging_required),
      charging_station: route.charging_station,
      availability_state: robot.availability_state,
      reasons,
      warnings
    };
  });
}

function buildExplanation({ robot, task, route }) {
  const drainLabel =
    task.location || task.zone || `drain ${task.drain_id}`;

  const routePhrase =
    route.route_mode === ROUTE_MODE.DIRECT
      ? "has sufficient battery for a direct route"
      : "can reach the task via a charging stop";

  const eta =
    route.estimated_travel_time !== null
      ? `, and the lowest feasible travel time (${robotPathPlanning.formatDuration(route.estimated_travel_time)}) among eligible robots`
      : "";

  return (
    `${robot.robot_name} selected because it is available, ${routePhrase}${eta} ` +
    `for the ${task.severity} task at ${drainLabel} (priority ${task.priority_score ?? "n/a"}/100).`
  );
}

function requiredActionFor(reason, task) {
  switch (reason) {
    case FLEET_STATUS.NO_ROBOTS:
      return "Register a robot or bring an offline unit online.";
    case FLEET_STATUS.NO_COORDINATES:
      return `Add valid latitude/longitude to drain ${task.drain_id}.`;
    case FLEET_STATUS.NO_FEASIBLE_ROUTE:
      return "Charge an available robot or reposition a unit closer to the task.";
    case FLEET_STATUS.NO_ELIGIBLE_ROBOT:
      return "Free up a robot (finish a mission / charge) or dispatch manually.";
    case FLEET_STATUS.INSUFFICIENT_DATA:
      return "Provide battery/location data for the fleet.";
    default:
      return "Manual review required.";
  }
}

/**
 * Greedy multi-task / multi-robot assignment. Tasks are processed in
 * priority order; a robot can be recommended for at most ONE task.
 * Recommendations are informational only.
 */
function buildRecommendations(tasks, robots, stations) {
  const ordered = [...tasks].sort((a, b) => {
    const pa = a.priority_score === null ? -1 : a.priority_score;
    const pb = b.priority_score === null ? -1 : b.priority_score;
    if (pb !== pa) return pb - pa;
    return String(a.task_id).localeCompare(String(b.task_id));
  });

  const usedRobotIds = new Set();
  const recommendations = [];
  const unassigned = [];

  for (const task of ordered) {
    const candidates = evaluateCandidates(task, robots, stations);
    const eligibleCandidates = candidates.filter((c) => c.eligible);

    const availableCandidates = eligibleCandidates.filter(
      (c) => !usedRobotIds.has(c.robot_id)
    );

    let reason = null;
    if (robots.length === 0) reason = FLEET_STATUS.NO_ROBOTS;
    else if (task.latitude === null || task.longitude === null) reason = FLEET_STATUS.NO_COORDINATES;
    else if (eligibleCandidates.length === 0) reason = FLEET_STATUS.NO_FEASIBLE_ROUTE;
    else if (availableCandidates.length === 0) reason = FLEET_STATUS.NO_ELIGIBLE_ROBOT;

    if (reason) {
      unassigned.push({
        task_id: task.task_id,
        drain_id: task.drain_id,
        incident_id: task.incident_id,
        severity: task.severity,
        priority_score: task.priority_score,
        status: task.status,
        reason,
        required_action: requiredActionFor(reason, task)
      });
      continue;
    }

    const ranked = [...availableCandidates].sort((a, b) => {
      if (b.candidate_score !== a.candidate_score) {
        return b.candidate_score - a.candidate_score;
      }
      return a.robot_id - b.robot_id;
    });

    const chosen = ranked[0];
    usedRobotIds.add(chosen.robot_id);

    const robot = robots.find((r) => r.robot_id === chosen.robot_id);

    recommendations.push({
      task_id: task.task_id,
      incident_id: task.incident_id,
      drain_id: task.drain_id,
      zone: task.zone,
      location: task.location,
      severity: task.severity,
      priority_score: task.priority_score,
      robot_id: chosen.robot_id,
      robot_name: chosen.robot_name,
      candidate_score: chosen.candidate_score,
      candidate_components: chosen.candidate_components,
      route_mode: chosen.route_mode,
      estimated_distance: chosen.estimated_distance,
      estimated_travel_time: chosen.estimated_travel_time,
      estimated_battery_cost: chosen.estimated_battery_cost,
      battery_before: chosen.battery_before,
      battery_after: chosen.battery_after,
      charging_required: chosen.charging_required,
      charging_station: chosen.charging_station,
      eligible: true,
      reasons: chosen.reasons,
      warnings: chosen.warnings,
      explanation: buildExplanation({ robot: robot || chosen, task, route: chosen }),
      alternatives: ranked.slice(1).map((c) => ({
        robot_id: c.robot_id,
        robot_name: c.robot_name,
        candidate_score: c.candidate_score,
        route_mode: c.route_mode,
        estimated_travel_time: c.estimated_travel_time,
        charging_required: c.charging_required
      }))
    });
  }

  return { orderedTasks: ordered, recommendations, unassigned, usedRobotIds };
}

// ------------------------------------------------------------
// Fleet summary
// ------------------------------------------------------------

function buildSummary(robots, tasks, recommendations, unassigned) {
  const count = (state) => robots.filter((r) => r.availability_state === state).length;

  const total = robots.length;
  const busy = count(AVAILABILITY.BUSY);
  const charging = count(AVAILABILITY.CHARGING);
  const lowBattery = count(AVAILABILITY.LOW_BATTERY);
  const offline = count(AVAILABILITY.OFFLINE);
  const unavailable = count(AVAILABILITY.UNAVAILABLE);
  const available = count(AVAILABILITY.AVAILABLE);

  const batteryRiskCount = lowBattery + charging;
  const chargingRequirementCount =
    lowBattery + recommendations.filter((r) => r.charging_required).length;

  return {
    total_robots: total,
    available_robots: available,
    busy_robots: busy,
    charging_robots: charging,
    low_battery_robots: lowBattery,
    offline_robots: offline,
    unavailable_robots: unavailable,
    active_tasks: tasks.length,
    assigned_tasks: recommendations.length,
    unassigned_tasks: unassigned.length,
    recommended_assignments: recommendations.length,
    // Utilization = robots actively committed (busy or charging) / total.
    fleet_utilization: total > 0 ? round1(((busy + charging) / total) * 100) : null,
    battery_risk_count: batteryRiskCount,
    charging_requirement_count: chargingRequirementCount
  };
}

// ------------------------------------------------------------
// Full optimization
// ------------------------------------------------------------

async function buildGlobalStatus(robots, tasks, recommendations, unassigned) {
  if (robots.length === 0) return FLEET_STATUS.NO_ROBOTS;
  if (tasks.length === 0) return FLEET_STATUS.NO_TASKS;
  if (recommendations.length > 0) return FLEET_STATUS.OK;
  if (unassigned.some((u) => u.reason === FLEET_STATUS.NO_COORDINATES)) {
    return FLEET_STATUS.NO_COORDINATES;
  }
  if (unassigned.some((u) => u.reason === FLEET_STATUS.NO_FEASIBLE_ROUTE)) {
    return FLEET_STATUS.NO_FEASIBLE_ROUTE;
  }
  return FLEET_STATUS.NO_ELIGIBLE_ROBOT;
}

function buildWarnings(robots, tasks, unassigned, recommendations) {
  const warnings = [];

  const noCoordsRobots = robots.filter(
    (r) => r.latitude === null || r.longitude === null
  );
  if (noCoordsRobots.length > 0) {
    warnings.push(`${noCoordsRobots.length} robot(s) have no location — excluded from recommendations.`);
  }

  const lowBattery = robots.filter((r) => r.availability_state === AVAILABILITY.LOW_BATTERY);
  if (lowBattery.length > 0) {
    warnings.push(`${lowBattery.length} robot(s) below the ${MIN_BATTERY_MISSION}% mission reserve.`);
  }

  const chargingTasks = tasks.filter((t) => t.latitude === null || t.longitude === null);
  if (chargingTasks.length > 0) {
    warnings.push(`${chargingTasks.length} task(s) have no drain coordinates — cannot be planned.`);
  }

  const chargingStops = recommendations.filter((r) => r.charging_required);
  if (chargingStops.length > 0) {
    warnings.push(`${chargingStops.length} recommendation(s) require a charging stop before the task.`);
  }

  if (unassigned.length > 0) {
    warnings.push(`${unassigned.length} task(s) could not be assigned to any eligible robot.`);
  }

  return warnings;
}

function mergeRecommendationsIntoTasks(tasks, recommendations, unassigned) {
  const byTask = new Map();
  for (const rec of recommendations) byTask.set(rec.task_id, rec);
  const unassignedSet = new Set(unassigned.map((u) => u.task_id));

  return tasks.map((task) => {
    const rec = byTask.get(task.task_id);
    return {
      ...task,
      recommendation_status: rec
        ? "RECOMMENDED"
        : unassignedSet.has(task.task_id)
          ? "UNASSIGNED"
          : "PENDING",
      recommended_robot_id: rec ? rec.robot_id : null,
      recommended_robot_name: rec ? rec.robot_name : null,
      route_mode: rec ? rec.route_mode : null,
      candidate_score: rec ? rec.candidate_score : null
    };
  });
}

async function getFleetOptimization() {
  const [robots, tasks, stations] = await Promise.all([
    getRobotStates(),
    getTasks(),
    getChargingStations()
  ]);

  const { orderedTasks, recommendations, unassigned, usedRobotIds } =
    buildRecommendations(tasks, robots, stations);

  const tasksWithRecs = mergeRecommendationsIntoTasks(tasks, recommendations, unassigned);

  // Re-order merged tasks by priority (same ordering rules).
  tasksWithRecs.sort((a, b) => {
    const pa = a.priority_score === null ? -1 : a.priority_score;
    const pb = b.priority_score === null ? -1 : b.priority_score;
    if (pb !== pa) return pb - pa;
    return String(a.task_id).localeCompare(String(b.task_id));
  });

  const summary = buildSummary(robots, tasks, recommendations, unassigned);
  const status = await buildGlobalStatus(robots, tasks, recommendations, unassigned);
  const warnings = buildWarnings(robots, tasks, unassigned, recommendations);

  const robotsWithoutAssignment = robots
    .filter((r) => !usedRobotIds.has(r.robot_id))
    .map((r) => ({
      robot_id: r.robot_id,
      robot_name: r.robot_name,
      availability_state: r.availability_state,
      battery_level: r.battery_level
    }));

  const robotsRequiringCharging = robots
    .filter(
      (r) =>
        r.availability_state === AVAILABILITY.LOW_BATTERY ||
        r.availability_state === AVAILABILITY.CHARGING
    )
    .map((r) => ({
      robot_id: r.robot_id,
      robot_name: r.robot_name,
      availability_state: r.availability_state,
      battery_level: r.battery_level,
      charging_station_id: r.charging_station_id
    }));

  return {
    status,
    generated_at: nowIso(),
    summary,
    robots,
    tasks: tasksWithRecs,
    recommendations,
    unassigned,
    robots_without_assignment: robotsWithoutAssignment,
    robots_requiring_charging: robotsRequiringCharging,
    warnings,
    disclaimer: FLEET_DISCLAIMER
  };
}

// ------------------------------------------------------------
// Focused views
// ------------------------------------------------------------

async function getSummary() {
  const optimization = await getFleetOptimization();
  return {
    status: optimization.status,
    generated_at: optimization.generated_at,
    summary: optimization.summary,
    warnings: optimization.warnings,
    disclaimer: optimization.disclaimer
  };
}

async function getRobots() {
  const optimization = await getFleetOptimization();
  return {
    status: optimization.status,
    generated_at: optimization.generated_at,
    robots: optimization.robots
  };
}

async function getTasksView() {
  const optimization = await getFleetOptimization();
  return {
    status: optimization.status,
    generated_at: optimization.generated_at,
    tasks: optimization.tasks
  };
}

async function getRecommendations() {
  const optimization = await getFleetOptimization();
  return {
    status: optimization.status,
    generated_at: optimization.generated_at,
    recommendations: optimization.recommendations,
    unassigned: optimization.unassigned,
    robots_without_assignment: optimization.robots_without_assignment,
    robots_requiring_charging: optimization.robots_requiring_charging,
    warnings: optimization.warnings,
    disclaimer: optimization.disclaimer
  };
}

async function getTask(taskId) {
  if (!taskId || typeof taskId !== "string") return null;
  const optimization = await getFleetOptimization();

  const task = optimization.tasks.find((t) => t.task_id === taskId);
  if (!task) return null;

  const recommendation =
    optimization.recommendations.find((r) => r.task_id === taskId) || null;
  const unassigned = optimization.unassigned.find((u) => u.task_id === taskId) || null;

  return {
    status: optimization.status,
    generated_at: optimization.generated_at,
    task,
    recommendation,
    unassigned,
    disclaimer: optimization.disclaimer
  };
}

// ------------------------------------------------------------
// Analytics — real, derived from live current state
// ------------------------------------------------------------

async function getAnalytics() {
  const optimization = await getFleetOptimization();
  const { summary, recommendations, unassigned } = optimization;

  const withEta = recommendations.filter((r) => r.estimated_travel_time !== null);
  const averageEstimatedResponseSeconds =
    withEta.length > 0
      ? Math.round(
          withEta.reduce((sum, r) => sum + r.estimated_travel_time, 0) / withEta.length
        )
      : null;

  const assignmentCoverage =
    summary.active_tasks > 0
      ? round1((summary.assigned_tasks / summary.active_tasks) * 100)
      : null;

  return {
    status: optimization.status,
    generated_at: optimization.generated_at,
    robot_utilization: summary.fleet_utilization,
    available_robots: summary.available_robots,
    busy_robots: summary.busy_robots,
    charging_robots: summary.charging_robots,
    low_battery_robots: summary.low_battery_robots,
    offline_robots: summary.offline_robots,
    unavailable_robots: summary.unavailable_robots,
    total_robots: summary.total_robots,
    task_assignment_coverage: assignmentCoverage,
    active_tasks: summary.active_tasks,
    assigned_tasks: summary.assigned_tasks,
    unassigned_task_count: summary.unassigned_tasks,
    average_estimated_response_seconds: averageEstimatedResponseSeconds,
    average_estimated_response_minutes:
      averageEstimatedResponseSeconds === null
        ? null
        : round1(averageEstimatedResponseSeconds / 60),
    battery_risk_count: summary.battery_risk_count,
    charging_requirement_count: summary.charging_requirement_count,
    unassigned_reasons: unassigned.reduce((acc, item) => {
      acc[item.reason] = (acc[item.reason] || 0) + 1;
      return acc;
    }, {}),
    disclaimer: FLEET_DISCLAIMER
  };
}

// ------------------------------------------------------------
// Dashboard (additive)
// ------------------------------------------------------------

async function getDashboardSummary() {
  const optimization = await getFleetOptimization();
  const s = optimization.summary;
  return {
    totalRobots: s.total_robots,
    availableRobots: s.available_robots,
    busyRobots: s.busy_robots,
    chargingRobots: s.charging_robots,
    lowBatteryRobots: s.low_battery_robots,
    activeTasks: s.active_tasks,
    unassignedTasks: s.unassigned_tasks,
    recommendedAssignments: s.recommended_assignments,
    fleetUtilization: s.fleet_utilization,
    status: optimization.status
  };
}

// ------------------------------------------------------------
// Live emission — fleetOptimizationUpdate, only on meaningful change
// ------------------------------------------------------------

let lastSignature = null;

/**
 * Signature captures recommendation-relevant state only (never the
 * raw per-tick battery value), so the event is not emitted on every
 * 5 s loop when nothing meaningful changed.
 */
function buildSignature(optimization) {
  // NOTE: the raw per-tick battery value is deliberately excluded —
  // it changes every 5 s as robots drain/charge and would spam the
  // event. Availability state changes capture the meaningful shift.
  const robotSig = optimization.robots
    .map(
      (r) =>
        `${r.robot_id}:${r.availability_state}:${r.charging_station_id ?? "-"}`
    )
    .join(",");

  const taskSig = optimization.tasks
    .map(
      (t) =>
        `${t.task_id}:${t.priority_score}:${t.recommended_robot_id ?? "-"}:${t.route_mode ?? "-"}:${t.status}`
    )
    .join(",");

  const s = optimization.summary;
  const summarySig = [
    optimization.status,
    s.active_tasks,
    s.assigned_tasks,
    s.unassigned_tasks,
    s.available_robots,
    s.charging_robots,
    s.low_battery_robots,
    s.charging_requirement_count
  ].join(":");

  return `${summarySig}|${robotSig}|${taskSig}`;
}

async function evaluateAndEmitFleetOptimization() {
  const optimization = await getFleetOptimization();
  const signature = buildSignature(optimization);

  if (signature === lastSignature) {
    return { emitted: false, optimization };
  }

  lastSignature = signature;
  socketHub.emit("fleetOptimizationUpdate", {
    status: optimization.status,
    summary: optimization.summary,
    tasks: optimization.tasks,
    recommendations: optimization.recommendations,
    robots: optimization.robots,
    unassigned: optimization.unassigned,
    generated_at: optimization.generated_at
  });

  return { emitted: true, optimization };
}

function resetFleetOptimizationRuntime() {
  lastSignature = null;
}

// ------------------------------------------------------------
// Exports
// ------------------------------------------------------------

module.exports = {
  // constants
  TICK_INTERVAL_MS,
  MIN_BATTERY_MISSION,
  CHARGE_PER_TICK,
  PRIORITY_WEIGHTS,
  AGE_RAMP_MINUTES,
  CANDIDATE_WEIGHTS,
  DISTANCE_FALLOFF,
  SEVERITY_SCORE,
  AVAILABILITY,
  ROUTE_MODE,
  FLEET_STATUS,
  FLEET_DISCLAIMER,
  // pure helpers
  clamp,
  round1,
  levelFromScore,
  severityScore,
  ageScore,
  operationalUrgencyScore,
  computeTaskPriority,
  computeCandidateScore,
  evaluateRouteMode,
  availabilityStateFor,
  // state + views
  getRobotStates,
  getTasks,
  evaluateCandidates,
  buildRecommendations,
  buildSummary,
  getFleetOptimization,
  getSummary,
  getRobots,
  getTasksView,
  getRecommendations,
  getTask,
  getAnalytics,
  getDashboardSummary,
  buildSignature,
  evaluateAndEmitFleetOptimization,
  resetFleetOptimizationRuntime
};
