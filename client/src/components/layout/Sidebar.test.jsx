import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import Sidebar from "./Sidebar";

describe("Sidebar Historical Intelligence navigation", () => {
  it("renders the nav item and navigates to the historical page", () => {
    const onNavigate = vi.fn();
    render(<Sidebar activePage="" onNavigate={onNavigate} userRole="Operator" />);

    const item = screen.getByText("Historical Intelligence");
    expect(item).toBeInTheDocument();

    fireEvent.click(item);
    expect(onNavigate).toHaveBeenCalledWith("historical");
  });

  it("marks the item active when the historical page is selected", () => {
    const onNavigate = vi.fn();
    render(<Sidebar activePage="historical" onNavigate={onNavigate} userRole="Operator" />);

    const item = screen.getByText("Historical Intelligence");
    expect(item.parentElement).toHaveClass("active");
  });
});

describe("Sidebar Operator Audit navigation", () => {
  it("hides the admin-only item from non-admin operators", () => {
    render(<Sidebar activePage="" onNavigate={vi.fn()} userRole="Operator" />);
    expect(screen.queryByText("Operator Audit")).not.toBeInTheDocument();
  });

  it("renders the item for admins and navigates to the operator audit page", () => {
    const onNavigate = vi.fn();
    render(<Sidebar activePage="" onNavigate={onNavigate} userRole="Admin" />);

    const item = screen.getByText("Operator Audit");
    expect(item).toBeInTheDocument();

    fireEvent.click(item);
    expect(onNavigate).toHaveBeenCalledWith("operatoraudit");
  });

  it("marks the item active when the operator audit page is selected", () => {
    render(<Sidebar activePage="operatoraudit" onNavigate={vi.fn()} userRole="Admin" />);
    expect(screen.getByText("Operator Audit").parentElement).toHaveClass("active");
  });
});