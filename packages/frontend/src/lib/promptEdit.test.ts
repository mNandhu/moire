import { describe, expect, it } from "vitest";
import { replaceTerm, termAt } from "./promptEdit";

describe("prompt autocomplete", () => {
  it("finds the term at the caret", () => {
    expect(termAt("sitting, gar", 12)).toEqual({ start: 9, end: 12, query: "gar" });
    expect(termAt("(smi", 4)).toEqual({ start: 1, end: 4, query: "smi" });
    expect(termAt("a, ", 3)).toBeNull();
    expect(termAt("(smile:1.", 9)).toBeNull();
    expect(termAt("embedding:eas", 13)?.query).toBe("embedding:eas");
  });

  it("replaces the term and moves on", () => {
    const text = "sitting, gar";
    expect(replaceTerm(text, termAt(text, 12)!, "garden")).toEqual({ text: "sitting, garden, ", caret: 17 });
    const mid = "gar, night";
    expect(replaceTerm(mid, termAt(mid, 3)!, "garden")).toEqual({ text: "garden, night", caret: 6 });
    expect(replaceTerm("(smi", termAt("(smi", 4)!, "smile").text).toBe("(smile, ");
  });
});
