import { describe, expect, it } from "vitest";
import { dropSide } from "./dropSide";

describe("dropSide", () => {
  it("opens below when the whole list fits there", () => {
    expect(dropSide(50, 400, 288)).toEqual({ up: false, max: 288 });
  });

  it("opens up when it doesn't fit below and there's more room above", () => {
    // A phone: the field just above the keyboard.
    expect(dropSide(300, 60, 288)).toEqual({ up: true, max: 288 });
    expect(dropSide(200, 60, 288)).toEqual({ up: true, max: 192 });
  });

  it("stays below, shortened, when below still has more room", () => {
    expect(dropSide(100, 200, 288)).toEqual({ up: false, max: 192 });
  });
});
