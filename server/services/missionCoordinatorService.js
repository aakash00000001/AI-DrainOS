// ============================================================
// AI-DrainOS — Autonomous Mission Scheduling & Multi-Robot
// Coordination (Update #22)
//
// A COORDINATION layer that answers: given the real tasks and the
// real robots, which task matters most, which robot should take it,
// can it get there, and what conflicts/reassignments exist — across
// the whole fleet at once.
//
// HARD RULES (do not violate):
//  * missionEngine.js remains the AUTHORITATIVE mission dispatcher.
//    This layer never inserts a competing mission record. In
//    AUTONOMOUS mode it only ever calls missionEngine.dispatchMission
//    (which enforces the existing uniqueness/authority rules).
//  * It does NOT replace robotPathPlanningService, fleetOptimization
//    Service, incidentService, decisionEngine, floodRiskService,
//    floodForecastService, maintenancePredictionService,
//    drainVisionService or historicalIntelligenceService. It REUSES
//    the fleet optimizer's real robot/task state and route evaluator,
//    the Robot Path Planning estimators, and the AI Decision Engine's
//    aggregated signals.
//  * It never fabricates robots, tasks, battery, coordinates, ETAs,
//    route feasibility or priority signals. Missing data is reported
//    explicitly (INSUFFICIENT_DATA / NO_COORDINATES /
//    NO_FEASIBLE_ROUTE / ... ) and never invented.
//  * Deterministic + explainable: every score is a documented
//    weighted sum of real inputs and every assignment carries a
//    reason.
// ============================================================

const pool = require("../config/db");
const socketHub = require("./socketHub");
const robotPathPlanning = require("./robotPathPlanningService");
const fleetOptimizationService = require("./fleetOptimizationService");
const decisionEngine = require("./decisionEngine");
const missionEngine = require("./missionEngine");

// ------------------------------------------------------------
// Constants
// ------------------------------------------------------------

const MODES = {
  AUTONOMOUS_PLAN: "AUTONOMOUS_PLAN",
  ADVISORY_PLAN: "ADVISORY_PLAN"
};

const DEFAULT_MODE = MODES.ADVISORY_PLAN;

// Coordination priority weights (documented, deterministic).
//   AI decision 40% · incident severity 25% · flood risk 15% ·
//   forecast urgency 10% · maintenance/vision urgency 10%
// Unavailable signals are dropped and the remaining weights are
// renormalized — never fabricated.
const COORDINATION_WEIGHTS = {
  decision: 0.40,
  severity: 0.25,
  floodRisk: 0.15,
  forecast: 0.10,
  maintenanceVision: 0.10
};

// Candidate score budget (sums to 100):
//   distance 30 · battery sufficiency 25 · ETA 20 · availability 15 ·
//   route feasibility 10
const CANDIDATE_WEIGHTS = {
  distance: 30,
  battery: 25,
  eta: 20,
  availability: 15,
  feasibility: 10
};

// Reused primitive constants (single source of truth lives in the
// Robot Path Planning / Fleet Optimization services).
const MIN_BATTERY_MISSION = robotPathPlanning.MIN_BATTERY_MISSION;
const DISTANCE_FALLOFF = fleetOptimizationService.DISTANCE_FALLOFF;
const SEVERITY_SCORE = fleetOptimizationService.SEVERITY_SCORE;
const AGE_RAMP_MINUTES = fleetOptimizationService.AGE_RAMP_MINUTES;

const ROUTE_MODE = fleetOptimizationService.ROUTE_MODE;
const AVAILABILITY = fleetOptimizationService.AVAILABILITY;

// Coordination status states.
const COORDINATION_STATUS = {
  OK: "OK",
  NO_TASKS: "NO_TASKS",
  NO_ROBOTS: "NO_ROBOTS",
  NO_ELIGIBLE_ROBOT: "NO_ELIGIBLE_ROBOT",
  NO_FEASIBLE_ROUTE: "NO_FEASIBLE_ROUTE",
  NO_COORDINATES: "NO_COORDINATES",
  INSUFFICIENT_DATA: "INSUFFICIENT_DATA"
};

// Task assignment states.
const TASK_STATE = {
  PENDING: "PENDING",
  ASSIGNED: "ASSIGNED",
  UNASSIGNED: "UNASSIGNED",
  COMPLETED: "COMPLETED",
  REASSIGNMENT_REQUIRED: "REASSIGNMENT_REQUIRED"
};

// Explicit unassigned reasons (never hidden).
const UNASSIGNED_REASON = {
  NO_AVAILABLE_ROBOT: "NO_AVAILABLE_ROBOT",
  NO_FEASIBLE_ROUTE: "NO_FEASIBLE_ROUTE",
  INSUFFICIENT_BATTERY: "INSUFFICIENT_BATTERY",
  ALL_ROBOTS_BUSY: "ALL_ROBOTS_BUSY",
  NO_COORDINATES: "NO_COORDINATES",
  INSUFFICIENT_DATA: "INSUFFICIENT_DATA"
};

// Conflict types (explicit).
const CONFLICT_TYPE = {
  ROBOT_DOUBLE_ASSIGNED: "ROBOT_DOUBLE_ASSIGNED",
  DUPLICATE_ACTIVE_MISSION: "DUPLICATE_ACTIVE_MISSION",
  DUPLICATE_DRAIN_TASK: "DUPLICATE_DRAIN_TASK",
  ROBOT_CHARGING_WITH_MISSION: "ROBOT_CHARGING_WITH_MISSION",
  ROBOT_UNAVAILABLE_WITH_MISSION: "ROBOT_UNAVAILABLE_WITH_MISSION",
  LOW_BATTERY_WITH_MISSION: "LOW_BATTERY_WITH_MISSION",
  TASK_WITHOUT_COORDINATES: "TASK_WITHOUT_COORDINATES",
  ROBOT_WITHOUT_COORDINATES: "ROBOT_WITHOUT_COORDINATES"
};

// Reassignment reasons.
const REASSIGNMENT_REASON = {
  ROBOT_OFFLINE: "ROBOT_OFFLINE",
  ROBOT_UNAVAILABLE: "ROBOT_UNAVAILABLE",
  ROBOT_CHARGING: "ROBOT_CHARGING",
  BATTERY_INSUFFICIENT: "BATTERY_INSUFFICIENT",
  ROUTE_INFEASIBLE: "ROUTE_INFEASIBLE",
  MISSION_CANCELLED: "MISSION_CANCELLED"
};

const MISSION_STATUS = {
  ASSIGNED: "Assigned",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled"
};

const COORDINATION_DISCLAIMER =
  "Mission coordination is a planning layer. ADVISORY mode never mutates " +
  "missions. AUTONOMOUS mode only ever dispatches through the existing " +
  "missionEngine (the sole authority). Distances/times are coordinate-space " +
  "estimates derived from the existing movement-loop constants.";

// Bounded caches so repeated reads inside one tick do not hammer the DB.
const SIGNAL_CACHE_TTL_MS = 10000;
const SNAPSHOT_CACHE_TTL_MS = 4000;

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

function ageScore(ageSeconds) {
  const secs = asNumber(ageSeconds);
  if (secs === null) return null;
  return round1(clamp((secs / 60 / AGE_RAMP_MINUTES) * 100, 0, 100));
}

/**
 * Coordination task priority (0-100), intentionally SEPARATE from the
 * existing AI Decision score.
 *
 *   decision            40%
 *   severity            25%
 *   flood risk          15%
 *   forecast urgency    10%
 *   maintenance/vision  10%
 *
 * Only real, available signals are used. When some are missing the
 * remaining weights are renormalized (status "RENORMALIZED"). When no
 * signal at all is available the priority is null with status
 * INSUFFICIENT_DATA — never fabricated.
 */
function computeCoordinationPriority({
  decisionScore,
  severity,
  floodRiskScore,
  forecastScore,
  maintenanceScore,
  visionScore
} = {}) {
  const signals = [];

  const decision = asNumber(decisionScore);
  if (decision !== null) {
    signals.push({ key: "decision", value: clamp(decision, 0, 100), weight: COORDINATION_WEIGHTS.decision });
  }

  const sev = asNumber(severityScore(severity));
  if (severity !== null && severity !== undefined && sev !== null && SEVERITY_SCORE[normalizeUpper(severity)] !== undefined) {
    signals.push({ key: "severity", value: sev, weight: COORDINATION_WEIGHTS.severity });
  }

  const flood = asNumber(floodRiskScore);
  if (flood !== null) {
    signals.push({ key: "flood_risk", value: clamp(flood, 0, 100), weight: COORDINATION_WEIGHTS.floodRisk });
  }

  const forecast = asNumber(forecastScore);
  if (forecast !== null) {
    signals.push({ key: "forecast", value: clamp(forecast, 0, 100), weight: COORDINATION_WEIGHTS.forecast });
  }

  const maintenance = asNumber(maintenanceScore);
  const vision = asNumber(visionScore);
  const mv = maintenance === null && vision === null ? null : Math.max(maintenance ?? 0, vision ?? 0);
  if (mv !== null) {
    signals.push({ key: "maintenance_vision", value: clamp(mv, 0, 100), weight: COORDINATION_WEIGHTS.maintenanceVision });
  }

  const totalWeight = signals.reduce((sum, s) => sum + s.weight, 0);

  if (totalWeight <= 0) {
    return {
      priority_score: null,
      priority_status: COORDINATION_STATUS.INSUFFICIENT_DATA,
      priority_breakdown: {}
    };
  }

  const weighted = signals.reduce((sum, s) => sum + s.value * (s.weight / totalWeight), 0);

  const breakdown = {};
  for (const s of signals) breakdown[s.key] = round1(s.value);

  const fullWeight = signals.reduce((sum, s) => {
    const weightKey =
      s.key === "flood_risk" ? "floodRisk" : s.key === "maintenance_vision" ? "maintenanceVision" : s.key;
    return sum + (COORDINATION_WEIGHTS[weightKey] || 0);
  }, 0);

  return {
    priority_score: round1(clamp(weighted, 0, 100)),
    priority_status: fullWeight >= 0.999 ? "OK" : "RENORMALIZED",
    priority_breakdown: breakdown
  };
}

/**
 * Candidate score (0-100) using the documented coordination budget:
 *   distance (closer better) 30 · battery 25 · ETA (faster) 20 ·
 *   availability 15 · route feasibility 10
 * Returns a null score for ineligible candidates.
 */
function computeCandidateScore({ distance, batteryLevel, travelSeconds, eligible }) {
  if (!eligible) {
    return { candidate_score: null, candidate_components: null };
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
    candidate_components: {
      distance: round1(distanceScore),
      battery: round1(batteryScore),
      eta: round1(etaScore),
      availability: CANDIDATE_WEIGHTS.availability,
      feasibility: CANDIDATE_WEIGHTS.feasibility
    }
  };
}

// ------------------------------------------------------------
// Real signal bundle per drain (reuses the AI Decision Engine's
// aggregated contributing factors — no duplicated formula).
// ------------------------------------------------------------

const signalCache = new Map();

async function getDrainSignals(drainId, { force = false } = {}) {
  const id = Number(drainId);
  if (!Number.isInteger(id) || id <= 0) {
    return emptySignals();
  }

  const cached = signalCache.get(id);
  if (!force && cached && Date.now() - cached.at < SIGNAL_CACHE_TTL_MS) {
    return cached.data;
  }

  let data = emptySignals();

  try {
    const decision = await decisionEngine.getDrainDecision(id);
    if (decision) {
      const byKey = {};
      for (const factor of decision.contributingFactors || []) {
        byKey[factor.key] = asNumber(factor.value);
      }

      data = {
        decision_score: asNumber(decision.priorityScore),
        decision_level: decision.priorityLevel || null,
        flood_risk_score: byKey.floodRisk ?? null,
        forecast_score: byKey.forecast ?? null,
        maintenance_score: byKey.maintenance ?? null,
        vision_score: byKey.vision ?? null,
        // Additive sensor-quality context (Update #21). Carried from the
        // decision engine's own additive sensorIntelligence context (no
        // extra queries). Descriptive only - it never changes priority or
        // assignment and never dispatches a robot.
        sensor_quality: decision.sensorIntelligence
          ? {
              health_status: decision.sensorIntelligence.healthStatus,
              average_health_score: decision.sensorIntelligence.averageHealthScore,
              total_sensors: decision.sensorIntelligence.totalSensors,
              anomaly_count: decision.sensorIntelligence.anomalyCount,
              stale: decision.sensorIntelligence.staleCount,
              missing_data: decision.sensorIntelligence.missingDataCount,
              cross_sensor_consistency: decision.sensorIntelligence.crossSensorConsistency
            }
          : null,
        available: {
          decision: asNumber(decision.priorityScore) !== null,
          flood_risk: byKey.floodRisk !== undefined,
          forecast: byKey.forecast !== undefined,
          maintenance: byKey.maintenance !== undefined,
          vision: byKey.vision !== undefined
        }
      };
    }
  } catch (err) {
    console.log(`⚠️ Mission coordinator: signals unavailable for drain ${id}:`, err.message);
  }

  signalCache.set(id, { at: Date.now(), data });
  return data;
}

function emptySignals() {
  return {
    decision_score: null,
    decision_level: null,
    flood_risk_score: null,
    forecast_score: null,
    maintenance_score: null,
    vision_score: null,
    sensor_quality: null,
    available: {
      decision: false,
      flood_risk: false,
      forecast: false,
      maintenance: false,
      vision: false
    }
  };
}

// ------------------------------------------------------------
// Base state snapshot (reuses the fleet optimizer + one bounded query)
// ------------------------------------------------------------

let snapshotCache = { at: 0, data: null };

async function getCoordinationSnapshot({ force = false } = {}) {
  if (!force && snapshotCache.data && Date.now() - snapshotCache.at < SNAPSHOT_CACHE_TTL_MS) {
    return snapshotCache.data;
  }

  const [fleet, stationResult, missionResult] = await Promise.all([
    fleetOptimizationService.getFleetOptimization(),
    pool.query("SELECT id, station_name, latitude, longitude FROM charging_stations ORDER BY id ASC"),
    pool.query(
      `
      SELECT m.id, m.robot_id, m.drain_id, m.assigned_time
      FROM missions m
      WHERE m.mission_status = 'Assigned'
      ORDER BY m.id ASC
      `
    )
  ]);

  const stations = stationResult.rows.map((row) => ({
    id: Number(row.id),
    station_name: row.station_name,
    latitude: asNumber(row.latitude),
    longitude: asNumber(row.longitude)
  }));

  const activeMissions = missionResult.rows.map((row) => ({
    mission_id: Number(row.id),
    robot_id: row.robot_id === null ? null : Number(row.robot_id),
    drain_id: row.drain_id === null ? null : Number(row.drain_id),
    assigned_time: row.assigned_time
  }));

  const missionByRobot = new Map();
  const missionByDrain = new Map();
  for (const mission of activeMissions) {
    if (mission.robot_id !== null) missionByRobot.set(mission.robot_id, mission);
    if (mission.drain_id !== null) missionByDrain.set(mission.drain_id, mission);
  }

  const data = { fleet, stations, activeMissions, missionByRobot, missionByDrain, generated_at: nowIso() };
  snapshotCache = { at: Date.now(), data };
  return data;
}

// ------------------------------------------------------------
// Task queue (real records only)
// ------------------------------------------------------------

async function getCreatedAtMaps(tasks) {
  const incidentIds = tasks.filter((t) => t.incident_id !== null).map((t) => t.incident_id);
  const drainIds = [...new Set(tasks.map((t) => t.drain_id))];

  const [incidentRows, drainRows] = await Promise.all([
    incidentIds.length > 0
      ? pool.query("SELECT id, created_at FROM incidents WHERE id = ANY($1::int[])", [incidentIds])
      : Promise.resolve({ rows: [] }),
    drainIds.length > 0
      ? pool.query("SELECT id, created_at FROM drains WHERE id = ANY($1::int[])", [drainIds])
      : Promise.resolve({ rows: [] })
  ]);

  const incidentMap = new Map(incidentRows.rows.map((r) => [Number(r.id), r.created_at]));
  const drainMap = new Map(drainRows.rows.map((r) => [Number(r.id), r.created_at]));
  return { incidentMap, drainMap };
}

/**
 * Build the live coordination task queue from REAL active incidents,
 * critical/warning drains and active missions. No duplicate task is
 * created for the same active incident/drain.
 */
async function getTaskQueue({ force = false } = {}) {
  const snapshot = await getCoordinationSnapshot({ force });
  const { fleet, missionByDrain } = snapshot;
  const baseTasks = fleet.tasks || [];

  const { incidentMap, drainMap } = await getCreatedAtMaps(baseTasks);

  // Unique drains -> signals (bounded, cached).
  const uniqueDrainIds = [...new Set(baseTasks.map((t) => t.drain_id))];
  const signalsByDrain = new Map();
  await Promise.all(
    uniqueDrainIds.map(async (drainId) => {
      signalsByDrain.set(drainId, await getDrainSignals(drainId, { force }));
    })
  );

  const seenDrains = new Set();
  const tasks = [];
  const nowMs = Date.now();

  for (const base of baseTasks) {
    if (seenDrains.has(base.drain_id)) continue; // one task per drain
    seenDrains.add(base.drain_id);

    const signals = signalsByDrain.get(base.drain_id) || emptySignals();
    const decisionScore = base.decision_score !== null && base.decision_score !== undefined
      ? base.decision_score
      : signals.decision_score;

    const priority = computeCoordinationPriority({
      decisionScore,
      severity: base.severity,
      floodRiskScore: signals.flood_risk_score,
      forecastScore: signals.forecast_score,
      maintenanceScore: signals.maintenance_score,
      visionScore: signals.vision_score
    });

    const createdAt =
      base.incident_id !== null
        ? incidentMap.get(base.incident_id) || null
        : drainMap.get(base.drain_id) || null;

    const activeMission = missionByDrain.get(base.drain_id) || null;

    tasks.push({
      task_id: base.task_id,
      drain_id: base.drain_id,
      incident_id: base.incident_id,
      source: base.source,
      severity: base.severity,
      priority_score: priority.priority_score,
      priority_status: priority.priority_status,
      priority_breakdown: priority.priority_breakdown,
      estimated_urgency: levelFromScore(priority.priority_score),
      decision_score: asNumber(decisionScore),
      decision_level: signals.decision_level,
      // Additive sensor-quality context (Update #21) - descriptive only.
      sensor_quality: signals.sensor_quality,
      signals: {
        decision: signals.available.decision || decisionScore != null,
        flood_risk: signals.available.flood_risk,
        forecast: signals.available.forecast,
        maintenance_vision:
          signals.available.maintenance || signals.available.vision
      },
      status: base.status,
      current_state: activeMission ? TASK_STATE.ASSIGNED : TASK_STATE.PENDING,
      assignment_status: activeMission ? TASK_STATE.ASSIGNED : TASK_STATE.PENDING,
      assigned_robot_id: activeMission ? activeMission.robot_id : null,
      active_mission_id: activeMission ? activeMission.mission_id : null,
      route_required: true,
      zone: base.zone,
      location: base.location,
      latitude: base.latitude,
      longitude: base.longitude,
      created_at: createdAt,
      age_seconds: secondsBetween(createdAt, nowMs)
    });
  }

  // Deterministic order by priority desc, then task_id.
  tasks.sort((a, b) => {
    const pa = a.priority_score === null ? -1 : a.priority_score;
    const pb = b.priority_score === null ? -1 : b.priority_score;
    if (pb !== pa) return pb - pa;
    return String(a.task_id).localeCompare(String(b.task_id));
  });

  return { tasks, snapshot };
}

// ------------------------------------------------------------
// Robot eligibility + candidate scoring
// ------------------------------------------------------------

function nearestStation(latitude, longitude, stations) {
  if (latitude === null || longitude === null) return null;
  let best = null;
  let bestDistance = Infinity;
  for (const station of stations) {
    if (station.latitude === null || station.longitude === null) continue;
    const dist = robotPathPlanning.coordinateDistance(latitude, longitude, station.latitude, station.longitude);
    if (dist !== null && dist < bestDistance) {
      bestDistance = dist;
      best = station;
    }
  }
  return best;
}

/**
 * Evaluate one robot against one task. Returns eligibility, the
 * battery-aware route evaluation (reused from the fleet optimizer)
 * and the explainable candidate score. Never fabricates.
 */
function evaluateRobotForTask(task, robot, stations) {
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
  const taskCoordsOk = task.latitude !== null && task.longitude !== null;

  if (!robotCoordsOk) {
    eligible = false;
    warnings.push("Robot location unavailable");
  }
  if (!taskCoordsOk) {
    eligible = false;
    warnings.push("Task has no coordinates");
  }

  let route;
  if (!robotCoordsOk || !taskCoordsOk) {
    route = fleetOptimizationService.evaluateRouteMode({
      robotBattery: robot.battery_level,
      robotLatitude: robotCoordsOk ? robot.latitude : null,
      robotLongitude: robotCoordsOk ? robot.longitude : null,
      taskLatitude: taskCoordsOk ? task.latitude : null,
      taskLongitude: taskCoordsOk ? task.longitude : null,
      chargingStation: null
    });
  } else {
    const station = nearestStation(robot.latitude, robot.longitude, stations);
    route = fleetOptimizationService.evaluateRouteMode({
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

  const { candidate_score, candidate_components } = computeCandidateScore({
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
    candidate_components,
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
    warnings,
    rejection_reason: eligible ? null : deriveRejectionReason(route, robot, task)
  };
}

function deriveRejectionReason(route, robot, task) {
  if (task.latitude === null || task.longitude === null) return UNASSIGNED_REASON.NO_COORDINATES;
  if (robot.latitude === null || robot.longitude === null) return UNASSIGNED_REASON.NO_COORDINATES;
  if (robot.battery_level === null) return UNASSIGNED_REASON.INSUFFICIENT_DATA;
  if (robot.availability_state === AVAILABILITY.LOW_BATTERY) return UNASSIGNED_REASON.INSUFFICIENT_BATTERY;
  if (route.route_mode === ROUTE_MODE.NO_FEASIBLE_ROUTE) {
    return route.reason === "BATTERY_INSUFFICIENT"
      ? UNASSIGNED_REASON.INSUFFICIENT_BATTERY
      : UNASSIGNED_REASON.NO_FEASIBLE_ROUTE;
  }
  return UNASSIGNED_REASON.NO_AVAILABLE_ROBOT;
}

function sortCandidates(candidates) {
  return [...candidates].sort((a, b) => {
    const sa = a.candidate_score === null ? -1 : a.candidate_score;
    const sb = b.candidate_score === null ? -1 : b.candidate_score;
    if (sb !== sa) return sb - sa;
    return a.robot_id - b.robot_id; // deterministic tie-break
  });
}

/**
 * scoreRobotForTask(task, robot) — explainable candidate score.
 * `third` may be the stations array (defaults to []).
 */
function scoreRobotForTask(task, robot, stations = []) {
  return evaluateRobotForTask(task, robot, stations);
}

/**
 * Robot eligibility view for the whole fleet (real state only).
 */
async function getEligibleRobots({ force = false } = {}) {
  const snapshot = await getCoordinationSnapshot({ force });
  const robots = (snapshot.fleet.robots || []).map((robot) => ({
    robot_id: robot.robot_id,
    robot_name: robot.robot_name,
    status: robot.status,
    availability_state: robot.availability_state,
    battery_level: robot.battery_level,
    latitude: robot.latitude,
    longitude: robot.longitude,
    current_mission_id: robot.current_mission_id,
    target_drain_id: robot.target_drain_id,
    charging_station_id: robot.charging_station_id,
    eligible: robot.availability_state === AVAILABILITY.AVAILABLE,
    reasons: [robot.estimated_available_reason || `State: ${robot.availability_state}`]
  }));

  return {
    status: robots.length === 0 ? COORDINATION_STATUS.NO_ROBOTS : COORDINATION_STATUS.OK,
    generated_at: nowIso(),
    robots
  };
}

/**
 * Per-task candidate evaluation (used by the plan + exposed for the
 * Task–Robot Matching section).
 */
async function getTaskCandidates(taskId, { force = false } = {}) {
  const { tasks, snapshot } = await getTaskQueue({ force });
  const task = tasks.find((t) => t.task_id === taskId) || null;
  if (!task) return null;

  const candidates = sortCandidates(
    snapshot.fleet.robots.map((robot) => evaluateRobotForTask(task, robot, snapshot.stations))
  );

  return {
    generated_at: nowIso(),
    task,
    candidates,
    eligible_robot_ids: candidates.filter((c) => c.eligible).map((c) => c.robot_id)
  };
}

// ------------------------------------------------------------
// Conflict detection (explicit, never silently overwritten)
// ------------------------------------------------------------

async function detectConflicts(tasks, robots, activeMissions) {
  const conflicts = [];

  // Data-integrity conflicts straight from the missions table.
  const [robotDup, drainDup] = await Promise.all([
    pool.query(
      `
      SELECT robot_id, COUNT(*) AS c
      FROM missions
      WHERE mission_status = 'Assigned'
      GROUP BY robot_id
      HAVING COUNT(*) > 1
      `
    ),
    pool.query(
      `
      SELECT drain_id, COUNT(*) AS c
      FROM missions
      WHERE mission_status = 'Assigned'
      GROUP BY drain_id
      HAVING COUNT(*) > 1
      `
    )
  ]);

  for (const row of robotDup.rows) {
    conflicts.push({
      type: CONFLICT_TYPE.ROBOT_DOUBLE_ASSIGNED,
      severity: "CRITICAL",
      robot_id: Number(row.robot_id),
      drain_id: null,
      task_id: null,
      message: `Robot ${row.robot_id} has ${row.c} simultaneous Assigned missions`,
      required_action: "Resolve duplicate missions before coordination."
    });
  }

  for (const row of drainDup.rows) {
    conflicts.push({
      type: CONFLICT_TYPE.DUPLICATE_ACTIVE_MISSION,
      severity: "HIGH",
      robot_id: null,
      drain_id: Number(row.drain_id),
      task_id: null,
      message: `Drain ${row.drain_id} has ${row.c} simultaneous Assigned missions`,
      required_action: "Resolve duplicate missions before coordination."
    });
  }

  // Robots on a mission that cannot safely continue.
  const missionByRobot = new Map();
  for (const mission of activeMissions) {
    if (mission.robot_id !== null) missionByRobot.set(mission.robot_id, mission);
  }

  for (const robot of robots) {
    const mission = missionByRobot.get(robot.robot_id);
    if (!mission) continue;

    if (robot.status === "Charging") {
      conflicts.push({
        type: CONFLICT_TYPE.ROBOT_CHARGING_WITH_MISSION,
        severity: "HIGH",
        robot_id: robot.robot_id,
        drain_id: mission.drain_id,
        task_id: null,
        message: `${robot.robot_name} is Charging while holding an Assigned mission`,
        required_action: "Reassign or wait for charging to complete."
      });
    } else if (robot.status === "Offline" || robot.status === "Maintenance") {
      conflicts.push({
        type: CONFLICT_TYPE.ROBOT_UNAVAILABLE_WITH_MISSION,
        severity: "HIGH",
        robot_id: robot.robot_id,
        drain_id: mission.drain_id,
        task_id: null,
        message: `${robot.robot_name} is ${robot.status} while holding an Assigned mission`,
        required_action: "Reassign the mission to an available robot."
      });
    } else if (robot.battery_level !== null && robot.battery_level <= MIN_BATTERY_MISSION) {
      conflicts.push({
        type: CONFLICT_TYPE.LOW_BATTERY_WITH_MISSION,
        severity: "MODERATE",
        robot_id: robot.robot_id,
        drain_id: mission.drain_id,
        task_id: null,
        message: `${robot.robot_name} is at ${robot.battery_level}% (below the ${MIN_BATTERY_MISSION}% reserve) on an Assigned mission`,
        required_action: "Plan a charging stop or reassignment."
      });
    }
  }

  // Queue conflicts.
  const seenDrains = new Set();
  for (const task of tasks) {
    if (seenDrains.has(task.drain_id)) {
      conflicts.push({
        type: CONFLICT_TYPE.DUPLICATE_DRAIN_TASK,
        severity: "MODERATE",
        robot_id: null,
        drain_id: task.drain_id,
        task_id: task.task_id,
        message: `Duplicate coordination task for drain ${task.drain_id}`,
        required_action: "Deduplicate the task queue."
      });
    }
    seenDrains.add(task.drain_id);

    if (task.latitude === null || task.longitude === null) {
      conflicts.push({
        type: CONFLICT_TYPE.TASK_WITHOUT_COORDINATES,
        severity: "MODERATE",
        robot_id: null,
        drain_id: task.drain_id,
        task_id: task.task_id,
        message: `Task ${task.task_id} has no drain coordinates`,
        required_action: `Add latitude/longitude for drain ${task.drain_id}.`
      });
    }
  }

  for (const robot of robots) {
    if (
      (robot.latitude === null || robot.longitude === null) &&
      robot.availability_state === AVAILABILITY.AVAILABLE
    ) {
      conflicts.push({
        type: CONFLICT_TYPE.ROBOT_WITHOUT_COORDINATES,
        severity: "MODERATE",
        robot_id: robot.robot_id,
        drain_id: null,
        task_id: null,
        message: `${robot.robot_name} has no location but is marked available`,
        required_action: "Set the robot's latitude/longitude."
      });
    }
  }

  return conflicts;
}

async function getMissionConflicts({ force = false } = {}) {
  const { tasks, snapshot } = await getTaskQueue({ force });
  const conflicts = await detectConflicts(tasks, snapshot.fleet.robots, snapshot.activeMissions);

  return {
    status: conflicts.length > 0 ? "CONFLICTS_FOUND" : "OK",
    generated_at: nowIso(),
    conflicts
  };
}

// ------------------------------------------------------------
// Reassignment planning (advisory — never mutates)
// ------------------------------------------------------------

function reassignmentReasonFor(robot) {
  if (robot.status === "Offline") return REASSIGNMENT_REASON.ROBOT_OFFLINE;
  if (robot.status === "Maintenance") return REASSIGNMENT_REASON.ROBOT_UNAVAILABLE;
  if (robot.status === "Charging") return REASSIGNMENT_REASON.ROBOT_CHARGING;
  if (robot.battery_level !== null && robot.battery_level <= MIN_BATTERY_MISSION) {
    return REASSIGNMENT_REASON.BATTERY_INSUFFICIENT;
  }
  if (robot.latitude === null || robot.longitude === null) return REASSIGNMENT_REASON.ROUTE_INFEASIBLE;
  return null;
}

/**
 * For every active mission whose robot can no longer safely serve it,
 * recommend REASSIGNMENT_REQUIRED plus the best eligible replacement.
 * The actual mutation must go through the existing mission authority.
 */
async function getReassignmentPlan({ force = false } = {}) {
  const { tasks, snapshot } = await getTaskQueue({ force });
  const { fleet, activeMissions, stations, missionByDrain } = snapshot;

  const reserved = new Set(
    (fleet.robots || [])
      .filter((r) => r.availability_state === AVAILABILITY.AVAILABLE)
      .map((r) => r.robot_id)
  );

  const reassignments = [];
  const taskByDrain = new Map(tasks.map((t) => [t.drain_id, t]));

  for (const mission of activeMissions) {
    if (mission.robot_id === null) continue;
    const robot = (fleet.robots || []).find((r) => r.robot_id === mission.robot_id);
    if (!robot) continue;

    const reason = reassignmentReasonFor(robot);
    if (!reason) continue;

    const task = mission.drain_id !== null ? taskByDrain.get(mission.drain_id) || null : null;

    // Best replacement: an AVAILABLE robot that is not the current one,
    // is not needed for a higher-priority pending task, and can reach it.
    let replacement = null;
    if (task) {
      const candidates = sortCandidates(
        (fleet.robots || [])
          .filter((r) => r.robot_id !== robot.robot_id)
          .map((r) => evaluateRobotForTask(task, r, stations))
      ).filter((c) => c.eligible);

      const chosen = candidates[0] || null;
      if (chosen) {
        replacement = {
          robot_id: chosen.robot_id,
          robot_name: chosen.robot_name,
          candidate_score: chosen.candidate_score,
          route_mode: chosen.route_mode,
          estimated_travel_time: chosen.estimated_travel_time,
          battery_after: chosen.battery_after
        };
      }
    }

    reassignments.push({
      requirement: TASK_STATE.REASSIGNMENT_REQUIRED,
      reason,
      mission_id: mission.mission_id,
      drain_id: mission.drain_id,
      task_id: task ? task.task_id : null,
      current_robot_id: robot.robot_id,
      current_robot_name: robot.robot_name,
      current_status: robot.status,
      battery_level: robot.battery_level,
      recommended_replacement: replacement,
      required_action: replacement
        ? `Reassign mission ${mission.mission_id} to ${replacement.robot_name} via the existing mission API.`
        : "No eligible replacement robot is currently available."
    });
  }

  // Also flag pending/unassigned tasks that have no reachable robot.
  return { reassignments, reserved, taskByDrain };
}

// ------------------------------------------------------------
// Multi-robot scheduling (deterministic greedy reservation)
// ------------------------------------------------------------

function explainAssignment(robot, task, competition) {
  const where = task.location || task.zone || `drain ${task.drain_id}`;
  const routePhrase =
    competition.route_mode === ROUTE_MODE.DIRECT
      ? "has sufficient battery for a direct route"
      : "can reach the task via a charging stop";
  const eta =
    competition.estimated_travel_time !== null
      ? ` (ETA ~${robotPathPlanning.formatDuration(competition.estimated_travel_time)})`
      : "";
  return (
    `${robot.robot_name} selected for the ${task.severity} task at ${where} ` +
    `(priority ${task.priority_score ?? "n/a"}/100): ${routePhrase}${eta}, ` +
    `highest candidate score among available robots.`
  );
}

function unassignedReasonFor(task, candidates, robots, reservedIds) {
  if (robots.length === 0) return UNASSIGNED_REASON.NO_AVAILABLE_ROBOT;
  if (task.latitude === null || task.longitude === null) return UNASSIGNED_REASON.NO_COORDINATES;

  const eligible = candidates.filter((c) => c.eligible);
  if (eligible.length === 0) {
    if (candidates.length > 0 && candidates.every((c) => c.rejection_reason === UNASSIGNED_REASON.INSUFFICIENT_BATTERY)) {
      return UNASSIGNED_REASON.INSUFFICIENT_BATTERY;
    }
    return UNASSIGNED_REASON.NO_FEASIBLE_ROUTE;
  }

  const freeEligible = eligible.filter((c) => !reservedIds.has(c.robot_id));
  if (freeEligible.length === 0) return UNASSIGNED_REASON.ALL_ROBOTS_BUSY;

  return UNASSIGNED_REASON.NO_AVAILABLE_ROBOT;
}

function requiredActionFor(reason, task) {
  switch (reason) {
    case UNASSIGNED_REASON.NO_AVAILABLE_ROBOT:
      return "Register a robot or bring an offline unit online.";
    case UNASSIGNED_REASON.NO_COORDINATES:
      return `Add valid latitude/longitude to drain ${task ? task.drain_id : ""}.`;
    case UNASSIGNED_REASON.NO_FEASIBLE_ROUTE:
      return "Charge an available robot or reposition a unit closer to the task.";
    case UNASSIGNED_REASON.INSUFFICIENT_BATTERY:
      return "Charge a robot or add a closer charging station.";
    case UNASSIGNED_REASON.ALL_ROBOTS_BUSY:
      return "Wait for a running mission to complete or add capacity.";
    default:
      return "Manual review required.";
  }
}

/**
 * Deterministic multi-task / multi-robot coordination plan.
 * A robot is reserved for at most ONE task. Advisory by default.
 */
async function buildCoordinationPlan({ mode = DEFAULT_MODE, force = false } = {}) {
  const { tasks, snapshot } = await getTaskQueue({ force });
  const { fleet, stations, activeMissions } = snapshot;
  const robots = fleet.robots || [];

  const reservedIds = new Set();
  const assignments = [];
  const unassigned = [];
  const taskResults = [];

  for (const task of tasks) {
    // Already assigned — never overwrite an existing mission.
    if (task.assignment_status === TASK_STATE.ASSIGNED) {
      taskResults.push({
        ...task,
        coordination_state: TASK_STATE.ASSIGNED,
        candidate_robot_id: null,
        unassigned_reason: null
      });
      continue;
    }

    const candidates = sortCandidates(
      robots.map((robot) => evaluateRobotForTask(task, robot, stations))
    );

    const eligible = candidates.filter((c) => c.eligible);
    const free = eligible.filter((c) => !reservedIds.has(c.robot_id));

    if (free.length === 0) {
      const reason = unassignedReasonFor(task, candidates, robots, reservedIds);
      unassigned.push({
        task_id: task.task_id,
        incident_id: task.incident_id,
        drain_id: task.drain_id,
        severity: task.severity,
        priority_score: task.priority_score,
        status: task.status,
        reason,
        required_action: requiredActionFor(reason, task)
      });
      taskResults.push({
        ...task,
        coordination_state: TASK_STATE.UNASSIGNED,
        candidate_robot_id: null,
        unassigned_reason: reason,
        candidate_count: candidates.length,
        eligible_count: eligible.length
      });
      continue;
    }

    // Deterministic: highest candidate score, then lowest robot id.
    const chosen = free[0];
    reservedIds.add(chosen.robot_id);

    assignments.push({
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
      explanation: explainAssignment(
        robots.find((r) => r.robot_id === chosen.robot_id) || chosen,
        task,
        chosen
      ),
      alternatives: free.slice(1).map((c) => ({
        robot_id: c.robot_id,
        robot_name: c.robot_name,
        candidate_score: c.candidate_score,
        route_mode: c.route_mode,
        estimated_travel_time: c.estimated_travel_time,
        charging_required: c.charging_required
      }))
    });

    taskResults.push({
      ...task,
      coordination_state: TASK_STATE.ASSIGNED,
      candidate_robot_id: chosen.robot_id,
      assigned_robot_id: chosen.robot_id,
      candidate_score: chosen.candidate_score,
      route_mode: chosen.route_mode,
      estimated_travel_time: chosen.estimated_travel_time,
      unassigned_reason: null,
      explanation: explainAssignment(robots.find((r) => r.robot_id === chosen.robot_id) || chosen, task, chosen)
    });
  }

  const conflicts = await detectConflicts(tasks, robots, activeMissions);
  const { reassignments } = await getReassignmentPlan({ force });
  const summary = buildSummary(robots, tasks, assignments, unassigned, conflicts, reassignments);
  const status = buildGlobalStatus(robots, tasks, assignments, unassigned);

  return {
    status,
    mode,
    generated_at: nowIso(),
    summary,
    tasks: taskResults,
    assignments,
    unassigned,
    conflicts,
    reassignment_required: reassignments,
    robot_availability: robots.map((r) => ({
      robot_id: r.robot_id,
      robot_name: r.robot_name,
      availability_state: r.availability_state,
      battery_level: r.battery_level,
      current_mission_id: r.current_mission_id,
      target_drain_id: r.target_drain_id
    })),
    warnings: buildWarnings(robots, tasks, unassigned, assignments, reassignments),
    disclaimer: COORDINATION_DISCLAIMER
  };
}

function buildGlobalStatus(robots, tasks, assignments, unassigned) {
  if (robots.length === 0) return COORDINATION_STATUS.NO_ROBOTS;
  if (tasks.length === 0) return COORDINATION_STATUS.NO_TASKS;
  if (assignments.length > 0) return COORDINATION_STATUS.OK;
  if (unassigned.some((u) => u.reason === UNASSIGNED_REASON.NO_COORDINATES)) {
    return COORDINATION_STATUS.NO_COORDINATES;
  }
  if (unassigned.some((u) => u.reason === UNASSIGNED_REASON.NO_FEASIBLE_ROUTE)) {
    return COORDINATION_STATUS.NO_FEASIBLE_ROUTE;
  }
  return COORDINATION_STATUS.NO_ELIGIBLE_ROBOT;
}

function buildSummary(robots, tasks, assignments, unassigned, conflicts, reassignments) {
  const count = (state) => robots.filter((r) => r.availability_state === state).length;
  const pending = tasks.filter((t) => t.assignment_status !== TASK_STATE.ASSIGNED).length;

  return {
    total_tasks: tasks.length,
    pending_tasks: pending,
    assigned_tasks: assignments.length,
    already_assigned_tasks: tasks.filter((t) => t.assignment_status === TASK_STATE.ASSIGNED).length,
    unassigned_tasks: unassigned.length,
    total_robots: robots.length,
    available_robots: count(AVAILABILITY.AVAILABLE),
    busy_robots: count(AVAILABILITY.BUSY),
    charging_robots: count(AVAILABILITY.CHARGING),
    low_battery_robots: count(AVAILABILITY.LOW_BATTERY),
    offline_robots: count(AVAILABILITY.OFFLINE),
    coordination_conflicts: conflicts.length,
    reassignment_required: reassignments.length
  };
}

function buildWarnings(robots, tasks, unassigned, assignments, reassignments) {
  const warnings = [];

  if (unassigned.length > 0) {
    warnings.push(`${unassigned.length} task(s) could not be scheduled to any eligible robot.`);
  }
  if (reassignments.length > 0) {
    warnings.push(`${reassignments.length} active mission(s) require reassignment.`);
  }
  const chargingStops = assignments.filter((a) => a.charging_required);
  if (chargingStops.length > 0) {
    warnings.push(`${chargingStops.length} assignment(s) require a charging stop before the task.`);
  }
  const noCoords = tasks.filter((t) => t.latitude === null || t.longitude === null);
  if (noCoords.length > 0) {
    warnings.push(`${noCoords.length} task(s) have no drain coordinates.`);
  }

  return warnings;
}

// ------------------------------------------------------------
// Autonomous execution — ONLY through the existing missionEngine
// ------------------------------------------------------------

/**
 * Execute a coordination plan's assignments via
 * missionEngine.dispatchMission (the authoritative dispatcher). This
 * never inserts a mission directly. Each dispatch is guarded: failures
 * (robot busy, drain already assigned, offline) are reported honestly
 * and never overwrite an existing mission.
 */
async function applyAutonomousPlan(plan) {
  const executed = [];
  const failed = [];

  for (const assignment of plan.assignments || []) {
    try {
      const result = await missionEngine.dispatchMission(assignment.robot_id, assignment.drain_id);
      executed.push({
        task_id: assignment.task_id,
        drain_id: assignment.drain_id,
        robot_id: assignment.robot_id,
        mission_id: result.mission.id,
        route_mode: assignment.route_mode
      });
    } catch (err) {
      failed.push({
        task_id: assignment.task_id,
        drain_id: assignment.drain_id,
        robot_id: assignment.robot_id,
        error: err.message
      });
    }
  }

  // The real state changed — drop caches so the next read is honest.
  resetCoordinationRuntime();

  return { executed, failed };
}

/**
 * Plan + (in AUTONOMOUS mode only) dispatch through missionEngine.
 */
async function coordinate({ mode = DEFAULT_MODE, force = false } = {}) {
  const plan = await buildCoordinationPlan({ mode, force });

  if (mode !== MODES.AUTONOMOUS_PLAN) {
    return plan;
  }

  const execution = await applyAutonomousPlan(plan);
  return { ...plan, execution };
}

// ------------------------------------------------------------
// Summary + analytics + dashboard (additive)
// ------------------------------------------------------------

async function getCoordinationSummary({ force = false } = {}) {
  const plan = await buildCoordinationPlan({ force });
  return {
    status: plan.status,
    mode: plan.mode,
    generated_at: plan.generated_at,
    summary: plan.summary,
    warnings: plan.warnings,
    disclaimer: plan.disclaimer
  };
}

async function getAnalytics({ force = false } = {}) {
  const plan = await buildCoordinationPlan({ force });

  const [assignedRow, completedRow, cancelledRow, durationRow] = await Promise.all([
    pool.query("SELECT COUNT(*) AS c FROM missions WHERE mission_status = 'Assigned'"),
    pool.query("SELECT COUNT(*) AS c FROM missions WHERE mission_status = 'Completed'"),
    pool.query("SELECT COUNT(*) AS c FROM missions WHERE mission_status = 'Cancelled'"),
    pool.query(
      `
      SELECT AVG(EXTRACT(EPOCH FROM (completed_time - assigned_time))) AS avg_seconds
      FROM missions
      WHERE mission_status = 'Completed'
        AND completed_time IS NOT NULL
        AND assigned_time IS NOT NULL
      `
    )
  ]);

  const avgDuration = asNumber(durationRow.rows[0]?.avg_seconds);

  const s = plan.summary;

  const priorityValues = (plan.tasks || [])
    .map((t) => asNumber(t.priority_score))
    .filter((v) => v !== null);
  const averageTaskPriority = priorityValues.length > 0
    ? round1(priorityValues.reduce((sum, v) => sum + v, 0) / priorityValues.length)
    : null;

  const candidateValues = (plan.assignments || [])
    .map((a) => asNumber(a.candidate_score))
    .filter((v) => v !== null);
  const averageCandidateScore = candidateValues.length > 0
    ? round1(candidateValues.reduce((sum, v) => sum + v, 0) / candidateValues.length)
    : null;

  return {
    status: plan.status,
    generated_at: plan.generated_at,
    task_assignment_count: Number(assignedRow.rows[0].c),
    task_completion_count: Number(completedRow.rows[0].c),
    task_cancelled_count: Number(cancelledRow.rows[0].c),
    unassigned_task_count: s.unassigned_tasks,
    reassignment_count: s.reassignment_required,
    average_assignment_time_seconds: null,
    average_assignment_time_available: false,
    average_assignment_time_reason:
      "No queue timestamp is stored, so assignment wait time cannot be computed honestly.",
    average_mission_duration_seconds: avgDuration === null ? null : Math.round(avgDuration),
    robot_utilization: {
      total: s.total_robots,
      available: s.available_robots,
      busy: s.busy_robots,
      charging: s.charging_robots,
      low_battery: s.low_battery_robots,
      offline: s.offline_robots,
      utilization: s.total_robots > 0
        ? round1(((s.busy_robots + s.charging_robots) / s.total_robots) * 100)
        : null
    },
    coordination_conflicts: s.coordination_conflicts,
    active_tasks: s.total_tasks,
    pending_tasks: s.pending_tasks,
    // Flat, prefixed aliases for the additive /api/analytics contract.
    coordination_pending_tasks: s.pending_tasks,
    coordination_assigned_tasks: s.assigned_tasks,
    coordination_unassigned_tasks: s.unassigned_tasks,
    coordination_available_robots: s.available_robots,
    coordination_busy_robots: s.busy_robots,
    coordination_charging_robots: s.charging_robots,
    coordination_conflict_count: s.coordination_conflicts,
    coordination_reassignment_required: s.reassignment_required,
    coordination_average_task_priority: averageTaskPriority,
    coordination_average_candidate_score: averageCandidateScore,
    coordination_status: plan.status,
    disclaimer: COORDINATION_DISCLAIMER
  };
}

async function getDashboardSummary({ force = false } = {}) {
  const plan = await buildCoordinationPlan({ force });
  const s = plan.summary;

  return {
    pendingTasks: s.pending_tasks,
    assignedTasks: s.assigned_tasks,
    unassignedTasks: s.unassigned_tasks,
    availableRobots: s.available_robots,
    busyRobots: s.busy_robots,
    chargingRobots: s.charging_robots,
    coordinationConflicts: s.coordination_conflicts,
    reassignmentRequired: s.reassignment_required,
    status: plan.status
  };
}

// ------------------------------------------------------------
// Live emission — missionCoordinationUpdate, only on meaningful change
// ------------------------------------------------------------

let lastSignature = null;

function buildSignature(plan) {
  // Raw per-tick battery is deliberately excluded (it changes every
  // 5 s and would spam the event). Availability state + assignment +
  // conflict/reassignment identity capture the meaningful changes.
  const summarySig = [
    plan.status,
    plan.summary.total_tasks,
    plan.summary.assigned_tasks,
    plan.summary.unassigned_tasks,
    plan.summary.available_robots,
    plan.summary.charging_robots,
    plan.summary.coordination_conflicts,
    plan.summary.reassignment_required
  ].join(":");

  const assignmentSig = [...(plan.assignments || [])]
    .map((a) => `${a.task_id}>${a.robot_id}:${a.route_mode}`)
    .sort()
    .join(",");

  const unassignedSig = [...(plan.unassigned || [])]
    .map((u) => `${u.task_id}:${u.reason}`)
    .sort()
    .join(",");

  const conflictSig = [...(plan.conflicts || [])]
    .map((c) => `${c.type}:${c.robot_id ?? "-"}:${c.drain_id ?? "-"}`)
    .sort()
    .join(",");

  const reassignSig = [...(plan.reassignment_required || [])]
    .map((r) => `${r.mission_id}:${r.current_robot_id}:${r.reason}:${r.recommended_replacement ? r.recommended_replacement.robot_id : "-"}`)
    .sort()
    .join(",");

  return `${summarySig}|${assignmentSig}|${unassignedSig}|${conflictSig}|${reassignSig}`;
}

async function evaluateAndEmitMissionCoordination() {
  const plan = await buildCoordinationPlan({ mode: DEFAULT_MODE });
  const signature = buildSignature(plan);

  if (signature === lastSignature) {
    return { emitted: false, plan };
  }

  lastSignature = signature;
  socketHub.emit("missionCoordinationUpdate", {
    status: plan.status,
    mode: plan.mode,
    summary: plan.summary,
    assignments: plan.assignments,
    unassigned: plan.unassigned,
    conflicts: plan.conflicts,
    reassignment_required: plan.reassignment_required,
    generated_at: plan.generated_at
  });

  return { emitted: true, plan };
}

function resetCoordinationRuntime() {
  lastSignature = null;
  snapshotCache = { at: 0, data: null };
  signalCache.clear();
}

// ------------------------------------------------------------
// Exports
// ------------------------------------------------------------

module.exports = {
  // constants
  MODES,
  DEFAULT_MODE,
  COORDINATION_WEIGHTS,
  CANDIDATE_WEIGHTS,
  COORDINATION_STATUS,
  TASK_STATE,
  UNASSIGNED_REASON,
  CONFLICT_TYPE,
  REASSIGNMENT_REASON,
  MISSION_STATUS,
  MIN_BATTERY_MISSION,
  COORDINATION_DISCLAIMER,
  // pure helpers
  round1,
  clamp,
  levelFromScore,
  severityScore,
  ageScore,
  computeCoordinationPriority,
  computeCandidateScore,
  // state + views
  getDrainSignals,
  getCoordinationSnapshot,
  getTaskQueue,
  evaluateRobotForTask,
  scoreRobotForTask,
  getEligibleRobots,
  getTaskCandidates,
  getMissionConflicts,
  getReassignmentPlan,
  buildCoordinationPlan,
  applyAutonomousPlan,
  coordinate,
  getCoordinationSummary,
  getAnalytics,
  getDashboardSummary,
  buildSignature,
  evaluateAndEmitMissionCoordination,
  resetCoordinationRuntime
};
