import { describe, expect, it } from "vitest";
import { prefixRepeats, withoutTerms } from "./promptRepeats";

const PREFIX = "masterpiece, best quality, amazing_quality";

describe("prefixRepeats", () => {
  it("finds plain prompt tags the prefix has, either spelling, once", () => {
    expect(prefixRepeats(PREFIX, "Masterpiece, 1girl, amazing quality, best_quality, masterpiece")).toEqual([
      "Masterpiece",
      "amazing quality",
      "best_quality",
    ]);
  });
  it("leaves weighted and grouped terms alone", () => {
    expect(prefixRepeats("1girl, masterpiece", "(masterpiece:1.2), (1girl, eula) AND (1girl, furina)")).toEqual([]);
  });
});

describe("withoutTerms", () => {
  it("drops the terms and one separator each", () => {
    expect(withoutTerms("masterpiece, 1girl, best quality, beach", ["masterpiece", "best_quality"])).toBe("1girl, beach");
    expect(withoutTerms("1girl, beach, masterpiece", ["masterpiece"])).toBe("1girl, beach");
    expect(withoutTerms("a, m, b", ["m", "b"])).toBe("a");
  });
  it("keeps line breaks and groups", () => {
    expect(withoutTerms("masterpiece, 1girl\nbeach, best quality\n(x, masterpiece)", ["masterpiece", "best quality"])).toBe(
      "1girl\nbeach\n(x, masterpiece)",
    );
  });
});
