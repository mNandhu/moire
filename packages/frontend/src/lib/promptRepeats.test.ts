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
  it("finds tags however they are weighted or grouped", () => {
    expect(prefixRepeats("1girl, masterpiece", "(masterpiece:1.2), 1girl")).toEqual(["(masterpiece:1.2)", "1girl"]);
    const remixed = "(xxx667_illu, 4ur4_illu,masterpiece,best quality, source_anime,:1.1), model_style";
    expect(prefixRepeats("masterpiece, best quality, source_anime", remixed)).toEqual(["masterpiece", "best quality", "source_anime"]);
    // A bracketed prefix counts too.
    expect(prefixRepeats(remixed, "1girl, best_quality, model style")).toEqual(["best_quality", "model style"]);
    expect(tagRepeats(["4ur4_illu"], remixed)).toEqual(["4ur4_illu"]);
  });
  it("leaves regions and prompt edits alone", () => {
    expect(prefixRepeats("1girl, masterpiece", "masterpiece, (1girl, eula) AND (1girl, furina)")).toEqual(["masterpiece"]);
    expect(prefixRepeats("masterpiece, sketch", "[masterpiece:sketch:0.5], 1girl")).toEqual([]);
    // AND only sets apart the chunk it is in.
    expect(prefixRepeats("smile", "(eula, smile), x BREAK (a, b) AND (c)")).toEqual(["smile"]);
    expect(prefixRepeats("smile", "x BREAK (eula, smile) AND (c)")).toEqual([]);
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
    // A bracket left open holds the rest of the prompt, weighted.
    expect(prefixRepeats("masterpiece", "(1girl, masterpiece")).toEqual(["masterpiece"]);
  });
});

describe("withoutTerms", () => {
  it("takes tags out of a weighted group, the group whole once empty", () => {
    const remixed = "(xxx667_illu, masterpiece,best quality, source_anime,:1.1), model_style";
    expect(withoutTerms(remixed, ["masterpiece", "source_anime"]).text).toBe("(xxx667_illu, best quality,:1.1), model_style");
    expect(withoutTerms(remixed, ["xxx667_illu"]).text).toBe("(masterpiece,best quality, source_anime,:1.1), model_style");
    expect(withoutTerms(remixed, ["xxx667_illu", "masterpiece", "best quality", "source_anime"])).toEqual({ text: "model_style", removed: 4 });
    expect(withoutTerms("1girl, (masterpiece:1.2)", ["masterpiece"]).text).toBe("1girl");
  });
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
      "1girl\nbeach\n(x)",
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
  it("finds weighted tags, but leaves regions alone", () => {
    expect(tagRepeats(["red_eyes"], "(red_eyes:1.2), (1girl, red_eyes) AND (1girl)")).toEqual(["(red_eyes:1.2)"]);
  });
  it("takes out what it found", () => {
    const prompt = "1girl, hu tao \\(genshin impact\\), beach";
    expect(withoutTerms(prompt, tagRepeats(["hu_tao_(genshin_impact)"], prompt)).text).toBe("1girl, beach");
  });
});
