import axios from "axios";
import { API_URL, authHeaders } from "./api";

const BASE = `${API_URL}/audit/operator`;

export async function getOperatorAudits(params = {}) {
  const response = await axios.get(BASE, { params, headers: authHeaders() });
  return response.data;
}

export async function getOperatorAuditSummary() {
  const response = await axios.get(`${BASE}/summary`, { headers: authHeaders() });
  return response.data;
}

export async function getOperatorAuditActions() {
  const response = await axios.get(`${BASE}/actions`, { headers: authHeaders() });
  return response.data;
}

export async function getOperatorAuditById(id) {
  const response = await axios.get(`${BASE}/${encodeURIComponent(id)}`, {
    headers: authHeaders()
  });
  return response.data;
}