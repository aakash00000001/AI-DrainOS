# AI-DrainOS MQTT Integration Guide

AI-DrainOS can ingest live sensor readings over MQTT so real IoT drain
sensors (or the bundled MQTT simulator) feed the existing pipeline:

```
IoT Sensor / MQTT Simulator
        ↓  (MQTT publish)
MQTT Broker
        ↓  (backend subscribes)
AI-DrainOS Backend MQTT Service
        ↓  (validated + stored in existing `sensors` table)
AI prediction  →  Alert workflow  →  existing robot mission workflow
        ↓
SensorMonitor UI (live `sensorUpdate` Socket.IO events)
```

---

## 1. Topic format

```
ai-drainos/drains/{drainId}/sensors/{sensorId}
```

Examples:

| Topic                              | Meaning                       |
|------------------------------------|-------------------------------|
| `ai-drainos/drains/5/sensors/5`    | Drain 5, its sensor (id 5)    |
| `ai-drainos/drains/1/sensors/9999` | Unknown id maps to drain 1's own sensor |

Specials:

- If `sensorId` does not exist but the drain does, the reading is mapped to
  that drain's existing sensor (the topic `sensorId` is informational).
- If the drain has no sensor row yet, one is created automatically for it.
- If `sensorId` exists but belongs to a *different* drain, the message is
  rejected (logged, never crashes).

## 2. Payload format

```json
{
  "water_level": 90,
  "gas_level": 80,
  "temperature": 33,
  "timestamp": "2026-08-05T10:30:00Z"
}
```

Validation applied before anything is stored:

| Field         | Rule                                          |
|---------------|-----------------------------------------------|
| `water_level` | required number, 0–100                        |
| `gas_level`   | required number, 0–100                        |
| `temperature` | required number, -40 to 65                    |
| `timestamp`   | optional valid date (defaults to now)         |

Malformed JSON, missing/non-numeric/out-of-range values are rejected and
logged without affecting the service or other readings.

## 3. Environment variables

| Variable              | Default                  | Notes                                  |
|-----------------------|--------------------------|----------------------------------------|
| `MQTT_BROKER_URL`     | `mqtt://localhost:1883`  | Docker compose: `mqtt://mosquitto:1883`|
| `MQTT_USERNAME`       | *(empty)*                | Leave empty for no-auth brokers        |
| `MQTT_PASSWORD`       | *(empty)*                | Leave empty for no-auth brokers        |
| `MQTT_CLIENT_ID`      | `ai-drainos-backend`     | Backend subscriber id                  |
| `MQTT_TOPIC_PREFIX`   | `ai-drainos`             | Topic base prefix                      |
| `MQTT_ENABLED`        | `true`                   | `false` disables MQTT                  |
| `MQTT_SIM_INTERVAL`   | from settings (10s)      | Seconds between simulator rounds       |

Place them in `server/.env` for local development (this file is gitignored)
or in the root `.env` for Docker Compose. Credentials are never hardcoded
and never exposed to the frontend.

## 4. Run everything locally

### 4.1 Start an MQTT broker

Option A — Docker:

```bash
docker compose up -d mosquitto
```

Option B — no Docker: install Mosquitto for Windows
(winget: `winget install EclipseMosquitto.Mosquitto`, or via
https://mosquitto.org/download/), then run:

```bash
mosquitto -v
```

### 4.2 Start the backend

```bash
cd server
npm start
```

You should see:

```
🔌 Connecting to MQTT broker: mqtt://localhost:1883
✅ MQTT connected: mqtt://localhost:1883
📥 MQTT subscribed to ai-drainos/drains/+/sensors/+
```

If no broker is running the backend still starts fine and logs
`🔌 MQTT error: ...` / `🔌 MQTT reconnecting...` until the broker appears.

### 4.3 Start the MQTT sensor simulator

```bash
cd server
npm run simulate:mqtt
```

Each round publishes one reading per drain/sensor, e.g.:

```
📤 → ai-drainos/drains/5/sensors/5  {"water_level":90,"gas_level":80,"temperature":33,"timestamp":"2026-08-05T10:30:00Z"}
```

The existing REST simulator is untouched and still runs with `npm run simulate`.

### 4.4 Start the frontend (optional)

```bash
cd client
npm run dev
```

Open the **Sensor Monitor** page — each sensor card shows ⚡ for live MQTT
readings, the AI prediction badge (HIGH/MEDIUM/LOW) and a last-updated time.

## 5. Verify end to end

1. Subscribe to the raw stream (from any Mosquitto client machine):

   ```bash
   mosquitto_sub -t 'ai-drainos/drains/+/sensors/#' -v
   ```

   Watch the simulator publishes appear.

2. Watch backend logs for `📡 MQTT <topic> → <location> water=... prediction=...`.

3. Check the database — readings land in the existing `sensors` table:

   ```sql
   SELECT id, drain_id, water_level, gas_level, temperature, status, recorded_at
   FROM sensors ORDER BY recorded_at DESC;
   ```

4. Escalation to the existing workflow: when a drain's water level crosses the
   critical threshold, an `Open` Flood Risk alert is created, `criticalAlert` is
   emitted, and the existing mission engine auto-dispatches the nearest robot on
   the next 5s loop tick. When the sensor reports the drain back to Normal, open
   Flood Risk alerts for that drain are resolved.

5. AI predictions: the service calls the existing AI service
   (`http://127.0.0.1:5001/predict`). If it is unreachable, predictions fall
   back to the configured warning/critical thresholds.

## 6. Stop everything

- `Ctrl+C` the MQTT simulator (logs `🛑 MQTT simulator stopped`).
- `Ctrl+C` the backend (MQTT client disconnects cleanly).
- Docker: `docker compose stop mosquitto`.
- Local Mosquitto: `Ctrl+C` (or `net stop mosquitto` if installed as a service).

## 7. Broker authentication (optional)

To protect a broker with username/password, create a Mosquitto config with a
password file, then set `MQTT_USERNAME` / `MQTT_PASSWORD` in `server/.env` and
the root `.env`. Both the backend subscriber and the simulator will use them.

## 8. Tests

MQTT parsing, validation, database mapping, AI integration, socket emission,
alert escalation/dedup, and broker-failure resilience are covered in:

```bash
cd server
npm test
```

## 9. Limitations / notes

- Messages are processed one handler at a time per message event; very high
  publish rates are coalesced by the existing 5s live loop for robot dispatch.
- AI calls are throttled per drain (max one per 5s and skipped when values
  are unchanged) to avoid spamming the AI service.
- The `sensorUpdate` Socket.IO event uses the resolved database sensor id.
- No sensor history table is created: the existing `sensors` row is updated per
  reading, matching the current simulator behaviour.