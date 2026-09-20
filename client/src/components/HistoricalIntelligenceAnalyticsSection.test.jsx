import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("../services/historicalIntelligenceService", () => {
  const fns = {
    getHistoricalAnalytics: vi.fn()
  };
  return {
    HISTORICAL_PERIODS: ["24h", "7d", "30d", "90d"],
    HISTORICAL_DEFAULT_PERIOD: "30d",
    ...fns
  };
});

import HistoricalIntelligenceAnalyticsSection from "./HistoricalIntelligenceAnalyticsSection";
import { getHistoricalAnalytics } from "../services/historicalIntelligenceService";

function makeOverview(overrides = {}) {
  return {
    period: "30d",
    record_count: 7,
    status: "OK",
    sensors: { reading_count: 40, sensor_count: 5, status: "OK" },
    incidents: { total: 3, resolved: 2, status: "OK" },
    missions: { total: 6, status: "OK" },
    alerts: { total: 1, unresolved: 0, status: "OK" },
    drain_health: { drain_count: 8, degraded_or_critical: 1, by_status: {} },
    data_quality: {
      label: "PARTIAL",
      sufficient_data: true,
      record_count: 7,
      coverage_ratio: 0.5
    },
    comparison: {
      incident_comparison: {
        current_period: 3,
        previous_period: 1,
        direction: "INCREASE"
      }
    },
    disclaimer: "analytics section disclaimer",
    ...overrides
  };
}

describe("HistoricalIntelligenceAnalyticsSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getHistoricalAnalytics.mockResolvedValue(makeOverview());
  });

  it("renders the analytics historical overview and the navigation link", async () => {
    const onOpen = vi.fn();
    render(<HistoricalIntelligenceAnalyticsSection onOpen={onOpen} />);

    await waitFor(() => expect(screen.getByText("Total records")).toBeInTheDocument());
    expect(screen.getByText("40")).toBeInTheDocument();
    expect(screen.getByText(/Incident comparison/)).toBeInTheDocument();
    expect(screen.getByText(/analytics section disclaimer/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /View Historical Intelligence/i }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("refetches when the period changes", async () => {
    render(<HistoricalIntelligenceAnalyticsSection onOpen={() => {}} />);

    await waitFor(() =>
      expect(getHistoricalAnalytics).toHaveBeenCalledWith({ period: "30d" })
    );

    fireEvent.change(screen.getByLabelText("Historical analytics period"), {
      target: { value: "90d" }
    });

    await waitFor(() =>
      expect(getHistoricalAnalytics).toHaveBeenLastCalledWith({ period: "90d" })
    );
  });

  it("shows the insufficient-data notice and handles errors", async () => {
    getHistoricalAnalytics.mockResolvedValue(
      makeOverview({
        status: "INSUFFICIENT_DATA",
        data_quality: {
          label: "INSUFFICIENT_DATA",
          sufficient_data: false,
          record_count: 0,
          coverage_ratio: 0
        }
      })
    );

    const { unmount } = render(<HistoricalIntelligenceAnalyticsSection onOpen={() => {}} />);

    await waitFor(() =>
      expect(screen.getByText(/No recorded data in this window/)).toBeInTheDocument()
    );
    unmount();

    getHistoricalAnalytics.mockRejectedValue(new Error("down"));
    render(<HistoricalIntelligenceAnalyticsSection onOpen={() => {}} />);

    await waitFor(() =>
      expect(screen.getByText(/Historical analytics unavailable/)).toBeInTheDocument()
    );
  });
});