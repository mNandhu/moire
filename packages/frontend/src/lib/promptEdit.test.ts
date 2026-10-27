import { describe, expect, it } from "vitest";
import { bumpWeight, replaceTerm, termAt } from "./promptEdit";

describe("prompt autocomplete", () => {
  it("finds the term at the caret", () => {
    expect(termAt("sitting, gar", 12)).toEqual({ start: 9, end: 12, query: "gar" });
    expect(termAt("(smi", 4)).toEqual({ start: 1, end: 4, query: "smi" });
    expect(termAt("a, ", 3)).toBeNull();
    expect(termAt("(smile:1.", 9)).toBeNull();
    expect(termAt("embedding:eas", 13)?.query).toBe("embedding:eas");
  });

  it("splits where the prompt board does, but keeps a half-typed qualifier", () => {
    expect(termAt("cat | do", 8)).toEqual({ start: 6, end: 8, query: "do" });
    expect(termAt("hu_tao_(gen", 11)?.query).toBe("hu_tao_(gen");
  });

  it("replaces the term and moves on", () => {
    const text = "sitting, gar";
    expect(replaceTerm(text, termAt(text, 12)!, "garden")).toEqual({ text: "sitting, garden, ", caret: 17 });
    const mid = "gar, night";
    expect(replaceTerm(mid, termAt(mid, 3)!, "garden")).toEqual({ text: "garden, night", caret: 6 });
    expect(replaceTerm("(smi", termAt("(smi", 4)!, "smile").text).toBe("(smile, ");
  });
});

// `|` marks the caret, `[...]` the selection, in and out.
function press(marked: string, delta: number): string | null {
  const caret = marked.indexOf("|");
  const start = caret >= 0 ? caret : marked.indexOf("[");
  const text = marked.replace("|", "").replace("[", "").replace("]", "");
  const end = caret >= 0 ? caret : marked.indexOf("]") - 1;
  const r = bumpWeight(text, start, end, delta);
  if (!r) return null;
  return `${r.text.slice(0, r.start)}[${r.text.slice(r.start, r.end)}]${r.text.slice(r.end)}`;
}

describe("prompt weight keys", () => {
  it("wraps the term at the caret and keeps it selected", () => {
    expect(press("1girl, smi|le, solo", 0.05)).toBe("1girl, ([smile]:1.05), solo");
    expect(press("1girl, smi|le, solo", -0.05)).toBe("1girl, ([smile]:0.95), solo");
  });

  it("steps an existing weight, and unwraps at 1", () => {
    expect(press("1girl, ([smile]:1.05), solo", 0.05)).toBe("1girl, ([smile]:1.1), solo");
    expect(press("1girl, ([smile]:1.05), solo", -0.05)).toBe("1girl, [smile], solo");
    expect(press("(smi|le:1.2)", 0.05)).toBe("([smile]:1.25)");
  });

  it("starts from the weight ComfyUI reads, nesting and all", () => {
    expect(press("((smi|le))", 0.05)).toBe("([smile]:1.26)");
    // Square brackets and a bare `:1.05` are text to ComfyUI, not weights:
    // they go with the rewrite.
    expect(press("[smi|le]", 0.05)).toBe("([smile]:1.05)");
    expect(press("smi|le:1.05", 0.05)).toBe("([smile]:1.05)");
  });

  it("weighs a group member from the group's weight, and lets it fall back into it", () => {
    expect(press("(a|a, bb:1.2)", 0.05)).toBe("(([aa]:1.25), bb:1.2)");
    expect(press("(([aa]:1.25), bb:1.2)", -0.05)).toBe("([aa], bb:1.2)");
  });

  it("weighs a selection of several terms as one group", () => {
    expect(press("[cat, dog], rain", 0.05)).toBe("([cat, dog]:1.05), rain");
    expect(press("([cat, dog]:1.05), rain", 0.05)).toBe("([cat, dog]:1.1), rain");
    expect(press("[(cat, dog:1.1)], rain", -0.05)).toBe("([cat, dog]:1.05), rain");
    expect(press("([cat, dog]:1.05), rain", -0.05)).toBe("[cat, dog], rain");
  });

  it("keeps escapes and stops at 0", () => {
    expect(press("hu tao \\(gen|shin\\)", 0.05)).toBe("([hu tao \\(genshin\\)]:1.05)");
    expect(press("([smile]:0)", -0.05)).toBe("([smile]:0)");
  });

  it("leaves LoRAs and separators alone", () => {
    expect(press("<lora:x:0.8|>", 0.05)).toBeNull();
    expect(press("cat,|  dog", 0.05)).toBeNull();
  });
});
