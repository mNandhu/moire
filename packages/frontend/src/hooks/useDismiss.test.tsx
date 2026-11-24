import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Dialog } from "@/components/ui/Dialog";
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

  it("keeps open on a press that removed what it pressed (a picked option)", () => {
    const onClose = vi.fn();
    function Panel() {
      const ref = useRef<HTMLDivElement>(null);
      const [listOpen, setListOpen] = useState(true);
      useDismiss(ref, onClose, true);
      return (
        <div ref={ref}>
          {listOpen && (
            <button onMouseDown={() => flushSync(() => setListOpen(false))}>option</button>
          )}
        </div>
      );
    }
    render(<Panel />);
    fireEvent.mouseDown(screen.getByText("option"));
    expect(screen.queryByText("option")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("still closes on a press outside that removed what it pressed", () => {
    const onClose = vi.fn();
    function Page() {
      const ref = useRef<HTMLDivElement>(null);
      const [chip, setChip] = useState(true);
      useDismiss(ref, onClose, true);
      return (
        <div>
          <div ref={ref}>popover</div>
          {chip && <button onMouseDown={() => flushSync(() => setChip(false))}>chip</button>}
        </div>
      );
    }
    render(<Page />);
    fireEvent.mouseDown(screen.getByText("chip"));
    expect(onClose).toHaveBeenCalledTimes(1);
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
