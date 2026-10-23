import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "../components/Toasts";
import {
  batchKey,
  cancelBatch,
  cancelRequest,
  invalidateQueue,
  retryRequest,
  type Batch,
  type GenRequest,
} from "./generate";

/**
 * A batch changed: with its new state, that is put straight in the cache,
 * else its query refetches; the queue's list and status refetch either way.
 */
export function useBatchChanged(id: number) {
  const qc = useQueryClient();
  return (next?: Batch) => {
    if (next) qc.setQueryData(batchKey(id), next);
    invalidateQueue(qc, next ? undefined : id);
  };
}

/**
 * Cancels a batch. One that never ran is deleted, not kept cancelled:
 * `onGone` then runs (else its query refetches, so its panel notices).
 */
export function useCancelBatch(id: number, { onGone }: { onGone?: () => void } = {}) {
  const qc = useQueryClient();
  const toast = useToast();
  const changed = useBatchChanged(id);
  return useMutation({
    mutationFn: () => cancelBatch(id),
    onSuccess: (nb) => {
      if (nb) return changed(nb);
      invalidateQueue(qc, onGone ? undefined : id);
      onGone?.();
    },
    onError: (e) => toast.push(e.message, "error"),
  });
}

/** Cancels one request of a batch. */
export function useCancelRequest(batchId: number, requestId: number, onChanged: (b?: Batch) => void) {
  const toast = useToast();
  return useMutation({
    mutationFn: () => cancelRequest(batchId, requestId),
    onSuccess: (b) => onChanged(b),
    onError: (e) => toast.push(e.message, "error"),
  });
}

/** Retries one request of a batch (`single`: just it, not its whole group). */
export function useRetryRequest(batchId: number, requestId: number, onChanged: (b?: Batch) => void) {
  const toast = useToast();
  return useMutation({
    mutationFn: (single: boolean) => retryRequest(batchId, requestId, single),
    onSuccess: (b) => onChanged(b),
    onError: (e) => toast.push(e.message, "error"),
  });
}

/** The requests a retry-all picks up. */
export const retryable = (requests: readonly GenRequest[]) => requests.filter((q) => q.state === "failed" || q.state === "lost");

/**
 * Retries every failed or lost request, one after another. If one throws
 * part-way the earlier retries still happened, so the batch refetches.
 */
export function useRetryFailed(batch: Batch | undefined, onChanged: (b?: Batch) => void) {
  const toast = useToast();
  return useMutation({
    mutationFn: async () => {
      let last: Batch | undefined;
      for (const q of retryable(batch?.requests ?? [])) last = await retryRequest(batch!._id, q._id);
      return last;
    },
    onSuccess: (nb) => onChanged(nb),
    onError: (e) => {
      toast.push(e.message, "error");
      onChanged();
    },
  });
}
