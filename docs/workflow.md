# AI-DrainOS System Workflow Documentation

This document illustrates key operational workflows within AI-DrainOS using Mermaid sequence and flow diagrams.

---

## 1. Critical Drain Lifecycle Workflow

```mermaid
flowchart TD
    A["Sensor Readings Written"] --> B{"Water Level >= Critical Threshold (80%)?"}
    B -- No --> C["Drain Status: Normal / Warning"]
    B -- Yes --> D["Drain Status Updated to 'Critical'"]
    D --> E["Critical Alert Generated"]
    E --> F["Mission Engine Searches for Nearest Available Idle Robot (Battery > 20%)"]
    F --> G["Robot Status Updated to 'Active' & Target Set to Drain GIS Location"]
    G --> H["Live Loop Increments Robot Coordinates Towards Target"]
    H --> I["Robot Progress Calculated & Emitted via Socket.IO"]
    I --> J{"Robot Reaches Target GIS Coordinates?"}
    J -- No --> H
    J -- Yes --> K["Drain Cleaning Executed"]
    K --> L["Drain Status Reset to 'Normal'"]
    L --> M["Mission Marked 'Completed' (100% Progress)"]
    M --> N["Robot Returned to 'Idle' / Route to Charging Station if Battery Low"]
```

---

## 2. Sensor → AI Prediction → Alert Workflow

```mermaid
sequenceDiagram
    autonumber
    participant Sim as Sensor Simulator
    participant DB as PostgreSQL
    participant Server as Express Backend
    participant AI as Flask AI Service (Port 5001)
    participant UI as Socket.IO Client

    Sim->>DB: Periodically insert sensor record (water, gas, temp)
    Server->>DB: Query latest sensor reading
    Server->>AI: POST /predict { water_level, gas_level, temperature }
    alt AI Service Available
        AI-->>Server: 200 OK { prediction: "HIGH" }
    else AI Unreachable
        Server-->>Server: Run fallback threshold calculation (Water Level >= 80)
    end
    alt Prediction is HIGH / Critical
        Server->>DB: INSERT INTO alerts (severity = 'Critical')
        Server->>UI: emit("criticalAlert", alertData)
        UI-->>UI: Display persistent error toast & sound alert
    end
```

---

## 3. Mission → Robot → Cleaning → Charging Workflow

```mermaid
sequenceDiagram
    autonumber
    actor Admin as Admin / Operator
    participant Server as Express Backend
    participant DB as PostgreSQL
    participant Loop as 5s Live Loop Engine
    participant Socket as Socket.IO

    Admin->>Server: POST /api/missions/dispatch { robot_id, drain_id }
    Server->>DB: INSERT INTO missions (status = 'Assigned')
    Server->>DB: UPDATE robots SET status = 'Active', target coordinates = drain coordinates
    loop Every 5 Seconds
        Loop->>DB: Decrement battery level (-1%)
        Loop->>DB: Move latitude & longitude step closer to target
        Loop->>Socket: emit("dashboardUpdate")
    end
    Loop->>DB: Robot reaches target coordinates
    Loop->>DB: UPDATE drains SET status = 'Normal'
    Loop->>DB: UPDATE missions SET mission_status = 'Completed', progress = 100
    Loop->>Socket: emit("drainCleaned", { robot, zone })
    alt Robot Battery <= 20%
        Loop->>DB: UPDATE robots SET status = 'Charging', target = Nearest Station
        Loop->>Socket: emit("batteryLow", robotData)
        loop Charging
            Loop->>DB: Increment battery level (+2%) until 100%
        end
        Loop->>DB: UPDATE robots SET status = 'Idle' when 100%
    end
```
