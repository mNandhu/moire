import { describe, expect, it } from "vitest";
import {
  batchLine,
  batchRunTime,
  coverAspect,
  dayLabel,
  durationLabel,
  resultGrid,
  resultSlots,
  scrubIndex,
  whenLabel,
} from "./batches";

describe("batch display", () => {
  it("summarizes images, failures and rejections", () => {
    expect(batchLine({ images: 8, kept: 8, failed: 0, arriving: 0 })).toBe("8 images");
    expect(batchLine({ images: 16, kept: 12, failed: 1, arriving: 0 })).toBe("16 images, 1 failed, 4 rejected");
    expect(batchLine({ images: 1, kept: 1, failed: 0, arriving: 0 })).toBe("1 image");
    // Not in the library yet is arriving, not rejected.
    expect(batchLine({ images: 1, kept: 0, failed: 0, arriving: 1 })).toBe("1 image");
  });
  it("labels days", () => {
    const now = new Date(2026, 9, 20, 15, 0);
    const today = new Date(2026, 9, 20, 9, 30).getTime() / 1000;
    const yesterday = new Date(2026, 9, 19, 23, 0).getTime() / 1000;
    expect(dayLabel(today, now)).toBe("Today");
    expect(whenLabel(yesterday, now)).toBe("Yesterday");
    expect(dayLabel(new Date(2026, 9, 1).getTime() / 1000, now)).not.toBe("Today");
  });
});

describe("result grid", () => {
  const req = (state: string, outputs: number, images: number | null = 1) =>
    ({
      _id: Math.random(),
      state,
      images,
      outputs: Array.from({ length: outputs }, (_, i) => ({ idx: i })),
    }) as never;

  it("lays requests out as one flat list of cells", () => {
    const slots = resultSlots({ requests: [req("done", 2), req("running", 0, 2), req("failed", 0, 2), req("pending", 0)] });
    expect(slots.map((s) => s.kind)).toEqual(["image", "image", "waiting", "waiting", "failed", "waiting"]);
    expect(slots.map((s) => s.number)).toEqual([1, 1, 2, 2, 3, 4]);
    expect(slots.filter((s) => s.kind === "waiting").map((s) => (s as { first: boolean }).first)).toEqual([true, false, true]);
  });

  it("keeps a few images in one row and wraps more at four", () => {
    expect(resultGrid(1, "page")).toEqual({ cols: 1, rows: 1 });
    expect(resultGrid(2, "page")).toEqual({ cols: 2, rows: 1 });
    expect(resultGrid(8, "page")).toEqual({ cols: 4, rows: 2 });
    expect(resultGrid(1, "panel")).toEqual({ cols: 1, rows: 1 });
    expect(resultGrid(3, "panel")).toEqual({ cols: 2, rows: 2 });
    expect(resultGrid(8, "panel")).toEqual({ cols: 4, rows: 2 });
  });

  it("stacks wide images in the output column", () => {
    const wide = 1216 / 832;
    expect(resultGrid(2, "panel", wide)).toEqual({ cols: 1, rows: 2 });
    expect(resultGrid(1, "panel", wide)).toEqual({ cols: 1, rows: 1 });
    expect(resultGrid(4, "panel", wide)).toEqual({ cols: 2, rows: 2 });
    expect(resultGrid(12, "panel", wide)).toEqual({ cols: 3, rows: 4 });
    // Square stays as portrait; the page is wide enough either way.
    expect(resultGrid(2, "panel", 1)).toEqual({ cols: 2, rows: 1 });
    expect(resultGrid(2, "page", wide)).toEqual({ cols: 2, rows: 1 });
  });
});

describe("run time", () => {
  it("reads like a stopwatch", () => {
    expect(durationLabel(8.43)).toBe("8.4s");
    expect(durationLabel(42.4)).toBe("42s");
    expect(durationLabel(65)).toBe("1m 05s");
    expect(durationLabel(3720)).toBe("1h 02m");
  });
  it("adds up timed requests and divides by their images", () => {
    const out = { idx: 0 } as never;
    const done = "done" as const;
    expect(batchRunTime([{ ran: null, outputs: [], state: "pending" }])).toBeNull();
    expect(
      batchRunTime([
        { ran: 10, outputs: [out, out], state: done },
        { ran: 6, outputs: [out], state: done },
        { ran: 30, outputs: [], state: "failed" },
        { ran: null, outputs: [], state: "pending" },
      ]),
    ).toEqual({ total: 46, perImage: 16 / 3, images: 3 });
    expect(batchRunTime([{ ran: 5, outputs: [], state: "failed" }])).toEqual({ total: 5, perImage: null, images: 0 });
  });
});

describe("batch covers", () => {
  it("take the batch's shape, within limits", () => {
    expect(coverAspect(832, 1216)).toBeCloseTo(832 / 1216);
    expect(coverAspect(1216, 832)).toBeCloseTo(1216 / 832);
    expect(coverAspect(1024, 1024)).toBe(1);
    expect(coverAspect(2048, 512)).toBe(3 / 2);
    expect(coverAspect(512, 2048)).toBe(2 / 3);
    expect(coverAspect(null, 1024)).toBe(3 / 4);
  });
  it("scrub across their images in strips", () => {
    expect(scrubIndex(0, 200, 4)).toBe(0);
    expect(scrubIndex(99, 200, 4)).toBe(1);
    expect(scrubIndex(199, 200, 4)).toBe(3);
    expect(scrubIndex(250, 200, 4)).toBe(3);
    expect(scrubIndex(-5, 200, 4)).toBe(0);
    expect(scrubIndex(120, 200, 1)).toBe(0);
  });
});
