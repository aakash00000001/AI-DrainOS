import { useEffect, useState } from "react";
import axios from "axios";
import socket from "../services/socket";
import { API_URL } from "../services/api";

const STATUS_COLORS = {
  ROBOT_SELECTED: "#16a34a",
  NO_ROBOT_AVAILABLE: "#dc2626",
  NO_COORDINATES: "#f59e0b",
  DRAIN_NOT_FOUND: "#64748b",
  SKIPPED: "#94a3b8",
  ERROR: "#dc2626"
};

const STATUS_LABELS = {
  ROBOT_SELECTED: "Route Planned",
  NO_ROBOT_AVAILABLE: "No Robot Available",
  NO_COORDINATES: "No Coordinates",
  DRAIN_NOT_FOUND: "Drain Not Found",
  SKIPPED: "Not Required",
  ERROR: "Planning Error"
};

function StatusBadge({ status }) {
  const bg = STATUS_COLORS[status] || "#64748b";

  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: "12px",
        fontSize: "0.75rem",
        fontWeight: "600",
        color: "#fff",
        background: bg
      }}
    >
      {STATUS_LABELS[status] || status}
    </span>
  );
}

function RouteBadge({ routeType }) {
  let text = "No Route";
  let color = "#94a3b8";

  if (routeType === "CHARGING_STOP") {
    text = "⚡ Charging Stop";
    color = "#f59e0b";
  } else if (routeType === "DIRECT") {
    text = "Direct";
    color = "#2563eb";
  }

  if (!routeType) return <span style={{ color: "#94a3b8" }}>—</span>;

  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: "12px",
        fontSize: "0.75rem",
        fontWeight: "600",
        color: "#fff",
        background: color
      }}
    >
      {text}
    </span>
  );
}

function WaypointList({ route }) {
  if (!route || !route.waypoints || route.waypoints.length === 0) {
    return null;
  }

  return (
    <div
      style={{
        marginTop: "8px",
        background: "#f8fafc",
        borderRadius: "8px",
        padding: "8px 10px",
        fontSize: "0.8rem"
      }}
    >
      {route.waypoints.map((wp, index) => (
        <div
          key={wp.label}
          style={{
            display: "flex",
            justifyContent: "space-between",
            padding: "2px 0",
            borderBottom:
              index < route.waypoints.length - 1 ? "1px dashed #e2e8f0" : "none"
          }}
        >
          <span style={{ fontWeight: "600", color: "#334155" }}>{wp.label}</span>
          <span style={{ color: "#64748b" }}>
            {wp.cumulativeDistance} units · {wp.cumulativeTravelSeconds}s
          </span>
        </div>
      ))}
    </div>
  );
}

function RouteDetail({ route }) {
  if (!route) return null;

  return (
    <div
      style={{
        marginTop: "8px",
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))",
        gap: "8px",
        fontSize: "0.8rem"
      }}
    >
      <div>
        <div style={{ color: "#94a3b8" }}>Distance</div>
        <b>{route.totalDistance} units</b>
      </div>
      <div>
        <div style={{ color: "#94a3b8" }}>Est. Time</div>
        <b>{route.formatTotalTravelTime}</b>
      </div>
      <div>
        <div style={{ color: "#94a3b8" }}>Battery Cost</div>
        <b>{route.totalBatteryCost}%</b>
      </div>
      {route.chargingStation && (
        <div>
          <div style={{ color: "#94a3b8" }}>Charging At</div>
          <b>{route.chargingStation.stationName}</b>
        </div>
      )}
    </div>
  );
}

function RobotRoutePlanner() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(false);
  const [openDrain, setOpenDrain] = useState(null);

  const loadRoutes = (refresh = false) => {
    axios
      .get(`${API_URL}/dashboard/robot-routes${refresh ? "?refresh=true" : ""}`)
      .then((response) => {
        setData(response.data);
        setError(false);
      })
      .catch(() => {
        setError(true);
      });
  };

  useEffect(() => {
    loadRoutes();

    const interval = setInterval(() => loadRoutes(), 10000);

    const onRouteUpdate = (payload) => {
      if (!payload || !payload.drain) return;

      setData((prev) => {
        if (!prev) return prev;

        const routes = prev.routes.map((r) => {
          if (r.drainId !== payload.drain.id) return r;

          return {
            ...r,
            planningStatus: payload.status,
            robot: payload.robot,
            route: payload.route,
            selectionScore: payload.selectionScore || null,
            selectionReasons: payload.selectionReasons || []
          };
        });

        return { ...prev, routes };
      });
    };

    socket.on("robotRouteUpdate", onRouteUpdate);

    return () => {
      clearInterval(interval);
      socket.off("robotRouteUpdate", onRouteUpdate);
    };
  }, []);

  if (error && !data) {
    return (
      <div className="panel-card">
        <h2>🗺️ Robot Route Planner</h2>
        <p className="empty-state">
          Route data unavailable - check that the backend is running.
        </p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="panel-card">
        <h2>🗺️ Robot Route Planner</h2>
        <p className="empty-state">Loading route plans...</p>
      </div>
    );
  }

  const { routes = [], warningCritical = 0, totalDrains = 0 } = data;

  const planned = routes.filter((r) => r.planningStatus === "ROBOT_SELECTED");
  const direct = planned.filter((r) => r.route && r.route.type === "DIRECT");
  const charging = planned.filter(
    (r) => r.route && r.route.type === "CHARGING_STOP"
  );

  return (
    <div className="panel-card">
      <h2>🗺️ Robot Route Planner</h2>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
          gap: "12px",
          marginBottom: "20px"
        }}
      >
        <div className="stat-card" style={{ background: "#eff6ff" }}>
          <div style={{ fontSize: "1.5rem", fontWeight: "700", color: "#2563eb" }}>
            {planned.length}
          </div>
          <div style={{ fontSize: "0.85rem", color: "#64748b" }}>Routes Planned</div>
        </div>

        <div className="stat-card" style={{ background: "#f0fdf4" }}>
          <div style={{ fontSize: "1.5rem", fontWeight: "700", color: "#16a34a" }}>
            {direct.length}
          </div>
          <div style={{ fontSize: "0.85rem", color: "#64748b" }}>Direct Routes</div>
        </div>

        <div className="stat-card" style={{ background: "#fefce8" }}>
          <div style={{ fontSize: "1.5rem", fontWeight: "700", color: "#f59e0b" }}>
            {charging.length}
          </div>
          <div style={{ fontSize: "0.85rem", color: "#64748b" }}>Charging Stops</div>
        </div>

        <div className="stat-card">
          <div style={{ fontSize: "1.5rem", fontWeight: "700" }}>
            {warningCritical}
          </div>
          <div style={{ fontSize: "0.85rem", color: "#64748b" }}>
            Warning / Critical
          </div>
        </div>
      </div>

      {routes.length === 0 ? (
        <p className="empty-state">No drain routes available yet.</p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: "0.9rem"
            }}
          >
            <thead>
              <tr style={{ borderBottom: "1px solid #e2e8f0", color: "#64748b" }}>
                <th style={{ padding: "8px", textAlign: "left" }}>Drain</th>
                <th style={{ padding: "8px", textAlign: "left" }}>Planning</th>
                <th style={{ padding: "8px", textAlign: "left" }}>Robot</th>
                <th style={{ padding: "8px", textAlign: "left" }}>Route</th>
                <th style={{ padding: "8px", textAlign: "left" }}>Battery</th>
                <th style={{ padding: "8px", textAlign: "left" }}>Est. Time</th>
              </tr>
            </thead>
            <tbody>
              {routes.map((route) => {
                const isRow =
                  route.status === "Warning" || route.status === "Critical";

                if (!isRow) return null;

                return (
                  <tr
                    key={route.drainId}
                    style={{
                      borderBottom: "1px solid #f1f5f9",
                      cursor: "pointer",
                      background:
                        openDrain === route.drainId ? "#f8fafc" : "transparent"
                    }}
                    onClick={() =>
                      setOpenDrain(
                        openDrain === route.drainId ? null : route.drainId
                      )
                    }
                  >
                    <td style={{ padding: "8px" }}>
                      <div style={{ fontWeight: "500" }}>{route.location}</div>
                      <div style={{ fontSize: "0.8rem", color: "#94a3b8" }}>
                        {route.zone} · {route.status}
                      </div>
                    </td>
                    <td style={{ padding: "8px" }}>
                      <StatusBadge status={route.planningStatus} />
                    </td>
                    <td style={{ padding: "8px" }}>
                      {route.robot ? (
                        <div>
                          <div style={{ fontWeight: "500" }}>
                            {route.robot.robotName}
                          </div>
                          <div style={{ fontSize: "0.8rem", color: "#94a3b8" }}>
                            ID {route.robot.id}
                          </div>
                        </div>
                      ) : (
                        <span style={{ color: "#94a3b8" }}>—</span>
                      )}
                    </td>
                    <td style={{ padding: "8px" }}>
<RouteBadge
  routeType={route.route ? route.route.type : null}
/>
                    </td>
                    <td style={{ padding: "8px" }}>
                      {route.robot ? `${route.robot.batteryLevel}%` : "—"}
                    </td>
                    <td style={{ padding: "8px" }}>
                      {route.route ? route.route.formatTotalTravelTime : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {openDrain !== null && (
        (() => {
          const selected = routes.find((r) => r.drainId === openDrain);

          if (!selected) return null;

          return (
            <div
              style={{
                marginTop: "16px",
                border: "1px solid #e2e8f0",
                borderRadius: "10px",
                padding: "14px"
              }}
            >
              <h3 style={{ margin: "0 0 6px" }}>
                {selected.location} · {selected.zone}
              </h3>

              {selected.planningStatus === "NO_ROBOT_AVAILABLE" && (
                <p style={{ color: "#dc2626", fontSize: "0.9rem" }}>
                  {selected.reason || "No robot available"}
                </p>
              )}

              {selected.planningStatus === "ROBOT_SELECTED" && selected.robot && (
                <>
                  <p style={{ fontSize: "0.9rem" }}>
                    <b>{selected.robot.robotName}</b>{" "}
                    {selected.route && selected.route.type === "CHARGING_STOP"
                      ? "will charge first, then head to this drain"
                      : "is routed directly to this drain"}
                    {" "}- battery {selected.robot.batteryLevel}%.
                  </p>

                  {selected.selectionReasons &&
                    selected.selectionReasons.length > 0 && (
                      <ul
                        style={{
                          fontSize: "0.8rem",
                          color: "#475569",
                          margin: "8px 0",
                          paddingLeft: "18px"
                        }}
                      >
                        {selected.selectionReasons.map((reason, i) => (
                          <li key={i}>{reason}</li>
                        ))}
                      </ul>
                    )}

                  {selected.route && (
                    <>
                      <RouteDetail route={selected.route} />
                      <WaypointList route={selected.route} />
                    </>
                  )}
                </>
              )}

              {selected.planningStatus === "SKIPPED" && (
                <p style={{ color: "#94a3b8", fontSize: "0.9rem" }}>
                  {selected.reason || "Planning not required"}
                </p>
              )}
            </div>
          );
        })()
      )}

      <p
        style={{
          marginTop: "16px",
          fontSize: "0.75rem",
          color: "#94a3b8",
          fontStyle: "italic"
        }}
      >
        {totalDrains} drain{totalDrains !== 1 ? "s" : ""} | Route planning is
        coordinate-space estimation derived from the existing movement loop.
        Robots on missions or charging are never selected.
      </p>
    </div>
  );
}

export default RobotRoutePlanner;