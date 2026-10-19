import { describe, expect, it } from "vitest";
import {
  avatarCrop,
  characterColours,
  characterFilters,
  characterHref,
  characterName,
  displayName,
  focusPosition,
} from "./character";

describe("characterName", () => {
  it("splits the series off", () => {
    expect(characterName("nahida_(genshin_impact)")).toEqual({
      name: "nahida",
      series: "genshin impact",
    });
    expect(characterName("2b_(nier:automata)")).toEqual({ name: "2b", series: "nier:automata" });
    expect(characterName("holo")).toEqual({ name: "holo", series: null });
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
