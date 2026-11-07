import { describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { BATCHES_KEY, STATUS_KEY, batchKey, invalidateQueue, recipeStuck } from "./generate";

const invalidated = (batchId?: number) => {
  const qc = new QueryClient();
  const spy = vi.spyOn(qc, "invalidateQueries");
  invalidateQueue(qc, batchId);
  return spy.mock.calls.map(([f]) => f?.queryKey);
};

describe("invalidateQueue", () => {
  it("refreshes the status card and the batch list", () => {
    expect(invalidated()).toEqual([STATUS_KEY, BATCHES_KEY]);
  });

  it("and the batch itself when given its id", () => {
    expect(invalidated(7)).toEqual([STATUS_KEY, BATCHES_KEY, batchKey(7)]);
  });
});

describe("recipeStuck", () => {
  const gaveUp = { data: undefined, isError: true, fetchStatus: "idle" };

  it("is a recipe query that failed and is not asking again", () => {
    expect(recipeStuck(gaveUp)).toBe(true);
  });

  it("is loading, not stuck, while it asks again after an error", () => {
    expect(recipeStuck({ ...gaveUp, fetchStatus: "fetching" })).toBe(false);
  });

  it("is never stuck with a recipe, or before an error", () => {
    expect(recipeStuck({ ...gaveUp, data: { tag: "a" } })).toBe(false);
    expect(recipeStuck({ ...gaveUp, isError: false, fetchStatus: "fetching" })).toBe(false);
  });
});
