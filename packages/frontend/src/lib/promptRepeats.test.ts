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

describe("prompt terms", () => {
  it("splits past a kaomoji, keeps LoRA tags whole, reads escaped parens", () => {
    expect(prefixRepeats("masterpiece", "1girl, >_<, masterpiece")).toEqual(["masterpiece"]);
    expect(prefixRepeats("x", "<lora:a, b:1>, x")).toEqual(["x"]);
    expect(prefixRepeats("hu_tao_\\(genshin_impact\\)", "1girl, hu tao \\(genshin impact\\)")).toEqual(["hu tao \\(genshin impact\\)"]);
  });
});

describe("withoutTerms", () => {
  it("counts every copy it takes out", () => {
    expect(withoutTerms("masterpiece, 1girl, masterpiece", ["masterpiece"])).toEqual({ text: "1girl", removed: 2 });
  });
  it("drops the terms and one separator each", () => {
    expect(withoutTerms("masterpiece, 1girl, best quality, beach", ["masterpiece", "best_quality"]).text).toBe("1girl, beach");
    expect(withoutTerms("1girl, beach, masterpiece", ["masterpiece"]).text).toBe("1girl, beach");
    expect(withoutTerms("a, m, b", ["m", "b"]).text).toBe("a");
  });
  it("keeps line breaks and groups", () => {
    expect(withoutTerms("masterpiece, 1girl\nbeach, best quality\n(x, masterpiece)", ["masterpiece", "best quality"]).text).toBe(
      "1girl\nbeach\n(x, masterpiece)",
    );
  });
});
