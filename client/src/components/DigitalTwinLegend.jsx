// ============================================================
// AI-DrainOS Digital Twin — legend
//
// Shares the exact SAME palette as the 3D scene via
// LEVEL_COLOR / STATUS_COLOR from digitalTwinUtils.mjs, so the
// legend can never drift from the rendered colors.
// ============================================================

import { LEVEL_COLOR, STATUS_COLOR } from "../services/digitalTwinUtils.mjs";

const RISK_LEVELS = [
  { label: "Low", color: LEVEL_COLOR.LOW },
  { label: "Moderate", color: LEVEL_COLOR.MODERATE },
  { label: "High", color: LEVEL_COLOR.HIGH },
  { label: "Critical", color: LEVEL_COLOR.CRITICAL }
];

const ENTITIES = [
  { label: "Manhole (drain)", color: STATUS_COLOR.Normal, round: false },
  { label: "Sensor node", color: "#06b6d4", round: true },
  { label: "Robot", color: "#16a34a", round: true },
  { label: "Charging station", color: "#f59e0b", round: true },
  { label: "Direct route", color: "#3b82f6", round: false },
  { label: "Charging-stop route", color: "#f59e0b", round: false }
];

function DigitalTwinLegend() {
  return (
    <div className="dt-legend" aria-label="Digital twin legend">
      <span className="dt-legend-item">
        <strong>Risk level</strong>
      </span>
      {RISK_LEVELS.map((level) => (
        <span className="dt-legend-item" key={level.label}>
          <span
            className="dt-swatch round"
            style={{ background: level.color }}
            aria-hidden="true"
          />
          {level.label}
        </span>
      ))}

      <span className="dt-legend-item" style={{ marginLeft: "10px" }}>
        <strong>Objects</strong>
      </span>
      {ENTITIES.map((entity) => (
        <span className="dt-legend-item" key={entity.label}>
          <span
            className={`dt-swatch${entity.round ? " round" : ""}`}
            style={{ background: entity.color }}
            aria-hidden="true"
          />
          {entity.label}
        </span>
      ))}
    </div>
  );
}

export default DigitalTwinLegend;