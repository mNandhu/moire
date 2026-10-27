import { describe, expect, it } from "vitest";
import { stemOf } from "./modelNames";

describe("stemOf", () => {
  it("drops folders and a model extension only", () => {
    expect(stemOf("styles/flat_color_xl.safetensors")).toBe("flat_color_xl");
    expect(stemOf("a\\b\\x.PT")).toBe("x");
    expect(stemOf("v1.5_style")).toBe("v1.5_style");
    expect(stemOf(" plain ")).toBe("plain");
  });
});
