import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { InlineRename } from "./InlineRename";

const open = (props: Partial<Parameters<typeof InlineRename>[0]> = {}) => {
  const onCommit = vi.fn();
  render(<InlineRename value="Old" label="batch" onCommit={onCommit} {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Rename batch" }));
  const field = screen.getByRole("textbox", { name: "Batch name" });
  return { onCommit, field };
};

describe("InlineRename", () => {
  it("commits once on Enter, trimmed", () => {
    const { onCommit, field } = open();
    fireEvent.change(field, { target: { value: "  New  " } });
    fireEvent.keyDown(field, { key: "Enter" });
    fireEvent.blur(field);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("New");
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("commits on leaving the field", () => {
    const { onCommit, field } = open();
    fireEvent.change(field, { target: { value: "New" } });
    fireEvent.blur(field);
    expect(onCommit).toHaveBeenCalledWith("New");
  });

  it("drops the edit on Escape", () => {
    const { onCommit, field } = open();
    fireEvent.change(field, { target: { value: "New" } });
    fireEvent.keyDown(field, { key: "Escape" });
    fireEvent.blur(field);
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByText("Old")).toBeTruthy();
  });

  it("resets without committing", () => {
    const onReset = vi.fn();
    const { onCommit } = open({ reset: { label: "Use auto name", onReset } });
    const button = screen.getByRole("button", { name: "Use auto name" });
    fireEvent.mouseDown(button);
    fireEvent.click(button);
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("commits again on a second edit", () => {
    const { onCommit, field } = open();
    fireEvent.keyDown(field, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Rename batch" }));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Batch name" }), { key: "Enter" });
    expect(onCommit).toHaveBeenCalledTimes(2);
  });
});
