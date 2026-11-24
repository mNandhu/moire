import { describe, it, expect } from "vitest";
import { presetOf, presetRange, rangeDays, rangeOf } from "./madeRange";

const now = new Date(2026, 10, 25, 15); // Wed Nov 25 2026
const s = (y: number, m: number, d: number) => new Date(y, m, d).getTime() / 1000;

describe("Made presets", () => {
  it("cover whole local days", () => {
    expect(presetRange("today", now)).toEqual({ madeFrom: s(2026, 10, 25), madeTo: s(2026, 10, 26) });
    expect(presetRange("yesterday", now)).toEqual({ madeFrom: s(2026, 10, 24), madeTo: s(2026, 10, 25) });
    expect(presetRange("7d", now)).toEqual({ madeFrom: s(2026, 10, 19) });
    expect(presetRange("30d", now)).toEqual({ madeFrom: s(2026, 9, 27) });
    expect(presetRange("year", now)).toEqual({ madeFrom: s(2026, 0, 1) });
  });
  it("are recognised from a range", () => {
    expect(presetOf(presetRange("7d", now), now)).toBe("7d");
    expect(presetOf({ madeFrom: s(2026, 10, 20) }, now)).toBeUndefined();
    expect(presetOf({}, now)).toBeUndefined();
  });
});

describe("custom range", () => {
  it("round-trips its days, To inclusive", () => {
    const r = rangeOf(new Date(2026, 10, 12), new Date(2026, 10, 14));
    expect(r).toEqual({ madeFrom: s(2026, 10, 12), madeTo: s(2026, 10, 15) });
    expect(rangeDays(r)).toEqual({ from: new Date(2026, 10, 12), to: new Date(2026, 10, 14) });
  });
  it("takes either end alone, and a To before the From as one day", () => {
    expect(rangeOf(new Date(2026, 10, 12), null)).toEqual({ madeFrom: s(2026, 10, 12), madeTo: undefined });
    expect(rangeOf(null, null)).toEqual({ madeFrom: undefined, madeTo: undefined });
    expect(rangeOf(new Date(2026, 10, 14), new Date(2026, 10, 12))).toEqual({
      madeFrom: s(2026, 10, 12),
      madeTo: s(2026, 10, 13),
    });
  });
});
