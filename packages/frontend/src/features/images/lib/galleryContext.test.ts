import { describe, expect, it } from "vitest";
import { galleryContext } from "./galleryContext";

describe("galleryContext", () => {
  it("is nothing for the whole library", () => {
    expect(galleryContext([], [])).toBeUndefined();
  });

  it("names the library tab, then the search, then the filters", () => {
    expect(galleryContext(["blue_eyes", "lora:Detail"], [{ label: "Score 4+" }], { library: "Renders" })).toBe(
      "Renders · blue eyes · lora:Detail · Score 4+",
    );
  });

  it("names a batch drilled into, which the chips leave out", () => {
    expect(galleryContext([], [], { batch: true })).toBe("Batch");
  });

  it("spells a tag of any kind with spaces", () => {
    expect(galleryContext(["any:blue_hair", "manual:red_hair"], [])).toBe("blue hair · red hair");
  });
});
