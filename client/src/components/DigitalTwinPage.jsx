// ============================================================
// AI-DrainOS — Digital Twin Page
//
// Requirement #14 layout:
//   1. Header stats (system | active robots | critical drains |
//      total drains | active routes | last update)
//   2. Toolbar (search, focus chips, camera view buttons)
//   3. Interactive 3D scene
//   4. Legend
//   5. Selected-object details (lazy per-drain detail loading)
//   6. Non-3D fallback data list (requirement #17)
//
// Single existing Socket.IO connection is reused; every live event
// goes through the pure digitalTwinReducer so it is auditable and
// unit-tested without a browser.
// ============================================================

import { useEffect, useMemo, useReducer, useState } from "react";
import {
  FaCube,
  FaRobot,
  FaExclamationTriangle,
  FaTint,
  FaRoute,
  FaClock,
  FaSearch,
  FaBolt,
  FaNetworkWired
} from "react-icons/fa";

import DigitalTwin from "./DigitalTwin";
import DigitalTwinLegend from "./DigitalTwinLegend";
import {
  loadDigitalTwinData,
  loadDrainDetails
} from "../services/digitalTwinService";
import {
  LEVEL_COLOR,
  AVAILABILITY_COLOR,
  FLEET_STATUS_COLOR,
  digitalTwinReducer,
  fuseDrains
} from "../services/digitalTwinUtils.mjs";
import socket from "../services/socket";

import "../styles/digitaltwin.css";

const INITIAL_STATE = {
  drains: [],
  sensors: [],
  robots: [],
  chargingStations: [],
  routes: [],
  missions: [],
  origin: null,
  metrics: null,
  loadError: [],
  decisionsByDrain: {},
  incidents: [],
  activeIncidentByDrain: {},
  fleet: null,
  coordination: null,
  sensorIntelligence: null,
  byDrain: {},
  bySensor: {}
};

const STATUS_LEVEL_COLOR = {
  Normal: "#16a34a",
  Warning: "#f59e0b",
  Critical: "#dc2626"
};

function formatTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function LevelBadge({ value, score, label }) {
  if (!value) return <span className="dt-badge" style={{ background: "#94a3b8" }}>—</span>;
  const color = LEVEL_COLOR[value] || "#94a3b8";
  return (
    <span className="dt-badge" style={{ background: color }}>
      {label ? `${label} ${value}` : value}
      {score != null ? ` · ${Math.round(Number(score))}` : ""}
    </span>
  );
}

function DetailsField({ label, value }) {
  return (
    <div className="dt-field">
      <span className="dt-field-label">{label}</span>
      <span className={`dt-field-value${value == null ? " dt-unavailable" : ""}`}>
        {value == null ? "Data unavailable" : value}
      </span>
    </div>
  );
}

// ------------------------------------------------------------
// Drain details panel (drainId, fused drain, lazy API details)
// ------------------------------------------------------------

function DrainDetails({ drain, details, fleetUnassigned, coordination }) {
  const danger = drain.status === "Critical" || drain.riskLevel === "CRITICAL";
  const fleet = drain.fleet || null;
  const unassigned =
    fleetUnassigned ||
    (fleet && fleet.recommendationStatus === "UNASSIGNED" ? fleet : null);
  const plan = coordination || null;

  return (
    <div>
      <div
        className="dt-section-title"
        style={{ color: danger ? "#dc2626" : "#2563eb" }}
      >
        {danger ? "CRITICAL DRAIN" : "DRAIN"}
      </div>
      <div className="dt-details-grid">
        <DetailsField label="Location" value={drain.location} />
        <DetailsField label="Zone" value={drain.zone} />
        <DetailsField
          label="Status"
          value={drain.status}
        />
        <DetailsField
          label="Water level"
          value={drain.waterLevel != null ? `${drain.waterLevel}%` : null}
        />
      </div>

      {drain.incident && (
        <div className="dt-details-grid">
          <div className="dt-field">
            <span className="dt-field-label">Emergency incident</span>
            <span
              className="dt-field-value"
              style={{ color: "#dc2626", fontWeight: 600 }}
            >
              #{drain.incident.id} · {drain.incident.severity} · {drain.incident.status}
              {drain.incident.routeStatus ? ` · ${drain.incident.routeStatus}` : ""}
            </span>
          </div>
        </div>
      )}

      {(fleet || unassigned) && (
        <div className="dt-details-grid">
          <div className="dt-field">
            <span className="dt-field-label">Fleet assignment (advisory)</span>
            <span
              className="dt-field-value"
              style={{
                color: unassigned ? "#dc2626" : "#0891b2",
                fontWeight: 600
              }}
            >
              {unassigned
                ? `Unassigned · ${unassigned.reason || "no eligible robot"}`
                : `${fleet.recommendedRobotName || `Robot ${fleet.recommendedRobotId}`} · ${fleet.routeMode || "route"}`}
            </span>
          </div>
          {fleet && fleet.estimatedTravelTime != null && (
            <div className="dt-field">
              <span className="dt-field-label">Estimated travel</span>
              <span className="dt-field-value">
                {Math.max(1, Math.round(fleet.estimatedTravelTime / 60))} min
              </span>
            </div>
          )}
          {fleet && fleet.chargingRequired && (
            <div className="dt-field">
              <span className="dt-field-label">Charging</span>
              <span className="dt-field-value" style={{ color: "#f59e0b", fontWeight: 600 }}>
                Charging stop required
              </span>
            </div>
          )}
          {unassigned && unassigned.requiredAction && (
            <div className="dt-field">
              <span className="dt-field-label">Required action</span>
              <span className="dt-field-value">{unassigned.requiredAction}</span>
            </div>
          )}
        </div>
      )}

      {plan && (
        <div className="dt-details-grid">
          <div className="dt-field">
            <span className="dt-field-label">Mission coordination (advisory)</span>
            <span
              className="dt-field-value"
              style={{
                color:
                  plan.coordinationState === "UNASSIGNED" || plan.unassignedReason
                    ? "#dc2626"
                    : "#7c3aed",
                fontWeight: 600
              }}
            >
              {plan.unassignedReason
                ? `Unassigned · ${plan.unassignedReason}`
                : `${plan.assignedRobotName || `Robot ${plan.assignedRobotId}`} · ${
                    plan.routeMode || "route"
                  }`}
            </span>
          </div>
          {plan.priorityScore != null && (
            <div className="dt-field">
              <span className="dt-field-label">Coordination priority</span>
              <span className="dt-field-value">
                {plan.priorityScore}/100
                {plan.priorityStatus ? ` · ${plan.priorityStatus}` : ""}
              </span>
            </div>
          )}
          {plan.estimatedTravelTime != null && (
            <div className="dt-field">
              <span className="dt-field-label">Coordination ETA</span>
              <span className="dt-field-value">
                {Math.max(1, Math.round(plan.estimatedTravelTime))}s
              </span>
            </div>
          )}
          {plan.requiredAction && (
            <div className="dt-field">
              <span className="dt-field-label">Required action</span>
              <span className="dt-field-value">{plan.requiredAction}</span>
            </div>
          )}
        </div>
      )}

      <div className="dt-details-grid">
        <div className="dt-field">
          <span className="dt-field-label">Flood risk</span>
          <LevelBadge value={drain.riskLevel} score={drain.riskScore} label="Level" />
        </div>
        <div className="dt-field">
          <span className="dt-field-label">AI decision</span>
          <span className="dt-field-value">
            <LevelBadge value={drain.decisionLevel} score={drain.decisionScore} />
          </span>
        </div>
        <div className="dt-field">
          <span className="dt-field-label">Forecast (60m)</span>
          <LevelBadge value={drain.forecastLevel} score={drain.forecastScore} />
        </div>
        <div className="dt-field">
          <span className="dt-field-label">Maintenance</span>
          <LevelBadge value={drain.maintenanceLevel} score={drain.maintenanceScore} />
        </div>
        <div className="dt-field">
          <span className="dt-field-label">Vision</span>
          <LevelBadge value={drain.visionLevel} score={drain.visionScore} />
        </div>
      </div>

      {drain.decisionAction && (
        <div className="dt-details-grid">
          <DetailsField label="Recommended action" value={drain.decisionAction} />
        </div>
      )}

      {drain.maintenanceRecommendation && (
        <div className="dt-details-grid">
          <DetailsField label="Maintenance" value={drain.maintenanceRecommendation} />
        </div>
      )}

      {details && (
        <div className="dt-section-title">On-demand detail (from AI services)</div>
      )}
      {details && details.forecast && details.forecast.worst && (
        <div className="dt-details-grid">
          <DetailsField
            label="Forecast horizon"
            value={details.forecast.worst.forecastMinutes
              ? `worst in ${details.forecast.worst.forecastMinutes} min`
              : null}
          />
          <DetailsField label="Trend" value={details.forecast.trendDirection} />
          <DetailsField
            label="Water trend"
            value={details.forecast.waterTrendPerMinute != null
              ? `${Number(details.forecast.waterTrendPerMinute).toFixed(2)} %/min`
              : null}
          />
        </div>
      )}
      {details && details.maintenance && details.maintenance.status === "READY" && (
        <div className="dt-details-grid">
          <DetailsField
            label="Blockage risk"
            value={details.maintenance.blockageRiskScore != null
              ? `${Math.round(details.maintenance.blockageRiskScore)}%`
              : null}
          />
          <DetailsField
            label="Recommendation"
            value={details.maintenance.maintenanceRecommendation}
          />
        </div>
      )}
      {details && details.vision && (
        <div className="dt-details-grid">
          <DetailsField
            label="Visual risk"
            value={details.vision.visualRiskScore != null
              ? `${Math.round(details.vision.visualRiskScore)}%`
              : null}
          />
          <DetailsField label="Recommendation" value={details.vision.recommendation} />
        </div>
      )}
      {details && details.decision && (
        <div className="dt-details-grid">
          <DetailsField
            label="Priority score"
            value={details.decision.priorityScore != null
              ? `${Math.round(details.decision.priorityScore)}/100`
              : null}
          />
          <DetailsField label="Action" value={details.decision.recommendedAction} />
        </div>
      )}
    </div>
  );
}

function RobotDetails({ robot, fleetInfo, coordinationInfo }) {
  return (
    <div>
      <div className="dt-section-title" style={{ color: "#16a34a" }}>
        ROBOT
      </div>
      <div className="dt-details-grid">
        <DetailsField label="Robot" value={robot.name} />
        <DetailsField label="Status" value={robot.status} />
        <DetailsField label="Battery" value={robot.batteryLevel != null ? `${Math.round(robot.batteryLevel)}%` : null} />
        <DetailsField label="Assigned zone" value={robot.zone} />
        <DetailsField label="Last active" value={formatTime(robot.lastActive)} />
      </div>

      {coordinationInfo && (
        <>
          <div className="dt-section-title" style={{ color: "#7c3aed" }}>
            MISSION COORDINATION (ADVISORY)
          </div>
          <div className="dt-details-grid">
            <div className="dt-field">
              <span className="dt-field-label">Availability</span>
              <span
                className="dt-field-value"
                style={{ color: "#7c3aed", fontWeight: 600 }}
              >
                {coordinationInfo.availabilityState || "Data unavailable"}
              </span>
            </div>
            <div className="dt-field">
              <span className="dt-field-label">Planned task</span>
              <span className="dt-field-value">
                {coordinationInfo.drainId != null
                  ? `Drain ${coordinationInfo.drainId}${
                      coordinationInfo.routeMode ? ` · ${coordinationInfo.routeMode}` : ""
                    }`
                  : "None"}
              </span>
            </div>
            {coordinationInfo.candidateScore != null && (
              <div className="dt-field">
                <span className="dt-field-label">Candidate score</span>
                <span className="dt-field-value">{coordinationInfo.candidateScore}/100</span>
              </div>
            )}
          </div>
        </>
      )}

      {fleetInfo && (
        <>
          <div className="dt-section-title" style={{ color: "#0891b2" }}>
            FLEET OPTIMIZATION (ADVISORY)
          </div>
          <div className="dt-details-grid">
            <div className="dt-field">
              <span className="dt-field-label">Availability</span>
              <span
                className="dt-field-value"
                style={{
                  color: AVAILABILITY_COLOR[fleetInfo.availabilityState] || "#334155",
                  fontWeight: 600
                }}
              >
                {fleetInfo.availabilityState || "Data unavailable"}
              </span>
            </div>
            <div className="dt-field">
              <span className="dt-field-label">Suggested task</span>
              <span className="dt-field-value">
                {fleetInfo.recommendedDrainId != null
                  ? `Drain ${fleetInfo.recommendedDrainId}${fleetInfo.chargingRequired ? " (charge first)" : ""}`
                  : "None"}
              </span>
            </div>
            {fleetInfo.estimatedAvailableReason && (
              <div className="dt-field">
                <span className="dt-field-label">Availability note</span>
                <span className="dt-field-value">{fleetInfo.estimatedAvailableReason}</span>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function SensorDetails({ sensor, intel }) {
  return (
    <div>
      <div className="dt-section-title" style={{ color: "#06b6d4" }}>
        SENSOR NODE
      </div>
      <div className="dt-details-grid">
        <DetailsField label="Sensor" value={`#${sensor.id}`} />
        <DetailsField label="Associated drain" value={sensor.drainLocation} />
        <DetailsField label="Zone" value={sensor.zone} />
        <DetailsField label="Water level" value={sensor.waterLevel != null ? `${sensor.waterLevel}%` : null} />
        <DetailsField label="Gas level" value={sensor.gasLevel != null ? `${sensor.gasLevel}%` : null} />
        <DetailsField label="Temperature" value={sensor.temperature != null ? `${sensor.temperature}°C` : null} />
        <DetailsField label="Status" value={sensor.status} />
        {/* Sensor intelligence overlay (Update #21) — read-only */}
        <DetailsField label="Health status" value={intel ? intel.healthStatus : null} />
        <DetailsField
          label="Health score"
          value={intel && intel.healthScore != null ? `${intel.healthScore}/100` : null}
        />
        <DetailsField label="Anomalies" value={intel ? intel.anomalyCount : null} />
        <DetailsField
          label="Latest signal"
          value={
            intel && intel.latestAnomaly
              ? `${intel.latestAnomaly.type} / ${intel.latestAnomaly.severity}`
              : null
          }
        />
      </div>
      {intel && intel.latestAnomaly && intel.latestAnomaly.message && (
        <div className="dt-details-grid">
          <div className="dt-field">
            <span className="dt-field-label" style={{ minWidth: 0 }}>
              Anomaly detail
            </span>
            <span className="dt-field-value">{intel.latestAnomaly.message}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function StationDetails({ station }) {
  return (
    <div>
      <div className="dt-section-title" style={{ color: "#f59e0b" }}>
        CHARGING STATION
      </div>
      <div className="dt-details-grid">
        <DetailsField label="Station" value={station.name} />
        <DetailsField label="Latitude" value={station.latitude} />
        <DetailsField label="Longitude" value={station.longitude} />
      </div>
    </div>
  );
}

function RouteDetails({ route }) {
  return (
    <div>
      <div className="dt-section-title" style={{ color: "#3b82f6" }}>
        PLANNED ROUTE
      </div>
      <div className="dt-details-grid">
        <DetailsField label="Target drain" value={route.location} />
        <DetailsField label="Zone" value={route.zone} />
        <DetailsField label="Drain status" value={route.drainStatus} />
        <DetailsField label="Planning status" value={route.planningStatus} />
        <DetailsField label="Route type" value={route.routeType} />
        <DetailsField label="Robot" value={route.robotName} />
        <DetailsField label="Robot battery" value={route.robotBatteryLevel != null ? `${Math.round(route.robotBatteryLevel)}%` : null} />
        <DetailsField label="Distance" value={route.totalDistance != null ? `${Number(route.totalDistance).toFixed(2)} km` : null} />
        <DetailsField label="Est. travel" value={route.formatTotalTravelTime} />
        <DetailsField label="Selection score" value={route.selectionScore != null ? `${Math.round(route.selectionScore)}/100` : null} />
      </div>
      {route.selectionReasons && route.selectionReasons.length > 0 && (
        <div className="dt-details-grid">
          <div className="dt-field">
            <span className="dt-field-label" style={{ minWidth: 0 }}>
              Selection reasons
            </span>
            <span className="dt-field-value" style={{ textAlign: "left" }}>
              {String(route.selectionReasons.join(", "))}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------
// Fallback / accessibility data list (non-3D access)
// ------------------------------------------------------------

function FallbackTable({ fusedDrains, robots, fleetByRobot, onSelect, selected }) {
  const visibleDrains = fusedDrains
    .filter((d) => d.x !== null && d.z !== null)
    .slice(0, 500);

  return (
    <div className="dt-fallback" aria-label="Digital twin data list">
      <h3 style={{ fontSize: "1rem", margin: "0 0 8px" }}>
        Data list (non-3D access)
      </h3>
      <div style={{ overflowX: "auto" }}>
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Location / Zone</th>
              <th>Status</th>
              <th>Water</th>
              <th>Flood risk</th>
              <th>AI decision</th>
              <th>Forecast</th>
              <th>Maintenance</th>
              <th>Fleet (advisory)</th>
            </tr>
          </thead>
          <tbody>
            {visibleDrains.length === 0 && (
              <tr>
                <td colSpan="9" style={{ textAlign: "center", color: "#94a3b8" }}>
                  No drain data available.
                </td>
              </tr>
            )}
            {visibleDrains.map((drain) => (
              <tr
                key={drain.id}
                className={
                  selected && selected.type === "drain" && Number(selected.id) === Number(drain.id)
                    ? "dt-row-selected"
                    : ""
                }
                onClick={() => onSelect("drain", drain.id)}
                tabIndex="0"
                onKeyDown={(e) => {
                  if (e.key === "Enter") onSelect("drain", drain.id);
                }}
                aria-label={`Select drain ${drain.location}`}
              >
                <td>{drain.id}</td>
                <td>
                  {drain.location}
                  {drain.zone ? ` / ${drain.zone}` : ""}
                </td>
                <td>
                  <span
                    style={{
                      color: STATUS_LEVEL_COLOR[drain.status] || "#334155",
                      fontWeight: 700
                    }}
                  >
                    {drain.status}
                  </span>
                </td>
                <td>{drain.waterLevel != null ? `${drain.waterLevel}%` : "—"}</td>
                <td>
                  <LevelBadge value={drain.riskLevel} score={drain.riskScore} />
                </td>
                <td>
                  <LevelBadge value={drain.decisionLevel} score={drain.decisionScore} />
                </td>
                <td>
                  <LevelBadge value={drain.forecastLevel} score={drain.forecastScore} />
                </td>
                <td>
                  <LevelBadge value={drain.maintenanceLevel} score={drain.maintenanceScore} />
                </td>
                <td>
                  {drain.fleet && drain.fleet.recommendedRobotId != null ? (
                    <span style={{ color: "#0891b2", fontWeight: 600 }}>
                      → {drain.fleet.recommendedRobotName || `Robot ${drain.fleet.recommendedRobotId}`}
                    </span>
                  ) : drain.fleet && drain.fleet.recommendationStatus === "UNASSIGNED" ? (
                    <span style={{ color: "#dc2626", fontWeight: 600 }}>unassigned</span>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {robots.length > 0 && (
        <div style={{ marginTop: "14px" }}>
          <h4 style={{ fontSize: "0.9rem", margin: "0 0 6px" }}>Robots</h4>
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Name</th>
                  <th>Zone</th>
                  <th>Status</th>
                  <th>Battery</th>
                  <th>Fleet (advisory)</th>
                </tr>
              </thead>
              <tbody>
                {robots
                  .filter((r) => r.x !== null && r.z !== null)
                  .map((robot) => (
                    <tr
                      key={robot.id}
                      className={
                        selected && selected.type === "robot" && Number(selected.id) === Number(robot.id)
                          ? "dt-row-selected"
                          : ""
                      }
                      onClick={() => onSelect("robot", robot.id)}
                      tabIndex="0"
                      onKeyDown={(e) => {
                        if (e.key === "Enter") onSelect("robot", robot.id);
                      }}
                    >
                      <td>{robot.id}</td>
                      <td>{robot.name}</td>
                      <td>{robot.zone}</td>
                      <td>{robot.status}</td>
                      <td>{robot.batteryLevel != null ? `${Math.round(robot.batteryLevel)}%` : "—"}</td>
                      <td>
                        {fleetByRobot && fleetByRobot[robot.id] ? (
                          <span
                            style={{
                              color:
                                AVAILABILITY_COLOR[fleetByRobot[robot.id].availabilityState] ||
                                "#334155",
                              fontWeight: 600
                            }}
                          >
                            {fleetByRobot[robot.id].availabilityState || "—"}
                            {fleetByRobot[robot.id].recommendedDrainId != null
                              ? ` → drain ${fleetByRobot[robot.id].recommendedDrainId}`
                              : ""}
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------
// Main page
// ------------------------------------------------------------

function DigitalTwinPage({ initialView = "overview" }) {
  const [state, dispatch] = useReducer(digitalTwinReducer, INITIAL_STATE);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);
  const [details, setDetails] = useState(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [viewRequest, setViewRequest] = useState({ mode: initialView, nonce: 0 });

  useEffect(() => {
    let cancelled = false;

    loadDigitalTwinData()
      .then((data) => {
        if (cancelled) return;
        dispatch({ type: "SET_DATA", ...data });
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("Digital Twin load error:", err);
        dispatch({
          type: "SET_DATA",
          drains: [],
          sensors: [],
          robots: [],
          chargingStations: [],
          routes: [],
          missions: [],
          origin: null,
          metrics: null,
          loadError: ["Failed to load digital twin data"],
          incidents: [],
          activeIncidentByDrain: {}
        });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // Live socket pipeline through the shared pure reducer
  useEffect(() => {
    const onSensor = (payload) => {
      if (payload && payload.drainId) dispatch({ type: "SENSOR_UPDATE", payload });
    };
    const onRisk = (payload) => {
      if (payload && payload.drainId) dispatch({ type: "RISK_UPDATE", payload });
    };
    const onForecast = (payload) => {
      if (payload && payload.drainId) dispatch({ type: "FORECAST_UPDATE", payload });
    };
    const onMaintenance = (payload) => {
      if (payload && payload.drainId) dispatch({ type: "MAINTENANCE_UPDATE", payload });
    };
    const onVision = (payload) => {
      if (payload && payload.drainId) dispatch({ type: "VISION_UPDATE", payload });
    };
    const onDecision = (payload) => {
      if (payload && payload.drainId) dispatch({ type: "DECISION_UPDATE", payload });
    };
    const onRoute = (payload) => {
      dispatch({ type: "ROUTE_UPDATE", payload });
    };
    const onDashboard = (payload) => {
      dispatch({ type: "DASHBOARD_UPDATE", payload });
    };
    const onIncident = (payload) => {
      if (payload && payload.incident) dispatch({ type: "INCIDENT_UPDATE", payload });
    };
    const onFleet = (payload) => {
      if (payload) dispatch({ type: "FLEET_OPTIMIZATION_UPDATE", payload });
    };
    const onCoordination = (payload) => {
      if (payload) dispatch({ type: "MISSION_COORDINATION_UPDATE", payload });
    };
    const onSensorIntelligence = (payload) => {
      if (payload) dispatch({ type: "SENSOR_INTELLIGENCE_UPDATE", payload });
    };

    socket.on("sensorUpdate", onSensor);
    socket.on("floodRiskUpdate", onRisk);
    socket.on("forecastUpdate", onForecast);
    socket.on("maintenanceUpdate", onMaintenance);
    socket.on("visionInspectionUpdate", onVision);
    socket.on("decisionUpdate", onDecision);
    socket.on("robotRouteUpdate", onRoute);
    socket.on("dashboardUpdate", onDashboard);
    socket.on("incidentUpdate", onIncident);
    socket.on("fleetOptimizationUpdate", onFleet);
    socket.on("missionCoordinationUpdate", onCoordination);
    socket.on("sensorIntelligenceUpdate", onSensorIntelligence);

    return () => {
      socket.off("sensorUpdate", onSensor);
      socket.off("floodRiskUpdate", onRisk);
      socket.off("forecastUpdate", onForecast);
      socket.off("maintenanceUpdate", onMaintenance);
      socket.off("visionInspectionUpdate", onVision);
      socket.off("decisionUpdate", onDecision);
      socket.off("robotRouteUpdate", onRoute);
      socket.off("dashboardUpdate", onDashboard);
      socket.off("incidentUpdate", onIncident);
      socket.off("fleetOptimizationUpdate", onFleet);
      socket.off("missionCoordinationUpdate", onCoordination);
      socket.off("sensorIntelligenceUpdate", onSensorIntelligence);
    };
  }, []);

  const fleet = state.fleet || null;
  const fleetByDrain = fleet && fleet.byDrain ? fleet.byDrain : null;
  const fleetByRobot = fleet && fleet.byRobot ? fleet.byRobot : null;

  const coordination = state.coordination || null;
  const coordinationByDrain =
    coordination && coordination.byDrain ? coordination.byDrain : null;
  const coordinationByRobot =
    coordination && coordination.byRobot ? coordination.byRobot : null;

  const fusedDrains = useMemo(
    () =>
      fuseDrains(
        state.drains,
        state.byDrain,
        state.decisionsByDrain || {},
        state.activeIncidentByDrain || {},
        fleetByDrain || {}
      ),
    [
      state.drains,
      state.byDrain,
      state.decisionsByDrain,
      state.activeIncidentByDrain,
      fleetByDrain
    ]
  );

  const handleSelect = (type, id) => {
    setSelected({ type, id });
    setDetails(null);
    if (type === "drain") {
      loadDrainDetails(id)
        .then((result) => setDetails(result))
        .catch(() => setDetails(null));
    }
  };

  const selectedDrain = selected && selected.type === "drain"
    ? fusedDrains.find((d) => Number(d.id) === Number(selected.id)) || null
    : null;

  const selectedRobot = selected && selected.type === "robot"
    ? state.robots.find((r) => Number(r.id) === Number(selected.id)) || null
    : null;

  const selectedSensor = selected && selected.type === "sensor"
    ? state.sensors.find((s) => Number(s.id) === Number(selected.id)) || null
    : null;

  const selectedStation = selected && selected.type === "station"
    ? state.chargingStations.find((s) => Number(s.id) === Number(selected.id)) || null
    : null;

  const selectedRoute = selected && selected.type === "route"
    ? state.routes.find((r) => Number(r.drainId) === Number(selected.id)) || null
    : null;

  const selectedRobotFleet =
    selectedRobot && fleetByRobot ? fleetByRobot[selectedRobot.id] || null : null;
  const selectedDrainFleetUnassigned =
    selectedDrain && fleet && fleet.unassignedByDrain
      ? fleet.unassignedByDrain[selectedDrain.id] || null
      : null;

  const metrics = state.metrics || {
    totalDrains: 0,
    criticalDrains: 0,
    activeRobots: 0,
    activeRoutes: 0
  };

  // liveBySensor kept for sensor panel parity; sensor visual state
  // already merged into byDrain via matches.
  const live = useMemo(
    () => ({
      byDrain: state.byDrain,
      bySensor: state.bySensor,
      sensorIntelligence: state.sensorIntelligence || null
    }),
    [state.byDrain, state.bySensor, state.sensorIntelligence]
  );

  const requestView = (mode) =>
    setViewRequest((prev) => ({ mode, nonce: prev.nonce + 1 }));

  const clearSelected = () => {
    setSelected(null);
    setDetails(null);
  };

  const systemOk = state.loadError.length === 0;

  return (
    <div className="dt-page">
      {/* Requirement #14: header stats */}
      <div className="dt-header">
        <div className="dt-stat">
          <div className="dt-stat-icon" style={{ background: systemOk ? "#16a34a" : "#dc2626" }}>
            <FaCube />
          </div>
          <div>
            <div className={`dt-stat-value ${systemOk ? "dt-system-ok" : "dt-system-error"}`}>
              {systemOk ? "ONLINE" : "DEGRADED"}
            </div>
            <div className="dt-stat-label">System status</div>
          </div>
        </div>

        <div className="dt-stat">
          <div className="dt-stat-icon" style={{ background: "#16a34a" }}>
            <FaRobot />
          </div>
          <div>
            <div className="dt-stat-value">{metrics.activeRobots || 0}</div>
            <div className="dt-stat-label">Active robots</div>
          </div>
        </div>

        <div className="dt-stat">
          <div className="dt-stat-icon" style={{ background: "#dc2626" }}>
            <FaExclamationTriangle />
          </div>
          <div>
            <div className="dt-stat-value">{metrics.criticalDrains || 0}</div>
            <div className="dt-stat-label">Critical drains</div>
          </div>
        </div>

        <div className="dt-stat">
          <div className="dt-stat-icon" style={{ background: "#2563eb" }}>
            <FaTint />
          </div>
          <div>
            <div className="dt-stat-value">{metrics.totalDrains || 0}</div>
            <div className="dt-stat-label">Total drains</div>
          </div>
        </div>

        <div className="dt-stat">
          <div className="dt-stat-icon" style={{ background: "#7c3aed" }}>
            <FaRoute />
          </div>
          <div>
            <div className="dt-stat-value">{metrics.activeRoutes || 0}</div>
            <div className="dt-stat-label">Active routes</div>
          </div>
        </div>

        <div className="dt-stat">
          <div className="dt-stat-icon" style={{ background: fleet ? FLEET_STATUS_COLOR[fleet.status] || "#64748b" : "#94a3b8" }}>
            <FaBolt />
          </div>
          <div>
            <div className="dt-stat-value">{fleet ? fleet.summary.unassignedTasks : "—"}</div>
            <div className="dt-stat-label">Unassigned tasks</div>
          </div>
        </div>

        <div className="dt-stat">
          <div className="dt-stat-icon" style={{ background: "#7c3aed" }}>
            <FaNetworkWired />
          </div>
          <div>
            <div className="dt-stat-value">
              {coordination
                ? `${coordination.summary.assignedTasks}/${coordination.summary.totalTasks}`
                : "—"}
            </div>
            <div className="dt-stat-label">
              Mission coordination
              {coordination && coordination.summary.conflicts > 0
                ? ` · ${coordination.summary.conflicts} conflict(s)`
                : ""}
            </div>
          </div>
        </div>

        <div className="dt-stat">
          <div className="dt-stat-icon" style={{ background: "#475569" }}>
            <FaClock />
          </div>
          <div>
            <div className="dt-stat-value" style={{ fontSize: "0.95rem" }}>
              {metrics.lastUpdated ? formatTime(metrics.lastUpdated) : "—"}
            </div>
            <div className="dt-stat-label">Last update</div>
          </div>
        </div>
      </div>

      {/* Toolbar */}
      <div className="dt-controls">
        <div className="dt-search">
          <FaSearch aria-hidden="true" />
          <input
            type="text"
            placeholder="Search drains, robots, zones..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search digital twin"
          />
        </div>

        <div className="dt-filter-chips" role="group" aria-label="Focus filter">
          <button
            className={`dt-chip${filter === "all" ? " active" : ""}`}
            onClick={() => setFilter("all")}
            aria-pressed={filter === "all"}
          >
            All
          </button>
          <button
            className={`dt-chip dt-chip-critical${filter === "critical" ? " active" : ""}`}
            onClick={() => setFilter("critical")}
            aria-pressed={filter === "critical"}
          >
            Critical drains
          </button>
          <button
            className={`dt-chip dt-chip-robots${filter === "robots" ? " active" : ""}`}
            onClick={() => setFilter("robots")}
            aria-pressed={filter === "robots"}
          >
            Robots
          </button>
        </div>

        <div className="dt-view-buttons" role="group" aria-label="Camera view">
          <button className="dt-btn primary" onClick={() => requestView("overview")}>
            Overview
          </button>
          <button className="dt-btn" onClick={() => requestView("top")}>
            Top
          </button>
          <button className="dt-btn" onClick={() => requestView("reset")}>
            Reset
          </button>
        </div>
      </div>

      {state.loadError.length > 0 && (
        <div className="dt-notice">
          Warning: one or more data endpoints failed — some objects are shown as
          "Data unavailable". ({state.loadError.join(", ")})
        </div>
      )}

      {/* Requirement #14 core: the 3D scene */}
      <DigitalTwin
        data={state}
        live={live}
        selected={selected}
        onSelect={handleSelect}
        height={520}
        viewRequest={viewRequest}
        filter={filter}
        search={search}
      />

      {loading && <div className="dt-loading">Loading digital twin...</div>}

      <DigitalTwinLegend />

      {/* Requirement #14: selected object details */}
      {(selectedDrain || selectedRobot || selectedSensor || selectedStation || selectedRoute) && (
        <div className="dt-details" aria-live="polite">
          <div className="dt-details-head">
            <h3 className="dt-details-title">
              {selectedDrain
                ? `${selectedDrain.name}`
                : selectedRobot
                  ? selectedRobot.name
                  : selectedSensor
                    ? `Sensor #${selectedSensor.id}`
                    : selectedStation
                      ? selectedStation.name
                      : `Route → ${selectedRoute.location || `drain ${selectedRoute.drainId}`}`}
            </h3>
            <button className="dt-close" onClick={clearSelected} aria-label="Close details">
              Close
            </button>
          </div>
          {selectedDrain && (
            <DrainDetails
              drain={selectedDrain}
              details={details}
              fleetUnassigned={selectedDrainFleetUnassigned}
              coordination={
                coordinationByDrain
                  ? coordinationByDrain[selectedDrain.id] || null
                  : null
              }
            />
          )}
          {selectedRobot && (
            <RobotDetails
              robot={selectedRobot}
              fleetInfo={selectedRobotFleet}
              coordinationInfo={
                coordinationByRobot
                  ? coordinationByRobot[selectedRobot.id] || null
                  : null
              }
            />
          )}
          {selectedSensor && (
            <SensorDetails
              sensor={selectedSensor}
              intel={
                state.sensorIntelligence && state.sensorIntelligence.bySensor
                  ? state.sensorIntelligence.bySensor[selectedSensor.id] || null
                  : null
              }
            />
          )}
          {selectedStation && <StationDetails station={selectedStation} />}
          {selectedRoute && <RouteDetails route={selectedRoute} />}
        </div>
      )}

      {/* Requirement #17: non-3D fallback data list */}
      <FallbackTable
        fusedDrains={fusedDrains}
        robots={state.robots}
        fleetByRobot={fleetByRobot}
        onSelect={handleSelect}
        selected={selected}
      />
    </div>
  );
}

export default DigitalTwinPage;