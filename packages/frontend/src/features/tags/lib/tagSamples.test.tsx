import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useTagCovers, useTagSamples } from "./tagSamples";

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>;
}

describe("tag samples and covers", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("asks for one tag's samples and unwraps its entry", async () => {
    const fetchMock = vi.fn(async (_url: string) => new Response(JSON.stringify({ "any:x": [{ _id: "a", thumb_url: "/t/a" }] })));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useTagSamples("any:x", 4), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual([{ _id: "a", thumb_url: "/t/a" }]));
    const url = new URL(String(fetchMock.mock.calls[0][0]), "http://x");
    expect(url.pathname).toBe("/api/v1/tags/samples");
    expect(url.searchParams.get("tags")).toBe("any:x");
    expect(url.searchParams.get("per")).toBe("4");
  });

  it("does not ask while disabled", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderHook(() => useTagSamples("any:x", 4, { enabled: false }), { wrapper });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("looks a cover up by tag once loaded, null before and for strangers", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([{ tag: "1girl", thumb_url: "/t/1" }])));
    vi.stubGlobal("fetch", fetchMock);
    const { result, rerender } = renderHook(({ on }) => useTagCovers(on), { wrapper, initialProps: { on: false } });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current("1girl")).toBeNull();
    rerender({ on: true });
    await waitFor(() => expect(result.current("1girl")).toBe("/t/1"));
    expect(result.current("nope")).toBeNull();
  });
});
