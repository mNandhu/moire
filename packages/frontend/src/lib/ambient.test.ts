import { afterEach, describe, expect, it } from "vitest";
import { applyAmbient, normalizePalette, restoreAmbient, tintAmbient } from "./ambient";

const A = "hsl(230 80% 55%)";
const B = "hsl(10 70% 55%)";
const root = () => document.documentElement.style;

afterEach(() => {
  localStorage.clear();
  ["--amb1", "--amb2", "--amb3"].forEach((v) => root().removeProperty(v));
});

describe("normalizePalette", () => {
  it("pads to three colours by repeating the first", () => {
    expect(normalizePalette([A, B])).toEqual([A, B, A]);
  });

  it("rejects anything that is not a palette colour", () => {
    expect(normalizePalette("hsl(1 1% 1%)")).toBeNull();
    expect(normalizePalette([])).toBeNull();
    expect(normalizePalette(["red; background: url(x)", 3])).toBeNull();
  });
});

describe("applyAmbient / restoreAmbient", () => {
  it("sets the CSS variables and restores them on the next load", () => {
    applyAmbient([A, B]);
    expect(root().getPropertyValue("--amb1")).toBe(A);
    expect(root().getPropertyValue("--amb2")).toBe(B);

    root().removeProperty("--amb1");
    restoreAmbient();
    expect(root().getPropertyValue("--amb1")).toBe(A);
  });

  it("ignores an empty palette, keeping the last one", () => {
    applyAmbient([A]);
    applyAmbient([]);
    expect(root().getPropertyValue("--amb1")).toBe(A);
  });

  it("survives corrupt storage", () => {
    localStorage.setItem("ambient:palette", "{not json");
    expect(() => restoreAmbient()).not.toThrow();
    expect(root().getPropertyValue("--amb1")).toBe("");
  });
});

describe("tintAmbient", () => {
  it("lights the wash for one page and puts the old palette back, storing nothing", () => {
    applyAmbient([A]);
    localStorage.clear();
    const undo = tintAmbient(["#112233", "#445566"]);
    expect(root().getPropertyValue("--amb1")).toBe("#112233");
    expect(root().getPropertyValue("--amb3")).toBe("#112233");
    expect(localStorage.length).toBe(0);
    undo();
    expect(root().getPropertyValue("--amb1")).toBe(A);
  });

  it("removes what it set when nothing was set before", () => {
    tintAmbient(["#112233"])();
    expect(root().getPropertyValue("--amb1")).toBe("");
  });
});
