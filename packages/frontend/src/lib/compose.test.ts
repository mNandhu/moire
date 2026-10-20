import { describe, expect, it } from "vitest";
import { compose, displayWord } from "./compose";

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
