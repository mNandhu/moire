import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Card } from "../ui";
import { BATCHES_KEY, STATUS_KEY, batchKey, useBatch, useBatches, type Batch } from "../../lib/generate";
import { BatchResults } from "./BatchResults";

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
  return (
    <Card className="p-3.5">
      <div className="mb-2.5 flex items-center gap-2 text-sm">
        <span className="min-w-0 truncate font-medium text-neutral-100" title={b.name}>
          {b.name}
        </span>
        {done < b.requests.length && (
          <span className="shrink-0 whitespace-nowrap font-mono text-xs text-muted">
            {done} / {b.requests.length}
          </span>
        )}
        <span className="flex-1" />
        <Link to={`/generations/${b._id}`} className="shrink-0 text-xs text-muted hover:text-neutral-100">
          Batch page
        </Link>
      </div>
      <BatchResults batch={b} onChanged={changed} variant="panel" />
    </Card>
  );
}

/** The newest batch's images, arriving as they're made, under the Queue button. */
export function LatestResults() {
  const { data } = useBatches(1);
  const id = data?.[0]?._id;
  return id != null ? <Latest key={id} id={id} /> : null;
}
