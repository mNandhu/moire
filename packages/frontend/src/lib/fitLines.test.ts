import { describe, expect, it } from "vitest";
import { fitLines } from "./fitLines";

const base = { lineHeight: 20, toggleHeight: 20 };

describe("fitLines", () => {
  it("leaves text that fits unclamped", () => {
    expect(fitLines({ ...base, available: 300, fullHeight: 200 })).toBeNull();
  });

  it("clamps to the whole lines left after the toggle", () => {
    // 250 - 20 for the toggle = 230: 11 whole lines.
    expect(fitLines({ ...base, available: 250, fullHeight: 600 })).toBe(11);
  });

  it("never goes below the minimum, even with no room", () => {
    expect(fitLines({ ...base, available: -100, fullHeight: 600 })).toBe(3);
  });

  it("doesn't clamp when the clamp would show it all anyway", () => {
    expect(fitLines({ ...base, available: 40, fullHeight: 60 })).toBeNull();
  });
});
