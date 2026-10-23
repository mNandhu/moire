import { describe, expect, it } from "vitest";
import { cellProgress, stepsLabel } from "./eta";
import { cellTitle, failureLabel, newestSlot, resultSlots, shownSlot, slotKey, slotWhy, stepIndex } from "./batches";

const run = (over: Record<string, unknown> = {}) => ({ state: "running", progress: null, expected: 20, ...over }) as never;

describe("stepsLabel", () => {
  it("shows ComfyUI's node and step of steps", () => {
    expect(stepsLabel({ progress: null })).toBeNull();
    expect(stepsLabel({ progress: { value: 12, max: 28 } })).toBe("12 / 28");
    expect(stepsLabel({ progress: { value: 12, max: 28, node: "3" } })).toBe("3 12 / 28");
  });
});

describe("cellProgress", () => {
  it("reads queued while it is not running, however it waits", () => {
    const c = cellProgress({ state: "pending", progress: null, expected: 20 } as never, null);
    expect(c).toMatchObject({ big: null, caption: "Queued", progress: null, fill: 0, late: false, striped: false, tip: "" });
  });

  it("counts down against the estimate", () => {
    const c = cellProgress(run(), 5);
    expect(c.big).toBe("0:15");
    expect(c.caption).toBe("left");
    expect(c.fill).toBe(0.25);
    expect(c.striped).toBe(false);
    expect(c.tip).toBe("Usually about 0:20");
  });

  it("counts up past the estimate, then calls it late", () => {
    const finishing = cellProgress(run(), 22);
    expect(finishing).toMatchObject({ big: "+0:02", caption: "Finishing up", late: false, striped: true });
    const late = cellProgress(run(), 30);
    expect(late).toMatchObject({ caption: "Taking longer than usual", late: true, striped: true });
  });

  it("prefers ComfyUI's steps for the bar", () => {
    const c = cellProgress(run({ progress: { value: 14, max: 28 } }), 5);
    expect(c.progress).toBe(0.5);
    expect(c.fill).toBe(0.5);
    expect(c.tip).toBe("14 / 28 · Usually about 0:20");
  });

  it("shows the time so far without an estimate, and the steps as caption", () => {
    const c = cellProgress(run({ expected: null, progress: { value: 1, max: 4, node: "9" } }), 65);
    expect(c).toMatchObject({ big: "1:05", caption: "9 1 / 4", striped: false });
    expect(cellProgress(run({ expected: null }), null)).toMatchObject({ big: null, caption: "Running", progress: null });
  });
});

describe("failureLabel", () => {
  it("names each way a request ends without images", () => {
    expect(failureLabel({ state: "cancelled", images: 4 })).toBe("Cancelled");
    expect(failureLabel({ state: "done", images: 1 })).toBe("Returned 0 images");
    expect(failureLabel({ state: "lost", images: 1 })).toBe("Lost");
    expect(failureLabel({ state: "failed", images: 1 })).toBe("Failed");
    expect(failureLabel({ state: "failed", images: 3 })).toBe("Failed, 3 images");
    expect(failureLabel({ state: "failed", images: null })).toBe("Failed");
  });
});

describe("the strip", () => {
  const req = (_id: number, state: string, outputs: number, images = 1) =>
    ({ _id, state, images, seed: _id * 10, outputs: Array.from({ length: outputs }, (_, i) => ({ idx: i })) }) as never;
  const slots = resultSlots({ requests: [req(1, "done", 2), req(2, "running", 0), req(3, "failed", 0)] });

  it("keys images by request and index, others by place", () => {
    expect(slots.map(slotKey)).toEqual(["1:0", "1:1", "2:waiting:2", "3:failed:3"]);
    expect(cellTitle(slots[2])).toBe("Request 2, seed 20");
  });

  it("says why a slot has no thumbnail", () => {
    expect(slots.map(slotWhy)).toEqual(["missing", "missing", "running", "failed"]);
    const queued = resultSlots({ requests: [req(5, "queued", 0)] });
    expect(slotWhy(queued[0])).toBe("waiting");
  });

  it("follows the image being made, else the last made, else the last", () => {
    expect(newestSlot(slots)).toBe(2);
    expect(newestSlot(slots.filter((s) => s.kind !== "waiting"))).toBe(1);
    expect(newestSlot(slots.filter((s) => s.kind === "failed"))).toBe(0);
    expect(newestSlot([])).toBe(-1);
  });

  it("keeps a pick on its image as cells come and go", () => {
    expect(shownSlot(slots, "1:1")).toBe(1);
    expect(shownSlot(slots.slice(1), "1:1")).toBe(0);
    expect(shownSlot(slots, null)).toBe(2);
    expect(shownSlot([], null)).toBe(0);
  });

  it("steps with wrap", () => {
    expect(stepIndex(0, -1, 4)).toBe(3);
    expect(stepIndex(3, 1, 4)).toBe(0);
    expect(stepIndex(1, 1, 4)).toBe(2);
  });
});
