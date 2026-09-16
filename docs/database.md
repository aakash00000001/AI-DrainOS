# AI-DrainOS Database Schema Documentation

Database System: PostgreSQL 15+  
Default Development Database: `ai_drainos`  
Test Database: `ai_drainos_test`

---

## Entity-Relationship Diagram (Mermaid)

```mermaid
erDiagram
    users ||--o{ refresh_tokens : "has"
    drains ||--o{ sensors : "monitors"
    drains ||--o{ alerts : "generates"
    drains ||--o{ missions : "target of"
    robots ||--o{ missions : "executes"

    users {
        int id PK
        string full_name
        string email UK
        string password
        string role
        string status
        timestamp created_at
    }

    refresh_tokens {
        int id PK
        int user_id FK
        text token UK
        timestamp expires_at
        timestamp created_at
    }

    settings {
        string key PK
        text value
        timestamp updated_at
    }

    drains {
        int id PK
        string zone_name
        string location
        string status
        int blockage_level
        numeric latitude
        numeric longitude
        timestamp created_at
    }

    robots {
        int id PK
        string robot_name
        string assigned_zone
        string status
        int battery_level
        timestamp last_active
        numeric latitude
        numeric longitude
        numeric target_latitude
        numeric target_longitude
    }

    sensors {
        int id PK
        int drain_id FK
        int water_level
        int gas_level
        numeric temperature
        string sensor_status
        string status
        timestamp recorded_at
    }

    alerts {
        int id PK
        int drain_id FK
        string alert_type
        text message
        string severity
        string alert_status
        timestamp created_at
    }

    missions {
        int id PK
        int robot_id FK
        int drain_id FK
        string mission_status
        int progress
        timestamp assigned_time
        timestamp completed_time
    }

    charging_stations {
        int id PK
        string station_name
        numeric latitude
        numeric longitude
    }

    reports {
        int id PK
        string report_title
        int total_drains
        int active_robots
        int critical_alerts
        timestamp generated_date
    }
```

---

## Core Tables & Descriptions

### 1. `users`
Stores system accounts with Role-Based Access Control (`Admin`, `Operator`) and status (`Active`, `Inactive`).
- `id` (SERIAL PRIMARY KEY)
- `full_name` (VARCHAR(100))
- `email` (VARCHAR(100) UNIQUE)
- `password` (VARCHAR(255) bcrypt hash)
- `role` (VARCHAR(20) DEFAULT 'Operator')
- `status` (VARCHAR(20) DEFAULT 'Active')
- `created_at` (TIMESTAMP)

### 2. `refresh_tokens`
Stores JWT refresh tokens for session rotation and logout revocation.

### 3. `settings`
Key-value store for global threshold configurations:
- `critical_threshold` (default: 80)
- `warning_threshold` (default: 50)
- `battery_low_threshold` (default: 20)
- `sensor_sim_interval` (default: 10)
- `notification_enabled` (default: true)

### 4. `drains`
Drainage location registry with GIS coordinates (Madurai, Tamil Nadu region defaults) and blockage statuses (`Normal`, `Warning`, `Critical`).

### 5. `robots`
Robot fleet tracking with dynamic GPS coordinates (`latitude`, `longitude`), target destination coordinates (`target_latitude`, `target_longitude`), battery level (0–100%), and operational statuses (`Idle`, `Active`, `Charging`).

### 6. `sensors`
Telemetry historical log linked to drains.

### 7. `alerts`
System alerts for blockages, critical water levels, and gas anomalies.

### 8. `missions`
Mission dispatch log linking assigned robots to target drains with progress tracking (0–100%).

### 9. `charging_stations`
Coordinates of designated charging hubs.

### 10. `reports`
Aggregated historical snapshot reports.
