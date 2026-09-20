const crypto = require("crypto");
const pool = require("../config/db");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const config = require("../config/env");
const logger = require("../config/logger");

const ACCESS_TOKEN_EXPIRY = config.jwtExpiresIn;
const REFRESH_TOKEN_EXPIRY_DAYS = 7;

const handleError = (res, err) => {
  logger.error("Auth failure", { message: err.message });
  res.status(500).json({ message: "Internal server error" });
};

// --------------------------------------------------
// Helpers
// --------------------------------------------------

function signAccessToken(user) {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      role: user.role
    },
    config.jwtSecret,
    { expiresIn: ACCESS_TOKEN_EXPIRY }
  );
}

async function signRefreshToken(user) {
  const token = jwt.sign(
    {
      id: user.id,
      type: "refresh",
      jti: crypto.randomUUID()
    },
    config.jwtSecret,
    { expiresIn: `${REFRESH_TOKEN_EXPIRY_DAYS}d` }
  );

  const expiresAt = new Date(
    Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000
  );

  await pool.query(
    `
    INSERT INTO refresh_tokens (user_id, token, expires_at)
    VALUES ($1, $2, $3)
    `,
    [user.id, token, expiresAt]
  );

  return token;
}

function publicUser(user) {
  return {
    id: user.id,
    full_name: user.full_name,
    email: user.email,
    role: user.role,
    status: user.status || "Active"
  };
}

// --------------------------------------------------
// Register - ADMIN ONLY
// --------------------------------------------------

const register = async (req, res) => {
  try {
    const {
      full_name,
      email,
      password,
      role = "Operator",
      status = "Active"
    } = req.body;

    if (!full_name || !email || !password) {
      return res.status(400).json({
        message: "full_name, email and password are required"
      });
    }

    const normalizedRole = role.charAt(0).toUpperCase() + role.slice(1).toLowerCase();

    if (!["Admin", "Operator"].includes(normalizedRole)) {
      return res.status(400).json({
        message: "Role must be Admin or Operator"
      });
    }

    const normalizedStatus = status.charAt(0).toUpperCase() + status.slice(1).toLowerCase();
    if (!["Active", "Inactive"].includes(normalizedStatus)) {
      return res.status(400).json({
        message: "Status must be Active or Inactive"
      });
    }

    const existing = await pool.query(
      "SELECT * FROM users WHERE email = $1",
      [email]
    );

    if (existing.rows.length > 0) {
      return res.status(400).json({
        message: "Email already exists"
      });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const result = await pool.query(
      `
      INSERT INTO users (full_name, email, password, role, status)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
      `,
      [full_name, email, hashedPassword, normalizedRole, normalizedStatus]
    );

    res.status(201).json({
      message: "User Created Successfully",
      user: publicUser(result.rows[0])
    });

  } catch (err) {
    return handleError(res, err);
  }
};

// --------------------------------------------------
// Login
// --------------------------------------------------

const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: "Email and password are required" });
    }

    const result = await pool.query(
      "SELECT * FROM users WHERE email = $1",
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ message: "Invalid Email" });
    }

    const user = result.rows[0];

    if (user.status && user.status.toLowerCase() === "inactive") {
      return res.status(403).json({ message: "Account is deactivated" });
    }

    const validPassword = await bcrypt.compare(password, user.password);

    if (!validPassword) {
      return res.status(400).json({ message: "Invalid Password" });
    }

    const token = signAccessToken(user);
    const refreshToken = await signRefreshToken(user);

    res.json({
      token,
      refreshToken,
      user: publicUser(user)
    });

  } catch (err) {
    return handleError(res, err);
  }
};

// --------------------------------------------------
// Refresh Token
// --------------------------------------------------

const refresh = async (req, res) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(400).json({ message: "refreshToken required" });
    }

    let payload;

    try {
      payload = jwt.verify(refreshToken, config.jwtSecret);
    } catch (err) {
      return res.status(401).json({ message: "Invalid refresh token" });
    }

    if (payload.type !== "refresh") {
      return res.status(401).json({ message: "Invalid refresh token" });
    }

    const stored = await pool.query(
      `
      SELECT rt.*, u.email, u.role, u.status
      FROM refresh_tokens rt
      JOIN users u ON rt.user_id = u.id
      WHERE rt.token = $1
      `,
      [refreshToken]
    );

    if (stored.rows.length === 0) {
      return res.status(401).json({ message: "Refresh token revoked" });
    }

    const record = stored.rows[0];

    if (record.status && record.status.toLowerCase() === "inactive") {
      return res.status(403).json({ message: "Account is deactivated" });
    }

    if (new Date(record.expires_at) < new Date()) {
      await pool.query("DELETE FROM refresh_tokens WHERE id = $1", [record.id]);
      return res.status(401).json({ message: "Refresh token expired" });
    }

    const token = signAccessToken(record);

    res.json({ token, user: publicUser(record) });

  } catch (err) {
    return handleError(res, err);
  }
};

// --------------------------------------------------
// Logout - revokes the refresh token
// --------------------------------------------------

const logout = async (req, res) => {
  try {
    const { refreshToken } = req.body;

    if (refreshToken) {
      await pool.query("DELETE FROM refresh_tokens WHERE token = $1", [refreshToken]);
    }

    res.json({ message: "Logged out successfully" });

  } catch (err) {
    return handleError(res, err);
  }
};

// --------------------------------------------------
// Get Current User
// --------------------------------------------------

const getMe = async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, full_name, email, role, status, created_at FROM users WHERE id = $1",
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    res.json(result.rows[0]);

  } catch (err) {
    return handleError(res, err);
  }
};

// --------------------------------------------------
// List Users - ADMIN ONLY
// --------------------------------------------------

const getUsers = async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, full_name, email, role, status, created_at
      FROM users
      ORDER BY id ASC
    `);

    res.json(result.rows);

  } catch (err) {
    return handleError(res, err);
  }
};

// --------------------------------------------------
// Update User (Full/Partial Update) - ADMIN ONLY
// --------------------------------------------------

const updateUser = async (req, res) => {
  try {
    const { id } = req.params;
    const { full_name, email, role, status } = req.body;

    const existing = await pool.query("SELECT * FROM users WHERE id = $1", [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    const current = existing.rows[0];

    let newRole = current.role;
    if (role) {
      newRole = role.charAt(0).toUpperCase() + role.slice(1).toLowerCase();
      if (!["Admin", "Operator"].includes(newRole)) {
        return res.status(400).json({ message: "Role must be Admin or Operator" });
      }
    }

    let newStatus = current.status || "Active";
    if (status) {
      newStatus = status.charAt(0).toUpperCase() + status.slice(1).toLowerCase();
      if (!["Active", "Inactive"].includes(newStatus)) {
        return res.status(400).json({ message: "Status must be Active or Inactive" });
      }
    }

    if (Number(id) === req.user.id) {
      if (newRole !== current.role) {
        return res.status(400).json({ message: "You cannot change your own role" });
      }
      if (newStatus === "Inactive") {
        return res.status(400).json({ message: "You cannot deactivate your own account" });
      }
    }

    const newName = full_name || current.full_name;
    const newEmail = email || current.email;

    const result = await pool.query(
      `
      UPDATE users
      SET full_name = $1, email = $2, role = $3, status = $4
      WHERE id = $5
      RETURNING id, full_name, email, role, status, created_at
      `,
      [newName, newEmail, newRole, newStatus, id]
    );

    res.json(result.rows[0]);

  } catch (err) {
    return handleError(res, err);
  }
};

// --------------------------------------------------
// Update User Role - ADMIN ONLY
// --------------------------------------------------

const updateUserRole = async (req, res) => {
  try {
    const { id } = req.params;
    const { role } = req.body;

    const normalizedRole = role.charAt(0).toUpperCase() + role.slice(1).toLowerCase();

    if (!["Admin", "Operator"].includes(normalizedRole)) {
      return res.status(400).json({ message: "Role must be Admin or Operator" });
    }

    if (Number(id) === req.user.id) {
      return res.status(400).json({ message: "You cannot change your own role" });
    }

    const result = await pool.query(
      `
      UPDATE users
      SET role = $1
      WHERE id = $2
      RETURNING id, full_name, email, role, status, created_at
      `,
      [normalizedRole, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    res.json(result.rows[0]);

  } catch (err) {
    return handleError(res, err);
  }
};

// --------------------------------------------------
// Toggle User Status (Activate / Deactivate) - ADMIN ONLY
// --------------------------------------------------

const toggleUserStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const normalizedStatus = status.charAt(0).toUpperCase() + status.slice(1).toLowerCase();

    if (!["Active", "Inactive"].includes(normalizedStatus)) {
      return res.status(400).json({ message: "Status must be Active or Inactive" });
    }

    if (Number(id) === req.user.id && normalizedStatus === "Inactive") {
      return res.status(400).json({ message: "You cannot deactivate your own account" });
    }

    const result = await pool.query(
      `
      UPDATE users
      SET status = $1
      WHERE id = $2
      RETURNING id, full_name, email, role, status, created_at
      `,
      [normalizedStatus, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    if (normalizedStatus === "Inactive") {
      await pool.query("DELETE FROM refresh_tokens WHERE user_id = $1", [id]);
    }

    res.json(result.rows[0]);

  } catch (err) {
    return handleError(res, err);
  }
};

// --------------------------------------------------
// Delete User - ADMIN ONLY
// --------------------------------------------------

const deleteUser = async (req, res) => {
  try {
    const { id } = req.params;

    if (Number(id) === req.user.id) {
      return res.status(400).json({ message: "You cannot delete your own account" });
    }

    await pool.query("DELETE FROM refresh_tokens WHERE user_id = $1", [id]);

    const result = await pool.query(
      "DELETE FROM users WHERE id = $1 RETURNING id",
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    res.json({ message: "User deleted successfully" });

  } catch (err) {
    return handleError(res, err);
  }
};

// --------------------------------------------------
// Change Password
// --------------------------------------------------

const changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ message: "currentPassword and newPassword required" });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ message: "New password must be at least 6 characters" });
    }

    const result = await pool.query(
      "SELECT * FROM users WHERE id = $1",
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    const validPassword = await bcrypt.compare(currentPassword, result.rows[0].password);

    if (!validPassword) {
      return res.status(400).json({ message: "Current password is incorrect" });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    await pool.query(
      "UPDATE users SET password = $1 WHERE id = $2",
      [hashedPassword, req.user.id]
    );

    res.json({ message: "Password changed successfully" });

  } catch (err) {
    return handleError(res, err);
  }
};

module.exports = {
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
};
