import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("../services/historicalIntelligenceService", () => {
  const fns = {
    getHistoricalOverview: vi.fn(),
    getHistoricalSensorHistory: vi.fn(),
    getHistoricalDrains: vi.fn(),
    getHistoricalIncidents: vi.fn(),
    getHistoricalMissions: vi.fn(),
    getHistoricalRobots: vi.fn(),
    getHistoricalAlerts: vi.fn(),
    getHistoricalPatterns: vi.fn(),
    getHistoricalComparison: vi.fn(),
    getDrainList: vi.fn()
  };
  return {
    HISTORICAL_PERIODS: ["24h", "7d", "30d", "90d"],
    HISTORICAL_DEFAULT_PERIOD: "30d",
    ...fns
  };
});

import HistoricalIntelligencePage from "./HistoricalIntelligencePage";
import {
  getHistoricalOverview,
  getHistoricalSensorHistory,
  getHistoricalDrains,
  getHistoricalIncidents,
  getHistoricalMissions,
  getHistoricalRobots,
  getHistoricalAlerts,
  getHistoricalPatterns,
  getHistoricalComparison,
  getDrainList
} from "../services/historicalIntelligenceService";

const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday"
];

function makeOverview(overrides = {}) {
  return {
    period: "30d",
    record_count: 0,
    status: "INSUFFICIENT_DATA",
    sensors: { reading_count: 0, sensor_count: 0, status: "INSUFFICIENT_DATA" },
    incidents: { total: 0, active: 0, resolved: 0, status: "INSUFFICIENT_DATA" },
    missions: { total: 0, status: "INSUFFICIENT_DATA" },
    alerts: { total: 0, unresolved: 0, status: "INSUFFICIENT_DATA" },
    drain_health: { drain_count: 0, degraded_or_critical: 0, by_status: {} },
    data_quality: {
      label: "INSUFFICIENT_DATA",
      sufficient_data: false,
      record_count: 0,
      coverage_ratio: 0,
      earliest_timestamp: null,
      latest_timestamp: null,
      missing_signals: []
    },
    disclaimer: "test disclaimer",
    ...overrides
  };
}

function makeSensors(overrides = {}) {
  return {
    period: "30d",
    status: "INSUFFICIENT_DATA",
    sensor_count: 0,
    reading_count: 0,
    sensors: [],
    data_quality: { label: "INSUFFICIENT_DATA" },
    ...overrides
  };
}

function makeDrains(overrides = {}) {
  return {
    period: "30d",
    status: "INSUFFICIENT_DATA",
    drain_count: 0,
    drains: [],
    ...overrides
  };
}

function makeIncidents(overrides = {}) {
  return {
    period: "30d",
    status: "INSUFFICIENT_DATA",
    total: 0,
    active: 0,
    resolved: 0,
    by_severity: { LOW: 0, MODERATE: 0, HIGH: 0, CRITICAL: 0 },
    by_source: { AI_DECISION: 0 },
    over_time: [],
    by_drain: [],
    average_response_minutes: null,
    average_resolution_minutes: null,
    data_points: { with_response: 0 },
    disclaimer: "incidents disclaimer",
    ...overrides
  };
}

function makeMissions(overrides = {}) {
  return {
    period: "30d",
    total: 0,
    completion_rate: null,
    by_status: {},
    by_drain: [],
    disclaimer: "missions disclaimer",
    ...overrides
  };
}

function makeRobots(overrides = {}) {
  return {
    period: "30d",
    robot_count: 0,
    robots: [],
    average_mission_duration_seconds: null,
    response_time_available: false,
    ...overrides
  };
}

function makeAlerts(overrides = {}) {
  return {
    period: "30d",
    status: "INSUFFICIENT_DATA",
    total: 0,
    resolved: 0,
    unresolved: 0,
    critical: 0,
    by_type: [],
    over_time: [],
    disclaimer: "alerts disclaimer",
    ...overrides
  };
}

function makePatterns(overrides = {}) {
  return {
    period: "30d",
    status: "INSUFFICIENT_DATA",
    incidents: {
      total: 0,
      hourly_distribution: [],
      weekday_distribution: [],
      peak_incident_day: null,
      peak_incident_hour: null,
      summary: null
    },
    alerts: {
      total: 0,
      hourly_distribution: [],
      weekday_distribution: [],
      peak_alert_day: null,
      peak_alert_hour: null,
      summary: null
    },
    weekday_names: WEEKDAY_NAMES,
    disclaimer: "patterns disclaimer",
    ...overrides
  };
}

function makeComparison(overrides = {}) {
  return {
    period: "30d",
    status: "INSUFFICIENT_DATA",
    incident_comparison: {
      current_period: 0,
      previous_period: 0,
      change: 0,
      direction: "NO_CHANGE",
      note: "comparison note",
      previous_period_start: null,
      previous_period_end: null
    },
    sensor_comparison: [],
    note: "comparison note 2",
    disclaimer: "comparison disclaimer",
    ...overrides
  };
}

function resetServiceMocks() {
  getHistoricalOverview.mockResolvedValue(makeOverview());
  getHistoricalSensorHistory.mockResolvedValue(makeSensors());
  getHistoricalDrains.mockResolvedValue(makeDrains());
  getHistoricalIncidents.mockResolvedValue(makeIncidents());
  getHistoricalMissions.mockResolvedValue(makeMissions());
  getHistoricalRobots.mockResolvedValue(makeRobots());
  getHistoricalAlerts.mockResolvedValue(makeAlerts());
  getHistoricalPatterns.mockResolvedValue(makePatterns());
  getHistoricalComparison.mockResolvedValue(makeComparison());
  getDrainList.mockResolvedValue([{ id: 5, zone_name: "Center", location: "Downtown" }]);
}

describe("HistoricalIntelligencePage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetServiceMocks();
  });

  it("renders a loading state while the overview is pending", () => {
    getHistoricalOverview.mockReturnValue(new Promise(() => {}));
    render(<HistoricalIntelligencePage />);
    expect(screen.getByText(/Loading historical data…/)).toBeInTheDocument();
  });

  it("shows an error banner when the historical requests fail", async () => {
    getHistoricalOverview.mockRejectedValue(new Error("boom"));
    getHistoricalSensorHistory.mockRejectedValue(new Error("boom"));
    getHistoricalDrains.mockRejectedValue(new Error("boom"));
    getHistoricalIncidents.mockRejectedValue(new Error("boom"));
    getHistoricalMissions.mockRejectedValue(new Error("boom"));
    getHistoricalRobots.mockRejectedValue(new Error("boom"));
    getHistoricalAlerts.mockRejectedValue(new Error("boom"));
    getHistoricalPatterns.mockRejectedValue(new Error("boom"));
    getHistoricalComparison.mockRejectedValue(new Error("boom"));

    render(<HistoricalIntelligencePage />);

    await waitFor(() =>
      expect(screen.getByText(/Some historical data is unavailable/)).toBeInTheDocument()
    );
  });

  it("surfaces the INSUFFICIENT_DATA banner and empty tables", async () => {
    render(<HistoricalIntelligencePage />);

    await waitFor(() =>
      expect(screen.getByText(/No recorded data found in the selected window/)).toBeInTheDocument()
    );
    expect(screen.getByText(/No sensor readings recorded in this window/)).toBeInTheDocument();
    expect(screen.getByText(/test disclaimer/)).toBeInTheDocument();
  });

  it("refetches everything when the period is changed", async () => {
    render(<HistoricalIntelligencePage />);

    await waitFor(() =>
      expect(getHistoricalOverview).toHaveBeenCalledWith({ period: "30d" })
    );

    fireEvent.change(screen.getByLabelText("Historical period"), {
      target: { value: "7d" }
    });

    await waitFor(() =>
      expect(getHistoricalOverview).toHaveBeenLastCalledWith({ period: "7d" })
    );
  });

  it("applies the drain filter option", async () => {
    render(<HistoricalIntelligencePage />);

    await waitFor(() =>
      expect(getHistoricalOverview).toHaveBeenCalledWith({ period: "30d" })
    );

    fireEvent.change(screen.getByLabelText("Drain filter"), {
      target: { value: "5" }
    });

    await waitFor(() =>
      expect(getHistoricalOverview).toHaveBeenLastCalledWith({ period: "30d", drainId: "5" })
    );
  });

  it("renders the period-comparison section when data is present", async () => {
    getHistoricalOverview.mockResolvedValue(
      makeOverview({ status: "OK", record_count: 5 })
    );
    getHistoricalComparison.mockResolvedValue(
      makeComparison({
        status: "OK",
        incident_comparison: {
          current_period: 5,
          previous_period: 2,
          change: 3,
          direction: "INCREASE",
          note: "comparison note"
        },
        sensor_comparison: [
          {
            metric: "water_level",
            current_value: 40,
            historical_average: 30,
            change: 10,
            direction: "INCREASE",
            status: "OK"
          }
        ]
      })
    );

    render(<HistoricalIntelligencePage />);

    await waitFor(() =>
      expect(screen.getByText(/Period Comparison/)).toBeInTheDocument()
    );
    expect(screen.getByText("Incidents · current")).toBeInTheDocument();
    expect(screen.getByText(/water_level/)).toBeInTheDocument();
    expect(screen.getByText("INCREASE")).toBeInTheDocument();
  });

  it("reloads when the Refresh button is clicked", async () => {
    render(<HistoricalIntelligencePage />);

    await waitFor(() =>
      expect(getHistoricalOverview).toHaveBeenCalledTimes(1)
    );

    fireEvent.click(screen.getByRole("button", { name: /Refresh/i }));

    await waitFor(() =>
      expect(getHistoricalOverview).toHaveBeenCalledTimes(2)
    );
  });

  it("lists the registered drains in the filter and uses realistic selection", async () => {
    render(<HistoricalIntelligencePage />);

    await waitFor(() =>
      expect(screen.getByText(/Drain 5: Center \(Downtown\)/)).toBeInTheDocument()
    );
  });
});