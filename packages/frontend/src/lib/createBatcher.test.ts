import { describe, expect, it, vi } from "vitest";
import { createBatcher } from "./tagSamples";

describe("createBatcher", () => {
  it("answers every caller from one request for the ids asked in the same tick", async () => {
    const fetchMany = vi.fn(async (ids: string[]) => Object.fromEntries(ids.map((id) => [id, id.toUpperCase()])));
    let flush = () => {};
    const get = createBatcher(fetchMany, (f) => (flush = f));
    const all = Promise.all([get("a"), get("b"), get("a")]);
    expect(fetchMany).not.toHaveBeenCalled();
    flush();
    expect(await all).toEqual(["A", "B", "A"]);
    expect(fetchMany).toHaveBeenCalledTimes(1);
    expect(fetchMany).toHaveBeenCalledWith(["a", "b"]);
  });

  it("starts a new batch after a flush, and gives undefined for an id the answer lacks", async () => {
    const fetchMany = vi.fn(async (ids: string[]): Promise<Record<string, number>> => (ids[0] === "a" ? { a: 1 } : {}));
    const flushes: Array<() => void> = [];
    const get = createBatcher(fetchMany, (f) => void flushes.push(f));
    const first = get("a");
    flushes[0]();
    expect(await first).toBe(1);
    const second = get("z");
    expect(flushes).toHaveLength(2);
    flushes[1]();
    expect(await second).toBeUndefined();
  });

  it("rejects every caller of a failed batch", async () => {
    let flush = () => {};
    const get = createBatcher(async () => Promise.reject(new Error("down")), (f) => (flush = f));
    const both = Promise.allSettled([get("a"), get("b")]);
    flush();
    expect((await both).map((r) => r.status)).toEqual(["rejected", "rejected"]);
  });
});
