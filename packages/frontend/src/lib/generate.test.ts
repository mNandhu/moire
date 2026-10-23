import { describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { BATCHES_KEY, STATUS_KEY, batchKey, invalidateQueue } from "./generate";

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
