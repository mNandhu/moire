import { describe, expect, it } from "vitest";
import autoName from "../../../backend/tests/fixtures/mirrored/auto_name_terms.json";
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
  it("leaves a chip written escaped escaped once", () => {
    expect(compose("", ["furina \\(genshin impact\\)"])).toBe("furina \\(genshin impact\\)");
  });
  it("writes a chip once however it was escaped", () => {
    expect(compose("", ["a_(b)"], ["a_\\(b\\)"])).toBe("a_\\(b\\)");
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
  // The cases live in one file the backend's prompt_terms reads too.
  it.each(autoName.cases)("takes the prompt's first terms for the auto name: $text", ({ text, limit, terms }) => {
    expect(promptTerms(text, limit)).toEqual(terms);
  });
});
