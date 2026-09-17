// ============================================================
// AI-DrainOS Digital Twin — client data aggregation service
//
// Combines the EXISTING backend REST endpoints into a single
// display model for the 3D Digital Twin. It never changes backend
// business logic and only uses contracts that already exist:
//
//   GET /api/drains
//   GET /api/sensors
//   GET /api/robots
//   GET /api/charging-stations
//   GET /api/dashboard/robot-routes
//   GET /api/dashboard/decisions
//   GET /api/incidents/active          (additive, Update #18)
//   GET /api/fleet-optimization        (additive, Update #19)
//   GET /api/predictions/risk/:id      (on-demand, drain detail)
//   GET /api/predictions/forecast/:id  (on-demand)
//   GET /api/predictions/maintenance/:id (on-demand)
//   GET /api/predictions/decision/:id  (on-demand)
//   GET /api/predictions/vision/:id    (on-demand)
//
// Promise.allSettled is used deliberately: a failing endpoint must
// degrade to an honest "data unavailable" scene, never a crash.
// ============================================================

import axios from "axios";
import { API_URL } from "./api";
import {
  asArray,
  computeOrigin,
  normalizeChargingStation,
  normalizeDrain,
  normalizeRobot,
  normalizeRoute,
  normalizeSensor,
  matchSensorsToDrains,
  buildMetrics,
  normalizeIncidentSignal,
  buildActiveIncidentByDrain,
  normalizeFleetOptimization
} from "./digitalTwinUtils.mjs";

function coordinatePoints(drains, robots, stations) {
  return []
    .concat(
      drains.map((d) => ({ lat: d.latitude, lng: d.longitude })),
      robots.map((r) => ({ lat: r.latitude, lng: r.longitude })),
      stations.map((s) => ({ lat: s.latitude, lng: s.longitude }))
    )
    .filter((p) => p.lat !== null && p.lng !== undefined && p.lng !== null);
}

/**
 * Load the full Digital Twin snapshot (aggregated + normalized).
 * Every entity is normalized with safe defaults and the reference
 * origin is derived from the loaded project coordinates.
 */
export async function loadDigitalTwinData() {
  const [
    drainsRes,
    sensorsRes,
    robotsRes,
    stationsRes,
    routesRes,
    decisionsRes,
    incidentsRes,
    fleetRes
  ] = await Promise.allSettled([
    axios.get(`${API_URL}/drains`),
    axios.get(`${API_URL}/sensors`),
    axios.get(`${API_URL}/robots`),
    axios.get(`${API_URL}/charging-stations`),
    axios.get(`${API_URL}/dashboard/robot-routes`),
    axios.get(`${API_URL}/dashboard/decisions`),
    axios.get(`${API_URL}/incidents/active`),
    axios.get(`${API_URL}/fleet-optimization`)
  ]);

  const rawDrains = drainsRes.status === "fulfilled" ? asArray(drainsRes.value.data) : [];
  const rawSensors = sensorsRes.status === "fulfilled" ? asArray(sensorsRes.value.data) : [];
  const rawRobots = robotsRes.status === "fulfilled" ? asArray(robotsRes.value.data) : [];
  const rawStations =
    stationsRes.status === "fulfilled" ? asArray(stationsRes.value.data) : [];
  const rawRoutes =
    routesRes.status === "fulfilled" && routesRes.value.data
      ? asArray(routesRes.value.data.routes)
      : [];
  const decisionsPayload =
    decisionsRes.status === "fulfilled" && decisionsRes.value.data
      ? decisionsRes.value.data
      : null;

  const origin = computeOrigin(
    coordinatePoints(rawDrains, rawRobots, rawStations)
  );

  // Match sensors to drains by zone+location (the sensor endpoint
  // does not return drain_id / coordinates).
  const matchedSensors = matchSensorsToDrains(
    rawSensors,
    rawDrains.map((d) => ({ id: d.id, zone: d.zone_name, location: d.location }))
  );

  const drains = rawDrains
    .map((drain) => ({ ...normalizeDrain(drain, origin), waterLevel: null }))
    .filter((drain) => drain.x !== null && drain.z !== null);

  const sensors = matchedSensors
    .map((sensor, index) => {
      const normalized = normalizeSensor(sensor, origin);
      const drain = drains.find((d) => d.id === normalized.drainId);
      // Position sensors beside their associated drain when possible.
      if (drain) {
        normalized.x = drain.x + 6;
        normalized.z = drain.z + 6;
        normalized.waterLevel = sensor.water_level !== undefined ? sensor.water_level : null;
        normalized.zone = sensor.zone_name || sensor.zone || drain.zone;
        normalized.drainLocation = sensor.location || drain.location;
      } else {
        // Unassigned sensor: honest placement near the workspace
        // origin without inventing a drain association.
        const offset = 12 + index * 4;
        normalized.x = normalized.x !== null ? normalized.x : origin ? offset : null;
        normalized.z = normalized.z !== null ? normalized.z : origin ? offset : null;
      }
      return normalized;
    })
    .filter((sensor) => sensor.x !== null && sensor.z !== null);

  const robots = rawRobots
    .map((robot) => normalizeRobot(robot, origin))
    .filter((robot) => robot.x !== null && robot.z !== null);

  const chargingStations = rawStations
    .map((station) => normalizeChargingStation(station, origin))
    .filter((station) => station.x !== null && station.z !== null);

  const routes = asArray(rawRoutes)
    .map((route) => normalizeRoute(route, origin))
    .filter((route) => route.points.length > 0);

  // Per-drain AI decision overlay (top-priority list carries real
  // priority scores/levels from the existing decision engine).
  const decisionsByDrain = {};
  const topPriority = asArray(decisionsPayload ? decisionsPayload.topPriority : []);
  for (const entry of topPriority) {
    decisionsByDrain[Number(entry.drainId)] = {
      drainId: Number(entry.drainId),
      zone: entry.zone || null,
      location: entry.location || null,
      priorityScore: entry.priorityScore,
      priorityLevel: entry.priorityLevel,
      recommendedAction: entry.recommendedAction
    };
  }

  // Sink real sensor water levels onto drains (real readings, never
  // fabricated); the flood-risk / decision levels come from the
  // decisions overlay plus live socket events.
  for (const sensor of sensors) {
    if (sensor.drainId) {
      const drain = drains.find((d) => d.id === sensor.drainId);
      if (drain && sensor.waterLevel !== null) {
        drain.waterLevel = sensor.waterLevel;
      }
    }
  }

  // Active incidents (Update #18) — additive overlay. When the
  // incident API is unavailable this degrades to an empty list and
  // the scene stays fully usable in a "degraded" state.
  const rawIncidents =
    incidentsRes.status === "fulfilled" ? asArray(incidentsRes.value.data) : [];

  const incidents = rawIncidents
    .map((incident) => normalizeIncidentSignal(incident))
    .filter((incident) => incident !== null);

  const activeIncidentByDrain = buildActiveIncidentByDrain(incidents);

  // Fleet optimization overlay (Update #19) — additive advisory.
  // A missing/failed endpoint degrades to fleet = null and the twin
  // simply draws no fleet markers.
  const fleet =
    fleetRes.status === "fulfilled"
      ? normalizeFleetOptimization(fleetRes.value.data)
      : null;

  const metrics = buildMetrics(drains, robots, routes, {
    decisionsTotal: topPriority.length,
    activeIncidents: Object.keys(activeIncidentByDrain).length,
    fleetActiveTasks: fleet ? fleet.summary.activeTasks : 0,
    fleetUnassignedTasks: fleet ? fleet.summary.unassignedTasks : 0,
    fleetAvailableRobots: fleet ? fleet.summary.availableRobots : 0,
    dataSources: {
      drains: drainsRes.status === "fulfilled",
      sensors: sensorsRes.status === "fulfilled",
      robots: robotsRes.status === "fulfilled",
      chargingStations: stationsRes.status === "fulfilled",
      routes: routesRes.status === "fulfilled",
      decisions: decisionsRes.status === "fulfilled",
      incidents: incidentsRes.status === "fulfilled",
      fleetOptimization: fleetRes.status === "fulfilled"
    }
  });

  const loadError = [
    drainsRes.status !== "fulfilled" && "drains",
    sensorsRes.status !== "fulfilled" && "sensors",
    robotsRes.status !== "fulfilled" && "robots",
    stationsRes.status !== "fulfilled" && "stations",
    routesRes.status !== "fulfilled" && "routes",
    decisionsRes.status !== "fulfilled" && "decisions",
    incidentsRes.status !== "fulfilled" && "incidents",
    fleetRes.status !== "fulfilled" && "fleetOptimization"
  ].filter(Boolean);

  return {
    drains,
    sensors,
    robots,
    chargingStations,
    routes,
    missions: [],
    decisionsByDrain,
    incidents,
    activeIncidentByDrain,
    fleet,
    origin,
    metrics,
    loadError
  };
}

/**
 * Load per-drain detail (risk / forecast / maintenance / decision /
 * vision) on demand when a drain is selected. Each request is
 * best-effort: failures become null fields shown as unavailable.
 */
export async function loadDrainDetails(drainId) {
  const id = Number(drainId);
  if (!Number.isInteger(id) || id <= 0) return null;

  const [risk, forecast, maintenance, decision, vision] =
    await Promise.allSettled([
      axios.get(`${API_URL}/predictions/risk/${id}`),
      axios.get(`${API_URL}/predictions/forecast/${id}`),
      axios.get(`${API_URL}/predictions/maintenance/${id}`),
      axios.get(`${API_URL}/predictions/decision/${id}`),
      axios.get(`${API_URL}/predictions/vision/${id}`)
    ]);

  return {
    drainId: id,
    risk: risk.status === "fulfilled" ? risk.value : null,
    forecast: forecast.status === "fulfilled" ? forecast.value : null,
    maintenance: maintenance.status === "fulfilled" ? maintenance.value : null,
    decision: decision.status === "fulfilled" ? decision.value : null,
    vision: vision.status === "fulfilled" ? vision.value : null
  };
}