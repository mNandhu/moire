import { describe, expect, it } from "vitest";
import {
  bulkTagNames,
  formatSearchTag,
  formatTag,
  tagQueryText,
  toPromptText,
  isAiTag,
  isManual,
  isPrompt,
  partitionTags,
  tagFlow,
} from "./tags";

describe("formatTag", () => {
  it("strips the manual: prefix", () => {
    expect(formatTag("manual:favourite")).toBe("favourite");
  });
  it("strips the prompt: prefix", () => {
    expect(formatTag("prompt:masterpiece")).toBe("masterpiece");
  });
  it("leaves a bare AI tag untouched", () => {
    expect(formatTag("1girl")).toBe("1girl");
  });
  it("shows underscores as spaces", () => {
    expect(formatTag("blue_eyes")).toBe("blue eyes");
    expect(formatTag("prompt:hu_tao_(genshin_impact)")).toBe("hu tao (genshin impact)");
  });
  it("keeps a kaomoji's underscore", () => {
    expect(formatTag("^_^")).toBe("^_^");
  });
});

describe("tagQueryText", () => {
  it("matches either spelling against the display form", () => {
    expect(formatTag("blue_eyes").includes(tagQueryText("Blue_Eyes"))).toBe(true);
  });
});

describe("toPromptText", () => {
  it("keeps underscores, drops prefixes and escapes parentheses", () => {
    expect(toPromptText(["1girl", "prompt:hu_tao_(genshin_impact)", "manual:keeper"])).toBe(
      "1girl, hu_tao_\\(genshin_impact\\), keeper",
    );
  });
  it("writes a tag once when AI and prompt both carry it", () => {
    expect(toPromptText(["blue_eyes", "manual:x", "prompt:blue_eyes"])).toBe("blue_eyes, x");
  });
});

describe("tag kind predicates", () => {
  it("classifies the three kinds", () => {
    expect(isManual("manual:fav")).toBe(true);
    expect(isPrompt("prompt:masterpiece")).toBe(true);
    expect(isAiTag("1girl")).toBe(true);
    expect(isAiTag("manual:fav")).toBe(false);
    expect(isAiTag("prompt:x")).toBe(false);
  });
});

describe("partitionTags", () => {
  it("splits one array into the three kinds, preserving order", () => {
    const p = partitionTags([
      "1girl",
      "manual:fav",
      "prompt:masterpiece",
      "solo",
      "manual:keep",
    ]);
    expect(p.ai).toEqual(["1girl", "solo"]);
    expect(p.manual).toEqual(["manual:fav", "manual:keep"]);
    expect(p.prompt).toEqual(["prompt:masterpiece"]);
  });

  it("keeps an AI tag and its prompt twin as distinct kinds", () => {
    // The backend never dedupes these against each other.
    const p = partitionTags(["1girl", "prompt:1girl"]);
    expect(p.ai).toEqual(["1girl"]);
    expect(p.prompt).toEqual(["prompt:1girl"]);
  });

  it("handles an absent tag array", () => {
    expect(partitionTags()).toEqual({ ai: [], manual: [], prompt: [] });
  });
});

describe("formatSearchTag", () => {
  it("strips the merged any: prefix as well as the kind prefixes", () => {
    expect(formatSearchTag("any:cat")).toBe("cat");
    expect(formatSearchTag("manual:cat")).toBe("cat");
    expect(formatSearchTag("cat")).toBe("cat");
  });
});

describe("tagFlow", () => {
  const ai = {
    general_tags: [["solo", 0.95], ["1boy", 0.97], ["tassel", 0.48]] as [string, number][],
    character_tags: [["zhongli", 0.93]] as [string, number][],
  };

  it("orders characters, AI by confidence, yours, then prompt", () => {
    const flow = tagFlow(["solo", "prompt:neon", "manual:fav", "tassel", "zhongli", "1boy"], ai);
    expect(flow.map((t) => [t.label, t.kind])).toEqual([
      ["zhongli", "character"],
      ["1boy", "ai"],
      ["solo", "ai"],
      ["tassel", "ai"],
      ["fav", "manual"],
      ["neon", "prompt"],
    ]);
    expect(flow[0].confidence).toBe(0.93);
  });

  it("keeps an AI tag and the same prompt tag as separate entries", () => {
    const flow = tagFlow(["solo", "prompt:solo"], ai);
    expect(flow.map((t) => t.raw)).toEqual(["solo", "prompt:solo"]);
  });

  it("works without tagger metadata, keeping stored order", () => {
    const flow = tagFlow(["b", "a", "prompt:c"], null);
    expect(flow.map((t) => [t.label, t.kind, t.confidence])).toEqual([
      ["b", "ai", undefined],
      ["a", "ai", undefined],
      ["c", "prompt", undefined],
    ]);
  });
});

describe("bulkTagNames", () => {
  it("strips the manual prefix from picked suggestions and keeps typed text", () => {
    expect(bulkTagNames(["manual:keeper", " new tag "])).toEqual(["keeper", "new tag"]);
  });

  it("dedupes a picked and a typed spelling of the same tag", () => {
    expect(bulkTagNames(["manual:fav", "fav", ""])).toEqual(["fav"]);
  });
});
