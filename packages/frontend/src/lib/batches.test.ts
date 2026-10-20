import { describe, expect, it } from "vitest";
import { batchLine, dayLabel, resultGrid, resultSlots, whenLabel } from "./batches";

describe("batch display", () => {
  it("summarizes images, failures and rejections", () => {
    expect(batchLine({ images: 8, kept: 8, failed: 0 })).toBe("8 images");
    expect(batchLine({ images: 16, kept: 12, failed: 1 })).toBe("16 images, 1 failed, 4 rejected");
    expect(batchLine({ images: 1, kept: 1, failed: 0 })).toBe("1 image");
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
