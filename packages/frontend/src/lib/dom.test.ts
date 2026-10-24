import { describe, expect, it } from "vitest";
import { hasModifier, isFormField, scrollParent } from "./dom";

function el(tag: string): HTMLElement {
  return document.createElement(tag);
}

describe("isFormField", () => {
  it("is true for input/textarea/select", () => {
    expect(isFormField(el("input"))).toBe(true);
    expect(isFormField(el("textarea"))).toBe(true);
    expect(isFormField(el("select"))).toBe(true);
  });

  it("is true for a contentEditable element", () => {
    // jsdom doesn't reflect the contenteditable attribute onto the
    // isContentEditable property, so duck-type the target the handler sees.
    const target = { tagName: "DIV", isContentEditable: true } as HTMLElement;
    expect(isFormField(target)).toBe(true);
  });

  it("is false for a plain element and for null", () => {
    expect(isFormField(el("div"))).toBe(false);
    expect(isFormField(el("button"))).toBe(false);
    expect(isFormField(null)).toBe(false);
  });
});

describe("hasModifier", () => {
  it("flags Ctrl, Cmd and Alt but not a bare key", () => {
    const k = { ctrlKey: false, metaKey: false, altKey: false };
    expect(hasModifier(k)).toBe(false);
    expect(hasModifier({ ...k, ctrlKey: true })).toBe(true);
    expect(hasModifier({ ...k, metaKey: true })).toBe(true);
    expect(hasModifier({ ...k, altKey: true })).toBe(true);
  });
});

describe("scrollParent", () => {
  it("finds the nearest vertically scrolling ancestor", () => {
    const outer = el("div");
    outer.style.overflowY = "scroll";
    const scroller = el("div");
    scroller.style.overflowY = "auto";
    const plain = el("div");
    const leaf = el("div");
    outer.append(scroller);
    scroller.append(plain);
    plain.append(leaf);
    document.body.append(outer);
    expect(scrollParent(leaf)).toBe(scroller);
    outer.remove();
  });

  it("is null when nothing above scrolls", () => {
    const leaf = el("div");
    document.body.append(leaf);
    expect(scrollParent(leaf)).toBeNull();
    expect(scrollParent(null)).toBeNull();
    leaf.remove();
  });
});
