import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { ToastProvider } from "../components/Toasts";
import { BATCHES_KEY, STATUS_KEY, batchKey, type Batch, type GenRequest } from "../lib/generate";
import { useBatchChanged, useCancelBatch, useCancelRequest, useRetryFailed, useRetryRequest } from "./useBatchActions";

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={client}>
      <ToastProvider>{children}</ToastProvider>
    </QueryClientProvider>
  );
}

const req = (_id: number, state: string) => ({ _id, state, outputs: [] }) as unknown as GenRequest;
const batch = (requests: GenRequest[]) => ({ _id: 7, requests }) as unknown as Batch;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

afterEach(() => {
  vi.unstubAllGlobals();
  client.clear();
});

describe("useBatchChanged", () => {
  it("puts a new state in the cache and marks the queue stale", () => {
    const spy = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useBatchChanged(7), { wrapper });
    const next = batch([]);
    act(() => result.current(next));
    expect(client.getQueryData(batchKey(7))).toBe(next);
    const keys = spy.mock.calls.map((c) => c[0]?.queryKey);
    expect(keys).toContainEqual(BATCHES_KEY);
    expect(keys).toContainEqual(STATUS_KEY);
    expect(keys).not.toContainEqual(batchKey(7));
    spy.mockRestore();
  });

  it("refetches the batch when given nothing", () => {
    const spy = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useBatchChanged(7), { wrapper });
    act(() => result.current());
    expect(spy.mock.calls.map((c) => c[0]?.queryKey)).toContainEqual(batchKey(7));
    spy.mockRestore();
  });
});

describe("useCancelBatch", () => {
  it("calls onGone for a batch that never ran", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(null)));
    const onGone = vi.fn();
    const { result } = renderHook(() => useCancelBatch(7, { onGone }), { wrapper });
    await act(() => result.current.mutateAsync());
    expect(onGone).toHaveBeenCalledOnce();
  });

  it("keeps a cancelled batch that did run", async () => {
    const nb = batch([req(1, "cancelled")]);
    vi.stubGlobal("fetch", vi.fn(async () => json(nb)));
    const onGone = vi.fn();
    const { result } = renderHook(() => useCancelBatch(7, { onGone }), { wrapper });
    await act(() => result.current.mutateAsync());
    expect(onGone).not.toHaveBeenCalled();
    expect(client.getQueryData(batchKey(7))).toEqual(nb);
  });

  it("toasts a failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ detail: "Nope" }, 500)));
    const { result } = renderHook(() => useCancelBatch(7), { wrapper });
    await act(async () => {
      await result.current.mutateAsync().catch(() => undefined);
    });
    expect(await screen.findByText("Nope")).toBeTruthy();
  });
});

describe("useRetryFailed", () => {
  it("retries each failed request in turn and reports the last state", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return json(batch([req(1, "queued")]));
      }),
    );
    const onChanged = vi.fn();
    const b = batch([req(1, "failed"), req(2, "done"), req(3, "lost")]);
    const { result } = renderHook(() => useRetryFailed(b, onChanged), { wrapper });
    await act(() => result.current.mutateAsync());
    expect(calls.map((u) => u.match(/requests\/(\d+)\/retry/)?.[1])).toEqual(["1", "3"]);
    expect(onChanged).toHaveBeenCalledWith(expect.objectContaining({ _id: 7 }));
  });

  it("refetches when one throws part-way", async () => {
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => (n++ === 0 ? json(batch([])) : json({ detail: "boom" }, 500))),
    );
    const onChanged = vi.fn();
    const b = batch([req(1, "failed"), req(3, "lost")]);
    const { result } = renderHook(() => useRetryFailed(b, onChanged), { wrapper });
    await act(async () => {
      await result.current.mutateAsync().catch(() => undefined);
    });
    expect(onChanged).toHaveBeenCalledWith();
  });
});

describe("useCancelRequest and useRetryRequest", () => {
  it("hand the new batch to onChanged", async () => {
    const nb = batch([req(1, "queued")]);
    vi.stubGlobal("fetch", vi.fn(async () => json(nb)));
    const onChanged = vi.fn();
    const cancel = renderHook(() => useCancelRequest(7, 1, onChanged), { wrapper });
    await act(() => cancel.result.current.mutateAsync());
    const retry = renderHook(() => useRetryRequest(7, 1, onChanged), { wrapper });
    await act(() => retry.result.current.mutateAsync(true));
    expect(onChanged).toHaveBeenCalledTimes(2);
    expect(onChanged).toHaveBeenCalledWith(expect.objectContaining({ _id: 7 }));
  });

  it("toast a failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ detail: "Nope" }, 500)));
    const { result } = renderHook(() => useCancelRequest(7, 1, vi.fn()), { wrapper });
    await act(async () => {
      await result.current.mutateAsync().catch(() => undefined);
    });
    expect(await screen.findByText("Nope")).toBeTruthy();
  });
});
