import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_TASKS_KEY, useRefreshOnFinish } from "./useBackgroundTasks";

/** The hook seeded with one activity reply, then fed `next` by its first fetch. */
function setup(next: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(next), { status: 200 })));
  const qc = new QueryClient();
  qc.setQueryData(BACKGROUND_TASKS_KEY, { items: [], ended: { scan: 2 } });
  const spy = vi.spyOn(qc, "invalidateQueries");
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children);
  renderHook(() => useRefreshOnFinish(), { wrapper });
  return () => spy.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey));
}

describe("useRefreshOnFinish", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("refreshes the library list and every image cache once a scan ends", async () => {
    const keys = setup({ items: [], ended: { scan: 3 } });
    await waitFor(() => expect(keys()).toContain(JSON.stringify(["images"])));
    for (const k of [["libraries"], ["image-groups"], ["tags"], ["image-stats"]]) {
      expect(keys()).toContain(JSON.stringify(k));
    }
  });

  it("refreshes only the list when a scan starts", async () => {
    const keys = setup({ items: [{ key: "scan:L", kind: "scan" }], ended: { scan: 2 } });
    await waitFor(() => expect(keys()).toContain(JSON.stringify(["libraries"])));
    expect(keys()).not.toContain(JSON.stringify(["images"]));
  });
});
