import { describe, it, expect, vi, afterEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { ToastProvider } from "../components/Toasts";
import { useAiTagging } from "./useAiTagging";

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      <ToastProvider>{children}</ToastProvider>
    </QueryClientProvider>
  );
}

describe("useAiTagging › an image's own job", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is picked up again when the image's panel comes back", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/ai/tag")) return new Response(JSON.stringify({ job_id: "J1" }));
        if (url.includes("/ai/jobs/J1")) {
          return new Response(JSON.stringify({ id: "J1", status: "running", phase: "tagging", total: 1, done: 0, failed: 0 }));
        }
        return new Response(JSON.stringify({ items: [], ended: {} }));
      }),
    );

    const first = renderHook(() => useAiTagging(undefined, "lib:a.png"), { wrapper });
    await act(() => first.result.current.start(["lib:a.png"]));
    expect(first.result.current.jobId).toBe("J1");
    first.unmount();

    // Another image's panel knows nothing of it.
    const other = renderHook(() => useAiTagging(undefined, "lib:b.png"), { wrapper });
    expect(other.result.current.jobId).toBeNull();

    // Back on the first image: its job, from the first render.
    const back = renderHook(() => useAiTagging(undefined, "lib:a.png"), { wrapper });
    expect(back.result.current.jobId).toBe("J1");
    await waitFor(() => expect(back.result.current.job?.status).toBe("running"));
  });
});
