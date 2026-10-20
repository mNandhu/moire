import { describe, expect, it } from "vitest";
import { checkCountTags, expectedTags, fixCountTags } from "./countTags";

const flagged = (prompt: string, kinds: Parameters<typeof checkCountTags>[1]) =>
  checkCountTags(prompt, kinds).marks.map((m) => m.text);

describe("expectedTags", () => {
  it("follows Danbooru's convention", () => {
    expect(expectedTags(["girl"])).toEqual(["1girl", "solo"]);
    expect(expectedTags(["girl", "girl"])).toEqual(["2girls", "multiple_girls"]);
    expect(expectedTags(["girl", "boy"])).toEqual(["1girl", "1boy"]);
    expect(expectedTags(["girl", "boy", "girl"])).toEqual(["2girls", "1boy", "multiple_girls"]);
    expect(expectedTags(["boy", "boy"])).toEqual(["2boys", "multiple_boys"]);
    expect(expectedTags(Array(7).fill("girl"))).toEqual(["6+girls", "multiple_girls"]);
  });
});

describe("checkCountTags", () => {
  it("is quiet without characters or when the prompt fits", () => {
    expect(checkCountTags("1girl, solo", []).marks).toEqual([]);
    expect(flagged("1girl, solo, smile", ["girl"])).toEqual([]);
    expect(flagged("1girl, 1boy, park", ["girl", "boy"])).toEqual([]);
    expect(flagged("2girls, multiple_girls", ["girl", "girl"])).toEqual([]);
  });

  it("flags what contradicts the cast", () => {
    expect(flagged("1girl, solo, park", ["girl", "girl"])).toEqual(["1girl", "solo"]);
    expect(flagged("2girls, cafe", ["girl", "boy"])).toEqual(["2girls"]);
    expect(flagged("1girl, 1boy", ["girl", "girl"])).toEqual(["1girl", "1boy"]);
    expect(flagged("multiple_boys, 1boy", ["boy"])).toEqual(["multiple_boys"]);
    // 6+ means six or more
    expect(flagged("6+girls, multiple_girls", Array(7).fill("girl"))).toEqual([]);
    expect(flagged("6+girls", Array(5).fill("girl"))).toEqual(["6+girls"]);
  });

  it("reads spaces, underscores and weights", () => {
    expect(flagged("(1girl:1.2), 2 boys, [solo]", ["boy", "boy"])).toEqual(["(1girl:1.2)", "[solo]"]);
    const m = checkCountTags("park,  1girl", ["boy"]).marks[0];
    expect([m.start, m.end]).toEqual([7, 12]);
  });

  it("with an unknown kind, flags only what is wrong whatever it is", () => {
    expect(flagged("1girl, 1boy, solo", ["girl", null])).toEqual(["solo"]);
    expect(flagged("3girls", ["girl", null])).toEqual(["3girls"]);
    expect(checkCountTags("1girl", ["girl", null]).expected).toBeNull();
  });

  it("says why in plain words", () => {
    const [m] = checkCountTags("solo", ["girl", "boy"]).marks;
    expect(m.reason).toBe("1 girl and 1 boy are picked, so this isn't a solo image.");
    expect(checkCountTags("2girls", ["girl", "boy"]).marks[0].reason).toBe("The cast has 1 girl, not 2.");
  });
});

describe("fixCountTags", () => {
  it("swaps every count tag for the expected set, where the first stood", () => {
    expect(fixCountTags("masterpiece, 1girl, solo, park", ["2girls", "multiple_girls"])).toBe(
      "masterpiece, 2girls, multiple_girls, park",
    );
    expect(fixCountTags("1girl, solo", ["1girl", "1boy"])).toBe("1girl, 1boy");
    expect(fixCountTags("park, solo", ["1girl", "1boy"])).toBe("park, 1girl, 1boy");
  });

  it("puts the set first when there was none", () => {
    expect(fixCountTags("park, smile", ["1girl", "1boy"])).toBe("1girl, 1boy, park, smile");
    expect(fixCountTags("", ["1girl", "solo"])).toBe("1girl, solo");
  });

  it("keeps lines and the rest of the text", () => {
    expect(fixCountTags("1girl, solo,\nsitting, rain", ["2girls"])).toBe("2girls,\nsitting, rain");
    expect(fixCountTags("1girl, smile, solo\nrain", ["2girls"])).toBe("2girls, smile,\nrain");
  });

  it("leaves weighted groups whole", () => {
    expect(flagged("(1girl, smile:1.2), park", ["girl", "girl"])).toEqual([]);
    expect(fixCountTags("(1girl, smile:1.2), solo", ["2girls"])).toBe("(1girl, smile:1.2), 2girls");
    // The middle of a group too, not just its ends.
    expect(flagged("(1girl, solo, smile:1.2), park", ["girl", "girl"])).toEqual([]);
    expect(fixCountTags("(smile, solo, rain:1.2), 1girl", ["2girls"])).toBe("(smile, solo, rain:1.2), 2girls");
    expect(flagged("[a, (b, solo), c], 1girl", ["girl", "girl"])).toEqual(["1girl"]);
  });
});
