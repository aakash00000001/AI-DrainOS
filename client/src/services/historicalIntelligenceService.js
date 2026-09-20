import axios from "axios";
import { API_URL } from "./api";

const BASE = `${API_URL}/historical`;

// Valid windows served by the backend (server/services/
// historicalIntelligenceService.js PERIODS map). The backend defaults
// to 30d when neither `period` nor its alias `window` is supplied.
export const HISTORICAL_PERIODS = ["24h", "7d", "30d", "90d"];
export const HISTORICAL_DEFAULT_PERIOD = "30d";

// Full historical overview (aggregate of every section).
export async function getHistoricalOverview(params = {}) {
  const response = await axios.get(BASE, { params });
  return response.data;
}

// Compact summary used by dashboards / analytics.
export async function getHistoricalSummary(params = {}) {
  const response = await axios.get(`${BASE}/summary`, { params });
  return response.data;
}

// Per-sensor historical analytics (water/gas/temperature + trends).
export async function getHistoricalSensorHistory(params = {}) {
  const response = await axios.get(`${BASE}/sensors`, { params });
  return response.data;
}

// Per-sensor trend view (filtered sensor projection).
export async function getHistoricalTrends(params = {}) {
  const response = await axios.get(`${BASE}/trends`, { params });
  return response.data;
}

// Per-drain history + descriptive historical health.
export async function getHistoricalDrains(params = {}) {
  const response = await axios.get(`${BASE}/drains`, { params });
  return response.data;
}

// Incident history (severity/source/drain breakdowns + timing).
export async function getHistoricalIncidents(params = {}) {
  const response = await axios.get(`${BASE}/incidents`, { params });
  return response.data;
}

// Mission history (completion rate, status, per-drain).
export async function getHistoricalMissions(params = {}) {
  const response = await axios.get(`${BASE}/missions`, { params });
  return response.data;
}

// Robot response history (derived from real missions, read-only).
export async function getHistoricalRobots(params = {}) {
  const response = await axios.get(`${BASE}/robots`, { params });
  return response.data;
}

// Alert history (severity/type/drain breakdowns + open vs resolved).
export async function getHistoricalAlerts(params = {}) {
  const response = await axios.get(`${BASE}/alerts`, { params });
  return response.data;
}

// Descriptive time-of-day / weekday patterns (not causal).
export async function getHistoricalPatterns(params = {}) {
  const response = await axios.get(`${BASE}/patterns`, { params });
  return response.data;
}

// CURRENT live state vs HISTORICAL window averages.
export async function getHistoricalComparison(params = {}) {
  const response = await axios.get(`${BASE}/comparison`, { params });
  return response.data;
}

// Analytics-style historical overview (snake_case, /api/analytics).
export async function getHistoricalAnalytics(params = {}) {
  const response = await axios.get(`${API_URL}/analytics/historical`, { params });
  return response.data;
}

// Drain list used to populate the page-level drain filter.
export async function getDrainList() {
  const response = await axios.get(`${API_URL}/drains`);
  return response.data;
}

// Compact camelCase summary embedded in GET /api/dashboard
// (historicalSummary field). Used by the dashboard preview panel.
export async function getDashboardHistoricalSummary() {
  const response = await axios.get(`${API_URL}/dashboard`);
  return response.data?.historicalSummary || null;
}