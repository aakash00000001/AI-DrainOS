require("dotenv").config();

const crypto = require("crypto");

const NODE_ENV = process.env.NODE_ENV || "development";
const isProduction = NODE_ENV === "production";
const isTest = NODE_ENV === "test";
const isDevelopment = NODE_ENV === "development";

const REQUIRED_IN_PRODUCTION = [
  ["JWT_SECRET", "JWT signing secret"],
  ["POSTGRES_HOST", "PostgreSQL host"],
  ["POSTGRES_DB", "PostgreSQL database name"],
  ["POSTGRES_USER", "PostgreSQL user"],
  ["POSTGRES_PASSWORD", "PostgreSQL password"],
  ["FRONTEND_URL", "allowed frontend origin (CORS)"]
];

function validateRequiredEnv() {
  if (!isProduction) return;
  const missing = REQUIRED_IN_PRODUCTION.filter(
    ([name]) => !process.env[name] || /^\s*$/.test(process.env[name])
  ).map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(
      `[config] Missing required environment variables in production: ${missing.join(", ")}. ` +
        "Set them before starting the server (see .env.example)."
    );
  }
}

validateRequiredEnv();

function intFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || /^\s*$/.test(raw)) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function listFromEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const jwtSecret = (() => {
  if (process.env.JWT_SECRET && /\S/.test(process.env.JWT_SECRET)) {
    return process.env.JWT_SECRET;
  }
  // Development/test convenience: an ephemeral secret so the stack still
  // works out of the box. Logged as a warning; restarts invalidate tokens.
  const ephemeral = crypto.randomBytes(32).toString("hex");
  if (!isTest) {
    // eslint-disable-next-line no-console
    console.warn(
      "[config] JWT_SECRET not set; using an ephemeral secret. " +
        "Set JWT_SECRET to keep sessions valid across restarts and across processes."
    );
  }
  return ephemeral;
})();

// Mirror the resolved secret back into process.env so any code that reads the
// environment directly (npm packages, legacy call sites) stays consistent.
process.env.JWT_SECRET = jwtSecret;

const config = {
  env: NODE_ENV,
  isProduction,
  isTest,
  isDevelopment,

  port: intFromEnv("PORT", 5000),
  jwtSecret,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || "1h",
  jwtRefreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || "7d",

  aiServiceUrl: (process.env.AI_SERVICE_URL || "http://127.0.0.1:5001").replace(/\/+$/, ""),
  aiRequestTimeoutMs: intFromEnv("AI_REQUEST_TIMEOUT_MS", 30000),

  openWeatherApiKey: process.env.OPENWEATHER_API_KEY || null,
  weatherCity: process.env.WEATHER_CITY || "Madurai",
  weatherFetchDisabled: process.env.WEATHER_FETCH_DISABLED === "true",

  frontendOrigins: listFromEnv("FRONTEND_URL", isTest ? ["http://localhost:5173"] : []),

  db: {
    user: process.env.POSTGRES_USER || process.env.PGUSER || (isProduction ? undefined : "postgres"),
    host: process.env.POSTGRES_HOST || process.env.PGHOST || (isProduction ? undefined : "localhost"),
    database: process.env.POSTGRES_DB || process.env.PGDATABASE || (isProduction ? undefined : "ai_drainos"),
    password: process.env.POSTGRES_PASSWORD || process.env.PGPASSWORD || (isProduction ? undefined : "admin123"),
    port: intFromEnv("POSTGRES_PORT", 5432),
    connectionTimeoutMillis: intFromEnv("DB_CONNECTION_TIMEOUT_MS", 5000),
    idleTimeoutMillis: intFromEnv("DB_IDLE_TIMEOUT_MS", 30000),
    max: intFromEnv("DB_POOL_MAX", 10)
  },

  mqtt: {
    enabled: process.env.MQTT_ENABLED !== "false",
    brokerUrl: process.env.MQTT_BROKER_URL || "mqtt://localhost:1883",
    username: process.env.MQTT_USERNAME || undefined,
    password: process.env.MQTT_PASSWORD || undefined,
    clientId: process.env.MQTT_CLIENT_ID || "ai-drainos-server",
    topicPrefix: process.env.MQTT_TOPIC_PREFIX || "ai_drainos"
  },

  rateLimits: {
    enabled: process.env.RATE_LIMIT_ENABLED !== "false",
    auth: {
      windowMs: intFromEnv("RATE_LIMIT_AUTH_WINDOW_MS", 60 * 1000),
      max: intFromEnv("RATE_LIMIT_AUTH_MAX", 30)
    },
    mutation: {
      windowMs: intFromEnv("RATE_LIMIT_MUTATION_WINDOW_MS", 60 * 1000),
      max: intFromEnv("RATE_LIMIT_MUTATION_MAX", 60)
    },
    vision: {
      windowMs: intFromEnv("RATE_LIMIT_VISION_WINDOW_MS", 60 * 1000),
      max: intFromEnv("RATE_LIMIT_VISION_MAX", 10)
    },
    analytics: {
      windowMs: intFromEnv("RATE_LIMIT_ANALYTICS_WINDOW_MS", 60 * 1000),
      max: intFromEnv("RATE_LIMIT_ANALYTICS_MAX", 300)
    }
  },

  jsonBodyLimit: process.env.JSON_BODY_LIMIT || "1mb",
  logLevel: process.env.LOG_LEVEL || "info"
};

module.exports = config;