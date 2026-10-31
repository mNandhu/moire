import { describe, expect, it } from "vitest";
import partCases from "../../../backend/tests/fixtures/mirrored/character_parts.json";
import {
  fewImagesNote,
  mixColours,
  avatarCrop,
  inkOn,
  characterColours,
  characterFilters,
  characterHref,
  characterName,
  characterParts,
  displayName,
  focusPosition,
} from "./character";

describe("characterName", () => {
  it.each(partCases.cases)("splits $tag like the backend's character_parts", (c) => {
    expect(characterParts(c.tag)).toEqual(c.series === null ? null : { name: c.name, series: c.series });
  });

  it("shows each part with spaces", () => {
    expect(characterName("hu_tao_(genshin_impact)")).toEqual({ name: "hu tao", series: "genshin impact" });
    expect(characterName("manual:nahida_(genshin_impact)")).toEqual({ name: "nahida", series: "genshin impact" });
    expect(characterName("a_(b)_(c)")).toEqual({ name: "a (b) (c)", series: null });
    expect(characterName("^_^_(x_y)")).toEqual({ name: "^_^", series: "x y" });
  });
});

describe("displayName", () => {
  it("prefers what the user set", () => {
    expect(displayName({ tag: "furina_(genshin_impact)", name: "Furina" })).toEqual({
      name: "Furina",
      series: "genshin impact",
    });
    expect(displayName({ tag: "my_oc", name: null, series: "Mine" })).toEqual({
      name: "my oc",
      series: "Mine",
    });
  });
});

describe("characterHref", () => {
  it("keeps parentheses inside one path segment", () => {
    expect(characterHref("hu_tao_(genshin_impact)")).toBe("/characters/hu_tao_(genshin_impact)");
    expect(characterHref("2b_(nier:automata)")).toBe("/characters/2b_(nier%3Aautomata)");
  });
});

describe("characterFilters", () => {
  it("matches any of the character's names", () => {
    const f = characterFilters("furina_(genshin_impact)", ["furina"]);
    expect(f.tags).toEqual(["any:furina_(genshin_impact)", "any:furina"]);
    expect(f.logic).toBe("or");
    expect(characterFilters("holo", []).logic).toBe("and");
  });
});

describe("focusPosition", () => {
  it("centres without a focus and clamps one", () => {
    expect(focusPosition(null)).toBe("50% 50%");
    expect(focusPosition([0.25, 1.4])).toBe("25% 100%");
  });
});

describe("characterColours", () => {
  it("puts the user's colour first and fills three", () => {
    expect(
      characterColours({ color: "#112233", palette: ["hsl(1 2% 3%)"], cover_blurhash: null }),
    ).toEqual(["#112233", "hsl(1 2% 3%)", "#112233"]);
  });
  it("uses the tag palette, else nothing without a cover", () => {
    expect(
      characterColours({ color: null, palette: ["a", "b"], cover_blurhash: null }),
    ).toEqual(["a", "b", "a"]);
    expect(characterColours({ color: null, palette: [], cover_blurhash: null })).toEqual([]);
  });
});

describe("avatarCrop", () => {
  it("zooms to a found face", () => {
    // A 0.7-wide portrait, face at the top centre, a fifth of the width.
    const crop = avatarCrop({ face: [0.5, 0.2, 0.2, 0.14], focus: null, aspect: 0.7 });
    // side = max(0.14, 0.14) * 2.5 = 0.35 of the height
    expect(crop).toEqual({ width: "200%", height: "285.71%", left: "-50%", top: "-7.14%" });
  });
  it("keeps the crop inside the image", () => {
    const crop = avatarCrop({ face: [0.02, 0.01, 0.1, 0.07], focus: null, aspect: 0.7 });
    expect(crop?.left).toBe("0%");
    expect(crop?.top).toBe("0%");
  });
  it("moves to the user's point, keeping the face's zoom", () => {
    const crop = avatarCrop({ face: [0.5, 0.2, 0.2, 0.14], focus: [0.5, 0.6], aspect: 0.7 });
    expect(crop?.width).toBe("200%");
    expect(crop?.top).toBe("-121.43%");
  });
  it("shows the whole width a third down without a face", () => {
    expect(avatarCrop({ face: null, focus: null, aspect: 0.5 })).toEqual({
      width: "100%",
      height: "200%",
      left: "0%",
      top: "-16.67%",
    });
    expect(avatarCrop({ face: null, focus: null, aspect: null })).toBeNull();
  });
});

describe("avatarCrop in a portrait frame", () => {
  it("shows more around the face, the frame's shape", () => {
    // 3:4 card, face a fifth wide: short side 0.14 * 4.5 = 0.63 of the height
    const crop = avatarCrop({ face: [0.5, 0.2, 0.2, 0.14], focus: null, aspect: 0.7 }, 0.75, 4.5);
    // h = min(fit 0.933, 0.63 / 0.75 = 0.84) = 0.84, w = 0.63
    expect(crop?.width).toBe("111.11%");
    expect(crop?.height).toBe("119.05%");
  });
  it("fits the whole width when the face is large", () => {
    const crop = avatarCrop({ face: [0.5, 0.3, 0.6, 0.5], focus: null, aspect: 0.7 }, 0.75, 4.5);
    expect(crop?.width).toBe("100%");
    expect(crop?.left).toBe("0%");
  });
});

describe("inkOn", () => {
  it("picks the text that reads", () => {
    expect(inkOn("hsl(48 85% 55%)")).toBe("dark");
    expect(inkOn("hsl(222 60% 35%)")).toBe("light");
    expect(inkOn("#ffffff")).toBe("dark");
    expect(inkOn("#112233")).toBe("light");
    expect(inkOn("red")).toBe("light");
  });
});

describe("mixColours", () => {
  it("takes one colour from each character before anyone's second", () => {
    expect(mixColours([["a1", "a2", "a3"]])).toEqual(["a1", "a2", "a3"]);
    expect(mixColours([["a1", "a2", "a3"], ["b1", "b2"]])).toEqual(["a1", "b1", "a2"]);
    expect(mixColours([["a1"], [], ["c1"], ["d1"], ["e1"]])).toEqual(["a1", "c1", "d1"]);
    expect(mixColours([[], []])).toEqual([]);
  });
});

describe("fewImagesNote", () => {
  it("speaks up only for a handful of images", () => {
    expect(fewImagesNote(1)).toBe("Based on just 1 image, so this may be off.");
    expect(fewImagesNote(3)).toBe("Based on just 3 images, so this may be off.");
    expect(fewImagesNote(5)).toBeNull();
    expect(fewImagesNote(0)).toBeNull();
  });
});
