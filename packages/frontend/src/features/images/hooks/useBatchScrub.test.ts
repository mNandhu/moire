import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { useBatchScrub } from "./useBatchScrub";

function stubFetch(docs: unknown[]) {
  const fetchMock = vi.fn(
    async (_url: string) => new Response(JSON.stringify(docs), { status: 200 }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const DOC = (id: string) => ({ _id: id, path: id, thumb_url: `/thumb/${id}` });

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("useBatchScrub", () => {
  it("scopes the peek fetch with the gallery's active filters", async () => {
    const fetchMock = stubFetch([DOC("a"), DOC("b"), DOC("c")]);

    renderHook(() =>
      useBatchScrub("g1", true, "quarantined=1&tags=portrait"),
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const url = new URL(fetchMock.mock.calls[0][0] as string, "http://x");
    expect(url.searchParams.get("quarantined")).toBe("1");
    expect(url.searchParams.get("tags")).toBe("portrait");
    expect(url.searchParams.get("group_id")).toBe("g1");
  });

  it("overrides any group/group_id already present in the filter query", async () => {
    // A drilled-into-a-batch URL carries its own group_id; the peek must
    // still scope to the group it was actually asked to peek, not that one.
    const fetchMock = stubFetch([DOC("a"), DOC("b")]);

    renderHook(() =>
      useBatchScrub("target-group", true, "group=1&group_id=stale-group"),
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const url = new URL(fetchMock.mock.calls[0][0] as string, "http://x");
    expect(url.searchParams.get("group_id")).toBe("target-group");
  });

  it("does not fetch when inactive", async () => {
    const fetchMock = stubFetch([]);
    renderHook(() => useBatchScrub("g1", false, ""));
    await new Promise((r) => setTimeout(r, 400));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
