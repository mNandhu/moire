import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { KeyboardEvent } from "react";
import { useSuggestNav } from "./useSuggestNav";

vi.mock("../lib/queries", () => ({ useBoilerplate: () => () => false }));

const matches = [
  { _id: "a", count: 3 },
  { _id: "b", count: 2 },
  { _id: "c", count: 1 },
];

function key(k: string, extra: object = {}) {
  const e = { key: k, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...extra };
  return e as unknown as KeyboardEvent<HTMLElement> & typeof e;
}

function setup(opts: Partial<Parameters<typeof useSuggestNav>[0]> = {}) {
  const onPick = vi.fn();
  const onClose = vi.fn();
  const hook = renderHook(
    (p: { resetKey: string }) => useSuggestNav({ matches, open: true, onPick, onClose, resetKey: p.resetKey, ...opts }),
    { initialProps: { resetKey: "" } },
  );
  return { ...hook, onPick, onClose };
}

describe("useSuggestNav", () => {
  it("clamps Up/Down and consumes the key", () => {
    const { result } = setup();
    const e = key("ArrowUp");
    let used = false;
    act(() => {
      used = result.current.onKeyDown(e);
    });
    expect(used).toBe(true);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(result.current.active).toBe(0);
    for (let i = 0; i < 5; i++) act(() => void result.current.onKeyDown(key("ArrowDown")));
    expect(result.current.active).toBe(2);
  });

  it("takes the highlighted row on Enter and resets", () => {
    const { result, onPick } = setup();
    act(() => void result.current.onKeyDown(key("ArrowDown")));
    act(() => void result.current.onKeyDown(key("Enter")));
    expect(onPick).toHaveBeenCalledWith(matches[1]);
    expect(result.current.active).toBe(0);
  });

  it("in moved mode leaves a bare Enter to the caller until arrowed", () => {
    const { result, onPick } = setup({ enter: "moved" });
    let used = true;
    act(() => {
      used = result.current.onKeyDown(key("Enter"));
    });
    expect(used).toBe(false);
    expect(onPick).not.toHaveBeenCalled();
    act(() => void result.current.onKeyDown(key("ArrowDown")));
    act(() => void result.current.onKeyDown(key("Enter")));
    expect(onPick).toHaveBeenCalledWith(matches[1]);
  });

  it("ignores Ctrl+Arrow so the field's weight keys keep it", () => {
    const { result } = setup();
    let used = true;
    act(() => {
      used = result.current.onKeyDown(key("ArrowDown", { ctrlKey: true }));
    });
    expect(used).toBe(false);
    expect(result.current.active).toBe(0);
  });

  it("closes on Escape and stops it reaching a surrounding dialog", () => {
    const { result, onClose } = setup();
    const e = key("Escape");
    act(() => void result.current.onKeyDown(e));
    expect(onClose).toHaveBeenCalled();
    expect(e.stopPropagation).toHaveBeenCalled();
  });

  it("takes no key while closed, and resets the highlight when the text changes", () => {
    const closed = setup({ open: false });
    let used = true;
    act(() => {
      used = closed.result.current.onKeyDown(key("Escape"));
    });
    expect(used).toBe(false);
    expect(closed.result.current.ariaProps["aria-expanded"]).toBe(false);

    const { result, rerender } = setup();
    act(() => void result.current.onKeyDown(key("ArrowDown")));
    expect(result.current.active).toBe(1);
    rerender({ resetKey: "x" });
    expect(result.current.active).toBe(0);
    expect(result.current.ariaProps["aria-haspopup"]).toBe("listbox");
  });
});
