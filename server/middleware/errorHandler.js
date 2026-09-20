const logger = require("../config/logger");

const PG_ERROR_CODE = /^[0-9A-Z]{5}$/;

function isPgError(err) {
  return err && typeof err.code === "string" && PG_ERROR_CODE.test(err.code);
}

function statusFor(err) {
  if (err.status && Number.isInteger(err.status) && err.status >= 400) return err.status;
  if (err.statusCode && Number.isInteger(err.statusCode) && err.statusCode >= 400) return err.statusCode;
  if (err.type === "entity.parse.failed") return 400;
  if (err.type === "entity.too.large") return 413;
  if (err.type === "entity.verify.failed") return 400;
  if (typeof err.code === "string" && err.code.startsWith("LIMIT_")) return 400;
  if (isPgError(err)) return 500;
  return 500;
}

function codeFor(err, status) {
  if (status === 404) return "NOT_FOUND";
  if (status === 413) return "PAYLOAD_TOO_LARGE";
  if (status === 429) return "RATE_LIMITED";
  if (status === 400) return "BAD_REQUEST";
  if (isPgError(err)) return "DATABASE_ERROR";
  return "INTERNAL_ERROR";
}

function notFoundHandler(req, res) {
  res.status(404).json({
    error: {
      code: "NOT_FOUND",
      message: `Route not found: ${req.method} ${req.originalUrl}`
    }
  });
}

function errorHandler(err, req, res, next) {
  if (res.headersSent) {
    return next(err);
  }

  const status = statusFor(err);
  const code = codeFor(err, status);

  if (status >= 500) {
    logger.error("Request error", {
      method: req.method,
      url: req.originalUrl,
      requestId: req.id,
      status,
      code,
      message: isPgError(err) ? err.message : undefined
    });
  }

  // Only expose a message for client errors or deliberately exposed errors.
  let message;
  if (status >= 500) {
    message = "Internal server error";
  } else if (err.expose) {
    message = err.message;
  } else if (status === 413) {
    message = "Request body too large";
  } else if (status === 400 && typeof err.message === "string") {
    message = err.message;
  } else {
    message = "Bad request";
  }

  res.status(status).json({
    error: {
      code,
      message,
      requestId: req.id
    }
  });
}

module.exports = { notFoundHandler, errorHandler };