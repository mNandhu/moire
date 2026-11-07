import { describe, expect, it } from "vitest";
import { batchStripQuery, stripOf } from "./batchStrip";

describe("stripOf", () => {
  it("is the Generation batch for a Moiré output, not the wider group", () => {
    // A second Queue press of the same prompt shares the group, not the batch.
    expect(stripOf(120, "g")).toEqual({ genBatch: 120 });
  });

  it("falls back to the group, else nothing", () => {
    expect(stripOf(null, "g")).toEqual({ groupId: "g" });
    expect(stripOf(undefined, null)).toBeNull();
    expect(stripOf(null, "")).toBeNull();
  });
});

describe("batchStripQuery", () => {
  it("narrows the viewer's scope to the batch", () => {
    expect(batchStripQuery({ genBatch: 7 }, "tags=cat")).toBe("tags=cat&gen_batch=7");
    expect(batchStripQuery({ groupId: "g" }, "tags=cat")).toBe("tags=cat&group_id=g");
  });

  it("replaces a batch the scope already names", () => {
    expect(batchStripQuery({ genBatch: 7 }, "gen_batch=3")).toBe("gen_batch=7");
  });
});
