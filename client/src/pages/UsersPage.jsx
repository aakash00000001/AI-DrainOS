import { useEffect, useState } from "react";
import axios from "axios";
import {
  FaUserPlus,
  FaTrash,
  FaKey,
  FaLock,
  FaEdit,
  FaUserCheck,
  FaUserSlash
} from "react-icons/fa";
import "../styles/pages.css";

const API = import.meta.env.VITE_API_URL || "http://localhost:5000/api";

function UsersPage() {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState(null);
  const [showRegister, setShowRegister] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [editingUser, setEditingUser] = useState(null);

  const [form, setForm] = useState({
    full_name: "",
    email: "",
    password: "",
    role: "Operator",
    status: "Active"
  });

  const [editForm, setEditForm] = useState({
    full_name: "",
    email: "",
    role: "Operator",
    status: "Active"
  });

  const [passwordForm, setPasswordForm] = useState({
    currentPassword: "",
    newPassword: ""
  });

  const currentUser = JSON.parse(localStorage.getItem("user") || "{}");

  const getHeaders = () => ({
    Authorization: `Bearer ${localStorage.getItem("token")}`
  });

  const loadUsers = async () => {
    try {
      const res = await axios.get(`${API}/auth/users`, { headers: getHeaders() });
      setUsers(res.data);
    } catch (err) {
      console.log(err);
      setMessage({ type: "error", text: "Failed to load users" });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadUsers();
  }, []);

  const registerUser = async () => {
    setMessage(null);

    if (!form.full_name || !form.email || !form.password) {
      setMessage({ type: "error", text: "Name, email and password are required" });
      return;
    }

    try {
      await axios.post(`${API}/auth/register`, form, { headers: getHeaders() });
      setMessage({ type: "success", text: `User ${form.full_name} created successfully` });
      setForm({ full_name: "", email: "", password: "", role: "Operator", status: "Active" });
      setShowRegister(false);
      loadUsers();
    } catch (err) {
      setMessage({ type: "error", text: err.response?.data?.message || "Registration failed" });
    }
  };

  const startEditUser = (user) => {
    setEditingUser(user);
    setEditForm({
      full_name: user.full_name,
      email: user.email,
      role: user.role,
      status: user.status || "Active"
    });
  };

  const saveEditUser = async () => {
    if (!editingUser) return;
    setMessage(null);

    try {
      await axios.put(`${API}/auth/users/${editingUser.id}`, editForm, { headers: getHeaders() });
      setMessage({ type: "success", text: `User ${editForm.full_name} updated` });
      setEditingUser(null);
      loadUsers();
    } catch (err) {
      setMessage({ type: "error", text: err.response?.data?.message || "Failed to update user" });
    }
  };

  const toggleStatus = async (id, currentStatus) => {
    setMessage(null);
    const newStatus = currentStatus === "Active" ? "Inactive" : "Active";

    try {
      await axios.patch(`${API}/auth/users/${id}/status`, { status: newStatus }, { headers: getHeaders() });
      setMessage({ type: "success", text: `User status set to ${newStatus}` });
      loadUsers();
    } catch (err) {
      setMessage({ type: "error", text: err.response?.data?.message || "Failed to update status" });
    }
  };

  const deleteUser = async (id, name) => {
    setMessage(null);
    if (!window.confirm(`Delete user ${name}?`)) return;

    try {
      await axios.delete(`${API}/auth/users/${id}`, { headers: getHeaders() });
      setMessage({ type: "success", text: `${name} deleted` });
      loadUsers();
    } catch (err) {
      setMessage({ type: "error", text: err.response?.data?.message || "Failed to delete user" });
    }
  };

  const changePassword = async () => {
    setMessage(null);

    if (!passwordForm.currentPassword || !passwordForm.newPassword) {
      setMessage({ type: "error", text: "Both password fields are required" });
      return;
    }

    try {
      await axios.put(`${API}/auth/me/password`, passwordForm, { headers: getHeaders() });
      setMessage({ type: "success", text: "Password changed successfully" });
      setPasswordForm({ currentPassword: "", newPassword: "" });
      setShowPassword(false);
    } catch (err) {
      setMessage({ type: "error", text: err.response?.data?.message || "Failed to change password" });
    }
  };

  if (loading) {
    return <p style={{ color: "#64748b" }}>Loading users...</p>;
  }

  return (
    <div className="page-section">

      <h2>👥 User Management</h2>

      {message && (
        <div className={`status-msg ${message.type}`}>
          {message.text}
        </div>
      )}

      <div className="panel-card">

        <div className="table-header">
          <h2>System Users</h2>
          <button
            className="btn btn-primary"
            onClick={() => {
              setShowRegister(!showRegister);
              setEditingUser(null);
            }}
          >
            <FaUserPlus /> {showRegister ? "Cancel" : "Register User"}
          </button>
        </div>

        {showRegister && (
          <div className="panel-card" style={{ boxShadow: "none", padding: "20px 0 0" }}>
            <h3>➕ Create New User</h3>
            <div className="panel-grid">
              <div className="form-group">
                <label>Full Name</label>
                <input
                  type="text"
                  placeholder="e.g. R. Kavitha"
                  value={form.full_name}
                  onChange={(e) => setForm({ ...form, full_name: e.target.value })}
                />
              </div>

              <div className="form-group">
                <label>Email</label>
                <input
                  type="email"
                  placeholder="officer@aidrain.com"
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                />
              </div>

              <div className="form-group">
                <label>Password</label>
                <input
                  type="password"
                  placeholder="Min 6 characters"
                  value={form.password}
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                />
              </div>

              <div className="form-group">
                <label>Role</label>
                <select
                  value={form.role}
                  onChange={(e) => setForm({ ...form, role: e.target.value })}
                >
                  <option value="Operator">Operator</option>
                  <option value="Admin">Admin</option>
                </select>
              </div>

              <div className="form-group">
                <label>Status</label>
                <select
                  value={form.status}
                  onChange={(e) => setForm({ ...form, status: e.target.value })}
                >
                  <option value="Active">Active</option>
                  <option value="Inactive">Inactive</option>
                </select>
              </div>
            </div>

            <button className="btn btn-success" onClick={registerUser}>
              Create User
            </button>
          </div>
        )}

        {editingUser && (
          <div className="panel-card" style={{ boxShadow: "none", padding: "20px 0 0", borderTop: "1px solid #334155" }}>
            <h3>✏️ Edit User: {editingUser.full_name}</h3>
            <div className="panel-grid">
              <div className="form-group">
                <label>Full Name</label>
                <input
                  type="text"
                  value={editForm.full_name}
                  onChange={(e) => setEditForm({ ...editForm, full_name: e.target.value })}
                />
              </div>

              <div className="form-group">
                <label>Email</label>
                <input
                  type="email"
                  value={editForm.email}
                  onChange={(e) => setEditForm({ ...editForm, email: e.target.value })}
                />
              </div>

              <div className="form-group">
                <label>Role</label>
                <select
                  value={editForm.role}
                  onChange={(e) => setEditForm({ ...editForm, role: e.target.value })}
                  disabled={editingUser.id === currentUser.id}
                >
                  <option value="Operator">Operator</option>
                  <option value="Admin">Admin</option>
                </select>
              </div>

              <div className="form-group">
                <label>Status</label>
                <select
                  value={editForm.status}
                  onChange={(e) => setEditForm({ ...editForm, status: e.target.value })}
                  disabled={editingUser.id === currentUser.id}
                >
                  <option value="Active">Active</option>
                  <option value="Inactive">Inactive</option>
                </select>
              </div>
            </div>

            <div style={{ display: "flex", gap: "10px", marginTop: "10px" }}>
              <button className="btn btn-success" onClick={saveEditUser}>
                Save Changes
              </button>
              <button className="btn btn-secondary" onClick={() => setEditingUser(null)}>
                Cancel
              </button>
            </div>
          </div>
        )}

        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th>Status</th>
              <th>Created</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id}>
                <td>
                  {user.full_name}
                  {user.id === currentUser.id && (
                    <small style={{ color: "#94a3b8" }}> (you)</small>
                  )}
                </td>
                <td>{user.email}</td>
                <td>
                  <span className={`role-badge role-${(user.role || "operator").toLowerCase()}`}>
                    {user.role}
                  </span>
                </td>
                <td>
                  <span className={`status-badge status-${(user.status || "active").toLowerCase()}`}>
                    {user.status || "Active"}
                  </span>
                </td>
                <td>{user.created_at ? new Date(user.created_at).toLocaleDateString() : "N/A"}</td>
                <td>
                  <button
                    className="action-btn"
                    onClick={() => startEditUser(user)}
                    title="Edit user details"
                  >
                    <FaEdit /> Edit
                  </button>

                  {user.id !== currentUser.id && (
                    <>
                      <button
                        className="action-btn"
                        onClick={() => toggleStatus(user.id, user.status || "Active")}
                        title={user.status === "Inactive" ? "Activate User" : "Deactivate User"}
                      >
                        {user.status === "Inactive" ? <FaUserCheck /> : <FaUserSlash />}
                        {user.status === "Inactive" ? " Activate" : " Deactivate"}
                      </button>

                      <button
                        className="action-btn danger"
                        onClick={() => deleteUser(user.id, user.full_name)}
                        title="Delete user"
                      >
                        <FaTrash /> Delete
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

      </div>

      <div className="panel-card">
        <div className="table-header">
          <h2>🔑 My Password</h2>
          <button
            className="btn btn-warning"
            onClick={() => setShowPassword(!showPassword)}
          >
            <FaKey /> {showPassword ? "Cancel" : "Change My Password"}
          </button>
        </div>

        {showPassword && (
          <div className="panel-grid">
            <div className="form-group">
              <label>Current Password</label>
              <input
                type="password"
                value={passwordForm.currentPassword}
                onChange={(e) => setPasswordForm({ ...passwordForm, currentPassword: e.target.value })}
              />
            </div>

            <div className="form-group">
              <label>New Password</label>
              <input
                type="password"
                value={passwordForm.newPassword}
                onChange={(e) => setPasswordForm({ ...passwordForm, newPassword: e.target.value })}
              />
            </div>

            <div className="form-group">
              <button className="btn btn-warning" onClick={changePassword}>
                <FaLock /> Update Password
              </button>
            </div>
          </div>
        )}
      </div>

    </div>
  );
}

export default UsersPage;