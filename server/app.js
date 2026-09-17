const express = require("express");
const cors = require("cors");

require("dotenv").config();

const app = express();

// CORS: restrict to FRONTEND_URL when configured, otherwise allow all (dev)
const frontendOrigins = (process.env.FRONTEND_URL || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(cors(frontendOrigins.length > 0 ? { origin: frontendOrigins } : {}));
app.use(express.json());

// --------------------------------------------------
// ROUTES
// --------------------------------------------------

app.use("/api/drains", require("./routes/drains"));
app.use("/api/alerts", require("./routes/alerts"));
app.use("/api/auth", require("./routes/auth"));
app.use("/api/sensors", require("./routes/sensors"));
app.use("/api/robots", require("./routes/robots"));
app.use("/api/predictions", require("./routes/predictions"));
app.use("/api/weather", require("./routes/weather"));
app.use("/api/analytics", require("./routes/analytics"));
app.use("/api/dashboard", require("./routes/dashboard"));
app.use("/api/missions", require("./routes/missions"));
app.use("/api/incidents", require("./routes/incidents"));
app.use("/api/fleet-optimization", require("./routes/fleetOptimization"));
app.use("/api/charging-stations", require("./routes/chargingStations"));
app.use("/api/settings", require("./routes/settings"));

app.get("/", (req, res) => {
  res.send("AI-DrainOS Server Running 🚧");
});

module.exports = app;
