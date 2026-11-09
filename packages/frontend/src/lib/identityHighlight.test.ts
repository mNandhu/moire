import { describe, expect, it } from "vitest";
import { identityNames, isIdentityTag, promptSegments } from "./identityHighlight";

const recipe = {
  tag: "hu_tao_(genshin_impact)",
  aliases: ["hutao"],
  identity: [
    { tag: "brown_hair", dropped: false, added: false },
    { tag: "red_eyes", dropped: false, added: false },
    { tag: "twintails", dropped: true, added: false },
  ],
};

describe("identityNames", () => {
  it("holds the tag, its aliases and the kept identity tags", () => {
    expect([...identityNames(recipe)].sort()).toEqual(["brown_hair", "hu_tao_(genshin_impact)", "hutao", "red_eyes"]);
  });
});

describe("isIdentityTag", () => {
  it("matches any kind of stored tag", () => {
    const names = identityNames(recipe);
    expect(isIdentityTag("brown_hair", names)).toBe(true);
    expect(isIdentityTag("prompt:red_eyes", names)).toBe(true);
    expect(isIdentityTag("manual:red_eyes", names)).toBe(true);
    expect(isIdentityTag("twintails", names)).toBe(false);
  });
});

describe("promptSegments", () => {
  const names = identityNames(recipe);
  const join = (s: { text: string }[]) => s.map((x) => x.text).join("");

  it("marks just the names, as written, and keeps the text whole", () => {
    const text = "1girl, hu tao \\(genshin impact\\), (brown hair:1.2), twintails, Red Eyes";
    const s = promptSegments(text, names);
    expect(join(s)).toBe(text);
    expect(s.filter((x) => x.hit).map((x) => x.text)).toEqual([
      "hu tao \\(genshin impact\\)",
      "brown hair",
      "Red Eyes",
    ]);
  });

  it("marks nothing without a match", () => {
    expect(promptSegments("1girl, smile", names)).toEqual([{ text: "1girl, smile", hit: false }]);
    expect(promptSegments("", names)).toEqual([]);
  });
});
