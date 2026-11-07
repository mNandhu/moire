import { describe, expect, it } from "vitest";
import { pastedLink, refill } from "./pictureTags";

describe("refill", () => {
  it("adds a picture's tags after the hand-added ones", () => {
    expect(refill(["halo"], [], ["long_hair", "halo", "blue_eyes"])).toEqual({
      tags: ["halo", "long_hair", "blue_eyes"],
      added: ["long_hair", "blue_eyes"],
    });
  });

  it("a second picture replaces the first one's tags, keeping hand-added ones", () => {
    const first = refill(["halo"], [], ["long_hair", "blue_eyes"]);
    expect(refill(first.tags, first.added, ["short_hair"]).tags).toEqual(["halo", "short_hair"]);
  });

  it("skips taken tags and caps the count", () => {
    const r = refill([], [], ["a", "b", "c", "d"], new Set(["b"]), 2);
    expect(r.tags).toEqual(["a", "c"]);
  });

  it("keeps a removed tag removed", () => {
    const first = refill([], [], ["a", "b"]);
    const afterRemove = first.tags.filter((t) => t !== "a");
    expect(refill(afterRemove, first.added, ["c"]).tags).toEqual(["c"]);
  });
});

describe("pastedLink", () => {
  it("takes one http(s) link", () => {
    expect(pastedLink("  https://x.example/a.png ")).toBe("https://x.example/a.png");
    expect(pastedLink("http://x.example/a b")).toBeNull();
    expect(pastedLink("fern_(sousou_no_frieren)")).toBeNull();
    expect(pastedLink("javascript:alert(1)")).toBeNull();
  });
});
