import axios from "axios";
import { API_URL } from "./api";

const BASE = `${API_URL}/predictions/weather-correlation`;

export async function getWeatherCorrelation() {
  const response = await axios.get(BASE);
  return response.data;
}

export async function getWeatherCorrelationSummary() {
  const response = await axios.get(`${BASE}/summary`);
  return response.data;
}

export async function getWeatherCorrelationSignals() {
  const response = await axios.get(`${BASE}/signals`);
  return response.data;
}

export async function getWeatherCorrelationTrends(params = {}) {
  const response = await axios.get(`${BASE}/trends`, { params });
  return response.data;
}

export async function getWeatherCorrelationDrains(params = {}) {
  const response = await axios.get(`${BASE}/drains`, { params });
  return response.data;
}

export async function getDrainWeatherCorrelation(drainId, params = {}) {
  const response = await axios.get(`${BASE}/drain/${encodeURIComponent(drainId)}`, { params });
  return response.data;
}

export async function getWeatherCorrelationSignal(signal, params = {}) {
  const response = await axios.get(`${BASE}/${encodeURIComponent(signal)}`, { params });
  return response.data;
}