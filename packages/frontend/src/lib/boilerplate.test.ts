import { describe, it, expect } from "vitest";
import {
  NO_BOILERPLATE,
  compileBoilerplate,
  normalizeTagName,
  splitBoilerplate,
} from "./boilerplate";

describe("normalizeTagName", () => {
  it("drops the source prefix, case and space/underscore differences", () => {
    expect(normalizeTagName("prompt:Best_Quality")).toBe("best quality");
    expect(normalizeTagName("manual:  very   aesthetic ")).toBe("very aesthetic");
    expect(normalizeTagName("any:score_9")).toBe("score 9");
    expect(normalizeTagName("1girl")).toBe("1girl");
  });
});

describe("compileBoilerplate", () => {
  const isBp = compileBoilerplate(["masterpiece", "best quality", "score_*", "source_*"]);

  it("matches a name from any source", () => {
    expect(isBp("prompt:masterpiece")).toBe(true);
    expect(isBp("masterpiece")).toBe(true);
    expect(isBp("manual:masterpiece")).toBe(true);
    expect(isBp("any:masterpiece")).toBe(true);
  });

  it("treats spaces and underscores alike, both ways", () => {
    expect(isBp("prompt:best_quality")).toBe(true);
    expect(isBp("prompt:score 7")).toBe(true);
    expect(isBp("prompt:score_8_up")).toBe(true);
    expect(isBp("prompt:source_anime")).toBe(true);
  });

  it("matches whole names only", () => {
    expect(isBp("prompt:masterpiece theatre")).toBe(false);
    expect(isBp("prompt:highscore 9")).toBe(false);
    expect(isBp("1girl")).toBe(false);
  });

  it("escapes regex characters in entries", () => {
    const m = compileBoilerplate(["(best:1.2)", "a+*"]);
    expect(m("prompt:(best:1.2)")).toBe(true);
    expect(m("prompt:(bestx1.2)")).toBe(false);
    expect(m("prompt:a+b")).toBe(true);
  });

  it("ignores empty and match-everything entries", () => {
    expect(compileBoilerplate(["", "*", " * "])).toBe(NO_BOILERPLATE);
    expect(compileBoilerplate([])("masterpiece")).toBe(false);
  });
});

describe("splitBoilerplate", () => {
  it("keeps order within both halves", () => {
    const isBp = compileBoilerplate(["masterpiece", "absurdres"]);
    const tags = ["prompt:masterpiece", "1girl", "prompt:absurdres", "solo"];
    expect(splitBoilerplate(tags, (t) => t, isBp)).toEqual({
      kept: ["1girl", "solo"],
      boilerplate: ["prompt:masterpiece", "prompt:absurdres"],
    });
  });
});
