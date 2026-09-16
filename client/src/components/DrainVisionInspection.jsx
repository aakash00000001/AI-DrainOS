import { useEffect, useRef, useState } from "react";
import axios from "axios";
import socket from "../services/socket";
import { API_URL } from "../services/api";

const LEVEL_COLORS = {
  LOW: "#16a34a",
  MODERATE: "#f59e0b",
  HIGH: "#ea580c",
  CRITICAL: "#dc2626"
};

function ScoreBar({ label, score }) {
  if (score === null || score === undefined) {
    return (
      <div style={{ fontSize: "13px", color: "#334155" }}>
        {label}: <span style={{ color: "#64748b" }}>n/a</span>
      </div>
    );
  }

  const color =
    LEVEL_COLORS[score >= 75 ? "CRITICAL" : score >= 50 ? "HIGH" : score >= 25 ? "MODERATE" : "LOW"] ||
    "#64748b";

  return (
    <div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px" }}>
      <span style={{ minWidth: "150px", color: "#334155" }}>{label}</span>
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

function DrainVisionInspection({ drains }) {
  const [selectedDrainId, setSelectedDrainId] = useState("");
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [result, setResult] = useState(null);
  const [history, setHistory] = useState([]);
  const [error, setError] = useState(null);

  const fileInputRef = useRef(null);
  const selectedRef = useRef("");

  const effectiveDrainId =
    selectedDrainId ||
    (drains && drains.length > 0 ? Number(drains[0].id) : "");

  useEffect(() => {
    selectedRef.current = effectiveDrainId;
  }, [effectiveDrainId]);

  const loadLatest = (drainId) => {
    axios
      .get(`${API_URL}/predictions/vision/${drainId}?history=6`)
      .then((response) => {
        setResult(response.data);
        setHistory(response.data.history || []);
      })
      .catch(() => {
        setResult(null);
        setHistory([]);
      });
  };

  useEffect(() => {
    if (effectiveDrainId) {
      loadLatest(effectiveDrainId);
    }
  }, [effectiveDrainId]);

  useEffect(() => {
    const onVisionInspectionUpdate = (payload) => {
      if (payload && Number(payload.drainId) === Number(selectedRef.current)) {
        loadLatest(Number(selectedRef.current));
      }
    };

    socket.on("visionInspectionUpdate", onVisionInspectionUpdate);

    return () => {
      socket.off("visionInspectionUpdate", onVisionInspectionUpdate);
    };
  }, []);

  const handleFileChange = (event) => {
    const selected = event.target.files && event.target.files[0];

    if (!selected) {
      return;
    }

    if (selected.size > 5 * 1024 * 1024) {
      setError("Image exceeds the 5 MB limit.");
      setFile(null);
      setPreview(null);
      return;
    }

    setError(null);
    setFile(selected);
    setPreview(URL.createObjectURL(selected));
  };

  const handleAnalyze = async () => {
    if (!effectiveDrainId) {
      setError("Select a drain first.");
      return;
    }

    if (!file) {
      setError("Choose a JPG, PNG or WEBP image to analyze.");
      return;
    }

    const form = new FormData();
    form.append("image", file);

    setAnalyzing(true);
    setError(null);

    try {
      const response = await axios.post(
        `${API_URL}/predictions/vision/${effectiveDrainId}`,
        form
      );

      setResult(response.data);
      loadLatest(effectiveDrainId);
    } catch (err) {
      setError(
        err.response && err.response.data && err.response.data.error
          ? err.response.data.error
          : "Vision inspection failed - check that the backend is running."
      );
    } finally {
      setAnalyzing(false);
    }
  };

  const levelColor = result
    ? LEVEL_COLORS[result.inspectionLevel] || "#64748b"
    : "#64748b";

  return (
    <div className="panel-card">
      <div className="card-header">
        <h2>👁️ Drain Vision Inspection</h2>
      </div>

      <div
        style={{
          display: "flex",
          gap: "14px",
          flexWrap: "wrap",
          alignItems: "flex-end"
        }}
      >
        <div style={{ minWidth: "220px" }}>
          <label style={{ fontSize: "13px", color: "#334155" }}>Drain</label>
          <select
            value={effectiveDrainId}
            onChange={(e) => setSelectedDrainId(e.target.value)}
            style={{
              width: "100%",
              padding: "8px 10px",
              borderRadius: "8px",
              border: "1px solid #cbd5e1"
            }}
          >
            {drains.map((drain) => (
              <option key={drain.id} value={drain.id}>
                {drain.location || `Drain ${drain.id}`} ({drain.zone_name || "zone"})
              </option>
            ))}
          </select>
        </div>

        <div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp"
            style={{ display: "none" }}
            onChange={handleFileChange}
          />
          <button
            type="button"
            className="btn"
            onClick={() => fileInputRef.current && fileInputRef.current.click()}
          >
            {file ? `📷 ${file.name}` : "📷 Choose image (max 5 MB)"}
          </button>
        </div>

        <button
          type="button"
          className="btn"
          style={{
            background: analyzing ? "#94a3b8" : "#0369a1",
            borderColor: analyzing ? "#94a3b8" : "#0369a1",
            color: "#ffffff"
          }}
          onClick={handleAnalyze}
          disabled={analyzing}
        >
          {analyzing ? "Analyzing..." : "🔍 Analyze"}
        </button>
      </div>

      {preview && (
        <div style={{ marginTop: "12px" }}>
          <img
            src={preview}
            alt="Drain preview"
            style={{ maxWidth: "260px", maxHeight: "180px", borderRadius: "10px", border: "1px solid #e2e8f0" }}
          />
        </div>
      )}

      {error && (
        <p style={{ color: "#b91c1c", fontSize: "13px", marginTop: "10px" }}>
          ⚠️ {error}
        </p>
      )}

      {result && result.status === "INSUFFICIENT_IMAGE_QUALITY" && (
        <div style={{ marginTop: "14px", padding: "12px 16px", background: "#fef3c7", borderRadius: "10px", border: "1px solid #fde68a" }}>
          <b>Image could not be reliably analyzed.</b>
          <p style={{ margin: "6px 0 0", fontSize: "13px" }}>{result.reason}</p>
          {result.limitations && result.limitations.length > 0 && (
            <p style={{ margin: "8px 0 0", fontSize: "12px", color: "#64748b" }}>
              {result.limitations[0]}
            </p>
          )}
        </div>
      )}

      {result && result.status === "READY" && (
        <div style={{ marginTop: "14px" }}>
          <div
            style={{
              display: "flex",
              gap: "24px",
              flexWrap: "wrap",
              alignItems: "center"
            }}
          >
            <div
              style={{
                display: "inline-block",
                padding: "6px 18px",
                borderRadius: "50px",
                fontSize: "16px",
                fontWeight: "bold",
                color: "#ffffff",
                background: levelColor
              }}
            >
              {result.inspectionLevel}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "6px", minWidth: "260px" }}>
              <ScoreBar label="Visual risk score" score={result.visualRiskScore} />
              <ScoreBar label="Possible blockage score" score={result.possibleBlockageScore} />
            </div>
          </div>

          <p style={{ margin: "12px 0 0", fontSize: "14px", color: "#0f172a" }}>
            💡 <b>{result.recommendation}</b>
          </p>

          {result.robotInspectionRecommended && (
            <p style={{ margin: "6px 0 0", fontSize: "13px", color: "#b45309" }}>
              🤖 Robot inspection/cleaning recommended (dispatch is manual - the mission engine stays the authority).
            </p>
          )}

          {result.findings && result.findings.length > 0 && (
            <div style={{ marginTop: "10px" }}>
              <b style={{ fontSize: "13px" }}>Findings</b>
              <ul style={{ margin: "6px 0 0", paddingLeft: "20px", fontSize: "13px", color: "#334155" }}>
                {result.findings.map((finding, index) => (
                  <li key={index}>
                    {finding.type.replace(/_/g, " ")} (
                    <b>{finding.severity}</b>): {finding.description}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {result.imageQuality && result.imageQuality.dimensions && (
            <p style={{ margin: "8px 0 0", fontSize: "12px", color: "#64748b" }}>
              Image {result.imageQuality.dimensions.width}×{result.imageQuality.dimensions.height}
              {result.analyzedAt ? ` · analyzed ${new Date(result.analyzedAt).toLocaleString()}` : ""}
            </p>
          )}

          {result.limitations && result.limitations.length > 0 && (
            <p style={{ margin: "10px 0 0", fontSize: "12px", color: "#64748b" }}>
              ⚠️ {result.limitations[0]}
            </p>
          )}
        </div>
      )}

      <hr />

      <h3>Recent inspections</h3>

      {history.length === 0 ? (
        <p className="empty-state">
          No vision inspections yet for this drain - upload a drain image above to run one.
        </p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
          <thead>
            <tr style={{ textAlign: "left", color: "#475569" }}>
              <th style={{ padding: "6px 8px" }}>Time</th>
              <th style={{ padding: "6px 8px" }}>Level</th>
              <th style={{ padding: "6px 8px" }}>Visual</th>
              <th style={{ padding: "6px 8px" }}>Blockage</th>
              <th style={{ padding: "6px 8px" }}>Recommendation</th>
            </tr>
          </thead>
          <tbody>
            {history.map((entry) => {
              const color = LEVEL_COLORS[entry.inspectionLevel] || "#64748b";
              return (
                <tr key={entry.id} style={{ borderTop: "1px solid #e2e8f0" }}>
                  <td style={{ padding: "6px 8px", color: "#64748b" }}>
                    {new Date(entry.analyzedAt).toLocaleString()}
                  </td>
                  <td style={{ padding: "6px 8px" }}>
                    <span
                      style={{
                        display: "inline-block",
                        padding: "2px 10px",
                        borderRadius: "50px",
                        fontSize: "12px",
                        fontWeight: "bold",
                        color: "#ffffff",
                        background: color
                      }}
                    >
                      {entry.inspectionLevel}
                    </span>
                  </td>
                  <td style={{ padding: "6px 8px" }}>{entry.visualRiskScore}/100</td>
                  <td style={{ padding: "6px 8px" }}>{entry.possibleBlockageScore}/100</td>
                  <td style={{ padding: "6px 8px" }}>{entry.recommendation}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default DrainVisionInspection;