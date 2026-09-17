import axios from "axios";
import { API_URL, authHeaders } from "./api";

const BASE = `${API_URL}/incidents`;

export async function getIncidents(params = {}) {
  const response = await axios.get(BASE, { params });
  return response.data;
}

export async function getActiveIncidents() {
  const response = await axios.get(`${BASE}/active`);
  return response.data;
}

export async function getIncident(id) {
  const response = await axios.get(`${BASE}/${id}`);
  return response.data;
}

export async function getIncidentTimeline(id) {
  const response = await axios.get(`${BASE}/${id}/timeline`);
  return response.data;
}

export async function createIncident(payload) {
  const response = await axios.post(BASE, payload, { headers: authHeaders() });
  return response.data;
}

export async function acknowledgeIncident(id) {
  const response = await axios.put(`${BASE}/${id}/acknowledge`, {}, { headers: authHeaders() });
  return response.data;
}

export async function respondToIncident(id) {
  const response = await axios.put(`${BASE}/${id}/respond`, {}, { headers: authHeaders() });
  return response.data;
}

export async function resolveIncident(id, notes) {
  const response = await axios.put(
    `${BASE}/${id}/resolve`,
    { resolution_notes: notes },
    { headers: authHeaders() }
  );
  return response.data;
}