const express = require("express");
const config = require("../config/env");
const pool = require("../config/db");
const { createRateLimiter } = require("../middleware/rateLimiter");
const { positiveIntParam } = require("../middleware/validate");
const { auditMutation } = require("../middleware/auditMutation");

const router = express.Router();

const {
  register,
  login,
  refresh,
  logout,
  getMe,
  getUsers,
  updateUser,
  updateUserRole,
  toggleUserStatus,
  deleteUser,
  changePassword
} = require("../controllers/authController");

const {
  authMiddleware,
  adminOnly
} = require("../middleware/auth");

const authLimiter = createRateLimiter({
  name: "authLimiter",
  windowMs: config.rateLimits.auth.windowMs,
  max: config.rateLimits.auth.max
});

const validateUserId = positiveIntParam("id");

async function loadUserForAudit(req) {
  const result = await pool.query(
    "SELECT id, full_name, email, role, status FROM users WHERE id = $1",
    [req.params.id]
  );
  return result.rows[0] || null;
}

// Public (rate-limited)
router.post("/login", authLimiter, login);
router.post("/refresh", authLimiter, refresh);
router.post("/logout", authLimiter, logout);

// Authenticated
router.get("/me", authMiddleware, getMe);
router.put("/me/password", authMiddleware, changePassword);

// Admin only
router.post("/register", authMiddleware, adminOnly, authLimiter, auditMutation({
  action: "USER_CREATE",
  entityType: "USER",
  entityId: (req, body) => (body && body.id !== undefined ? body.id : null)
}), register);
router.get("/users", authMiddleware, adminOnly, getUsers);
router.put("/users/:id", authMiddleware, adminOnly, validateUserId, auditMutation({
  action: "USER_UPDATE",
  entityType: "USER",
  entityId: (req) => req.params.id,
  before: loadUserForAudit
}), updateUser);
router.put("/users/:id/role", authMiddleware, adminOnly, validateUserId, auditMutation({
  action: "USER_UPDATE_ROLE",
  entityType: "USER",
  entityId: (req) => req.params.id,
  before: loadUserForAudit
}), updateUserRole);
router.patch("/users/:id/status", authMiddleware, adminOnly, validateUserId, auditMutation({
  action: "USER_UPDATE_STATUS",
  entityType: "USER",
  entityId: (req) => req.params.id,
  before: loadUserForAudit
}), toggleUserStatus);
router.delete("/users/:id", authMiddleware, adminOnly, validateUserId, auditMutation({
  action: "USER_DELETE",
  entityType: "USER",
  entityId: (req) => req.params.id,
  before: loadUserForAudit
}), deleteUser);
router.put("/me/password", authMiddleware, auditMutation({
  action: "PASSWORD_CHANGE",
  entityType: "USER",
  entityId: (req) => req.user.id
}), changePassword);

module.exports = router;