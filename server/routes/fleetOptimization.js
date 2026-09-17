// ============================================================
// AI-DrainOS Fleet Optimization API - /api/fleet-optimization
//
// Predictive Resource & Robot Fleet Optimization.
//
// READ-ONLY + ADVISORY. There is deliberately NO state-changing
// endpoint here: recommendations never dispatch or assign robots.
// missionEngine.js remains the sole authority for mission
// assignment and movement.
// ============================================================

const express = require("express");
const router = express.Router();

const fleetOptimizationService = require("../services/fleetOptimizationService");

// --------------------------------------------------
// GET /api/fleet-optimization - full optimization view
// --------------------------------------------------

router.get("/", async (req, res) => {
  try {
    const optimization = await fleetOptimizationService.getFleetOptimization();
    res.json(optimization);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server Error" });
  }
});

// --------------------------------------------------
// GET /api/fleet-optimization/summary
// --------------------------------------------------

router.get("/summary", async (req, res) => {
  try {
    const summary = await fleetOptimizationService.getSummary();
    res.json(summary);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server Error" });
  }
});

// --------------------------------------------------
// GET /api/fleet-optimization/tasks
// --------------------------------------------------

router.get("/tasks", async (req, res) => {
  try {
    const tasks = await fleetOptimizationService.getTasksView();
    res.json(tasks);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server Error" });
  }
});

// --------------------------------------------------
// GET /api/fleet-optimization/robots
// --------------------------------------------------

router.get("/robots", async (req, res) => {
  try {
    const robots = await fleetOptimizationService.getRobots();
    res.json(robots);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server Error" });
  }
});

// --------------------------------------------------
// GET /api/fleet-optimization/recommendations
// --------------------------------------------------

router.get("/recommendations", async (req, res) => {
  try {
    const recommendations = await fleetOptimizationService.getRecommendations();
    res.json(recommendations);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server Error" });
  }
});

// --------------------------------------------------
// GET /api/fleet-optimization/analytics
// --------------------------------------------------

router.get("/analytics", async (req, res) => {
  try {
    const analytics = await fleetOptimizationService.getAnalytics();
    res.json(analytics);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server Error" });
  }
});

// --------------------------------------------------
// GET /api/fleet-optimization/:taskId
//   taskId format: "incident:<id>" | "drain:<id>"
//   Keep this LAST so it never shadows the routes above.
// --------------------------------------------------

router.get("/:taskId", async (req, res) => {
  try {
    const task = await fleetOptimizationService.getTask(req.params.taskId);
    if (!task) {
      return res.status(404).json({ error: "Task not found" });
    }
    res.json(task);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server Error" });
  }
});

module.exports = router;
