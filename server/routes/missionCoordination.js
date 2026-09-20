// ============================================================
// AI-DrainOS Mission Coordination API
//   /api/missions/coordination
//
// Autonomous Mission Scheduling & Multi-Robot Coordination
// (Update #22).
//
// GET endpoints are read-only planning views (like the fleet
// optimization API). The single state-changing endpoint is
// POST /plan, which is auth-protected and, in autonomous mode,
// dispatches ONLY through the existing missionEngine authority
// (never a direct/competing mission insert).
// ============================================================

const express = require("express");
const router = express.Router();

const missionCoordinator = require("../services/missionCoordinatorService");
const { authMiddleware } = require("../middleware/auth");
const { auditMutation } = require("../middleware/auditMutation");

// --------------------------------------------------
// Mode validation
// Accepts "advisory" / "autonomous" (case-insensitive) plus the
// canonical ADVISORY_PLAN / AUTONOMOUS_PLAN values.
// --------------------------------------------------

function resolveMode(raw) {
  if (raw === undefined || raw === null || raw === "") {
    return { ok: true, mode: missionCoordinator.DEFAULT_MODE };
  }

  const value = String(raw).toUpperCase();
  const map = {
    ADVISORY: missionCoordinator.MODES.ADVISORY_PLAN,
    AUTONOMOUS: missionCoordinator.MODES.AUTONOMOUS_PLAN,
    ADVISORY_PLAN: missionCoordinator.MODES.ADVISORY_PLAN,
    AUTONOMOUS_PLAN: missionCoordinator.MODES.AUTONOMOUS_PLAN
  };

  if (map[value]) {
    return { ok: true, mode: map[value] };
  }

  return { ok: false, allowed: ["advisory", "autonomous"] };
}

// --------------------------------------------------
// GET /api/missions/coordination - full advisory plan
// --------------------------------------------------

router.get("/", async (req, res) => {
  try {
    const plan = await missionCoordinator.buildCoordinationPlan({
      mode: missionCoordinator.DEFAULT_MODE
    });
    res.json(plan);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server Error" });
  }
});

// --------------------------------------------------
// GET /api/missions/coordination/tasks - live task queue
// --------------------------------------------------

router.get("/tasks", async (req, res) => {
  try {
    const { tasks } = await missionCoordinator.getTaskQueue();
    res.json({ status: "OK", generated_at: new Date().toISOString(), tasks });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server Error" });
  }
});

// --------------------------------------------------
// GET /api/missions/coordination/robots - robot eligibility
// --------------------------------------------------

router.get("/robots", async (req, res) => {
  try {
    const view = await missionCoordinator.getEligibleRobots();
    res.json(view);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server Error" });
  }
});

// --------------------------------------------------
// GET /api/missions/coordination/conflicts
// --------------------------------------------------

router.get("/conflicts", async (req, res) => {
  try {
    const conflicts = await missionCoordinator.getMissionConflicts();
    res.json(conflicts);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server Error" });
  }
});

// --------------------------------------------------
// GET /api/missions/coordination/summary
// --------------------------------------------------

router.get("/summary", async (req, res) => {
  try {
    const summary = await missionCoordinator.getCoordinationSummary();
    res.json(summary);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server Error" });
  }
});

// --------------------------------------------------
// GET /api/missions/coordination/analytics
// --------------------------------------------------

router.get("/analytics", async (req, res) => {
  try {
    const analytics = await missionCoordinator.getAnalytics();
    res.json(analytics);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server Error" });
  }
});

// --------------------------------------------------
// POST /api/missions/coordination/plan - plan (auth)
//   body/query: { mode: "advisory" | "autonomous" }
//
// advisory  -> returns the plan, never mutates missions.
// autonomous-> executes the plan through missionEngine.dispatchMission.
// --------------------------------------------------

router.post("/plan", authMiddleware, auditMutation({
  action: "MISSION_COORDINATION_PLAN",
  entityType: "SYSTEM",
  before: async (req) => {
    const rawMode =
      req.body && req.body.mode !== undefined ? req.body.mode : req.query.mode;
    return { mode: rawMode || missionCoordinator.DEFAULT_MODE };
  },
  after: async (req, body) => {
    if (!body || typeof body !== "object") return body;
    const summarized = {};
    for (const [key, value] of Object.entries(body)) {
      summarized[key] = Array.isArray(value)
        ? { count: value.length }
        : value;
    }
    return summarized;
  }
}), async (req, res) => {
  const rawMode = req.body && req.body.mode !== undefined ? req.body.mode : req.query.mode;
  const resolved = resolveMode(rawMode);

  if (!resolved.ok) {
    return res.status(400).json({
      error: "Invalid mode",
      message: "mode must be one of: advisory, autonomous",
      allowed_modes: ["advisory", "autonomous"],
      default_mode: missionCoordinator.DEFAULT_MODE
    });
  }

  try {
    const result = await missionCoordinator.coordinate({ mode: resolved.mode });
    res.status(200).json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server Error" });
  }
});

module.exports = router;
