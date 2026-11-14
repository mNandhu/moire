/**
 * Bounded-concurrency runner for bulk per-image mutations.
 *
 * Bulk quarantine used to be `Promise.all(ids.map(...))`: a thousand selected
 * images meant a thousand simultaneous requests against a single-writer SQLite
 * backend, no progress to show the user, and one failure rejecting the whole
 * batch with no record of which writes had already landed. This runs a fixed
 * number at a time, reports progress as each settles, and always resolves with
 * a per-id account of what happened, so the caller can tell the user "912 of
 * 1000, 88 failed" instead of just "failed".
 */

export type BulkResult = {
  /** Ids whose mutation resolved. */
  ok: string[];
  /** Ids whose mutation threw, with the error. */
  failed: { id: string; error: unknown }[];
};

const DEFAULT_CONCURRENCY = 6;

export async function runBulk(
  ids: readonly string[],
  fn: (id: string) => Promise<unknown>,
  opts: {
    onProgress?: (done: number, total: number) => void;
    concurrency?: number;
    signal?: AbortSignal;
  } = {},
): Promise<BulkResult> {
  const total = ids.length;
  const ok: string[] = [];
  const failed: { id: string; error: unknown }[] = [];
  if (!total) return { ok, failed };

  const limit = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY);
  let cursor = 0;
  let done = 0;

  const worker = async () => {
    while (cursor < total) {
      if (opts.signal?.aborted) return;
      const id = ids[cursor++];
      try {
        await fn(id);
        ok.push(id);
      } catch (error) {
        failed.push({ id, error });
      }
      done++;
      opts.onProgress?.(done, total);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(limit, total) }, () => worker()),
  );
  return { ok, failed };
}
