import { describe, expect, it } from "vitest";
import { autoBatchName } from "./batchName";

describe("autoBatchName", () => {
  it("uses character and outfit first", () => {
    expect(
      autoBatchName({ number: 3, generator: "Built-in", character: "hu_tao_(genshin_impact)", outfit: "Default" }),
    ).toBe("hu tao (genshin impact), Default");
  });
  it("falls back to generator and two extra tags, skipping embeddings", () => {
    expect(
      autoBatchName({ number: 3, generator: "Built-in", extra: ["embedding:x", "red_dress", "night", "rain"] }),
    ).toBe("Built-in, red dress, night");
  });
  it("ends at Batch n", () => {
    expect(autoBatchName({ number: 3, generator: "Built-in" })).toBe("Batch 3");
  });
});
