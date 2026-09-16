import {
  MapContainer,
  TileLayer,
  Marker,
  Popup,
  Polyline,
  CircleMarker,
  useMap,
} from "react-leaflet";

import React, { useEffect, useState } from "react";
import axios from "axios";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { API_URL } from "../services/api";

const robotIcon = new L.Icon({
  iconUrl: "https://cdn-icons-png.flaticon.com/512/4712/4712109.png",
  iconSize: [40, 40],
  iconAnchor: [20, 40],
  popupAnchor: [0, -35],
});

const chargingIcon = new L.Icon({
  iconUrl: "https://cdn-icons-png.flaticon.com/512/1048/1048315.png",
  iconSize: [35, 35],
  iconAnchor: [17, 35],
  popupAnchor: [0, -30],
});

function FollowRobot({ position }) {
  const map = useMap();

  useEffect(() => {
    if (position) {
      map.flyTo(position, map.getZoom(), {
        duration: 1.5,
      });
    }
  }, [position, map]);

  return null;
}

function getDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;

  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
}

function DrainMap() {
  const [robots, setRobots] = useState([]);
  const [robotPaths, setRobotPaths] = useState({});
  const [navigationLines, setNavigationLines] = useState([]);
  const [chargingStations, setChargingStations] = useState([]);
  const [drains, setDrains] = useState([]);

  // -------------------------
  // Load Robots
  // -------------------------
  const loadRobots = async () => {
    try {
      const response = await axios.get(
        `${API_URL}/robots`
      );

      const robotData = response.data;

      setRobots(robotData);

      // -------------------------
      // Robot → Critical Drain
      // -------------------------
      const lines = [];

      const availableDrains = drains.filter(
        (drain) => drain.status === "Critical"
      );

      const assignedDrainIds = [];

      robotData.forEach((robot) => {
        if (
          robot.latitude === null ||
          robot.longitude === null
        ) {
          return;
        }

        let nearest = null;
        let minDistance = Infinity;

        availableDrains.forEach((drain) => {
          if (assignedDrainIds.includes(drain.id)) {
            return;
          }

          if (
            drain.latitude === null ||
            drain.longitude === null
          ) {
            return;
          }

          const distance = getDistance(
            Number(robot.latitude),
            Number(robot.longitude),
            Number(drain.latitude),
            Number(drain.longitude)
          );

          if (distance < minDistance) {
            minDistance = distance;
            nearest = drain;
          }
        });

        if (nearest) {
          assignedDrainIds.push(nearest.id);

          lines.push({
            id: robot.id,
            positions: [
              [
                Number(robot.latitude),
                Number(robot.longitude),
              ],
              [
                Number(nearest.latitude),
                Number(nearest.longitude),
              ],
            ],
          });
        }
      });

      setNavigationLines(lines);

      // -------------------------
      // Robot Movement Path
      // -------------------------
      setRobotPaths((previousPaths) => {
        const updated = { ...previousPaths };

        robotData.forEach((robot) => {
          if (
            robot.latitude === null ||
            robot.longitude === null
          ) {
            return;
          }

          const point = [
            Number(robot.latitude),
            Number(robot.longitude),
          ];

          if (!updated[robot.id]) {
            updated[robot.id] = [point];
          } else {
            updated[robot.id] = [
              ...updated[robot.id],
              point,
            ].slice(-20);
          }
        });

        return updated;
      });
    } catch (error) {
      console.log("Robot Load Error:", error);
    }
  };

  // -------------------------
  // Load Charging Stations
  // -------------------------
  const loadChargingStations = async () => {
    try {
      const response = await axios.get(
        `${API_URL}/charging-stations`
      );

      setChargingStations(response.data);
    } catch (error) {
      console.log(
        "Charging Station Error:",
        error
      );
    }
  };

  // -------------------------
  // Load Drains
  // -------------------------
  const loadDrains = async () => {
    try {
      const response = await axios.get(
        `${API_URL}/drains`
      );

      setDrains(response.data);
    } catch (error) {
      console.log("Drain Load Error:", error);
    }
  };

  // -------------------------
  // Initial Load
  // -------------------------
  useEffect(() => {
    loadDrains();
    loadChargingStations();
  }, []);

  // -------------------------
  // Robot Refresh
  // -------------------------
  useEffect(() => {
    loadRobots();

    const interval = setInterval(() => {
      loadRobots();
      loadDrains();
      loadChargingStations();
    }, 5000);

    return () => clearInterval(interval);
  }, [drains]);

  // -------------------------
  // Map Center
  // -------------------------
  const mapCenter = [9.925, 78.120];

  const followRobot =
    robots.find(
      (robot) =>
        robot.latitude !== null &&
        robot.longitude !== null
    );

  return (
    <div
      className="map-box"
      style={{
        background: "#ffffff",
        padding: "20px",
        borderRadius: "18px",
        boxShadow:
          "0 10px 25px rgba(0,0,0,.08)",
        marginBottom: "25px",
      }}
    >
      <h2>🗺️ Live Drain & Robot Tracking</h2>

      <div
        style={{
          display: "flex",
          gap: "20px",
          flexWrap: "wrap",
          marginBottom: "15px",
          fontSize: "14px",
          fontWeight: "600",
        }}
      >
        <span>🟢 Normal</span>
        <span>🟠 Warning</span>
        <span>🔴 Critical</span>
        <span>🤖 Robot</span>
        <span>🔋 Charging Station</span>
      </div>

      <MapContainer
        center={mapCenter}
        zoom={15}
        style={{
          height: "600px",
          width: "100%",
          borderRadius: "15px",
        }}
      >
        <TileLayer
          attribution="&copy; OpenStreetMap contributors"
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />

        {/* Follow First Active Robot */}
        {followRobot && (
          <FollowRobot
            position={[
              Number(followRobot.latitude),
              Number(followRobot.longitude),
            ]}
          />
        )}

        {/* Robot → Critical Drain Navigation */}
        {navigationLines.map((line) => (
          <Polyline
            key={`navigation-${line.id}`}
            positions={line.positions}
            pathOptions={{
              color: "#2563eb",
              weight: 5,
              dashArray: "10,10",
            }}
          />
        ))}

        {/* Drain Markers */}
        {drains.map((drain) => {
          if (
            drain.latitude === null ||
            drain.longitude === null
          ) {
            return null;
          }

          const statusColor =
            drain.status === "Critical"
              ? "#ef4444"
              : drain.status === "Warning"
              ? "#f59e0b"
              : "#22c55e";

          const radius =
            drain.status === "Critical"
              ? 18
              : drain.status === "Warning"
              ? 12
              : 8;

          return (
            <CircleMarker
              key={drain.id}
              center={[
                Number(drain.latitude),
                Number(drain.longitude),
              ]}
              radius={radius}
              pathOptions={{
                color: statusColor,
                fillColor: statusColor,
                fillOpacity: 0.8,
                weight: 2,
              }}
            >
              <Popup>
                <h3>🕳️ {drain.location}</h3>

                <p>
                  <b>Status:</b>{" "}
                  {drain.status}
                </p>

                <p>
                  <b>Latitude:</b>{" "}
                  {drain.latitude}
                </p>

                <p>
                  <b>Longitude:</b>{" "}
                  {drain.longitude}
                </p>
              </Popup>
            </CircleMarker>
          );
        })}

       {/* Robots & Movement Paths */}
        {robots.map((robot) => {
          if (
            robot.latitude === null ||
            robot.longitude === null
          ) {
            return null;
          }

          const position = [
            Number(robot.latitude),
            Number(robot.longitude),
          ];

          return (
            <React.Fragment key={robot.id}>
              {/* Robot Movement Path */}
              {robotPaths[robot.id] &&
                robotPaths[robot.id].length > 1 && (
                  <Polyline
                    positions={robotPaths[robot.id]}
                    pathOptions={{
                      color: "#2563eb",
                      weight: 3,
                      opacity: 0.7,
                    }}
                  />
                )}

              {/* Robot Marker */}
              <Marker
                position={position}
                icon={robotIcon}
              >
                <Popup>
                  <h3>
                    🤖 {robot.robot_name}
                  </h3>

                  <p>
                    <b>Status:</b>{" "}
                    {robot.status}
                  </p>

                  <p>
                    <b>Battery:</b>{" "}
                    {robot.battery_level}%
                  </p>

                  <p>
                    <b>Latitude:</b>{" "}
                    {robot.latitude}
                  </p>

                  <p>
                    <b>Longitude:</b>{" "}
                    {robot.longitude}
                  </p>

                  {robot.status ===
                    "Charging" && (
                    <p>
                      🔋 Robot is charging
                    </p>
                  )}
                </Popup>
              </Marker>
            </React.Fragment>
          );
        })}
      </MapContainer>
    </div>
  );
}

export default DrainMap;