import { useEffect, useState } from "react";
import axios from "axios";
import socket from "../services/socket";
import { API_URL } from "../services/api";

const LEVEL_COLORS = {
  LOW: "#16a34a",
  MODERATE: "#f59e0b",
  HIGH: "#ea580c",
  CRITICAL: "#dc2626"
};

const ACTION_LABELS = {
  CONTINUE_MONITORING: "Monitor",
  MONITOR_CLOSELY: "Close Watch",
  INSPECT_DRAIN: "Inspect",
  IMMEDIATE_ROBOT_INSPECTION: "Send Robot"
};

const ACTION_COLORS = {
  CONTINUE_MONITORING: "#16a34a",
  MONITOR_CLOSELY: "#f59e0b",
  INSPECT_DRAIN: "#ea580c",
  IMMEDIATE_ROBOT_INSPECTION: "#dc2626"
};

function ScoreBar({ score }) {
  if (score === null || score === undefined) {
    return <span style={{ color: "#64748b" }}>n/a</span>;
  }

  const color = LEVEL_COLORS[
    score >= 75 ? "CRITICAL" : score >= 50 ? "HIGH" : score >= 25 ? "MODERATE" : "LOW"
  ] || "#64748b";

  return (
    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
      <div
        style={{
          width: "120px",
          height: "8px",
          background: "#e2e8f0",
          borderRadius: "6px",
          overflow: "hidden"
        }}
      >
        <div
          style={{
            width: `${score}%`,
            height: "100%",
            background: color,
            borderRadius: "6px"
          }}
        />
      </div>
      <b>{score}/100</b>
    </div>
  );
}

function Badge({ level, text }) {
  const bg = LEVEL_COLORS[level] || "#64748b";

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
      {text}
    </span>
  );
}

function AIDecisionPanel() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(false);

  const loadDecisions = () => {
    axios
      .get(`${API_URL}/dashboard/decisions`)
      .then((response) => {
        setData(response.data);
        setError(false);
      })
      .catch(() => {
        setError(true);
      });
  };

  useEffect(() => {
    loadDecisions();

    const interval = setInterval(loadDecisions, 5000);

    const onDecisionUpdate = (payload) => {
      setData((prev) => {
        if (!prev) return prev;

        const topPriority = prev.topPriority.map((drain) => {
          if (drain.drainId !== payload.drainId) return drain;

          return {
            ...drain,
            priorityScore: payload.priorityScore,
            priorityLevel: payload.priorityLevel,
            recommendedAction: payload.recommendedAction
          };
        });

        return { ...prev, topPriority };
      });
    };

    socket.on("decisionUpdate", onDecisionUpdate);

    return () => {
      clearInterval(interval);
      socket.off("decisionUpdate", onDecisionUpdate);
    };
  }, []);

  if (error && !data) {
    return (
      <div className="panel-card">
        <h2>🧠 AI Drain Decisions</h2>
        <p className="empty-state">
          Decision data unavailable - check that the backend is running.
        </p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="panel-card">
        <h2>🧠 AI Drain Decisions</h2>
        <p className="empty-state">Loading AI decisions...</p>
      </div>
    );
  }

  const {
    counts,
    averagePriorityScore,
    topPriority,
    actionDistribution,
    insufficientData,
    totalDrains
  } = data;

  return (
    <div className="panel-card">
      <h2>🧠 AI Drain Decisions</h2>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
          gap: "12px",
          marginBottom: "20px"
        }}
      >
        <div className="stat-card" style={{ background: "#f0fdf4" }}>
          <div style={{ fontSize: "1.5rem", fontWeight: "700", color: "#16a34a" }}>
            {counts.low}
          </div>
          <div style={{ fontSize: "0.85rem", color: "#64748b" }}>LOW</div>
        </div>

        <div className="stat-card" style={{ background: "#fefce8" }}>
          <div style={{ fontSize: "1.5rem", fontWeight: "700", color: "#f59e0b" }}>
            {counts.moderate}
          </div>
          <div style={{ fontSize: "0.85rem", color: "#64748b" }}>MODERATE</div>
        </div>

        <div className="stat-card" style={{ background: "#fff7ed" }}>
          <div style={{ fontSize: "1.5rem", fontWeight: "700", color: "#ea580c" }}>
            {counts.high}
          </div>
          <div style={{ fontSize: "0.85rem", color: "#64748b" }}>HIGH</div>
        </div>

        <div className="stat-card" style={{ background: "#fef2f2" }}>
          <div style={{ fontSize: "1.5rem", fontWeight: "700", color: "#dc2626" }}>
            {counts.critical}
          </div>
          <div style={{ fontSize: "0.85rem", color: "#64748b" }}>CRITICAL</div>
        </div>

        <div className="stat-card">
          <div style={{ fontSize: "1.5rem", fontWeight: "700" }}>
            {averagePriorityScore !== null ? `${averagePriorityScore}` : "n/a"}
          </div>
          <div style={{ fontSize: "0.85rem", color: "#64748b" }}>Avg Priority</div>
        </div>

        {insufficientData > 0 && (
          <div className="stat-card" style={{ background: "#f8fafc" }}>
            <div style={{ fontSize: "1.5rem", fontWeight: "700", color: "#94a3b8" }}>
              {insufficientData}
            </div>
            <div style={{ fontSize: "0.85rem", color: "#64748b" }}>Insufficient Data</div>
          </div>
        )}
      </div>

      {topPriority.length === 0 ? (
        <p className="empty-state">No decision data yet for any drain.</p>
      ) : (
        <>
          <h3>Top Priority Drains</h3>
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
                  <th style={{ padding: "8px", textAlign: "left" }}>Priority</th>
                  <th style={{ padding: "8px", textAlign: "left" }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {topPriority.map((drain) => (
                  <tr
                    key={drain.drainId}
                    style={{ borderBottom: "1px solid #f1f5f9" }}
                  >
                    <td style={{ padding: "8px" }}>
                      <div style={{ fontWeight: "500" }}>{drain.location}</div>
                      <div style={{ fontSize: "0.8rem", color: "#94a3b8" }}>
                        {drain.zone}
                      </div>
                    </td>
                    <td style={{ padding: "8px" }}>
                      <ScoreBar score={drain.priorityScore} />
                    </td>
                    <td style={{ padding: "8px" }}>
                      <Badge
                        level={drain.priorityLevel}
                        text={`${ACTION_LABELS[drain.recommendedAction] || drain.recommendedAction}`}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <div style={{ marginTop: "16px" }}>
        <h3>Recommended Actions</h3>
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "12px",
            fontSize: "0.85rem"
          }}
        >
          {Object.entries(actionDistribution).map(([action, count]) => (
            <div
              key={action}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "6px"
              }}
            >
              <div
                style={{
                  width: "10px",
                  height: "10px",
                  borderRadius: "50%",
                  background: ACTION_COLORS[action] || "#94a3b8"
                }}
              />
              <span style={{ color: "#64748b" }}>
                {ACTION_LABELS[action] || action}: {count}
              </span>
            </div>
          ))}
        </div>
      </div>

      <p
        style={{
          marginTop: "16px",
          fontSize: "0.75rem",
          color: "#94a3b8",
          fontStyle: "italic"
        }}
      >
        {totalDrains} drain{totalDrains !== 1 ? "s" : ""} evaluated | Priority
        is a deterministic blend of flood risk, forecast, maintenance and vision
        signals
      </p>
    </div>
  );
}

export default AIDecisionPanel;