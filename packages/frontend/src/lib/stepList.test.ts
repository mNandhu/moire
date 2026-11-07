import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { publishSteps, sameSteps, stepsState, useStepList, useSteps, type StepItem } from "./stepList";

const item = (id: string, thumb: string | null = `/t/${id}`): StepItem => ({ _id: id, thumb_url: thumb, width: 1, height: 1 });

describe("step lists", () => {
  it("tells lists apart by their images and thumbnails", () => {
    expect(sameSteps([item("a")], [item("a")])).toBe(true);
    expect(sameSteps([item("a")], [item("a", null)])).toBe(false);
    expect(sameSteps([item("a"), item("b")], [item("b"), item("a")])).toBe(false);
  });

  it("the viewer follows the page's live list, else the list it was opened with", () => {
    const opened = { state: stepsState({ name: "t-live", items: [item("a")] }) };
    const { result } = renderHook(() => useSteps(opened));
    expect(result.current?.map((x) => x._id)).toEqual(["a"]);
    act(() => publishSteps("t-live", [item("a"), item("b")]));
    expect(result.current?.map((x) => x._id)).toEqual(["a", "b"]);
    act(() => publishSteps("t-live", null));
    expect(result.current?.map((x) => x._id)).toEqual(["a"]);
  });

  it("is the feed when opened without a list", () => {
    const { result } = renderHook(() => useSteps({ state: null }));
    expect(result.current).toBeUndefined();
  });

  it("a page keeps one value while its images stay the same, and publishes while up", () => {
    const { result, rerender, unmount } = renderHook(({ items }) => useStepList("t-page", items), {
      initialProps: { items: [item("a")] },
    });
    const first = result.current;
    rerender({ items: [item("a")] });
    expect(result.current).toBe(first);
    rerender({ items: [item("a"), item("b")] });
    expect(result.current.items.map((x) => x._id)).toEqual(["a", "b"]);

    const viewer = renderHook(() => useSteps({ state: stepsState({ name: "t-page", items: [] }) }));
    expect(viewer.result.current?.map((x) => x._id)).toEqual(["a", "b"]);
    unmount();
    viewer.rerender();
    expect(viewer.result.current).toEqual([]);
  });
});
