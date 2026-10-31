import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { NumberStepper } from "./fields";

describe("NumberStepper", () => {
  it("keeps a typed value clamped into range, and shows the kept one on leaving", () => {
    const onChange = vi.fn();
    const { rerender } = render(<NumberStepper label="Images" value={4} onChange={onChange} step={1} min={1} max={500} compact />);
    const field = screen.getByRole("spinbutton", { name: "Images" });
    fireEvent.change(field, { target: { value: "600" } });
    expect(onChange).toHaveBeenLastCalledWith(500);
    fireEvent.change(field, { target: { value: "0" } });
    expect(onChange).toHaveBeenLastCalledWith(1);
    onChange.mockClear();
    fireEvent.change(field, { target: { value: "" } });
    expect(onChange).not.toHaveBeenCalled();
    rerender(<NumberStepper label="Images" value={1} onChange={onChange} step={1} min={1} max={500} compact />);
    fireEvent.blur(field);
    expect(field).toHaveValue(1);
  });

  it("names its buttons Fewer for whole steps and Less for fractions", () => {
    render(<NumberStepper label="Steps" value={20} onChange={() => {}} step={1} min={1} max={150} />);
    render(<NumberStepper label="CFG" value={7} onChange={() => {}} step={0.5} min={1} max={30} hideLabel />);
    expect(screen.getByRole("button", { name: "Fewer Steps" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Less CFG" })).toBeTruthy();
    expect(screen.queryByText("CFG")).toBeNull();
  });

  it("goes on stepping with the arrows once - or + has focus", () => {
    const onChange = vi.fn();
    render(<NumberStepper label="Strength" value={0.7} onChange={onChange} step={0.05} min={-2} max={2} small hideLabel />);
    const more = screen.getByRole("button", { name: "More Strength" });
    fireEvent.keyDown(more, { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith(0.75);
    fireEvent.keyDown(more, { key: "ArrowLeft" });
    expect(onChange).toHaveBeenLastCalledWith(0.65);
    onChange.mockClear();
    fireEvent.keyDown(screen.getByRole("spinbutton", { name: "Strength" }), { key: "ArrowRight" });
    expect(onChange).not.toHaveBeenCalled();
  });
});
