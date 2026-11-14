import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EXPECT_SCAN_MS,
  SCAN_POLL_MS,
  expectScan,
  useLibraryWrites,
  feedNeedsRefetch,
  libraryPollMs,
  scanLabel,
  scanProblem,
  type Library,
} from "./libraries";

const lib = (scan_error: string | null, scanning = false): Library =>
  ({ _id: "L", name: "L", path: "/p", scan_error, scanning }) as Library;

const mk = (id: string, extra: Partial<Library> = {}): Library => ({ _id: id, path: `/${id}`, ...extra });

describe("scanProblem", () => {
  it("is a failure for an error, a note for what a finished scan kept", () => {
    expect(scanProblem(lib("Library folder not found: /p"))).toEqual({
      text: "Library folder not found: /p",
      note: false,
    });
    expect(scanProblem(lib("Kept 40 images: folder unreadable"))?.note).toBe(true);
    expect(scanProblem(lib("Some folders could not be read; their images were kept"))?.note).toBe(true);
  });
  it("is nothing while scanning, after a cancel, or when clean", () => {
    expect(scanProblem(lib("boom", true))).toBeNull();
    expect(scanProblem(lib("cancelled"))).toBeNull();
    expect(scanProblem(lib(null))).toBeNull();
  });
});

describe("scanLabel", () => {
  it("has no percentage until the total is known, and never reads 100%", () => {
    expect(scanLabel(mk("a", { scanning: true }))).toBe("Scanning…");
    expect(scanLabel(mk("a", { scan_total: 200, scan_done: 50 }))).toBe("Scanning 25%");
    expect(scanLabel(mk("a", { scan_total: 200, scan_done: 200 }))).toBe("Scanning 99%");
  });
});

describe("libraryPollMs", () => {
  // The expect-a-scan window is module state a write test may have opened.
  beforeEach(() => expectScan(0));
  it("is brisk while any library scans or is being deleted", () => {
    expect(libraryPollMs([mk("a"), mk("b", { scanning: true })])).toBe(SCAN_POLL_MS);
    expect(libraryPollMs([mk("a", { deleting: true })], 8000)).toBe(SCAN_POLL_MS);
  });
  it("falls back to the idle interval, off by default", () => {
    expect(libraryPollMs([mk("a")])).toBe(false);
    expect(libraryPollMs(undefined)).toBe(false);
    expect(libraryPollMs([mk("a")], 8000)).toBe(8000);
  });
  it("is brisk for a while after a write that may start a scan, before any read shows it", () => {
    const t = 1_000_000;
    expectScan(t);
    expect(libraryPollMs([mk("a")], false, t + 1)).toBe(SCAN_POLL_MS);
    expect(libraryPollMs([mk("a")], 8000, t + EXPECT_SCAN_MS - 1)).toBe(SCAN_POLL_MS);
    expect(libraryPollMs([mk("a")], 8000, t + EXPECT_SCAN_MS)).toBe(8000);
    expect(libraryPollMs([mk("a")], false, t + EXPECT_SCAN_MS)).toBe(false);
  });
});

describe("feedNeedsRefetch", () => {
  it("pulls on the first read", () => {
    expect(feedNeedsRefetch(undefined, [mk("a")])).toBe(true);
  });
  it("pulls while scanning and once more after it ends", () => {
    expect(feedNeedsRefetch([mk("a", { scanning: true })], [mk("a", { scanning: true })])).toBe(true);
    expect(feedNeedsRefetch([mk("a")], [mk("a", { scanning: true })])).toBe(true);
  });
  it("is quiet when idle and nothing changed", () => {
    expect(feedNeedsRefetch([mk("a", { last_event_at: "t1" })], [mk("a", { last_event_at: "t1" })])).toBe(false);
    expect(feedNeedsRefetch([mk("a")], [mk("a", { last_event_at: null })])).toBe(false);
  });
  it("pulls on a new watcher event", () => {
    expect(feedNeedsRefetch([mk("a", { last_event_at: "t1" })], [mk("a", { last_event_at: "t2" })])).toBe(true);
    expect(feedNeedsRefetch([mk("a")], [mk("a", { last_event_at: "t1" })])).toBe(true);
  });
});

describe("useLibraryWrites", () => {
  afterEach(() => vi.unstubAllGlobals());

  const setup = () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, "invalidateQueries");
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: qc }, children);
    const { result } = renderHook(() => useLibraryWrites(), { wrapper });
    const keys = () => spy.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey));
    return { result, keys };
  };
  const all = [
    ["libraries"],
    ["images"],
    ["batch-strip"],
    ["image-groups"],
    ["tags"],
    ["image-stats"],
    ["image-models"],
    ["image-loras"],
    ["image-embeddings"],
    ["image-sizes"],
  ].map((k) => JSON.stringify(k));

  it("refreshes the list and both gallery caches after any write", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    const { result, keys } = setup();
    await result.current.rescan("a");
    expect(keys()).toEqual(all);
  });

  it("refreshes even when the write fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"detail":"nope"}', { status: 409 })));
    const { result, keys } = setup();
    await expect(result.current.remove("a")).rejects.toThrow("nope");
    expect(keys()).toEqual(all);
  });

  it("removeMany refetches the list after each delete but the image caches once", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.endsWith("/b") ? new Response('{"detail":"nope"}', { status: 409 }) : new Response("{}", { status: 200 }),
      ),
    );
    const { result, keys } = setup();
    const out = await result.current.removeMany(["a", "b", "c"]);
    expect(out.failed).toEqual(["b"]);
    const lib = JSON.stringify(["libraries"]);
    expect(keys().filter((k) => k === lib)).toHaveLength(4);
    expect(keys().filter((k) => k === JSON.stringify(["images"]))).toHaveLength(1);
  });

  it("createMany keeps going past a failure and reports it by path", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const { path } = JSON.parse(String(init?.body));
        return path === "/bad"
          ? new Response('{"detail":"overlaps"}', { status: 409 })
          : new Response(JSON.stringify({ _id: `id${path}` }), { status: 200 });
      }),
    );
    const { result, keys } = setup();
    const out = await result.current.createMany([{ path: "/a" }, { path: "/bad" }, { path: "/c" }]);
    expect(out.created).toEqual({ "/a": "id/a", "/c": "id/c" });
    expect(out.failed).toEqual([{ path: "/bad", error: "overlaps" }]);
    expect(keys()).toEqual(all);
  });
});
