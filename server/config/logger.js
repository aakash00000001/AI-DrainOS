const config = require("./env");

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const configuredLevel = LEVELS[config.logLevel] ?? LEVELS.info;

const SECRET_KEYS = new Set([
  "password",
  "passwd",
  "secret",
  "token",
  "accessToken",
  "refreshToken",
  "apiKey",
  "api_key",
  "appid",
  "authorization"
]);

function redact(value, depth) {
  if (value == null) return value;
  if (Buffer.isBuffer(value)) return "[Buffer]";
  if (typeof value === "function") return "[Function]";
  if (typeof value === "object") {
    if (depth > 4) return "[Object]";
    if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEYS.has(k.toLowerCase()) ? "[REDACTED]" : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

function safeContext(context) {
  if (!context || typeof context !== "object") return undefined;
  return redact(context, 0);
}

function write(level, message, context) {
  if (LEVELS[level] < configuredLevel) return;
  const entry = {
    time: new Date().toISOString(),
    level,
    msg: message,
    ...safeContext(context)
  };
  const line = JSON.stringify(entry);
  if (level === "error" || level === "warn") {
    process.stderr.write(line + "\n");
  } else {
    process.stdout.write(line + "\n");
  }
}

const logger = {
  debug: (message, ctx) => write("debug", message, ctx),
  info: (message, ctx) => write("info", message, ctx),
  warn: (message, ctx) => write("warn", message, ctx),
  error: (message, ctx) => write("error", message, ctx)
};

module.exports = logger;