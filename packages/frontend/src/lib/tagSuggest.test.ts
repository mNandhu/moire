import { describe, expect, it } from "vitest";
import { rankSuggestions, suggestKeyAction } from "./tagSuggest";

const tags = Array.from({ length: 12 }, (_, i) => ({ _id: `any:bad_tag_${i}`, count: 100 - i }));
const resources = [
  { _id: "embedding:badhandv4", count: 364 },
  { _id: "lora:BadDream", count: 3 },
  { _id: "lora:NahidaXL", count: 40 },
];
const none = () => false;

describe("rankSuggestions", () => {
  it("keeps loras and embeddings below tags but never off the list", () => {
    const got = rankSuggestions("bad", tags, resources, none).map((s) => s._id);
    expect(got).toHaveLength(8);
    expect(got.slice(0, 6).every((id) => id.startsWith("any:"))).toBe(true);
    expect(got.slice(6)).toEqual(expect.arrayContaining(["embedding:badhandv4", "lora:BadDream"]));
  });

  it("lists only that kind behind a prefix", () => {
    expect(rankSuggestions("lora:", tags, resources, none).map((s) => s._id)).toEqual([
      "lora:NahidaXL",
      "lora:BadDream",
    ]);
    expect(rankSuggestions("emb:bdhand", tags, resources, none).map((s) => s._id)).toEqual([
      "embedding:badhandv4",
    ]);
  });

  it("offers nothing extra without resources (the rename dialog)", () => {
    expect(rankSuggestions("bad", tags, [], none).every((s) => s._id.startsWith("any:"))).toBe(true);
  });
});

describe("suggestKeyAction", () => {
  const open = { open: true, moved: false, enter: "highlight", tab: false } as const;
  const act = (key: string, s: Partial<Parameters<typeof suggestKeyAction>[1]> = {}, e = {}) =>
    suggestKeyAction({ key, ...e }, { ...open, ...s });

  it("takes no key while the list is closed", () => {
    for (const k of ["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"]) {
      expect(act(k, { open: false })).toBe("none");
    }
  });

  it("moves with the arrows but leaves Ctrl/Cmd+Arrow to the field", () => {
    expect(act("ArrowDown")).toBe("down");
    expect(act("ArrowUp")).toBe("up");
    expect(act("ArrowDown", {}, { ctrlKey: true })).toBe("none");
    expect(act("ArrowUp", {}, { metaKey: true })).toBe("none");
  });

  it("takes the highlighted row on Enter, or only after arrowing in moved mode", () => {
    expect(act("Enter")).toBe("accept");
    expect(act("Enter", { enter: "moved" })).toBe("none");
    expect(act("Enter", { enter: "moved", moved: true })).toBe("accept");
  });

  it("takes Tab only when asked to", () => {
    expect(act("Tab")).toBe("none");
    expect(act("Tab", { tab: true })).toBe("accept");
  });

  it("closes on Escape and ignores IME composition and other keys", () => {
    expect(act("Escape")).toBe("close");
    expect(act("Enter", {}, { isComposing: true })).toBe("none");
    expect(act("a")).toBe("none");
  });
});
