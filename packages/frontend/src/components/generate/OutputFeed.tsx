import { Link } from "react-router-dom";
import { batchProgress, isWaiting, turnLabel } from "../../lib/batches";
import { durationWords } from "../../lib/format";
import { useBatchChanged } from "../../hooks/useBatchActions";
import { useBatch, useBatches, useComfyStatus } from "../../lib/generate";
import { leftLabel } from "../../lib/eta";
import { queueRoles } from "../../lib/queueClock";
import { useLocalPref } from "../../hooks/useLocalPref";
import { BatchResults } from "./BatchResults";

/** Batches shown in the output column. */
const SHOWN = 3;
/** The newest batch id when the column was last cleared, and the ones
 * still in the queue then (they stay, finished or not). */
const CLEARED_KEY = "generate:output-cleared";

function BatchPanel({ id }: { id: number }) {
  const { data: b } = useBatch(id);
  const changed = useBatchChanged(id);
  const { data: status } = useComfyStatus();
  if (!b) return null;
  const { done, took, left } = batchProgress(b.requests);
  // With others queued its own time left isn't when it's done: the queue's
  // word for it first.
  const turn = status?.active.find((a) => a._id === id);
  const leftText = turn ? turnLabel(turn) : left && leftLabel(left);
  return (
    // No card: a frame sized to the column sat wider than a portrait batch.
    <section aria-label={b.name}>
      <div className="mb-1.5 flex items-center gap-2 px-2 text-sm">
        <span className="min-w-0 truncate font-medium text-neutral-100" title={b.name}>
          {b.name}
        </span>
        {done < b.requests.length && (
          <span className="shrink-0 whitespace-nowrap font-mono text-xs text-muted">
            {done} / {b.requests.length}
          </span>
        )}
        {leftText ? (
          <span className="shrink-0 whitespace-nowrap text-xs tabular-nums text-muted">{leftText}</span>
        ) : (
          !turn &&
          took && (
            <span
              className="shrink-0 whitespace-nowrap text-xs tabular-nums text-muted"
              title={took.perImage != null && took.images > 1 ? `${durationWords(took.perImage)} per image` : undefined}
            >
              {durationWords(took.total)}
            </span>
          )
        )}
        <span className="flex-1" />
        <Link to={`/generations/${b._id}`} className="shrink-0 text-xs text-muted hover:text-neutral-100">
          Batch page
        </Link>
      </div>
      <BatchResults batch={b} onChanged={changed} variant="panel" />
    </section>
  );
}

/**
 * The output column under the queue deck: the last few batches that have
 * started, newest on top, each with its images big as they're made. A batch
 * still waiting its turn is only in the deck. Clear empties it (here only,
 * nothing is deleted) of all but a batch still running.
 */
export function OutputFeed() {
  const { data: status } = useComfyStatus();
  // Waiting its turn: in the queue, nothing made, and not the one in front
  // (which may sit queued in ComfyUI a moment before it runs).
  const active = (status?.active ?? []).filter((a) => !a.test);
  const queued = queueRoles(active).behind;
  const behind = new Set(active.filter((a) => isWaiting(a) && queued.has(a._id)).map((a) => a._id));
  // Enough to get past every one of them.
  const { data } = useBatches(SHOWN + behind.size);
  const [cleared, setCleared] = useLocalPref<{ upTo: number; keep: number[] }>(CLEARED_KEY, { upTo: 0, keep: [] });
  const kept = new Set([...cleared.keep, ...active.map((a) => a._id)]);
  const started = data
    ?.filter((b) => {
      // Cancelled with nothing made: nothing to show (Generations lists it).
      if (b.state === "cancelled" && b.images === 0) return false;
      if (b._id <= cleared.upTo && !kept.has(b._id)) return false;
      return !behind.has(b._id);
    })
    .slice(0, SHOWN);
  if (!started?.length) return null;
  return (
    <>
      {started.map((b) => (
        <BatchPanel key={b._id} id={b._id} />
      ))}
      <div className="flex justify-center gap-4">
        <button
          type="button"
          onClick={() =>
            setCleared({
              upTo: Math.max(cleared.upTo, ...(data ?? []).map((b) => b._id)),
              keep: [
                ...active.map((a) => a._id),
                ...(data ?? []).filter((b) => b.state === "running" || b.state === "paused").map((b) => b._id),
              ],
            })
          }
          className="text-xs text-muted hover:text-neutral-100"
        >
          Clear
        </button>
        <Link to="/generations" className="text-xs text-muted hover:text-neutral-100">
          All generations
        </Link>
      </div>
    </>
  );
}
