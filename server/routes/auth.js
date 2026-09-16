const express = require("express");

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

// Public
router.post("/login", login);
router.post("/refresh", refresh);
router.post("/logout", logout);

// Authenticated
router.get("/me", authMiddleware, getMe);
router.put("/me/password", authMiddleware, changePassword);

// Admin only
router.post("/register", authMiddleware, adminOnly, register);
router.get("/users", authMiddleware, adminOnly, getUsers);
router.put("/users/:id", authMiddleware, adminOnly, updateUser);
router.put("/users/:id/role", authMiddleware, adminOnly, updateUserRole);
router.patch("/users/:id/status", authMiddleware, adminOnly, toggleUserStatus);
router.delete("/users/:id", authMiddleware, adminOnly, deleteUser);

module.exports = router;
