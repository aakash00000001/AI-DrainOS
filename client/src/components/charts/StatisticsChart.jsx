import { useEffect, useState } from "react";
import axios from "axios";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid
} from "recharts";
import { API_URL } from "../../services/api";

function StatisticsChart() {
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;

    const load = async () => {
      try {
        const res = await axios.get(`${API_URL}/analytics/monthly`);
        if (active) {
          setData(res.data.map((row) => ({
            month: row.month,
            risk: Number(row.avg_water)
          })));
        }
      } catch (err) {
        console.log(err);
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    };

    load();

    const interval = setInterval(load, 60000);

    return () => {
      active = false;
      clearInterval(interval);
    };
  }, []);

  return (

    <div className="chart-card">

      <h2>📊 Monthly Flood Risk</h2>

      {loading ? (
        <p style={{ color: "#64748b", padding: "20px 0" }}>
          Loading chart...
        </p>
      ) : data.length === 0 ? (
        <p style={{ color: "#64748b", padding: "20px 0" }}>
          No sensor history yet - run the sensor simulator
        </p>
      ) : (
        <ResponsiveContainer width="100%" height={300}>

          <BarChart data={data}>

            <CartesianGrid strokeDasharray="3 3" />

            <XAxis dataKey="month" />

            <YAxis domain={[0, 100]} />

            <Tooltip />

            <Bar
              dataKey="risk"
              name="Water Level"
              radius={[8, 8, 0, 0]}
              fill="#2563eb"
            />

          </BarChart>

        </ResponsiveContainer>
      )}

    </div>

  );

}

export default StatisticsChart;