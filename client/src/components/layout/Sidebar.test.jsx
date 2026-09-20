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