import { batchLine, stateTone, STATE_LABEL, whenLabel } from "../../lib/batches";
import { useBatches } from "../../lib/generate";
import { Badge } from "../ui";

/** The last few batches under the run panel. */
export function RecentBatches({ onOpen }: { onOpen: (id: number) => void }) {
  const { data } = useBatches(5);
  if (!data?.length) return null;
  return (
    <section aria-label="Recent batches">
      <div className="mb-2 text-xs font-medium text-muted">Recent batches</div>
      <ul className="space-y-1">
        {data.map((b) => (
          <li key={b._id}>
            <button
              type="button"
              onClick={() => onOpen(b._id)}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-raised"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-neutral-100">{b.name}</span>
                <span className="block truncate text-xs text-faint">{batchLine(b)}</span>
              </span>
              {b.state === "running" || b.state === "failed" || b.state === "paused" ? (
                <Badge tone={stateTone(b.state)}>{STATE_LABEL[b.state]}</Badge>
              ) : (
                <span className="text-xs text-faint">{whenLabel(b.created_at)}</span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
