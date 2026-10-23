import { describe, expect, it } from "vitest";
import { imageFileUrl, smallThumb } from "./media";

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

describe("smallThumb on a versioned URL", () => {
  it("keeps the version", () => {
    expect(smallThumb("/api/v1/images/L1%3Aa/thumb?v=3d55dd6ddd37")).toBe("/api/v1/images/L1%3Aa/thumb?v=3d55dd6ddd37&size=small");
  });
});

describe("imageFileUrl", () => {
  it("is the original's route, the id encoded", () => {
    expect(imageFileUrl("L1:a/b.png")).toBe("/api/v1/images/L1%3Aa%2Fb.png/file");
  });
});
