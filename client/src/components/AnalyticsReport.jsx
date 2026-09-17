import { useEffect, useState } from "react";
import axios from "axios";
import { API_URL } from "../services/api";

import {
  FaWater,
  FaRobot,
  FaExclamationTriangle,
  FaChartLine,
  FaListOl
} from "react-icons/fa";

import {
  Bar,
  Doughnut
} from "react-chartjs-2";

import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  ArcElement,
  Tooltip,
  Legend
} from "chart.js";

ChartJS.register(
  CategoryScale,
  LinearScale,
  BarElement,
  ArcElement,
  Tooltip,
  Legend
);

function AnalyticsReport() {

  const [analytics, setAnalytics] = useState(null);
  const [error, setError] = useState(false);
  const [decisions, setDecisions] = useState(null);

  const loadAnalytics = async () => {

    try {

      const response = await axios.get(
        `${API_URL}/analytics`
      );

      setAnalytics(response.data);
      setError(false);

    }

    catch(err){

      console.log(err);
      setError(true);

    }

  };

  const loadDecisions = async () => {

    try {

      const response = await axios.get(
        `${API_URL}/analytics/decisions`
      );

      setDecisions(response.data);

    }

    catch(err){

      console.log(err);

    }

  };

  useEffect(() => {

    loadAnalytics();
    loadDecisions();

    const interval = setInterval(() => {
      loadAnalytics();
      loadDecisions();
    }, 5000);

    return ()=>clearInterval(interval);

  },[]);

  if(!analytics){

    return(

      <div className="analytics-card">

        {error ? "Analytics unavailable - check that the backend is running." : "Loading Analytics..."}

      </div>

    );

  }

  const barData={

    labels:[
      "Cleanings",
      "Blockages",
      "Robots",
      "Predictions"
    ],

    datasets:[

      {

        label:"AI DrainOS",

        data:[

          analytics.total_cleanings,

          analytics.blockages_detected,

          analytics.robot_operations,

          analytics.flood_predictions

        ]

      }

    ]

  };

  const doughnutData={

    labels:[

      "Robot Operations",

      "Critical Alerts",

      "Flood Predictions"

    ],

    datasets:[

      {

        data:[

          analytics.robot_operations,

          analytics.blockages_detected,

          analytics.flood_predictions

        ]

      }

    ]

  };

  return(

<div className="analytics-card">

<div className="card-header">

<h2>

<FaChartLine/>

{" "}AI Analytics Dashboard

</h2>

</div>

<div className="analytics-grid">

<div className="analytics-item">

<FaWater className="analytics-icon"/>

<h3>{analytics.total_cleanings}</h3>

<p>Total Cleanings</p>

</div>

<div className="analytics-item">

<FaExclamationTriangle className="analytics-icon"/>

<h3>{analytics.blockages_detected}</h3>

<p>Critical Alerts</p>

</div>

<div className="analytics-item">

<FaRobot className="analytics-icon"/>

<h3>{analytics.robot_operations}</h3>

<p>Robot Operations</p>

</div>

<div className="analytics-item">

<FaChartLine className="analytics-icon"/>

<h3>{analytics.flood_predictions}</h3>

<p>Predictions</p>

</div>

</div>

{analytics.risk_average_score !== undefined && (
  <>
    <h3>🌊 Flood Risk Summary</h3>

    <div className="analytics-grid">

      <div className="analytics-item">
        <FaChartLine className="analytics-icon"/>
        <h3>{analytics.risk_average_score}</h3>
        <p>Average Risk</p>
      </div>

      <div className="analytics-item">
        <h3>{analytics.risk_low}</h3>
        <p>LOW Drains</p>
      </div>

      <div className="analytics-item">
        <h3>{analytics.risk_moderate}</h3>
        <p>MODERATE Drains</p>
      </div>

      <div className="analytics-item">
        <h3>{analytics.risk_high}</h3>
        <p>HIGH Drains</p>
      </div>

      <div className="analytics-item">
        <h3>{analytics.risk_critical}</h3>
        <p>CRITICAL Drains</p>
      </div>

    </div>

    <br/>
  </>
)}

{analytics.forecast_average_risk !== undefined && (
  <>
    <h3>🔮 Flood Forecast Summary (60 min)</h3>

    <div className="analytics-grid">

      <div className="analytics-item">
        <FaChartLine className="analytics-icon"/>
        <h3>{analytics.forecast_average_risk}</h3>
        <p>Avg Predicted Risk</p>
      </div>

      <div className="analytics-item">
        <h3>{analytics.forecast_low}</h3>
        <p>Predicted LOW</p>
      </div>

      <div className="analytics-item">
        <h3>{analytics.forecast_moderate}</h3>
        <p>Predicted MODERATE</p>
      </div>

      <div className="analytics-item">
        <h3>{analytics.forecast_high}</h3>
        <p>Predicted HIGH</p>
      </div>

      <div className="analytics-item">
        <h3>{analytics.forecast_critical}</h3>
        <p>Predicted CRITICAL</p>
      </div>

    </div>

    <br/>
  </>
)}

{analytics.maintenance_average_score !== undefined && (
  <>
    <h3>🛠️ Maintenance Prediction Summary</h3>

    <div className="analytics-grid">

      <div className="analytics-item">
        <FaChartLine className="analytics-icon"/>
        <h3>{analytics.maintenance_average_score}</h3>
        <p>Avg Maintenance Score</p>
      </div>

      <div className="analytics-item">
        <h3>{analytics.maintenance_average_blockage_risk}</h3>
        <p>Avg Blockage Risk</p>
      </div>

      <div className="analytics-item">
        <h3>{analytics.maintenance_low}</h3>
        <p>Maintenance LOW</p>
      </div>

      <div className="analytics-item">
        <h3>{analytics.maintenance_moderate}</h3>
        <p>Maintenance MODERATE</p>
      </div>

      <div className="analytics-item">
        <h3>{analytics.maintenance_high}</h3>
        <p>Maintenance HIGH</p>
      </div>

      <div className="analytics-item">
        <h3>{analytics.maintenance_critical}</h3>
        <p>Maintenance CRITICAL</p>
      </div>

      <div className="analytics-item">
        <h3>{analytics.maintenance_drains_inspection}</h3>
        <p>Need Inspection</p>
      </div>

    </div>

    <br/>
  </>
)}

{analytics.vision_average_visual_risk !== undefined && (
  <>
    <h3>👁️ Vision Inspection Summary</h3>

    <div className="analytics-grid">

      <div className="analytics-item">
        <FaChartLine className="analytics-icon"/>
        <h3>{analytics.vision_total_inspections}</h3>
        <p>Total Inspections</p>
      </div>

      <div className="analytics-item">
        <h3>{analytics.vision_average_visual_risk}</h3>
        <p>Avg Visual Risk</p>
      </div>

      <div className="analytics-item">
        <h3>{analytics.vision_average_blockage_risk}</h3>
        <p>Avg Blockage Risk</p>
      </div>

      <div className="analytics-item">
        <h3>{analytics.vision_low}</h3>
        <p>Visual LOW</p>
      </div>

      <div className="analytics-item">
        <h3>{analytics.vision_moderate}</h3>
        <p>Visual MODERATE</p>
      </div>

      <div className="analytics-item">
        <h3>{analytics.vision_high}</h3>
        <p>Visual HIGH</p>
      </div>

      <div className="analytics-item">
        <h3>{analytics.vision_critical}</h3>
        <p>Visual CRITICAL</p>
      </div>

      <div className="analytics-item">
        <h3>{analytics.vision_drains_with_issues}</h3>
        <p>Drains w/ Issues</p>
      </div>

    </div>

    <br/>
  </>
)}

{decisions && decisions.total_drains !== undefined && (
  <>
    <h3><FaListOl /> AI Decision & Priority Summary</h3>

    <div className="analytics-grid">

      <div className="analytics-item">
        <FaChartLine className="analytics-icon"/>
        <h3>{decisions.total_drains}</h3>
        <p>Drains Evaluated</p>
      </div>

      <div className="analytics-item">
        <FaChartLine className="analytics-icon"/>
        <h3>{decisions.average_priority_score !== null ? decisions.average_priority_score : "n/a"}</h3>
        <p>Avg Priority Score</p>
      </div>

      <div className="analytics-item">
        <h3>{decisions.decision_low}</h3>
        <p>Decision LOW</p>
      </div>

      <div className="analytics-item">
        <h3>{decisions.decision_moderate}</h3>
        <p>Decision MODERATE</p>
      </div>

      <div className="analytics-item">
        <h3>{decisions.decision_high}</h3>
        <p>Decision HIGH</p>
      </div>

      <div className="analytics-item">
        <h3>{decisions.decision_critical}</h3>
        <p>Decision CRITICAL</p>
      </div>

      <div className="analytics-item">
        <h3>{decisions.insufficient_data}</h3>
        <p>Insufficient Data</p>
      </div>

    </div>

    {decisions.top_priority_drains && decisions.top_priority_drains.length > 0 && (
      <div style={{ marginTop: "12px" }}>
        <p style={{ fontSize: "0.85rem", color: "#64748b", marginBottom: "4px" }}>Top Priority Drains:</p>
        {decisions.top_priority_drains.map((drain) => (
          <span
            key={drain.drainId}
            style={{
              display: "inline-block",
              padding: "4px 10px",
              borderRadius: "12px",
              fontSize: "0.8rem",
              fontWeight: "600",
              color: "#fff",
              marginRight: "8px",
              marginBottom: "4px",
              background:
                drain.priorityLevel === "CRITICAL" ? "#dc2626" :
                drain.priorityLevel === "HIGH" ? "#ea580c" :
                drain.priorityLevel === "MODERATE" ? "#f59e0b" : "#16a34a"
            }}
          >
            {drain.location} ({drain.priorityScore}/100 {drain.priorityLevel})
          </span>
        ))}
      </div>
    )}

    <br/>
  </>
)}

<br/>

<h3>📊 System Analytics</h3>

<Bar data={barData}/>

<br/>

<h3>🥧 System Distribution</h3>

<Doughnut data={doughnutData}/>

<br/>

<div className="analytics-summary">

<h3>AI Summary</h3>

<p>

The AI continuously monitors sensors,

weather,

robots,

and alerts

to detect possible flood risks

in real time.

</p>

</div>

</div>

  );

}

export default AnalyticsReport;