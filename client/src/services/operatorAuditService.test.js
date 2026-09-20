import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("axios", () => ({ default: { get: vi.fn() } }));

import axios from "axios";
import {
  getOperatorAudits,
  getOperatorAuditSummary,
  getOperatorAuditActions,
  getOperatorAuditById
} from "./operatorAuditService";

const BASE = "http://localhost:5000/api/audit/operator";

describe("operatorAuditService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    axios.get.mockResolvedValue({ data: { ok: true } });
  });

  it("fetches the audit list with forwarded params and no auth header when signed out", async () => {
    const result = await getOperatorAudits({ page: 2, limit: 20, action: "USER_CREATE" });
    expect(axios.get).toHaveBeenCalledWith(BASE, {
      params: { page: 2, limit: 20, action: "USER_CREATE" },
      headers: {}
    });
    expect(result).toEqual({ ok: true });
  });

  it("attaches a bearer header when a token is present", async () => {
    localStorage.setItem("token", "test-token");
    await getOperatorAudits({ page: 1 });
    expect(axios.get).toHaveBeenCalledWith(BASE, {
      params: { page: 1 },
      headers: { Authorization: "Bearer test-token" }
    });
  });

  it("fetches the summary from /summary", async () => {
    await getOperatorAuditSummary();
    expect(axios.get).toHaveBeenCalledWith(`${BASE}/summary`, { headers: {} });
  });

  it("fetches the known actions from /actions", async () => {
    await getOperatorAuditActions();
    expect(axios.get).toHaveBeenCalledWith(`${BASE}/actions`, { headers: {} });
  });

  it("fetches a single audit and encodes the id", async () => {
    await getOperatorAuditById(42);
    expect(axios.get).toHaveBeenCalledWith(`${BASE}/42`, { headers: {} });
  });
});
