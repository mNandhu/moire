import { describe, expect, it } from "vitest";
import { pickRating, ratingBadgeClass, ratingDotClass } from "./rating";
import { imageDetail as doc } from "../test/images";

describe("pickRating", () => {
  it("prefers the explicit rating when set", () => {
    expect(pickRating(doc({ rating: "sensitive" }))).toBe("sensitive");
  });

  it("falls back to the highest-scoring AI rating", () => {
    expect(
      pickRating(doc({ ai: { rating: { general: 0.1, explicit: 0.9 } } })),
    ).toBe("explicit");
  });

  it("returns '-' for no rating at all", () => {
    expect(pickRating(doc({}))).toBe("-");
    expect(pickRating(null)).toBe("-");
  });

  it("ignores non-numeric AI scores", () => {
    expect(
      pickRating(doc({ ai: { rating: { a: "x" as unknown as number, b: 0.5 } } })),
    ).toBe("b");
  });
});

describe("ratingBadgeClass", () => {
  it("maps known ratings to distinct classes and unknowns to neutral", () => {
    expect(ratingBadgeClass("general")).toContain("emerald");
    expect(ratingBadgeClass("safe")).toContain("neutral");
    expect(ratingBadgeClass("explicit")).toContain("red");
    expect(ratingBadgeClass("-")).toContain("neutral");
    expect(ratingBadgeClass("???")).toContain("neutral");
  });
});

describe("ratingDotClass", () => {
  it("colours the ratings worth flagging", () => {
    expect(ratingDotClass("sensitive")).toContain("amber");
    expect(ratingDotClass("questionable")).toContain("orange");
    expect(ratingDotClass("explicit")).toContain("red");
  });

  it("draws nothing for the unremarkable or unrated cases", () => {
    expect(ratingDotClass("general")).toBeNull();
    expect(ratingDotClass("-")).toBeNull();
    expect(ratingDotClass("")).toBeNull();
    expect(ratingDotClass(undefined)).toBeNull();
  });
});
