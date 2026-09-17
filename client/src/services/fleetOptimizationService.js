import axios from "axios";
import { API_URL } from "./api";

const BASE = `${API_URL}/fleet-optimization`;

export async function getFleetOptimization() {
  const response = await axios.get(BASE);
  return response.data;
}

export async function getFleetSummary() {
  const response = await axios.get(`${BASE}/summary`);
  return response.data;
}

export async function getFleetTasks() {
  const response = await axios.get(`${BASE}/tasks`);
  return response.data;
}

export async function getFleetRobots() {
  const response = await axios.get(`${BASE}/robots`);
  return response.data;
}

export async function getFleetRecommendations() {
  const response = await axios.get(`${BASE}/recommendations`);
  return response.data;
}

export async function getFleetAnalytics() {
  const response = await axios.get(`${BASE}/analytics`);
  return response.data;
}

export async function getFleetTask(taskId) {
  const response = await axios.get(`${BASE}/${encodeURIComponent(taskId)}`);
  return response.data;
}
