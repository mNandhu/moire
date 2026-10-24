import { describe, expect, it } from "vitest";
import type { GenRequest } from "./generate";
import { retryable } from "./batchActions";

const req = (_id: number, state: string) => ({ _id, state, outputs: [] }) as unknown as GenRequest;

describe("retryable", () => {
  it("picks failed and lost requests only", () => {
    const rs = [req(1, "done"), req(2, "failed"), req(3, "lost"), req(4, "cancelled"), req(5, "running")];
    expect(retryable(rs).map((r) => r._id)).toEqual([2, 3]);
  });
});
