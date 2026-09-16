# AI-DrainOS REST API Documentation

Base URL: `http://localhost:5000/api` (or environment configured `VITE_API_URL`)

---

## Authentication & User Management (`/api/auth`)

### `POST /api/auth/login`
- **Access**: Public
- **Request Body**:
  ```json
  {
    "email": "admin@aidrain.com",
    "password": "admin123"
  }
  ```
- **Response** (200 OK):
  ```json
  {
    "token": "<JWT_ACCESS_TOKEN>",
    "refreshToken": "<JWT_REFRESH_TOKEN>",
    "user": {
      "id": 1,
      "full_name": "Administrator",
      "email": "admin@aidrain.com",
      "role": "Admin",
      "status": "Active"
    }
  }
  ```

### `POST /api/auth/refresh`
- **Access**: Public
- **Request Body**: `{ "refreshToken": "<JWT_REFRESH_TOKEN>" }`
- **Response** (200 OK): `{ "token": "<NEW_JWT_ACCESS_TOKEN>", "user": { ... } }`

### `POST /api/auth/logout`
- **Access**: Public
- **Request Body**: `{ "refreshToken": "<JWT_REFRESH_TOKEN>" }`
- **Response** (200 OK): `{ "message": "Logged out successfully" }`

### `GET /api/auth/me`
- **Access**: Authenticated (`Bearer <token>`)
- **Response** (200 OK): User profile object omitting password hash.

### `PUT /api/auth/me/password`
- **Access**: Authenticated (`Bearer <token>`)
- **Request Body**: `{ "currentPassword": "admin123", "newPassword": "newpassword123" }`
- **Response** (200 OK): `{ "message": "Password changed successfully" }`

### `GET /api/auth/users`
- **Access**: Admin Only (`Bearer <token>`)
- **Response** (200 OK): Array of all user accounts.

### `POST /api/auth/register`
- **Access**: Admin Only (`Bearer <token>`)
- **Request Body**: `{ "full_name": "John Doe", "email": "john@aidrain.com", "password": "password123", "role": "Operator", "status": "Active" }`
- **Response** (201 Created): User creation summary.

### `PUT /api/auth/users/:id`
- **Access**: Admin Only (`Bearer <token>`)
- **Request Body**: `{ "full_name": "Updated Name", "email": "john@aidrain.com", "role": "Operator", "status": "Active" }`
- **Response** (200 OK): Updated user details.

### `PATCH /api/auth/users/:id/status`
- **Access**: Admin Only (`Bearer <token>`)
- **Request Body**: `{ "status": "Inactive" }`
- **Response** (200 OK): Updated user record with new status.

### `DELETE /api/auth/users/:id`
- **Access**: Admin Only (`Bearer <token>`)
- **Response** (200 OK): `{ "message": "User deleted successfully" }`

---

## Drains API (`/api/drains`)

### `GET /api/drains`
- **Access**: Public / Authenticated
- **Response** (200 OK): Array of drain zone objects with coordinates and blockage levels.

### `GET /api/drains/:id`
- **Access**: Public / Authenticated
- **Response** (200 OK): Single drain object.

### `POST /api/drains`
- **Access**: Authenticated
- **Request Body**: `{ "zone_name": "Zone 8", "location": "Anna Nagar", "status": "Normal", "blockage_level": 15, "latitude": 9.93, "longitude": 78.12 }`
- **Response** (201 Created): Created drain record.

### `PUT /api/drains/:id`
- **Access**: Authenticated
- **Request Body**: `{ "zone_name": "Zone 1", "location": "Goripalayam", "status": "Normal", "blockage_level": 30, "latitude": 9.9252, "longitude": 78.1198 }`
- **Response** (200 OK): Updated drain record.
- **Note**: When `status` is set to `Normal`, any open alerts for that drain are automatically marked `Resolved`. Setting a drain to `Critical` (via this route or `PATCH /api/drains/:id/status`) triggers the mission engine to auto-dispatch the nearest available robot.

### `PATCH /api/drains/:id/status`
- **Access**: Authenticated
- **Request Body**: `{ "status": "Critical" }`
- **Response** (200 OK): Updated status confirmation.

### `DELETE /api/drains/:id`
- **Access**: Authenticated
- **Response** (200 OK): Deletion status.

---

## Robots & Mission API (`/api/robots`, `/api/missions`)

### `GET /api/robots`
- **Access**: Public / Authenticated
- **Response** (200 OK): List of robots with status, battery level, location, target coordinates.

### `GET /api/missions`
- **Access**: Public / Authenticated
- **Response** (200 OK): Current active & recent missions list.

### `GET /api/missions/history`
- **Access**: Public / Authenticated
- **Query Params**: `?robot_id=2&status=Completed`
- **Response** (200 OK): Mission history records.

### `POST /api/missions/dispatch`
- **Access**: Authenticated
- **Request Body**: `{ "robot_id": 2, "drain_id": 3 }`
- **Response** (201 Created): Mission dispatch object.

---

## Sensors & Predictions (`/api/sensors`, `/api/predictions`)

### `GET /api/sensors`
- **Access**: Public / Authenticated
- **Response** (200 OK): Sensor telemetry list.

### `GET /api/predictions`
- **Access**: Public / Authenticated
- **Response** (200 OK): Returns AI machine learning prediction or fallback calculation.
  ```json
  {
    "prediction": "HIGH",
    "sensor": { "water_level": 90, "gas_level": 75, "temperature": 37.0 },
    "source": "ai"
  }
  ```

---

## Alerts, Settings & Dashboard

### `GET /api/alerts`
- **Access**: Public / Authenticated

### `POST /api/alerts`
- **Access**: Authenticated

### `PUT /api/alerts/:id`
- **Access**: Authenticated

### `GET /api/settings`
- **Access**: Public / Authenticated

### `PUT /api/settings`
- **Access**: Admin Only (`Bearer <token>`)

### `GET /api/dashboard`
- **Access**: Public / Authenticated
- **Response** (200 OK): `{ "totalDrains": 7, "activeRobots": 1, "criticalAlerts": 2 }`

---

## Analytics API (`/api/analytics`)

### `GET /api/analytics`
- **Access**: Public / Authenticated
- **Response** (200 OK): Derived from live database state:
  ```json
  {
    "total_cleanings": 3,
    "total_missions": 3,
    "blockages_detected": 3,
    "critical_alerts_total": 3,
    "robot_operations": 3,
    "flood_predictions": 7,
    "total_drains": 7,
    "avg_mission_duration_minutes": 10.0
  }
  ```
  - `total_cleanings` / `robot_operations` / `total_missions`: mission records.
  - `blockages_detected`: open Critical alerts.
  - `flood_predictions`: sensor readings count.
  - Also includes `risk_average_score` / `risk_*` fields (see [flood-risk.md](flood-risk.md)) and `forecast_average_risk` / `forecast_*` fields (see [forecasting.md](forecasting.md)).

### `GET /api/analytics/monthly`
- **Access**: Public / Authenticated
- **Response** (200 OK): Monthly sensor aggregates for the last 6 months (drives the "Monthly Flood Risk" chart):
  ```json
  [
    { "month": "Sep", "avg_water": 54.3, "max_water": 95, "avg_gas": 38.2, "readings": 7 }
  ]
  ```
