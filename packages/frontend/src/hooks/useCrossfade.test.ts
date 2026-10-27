import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CROSSFADE_MS, useCrossfade } from "./useCrossfade";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const tick = (ms = 20) => act(() => void vi.advanceTimersByTime(ms));

describe("useCrossfade", () => {
  it("paints each new src into the back layer, then flips it to the front", () => {
    const { result, rerender } = renderHook(({ src }) => useCrossfade(src), {
      initialProps: { src: null as string | null },
    });
    expect(result.current).toEqual({ layers: [null, null], front: 0 });

    rerender({ src: "a" });
    expect(result.current.layers).toEqual([null, "a"]);
    expect(result.current.front).toBe(0);
    tick();
    expect(result.current.front).toBe(1);

    rerender({ src: "b" });
    expect(result.current.layers).toEqual(["b", "a"]);
    tick();
    expect(result.current.front).toBe(0);
  });

  it("fades both layers out, then clears them after the transition", () => {
    const { result, rerender } = renderHook(({ src }) => useCrossfade(src), {
      initialProps: { src: "a" as string | null },
    });
    tick();
    rerender({ src: null });
    expect(result.current.front).toBeNull();
    expect(result.current.layers).toEqual([null, "a"]);
    tick(CROSSFADE_MS);
    expect(result.current.layers).toEqual([null, null]);
  });
});
