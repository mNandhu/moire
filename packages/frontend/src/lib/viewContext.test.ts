import { describe, expect, it } from "vitest";
import { contextPage, contextState, getViewContext, withoutContext } from "./viewContext";

describe("view context", () => {
  it("rides in the history state when named", () => {
    expect(getViewContext({ state: { backgroundLocation: {}, ...contextState("Top rated") } })).toBe("Top rated");
  });

  it("names the page it was opened on", () => {
    expect(contextPage("/")).toBe("All Images");
    expect(contextPage("/discover")).toBe("Discover");
    expect(contextPage("/overview")).toBe("Overview");
    expect(contextPage("/characters/furina")).toBe("Characters");
    expect(contextPage("/tags")).toBe("Tags");
    expect(contextPage("/tags/blue_eyes")).toBe("Tags");
    expect(contextPage("/tagsx")).toBeUndefined();
    expect(contextPage("/generate")).toBeUndefined();
    expect(contextPage(undefined)).toBeUndefined();
  });

  it("can be dropped, keeping the rest of the state", () => {
    const state = { backgroundLocation: { pathname: "/discover" }, ...contextState("Top rated") };
    expect(withoutContext(state)).toEqual({ backgroundLocation: { pathname: "/discover" } });
    expect(getViewContext({ state: withoutContext(state) })).toBeUndefined();
    expect(withoutContext(null)).toBeNull();
  });

  it("is nothing unnamed, or with no state", () => {
    expect(contextState(undefined)).toEqual({});
    expect(getViewContext({ state: contextState("") })).toBeUndefined();
    expect(getViewContext({ state: null })).toBeUndefined();
    expect(getViewContext({ state: { context: 3 } })).toBeUndefined();
  });
});
