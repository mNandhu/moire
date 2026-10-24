import { describe, expect, it, vi } from "vitest";
import { chunkIds, createBatcher } from "./tagSamples";

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
    expect(fetchMany).toHaveBeenCalledWith(["a", "b"], expect.any(AbortSignal));
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

  it("rejects every caller when fetchMany throws synchronously", async () => {
    let flush = () => {};
    const get = createBatcher(
      (): Promise<Record<string, number>> => {
        throw new Error("sync");
      },
      (f) => (flush = f),
    );
    const both = Promise.allSettled([get("a"), get("b")]);
    flush();
    expect((await both).map((r) => r.status)).toEqual(["rejected", "rejected"]);
  });

  it("splits a flush into chunks and fails only the callers of a failed chunk", async () => {
    const fetchMany = vi.fn(async (ids: string[]): Promise<Record<string, string>> => {
      if (ids.includes("c")) throw new Error("down");
      return Object.fromEntries(ids.map((id) => [id, id]));
    });
    let flush = () => {};
    const get = createBatcher(fetchMany, (f) => (flush = f), { maxIds: 2 });
    const all = Promise.allSettled([get("a"), get("b"), get("c"), get("d")]);
    flush();
    expect(fetchMany.mock.calls.map((c) => c[0])).toEqual([["a", "b"], ["c", "d"]]);
    expect((await all).map((r) => r.status)).toEqual(["fulfilled", "fulfilled", "rejected", "rejected"]);
  });

  it("aborts a chunk only once every caller in it has aborted", async () => {
    let seen!: AbortSignal;
    let flush = () => {};
    const get = createBatcher(
      (_ids, signal) => {
        seen = signal;
        return new Promise<Record<string, number>>(() => {});
      },
      (f) => (flush = f),
    );
    const a = new AbortController();
    const b = new AbortController();
    void get("x", a.signal);
    void get("y", b.signal);
    flush();
    a.abort();
    expect(seen.aborted).toBe(false);
    b.abort();
    expect(seen.aborted).toBe(true);
  });
});

describe("chunkIds", () => {
  it("bounds a chunk by count and by encoded length", () => {
    expect(chunkIds(["a", "b", "c"], { maxIds: 2 })).toEqual([["a", "b"], ["c"]]);
    const long = "x".repeat(30);
    expect(chunkIds([long, long, long], { maxChars: 80 })).toEqual([[long, long], [long]]);
    expect(chunkIds([])).toEqual([]);
  });
});
