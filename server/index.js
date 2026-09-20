const http = require("http");
const { Server } = require("socket.io");

const app = require("./app");
const config = require("./config/env");
const logger = require("./config/logger");
const socketHub = require("./services/socketHub");
const { startMqttService } = require("./services/mqttService");
const { createLiveLoop } = require("./services/liveLoop");
const { installShutdown } = require("./services/gracefulShutdown");

const pool = require("./config/db");

// Mutable holder so the shutdown helper can reach the MQTT client
// created inside the listen() callback.
let mqttClient = null;

// --------------------------------------------------
// PROCESS-LEVEL GUARDS (crash resilience)
// --------------------------------------------------

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled promise rejection", { reason: reason && reason.message });
});

process.on("uncaughtException", (err) => {
  logger.error("Uncaught exception", { message: err.message, stack: err.stack });
  const shutdown = installShutdown({ timeoutMs: 5000 });
  shutdown("uncaughtException").catch(() => process.exit(1));
});

// --------------------------------------------------
// HTTP + SOCKET.IO SERVER
// --------------------------------------------------

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin:
      config.frontendOrigins.length > 0 ? config.frontendOrigins : "http://localhost:5173",
    methods: ["GET", "POST"],
  },
});

// Share the single Socket.IO instance with services that emit live
// events. The MQTT service keeps receiving `io` directly.
socketHub.init(io);

io.on("connection", (socket) => {
  try {
    logger.info("Client connected", { socketId: socket.id });

    socket.on("disconnect", () => {
      logger.info("Client disconnected", { socketId: socket.id });
    });

    socket.on("error", (err) => {
      logger.error("Socket error", { socketId: socket.id, message: err.message });
    });
  } catch (err) {
    logger.error("Socket connection handler failed", { message: err.message });
  }
});

io.engine.on("connection_error", (err) => {
  logger.warn("Socket connection error", { message: err.message, code: err.code });
});

// --------------------------------------------------
// LIVE SYSTEM LOOP (5 s tick, overlap-guarded)
// --------------------------------------------------

const liveLoop = createLiveLoop({ io, pool, tickIntervalMs: 5000 });
liveLoop.start();

// --------------------------------------------------
// GRACEFUL SHUTDOWN
// --------------------------------------------------

const shutdown = installShutdown({
  server,
  io,
  pool,
  liveLoop,
  getMqttClient: () => mqttClient,
  timeoutMs: 10000
});

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// --------------------------------------------------
// START
// --------------------------------------------------

server.listen(config.port, () => {
  logger.info(`Server running on port ${config.port}`);

  mqttClient = startMqttService({ io });
});