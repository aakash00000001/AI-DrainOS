import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("axios", () => ({ default: { get: vi.fn() } }));

import axios from "axios";
import {
  HISTORICAL_PERIODS,
  HISTORICAL_DEFAULT_PERIOD,
  getHistoricalOverview,
  getHistoricalSummary,
  getHistoricalSensorHistory,
  getHistoricalTrends,
  getHistoricalDrains,
  getHistoricalIncidents,
  getHistoricalMissions,
  getHistoricalRobots,
  getHistoricalAlerts,
  getHistoricalPatterns,
  getHistoricalComparison,
  getHistoricalAnalytics,
  getDrainList,
  getDashboardHistoricalSummary
} from "./historicalIntelligenceService";

describe("historicalIntelligenceService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    axios.get.mockResolvedValue({ data: { ok: true } });
  });

  it("exposes the documented period constants", () => {
    expect(HISTORICAL_PERIODS).toEqual(["24h", "7d", "30d", "90d"]);
    expect(HISTORICAL_DEFAULT_PERIOD).toBe("30d");
  });

  it("fetches the full overview with forwarded params", async () => {
    const result = await getHistoricalOverview({ period: "7d", drainId: 5 });
    expect(axios.get).toHaveBeenCalledWith("http://localhost:5000/api/historical", {
      params: { period: "7d", drainId: 5 }
    });
    expect(result).toEqual({ ok: true });
  });

  it("forwards raw params unchanged (including window alias)", async () => {
    await getHistoricalSummary({ window: "90d" });
    expect(axios.get).toHaveBeenCalledWith(
      "http://localhost:5000/api/historical/summary",
      { params: { window: "90d" } }
    );
  });

  const endpoints = [
    ["getHistoricalSensorHistory", getHistoricalSensorHistory, "/sensors"],
    ["getHistoricalTrends", getHistoricalTrends, "/trends"],
    ["getHistoricalDrains", getHistoricalDrains, "/drains"],
    ["getHistoricalIncidents", getHistoricalIncidents, "/incidents"],
    ["getHistoricalMissions", getHistoricalMissions, "/missions"],
    ["getHistoricalRobots", getHistoricalRobots, "/robots"],
    ["getHistoricalAlerts", getHistoricalAlerts, "/alerts"],
    ["getHistoricalPatterns", getHistoricalPatterns, "/patterns"],
    ["getHistoricalComparison", getHistoricalComparison, "/comparison"]
  ];

  for (const [name, fn, path] of endpoints) {
    it(`${name} hits ${path} and returns response.data`, async () => {
      axios.get.mockResolvedValue({ data: { path } });
      const result = await fn({ period: "24h" });
      expect(axios.get).toHaveBeenCalledWith(
        `http://localhost:5000/api/historical${path}`,
        { params: { period: "24h" } }
      );
      expect(result).toEqual({ path });
    });
  }

  it("getHistoricalAnalytics uses the analytics historical endpoint", async () => {
    const result = await getHistoricalAnalytics({ period: "7d" });
    expect(axios.get).toHaveBeenCalledWith(
      "http://localhost:5000/api/analytics/historical",
      { params: { period: "7d" } }
    );
    expect(result).toEqual({ ok: true });
  });

  it("getDrainList fetches /api/drains", async () => {
    axios.get.mockResolvedValue({ data: [{ id: 1 }] });
    const result = await getDrainList();
    expect(axios.get).toHaveBeenCalledWith("http://localhost:5000/api/drains");
    expect(result).toEqual([{ id: 1 }]);
  });

  it("getDashboardHistoricalSummary unwraps historicalSummary from /api/dashboard", async () => {
    axios.get.mockResolvedValue({
      data: { historicalSummary: { historicalIncidentCount: 3 } }
    });
    const result = await getDashboardHistoricalSummary();
    expect(axios.get).toHaveBeenCalledWith("http://localhost:5000/api/dashboard");
    expect(result).toEqual({ historicalIncidentCount: 3 });
  });

  it("getDashboardHistoricalSummary tolerates a missing historicalSummary field", async () => {
    axios.get.mockResolvedValue({ data: { totalDrains: 4 } });
    expect(await getDashboardHistoricalSummary()).toBeNull();
  });
});