import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("../services/operatorAuditService", () => ({
  getOperatorAudits: vi.fn(),
  getOperatorAuditSummary: vi.fn()
}));

import OperatorAuditPage from "./OperatorAuditPage";
import {
  getOperatorAudits,
  getOperatorAuditSummary
} from "../services/operatorAuditService";

function makeSummary(overrides = {}) {
  return {
    summary: {
      total: 0,
      oldest: null,
      newest: null,
      byAction: {},
      byEntityType: {},
      byOperator: {},
      ...overrides
    }
  };
}

function makeAudit(overrides = {}) {
  return {
    id: 1,
    createdAt: "2026-01-02T03:04:05.000Z",
    userEmail: "admin@aidrain.com",
    action: "USER_CREATE",
    entityType: "USER",
    entityId: 7,
    method: "POST",
    status: 201,
    requestId: "req-1",
    route: "/api/auth/register",
    beforeData: null,
    afterData: { id: 7, email: "new@aidrain.com", role: "Operator" },
    metaData: null,
    ...overrides
  };
}

function resetMocks() {
  getOperatorAuditSummary.mockResolvedValue(makeSummary());
  getOperatorAudits.mockResolvedValue({ audits: [] });
}

describe("OperatorAuditPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMocks();
  });

  it("renders the empty state once loaded", async () => {
    render(<OperatorAuditPage />);
    await waitFor(() =>
      expect(screen.getByText(/No operator actions recorded yet/)).toBeInTheDocument()
    );
    expect(screen.getByText(/Operator Action Audit Trail/)).toBeInTheDocument();
  });

  it("shows an error banner when the list request fails", async () => {
    getOperatorAudits.mockRejectedValue({
      response: { data: { error: "Forbidden" } }
    });
    render(<OperatorAuditPage />);
    await waitFor(() =>
      expect(screen.getByText("Forbidden")).toBeInTheDocument()
    );
  });

  it("renders the summary totals and top operators", async () => {
    getOperatorAuditSummary.mockResolvedValue(
      makeSummary({ total: 3, byOperator: { "admin@aidrain.com": 3 } })
    );
    render(<OperatorAuditPage />);
    await waitFor(() => expect(screen.getByText("3")).toBeInTheDocument());
    expect(screen.getByText("admin@aidrain.com (3)")).toBeInTheDocument();
  });

  it("renders an audit row and expands it to show before/after", async () => {
    getOperatorAudits.mockResolvedValue({ audits: [makeAudit()] });
    render(<OperatorAuditPage />);

    await waitFor(() =>
      expect(screen.getByText("admin@aidrain.com")).toBeInTheDocument()
    );
    fireEvent.click(screen.getByText("admin@aidrain.com"));

    await waitFor(() =>
      expect(screen.getByText("Before")).toBeInTheDocument()
    );
    expect(screen.getByText(/new@aidrain.com/)).toBeInTheDocument();
    expect(screen.getByText(/req-1/)).toBeInTheDocument();
  });

  it("never renders sensitive values, even if the payload is unredacted", async () => {
    getOperatorAudits.mockResolvedValue({
      audits: [
        makeAudit({
          action: "PASSWORD_CHANGE",
          afterData: { password: "super-secret", apiToken: "abc123" },
          metaData: { new_password: "super-secret" }
        })
      ]
    });
    render(<OperatorAuditPage />);

    await waitFor(() =>
      expect(screen.getByText("admin@aidrain.com")).toBeInTheDocument()
    );
    fireEvent.click(screen.getByText("admin@aidrain.com"));

    await waitFor(() =>
      expect(screen.getAllByText(/\[REDACTED\]/).length).toBeGreaterThan(0)
    );
    expect(screen.queryByText(/super-secret/)).not.toBeInTheDocument();
    expect(screen.queryByText(/abc123/)).not.toBeInTheDocument();
  });

  it("applies the action filter on Apply", async () => {
    render(<OperatorAuditPage />);
    await waitFor(() => expect(getOperatorAudits).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getAllByRole("combobox")[0], {
      target: { value: "USER_CREATE" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() =>
      expect(getOperatorAudits).toHaveBeenLastCalledWith(
        expect.objectContaining({ action: "USER_CREATE", page: 1 })
      )
    );
  });

  it("shows pagination controls and pages forward when more than 20 rows exist", async () => {
    getOperatorAuditSummary.mockResolvedValue(makeSummary({ total: 45 }));
    render(<OperatorAuditPage />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Next" })).toBeInTheDocument()
    );

    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    await waitFor(() =>
      expect(getOperatorAudits).toHaveBeenLastCalledWith(
        expect.objectContaining({ page: 2 })
      )
    );
  });

  it("reloads the list and summary on Refresh", async () => {
    render(<OperatorAuditPage />);
    await waitFor(() => expect(getOperatorAudits).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: /Refresh/i }));

    await waitFor(() => expect(getOperatorAudits).toHaveBeenCalledTimes(2));
    expect(getOperatorAuditSummary).toHaveBeenCalledTimes(2);
  });
});
