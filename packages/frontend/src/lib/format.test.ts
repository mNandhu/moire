import { describe, expect, it } from "vitest";
import { clockText, durationWords, formatBytes, roughDuration } from "./format";

describe("formatBytes", () => {
  it("scales to the largest unit under 1024", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(-5)).toBe("0 B");
    expect(formatBytes(Number.NaN)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(3 * 1024 ** 3)).toBe("3.0 GB");
    expect(formatBytes(5000 * 1024 ** 3)).toBe("5000.0 GB");
  });
});

describe("clockText modes", () => {
  it("floors, rounds or ceils a fraction", () => {
    expect(clockText(7.9)).toBe("0:07");
    expect(clockText(7.9, "floor")).toBe("0:07");
    expect(clockText(7.5, "round")).toBe("0:08");
    expect(clockText(7.1, "ceil")).toBe("0:08");
  });
  it("shows hours past 59:59 and never goes negative", () => {
    expect(clockText(150)).toBe("2:30");
    expect(clockText(545, "round")).toBe("9:05");
    expect(clockText(3723)).toBe("1:02:03");
    expect(clockText(3729, "round")).toBe("1:02:09");
    expect(clockText(-3, "round")).toBe("0:00");
    expect(clockText(-0.4, "ceil")).toBe("0:00");
  });
});

describe("roughDuration and durationWords", () => {
  it("keep their own styles", () => {
    expect(roughDuration(10)).toBe("1 min");
    expect(roughDuration(7 * 60)).toBe("7 min");
    expect(roughDuration(2 * 3600)).toBe("2 h");
    expect(roughDuration(4212 / 0.6)).toBe("1.9 h");
    expect(roughDuration(3 * 3600 + 1200)).toBe("3.3 h");
    expect(durationWords(8.43)).toBe("8.4s");
    expect(durationWords(42.4)).toBe("42s");
    expect(durationWords(65)).toBe("1m 05s");
    expect(durationWords(3720)).toBe("1h 02m");
  });
});
