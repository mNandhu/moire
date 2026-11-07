import { describe, expect, it } from "vitest";
import { scrollTopFor } from "./scrollRow";

describe("scrollTopFor", () => {
  const list = { scrollTop: 100, clientHeight: 200 };
  it("leaves a row in view alone", () => {
    expect(scrollTopFor(list, { offsetTop: 150, offsetHeight: 30 })).toBeNull();
  });
  it("scrolls up to a row above", () => {
    expect(scrollTopFor(list, { offsetTop: 40, offsetHeight: 30 })).toBe(40);
  });
  it("scrolls down just enough for a row below", () => {
    expect(scrollTopFor(list, { offsetTop: 290, offsetHeight: 30 })).toBe(120);
  });
});
