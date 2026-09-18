import axios from "axios";
import { API_URL, authHeaders } from "./api";

const BASE = `${API_URL}/audit`;

export async function getDecisionAudits(params = {}) {
  const response = await axios.get(BASE, { params });
  return response.data;
}

export async function getDecisionAuditSummary() {
  const response = await axios.get(`${BASE}/summary`);
  return response.data;
}

export async function getRecentDecisionAudits(limit = 10) {
  const response = await axios.get(`${BASE}/recent`, { params: { limit } });
  return response.data;
}

export async function getDrainDecisionAudits(drainId, params = {}) {
  const response = await axios.get(`${BASE}/drain/${encodeURIComponent(drainId)}`, { params });
  return response.data;
}

export async function getRobotDecisionAudits(robotId, params = {}) {
  const response = await axios.get(`${BASE}/robot/${encodeURIComponent(robotId)}`, { params });
  return response.data;
}

export async function getDecisionAuditById(id) {
  const response = await axios.get(`${BASE}/${encodeURIComponent(id)}`);
  return response.data;
}

export async function getDecisionAuditExplanation(id) {
  const response = await axios.get(`${BASE}/${encodeURIComponent(id)}/explanation`);
  return response.data;
}

export async function snapshotDecisionAudit(payload) {
  const response = await axios.post(`${BASE}/snapshot`, payload, {
    headers: authHeaders()
  });
  return response.data;
}