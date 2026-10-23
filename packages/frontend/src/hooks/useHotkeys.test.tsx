import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { OverlayOpenContext } from "../lib/backgroundLocation";
import { useHotkeys, type Hotkey, type HotkeyOptions } from "./useHotkeys";

function press(key: string, init: KeyboardEventInit = {}, target: EventTarget = document.body) {
  const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
}

function mount(bindings: Hotkey[], options?: HotkeyOptions, overlay = false) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <OverlayOpenContext.Provider value={overlay}>{children}</OverlayOpenContext.Provider>
  );
  return renderHook(() => useHotkeys(bindings, options), { wrapper });
}

describe("useHotkeys", () => {
  it("runs the first binding that matches by key or by match()", () => {
    const x = vi.fn();
    const digit = vi.fn();
    mount([
      { keys: ["x", "X"], run: x },
      { match: (e) => e.key >= "0" && e.key <= "5", run: digit },
    ]);
    press("X");
    press("3");
    press("9");
    expect(x).toHaveBeenCalledTimes(1);
    expect(digit).toHaveBeenCalledTimes(1);
  });

  it("leaves Ctrl/Cmd/Alt combos alone by default", () => {
    const run = vi.fn();
    mount([{ keys: ["1"], run }]);
    press("1", { ctrlKey: true });
    press("1", { metaKey: true });
    press("1", { altKey: true });
    expect(run).not.toHaveBeenCalled();
  });

  it("mods: ctrl lets Ctrl/Cmd through but never Alt; any lets all through", () => {
    const edge = vi.fn();
    const any = vi.fn();
    mount([
      { keys: ["Home"], mods: "ctrl", run: edge },
      { keys: ["k"], mods: "any", run: any },
    ]);
    press("Home", { ctrlKey: true });
    press("Home", { metaKey: true });
    press("Home", { altKey: true });
    expect(edge).toHaveBeenCalledTimes(2);
    press("k", { altKey: true });
    expect(any).toHaveBeenCalledTimes(1);
  });

  it("ignores keys typed into a form field unless fields is set", () => {
    const run = vi.fn();
    const input = document.createElement("input");
    document.body.appendChild(input);
    const a = mount([{ keys: ["s"], run }]);
    press("s", {}, input);
    expect(run).not.toHaveBeenCalled();
    a.unmount();
    mount([{ keys: ["s"], run }], { fields: true });
    press("s", {}, input);
    expect(run).toHaveBeenCalledTimes(1);
    input.remove();
  });

  it("goes quiet while an image overlay is open, unless overlay is ignore", () => {
    const run = vi.fn();
    const a = mount([{ keys: ["s"], run }], {}, true);
    press("s");
    expect(run).not.toHaveBeenCalled();
    a.unmount();
    mount([{ keys: ["s"], run }], { overlay: "ignore" }, true);
    press("s");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("skipHandled drops an event someone already prevented", () => {
    const run = vi.fn();
    mount([{ keys: ["Escape"], mods: "any", run }], { skipHandled: true });
    const stop = (e: Event) => e.preventDefault();
    window.addEventListener("keydown", stop, true);
    press("Escape");
    window.removeEventListener("keydown", stop, true);
    expect(run).not.toHaveBeenCalled();
    press("Escape");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("enabled false detaches the listener, and cleanup removes it", () => {
    const run = vi.fn();
    const off = mount([{ keys: ["s"], run }], { enabled: false });
    press("s");
    expect(run).not.toHaveBeenCalled();
    off.unmount();
    const on = mount([{ keys: ["s"], run }]);
    on.unmount();
    press("s");
    expect(run).not.toHaveBeenCalled();
  });

  it("capture mode runs ahead of a bubble listener and can stop it", () => {
    const bubble = vi.fn();
    window.addEventListener("keydown", bubble);
    mount([{ keys: ["k"], mods: "any", run: (e) => e.stopPropagation() }], { capture: true });
    press("k");
    window.removeEventListener("keydown", bubble);
    expect(bubble).not.toHaveBeenCalled();
  });

  it("reads fresh bindings without re-subscribing", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(({ run }) => useHotkeys([{ keys: ["s"], run }]), {
      initialProps: { run: first },
    });
    rerender({ run: second });
    press("s");
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
