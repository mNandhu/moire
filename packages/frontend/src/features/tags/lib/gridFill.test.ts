import { describe, expect, it } from "vitest";
import { fillLastRow } from "./gridFill";

describe("fillLastRow", () => {
  it("rounds up to whole rows while more are left", () => {
    expect(fillLastRow(60, 7, 200)).toBe(63);
    expect(fillLastRow(60, 6, 200)).toBe(60);
  });

  it("never shows more than there are", () => {
    expect(fillLastRow(60, 7, 62)).toBe(62);
    expect(fillLastRow(60, 7, 40)).toBe(40);
  });

  it("leaves a single column alone", () => {
    expect(fillLastRow(60, 1, 200)).toBe(60);
  });
});
