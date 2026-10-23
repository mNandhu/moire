import { describe, expect, it } from "vitest";
import { prefixRepeats, tagRepeats, withoutTerms } from "./promptRepeats";

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
  it("splits the way the board and the backend do", () => {
    // "|" separates; a qualifier glued onto a name is part of the tag.
    expect(prefixRepeats("masterpiece", "1girl | masterpiece")).toEqual(["masterpiece"]);
    expect(tagRepeats(["hu_tao_(genshin_impact)"], "1girl, hu_tao_(genshin_impact)")).toEqual(["hu_tao_(genshin_impact)"]);
    // A bracket left open holds the rest of the prompt.
    expect(prefixRepeats("masterpiece", "(1girl, masterpiece")).toEqual([]);
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
  it("keeps what stands beside a term it takes out", () => {
    expect(withoutTerms("masterpiece, (x, y), beach", ["masterpiece"]).text).toBe("(x, y), beach");
    expect(withoutTerms("beach, (x, y), masterpiece", ["masterpiece"]).text).toBe("beach, (x, y)");
    expect(withoutTerms("masterpiece, BREAK, 1girl", ["masterpiece"]).text).toBe("1girl");
    expect(withoutTerms("1girl, masterpiece\n(x, y)", ["masterpiece"]).text).toBe("1girl\n(x, y)");
    expect(withoutTerms("a\nm, n, b", ["m", "n"]).text).toBe("a\nb");
    expect(withoutTerms("a, m\nn, b", ["m", "n"]).text).toBe("a\nb");
    expect(withoutTerms("  m, a, ", ["m"]).text).toBe("  a, ");
    expect(withoutTerms("m", ["m"])).toEqual({ text: "", removed: 1 });
  });
  it("leaves no BREAK or AND orphaned at either end", () => {
    expect(withoutTerms("a BREAK b, c", ["a"]).text).toBe("b, c");
    expect(withoutTerms("b, c BREAK a", ["a"]).text).toBe("b, c");
    expect(withoutTerms("b | a | c", ["a"]).text).toBe("b | c");
  });
  it("keeps line breaks and groups", () => {
    expect(withoutTerms("masterpiece, 1girl\nbeach, best quality\n(x, masterpiece)", ["masterpiece", "best quality"]).text).toBe(
      "1girl\nbeach\n(x, masterpiece)",
    );
  });
});

describe("tagRepeats", () => {
  it("finds a character's and outfit's stored tags in the prompt, either spelling, once", () => {
    const tags = ["hu_tao_(genshin_impact)", "red_eyes", "twintails", "black_coat"];
    expect(tagRepeats(tags, "1girl, Red Eyes, hu tao \\(genshin impact\\), beach, red_eyes, black_coat")).toEqual([
      "Red Eyes",
      "hu tao \\(genshin impact\\)",
      "black_coat",
    ]);
  });
  it("reads a stored tag that kept its escapes", () => {
    expect(tagRepeats(["hu_tao_\\(genshin_impact\\)"], "hu tao \\(genshin impact\\)")).toEqual(["hu tao \\(genshin impact\\)"]);
  });
  it("leaves weighted and grouped terms alone", () => {
    expect(tagRepeats(["red_eyes"], "(red_eyes:1.2), (1girl, red_eyes) AND (1girl)")).toEqual([]);
  });
  it("takes out what it found", () => {
    const prompt = "1girl, hu tao \\(genshin impact\\), beach";
    expect(withoutTerms(prompt, tagRepeats(["hu_tao_(genshin_impact)"], prompt)).text).toBe("1girl, beach");
  });
});
