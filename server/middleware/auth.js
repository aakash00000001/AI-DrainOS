const jwt = require("jsonwebtoken");
const config = require("../config/env");

// --------------------------------------------------
// AUTH MIDDLEWARE - verifies Bearer access token
// --------------------------------------------------

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || "";

  if (!header.startsWith("Bearer ")) {
    return res.status(401).json({
      message: "No token provided"
    });
  }

  const token = header.slice(7);

  try {
    const payload = jwt.verify(token, config.jwtSecret);

    req.user = {
      id: payload.id,
      email: payload.email,
      role: payload.role
    };

    next();

  } catch (err) {
    return res.status(401).json({
      message: "Invalid or expired token"
    });
  }
}

// --------------------------------------------------
// ADMIN ONLY - must be used after authMiddleware
// --------------------------------------------------

function adminOnly(req, res, next) {
  if (req.user?.role !== "Admin") {
    return res.status(403).json({
      message: "Admin access required"
    });
  }

  next();
}

module.exports = {
  authMiddleware,
  adminOnly
};
