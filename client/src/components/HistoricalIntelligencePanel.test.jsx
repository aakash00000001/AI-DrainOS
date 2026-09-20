import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("../services/historicalIntelligenceService", async () => {
  const actual = await vi.importActual("../services/historicalIntelligenceService");
  return {
    ...actual,
    getDashboardHistoricalSummary: vi.fn()
  };
});

import HistoricalIntelligencePanel from "./HistoricalIntelligencePanel";
import { getDashboardHistoricalSummary } from "../services/historicalIntelligenceService";

describe("HistoricalIntelligencePanel (dashboard preview)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getDashboardHistoricalSummary.mockResolvedValue({
      period: "30d",
      historicalIncidentCount: 4,
      recurrentDrainCount: 2,
      degradedDrainCount: 1,
      historicalDataQuality: "PARTIAL",
      recentHistoricalTrend: "RISING",
      topRecurringDrains: [
        { drain_id: 1, zone: "North", incident_count: 3 },
        { drain_id: 2, zone: "South", incident_count: 2 }
      ]
    });
  });

  it("renders the compact summary and calls onOpen from the console button", async () => {
    const onOpen = vi.fn();
    render(<HistoricalIntelligencePanel onOpen={onOpen} />);

    await waitFor(() => expect(screen.getByText("Historical incidents")).toBeInTheDocument());

    expect(screen.getByText("4")).toBeInTheDocument();
    expect(screen.getByText("Recurrent drains")).toBeInTheDocument();
    expect(screen.getByText("PARTIAL")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Historical Console/i }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("shows an explicit insufficient-data message when quality is INSUFFICIENT_DATA", async () => {
    getDashboardHistoricalSummary.mockResolvedValue({
      period: "30d",
      historicalIncidentCount: 0,
      recurrentDrainCount: 0,
      degradedDrainCount: 0,
      historicalDataQuality: "INSUFFICIENT_DATA",
      recentHistoricalTrend: "INSUFFICIENT_DATA",
      topRecurringDrains: []
    });

    render(<HistoricalIntelligencePanel onOpen={() => {}} />);

    await waitFor(() =>
      expect(screen.getByText(/Not enough recorded data in this window/)).toBeInTheDocument()
    );
  });

  it("handles a backend failure gracefully", async () => {
    getDashboardHistoricalSummary.mockRejectedValue(new Error("down"));

    render(<HistoricalIntelligencePanel onOpen={() => {}} />);

    await waitFor(() =>
      expect(screen.getByText("Historical intelligence unavailable")).toBeInTheDocument()
    );
  });
});