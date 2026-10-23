import { describe, expect, it } from "vitest";
import fixture from "../../../backend/tests/fixtures/mirrored/prompt_terms.json";
import { appendTag, promptTerms, removeSpan, replaceName } from "./promptOutline";

const names = (text: string) => promptTerms(text).map((t) => [t.name, t.weight ?? null, t.kind]);

describe("promptTerms", () => {
  it("reads weights, emphasis and escapes", () => {
    expect(names("1girl, (white dress:1.2), ((blue eyes)), [smile], x_\\(cosplay\\), (red bow:0.8)")).toEqual([
      ["1girl", null, "tag"],
      ["white_dress", 1.2, "tag"],
      ["blue_eyes", null, "tag"],
      ["smile", null, "tag"],
      ["x_(cosplay)", null, "tag"],
      ["red_bow", 0.8, "tag"],
    ]);
  });

  it("spreads a group's weight to its members", () => {
    expect(names("(sunflower field, blue sky:1.1), solo")).toEqual([
      ["sunflower_field", 1.1, "tag"],
      ["blue_sky", 1.1, "tag"],
      ["solo", null, "tag"],
    ]);
  });

  it("tells LoRAs, embeddings and prose apart", () => {
    expect(names("<lora:foo:0.8>, embedding:bad, a gentle breeze moving through her hair, holding_hands_with_a_friend")).toEqual([
      ["<lora:foo:0.8>", null, "lora"],
      ["embedding:bad", null, "embedding"],
      ["a_gentle_breeze_moving_through_her_hair", null, "prose"],
      ["holding_hands_with_a_friend", null, "tag"],
    ]);
  });

  it("unwraps nested and square-bracket groups", () => {
    expect(names("((sunflower field, blue sky)), [red bow, smile], ((solo))")).toEqual([
      ["sunflower_field", null, "tag"],
      ["blue_sky", null, "tag"],
      ["red_bow", null, "tag"],
      ["smile", null, "tag"],
      ["solo", null, "tag"],
    ]);
    expect(names("((cat, dog:1.3))")).toEqual([
      ["cat", 1.3, "tag"],
      ["dog", 1.3, "tag"],
    ]);
  });

  it("reads a colon outside parens as part of the name", () => {
    expect(names(":3, 16:9, (:d:1.1)")).toEqual([
      [":3", null, "tag"],
      ["16:9", null, "tag"],
      [":d", 1.1, "tag"],
    ]);
  });

  it("still splits after a bracket left open, its terms grouped", () => {
    const text = "1girl, (smile, red eyes, rain";
    expect(promptTerms(text).map((t) => [t.name, t.grouped, text.slice(t.start, t.end)])).toEqual([
      ["1girl", false, "1girl"],
      ["smile", true, "smile"],
      ["red_eyes", true, "red eyes"],
      ["rain", true, "rain"],
    ]);
  });

  it("keeps a group around one term as its piece, weight and all", () => {
    const text = "(cat:1.05)(dog:1.25), ((cat), dog:1.2), smile:1.05";
    expect(promptTerms(text).map((t) => [t.name, t.weight ?? null, t.grouped, text.slice(t.start, t.end)])).toEqual([
      ["cat", 1.05, false, "(cat:1.05)"],
      ["dog", 1.25, false, "(dog:1.25)"],
      ["cat", 1.2, true, "(cat)"],
      ["dog", 1.2, true, "dog"],
      ["smile", 1.05, false, "smile:1.05"],
    ]);
  });

  it("reads an unbracketed decimal weight, not a time or a ratio", () => {
    expect(names("smile:1.05, 16:9, 12:00")).toEqual([
      ["smile", 1.05, "tag"],
      ["16:9", null, "tag"],
      ["12:00", null, "tag"],
    ]);
  });

  it("reads an emoticon last in a group as a member, not the group's weight", () => {
    expect(names("(smile, :3)")).toEqual([
      ["smile", null, "tag"],
      [":3", null, "tag"],
    ]);
    expect(names("(cat:3), (dog, :d:1.1)")).toEqual([
      ["cat", 3, "tag"],
      ["dog", 1.1, "tag"],
      [":d", 1.1, "tag"],
    ]);
  });

  it("splits on new lines too", () => {
    expect(names("smile,\nstanding\noutdoors")).toEqual([
      ["smile", null, "tag"],
      ["standing", null, "tag"],
      ["outdoors", null, "tag"],
    ]);
  });
});

describe("removeSpan", () => {
  const text = "1girl, (sunflower field, blue sky:1.1), smile,\nstanding, x_\\(cosplay\\)";
  const without = (name: string) => {
    const t = promptTerms(text).find((x) => x.name === name)!;
    return removeSpan(text, t.start, t.end);
  };

  it("takes the first, a middle and the last term with their comma", () => {
    expect(without("1girl")).toBe("(sunflower field, blue sky:1.1), smile,\nstanding, x_\\(cosplay\\)");
    expect(without("standing")).toBe("1girl, (sunflower field, blue sky:1.1), smile,\nx_\\(cosplay\\)");
    expect(without("x_(cosplay)")).toBe("1girl, (sunflower field, blue sky:1.1), smile,\nstanding");
  });

  it("takes a group member and keeps the group's weight", () => {
    expect(without("sunflower_field")).toBe("1girl, (blue sky:1.1), smile,\nstanding, x_\\(cosplay\\)");
    expect(without("blue_sky")).toBe("1girl, (sunflower field:1.1), smile,\nstanding, x_\\(cosplay\\)");
  });

  it("takes a term's line break when lines separate them", () => {
    const cut = (text: string, name: string) => {
      const t = promptTerms(text).find((x) => x.name === name)!;
      return removeSpan(text, t.start, t.end);
    };
    expect(cut("smile\nstanding\noutdoors", "standing")).toBe("smile\noutdoors");
    expect(cut("smile\nstanding\noutdoors", "smile")).toBe("standing\noutdoors");
    expect(cut("smile,\nstanding", "standing")).toBe("smile");
    expect(cut("smile,\nstanding", "smile")).toBe("standing");
  });

  it("empties a prompt of one term", () => {
    expect(removeSpan("smile", 0, 5)).toBe("");
  });
});

describe("appendTag / replaceName", () => {
  it("adds after the last term, however the text ends", () => {
    expect(appendTag("a, b, ", "light_smile")).toBe("a, b, light smile");
    expect(appendTag("", "x_(y)")).toBe("x \\(y\\)");
  });

  it("swaps a name and keeps its weight", () => {
    const text = "1girl, (blowjob:1.2), solo";
    const t = promptTerms(text)[1];
    expect(replaceName(text, t, "fellatio")).toBe("1girl, (fellatio:1.2), solo");
  });
});

// The backend's prompt_parse is the authority on how a prompt splits; the
// fixture's `about` says what is compared.
const read = (text: string) =>
  promptTerms(text).map((t) =>
    t.kind === "lora" || t.kind === "embedding" ? [t.written.toLowerCase(), "network"] : [t.name, t.kind],
  );

describe("promptTerms agrees with the backend's prompt_parse", () => {
  for (const c of fixture.cases) {
    const want = c.terms.filter(([name]) => name);
    it(JSON.stringify(c.text), () => {
      expect(read(c.text)).toEqual(want);
    });
  }
});
