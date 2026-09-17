// ============================================================
// AI-DrainOS Digital Twin — pure shared utilities
//
// This module contains ONLY deterministic, side-effect-free
// functions: level mapping, safe water-level clamping,
// coordinate conversion, entity normalization, 3D route
// geometry and live socket-state reducers.
//
// It is written as ESM (.mjs) so the SAME file is importable
// from the Vite frontend AND from the Node.js backend test
// suite (server/tests/digitalTwin.test.js) without any build
// step or duplicate implementation.
//
// COORDINATE CONTRACT (IMPORTANT):
// The Digital Twin uses a VISUALIZATION coordinate system, not a
// survey-grade GIS. Real latitude/longitude from the existing
// APIs are mapped deterministically to a local X/Z plane around a
// reference origin derived from the currently loaded project
// coordinates. Y is reserved for visual elevation (water level,
// objects, labels). None of these values are real-world meters.
// ============================================================

export const LEVELS = ["LOW", "MODERATE", "HIGH", "CRITICAL"];

export const LEVEL_THRESHOLDS = { moderate: 25, high: 50, critical: 75 };

// Shared palette (also reused by DigitalTwinLegend).
export const LEVEL_COLOR = {
  LOW: "#22c55e",
  MODERATE: "#f59e0b",
  HIGH: "#ea580c",
  CRITICAL: "#ef4444"
};

export const LEVEL_RANK = { LOW: 0, MODERATE: 1, HIGH: 2, CRITICAL: 3 };

// Visualization scale: number of local units per longitude/latitude
// degree. Deterministic and documented - deliberately NOT real-world
// meters.
export const VIS_SCALE = 1000;

// Max elevation (local units) used when mapping a 0-100 water level
// to a 3D water-surface height.
export const MAX_WATER_HEIGHT = 1.1;

export const STATUS_COLOR = {
  Normal: "#16a34a",
  Warning: "#f59e0b",
  Critical: "#dc2626",
  Active: "#16a34a",
  Idle: "#64748b",
  Charging: "#f59e0b",
  Maintenance: "#ea580c"
};

// ------------------------------------------------------------
// Clamping / safe numbers
// ------------------------------------------------------------

/** Clamp a number between min and max (inclusive). */
export function clamp(value, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num)) return min;
  return Math.min(max, Math.max(min, num));
}

/**
 * Safe water-level clamp for visualization:
 *  - null/undefined/non-numeric  -> null (honest "data unavailable")
 *  - otherwise clamped to [0, 100] and rounded.
 */
export function safeWaterLevel(value) {
  if (value === null || value === undefined) return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.round(clamp(num, 0, 100));
}

/** Safe finite number with a fallback. */
export function safeNumber(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

/**
 * Map a 0-100 score to a level using the same banding as the
 * existing engines (moderate >= 25, high >= 50, critical >= 75).
 * Used only as a deterministic fallback when a level label itself
 * is not available but a real score is.
 */
export function levelFromScore(score) {
  if (score === null || score === undefined || score === "") return null;
  const num = Number(score);
  if (!Number.isFinite(num)) return null;
  if (num >= LEVEL_THRESHOLDS.critical) return "CRITICAL";
  if (num >= LEVEL_THRESHOLDS.high) return "HIGH";
  if (num >= LEVEL_THRESHOLDS.moderate) return "MODERATE";
  return "LOW";
}

/** Normalize an arbitrary level label to the canonical 4 levels. */
export function normalizeLevel(level) {
  if (level === null || level === undefined) return null;
  const upper = String(level).toUpperCase();
  return LEVELS.includes(upper) ? upper : null;
}

// ------------------------------------------------------------
// Coordinate conversion (documented visualization space)
// ------------------------------------------------------------

/**
 * Compute a deterministic reference origin from a list of
 * lat/lng points (midpoint of the bounding box). If no valid
 * points exist, returns null.
 */
export function computeOrigin(points) {
  let minLat = null;
  let maxLat = null;
  let minLng = null;
  let maxLng = null;

  for (const point of points) {
    const lat = Number(point && point.lat);
    const lng = Number(point && point.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (minLat === null || lat < minLat) minLat = lat;
    if (maxLat === null || lat > maxLat) maxLat = lat;
    if (minLng === null || lng < minLng) minLng = lng;
    if (maxLng === null || lng > maxLng) maxLng = lng;
  }

  if (minLat === null) return null;

  return {
    lat: (minLat + maxLat) / 2,
    lng: (minLng + maxLng) / 2
  };
}

/**
 * Convert latitude/longitude to local visualization X/Z.
 *   X = (lng - origin.lng) * VIS_SCALE
 *   Z = (lat - origin.lat) * VIS_SCALE
 * Returns null for invalid input. Y is reserved for elevation.
 */
export function latLngToLocal(lat, lng, origin) {
  const latNum = safeNumber(lat, NaN);
  const lngNum = safeNumber(lng, NaN);
  if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) return null;
  if (!origin || !Number.isFinite(Number(origin.lat)) || !Number.isFinite(Number(origin.lng))) {
    return null;
  }
  return {
    x: (lngNum - Number(origin.lng)) * VIS_SCALE,
    z: (latNum - Number(origin.lat)) * VIS_SCALE
  };
}

/**
 * Water level (0-100) -> 3D water surface height (local units),
 * clamped. Returns 0 when data is unavailable (level, not raised).
 */
export function waterLevelToHeight(waterLevel) {
  const clamped = safeWaterLevel(waterLevel);
  if (clamped === null) return 0;
  return (clamped / 100) * MAX_WATER_HEIGHT;
}

// ------------------------------------------------------------
// Entity normalization (REST payloads -> display model)
// ------------------------------------------------------------

export function normalizeDrain(raw, origin) {
  const local = latLngToLocal(raw.latitude, raw.longitude, origin);
  return {
    id: Number(raw.id),
    name: raw.location || `Drain ${raw.id}`,
    location: raw.location || null,
    zone: raw.zone_name || null,
    status: String(raw.status || "Normal"),
    blockageLevel: safeNumber(raw.blockage_level, 0),
    latitude: safeNumber(raw.latitude),
    longitude: safeNumber(raw.longitude),
    x: local ? local.x : null,
    z: local ? local.z : null
  };
}

/**
 * Match /api/sensors rows to drains by zone+location (the sensor
 * endpoint carries no drain_id or coordinates). Unmatched sensors
 * keep drainId null and are honestly reported as unassigned.
 */
export function matchSensorsToDrains(sensors, drains) {
  const byLocation = new Map();
  for (const drain of drains) {
    const key = `${String(drain.zone || "").trim()}|${String(drain.location || "").trim()}`;
    if (!key.includes("||") && !byLocation.has(key)) {
      byLocation.set(key, drain.id);
    }
  }

  return sensors.map((sensor) => {
    const zone = sensor.zone_name || sensor.zone || "";
    const location = sensor.location || "";
    const key = `${String(zone).trim()}|${String(location).trim()}`;
    return { ...sensor, drainId: byLocation.get(key) || null };
  });
}

export function normalizeSensor(raw, origin) {
  const local = latLngToLocal(raw.latitude, raw.longitude, origin);
  return {
    id: Number(raw.id),
    drainId: raw.drainId ? Number(raw.drainId) : null,
    drainLocation: raw.location || null,
    zone: raw.zone_name || raw.zone || null,
    waterLevel: safeWaterLevel(raw.water_level !== undefined ? raw.water_level : raw.waterLevel),
    gasLevel: safeNumber(raw.gas_level !== undefined ? raw.gas_level : raw.gasLevel),
    temperature: safeNumber(raw.temperature),
    status: String(raw.status || raw.sensor_status || "Normal"),
    latitude: safeNumber(raw.latitude),
    longitude: safeNumber(raw.longitude),
    x: local ? local.x : null,
    z: local ? local.z : null
  };
}

export function normalizeRobot(raw, origin) {
  const local = latLngToLocal(raw.latitude, raw.longitude, origin);
  const target = latLngToLocal(raw.target_latitude, raw.target_longitude, origin);
  return {
    id: Number(raw.id),
    name: raw.robot_name || `Robot ${raw.id}`,
    zone: raw.assigned_zone || null,
    status: String(raw.status || "Idle"),
    batteryLevel: safeNumber(raw.battery_level, 0),
    latitude: safeNumber(raw.latitude),
    longitude: safeNumber(raw.longitude),
    targetLatitude: safeNumber(raw.target_latitude),
    targetLongitude: safeNumber(raw.target_longitude),
    lastActive: raw.last_active || null,
    x: local ? local.x : null,
    z: local ? local.z : null,
    targetX: target ? target.x : null,
    targetZ: target ? target.z : null
  };
}

export function normalizeChargingStation(raw, origin) {
  const local = latLngToLocal(raw.latitude, raw.longitude, origin);
  return {
    id: Number(raw.id),
    name: raw.station_name || `Station ${raw.id}`,
    latitude: safeNumber(raw.latitude),
    longitude: safeNumber(raw.longitude),
    x: local ? local.x : null,
    z: local ? local.z : null
  };
}

/**
 * Build 3D line geometry (array of {x, z} points) from route
 * waypoints. Waypoints without coordinates are skipped; returns an
 * empty array when there is nothing to draw.
 */
export function buildRouteGeometry(waypoints, origin) {
  if (!Array.isArray(waypoints)) return [];
  return waypoints
    .map((wp) => latLngToLocal(wp.latitude, wp.longitude, origin))
    .filter((point) => point !== null);
}

export function normalizeRoute(raw, origin) {
  const routePayload = raw.route || null;
  const points = buildRouteGeometry(routePayload ? routePayload.waypoints : null, origin);
  const waypoints = Array.isArray(routePayload && routePayload.waypoints)
    ? routePayload.waypoints
        .map((wp) => {
          const local = latLngToLocal(wp.latitude, wp.longitude, origin);
          return {
            label: wp.label || "WAYPOINT",
            latitude: safeNumber(wp.latitude),
            longitude: safeNumber(wp.longitude),
            cumulativeDistance: safeNumber(wp.cumulativeDistance, 0),
            cumulativeTravelSeconds: safeNumber(wp.cumulativeTravelSeconds, 0),
            x: local ? local.x : null,
            z: local ? local.z : null
          };
        })
        .filter((wp) => wp.x !== null && wp.z !== null)
    : [];

  return {
    drainId: Number(raw.drainId),
    zone: raw.zone || null,
    location: raw.location || null,
    drainStatus: String(raw.status || "Normal"),
    planningStatus: String(raw.planningStatus || "UNKNOWN"),
    robotId: raw.robot ? Number(raw.robot.id) : null,
    robotName: raw.robot ? raw.robot.robotName || raw.robot.robot_name : null,
    robotBatteryLevel: raw.robot ? safeNumber(raw.robot.batteryLevel, 0) : null,
    routeType: routePayload ? routePayload.type : null,
    needsCharging: routePayload ? Boolean(routePayload.needsCharging) : false,
    chargingStation: routePayload && routePayload.chargingStation
      ? {
          id: routePayload.chargingStation.id,
          name: routePayload.chargingStation.stationName || routePayload.chargingStation.station_name,
          latitude: routePayload.chargingStation.latitude,
          longitude: routePayload.chargingStation.longitude
        }
      : null,
    totalDistance: routePayload ? safeNumber(routePayload.totalDistance, 0) : null,
    formatTotalTravelTime: routePayload ? routePayload.formatTotalTravelTime : null,
    selectionScore: safeNumber(raw.selectionScore),
    selectionReasons: Array.isArray(raw.selectionReasons) ? raw.selectionReasons : [],
    points,
    waypoints
  };
}

// ------------------------------------------------------------
// Fused view-model: attach live risk / decision / maintenance /
// forecast / vision signals to normalized drains so the 3D scene
// stays a pure function of a single object graph.
// ------------------------------------------------------------

export function fuseDrains(drains, liveByDrain, decisionsByDrain) {
  return drains.map((drain) => {
    const live = liveByDrain[drain.id] || {};
    const decision = decisionsByDrain[drain.id] || {};

    const riskLevel =
      normalizeLevel(live.riskLevel) ||
      normalizeLevel(decision.riskLevel) ||
      normalizeLevel(decision.decisionLevel) ||
      null;

    const decisionLevel =
      normalizeLevel(decision.decisionLevel) ||
      normalizeLevel(live.decisionLevel) ||
      levelFromScore(decision.priorityScore) ||
      levelFromScore(live.decisionScore) ||
      null;

    const waterLevel = safeWaterLevel(
      live.waterLevel !== undefined && live.waterLevel !== null
        ? live.waterLevel
        : drain.waterLevel
    );

    return {
      ...drain,
      waterLevel,
      riskLevel,
      riskScore: safeNumber(live.riskScore, null),
      decisionLevel,
      decisionScore:
        decision.priorityScore !== undefined
          ? safeNumber(decision.priorityScore, null)
          : safeNumber(live.decisionScore, null),
      decisionAction:
        decision.recommendedAction || live.decisionAction || null,
      forecastLevel: normalizeLevel(live.forecastLevel),
      forecastScore: safeNumber(live.forecastScore, null),
      maintenanceLevel: normalizeLevel(live.maintenanceLevel),
      maintenanceScore: safeNumber(live.maintenanceScore, null),
      visionLevel: normalizeLevel(live.visionLevel),
      visionScore: safeNumber(live.visionScore, null)
    };
  });
}

// ------------------------------------------------------------
// Live socket state reducer (single immutable reducer shared by
// the Digital Twin page/preview so every event path is pure and
// testable without a browser).
// ------------------------------------------------------------

function mergeDrainLive(prev, patch) {
  return prev ? { ...prev, ...patch } : { ...patch };
}

export function digitalTwinReducer(state, action) {
  switch (action.type) {
    case "SET_DATA": {
      return {
        ...state,
        drains: action.drains,
        sensors: action.sensors,
        robots: action.robots,
        chargingStations: action.chargingStations,
        routes: action.routes,
        missions: action.missions,
        origin: action.origin,
        metrics: action.metrics,
        decisionsByDrain: action.decisionsByDrain || {},
        loadError: action.loadError,
        refreshNonce: (state.refreshNonce || 0) + 1
      };
    }

    case "SENSOR_UPDATE": {
      const p = action.payload || {};
      const bySensor = { ...state.bySensor, [p.sensorId]: { ...p } };
      const byDrain = {
        ...state.byDrain,
        [p.drainId]: mergeDrainLive(state.byDrain[p.drainId], {
          waterLevel: p.water_level !== undefined ? p.water_level : state.byDrain[p.drainId]?.waterLevel,
          gasLevel: p.gas_level !== undefined ? p.gas_level : state.byDrain[p.drainId]?.gasLevel,
          temperature: p.temperature !== undefined ? p.temperature : state.byDrain[p.drainId]?.temperature,
          riskScore: p.riskScore !== undefined && p.riskScore !== null ? p.riskScore : state.byDrain[p.drainId]?.riskScore,
          riskLevel: normalizeLevel(p.riskLevel) || state.byDrain[p.drainId]?.riskLevel || null,
          riskTrend: p.riskTrend !== undefined ? p.riskTrend : state.byDrain[p.drainId]?.riskTrend,
          forecastScore: p.forecast60Score !== undefined && p.forecast60Score !== null ? p.forecast60Score : state.byDrain[p.drainId]?.forecastScore,
          forecastLevel: normalizeLevel(p.forecast60Level) || state.byDrain[p.drainId]?.forecastLevel || null,
          maintenanceScore: p.maintenanceScore !== undefined && p.maintenanceScore !== null ? p.maintenanceScore : state.byDrain[p.drainId]?.maintenanceScore,
          maintenanceLevel: normalizeLevel(p.maintenanceLevel) || state.byDrain[p.drainId]?.maintenanceLevel || null,
          decisionScore: p.decisionPriorityScore !== undefined && p.decisionPriorityScore !== null ? p.decisionPriorityScore : state.byDrain[p.drainId]?.decisionScore,
          decisionLevel: normalizeLevel(p.decisionPriorityLevel) || state.byDrain[p.drainId]?.decisionLevel || null,
          decisionAction: p.decisionRecommendedAction !== undefined ? p.decisionRecommendedAction : state.byDrain[p.drainId]?.decisionAction,
          updatedAt: p.timestamp || new Date().toISOString()
        })
      };
      return { ...state, bySensor, byDrain };
    }

    case "RISK_UPDATE": {
      const p = action.payload || {};
      const byDrain = {
        ...state.byDrain,
        [p.drainId]: mergeDrainLive(state.byDrain[p.drainId], {
          riskScore: p.riskScore !== undefined ? p.riskScore : state.byDrain[p.drainId]?.riskScore,
          riskLevel: normalizeLevel(p.riskLevel) || state.byDrain[p.drainId]?.riskLevel || null,
          waterLevel: p.waterLevel !== undefined ? p.waterLevel : state.byDrain[p.drainId]?.waterLevel,
          riskTrend: p.trend ? (p.trend.label || p.trend.direction || null) : state.byDrain[p.drainId]?.riskTrend,
          updatedAt: p.timestamp || new Date().toISOString()
        })
      };
      return { ...state, byDrain };
    }

    case "FORECAST_UPDATE": {
      const p = action.payload || {};
      const worst = p.worst || {};
      const byDrain = {
        ...state.byDrain,
        [p.drainId]: mergeDrainLive(state.byDrain[p.drainId], {
          forecastLevel: normalizeLevel(worst.predictedRiskLevel) || state.byDrain[p.drainId]?.forecastLevel || null,
          forecastScore: worst.predictedRiskScore !== undefined ? worst.predictedRiskScore : state.byDrain[p.drainId]?.forecastScore,
          forecastTrendDirection: p.trendDirection !== undefined ? p.trendDirection : state.byDrain[p.drainId]?.forecastTrendDirection,
          updatedAt: p.timestamp || new Date().toISOString()
        })
      };
      return { ...state, byDrain };
    }

    case "MAINTENANCE_UPDATE": {
      const p = action.payload || {};
      const byDrain = {
        ...state.byDrain,
        [p.drainId]: mergeDrainLive(state.byDrain[p.drainId], {
          maintenanceScore: p.maintenanceScore !== undefined ? p.maintenanceScore : state.byDrain[p.drainId]?.maintenanceScore,
          maintenanceLevel: normalizeLevel(p.maintenanceLevel) || state.byDrain[p.drainId]?.maintenanceLevel || null,
          blockageRiskScore: p.blockageRiskScore !== undefined ? p.blockageRiskScore : state.byDrain[p.drainId]?.blockageRiskScore,
          maintenanceRecommendation: p.maintenanceRecommendation !== undefined ? p.maintenanceRecommendation : state.byDrain[p.drainId]?.maintenanceRecommendation,
          updatedAt: p.timestamp || new Date().toISOString()
        })
      };
      return { ...state, byDrain };
    }

    case "VISION_UPDATE": {
      const p = action.payload || {};
      const byDrain = {
        ...state.byDrain,
        [p.drainId]: mergeDrainLive(state.byDrain[p.drainId], {
          visionLevel: normalizeLevel(p.inspectionLevel) || state.byDrain[p.drainId]?.visionLevel || null,
          visionScore: p.visualRiskScore !== undefined ? p.visualRiskScore : state.byDrain[p.drainId]?.visionScore,
          visionRecommendation: p.recommendation !== undefined ? p.recommendation : state.byDrain[p.drainId]?.visionRecommendation,
          updatedAt: p.analyzedAt || new Date().toISOString()
        })
      };
      return { ...state, byDrain };
    }

    case "DECISION_UPDATE": {
      const p = action.payload || {};
      const byDrain = {
        ...state.byDrain,
        [p.drainId]: mergeDrainLive(state.byDrain[p.drainId], {
          decisionScore: p.priorityScore !== undefined ? p.priorityScore : state.byDrain[p.drainId]?.decisionScore,
          decisionLevel: normalizeLevel(p.priorityLevel) || state.byDrain[p.drainId]?.decisionLevel || null,
          decisionAction: p.recommendedAction !== undefined ? p.recommendedAction : state.byDrain[p.drainId]?.decisionAction,
          updatedAt: p.generatedAt || new Date().toISOString()
        })
      };
      return { ...state, byDrain };
    }

    case "ROUTE_UPDATE": {
      const p = action.payload || {};
      const drainId = p.drain ? Number(p.drain.id) : Number(p.drainId);
      if (!drainId) return state;

      const remote = {
        drainId,
        zone: p.drain ? p.drain.zoneName || p.drain.zone : null,
        location: p.drain ? p.drain.location : null,
        drainStatus: p.drain ? p.drain.status : null,
        planningStatus: String(p.status || "UNKNOWN"),
        robotId: p.robot ? Number(p.robot.id) : null,
        robotName: p.robot ? p.robot.robotName : null,
        robotBatteryLevel: p.robot ? p.robot.batteryLevel : null,
        routeType: p.route ? p.route.type : null,
        needsCharging: p.route ? Boolean(p.route.needsCharging) : false,
        chargingStation: p.route && p.route.chargingStation,
        totalDistance: p.route ? p.route.totalDistance : null,
        formatTotalTravelTime: p.route ? p.route.formatTotalTravelTime : null,
        selectionScore: p.selectionScore || null,
        selectionReasons: Array.isArray(p.selectionReasons) ? p.selectionReasons : [],
        points: buildRouteGeometry(p.route ? p.route.waypoints : null, state.origin),
        waypoints: Array.isArray(p.route && p.route.waypoints)
          ? p.route.waypoints
              .map((wp) => {
                const local = latLngToLocal(wp.latitude, wp.longitude, state.origin);
                return {
                  label: wp.label || "WAYPOINT",
                  latitude: safeNumber(wp.latitude),
                  longitude: safeNumber(wp.longitude),
                  cumulativeDistance: safeNumber(wp.cumulativeDistance, 0),
                  cumulativeTravelSeconds: safeNumber(wp.cumulativeTravelSeconds, 0),
                  x: local ? local.x : null,
                  z: local ? local.z : null
                };
              })
              .filter((wp) => wp.x !== null && wp.z !== null)
          : []
      };

      const routes = (state.routes || [])
        .filter((route) => Number(route.drainId) !== drainId)
        .concat([remote]);

      return { ...state, routes };
    }

    case "DASHBOARD_UPDATE": {
      const p = action.payload || {};
      return {
        ...state,
        metrics: {
          ...state.metrics,
          totalDrains: p.totalDrains !== undefined ? p.totalDrains : state.metrics.totalDrains,
          activeRobots: p.activeRobots !== undefined ? p.activeRobots : state.metrics.activeRobots,
          criticalAlerts: p.criticalAlerts !== undefined ? p.criticalAlerts : state.metrics.criticalAlerts,
          lastUpdated: new Date()
        }
      };
    }

    default:
      return state;
  }
}

// ------------------------------------------------------------
// Payload guards (invalid/surprising API responses -> aligned
// defaults so the scene never crashes on bad data).
// ------------------------------------------------------------

export function asArray(value, fallback = []) {
  return Array.isArray(value) ? value : fallback;
}

export function buildMetrics(drains, robots, routes, extra = {}) {
  const criticalCount = drains.filter(
    (drain) =>
      drain.status === "Critical" ||
      drain.riskLevel === "CRITICAL" ||
      drain.decisionLevel === "CRITICAL"
  ).length;

  const activeRobots = robots.filter((robot) => robot.status === "Active").length;
  const activeRoutes = routes.filter(
    (route) =>
      route.planningStatus === "ROBOT_SELECTED" &&
      route.routeType !== null
  ).length;

  return {
    totalDrains: drains.length,
    criticalDrains: criticalCount,
    activeRobots,
    activeRoutes,
    totalRobots: robots.length,
    lastUpdated: new Date(),
    ...extra
  };
}