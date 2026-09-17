// ============================================================
// AI-DrainOS — Digital Twin compact dashboard preview
//
// A small live 3D canvas on the Dashboard that reuses the exact
// same data service, reducer and Socket.IO events as the full
// page (no second connection, no second movement loop).
// ============================================================

import { useEffect, useMemo, useReducer, useState } from "react";
import { FaCube } from "react-icons/fa";

import DigitalTwin from "./DigitalTwin";
import { loadDigitalTwinData } from "../services/digitalTwinService";
import {
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
  byDrain: {},
  bySensor: {}
};

function DigitalTwinPreview({ onOpen }) {
  const [state, dispatch] = useReducer(digitalTwinReducer, INITIAL_STATE);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    loadDigitalTwinData()
      .then((data) => {
        if (!cancelled) dispatch({ type: "SET_DATA", ...data });
      })
      .catch((err) => {
        if (!cancelled) {
          console.error("Digital Twin preview load error:", err);
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
            loadError: ["Preview failed to load"]
          });
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const forward = (type) => (payload) => {
      if (!payload || (payload.drainId === undefined && type !== "ROUTE_UPDATE")) return;
      dispatch({ type, payload });
    };
    const onDashboard = (payload) => dispatch({ type: "DASHBOARD_UPDATE", payload });
    const onIncident = (payload) => {
      if (payload && payload.incident) dispatch({ type: "INCIDENT_UPDATE", payload });
    };

    socket.on("sensorUpdate", forward("SENSOR_UPDATE"));
    socket.on("floodRiskUpdate", forward("RISK_UPDATE"));
    socket.on("forecastUpdate", forward("FORECAST_UPDATE"));
    socket.on("maintenanceUpdate", forward("MAINTENANCE_UPDATE"));
    socket.on("visionInspectionUpdate", forward("VISION_UPDATE"));
    socket.on("decisionUpdate", forward("DECISION_UPDATE"));
    socket.on("robotRouteUpdate", forward("ROUTE_UPDATE"));
    socket.on("dashboardUpdate", onDashboard);
    socket.on("incidentUpdate", onIncident);

    return () => {
      socket.off("sensorUpdate");
      socket.off("floodRiskUpdate");
      socket.off("forecastUpdate");
      socket.off("maintenanceUpdate");
      socket.off("visionInspectionUpdate");
      socket.off("decisionUpdate");
      socket.off("robotRouteUpdate");
      socket.off("dashboardUpdate");
      socket.off("incidentUpdate");
    };
  }, []);

  const fusedDrains = useMemo(
    () =>
      fuseDrains(
        state.drains,
        state.byDrain,
        state.decisionsByDrain || {},
        state.activeIncidentByDrain || {}
      ),
    [state.drains, state.byDrain, state.decisionsByDrain, state.activeIncidentByDrain]
  );

  const live = useMemo(
    () => ({ byDrain: state.byDrain, bySensor: state.bySensor }),
    [state.byDrain, state.bySensor]
  );

  const metrics = state.metrics || {};
  const critical = fusedDrains.filter(
    (d) =>
      d.status === "Critical" ||
      d.riskLevel === "CRITICAL" ||
      d.decisionLevel === "CRITICAL"
  ).length;

  return (
    <section className="dt-preview" aria-label="Digital twin 3D preview">
      <div className="dt-preview-head">
        <h2>
          <FaCube style={{ marginRight: 8, color: "#2563eb" }} />
          Digital Twin (3D)
        </h2>
        <div className="dt-preview-stats">
          <span>
            Drains <b>{metrics.totalDrains ?? 0}</b>
          </span>
          <span>
            Active robots <b>{metrics.activeRobots ?? 0}</b>
          </span>
          <span>
            Critical <b style={{ color: "#dc2626" }}>{critical}</b>
          </span>
          <span>
            Routes <b>{metrics.activeRoutes ?? 0}</b>
          </span>
        </div>
        <button className="dt-btn primary" onClick={onOpen} disabled={loading}>
          Open full 3D view →
        </button>
      </div>

      <DigitalTwin
        data={state}
        live={live}
        compact
        height={260}
        viewRequest={{ mode: "overview", nonce: 0 }}
      />
    </section>
  );
}

export default DigitalTwinPreview;