import { describe, expect, it } from "vitest";
import { smallThumb } from "./media";

describe("smallThumb", () => {
  it("asks the thumb route for its small copy", () => {
    expect(smallThumb("/api/v1/images/L1%3Aa.png/thumb")).toBe("/api/v1/images/L1%3Aa.png/thumb?size=small");
    expect(smallThumb("/x/thumb?v=2")).toBe("/x/thumb?v=2&size=small");
  });

  it("passes no URL through", () => {
    expect(smallThumb(null)).toBeNull();
    expect(smallThumb(undefined)).toBeNull();
  });
});
