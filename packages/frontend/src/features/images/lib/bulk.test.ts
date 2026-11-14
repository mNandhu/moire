import { describe, it, expect, vi } from "vitest";
import { runBulk } from "./bulk";

const ids = (n: number) => Array.from({ length: n }, (_, i) => `id-${i}`);

describe("runBulk", () => {
  it("runs every id and reports them as ok", async () => {
    const seen: string[] = [];
    const r = await runBulk(ids(5), async (id) => {
      seen.push(id);
    });
    expect(seen.sort()).toEqual(ids(5).sort());
    expect(r.ok).toHaveLength(5);
    expect(r.failed).toHaveLength(0);
  });

  it("keeps going after a failure and records which ids failed", async () => {
    const r = await runBulk(ids(4), async (id) => {
      if (id === "id-1" || id === "id-3") throw new Error("boom");
    });
    expect(r.ok.sort()).toEqual(["id-0", "id-2"]);
    expect(r.failed.map((f) => f.id).sort()).toEqual(["id-1", "id-3"]);
  });

  it("reports monotonic progress ending at the total", async () => {
    const seen: number[] = [];
    await runBulk(ids(7), async () => {}, {
      onProgress: (done) => seen.push(done),
      concurrency: 3,
    });
    expect(seen).toHaveLength(7);
    expect(seen[seen.length - 1]).toBe(7);
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]).toBeGreaterThan(seen[i - 1]);
    }
  });

  it("never exceeds the concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;
    await runBulk(
      ids(20),
      async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight--;
      },
      { concurrency: 4 },
    );
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1); // actually parallel, not accidentally serial
  });

  it("stops early when aborted", async () => {
    const controller = new AbortController();
    const fn = vi.fn(async () => {
      controller.abort();
    });
    const r = await runBulk(ids(50), fn, {
      concurrency: 1,
      signal: controller.signal,
    });
    expect(fn.mock.calls.length).toBe(1);
    expect(r.ok).toHaveLength(1);
  });

  it("resolves immediately for an empty selection", async () => {
    const fn = vi.fn();
    const r = await runBulk([], fn);
    expect(fn).not.toHaveBeenCalled();
    expect(r).toEqual({ ok: [], failed: [] });
  });
});
