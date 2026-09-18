// ============================================================
// AI-DrainOS — Sensor Intelligence client service (Update #21)
//
// Thin read-only wrapper over the additive
// /api/predictions/sensor-intelligence API. Mirrors the existing
// fleet-optimization / mission-coordination service pattern.
// ============================================================

import axios from "axios";
import { API_URL } from "./api";

const BASE = `${API_URL}/predictions/sensor-intelligence`;

export async function getSensorIntelligence(params = {}) {
  const response = await axios.get(BASE, { params });
  return response.data;
}

export async function getSensorIntelligenceSummary() {
  const response = await axios.get(`${BASE}/summary`);
  return response.data;
}

export async function getSensorIntelligenceAnomalies(params = {}) {
  const response = await axios.get(`${BASE}/anomalies`, { params });
  return response.data;
}

export async function getSensorAnomaliesBySensor(sensorId, params = {}) {
  const response = await axios.get(`${BASE}/anomalies/${sensorId}`, { params });
  return response.data;
}

export async function getDrainSensorIntelligence(drainId) {
  const response = await axios.get(`${BASE}/drain/${drainId}`);
  return response.data;
}

export async function getSensorDetail(sensorId) {
  const response = await axios.get(`${BASE}/${sensorId}`);
  return response.data;
}
