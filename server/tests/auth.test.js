const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const { setup } = require("./helpers");

let app;
let pool;

before(async () => {
  ({ app, pool } = await setup());
});

after(async () => {
  await pool.end();
});

test("GET /api/auth/me returns 401 without token", async () => {
  const res = await request(app).get("/api/auth/me");
  assert.equal(res.status, 401);
});

test("GET /api/auth/me returns 401 with invalid token", async () => {
  const res = await request(app)
    .get("/api/auth/me")
    .set("Authorization", "Bearer invalid.jwt.token");
  assert.equal(res.status, 401);
});

test("POST /api/auth/login - missing credentials rejected", async () => {
  const res = await request(app).post("/api/auth/login").send({});
  assert.equal(res.status, 400);
});

test("POST /api/auth/login - invalid credentials rejected", async () => {
  const res = await request(app).post("/api/auth/login").send({
    email: "admin@aidrain.com",
    password: "wrong-password"
  });

  assert.equal(res.status, 400);
});

test("POST /api/auth/login - valid admin login returns tokens", async () => {
  const res = await request(app).post("/api/auth/login").send({
    email: "admin@aidrain.com",
    password: "admin123"
  });

  assert.equal(res.status, 200);
  assert.ok(res.body.token);
  assert.ok(res.body.refreshToken);
  assert.equal(res.body.user.role, "Admin");
});

test("POST /api/auth/register - requires admin", async () => {
  const res = await request(app).post("/api/auth/register").send({
    full_name: "Intruder",
    email: "intruder@test.com",
    password: "password123"
  });

  assert.equal(res.status, 401);
});

test("POST /api/auth/register - operator cannot register users", async () => {
  const login = await request(app).post("/api/auth/login").send({
    email: "operator@aidrain.com",
    password: "operator123"
  });

  const res = await request(app)
    .post("/api/auth/register")
    .set("Authorization", `Bearer ${login.body.token}`)
    .send({
      full_name: "New User",
      email: "newuser@test.com",
      password: "password123"
    });

  assert.equal(res.status, 403);
});

test("POST /api/auth/register - admin can create operator", async () => {
  const login = await request(app).post("/api/auth/login").send({
    email: "admin@aidrain.com",
    password: "admin123"
  });

  const res = await request(app)
    .post("/api/auth/register")
    .set("Authorization", `Bearer ${login.body.token}`)
    .send({
      full_name: "New Operator",
      email: "newuser@test.com",
      password: "password123",
      role: "Operator"
    });

  assert.equal(res.status, 201);
  assert.equal(res.body.user.role, "Operator");

  const duplicate = await request(app)
    .post("/api/auth/register")
    .set("Authorization", `Bearer ${login.body.token}`)
    .send({
      full_name: "New Operator",
      email: "newuser@test.com",
      password: "password123"
    });

  assert.equal(duplicate.status, 400);
});

test("PUT /api/auth/users/:id - update user details and status", async () => {
  const adminLogin = await request(app).post("/api/auth/login").send({
    email: "admin@aidrain.com",
    password: "admin123"
  });

  const token = adminLogin.body.token;

  const createRes = await request(app)
    .post("/api/auth/register")
    .set("Authorization", `Bearer ${token}`)
    .send({
      full_name: "To Edit",
      email: "toedit@test.com",
      password: "password123",
      role: "Operator"
    });

  const userId = createRes.body.user.id;

  const updateRes = await request(app)
    .put(`/api/auth/users/${userId}`)
    .set("Authorization", `Bearer ${token}`)
    .send({
      full_name: "Edited Name",
      role: "Operator",
      status: "Active"
    });

  assert.equal(updateRes.status, 200);
  assert.equal(updateRes.body.full_name, "Edited Name");
});

test("PATCH /api/auth/users/:id/status - deactivate user blocks login", async () => {
  const adminLogin = await request(app).post("/api/auth/login").send({
    email: "admin@aidrain.com",
    password: "admin123"
  });

  const token = adminLogin.body.token;

  const createRes = await request(app)
    .post("/api/auth/register")
    .set("Authorization", `Bearer ${token}`)
    .send({
      full_name: "Temp Deactive",
      email: "tempdeactive@test.com",
      password: "password123",
      role: "Operator"
    });

  const userId = createRes.body.user.id;

  const deactivateRes = await request(app)
    .patch(`/api/auth/users/${userId}/status`)
    .set("Authorization", `Bearer ${token}`)
    .send({ status: "Inactive" });

  assert.equal(deactivateRes.status, 200);
  assert.equal(deactivateRes.body.status, "Inactive");

  const blockedLogin = await request(app).post("/api/auth/login").send({
    email: "tempdeactive@test.com",
    password: "password123"
  });

  assert.equal(blockedLogin.status, 403);
});

test("DELETE /api/auth/users/:id - prevents self-deletion", async () => {
  const adminLogin = await request(app).post("/api/auth/login").send({
    email: "admin@aidrain.com",
    password: "admin123"
  });

  const res = await request(app)
    .delete(`/api/auth/users/${adminLogin.body.user.id}`)
    .set("Authorization", `Bearer ${adminLogin.body.token}`);

  assert.equal(res.status, 400);
});

test("POST /api/auth/refresh - returns new access token", async () => {
  const login = await request(app).post("/api/auth/login").send({
    email: "admin@aidrain.com",
    password: "admin123"
  });

  const res = await request(app).post("/api/auth/refresh").send({
    refreshToken: login.body.refreshToken
  });

  assert.equal(res.status, 200);
  assert.ok(res.body.token);
  assert.equal(res.body.user.email, "admin@aidrain.com");
});

test("POST /api/auth/refresh - revoked token rejected", async () => {
  const login = await request(app).post("/api/auth/login").send({
    email: "admin@aidrain.com",
    password: "admin123"
  });

  await request(app).post("/api/auth/logout").send({
    refreshToken: login.body.refreshToken
  });

  const res = await request(app).post("/api/auth/refresh").send({
    refreshToken: login.body.refreshToken
  });

  assert.equal(res.status, 401);
});

test("GET /api/auth/users - admin only", async () => {
  const operatorLogin = await request(app).post("/api/auth/login").send({
    email: "operator@aidrain.com",
    password: "operator123"
  });

  const forbidden = await request(app)
    .get("/api/auth/users")
    .set("Authorization", `Bearer ${operatorLogin.body.token}`);

  assert.equal(forbidden.status, 403);

  const adminLogin = await request(app).post("/api/auth/login").send({
    email: "admin@aidrain.com",
    password: "admin123"
  });

  const ok = await request(app)
    .get("/api/auth/users")
    .set("Authorization", `Bearer ${adminLogin.body.token}`);

  assert.equal(ok.status, 200);
  assert.ok(ok.body.length >= 2);
});

test("PUT /api/auth/me/password - wrong current password rejected", async () => {
  const login = await request(app).post("/api/auth/login").send({
    email: "operator@aidrain.com",
    password: "operator123"
  });

  const res = await request(app)
    .put("/api/auth/me/password")
    .set("Authorization", `Bearer ${login.body.token}`)
    .send({
      currentPassword: "not-the-password",
      newPassword: "newpass123"
    });

  assert.equal(res.status, 400);
});

test("PUT /api/auth/me/password - change and login with new password", async () => {
  const login = await request(app).post("/api/auth/login").send({
    email: "operator@aidrain.com",
    password: "operator123"
  });

  const res = await request(app)
    .put("/api/auth/me/password")
    .set("Authorization", `Bearer ${login.body.token}`)
    .send({
      currentPassword: "operator123",
      newPassword: "newpass123"
    });

  assert.equal(res.status, 200);

  const relogin = await request(app).post("/api/auth/login").send({
    email: "operator@aidrain.com",
    password: "newpass123"
  });

  assert.equal(relogin.status, 200);
});
