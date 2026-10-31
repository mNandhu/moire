import { describe, expect, it } from "vitest";
import { cleanPrompt, cleanupWords } from "./promptCleanup";

describe("cleanPrompt", () => {
  it("keeps a repeated plain tag at its first place, spaces and underscores alike", () => {
    const c = cleanPrompt("1girl, red hair, smile, red_hair, 1girl");
    expect(c.text).toBe("1girl, red hair, smile");
    expect(c.repeats).toBe(2);
  });

  it("leaves weighted, bracketed and grouped repeats alone", () => {
    const text = "smile, (smile:1.2), (eula, smile) AND (furina, smile)";
    expect(cleanPrompt(text).text).toBe(text);
  });

  it("drops doubled, leading and trailing commas and spaces before one", () => {
    const c = cleanPrompt(", 1girl,, smile , ,garden,  ");
    expect(c.text).toBe("1girl, smile,garden");
    expect(c.commas).toBe(4);
  });

  it("keeps an escaped comma and the lines as written", () => {
    expect(cleanPrompt("a\\, b, c").text).toBe("a\\, b, c");
    expect(cleanPrompt("1girl, smile,\nsky, cloud\n\nBREAK\nsea").text).toBe("1girl, smile,\nsky, cloud\n\nBREAK\nsea");
  });

  it("leaves a repeat across BREAK or AND alone", () => {
    expect(cleanPrompt("eula, smile AND furina, smile").text).toBe("eula, smile AND furina, smile");
    expect(cleanPrompt("1girl, red hair BREAK 1girl, sky").text).toBe("1girl, red hair BREAK 1girl, sky");
    expect(cleanPrompt("1girl, smile BREAK sky, sky").text).toBe("1girl, smile BREAK sky");
  });

  it("keeps a line's leading comma when it is the only one between two lines", () => {
    expect(cleanPrompt("1girl, smile\n, garden").text).toBe("1girl, smile\n, garden");
    expect(cleanPrompt("1girl, smile,\n, garden").text).toBe("1girl, smile,\ngarden");
  });

  it("leaves trailing space alone with no comma there", () => {
    expect(cleanPrompt("1girl, smile  \n").text).toBe("1girl, smile  \n");
  });

  it("drops a line that was only commas", () => {
    expect(cleanPrompt("1girl,\n, ,\nsmile").text).toBe("1girl,\nsmile");
  });

  it("changes nothing on a tidy prompt", () => {
    expect(cleanPrompt("1girl, smile")).toEqual({ text: "1girl, smile", repeats: 0, commas: 0 });
  });
});

describe("cleanupWords", () => {
  it("says what it would remove", () => {
    expect(cleanupWords({ text: "", repeats: 1, commas: 2 }, true)).toBe("Remove 1 repeated tag and 2 stray commas");
    expect(cleanupWords({ text: "", repeats: 0, commas: 0 }, true)).toBe("Tidy the commas");
    expect(cleanupWords({ text: "", repeats: 0, commas: 0 }, false)).toBeNull();
  });
});
