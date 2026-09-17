// ============================================================
// AI-DrainOS Digital Twin — interactive 3D visualization
//
// Renders the existing system state (drains, sensors, robots,
// charging stations and planned robot routes) inside a single
// three.js canvas (@react-three/fiber + @react-three/drei).
//
// HONESTY CONTRACT:
//  - Every value rendered here comes from the existing REST APIs
//    or the existing Socket.IO events. Nothing is fabricated.
//  - Water levels are clamped 0-100 (safeWaterLevel); when a
//    signal is missing the object shows "Data unavailable".
//  - Drain "Flood Risk" and "AI Decision" are two SEPARATE
//    indicators and are never merged.
//  - The coordinate space is a documented VISUALIZATION grid
//    (see digitalTwinUtils.mjs) - not a survey-grade GIS.
//
// PERF: entity meshes are memoized per-id and keyed on primitive
// props, so a live sensor update only re-renders the affected
// object, never the whole scene.
// ============================================================

import { memo, useMemo, useRef } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Grid, Html, Line, OrbitControls } from "@react-three/drei";
import { damp3 } from "maath/easing";
import * as THREE from "three";

import {
  LEVEL_COLOR,
  AVAILABILITY_COLOR,
  normalizeLevel,
  safeWaterLevel,
  waterLevelToHeight,
  fuseDrains,
  buildActiveIncidentByDrain
} from "../services/digitalTwinUtils.mjs";

import "../styles/digitaltwin.css";

// Stable empty references so React useMemo dependencies never change
// identity on every render when a dataset is still loading.
const EMPTY_ARRAY = [];
const EMPTY_OBJECT = {};

// ------------------------------------------------------------
// Shared helpers
// ------------------------------------------------------------

function statusColor(status) {
  return (
    {
      Critical: "#dc2626",
      Warning: "#f59e0b",
      Normal: "#16a34a",
      Active: "#16a34a",
      Idle: "#64748b",
      Charging: "#f59e0b",
      Maintenance: "#ea580c"
    }[status] || "#94a3b8"
  );
}

function batteryColor(battery) {
  if (battery === null || battery === undefined) return "#94a3b8";
  if (battery <= 20) return "#dc2626";
  if (battery <= 50) return "#f59e0b";
  return "#22c55e";
}

// Drain status -> derived *visual* level guidance (only used for
// color, never shown as a computed flood-risk value).
function drainStatusLevel(status) {
  if (status === "Critical") return "CRITICAL";
  if (status === "Warning") return "MODERATE";
  return null;
}

const labelWrap = {
  pointerEvents: "none",
  transform: "translateY(4px)",
  textAlign: "center",
  color: "#e2e8f0",
  fontSize: "11px",
  fontWeight: 600,
  lineHeight: 1.35,
  textShadow: "0 1px 2px rgba(0,0,0,0.85)",
  whiteSpace: "nowrap",
  fontFamily:
    "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
};

// ------------------------------------------------------------
// Drain object
// ------------------------------------------------------------

const DrainView = memo(function DrainView({
  id,
  x,
  z,
  name,
  status,
  waterLevel,
  riskLevel,
  riskScore,
  decisionLevel,
  decisionScore,
  incident,
  fleet,
  fleetUnassigned,
  selected,
  compact,
  onSelect
}) {
  const rimColor = statusColor(status);
  const derived = drainStatusLevel(status);
  const riskVisual =
    normalizeLevel(riskLevel) || derived || (riskScore != null ? levelFromScore(riskScore) : null);
  const decisionVisual = normalizeLevel(decisionLevel);
  const water = safeWaterLevel(waterLevel);
  const waterHeight = waterLevelToHeight(water);
  const riskColor = LEVEL_COLOR[riskVisual] || "#64748b";
  const decisionColor = LEVEL_COLOR[decisionVisual] || "#64748b";
  const decisionBarHeight = (decisionScore != null ? Math.max(0, Math.min(100, decisionScore)) : 0) / 100 * 1.3;
  const riskBarHeight = (riskScore != null ? Math.max(0, Math.min(100, riskScore)) : 0) / 100 * 1.3;
  const incidentColor = incident ? LEVEL_COLOR[incident.severity] || "#ef4444" : null;

  // Fleet overlay (Update #19) — advisory only. Cyan = a robot is
  // recommended for this task; red = the task is unassigned.
  const fleetRecommended = Boolean(fleet && fleet.recommendedRobotId != null);
  const fleetColor = fleetUnassigned
    ? "#ef4444"
    : fleetRecommended
      ? "#22d3ee"
      : null;

  return (
    <group
      position={[x, 0, z]}
      onClick={(e) => {
        e.stopPropagation();
        onSelect("drain", id);
      }}
      onPointerOver={(e) => {
        e.stopPropagation();
        document.body.style.cursor = "pointer";
      }}
      onPointerOut={() => {
        document.body.style.cursor = "default";
      }}
    >
      {/* concrete manhole ring */}
      <mesh position={[0, 0.16, 0]} castShadow>
        <cylinderGeometry args={[1.05, 1.15, 0.32, 28]} />
        <meshStandardMaterial color={rimColor} roughness={0.85} metalness={0.1} />
      </mesh>

      {/* inner shaded shaft */}
      <mesh position={[0, 0.12, 0]}>
        <cylinderGeometry args={[0.86, 0.86, 0.32, 28]} />
        <meshStandardMaterial color="#1e293b" roughness={0.95} />
      </mesh>

      {/* water fill (real clamped sensor/live level; 0 when unknown) */}
      {waterHeight > 0.03 && (
        <mesh position={[0, waterHeight / 2 + 0.14, 0]}>
          <cylinderGeometry args={[0.8, 0.8, waterHeight, 22]} />
          <meshStandardMaterial
            color="#3b82f6"
            transparent
            opacity={0.62}
            roughness={0.25}
            metalness={0.2}
          />
        </mesh>
      )}

      {/* flood-risk ring (flat) on the ground */}
      <mesh
        position={[0, 0.02, 0]}
        rotation={[-Math.PI / 2, 0, 0]}
      >
        <ringGeometry args={[1.45, 1.78, 48]} />
        <meshBasicMaterial
          color={riskColor}
          transparent
          opacity={riskVisual ? 0.9 : 0.25}
          side={THREE.DoubleSide}
        />
      </mesh>

      {/* AI-decision standing bar (kept separate from risk ring) */}
      {decisionVisual && decisionBarHeight > 0 && (
        <mesh position={[1.5, decisionBarHeight / 2, 0]}>
          <boxGeometry args={[0.12, decisionBarHeight, 0.12]} />
          <meshStandardMaterial
            color={decisionColor}
            emissive={decisionColor}
            emissiveIntensity={0.6}
          />
        </mesh>
      )}

      {/* flood-risk standing bar */}
      {riskVisual && riskBarHeight > 0 && riskScore != null && (
        <mesh position={[-1.5, riskBarHeight / 2, 0]}>
          <boxGeometry args={[0.12, riskBarHeight, 0.12]} />
          <meshStandardMaterial
            color={riskColor}
            emissive={riskColor}
            emissiveIntensity={0.45}
          />
        </mesh>
      )}

      {/* emergency incident beacon (Update #18, additive) */}
      {incident && (
        <>
          <mesh position={[0, 1.35, 0]}>
            <sphereGeometry args={[0.3, 18, 18]} />
            <meshStandardMaterial
              color={incidentColor}
              emissive={incidentColor}
              emissiveIntensity={1}
            />
          </mesh>
          <mesh position={[0, 1.35, 0]}>
            <sphereGeometry args={[0.6, 18, 18]} />
            <meshBasicMaterial color={incidentColor} transparent opacity={0.18} />
          </mesh>
          <mesh position={[0, 0.09, 0]} rotation={[-Math.PI / 2, 0, 0]}>
            <ringGeometry args={[2.35, 2.6, 48]} />
            <meshBasicMaterial
              color={incidentColor}
              transparent
              opacity={0.85}
              side={THREE.DoubleSide}
            />
          </mesh>
        </>
      )}

      {/* fleet-optimization advisory ring (Update #19) */}
      {fleetColor && (
        <mesh position={[0, 0.07, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[2.72, 2.96, 48]} />
          <meshBasicMaterial color={fleetColor} transparent opacity={0.85} side={THREE.DoubleSide} />
        </mesh>
      )}

      {/* selection highlight ring */}
      {selected && (
        <mesh position={[0, 0.05, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[1.9, 2.25, 48]} />
          <meshBasicMaterial color="#facc15" transparent opacity={0.95} side={THREE.DoubleSide} />
        </mesh>
      )}

      {!compact && (
        <Html position={[0, 2.6, 0]} center distanceFactor={10} zIndexRange={[20, 0]}>
          <div style={labelWrap}>
            <div>{name}</div>
            <div style={{ color: "#94a3b8", fontWeight: 400 }}>
              {water === null ? "Data unavailable" : `water ${water}%`}
            </div>
            {incident && (
              <div style={{ color: incidentColor, fontWeight: 600 }}>
                🚑 {incident.severity} · {incident.status}
              </div>
            )}
            {fleetRecommended && (
              <div style={{ color: "#22d3ee", fontWeight: 600 }}>
                ↳ {fleet.recommendedRobotName || `robot ${fleet.recommendedRobotId}`}
                {fleet.chargingRequired ? " (charge first)" : ""}
              </div>
            )}
            {fleetUnassigned && (
              <div style={{ color: "#f87171", fontWeight: 600 }}>
                ⚠ unassigned{fleetUnassigned.reason ? ` · ${fleetUnassigned.reason}` : ""}
              </div>
            )}
          </div>
        </Html>
      )}
    </group>
  );
});

function levelFromScore(score) {
  const num = Number(score);
  if (!Number.isFinite(num)) return null;
  if (num >= 75) return "CRITICAL";
  if (num >= 50) return "HIGH";
  if (num >= 25) return "MODERATE";
  return "LOW";
}

// ------------------------------------------------------------
// Sensor object
// ------------------------------------------------------------

const SensorView = memo(function SensorView({
  id,
  x,
  z,
  sensorIdLabel,
  waterLevel,
  status,
  selected,
  compact,
  onSelect
}) {
  const water = safeWaterLevel(waterLevel);
  const isWarning = status === "Warning" || status === "Critical";
  const color = water !== null && water >= 75 ? "#dc2626" : isWarning ? "#f59e0b" : "#06b6d4";

  return (
    <group
      position={[x, 0, z]}
      onClick={(e) => {
        e.stopPropagation();
        onSelect("sensor", id);
      }}
      onPointerOver={(e) => {
        e.stopPropagation();
        document.body.style.cursor = "pointer";
      }}
      onPointerOut={() => {
        document.body.style.cursor = "default";
      }}
    >
      <mesh position={[0, 2.0, 0]}>
        <octahedronGeometry args={[0.45]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.7} />
      </mesh>
      <mesh position={[0, 1.15, 0]}>
        <cylinderGeometry args={[0.04, 0.04, 1.4, 8]} />
        <meshStandardMaterial color="#94a3b8" />
      </mesh>
      {selected && (
        <mesh position={[0, 2.0, 0]}>
          <sphereGeometry args={[0.85, 20, 20]} />
          <meshBasicMaterial color="#facc15" transparent opacity={0.28} />
        </mesh>
      )}
      {!compact && (
        <Html position={[0, 2.85, 0]} center distanceFactor={10} zIndexRange={[20, 0]}>
          <div style={{ ...labelWrap, fontSize: "10px" }}>
            <div>{sensorIdLabel}</div>
            <div style={{ color: "#94a3b8", fontWeight: 400 }}>
              {water === null ? "Data unavailable" : `water ${water}%`}
            </div>
          </div>
        </Html>
      )}
    </group>
  );
});

// ------------------------------------------------------------
// Robot object
// ------------------------------------------------------------

const RobotView = memo(function RobotView({
  id,
  x,
  z,
  name,
  status,
  battery,
  fleetInfo,
  selected,
  compact,
  onSelect
}) {
  const bodyColor = statusColor(status);
  const batt = battery;
  const battColor = batteryColor(batt);
  const battWidth = batt != null ? Math.max(0.06, (Math.min(100, Math.max(0, batt)) / 100) * 0.66) : 0.06;

  // Fleet overlay (Update #19) — advisory only, never a dispatch.
  const availability = fleetInfo ? fleetInfo.availabilityState : null;
  const availabilityColor = AVAILABILITY_COLOR[availability] || null;
  const recommendedDrainId = fleetInfo ? fleetInfo.recommendedDrainId : null;
  const chargingRequired = Boolean(fleetInfo && fleetInfo.chargingRequired);

  return (
    <group
      position={[x, 0, z]}
      onClick={(e) => {
        e.stopPropagation();
        onSelect("robot", id);
      }}
      onPointerOver={(e) => {
        e.stopPropagation();
        document.body.style.cursor = "pointer";
      }}
      onPointerOut={() => {
        document.body.style.cursor = "default";
      }}
    >
      {/* platform */}
      <mesh position={[0, 0.12, 0]}>
        <cylinderGeometry args={[0.7, 0.8, 0.24, 18]} />
        <meshStandardMaterial color="#1e293b" roughness={0.8} />
      </mesh>
      {/* body */}
      <mesh position={[0, 0.42, 0]}>
        <boxGeometry args={[0.72, 0.36, 0.95]} />
        <meshStandardMaterial color={bodyColor} roughness={0.6} />
      </mesh>
      {/* cab/head */}
      <mesh position={[0, 0.74, 0.05]}>
        <boxGeometry args={[0.5, 0.3, 0.55]} />
        <meshStandardMaterial color="#0f172a" roughness={0.5} metalness={0.2} />
      </mesh>
      {/* headlight */}
      <mesh position={[0, 0.62, 0.35]}>
        <boxGeometry args={[0.28, 0.1, 0.05]} />
        <meshStandardMaterial color="#fde68a" emissive="#facc15" emissiveIntensity={0.6} />
      </mesh>
      {/* battery level bar */}
      <mesh position={[0, 1.06, 0]}>
        <boxGeometry args={[0.7, 0.08, 0.06]} />
        <meshStandardMaterial color="#1e293b" />
      </mesh>
      <mesh position={[battWidth / 2 - 0.35, 1.06, 0]}>
        <boxGeometry args={[battWidth, 0.09, 0.07]} />
        <meshBasicMaterial color={battColor} />
      </mesh>
      {/* antenna */}
      <mesh position={[0.18, 1.08, 0.3]}>
        <cylinderGeometry args={[0.02, 0.02, 0.22, 6]} />
        <meshStandardMaterial color="#94a3b8" />
      </mesh>
      {/* fleet availability ring (Update #19) */}
      {availabilityColor && (
        <mesh position={[0, 0.03, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.84, 0.99, 32]} />
          <meshBasicMaterial color={availabilityColor} transparent opacity={0.9} side={THREE.DoubleSide} />
        </mesh>
      )}
      {/* recommended-task highlight ring (advisory only) */}
      {recommendedDrainId != null && (
        <mesh position={[0, 0.04, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[1.42, 1.62, 40]} />
          <meshBasicMaterial color="#22d3ee" transparent opacity={0.85} side={THREE.DoubleSide} />
        </mesh>
      )}
      {selected && (
        <mesh position={[0, 0.35, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[1.0, 1.32, 32]} />
          <meshBasicMaterial color="#facc15" transparent opacity={0.9} side={THREE.DoubleSide} />
        </mesh>
      )}
      {!compact && (
        <Html position={[0, 1.6, 0]} center distanceFactor={10} zIndexRange={[20, 0]}>
          <div style={labelWrap}>
            <div>{name}</div>
            <div style={{ color: "#94a3b8", fontWeight: 400 }}>
              {status}
              {batt != null ? ` · ${Math.round(batt)}%` : ""}
            </div>
            {availability && (
              <div style={{ color: availabilityColor || "#94a3b8", fontWeight: 600 }}>
                {availability}
                {chargingRequired ? " · charge required" : ""}
              </div>
            )}
            {recommendedDrainId != null && (
              <div style={{ color: "#22d3ee", fontWeight: 600 }}>
                ↳ suggested for drain {recommendedDrainId}
              </div>
            )}
          </div>
        </Html>
      )}
    </group>
  );
});

// ------------------------------------------------------------
// Charging station object
// ------------------------------------------------------------

const ChargingStationView = memo(function ChargingStationView({
  id,
  x,
  z,
  name,
  selected,
  compact,
  onSelect
}) {
  return (
    <group
      position={[x, 0, z]}
      onClick={(e) => {
        e.stopPropagation();
        onSelect("station", id);
      }}
      onPointerOver={(e) => {
        e.stopPropagation();
        document.body.style.cursor = "pointer";
      }}
      onPointerOut={() => {
        document.body.style.cursor = "default";
      }}
    >
      <mesh position={[0, 0.08, 0]}>
        <cylinderGeometry args={[1.0, 1.15, 0.16, 24]} />
        <meshStandardMaterial color="#334155" roughness={0.8} />
      </mesh>
      <mesh position={[0, 0.6, 0]}>
        <boxGeometry args={[0.5, 0.9, 0.5]} />
        <meshStandardMaterial color="#f59e0b" emissive="#f59e0b" emissiveIntensity={0.45} />
      </mesh>
      <mesh position={[0, 1.25, 0]}>
        <sphereGeometry args={[0.22, 16, 16]} />
        <meshStandardMaterial color="#fde68a" emissive="#facc15" emissiveIntensity={1.4} />
      </mesh>
      <mesh position={[-0.36, 0.6, 0]}>
        <boxGeometry args={[0.08, 0.5, 0.08]} />
        <meshStandardMaterial color="#1e293b" />
      </mesh>
      {selected && (
        <mesh position={[0, 0.05, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[1.3, 1.6, 32]} />
          <meshBasicMaterial color="#facc15" transparent opacity={0.9} side={THREE.DoubleSide} />
        </mesh>
      )}
      {!compact && (
        <Html position={[0, 1.9, 0]} center distanceFactor={10} zIndexRange={[20, 0]}>
          <div style={{ ...labelWrap, fontSize: "10px" }}>
            <div>⚡ {name}</div>
          </div>
        </Html>
      )}
    </group>
  );
});

// ------------------------------------------------------------
// Route object
// ------------------------------------------------------------

const RouteView = memo(function RouteView({
  route,
  selected,
  compact,
  onSelect
}) {
  const points = route.points;
  if (!points || points.length < 2) return null;

  const color = route.routeType === "CHARGING_STOP" ? "#f59e0b" : "#3b82f6";
  const linePoints = points.map((p) => [p.x, 0.18, p.z]);
  const mid = points[Math.floor(points.length / 2)];

  return (
    <group>
      <Line points={linePoints} color={color} lineWidth={selected ? 3 : 1.6} transparent opacity={selected ? 1 : 0.8} />

      {route.waypoints.map((wp, index) => (
        <mesh
          key={`${route.drainId}-wp-${index}-${wp.label}`}
          position={[wp.x, 0.24, wp.z]}
          onClick={(e) => {
            e.stopPropagation();
            onSelect("route", route.drainId);
          }}
          onPointerOver={(e) => {
            e.stopPropagation();
            document.body.style.cursor = "pointer";
          }}
          onPointerOut={() => {
            document.body.style.cursor = "default";
          }}
        >
          <sphereGeometry args={[wp.label === "CHARGING_STATION" ? 0.34 : 0.24, 14, 14]} />
          <meshBasicMaterial
            color={wp.label === "CHARGING_STATION" ? "#f59e0b" : color}
            transparent
            opacity={selected ? 1 : 0.9}
          />
        </mesh>
      ))}

      {!compact && mid && (
        <Html position={[mid.x, 0.6, mid.z]} center distanceFactor={10} zIndexRange={[20, 0]}>
          <div
            role="button"
            aria-label={`Select route to ${route.location || route.drainId}`}
            onClick={(e) => {
              e.stopPropagation();
              onSelect("route", route.drainId);
            }}
            style={{
              pointerEvents: "auto",
              cursor: "pointer",
              background: selected ? "#facc15" : color,
              color: "#0f172a",
              fontSize: "10px",
              fontWeight: 700,
              padding: "2px 7px",
              borderRadius: "8px",
              whiteSpace: "nowrap",
              boxShadow: "0 1px 3px rgba(0,0,0,0.6)"
            }}
          >
            {route.routeType === "CHARGING_STOP" ? "⚡ route" : "route"} →{" "}
            {route.location || `drain ${route.drainId}`}
          </div>
        </Html>
      )}
    </group>
  );
});

// ------------------------------------------------------------
// Environment + camera rig
// ------------------------------------------------------------

const VIEW_POSITIONS = {
  overview: [30, 36, 42],
  top: [0.02, 58, 0.02],
  reset: [30, 36, 42]
};

function CameraRig({ viewRequest }) {
  const camera = useThree((s) => s.camera);
  const controlsRef = useRef(null);

  const targetPos = useMemo(() => {
    const mode = VIEW_POSITIONS[viewRequest.mode] ? viewRequest.mode : "overview";
    return VIEW_POSITIONS[mode];
  }, [viewRequest.mode]);

  useFrame((_, delta) => {
    if (controlsRef.current) {
      controlsRef.current.update();
    }
    damp3(camera.position, targetPos, 0.18, delta);
    camera.lookAt(0, 0, 0);
  });

  return (
    <OrbitControls
      ref={controlsRef}
      makeDefault
      enableDamping
      dampingFactor={0.08}
      maxPolarAngle={Math.PI / 2.04}
      minDistance={8}
      maxDistance={160}
      target={[0, 0, 0]}
    />
  );
}

function SceneEnvironment() {
  return (
    <>
      <color attach="background" args={["#0b1220"]} />
      <fog attach="fog" args={["#0b1220", 70, 160]} />
      <ambientLight intensity={0.55} />
      <hemisphereLight args={["#94a3b8", "#1e293b", 0.5]} />
      <directionalLight
        position={[26, 42, 20]}
        intensity={1.3}
        castShadow
        shadow-mapSize-width={1024}
        shadow-mapSize-height={1024}
      />
      <pointLight position={[-20, 12, -18]} intensity={0.35} color="#60a5fa" />

      {/* ground plane */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, 0]} receiveShadow>
        <planeGeometry args={[220, 220]} />
        <meshStandardMaterial color="#0f172a" roughness={0.95} metalness={0.05} />
      </mesh>

      {/* technical grid */}
      <Grid
        position={[0, 0, 0]}
        args={[200, 200]}
        cellSize={1.6}
        cellColor="#1e3a5f"
        sectionSize={8}
        sectionColor="#2f5c8f"
        fadeDistance={110}
        fadeStrength={1.2}
        infiniteGrid={false}
      />
    </>
  );
}

// ------------------------------------------------------------
// Main DigitalTwin component
// ------------------------------------------------------------

function DigitalTwin({
  data,
  live = { byDrain: {}, bySensor: {} },
  selected = null,
  onSelect = () => {},
  height = 520,
  compact = false,
  viewRequest = { mode: "overview", nonce: 0 },
  filter = "all",
  search = ""
}) {
  // Honest focus filters: they only change what is drawn, never the
  // underlying data. Objects that do not match are simply not drawn.
  const q = String(search || "").trim().toLowerCase();
  const matchesQuery = (obj, fields) => {
    if (!q) return true;
    if (String(obj.id).toLowerCase().includes(q)) return true;
    return fields.some((field) => String(obj[field] || "").toLowerCase().includes(q));
  };
  const isCritical = (d) =>
    d.status === "Critical" ||
    d.riskLevel === "CRITICAL" ||
    d.decisionLevel === "CRITICAL" ||
    Boolean(d.incident);
  const isCriticalByDrainId = (id, drainsList) => {
    const target = drainsList.find((d) => Number(d.id) === Number(id));
    return target ? isCritical(target) : true;
  };
  const drains = data && data.drains ? data.drains : EMPTY_ARRAY;
  const sensors = data && data.sensors ? data.sensors : EMPTY_ARRAY;
  const robots = data && data.robots ? data.robots : EMPTY_ARRAY;
  const stations = data && data.chargingStations ? data.chargingStations : EMPTY_ARRAY;
  const routes = data && data.routes ? data.routes : EMPTY_ARRAY;
  const decisions =
    data && data.decisionsByDrain ? data.decisionsByDrain : EMPTY_OBJECT;
  const activeIncidentByDrain =
    data && data.activeIncidentByDrain ? data.activeIncidentByDrain : null;
  const incidentList = data && data.incidents ? data.incidents : null;
  const incidentsByDrain = useMemo(
    () =>
      activeIncidentByDrain ||
      (incidentList ? buildActiveIncidentByDrain(incidentList) : EMPTY_OBJECT),
    [activeIncidentByDrain, incidentList]
  );

  // Fleet optimization overlay (Update #19) — additive + advisory.
  // Missing fleet data simply draws no markers (graceful degrade).
  const fleet = data && data.fleet ? data.fleet : null;
  const fleetByDrain = fleet && fleet.byDrain ? fleet.byDrain : EMPTY_OBJECT;
  const fleetUnassignedByDrain =
    fleet && fleet.unassignedByDrain ? fleet.unassignedByDrain : EMPTY_OBJECT;
  const fleetByRobot = fleet && fleet.byRobot ? fleet.byRobot : EMPTY_OBJECT;

  const fusedDrains = useMemo(
    () => fuseDrains(drains, live.byDrain, decisions, incidentsByDrain),
    [drains, live.byDrain, decisions, incidentsByDrain]
  );

  // Filtered object sets for the active focus mode + search term.
  // Unmatched objects are not drawn (the legend explains the modes).
  const isRobotFocus = filter === "robots";
  const isCriticalFocus = filter === "critical";

  const renderDrains = fusedDrains.filter((d) => {
    if (d.x === null || d.z === null) return false;
    if (isCriticalFocus && !isCritical(d)) return false;
    return matchesQuery(d, ["location", "zone", "name"]);
  });
  const renderSensors = sensors.filter((s) => {
    if (s.x === null || s.z === null) return false;
    if (isCriticalFocus || isRobotFocus) return false;
    return matchesQuery(s, ["drainLocation", "zone"]);
  });
  const renderRobots = robots.filter((r) => {
    if (r.x === null || r.z === null) return false;
    if (isCriticalFocus) return false;
    return matchesQuery(r, ["name", "zone"]);
  });
  const renderStations = stations.filter((s) => {
    if (s.x === null || s.z === null) return false;
    if (isCriticalFocus) return false;
    return matchesQuery(s, ["name"]);
  });
  const renderRoutes = routes.filter((r) => {
    if (!r.points || r.points.length < 2) return false;
    if (isRobotFocus) return false;
    if (isCriticalFocus && !isCriticalByDrainId(r.drainId, fusedDrains)) return false;
    return matchesQuery(r, ["location", "zone"]);
  });

  const hasAnyData =
    fusedDrains.length > 0 ||
    sensors.length > 0 ||
    robots.length > 0 ||
    stations.length > 0;

  return (
    <div className="dt-canvas-wrap" style={{ height }}>
      <div className="dt-canvas-hint">
        {compact ? "Live 3D preview" : "Rotate · Zoom · Pan — click any object for details"}
      </div>
      <div className="dt-canvas-note">
        Visualization coords (not survey-grade GIS)
      </div>

      {!hasAnyData ? (
        <div className="dt-loading">
          {data && data.loadError && data.loadError.length > 0
            ? "3D scene unavailable — check that the backend is running."
            : "Loading digital twin..."}
        </div>
      ) : (
        <Canvas
          camera={{ position: [30, 36, 42], fov: 45, near: 0.1, far: 400 }}
          dpr={[1, 1.75]}
          gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
          style={{ touchAction: "none" }}
        >
          <SceneEnvironment />
          <CameraRig viewRequest={viewRequest} />

          {renderRoutes.map((route) => (
            <RouteView
              key={`route-${route.drainId}`}
              route={route}
              selected={selected && selected.type === "route" && Number(selected.id) === Number(route.drainId)}
              compact={compact}
              onSelect={onSelect}
            />
          ))}

          {renderDrains.map((drain) => (
            <DrainView
              key={`drain-${drain.id}`}
              id={drain.id}
              x={drain.x}
              z={drain.z}
              name={drain.name}
              status={drain.status}
              waterLevel={drain.waterLevel}
              riskLevel={drain.riskLevel}
              riskScore={drain.riskScore}
              decisionLevel={drain.decisionLevel}
              decisionScore={drain.decisionScore}
              incident={drain.incident}
              fleet={fleetByDrain[drain.id] || null}
              fleetUnassigned={fleetUnassignedByDrain[drain.id] || null}
              selected={selected && selected.type === "drain" && Number(selected.id) === Number(drain.id)}
              compact={compact}
              onSelect={onSelect}
            />
          ))}

          {renderStations.map((station) => (
            <ChargingStationView
              key={`station-${station.id}`}
              id={station.id}
              x={station.x}
              z={station.z}
              name={station.name}
              selected={selected && selected.type === "station" && Number(selected.id) === Number(station.id)}
              compact={compact}
              onSelect={onSelect}
            />
          ))}

          {renderSensors.map((sensor) => (
            <SensorView
              key={`sensor-${sensor.id}`}
              id={sensor.id}
              x={sensor.x}
              z={sensor.z}
              sensorIdLabel={`Sensor ${sensor.id}`}
              waterLevel={sensor.waterLevel}
              status={sensor.status}
              selected={selected && selected.type === "sensor" && Number(selected.id) === Number(sensor.id)}
              compact={compact}
              onSelect={onSelect}
            />
          ))}

          {renderRobots.map((robot) => (
            <RobotView
              key={`robot-${robot.id}`}
              id={robot.id}
              x={robot.x}
              z={robot.z}
              name={robot.name}
              status={robot.status}
              battery={robot.batteryLevel}
              fleetInfo={fleetByRobot[robot.id] || null}
              selected={selected && selected.type === "robot" && Number(selected.id) === Number(robot.id)}
              compact={compact}
              onSelect={onSelect}
            />
          ))}
        </Canvas>
      )}
    </div>
  );
}

export default DigitalTwin;