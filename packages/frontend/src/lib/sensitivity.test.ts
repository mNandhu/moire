import { describe, expect, it } from "vitest";
import {
  filterLabel,
  fromOption,
  hiddenCount,
  OFF,
  toOption,
  unknownHidden,
  type SensitivityState,
} from "./sensitivity";

const state = (max: SensitivityState["max_level"]): SensitivityState => ({
  max_level: max,
  counts: { unknown: 5, by_level: { general: 10, sensitive: 4, questionable: 3, explicit: 2 } },
});

describe("sensitivity filter", () => {
  it("round-trips the setting through the picker", () => {
    expect(toOption(null)).toBe(OFF);
    expect(toOption("sensitive")).toBe("sensitive");
    expect(fromOption(OFF)).toBeNull();
    expect(fromOption("questionable")).toBe("questionable");
    expect(fromOption("explicit")).toBeNull(); // allowing everything is off
  });

  it("labels each setting", () => {
    expect(filterLabel(null)).toBe("Show everything");
    expect(filterLabel("general")).toBe("General only");
  });

  it("counts what the setting hides: higher levels and the unknown", () => {
    expect(hiddenCount(state(null))).toBe(0);
    expect(hiddenCount(state("general"))).toBe(4 + 3 + 2 + 5);
    expect(hiddenCount(state("questionable"))).toBe(2 + 5);
    expect(hiddenCount(undefined)).toBe(0);
  });

  it("counts the unknown only while the filter is on", () => {
    expect(unknownHidden(state(null))).toBe(0);
    expect(unknownHidden(state("sensitive"))).toBe(5);
  });
});
