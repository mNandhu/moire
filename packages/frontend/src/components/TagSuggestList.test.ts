import { describe, expect, it } from "vitest";
import { rankSuggestions } from "./TagSuggestList";

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
