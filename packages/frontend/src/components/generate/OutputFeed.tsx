import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { batchRunTime, durationLabel, isWaiting, turnLabel } from "../../lib/batches";
import { BATCHES_KEY, STATUS_KEY, batchKey, useBatch, useBatches, useComfyStatus, type Batch } from "../../lib/generate";
import { batchLeft, leftLabel } from "../../lib/eta";
import { BatchResults } from "./BatchResults";

/** Batches shown in the output column. */
const SHOWN = 3;

function BatchPanel({ id }: { id: number }) {
  const qc = useQueryClient();
  const { data: b } = useBatch(id);
  const { data: status } = useComfyStatus();
  if (!b) return null;
  const changed = (next?: Batch) => {
    if (next) qc.setQueryData(batchKey(id), next);
    else void qc.invalidateQueries({ queryKey: batchKey(id) });
    void qc.invalidateQueries({ queryKey: BATCHES_KEY });
    void qc.invalidateQueries({ queryKey: STATUS_KEY });
  };
  const done = b.requests.filter((q) => !["pending", "queued", "running"].includes(q.state)).length;
  const took = batchRunTime(b.requests);
  // With others queued its own time left isn't when it's done: the queue's
  // word for it first.
  const turn = status?.active.find((a) => a._id === id);
  const left = batchLeft(b.requests);
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
              title={took.perImage != null && took.images > 1 ? `${durationLabel(took.perImage)} per image` : undefined}
            >
              {durationLabel(took.total)}
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
 * still waiting its turn is only in the deck.
 */
export function OutputFeed() {
  const { data: status } = useComfyStatus();
  // Enough to get past every batch still waiting its turn.
  const waiting = status?.active.filter(isWaiting).length ?? 0;
  const { data } = useBatches(SHOWN + waiting);
  const started = data
    ?.filter((b) => {
      // Cancelled with nothing made: nothing to show (Generations lists it).
      if (b.state === "cancelled" && b.images === 0) return false;
      const turn = status?.active.find((a) => a._id === b._id);
      return !(turn && isWaiting(turn));
    })
    .slice(0, SHOWN);
  if (!started?.length) return null;
  return (
    <>
      {started.map((b) => (
        <BatchPanel key={b._id} id={b._id} />
      ))}
      <div className="flex justify-center">
        <Link to="/generations" className="text-xs text-muted hover:text-neutral-100">
          All generations
        </Link>
      </div>
    </>
  );
}
