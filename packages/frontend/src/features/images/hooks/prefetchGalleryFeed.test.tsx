import { describe, expect, it, vi, beforeEach } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const fetchImagesPage = vi.fn(async () => ({ items: [], next: null }));
vi.mock("@/features/images/lib/imageApi", async (orig) => ({
  ...(await orig<typeof import("@/features/images/lib/imageApi")>()),
  fetchImagesPage: (...a: unknown[]) => fetchImagesPage(...(a as [])),
}));

const { prefetchGalleryFeed, useImageFeed } = await import("./useImageFeed");
const { filtersFrom } = await import("./useFilters");

const at = (path: string) => new URL(path, "http://x") as unknown as Location;

describe("prefetchGalleryFeed", () => {
  beforeEach(() => {
    fetchImagesPage.mockClear();
    localStorage.clear();
  });

  it("starts the page the gallery's own query then uses, fetched once", async () => {
    const qc = new QueryClient();
    prefetchGalleryFeed(qc, at("/?tags=cat&sort=oldest"));
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: qc }, children);
    const filters = filtersFrom(new URLSearchParams("tags=cat&sort=oldest"));
    const { result } = renderHook(() => useImageFeed(filters), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchImagesPage).toHaveBeenCalledTimes(1);
  });

  it("leaves other pages and the grouped view alone", () => {
    const qc = new QueryClient();
    prefetchGalleryFeed(qc, at("/tags"));
    prefetchGalleryFeed(qc, at("/?group=1"));
    localStorage.setItem("gallery_group_pref", "1");
    prefetchGalleryFeed(qc, at("/"));
    expect(fetchImagesPage).not.toHaveBeenCalled();
  });
});
