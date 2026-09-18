// ============================================================
// AI-DrainOS — Mission Coordination client service (Update #22)
//
// Thin wrapper over the additive /api/missions/coordination API.
// Read helpers mirror the existing fleet-optimization service. The
// POST /plan call requires a token (the endpoint is auth-protected)
// and is the ONLY mutating call — and only in autonomous mode.
// ============================================================

import axios from "axios";
import { API_URL, authHeaders } from "./api";

const BASE = `${API_URL}/missions/coordination`;

export async function getMissionCoordination() {
  const response = await axios.get(BASE);
  return response.data;
}

export async function getCoordinationTasks() {
  const response = await axios.get(`${BASE}/tasks`);
  return response.data;
}

export async function getCoordinationRobots() {
  const response = await axios.get(`${BASE}/robots`);
  return response.data;
}

export async function getCoordinationConflicts() {
  const response = await axios.get(`${BASE}/conflicts`);
  return response.data;
}

export async function getCoordinationSummary() {
  const response = await axios.get(`${BASE}/summary`);
  return response.data;
}

export async function getCoordinationAnalytics() {
  const response = await axios.get(`${BASE}/analytics`);
  return response.data;
}

/**
 * Request a coordination plan.
 * @param {"advisory"|"autonomous"} mode advisory never mutates;
 *   autonomous dispatches through the existing missionEngine.
 */
export async function planMissionCoordination(mode = "advisory") {
  const response = await axios.post(
    `${BASE}/plan`,
    { mode },
    { headers: authHeaders() }
  );
  return response.data;
}
