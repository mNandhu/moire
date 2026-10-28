import { describe, expect, it } from "vitest";
import fixture from "../../../backend/tests/fixtures/mirrored/prompt_terms.json";
import { appendTag, promptTerms, removeTerms, replaceName } from "./promptOutline";

const names = (text: string) => promptTerms(text).map((t) => [t.name, t.weight ?? null, t.kind]);

describe("promptTerms", () => {
  it("reads weights, emphasis and escapes", () => {
    expect(names("1girl, (white dress:1.2), ((blue eyes)), [smile], x_\\(cosplay\\), (red bow:0.8)")).toEqual([
      ["1girl", null, "tag"],
      ["white_dress", 1.2, "tag"],
      ["blue_eyes", 1.21, "tag"],
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

  it("unwraps nested groups, x1.1 a layer; square brackets are text to ComfyUI", () => {
    expect(names("((sunflower field, blue sky)), [red bow, smile], ((solo))")).toEqual([
      ["sunflower_field", 1.21, "tag"],
      ["blue_sky", 1.21, "tag"],
      ["red_bow", null, "tag"],
      ["smile", null, "tag"],
      ["solo", 1.21, "tag"],
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
      ["cat", 1.32, true, "(cat)"],
      ["dog", 1.2, true, "dog"],
      ["smile", null, false, "smile:1.05"],
    ]);
  });

  it("takes an unbracketed decimal weight off the name, though ComfyUI ignores it", () => {
    expect(names("smile:1.05, 16:9, 12:00")).toEqual([
      ["smile", null, "tag"],
      ["16:9", null, "tag"],
      ["12:00", null, "tag"],
    ]);
  });

  it("reads an emoticon last in a group as a member, not the group's weight", () => {
    expect(names("(smile, :3)")).toEqual([
      ["smile", 1.1, "tag"],
      [":3", 1.1, "tag"],
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

// Remove the terms named `drop` (every copy), as the board does.
const cut = (text: string, ...drop: string[]) =>
  removeTerms(text, promptTerms(text).filter((x) => drop.includes(x.name)));

describe("removeTerms", () => {
  const text = "1girl, (sunflower field, blue sky:1.1), smile,\nstanding, x_\\(cosplay\\)";
  const without = (name: string) => {
    const t = promptTerms(text).find((x) => x.name === name)!;
    return removeTerms(text, [t]);
  };

  it("takes the first, a middle and the last term with their comma", () => {
    expect(without("1girl")).toBe("(sunflower field, blue sky:1.1), smile,\nstanding, x_\\(cosplay\\)");
    expect(without("standing")).toBe("1girl, (sunflower field, blue sky:1.1), smile,\nx_\\(cosplay\\)");
    expect(without("x_(cosplay)")).toBe("1girl, (sunflower field, blue sky:1.1), smile,\nstanding");
  });

  it("takes a stray backslash with the term it borders", () => {
    expect(cut("smile, trailing\\", "trailing")).toBe("smile");
    expect(cut("a, \\[smile]", "smile")).toBe("a");
    expect(cut("\\\\foo, b", "foo")).toBe("b");
    expect(cut("a, furina \\\\(genshin impact\\\\)", "furina_(genshin_impact)")).toBe("a");
  });

  it("takes a group member and keeps the group's weight", () => {
    expect(without("sunflower_field")).toBe("1girl, (blue sky:1.1), smile,\nstanding, x_\\(cosplay\\)");
    expect(without("blue_sky")).toBe("1girl, (sunflower field:1.1), smile,\nstanding, x_\\(cosplay\\)");
  });

  it("takes a term's line break when lines separate them", () => {
    expect(cut("smile\nstanding\noutdoors", "standing")).toBe("smile\noutdoors");
    expect(cut("smile\nstanding\noutdoors", "smile")).toBe("standing\noutdoors");
    expect(cut("smile,\nstanding", "standing")).toBe("smile");
    expect(cut("smile,\nstanding", "smile")).toBe("standing");
  });

  it("empties a prompt of one term", () => {
    expect(removeTerms("smile", [{ start: 0, end: 5 }])).toBe("");
  });

  it("takes one separator of any kind, BREAK and AND included", () => {
    expect(cut("a | b | c", "b")).toBe("a | c");
    expect(cut("a | b", "b")).toBe("a");
    expect(cut("a BREAK b", "b")).toBe("a");
    expect(cut("a BREAK b, c", "a")).toBe("b, c");
    expect(cut("a, b BREAK c", "c")).toBe("a, b");
    expect(cut("a AND b", "a")).toBe("b");
    // The stronger separator stays between what is left.
    expect(cut("a, b BREAK c", "b")).toBe("a BREAK c");
    expect(cut("a BREAK b, c", "b")).toBe("a BREAK c");
  });

  it("takes a group whose members all go, and keeps its weight while one is left", () => {
    expect(cut("(x, y:1.2), z", "x", "y")).toBe("z");
    expect(cut("a, (x, y:1.2), z", "x", "y")).toBe("a, z");
    expect(cut("a, ((x, y), w:1.2)", "x", "y")).toBe("a, (w:1.2)");
    expect(cut("a, ((x, y), w:1.2)", "x", "y", "w")).toBe("a");
    expect(cut("(x, y:1.2)", "y")).toBe("(x:1.2)");
  });

  it("takes a prompt edit whole when either side goes", () => {
    expect(cut("a, [from:to:0.5], b", "from")).toBe("a, b");
    expect(cut("a, [from:to:0.5], b", "to")).toBe("a, b");
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
  promptTerms(text).map((t) => [
    ...(t.kind === "lora" || t.kind === "embedding" ? [t.written.toLowerCase(), "network"] : [t.name, t.kind]),
    t.weight ?? 1,
  ]);

describe("promptTerms agrees with the backend's prompt_parse", () => {
  for (const c of fixture.cases) {
    const want = c.terms.filter(([name]) => name).map(([name, kind, comfyui]) => [name, kind, comfyui]);
    it(JSON.stringify(c.text), () => {
      expect(read(c.text)).toEqual(want);
    });
  }
});
