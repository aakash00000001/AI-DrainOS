import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import axios from "axios";
import { API_URL } from "../services/api";

function PDFReport() {

  const downloadReport = async () => {

    try {

      const dashboard = await axios.get(`${API_URL}/dashboard`);
      const analytics = await axios.get(`${API_URL}/analytics`);
      const prediction = await axios.get(`${API_URL}/predictions`);
      const weather = await axios.get(`${API_URL}/weather`);

      const doc = new jsPDF();

      doc.setFontSize(20);
      doc.text("AI-DrainOS Report", 14, 20);

      doc.setFontSize(11);
      doc.text(
        `Generated: ${new Date().toLocaleString()}`,
        14,
        30
      );

      autoTable(doc, {
        startY: 40,
        head: [["Dashboard", "Value"]],
        body: [
          ["Total Drains", dashboard.data.totalDrains],
          ["Active Robots", dashboard.data.activeRobots],
          ["Critical Alerts", dashboard.data.criticalAlerts],
          ["AI Prediction", prediction.data.prediction],
          ["Temperature", weather.data.main.temp + " °C"],
          ["Weather", weather.data.weather[0].description]
        ]
      });

      autoTable(doc, {
        startY: doc.lastAutoTable.finalY + 10,
        head: [["Analytics", "Value"]],
        body: [
          ["Total Cleanings", analytics.data.total_cleanings],
          ["Blockages", analytics.data.blockages_detected],
          ["Robot Operations", analytics.data.robot_operations],
          ["Flood Predictions", analytics.data.flood_predictions]
        ]
      });

      doc.save("AI-DrainOS-Report.pdf");

    } catch (err) {

      console.log(err);

      alert("Failed to generate report");

    }

  };

  return (

    <div style={{ marginTop: "20px" }}>

      <button
        onClick={downloadReport}
        style={{
          padding: "12px 20px",
          background: "#2563eb",
          color: "#fff",
          border: "none",
          borderRadius: "8px",
          cursor: "pointer",
          fontWeight: "bold"
        }}
      >
        📄 Download AI Report
      </button>

    </div>

  );

}

export default PDFReport;