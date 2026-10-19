import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useSelectionMode } from "./useSelectionMode";

describe("useSelectionMode", () => {
  it("toggles ids in and out of the selection (in selection mode)", () => {
    const { result } = renderHook(() => useSelectionMode());
    act(() => result.current.setSelectionMode(true));
    act(() => result.current.toggle("a"));
    expect([...result.current.selection]).toEqual(["a"]);
    expect(result.current.selectionActive).toBe(true);
    act(() => result.current.toggle("a"));
    expect(result.current.selection.size).toBe(0);
    expect(result.current.selectionActive).toBe(false);
  });

  it("selectOnly() replaces the selection (Select all)", () => {
    const { result } = renderHook(() => useSelectionMode());
    act(() => result.current.setSelectionMode(true));
    act(() => result.current.toggle("x"));
    act(() => result.current.selectOnly(["a", "b", "c"]));
    expect([...result.current.selection]).toEqual(["a", "b", "c"]);
  });

  it("clear() empties the selection", () => {
    const { result } = renderHook(() => useSelectionMode());
    act(() => result.current.setSelectionMode(true));
    act(() => {
      result.current.toggle("a");
      result.current.toggle("b");
    });
    expect(result.current.selection.size).toBe(2);
    act(() => result.current.clear());
    expect(result.current.selection.size).toBe(0);
  });

  it("a selection made while NOT in selection mode is auto-dropped", () => {
    const { result } = renderHook(() => useSelectionMode());
    act(() => result.current.toggle("a"));
    expect(result.current.selection.size).toBe(0);
  });

  it("drops the selection when selection mode is turned off", () => {
    const { result } = renderHook(() => useSelectionMode());
    act(() => {
      result.current.setSelectionMode(true);
      result.current.toggle("a");
    });
    expect(result.current.selection.size).toBe(1);
    act(() => result.current.setSelectionMode(false));
    expect(result.current.selection.size).toBe(0);
  });
});
