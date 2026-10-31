import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { Dialog } from "../components/ui/Dialog";
import { useDismiss } from "./useDismiss";

function Popover({ open, onClose, escape }: { open: boolean; onClose: () => void; escape?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const dismiss = useDismiss(ref, onClose, open, { escape });
  return (
    <div>
      <div ref={ref} onKeyDown={dismiss.onKeyDown}>
        <button aria-haspopup="dialog" aria-expanded={open}>
          trigger
        </button>
        {open && (
          <div>
            <input aria-label="inside" />
          </div>
        )}
      </div>
      <button>outside</button>
    </div>
  );
}

describe("useDismiss", () => {
  it("closes on a mouse or touch press outside, not inside", () => {
    const onClose = vi.fn();
    render(<Popover open onClose={onClose} />);
    fireEvent.mouseDown(screen.getByLabelText("inside"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(screen.getByText("outside"));
    fireEvent.touchStart(screen.getByText("outside"));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("closes on Escape, but not when it was already handled", () => {
    const onClose = vi.fn();
    render(<Popover open onClose={onClose} />);
    const handled = (e: Event) => e.preventDefault();
    document.addEventListener("keydown", handled, true);
    fireEvent.keyDown(document.body, { key: "Escape" });
    document.removeEventListener("keydown", handled, true);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does nothing while closed, and escape: false leaves Escape alone", () => {
    const closed = vi.fn();
    const a = render(<Popover open={false} onClose={closed} />);
    fireEvent.mouseDown(document.body);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(closed).not.toHaveBeenCalled();
    a.unmount();
    const noEsc = vi.fn();
    render(<Popover open onClose={noEsc} escape={false} />);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(noEsc).not.toHaveBeenCalled();
    fireEvent.mouseDown(document.body);
    expect(noEsc).toHaveBeenCalledTimes(1);
  });

  it("inside a Dialog, Escape on the popover closes only the popover", () => {
    const onClose = vi.fn();
    const onDialogClose = vi.fn();
    render(
      <Dialog open onClose={onDialogClose} ariaLabel="d">
        <Popover open onClose={onClose} />
      </Dialog>,
    );
    fireEvent.keyDown(screen.getByLabelText("inside"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onDialogClose).not.toHaveBeenCalled();
    // The trigger carries aria-haspopup + aria-expanded, so the Dialog leaves it too.
    fireEvent.keyDown(screen.getByText("trigger"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onDialogClose).not.toHaveBeenCalled();
  });
});
