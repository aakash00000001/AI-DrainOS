const express = require("express");
const config = require("../config/env");
const { createRateLimiter } = require("../middleware/rateLimiter");
const { positiveIntParam } = require("../middleware/validate");

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

// Public (rate-limited)
router.post("/login", authLimiter, login);
router.post("/refresh", authLimiter, refresh);
router.post("/logout", authLimiter, logout);

// Authenticated
router.get("/me", authMiddleware, getMe);
router.put("/me/password", authMiddleware, changePassword);

// Admin only
router.post("/register", authMiddleware, adminOnly, authLimiter, register);
router.get("/users", authMiddleware, adminOnly, getUsers);
router.put("/users/:id", authMiddleware, adminOnly, validateUserId, updateUser);
router.put("/users/:id/role", authMiddleware, adminOnly, validateUserId, updateUserRole);
router.patch("/users/:id/status", authMiddleware, adminOnly, validateUserId, toggleUserStatus);
router.delete("/users/:id", authMiddleware, adminOnly, validateUserId, deleteUser);

module.exports = router;