import { describe, expect, it } from "vitest";
import { compose, composeParts, displayWord, promptTerms } from "./compose";

describe("compose", () => {
  it("writes base, then blocks escaped and deduped across blocks", () => {
    expect(
      compose(
        "masterpiece, best quality,",
        ["hu_tao_(genshin_impact)"],
        ["1girl", "embedding:easynegative"],
        ["1girl"],
      ),
    ).toBe("masterpiece, best quality, hu_tao_\\(genshin_impact\\), 1girl, embedding:easynegative");
  });
  it("handles an empty base", () => {
    expect(compose("", ["a"], [])).toBe("a");
    expect(compose("  ")).toBe("");
  });
  it("displays words", () => {
    expect(displayWord("red_dress")).toBe("red dress");
    expect(displayWord("embedding:pos/aesthetic")).toBe("pos/aesthetic");
  });
});

describe("composeParts (same cases as test_generation_compose.py)", () => {
  it("keeps text raw and chips escaped", () => {
    expect(
      composeParts([
        "masterpiece, best quality,",
        ["hu_tao_(genshin_impact)", "red_eyes"],
        "embedding:pos/aesthetic",
        "(smile:1.2), sitting on a swing, red_eyes",
        [],
      ]),
    ).toBe(
      "masterpiece, best quality, hu_tao_\\(genshin_impact\\), red_eyes, embedding:pos/aesthetic, (smile:1.2), sitting on a swing, red_eyes",
    );
  });
  it("takes the prompt's first terms for the auto name", () => {
    expect(promptTerms("(smile:1.2), embedding:x, <lora:a:1>, sitting_on_swing, garden")).toEqual([
      "smile",
      "sitting on swing",
    ]);
    expect(promptTerms("")).toEqual([]);
    // Read as the board reads them: escapes, kaomoji and groups kept whole.
    expect(promptTerms("hu_tao_\\(genshin_impact\\), (>_<:1.1), smile", 3)).toEqual([
      "hu tao (genshin impact)",
      ">_<",
      "smile",
    ]);
    expect(promptTerms("(white dress, blue sky:1.2), a gentle breeze moving through her hair, 1girl")).toEqual([
      "white dress",
      "blue sky",
    ]);
    // Lowercase, as stored; prose is no tag.
    expect(promptTerms("(Smile:1.2), embedding:x, <lora:a:1>, Sitting_on_swing")).toEqual(["smile", "sitting on swing"]);
    expect(promptTerms("a gentle breeze moving through her hair, 1girl, smile")).toEqual(["1girl", "smile"]);
  });
});
