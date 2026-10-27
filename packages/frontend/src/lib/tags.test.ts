import { describe, expect, it } from "vitest";
import {
  adherenceGroups,
  bareTagPool,
  bulkTagNames,
  danbooruWikiUrl,
  descriptionKey,
  onDanbooru,
  formatSearchTag,
  formatTag,
  planRename,
  renameOptions,
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

  it("lists each name once, as its first kind, with the others in `also`", () => {
    const flow = tagFlow(
      ["prompt:solo", "solo", "manual:solo", "prompt:neon", "manual:neon", "manual:fav",
        "zhongli", "prompt:Zhongli"],
      ai,
    );
    expect(flow.map((t) => [t.raw, t.kind, t.also])).toEqual([
      ["zhongli", "character", ["prompt"]],
      ["solo", "ai", ["manual", "prompt"]],
      ["manual:neon", "manual", ["prompt"]],
      ["manual:fav", "manual", undefined],
    ]);
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

describe("renameOptions", () => {
  const known = [
    { _id: "1girl", count: 9 },
    { _id: "manual:keeper", count: 2 },
    { _id: "manual:other", count: 1 },
    { _id: "prompt:1girl", count: 4 },
    { _id: "prompt:solo", count: 3 },
  ];
  it("offers only other manual tags for a manual tag", () => {
    expect(renameOptions("manual:keeper", known).map((t) => t._id)).toEqual(["manual:other"]);
  });
  it("offers only other prompt tags for a prompt tag", () => {
    expect(renameOptions("prompt:1girl", known).map((t) => t._id)).toEqual(["prompt:solo"]);
  });
  it("offers nothing for an AI tag, which can't be renamed", () => {
    expect(renameOptions("1girl", known)).toEqual([]);
  });
});

describe("planRename", () => {
  const known = [
    { _id: "manual:keeper", count: 3 },
    { _id: "prompt:blonde_hair", count: 9 },
  ];
  it("refuses AI tags", () => {
    expect(planRename("blonde", "x", known).ok).toBe(false);
  });
  it("keeps the kind and canonicalizes the typed name", () => {
    expect(planRename("manual:keepr", "  my pick ", known)).toEqual({
      ok: true,
      target: "manual:my_pick",
    });
  });
  it("is a merge when the target exists, prompt names lowercased", () => {
    expect(planRename("prompt:blonde", "Blonde Hair", known)).toEqual({
      ok: true,
      target: "prompt:blonde_hair",
      existing: { _id: "prompt:blonde_hair", count: 9 },
    });
  });
  it("treats the other spelling of the same name as no change", () => {
    expect(planRename("manual:my_pick", "my pick", known).ok).toBe(false);
  });
});

describe("adherenceGroups", () => {
  const ai = {
    general_tags: [["solo", 0.9], ["tassel", 0.6]] as [string, number][],
    character_tags: [["zhongli", 0.95]] as [string, number][],
  };

  it("splits tags by what the prompt asked for and the tagger saw", () => {
    const g = adherenceGroups(tagFlow(["zhongli", "solo", "tassel", "prompt:solo", "prompt:neon", "manual:fav"], ai))!;
    expect(g.matched.map((t) => t.raw)).toEqual(["solo"]);
    expect(g.unprompted.map((t) => t.raw)).toEqual(["zhongli", "tassel"]);
    expect(g.missed.map((t) => t.raw)).toEqual(["prompt:neon"]);
    expect(g.mine.map((t) => t.raw)).toEqual(["manual:fav"]);
  });

  it("counts your tag that the prompt also names as prompted", () => {
    const g = adherenceGroups(tagFlow(["solo", "prompt:solo", "prompt:neon", "manual:neon"], ai))!;
    expect(g.missed.map((t) => t.raw)).toEqual(["manual:neon"]);
    expect(g.mine).toEqual([]);
  });

  it("is null with only one side to compare", () => {
    expect(adherenceGroups(tagFlow(["prompt:neon", "manual:fav"]))).toBeNull();
    expect(adherenceGroups(tagFlow(["solo", "manual:fav"], ai))).toBeNull();
  });
});

describe("descriptionKey", () => {
  it("files any spelling under the bare, underscored, lowercase name", () => {
    expect(descriptionKey("prompt:Blue Eyes")).toBe("blue_eyes");
    expect(descriptionKey("manual:hime_cut")).toBe("hime_cut");
    expect(descriptionKey("ahoge")).toBe("ahoge");
  });

  it("links the Danbooru wiki page, escaped", () => {
    expect(danbooruWikiUrl("prompt:keyboard (computer)")).toBe(
      "https://danbooru.donmai.us/wiki_pages/keyboard_(computer)",
    );
    expect(danbooruWikiUrl("+_+")).toBe("https://danbooru.donmai.us/wiki_pages/%2B_%2B");
  });
});

describe("onDanbooru", () => {
  it("is the tagger's tags and the described ones, not prompt filler", () => {
    expect(onDanbooru(3, undefined)).toBe(true);
    expect(onDanbooru(0, "A stray lock of hair.")).toBe(true);
    expect(onDanbooru(0, undefined)).toBe(false);
  });
});

describe("bareTagPool", () => {
  it("folds a tag's kinds into one bare row with summed counts", () => {
    expect(bareTagPool([
      { _id: "blue_eyes", count: 3 },
      { _id: "prompt:blue_eyes", count: 2 },
      { _id: "manual:smile", count: 1 },
    ])).toEqual([
      { _id: "blue_eyes", count: 5 },
      { _id: "smile", count: 1 },
    ]);
  });
});
