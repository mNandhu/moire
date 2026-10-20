import { describe, expect, it } from "vitest";
import { batchLine, dayLabel, whenLabel } from "./batches";

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
