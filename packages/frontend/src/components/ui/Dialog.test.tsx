import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Dialog } from "./Dialog";
import { DropdownMenu } from "./DropdownMenu";
import { Picker } from "./Picker";

const options = [
  { value: "a", label: "Alpha" },
  { value: "b", label: "Beta" },
];

describe("Dialog Escape", () => {
  it("closes only an open Picker list first, then the dialog", () => {
    const onClose = vi.fn();
    render(
      <Dialog open onClose={onClose} title="Edit">
        <Picker aria-label="Kind" value="a" options={options} onChange={() => {}} />
      </Dialog>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Kind" }));
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("button", { name: "Kind" }), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes only an open DropdownMenu first, then the dialog", () => {
    const onClose = vi.fn();
    render(
      <Dialog open onClose={onClose} title="Edit">
        <DropdownMenu label="More" items={[{ label: "Do it", onClick: () => {} }]} />
      </Dialog>,
    );
    fireEvent.click(screen.getByRole("button", { name: /More/ }));
    fireEvent.keyDown(screen.getByRole("menuitem"), { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("button", { name: /More/ }), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
