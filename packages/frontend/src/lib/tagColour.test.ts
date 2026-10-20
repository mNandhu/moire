import { describe, expect, it } from "vitest";
import { chipBorderStyle, colourWord, isMulticolour, tagColour, tagMarkStyle } from "./tagColour";

describe("colourWord", () => {
  it("reads the colour from hair and eye tags", () => {
    expect(colourWord("blue_eyes")).toBe("blue");
    expect(colourWord("red_hair")).toBe("red");
    expect(colourWord("light_blue_hair")).toBe("light_blue");
    expect(colourWord("large_innocent_green_eyes")).toBe("green");
    expect(colourWord("black_hair")).toBe("black");
  });

  it("reads through the kind prefix", () => {
    expect(colourWord("prompt:pink_hair")).toBe("pink");
    expect(colourWord("manual:aqua_eyes")).toBe("aqua");
  });

  it("ignores tags that aren't a coloured hair or eye tag", () => {
    expect(colourWord("closed_eyes")).toBeNull();
    expect(colourWord("long_hair")).toBeNull();
    expect(colourWord("red_dress")).toBeNull();
    expect(colourWord("blue_hair_ornament")).toBeNull();
    expect(colourWord("hair")).toBeNull();
  });
});

describe("tagColour", () => {
  it("gives CSS for a coloured tag, null otherwise", () => {
    expect(tagColour("blue_eyes")).toBe("hsl(215 70% 55%)");
    expect(tagColour("smile")).toBeNull();
  });
});

describe("isMulticolour", () => {
  it("knows the multicolour hair and eye tags", () => {
    expect(isMulticolour("multicolored_hair")).toBe(true);
    expect(isMulticolour("heterochromia")).toBe(true);
    expect(isMulticolour("prompt:gradient_hair")).toBe(true);
    expect(isMulticolour("blue_hair")).toBe(false);
  });
});

describe("tagMarkStyle", () => {
  const ground = "#15141c";

  it("rings a coloured tag and tints by facet", () => {
    expect(tagMarkStyle("red_hair", "look", ground)).toEqual({
      backgroundColor: "rgb(251 113 133 / 0.10)",
      boxShadow: "inset 0 0 0 1px hsl(355 70% 52%)",
    });
  });

  it("tints alone when there is no colour, nothing when neither", () => {
    expect(tagMarkStyle("serafuku", "outfit", ground)).toEqual({ backgroundColor: "rgb(252 211 77 / 0.08)" });
    expect(tagMarkStyle("1girl", null, ground)).toBeUndefined();
  });

  it("paints a rainbow border under the fill for multicolour tags", () => {
    const style = tagMarkStyle("multicolored_hair", "look", ground);
    expect(style?.border).toBe("1px solid transparent");
    expect(String(style?.background)).toMatch(/^linear-gradient\(rgb\(251 113 133 \/ 0.10\).*linear-gradient\(#15141c, #15141c\) padding-box, conic-gradient/);
  });
});

describe("chipBorderStyle", () => {
  it("colours a chip's border, or leaves it alone", () => {
    expect(chipBorderStyle("blue_eyes")).toEqual({ borderColor: "hsl(215 70% 55%)" });
    expect(chipBorderStyle("smile")).toBeUndefined();
    expect(chipBorderStyle("heterochromia")?.borderColor).toBe("transparent");
  });
});
