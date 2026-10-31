import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
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

  it("leaves an Escape a control claimed to that control, with no popup markup", () => {
    const onClose = vi.fn();
    const own = vi.fn();
    render(
      <Dialog open onClose={onClose} title="Edit">
        <input
          aria-label="Name"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              own();
            }
          }}
        />
        <button>Other</button>
      </Dialog>,
    );
    fireEvent.keyDown(screen.getByLabelText("Name"), { key: "Escape" });
    expect(own).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("button", { name: "Other" }), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape when focus fell outside the panel", () => {
    const onClose = vi.fn();
    render(<Dialog open onClose={onClose} title="Edit"><button>Ok</button></Dialog>);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes only a confirm opened over a dialog", () => {
    const outer = vi.fn();
    const inner = vi.fn();
    function Stacked() {
      const [confirming, setConfirming] = useState(false);
      return (
        <Dialog open onClose={outer} title="Outer">
          <button onClick={() => setConfirming(true)}>Delete</button>
          <Dialog open={confirming} onClose={inner} title="Sure?" labelledBy="inner-title">
            <button>Inner button</button>
          </Dialog>
        </Dialog>
      );
    }
    render(<Stacked />);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.keyDown(screen.getByRole("button", { name: "Inner button" }), { key: "Escape" });
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(inner).toHaveBeenCalledTimes(2);
    expect(outer).not.toHaveBeenCalled();
  });
});

describe("DropdownMenu Escape", () => {
  it("closes once outside a dialog and keeps the key from the page", () => {
    const page = vi.fn();
    window.addEventListener("keydown", page);
    render(<DropdownMenu label="More" items={[{ label: "Do it", onClick: () => {} }]} />);
    fireEvent.click(screen.getByRole("button", { name: /More/ }));
    fireEvent.keyDown(screen.getByRole("menuitem"), { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /More/ }));
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    window.removeEventListener("keydown", page);
    expect(page).not.toHaveBeenCalled();
  });
});
