import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { BATCHES_KEY, STATUS_KEY, batchKey, useBatch, useBatches, type Batch } from "../../lib/generate";
import { BatchResults } from "./BatchResults";
import { batchRunTime, durationLabel } from "../../lib/batches";
import { batchLeft, leftLabel } from "../../lib/eta";

function Latest({ id }: { id: number }) {
  const qc = useQueryClient();
  const { data: b } = useBatch(id);
  if (!b) return null;
  const changed = (next?: Batch) => {
    if (next) qc.setQueryData(batchKey(id), next);
    else void qc.invalidateQueries({ queryKey: batchKey(id) });
    void qc.invalidateQueries({ queryKey: BATCHES_KEY });
    void qc.invalidateQueries({ queryKey: STATUS_KEY });
  };
  const done = b.requests.filter((q) => !["pending", "queued", "running"].includes(q.state)).length;
  const took = batchRunTime(b.requests);
  const left = batchLeft(b.requests);
  return (
    // No card: a frame sized to the column sat wider than a portrait batch.
    // Headed like Recent batches under it, so the column reads as one list.
    <section aria-label="Latest batch">
      <div className="mb-1.5 flex items-center gap-2 px-2 text-sm">
        <span className="min-w-0 truncate font-medium text-neutral-100" title={b.name}>
          {b.name}
        </span>
        {done < b.requests.length && (
          <span className="shrink-0 whitespace-nowrap font-mono text-xs text-muted">
            {done} / {b.requests.length}
          </span>
        )}
        {left ? (
          <span className="shrink-0 whitespace-nowrap text-xs tabular-nums text-muted">{leftLabel(left)}</span>
        ) : took && (
          <span
            className="shrink-0 whitespace-nowrap text-xs tabular-nums text-muted"
            title={took.perImage != null && took.images > 1 ? `${durationLabel(took.perImage)} per image` : undefined}
          >
            {durationLabel(took.total)}
          </span>
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

/** The newest batch's images, arriving as they're made, under the Queue button. */
export function LatestResults() {
  const { data } = useBatches(1);
  const id = data?.[0]?._id;
  return id != null ? <Latest key={id} id={id} /> : null;
}
