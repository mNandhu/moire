import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Button } from "./Button";
import { DialogFooter } from "./Dialog";

describe("Button pending", () => {
  it("disables the button and marks it busy", () => {
    const onClick = vi.fn();
    render(
      <Button pending onClick={onClick}>
        Go
      </Button>,
    );
    const b = screen.getByRole("button", { name: "Go" }) as HTMLButtonElement;
    expect(b.disabled).toBe(true);
    expect(b.getAttribute("aria-busy")).toBe("true");
    fireEvent.click(b);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("is plain when not pending", () => {
    render(<Button>Go</Button>);
    const b = screen.getByRole("button", { name: "Go" }) as HTMLButtonElement;
    expect(b.disabled).toBe(false);
    expect(b.hasAttribute("aria-busy")).toBe(false);
  });
});

describe("DialogFooter", () => {
  it("cancels and confirms", () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(<DialogFooter onCancel={onCancel} onConfirm={onConfirm} confirmLabel="Create outfit" start={<span>3 tags</span>} />);
    expect(screen.getByText("3 tags")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Create outfit" }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("holds the confirm button while pending or disabled", () => {
    const { rerender } = render(<DialogFooter onCancel={() => undefined} onConfirm={() => undefined} pending />);
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    rerender(<DialogFooter onCancel={() => undefined} onConfirm={() => undefined} disabled />);
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
